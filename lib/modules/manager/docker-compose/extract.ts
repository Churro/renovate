import is from '@sindresorhus/is';
import { logger } from '../../../logger';
import { newlineRegex, regEx } from '../../../util/regex';
import { parseSingleYaml } from '../../../util/yaml';
import { getDep } from '../dockerfile/extract';
import type { ExtractConfig, PackageFileContent } from '../types';
import { DockerComposeFile } from './schema';

class LineMapper {
  private imageLines: { line: string; lineNumber: number; used: boolean }[];

  constructor(content: string, filter: RegExp) {
    this.imageLines = [...content.split(newlineRegex).entries()]
      .filter((entry) => filter.test(entry[1]))
      .map(([lineNumber, line]) => ({ lineNumber, line, used: false }));
  }

  pluckLineNumber(imageName: string | undefined): number | null {
    const lineMeta = this.imageLines.find(
      ({ line, used }) => !used && imageName && line.includes(imageName),
    );
    // istanbul ignore if
    if (!lineMeta) {
      return null;
    }
    lineMeta.used = true; // unset plucked lines so duplicates are skipped
    return lineMeta.lineNumber;
  }
}

export function extractPackageFile(
  content: string,
  packageFile: string,
  extractConfig: ExtractConfig,
): PackageFileContent | null {
  logger.debug(`docker-compose.extractPackageFile(${packageFile})`);
  let config: DockerComposeFile;
  try {
    config = parseSingleYaml(content, {
      customSchema: DockerComposeFile,
      removeTemplates: true,
    });
  } catch (err) {
    logger.debug(
      { err, packageFile },
      `Parsing Docker Compose config YAML failed`,
    );
    return null;
  }
  try {
    const lineMapper = new LineMapper(content, regEx(/^\s*image:/));

    // docker-compose v1 places the services at the top level,
    // docker-compose v2+ places the services within a 'services' key
    // since docker-compose spec version 1.27, the 'version' key has
    // become optional and can no longer be used to differentiate
    // between v1 and v2.
    const services = config.services ?? config;
    const extensions = config.extensions ?? {};

    // Image name/tags for services are only eligible for update if they don't
    // use variables and if the image is not built locally
    const deps = Object.values(
      services || /* istanbul ignore next: can never happen */ {},
    )
      .concat(Object.values(extensions))
      .filter((service) => is.string(service?.image) && !service?.build)
      .map((service) => {
        const dep = getDep(service.image, true, extractConfig.registryAliases);
        const lineNumber = lineMapper.pluckLineNumber(service.image);
        // istanbul ignore if
        if (!lineNumber) {
          return null;
        }
        return dep;
      })
      .filter(is.truthy);

    logger.trace({ deps }, 'Docker Compose image');
    return { deps };
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ packageFile, err }, 'Error extracting Docker Compose file');
    return null;
  }
}

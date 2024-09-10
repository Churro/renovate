import os from 'node:os';
import { dirname, join } from 'upath';
import { GlobalConfig } from '../../../config/global';
import { logger } from '../../../logger';
import { chmodLocalFile, readLocalFile, statLocalFile } from '../../../util/fs';
import { newlineRegex, regEx } from '../../../util/regex';
import gradleVersioning from '../../versioning/gradle';
import type { GradleVersionExtract } from './types';

export const extraEnv = {
  GRADLE_OPTS:
    '-Dorg.gradle.parallel=true -Dorg.gradle.configureondemand=true -Dorg.gradle.daemon=false -Dorg.gradle.caching=false',
};

export function gradleWrapperFileName(): string {
  if (
    os.platform() === 'win32' &&
    GlobalConfig.get('binarySource') !== 'docker'
  ) {
    return 'gradlew.bat';
  }
  return './gradlew';
}

export async function prepareGradleCommand(
  gradlewFile: string,
): Promise<string | null> {
  const gradlewStat = await statLocalFile(gradlewFile);
  if (gradlewStat?.isFile() === true) {
    // if the file is not executable by others
    if (os.platform() !== 'win32' && (gradlewStat.mode & 0o1) === 0) {
      logger.debug('Gradle wrapper is missing the executable bit');
      // add the execution permission to the owner, group and others
      await chmodLocalFile(gradlewFile, gradlewStat.mode | 0o111);
    }
    return gradleWrapperFileName();
  }
  return null;
}

export async function getJavaConstraint(
  gradleVersion: string | null | undefined,
  gradlewFile: string,
): Promise<string> {
  const major = gradleVersion ? gradleVersioning.getMajor(gradleVersion) : null;
  const minor = gradleVersion ? gradleVersioning.getMinor(gradleVersion) : null;

  if (major && major >= 8 && minor && minor >= 8) {
    const toolChainVersion = await getJvmConfiguration(gradlewFile);
    if (toolChainVersion) {
      return `^${toolChainVersion}.0.0`;
    }
  }

  if (major && (major > 7 || (major >= 7 && minor && minor >= 3))) {
    return '^17.0.0';
  }
  if (major && major >= 7) {
    return '^16.0.0';
  }
  // first public gradle version was 2.0
  if (major && major > 0 && major < 5) {
    return '^8.0.0';
  }
  return '^11.0.0';
}

// https://docs.gradle.org/current/userguide/gradle_daemon.html#sec:daemon_jvm_criteria
export async function getJvmConfiguration(
  gradlewFile: string,
): Promise<string | null> {
  const daemonJvmFile = join(
    dirname(gradlewFile),
    'gradle/gradle-daemon-jvm.properties',
  );
  const daemonJvm = await readLocalFile(daemonJvmFile, 'utf8');
  if (daemonJvm) {
    const TOOLCHAIN_VERSION_REGEX = regEx(
      '^(?:toolchainVersion=)(?<version>\\d+)$',
      'm',
    );
    const toolChainMatch = TOOLCHAIN_VERSION_REGEX.exec(daemonJvm);
    if (toolChainMatch?.groups) {
      return toolChainMatch.groups.version;
    }
  }

  return null;
}

// https://regex101.com/r/IcOs7P/1
const DISTRIBUTION_URL_REGEX = regEx(
  '^(?:distributionUrl\\s*=\\s*)(?<url>\\S*-(?<version>\\d+\\.\\d+(?:\\.\\d+)?(?:-\\w+)*)-(?<type>bin|all)\\.zip)\\s*$',
);

export function extractGradleVersion(
  fileContent: string,
): GradleVersionExtract | null {
  const lines = fileContent?.split(newlineRegex) ?? [];

  for (const line of lines) {
    const distributionUrlMatch = DISTRIBUTION_URL_REGEX.exec(line);

    if (distributionUrlMatch?.groups) {
      return {
        url: distributionUrlMatch.groups.url,
        version: distributionUrlMatch.groups.version,
      };
    }
  }
  logger.debug(
    'Gradle wrapper version and url could not be extracted from properties - skipping update',
  );

  return null;
}

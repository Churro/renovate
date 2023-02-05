// TODO #7154
import { Ecosystem, Osv, OsvOffline } from '@renovatebot/osv-offline';
import is from '@sindresorhus/is';
import type { CvssScore } from 'vuln-vects';
import { parseCvssVector } from 'vuln-vects';
import { getManagerConfig, mergeChildConfig } from '../../../config';
import type { PackageRule, RenovateConfig } from '../../../config/types';
import { logger } from '../../../logger';
import { getDefaultVersioning } from '../../../modules/datasource';
import type {
  PackageDependency,
  PackageFile,
} from '../../../modules/manager/types';
import {
  VersioningApi,
  get as getVersioning,
} from '../../../modules/versioning';
import { sanitizeMarkdown } from '../../../util/markdown';
import * as p from '../../../util/promises';
import { regEx } from '../../../util/regex';

export class Vulnerabilities {
  private osvOffline: OsvOffline | undefined;

  private static readonly datasourceEcosystemMap: Record<
    string,
    Ecosystem | undefined
  > = {
    crate: 'crates.io',
    go: 'Go',
    hex: 'Hex',
    maven: 'Maven',
    npm: 'npm',
    nuget: 'NuGet',
    packagist: 'Packagist',
    pypi: 'PyPI',
    rubygems: 'RubyGems',
  };

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  private async initialize(): Promise<void> {
    this.osvOffline = await OsvOffline.create();
  }

  static async create(): Promise<Vulnerabilities> {
    const instance = new Vulnerabilities();
    await instance.initialize();
    return instance;
  }

  async fetchVulnerabilities(
    config: RenovateConfig,
    packageFiles: Record<string, PackageFile[]>
  ): Promise<void> {
    const managers = Object.keys(packageFiles);
    const allManagerJobs = managers.map((manager) =>
      this.fetchManagerVulnerabilities(config, packageFiles, manager)
    );
    await Promise.all(allManagerJobs);
  }

  private async fetchManagerVulnerabilities(
    config: RenovateConfig,
    packageFiles: Record<string, PackageFile[]>,
    manager: string
  ): Promise<void> {
    const managerConfig = getManagerConfig(config, manager);
    const queue = packageFiles[manager].map(
      (pFile) => (): Promise<void> =>
        this.fetchManagerPackageFileVulnerabilities(
          config,
          managerConfig,
          pFile
        )
    );
    logger.trace(
      { manager, queueLength: queue.length },
      'fetchManagerUpdates starting'
    );
    await p.all(queue);
    logger.trace({ manager }, 'fetchManagerUpdates finished');
  }

  private async fetchManagerPackageFileVulnerabilities(
    config: RenovateConfig,
    managerConfig: RenovateConfig,
    pFile: PackageFile
  ): Promise<void> {
    const { packageFile } = pFile;
    const packageFileConfig = mergeChildConfig(managerConfig, pFile);
    const { manager } = packageFileConfig;
    const queue = pFile.deps.map(
      (dep) => (): Promise<PackageRule[]> =>
        this.fetchDependencyVulnerabilities(packageFileConfig, dep)
    );
    logger.trace(
      { manager, packageFile, queueLength: queue.length },
      'fetchManagerPackageFileVulnerabilities starting with concurrency'
    );

    config.packageRules?.push(...(await p.all(queue)).flat());
    logger.trace(
      { packageFile },
      'fetchManagerPackageFileVulnerabilities finished'
    );
  }

  private async fetchDependencyVulnerabilities(
    packageFileConfig: RenovateConfig & PackageFile,
    dep: PackageDependency
  ): Promise<PackageRule[]> {
    const ecosystem = Vulnerabilities.datasourceEcosystemMap[dep.datasource!];
    if (!ecosystem) {
      logger.trace(`Cannot map datasource ${dep.datasource!} to OSV ecosystem`);
      return [];
    }

    let packageName = dep.packageName ?? dep.depName!;
    if (ecosystem === 'PyPI') {
      // https://peps.python.org/pep-0503/#normalized-names
      packageName = packageName.toLowerCase().replace(regEx(/[_.-]+/g), '-');
    }

    const packageRules: PackageRule[] = [];
    try {
      const vulnerabilities = await this.osvOffline?.getVulnerabilities(
        ecosystem,
        packageName
      );
      if (
        is.nullOrUndefined(vulnerabilities) ||
        is.emptyArray(vulnerabilities)
      ) {
        logger.trace(
          `No vulnerabilities found in OSV database for ${packageName}`
        );
        return [];
      }

      const depVersion =
        dep.lockedVersion ?? dep.currentVersion ?? dep.currentValue!;

      const versioning = dep.versioning ?? getDefaultVersioning(dep.datasource);
      const versioningApi = getVersioning(versioning);

      if (!versioningApi.isVersion(depVersion)) {
        logger.debug(
          `Skipping vulnerability lookup for package ${packageName} due to unsupported version ${depVersion}`
        );
        return [];
      }

      for (const vulnerability of vulnerabilities) {
        for (const affected of vulnerability.affected ?? []) {
          if (
            this.isPackageVulnerable(
              ecosystem,
              packageName,
              depVersion,
              affected,
              versioningApi
            )
          ) {
            logger.debug(
              `Vulnerability ${vulnerability.id} affects ${packageName} ${depVersion}`
            );
            const fixedVersion = this.getFixedVersion(
              ecosystem,
              depVersion,
              affected,
              versioningApi
            );
            if (fixedVersion) {
              logger.debug(
                `Setting allowed version ${fixedVersion} to fix vulnerability ${vulnerability.id} in ${packageName} ${depVersion}`
              );
              const rule = this.convertToPackageRule(
                packageFileConfig,
                dep,
                packageName,
                depVersion,
                fixedVersion,
                vulnerability
              );
              packageRules.push(rule);
            } else {
              logger.debug(
                `No fixed version available for vulnerability ${vulnerability.id} in ${packageName} ${depVersion}`
              );
            }
          }
        }
      }

      this.sortByFixedVersion(packageRules, versioningApi);
    } catch (err) {
      logger.debug(
        { err },
        `Error fetching vulnerability information for ${packageName}`
      );
    }

    return packageRules;
  }

  private sortByFixedVersion(
    packageRules: PackageRule[],
    versioningApi: VersioningApi
  ): void {
    packageRules.sort((a, b) =>
      versioningApi.sortVersions(
        (a.allowedVersions as string).replace(regEx(/[=> ]+/g), ''),
        (b.allowedVersions as string).replace(regEx(/[=> ]+/g), '')
      )
    );
  }

  // https://ossf.github.io/osv-schema/#affectedrangesevents-fields
  private sortEvents(
    events: Osv.Event[],
    versioningApi: VersioningApi
  ): Osv.Event[] {
    const sortedCopy: Osv.Event[] = [];
    let zeroEvent: Osv.Event | null = null;

    for (const event of events) {
      if (event.introduced === '0') {
        zeroEvent = event;
        continue;
      }
      sortedCopy.push(event);
    }

    sortedCopy.sort((a, b) =>
      versioningApi.sortVersions(Object.values(a)[0], Object.values(b)[0])
    );

    if (zeroEvent) {
      sortedCopy.unshift(zeroEvent);
    }

    return sortedCopy;
  }

  private isPackageAffected(
    ecosystem: Ecosystem,
    packageName: string,
    affected: Osv.Affected
  ): boolean {
    return (
      affected.package?.name === packageName &&
      affected.package?.ecosystem === ecosystem
    );
  }

  private includedInVersions(
    depVersion: string,
    affected: Osv.Affected
  ): boolean {
    return !!affected.versions?.includes(depVersion);
  }

  private includedInRanges(
    depVersion: string,
    affected: Osv.Affected,
    versioningApi: VersioningApi
  ): boolean {
    for (const range of affected.ranges ?? []) {
      if (range.type === 'GIT') {
        continue;
      }

      let vulnerable = false;
      for (const event of this.sortEvents(range.events, versioningApi)) {
        if (
          is.nonEmptyString(event.introduced) &&
          (event.introduced === '0' ||
            (versioningApi.isVersion(event.introduced) &&
              (versioningApi.equals(depVersion, event.introduced) ||
                versioningApi.isGreaterThan(depVersion, event.introduced))))
        ) {
          vulnerable = true;
        } else if (
          is.nonEmptyString(event.fixed) &&
          versioningApi.isVersion(event.fixed) &&
          (versioningApi.equals(depVersion, event.fixed) ||
            versioningApi.isGreaterThan(depVersion, event.fixed))
        ) {
          vulnerable = false;
        } else if (
          is.nonEmptyString(event.last_affected) &&
          versioningApi.isVersion(event.last_affected) &&
          versioningApi.isGreaterThan(depVersion, event.last_affected)
        ) {
          vulnerable = false;
        }
      }

      if (vulnerable) {
        return true;
      }
    }

    return false;
  }

  // https://ossf.github.io/osv-schema/#evaluation
  private isPackageVulnerable(
    ecosystem: Ecosystem,
    packageName: string,
    depVersion: string,
    affected: Osv.Affected,
    versioningApi: VersioningApi
  ): boolean {
    return (
      this.isPackageAffected(ecosystem, packageName, affected) &&
      (this.includedInVersions(depVersion, affected) ||
        this.includedInRanges(depVersion, affected, versioningApi))
    );
  }

  private getFixedVersion(
    ecosystem: Ecosystem,
    depVersion: string,
    affected: Osv.Affected,
    versioningApi: VersioningApi
  ): string | null {
    const fixedVersions: string[] = [];
    const lastAffectedVersions: string[] = [];

    for (const range of affected.ranges ?? []) {
      if (range.type === 'GIT') {
        continue;
      }

      for (const event of range.events) {
        if (is.nonEmptyString(event.fixed)) {
          fixedVersions.push(event.fixed);
        } else if (is.nonEmptyString(event.last_affected)) {
          lastAffectedVersions.push(event.last_affected);
        }
      }
    }

    fixedVersions.sort((a, b) => versioningApi.sortVersions(a, b));
    const fixedVersion = fixedVersions.find(
      (version) =>
        versioningApi.isVersion(version) &&
        versioningApi.isGreaterThan(version, depVersion)
    );
    if (fixedVersion) {
      return ecosystem === 'PyPI' ? `==${fixedVersion}` : fixedVersion;
    }

    lastAffectedVersions.sort((a, b) => versioningApi.sortVersions(a, b));
    const lastAffected = lastAffectedVersions.find(
      (version) =>
        versioningApi.isVersion(version) &&
        (versioningApi.equals(version, depVersion) ||
          versioningApi.isGreaterThan(version, depVersion))
    );
    if (lastAffected) {
      return `> ${lastAffected}`;
    }

    return null;
  }

  private convertToPackageRule(
    packageFileConfig: RenovateConfig & PackageFile,
    dep: PackageDependency,
    packageName: string,
    depVersion: string,
    fixedVersion: string,
    vulnerability: Osv.Vulnerability
  ): PackageRule {
    return {
      matchDatasources: [dep.datasource!],
      matchPackageNames: [packageName],
      matchCurrentVersion: depVersion,
      allowedVersions: fixedVersion,
      isVulnerabilityAlert: true,
      prBodyNotes: Vulnerabilities.generatePrBodyNotes(vulnerability),
      force: {
        ...packageFileConfig.vulnerabilityAlerts,
      },
    };
  }

  private static evaluateCvssVector(vector: string): [string, string] {
    try {
      const parsedCvss: CvssScore = parseCvssVector(vector);
      const severityLevel =
        parsedCvss.cvss3OverallSeverityText.charAt(0).toUpperCase() +
        parsedCvss.cvss3OverallSeverityText.slice(1);

      return [parsedCvss.baseScore.toFixed(1), severityLevel];
    } catch (err) {
      logger.debug(`Error processing CVSS vector ${vector}`);
    }

    return ['0', ''];
  }

  private static generatePrBodyNotes(
    vulnerability: Osv.Vulnerability
  ): string[] {
    let aliases = [vulnerability.id].concat(vulnerability.aliases ?? []).sort();
    aliases = aliases.map((id) => {
      if (id.startsWith('CVE-')) {
        return `[${id}](https://nvd.nist.gov/vuln/detail/${id})`;
      } else if (id.startsWith('GHSA-')) {
        return `[${id}](https://github.com/advisories/${id})`;
      } else if (id.startsWith('GO-')) {
        return `[${id}](https://pkg.go.dev/vuln/${id})`;
      } else if (id.startsWith('RUSTSEC-')) {
        return `[${id}](https://rustsec.org/advisories/${id}.html)`;
      }

      return id;
    });

    let content = '\n\n---\n\n### ';
    content += vulnerability.summary ? `${vulnerability.summary}\n` : '';
    content += `${aliases.join(' / ')}\n`;
    content += `\n<details>\n<summary>More information</summary>\n`;
    content += `### Details\n${vulnerability.details ?? 'No details'}\n`;
    content += '### Severity\n';
    if (vulnerability.severity?.[0].score) {
      const [score, severity] = this.evaluateCvssVector(
        vulnerability.severity[0].score
      );
      content += `- Score: ${score} / 10 (${severity})\n`;
      content += `- Vector: \`${vulnerability.severity?.[0].score}\`\n`;
    } else {
      content += 'Unknown severity\n';
    }
    content += `\n### References\n${
      vulnerability.references
        ?.map((ref) => {
          return `- [${ref.url}](${ref.url})`;
        })
        .join('\n') ?? 'No references'
    }`;

    let attribution = '';
    if (vulnerability.id.startsWith('GHSA-')) {
      attribution = ` and the [GitHub Advisory Database](https://github.com/github/advisory-database) ([CC-BY 4.0](https://github.com/github/advisory-database/blob/main/LICENSE.md))`;
    } else if (vulnerability.id.startsWith('GO-')) {
      attribution = ` and the [Go Vulnerability Database](https://github.com/golang/vulndb) ([CC-BY 4.0](https://github.com/golang/vulndb#license))`;
    } else if (vulnerability.id.startsWith('PYSEC-')) {
      attribution = ` and the [PyPI Advisory Database](https://github.com/pypa/advisory-database) ([CC-BY 4.0](https://github.com/pypa/advisory-database/blob/main/LICENSE))`;
    } else if (vulnerability.id.startsWith('RUSTSEC-')) {
      attribution = ` and the [Rust Advisory Database](https://github.com/RustSec/advisory-db) ([CC0 1.0](https://github.com/rustsec/advisory-db/blob/main/LICENSE.txt))`;
    }
    content += `\n\nThis data is provided by [OSV](https://osv.dev/vulnerability/${vulnerability.id})${attribution}.\n`;
    content += `</details>`;

    return [sanitizeMarkdown(content)];
  }
}

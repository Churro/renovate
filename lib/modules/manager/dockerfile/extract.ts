import is from '@sindresorhus/is';
import { logger } from '../../../logger';
import { newlineRegex, regEx } from '../../../util/regex';
import { DockerDatasource } from '../../datasource/docker';
import * as debianVersioning from '../../versioning/debian';
import * as ubuntuVersioning from '../../versioning/ubuntu';
import type { PackageDependency, PackageFile } from '../types';

const variableMarker = '$';
const variableOpen = '${';
const variableClose = '}';
const variableDefaultValueSplit = ':-';

export function extractVariables(image: string): Record<string, string> {
  const variables: Record<string, string> = {};
  const variableRegex = regEx(
    /(?<fullvariable>\\?\$(?<simplearg>\w+)|\\?\${(?<complexarg>\w+)(?::.+?)?}+)/gi
  );

  let match: RegExpExecArray | null;
  do {
    match = variableRegex.exec(image);
    if (match?.groups?.fullvariable) {
      variables[match.groups.fullvariable] =
        match.groups?.simplearg || match.groups?.complexarg;
    }
  } while (match);

  return variables;
}

export function splitImageParts(currentFrom: string): PackageDependency {
  // Check if we have a variable in format of "${VARIABLE:-<image>:<defaultVal>@<digest>}"
  // If so, remove everything except the image, defaultVal and digest.
  let isVariable = false;
  let cleanedCurrentFrom: string = currentFrom;
  if (
    currentFrom.startsWith(variableOpen) &&
    currentFrom.endsWith(variableClose)
  ) {
    isVariable = true;

    // If the variable contains exactly one $ and has the default value, we consider it as a valid dependency;
    // otherwise skip it.
    if (
      currentFrom.split('$').length !== 2 ||
      currentFrom.indexOf(variableDefaultValueSplit) === -1
    ) {
      return {
        skipReason: 'contains-variable',
      };
    }

    cleanedCurrentFrom = currentFrom.substr(
      variableOpen.length,
      currentFrom.length - (variableClose.length + 2)
    );
    cleanedCurrentFrom = cleanedCurrentFrom.substr(
      cleanedCurrentFrom.indexOf(variableDefaultValueSplit) +
        variableDefaultValueSplit.length
    );
  }

  const [currentDepTag, currentDigest] = cleanedCurrentFrom.split('@');
  const depTagSplit = currentDepTag.split(':');
  let depName: string;
  let currentValue: string | undefined;
  if (
    depTagSplit.length === 1 ||
    depTagSplit[depTagSplit.length - 1].includes('/')
  ) {
    depName = currentDepTag;
  } else {
    currentValue = depTagSplit.pop();
    depName = depTagSplit.join(':');
  }

  if (depName?.includes(variableMarker)) {
    // If depName contains a variable, after cleaning, e.g. "$REGISTRY/alpine", we do not support this.
    return {
      skipReason: 'contains-variable',
    };
  }

  if (currentValue?.includes(variableMarker)) {
    // If tag contains a variable, e.g. "5.0${VERSION_SUFFIX}", we do not support this.
    return {
      skipReason: 'contains-variable',
    };
  }

  if (isVariable) {
    // If we have the variable and it contains the default value, we need to return
    // it as a valid dependency.

    const dep: PackageDependency = {
      depName,
      currentValue,
      currentDigest,
      replaceString: cleanedCurrentFrom,
    };

    if (!dep.currentValue) {
      delete dep.currentValue;
    }

    if (!dep.currentDigest) {
      delete dep.currentDigest;
    }

    return dep;
  }

  const dep: PackageDependency = {
    depName,
    currentValue,
    currentDigest,
  };
  return dep;
}

const quayRegex = regEx(/^quay\.io(?::[1-9][0-9]{0,4})?/i);

export function getDep(
  currentFrom: string | null | undefined,
  specifyReplaceString = true
): PackageDependency {
  if (!is.string(currentFrom)) {
    return {
      skipReason: 'invalid-value',
    };
  }
  const dep = splitImageParts(currentFrom);
  if (specifyReplaceString) {
    if (!dep.replaceString) {
      dep.replaceString = currentFrom;
    }
    dep.autoReplaceStringTemplate =
      '{{depName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
  }
  dep.datasource = DockerDatasource.id;

  // Pretty up special prefixes
  if (dep.depName) {
    const specialPrefixes = ['amd64', 'arm64', 'library'];
    for (const prefix of specialPrefixes) {
      if (dep.depName.startsWith(`${prefix}/`)) {
        dep.packageName = dep.depName;
        dep.depName = dep.depName.replace(`${prefix}/`, '');
        if (specifyReplaceString) {
          dep.autoReplaceStringTemplate =
            '{{packageName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
        }
      }
    }
  }

  if (dep.depName === 'ubuntu') {
    dep.versioning = ubuntuVersioning.id;
  }

  if (dep.depName === 'debian') {
    dep.versioning = debianVersioning.id;
  }

  // Don't display quay.io ports
  if (dep.depName && quayRegex.test(dep.depName)) {
    const depName = dep.depName.replace(quayRegex, 'quay.io');
    if (depName !== dep.depName) {
      dep.packageName = dep.depName;
      dep.depName = depName;
      dep.autoReplaceStringTemplate =
        '{{packageName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
    }
  }

  return dep;
}

export function extractPackageFile(content: string): PackageFile | null {
  const deps: PackageDependency[] = [];
  const stageNames: string[] = [];
  const args: Record<string, string> = {};
  const argsLines: Record<string, number[]> = {};

  let escapeChar = '\\\\';
  let lookForEscapeChar = true;

  const lines = content.split(newlineRegex);
  for (let lineNumber = 0; lineNumber < lines.length; ) {
    const lineNumberInstrStart = lineNumber;
    let instruction = lines[lineNumber];

    if (lookForEscapeChar) {
      const directivesMatch = regEx(
        /^[ \t]*#[ \t]*(?<directive>syntax|escape)[ \t]*=[ \t]*(?<escapeChar>\S)/i
      ).exec(instruction);
      if (!directivesMatch) {
        lookForEscapeChar = false;
      } else if (directivesMatch.groups?.directive.toLowerCase() === 'escape') {
        if (directivesMatch.groups?.escapeChar === '`') {
          escapeChar = '`';
        }
        lookForEscapeChar = false;
      }
    }

    const lineContinuationRegex = regEx(escapeChar + '[ \\t]*$|^[ \\t]*#', 'm');
    let lineLookahead = instruction;
    while (
      !lookForEscapeChar &&
      !instruction.trimStart().startsWith('#') &&
      lineContinuationRegex.test(lineLookahead)
    ) {
      lineLookahead = lines[++lineNumber] || '';
      instruction += '\n' + lineLookahead;
    }

    const argRegex = regEx(
      '^[ \\t]*ARG(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n)+(?<name>\\S+)[ =](?<value>.*)',
      'im'
    );
    const argMatch = argRegex.exec(instruction);
    if (argMatch?.groups?.name) {
      argsLines[argMatch.groups.name] = [lineNumberInstrStart, lineNumber];
      let argMatchValue = argMatch.groups?.value;

      if (
        argMatchValue.charAt(0) === '"' &&
        argMatchValue.charAt(argMatchValue.length - 1) === '"'
      ) {
        argMatchValue = argMatchValue.slice(1, -1);
      }

      args[argMatch.groups.name] = argMatchValue || '';
    }

    const fromRegex = new RegExp(
      '^[ \\t]*FROM(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n|--platform=\\S+)+(?<image>\\S+)(?:(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n)+as[ \\t]+(?<name>\\S+))?',
      'im'
    ); // TODO #12875 complex for re2 has too many not supported groups
    const fromMatch = instruction.match(fromRegex);
    if (fromMatch?.groups?.image) {
      let fromImage = fromMatch.groups.image;
      const lineNumberRanges: number[][] = [[lineNumberInstrStart, lineNumber]];

      if (fromImage.includes(variableMarker)) {
        const variables = extractVariables(fromImage);
        for (const [fullVariable, argName] of Object.entries(variables)) {
          const resolvedArgValue = args[argName];
          if (resolvedArgValue || resolvedArgValue === '') {
            fromImage = fromImage.replace(fullVariable, resolvedArgValue);
            lineNumberRanges.push(argsLines[argName]);
          }
        }
      }

      if (fromMatch.groups?.name) {
        logger.debug('Found a multistage build stage name');
        stageNames.push(fromMatch.groups.name);
      }
      if (fromImage === 'scratch') {
        logger.debug('Skipping scratch');
      } else if (fromImage && stageNames.includes(fromImage)) {
        logger.debug({ image: fromImage }, 'Skipping alias FROM');
      } else {
        const dep = getDep(fromImage);
        dep.managerData = { lineNumberRanges };
        logger.trace(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
          },
          'Dockerfile FROM'
        );
        deps.push(dep);
      }
    }

    const copyFromRegex = new RegExp(
      '^[ \\t]*COPY(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n|--[a-z]+=[a-zA-Z0-9_.:-]+?)+--from=(?<image>\\S+)',
      'im'
    ); // TODO #12875 complex for re2 has too many not supported groups
    const copyFromMatch = instruction.match(copyFromRegex);
    if (copyFromMatch?.groups?.image) {
      if (stageNames.includes(copyFromMatch.groups.image)) {
        logger.debug(
          { image: copyFromMatch.groups.image },
          'Skipping alias COPY --from'
        );
      } else if (Number.isNaN(Number(copyFromMatch.groups.image))) {
        const dep = getDep(copyFromMatch.groups.image);
        const lineNumberRanges: number[][] = [
          [lineNumberInstrStart, lineNumber],
        ];
        dep.managerData = { lineNumberRanges };
        logger.debug(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
          },
          'Dockerfile COPY --from'
        );
        deps.push(dep);
      } else {
        logger.debug(
          { image: copyFromMatch.groups.image },
          'Skipping index reference COPY --from'
        );
      }
    }

    lineNumber += 1;
  }

  if (!deps.length) {
    return null;
  }
  for (const d of deps) {
    d.depType = 'stage';
  }
  deps[deps.length - 1].depType = 'final';
  return { deps };
}

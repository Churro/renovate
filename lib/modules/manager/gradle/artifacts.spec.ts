import os from 'os';
import { join } from 'upath';
import {
  envMock,
  mockExecAll,
  mockExecSequence,
} from '../../../../test/exec-util';
import {
  env,
  fs,
  git,
  logger,
  mockedFunction,
  partial,
} from '../../../../test/util';
import { GlobalConfig } from '../../../config/global';
import type { RepoGlobalConfig } from '../../../config/types';
import { TEMPORARY_ERROR } from '../../../constants/error-messages';
import { resetPrefetchedImages } from '../../../util/exec/docker';
import { ExecError } from '../../../util/exec/exec-error';
import type { StatusResult } from '../../../util/git/types';
import { getPkgReleases } from '../../datasource';
import { updateArtifacts } from '.';

const platform = jest.spyOn(os, 'platform');
jest.mock('../../../util/fs');
jest.mock('../../../util/git');
jest.mock('../../../util/exec/env');
jest.mock('../../datasource');

process.env.BUILDPACK = 'true';

const adminConfig: RepoGlobalConfig = {
  // `join` fixes Windows CI
  localDir: join('/tmp/github/some/repo'),
  cacheDir: join('/tmp/cache'),
  containerbaseDir: join('/tmp/cache/containerbase'),
};

jest.spyOn(os, 'platform').mockReturnValue('linux');

describe('modules/manager/gradle/artifacts', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    env.getChildProcessEnv.mockReturnValue({
      ...envMock.basic,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US',
    });

    GlobalConfig.set(adminConfig);
    resetPrefetchedImages();

    // java
    mockedFunction(getPkgReleases).mockResolvedValueOnce({
      releases: [
        { version: '8.0.1' },
        { version: '11.0.1' },
        { version: '16.0.1' },
        { version: '17.0.0' },
      ],
    });

    platform.mockReturnValueOnce('linux');
    fs.findUpLocal.mockResolvedValue('gradlew');

    git.getFileList.mockResolvedValue([
      'gradlew',
      'build.gradle',
      'gradle.lockfile',
    ]);
    git.getFile.mockResolvedValue('Current gradle.lockfile');
    fs.readLocalFile.mockResolvedValue('New gradle.lockfile');
  });

  it('aborts if no lockfile is found', async () => {
    const execSnapshots = mockExecAll();
    git.getFileList.mockResolvedValue(['build.gradle', 'settings.gradle']);

    expect(
      await updateArtifacts({
        packageFileName: 'build.gradle',
        updatedDeps: [],
        newPackageFileContent: '',
        config: {},
      })
    ).toBeNull();

    expect(logger.logger.debug).toHaveBeenCalledWith(
      'No Gradle dependency lockfiles found - skipping update'
    );
    expect(execSnapshots).toBeEmptyArray();
  });

  it('aborts if lock file exists but no gradle wrapper', async () => {
    const execSnapshots = mockExecAll();
    fs.findUpLocal.mockResolvedValue(null);

    expect(
      await updateArtifacts({
        packageFileName: 'build.gradle',
        updatedDeps: [],
        newPackageFileContent: '',
        config: {},
      })
    ).toBeNull();

    expect(logger.logger.debug).toHaveBeenCalledWith(
      'Found Gradle dependency lockfiles but no gradlew - aborting update'
    );
    expect(execSnapshots).toBeEmptyArray();
  });

  it('updates lock file', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({
        modified: ['build.gradle', 'gradle.lockfile'],
      })
    );

    const res = await updateArtifacts({
      packageFileName: 'build.gradle',
      updatedDeps: [
        { depName: 'org.junit.jupiter:junit-jupiter-api' },
        { depName: 'org.junit.jupiter:junit-jupiter-engine' },
      ],
      newPackageFileContent: '',
      config: {},
    });

    expect(res).toEqual([
      {
        file: {
          type: 'addition',
          path: 'gradle.lockfile',
          contents: 'New gradle.lockfile',
        },
      },
    ]);
    expect(execSnapshots).toMatchObject([
      {
        cmd: './gradlew --console=plain -q properties',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
      {
        cmd: './gradlew --console=plain -q :dependencies --update-locks org.junit.jupiter:junit-jupiter-api,org.junit.jupiter:junit-jupiter-engine',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
    ]);
  });

  it('prefers packageName over depName if provided', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({
        modified: ['build.gradle', 'gradle.lockfile'],
      })
    );

    expect(
      await updateArtifacts({
        packageFileName: 'build.gradle',
        updatedDeps: [
          {
            depType: 'plugin',
            depName: 'org.springframework.boot',
            packageName:
              'org.springframework.boot:org.springframework.boot.gradle.plugin',
          },
        ],
        newPackageFileContent: '',
        config: {},
      })
    ).not.toBeNull();

    expect(execSnapshots).toMatchObject([
      {
        cmd: './gradlew --console=plain -q properties',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
      {
        cmd: './gradlew --console=plain -q :dependencies --update-locks org.springframework.boot:org.springframework.boot.gradle.plugin',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
    ]);
  });

  it('performs lock file maintenance', async () => {
    const execSnapshots = mockExecAll();
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({
        modified: ['gradle.lockfile'],
      })
    );
    expect(
      await updateArtifacts({
        packageFileName: 'build.gradle',
        updatedDeps: [],
        newPackageFileContent: '',
        config: { isLockFileMaintenance: true },
      })
    ).not.toBeNull();

    expect(execSnapshots).toMatchObject([
      {
        cmd: './gradlew --console=plain -q properties',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
      {
        cmd: './gradlew --console=plain -q :dependencies --write-locks',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
    ]);
  });

  it('updates all included projects', async () => {
    const execSnapshots = mockExecSequence([
      { stdout: "subprojects: [project ':sub1', project ':sub2']", stderr: '' },
      { stdout: '', stderr: '' },
    ]);
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({
        modified: ['gradle.lockfile'],
      })
    );

    expect(
      await updateArtifacts({
        packageFileName: 'build.gradle',
        updatedDeps: [],
        newPackageFileContent: '',
        config: { isLockFileMaintenance: true },
      })
    ).not.toBeNull();

    expect(execSnapshots).toMatchObject([
      {
        cmd: './gradlew --console=plain -q properties',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
      {
        cmd: './gradlew --console=plain -q :dependencies :sub1:dependencies :sub2:dependencies --write-locks',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
    ]);
  });

  it('does not update lockfile if content is unchanged', async () => {
    mockExecAll();
    fs.readLocalFile.mockResolvedValue('Current gradle.lockfile');
    git.getRepoStatus.mockResolvedValue(
      partial<StatusResult>({
        modified: ['gradle.lockfile'],
      })
    );

    expect(
      await updateArtifacts({
        packageFileName: 'build.gradle',
        updatedDeps: [],
        newPackageFileContent: '',
        config: { isLockFileMaintenance: true },
      })
    ).toBeNull();
  });

  it('gradlew failed', async () => {
    const execSnapshots = mockExecAll(new Error('failed'));

    expect(
      await updateArtifacts({
        packageFileName: 'build.gradle',
        updatedDeps: [],
        newPackageFileContent: '',
        config: { isLockFileMaintenance: true },
      })
    ).toEqual([
      {
        artifactError: {
          lockFile: 'build.gradle',
          stderr: 'failed',
        },
      },
    ]);

    expect(execSnapshots).toHaveLength(1);
    expect(execSnapshots).toMatchObject([
      {
        cmd: './gradlew --console=plain -q properties',
        options: {
          cwd: '/tmp/github/some/repo',
        },
      },
    ]);
  });

  it('rethrows temporary error', async () => {
    const execError = new ExecError(TEMPORARY_ERROR, {
      cmd: '',
      stdout: '',
      stderr: '',
      options: { encoding: 'utf8' },
    });
    mockExecAll(execError);

    await expect(
      updateArtifacts({
        packageFileName: 'build.gradle',
        updatedDeps: [],
        newPackageFileContent: '{}',
        config: {},
      })
    ).rejects.toThrow(TEMPORARY_ERROR);
  });
});

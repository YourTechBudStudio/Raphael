/**
 * `pnpm package`: the one release artifact, built from the locked installation.
 *
 * Everything this writes lives under the repository's `release/`, which packaging owns and recreates:
 *
 *   release/package/       the staged package, exactly what the tarball holds
 *   release/<npm name>.tgz the tarball npm made from it
 *   release/release.json   what was made: identity, tarball path, checksums, and file listing
 *
 * Source manifests and the lockfile are read, never written. Any failed check stops packaging with
 * nothing left that looks like a finished artifact: `release.json` is written last.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkArchive, pack, readArchive } from './archive.ts';
import { bundle, checkBundle } from './bundle.ts';
import { PackagingError } from './errors.ts';
import { listFiles } from './files.ts';
import { BIN_NAME, BIN_PATH, NOTICES_FILE, releaseManifest } from './manifest.ts';
import { stageMigrations } from './migrations.ts';
import { distributedPackages, describePackage, renderNotices } from './notices.ts';
import { checkDatabaseConstruction, SQLITE_VENDOR_PATH, stageSqlite } from './sqlite.ts';

export const RELEASE_METADATA = 'release.json';

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const resetReleaseDir = (releaseDir: string): void => {
  try {
    if (lstatSync(releaseDir).isSymbolicLink()) {
      throw new PackagingError(`"${releaseDir}" is a symbolic link; refusing to clear it.`);
    }
    rmSync(releaseDir, { recursive: true });
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  mkdirSync(releaseDir);
};

const buildWorkspaceDependencies = (repoRoot: string, cliName: string): void => {
  // Only what the CLI depends on, through the same filter `backend:start` uses; never the mobile app.
  const ran = spawnSync(
    'pnpm',
    ['-r', '--workspace-concurrency=1', '--filter', `${cliName}^...`, '--if-present', 'build'],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (ran.status !== 0) {
    throw new PackagingError(
      `building the CLI's workspace dependencies failed (${String(ran.status)}).`,
    );
  }
};

const checkBin = (path: string): void => {
  if (!readFileSync(path, 'utf8').startsWith('#!/usr/bin/env node\n')) {
    throw new PackagingError(`"${path}" does not start with a node shebang.`);
  }
  chmodSync(path, 0o755);
};

const checkStaged = (files: readonly string[]): void => {
  const undeclared = files.filter(
    (file) => file !== 'package.json' && file !== NOTICES_FILE && !file.startsWith('dist/'),
  );
  if (undeclared.length > 0) {
    throw new PackagingError(`undeclared files were staged: ${undeclared.join(', ')}`);
  }
};

export const packageRelease = async (repoRoot: string): Promise<string> => {
  const cliRoot = join(repoRoot, 'apps', 'cli');
  const backendRoot = join(repoRoot, 'apps', 'backend');
  const releaseDir = join(repoRoot, 'release');
  const stageDir = join(releaseDir, 'package');
  const distDir = join(stageDir, 'dist');

  // Identity and version are settled before any work, so an invalid root version costs nothing.
  const cliManifest = readJson(join(cliRoot, 'package.json'));
  const manifest = releaseManifest(readJson(join(repoRoot, 'package.json')), cliManifest);

  resetReleaseDir(releaseDir);
  buildWorkspaceDependencies(repoRoot, manifest.name);

  const metafile = await bundle(repoRoot, distDir);
  checkBundle(metafile, repoRoot, distDir);
  checkBin(join(stageDir, BIN_PATH));

  stageMigrations(join(backendRoot, 'drizzle'), join(distDir, 'drizzle'));

  checkDatabaseConstruction(join(backendRoot, 'src'));
  const sqliteRoot = realpathSync(
    dirname(
      createRequire(join(backendRoot, 'package.json')).resolve('better-sqlite3/package.json'),
    ),
  );
  stageSqlite(sqliteRoot, join(distDir, SQLITE_VENDOR_PATH));

  const distributed = distributedPackages(
    Object.keys(metafile.inputs).map((input) => join(repoRoot, input)),
  );
  writeFileSync(
    join(stageDir, NOTICES_FILE),
    renderNotices([...distributed, describePackage(sqliteRoot)]),
  );
  writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const staged = listFiles(stageDir);
  checkStaged(staged);

  const packed = pack(stageDir, releaseDir);
  const tarball = join(releaseDir, packed.filename);
  const entries = readArchive(tarball);
  checkArchive(entries, staged, BIN_PATH);

  const metadataPath = join(releaseDir, RELEASE_METADATA);
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        bin: BIN_NAME,
        tarball: relative(repoRoot, tarball),
        integrity: packed.integrity,
        shasum: packed.shasum,
        size: packed.size,
        files: entries.map((entry) => ({
          path: entry.path.slice('package/'.length),
          mode: entry.mode.toString(8),
          size: entry.size,
        })),
      },
      null,
      2,
    )}\n`,
  );
  return metadataPath;
};

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  try {
    const metadata = await packageRelease(repoRoot);
    const { tarball, version } = readJson(metadata) as { tarball: string; version: string };
    process.stdout.write(
      `Packaged ${version}: ${tarball}\nMetadata: ${relative(repoRoot, metadata)}\n`,
    );
  } catch (error) {
    if (!(error instanceof PackagingError)) throw error;
    process.stderr.write(`Packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

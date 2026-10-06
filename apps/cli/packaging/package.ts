/**
 * `pnpm package`: the one release artifact, built from the locked installation and verified.
 *
 * Everything this writes lives under a release directory - the repository's `release/` for
 * `pnpm package` - which packaging owns and recreates:
 *
 *   package/       the staged package, exactly what the tarball holds
 *   <npm name>.tgz the tarball npm made from it
 *   release.json   the receipt: identity, the tarball's filename beside it, checksums, file listing,
 *                  and the record of the behavioural verification that tarball passed
 *
 * Source manifests and the lockfile are read, never written. Any failed check, including the
 * verification of the installed tarball, stops packaging with nothing left that looks like a finished
 * artifact: `release.json` is written last.
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
import { RELEASE_METADATA } from './receipt.ts';
import { checkDatabaseConstruction, SQLITE_VENDOR_PATH, stageSqlite } from './sqlite.ts';
import { interruptOnSignals, verifyArtifact } from './verify.ts';

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

export interface PackageOptions {
  /**
   * Whether to build the CLI's workspace dependencies first. Always true for `pnpm package`. Only the
   * artifact tests turn it off: they run beside other test files that import those same outputs, and
   * `pnpm test` has already built them. Nothing else about packaging changes.
   */
  readonly buildDependencies?: boolean;
  readonly log?: (line: string) => void;
  /** Stops packaging between steps, and verification (with its cleanup) at once. */
  readonly signal?: AbortSignal;
}

export const packageRelease = async (
  repoRoot: string,
  releaseDir: string,
  { buildDependencies = true, log = () => {}, signal }: PackageOptions = {},
): Promise<string> => {
  const checkpoint = (): void => {
    if (signal?.aborted === true) throw new PackagingError('packaging was interrupted.');
  };
  const cliRoot = join(repoRoot, 'apps', 'cli');
  const backendRoot = join(repoRoot, 'apps', 'backend');
  const stageDir = join(releaseDir, 'package');
  const distDir = join(stageDir, 'dist');

  // Identity and version are settled before any work, so an invalid root version costs nothing.
  const cliManifest = readJson(join(cliRoot, 'package.json'));
  const manifest = releaseManifest(readJson(join(repoRoot, 'package.json')), cliManifest);

  resetReleaseDir(releaseDir);
  if (buildDependencies) buildWorkspaceDependencies(repoRoot, manifest.name);
  checkpoint();

  let metafile;
  try {
    metafile = await bundle(repoRoot, distDir);
  } catch (error) {
    if (buildDependencies || error instanceof PackagingError) throw error;
    throw new PackagingError(
      `bundling failed without building workspace dependencies; run "pnpm build:libs" first.\n${String(error)}`,
    );
  }
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

  checkpoint();
  const packed = pack(stageDir, releaseDir);
  const tarball = join(releaseDir, packed.filename);
  const entries = readArchive(tarball);
  checkArchive(entries, staged, BIN_PATH);

  log(`verifying ${packed.filename}`);
  const verification = await verifyArtifact(tarball, {
    version: manifest.version,
    engines: manifest.engines.node,
    log,
    ...(signal === undefined ? {} : { signal }),
  });
  checkpoint();
  if (verification.integrity !== packed.integrity) {
    throw new PackagingError('the verified tarball is not the one npm packed.');
  }

  const metadataPath = join(releaseDir, RELEASE_METADATA);
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        bin: BIN_NAME,
        tarball: packed.filename,
        integrity: packed.integrity,
        shasum: packed.shasum,
        size: packed.size,
        files: entries.map((entry) => ({
          path: entry.path.slice('package/'.length),
          mode: entry.mode.toString(8),
          size: entry.size,
        })),
        verification,
      },
      null,
      2,
    )}\n`,
  );
  return metadataPath;
};

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  const interruption = interruptOnSignals();
  try {
    const metadata = await packageRelease(repoRoot, join(repoRoot, 'release'), {
      log: (line) => process.stdout.write(`${line}\n`),
      signal: interruption.signal,
    });
    const { tarball, version } = readJson(metadata) as { tarball: string; version: string };
    process.stdout.write(
      `Packaged and verified ${version}: ${relative(repoRoot, join(dirname(metadata), tarball))}\n` +
        `Metadata: ${relative(repoRoot, metadata)}\n`,
    );
  } catch (error) {
    if (!(error instanceof PackagingError)) throw error;
    process.stderr.write(`Packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    interruption.dispose();
  }
  process.exitCode = interruption.exitCode() ?? process.exitCode;
}

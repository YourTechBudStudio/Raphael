/**
 * `pnpm versions:sync [version]`: gives every workspace package and the Expo app the root's version.
 *
 * The root `package.json` is the only release-version authority. With a version argument, the root
 * is set to it first; without one, the root's current version is spread as it stands. Versions are
 * checked with the same pattern the CLI release uses, so anything synced here can be published.
 *
 * Only `version` fields change. `app.json` is edited as text, replacing just its version string, so
 * the formatter's layout is preserved.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEMVER } from '../apps/cli/packaging/manifest.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

class SyncError extends Error {}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const checkVersion = (version: unknown, label: string): string => {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new SyncError(`${label} ${JSON.stringify(version)} is not a semantic version.`);
  }
  return version;
};

/** The `packages:` globs of `pnpm-workspace.yaml`. Only `dir/*` and plain directories are used here. */
const workspacePatterns = (): string[] => {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8').split(/\r?\n/)) {
    if (line === 'packages:') {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item?.[1] === undefined) break;
    patterns.push(item[1].replace(/^['"]|['"]$/g, ''));
  }
  if (patterns.length === 0) throw new SyncError('pnpm-workspace.yaml lists no packages.');
  return patterns;
};

const workspaceManifests = (): string[] =>
  workspacePatterns().flatMap((pattern) => {
    if (pattern.includes('*') && !pattern.endsWith('/*')) {
      throw new SyncError(`unsupported workspace pattern ${JSON.stringify(pattern)}.`);
    }
    const directories = pattern.endsWith('/*')
      ? (() => {
          const parent = join(repoRoot, pattern.slice(0, -2));
          return existsSync(parent)
            ? readdirSync(parent, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => join(parent, entry.name))
            : [];
        })()
      : [join(repoRoot, pattern)];
    return directories
      .map((directory) => join(directory, 'package.json'))
      .filter((path) => existsSync(path));
  });

/** Returns whether the file changed. */
const syncManifest = (path: string, version: string): boolean => {
  const manifest = readJson(path);
  if (manifest.version === version) return false;
  writeJson(path, { ...manifest, version });
  return true;
};

/** Returns whether the file changed. */
const syncExpoApp = (path: string, version: string): boolean => {
  const source = readFileSync(path, 'utf8');
  const expo = readJson(path).expo as { version?: unknown } | undefined;
  if (expo?.version === undefined || expo.version === version) return false;
  const updated = source.replace(
    `"version": ${JSON.stringify(expo.version)}`,
    `"version": ${JSON.stringify(version)}`,
  );
  if ((JSON.parse(updated) as { expo: { version: unknown } }).expo.version !== version) {
    throw new SyncError(`could not update expo.version in ${relative(repoRoot, path)}.`);
  }
  writeFileSync(path, updated);
  return true;
};

const main = (argv: readonly string[]): string => {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.length > 1) throw new SyncError('usage: pnpm versions:sync [version]');

  const rootPath = join(repoRoot, 'package.json');
  const version =
    args[0] === undefined
      ? checkVersion(readJson(rootPath).version, 'the root "version"')
      : checkVersion(args[0], 'the requested version');

  const manifests = workspaceManifests();
  const apps = manifests
    .map((path) => join(dirname(path), 'app.json'))
    .filter((path) => existsSync(path));

  const changed = [
    ...[rootPath, ...manifests].filter((path) => syncManifest(path, version)),
    ...apps.filter((path) => syncExpoApp(path, version)),
  ];

  const listing = changed.map((path) => `  ${relative(repoRoot, path)}\n`).join('');
  return changed.length === 0
    ? `Everything is already at ${version}.`
    : `Set ${version} in ${changed.length} file(s):\n${listing.trimEnd()}`;
};

try {
  process.stdout.write(`${main(process.argv.slice(2))}\n`);
} catch (error) {
  if (!(error instanceof SyncError)) throw error;
  process.stderr.write(`Version sync failed: ${error.message}\n`);
  process.exitCode = 1;
}

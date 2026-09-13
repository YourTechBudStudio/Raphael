/**
 * Build, pack, and install Raphael the way someone who is not us would receive it.
 *
 * Everything earlier in this plan ran from the workspace: `node apps/cli/src/main.ts`, source
 * resolved through pnpm's workspace links, assets found beside the files that reference them because
 * those files were still in the repository. None of that establishes that a *packaged* Raphael works.
 * The failures this catches are the ones a workspace cannot have: an asset excluded from `files`, a
 * dependency that was only ever a devDependency, a path resolved from the working directory that
 * happened to be the package root, a native driver that is present in the store and absent from an
 * install.
 *
 * So: pack real tarballs, inspect them, install them into a project that is not in this repository,
 * and drive the installed `raphael` binary. The one thing this must never do is *repair* what it
 * packed. Overrides here redirect first-party packages that have no registry to be fetched from, and
 * do nothing else; if a tarball is missing a file, that is the finding, and rewriting it to get a
 * green run would destroy the only evidence this harness exists to produce.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOrThrow, temporaryDirectory } from './bounded.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, '..', '..', '..');

/**
 * The first-party runtime closure of the CLI.
 *
 * `@raphael/cli` depends on backend, client, contracts and fs-trust; the backend adds content. The
 * shared TypeScript configuration is a devDependency and is deliberately absent - a production
 * install must not need a compiler configuration, and if this list ever has to grow to make an
 * install succeed, that growth is itself a finding about what we are shipping.
 */
export const FIRST_PARTY = [
  'cli',
  'backend',
  'client',
  'content',
  'contracts',
  'fs-trust',
] as const;

export interface PackedTarball {
  readonly name: string;
  readonly file: string;
  readonly sha256: string;
  readonly manifest: Record<string, unknown>;
  readonly entries: readonly string[];
}

export interface Installation {
  readonly root: string;
  /** A directory outside the installation, to run commands from. Nothing resolves relative to it. */
  readonly foreignCwd: string;
  /** Isolated HOME and XDG_CONFIG_HOME, so no real saved login is readable or writable. */
  readonly home: string;
  /** The shim a user actually invokes: `node_modules/.bin/raphael`. Not a JavaScript file. */
  readonly binary: string;
  /** The compiled entry point inside the installed CLI, for runs that need `node` options. */
  readonly entry: string;
  readonly tarballs: readonly PackedTarball[];
  readonly installGraph: string;
  readonly toolVersions: { readonly node: string; readonly pnpm: string };
}

const PATH_ONLY = { PATH: process.env['PATH'] ?? '' } as const;

/**
 * The environment an installed command sees.
 *
 * Deliberately not this process's environment. A developer machine running these tests may well have
 * `RAPHAEL_ENDPOINT` and `RAPHAEL_API_KEY` exported and a real saved login in `~/.config`; inheriting
 * either would let a test pass against the owner's own server, which is both wrong and unsafe. HOME
 * and XDG_CONFIG_HOME point inside the run's temporary tree, so the credential the CLI would read or
 * write is one this harness created and deletes.
 */
export const isolatedEnvironment = (
  installation: Installation,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: installation.home,
  XDG_CONFIG_HOME: join(installation.home, '.config'),
  ...extra,
});

const readManifestFromTarball = async (
  file: string,
  cwd: string,
): Promise<Record<string, unknown>> => {
  const ran = await runOrThrow('tar', ['-xzOf', file, 'package/package.json'], {
    cwd,
    env: PATH_ONLY,
    timeoutMs: 60_000,
  });
  return JSON.parse(ran.stdout) as Record<string, unknown>;
};

const listTarball = async (file: string, cwd: string): Promise<readonly string[]> => {
  const ran = await runOrThrow('tar', ['-tzf', file], { cwd, env: PATH_ONLY, timeoutMs: 60_000 });
  return ran.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^package\//, ''));
};

/**
 * Build the closure, pack each package, and read back what was actually packed.
 *
 * `pnpm pack` is what rewrites `workspace:*` and `catalog:` into real, installable specifications;
 * the packed manifests are checked for that, because a tarball carrying a protocol no registry
 * understands is an artifact nobody could install.
 */
export const packFirstParty = async (): Promise<readonly PackedTarball[]> => {
  const destination = temporaryDirectory('tarballs');

  await runOrThrow('pnpm', ['--filter', '@raphael/cli...', 'build'], {
    cwd: repositoryRoot,
    env: PATH_ONLY,
    timeoutMs: 600_000,
  });

  const packed: PackedTarball[] = [];
  for (const short of FIRST_PARTY) {
    const name = `@raphael/${short}`;
    const ran = await runOrThrow(
      'pnpm',
      ['--filter', name, 'pack', '--pack-destination', destination],
      { cwd: repositoryRoot, env: PATH_ONLY, timeoutMs: 300_000 },
    );
    // The filename is whatever pnpm says it wrote, never a name this file predicts. Assembling it
    // from a hard-coded version would put a second copy of the version here, and the first bump
    // would break the acceptance gate while packaging was perfectly correct.
    const file = ran.stdout
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.endsWith('.tgz'));
    if (file === undefined) {
      throw new Error(`pnpm pack did not report a tarball for ${name}:\n${ran.stdout}`);
    }
    packed.push({
      name,
      file,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      manifest: await readManifestFromTarball(file, destination),
      entries: await listTarball(file, destination),
    });
  }
  return packed;
};

/**
 * Install the packed CLI into a standalone project outside this repository.
 *
 * Two things are reproduced from the workspace on purpose. The `allowBuilds` entry is the *package
 * specific* policy this repository states for `better-sqlite3` - it ships prebuilt binaries and is
 * never compiled from source - and reproducing it here is what makes the install a real test of that
 * policy. Globally permitting builds to make an install succeed would answer a different question
 * than the one being asked.
 *
 * `pnpm-workspace.yaml` with no packages is how a standalone pnpm project carries overrides and build
 * policy in this version. The overrides exist only because these packages are unpublished; every
 * third-party dependency, including the native driver, is resolved and fetched normally.
 */
export const installPacked = async (tarballs: readonly PackedTarball[]): Promise<Installation> => {
  const root = temporaryDirectory('install');
  const foreignCwd = temporaryDirectory('cwd');
  const home = temporaryDirectory('home');
  mkdirSync(join(home, '.config'), { recursive: true });

  const cli = tarballs.find((tarball) => tarball.name === '@raphael/cli');
  if (cli === undefined) throw new Error('the CLI tarball is missing from the packed set.');

  const overrides = tarballs
    .filter((tarball) => tarball.name !== '@raphael/cli')
    .map((tarball) => `  '${tarball.name}': file:${tarball.file}`)
    .join('\n');

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'raphael-acceptance-install',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: { '@raphael/cli': `file:${cli.file}` },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    `packages: []\noverrides:\n${overrides}\nallowBuilds:\n  better-sqlite3: false\n`,
  );

  // --prod, because devDependencies are not part of what a user installs. If anything the runtime
  // needs is only a devDependency, this is where that shows up.
  await runOrThrow('pnpm', ['install', '--prod'], {
    cwd: root,
    env: PATH_ONLY,
    timeoutMs: 600_000,
  });

  const graph = await runOrThrow('pnpm', ['list', '--prod', '--depth', '2'], {
    cwd: root,
    env: PATH_ONLY,
    timeoutMs: 120_000,
  });
  const node = process.version;
  const pnpm = (
    await runOrThrow('pnpm', ['--version'], { cwd: root, env: PATH_ONLY, timeoutMs: 60_000 })
  ).stdout.trim();

  return {
    root,
    foreignCwd,
    home,
    binary: join(root, 'node_modules', '.bin', 'raphael'),
    entry: join(realpathSync(join(root, 'node_modules', '@raphael', 'cli')), 'dist', 'main.js'),
    tarballs,
    installGraph: graph.stdout,
    toolVersions: { node, pnpm },
  };
};

/** Where an installed top-level package ended up, following the link into the virtual store. */
export const installedPackageDirectory = (installation: Installation, name: string): string =>
  realpathSync(join(installation.root, 'node_modules', ...name.split('/')));

/**
 * Where a dependency of an installed package ended up.
 *
 * pnpm's layout is isolated: a package's dependencies are not nested inside it, they are siblings
 * within that package's own entry in the virtual store. So the peers of `.../@raphael+cli@.../
 * node_modules/@raphael/cli` live two directories up, and that is the only place the CLI can reach
 * them from - which is exactly what makes this a resolution assertion rather than a path guess.
 */
export const installedPeerDirectory = (
  installation: Installation,
  ofPackage: string,
  name: string,
): string =>
  join(dirname(dirname(installedPackageDirectory(installation, ofPackage))), ...name.split('/'));

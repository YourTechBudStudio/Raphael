import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Metafile } from 'esbuild';

import { checkArchive, readArchive } from '../packaging/archive.ts';
import { checkBundle, ENTRY } from '../packaging/bundle.ts';
import { PackagingError } from '../packaging/errors.ts';
import { listFiles } from '../packaging/files.ts';
import { BIN_PATH, NOTICES_FILE, releaseManifest, releaseVersion } from '../packaging/manifest.ts';
import { stageMigrations } from '../packaging/migrations.ts';
import { distributedPackages, renderNotices } from '../packaging/notices.ts';
import {
  checkDatabaseConstruction,
  checkLoaderRequires,
  prebuildTargets,
  SQLITE_SPECIFIER,
  stageSqlite,
} from '../packaging/sqlite.ts';

/**
 * The packager's refusals, one at a time.
 *
 * Producing the real artifact is `pnpm package`'s job and its end-to-end verification belongs to the
 * release flow. What these establish is that each guard the artifact depends on actually fires: a
 * missing migration or prebuild, an unexpected loader change, a server-side chunk reachable from the
 * entry, a dependency without a license text, a symbolic link, and a manifest that would leak source
 * declarations or an invalid version.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const sqliteRoot = realpathSync(
  dirname(
    createRequire(join(repoRoot, 'apps', 'backend', 'package.json')).resolve(
      'better-sqlite3/package.json',
    ),
  ),
);

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const scratch = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-packaging-')));
  directories.push(directory);
  return directory;
};

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const refuses = (run: () => unknown, pattern: RegExp): void => {
  assert.throws(
    run,
    (error: unknown) => error instanceof PackagingError && pattern.test(error.message),
  );
};

const ROOT = {
  name: 'raphael',
  version: '1.2.3',
  private: true,
  description: 'An actionable second brain.',
  author: 'YourTechBud',
  engines: { node: '>=26 <27' },
  scripts: { check: 'pnpm lint' },
};

const CLI = {
  name: '@yourtechbudstudio/raphael',
  version: '0.0.0',
  private: true,
  bin: { raphael: './dist/main.js' },
  exports: { '.': './dist/main.js' },
  scripts: { build: 'tsc' },
  dependencies: { '@raphael/backend': 'workspace:*' },
};

describe('the release manifest', () => {
  it('takes identity from the CLI and version and engines from the root, and nothing else', () => {
    assert.deepEqual(releaseManifest(ROOT, CLI), {
      name: '@yourtechbudstudio/raphael',
      version: '1.2.3',
      private: false,
      description: 'An actionable second brain.',
      author: 'YourTechBud',
      type: 'module',
      bin: { raphael: BIN_PATH },
      files: ['dist', NOTICES_FILE],
      engines: { node: '>=26 <27' },
      publishConfig: { access: 'public' },
    });
  });

  it('accepts any semantic version, including the unreleased 0.0.0', () => {
    for (const version of [
      '0.0.0',
      '1.0.0-rc.1',
      '2.3.4+build.5',
      '1.0.0-alpha.beta.1+exp.sha.5114f85',
    ]) {
      assert.equal(releaseVersion({ ...ROOT, version }), version);
    }
  });

  it('refuses a root version that is not a semantic version', () => {
    for (const version of ['', '1.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0 ', 'latest']) {
      refuses(() => releaseVersion({ ...ROOT, version }), /version/);
    }
    refuses(() => releaseVersion({ ...ROOT, version: 1 }), /version/);
    const { version: _omitted, ...unversioned } = ROOT;
    refuses(() => releaseVersion(unversioned), /version/);
  });

  it('refuses a source manifest that has lost its private guard or its bin', () => {
    refuses(() => releaseManifest(ROOT, { ...CLI, private: false }), /private/);
    refuses(() => releaseManifest(ROOT, { ...CLI, bin: { other: './x.js' } }), /raphael/);
    refuses(() => releaseManifest({ ...ROOT, engines: {} }, CLI), /engines\.node/);
  });
});

describe('migrations', () => {
  const fixture = (tags: readonly string[], present: readonly string[] = tags): string => {
    const source = scratch();
    write(
      join(source, 'meta', '_journal.json'),
      JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag, when: idx })) }),
    );
    for (const tag of present) write(join(source, `${tag}.sql`), `-- ${tag}`);
    write(join(source, 'meta', '0000_snapshot.json'), '{}');
    return source;
  };

  it('stages the journal and exactly the migrations it names', () => {
    const target = join(scratch(), 'drizzle');
    stageMigrations(fixture(['0000_init', '0001_next']), target);
    assert.deepEqual(listFiles(target), ['0000_init.sql', '0001_next.sql', 'meta/_journal.json']);
  });

  it('refuses a journalled migration that is missing', () => {
    refuses(
      () => stageMigrations(fixture(['0000_init', '0001_next'], ['0000_init']), scratch()),
      /0001_next\.sql.*missing/,
    );
  });

  it('refuses a missing or empty journal, and a tag that could escape the folder', () => {
    refuses(() => stageMigrations(scratch(), scratch()), /journal/);
    refuses(() => stageMigrations(fixture([]), scratch()), /no entries/);
    refuses(() => stageMigrations(fixture(['../outside']), scratch()), /invalid tag/);
  });

  it('refuses a migration that is a symbolic link', () => {
    const source = fixture(['0000_init'], []);
    const elsewhere = join(scratch(), 'real.sql');
    write(elsewhere, '-- real');
    symlinkSync(elsewhere, join(source, '0000_init.sql'));
    refuses(() => stageMigrations(source, scratch()), /not a regular file/);
  });

  it('refuses a migration directory reached through a symbolic link', () => {
    // The journal lives outside the declared tree and is reached through a linked `meta`.
    const source = fixture(['0000_init']);
    const outside = fixture(['0000_init']);
    rmSync(join(source, 'meta'), { recursive: true });
    symlinkSync(join(outside, 'meta'), join(source, 'meta'));
    refuses(() => stageMigrations(source, scratch()), /passes through a symbolic link/);

    const linkedRoot = join(scratch(), 'drizzle');
    symlinkSync(outside, linkedRoot);
    refuses(() => stageMigrations(linkedRoot, scratch()), /is not a directory/);
  });
});

describe('the vendored SQLite loader', () => {
  const binding = readFileSync(join(sqliteRoot, 'lib', 'binding.js'), 'utf8');
  const targets = prebuildTargets(binding);

  /** The real locked loader and license, with small stand-ins for the binaries. */
  const fixture = (prebuilds: readonly string[] = targets): string => {
    const source = scratch();
    for (const file of listFiles(join(sqliteRoot, 'lib'))) {
      mkdirSync(dirname(join(source, 'lib', file)), { recursive: true });
      copyFileSync(join(sqliteRoot, 'lib', file), join(source, 'lib', file));
    }
    copyFileSync(join(sqliteRoot, 'LICENSE'), join(source, 'LICENSE'));
    copyFileSync(join(sqliteRoot, 'package.json'), join(source, 'package.json'));
    for (const target of prebuilds) write(join(source, 'prebuilds', target), 'binary');
    return source;
  };

  it('derives every upstream prebuild target from the locked loader', () => {
    assert.deepEqual(targets, [
      'darwin-arm64.node',
      'darwin-x64.node',
      'linux-arm64.node',
      'linux-x64.node',
      'linuxmusl-arm64.node',
      'linuxmusl-x64.node',
      'win32-arm64.node',
      'win32-x64.node',
    ]);
  });

  it('refuses a loader whose prebuild selection has changed', () => {
    refuses(
      () => prebuildTargets(binding.replace("'linuxmusl'", "'musl'")),
      /selection has changed/,
    );
  });

  it('stages a CommonJS tree with no compilation inputs', () => {
    const target = join(scratch(), 'vendor');
    stageSqlite(fixture(), target);
    const files = listFiles(target);
    assert.ok(files.includes('lib/index.js'));
    assert.ok(files.includes('LICENSE'));
    assert.equal(files.filter((file) => file.startsWith('prebuilds/')).length, targets.length);
    assert.equal(
      files.some((file) => /^(?:binding\.gyp|build\/|src\/|deps\/)/.test(file)),
      false,
    );
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(manifest.type, 'commonjs');
    assert.equal(manifest.main, 'lib/index.js');
    assert.equal(
      'dependencies' in manifest || 'scripts' in manifest || 'gypfile' in manifest,
      false,
    );
  });

  it('refuses a missing or unexpected prebuild', () => {
    refuses(
      () => stageSqlite(fixture(targets.slice(1)), scratch()),
      /missing \[darwin-arm64\.node\]/,
    );
    refuses(
      () => stageSqlite(fixture([...targets, 'freebsd-x64.node']), scratch()),
      /unexpected \[freebsd-x64\.node\]/,
    );
  });

  it('refuses a prebuild or loader directory reached through a symbolic link', () => {
    for (const directory of ['prebuilds', 'lib']) {
      const source = fixture();
      const outside = join(scratch(), directory);
      renameSync(join(source, directory), outside);
      symlinkSync(outside, join(source, directory));
      refuses(() => stageSqlite(source, scratch()), /symbolic link|is not a directory/);
    }
  });

  it('refuses a different upstream version', () => {
    const source = fixture();
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as object;
    writeFileSync(join(source, 'package.json'), JSON.stringify({ ...manifest, version: '99.0.0' }));
    refuses(() => stageSqlite(source, scratch()), /expected better-sqlite3/);
  });

  it('refuses a require that is not shipped, or a new non-literal require', () => {
    const shipped = join(scratch(), 'vendor');
    stageSqlite(fixture(), shipped);
    checkLoaderRequires(shipped);

    writeFileSync(join(shipped, 'lib', 'extra.js'), "require('node-addon-api');\n");
    refuses(() => checkLoaderRequires(shipped), /node-addon-api.*not shipped/);

    writeFileSync(join(shipped, 'lib', 'extra.js'), 'require(somewhere);\n');
    refuses(() => checkLoaderRequires(shipped), /non-literal requires changed/);
  });

  it('accepts Raphael database construction only when it passes a path alone', () => {
    checkDatabaseConstruction(join(repoRoot, 'apps', 'backend', 'src'));

    const source = scratch();
    write(join(source, 'a.ts'), "new Database(path, { nativeBinding: '/tmp/x.node' });\n");
    refuses(() => checkDatabaseConstruction(source), /nativeBinding/);
    refuses(() => checkDatabaseConstruction(scratch()), /no "new Database/);
  });
});

describe('license notices', () => {
  const installed = (name: string, version: string, files: Record<string, string>): string => {
    const root = join(scratch(), 'node_modules', name);
    write(join(root, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }));
    for (const [file, content] of Object.entries(files)) write(join(root, file), content);
    return root;
  };

  it('reproduces every license and notice file a distributed package ships', () => {
    const root = installed('@scope/one', '1.0.0', {
      'LICENSE.md': 'MIT text',
      NOTICE: 'notice text',
      'index.js': '',
    });
    const packages = distributedPackages([join(root, 'index.js'), join(root, 'index.js')]);
    assert.equal(packages.length, 1);
    const notices = renderNotices(packages, {});
    assert.match(notices, /@scope\/one@1\.0\.0\nLicense: MIT\n\nMIT text\nnotice text/);
  });

  it('refuses a package with no license text, rather than citing its identifier', () => {
    const root = installed('bare', '2.0.0', { 'README.md': 'no license here' });
    refuses(
      () => renderNotices(distributedPackages([join(root, 'index.js')]), {}),
      /bare@2\.0\.0 \(MIT\)/,
    );
  });

  it('uses a recorded upstream license only for the exact version and digest reviewed', () => {
    const root = installed('drizzle-orm', '0.45.2', {});
    const [pkg] = distributedPackages([join(root, 'index.js')]);
    assert.ok(pkg !== undefined);
    assert.match(renderNotices([pkg]), /Apache License\s+Version 2\.0/);
    refuses(() => renderNotices([{ ...pkg, version: '0.45.3' }]), /drizzle-orm@0\.45\.3/);
    refuses(
      () =>
        renderNotices([pkg], {
          'drizzle-orm@0.45.2': {
            file: 'licenses/drizzle-orm-0.45.2-LICENSE',
            origin: 'x',
            sha256: '0',
          },
        }),
      /does not match its digest/,
    );
  });
});

describe('the bundle graph', () => {
  const out = join(repoRoot, 'release', 'package', 'dist');
  const at = (file: string): string => `release/package/dist/${file}`;
  type Import = Metafile['outputs'][string]['imports'][number];
  const output = (
    inputs: readonly string[],
    imports: readonly Import[],
    entryPoint?: string,
  ): Metafile['outputs'][string] => ({
    bytes: 0,
    inputs: Object.fromEntries(inputs.map((input) => [input, { bytesInOutput: 0 }])),
    imports: [...imports],
    exports: [],
    ...(entryPoint === undefined ? {} : { entryPoint }),
  });
  const metafile = (outputs: Metafile['outputs']): Metafile => ({
    inputs: {
      [ENTRY]: { bytes: 0, imports: [] },
      'apps/cli/packaging/distribution.packaged.ts': { bytes: 0, imports: [] },
    },
    outputs,
  });
  const backend = output(
    ['apps/backend/dist/index.js'],
    [{ path: SQLITE_SPECIFIER, kind: 'import-statement', external: true }],
    'apps/backend/dist/index.js',
  );

  it('accepts a backend that is only reachable through a dynamic import', () => {
    checkBundle(
      metafile({
        [at('main.js')]: output(
          [ENTRY],
          [
            { path: 'node:fs', kind: 'import-statement', external: true },
            { path: at('dist-1.js'), kind: 'dynamic-import' },
          ],
          ENTRY,
        ),
        [at('dist-1.js')]: backend,
      }),
      repoRoot,
      out,
    );
  });

  it('refuses a server-side chunk that the entry imports statically', () => {
    refuses(
      () =>
        checkBundle(
          metafile({
            [at('main.js')]: output(
              [ENTRY],
              [{ path: at('chunk-1.js'), kind: 'import-statement' }],
              ENTRY,
            ),
            [at('chunk-1.js')]: output([], [{ path: at('dist-1.js'), kind: 'import-statement' }]),
            [at('dist-1.js')]: backend,
          }),
          repoRoot,
          out,
        ),
      /statically reachable/,
    );
  });

  it('refuses an external import that is not a built-in or the vendored driver', () => {
    refuses(
      () =>
        checkBundle(
          metafile({
            [at('main.js')]: output(
              [ENTRY],
              [
                { path: 'left-pad', kind: 'require-call', external: true },
                { path: at('dist-1.js'), kind: 'dynamic-import' },
              ],
              ENTRY,
            ),
            [at('dist-1.js')]: backend,
          }),
          repoRoot,
          out,
        ),
      /left-pad.*not shipped/,
    );
  });

  it('refuses a bundle with no backend chunk at all, since isolation would then prove nothing', () => {
    refuses(
      () => checkBundle(metafile({ [at('main.js')]: output([ENTRY], [], ENTRY) }), repoRoot, out),
      /no dynamically loaded chunk/,
    );
  });
});

describe('the archive', () => {
  /** Archives exactly the named members, as npm does: no directory entries. */
  const tarball = (prepare: (root: string) => void, members: readonly string[]): string => {
    const directory = scratch();
    prepare(join(directory, 'package'));
    const file = join(directory, 'out.tgz');
    const ran = spawnSync(
      'tar',
      ['-czf', file, '-C', directory, ...members.map((member) => `package/${member}`)],
      { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    assert.equal(ran.status, 0, ran.stderr);
    return file;
  };

  it('reads modes and checks the archive against the stage', () => {
    const file = tarball(
      (root) => {
        write(join(root, 'package.json'), '{}');
        write(join(root, BIN_PATH), '#!/usr/bin/env node\n');
        chmodSync(join(root, BIN_PATH), 0o755);
      },
      ['package.json', BIN_PATH],
    );
    const entries = readArchive(file);
    checkArchive(entries, ['package.json', BIN_PATH], BIN_PATH);
    refuses(
      () => checkArchive(entries, ['package.json'], BIN_PATH),
      /extra \[package\/dist\/main\.js\]/,
    );
    const notExecutable = entries.map((entry) => ({ ...entry, mode: 0o644 }));
    refuses(
      () => checkArchive(notExecutable, ['package.json', BIN_PATH], BIN_PATH),
      /not executable/,
    );
  });

  it('refuses a symbolic link in the archive', () => {
    const file = tarball(
      (root) => {
        write(join(root, 'package.json'), '{}');
        symlinkSync('package.json', join(root, 'link.json'));
      },
      ['package.json', 'link.json'],
    );
    refuses(() => readArchive(file), /not a regular file/);
  });
});

describe('the staged tree', () => {
  it('refuses a root that is a symbolic link', () => {
    const root = scratch();
    write(join(root, 'real', 'main.js'), '');
    symlinkSync(join(root, 'real'), join(root, 'linked'));
    refuses(() => listFiles(join(root, 'linked')), /is not a directory/);
  });

  it('refuses a symbolic link', () => {
    const root = scratch();
    write(join(root, 'dist', 'main.js'), '');
    symlinkSync(join(root, 'dist', 'main.js'), join(root, 'dist', 'link.js'));
    refuses(() => listFiles(root), /not a regular file or directory/);
  });
});

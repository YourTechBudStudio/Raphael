import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Help and version must work on a machine that is not set up.
 *
 * No network, no configuration, no credential, and - the one that needs real evidence - no backend
 * and no native SQLite driver. `import('@raphael/backend')` initializes better-sqlite3, which on a
 * machine with an incompatible prebuilt binary throws at load. If that import were reachable from the
 * dispatcher, `raphael --help` would fail on exactly the machine where someone most needs to read it.
 *
 * The check is a module hook that refuses to resolve the forbidden modules. A hook that silently did
 * not intercept would make every test here pass while establishing nothing, so there is a positive
 * control that deliberately imports the backend and must fail.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const binary = join(packageRoot, 'dist', 'main.js');

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/**
 * A hook that throws if anything in the process resolves the backend or the native driver.
 *
 * `module.registerHooks` rather than `module.register`: the latter is deprecated in Node 26 and warns
 * on stderr, which would both pollute the output these tests assert on and eventually stop working.
 * Hooks run synchronously in this thread, so one file is enough.
 *
 * Interception happens at `resolve`, before any of the module's own initialization can run, and both
 * the bare specifier and the path it resolves to are checked - a package reached through a relative
 * path inside another package would otherwise slip past a name-only test.
 */
const HOOK = `
import { registerHooks } from 'node:module';

const FORBIDDEN = ['@raphael/backend', 'better-sqlite3', 'drizzle-orm', 'express'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const name of FORBIDDEN) {
      if (specifier === name || specifier.startsWith(name + '/')) {
        throw new Error('FORBIDDEN_IMPORT:' + specifier);
      }
    }
    const resolved = nextResolve(specifier, context);
    for (const name of FORBIDDEN) {
      if (
        resolved.url.includes('/node_modules/' + name + '/') ||
        resolved.url.includes('/' + name + '/dist/')
      ) {
        throw new Error('FORBIDDEN_IMPORT:' + resolved.url);
      }
    }
    return resolved;
  },
});
`;

const hookDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'raphael-hook-'));
  directories.push(directory);
  writeFileSync(join(directory, 'register.mjs'), HOOK);
  return directory;
};

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runGuarded = (args: readonly string[], script = binary): Promise<Ran> => {
  const directory = hookDirectory();
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ['--import', join(directory, 'register.mjs'), script, ...args],
      {
        // A deliberately bare environment beyond PATH: no HOME, no XDG_CONFIG_HOME, no endpoint,
        // no key.
        env: { PATH: process.env.PATH ?? '' },
        cwd: packageRoot,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
};

describe('the import hook itself', () => {
  it('actually intercepts a forbidden import', async () => {
    // The positive control. Without this, every test below could be passing because the hook does
    // nothing at all.
    const directory = mkdtempSync(join(tmpdir(), 'raphael-probe-'));
    directories.push(directory);
    const probe = join(directory, 'probe.mjs');
    writeFileSync(probe, `import '@raphael/backend';\nconsole.log('loaded');\n`);

    const ran = await runGuarded([], probe);
    assert.notEqual(ran.code, 0, 'the probe should have been stopped by the hook');
    assert.match(ran.stderr, /FORBIDDEN_IMPORT/);
    assert.equal(ran.stdout.includes('loaded'), false);
  });

  it('lets an ordinary import through', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'raphael-probe-'));
    directories.push(directory);
    const probe = join(directory, 'probe.mjs');
    writeFileSync(probe, `import 'node:path';\nconsole.log('loaded');\n`);

    const ran = await runGuarded([], probe);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /loaded/);
  });
});

describe('help and version need nothing', () => {
  const cases: Array<[string, readonly string[]]> = [
    ['no arguments', []],
    ['help', ['help']],
    ['--help', ['--help']],
    ['-h', ['-h']],
    ['--version', ['--version']],
    ['-v', ['-v']],
    ['create --help', ['create', '--help']],
    ['get --help', ['get', '--help']],
    ['list --help', ['list', '--help']],
    ['path --help', ['path', '--help']],
    ['login --help', ['login', '--help']],
    ['server', ['server']],
    ['server serve --help', ['server', 'serve', '--help']],
  ];

  for (const [label, args] of cases) {
    it(`answers "${label}" with no backend, no native driver, no configuration`, async () => {
      const ran = await runGuarded(args);
      assert.equal(ran.code, 0, `exited ${ran.code}: ${ran.stderr}`);
      assert.equal(ran.stderr, '', 'help belongs on stdout');
      assert.ok(ran.stdout.length > 0);
      assert.equal(ran.stdout.includes('FORBIDDEN_IMPORT'), false);
    });
  }

  it('reports the version in its own manifest, not a literal beside it', async () => {
    // The point of reading the manifest is that an installed copy reports what it actually is. If
    // this ever drifts back to a hand-maintained constant, the two answers disagree here first.
    const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const { version } = manifest as { readonly version: string };
    const ran = await runGuarded(['--version']);
    assert.equal(ran.code, 0);
    assert.equal(ran.stdout.trim(), version);
  });

  it('reports an unknown command as a usage error without loading anything', async () => {
    const ran = await runGuarded(['frobnicate']);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /is not a command/);
  });

  it('reports a bad flag before it needs a credential', async () => {
    // The order matters: someone with a typo should be told about the typo, not told they are not
    // logged in.
    const ran = await runGuarded(['get', '/work', '--nonsense']);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /nonsense/);
  });
});

describe('remote commands never load the backend', () => {
  it('fails for want of configuration, not for want of a driver', async () => {
    const ran = await runGuarded(['get', '/work']);
    assert.equal(ran.code, 2);
    assert.equal(ran.stdout, '');
    assert.equal(ran.stderr.includes('FORBIDDEN_IMPORT'), false);
  });
});

/**
 * Nothing bundles this app without preparing the editor first.
 *
 * The generated document is git-ignored, so a clean checkout has none; and a checkout that has one
 * from an older bundle is the worse case, because a run that skipped preparation would serve stale
 * output and look like it worked. Every entry point that reaches Metro or native packaging has to
 * prepare first and has to stop when preparation fails.
 *
 * The real recorded command strings are executed here with a stubbed `expo` on `PATH` and the
 * preparation step substituted, so what is tested is the composition this repository actually ships
 * rather than a restatement of it. No development server is started: the stub records its arguments
 * and exits.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const mobile = fileURLToPath(new URL('..', import.meta.url));
const root = path.join(mobile, '..', '..');

const manifest = JSON.parse(readFileSync(path.join(mobile, 'package.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const PREPARE = 'pnpm editor:prepare';

/** Every script that hands work to Metro or to native packaging. */
const BUNDLING_SCRIPTS = Object.entries(manifest.scripts).filter(([, command]) =>
  /(?:^|&&\s*)expo\s/u.test(command),
);

const workspaces = [];
after(() => {
  for (const dir of workspaces) {
    try {
      spawnSync('rm', ['-rf', dir]);
    } catch {
      // A leftover temporary directory is not worth failing a run over.
    }
  }
});

/**
 * Runs one recorded script with `expo` replaced by a recorder, and the preparation step replaced by
 * `prepare` — a shell command the test controls, so both success and failure are exact.
 */
const runScript = (command, prepare) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'raphael-scripts-'));
  workspaces.push(dir);
  const log = path.join(dir, 'invocations');
  const stub = path.join(dir, 'expo');
  writeFileSync(stub, `#!/bin/sh\nprintf 'expo %s\\n' "$*" >> "$RAPHAEL_SCRIPT_LOG"\n`, 'utf8');
  chmodSync(stub, 0o755);

  const substituted = command.replace(PREPARE, prepare.replaceAll('%log%', log));
  assert.notEqual(substituted, command, `the script does not contain "${PREPARE}"`);

  const result = spawnSync('sh', ['-c', substituted], {
    cwd: mobile,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RAPHAEL_SCRIPT_LOG: log },
    encoding: 'utf8',
  });

  return {
    status: result.status,
    invocations: existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
      : [],
  };
};

describe('entry points that bundle', () => {
  it('covers development and native packaging, not only the export', () => {
    const names = BUNDLING_SCRIPTS.map(([name]) => name).sort();
    // Development on all four platforms, the export, and native packaging. If a new bundling script
    // appears it lands in `BUNDLING_SCRIPTS` and has to satisfy the assertions below too.
    assert.deepEqual(names, [
      'android',
      'build',
      'ios',
      'prebuild',
      'release:android',
      'release:ios',
      'start',
      'web',
    ]);
  });

  for (const [name, command] of BUNDLING_SCRIPTS) {
    it(`prepares before \`${name}\` reaches expo`, () => {
      assert.ok(
        command.startsWith(`${PREPARE} && `),
        `${name} must prepare the editor before anything else: ${command}`,
      );
    });
  }

  it('reaches the prepared package script from the repository root', () => {
    assert.equal(rootManifest.scripts['mobile:start'], 'pnpm --filter @raphael/mobile start');
    assert.ok(manifest.scripts.start.startsWith(`${PREPARE} && `));
  });
});

describe('what happens when preparation fails', () => {
  for (const [name, command] of BUNDLING_SCRIPTS) {
    it(`stops \`${name}\` before expo is invoked`, () => {
      const run = runScript(command, 'sh -c \'printf "prepare\\n" >> "%log%"; exit 3\'');
      assert.notEqual(run.status, 0, 'a failed preparation must fail the calling command');
      assert.deepEqual(run.invocations, ['prepare'], 'expo must not run after preparation failed');
    });
  }

  it('is not bypassed by generated output that already exists', () => {
    // The ordinary state during a test run: preparation has already succeeded once, so the document
    // is on disk. A later failure must still stop, rather than quietly bundling what is lying around.
    assert.ok(existsSync(path.join(mobile, 'src/modules/editor/generated/document.ts')));

    const run = runScript(manifest.scripts.start, 'false');
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.invocations, []);
  });
});

describe('what happens when preparation succeeds', () => {
  it('runs expo afterwards, with the arguments the script records', () => {
    const run = runScript(manifest.scripts.start, 'sh -c \'printf "prepare\\n" >> "%log%"\'');
    assert.equal(run.status, 0);
    // Order is the point: preparation completed, and only then did bundling begin.
    assert.deepEqual(run.invocations, ['prepare', 'expo start']);
  });

  it('passes each platform its own arguments', () => {
    const expected = new Map([
      ['android', 'expo start --android'],
      ['ios', 'expo start --ios'],
      ['web', 'expo start --web'],
      ['prebuild', 'expo prebuild'],
      ['release:android', 'expo run:android --variant release'],
      ['release:ios', 'expo run:ios --configuration Release'],
      ['build', 'expo export --platform all'],
    ]);

    for (const [name, invocation] of expected) {
      const run = runScript(manifest.scripts[name], 'true');
      assert.equal(run.status, 0, `${name} failed`);
      assert.deepEqual(run.invocations, [invocation], `${name} invoked the wrong command`);
    }
  });
});

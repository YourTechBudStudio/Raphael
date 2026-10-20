import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { errorResponse, neverConnect, runCli, stubServer, type Ran } from './support/cli.ts';
import { caseName, goldenSurface } from './support/golden.ts';

/**
 * Regression tests for the problems that damaged data, wrote to the wrong item, or silently did
 * nothing while exiting 0. Each refusal's copy is pinned; each case that must go ahead proves it
 * reached the server.
 */

const here = dirname(fileURLToPath(import.meta.url));
const main = resolve(here, '..', 'src', 'main.ts');

const refusals = goldenSurface('refusals');

after(() => assert.deepEqual(refusals.strays(), []));

/** Refused before anything was read or sent: `neverConnect` fails the case if it is reached. */
const refused = async (name: string, argv: readonly string[]): Promise<void> => {
  const ran = await runCli(argv, { connect: neverConnect });
  assert.equal(ran.code, 2, ran.stderr);
  assert.equal(ran.stdout, '');
  refusals.expectRun(name, ran);
};

/** Went ahead: the request reached the stub server. */
const reachesServer = async (argv: readonly string[]): Promise<void> => {
  const server = stubServer(() => errorResponse(503, 'storage_busy', 'Busy.'));
  const ran = await runCli(argv, { connect: server.connect });
  assert.ok(server.requests.length > 0, `never reached the server:\n${ran.stderr}`);
};

describe('a flag that takes one value, given twice', () => {
  // `archive --id 7 --id 6` used to archive 6, and `update --title A --title B` used to write B.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['archive-id', ['archive', '--id', '7', '--id', '6', '--revision', '1']],
    ['update-title', ['update', '--id', '7', '--title', 'A', '--title', 'B']],
    ['update-id', ['update', '--id', '7', '--id', '6', '--title', 'A']],
    ['create-title', ['create', 'area', '/work', '--title', 'A', '--title', 'B']],
    ['move-revision', ['move', '/work', '/personal', '--revision', '1', '--revision', '2']],
    ['get-json', ['get', '/work', '--json', '--json']],
    ['list-recursive', ['list', '/', '-r', '-r']],
    ['list-recursive-cluster', ['list', '/', '-rr']],
    ['list-recursive-mixed', ['list', '/', '-r', '--recursive']],
    ['favorites-limit', ['favorites', '--limit', '1', '--limit', '2']],
    ['login-json', ['login', '--json', '--json']],
    ['serve-config', ['server', 'serve', '--config', 'a.yaml', '--config', 'b.yaml']],
  ];
  for (const [name, argv] of cases) {
    it(`refuses ${argv.join(' ')}`, () => refused(caseName('repeat', name), argv));
  }
});

describe('a flag documented as repeatable, given twice', () => {
  const cases: ReadonlyArray<readonly string[]> = [
    ['list', '--id', '1', '--id', '2'],
    ['search', '--id', '1', '--id', '2', '-q', 'auth'],
    ['search', '/', '-q', 'auth', '-q', 'tokens'],
    ['list', '/', '--order-by', 'slug:asc', '--order-by', 'id:asc'],
    ['update', '--id', '1', '--tag', 'a', '--tag', 'b', '--revision', '1'],
    ['create', 'area', '/work', '--title', 'Work', '--tag', 'a', '--tag', 'b'],
  ];
  for (const argv of cases) {
    it(`accepts ${argv.join(' ')}`, () => reachesServer(argv));
  }
});

describe('the version flags', () => {
  it('refuses --version followed by a command', () =>
    refused('version-flag-then-command', ['--version', 'list']));
  it('refuses version followed by a command', () =>
    refused('version-word-then-command', ['version', 'archive', '/work']));
  it('no longer knows -v', () => refused('version-short', ['-v']));
  it('still answers --version and version alone', async () => {
    const flag = await runCli(['--version']);
    assert.equal(flag.code, 0);
    assert.match(flag.stdout, /^\d+\.\d+\.\d+/);
    assert.deepEqual(await runCli(['version']), flag);
  });
});

describe('help is an option, not a word', () => {
  it('runs a search for a query spelled "help"', () =>
    reachesServer(['search', '/', '-q', 'help']));
  it('runs a search for a query spelled "--help"', () =>
    reachesServer(['search', '/', '--query=--help']));
  it('runs a search for a query spelled "-h"', () => reachesServer(['search', '/', '--query=-h']));
  it('creates a note titled "help"', () =>
    reachesServer(['create', 'resource.note', '/work/n', '--title', 'help']));

  it('shows help for -h inside a cluster', async () => {
    assert.deepEqual(await runCli(['list', '/', '-rh']), await runCli(['list', '--help']));
  });
  it('shows help beside an unknown flag', async () => {
    assert.deepEqual(
      await runCli(['update', '--bogus', '--help']),
      await runCli(['update', '--help']),
    );
  });

  it('treats -h after -- as a path', () => refused('help-after-terminator', ['list', '--', '-h']));
  it('treats a bare "help" after a command as an argument', () =>
    refused('help-word-after-command', ['get', '/work', 'help']));
  it('treats a bare "help" after server as a subcommand', () =>
    refused('help-word-after-server', ['server', 'help']));
});

/** Run the CLI as a process, with standard input arranged by `stdin`, against nothing at all. */
const runProcess = (
  argv: readonly string[],
  stdin: { readonly text: string } | 'dev-null' | 'closed',
): Promise<Ran> =>
  new Promise((resolveRun, rejectRun) => {
    // An address nothing listens on: a request that is sent fails as unreachable, exit 1, which is
    // what tells a body that went ahead apart from a refusal.
    const env = {
      PATH: process.env.PATH ?? '',
      RAPHAEL_ENDPOINT: 'http://127.0.0.1:9',
      RAPHAEL_API_KEY: 'stdin-key-0123456789abcdef0123456789',
    };
    const nullFd = stdin === 'dev-null' ? openSync('/dev/null', 'r') : undefined;
    const child =
      stdin === 'closed'
        ? // The shell closes descriptor 0 before starting node, which is the only way to get a
          // process whose standard input is not open at all.
          spawn('/bin/sh', ['-c', 'exec "$0" "$@" <&-', process.execPath, main, ...argv], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(process.execPath, [main, ...argv], {
            env,
            stdio: [nullFd ?? 'pipe', 'pipe', 'pipe'],
          });
    if (nullFd !== undefined) closeSync(nullFd);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    if (typeof stdin === 'object') child.stdin?.end(stdin.text);
  });

describe('an empty body on standard input', () => {
  const update = ['update', '/work/contracts', '--body', '@-', '--revision', '3'];
  const create = ['create', 'resource.note', '/work/n', '--title', 'N', '--body', '@-'];

  it('refuses zero bytes for update', async () => {
    // `gen | raphael update ... --body @-` when gen failed used to replace the body with nothing.
    const ran = await runProcess(update, { text: '' });
    assert.equal(ran.code, 2);
    refusals.expectRun('stdin-empty-update', ran);
  });

  it('refuses zero bytes for create', async () => {
    const ran = await runProcess(create, { text: '' });
    assert.equal(ran.code, 2);
    refusals.expectRun('stdin-empty-create', ran);
  });

  it('refuses /dev/null and a closed standard input the same way', async () => {
    const empty = await runProcess(update, { text: '' });
    assert.deepEqual(await runProcess(update, 'dev-null'), empty);
    assert.deepEqual(await runProcess(update, 'closed'), empty);
  });

  it('sends whitespace, which is a body someone wrote', async () => {
    const ran = await runProcess(update, { text: '\n' });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /The server could not be reached\./);
  });
});

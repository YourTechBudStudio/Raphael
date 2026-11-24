import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Transport } from '@raphael/client';
import { LIST_LIMIT_MAX, LIST_LIMIT_MIN } from '@raphael/contracts/nodes';

import { suggestedCommand } from '../src/main.ts';
import type { Connected } from '../src/shared/command.ts';
import {
  STUB_CONNECTION,
  STUB_ENDPOINT,
  errorResponse,
  neverConnect,
  runCli,
  stubServer,
  type Ran,
} from './support/cli.ts';
import {
  assertErrorDocument,
  assertJsonMirrorsText,
  caseName,
  goldenSurface,
} from './support/golden.ts';

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

/** Refused in exactly the words, exit code and streams of another refusal that is pinned. */
const refusedAs = async (argv: readonly string[], pinned: readonly string[]): Promise<void> => {
  const ran = await runCli(argv, { connect: neverConnect });
  assert.equal(ran.code, 2, ran.stderr);
  assert.deepEqual(ran, await runCli(pinned, { connect: neverConnect }));
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

describe('an unknown command', () => {
  // A close misspelling, a natural alias, or an option put before the command gets a runnable
  // suggestion; a word that is close to nothing gets none.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['misspelled', ['lst', '/work']],
    ['british-spelling', ['favourites']],
    ['swapped-letters', ['gte', '/work']],
    ['begun', ['serv']],
    ['alias-mv', ['mv', '/work', '/personal']],
    ['alias-remove', ['remove', '/work']],
    ['server-subcommand', ['server', 'start']],
    ['option-first', ['--json', 'get', '/work']],
    ['option-first-text', ['--recursive', 'list', '/']],
    // Moved after the command with their values, `--` left out, and only when the result parses.
    ['terminator-first', ['--', 'list', '/']],
    ['option-value-first', ['--id', '3', 'get']],
    ['option-value-first-list', ['--limit', '5', 'list', '/']],
    ['short-option-first', ['-r', 'list', '/']],
    ['unknown-option-first', ['--bogus', 'list', '/']],
    ['topic-as-command', ['addressing', '--help']],
    ['close-to-nothing', ['frobnicate']],
    ['short-word', ['x']],
  ];
  for (const [name, argv] of cases) {
    it(`answers ${argv.join(' ')}`, () => refused(caseName('unknown', name), argv));
  }

  // Natural guesses whose closest spelling would be another command, sometimes the opposite one. The
  // wording is pinned by the alias cases above; these pin only which command each one suggests.
  const aliases: ReadonlyArray<readonly [string, string]> = [
    ['unarchive', 'restore'],
    ['new', 'create'],
    ['add', 'create'],
    ['mk', 'create'],
    ['edit', 'update'],
    ['set', 'update'],
    ['show', 'get'],
    ['cat', 'get'],
    ['read', 'get'],
    ['find', 'search'],
    ['grep', 'search'],
  ];
  for (const [typed, meant] of aliases) {
    it(`suggests ${meant} for ${typed}`, () => assert.equal(suggestedCommand(typed), meant));
  }
});

describe('a create type that is not one, or not where it belongs', () => {
  // The path first, a type with no kind, and a kind with no type each get the token to type.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['path-first', ['create', '/work', 'area', '--title', 'Work']],
    ['path-first-note', ['create', '/work/n', 'resource.note']],
    ['bare-resource', ['create', 'resource', '/work/n', '--title', 'N']],
    ['bare-kind', ['create', 'note', '/work/n', '--title', 'N']],
    ['neither', ['create', '/work', '/other']],
  ];
  for (const [name, argv] of cases) {
    it(`answers ${argv.join(' ')}`, () => refused(caseName('create-type', name), argv));
  }
});

describe('an option the command does not take', () => {
  // Pointed only at what was meant: a filter on a listing, an update on a single item, and nothing
  // where no command takes it for that purpose.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['list-tag', ['list', '/work', '--tag', 'urgent']],
    ['list-tags', ['list', '/work', '--tags', 'urgent']],
    ['search-tag', ['search', '/', '-q', 'auth', '--tag', 'urgent']],
    ['list-type', ['list', '/work', '--type', 'area']],
    ['search-kind', ['search', '/', '-q', 'auth', '--kind', 'note']],
    ['list-title', ['list', '/work', '--title', 'X']],
    ['list-query', ['list', '/work', '-q', 'auth']],
    ['get-body', ['get', '/work', '--body', 'X']],
    ['favorite-revision', ['favorite', '/work', '--revision', '1']],
    ['update-parent-id', ['update', '/work', '--parent-id', '4']],
    // Metadata is set once, so it points at create.
    ['get-metadata', ['get', '/work', '--metadata', '{}']],
  ];
  for (const [name, argv] of cases) {
    it(`answers ${argv.join(' ')}`, () => refused(caseName('other-option', name), argv));
  }
});

describe('a whole-number option followed by a negative number', () => {
  // The range rule, as --x=-1 would give it, instead of advice to write --x=-1.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['skip', ['list', '/', '--skip', '-1']],
    ['limit', ['list', '/', '--limit', '-5']],
    ['revision', ['update', '/work', '--title', 'X', '--revision', '-3']],
    ['id', ['get', '--id', '-4']],
    ['parent-id', ['create', 'area', '--parent-id', '-4', '--slug', 'x', '--title', 'X']],
    ['port', ['server', 'serve', '--port', '-1']],
  ];
  for (const [name, argv] of cases) {
    it(`answers ${argv.join(' ')}`, () => refused(caseName('negative', name), argv));
  }

  // Joined with =, the same value is refused in the same words.
  const joined: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
    [
      ['list', '/', '--skip=-1'],
      ['list', '/', '--skip', '-1'],
    ],
    [
      ['list', '/', '--limit=-5'],
      ['list', '/', '--limit', '-5'],
    ],
    [
      ['update', '/work', '--title', 'X', '--revision=-3'],
      ['update', '/work', '--title', 'X', '--revision', '-3'],
    ],
  ];
  for (const [argv, pinned] of joined) {
    it(`answers ${argv.join(' ')} as ${pinned.join(' ')}`, () => refusedAs(argv, pinned));
  }
});

describe('a local refusal, pinned in text and checked in JSON', () => {
  // These used to be checked by exit code alone, so a regression to parser or decoder text, or a
  // lost help pointer, would still have passed.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['list-limit-zero', ['list', '/', '--limit', String(LIST_LIMIT_MIN - 1)]],
    ['search-order-by', ['search', '/', '-q', 'auth', '--order-by', 'slug:asc']],
    ['archive-root', ['archive', '/', '--revision', '1']],
    ['restore-extra', ['restore', '/work/a', '/work/b']],
    ['favorites-limit-zero', ['favorites', '--limit', '0']],
    ['favorites-skip-negative', ['favorites', '--skip', '-1']],
    ['favorites-path', ['favorites', '/work']],
    ['favorite-root', ['favorite', '/']],
    ['unfavorite-extra', ['unfavorite', '/work/a', '/work/b']],
    // JSON would keep the last value of a repeated key and drop the other without a word.
    [
      'create-metadata-repeated-key',
      ['create', 'resource.note', '/work/m', '--body', 'x', '--metadata', '{"a":1,"a":2}'],
    ],
    ['list-filter-repeated-key', ['list', '/', '--filter', '{"type":"area","type":"project"}']],
    ['get-root', ['get', '/']],
    ['get-id-empty', ['get', '/work', '--id=']],
    [
      'create-tiptap-not-document',
      [
        'create',
        'project',
        '/work/x',
        '--title',
        'X',
        '--body-format',
        'tiptap',
        '--body',
        '[1,2,3]',
      ],
    ],
    // A document the content package refuses is refused here too, with or without --title and on
    // update, so nothing is sent for a body that can never be stored.
    [
      'create-tiptap-unsupported-element',
      [
        'create',
        'resource.note',
        '/work/t9',
        '--title',
        'T',
        '--body-format',
        'tiptap',
        '--body',
        '{"type":"doc","content":[{"type":"table"}]}',
      ],
    ],
    [
      'update-tiptap-heading-level',
      [
        'update',
        '/work/n',
        '--revision',
        '1',
        '--body-format',
        'tiptap',
        '--body',
        '{"type":"doc","content":[{"type":"heading","attrs":{"level":9},"content":[{"type":"text","text":"x"}]}]}',
      ],
    ],
    [
      'create-tiptap-empty-document',
      [
        'create',
        'resource.note',
        '/work/t',
        '--title',
        'T',
        '--body-format',
        'tiptap',
        '--body',
        '{"type":"doc","content":[]}',
      ],
    ],
    [
      'create-tiptap-too-deep',
      [
        'create',
        'resource.note',
        '/work/t',
        '--title',
        'T',
        '--body-format',
        'tiptap',
        '--body',
        `{"type":"doc","content":[${'{"type":"blockquote","content":['.repeat(31)}{"type":"paragraph"}${']}'.repeat(31)}]}`,
      ],
    ],
  ];
  // The JSON of these is pinned too; the rest are checked against their text.
  const pinnedJson = new Set(['list-limit-zero', 'create-tiptap-not-document']);
  for (const [name, argv] of cases) {
    it(`answers ${argv.join(' ')}`, () => refused(caseName('local', name), argv));
    it(`answers ${argv.join(' ')} --json`, async () => {
      const ran = await runCli([...argv, '--json'], { connect: neverConnect });
      if (pinnedJson.has(name)) {
        assertErrorDocument(ran, { exit: 2 });
        refusals.expectRun(caseName('local', name, 'json'), ran);
      } else {
        assertJsonMirrorsText(ran, await runCli(argv, { connect: neverConnect }), { exit: 2 });
      }
    });
  }

  // Any --limit outside the range, or not a whole number, is refused as the pinned zero is.
  for (const limit of [String(LIST_LIMIT_MAX + 1), '2.5', 'ten']) {
    it(`answers list / --limit ${limit}`, () =>
      refusedAs(
        ['list', '/', '--limit', limit],
        ['list', '/', '--limit', String(LIST_LIMIT_MIN - 1)],
      ));
  }
});

describe('a failure of our own, with nothing to say about it', () => {
  // The last resort of the failure renderer: an error with no message of its own. A read applied
  // nothing; a write that was handed to the transport may have been applied.
  const silent = (): Connected => ({
    connection: STUB_CONNECTION,
    transport: {
      endpoint: { base: STUB_ENDPOINT } as Transport['endpoint'],
      timeoutMs: 1_000,
      invoke: () => {
        throw new Error('');
      },
    },
  });
  const cases: ReadonlyArray<readonly [string, readonly string[], boolean]> = [
    ['read', ['get', '/work'], false],
    ['write', ['archive', '/work', '--revision', '1'], true],
  ];
  for (const [name, argv, sent] of cases) {
    for (const json of [false, true]) {
      it(`answers ${name}${json ? ' as JSON' : ''}`, async () => {
        const ran = await runCli(json ? [...argv, '--json'] : argv, { connect: silent });
        assert.equal(ran.code, sent ? 7 : 1, ran.stderr);
        if (json) assertErrorDocument(ran, { exit: sent ? 7 : 1, code: 'unexpected' });
        refusals.expectRun(caseName('unexpected', name, ...(json ? ['json'] : [])), ran);
      });
    }
  }
});

/** Run the CLI as a process, with standard input arranged by `stdin`, against nothing at all. */
const runProcess = (
  argv: readonly string[],
  stdin: { readonly text: string } | 'dev-null' | 'closed',
): Promise<Ran> =>
  new Promise((resolveRun, rejectRun) => {
    // An address nothing listens on: a request that is sent fails as unreachable, exit 6, which is
    // what tells a body that went ahead apart from a refusal.
    const env = {
      PATH: process.env.PATH ?? '',
      RAPHAEL_ENDPOINT: 'http://127.0.0.1:2',
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

  it('refuses whitespace only, which is what echo "$(gen)" sends when gen failed', async () => {
    const blankUpdate = await runProcess(update, { text: '\n' });
    assert.equal(blankUpdate.code, 2);
    refusals.expectRun('stdin-blank-update', blankUpdate);
    const blankCreate = await runProcess(create, { text: ' \t\r\n\n' });
    assert.equal(blankCreate.code, 2);
    refusals.expectRun('stdin-blank-create', blankCreate);
  });

  it('sends a body with text, whatever whitespace surrounds it', async () => {
    const ran = await runProcess(update, { text: '\n  x\n' });
    // It got as far as the connection, which nothing answers: not sent, and trying again may work.
    assert.equal(ran.code, 6);
    assert.match(ran.stderr, /^Could not connect to the server at /);
    assert.match(ran.stderr, /^The change was not sent\.$/m);
  });
});

describe('a file named with @ that cannot be used', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raphael-at-file-'));
  after(() => {
    chmodSync(join(directory, 'locked.md'), 0o600);
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, 'empty.md'), '');
  writeFileSync(join(directory, 'blank.md'), ' \n\t\n');
  writeFileSync(join(directory, 'locked.md'), '# Locked');
  chmodSync(join(directory, 'locked.md'), 0o000);
  mkdirSync(join(directory, 'folder'));
  const at = (name: string): string => `@${join(directory, name)}`;
  const update = (body: string): readonly string[] => [
    'update',
    '/work/contracts',
    '--body',
    body,
    '--revision',
    '3',
  ];
  const create = (...extra: string[]): readonly string[] => [
    'create',
    'resource.note',
    '/work/n',
    '--title',
    'N',
    ...extra,
  ];
  const list = (filter: string): readonly string[] => ['list', '/', '--filter', filter];

  /** Refused before anything was sent, with the temporary directory written as <tmp>. */
  const refusedFile = async (name: string, argv: readonly string[]): Promise<void> => {
    const ran = await runCli(argv, { connect: neverConnect });
    assert.equal(ran.code, 2, ran.stderr);
    refusals.expectRun(name, { ...ran, stderr: ran.stderr.replaceAll(directory, '<tmp>') });
  };

  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    // A file a failed generator left empty would otherwise clear the body under a success.
    ['body-empty-update', update(at('empty.md'))],
    ['body-blank-update', update(at('blank.md'))],
    ['body-empty-create', create('--body', at('empty.md'))],
    ['body-missing', create('--body', at('missing.md'))],
    ['body-permission', create('--body', at('locked.md'))],
    ['body-not-a-file', create('--body', at('folder'))],
    // A bare @ would otherwise read the current directory.
    ['body-bare-at', create('--body', '@')],
    ['metadata-bare-at', create('--metadata', '@')],
    ['filter-bare-at', list('@')],
    // Metadata and filters refuse @- and are never text beginning with @.
    ['metadata-missing', create('--metadata', at('missing.json'))],
    ['metadata-not-a-file', create('--metadata', at('folder'))],
    ['filter-missing', list(at('missing.json'))],
    ['filter-permission', list(at('locked.md'))],
    ['filter-not-a-file', list(at('folder'))],
  ];
  for (const [name, argv] of cases) {
    it(`refuses ${name}`, () => refusedFile(caseName('at-file', name), argv));
  }
});

describe('a signal while waiting on standard input', () => {
  /**
   * Start `update --body @-`, give it part of a body, then send the signal. A signal that lands before
   * node has started the CLI kills the process outright (exit null), which says nothing about the CLI,
   * so such a run is repeated with a longer wait rather than counted.
   */
  const interrupted = async (
    signal: 'SIGINT' | 'SIGTERM',
  ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    for (const wait of [500, 1_500, 4_000]) {
      const child = spawn(
        process.execPath,
        [main, 'update', '/work/contracts', '--body', '@-', '--revision', '3'],
        {
          env: {
            PATH: process.env.PATH ?? '',
            RAPHAEL_ENDPOINT: 'http://127.0.0.1:2',
            RAPHAEL_API_KEY: 'stdin-key-0123456789abcdef0123456789',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15_000,
          killSignal: 'SIGKILL',
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      // Some input arrives and more is still coming when the signal does.
      child.stdin.write('# Half a body\n');
      setTimeout(() => child.kill(signal), wait);
      const code = await new Promise<number | null>((done) => child.on('close', done));
      if (code !== null) return { code, stdout, stderr };
    }
    assert.fail('the CLI never got as far as reading standard input');
  };

  for (const [signal, exit] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    it(`ends ${signal === 'SIGINT' ? 'with Ctrl-C' : 'on SIGTERM'}: exit ${exit}, and nothing was sent`, async () => {
      const ran = await interrupted(signal);
      assert.equal(ran.code, exit);
      assert.equal(ran.stdout, '');
      assert.equal(
        ran.stderr,
        `Interrupted by ${signal}.\nThe change was not sent.\nhint: Run the command again.\n`,
      );
    });
  }
});

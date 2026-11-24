import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ApiCredential, serve, silentLogger } from '@raphael/backend';
import { createTransport, type FetchLike, type Transport } from '@raphael/client';
import { update as updateDirect } from '@raphael/client/nodes';
import { PROTOCOL_VERSION } from '@raphael/contracts/connection';
import {
  decodeAddFavoriteResponse,
  decodeListResponse,
  decodeLifecycleResponse,
  decodeMoveResponse,
  decodeUpdateResponse,
} from '@raphael/contracts/nodes';
import { Effect, Either, Exit, Scope } from 'effect';

import { version } from '../src/distribution.ts';
import { invocationOf, run as runCli } from '../src/main.ts';
import { runLogin } from '../src/modules/connection/login.ts';
import { connectFrom } from '../src/modules/connection/remote.ts';
import { newSession } from '../src/shared/command.ts';
import { assertErrorDocument, assertRefusal } from './support/golden.ts';

/**
 * The CLI against a real server.
 *
 * A live backend on an ephemeral port over a real on-disk database. Most cases call the CLI's
 * entry function with captured streams, exercising argument parsing and real HTTP without starting
 * a process per assertion. Subprocess cases retain evidence for stdin, OS exit codes, and streams.
 *
 * The server is started by the test and torn down in `after`, which is what keeps this a bounded
 * automated check rather than a long-running process.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
// The sources, not `dist`: `pnpm test` does not build first, and a copy assertion checked against a
// stale build would pass or fail for reasons that have nothing to do with the change under test.
const binary = join(packageRoot, 'src', 'main.ts');

/** Long enough to satisfy the shared key policy, and obviously not a real credential. */
const KEY = 'test-key-0123456789abcdef0123456789';

let endpoint = '';
let scope: Scope.CloseableScope;
const directories: string[] = [];

const temporary = (prefix: string): string => {
  // Resolved, because /tmp is a symlink on macOS and the filesystem checks verify a resolved chain.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
};

before(async () => {
  const data = temporary('raphael-cli-db-');
  scope = Effect.runSync(Scope.make());
  const running = await Effect.runPromise(
    Scope.extend(
      serve({
        // Built directly rather than through `resolveOptions`, which is the *file* surface: a
        // configuration file may not ask for port 0, and a test that reads the bound port back must.
        options: {
          server: { host: '127.0.0.1', port: 0 },
          database: {
            databasePath: join(data, 'raphael.sqlite'),
          },
        },
        credential: ApiCredential.fromKey(KEY),
        release: version(),
        logger: silentLogger,
      }),
      scope,
    ),
  );
  endpoint = `http://127.0.0.1:${running.port}`;
});

after(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** Help text with its line wrapping undone, so a sentence can be matched wherever it breaks. */
const wrapped = (text: string): string => text.replaceAll(/\s+/gu, ' ');

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `holdStdin` leaves the child's standard input open and empty, so a command that reads it blocks
 * until the spawn timeout. That is how "this refusal did not touch stdin" is asserted: a prompt
 * exit 2 with the pipe still open proves nothing was read from it.
 */
const runProcess = (
  args: readonly string[],
  options: { env?: Record<string, string>; stdin?: string; holdStdin?: boolean } = {},
): Promise<Ran> =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        RAPHAEL_ENDPOINT: endpoint,
        RAPHAEL_API_KEY: KEY,
        ...options.env,
      },
      cwd: packageRoot,
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else if (options.holdStdin !== true) child.stdin.end();
  });

const run = async (
  args: readonly string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<Ran> => {
  if (options.stdin !== undefined) return runProcess(args, options);
  let stdout = '';
  let stderr = '';
  const environment = { RAPHAEL_ENDPOINT: endpoint, RAPHAEL_API_KEY: KEY, ...options.env };
  const code = await runCli(args, {
    streams: {
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    },
    environment,
    platform: process.platform,
    cwd: packageRoot,
    // Remote commands watch for signals; none arrives here.
    onSignal: () => () => {},
    exit: () => {
      throw new Error('Remote commands must return their exit code');
    },
    terminal: { stdin: false, stdout: false },
    connect: () => connectFrom(environment, process.platform),
  });
  return { code, stdout, stderr };
};

const jsonOf = (ran: Ran): any => JSON.parse(ran.stdout);

describe('reading the seeded hierarchy', () => {
  it('lists the root', async () => {
    const ran = await run(['list', '/', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    const page = jsonOf(ran);
    const slugs = page.items.map((item: { slug: string }) => item.slug).sort();
    // A fresh database is seeded with these two ordinary areas.
    assert.deepEqual(slugs, ['personal', 'work']);
  });

  it('gets an entity by path and by id, and they agree', async () => {
    const byPath = jsonOf(await run(['get', '/work', '--json']));
    const byId = jsonOf(await run(['get', '--id', String(byPath.entity.id), '--json']));
    assert.deepEqual(byPath.entity, byId.entity);
  });

  it('reads leading zeros in an id as every whole-number option does', async () => {
    const byPath = jsonOf(await run(['get', '/work', '--json']));
    const padded = await run(['get', '--id', `00${byPath.entity.id}`, '--json']);
    assert.equal(padded.code, 0, padded.stderr);
    assert.equal(jsonOf(padded).entity.id, byPath.entity.id);
    const listed = await run(['list', '--id', `0${byPath.entity.id}`, '--limit', '01', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    // Zero is still not an id, however it is written.
    assert.equal((await run(['get', '--id', '00'])).code, 2);
  });

  it('prints a path for an id', async () => {
    const work = jsonOf(await run(['get', '/work', '--json'])).entity;
    const ran = await run(['path', '--id', String(work.id)]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), '/work');
  });

  it('reports a missing entity as not found, naming what was looked up', async () => {
    const ran = await run(['get', '/nope']);
    assert.equal(ran.code, 3);
    assert.equal(ran.stdout, '', 'nothing belongs on stdout when there is no result');
    assert.equal(
      ran.stderr,
      'Nothing exists at /nope.\nhint: Run "raphael list /" to see what is there.\ncode: node_not_found (404)\n',
    );
  });

  it('points a missing path at a place that exists, and following the hint succeeds', async () => {
    // Only /work exists of these: listing the missing parent's own parent would fail again.
    const cases: ReadonlyArray<readonly string[]> = [
      ['create', 'area', '/work/zz/yy/xx', '--title', 'X'],
      ['move', '/personal', '/work/zz/yy/xx'],
      ['get', '/work/nope/deeper'],
      ['path', '/work/nope'],
      ['create', 'area', '/nope/x', '--title', 'X'],
    ];
    for (const argv of cases) {
      const ran = await run(argv);
      assert.equal(ran.code, 3, ran.stderr);
      const hint = /^hint: Run "raphael (.*)" to see/mu.exec(ran.stderr)?.[1];
      assert.ok(hint !== undefined, ran.stderr);
      const followed = await run(hint.split(' '));
      assert.equal(followed.code, 0, `${argv.join(' ')} hinted "${hint}": ${followed.stderr}`);
    }
  });
});

describe('creating', () => {
  it('creates from a complete path and reports the entity', async () => {
    const ran = await run([
      'create',
      'project',
      '/work/from-path',
      '--title',
      'From path',
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    const { entity } = jsonOf(ran);
    assert.equal(entity.type, 'project');
    assert.equal(entity.slug, 'from-path');
    assert.equal(entity.title, 'From path');
    assert.equal(entity.revision, 1);
  });

  it('creates from a parent id and an explicit slug', async () => {
    const work = jsonOf(await run(['get', '/work', '--json'])).entity;
    const ran = await run([
      'create',
      'project',
      '--parent-id',
      String(work.id),
      '--slug',
      'from-id',
      '--title',
      'From id',
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(jsonOf(ran).entity.parentId, work.id);
  });

  it('refuses both addressing forms at once', async () => {
    const ran = await run([
      'create',
      'project',
      '/work/x',
      '--parent-id',
      '1',
      '--slug',
      'x',
      '--title',
      'X',
    ]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /not both/);
  });

  it('requires a title for a container, but not for a note', async () => {
    const container = await run(['create', 'project', '/work/untitled']);
    assert.equal(container.code, 2);
    assert.match(container.stderr, /^--title: A title is required\.$/m);

    // The CLI does not decide whether a kind may omit a title; it declines to invent one and lets the
    // server answer. So this reaches the server and succeeds on the strength of its body.
    const note = await run([
      'create',
      'resource.note',
      '/work/untitled-note',
      '--body',
      '# Derived name',
      '--json',
    ]);
    assert.equal(note.code, 0);
    assert.equal(jsonOf(note).entity.title, 'Derived name');
  });

  it('carries description, tags, and metadata', async () => {
    const ran = await run([
      'create',
      'project',
      '/work/furnished',
      '--title',
      'Furnished',
      '--description',
      'A described project',
      '--tag',
      'one',
      '--tag',
      'two',
      '--metadata',
      '{"priority":3}',
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    const { entity } = jsonOf(ran);
    assert.equal(entity.description, 'A described project');
    assert.deepEqual([...entity.tags].sort(), ['one', 'two']);
    assert.deepEqual(entity.metadata, { priority: 3 });
  });

  it('reads a body from standard input and returns it in the asked-for format', async () => {
    const ran = await run(
      [
        'create',
        'project',
        '/work/from-stdin',
        '--title',
        'Stdin',
        '--body',
        '@-',
        '--return-format',
        'tiptap',
        '--json',
      ],
      { stdin: '# Heading\n\nA paragraph.\n' },
    );
    assert.equal(ran.code, 0, ran.stderr);
    const { entity } = jsonOf(ran);
    assert.equal(entity.body.format, 'tiptap');
    assert.equal(entity.body.value.type, 'doc');
  });

  it('creates from a TipTap document given inline, from a file, and on standard input', async () => {
    // The submitted format, not the returned one. This is the path that was previously impossible:
    // the document was parsed to check its syntax and then the original *string* was sent, which the
    // shared request contract rejects before the transport is ever reached.
    const document = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From TipTap' }] }],
    });

    const inline = await run([
      'create',
      'project',
      '/work/tiptap-inline',
      '--title',
      'Inline',
      '--body-format',
      'tiptap',
      '--body',
      document,
      '--json',
    ]);
    assert.equal(inline.code, 0, inline.stderr);
    assert.match(jsonOf(inline).entity.body.value, /From TipTap/);

    const file = join(temporary('raphael-cli-body-'), 'body.json');
    writeFileSync(file, document);
    const fromFile = await run([
      'create',
      'project',
      '/work/tiptap-file',
      '--title',
      'File',
      '--body-format',
      'tiptap',
      '--body',
      `@${file}`,
      '--json',
    ]);
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.match(jsonOf(fromFile).entity.body.value, /From TipTap/);

    const fromStdin = await run(
      [
        'create',
        'project',
        '/work/tiptap-stdin',
        '--title',
        'Stdin',
        '--body-format',
        'tiptap',
        '--body',
        '@-',
        '--return-format',
        'tiptap',
        '--json',
      ],
      { stdin: document },
    );
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
    assert.equal(jsonOf(fromStdin).entity.body.value.type, 'doc');
  });

  it('rejects a TipTap body that is JSON but not a document, before sending it', async () => {
    const ran = await run([
      'create',
      'project',
      '/work/tiptap-bad',
      '--title',
      'Bad',
      '--body-format',
      'tiptap',
      '--body',
      '[1,2,3]',
    ]);
    assert.equal(ran.code, 2, ran.stderr);
    assert.equal(ran.stdout, '');
  });

  it('rejects malformed TipTap JSON locally', async () => {
    const ran = await run([
      'create',
      'project',
      '/work/tiptap-broken',
      '--title',
      'Broken',
      '--body-format',
      'tiptap',
      '--body',
      '{not json',
    ]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /--body must be valid JSON: syntax error at line 1, column 2\./);
    assert.equal(ran.stderr.includes('{not json'), false);
  });

  it('refuses a body file that is not valid UTF-8 rather than storing replaced characters', async () => {
    // `Buffer.toString("utf8")` would substitute U+FFFD and store altered content under a successful
    // creation. The bytes the person named are either usable or reported.
    const file = join(temporary('raphael-cli-bytes-'), 'body.md');
    writeFileSync(file, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const ran = await run([
      'create',
      'project',
      '/work/bad-bytes',
      '--title',
      'Bytes',
      '--body',
      `@${file}`,
    ]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /not valid UTF-8/);
  });

  it('refuses a body source that is not a regular file', async () => {
    // A FIFO reports a size of zero and then supplies bytes without end, so a stat-then-read bound
    // would not bound anything.
    const directory = temporary('raphael-cli-fifo-');
    const fifo = join(directory, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const ran = await run([
      'create',
      'project',
      '/work/from-fifo',
      '--title',
      'Fifo',
      '--body',
      `@${fifo}`,
    ]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /not a regular file/);
  });

  it('treats a leading @ as a path unless it was given literally', async () => {
    const missing = await run([
      'create',
      'project',
      '/work/missing-file',
      '--title',
      'M',
      '--body',
      '@/does/not/exist',
    ]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /^The body file at "\/does\/not\/exist" does not exist\./m);
    assert.match(missing.stderr, /Use --body-literal for text beginning with @\./);

    const literal = await run([
      'create',
      'project',
      '/work/literal-at',
      '--title',
      'L',
      '--body-literal',
      '@not-a-path',
      '--json',
    ]);
    assert.equal(literal.code, 0, literal.stderr);
    assert.match(jsonOf(literal).entity.body.value, /@not-a-path/);
  });

  it('refuses two body sources at once', async () => {
    const ran = await run([
      'create',
      'project',
      '/work/two-bodies',
      '--title',
      'T',
      '--body',
      'a',
      '--body-literal',
      'b',
    ]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /not both/);
  });

  it('reports a slug conflict with what conflicted and where', async () => {
    await run(['create', 'project', '/work/duplicate', '--title', 'First']);
    const ran = await run(['create', 'project', '/work/duplicate', '--title', 'Second']);
    assert.equal(ran.code, 4);
    assert.match(ran.stderr, /^code: slug_conflict \(409\)$/m);
    // The full path the caller typed, and what holds it, by an id that can be fetched.
    assert.match(ran.stderr, /^\/work\/duplicate is already taken by project \d+\.$/m);
    assert.match(ran.stderr, /^Nothing was changed\.$/m);
    assert.match(ran.stderr, /^hint: Run "raphael get --id \d+" to see what holds it/m);
  });

  it('refuses an area under a project, and says so as a parentage problem', async () => {
    await run(['create', 'project', '/work/host', '--title', 'Host']);
    const ran = await run(['create', 'area', '/work/host/nested', '--title', 'Nested']);
    assert.equal(ran.code, 4);
    assert.match(ran.stderr, /^code: invalid_parent \(422\)$/m);
    assert.match(
      ran.stderr,
      /^\/work\/host\/nested cannot be created: a project cannot contain an area\. An area can go at the top level or inside an area\.$/m,
    );
  });
});

describe('pagination', () => {
  it('never implies the page is everything', async () => {
    for (const index of [1, 2, 3]) {
      await run(['create', 'project', `/work/page-${index}`, '--title', `Page ${index}`]);
    }
    const ran = await run(['list', '/work', '--limit', '2']);
    assert.equal(ran.code, 0, ran.stderr);
    // The page note describes the page; it is not one of its rows, so it is on stderr.
    assert.equal(ran.stdout.trimEnd().split('\n').length, 2, 'stdout holds exactly the rows');
    // The footer gives the range and the whole next command, with the page size kept.
    assert.equal(
      ran.stderr,
      'Showing 1-2.\nhint: Run "raphael list /work --limit 2 --skip 2" for the next page.\n',
    );
  });

  it('refuses a limit outside the contract rather than clamping it', async () => {
    for (const limit of ['0', '501', '2.5', 'ten']) {
      const ran = await run(['list', '/work', '--limit', limit]);
      assert.equal(ran.code, 2, `--limit ${limit}`);
    }
  });

  it('refuses a repeated filter operand rather than dropping entries', async () => {
    // The old --types flag enforced this by hand while splitting on commas. The rule did not go away
    // with the flag: it moved into the contract's own `$in` operand list, which is where it now has to
    // be exercised. A filter that silently discarded half of what was asked for would return a page
    // that does not answer the question.
    const ran = await run(['list', '/work', '--filter', '{"type":{"$in":["area","area"]}}']);
    assert.equal(ran.code, 2);
    assert.match(
      ran.stderr,
      /--filter: Type must be area, project, resource, or \$in with one or more distinct values from that list\./,
    );
  });

  it('filters by type', async () => {
    const ran = await run(['list', '/', '--filter', '{"type":"area"}', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    for (const item of jsonOf(ran).items) assert.equal(item.type, 'area');
  });
});

/**
 * Run the CLI as a process whose stdout reader goes away at once, as `| head -1` or `| true` does.
 * Its standard input carries `stdin` when given.
 */
const runClosedReader = (args: readonly string[], stdin?: string): Promise<Ran> =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: { PATH: process.env.PATH ?? '', RAPHAEL_ENDPOINT: endpoint, RAPHAEL_API_KEY: KEY },
      cwd: packageRoot,
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout: '', stderr }));
    child.stdin.end(stdin ?? '');
  });

describe('content refusals, as a real server words them', () => {
  it('states the supported heading levels for a heading the server refuses', async () => {
    const body = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 7 }, content: [{ type: 'text', text: 'Deep' }] },
      ],
    });
    const ran = await run([
      'create',
      'resource.note',
      '/work/deep-heading',
      '--title',
      'Deep',
      '--body-format',
      'tiptap',
      '--body',
      body,
    ]);
    assert.equal(ran.code, 2);
    assert.match(
      ran.stderr,
      /^The body has a heading level Raphael does not support \(block 1\)\. Use 1 to 3\.$/m,
    );
  });
});

describe('a reader that goes away', () => {
  it('is not an error: a large read exits 0 with nothing on stderr', async () => {
    // Larger than any pipe buffer, so the write after the reader left really does fail.
    const big = `# Big\n\n${'words in one long paragraph '.repeat(20_000)}\n`;
    const made = await run(
      ['create', 'resource.note', '/work/epipe-big', '--title', 'Big', '--body', '@-'],
      {
        stdin: big,
      },
    );
    assert.equal(made.code, 0, made.stderr);
    for (const args of [
      ['get', '/work/epipe-big'],
      ['get', '/work/epipe-big', '--json'],
    ]) {
      const ran = await runClosedReader(args);
      assert.equal(ran.code, 0, `${args.join(' ')}: ${ran.stderr}`);
      assert.equal(ran.stderr, '', 'no stack trace, no complaint');
    }
  });

  it('does not turn a successful write into a failure', async () => {
    const ran = await runClosedReader([
      'create',
      'project',
      '/work/epipe-write',
      '--title',
      'Written',
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stderr, '');
    // It happened, so a retry would only meet its own first attempt.
    assert.equal((await run(['get', '/work/epipe-write'])).code, 0);
  });

  it('is not an error for help either', async () => {
    const ran = await runClosedReader(['--help']);
    assert.equal(ran.code, 0);
    assert.equal(ran.stderr, '');
  });
});

describe('stream and exit discipline', () => {
  it('puts results on stdout and diagnostics on stderr', async () => {
    const ok = await runProcess(['get', '/work', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stderr, '');
    assert.ok(ok.stdout.length > 0);

    const bad = await runProcess(['get', '/nope', '--json']);
    assert.equal(bad.code, 3, bad.stderr);
    assertErrorDocument(bad, { exit: 3, code: 'node_not_found', command: 'get' });
  });

  it('never prints the API key, whatever happens', async () => {
    const outputs = await Promise.all([
      run(['get', '/work', '--json']),
      run(['get', '/nope']),
      run(['list', '/', '--limit', '0']),
      run(['--help']),
    ]);
    for (const ran of outputs) {
      assert.equal(ran.stdout.includes(KEY), false);
      assert.equal(ran.stderr.includes(KEY), false);
    }
  });
});

describe('connecting', () => {
  it('refuses a half-set environment pair instead of mixing sources', async () => {
    const ran = await run(['get', '/work'], { env: { RAPHAEL_ENDPOINT: '' } });
    assert.equal(ran.code, 5);
    assert.match(ran.stderr, /^hint: Set RAPHAEL_ENDPOINT too, or unset RAPHAEL_API_KEY/m);
  });

  it('refuses a wrong key as an operation failure', async () => {
    const ran = await run(['get', '/work'], { env: { RAPHAEL_API_KEY: 'b'.repeat(32) } });
    assert.equal(ran.code, 5, 'not authorized: fix the setup, do not retry');
    assert.match(ran.stderr, /^code: unauthorized \(401\)$/m);
  });

  it('still refuses an endpoint that cannot carry a credential', async () => {
    // Plain http to any host is allowed; userinfo in the URL is not, because it would put the key
    // into shell history and logs whatever the scheme.
    const ran = await run(['get', '/work'], {
      env: { RAPHAEL_ENDPOINT: 'http://user:secret@raphael.example.com' },
    });
    assert.equal(ran.code, 5);
    assert.match(
      ran.stderr,
      /^RAPHAEL_ENDPOINT is not a usable address: it includes a user name or password/m,
    );
    assert.equal(ran.stderr.includes('secret'), false);
  });

  it('reports an unreachable server plainly, with where to look', async () => {
    const ran = await run(['create', 'project', '/work/unreachable', '--title', 'U'], {
      env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:2' },
    });
    // Nothing was ever sent, so this is "not applied, and retrying may work" - not "unknown".
    assert.equal(ran.code, 6);
    assert.equal(
      ran.stderr,
      'Could not connect to the server at http://127.0.0.1:2 (from RAPHAEL_ENDPOINT): nothing is listening there (connection refused).\n' +
        'The change was not sent.\n' +
        'hint: Start the server with "raphael server serve --port 2", or fix RAPHAEL_ENDPOINT.\n',
    );
  });

  it('reports the protocol identifier the server answered with, as the identifier it is', async () => {
    // `login --json` is the one place a person can read back what their server said. The identifier
    // is a date string now, and this is what stops it quietly reverting to a number.
    const home = temporary('raphael-cli-login-');
    let stdout = '';

    const code = await runLogin(['--json'], {
      session: newSession(invocationOf(['login', '--json'])),
      streams: {
        out: (text) => {
          stdout += text;
        },
        err: () => {
          throw new Error('a successful login writes nothing to stderr');
        },
      },
      // Driven directly rather than through the terminal prompter: this is about the reported
      // identifier, and a real prompt would need a TTY that an automated check does not have.
      prompter: () => ({
        ask: async () => endpoint,
        askHidden: async () => KEY,
        close: () => {},
      }),
      environment: { XDG_CONFIG_HOME: home },
      platform: 'linux',
    });

    assert.equal(code, 0);
    const reported = JSON.parse(stdout);
    assert.equal(reported.protocolVersion, PROTOCOL_VERSION);
    assert.equal(typeof reported.protocolVersion, 'string');
  });
});

describe('notes', () => {
  it('creates, reads, and lists a note with its qualified type', async () => {
    const created = await run([
      'create',
      'resource.note',
      '/work/api-design',
      '--title',
      'API design',
      '--description',
      'Request contracts',
      '--body',
      '# API design',
    ]);
    assert.equal(created.code, 0);
    assert.match(created.stdout, /Created resource\.note \d+: API design/);

    const got = await run(['get', '/work/api-design']);
    assert.equal(got.code, 0);
    assert.match(got.stdout, /^resource\.note \d+: API design$/m);
    assert.match(got.stdout, /^ {2}revision: {4}1$/m);
    assert.match(got.stdout, /^ {2}description: Request contracts$/m);
    assert.match(got.stdout, /\n\n# API design\n$/);

    const listed = await run(['list', '/work', '--filter', '{"type":"resource"}']);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /resource\.note {2}- {2}\/work\/api-design +API design$/m);
  });

  it('accepts a body from a file, standard input, and TipTap', async () => {
    const directory = temporary('raphael-cli-note-');
    const file = join(directory, 'note.md');
    writeFileSync(file, '# From a file\n', 'utf8');

    const fromFile = await run([
      'create',
      'resource.note',
      '/work/from-file',
      '--body',
      `@${file}`,
      '--json',
    ]);
    assert.equal(fromFile.code, 0);
    assert.equal(jsonOf(fromFile).entity.title, 'From a file');
    assert.equal(jsonOf(fromFile).entity.kind, 'note');

    const fromStdin = await run(
      ['create', 'resource.note', '/work/note-from-stdin', '--body', '@-', '--json'],
      { stdin: '# From standard input\n' },
    );
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
    assert.equal(jsonOf(fromStdin).entity.title, 'From standard input');

    const document = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From TipTap' }] }],
    });
    const fromTipTap = await run([
      'create',
      'resource.note',
      '/work/from-tiptap',
      '--body',
      document,
      '--body-format',
      'tiptap',
      '--json',
    ]);
    assert.equal(fromTipTap.code, 0);
    assert.equal(jsonOf(fromTipTap).entity.title, 'From TipTap');
  });

  it('names an untitled note from its description, and asks for a title when nothing can name it', async () => {
    const described = await run([
      'create',
      'resource.note',
      '/work/note-from-description',
      '--description',
      '\n  Weekly review \nmore',
      '--json',
    ]);
    assert.equal(described.code, 0, described.stderr);
    assert.equal(jsonOf(described).entity.title, 'Weekly review');

    const unnamed = await run(['create', 'resource.note', '/work/note-unnamed', '--body', '   ']);
    assert.equal(unnamed.code, 2);
    assert.match(
      unnamed.stderr,
      /--title: A title is required\. The body and description have no text to take one from\./,
    );
    assert.equal((await run(['get', '/work/note-unnamed'])).code, 3, 'nothing was sent');
  });

  it('creates a note with no body at all when it is given a title', async () => {
    const ran = await run([
      'create',
      'resource.note',
      '/work/empty-note',
      '--title',
      'Empty note',
      '--json',
    ]);
    assert.equal(ran.code, 0);
    assert.equal(jsonOf(ran).entity.body.value, '');
  });

  it('refuses a nameless note locally, before any request is made', async () => {
    // The CLI decides this itself; the server's own "A title is required." is never reached.
    assertRefusal(
      await run(['create', 'resource.note', '/work/nameless']),
      {
        exit: 2,
        code: 'usage',
        lines: [
          '--title: A title is required. No body was given to take one from, and no description. Standard input is not a terminal; to read the body from it, pass --body @-.',
          'The change was not sent.',
          'hint: Run "raphael create --help" for usage.',
        ],
      },
      await run(['create', 'resource.note', '/work/nameless', '--json']),
    );
  });

  it('refuses an unknown type token before any request is made', async () => {
    for (const token of ['resource', 'resource.bogus', 'resource.note.extra', 'note', 'sketch']) {
      const ran = await run(['create', token, '/work/whatever', '--title', 'T']);
      assert.equal(ran.code, 2, token);
      assert.match(ran.stderr, /area, project or resource\.note/, token);
    }
  });

  it('filters by resource, and by kind through the key that owns it', async () => {
    const byType = await run(['list', '/work', '--filter', '{"type":"resource"}', '--json']);
    assert.equal(byType.code, 0);

    // A qualified token is not a value `type` accepts. The dotted form belongs to `create`, where it
    // names what to make; in a filter, which leaf is wanted is the `kind` key's question.
    const qualified = await run(['list', '/work', '--filter', '{"type":"resource.note"}']);
    assert.equal(qualified.code, 2);
    assert.match(
      qualified.stderr,
      /--filter: Type must be area, project, resource, or \$in with one or more distinct values from that list\./,
    );

    const byKind = await run([
      'list',
      '/work',
      '--filter',
      '{"type":"resource","kind":"note"}',
      '--json',
    ]);
    assert.equal(byKind.code, 0);
    for (const item of jsonOf(byKind).items) {
      assert.equal(item.type, 'resource');
      assert.equal(item.kind, 'note');
    }
  });
});

describe('ordering', () => {
  it('defaults to slug order and honours explicit clauses in priority order', async () => {
    const area = await run(['create', 'area', '/ordering', '--title', 'Ordering', '--json']);
    assert.equal(area.code, 0);

    for (const slug of ['charlie', 'alpha', 'bravo']) {
      const made = await run([
        'create',
        'resource.note',
        `/ordering/${slug}`,
        '--title',
        slug,
        '--json',
      ]);
      assert.equal(made.code, 0);
    }

    const byDefault = await run(['list', '/ordering', '--json']);
    assert.deepEqual(
      jsonOf(byDefault).items.map((item: { slug: string }) => item.slug),
      ['alpha', 'bravo', 'charlie'],
    );

    const descending = await run(['list', '/ordering', '--order-by', 'slug:desc', '--json']);
    assert.deepEqual(
      jsonOf(descending).items.map((item: { slug: string }) => item.slug),
      ['charlie', 'bravo', 'alpha'],
    );

    // Repeated flags are preserved in occurrence order rather than the last one winning. These were
    // created in one run, so their timestamps may tie - which is exactly when the second clause is
    // what decides, and the reason a tie is worth building into the fixture.
    const tied = await run([
      'list',
      '/ordering',
      '--order-by',
      'updatedAt:desc',
      '--order-by',
      'slug:asc',
      '--json',
    ]);
    assert.equal(tied.code, 0);
    assert.equal(jsonOf(tied).items.length, 3);

    const byId = await run(['list', '/ordering', '--order-by', 'id:desc', '--json']);
    const ids = jsonOf(byId).items.map((item: { id: number }) => item.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a: number, b: number) => b - a),
    );
  });

  it('pages a recursive root listing as one globally ordered sequence', async () => {
    // Notes spread across two areas and two projects, so the recursion has to cross container
    // boundaries to collect them and the ordering has to span those branches rather than run per
    // branch.
    for (const [area, project] of [
      ['paging-one', 'alpha'],
      ['paging-two', 'beta'],
    ] as const) {
      assert.equal((await run(['create', 'area', `/${area}`, '--title', area, '--json'])).code, 0);
      assert.equal(
        (await run(['create', 'project', `/${area}/${project}`, '--title', project, '--json']))
          .code,
        0,
      );
      for (const n of ['1', '2', '3']) {
        const made = await run([
          'create',
          'resource.note',
          `/${area}/${project}/page-${area}-${n}`,
          '--title',
          `note ${area} ${n}`,
          '--json',
        ]);
        assert.equal(made.code, 0);
      }
    }

    // The whole ordered sequence, read in one page. Everything below is checked against this rather
    // than against a hand-written list, so other tests' data cannot make the assertions wrong - and
    // the property being tested is exactly that a page is a window on this one sequence.
    const whole = await run([
      'list',
      '/',
      '-r',
      '--filter',
      '{"type":"resource"}',
      '--order-by',
      'slug:asc',
      '--limit',
      '500',
      '--json',
    ]);
    assert.equal(whole.code, 0);
    const all = jsonOf(whole).items as { id: number; slug: string; parentId: number }[];
    assert.equal(all.length > 6, true, 'the fixture notes are in there');
    assert.equal(
      new Set(all.filter((i) => i.slug.startsWith('page-')).map((i) => i.parentId)).size,
      2,
      'the fixture spans two projects, so recursion really did cross containers',
    );

    // A page is that sequence, windowed. Ordering before pagination is what makes this hold; sorting
    // a page after cutting it would reorder within the window and leave the boundaries wrong.
    const page = await run([
      'list',
      '/',
      '-r',
      '--filter',
      '{"type":"resource"}',
      '--order-by',
      'slug:asc',
      '--skip',
      '2',
      '--limit',
      '3',
      '--json',
    ]);
    assert.equal(page.code, 0);
    const body = jsonOf(page);
    assert.deepEqual(
      (body.items as { id: number }[]).map((i) => i.id),
      all.slice(2, 5).map((i) => i.id),
    );
    assert.deepEqual(
      (body.items as { slug: string }[]).map((i) => i.slug),
      all.slice(2, 5).map((i) => i.slug),
    );
    assert.equal(body.page.skip, 2);
    assert.equal(body.page.limit, 3);
    assert.equal(body.page.hasMore, all.length > 5);
    assert.equal(body.page.nextSkip, all.length > 5 ? 5 : null);

    // The reverse direction is the same sequence read backwards, which a mis-forwarded direction
    // would not produce.
    const reversed = await run([
      'list',
      '/',
      '-r',
      '--filter',
      '{"type":"resource"}',
      '--order-by',
      'slug:desc',
      '--limit',
      '500',
      '--json',
    ]);
    assert.deepEqual(
      (jsonOf(reversed).items as { id: number }[]).map((i) => i.id),
      [...all].reverse().map((i) => i.id),
    );
  });

  it('breaks a tie by the next clause, and by id when the caller names no other', async () => {
    // Equal slugs under different parents, which is a tie the test controls exactly. Timestamps are
    // the other tie the server can produce, but nothing at this layer can set them - two creations
    // land in whatever milliseconds they land in - so the deliberately-controlled timestamp ties are
    // exercised against the database in `apps/backend/tests/nodes-list.test.ts`, and this case pins
    // the part that is the CLI's own job: that clause priority survives the round trip.
    for (const area of ['tie-one', 'tie-two']) {
      assert.equal((await run(['create', 'area', `/${area}`, '--title', area, '--json'])).code, 0);
      const made = await run([
        'create',
        'resource.note',
        `/${area}/shared-slug`,
        '--title',
        `shared in ${area}`,
        '--json',
      ]);
      assert.equal(made.code, 0);
    }

    const idsOf = (ran: Ran): number[] =>
      (jsonOf(ran).items as { id: number; slug: string }[])
        .filter((item) => item.slug === 'shared-slug')
        .map((item) => item.id);

    // Slug alone cannot separate them, so the id clause core appends decides: ascending.
    const appended = await run([
      'list',
      '/',
      '-r',
      '--filter',
      '{"type":"resource"}',
      '--order-by',
      'slug:asc',
      '--limit',
      '500',
      '--json',
    ]);
    const ascending = idsOf(appended);
    assert.equal(ascending.length, 2);
    assert.deepEqual(
      ascending,
      [...ascending].sort((a, b) => a - b),
    );

    // An explicit id clause keeps its own direction and position instead of being shadowed by an
    // appended one, so the same tie resolves the other way.
    const explicit = await run([
      'list',
      '/',
      '-r',
      '--filter',
      '{"type":"resource"}',
      '--order-by',
      'slug:asc',
      '--order-by',
      'id:desc',
      '--limit',
      '500',
      '--json',
    ]);
    assert.deepEqual(idsOf(explicit), [...ascending].reverse());

    // And priority is the order the flags were given: leading with id:desc sorts by id across every
    // note, so the two tied slugs are no longer adjacent in the way slug-first makes them.
    const idFirst = await run([
      'list',
      '/',
      '-r',
      '--filter',
      '{"type":"resource"}',
      '--order-by',
      'id:desc',
      '--limit',
      '500',
      '--json',
    ]);
    const everyId = (jsonOf(idFirst).items as { id: number }[]).map((i) => i.id);
    assert.deepEqual(
      everyId,
      [...everyId].sort((a, b) => b - a),
    );
  });

  it('refuses malformed ordering locally, before any request', async () => {
    for (const value of [
      'slug',
      'slug:',
      ':asc',
      'slug:asc:extra',
      'title:asc',
      'slug:ascending',
      'slug asc',
      'slug:asc,id:asc',
    ]) {
      const ran = await run(['list', '/work', '--order-by', value]);
      assert.equal(ran.code, 2, value);
      assert.match(ran.stderr, /--order-by/, value);
    }

    const repeated = await run([
      'list',
      '/work',
      '--order-by',
      'slug:asc',
      '--order-by',
      'slug:desc',
    ]);
    assert.equal(repeated.code, 2);
    assert.match(repeated.stderr, /must not repeat/);
  });

  it('documents an ordering example and repeat priority in its help', async () => {
    const ran = await run(['list', '--help']);
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /--order-by updatedAt:desc --limit 4/);
    assert.match(
      wrapped(ran.stdout),
      /Repeat in priority order\. Fields: slug, updatedAt, id\. Directions: asc, desc\./,
    );
  });

  it('documents the note token and the optional title in create help', async () => {
    const ran = await run(['create', '--help']);
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /area, project, resource\.note/);
    assert.match(
      wrapped(ran.stdout),
      /Without --title, a note takes its title from the first line of the body's text that is not blank/,
    );
  });
});

describe('updating', () => {
  /** Make a note under /work with its own slug, and hand back what the server says it is. */
  const seedNote = async (slug: string, body = '# Original\n'): Promise<any> => {
    const ran = await run([
      'create',
      'resource.note',
      `/work/${slug}`,
      '--title',
      'Original',
      '--body',
      body,
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    return jsonOf(ran).entity;
  };

  const entityAt = async (path: string): Promise<any> =>
    jsonOf(await run(['get', path, '--json'])).entity;

  it('changes an entity by path, and the answer decodes as an UpdateResponse', async () => {
    const note = await seedNote('update-by-path');
    const ran = await run([
      'update',
      '/work/update-by-path',
      '--title',
      'Renamed',
      '--revision',
      String(note.revision),
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);

    // Decoded against the shared contract rather than picked at by hand: what the CLI prints for a
    // script has to be the response shape, not something that merely resembles it.
    const decoded = decodeUpdateResponse(jsonOf(ran));
    assert.equal(Either.isRight(decoded), true);
    if (Either.isRight(decoded)) {
      assert.equal(decoded.right.entity.title, 'Renamed');
      assert.equal(decoded.right.entity.revision, note.revision + 1);
      // A title change never moves the address.
      assert.equal(decoded.right.entity.slug, 'update-by-path');
    }
  });

  it('changes an entity by --id, and prints what changed', async () => {
    const note = await seedNote('update-by-id');
    const ran = await run([
      'update',
      '--id',
      String(note.id),
      '--description',
      'Now described',
      '--revision',
      String(note.revision),
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Updated resource\.note \d+: Original$/m);
    assert.match(ran.stdout, /revision: 2/);
    assert.match(ran.stdout, /^ {2}path: +\/work\/update-by-id$/m);
    assert.equal((await entityAt('/work/update-by-id')).description, 'Now described');
  });

  it('refuses a body change with no --revision, and sends nothing', async () => {
    const note = await seedNote('body-needs-revision');
    const file = join(temporary('raphael-body-'), 'note.md');
    writeFileSync(file, '# Replaced\n', 'utf8');

    const ran = await run(['update', '/work/body-needs-revision', '--body', `@${file}`]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /A body change needs --revision/);

    // Nothing left the process: the revision has not moved, so no write was even attempted.
    const settled = await entityAt('/work/body-needs-revision');
    assert.equal(settled.revision, note.revision);
    assert.match(settled.body.value, /Original/);
  });

  it('applies the same body change once --revision is given', async () => {
    const note = await entityAt('/work/body-needs-revision');
    const file = join(temporary('raphael-body-'), 'note.md');
    writeFileSync(file, '# Replaced\n', 'utf8');

    const ran = await run([
      'update',
      '/work/body-needs-revision',
      '--body',
      `@${file}`,
      '--revision',
      String(note.revision),
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    const { entity } = jsonOf(ran);
    assert.match(entity.body.value, /Replaced/);
    assert.equal(entity.revision, note.revision + 1);
  });

  it('reads the current revision for itself when no body is being replaced', async () => {
    const note = await seedNote('tag-convenience');
    await run([
      'update',
      '/work/tag-convenience',
      '--tag',
      'draft',
      '--revision',
      String(note.revision),
    ]);

    // No --revision at all. The CLI performs one Get immediately before the update and uses what it
    // returns; that is a convenience, not a blessing, because the server's guard still decides.
    const ran = await run([
      'update',
      '/work/tag-convenience',
      '--tag',
      'reviewed',
      '--tag',
      'launch',
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    const { entity } = jsonOf(ran);
    assert.deepEqual(entity.tags, ['reviewed', 'launch'], 'the given tags replace the stored ones');
    assert.equal(entity.revision, note.revision + 2);

    const cleared = await run(['update', '/work/tag-convenience', '--no-tags', '--json']);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.deepEqual(jsonOf(cleared).entity.tags, []);

    const both = await run(['update', '/work/tag-convenience', '--tag', 'x', '--no-tags']);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /Give --tag or --no-tags, not both\./);
  });

  it('reports a stale revision as a conflict, changes nothing, and never retries', async () => {
    const note = await seedNote('stale-revision');
    const stale = note.revision;
    await run([
      'update',
      '/work/stale-revision',
      '--title',
      'Moved on',
      '--revision',
      String(stale),
    ]);
    const current = await entityAt('/work/stale-revision');
    assert.equal(current.revision, stale + 1);

    const ran = await run([
      'update',
      '/work/stale-revision',
      '--title',
      'Too late',
      '--revision',
      String(stale),
    ]);
    assert.equal(ran.code, 4, 'a conflict with stored state; nothing was applied');
    assert.equal(ran.stdout, '', 'a conflict produces no result');
    assert.match(ran.stderr, /^code: revision_conflict \(409\)$/m);
    assert.match(
      ran.stderr,
      new RegExp(
        `^/work/stale-revision changed after revision ${stale}: it is now at revision ${current.revision}\\.$`,
        'm',
      ),
    );
    assert.match(ran.stderr, /^Nothing was changed\.$/m);
    assert.match(ran.stderr, /^hint: Run "raphael get \/work\/stale-revision" to see the change/m);

    // The entity is exactly where the earlier update left it.
    const afterConflict = await entityAt('/work/stale-revision');
    assert.equal(afterConflict.revision, current.revision);
    assert.equal(afterConflict.title, 'Moved on');
  });

  it('classifies a real conflict as a definite rejection in the machine report', async () => {
    // The client's own failure for a conflict a real server produced: answered, a write, and the
    // current revision as a structured detail the CLI words its sentence from.
    const note = await seedNote('report-shape');
    const transport = createTransport({
      endpoint,
      apiKey: KEY,
      fetch: fetch as unknown as FetchLike,
    }) as Transport;

    await run([
      'update',
      '/work/report-shape',
      '--title',
      'First',
      '--revision',
      String(note.revision),
    ]);
    const result = await updateDirect(transport, {
      target: { path: '/work/report-shape' },
      revision: note.revision,
      title: 'Second',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.failure, {
        kind: 'http',
        effect: 'write',
        delivery: 'answered',
        status: 409,
        code: 'revision_conflict',
        message: `This changed on the server. It is now at revision ${note.revision + 1}.`,
        details: { currentRevision: note.revision + 1 },
      });
    }
  });

  it('refuses an update that asks for no change at all', async () => {
    await seedNote('no-change');
    const ran = await run(['update', '/work/no-change']);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /Give at least one change/);
  });

  it('treats an empty value as a change, for a description and for a body', async () => {
    const note = await seedNote('clearing', '# Has a body\n');
    await run([
      'update',
      '/work/clearing',
      '--description',
      'Something',
      '--revision',
      String(note.revision),
    ]);

    // Clearing a description is a change. Presence of the flag is the rule, not its value.
    const cleared = await run(['update', '/work/clearing', '--description', '', '--json']);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal(jsonOf(cleared).entity.description, '');

    const beforeBody = await entityAt('/work/clearing');
    const emptied = await run([
      'update',
      '/work/clearing',
      '--body',
      '',
      '--revision',
      String(beforeBody.revision),
      '--json',
    ]);
    assert.equal(emptied.code, 0, emptied.stderr);
    assert.equal(jsonOf(emptied).entity.body.value, '');
  });

  it('reads a body from standard input, and still requires --revision for it', async () => {
    const note = await seedNote('update-from-stdin');
    const applied = await runProcess(
      [
        'update',
        '/work/update-from-stdin',
        '--body',
        '@-',
        '--revision',
        String(note.revision),
        '--json',
      ],
      { stdin: '# From stdin\n' },
    );
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(JSON.parse(applied.stdout).entity.body.value, /From stdin/);
  });

  it('refuses a body with no --revision before it reads standard input', async () => {
    // The pipe is left open and empty. If the refusal came after `resolveBody`, this would block
    // until the spawn timeout killed it - which is exactly the trap of making someone type a whole
    // document into a terminal and only then telling them the command was wrong.
    await seedNote('stdin-untouched');
    const ran = await runProcess(['update', '/work/stdin-untouched', '--body', '@-'], {
      holdStdin: true,
    });
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /A body change needs --revision/);
  });

  it('carries every change flag through to the server, including the two rarer ones', async () => {
    // `--slug` and `--body-literal` are the change flags nothing else here exercises. They are worth
    // an end-to-end case each because the failure mode of omitting one from the request is silent: the
    // command would pass its own "at least one change" gate, bump the revision, and print "Updated".
    const note = await seedNote('every-flag');
    const moved = await run(['update', '/work/every-flag', '--slug', 'every-flag-moved', '--json']);
    assert.equal(moved.code, 0, moved.stderr);
    assert.equal(jsonOf(moved).entity.slug, 'every-flag-moved');

    const current = await entityAt('/work/every-flag-moved');
    const literal = await run([
      'update',
      '/work/every-flag-moved',
      '--body-literal',
      '@not-a-path',
      '--revision',
      String(current.revision),
      '--json',
    ]);
    assert.equal(literal.code, 0, literal.stderr);
    assert.match(jsonOf(literal).entity.body.value, /@not-a-path/);
    assert.equal(jsonOf(literal).entity.revision, note.revision + 2);
  });

  it('says the change was not sent when the revision could not be read', async () => {
    const ran = await run(['update', '/work/anything', '--tag', 'reviewed'], {
      env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:2' },
    });
    assert.equal(ran.code, 6);
    assert.match(ran.stderr, /^The change was not sent\.$/m);
    assert.match(ran.stderr, /^hint: Start the server with "raphael server serve --port 2"/m);
  });

  it('points at its own help when a body on standard input is refused', async () => {
    // `readStdin` hard-coded "create" while create was its only caller. Update is the second, and an
    // accurate refusal followed by "Run \"raphael create --help\"" sends the person to the wrong page.
    const ran = await runProcess(
      ['update', '/work/update-from-stdin', '--body', '@-', '--revision', '1'],
      { stdin: 'x'.repeat(1_048_577) },
    );
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /larger than the 1048576-byte request limit/);
    assert.match(ran.stderr, /^hint: Run "raphael update --help" for usage\.$/m);
  });

  it('documents the revision rule in its help', async () => {
    const ran = await run(['update', '--help']);
    assert.equal(ran.code, 0);
    assert.match(wrapped(ran.stdout), /A body replacement requires the revision you read\./);
    assert.match(
      wrapped(ran.stdout),
      /Other changes may read and pin the current id and revision for you\./,
    );
  });

  /**
   * Marking a project as being worked on.
   *
   * Two ordinary change flags on the operation that already exists, not a command of their own: the
   * story asks for parity of the core *operation*, not of interactions.
   */

  const seedProject = async (slug: string): Promise<any> => {
    const ran = await run(['create', 'project', `/work/${slug}`, '--title', 'Original', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    return jsonOf(ran).entity;
  };

  it('marks a project active and inactive by path, pinning the revision it read', async () => {
    const created = await seedProject('selection-by-path');
    assert.equal(created.active, false, 'a project is created inactive');

    // No --revision. The existing pre-read pins the target by identifier, exactly as it does for a
    // title change, so a slug freed and reoccupied in between cannot land this on another entity.
    const activated = await run(['update', '/work/selection-by-path', '--active', '--json']);
    assert.equal(activated.code, 0, activated.stderr);
    assert.equal(jsonOf(activated).entity.active, true);
    assert.equal(jsonOf(activated).entity.revision, created.revision + 1);

    const deactivated = await run(['update', '/work/selection-by-path', '--inactive', '--json']);
    assert.equal(deactivated.code, 0, deactivated.stderr);
    assert.equal(jsonOf(deactivated).entity.active, false);

    // And the field survives the shared response contract rather than merely resembling it.
    const decoded = decodeUpdateResponse(jsonOf(deactivated));
    assert.equal(Either.isRight(decoded), true);
  });

  it('marks a project active by --id against an explicit revision', async () => {
    const created = await seedProject('selection-by-id');
    const ran = await run([
      'update',
      '--id',
      String(created.id),
      '--active',
      '--revision',
      String(created.revision),
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(jsonOf(ran).entity.active, true);
  });

  it('counts the selection flags as a change on their own', async () => {
    const ran = await run(['update', '/work/anything', '--active', '--help']);
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /--active\s+Mark the project active\./);
    assert.match(ran.stdout, /--inactive\s+Mark the project inactive\./);

    // The refusal for an empty update now names them, so someone reading it knows they are changes.
    const nothing = await run(['update', '/work/anything']);
    assert.equal(nothing.code, 2);
    assert.match(nothing.stderr, /--active, --inactive/);
  });

  it('refuses both selection flags together before it issues any request', async () => {
    // Pointed at a port nothing listens on: a usage error here proves the refusal was decided from
    // flag presence alone, because a dispatched request - including the revision pre-read - would
    // have failed as a transport error with exit 1 instead.
    const ran = await run(['update', '/work/anything', '--active', '--inactive'], {
      env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:2' },
    });
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /Give --active or --inactive, not both\./);
    assert.match(ran.stderr, /^hint: Run "raphael update --help" for usage\.$/m);
    assert.equal(ran.stderr.includes('Could not connect'), false);
  });

  it('refuses to mark anything but a project, and says why', async () => {
    const note = await seedNote('selection-on-a-note');
    // Both flags, because the rule is on presence: the caller's mistake is a field that does not apply
    // to this target, so `--inactive` is refused exactly as `--active` is. And both targets, because
    // `/work` is a root area and the note is a resource - they travel different paths through target
    // resolution before either one reaches the refusal, so this pins that the CLI arrives at it the
    // same way for a container and a non-container alike.
    for (const path of ['/work', '/work/selection-on-a-note']) {
      for (const flag of ['--active', '--inactive']) {
        const ran = await run(['update', path, flag]);
        assert.equal(ran.code, 2, ran.stderr);
        assert.match(ran.stderr, /^code: invalid_input \(400\)$/m);
        assert.match(
          ran.stderr,
          new RegExp(`^Only a project can be active, and ${path} is not a project\\.$`, 'm'),
        );
        assert.match(ran.stderr, /^Nothing was changed\.$/m);
      }
    }
    // Nothing was written by any of the four attempts. Asserted on the note, whose revision this test
    // knows; the seeded area is shared with the rest of the suite and has no revision to pin here.
    assert.equal((await entityAt('/work/selection-on-a-note')).revision, note.revision);
  });

  it('reports a stale selection as a revision conflict, with the revision to re-read', async () => {
    const created = await seedProject('selection-stale');
    await run(['update', '/work/selection-stale', '--active', '--json']);

    const ran = await run([
      'update',
      '/work/selection-stale',
      '--inactive',
      '--revision',
      String(created.revision),
    ]);
    assert.equal(ran.code, 4);
    assert.match(ran.stderr, /^code: revision_conflict \(409\)$/m);
    assert.match(ran.stderr, new RegExp(`it is now at revision ${created.revision + 1}\\.$`, 'm'));
    // The stale write did not silently undo a decision it never saw.
    assert.equal((await entityAt('/work/selection-stale')).active, true);
  });

  it('shows the selection in get and list, and only where it means something', async () => {
    const created = await seedProject('selection-shown');
    await run(['update', '/work/selection-shown', '--active']);

    const shown = await run(['get', '/work/selection-shown']);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^ {2}active: +yes$/m);

    await run(['update', '/work/selection-shown', '--inactive']);
    assert.match((await run(['get', '/work/selection-shown'])).stdout, /^ {2}active: +no$/m);

    // An area is never active: the field is there, and says it does not apply rather than "no".
    assert.match((await run(['get', '/work'])).stdout, /^ {2}active: +-$/m);

    // A listing marks the selected row and leaves every other row exactly as it was.
    await run(['update', '/work/selection-shown', '--active']);
    const listed = await run(['list', '/work']);
    const rows = listed.stdout.split('\n').filter((line) => line.includes('selection-shown'));
    assert.equal(rows.length, 1);
    // The state is its own column before the free text, so a title or slug cannot imitate it.
    assert.match(rows[0] ?? '', / {2}active {2}\/work\/selection-shown +Original$/);

    // --json is unchanged in shape and simply carries the field, so it is the independent statement
    // of which rows are selected that the marker can be checked against.
    const json = jsonOf(await run(['list', '/work', '--json']));
    assert.equal(
      json.items.every((row: { active: unknown }) => typeof row.active === 'boolean'),
      true,
      'every row carries the field, never only the selected ones',
    );
    const selected = json.items
      .filter((row: { active: boolean }) => row.active)
      .map((row: { path: string }) => row.path)
      .sort();
    const marked = listed.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[2] === 'active')
      .map((columns) => columns[3])
      .sort();
    assert.ok(selected.includes('/work/selection-shown'));
    assert.deepEqual(marked, selected, 'exactly the selected rows are marked, and no others');

    // An inactive row says so in the same column, with the fixed word for "nothing to mark".
    const plain = listed.stdout.split('\n').find((line) => line.includes('selection-by-path'));
    assert.match(plain ?? '', / {2}- +\/work\/selection-by-path +Original$/);
    assert.equal(jsonOf(await run(['get', '/work', '--json'])).entity.active, false);
    assert.equal(created.active, false);
  });
});

describe('search', () => {
  /**
   * One fixture area, used by every case below.
   *
   * Scoped to itself rather than to the root, because the other suites in this file seed notes into
   * `/work` and the root, and a search assertion that counted rows from them would depend on test
   * order. `/searching/deep` is a nested container, which is what lets a two-scope request be asked
   * about a parent and its own child at once.
   */
  before(async () => {
    assert.equal((await run(['create', 'area', '/searching', '--title', 'Searching'])).code, 0);
    assert.equal((await run(['create', 'project', '/searching/deep', '--title', 'Deep'])).code, 0);
    const notes: readonly (readonly [string, string, string])[] = [
      ['/searching/tokens', 'Auth tokens', 'Rotating the signing key'],
      ['/searching/deep/flow', 'Login flow', 'The retry path after a refused token'],
      ['/searching/unrelated', 'Kitchen inventory', 'Nothing to do with sessions'],
    ];
    for (const [path, title, body] of notes) {
      const made = await run(['create', 'resource.note', path, '--title', title, '--body', body]);
      assert.equal(made.code, 0, path);
    }
  });

  it('searches descendants by default and restricts --direct to immediate children', async () => {
    const recursive = await run(['search', '/searching', '-q', 'login', '--json']);
    assert.equal(recursive.code, 0, recursive.stderr);
    assert.deepEqual(
      jsonOf(recursive).items.map((hit: { node: { slug: string } }) => hit.node.slug),
      ['flow'],
    );

    const direct = await run(['search', '/searching', '--direct', '-q', 'login', '--json']);
    assert.equal(direct.code, 0, direct.stderr);
    assert.deepEqual(jsonOf(direct).items, []);

    const removed = await run(['search', '/searching', '-r', '-q', 'login']);
    assert.equal(removed.code, 2);
    assert.match(
      removed.stderr,
      /^search does not take -r: it includes descendants by default\.\nhint: Remove -r, or use --direct/m,
    );
  });

  it('finds a note by its text, and prints the title beside the slug', async () => {
    const ran = await run(['search', '/searching', '-q', 'auth tokens']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /resource\.note {2}- {2}\/searching\/tokens {2}Auth tokens$/m);
    assert.match(ran.stderr, /^Showing 1(-\d+)?\. No more\.$/m);

    // The same request as JSON is the independent statement of what was found, so the text form is
    // checked against it rather than against a hand-written expectation.
    const json = await run(['search', '/searching', '-q', 'auth tokens', '--json']);
    assert.equal(json.code, 0, json.stderr);
    const page = jsonOf(json);
    assert.equal(Array.isArray(page.items), true);
    assert.equal(page.ok, true);
    assert.equal(page.command, 'search');
    assert.equal(page.page.skip, 0);
    assert.equal(typeof page.page.hasMore, 'boolean');
    assert.equal(typeof page.page.archivedLeftOut, 'boolean');
    // A hit is a wrapper around the summary, not the summary itself.
    assert.ok(page.items.every((hit: { node: unknown }) => typeof hit.node === 'object'));
    const slugs = page.items.map((hit: { node: { slug: string } }) => hit.node.slug);
    assert.ok(slugs.includes('tokens'));
    assert.equal(slugs.includes('unrelated'), false);
  });

  it('searches the body, not only the title', async () => {
    const ran = await run(['search', '/searching', '-q', 'rotating', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(
      jsonOf(ran).items.map((hit: { node: { slug: string } }) => hit.node.slug),
      ['tokens'],
    );
  });

  it('takes a quoted phrase and an uppercase AND as the grammar describes', async () => {
    const phrase = await run(['search', '/searching', '-q', '"login flow"', '--json']);
    assert.equal(phrase.code, 0, phrase.stderr);
    assert.deepEqual(
      jsonOf(phrase).items.map((hit: { node: { slug: string } }) => hit.node.slug),
      ['flow'],
    );

    // AND narrows: both words are in the one note, and no other note has both.
    const narrowed = await run(['search', '/searching', '-q', 'login AND retry', '--json']);
    assert.equal(narrowed.code, 0, narrowed.stderr);
    assert.deepEqual(
      jsonOf(narrowed).items.map((hit: { node: { slug: string } }) => hit.node.slug),
      ['flow'],
    );

    // Whitespace is OR, so the same two words unnarrowed reach more than the one note.
    const widened = await run(['search', '/searching', '-q', 'login kitchen', '--json']);
    assert.equal(widened.code, 0, widened.stderr);
    const slugs = jsonOf(widened).items.map((hit: { node: { slug: string } }) => hit.node.slug);
    assert.ok(slugs.includes('flow'));
    assert.ok(slugs.includes('unrelated'));
  });

  it('takes a filter inline and from a file, and applies it to the hits', async () => {
    const inline = await run([
      'search',
      '/searching',
      '-q',
      'login kitchen deep',
      '--filter',
      '{"type":"resource"}',
      '--json',
    ]);
    assert.equal(inline.code, 0, inline.stderr);
    const inlineItems = jsonOf(inline).items as { node: { type: string } }[];
    assert.ok(inlineItems.length > 0);
    for (const hit of inlineItems) assert.equal(hit.node.type, 'resource');

    const directory = temporary('raphael-cli-filter-');
    const file = join(directory, 'filter.json');
    writeFileSync(file, '{"type":{"$in":["project"]}}');
    const fromFile = await run([
      'search',
      '/searching',
      '-q',
      'deep',
      '--filter',
      `@${file}`,
      '--json',
    ]);
    assert.equal(fromFile.code, 0, fromFile.stderr);
    const fileItems = jsonOf(fromFile).items as { node: { type: string; slug: string } }[];
    assert.deepEqual(
      fileItems.map((hit) => hit.node.slug),
      ['deep'],
    );
    for (const hit of fileItems) assert.equal(hit.node.type, 'project');
  });

  it('takes two scopes at once and returns a shared descendant exactly once', async () => {
    // `/searching` recursively already contains `/searching/deep`, so naming both is a union with an
    // overlap. Deduplication happens in the page query; a client-side merge would either repeat the
    // row or cut a page that had already been made wrong.
    const ran = await run(['search', '/searching', '/searching/deep', '-q', 'login', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    const ids = (jsonOf(ran).items as { node: { id: number } }[]).map((hit) => hit.node.id);
    assert.deepEqual(ids, [...new Set(ids)], 'no row appears twice');
    const slugs = (jsonOf(ran).items as { node: { slug: string } }[]).map((hit) => hit.node.slug);
    assert.deepEqual(
      slugs.filter((slug) => slug === 'flow'),
      ['flow'],
    );
  });

  it('marks an active project among its hits, exactly as a listing does', async () => {
    await run(['update', '/searching/deep', '--active']);
    const ran = await run(['search', '/searching', '-q', 'deep']);
    assert.equal(ran.code, 0, ran.stderr);
    const row = ran.stdout.split('\n').find((line) => line.includes('/searching/deep  '));
    assert.match(row ?? '', /project +active {2}\/searching\/deep {2}Deep$/);
    await run(['update', '/searching/deep', '--inactive']);
  });

  it('asks each repeated -q of the same scopes', async () => {
    // The help says so, so the suite has to hold it. Iterating and passing every value through
    // unchanged is the one thing about repetition the CLI owns; a build that sent only the first or
    // only the last would still type-check.
    const both = await run(['search', '/searching', '-q', 'login', '-q', 'kitchen', '--json']);
    assert.equal(both.code, 0, both.stderr);
    const slugs = (jsonOf(both).items as { node: { slug: string } }[]).map((hit) => hit.node.slug);
    assert.ok(slugs.includes('flow'), 'the first query was asked');
    assert.ok(slugs.includes('unrelated'), 'the second query was asked');

    // Each alone reaches only its own note, which is what makes the pair above a union rather than a
    // coincidence of one broad query.
    const first = await run(['search', '/searching', '-q', 'login', '--json']);
    assert.deepEqual(
      (jsonOf(first).items as { node: { slug: string } }[]).map((hit) => hit.node.slug),
      ['flow'],
    );
    const second = await run(['search', '/searching', '-q', 'kitchen', '--json']);
    assert.deepEqual(
      (jsonOf(second).items as { node: { slug: string } }[]).map((hit) => hit.node.slug),
      ['unrelated'],
    );
  });

  it('names the path and the reason when a path is invalid', async () => {
    // The decoder would answer for a union of two selector shapes here, telling someone who forgot
    // the leading slash that an `id` was expected. The contract's own path helper is asked first, so
    // the sentence is about the mistake that was actually made.
    const relative = await run(['search', 'work', '-q', 'x']);
    assert.equal(relative.code, 2);
    assert.match(relative.stderr, /^path: A path must start with "\/"\.$/m);
    assert.equal(relative.stderr.includes('expected: "id"'), false);

    for (const [path, expected] of [
      ['/work/', /A path must not end with "\/"/],
      ['/work//deep', /A path must not contain an empty segment at segment 2/],
      [
        '/Work',
        /A path segment must follow the slug grammar at segment 1: NFC lowercase Unicode letter or number tokens joined by single hyphens;/,
      ],
    ] as const) {
      const ran = await run(['search', path, '-q', 'x']);
      assert.equal(ran.code, 2, path);
      assert.match(ran.stderr, expected, path);
      assert.match(ran.stderr, /^path: /m, path);
    }

    // The same check, on the same helper, for the other command that takes scopes.
    const listed = await run(['list', 'work']);
    assert.equal(listed.code, 2);
    assert.match(listed.stderr, /^path: A path must start with "\/"\.$/m);

    // The root is a valid scope and must survive the check that refuses the others.
    const root = await run(['search', '/', '-q', 'auth', '--json']);
    assert.equal(root.code, 0, root.stderr);
  });

  it('refuses a malformed query locally, in the contract’s own words', async () => {
    for (const query of ['a AND', '"unclosed', '""', '   ']) {
      const ran = await run(['search', '/searching', '-q', query]);
      assert.equal(ran.code, 2, query);
      assert.match(ran.stderr, /^-q: /m, query);
      // Fixed text per reason: the submitted query is never echoed back into the message.
      assert.equal(ran.stderr.includes(`-q: ${query}`), false, query);
    }
  });

  it('requires at least one query and at least one scope', async () => {
    const noQuery = await run(['search', '/searching']);
    assert.equal(noQuery.code, 2);
    assert.match(noQuery.stderr, /Give at least one -q query\./);

    const noScope = await run(['search', '-q', 'auth']);
    assert.equal(noScope.code, 2);
    assert.match(noScope.stderr, /Give at least one path, or --id\./);

    const noScopeList = await run(['list']);
    assert.equal(noScopeList.code, 2);
    assert.match(noScopeList.stderr, /Give at least one path, or --id\./);
  });

  it('refuses an unsupported filter key locally rather than sending it stripped', async () => {
    // The key is outside the three this filter owns. A local decode against the schema would have
    // *ignored* it and sent an empty filter, answering a wider question than the one asked; the
    // contract's own inspector is what refuses it.
    const ran = await run(['search', '/searching', '-q', 'auth', '--filter', '{"metadata.x":1}']);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /--filter: A filter may only use type, kind, tags/);

    for (const filter of ['[]', '"nope"', '{"type":{"$nin":["area"]}}', 'not json']) {
      const bad = await run(['search', '/searching', '-q', 'auth', '--filter', filter]);
      assert.equal(bad.code, 2, filter);
      assert.match(bad.stderr, /--filter/, filter);
    }

    // An empty filter is no restriction, the same as omitting the flag. There is nothing to refuse
    // about asking for everything.
    const empty = await run(['search', '/searching', '-q', 'auth', '--filter', '{}', '--json']);
    assert.equal(empty.code, 0, empty.stderr);
    assert.ok((jsonOf(empty).items as unknown[]).length > 0);
  });

  it('names the position of a scope that cannot be resolved', async () => {
    const ran = await run(['search', '--id', '9', '/missing', '-q', 'x']);
    assert.equal(ran.code, 3, ran.stderr);
    assert.match(ran.stderr, /^code: node_not_found \(404\)$/m);
    // Paths are sent before ids, and the server names the position it received; the CLI maps that
    // back to what was typed, however the flags were ordered.
    assert.match(ran.stderr, /^Nothing exists at \/missing\.$/m);
  });

  it('refuses --order-by rather than accepting an order it cannot honour', async () => {
    const ran = await run(['search', '/searching', '-q', 'auth', '--order-by', 'slug:asc']);
    assert.equal(ran.code, 2);
  });

  it('documents the grammar and the repeatable query in its help', async () => {
    const ran = await run(['search', '--help']);
    assert.equal(ran.code, 0);
    const text = wrapped(ran.stdout);
    assert.match(
      text,
      /Words separated by spaces mean OR; uppercase AND binds more tightly than uppercase OR\. .*Words joined by punctuation, such as auth-token or auth\.token, must appear together and in that order, like a phrase\./,
    );
    assert.match(text, /Double quotes make a phrase\./);
    assert.match(text, /Repeat -q to OR queries together/);
    assert.match(
      text,
      /-q, --query <text>\s+Text to search\. At least one required\. Repeatable\./,
    );
    assert.match(text, /At most \d+ paths or ids may be searched or listed in one request\./);

    const root = await run(['--help']);
    assert.match(root.stdout, /^ {2}search +Search all descendants by text\.$/m);
  });
});

describe('moving', () => {
  const created = async (args: readonly string[]): Promise<any> => {
    const ran = await run([...args, '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    return jsonOf(ran).entity;
  };
  const seedArea = (path: string): Promise<any> =>
    created(['create', 'area', path, '--title', 'Area']);
  const seedProject = (path: string): Promise<any> =>
    created(['create', 'project', path, '--title', 'Project']);
  const seedNote = (path: string): Promise<any> =>
    created(['create', 'resource.note', path, '--title', 'Moving note', '--body', '# Kept\n']);

  const entityAt = async (path: string): Promise<any> =>
    jsonOf(await run(['get', path, '--json'])).entity;

  it('moves into an existing container and keeps the slug', async () => {
    const note = await seedNote('/work/move-keep');

    const ran = await run(['move', '/work/move-keep', '/personal']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(
      ran.stdout,
      [
        `Moved resource.note ${note.id}: Moving note`,
        '  path:     /personal/move-keep',
        '  was:      /work/move-keep',
        `  revision: ${note.revision + 1}`,
        '',
      ].join('\n'),
    );

    // Same identifier, same body, reachable only at the new address.
    const moved = await entityAt('/personal/move-keep');
    assert.equal(moved.id, note.id);
    assert.deepEqual(moved.body, note.body);
    const old = await run(['get', '/work/move-keep']);
    assert.equal(old.code, 3);
    assert.match(old.stderr, /node_not_found/);
  });

  it('takes an absent last segment as the new slug under an existing parent', async () => {
    const note = await seedNote('/work/move-rename');
    const ran = await run(['move', '/work/move-rename', '/personal/move-renamed']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /\n {2}path: +\/personal\/move-renamed\n/);

    const path = await run(['path', '--id', String(note.id)]);
    assert.equal(path.stdout.trim(), '/personal/move-renamed');
    assert.equal((await run(['get', '/work/move-rename'])).code, 3);
  });

  it('carries a moved container’s descendants with it', async () => {
    const outer = await seedArea('/work/move-outer');
    const note = await seedNote('/work/move-outer/inside');
    const ran = await run(['move', '/work/move-outer', '/personal']);
    assert.equal(ran.code, 0, ran.stderr);

    const inside = await entityAt('/personal/move-outer/inside');
    assert.equal(inside.id, note.id);
    assert.equal(inside.parentId, outer.id);
    assert.equal(inside.revision, note.revision);
  });

  it('moves by --id against an explicit revision, and prints the response as JSON', async () => {
    const note = await seedNote('/work/move-by-id');
    const ran = await run([
      'move',
      '--id',
      String(note.id),
      '/personal',
      '--revision',
      String(note.revision),
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    const decoded = decodeMoveResponse(jsonOf(ran));
    assert.equal(Either.isRight(decoded), true);
    if (Either.isRight(decoded)) {
      assert.equal(decoded.right.node.id, note.id);
      assert.equal(decoded.right.node.slug, 'move-by-id');
      assert.equal(decoded.right.node.revision, note.revision + 1);
    }
  });

  it('reads the current revision for itself when none is given', async () => {
    const note = await seedNote('/work/move-pinned');
    // Advance the revision first, so a move that did not read it would be stale.
    const updated = await run(['update', '/work/move-pinned', '--title', 'Renamed', '--json']);
    assert.equal(updated.code, 0, updated.stderr);

    const ran = await run(['move', '/work/move-pinned', '/personal', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(jsonOf(ran).node.revision, note.revision + 2);
  });

  it('refuses a stale revision, moves nothing, and names the revision to re-read', async () => {
    const note = await seedNote('/work/move-stale');
    await run(['update', '/work/move-stale', '--title', 'Newer']);

    const ran = await run(['move', '/work/move-stale', '/personal', '--revision', '1']);
    assert.equal(ran.code, 4);
    assert.match(ran.stderr, /^code: revision_conflict \(409\)$/m);
    assert.match(ran.stderr, new RegExp(`it is now at revision ${note.revision + 1}\\.$`, 'm'));
    assert.match(ran.stderr, /^Nothing was changed\.$/m);
    assert.equal((await entityAt('/work/move-stale')).id, note.id);
  });

  it('reports a move to where it already is as unchanged, at the same revision', async () => {
    const note = await seedNote('/work/move-noop');
    const ran = await run(['move', '/work/move-noop', '/work']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, new RegExp(`^Unchanged resource.note ${note.id}: Moving note\\n`));
    assert.match(ran.stdout, new RegExp(`\\n {2}revision: ${note.revision}\\n`));
    assert.equal(ran.stderr, 'Nothing changed: it is already at /work/move-noop.\n');
    const json = jsonOf(await run(['move', '/work/move-noop', '/work', '--json']));
    assert.deepEqual(
      [json.changed, json.previousPath, json.node.path],
      [false, '/work/move-noop', '/work/move-noop'],
    );
  });

  it('reports a move to its own full path as unchanged, for a note, a project and an area', async () => {
    const note = await seedNote('/work/move-self-note');
    const project = await seedProject('/work/move-self-project');
    const area = await seedArea('/move-self-area');
    for (const [item, path, type] of [
      [note, '/work/move-self-note', 'resource.note'],
      [project, '/work/move-self-project', 'project'],
      [area, '/move-self-area', 'area'],
    ] as const) {
      const ran = await run(['move', path, path]);
      assert.equal(ran.code, 0, ran.stderr);
      assert.match(ran.stdout, new RegExp(`^Unchanged ${type} ${item.id}: `), path);
      assert.equal(ran.stderr, `Nothing changed: it is already at ${path}.\n`);
      // A retry by id, as after an answer that never arrived, confirms instead of conflicting.
      const json = jsonOf(await run(['move', '--id', String(item.id), path, '--json']));
      assert.deepEqual([json.changed, json.node.revision], [false, item.revision], path);
    }
  });

  it('moves an area to the top level', async () => {
    await seedArea('/work/move-to-top');
    const ran = await run(['move', '/work/move-to-top', '/']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /\n {2}path: +\/move-to-top\n {2}was: +\/work\/move-to-top\n/);
    assert.equal((await run(['path', '/move-to-top'])).stdout.trim(), '/move-to-top');
  });

  it('refuses anything but an area at the top level, as a parentage problem', async () => {
    await seedProject('/work/move-project-top');
    const ran = await run(['move', '/work/move-project-top', '/']);
    assert.equal(ran.code, 4);
    assert.match(ran.stderr, /^code: invalid_parent \(422\)$/m);
    assert.match(
      ran.stderr,
      /^\/work\/move-project-top cannot move to \/: only areas can be at the top level\. A project can go inside an area\.$/m,
    );
  });

  it('refuses a destination held by a note, and never overwrites it', async () => {
    const mover = await seedNote('/work/move-collide-a');
    const holder = await seedNote('/work/move-collide-b');
    const ran = await run(['move', '/work/move-collide-a', '/work/move-collide-b']);
    assert.equal(ran.code, 4);
    assert.match(ran.stderr, /^code: slug_conflict \(409\)$/m);
    assert.match(
      ran.stderr,
      new RegExp(`^/work/move-collide-b is already taken by note ${holder.id}\\.$`, 'm'),
    );
    assert.equal((await entityAt('/work/move-collide-a')).id, mover.id);
    assert.equal((await entityAt('/work/move-collide-b')).id, holder.id);
  });

  it('refuses a container moved inside itself as a cycle', async () => {
    await seedArea('/work/move-cycle');
    await seedArea('/work/move-cycle/child');
    const ran = await run(['move', '/work/move-cycle', '/work/move-cycle/child']);
    assert.equal(ran.code, 4);
    assert.match(ran.stderr, /^code: invalid_parent \(422\)$/m);
    assert.match(
      ran.stderr,
      /^\/work\/move-cycle cannot move into \/work\/move-cycle\/child, which is inside it\.$/m,
    );
    assert.equal((await run(['path', '/work/move-cycle/child'])).code, 0);
  });

  it('refuses malformed, missing and extra arguments before anything is sent', async () => {
    // Pointed at a closed port: a usage error must be decided before any request is attempted.
    const env = { RAPHAEL_ENDPOINT: 'http://127.0.0.1:2' };
    const cases: readonly [readonly string[], RegExp][] = [
      [['move'], /Give a path, or --id\./],
      [['move', '/work/x'], /Give a destination/],
      [['move', '--id', '5'], /Give a destination/],
      [['move', '/work/x', 'personal'], /^destination: A path must start with "\/"\.$/m],
      [['move', '/work/x', '/personal/'], /^destination: A path must not end with "\/"\.$/m],
      [
        ['move', '/work/x', '/a', '/b'],
        /move takes one source and one destination, or --id and one destination\./,
      ],
      // With --id the one positional is the destination, so a second one is extra, not a source.
      [
        ['move', '--id', '5', '/a', '/b'],
        /move takes one source and one destination, or --id and one destination\./,
      ],
      [['move', '/work/x', '/a', '--revision', '0'], /--revision/],
    ];
    for (const [args, message] of cases) {
      const ran = await run(args, { env });
      assert.equal(ran.code, 2, args.join(' '));
      assert.match(ran.stderr, message, args.join(' '));
      // A path that only lacks its leading or trailing slash is answered with the path it meant.
      assert.match(
        ran.stderr,
        /raphael move --help|^hint: (?:Try "\/personal"\.|Did you mean "raphael move \/work\/x \/personal"\?)$/m,
        args.join(' '),
      );
    }
  });

  it('says the move was not sent when the revision could not be read', async () => {
    const ran = await run(['move', '/work/anything', '/personal'], {
      env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:2' },
    });
    assert.equal(ran.code, 6);
    assert.match(ran.stderr, /^The change was not sent\.$/m);
    assert.equal(ran.stderr.includes('may or may not'), false);
  });
});

describe('archiving and restoring', () => {
  const created = async (args: readonly string[]): Promise<any> => {
    const ran = await run([...args, '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    return jsonOf(ran).entity;
  };
  const entityAt = async (path: string): Promise<any> =>
    jsonOf(await run(['get', path, '--json'])).entity;

  it('archives by path, pinning the revision it read, and restores by --id against an explicit one', async () => {
    const project = await created(['create', 'project', '/work/arch-basic', '--title', 'Basic']);

    const archived = await run(['archive', '/work/arch-basic']);
    assert.equal(archived.code, 0, archived.stderr);
    assert.equal(
      archived.stdout,
      [
        `Archived project ${project.id}: Basic`,
        '  path:     /work/arch-basic',
        `  revision: ${project.revision + 1}`,
        '  archived: yes',
        '    directly (user)',
        '',
      ].join('\n'),
    );

    const restored = await run([
      'restore',
      '--id',
      String(project.id),
      '--revision',
      String(project.revision + 1),
    ]);
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(
      restored.stdout,
      [
        `Restored project ${project.id}: Basic`,
        '  path:     /work/arch-basic',
        `  revision: ${project.revision + 2}`,
        '  archived: no',
        '',
      ].join('\n'),
    );
  });

  it('says "Still archived" when a container above keeps it archived, and prints the response as JSON', async () => {
    const shelf = await created(['create', 'area', '/work/arch-shelf', '--title', 'Shelf']);
    const note = await created([
      'create',
      'resource.note',
      '/work/arch-shelf/kept',
      '--title',
      'Kept',
    ]);
    assert.equal((await run(['archive', '/work/arch-shelf/kept'])).code, 0);
    assert.equal((await run(['archive', '/work/arch-shelf'])).code, 0);

    const still = await run(['restore', '/work/arch-shelf/kept']);
    assert.equal(still.code, 0, still.stderr);
    assert.equal(
      still.stdout,
      [
        `Still archived resource.note ${note.id}: Kept`,
        '  path:     /work/arch-shelf/kept',
        `  revision: ${note.revision + 2}`,
        '  archived: yes',
        `    through area ${shelf.id} "Shelf" (user)`,
        '',
      ].join('\n'),
    );
    // The next step is not a result, so it is on stderr: restore the container that holds it.
    assert.equal(
      still.stderr,
      `It is archived through area ${shelf.id}.\nhint: Run "raphael restore --id ${shelf.id}" to restore that area.\n`,
    );

    const json = await run(['restore', '--id', String(shelf.id), '--json']);
    assert.equal(json.code, 0, json.stderr);
    const decoded = decodeLifecycleResponse(jsonOf(json));
    assert.equal(Either.isRight(decoded), true);
    if (Either.isRight(decoded)) {
      assert.equal(decoded.right.node.archived, false);
      assert.deepEqual(decoded.right.archiveCauses, []);
    }
  });

  it('prints the archive causes in get only when something is archived', async () => {
    const shelf = await created(['create', 'area', '/work/arch-get', '--title', 'Shelf']);
    await created(['create', 'project', '/work/arch-get/inner', '--title', 'Inner']);

    // Always the field, so an active item says so rather than leaving it to be inferred.
    const active = await run(['get', '/work/arch-get/inner']);
    assert.match(active.stdout, /\n {2}archived: +no\n {2}favorite:/);

    assert.equal((await run(['archive', '/work/arch-get'])).code, 0);
    const inherited = await run(['get', '/work/arch-get/inner']);
    assert.match(
      inherited.stdout,
      /\n {2}active: +no\n {2}archived: +yes\n {4}through area \d+ "Shelf" \(user\)\n/,
    );
    assert.equal(inherited.stdout.includes(`area ${shelf.id}`), true);
  });

  it('hides archived things from list and search unless asked, and marks them when shown', async () => {
    await created(['create', 'area', '/work/arch-list', '--title', 'Listing']);
    await created(['create', 'project', '/work/arch-list/zephyr', '--title', 'Zephyr one']);
    await created(['create', 'project', '/work/arch-list/breeze', '--title', 'Zephyr two']);
    assert.equal((await run(['archive', '/work/arch-list/zephyr'])).code, 0);

    const hidden = await run(['list', '/work/arch-list']);
    assert.equal(hidden.stdout.includes('zephyr'), false);
    assert.match(hidden.stdout, /\/breeze {2}Zephyr two\n/);
    // Left out, and said so, with the command that shows them.
    assert.match(
      hidden.stderr,
      /^Archived items were left out\.\nhint: Run "raphael list \/work\/arch-list --include-archived" to include them\.$/m,
    );

    const shown = await run(['list', '/work/arch-list', '--include-archived']);
    assert.match(shown.stdout, / {2}archived {2}\/work\/arch-list\/zephyr {2}Zephyr one\n/);
    assert.match(shown.stdout, /\/breeze {2}Zephyr two\n/);

    const searched = await run(['search', '/work/arch-list', '-q', 'zephyr']);
    assert.equal(searched.stdout.includes('Zephyr one'), false);
    const included = await run(['search', '/work/arch-list', '-q', 'zephyr', '--include-archived']);
    assert.match(included.stdout, / {2}archived {2}\/work\/arch-list\/zephyr {2}Zephyr one\n/);
  });

  it('explains each refusal of something archived by what is archived and how', async () => {
    await created(['create', 'area', '/work/arch-refuse', '--title', 'Refuse']);
    await created(['create', 'project', '/work/arch-refuse/inner', '--title', 'Inner']);
    const direct = await created(['create', 'project', '/work/arch-direct', '--title', 'Direct']);
    assert.equal((await run(['archive', '/work/arch-refuse'])).code, 0);
    assert.equal((await run(['archive', '/work/arch-direct'])).code, 0);

    const refuse = await entityAt('/work/arch-refuse');
    const onDirect = await run(['update', '--id', String(direct.id), '--title', 'X']);
    assert.equal(onDirect.code, 4);
    assert.match(onDirect.stderr, /^code: node_archived \(409\)$/m);
    assert.match(
      onDirect.stderr,
      new RegExp(`^--id ${direct.id} is archived, so it cannot be changed\\.$`, 'm'),
    );
    assert.match(
      onDirect.stderr,
      new RegExp(`^hint: Run "raphael restore --id ${direct.id}" first`, 'm'),
    );

    const onInherited = await run(['update', '/work/arch-refuse/inner', '--active']);
    assert.equal(onInherited.code, 4);
    assert.match(
      onInherited.stderr,
      new RegExp(
        `^/work/arch-refuse/inner is inside archived area ${refuse.id}, so it cannot be changed\\.$`,
        'm',
      ),
    );
    assert.match(
      onInherited.stderr,
      new RegExp(`^hint: Run "raphael restore --id ${refuse.id}" first`, 'm'),
    );

    const underArchived = await run([
      'create',
      'resource.note',
      '/work/arch-refuse/inner/n',
      '--title',
      'N',
    ]);
    assert.equal(underArchived.code, 4);
    assert.match(
      underArchived.stderr,
      new RegExp(`^The parent /work/arch-refuse/inner is inside archived area ${refuse.id}`, 'm'),
    );

    const note = await created(['create', 'resource.note', '/work/arch-mover', '--title', 'M']);
    const toArchived = await run(['move', '--id', String(note.id), '/work/arch-refuse']);
    assert.equal(toArchived.code, 4);
    assert.match(
      toArchived.stderr,
      new RegExp(
        `^Area ${refuse.id} is archived, so nothing can move to /work/arch-refuse\\.$`,
        'm',
      ),
    );
    // A new path directly inside the archived area does not exist; the area is what is named.
    const toNewPath = await run(['move', '--id', String(note.id), '/work/arch-refuse/renamed']);
    assert.equal(toNewPath.code, 4);
    assert.match(
      toNewPath.stderr,
      new RegExp(
        `^Area ${refuse.id} is archived, so nothing can move to /work/arch-refuse/renamed\\.$`,
        'm',
      ),
    );
    assert.match(
      toNewPath.stderr,
      new RegExp(`^hint: Run "raphael restore --id ${refuse.id}" first`, 'm'),
    );

    // An inherited-only item moves out, and is active once it is somewhere active.
    const out = await run(['move', '/work/arch-refuse/inner', '/work/arch-rescued']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal((await entityAt('/work/arch-rescued')).archived, false);
  });

  it('says nothing was sent when the pre-read fails', async () => {
    for (const verb of ['archive', 'restore'] as const) {
      const unread = await run([verb, '/work/anything'], {
        env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:2' },
      });
      assert.equal(unread.code, 6);
      assert.match(unread.stderr, /^The change was not sent\.$/m);
    }
  });

  it('refuses the root and an extra argument locally', async () => {
    const root = await run(['archive', '/', '--revision', '1']);
    assert.equal(root.code, 2);
    const extra = await run(['restore', '/work/a', '/work/b']);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /restore takes one path, or --id\./);
  });
});

describe('favorites', () => {
  const created = async (args: readonly string[]): Promise<any> => {
    const ran = await run([...args, '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    return jsonOf(ran).entity;
  };
  /** The favorite field of `get`, with its padding collapsed: `favorite: yes`. */
  const favoriteLine = async (path: string): Promise<string | undefined> =>
    (await run(['get', path])).stdout
      .split('\n')
      .map((line) => line.trim().replace(/: +/, ': '))
      .find((line) => line.startsWith('favorite: '));
  const listedIds = async (): Promise<number[]> => {
    const ran = await run(['favorites', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    return jsonOf(ran).items.map((item: { id: number }) => item.id);
  };

  it('adds, shows, lists and removes a favorite, and repeating either is fine', async () => {
    const project = await created(['create', 'project', '/work/fav-basic', '--title', 'Basic']);
    assert.equal(await favoriteLine('/work/fav-basic'), 'favorite: no');

    for (const headline of ['Favorited', 'Unchanged']) {
      const added = await run(['favorite', '/work/fav-basic']);
      assert.equal(added.code, 0, added.stderr);
      assert.equal(
        added.stdout,
        `${headline} project ${project.id}: Basic\n  path:     /work/fav-basic\n  favorite: yes\n`,
      );
    }
    assert.equal(await favoriteLine('/work/fav-basic'), 'favorite: yes');

    const listed = await run(['favorites']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(
      listed.stdout,
      new RegExp(`^${project.id} +project +- +/work/fav-basic +Basic$`, 'm'),
    );
    assert.match(listed.stderr, /^Showing 1(-\d+)?\. No more\.\n$/);

    for (const headline of ['Unfavorited', 'Unchanged']) {
      const removed = await run(['unfavorite', '--id', String(project.id)]);
      assert.equal(removed.code, 0, removed.stderr);
      assert.equal(
        removed.stdout,
        `${headline} project ${project.id}: Basic\n  path:     /work/fav-basic\n  favorite: no\n`,
      );
    }
    const nothing = await run(['unfavorite', '--id', '999999']);
    assert.equal(nothing.code, 0, nothing.stderr);
    assert.equal(nothing.stdout, 'No item has id 999999, so nothing changed.\n');
    assert.equal(await favoriteLine('/work/fav-basic'), 'favorite: no');
    assert.equal((await listedIds()).includes(project.id), false);
  });

  it('prints the answer as JSON, and pages the list', async () => {
    const area = await created(['create', 'area', '/work/fav-json', '--title', 'Json']);
    const added = await run(['favorite', '--id', String(area.id), '--json']);
    assert.equal(added.code, 0, added.stderr);
    const answer = Either.getOrUndefined(decodeAddFavoriteResponse(jsonOf(added)));
    assert.deepEqual(
      [answer?.nodeId, answer?.isFavorite, answer?.changed, answer?.node.path],
      [area.id, true, true, '/work/fav-json'],
    );

    const page = await run(['favorites', '--limit', '1', '--skip', '0', '--json']);
    assert.equal(page.code, 0, page.stderr);
    // The page window travels under `page`; the items are exactly the contract's summaries.
    const envelope = jsonOf(page);
    const decoded = decodeListResponse({ items: envelope.items, ...envelope.page });
    assert.equal(Either.isRight(decoded), true);
    if (Either.isRight(decoded)) {
      assert.equal(decoded.right.limit, 1);
      assert.equal(
        decoded.right.items.every((item) => item.isFavorite),
        true,
      );
    }
    assert.equal((await run(['unfavorite', '--id', String(area.id)])).code, 0);
  });

  it("refuses a note with the server's reason", async () => {
    await created(['create', 'project', '/work/fav-note', '--title', 'Holder']);
    await created(['create', 'resource.note', '/work/fav-note/runbook', '--title', 'Runbook']);

    const refused = await run(['favorite', '/work/fav-note/runbook']);
    assert.equal(refused.code, 2);
    assert.match(
      refused.stderr,
      /^Only areas and projects can be favorites, and \/work\/fav-note\/runbook is neither\.$/m,
    );
    assert.equal(await favoriteLine('/work/fav-note/runbook'), 'favorite: no');
  });

  it('leaves an archived favorite out of the list while it stays a favorite', async () => {
    const shelf = await created(['create', 'area', '/work/fav-shelf', '--title', 'Shelf']);
    assert.equal((await run(['favorite', '/work/fav-shelf'])).code, 0);
    assert.equal((await listedIds()).includes(shelf.id), true);

    assert.equal((await run(['archive', '/work/fav-shelf'])).code, 0);
    assert.equal((await listedIds()).includes(shelf.id), false);
    assert.equal(await favoriteLine('/work/fav-shelf'), 'favorite: yes');

    assert.equal((await run(['restore', '/work/fav-shelf'])).code, 0);
    assert.equal((await listedIds()).includes(shelf.id), true);
    assert.equal((await run(['unfavorite', '/work/fav-shelf'])).code, 0);
  });

  it('refuses a bad window, the root, and extra arguments locally', async () => {
    const zero = await run(['favorites', '--limit', '0']);
    assert.equal(zero.code, 2);
    assert.equal((await run(['favorites', '--skip', '-1'])).code, 2);
    assert.equal((await run(['favorites', '/work'])).code, 2);
    assert.equal((await run(['favorite', '/'])).code, 2);
    const extra = await run(['unfavorite', '/work/a', '/work/b']);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /unfavorite takes one path, or --id\./);
  });
});

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ApiCredential, CONFIG_DEFAULTS, serve, silentLogger } from '@raphael/backend';
import { createTransport, type FetchLike, type Transport } from '@raphael/client';
import { update as updateDirect } from '@raphael/client/nodes';
import { PROTOCOL_VERSION } from '@raphael/contracts/connection';
import { decodeUpdateResponse } from '@raphael/contracts/nodes';
import { Effect, Either, Exit, Scope } from 'effect';

import { run as runCli } from '../src/main.ts';
import { runLogin } from '../src/modules/connection/login.ts';
import { buildFailureReport } from '../src/shared/report.ts';

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
const binary = join(packageRoot, 'dist', 'main.js');

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
            busyTimeoutMs: CONFIG_DEFAULTS.busyTimeoutMs,
          },
          idempotency: {
            gcIntervalMinutes: CONFIG_DEFAULTS.gcIntervalMinutes,
            gcBatchSize: CONFIG_DEFAULTS.gcBatchSize,
          },
        },
        credential: ApiCredential.fromKey(KEY),
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
  const code = await runCli(args, {
    streams: {
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    },
    environment: { RAPHAEL_ENDPOINT: endpoint, RAPHAEL_API_KEY: KEY, ...options.env },
    platform: process.platform,
    cwd: packageRoot,
    onSignal: () => {
      throw new Error('Remote commands must not register signal handlers');
    },
    exit: () => {
      throw new Error('Remote commands must return their exit code');
    },
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

  it('prints a path for an id', async () => {
    const work = jsonOf(await run(['get', '/work', '--json'])).entity;
    const ran = await run(['path', '--id', String(work.id)]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), '/work');
  });

  it('reports a missing entity as an operation failure, not a usage error', async () => {
    const ran = await run(['get', '/nope']);
    assert.equal(ran.code, 1);
    assert.equal(ran.stdout, '', 'nothing belongs on stdout when there is no result');
    assert.match(ran.stderr, /node_not_found/);
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
    assert.match(container.stderr, /--title is required/);

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
        '--format',
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
        '--format',
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
    assert.match(ran.stderr, /not valid JSON/);
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
    assert.match(missing.stderr, /Cannot read the body file/);

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
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /slug_conflict/);
    assert.match(ran.stderr, /duplicate/);
    // A definite rejection: nothing was created, so there is nothing to resolve and no key to keep.
    assert.equal(ran.stderr.includes('idempotency-key'), false);
    assert.equal(ran.stderr.includes('Could not confirm'), false);
  });

  it('refuses an area under a project, and says so as a parentage problem', async () => {
    await run(['create', 'project', '/work/host', '--title', 'Host']);
    const ran = await run(['create', 'area', '/work/host/nested', '--title', 'Nested']);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /invalid_parent/);
  });
});

describe('idempotency', () => {
  it('replays an identical request with the same key as the same entity', async () => {
    const key = 'fixed-key-for-replay-0001';
    const args = [
      'create',
      'project',
      '/work/replayed',
      '--title',
      'Replayed',
      '--idempotency-key',
      key,
      '--json',
    ];
    const first = jsonOf(await run(args));
    const second = jsonOf(await run(args));
    // A replay is a success reporting the entity that exists, not a distinct outcome.
    assert.deepEqual(first.entity, second.entity);
  });

  it('reports a conflict when the same key carries different input', async () => {
    const key = 'fixed-key-for-conflict-0001';
    await run(['create', 'project', '/work/conflict-a', '--title', 'A', '--idempotency-key', key]);
    const ran = await run([
      'create',
      'project',
      '/work/conflict-b',
      '--title',
      'B',
      '--idempotency-key',
      key,
    ]);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /idempotency_conflict/);
  });
});

describe('pagination', () => {
  it('never implies the page is everything', async () => {
    for (const index of [1, 2, 3]) {
      await run(['create', 'project', `/work/page-${index}`, '--title', `Page ${index}`]);
    }
    const ran = await run(['list', '/work', '--limit', '2']);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /skip 0, limit 2/);
    assert.match(ran.stdout, /More available: --skip 2/);
  });

  it('refuses a limit outside the contract rather than clamping it', async () => {
    for (const limit of ['0', '501', '2.5', 'ten']) {
      const ran = await run(['list', '/work', '--limit', limit]);
      assert.equal(ran.code, 2, `--limit ${limit}`);
    }
  });

  it('refuses an empty or repeated type filter rather than dropping entries', async () => {
    for (const types of ['area,', 'area,area', '']) {
      const ran = await run(['list', '/work', '--types', types]);
      assert.equal(ran.code, 2, `--types "${types}"`);
    }
  });

  it('filters by type', async () => {
    const ran = await run(['list', '/', '--types', 'area', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    for (const item of jsonOf(ran).items) assert.equal(item.type, 'area');
  });
});

describe('stream and exit discipline', () => {
  it('puts results on stdout and diagnostics on stderr', async () => {
    const ok = await runProcess(['get', '/work', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stderr, '');
    assert.ok(ok.stdout.length > 0);

    const bad = await runProcess(['get', '/nope', '--json']);
    assert.equal(bad.code, 1, bad.stderr);
    assert.equal(bad.stdout, '');
    assert.ok(bad.stderr.length > 0);
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
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /Set both, or unset both/);
  });

  it('refuses a wrong key as an operation failure', async () => {
    const ran = await run(['get', '/work'], { env: { RAPHAEL_API_KEY: 'b'.repeat(32) } });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /unauthorized/);
  });

  it('still refuses an endpoint that cannot carry a credential', async () => {
    // Plain http to any host is allowed; userinfo in the URL is not, because it would put the key
    // into shell history and logs whatever the scheme.
    const ran = await run(['get', '/work'], {
      env: { RAPHAEL_ENDPOINT: 'http://user:secret@raphael.example.com' },
    });
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /username and password/);
    assert.equal(ran.stderr.includes('secret'), false);
  });

  it('reports an unreachable server as uncertain for a creation', async () => {
    // Deliberately over-cautious: a refused connection is indistinguishable from a reset through
    // `fetch`, so a creation that may not have been sent is still reported as unresolved.
    const ran = await run(['create', 'project', '/work/unreachable', '--title', 'U'], {
      env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:1' },
    });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /Could not confirm whether this was created/);
    assert.match(ran.stderr, /--idempotency-key/);
    assert.equal(ran.stderr.includes('not applied'), false);
    assert.equal(ran.stderr.includes('was not created'), false);
  });

  it('reports the protocol identifier the server answered with, as the identifier it is', async () => {
    // `login --json` is the one place a person can read back what their server said. The identifier
    // is a date string now, and this is what stops it quietly reverting to a number.
    const home = temporary('raphael-cli-login-');
    let stdout = '';

    const code = await runLogin(['--json'], {
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

  it('does not present a reused key as though this invocation started the window', async () => {
    const ran = await run(
      [
        'create',
        'project',
        '/work/reused',
        '--title',
        'R',
        '--idempotency-key',
        'a-key-from-an-earlier-attempt',
      ],
      { env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:1' } },
    );
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /not when the key was first used/);
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
    assert.match(got.stdout, /^resource\.note \d+ {2}\(revision 1\)/m);
    assert.match(got.stdout, /title: API design/);
    assert.match(got.stdout, /# API design/);

    const listed = await run(['list', '/work', '--types', 'resource']);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /resource\.note {2}api-design/);
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

  it('prints the server sentence when no title can be derived', async () => {
    const ran = await run(['create', 'resource.note', '/work/nameless']);
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /title is required/i);
  });

  it('refuses an unknown type token before any request is made', async () => {
    for (const token of ['resource', 'resource.bogus', 'resource.note.extra', 'note', 'sketch']) {
      const ran = await run(['create', token, '/work/whatever', '--title', 'T']);
      assert.equal(ran.code, 2, token);
      assert.match(ran.stderr, /area, project, resource\.note/, token);
    }
  });

  it('filters by resource, and refuses a kind as a filter value', async () => {
    const byType = await run(['list', '/work', '--types', 'resource', '--json']);
    assert.equal(byType.code, 0);

    const byKind = await run(['list', '/work', '--types', 'resource.note']);
    assert.equal(byKind.code, 2);
    assert.match(byKind.stderr, /--types must name area or project or resource/);
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
      '--types',
      'resource',
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
      '--types',
      'resource',
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
    assert.equal(body.skip, 2);
    assert.equal(body.limit, 3);
    assert.equal(body.hasMore, all.length > 5);

    // The reverse direction is the same sequence read backwards, which a mis-forwarded direction
    // would not produce.
    const reversed = await run([
      'list',
      '/',
      '-r',
      '--types',
      'resource',
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
      '--types',
      'resource',
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
      '--types',
      'resource',
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
      '--types',
      'resource',
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

  it('documents both ordering examples in its help', async () => {
    const ran = await run(['list', '--help']);
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /--order-by updatedAt:desc --limit 4/);
    assert.match(ran.stdout, /--order-by updatedAt:desc --order-by slug:asc/);
  });

  it('documents the note token and the optional title in create help', async () => {
    const ran = await run(['create', '--help']);
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /area, project, resource\.note/);
    assert.match(ran.stdout, /A note may omit --title/);
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
    assert.match(ran.stdout, /slug: update-by-id/);
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
    // Seed a tag to remove, so the diff exercises both lists.
    await run([
      'update',
      '/work/tag-convenience',
      '--add-tag',
      'draft',
      '--revision',
      String(note.revision),
    ]);

    // No --revision at all. The CLI performs one Get immediately before the update and uses what it
    // returns; that is a convenience, not a blessing, because the server's guard still decides.
    const ran = await run([
      'update',
      '/work/tag-convenience',
      '--add-tag',
      'reviewed',
      '--remove-tag',
      'draft',
      '--json',
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    const { entity } = jsonOf(ran);
    assert.deepEqual([...entity.tags].sort(), ['reviewed']);
    assert.equal(entity.revision, note.revision + 2);
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
    assert.equal(ran.code, 1);
    assert.equal(ran.stdout, '', 'a conflict produces no result');
    assert.match(ran.stderr, /code: revision_conflict \(409\)/);
    assert.match(ran.stderr, new RegExp(`currentRevision: ${current.revision}`));
    assert.match(ran.stderr, /send it with --revision \d+/);
    // No creation wording, and nothing that suggests the command will try again by itself.
    assert.equal(ran.stderr.includes('Could not confirm'), false);
    assert.equal(ran.stderr.includes('idempotency-key'), false);

    // The entity is exactly where the earlier update left it.
    const afterConflict = await entityAt('/work/stale-revision');
    assert.equal(afterConflict.revision, current.revision);
    assert.equal(afterConflict.title, 'Moved on');
  });

  it('classifies a real conflict as a definite rejection in the machine report', async () => {
    // The CLI has no JSON failure output, so the machine shape is asserted where it is actually
    // built, against a failure a real server produced rather than a handwritten one.
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
      const report = buildFailureReport(result.failure, { operation: 'update' });
      assert.equal(report.mutationOutcome, 'rejected');
      assert.equal(report.code, 'revision_conflict');
      assert.equal(report.status, 409);
      assert.equal(
        (report.details as { currentRevision?: number }).currentRevision,
        note.revision + 1,
      );
      // An update has no key to replay, so none is reported.
      assert.equal(report.idempotencyKey, undefined);
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
    // The pre-read is the one failure where the CLI knows with certainty that nothing changed. Saying
    // so is worth more than the paragraph the uncertain case gets, and before this it said nothing.
    const ran = await run(['update', '/work/anything', '--add-tag', 'reviewed'], {
      env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:1' },
    });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /The change was not sent\./);
    assert.match(ran.stderr, /Check the server address/);
    // Nothing was attempted, so nothing may be said about whether it was applied.
    assert.equal(ran.stderr.includes('Could not confirm'), false);
  });

  it('reports an unreachable server as an uncertain change, with nothing to replay', async () => {
    // An update has no idempotency key, so an uncertain one cannot be resolved by resending. The only
    // honest instruction is to read the entity back, and the wording must not borrow creation's.
    const ran = await run(['update', '/work/anything', '--title', 'U', '--revision', '1'], {
      env: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:1' },
    });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /Could not confirm whether this change was applied/);
    assert.match(ran.stderr, /does not retry a change on its own/);
    // The transport hint still applies here, and only here: the server was never reached.
    assert.match(ran.stderr, /Check the server address/);
    assert.equal(ran.stderr.includes('whether this was created'), false);
    assert.equal(ran.stderr.includes('idempotency-key'), false);
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
    assert.match(ran.stderr, /Run "raphael update --help" for usage\./);
  });

  it('documents the revision rule in its help', async () => {
    const ran = await run(['update', '--help']);
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /Requires --revision/);
    assert.match(
      ran.stdout,
      /the\n\s+current revision is read for you just before the update is sent/,
    );
  });
});

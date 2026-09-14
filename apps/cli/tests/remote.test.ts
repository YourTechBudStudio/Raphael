import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ApiCredential, CONFIG_DEFAULTS, serve, silentLogger } from '@raphael/backend';
import { Effect, Exit, Scope } from 'effect';

import { run as runCli } from '../src/main.ts';

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

const runProcess = (
  args: readonly string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
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
    else child.stdin.end();
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

  it('requires a title', async () => {
    const ran = await run(['create', 'project', '/work/untitled']);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /--title is required/);
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

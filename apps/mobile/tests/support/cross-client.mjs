/**
 * The two real clients, in one process boundary each.
 *
 * A note written by one client has to be the same note to the other, and the phone's unsent writing
 * has to reach the server exactly once through a lost answer. None of that is provable against
 * substitutes, so everything here is real: a backend listening on an ephemeral port over an on-disk
 * database, the CLI run as its own operating-system process, and the phone's `unsent` table and runner
 * over genuine SQLite through the same port the app uses.
 *
 * **What this is not.** There is no Expo runtime, no WebView and no `expo-sqlite`; the local store
 * runs on `node:sqlite` through the shared port. The device remains a human-assisted check.
 *
 * Every listener, child process and directory this creates is torn down before the test returns,
 * including when an assertion fails.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiCredential, serve, silentLogger } from '@raphael/backend';
import { createTransport } from '@raphael/client';
import {
  create as createNode,
  get as getNode,
  getPath,
  list as listNodes,
  update as updateNode,
} from '@raphael/client/nodes';
import { Effect, Exit, Scope } from 'effect';

import { migrate } from '../../src/infrastructure/sqlite/migrate.ts';
import { fetchHierarchy } from '../../src/modules/collections/client/hierarchy.ts';
import { createRunner } from '../../src/modules/unsent/runner.ts';
import { MIGRATIONS, openUnsentStore } from '../../src/modules/unsent/store.ts';
import { openNodeDatabase } from './node-sqlite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `apps/mobile/tests/support` → the repository root. */
const repositoryRoot = path.resolve(here, '..', '..', '..', '..');

/** The CLI's own entry point, run from source: this runtime strips its types. */
export const CLI_ENTRY = path.join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

/**
 * The directory runtime state is created beneath, and the one directory no worker ever removes.
 *
 * Scratch state lives under the repository's `data/`, which is git-ignored and is where these tests
 * create and destroy runtime state. Nothing is written to the operator's home
 * directory, and `HOME` is redirected into this process's own root so a stray credential file
 * cannot land in a real one.
 *
 * This is `data/` itself rather than a directory beneath it, and that is the whole point: it is
 * pre-existing, stable, and deleted by nobody. A per-run parent would have to be created before a
 * root could be made inside it, and creating it and taking a root are two operations, not one - so
 * a worker finishing in between could remove the parent a starting worker had just created and
 * leave it to fail with `ENOENT`. Having no shared directory to delete removes that race rather
 * than narrowing it.
 */
export const RUNTIME_PARENT = path.join(repositoryRoot, 'data');

/** Distinctive, so an owned root is recognisable beside whatever else lives in `data/`. */
const ROOT_PREFIX = 'cross-client-runtime-';

/** Long enough for the shared key policy, and obviously not a real credential. */
export const KEY = `test-${'k'.repeat(40)}`;

const directories = [];

/**
 * This process's own root, and the only directory tree it ever deletes.
 *
 * `node --test` runs test files concurrently in separate processes, so anything above this root is
 * shared state on disk even though each process has its own module instance. One suite finishing
 * must never be able to remove a database another suite is still running against, nor a directory
 * another suite is about to create one in.
 */
let ownedRoot = null;

const ownRoot = async () => {
  if (ownedRoot === null) {
    await mkdir(RUNTIME_PARENT, { recursive: true });
    ownedRoot = await mkdtemp(path.join(RUNTIME_PARENT, ROOT_PREFIX));
  }

  return ownedRoot;
};

export const temporaryDir = async (prefix) => {
  const dir = await mkdtemp(path.join(await ownRoot(), prefix));
  directories.push(dir);

  return dir;
};

/**
 * Called from a test's `after`. Removes this process's own root, and nothing else.
 *
 * There is deliberately no attempt to tidy `RUNTIME_PARENT`: it is the repository's own `data/`,
 * it is git-ignored, and an empty directory is not worth a race with a worker that is starting.
 */
export const cleanupDirectories = async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
  directories.length = 0;

  if (ownedRoot !== null) {
    await rm(ownedRoot, { recursive: true, force: true });
    ownedRoot = null;
  }
};

/**
 * A real server on a real database.
 *
 * `databasePath` is exposed so a test can point two successive servers at the same file, or at a
 * deliberately replaced one, which is what the reset exercise needs.
 */
export const withServer = async (body, options = {}) => {
  const dir = options.databasePath === undefined ? await temporaryDir('server-') : null;
  const databasePath = options.databasePath ?? path.join(dir, 'raphael.sqlite');
  const scope = Effect.runSync(Scope.make());

  try {
    const running = await Effect.runPromise(
      Scope.extend(
        serve({
          options: {
            server: { host: '127.0.0.1', port: options.port ?? 0 },
            database: { databasePath },
          },
          credential: ApiCredential.fromKey(options.key ?? KEY),
          logger: silentLogger,
        }),
        scope,
      ),
    );

    return await body({
      endpoint: `http://${running.host}:${String(running.port)}`,
      port: running.port,
      databasePath,
    });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

/**
 * The CLI as its own process.
 *
 * A child process rather than an in-process call, because the claim under test is that the two
 * clients agree across a real boundary - argument parsing, stdin, streams and exit code included.
 */
export const runCli = async (args, options = {}) => {
  const home = options.home ?? (await ownRoot());

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        RAPHAEL_ENDPOINT: options.endpoint ?? '',
        RAPHAEL_API_KEY: options.key ?? KEY,
        ...options.env,
      },
      cwd: options.cwd ?? repositoryRoot,
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
};

/** `runCli`, refusing anything but a clean exit, and parsing the `--json` result. */
export const cliJson = async (args, options = {}) => {
  const ran = await runCli([...args, '--json'], options);
  if (ran.code !== 0) {
    throw new Error(
      `cli ${args.join(' ')} exited ${String(ran.code)}: ${ran.stderr || ran.stdout}`,
    );
  }

  return JSON.parse(ran.stdout);
};

/** The phone's transport. `fetch` is the one seam a test replaces, to make an answer go missing. */
export const phoneTransport = (endpoint, fetchImpl = fetch) =>
  createTransport({ endpoint, apiKey: KEY, fetch: fetchImpl });

/**
 * A fetch that lets the server commit the next matching request and then loses its answer, as a
 * dropped connection would. Every other request goes through untouched.
 */
export const losingNextAnswer = (matches) => {
  let armed = true;

  return async (url, init) => {
    const response = await fetch(url, init);

    if (armed && matches(String(url))) {
      armed = false;
      await response.text();
      throw new TypeError('Network request failed');
    }

    return response;
  };
};

/**
 * The phone's `unsent` table and runner over real SQLite, sending to a real server.
 *
 * The runner is driven by hand: `send()` kicks it and waits until nothing pending is left or it has
 * backed off, so a case reads as "write, then let the phone send". Backoff timers are recorded, never
 * run, so nothing outlives the case.
 */
export const unsentOver = async (endpoint, options = {}) => {
  const transport = phoneTransport(endpoint, options.fetch ?? fetch);
  const db = await openNodeDatabase();

  if ((await migrate(db, MIGRATIONS)).kind !== 'ready') throw new Error('unsent did not migrate');

  const store = await openUnsentStore(db);
  const cached = new Map();
  const backoffs = [];
  const runner = createRunner({
    store,
    session: () => ({ activation: 1, transport }),
    online: () => true,
    create: (active, request) => createNode(active, request),
    update: (active, request) => updateNode(active, request),
    get: (active, target) => getNode(active, { target, format: 'tiptap' }),
    pathOf: async (active, id) => {
      const result = await getPath(active, { target: { id } });

      return result.ok ? { ok: true, value: result.value.path } : result;
    },
    cache: (entity) => {
      cached.set(entity.id, entity);
    },
    refresh: () => {},
    setTimer: (_run, ms) => {
      backoffs.push(ms);

      return () => {};
    },
  });

  const send = async () => {
    const before = backoffs.length;

    runner.kick();
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (backoffs.length > before) return 'backed_off';
      if (!store.rows().some((row) => row.status === 'pending')) return 'settled';
    }

    throw new Error('the runner did not settle');
  };

  return {
    transport,
    store,
    runner,
    cached,
    send,
    row: (id) => store.rows().find((row) => row.id === id),
    close: async () => {
      runner.stop();
      await db.close();
    },
  };
};

/**
 * The container hierarchy, read the way the app reads it.
 *
 * The same wiring `collections/client/queries.ts` performs in `runHierarchy`: the real traversal over
 * the real client, with the transport captured rather than looked up per page. It lives here rather
 * than in each suite because both integration files now enter the phone's read through it, and two
 * copies of "how the phone reads the hierarchy" are two things free to drift.
 */
export const hierarchyOver = (transport, signal) =>
  fetchHierarchy((request, pageSignal) => listNodes(transport, request, pageSignal), signal);

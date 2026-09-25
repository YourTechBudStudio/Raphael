/**
 * The two real clients, in one process boundary each.
 *
 * Phase 07 has to show that a note written by one client is the same note to the other, and that a
 * creation survives a lost answer, a restarted owner and a reset server. None of that is provable
 * against substitutes, so everything here is real: a backend listening on an ephemeral port over an
 * on-disk database, the CLI run as its own operating-system process, and the mobile capture owner
 * over genuine SQLite through the same port the app uses.
 *
 * **What this is not.** There is no Expo runtime, no WebView and no `expo-sqlite`; the local store
 * runs on `node:sqlite` through the shared port. The device remains Phase 07's human-assisted block.
 *
 * Every listener, child process and directory this creates is torn down before the test returns,
 * including when an assertion fails.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiCredential, CONFIG_DEFAULTS, serve, silentLogger } from '@raphael/backend';
import { createTransport } from '@raphael/client';
import {
  archive as archiveNode,
  create as createNode,
  get as getNode,
  list as listNodes,
  move as moveNode,
  restore as restoreNode,
  update as updateNode,
} from '@raphael/client/nodes';
import { Effect, Exit, Scope } from 'effect';

import { createEditOwner } from '../../src/modules/capture/edit-owner.ts';
import { editKeyOf } from '../../src/modules/capture/edit-types.ts';
import { createCaptureOwner } from '../../src/modules/capture/owner.ts';
import { openCaptureStore } from '../../src/modules/capture/store.ts';
import { fetchHierarchy } from '../../src/modules/collections/client/hierarchy.ts';
import { openNodeDatabase } from './node-sqlite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `apps/mobile/tests/support` → the repository root. */
const repositoryRoot = path.resolve(here, '..', '..', '..', '..');

/** The CLI's own entry point, run from source: this runtime strips its types. */
export const CLI_ENTRY = path.join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

/**
 * The directory runtime state is created beneath, and the one directory no worker ever removes.
 *
 * Scratch state lives under the repository's `data/`, which is git-ignored and is where Phase 07 is
 * authorized to create and destroy runtime state. Nothing is written to the operator's home
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
const ROOT_PREFIX = 'phase-07-runtime-';

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
            database: { databasePath, busyTimeoutMs: CONFIG_DEFAULTS.busyTimeoutMs },
            idempotency: {
              gcIntervalMinutes: CONFIG_DEFAULTS.gcIntervalMinutes,
              gcBatchSize: CONFIG_DEFAULTS.gcBatchSize,
            },
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

/**
 * A capture owner over a real store, wired to a real transport.
 *
 * `fetchImpl` is the only seam a test replaces, and only to make a response actually go missing.
 * `sessionIsCurrent` is supplied by the caller so a test can retire an activation for real.
 */
export const captureOver = async (endpoint, localDbFile, options = {}) => {
  const transport = createTransport({
    endpoint,
    apiKey: options.key ?? KEY,
    fetch: options.fetch ?? fetch,
  });
  let ids = 0;

  const owner = createCaptureOwner({
    openStore: async () => openCaptureStore(await openNodeDatabase(localDbFile), () => Date.now()),
    create: (activeTransport, request) => createNode(activeTransport, request),
    now: options.now ?? (() => Date.now()),
    monotonic: () => performance.now(),
    newId: () => {
      ids += 1;

      return `note-${String(ids)}-${String(Math.random()).slice(2, 10)}`;
    },
    applyCreation: options.applyCreation ?? (async () => {}),
    sessionIsCurrent: options.sessionIsCurrent ?? ((session) => session.activation === 1),
  });

  return {
    owner,
    transport,
    session: {
      activation: options.activation ?? 1,
      connectionId: options.connectionId ?? 'c1',
      endpoint,
      transport,
      usable: true,
    },
  };
};

/**
 * An edit owner over a real store, wired to a real transport.
 *
 * `captureOver`'s counterpart, and the reason both exist in one harness: editing is the first
 * operation where the two clients' interaction models genuinely diverge - `raphael update` names a
 * revision explicitly, the phone autosaves against a base it keeps itself - so the only place that
 * divergence can be checked is at a server both of them talk to.
 *
 * The debounce is set to zero and the timers are real, so a case reads as "edit, then wait for the
 * server to have it" rather than as a schedule being driven by hand. `fetchImpl` is the one seam a
 * case replaces, and only to make an answer actually go missing.
 */
export const editOver = async (endpoint, localDbFile, options = {}) => {
  const transport = createTransport({
    endpoint,
    apiKey: options.key ?? KEY,
    fetch: options.fetch ?? fetch,
  });
  const applied = [];
  const refreshed = [];

  const owner = createEditOwner({
    openStore: async () => openCaptureStore(await openNodeDatabase(localDbFile), () => Date.now()),
    get: (activeTransport, request) => getNode(activeTransport, request),
    update: (activeTransport, request) => updateNode(activeTransport, request),
    move: (activeTransport, request) => moveNode(activeTransport, request),
    archive: (activeTransport, request) => archiveNode(activeTransport, request),
    restore: (activeTransport, request) => restoreNode(activeTransport, request),
    now: options.now ?? (() => Date.now()),
    applyUpdate: async (ref, activation) => {
      applied.push({ ref, activation });
    },
    applyLifecycle: async (activation) => {
      refreshed.push(activation);
    },
    sessionIsCurrent: options.sessionIsCurrent ?? ((session) => session.activation === 1),
    autosaveDelayMs: options.autosaveDelayMs ?? 0,
    autosaveRetryMs: options.autosaveRetryMs ?? 50,
  });

  const session = {
    activation: options.activation ?? 1,
    connectionId: options.connectionId ?? 'c1',
    endpoint,
    transport,
    usable: true,
  };

  return {
    owner,
    transport,
    session,
    applied,
    refreshed,
    keyFor: (nodeId) => editKeyOf({ connectionId: session.connectionId, nodeId }),
    record: (nodeId) =>
      owner.getState().edits.find((candidate) => candidate.key.nodeId === nodeId) ?? null,
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

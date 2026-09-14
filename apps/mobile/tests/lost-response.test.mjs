/**
 * A creation that commits and loses its answer, end to end.
 *
 * This is the case the whole phase exists for, and the only way to be sure of it is to make it
 * actually happen: a real server, a real commit, and a response that never reaches the caller. The
 * fault is injected at the transport, **after** the server has finished writing - so the database
 * genuinely holds the node and the replay receipt, and the phone genuinely does not know it.
 *
 * **What this is not.** It is an instrumented post-commit response loss. It is not evidence about
 * killing an Expo process, not evidence about a network being cut, and not evidence about the
 * `expo-sqlite` binding: the local store here runs on `node:sqlite` through the same port. Those
 * remain device evidence and are recorded as outstanding.
 *
 * The listener, the database, and the temporary directories are all torn down before the test
 * returns, including when an assertion fails.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ApiCredential, serve } from '@raphael/backend';
import { CONFIG_DEFAULTS } from '@raphael/backend';
import { silentLogger } from '@raphael/backend';
import { createTransport } from '@raphael/client';
import { create as createNode } from '@raphael/client/nodes';
import { Effect, Exit, Scope } from 'effect';

import { logicalStateOf } from '../src/modules/collections/creation/derive.ts';
import { createCreationOwner } from '../src/modules/collections/creation/owner.ts';
import { openAttemptStore } from '../src/modules/collections/creation/store.ts';
import { openNodeDatabase } from './support/node-sqlite.mjs';

const KEY = `test-${'k'.repeat(40)}`;
const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-lost-'));
  temporaries.push(dir);

  return dir;
};

/** A real server on a real database, on whatever port the operating system hands out. */
const withServer = async (body) => {
  const dir = await temporaryDir();
  const scope = Effect.runSync(Scope.make());

  try {
    const running = await Effect.runPromise(
      Scope.extend(
        serve({
          options: {
            server: { host: '127.0.0.1', port: 0 },
            database: {
              databasePath: path.join(dir, 'raphael.db'),
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

    return await body(`http://${running.host}:${String(running.port)}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

/**
 * A fetch that lets the request through and then throws instead of returning the response.
 *
 * The server has committed by the time this fires. Throwing here is what an interrupted connection
 * looks like to the caller, and it is the failure the shared client classifies as `unknown` -
 * because it genuinely cannot tell a reset before the write from one after it.
 */
const losingFetch = (state) => async (input, init) => {
  const response = await fetch(input, init);

  if (state.lose) {
    // Drain it, so the exchange really did complete on the wire before the caller loses it.
    await response.arrayBuffer();
    state.lost += 1;
    throw new TypeError('Network request failed');
  }

  return response;
};

const ownerOver = async (base, fetchImpl, localDbFile) => {
  const transport = createTransport({ endpoint: base, apiKey: KEY, fetch: fetchImpl });
  let ids = 0;

  const open = async () => {
    const db = await openNodeDatabase(localDbFile);

    return openAttemptStore(db, () => Date.now());
  };

  const owner = createCreationOwner({
    openStore: open,
    create: (activeTransport, request) => createNode(activeTransport, request),
    now: () => Date.now(),
    monotonic: () => performance.now(),
    newId: () => {
      ids += 1;

      return `local-${String(ids)}`;
    },
    applyCreation: async () => {},
  });

  return {
    owner,
    session: {
      activation: 1,
      connectionId: 'c1',
      endpoint: base,
      transport,
      usable: true,
    },
  };
};

const waitForUncertain = (owner, attemptId) =>
  new Promise((resolve, reject) => {
    const matches = (state) =>
      state.records.some(
        (record) => record.attemptId === attemptId && record.state === 'uncertain',
      );

    if (matches(owner.getState())) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Attempt ${attemptId} did not become uncertain within 5 seconds`));
    }, 5_000);
    const unsubscribe = owner.subscribe((state) => {
      if (!matches(state)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });

describe('a creation whose response is lost after the server commits', () => {
  it('is recovered by replaying the frozen request, and reports the same entity', async () => {
    const localDir = await temporaryDir();
    const localDb = path.join(localDir, 'attempts.db');

    await withServer(async (base) => {
      const state = { lose: true, lost: 0 };
      const first = await ownerOver(base, losingFetch(state), localDb);

      await first.owner.getState().initialize();
      const submitted = await first.owner.getState().submit({
        target: { type: 'area', parentAreaId: null },
        title: 'Lost and found',
        body: 'written before the answer went missing',
        session: first.session,
      });

      assert.equal(submitted.kind, 'dispatched');
      await waitForUncertain(first.owner, submitted.attemptId);

      assert.equal(state.lost, 1, 'the response was actually discarded');

      const pending = first.owner.getState().records[0];
      assert.equal(pending.state, 'uncertain');
      assert.equal(logicalStateOf(pending), 'unresolved');
      const frozen = pending.request;

      // The phone is put away and comes back. Everything about the attempt has to survive that,
      // including the key, which is the only thing that can resolve it.
      const second = await ownerOver(base, losingFetch({ lose: false, lost: 0 }), localDb);
      await second.owner.getState().initialize();

      const recovered = second.owner.getState().records[0];
      assert.equal(recovered.attemptId, pending.attemptId);
      assert.equal(recovered.request, frozen, 'the frozen request is byte-for-byte what was sent');
      assert.equal(recovered.state, 'uncertain');

      // An explicit retry. Nothing here is automatic.
      const retried = await second.owner.getState().retry(recovered.attemptId, second.session);
      assert.equal(retried.kind, 'done');
      const resolved = second.owner.getState().records[0];
      assert.equal(resolved.state, 'acknowledged');
      assert.equal(logicalStateOf(resolved), 'created');
      assert.equal(resolved.acknowledged.title, 'Lost and found');
      assert.equal(resolved.acknowledged.type, 'area');

      // The replay resolved the original creation rather than making a second one. The server's
      // own receipt is what establishes that: a fresh key would have produced a slug conflict.
      const listed = await listAreas(base);
      const matching = listed.filter((item) => item.title === 'Lost and found');
      assert.equal(matching.length, 1, 'exactly one area was created, across both dispatches');
      assert.equal(matching[0].id, resolved.acknowledged.id);
    });
  });
});

const listAreas = async (base) => {
  const response = await fetch(`${base}/api/nodes/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ parent: { path: '/' }, recursive: true, limit: 100 }),
  });

  return (await response.json()).items;
};

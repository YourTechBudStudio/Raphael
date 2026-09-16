/**
 * A note that commits and loses its answer, end to end.
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

import { createCaptureOwner } from '../src/modules/capture/owner.ts';
import { factsOf, logicalStateOf as noteStateOf } from '../src/modules/capture/policy.ts';
import { openCaptureStore } from '../src/modules/capture/store.ts';
import { documentWith, fakeEditor } from './support/capture-harness.mjs';
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

const captureOver = async (base, fetchImpl, localDbFile) => {
  const transport = createTransport({ endpoint: base, apiKey: KEY, fetch: fetchImpl });
  let ids = 0;

  const owner = createCaptureOwner({
    openStore: async () => openCaptureStore(await openNodeDatabase(localDbFile), () => Date.now()),
    create: (activeTransport, request) => createNode(activeTransport, request),
    now: () => Date.now(),
    monotonic: () => performance.now(),
    newId: () => {
      ids += 1;

      return `note-${String(ids)}-${String(Math.random()).slice(2, 10)}`;
    },
    applyCreation: async () => {},
    // One connection throughout: this test is about a lost response, not a connection change.
    sessionIsCurrent: (session) => session.activation === 1,
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

const createArea = async (base, title) => {
  const response = await fetch(`${base}/api/nodes/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ type: 'area', title, parent: { path: '/' } }),
  });

  return (await response.json()).entity;
};

const listNotes = async (base) => {
  const response = await fetch(`${base}/api/nodes/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      parent: { path: '/' },
      recursive: true,
      types: ['resource'],
      limit: 100,
    }),
  });

  return (await response.json()).items;
};

describe('a note whose response is lost after the server commits', () => {
  it('is adopted as unresolved at the next open, and a replay returns the original note', async () => {
    const localDir = await temporaryDir();
    const localDb = path.join(localDir, 'capture.db');

    await withServer(async (base) => {
      const area = await createArea(base, 'Somewhere');
      const state = { lose: true, lost: 0 };
      const first = await captureOver(base, losingFetch(state), localDb);
      const editor = fakeEditor();

      await first.owner.getState().initialize();
      const draft = await first.owner.getState().createDraft(first.session);
      assert.equal(draft.kind, 'created');
      const { draftId } = draft;

      await first.owner
        .getState()
        .selectDestination(draftId, { type: 'area', id: area.id }, first.session);
      first.owner.getState().editDraft(draftId, { title: 'Lost and found' });
      first.owner.getState().attachEditor(draftId, editor.port);
      editor.captures(documentWith('written before the answer went missing'));

      const outcome = await first.owner.getState().save(draftId, first.session);

      assert.equal(outcome.kind, 'dispatched');
      assert.equal(state.lost, 1, 'the response was actually discarded');

      const pending = first.owner.getState().attempts[0];
      assert.equal(pending.state, 'uncertain');
      assert.equal(noteStateOf(factsOf(pending)), 'unresolved');
      // The draft is editable again while the creation stays unresolved.
      assert.equal(first.owner.getState().drafts[0].state, 'composing');
      assert.equal(first.owner.getState().standingFor(draftId).kind, 'retry');
      const frozen = pending.request;

      // The phone is put away and comes back. Everything about the attempt has to survive that,
      // including the key, which is the only thing that can resolve it.
      const second = await captureOver(base, losingFetch({ lose: false, lost: 0 }), localDb);
      await second.owner.getState().initialize();

      const recovered = second.owner.getState().attempts[0];
      assert.equal(recovered.attemptId, pending.attemptId);
      assert.equal(recovered.request, frozen, 'the frozen request is byte-for-byte what was sent');
      assert.equal(recovered.state, 'uncertain');
      // Ordinary Save is refused: admitting it here would mint a second key for a note whose first
      // response was lost, and both requests would be accepted.
      assert.equal(
        (await second.owner.getState().save(draftId, second.session)).reason,
        'not_admitted',
      );

      // An explicit replay. Nothing here is automatic.
      assert.deepEqual(await second.owner.getState().retry(draftId, second.session), {
        kind: 'done',
      });

      const resolved = second.owner.getState().attempts[0];
      assert.equal(resolved.state, 'acknowledged');
      assert.equal(resolved.acknowledged.title, 'Lost and found');
      assert.equal(resolved.acknowledged.kind, 'note');
      assert.equal(second.owner.getState().drafts[0].serverNodeId, resolved.acknowledged.id);

      // The replay resolved the original creation rather than making a second one. The server's own
      // receipt is what establishes that.
      const notes = await listNotes(base);
      const matching = notes.filter((item) => item.title === 'Lost and found');

      assert.equal(matching.length, 1, 'exactly one note was created, across both dispatches');
      assert.equal(matching[0].id, resolved.acknowledged.id);
    });
  });
});

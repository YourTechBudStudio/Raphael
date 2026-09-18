/**
 * What survives a shutdown, and what a reset is allowed to reach.
 *
 * Two process boundaries this story depends on and nothing else exercises together. The first is a
 * creation whose answer went missing: the owner is genuinely **closed**, the server is genuinely
 * **stopped and restarted over its own file**, and only then is the frozen request replayed under
 * its original key. The second is the rollout D7 describes: the backend database is deliberately
 * deleted and rebuilt from committed migrations at the same address, and the work recorded against
 * the connection that is now gone must stay visible, stay unsendable, and never rebind itself to
 * the new server.
 *
 * `tests/lost-response.test.mjs` proves the adoption and replay of a lost answer within one process.
 * What is added here is the shutdown between them, the server restart, and the reset.
 *
 * **What this is not.** No Expo runtime and no `expo-sqlite`; the capture store runs on
 * `node:sqlite` through the shared port. A real process kill and the Expo binding remain device
 * evidence. The backend state this creates lives under the repository's git-ignored `data/` and is
 * removed before the test returns, including when an assertion fails.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { update } from '@raphael/client/nodes';

import { unwrap } from '../src/infrastructure/query/failure.ts';
import { factsOf, logicalStateOf } from '../src/modules/capture/policy.ts';
import { unfinishedNotes } from '../src/modules/capture/unfinished.ts';
import { activeProjects } from '../src/modules/collections/client/hierarchy.ts';
import { documentWith, fakeEditor } from './support/capture-harness.mjs';
import {
  captureOver,
  cleanupDirectories,
  cliJson,
  hierarchyOver,
  runCli,
  temporaryDir,
  withServer,
} from './support/cross-client.mjs';

after(cleanupDirectories);

const WORK = { path: '/work', id: 1 };
const PERSONAL = { path: '/personal', id: 2 };

/**
 * Wait for a dispatch to stop being an intent. A real round trip, so a wall-clock deadline.
 *
 * `matches` picks the attempt, because after a reset there are two: the retired one and the one the
 * copy is making. Watching position zero would let one test the other's answer.
 */
const settled = async (owner, what, matches = () => true) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const attempt = owner.getState().attempts.find(matches);
    if (attempt !== undefined && attempt.state !== 'dispatch_intent') return attempt;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.fail(`timed out waiting for ${what}`);
};

/**
 * A fetch that completes the exchange and then throws the answer away.
 *
 * The server has committed by the time this fires, so what the caller sees is exactly what an
 * interrupted connection looks like: a failure that cannot distinguish a reset before the write
 * from one after it.
 */
const losingFetch = (state) => async (input, init) => {
  const response = await fetch(input, init);

  if (state.lose) {
    await response.arrayBuffer();
    state.lost += 1;
    throw new TypeError('Network request failed');
  }

  return response;
};

/** Write a note, lose its answer, and hand back everything needed to resolve it later. */
const writeAndLoseTheAnswer = async (endpoint, captureDb, title, text, session = {}) => {
  const state = { lose: true, lost: 0 };
  const { owner, session: active } = await captureOver(endpoint, captureDb, {
    fetch: losingFetch(state),
    ...session,
  });
  const editor = fakeEditor();

  await owner.getState().initialize();
  const draft = await owner.getState().createDraft(active);
  assert.equal(draft.kind, 'created');

  const { draftId } = draft;
  await owner.getState().selectDestination(draftId, { type: 'area', id: WORK.id }, active);
  owner.getState().editDraft(draftId, { title });
  owner.getState().attachEditor(draftId, editor.port);
  editor.captures(documentWith(text));

  assert.equal((await owner.getState().save(draftId, active)).kind, 'dispatched');

  const attempt = await settled(owner, 'the answer to go missing');
  assert.equal(attempt.state, 'uncertain');
  assert.equal(state.lost, 1, 'the response really was discarded');

  return { owner, draftId, attempt };
};

describe('a creation whose answer was lost, across a real shutdown and a server restart', () => {
  it('replays the frozen bytes under the original key and resolves to one note', async () => {
    const dir = await temporaryDir('restart-');
    const captureDb = path.join(dir, 'capture.db');
    const serverDb = path.join(dir, 'raphael.sqlite');

    // The phone writes, the answer is lost, and the owner is closed - not abandoned.
    const { frozen, attemptId, draftId } = await withServer(
      async ({ endpoint }) => {
        const {
          owner,
          draftId: id,
          attempt,
        } = await writeAndLoseTheAnswer(
          endpoint,
          captureDb,
          'Written before the answer went missing',
          'the writing itself',
        );

        try {
          assert.equal(logicalStateOf(factsOf(attempt)), 'unresolved');

          return { frozen: attempt.request, attemptId: attempt.attemptId, draftId: id };
        } finally {
          // A genuine shutdown: the store is closed and the lifetime is over.
          await owner.getState().close();
        }
      },
      { databasePath: serverDb },
    );

    // The server is stopped and started again over the same file. Its receipt has to have been on
    // disk, not in the process that answered - which is the difference between a durable ledger and
    // a memory of one.
    await withServer(
      async ({ endpoint }) => {
        const { owner, session } = await captureOver(endpoint, captureDb);

        try {
          await owner.getState().initialize();

          const recovered = owner.getState().attempts[0];
          assert.equal(recovered.attemptId, attemptId, 'the same attempt came back');
          assert.equal(recovered.request, frozen, 'byte for byte what was sent');
          assert.equal(recovered.state, 'uncertain');

          // Ordinary Save stays refused: it would mint a second key for a creation that may already
          // have happened, and both requests would be accepted.
          assert.equal(
            (await owner.getState().save(draftId, session)).reason,
            'not_admitted',
            'an unresolved attempt does not permit an ordinary Save',
          );

          assert.deepEqual(await owner.getState().retry(draftId, session), { kind: 'done' });

          const resolved = owner.getState().attempts[0];
          assert.equal(resolved.state, 'acknowledged');
          assert.equal(resolved.acknowledged.title, 'Written before the answer went missing');
          assert.equal(resolved.acknowledged.kind, 'note');

          // One note, across two dispatches and a restarted server on both sides.
          const listed = await cliJson(['list', WORK.path, '--types', 'resource'], { endpoint });
          const matching = listed.items.filter(
            (item) => item.title === 'Written before the answer went missing',
          );
          assert.equal(
            matching.length,
            1,
            'the replay resolved the creation, it did not repeat it',
          );
          assert.equal(matching[0].id, resolved.acknowledged.id);
        } finally {
          await owner.getState().close();
        }
      },
      { databasePath: serverDb },
    );
  });
});

/**
 * A selection that outlives the process that accepted it.
 *
 * Acceptance criterion 2 of story #5 - "selections persist across restart and are consistent across
 * clients" - asserts two properties this repository proves separately and has never proved together,
 * and never for a selection at all. The crossing half is in `cross-client.test.mjs`; this is the
 * restart half, and this file is the only harness that genuinely stops a server and starts another
 * one over the same database file.
 *
 * What is asserted is the row, not the byte. A durable boolean would be satisfied by reading `true`
 * back; what the phone actually depends on is that a reading taken *before* the restart is still a
 * usable revision *after* it, because that reading is what a Home card holds and what a toggle from
 * it is guarded by. So the selection is read across the boundary and then written against the
 * pre-restart revision.
 *
 * **What this is not.** The same limit the rest of this file states: no Expo runtime and no
 * `expo-sqlite`, and no real process kill. A force-quit, a disconnect and reconnect, and a switch to
 * another server and back remain device evidence.
 */
describe('an active project, across a server stop and a restart over the same file', () => {
  it('is still selected afterwards, at a revision the pre-restart reading can still write against', async () => {
    const dir = await temporaryDir('active-restart-');
    const serverDb = path.join(dir, 'raphael.sqlite');
    const captureDb = path.join(dir, 'capture.db');

    // Selected at a terminal, on the server that is about to go away.
    const read = await withServer(
      async ({ endpoint }) => {
        const created = (
          await cliJson(
            ['create', 'project', `${WORK.path}/outlives-its-server`, '--title', 'Ship it'],
            {
              endpoint,
            },
          )
        ).entity;
        assert.equal(created.active, false);

        const ran = await runCli(['update', `${WORK.path}/outlives-its-server`, '--active'], {
          endpoint,
        });
        assert.equal(ran.code, 0, ran.stderr);

        // The phone's reading, taken while this server is still running. This is the object a Home
        // card renders from, and the revision a toggle from that card would send.
        const { transport } = await captureOver(endpoint, captureDb);
        const node = (await hierarchyOver(transport)).byId.get(created.id);
        assert.equal(node.active, true);

        return { id: node.id, revision: node.revision, slug: node.slug };
      },
      { databasePath: serverDb },
    );

    // The server is stopped and another is started over the same file. The selection has to have
    // been on disk rather than in the process that accepted it.
    await withServer(
      async ({ endpoint }) => {
        const atTerminal = await cliJson(['get', `${WORK.path}/outlives-its-server`], { endpoint });
        assert.equal(atTerminal.entity.active, true, 'the terminal still reads it as selected');
        assert.equal(atTerminal.entity.revision, read.revision, 'and at the same revision');

        const { transport } = await captureOver(endpoint, captureDb);
        const fresh = await hierarchyOver(transport);
        assert.equal(fresh.byId.get(read.id).active, true, 'and so does the phone');
        assert.deepEqual(
          activeProjects(fresh).map((found) => found.slug),
          [read.slug],
          'so Home draws it again with nothing else selected',
        );

        // The claim this case exists for: the reading taken before the restart is still a usable
        // revision after it, so a card held across the boundary can still issue a guarded write.
        const answered = unwrap(
          await update(transport, {
            target: { id: read.id },
            revision: read.revision,
            active: false,
          }),
        );
        assert.equal(answered.entity.active, false);
        assert.equal(answered.entity.revision, read.revision + 1);

        const cleared = await cliJson(['get', `${WORK.path}/outlives-its-server`], { endpoint });
        assert.equal(cleared.entity.active, false, 'and the deselection is durable in its turn');
      },
      { databasePath: serverDb },
    );
  });
});

describe('a deliberately reset backend, at the same address', () => {
  it('retires the old work, refuses to resend it, and saves a copy against the fresh server', async () => {
    const dir = await temporaryDir('reset-');
    const captureDb = path.join(dir, 'capture.db');
    const serverDb = path.join(dir, 'raphael.sqlite');

    // One connection, one unresolved creation, then the owner closes and the server stops.
    const { address, oldAttemptId, oldDraftId, oldServerIds, oldKey, oldDestination } =
      await withServer(
        async ({ endpoint, port }) => {
          const { owner, draftId, attempt } = await writeAndLoseTheAnswer(
            endpoint,
            captureDb,
            'Filed on the server that is going away',
            'writing that outlives its server',
            { activation: 1, connectionId: 'c1' },
          );

          try {
            const listed = await cliJson(['list', WORK.path, '--types', 'resource'], { endpoint });

            return {
              address: { endpoint, port },
              oldAttemptId: attempt.attemptId,
              oldDraftId: draftId,
              oldServerIds: listed.items.map((item) => item.id),
              oldKey: JSON.parse(attempt.request).idempotencyKey,
              oldDestination: attempt.destination,
            };
          } finally {
            await owner.getState().close();
          }
        },
        { databasePath: serverDb },
      );

    assert.equal(oldServerIds.length, 1, 'the creation did commit before its answer was lost');

    // The reset itself. The operator's step, performed here on this test's own throwaway database:
    // the file is deleted while nothing is running, and the next server bootstraps from the
    // committed migration chain.
    await rm(serverDb, { force: true });
    await rm(`${serverDb}-wal`, { force: true });
    await rm(`${serverDb}-shm`, { force: true });

    await withServer(
      async ({ endpoint }) => {
        assert.equal(endpoint, address.endpoint, 'the fresh server is at the same address');

        // A fresh bootstrap: the seeded areas and nothing else. The old note is gone, and so is the
        // receipt that could have resolved its attempt.
        const fresh = await cliJson(['list', '/', '--types', 'area,project,resource'], {
          endpoint,
        });
        assert.deepEqual(
          fresh.items.map((item) => item.slug).sort(),
          ['personal', 'work'],
          'the reset server holds only what the migrations seed',
        );

        // Setup mints a new identity even at the same URL, so the phone comes back under a new
        // activation and a new connection id. Its transport can lose an answer too, because the
        // copy's own save has to be shown surviving the same failure on the fresh server.
        const loss = { lose: false, lost: 0 };
        const { owner, session } = await captureOver(endpoint, captureDb, {
          activation: 2,
          connectionId: 'c2',
          sessionIsCurrent: (candidate) => candidate.activation === 2,
          fetch: losingFetch(loss),
        });

        try {
          await owner.getState().initialize();

          const state = owner.getState();
          const rows = unfinishedNotes({
            drafts: state.drafts,
            unusableDrafts: state.unusableDrafts,
            attempts: state.attempts,
            unsaved: state.unsaved,
            sending: state.sending,
            standingFor: (id) => state.standingFor(id),
            connectionId: 'c2',
          });

          const old = rows.find((row) => row.attemptId === oldAttemptId);
          assert.ok(old !== undefined, 'the old work is still here');
          assert.equal(old.scope, 'retired', 'and it belongs to the connection that is gone');
          assert.ok(
            old.actions.includes('copy'),
            'copying it into the current connection is offered',
          );

          // Neither route sends it. An ordinary Save would mint a second key for a creation that may
          // exist somewhere; a replay would aim a key minted for one server at another one.
          // The refusal names the connection rather than the attempt: this draft was written
          // somewhere else, which is a reason to refuse before the attempt is even considered.
          assert.equal(
            (await owner.getState().save(oldDraftId, session)).reason,
            'wrong_connection',
            'a draft from a retired connection is not saved under the current one',
          );
          assert.notDeepEqual(
            await owner.getState().retry(oldDraftId, session),
            { kind: 'done' },
            'a frozen request is never replayed to a different connection',
          );

          // Copy is the only way across, and it carries writing rather than identity.
          const copied = await owner.getState().copyDraft(oldDraftId, session);
          assert.equal(copied.kind, 'created');
          assert.notEqual(copied.draftId, oldDraftId);

          const copy = owner.getState().drafts.find((draft) => draft.draftId === copied.draftId);
          assert.equal(copy.connectionId, 'c2', 'the copy belongs to the connection in use');
          assert.equal(copy.destination, null, 'and must be given a destination of its own');
          assert.equal(copy.serverNodeId, null, 'it inherits no server identity');
          assert.equal(copy.title, 'Filed on the server that is going away', 'the writing came');
          assert.ok(
            !owner.getState().attempts.some((attempt) => attempt.draftId === copied.draftId),
            'and it carries no attempt and no key',
          );

          // The original evidence is untouched: copying is not a way of clearing uncertainty.
          const original = owner
            .getState()
            .attempts.find((attempt) => attempt.attemptId === oldAttemptId);
          assert.equal(original.state, 'uncertain');

          // Nothing has been sent to the fresh server yet.
          const remaining = await cliJson(['list', WORK.path, '--types', 'resource'], { endpoint });
          assert.deepEqual(remaining.items, [], 'the reset server still holds no notes');

          // --- The copy is now saved, and its answer is lost too. ---
          //
          // A destination on the *fresh* server, deliberately not the area the retired attempt was
          // filed under. The seeded ids repeat after a reset, so choosing the same area would make
          // "no old destination was reused" unprovable: it would be indistinguishable from a
          // coincidence. Personal is a different area, and the copy had to be given it explicitly.
          const chosen = { type: 'area', id: PERSONAL.id };
          assert.notEqual(chosen.id, oldDestination.id, 'a different area from the retired one');
          assert.deepEqual(
            await owner.getState().selectDestination(copied.draftId, chosen, session),
            {
              kind: 'done',
            },
          );

          const editor = fakeEditor();
          owner.getState().attachEditor(copied.draftId, editor.port);
          editor.captures(documentWith('writing that outlives its server'));

          loss.lose = true;
          assert.equal((await owner.getState().save(copied.draftId, session)).kind, 'dispatched');

          const fresh2 = await settled(
            owner,
            'the copy to lose its answer',
            (attempt) => attempt.draftId === copied.draftId,
          );
          assert.equal(fresh2.state, 'uncertain', 'the copy is unresolved on the fresh server');
          assert.equal(loss.lost, 1, 'its response really was discarded');

          // A newly minted key, and a request aimed at the destination just chosen. Neither the old
          // key nor the old parent survives into it.
          const frozen = JSON.parse(fresh2.request);
          assert.notEqual(frozen.idempotencyKey, oldKey, 'the copy sends under a key of its own');
          assert.notEqual(fresh2.attemptId, oldAttemptId, 'and it is a different attempt');
          assert.equal(frozen.parent.id, PERSONAL.id, 'aimed where it was told, not where it was');

          // The retired record is untouched by all of this.
          const retired = owner
            .getState()
            .attempts.find((attempt) => attempt.attemptId === oldAttemptId);
          assert.equal(retired.state, 'uncertain', 'the retired attempt is still unresolved');
          assert.equal(retired.acknowledged, null, 'and still carries no server identity');
          assert.equal(
            JSON.parse(retired.request).idempotencyKey,
            oldKey,
            'its frozen bytes are exactly what they were',
          );

          // The replay the person asks for, over a connection that now answers.
          loss.lose = false;
          const replayed = fresh2.request;
          assert.deepEqual(await owner.getState().retry(copied.draftId, session), { kind: 'done' });

          const resolved = owner
            .getState()
            .attempts.find((attempt) => attempt.attemptId === fresh2.attemptId);
          assert.equal(resolved.state, 'acknowledged');
          assert.equal(resolved.request, replayed, 'the replay sent the frozen bytes, unchanged');
          assert.equal(resolved.acknowledged.kind, 'note');
          assert.equal(resolved.acknowledged.revision, 1);
          assert.equal(resolved.acknowledged.title, 'Filed on the server that is going away');

          // The local record reconciles against what the fresh server actually holds.
          const savedDraft = owner
            .getState()
            .drafts.find((draft) => draft.draftId === copied.draftId);
          assert.equal(savedDraft.serverNodeId, resolved.acknowledged.id);
          assert.equal(savedDraft.serverRevision, resolved.acknowledged.revision);

          const onServer = await cliJson(
            ['get', '--id', String(resolved.acknowledged.id), '--format', 'tiptap'],
            { endpoint },
          );
          assert.equal(onServer.entity.parentId, PERSONAL.id);
          assert.equal(onServer.entity.revision, 1);
          assert.equal(onServer.entity.kind, 'note');
          assert.deepEqual(
            onServer.entity.body.value,
            documentWith('writing that outlives its server'),
          );

          // Exactly one note exists, across both dispatches, on the whole fresh server.
          const everything = await cliJson(['list', '/', '-r', '--types', 'resource'], {
            endpoint,
          });
          assert.equal(everything.items.length, 1, 'one note, not one per dispatch');
          assert.equal(everything.items[0].id, resolved.acknowledged.id);

          // And the retired record still never acquired one. Nothing rebound it to the new server:
          // its draft has no server id, which is the claim the repeated seed ids cannot muddle.
          const retiredDraft = owner
            .getState()
            .drafts.find((draft) => draft.draftId === oldDraftId);
          assert.equal(retiredDraft.serverNodeId, null);
          assert.equal(retiredDraft.serverRevision, null);
        } finally {
          await owner.getState().close();
        }
      },
      { databasePath: serverDb, port: address.port },
    );
  });
});

/**
 * The edit owner's move, against real SQLite and a server that follows core's move rules.
 *
 * What is defended here is that a move is one more thing the autosave loop keeps honest: writing is
 * settled on the server before a move leaves the phone, the move is on disk before it is sent, the
 * confirmed location advances only on the store's own acknowledgement, and an answer that was lost
 * is answered later by a re-read - never by adopting someone else's write as this phone's move, and
 * never by throwing away writing.
 *
 * The protection barrier appears only around the one transition that rewrites authored columns:
 * adopting the server after a lost move that expected no write. A move acknowledgement changes
 * nothing authored, so it needs none.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { editKeyOf } from '../src/modules/capture/edit-types.ts';
import { fakeEditor } from './support/capture-harness.mjs';
import {
  clientFailure,
  documentWith,
  editHarness,
  serverModel,
  SESSION,
  until,
} from './support/edit-harness.mjs';

const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryFile = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-move-'));

  temporaries.push(dir);

  return path.join(dir, 'capture.db');
};

const KEY = editKeyOf({ connectionId: 'c1', nodeId: 42 });
const RETRY_MS = 10_000;

/** Open the owner and one entity, with an editor attached unless asked otherwise. */
const opened = async (options = {}) => {
  const kit = await editHarness(options);

  await kit.owner.getState().initialize();

  const outcome = await kit.owner.getState().open(42, SESSION);

  assert.equal(outcome.kind, 'ready', JSON.stringify(outcome));

  if (options.detached !== true) {
    kit.editor = fakeEditor();
    kit.token = kit.owner.getState().attachEditor(outcome.editKey, kit.editor.port);
    assert.notEqual(kit.token, null, 'the editor attached');
  }

  return kit;
};

const committed = (kit, version) =>
  until(
    () => (kit.state().protection[KEY]?.committedVersion ?? 0) >= version,
    `version ${String(version)} to be committed`,
  );

const move = (kit, parentId) => kit.owner.getState().move(KEY, { parentId });
const location = (kit) => kit.state().locations[KEY];
const standing = (kit) => kit.owner.getState().standingFor(KEY);

/** Fire only the reconciliation retry, leaving any flush deadline armed. */
const fireRetry = (kit) => {
  for (const [handle, timer] of [...kit.timers]) {
    if (timer.ms !== RETRY_MS) continue;
    kit.timers.delete(handle);
    timer.run();
  }
};

const retryArmed = (kit) => [...kit.timers.values()].some((timer) => timer.ms === RETRY_MS);

/** A move whose answer is lost after the server applied it (`applied`) or without it (`!applied`). */
const lostMove = async (kit, parentId, { applied = true } = {}) => {
  if (applied) kit.server.lose = true;
  else kit.server.moveFailure = clientFailure('transport', null, 'unknown');

  assert.deepEqual(await move(kit, parentId), { kind: 'unconfirmed' });
  assert.equal(kit.record(KEY).inflight?.kind, 'move', 'the move is left in flight');
};

/** A deferred promise, for holding a store transition open. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
};

describe('moving', () => {
  it('moves under a new parent, keeping the slug and advancing only the base revision', async () => {
    const kit = await opened();
    const before = kit.record(KEY);

    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 }, 'seeded from the open');
    assert.deepEqual(await move(kit, 9), { kind: 'moved', parentId: 9 });

    assert.deepEqual(kit.server.moves, [
      { target: { id: 42 }, revision: 1, destination: { parent: { id: 9 } } },
    ]);

    const record = kit.record(KEY);

    assert.equal(record.inflight, null);
    assert.equal(record.baseRevision, 2);
    assert.deepEqual(record.base, before.base, 'the base is still what this phone sent');
    assert.deepEqual(record.content, before.content);
    assert.equal(record.acknowledgedVersion, before.acknowledgedVersion);
    assert.deepEqual(location(kit), { kind: 'known', parentId: 9 });
    assert.deepEqual(standing(kit), { kind: 'synced', revision: 2 });
    assert.deepEqual(
      kit.applied,
      [{ ref: { type: 'resource', id: 42 }, activation: 1 }],
      'where things are listed changed, so it is refreshed at once',
    );

    assert.equal(await kit.owner.getState().leave(KEY), 'settled');
    assert.equal(kit.applied.length, 1, 'and not a second time on leaving');
    assert.equal(location(kit), undefined, 'the location goes with the record');
  });

  it('sends the top level as the root path, and never a slug', async () => {
    const kit = await opened({ server: serverModel({ type: 'area', kind: null, parentId: 5 }) });

    assert.deepEqual(await move(kit, null), { kind: 'moved', parentId: null });
    assert.deepEqual(kit.server.moves.at(-1).destination, { parent: { path: '/' } });

    for (const request of kit.server.moves) {
      assert.equal(Object.hasOwn(request.destination, 'slug'), false);
    }
    assert.deepEqual(kit.applied, [{ ref: { type: 'area', id: 42 }, activation: 1 }]);
  });

  it('settles pending writing on the server first, and moves from its revision', async () => {
    const kit = await opened();
    const order = [];
    const update = kit.server.update;
    const serverMove = kit.server.move;

    kit.server.update = (request) => {
      order.push('update');

      return update(request);
    };
    kit.server.move = (request) => {
      order.push('move');

      return serverMove(request);
    };

    kit.owner.getState().editFields(KEY, { title: 'written first' });
    await committed(kit, 2);

    assert.deepEqual(await move(kit, 9), { kind: 'moved', parentId: 9 });
    assert.deepEqual(order, ['update', 'move']);
    assert.equal(kit.server.moves[0].revision, 2, 'against the revision the update produced');
    assert.equal(kit.server.entity().title, 'written first');
    assert.equal(kit.record(KEY).acknowledgedVersion, 2);
  });

  it('waits for a version still being written, then sends it before the move', async () => {
    const gate = deferred();
    let holding = true;
    const kit = await opened({
      store: (real) => ({
        writeEditVersion: async (write) => {
          if (holding) await gate.promise;

          return real.writeEditVersion(write);
        },
      }),
    });

    kit.owner.getState().editFields(KEY, { title: 'slow disk' });
    await until(() => kit.state().protection[KEY].writing, 'the write to be in progress');
    assert.equal(kit.state().protection[KEY].committedVersion, 1, 'committed lags accepted');

    const moving = move(kit, 9);

    await until(() => true, 'a turn');
    assert.equal(kit.server.moves.length, 0, 'nothing moves over writing still being written');

    holding = false;
    gate.resolve();

    assert.deepEqual(await moving, { kind: 'moved', parentId: 9 });
    assert.equal(kit.server.updates.length, 1);
    assert.equal(kit.server.entity().title, 'slow disk');
  });

  it('is not sent over writing that is not settled on this phone', async () => {
    const kit = await opened({
      store: (real) => ({
        writeEditVersion: async (write) =>
          write.draftVersion === 2
            ? Promise.reject(new Error('disk full'))
            : real.writeEditVersion(write),
      }),
    });

    kit.owner.getState().editFields(KEY, { title: 'only in memory' });
    await until(() => kit.state().protection[KEY].failedWrite, 'the write to fail');

    assert.deepEqual(await move(kit, 9), { kind: 'not_sent', reason: 'unsent_writing' });
    assert.equal(kit.server.moves.length, 0);
    assert.equal(kit.record(KEY).inflight, null);
  });

  it('is not sent while the editor may hold writing nobody counted', async () => {
    const kit = await opened();

    kit.editor.unanswered();
    assert.equal((await kit.owner.getState().flush(KEY)).kind, 'unanswered');

    assert.deepEqual(await move(kit, 9), { kind: 'not_sent', reason: 'unsent_writing' });
    assert.equal(kit.server.moves.length, 0);
  });

  it('is not sent over writing that cannot reach the server, which stays owed a send', async () => {
    const kit = await opened({ sessionIsCurrent: () => true });

    kit.owner.getState().editFields(KEY, { title: 'offline' });
    await committed(kit, 2);
    kit.owner.getState().resume(KEY, { ...SESSION, usable: false });

    assert.deepEqual(await move(kit, 9), { kind: 'not_sent', reason: 'no_session' });
    assert.equal(kit.server.moves.length, 0);
    assert.ok(
      [...kit.timers.values()].some((timer) => timer.ms === 1500),
      'the unsent writing is still owed a send',
    );
  });

  it('is not sent when settling the writing loses its answer', async () => {
    const kit = await opened();

    kit.server.lose = true;
    kit.owner.getState().editFields(KEY, { title: 'lost on the way' });
    await committed(kit, 2);

    assert.deepEqual(await move(kit, 9), { kind: 'not_sent', reason: 'unconfirmed' });
    assert.equal(kit.server.moves.length, 0);
    assert.equal(kit.record(KEY).inflight?.kind, 'update', 'the update is what is in flight');
    assert.ok(retryArmed(kit), 'and it is re-read later');
  });

  it('reports a verdict the autosave earned as the autosave’s', async () => {
    const kit = await opened();

    kit.server.writeBehind({ title: 'theirs' });
    kit.owner.getState().editFields(KEY, { title: 'mine' });
    await committed(kit, 2);

    assert.deepEqual(await move(kit, 9), { kind: 'not_sent', reason: 'conflicted' });
    assert.equal(kit.server.moves.length, 0);
    assert.equal(kit.record(KEY).content.title, 'mine');
  });

  it('answers a same-location move as the server’s no-op, invalidating nothing', async () => {
    const kit = await opened();

    assert.deepEqual(await move(kit, 3), { kind: 'moved', parentId: 3 });
    assert.equal(kit.server.moves.length, 1);
    assert.equal(kit.record(KEY).inflight, null);
    assert.equal(kit.record(KEY).baseRevision, 1);
    assert.deepEqual(kit.applied, []);
    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 });
  });

  it('does not report a move when the server wrote nothing it was asked to write', async () => {
    const kit = await opened();

    // An answer this phone cannot explain: same revision, and not the requested parent.
    kit.server.moveFailure = {
      ok: true,
      value: { node: { ...kit.server.entity(), body: undefined, metadata: undefined } },
    };

    assert.deepEqual(await move(kit, 9), { kind: 'unconfirmed' });
    assert.equal(kit.record(KEY).inflight?.kind, 'move', 'kept for reconciliation');
    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 }, 'and nothing is claimed');
    assert.ok(retryArmed(kit));

    fireRetry(kit);
    await until(() => kit.record(KEY).inflight === null, 'the re-read to clear it');
    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 });
  });

  it('clears only the move on a definite refusal, leaving the writing’s standing alone', async () => {
    const kit = await opened();
    const refusal = clientFailure('api_error', 'invalid_parent', 'rejected', {
      field: 'destination',
      reason: 'cycle',
    });

    kit.server.moveFailure = refusal;

    const outcome = await move(kit, 9);

    assert.equal(outcome.kind, 'refused');
    assert.equal(outcome.failure.error.code, 'invalid_parent');
    assert.equal(kit.record(KEY).inflight, null);
    assert.equal(kit.record(KEY).syncState, 'syncing');
    assert.equal(kit.record(KEY).lastRefusal, null);
    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 });
    assert.deepEqual(kit.applied, []);
  });

  it('marks the record conflicted when the move meets a stale revision', async () => {
    const kit = await opened();

    kit.server.writeBehind({ description: 'someone else' });

    assert.deepEqual(await move(kit, 9), { kind: 'conflicted' });
    assert.equal(kit.record(KEY).syncState, 'conflicted');
    assert.equal(kit.record(KEY).inflight, null);
    assert.equal(retryArmed(kit), false);
  });

  it('refuses to discard while the move is being sent', async () => {
    const kit = await opened();

    kit.server.hold = true;

    const moving = move(kit, 9);

    await until(() => kit.server.holding() === 1, 'the move to be in the air');

    const outcome = await kit.owner.getState().discardChanges(KEY);

    assert.equal(outcome.kind, 'refused');
    assert.match(outcome.problem, /Wait for an answer/);

    kit.server.hold = false;
    kit.server.release();
    assert.equal((await moving).kind, 'moved');
  });
});

describe('a move whose answer never arrived', () => {
  it('is on disk before it is sent, and a later process reconciles it', async () => {
    const file = await temporaryFile();
    const kit = await opened({ file });

    await lostMove(kit, 9);
    assert.equal(standing(kit).kind, 'unconfirmed');
    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 }, 'nothing is guessed');

    // A different process, over the same file: only what was written down survives.
    const next = await editHarness({ file, server: kit.server });

    await next.owner.getState().initialize();
    assert.deepEqual(next.record(KEY).inflight, { kind: 'move', parentId: 9, expectsWrite: true });
    assert.equal(next.owner.getState().standingFor(KEY).kind, 'unconfirmed');

    const outcome = await next.owner.getState().open(42, SESSION);

    assert.deepEqual(outcome.location, { kind: 'known', parentId: 9 });
    assert.equal(next.server.moves.length, 1, 'reconciled rather than resent');
    assert.equal(next.record(KEY).inflight, null);
    assert.equal(next.record(KEY).baseRevision, 2);
    assert.deepEqual(next.state().locations[KEY], { kind: 'known', parentId: 9 });
  });

  it('re-reads by itself while attached, and advances the location with no sheet open', async () => {
    const kit = await opened();

    await lostMove(kit, 9);
    assert.ok(retryArmed(kit), 'a retry is armed');

    fireRetry(kit);
    await until(() => kit.record(KEY).inflight === null, 'the reconciliation');

    assert.equal(kit.record(KEY).baseRevision, 2);
    assert.deepEqual(location(kit), { kind: 'known', parentId: 9 });
    assert.deepEqual(kit.applied, [{ ref: { type: 'resource', id: 42 }, activation: 1 }]);
    assert.equal(kit.server.moves.length, 1);
  });

  it('clears the move when the server shows it never applied', async () => {
    const kit = await opened();

    await lostMove(kit, 9, { applied: false });
    fireRetry(kit);
    await until(() => kit.record(KEY).inflight === null, 'the reconciliation');

    assert.equal(kit.record(KEY).syncState, 'syncing');
    assert.equal(kit.record(KEY).baseRevision, 1);
    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 });
    assert.deepEqual(kit.applied, []);
  });

  it('calls it a conflict when someone else wrote instead', async () => {
    const kit = await opened();

    await lostMove(kit, 9, { applied: false });
    kit.server.writeBehind({ title: 'theirs' });
    fireRetry(kit);
    await until(() => kit.record(KEY).syncState === 'conflicted', 'the conflict');

    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 });
  });

  it('is waited for and reconciled by leaving', async () => {
    const kit = await opened();

    await lostMove(kit, 9);

    assert.equal(await kit.owner.getState().leave(KEY), 'settled');
    assert.equal(kit.record(KEY), null);
    assert.equal(kit.server.entity().parentId, 9);
  });

  it('cannot be judged against a location the phone never learned', async () => {
    const file = await temporaryFile();
    const kit = await opened({ file });

    kit.owner.getState().editFields(KEY, { title: 'kept' });
    await committed(kit, 2);

    const next = await editHarness({ file, server: kit.server });

    await next.owner.getState().initialize();
    next.server.getFailure = clientFailure('transport', null, 'not_applicable');

    const outcome = await next.owner.getState().open(42, SESSION);

    assert.deepEqual(outcome.location, { kind: 'unknown' });
    assert.deepEqual(await next.owner.getState().move(KEY, { parentId: 9 }), {
      kind: 'not_sent',
      reason: 'unknown_location',
    });
    assert.equal(next.server.moves.length, 0);
  });
});

/**
 * The store's own word decides an acknowledgement. A transition it did not apply, or one that rolled
 * back, leaves the move in flight for the loop to answer - the server has applied it, and this process
 * cannot say what the record holds.
 */
describe('a move acknowledgement the store did not apply', () => {
  it('answers unconfirmed, claims nothing, and reconciles later', async () => {
    let misses = 1;
    const kit = await opened({
      store: (real) => ({
        acknowledgeMove: async (...args) => {
          if (misses > 0) {
            misses -= 1;

            return { applied: false, record: (await real.listEdits()).edits[0] };
          }

          return real.acknowledgeMove(...args);
        },
      }),
    });

    assert.deepEqual(await move(kit, 9), { kind: 'unconfirmed' });
    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 });
    assert.deepEqual(kit.applied, []);
    assert.ok(retryArmed(kit));

    fireRetry(kit);
    await until(() => kit.record(KEY).inflight === null, 'the reconciliation');
    assert.deepEqual(location(kit), { kind: 'known', parentId: 9 });
    assert.equal(kit.applied.length, 1);
  });

  it('answers unconfirmed when the transition throws, and recovers on the retry', async () => {
    let failing = true;
    const kit = await opened({
      store: (real) => ({
        acknowledgeMove: async (...args) => {
          if (failing) throw new Error('disk');

          return real.acknowledgeMove(...args);
        },
      }),
    });

    assert.deepEqual(await move(kit, 9), { kind: 'unconfirmed' });
    assert.equal(kit.record(KEY).inflight?.kind, 'move');

    failing = false;
    fireRetry(kit);
    await until(() => kit.record(KEY).inflight === null, 'the reconciliation');
    assert.deepEqual(location(kit), { kind: 'known', parentId: 9 });
  });
});

/**
 * A lost move that expected no write, and a server that moved on anyway.
 *
 * That move cannot have produced a revision above the base, so the re-read has proved someone else
 * wrote - here, a body-only write that would pass every other comparison. With nothing outstanding the
 * server is adopted, atomically and under the barrier; with writing outstanding it is a conflict that
 * keeps every byte.
 */
describe('a lost no-op move under someone else’s write', () => {
  const rivalBody = (kit) =>
    kit.server.writeBehind({ body: { format: 'tiptap', value: documentWith('theirs') } });

  it('adopts the server when nothing is outstanding, with no editor attached', async () => {
    const kit = await opened({ detached: true });

    await lostMove(kit, 3);
    assert.deepEqual(kit.record(KEY).inflight, { kind: 'move', parentId: 3, expectsWrite: false });
    rivalBody(kit);

    await kit.owner.getState().open(42, SESSION);

    const record = kit.record(KEY);

    assert.equal(record.inflight, null);
    assert.equal(record.syncState, 'syncing');
    assert.equal(record.baseRevision, 2);
    assert.deepEqual(record.content.document, documentWith('theirs'));
    assert.deepEqual(record.base.document, documentWith('theirs'));
    assert.deepEqual(standing(kit), { kind: 'synced', revision: 2 });
    assert.deepEqual(location(kit), { kind: 'known', parentId: 3 });
  });

  it('adopts under its own lease when an editor is attached and answers', async () => {
    const kit = await opened();

    await lostMove(kit, 3);
    rivalBody(kit);
    kit.editor.captures(kit.record(KEY).content.document);

    fireRetry(kit);
    await until(() => kit.record(KEY).inflight === null, 'the adoption');

    assert.deepEqual(kit.record(KEY).content.document, documentWith('theirs'));
    assert.equal(kit.record(KEY).syncState, 'syncing');
    assert.equal(kit.state().protection[KEY].locked, false, 'the lease is given back');
    assert.equal(kit.editor.editable.at(-1), true);
  });

  it('changes nothing while the editor cannot say it is at rest, and asks again', async () => {
    const kit = await opened();

    await lostMove(kit, 3);
    rivalBody(kit);
    kit.editor.unanswered();

    fireRetry(kit);
    await until(() => kit.state().checking.length === 0 && retryArmed(kit), 'the retry re-armed');

    assert.equal(kit.record(KEY).inflight?.kind, 'move', 'unsettled: the move stays in flight');
    assert.equal(kit.state().protection[KEY].locked, false);
  });

  it('marks a conflict and keeps the writing when a title was written meanwhile', async () => {
    const kit = await opened();

    await lostMove(kit, 3);
    rivalBody(kit);
    kit.owner.getState().editFields(KEY, { title: 'written while unsure' });
    await committed(kit, 2);

    // The edit re-armed the record's one timer as a debounce; what it owes is still a re-read.
    kit.fire();
    await until(() => kit.record(KEY).syncState === 'conflicted', 'the conflict');

    assert.equal(kit.record(KEY).content.title, 'written while unsure');
    assert.equal(kit.record(KEY).inflight, null);
    assert.equal(retryArmed(kit), false, 'and nothing is re-armed');
  });

  it('keeps a title accepted while the reconciling read is in the air', async () => {
    const kit = await opened();

    await lostMove(kit, 3);
    rivalBody(kit);
    kit.server.hold = true;
    fireRetry(kit);
    await until(() => kit.server.holding() === 1, 'the re-read to be in the air');

    kit.owner.getState().editFields(KEY, { title: 'typed during the read' });
    await committed(kit, 2);
    kit.server.hold = false;
    kit.server.release();

    await until(() => kit.record(KEY).syncState === 'conflicted', 'the conflict');
    assert.equal(kit.record(KEY).content.title, 'typed during the read');
  });

  it('publishes nothing when the adoption rolls back, and adopts on the retry', async () => {
    let failing = true;
    const kit = await opened({
      detached: true,
      store: (real) => ({
        adoptAfterNoopMove: async (...args) => {
          if (failing) throw new Error('disk');

          return real.adoptAfterNoopMove(...args);
        },
      }),
    });

    await lostMove(kit, 3);
    rivalBody(kit);
    await kit.owner.getState().open(42, SESSION);

    assert.equal(kit.record(KEY).inflight?.kind, 'move');
    assert.equal(standing(kit).kind, 'unconfirmed');

    failing = false;
    await kit.owner.getState().open(42, SESSION);
    assert.equal(kit.record(KEY).inflight, null);
    assert.deepEqual(kit.record(KEY).content.document, documentWith('theirs'));
  });

  it('waits for a controlled exit’s flush, and then adopts under that lease', async () => {
    const kit = await opened();

    await lostMove(kit, 3);
    rivalBody(kit);
    kit.editor.holds();

    const exiting = kit.owner.getState().beginControlledExit(KEY);

    await until(() => kit.editor.barriers.length === 1, 'the exit flush to be asked');
    fireRetry(kit);
    await until(() => kit.state().checking.length === 0 && retryArmed(kit), 'an unsettled pass');
    assert.equal(
      kit.record(KEY).inflight?.kind,
      'move',
      'nothing changes under an unflushed lease',
    );

    kit.editor.answerNext({
      kind: 'captured',
      snapshot: { sessionId: 1, editSeq: 1, document: kit.record(KEY).content.document },
      unchanged: false,
    });

    const { result, release } = await exiting;

    assert.equal(result.kind, 'flushed');
    fireRetry(kit);
    await until(() => kit.record(KEY).inflight === null, 'the adoption');
    assert.equal(kit.state().protection[KEY].locked, true, 'the exit still holds its lease');

    release();
    assert.equal(kit.state().protection[KEY].locked, false);
  });

  it('defers a release requested mid-transition, and a second exit waits for it', async () => {
    const gate = deferred();
    let entered = false;
    const kit = await opened({
      store: (real) => ({
        adoptAfterNoopMove: async (...args) => {
          entered = true;
          await gate.promise;

          return real.adoptAfterNoopMove(...args);
        },
      }),
    });

    await lostMove(kit, 3);
    rivalBody(kit);
    kit.editor.captures(kit.record(KEY).content.document);

    const first = await kit.owner.getState().beginControlledExit(KEY);

    assert.equal(first.result.kind, 'flushed');
    fireRetry(kit);
    await until(() => entered, 'the adoption to be in progress');

    first.release();
    assert.equal(kit.state().protection[KEY].locked, true, 'the release waits for the transition');

    let secondStarted = false;
    const second = kit.owner
      .getState()
      .beginControlledExit(KEY)
      .then((exit) => {
        secondStarted = true;

        return exit;
      });

    await until(() => true, 'a turn');
    assert.equal(secondStarted, false, 'a second exit does not displace the protected lease');

    gate.resolve();
    await until(() => kit.record(KEY).inflight === null, 'the adoption');

    const { release } = await second;

    assert.equal(secondStarted, true);
    release();
    assert.equal(kit.state().protection[KEY].locked, false, 'and the editor is editable again');
  });

  it('releases the lease when the transition throws mid-release, and admits the next exit', async () => {
    const gate = deferred();
    let attempts = 0;
    const kit = await opened({
      store: (real) => ({
        adoptAfterNoopMove: async (...args) => {
          attempts += 1;
          if (attempts === 1) {
            await gate.promise;
            throw new Error('disk');
          }

          return real.adoptAfterNoopMove(...args);
        },
      }),
    });

    await lostMove(kit, 3);
    rivalBody(kit);
    kit.editor.captures(kit.record(KEY).content.document);

    const first = await kit.owner.getState().beginControlledExit(KEY);

    fireRetry(kit);
    await until(() => attempts === 1, 'the adoption to be in progress');
    first.release();
    gate.resolve();

    await until(() => kit.state().protection[KEY].locked === false, 'the lease to be released');
    assert.equal(kit.record(KEY).inflight?.kind, 'move');
    assert.equal(kit.editor.editable.at(-1), true);

    const next = await kit.owner.getState().beginControlledExit(KEY);

    assert.equal(next.result.kind, 'flushed');
    next.release();

    await until(() => retryArmed(kit), 'the retry');
    fireRetry(kit);
    await until(() => kit.record(KEY).inflight === null, 'the adoption on the retry');
  });

  it('leaves no tracked lease behind an exit that detached without releasing', async () => {
    const kit = await opened();

    await lostMove(kit, 3);
    rivalBody(kit);
    kit.editor.captures(kit.record(KEY).content.document);

    const exit = await kit.owner.getState().beginControlledExit(KEY);

    assert.equal(exit.result.kind, 'flushed');
    // A successful exit hands its lock to the unmount and never calls `release`.
    kit.owner.getState().detachEditor(kit.token);

    await kit.owner.getState().open(42, SESSION);

    assert.equal(kit.record(KEY).inflight, null, 'reconciled through the unattached branch');
    assert.deepEqual(kit.record(KEY).content.document, documentWith('theirs'));
  });
});

/**
 * One piece of work at a time per record. A read that predates a dispatch is not evidence about it,
 * so an open, a timer send and a move must never overlap.
 */
describe('a move beside an open and the timer', () => {
  it('makes a second open wait for a move in the air, rather than clearing it', async () => {
    const kit = await opened();

    kit.server.hold = true;

    const moving = move(kit, 9);

    await until(() => kit.server.holding() === 1, 'the move to be in the air');

    const getsBefore = kit.server.gets;
    const opening = kit.owner.getState().open(42, SESSION);

    await until(() => true, 'a turn');
    assert.equal(kit.server.gets, getsBefore, 'the open has not read yet');

    kit.server.hold = false;
    kit.server.release();

    assert.deepEqual(await moving, { kind: 'moved', parentId: 9 });

    const outcome = await opening;

    assert.deepEqual(outcome.location, { kind: 'known', parentId: 9 });
    assert.equal(kit.record(KEY).inflight, null);
    assert.equal(kit.record(KEY).syncState, 'syncing');
    assert.equal(kit.record(KEY).baseRevision, 2);
  });

  it('dispatches nothing while an open’s read is in the air, then sends in order', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { title: 'timed' });
    await committed(kit, 2);

    kit.server.hold = true;

    const opening = kit.owner.getState().open(42, SESSION);

    await until(() => kit.server.holding() === 1, 'the open’s read to be in the air');

    // The debounce fires into the open, and a move is asked for as well.
    for (const [handle, timer] of [...kit.timers]) {
      if (timer.ms !== 1500) continue;
      kit.timers.delete(handle);
      timer.run();
    }

    const moving = move(kit, 9);

    await until(() => true, 'a turn');
    assert.equal(kit.server.updates.length, 0, 'the timer sent nothing');
    assert.equal(kit.server.moves.length, 0, 'and neither did the move');

    kit.server.hold = false;
    kit.server.release();
    await opening;

    assert.deepEqual(await moving, { kind: 'moved', parentId: 9 });
    assert.equal(kit.server.updates.length, 1, 'the writing went first');
    assert.equal(kit.server.moves[0].revision, 2);
    assert.equal(kit.server.entity().title, 'timed');
    assert.equal(kit.record(KEY).inflight, null);
    assert.equal(kit.record(KEY).acknowledgedVersion, 2);
  });
});

/**
 * A send persists its envelope before it is marked as sending, so between the two the record looks
 * idle. Deleting the row in that interval would let the request leave with nothing durable behind it
 * to reconcile a lost answer, so a deletion waits its turn with the record's other work.
 */
describe('deleting a record beside a move', () => {
  /** A store whose `markEditInflight` commits, then holds its answer until released. */
  const heldMark = () => {
    const gate = deferred();
    const state = { marked: false };

    return {
      gate,
      state,
      store: (real) => ({
        markEditInflight: async (...args) => {
          const record = await real.markEditInflight(...args);

          state.marked = true;
          await gate.promise;

          return record;
        },
      }),
    };
  };

  /** Record what is durably stored at the moment each request leaves the phone. */
  const recordAtDispatch = (kit, method) => {
    const seen = [];
    const send = kit.server[method];

    kit.server[method] = async (request) => {
      seen.push((await kit.store.listEdits()).edits[0]?.inflight ?? null);

      return send(request);
    };

    return seen;
  };

  it('makes a discard wait for a move whose intent is persisted but not yet sent', async () => {
    const held = heldMark();
    const kit = await opened({ store: held.store });
    const seen = recordAtDispatch(kit, 'move');

    const moving = move(kit, 9);

    await until(() => held.state.marked, 'the move to be persisted');
    assert.equal(kit.state().sending.length, 0, 'the interval in which the record looks idle');

    let discarded = false;
    const discarding = kit.owner
      .getState()
      .discardChanges(KEY)
      .then((outcome) => {
        discarded = true;

        return outcome;
      });

    await until(() => true, 'a turn');
    assert.equal(discarded, false, 'the discard waits');

    held.gate.resolve();

    assert.deepEqual(await moving, { kind: 'moved', parentId: 9 });
    assert.deepEqual(
      seen,
      [{ kind: 'move', parentId: 9, expectsWrite: true }],
      'the move left with its intent on disk',
    );
    assert.deepEqual(await discarding, { kind: 'done' });
    assert.equal(kit.record(KEY), null, 'and the discard applied once the move was answered');
  });

  it('makes a discard wait for an autosave in the same interval', async () => {
    const held = heldMark();
    const kit = await opened({ store: held.store });
    const seen = recordAtDispatch(kit, 'update');

    kit.owner.getState().editFields(KEY, { title: 'sent before discarding' });
    await committed(kit, 2);
    kit.fire();
    await until(() => held.state.marked, 'the update to be persisted');

    const discarding = kit.owner.getState().discardChanges(KEY);

    held.gate.resolve();

    assert.deepEqual(await discarding, { kind: 'done' });
    assert.deepEqual(seen, [{ kind: 'update', envelope: { title: 'sent before discarding' } }]);
    assert.equal(kit.server.entity().title, 'sent before discarding');
  });

  it('answers leave from the record as it is after a move started in the meantime', async () => {
    const kit = await opened();

    kit.server.lose = true;
    kit.server.getFailure = clientFailure('transport', null, 'not_applicable');

    // Started in the same turn: the move takes the record's slot while leave is still resuming, so
    // leave judges the row settled before the move's intent is on disk.
    const leaving = kit.owner.getState().leave(KEY);
    const moving = move(kit, 9);

    assert.deepEqual(await moving, { kind: 'unconfirmed' });
    assert.equal(await leaving, 'unconfirmed', 'not settled: the move is still unanswered');
    assert.deepEqual(kit.record(KEY).inflight, { kind: 'move', parentId: 9, expectsWrite: true });
  });

  it('makes a move wait for leave’s deletion, and then sends nothing', async () => {
    const gate = deferred();
    let deleting = false;
    const kit = await opened({
      store: (real) => ({
        deleteEdit: async (key) => {
          deleting = true;
          await gate.promise;

          return real.deleteEdit(key);
        },
      }),
    });

    const leaving = kit.owner.getState().leave(KEY);

    await until(() => deleting, 'leave to be deleting the settled record');

    const moving = move(kit, 9);

    await until(() => true, 'a turn');
    assert.equal(kit.server.moves.length, 0);

    gate.resolve();

    assert.equal(await leaving, 'settled');
    assert.deepEqual(await moving, { kind: 'not_sent', reason: 'no_session' });
    assert.equal(kit.server.moves.length, 0, 'nothing leaves for a record that is gone');
  });
});

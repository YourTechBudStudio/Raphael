/**
 * The production collaboration, end to end, as one continuous run.
 *
 * `capture-owner.test.mjs` settles what the owner does; `unfinished.test.mjs` and
 * `composer.test.mjs` settle what the two projections say about a record. This settles the thing
 * neither can: that the same records, moving through one real owner over one real database, make the
 * bar and the cards say the right thing at each step - and that nothing in between is a second
 * opinion about what a record means.
 *
 * It is deliberately one collaboration rather than several scenarios with matching assertions. A
 * test that rebuilt the state at each step would agree with itself and prove nothing about the
 * transitions, which is where a save turns into a second note.
 *
 * What is real: the owner, the store, SQLite, `deriveStanding`, the projection and the composer
 * view. What is faked is only what a test cannot otherwise reach - the clock, the HTTP call, and an
 * editor that can be made to answer late, refuse, or not answer at all.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { composerView } from '../src/modules/capture/composer.ts';
import { pendingReceipts, unfinishedNotes } from '../src/modules/capture/unfinished.ts';
import {
  created,
  documentWith,
  failed,
  fakeEditor,
  harness,
  until,
  DESTINATION,
} from './support/capture-harness.mjs';

const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryFile = async (name) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-capture-'));
  temporaries.push(dir);

  return path.join(dir, name);
};

/** The list Home and recovery draw, derived exactly as the hooks derive it. */
const cards = (kit, connectionId = 'c1') => {
  const state = kit.owner.getState();

  return unfinishedNotes({
    drafts: state.drafts,
    attempts: state.attempts,
    unsaved: state.unsaved,
    sending: state.sending,
    connectionId,
    standingFor: state.standingFor,
  });
};

/** The bar, derived exactly as the screen derives it. */
const bar = (kit, draftId, over = {}) => {
  const state = kit.owner.getState();
  const draft = state.drafts.find((candidate) => candidate.draftId === draftId);

  return composerView({
    standing: state.standingFor(draftId),
    protection: state.protection[draftId],
    lastRejection: over.lastRejection ?? null,
    saving: state.saving.includes(draftId),
    hasContent: over.hasContent ?? true,
    hasDestination: draft?.destination != null,
    revision: draft?.serverRevision ?? null,
    hasRemainder: over.hasRemainder ?? false,
  });
};

describe('writing a note, saving it, and being told', () => {
  it('runs from an empty draft to a receipt Home can spend', async () => {
    const file = await temporaryFile('capture.db');
    const kit = await harness({ file });
    const editor = fakeEditor();

    try {
      // A draft exists before a composer could ever be opened over it. This is the persist-first
      // rule the New note control obeys: there is never a screen holding writing with nowhere to
      // keep it.
      const outcome = await kit.owner.getState().createDraft(kit.session());
      assert.equal(outcome.kind, 'created');
      const { draftId } = outcome;

      // Nothing has been written and nowhere has been chosen, so the bar offers Save and refuses it.
      assert.equal(bar(kit, draftId, { hasContent: false }).action.kind, 'save');
      assert.equal(bar(kit, draftId, { hasContent: false }).action.enabled, false);

      // The card is already in Home's leading grid: it is on this phone whatever the server does.
      assert.deepEqual(
        cards(kit).map((card) => [card.status, [...card.actions]]),
        [['draft', ['open', 'discard']]],
      );

      const token = kit.owner.getState().attachEditor(draftId, editor.port);
      kit.owner.getState().editDraft(draftId, { title: 'Field notes' });
      kit.owner.getState().snapshotAccepted(token, {
        sessionId: 1,
        editSeq: 1,
        document: documentWith('what the light did'),
      });

      await until(
        () => kit.owner.getState().protection[draftId].committedVersion >= 2,
        'the writing to reach the database',
      );
      assert.equal(kit.owner.getState().protection[draftId].failedWrite, false);

      // Opening the picker flushes first, so renderer-only writing is on this phone before a sheet
      // takes the window. Closing it without choosing changes nothing.
      editor.captures(documentWith('what the light did'));
      const beforePicker = await kit.owner.getState().flush(draftId);
      assert.equal(beforePicker.kind, 'flushed');
      assert.equal(
        kit.owner.getState().drafts.find((draft) => draft.draftId === draftId).title,
        'Field notes',
      );
      assert.equal(bar(kit, draftId).action.enabled, false, 'still nowhere to put it');

      const selected = await kit.owner
        .getState()
        .selectDestination(draftId, DESTINATION, kit.session());
      assert.equal(selected.kind, 'done');
      assert.equal(bar(kit, draftId).action.enabled, true);

      kit.respond(created({ id: 7, revision: 1, title: 'Field notes' }));
      const saved = await kit.owner.getState().save(draftId, kit.session());
      assert.equal(saved.kind, 'dispatched');

      // The creation's consequences are fenced by the activation it was made under.
      assert.deepEqual(kit.applied, [{ id: 7, activation: 1 }]);

      // The note is filed and the draft kept nothing back, so it is no longer unfinished - but its
      // row stays on disk as the guard that stops a second creation.
      assert.deepEqual(cards(kit), []);
      assert.equal(
        kit.owner.getState().drafts.find((draft) => draft.draftId === draftId).state,
        'created',
      );

      // What Home shows instead is the receipt, which is spent only once it has been shown.
      const queue = pendingReceipts(kit.owner.getState().attempts, 'c1');
      assert.equal(queue.length, 1);
      assert.deepEqual(queue[0].destination, DESTINATION);

      await kit.owner.getState().consumeReceipt(queue[0].attemptId);
      assert.deepEqual(pendingReceipts(kit.owner.getState().attempts, 'c1'), []);

      // Consumed, and the draft-level guard survives it. Ordinary Save stays refused for ever.
      assert.equal(bar(kit, draftId).action.kind, 'none');
    } finally {
      await kit.owner.getState().close();
      await kit.close();
    }
  });
});

describe('a save whose answer never arrives', () => {
  it('keeps Retry through a refusal, and reconciles in place when one works', async () => {
    const file = await temporaryFile('capture.db');
    const kit = await harness({ file });
    const editor = fakeEditor();

    try {
      const outcome = await kit.owner.getState().createDraft(kit.session());
      const { draftId } = outcome;
      const token = kit.owner.getState().attachEditor(draftId, editor.port);

      kit.owner.getState().editDraft(draftId, { title: 'Sent into the dark' });
      kit.owner.getState().snapshotAccepted(token, {
        sessionId: 1,
        editSeq: 1,
        document: documentWith('first'),
      });
      await kit.owner.getState().selectDestination(draftId, DESTINATION, kit.session());

      editor.captures(documentWith('first'));
      kit.respond(failed('unknown'));
      await kit.owner.getState().save(draftId, kit.session());

      // Unresolved, and the bar says so. The destination is frozen: the request answers for it.
      let view = bar(kit, draftId);
      assert.equal(view.action.kind, 'retry');
      assert.equal(view.destinationFrozen, true);
      assert.deepEqual(
        cards(kit).map((card) => card.status),
        ['unresolved'],
      );

      // The replay is refused. That answers for the replay, not for the first dispatch, which may
      // have committed before its own answer was lost.
      editor.captures(documentWith('first'));
      kit.respond(failed('rejected', 'invalid_input'));
      const refusedRetry = await kit.owner.getState().retry(draftId, kit.session());
      assert.equal(refusedRetry.kind, 'done');

      view = bar(kit, draftId);
      assert.equal(view.action.kind, 'retry', 'a refused replay never restores ordinary Save');
      assert.notEqual(view.action.kind, 'save');
      assert.deepEqual(
        cards(kit).map((card) => card.status),
        ['unresolved'],
      );

      // Writing continues while it is unresolved, and that newer writing is protected here.
      kit.owner.getState().snapshotAccepted(token, {
        sessionId: 1,
        editSeq: 2,
        document: documentWith('second, written while waiting'),
      });
      await until(
        () => kit.owner.getState().protection[draftId].committedVersion >= 3,
        'the newer writing to be protected',
      );

      // The replay finally works. The lock cannot be taken cleanly over writing the editor is still
      // holding newer than the submitted version, so the retain branch runs and nothing is cleared.
      editor.captures(documentWith('second, written while waiting'));
      kit.respond(created({ id: 9, revision: 1, title: 'Sent into the dark' }));
      const worked = await kit.owner.getState().retry(draftId, kit.session());
      assert.equal(worked.kind, 'done');

      const draft = kit.owner.getState().drafts.find((candidate) => candidate.draftId === draftId);
      assert.equal(draft.state, 'created');
      assert.equal(draft.serverNodeId, 9);

      // Reconciled in place: the status flips and there is no action, because this slice has no
      // update operation. The newer writing is retained and reachable, never silently dropped.
      view = bar(kit, draftId, { hasRemainder: true });
      assert.equal(view.action.kind, 'none');
      assert.ok(view.status.text.includes('revision 1'));

      const remainder = cards(kit);
      assert.equal(remainder.length, 1);
      assert.equal(remainder[0].status, 'remainder');
      assert.ok(remainder[0].actions.includes('copy'), 'copying is the way forward until #4');
    } finally {
      await kit.owner.getState().close();
      await kit.close();
    }
  });
});

describe('repairing a change and discarding a note are different acts', () => {
  it('leaves the note behind one and removes it behind the other, keeping the evidence', async () => {
    const file = await temporaryFile('capture.db');
    const kit = await harness({ file });
    const editor = fakeEditor();

    try {
      const { draftId } = await createReady(kit);
      const token = kit.owner.getState().attachEditor(draftId, editor.port);

      // A save that was sent and never answered. This is the evidence a discard must not erase.
      editor.captures(documentWith('written'));
      kit.respond(failed('unknown'));
      await kit.owner.getState().save(draftId, kit.session());

      // The next local write fails, so the writing on screen is unprotected.
      kit.faults.writeVersion = 'the phone could not write it';
      kit.owner.getState().snapshotAccepted(token, {
        sessionId: 1,
        editSeq: 2,
        document: documentWith('written while waiting'),
      });
      await until(
        () => kit.owner.getState().protection[draftId].failedWrite,
        'the write to have failed',
      );

      // Repairing acts on the last change only. The note is still here afterwards.
      delete kit.faults.writeVersion;
      editor.captures(documentWith('written while waiting'));
      const repaired = await kit.owner.getState().flush(draftId);
      assert.equal(repaired.kind, 'flushed');
      assert.equal(kit.owner.getState().protection[draftId].failedWrite, false);
      assert.ok(
        kit.owner.getState().drafts.some((draft) => draft.draftId === draftId),
        'repairing a change does not delete a note',
      );

      // Discarding deletes the note - and keeps the record of the question that was asked, because
      // throwing writing away cannot un-ask it.
      kit.owner.getState().detachEditor(token);
      const discarded = await kit.owner.getState().discardDraft(draftId);
      assert.equal(discarded.kind, 'done');
      assert.equal(
        kit.owner.getState().drafts.some((draft) => draft.draftId === draftId),
        false,
      );

      const orphan = cards(kit);
      assert.equal(orphan.length, 1);
      assert.equal(orphan[0].draftId, null, 'what survives is the attempt, not the writing');
      assert.equal(orphan[0].status, 'unresolved_withdrawn');
    } finally {
      await kit.owner.getState().close();
      await kit.close();
    }
  });
});

describe('a success this phone could not write down', () => {
  it('is reported as the success it is, and offers only the local write again', async () => {
    const file = await temporaryFile('capture.db');
    const kit = await harness({ file });

    try {
      const { draftId } = await createReady(kit);

      kit.faults.acknowledge = 'the acknowledgement could not be written';
      kit.respond(created({ id: 11, revision: 1, title: 'A note' }));
      await kit.owner.getState().save(draftId, kit.session());

      const view = bar(kit, draftId);
      assert.equal(view.action.kind, 'record_again');

      const [card] = cards(kit);
      assert.equal(card.status, 'unrecorded_success');
      assert.ok(card.actions.includes('record_again'));
      assert.ok(
        !card.actions.includes('copy'),
        'a second creation is never offered as a repair for local storage',
      );
      assert.deepEqual(card.server, { id: 11, revision: 1 });

      // The repair is the local write, and once it lands the note is filed like any other.
      delete kit.faults.acknowledge;
      const recorded = await kit.owner.getState().saveAcknowledgement(card.attemptId);
      assert.equal(recorded.kind, 'done');
      assert.equal(bar(kit, draftId).action.kind, 'none');
    } finally {
      await kit.owner.getState().close();
      await kit.close();
    }
  });
});

describe('opening the destination picker', () => {
  it('takes a locked flush, and does not cover a live editor when one fails', async () => {
    const file = await temporaryFile('capture.db');
    const kit = await harness({ file });
    const editor = fakeEditor();

    try {
      const outcome = await kit.owner.getState().createDraft(kit.session());
      const { draftId } = outcome;
      const token = kit.owner.getState().attachEditor(draftId, editor.port);

      kit.owner.getState().editDraft(draftId, { title: 'Where does this go' });
      kit.owner.getState().snapshotAccepted(token, {
        sessionId: 1,
        editSeq: 1,
        document: documentWith('first'),
      });

      // The renderer will not hand its document over. The sheet must not open over it: the only
      // copy of what is on screen is in the editor, and a sheet would hide both the unprotected
      // status and the repair.
      editor.refuses('too_large');
      const refused = await kit.owner.getState().beginControlledExit(draftId);

      assert.equal(refused.result.kind, 'refused');
      refused.release();
      assert.equal(
        kit.owner.getState().protection[draftId].locked,
        false,
        'and the lock goes back',
      );

      // With a renderer that answers, the flush lands and the lock is held while the sheet is up,
      // so nothing can change under the version it just committed.
      editor.captures(documentWith('first'));
      const opened = await kit.owner.getState().beginControlledExit(draftId);

      assert.equal(opened.result.kind, 'flushed');
      assert.equal(kit.owner.getState().protection[draftId].locked, true);
      assert.deepEqual(
        editor.barriers.map((barrier) => barrier.lock),
        [true, true],
        'both asked for the lock, unlike a background flush',
      );

      // Closing the sheet gives the editor back, whichever way it was left.
      opened.release();
      assert.equal(kit.owner.getState().protection[draftId].locked, false);
      assert.equal(editor.editable.at(-1), true);
    } finally {
      await kit.owner.getState().close();
      await kit.close();
    }
  });
});

describe('a receipt this phone could not spend', () => {
  it('keeps the success recoverable, dispatches nothing, and can be spent later', async () => {
    const file = await temporaryFile('capture.db');
    const kit = await harness({ file });

    try {
      const { draftId } = await createReady(kit);

      kit.respond(created({ id: 21, revision: 1, title: 'A note' }));
      await kit.owner.getState().save(draftId, kit.session());

      const [receipt] = pendingReceipts(kit.owner.getState().attempts, 'c1');
      assert.ok(receipt !== undefined);

      // Showing it worked; removing the spent row did not.
      kit.faults.removeAttempt = 'the row could not be removed';
      await kit.owner.getState().consumeReceipt(receipt.attemptId);

      // Cleanup that fails leaves a recoverable acknowledged row, which is the safe direction.
      assert.deepEqual(
        pendingReceipts(kit.owner.getState().attempts, 'c1').map((held) => held.attemptId),
        [receipt.attemptId],
      );

      // And none of it reopens the question. The draft-level guard survives receipt consumption by
      // design, so ordinary Save stays refused whether the row went or not.
      const draft = kit.owner.getState().drafts.find((candidate) => candidate.draftId === draftId);
      assert.equal(draft.state, 'created');
      assert.equal(draft.serverNodeId, 21);
      assert.equal(bar(kit, draftId).action.kind, 'none');
      assert.deepEqual(cards(kit), [], 'a created note with nothing left is still not unfinished');

      // Nothing was sent to repair local storage: the only dispatch in this test is the first one.
      assert.deepEqual(kit.applied, [{ id: 21, activation: 1 }]);

      delete kit.faults.removeAttempt;
      await kit.owner.getState().consumeReceipt(receipt.attemptId);
      assert.deepEqual(pendingReceipts(kit.owner.getState().attempts, 'c1'), []);
    } finally {
      await kit.owner.getState().close();
      await kit.close();
    }
  });
});

describe('a Retry the renderer will not hand its document to', () => {
  it('still replays the frozen bytes, and never turns the refusal into an ordinary Save', async () => {
    const file = await temporaryFile('capture.db');
    const kit = await harness({ file });
    const editor = fakeEditor();

    try {
      const outcome = await kit.owner.getState().createDraft(kit.session());
      const { draftId } = outcome;
      const token = kit.owner.getState().attachEditor(draftId, editor.port);

      kit.owner.getState().editDraft(draftId, { title: 'Sent into the dark' });
      kit.owner.getState().snapshotAccepted(token, {
        sessionId: 1,
        editSeq: 1,
        document: documentWith('first'),
      });
      await kit.owner.getState().selectDestination(draftId, DESTINATION, kit.session());

      editor.captures(documentWith('first'));
      kit.respond(failed('unknown'));
      await kit.owner.getState().save(draftId, kit.session());

      const frozen = kit.owner.getState().attempts[0];
      assert.equal(frozen.state, 'uncertain');

      // The renderer now refuses to hand anything over. Native does not have what is on screen.
      editor.refuses('too_large');

      const replayed = [];
      kit.respond((request) => {
        replayed.push(request);

        return created({ id: 31, revision: 1, title: 'Sent into the dark' });
      });

      const retried = await kit.owner.getState().retry(draftId, kit.session());
      assert.equal(retried.kind, 'done', 'a refused flush does not block resolving an attempt');

      // The frozen bytes and the original key, never whatever the fields hold now.
      assert.equal(replayed.length, 1);
      assert.deepEqual(replayed[0], JSON.parse(frozen.request));

      // The refusal is a fact about the renderer, not about the request: the attempt resolved, and
      // nothing minted a fresh key or turned this into a new creation.
      assert.equal(kit.owner.getState().attempts.length, 1);
      assert.equal(kit.owner.getState().attempts[0].attemptId, frozen.attemptId);

      const draft = kit.owner.getState().drafts.find((candidate) => candidate.draftId === draftId);
      assert.equal(draft.state, 'created');
      assert.equal(draft.serverNodeId, 31);

      // Renderer-only writing is neither reported as kept nor cleared: the lease never got a
      // version, so the acknowledgement took the retain branch.
      const protection = kit.owner.getState().protection[draftId];
      assert.equal(protection.rendererUnknown, true);
      assert.ok(draft.title !== '', 'the retain branch kept what was written');

      // The editor is still usable, which is what the repair needs.
      assert.equal(editor.editable.at(-1), true);
      assert.equal(bar(kit, draftId, { hasRemainder: true }).action.kind, 'none');
    } finally {
      await kit.owner.getState().close();
      await kit.close();
    }
  });
});

describe('a connection the app has moved on from', () => {
  it('still records a late answer, and cannot reach the current app with it', async () => {
    const file = await temporaryFile('capture.db');
    const kit = await harness({ file });

    try {
      const { draftId } = await createReady(kit);

      // The request leaves, and the connection is retired while it is in the air.
      let answer;
      kit.respond(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      const dispatched = kit.owner.getState().save(draftId, kit.session());
      await until(() => kit.owner.getState().sending.length === 1, 'the request to be in flight');

      kit.retireActivation();
      answer(created({ id: 13, revision: 1, title: 'A note' }));
      await dispatched;

      // The answer resolved its own attempt - it is evidence about something that may already have
      // reached a server - and the cache was still told under the activation it was made with, so
      // nothing it did can reach the connection the app is on now.
      const draft = kit.owner.getState().drafts.find((candidate) => candidate.draftId === draftId);
      assert.equal(draft.state, 'created');
      assert.deepEqual(kit.applied, [{ id: 13, activation: 1 }]);

      // Nothing new may be started under the session that is gone.
      const refused = await kit.owner.getState().createDraft(kit.session({ activation: 1 }));
      assert.equal(refused.kind, 'refused');

      // And the work filed under it is recovery's, under its own heading, offering only what needs
      // no server.
      const elsewhere = cards(kit, 'another-connection');
      for (const card of elsewhere) {
        assert.equal(card.scope, 'retired');
        assert.deepEqual([...card.actions], ['copy', 'discard']);
      }
    } finally {
      await kit.owner.getState().close();
      await kit.close();
    }
  });
});

describe('what a restart finds', () => {
  it('adopts an interrupted dispatch as uncertain and keeps every card it had', async () => {
    const file = await temporaryFile('capture.db');
    const first = await harness({ file });

    try {
      const { draftId } = await createReady(first);

      // The process dies between writing the intent and hearing anything back.
      first.respond(() => new Promise(() => {}));
      void first.owner.getState().save(draftId, first.session());
      await until(
        () => first.owner.getState().attempts.length === 1,
        'the intent to reach the database',
      );
      await first.owner.getState().close();

      const second = await harness({ file });

      try {
        const [card] = cards(second);
        assert.equal(card.status, 'unresolved');
        assert.equal(card.draftId, draftId);

        const view = bar(second, draftId);
        assert.equal(
          view.action.kind,
          'retry',
          'the replay is what resolves it, and only on a tap',
        );
      } finally {
        await second.owner.getState().close();
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
});

/** A draft with somewhere to go and something in it, without an editor attached. */
const createReady = async (kit) => {
  const outcome = await kit.owner.getState().createDraft(kit.session());

  assert.equal(outcome.kind, 'created');
  const { draftId } = outcome;

  kit.owner.getState().editDraft(draftId, { title: 'A note' });
  const selected = await kit.owner
    .getState()
    .selectDestination(draftId, DESTINATION, kit.session());

  assert.equal(selected.kind, 'done');

  return { draftId };
};

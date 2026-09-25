/**
 * The capture owner, driven through its ports against real SQLite.
 *
 * The happy path is the least of it. What is pinned here is that a logical creation survives every
 * individually definite failure that can follow it, that nothing is ever sent before it is written
 * down, and that consumed writing is cleared only when both the owner's own knowledge and the
 * acknowledgement transaction agree that nothing newer exists.
 *
 * Storage is genuine - the same schema, the same constraints, real transactions - so a claim about
 * what survives a restart is made by restarting. What is substituted is the clock, the flush
 * deadline's timer, the HTTP call and the editor, because none of those races is otherwise
 * reachable. The `expo-sqlite` binding and a real device remain outside every automated test here.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { TITLE_MAX_CODE_POINTS } from '@raphael/contracts/nodes';

import { RETRY_WINDOW_MS } from '../src/modules/capture/policy.ts';
import {
  created,
  DESTINATION,
  documentWith,
  entity,
  fakeEditor,
  failed,
  harness,
  readyDraft,
  T0,
  tick,
  until,
} from './support/capture-harness.mjs';
import { openNodeDatabase } from './support/node-sqlite.mjs';

const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryFile = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-capture-owner-'));
  temporaries.push(dir);

  return path.join(dir, 'capture.db');
};

const draftOf = (kit, draftId) =>
  kit.owner.getState().drafts.find((draft) => draft.draftId === draftId);
const attemptsOf = (kit, draftId) =>
  kit.owner.getState().attempts.filter((attempt) => attempt.draftId === draftId);

describe('protecting what is written', () => {
  it('bumps one counter for every authored field, and reports only what is committed', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId, token } = await readyDraft(kit, editor);

    kit.owner.getState().editDraft(draftId, { title: 'A title' });
    kit.owner.getState().editDraft(draftId, { description: 'why' });
    editor.captures(documentWith('body'));
    await kit.owner.getState().flush(draftId);

    const protection = kit.owner.getState().protection[draftId];

    // Created at 1, a destination at 2, a title at 3, a description at 4, a body snapshot at 5. A
    // title edit is protected exactly like a body edit, which is why the counter is not the
    // editor's.
    assert.equal(protection.latestAcceptedVersion, 5);
    assert.equal(protection.committedVersion, 5);
    assert.equal(draftOf(kit, draftId).title, 'A title');
    assert.equal(draftOf(kit, draftId).document.content[0].content[0].text, 'body');
    assert.ok(token !== null);

    await kit.close();
  });

  /**
   * Tags are authored content, and the same counter answers for them.
   *
   * The details sheet commits on Done and rebuilds its array each time, so the no-op case is the
   * ordinary one: opening the sheet and pressing Done over an unchanged list must not bump a version,
   * write a row, or make the bar say anything. `sameTags` is what decides it, and identity would get
   * it wrong on the one authored field that is not a string.
   */
  it('counts a tag change like any other authored field, and a tag no-op not at all', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    const version = () => kit.owner.getState().protection[draftId].latestAcceptedVersion;
    // Created at 1, a destination at 2.
    const before = version();

    // A new note starts with no tags, and that is a list rather than an absence: every later
    // comparison and the frozen request itself are written against a real array.
    assert.deepEqual(draftOf(kit, draftId).tags, []);

    kit.owner.getState().editDraft(draftId, { tags: ['sync'] });

    assert.equal(version(), before + 1);

    // The same list, a new array - exactly what Done hands over when nothing was changed.
    kit.owner.getState().editDraft(draftId, { tags: ['sync'] });

    assert.equal(version(), before + 1, 'an equal list is not a change');

    // Order is significant, because the frozen bytes are.
    kit.owner.getState().editDraft(draftId, { tags: ['sync', 'design'] });

    assert.equal(version(), before + 2);

    // The barrier is what folds the accepted versions into the row, exactly as it does for a title.
    editor.captures(documentWith('body'));
    await kit.owner.getState().flush(draftId);

    assert.deepEqual(draftOf(kit, draftId).tags, ['sync', 'design']);

    await kit.close();
  });

  it('coalesces snapshots rather than queueing a document per change', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId, token } = await readyDraft(kit, editor);
    const before = kit.log.filter((entry) => entry === 'writeVersion').length;
    let release;
    kit.gates.writeVersion = new Promise((resolve) => {
      release = resolve;
    });

    for (const text of ['one', 'two', 'three', 'four']) {
      kit.owner.getState().snapshotAccepted(token, {
        sessionId: 1,
        editSeq: (editor.state.seq += 1),
        document: documentWith(text),
      });
    }
    await tick();
    release();
    kit.owner.getState().detachEditor(token);
    await kit.owner.getState().flush(draftId);

    // One write in progress and one pending slot, replaced rather than queued behind: four changes
    // never mean four full documents waiting their turn.
    assert.equal(kit.log.filter((entry) => entry === 'writeVersion').length - before, 2);
    assert.equal(draftOf(kit, draftId).document.content[0].content[0].text, 'four');

    await kit.close();
  });

  it('tells a document only the renderer has from work native accepted but could not write', async () => {
    // Two clean baselines, side by side, because these are two different sentences: one says the
    // writing exists only in the live editor, the other says native has it and this phone does not.
    const kit = await harness();
    const refusing = fakeEditor();
    const failing = fakeEditor();
    const rendererOnly = await readyDraft(kit, refusing);
    const unwritten = await readyDraft(kit, failing);

    refusing.refuses('invalid_document');
    await kit.owner.getState().flush(rendererOnly.draftId, { lock: true });

    failing.captures(documentWith('accepted but unwritten'));
    kit.faults.writeVersion = 'the disk is full';
    await kit.owner.getState().flush(unwritten.draftId, { lock: true });

    const refused = kit.owner.getState().protection[rendererOnly.draftId];
    const unpersisted = kit.owner.getState().protection[unwritten.draftId];

    // The renderer refused to hand the document over, so native holds nothing newer than what it
    // already committed - and the only copy is in the live editor.
    assert.equal(refused.rendererUnknown, true);
    assert.equal(refused.latestAcceptedVersion, refused.committedVersion);
    assert.equal(refused.failedWrite, false);

    // Native accepted this one and then could not write it. The editor answered, so nothing is
    // unknown about the renderer; what is unprotected is a version native is holding.
    assert.equal(unpersisted.rendererUnknown, false);
    assert.equal(unpersisted.latestAcceptedVersion > unpersisted.committedVersion, true);
    assert.equal(unpersisted.failedWrite, true);

    await kit.close();
  });

  it('keeps newer memory and older committed bytes distinguishable when a write fails', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);

    editor.captures(documentWith('protected'));
    await kit.owner.getState().flush(draftId);
    kit.faults.writeVersion = 'the disk is full';
    editor.captures(documentWith('in memory only'));

    const result = await kit.owner.getState().flush(draftId);
    const protection = kit.owner.getState().protection[draftId];

    assert.equal(result.kind, 'not_persisted');
    assert.equal(protection.committedVersion, 3);
    assert.equal(protection.latestAcceptedVersion, 4);
    assert.equal(protection.failedWrite, true);
    // The last committed snapshot is intact. Nothing reset, recreated, or fell back to memory.
    assert.equal(draftOf(kit, draftId).document.content[0].content[0].text, 'protected');

    await kit.close();
  });
});

describe('the attachment', () => {
  it('retires the earlier token when an editor is replaced, and a late detach removes nothing', async () => {
    const kit = await harness();
    const first = fakeEditor();
    const second = fakeEditor();
    const { draftId, token } = await readyDraft(kit, first);

    const replacement = kit.owner.getState().attachEditor(draftId, second.port);

    assert.notDeepEqual(token, replacement);
    assert.equal(
      kit.owner
        .getState()
        .snapshotAccepted(token, { sessionId: 1, editSeq: 9, document: documentWith('stale') }),
      'retired',
    );

    // A slow unmount from the retired half must not tear down its own replacement.
    kit.owner.getState().detachEditor(token);
    assert.equal(kit.owner.getState().protection[draftId].attached, true);

    assert.equal(
      kit.owner.getState().snapshotAccepted(replacement, {
        sessionId: 1,
        editSeq: 1,
        document: documentWith('live'),
      }),
      'accepted',
    );

    kit.owner.getState().detachEditor(replacement);
    assert.equal(kit.owner.getState().protection[draftId].attached, false);

    await kit.close();
  });

  it('confirms a snapshot that says nothing new without inventing a version', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId, token } = await readyDraft(kit, editor);
    const document = documentWith('same');

    assert.equal(
      kit.owner.getState().snapshotAccepted(token, { sessionId: 1, editSeq: 1, document }),
      'accepted',
    );
    // A requested snapshot equal to the last accepted sequence confirms the barrier and nothing more.
    assert.equal(
      kit.owner.getState().snapshotAccepted(token, { sessionId: 1, editSeq: 1, document }),
      'unchanged',
    );
    // And so does an identical document under a later sequence.
    assert.equal(
      kit.owner.getState().snapshotAccepted(token, { sessionId: 1, editSeq: 2, document }),
      'unchanged',
    );
    await kit.owner.getState().flush(draftId);

    // Created at 1, a destination at 2, the one genuinely new document at 3. The two confirmations
    // added nothing.
    assert.equal(kit.owner.getState().protection[draftId].latestAcceptedVersion, 3);

    await kit.close();
  });

  it('accepts the first snapshot of a restarted renderer, whose sequence begins again', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId, token } = await readyDraft(kit, editor);

    kit.owner
      .getState()
      .snapshotAccepted(token, { sessionId: 1, editSeq: 7, document: documentWith('before') });

    assert.equal(
      kit.owner
        .getState()
        .snapshotAccepted(token, { sessionId: 2, editSeq: 1, document: documentWith('after') }),
      'accepted',
    );
    // Detached first, so the flush commits what the owner holds rather than asking an editor that
    // has nothing new to say.
    kit.owner.getState().detachEditor(token);
    await kit.owner.getState().flush(draftId);
    assert.equal(draftOf(kit, draftId).document.content[0].content[0].text, 'after');

    await kit.close();
  });
});

describe('the flush barrier', () => {
  it('distinguishes no editor at all from one that does not answer', async () => {
    const kit = await harness();
    const { draftId } = await readyDraft(kit);

    const withoutEditor = await kit.owner.getState().flush(draftId);

    // Nothing renderer-only can exist to lose, and the outcome says which of the two this was.
    assert.deepEqual(withoutEditor, { kind: 'flushed', version: 2, captured: 'no_editor' });

    const editor = fakeEditor();
    kit.owner.getState().attachEditor(draftId, editor.port);
    editor.unanswered();

    assert.deepEqual(await kit.owner.getState().flush(draftId), { kind: 'unanswered' });
    assert.equal(kit.owner.getState().protection[draftId].rendererUnknown, true);

    await kit.close();
  });

  it('ends a barrier the editor never answers at all', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.hangs();

    const pending = kit.owner.getState().flush(draftId, { lock: true });
    await tick();
    kit.fireTimers();

    // A renderer that is gone must not hold a caller open with the editor locked forever.
    assert.deepEqual(await pending, { kind: 'unanswered' });

    await kit.close();
  });

  it('reports a refusal without repairing, dropping, or calling it saved', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.refuses('invalid_document');

    const result = await kit.owner.getState().flush(draftId, { lock: true });

    assert.deepEqual(result, { kind: 'refused', code: 'invalid_document' });
    assert.equal(kit.owner.getState().protection[draftId].rendererUnknown, true);

    await kit.close();
  });

  it('never answers a locking caller with a barrier someone else took unlocked', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.holds();

    const unlocked = kit.owner.getState().flush(draftId);
    const locked = kit.owner.getState().flush(draftId, { lock: true });
    await tick();

    // The second call waits rather than sharing the first: the point of locking first is that no
    // edit can be generated between the capture and the commit, and sharing a barrier taken without
    // a lock would report a version taken with that window wide open.
    assert.equal(editor.barriers.length, 1);

    editor.answerNext({
      kind: 'captured',
      snapshot: { sessionId: 1, editSeq: 1, document: documentWith('unlocked') },
      unchanged: false,
    });
    assert.equal((await unlocked).kind, 'flushed');
    await until(() => editor.barriers.length === 2, 'the locking barrier to be taken');

    assert.deepEqual(editor.barriers[1], { lock: true });

    editor.answerNext({
      kind: 'captured',
      snapshot: { sessionId: 1, editSeq: 2, document: documentWith('locked') },
      unchanged: false,
    });
    assert.equal((await locked).kind, 'flushed');

    await kit.close();
  });

  it('locks first when asked, so nothing can change under the barrier', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('locked'));

    await kit.owner.getState().flush(draftId, { lock: true });

    assert.deepEqual(editor.barriers.at(-1), { lock: true });

    await kit.close();
  });
});

describe('controlled navigation', () => {
  it('holds its lock from capture until the route goes, and gives it back if cancelled', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId, token } = await readyDraft(kit, editor);
    editor.captures(documentWith('the last word'));

    const exit = await kit.owner.getState().beginControlledExit(draftId);

    assert.equal(exit.result.kind, 'flushed');
    // Held: an unlocked flush here captures V, the person types W while the commit runs, V commits,
    // the route unmounts, and W dies with the editor.
    assert.equal(kit.owner.getState().protection[draftId].locked, true);

    exit.release();
    assert.equal(kit.owner.getState().protection[draftId].locked, false);
    assert.equal(editor.editable.at(-1), true);

    kit.owner.getState().detachEditor(token);

    await kit.close();
  });

  it('releases the lock when the flush fails, so the route stays usable', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.refuses('composing');

    const exit = await kit.owner.getState().beginControlledExit(draftId);

    assert.equal(exit.result.kind, 'refused');
    // The editor is left live, editable and unlocked so the document can be brought back into
    // range: undo, editing it down, or discarding explicitly.
    assert.equal(kit.owner.getState().protection[draftId].locked, false);
    assert.equal(editor.editable.at(-1), true);

    await kit.close();
  });
});

describe('Save', () => {
  it('persists the intent before it sends anything', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('sent'));
    kit.respond(created());

    const outcome = await kit.owner.getState().save(draftId, kit.session());

    assert.equal(outcome.kind, 'dispatched');
    const order = kit.log.filter((entry) => entry === 'insertIntent' || entry === 'acknowledge');
    assert.deepEqual(order, ['insertIntent', 'acknowledge']);

    await kit.close();
  });

  it('dispatches nothing when the intent cannot be written', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('never sent'));
    kit.faults.insertIntent = 'the disk is full';

    const outcome = await kit.owner.getState().save(draftId, kit.session());

    assert.equal(outcome.kind, 'not_saved');
    assert.equal(outcome.reason, 'not_recorded');
    assert.equal(attemptsOf(kit, draftId).length, 0);

    await kit.close();
  });

  it('admits exactly one of two concurrent presses', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('once'));
    kit.respond(created());

    const [first, second] = await Promise.all([
      kit.owner.getState().save(draftId, kit.session()),
      kit.owner.getState().save(draftId, kit.session()),
    ]);
    const outcomes = [first.kind, second.kind].sort();

    // A disabled button is a hint; the in-flight set added in the same synchronous turn is the
    // invariant.
    assert.deepEqual(outcomes, ['dispatched', 'not_saved']);
    assert.equal(attemptsOf(kit, draftId).length, 1);

    await kit.close();
  });

  it('ends without dispatching on every flush outcome that is not a commit', async () => {
    for (const [prepare, reason] of [
      [(editor) => editor.unanswered(), 'editor_unanswered'],
      [(editor) => editor.refuses('invalid_document'), 'editor_refused'],
    ]) {
      const kit = await harness();
      const editor = fakeEditor();
      const { draftId } = await readyDraft(kit, editor);
      prepare(editor);

      const outcome = await kit.owner.getState().save(draftId, kit.session());

      assert.equal(outcome.reason, reason);
      assert.equal(attemptsOf(kit, draftId).length, 0);
      // Every one of these exits releases the admission entry and the lock, so a corrected Save
      // works without remounting the route.
      assert.deepEqual(kit.owner.getState().saving, []);
      assert.equal(kit.owner.getState().protection[draftId].locked, false);
      assert.equal(editor.editable.at(-1), true);

      editor.captures(documentWith('second time'));
      kit.respond(created());
      assert.equal((await kit.owner.getState().save(draftId, kit.session())).kind, 'dispatched');

      await kit.close();
    }
  });

  it('ends without dispatching when the snapshot cannot be written', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('unprotected'));
    kit.faults.writeVersion = 'the disk is full';

    const outcome = await kit.owner.getState().save(draftId, kit.session());

    assert.equal(outcome.reason, 'not_recorded');
    assert.equal(attemptsOf(kit, draftId).length, 0);
    assert.deepEqual(kit.owner.getState().saving, []);

    await kit.close();
  });

  it('refuses without a destination, without a usable connection, and against another server', async () => {
    const kit = await harness();
    const outcome = await kit.owner.getState().createDraft(kit.session());
    const draftId = outcome.draftId;

    assert.equal(
      (await kit.owner.getState().save(draftId, kit.session())).reason,
      'no_destination',
    );

    await kit.owner.getState().selectDestination(draftId, DESTINATION, kit.session());

    assert.equal(
      (await kit.owner.getState().save(draftId, kit.session({ usable: false }))).reason,
      'no_connection',
    );
    // An endpoint string is identification only; a durable connection id is what decides this.
    assert.equal(
      (await kit.owner.getState().save(draftId, kit.session({ connectionId: 'c2' }))).reason,
      'wrong_connection',
    );
    assert.equal(attemptsOf(kit, draftId).length, 0);

    await kit.close();
  });

  it('never persists a destination chosen against a different connection', async () => {
    const kit = await harness();
    const { draftId } = await readyDraft(kit);

    const refused = await kit.owner
      .getState()
      .selectDestination(draftId, { type: 'project', id: 99 }, kit.session({ connectionId: 'c2' }));

    assert.equal(refused.kind, 'refused');
    assert.deepEqual(draftOf(kit, draftId).destination, DESTINATION);

    await kit.close();
  });
});

describe('a Save the request cannot be built for', () => {
  it('sends nothing, gives everything back, and lets a corrected Save through', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    // Past the contract's own bound, which is a perfectly ordinary thing to paste into a title.
    kit.owner.getState().editDraft(draftId, { title: 'x'.repeat(TITLE_MAX_CODE_POINTS + 1) });
    editor.captures(documentWith('written'));

    const refused = await kit.owner.getState().save(draftId, kit.session());

    assert.equal(refused.kind, 'not_saved');
    assert.equal(refused.reason, 'not_recorded');
    assert.match(refused.problem, /too long/);
    // Nothing was persisted and nothing was sent: the freeze happens before the intent write.
    assert.equal(attemptsOf(kit, draftId).length, 0);
    assert.equal(draftOf(kit, draftId).state, 'composing');
    assert.equal(draftOf(kit, draftId).submittedVersion, null);
    // The lock and the admission entry both came back, which is what makes the next press possible
    // without remounting the route.
    assert.deepEqual(kit.owner.getState().saving, []);
    assert.equal(kit.owner.getState().protection[draftId].locked, false);
    assert.equal(editor.editable.at(-1), true);

    // Pressing again with the same title is still refused - the input is what is wrong.
    editor.captures(documentWith('written'));
    assert.equal((await kit.owner.getState().save(draftId, kit.session())).reason, 'not_recorded');
    assert.equal(attemptsOf(kit, draftId).length, 0);

    kit.owner.getState().editDraft(draftId, { title: 'Short enough' });
    editor.captures(documentWith('written'));
    kit.respond(created());

    assert.equal((await kit.owner.getState().save(draftId, kit.session())).kind, 'dispatched');
    assert.equal(attemptsOf(kit, draftId)[0].title, 'Short enough');

    await kit.close();
  });
});

describe('a session the app has moved on from', () => {
  it('cannot start any new work, however usable it still claims to be', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    // A callback holding the session from before a credential rotation: same server, same
    // connection id, and a transport the server has stopped accepting.
    const stale = kit.session();
    kit.retireActivation();

    assert.equal(stale.usable, true);
    assert.equal(stale.connectionId, kit.session().connectionId);
    assert.notEqual(stale.activation, kit.session().activation);

    editor.captures(documentWith('under a retired activation'));
    const saved = await kit.owner.getState().save(draftId, stale);

    assert.equal(saved.reason, 'retired_connection');
    assert.equal(attemptsOf(kit, draftId).length, 0);
    // The route unmounting is not what stops this: the owner refuses it.
    assert.equal((await kit.owner.getState().createDraft(stale)).kind, 'refused');
    assert.equal((await kit.owner.getState().copyDraft(draftId, stale)).kind, 'refused');
    assert.equal(
      (await kit.owner.getState().selectDestination(draftId, { type: 'area', id: 9 }, stale)).kind,
      'refused',
    );
    assert.equal(draftOf(kit, draftId).destination.id, DESTINATION.id);

    // And the current session still works, so this is a fence rather than a shutdown.
    editor.captures(documentWith('under the live one'));
    kit.respond(created());
    assert.equal((await kit.owner.getState().save(draftId, kit.session())).kind, 'dispatched');

    await kit.close();
  });

  it('refuses a replay under a retired activation but still resolves one already sent', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('dispatched before the change'));

    let answer;
    kit.respond(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const saving = kit.owner.getState().save(draftId, kit.session());
    await until(() => kit.owner.getState().sending.length === 1, 'the request to be in flight');

    const during = kit.session();
    kit.retireActivation();
    answer(created());
    await saving;

    // A response to a request already in flight still resolves its own attempt: that attempt is
    // evidence about something that may already have reached a server. What it may not do is seed a
    // cache, which `applyCreation` fences on the activation it was made under.
    assert.equal(attemptsOf(kit, draftId)[0].state, 'acknowledged');
    assert.equal(draftOf(kit, draftId).serverNodeId, 42);
    assert.deepEqual(kit.applied, [{ id: 42, activation: during.activation }]);

    await kit.close();
  });

  it('refuses a replay of an unresolved attempt under a retired activation', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('unresolved'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    const stale = kit.session();
    kit.retireActivation();

    assert.equal((await kit.owner.getState().retry(draftId, stale)).kind, 'refused');
    // Nothing was sent and the evidence is untouched, so the replay is still there for the live one.
    assert.equal(attemptsOf(kit, draftId)[0].state, 'uncertain');
    assert.equal(kit.owner.getState().standingFor(draftId).kind, 'retry');

    kit.respond(created());
    assert.deepEqual(await kit.owner.getState().retry(draftId, kit.session()), { kind: 'done' });

    await kit.close();
  });
});

describe('what the answer does', () => {
  it('clears consumed content when both memory and the transaction say nothing is newer', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    kit.owner.getState().editDraft(draftId, { title: 'Consumed' });
    editor.captures(documentWith('consumed'));
    kit.respond(created());

    await kit.owner.getState().save(draftId, kit.session());

    const draft = draftOf(kit, draftId);

    assert.equal(draft.state, 'created');
    assert.equal(draft.serverNodeId, 42);
    assert.equal(draft.serverRevision, 1);
    assert.equal(draft.title, '');
    assert.deepEqual(kit.applied, [{ id: 42, activation: 1 }]);

    await kit.close();
  });

  it('retains everything when a snapshot is still pending, or its write has failed', async () => {
    for (const mode of ['pending', 'failed']) {
      const kit = await harness();
      const editor = fakeEditor();
      const { draftId, token } = await readyDraft(kit, editor);
      editor.captures(documentWith('submitted'));
      kit.respond(async () => {
        // The answer arrives while writing made after the flush is still in the air. A durable
        // comparison cannot see that work, which is exactly when it is most at risk.
        if (mode === 'failed') kit.faults.writeVersion = 'the disk is full';
        kit.owner.getState().snapshotAccepted(token, {
          sessionId: 1,
          editSeq: 99,
          document: documentWith('written since'),
        });

        return created();
      });

      await kit.owner.getState().save(draftId, kit.session());

      const draft = draftOf(kit, draftId);

      // The creation and the base revision are recorded; not a byte of the newer writing is cleared.
      assert.equal(draft.state, 'created');
      assert.equal(draft.serverNodeId, 42);
      assert.notEqual(draft.document.content[0].content[0].text, '');
      assert.equal(kit.owner.getState().protection[draftId].latestAcceptedVersion > 0, true);

      await kit.close();
    }
  });

  it('reports server success and offers only the local write again when recording it fails', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('created anyway'));
    kit.faults.acknowledge = 'the disk is full';
    kit.respond(created());

    const outcome = await kit.owner.getState().save(draftId, kit.session());
    const attemptId = outcome.attemptId;

    assert.equal(kit.owner.getState().unsaved[attemptId].id, 42);
    // The creation is not reported as failed - it demonstrably was not - and what is offered is a
    // retry of the local write, never another creation.
    assert.equal(kit.owner.getState().standingFor(draftId).kind, 'record_again');

    delete kit.faults.acknowledge;
    assert.deepEqual(await kit.owner.getState().saveAcknowledgement(attemptId), { kind: 'done' });
    assert.equal(kit.owner.getState().unsaved[attemptId], undefined);
    assert.equal(draftOf(kit, draftId).serverNodeId, 42);

    await kit.close();
  });

  it('returns the draft to composing after a refusal, and admits a corrected Save under a new key', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('refused'));
    kit.respond(failed('rejected', 'slug_conflict'));

    await kit.owner.getState().save(draftId, kit.session());

    assert.equal(draftOf(kit, draftId).state, 'composing');
    const refusedAttempt = attemptsOf(kit, draftId)[0];
    assert.equal(kit.owner.getState().standingFor(draftId).kind, 'save_replacing');

    editor.captures(documentWith('corrected'));
    kit.respond(created());
    await kit.owner.getState().save(draftId, kit.session());

    const attempts = attemptsOf(kit, draftId);

    // The corrected request is a different request, so it must not reuse the key, and the refused
    // row - known to have created nothing - is replaced in the same transaction.
    assert.equal(attempts.length, 1);
    assert.notEqual(attempts[0].attemptId, refusedAttempt.attemptId);
    assert.notEqual(
      JSON.parse(attempts[0].request).idempotencyKey,
      JSON.parse(refusedAttempt.request).idempotencyKey,
    );

    await kit.close();
  });

  it('words an archived destination from the lifecycle table, and keeps the draft', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('refused'));
    kit.respond({
      ok: false,
      failure: {
        kind: 'api_error',
        error: { code: 'node_archived' },
        details: { field: 'parent', reason: 'inherited' },
        message: 'the server’s own words',
        mutationOutcome: 'rejected',
      },
    });

    await kit.owner.getState().save(draftId, kit.session());

    assert.equal(draftOf(kit, draftId).state, 'composing');
    assert.deepEqual(
      {
        code: attemptsOf(kit, draftId)[0].lastOutcome.code,
        message: attemptsOf(kit, draftId)[0].lastOutcome.message,
      },
      { code: 'node_archived', message: 'That place is archived. Pick another.' },
    );

    await kit.close();
  });

  it('refuses ordinary Save once an attempt is unresolved, and keeps refusing after a rejection', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('lost'));
    kit.respond(failed('unknown'));

    await kit.owner.getState().save(draftId, kit.session());

    assert.equal(kit.owner.getState().standingFor(draftId).kind, 'retry');
    assert.equal(draftOf(kit, draftId).state, 'composing', 'editable again while unresolved');

    const refused = await kit.owner.getState().save(draftId, kit.session());
    assert.equal(refused.reason, 'not_admitted');

    // A later definite rejection is about that replay. The creation is still unresolved, so Save
    // stays refused and no correction key is minted.
    kit.respond(failed('rejected', 'unauthorized'));
    await kit.owner.getState().retry(draftId, kit.session());

    assert.equal(attemptsOf(kit, draftId)[0].state, 'blocked');
    assert.equal(attemptsOf(kit, draftId)[0].firstUncertainAt !== null, true);
    assert.equal(kit.owner.getState().standingFor(draftId).kind, 'retry');
    assert.equal((await kit.owner.getState().save(draftId, kit.session())).reason, 'not_admitted');

    await kit.close();
  });
});

describe('Retry', () => {
  it('replays the frozen bytes rather than what is in the form now', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    kit.owner.getState().editDraft(draftId, { title: 'As submitted' });
    editor.captures(documentWith('as submitted'));
    kit.respond(failed('unknown'));

    await kit.owner.getState().save(draftId, kit.session());
    const frozen = attemptsOf(kit, draftId)[0].request;

    kit.owner.getState().editDraft(draftId, { title: 'Changed since' });
    editor.captures(documentWith('changed since'));

    let replayed = null;
    kit.respond((request) => {
      replayed = request;

      return created();
    });
    await kit.owner.getState().retry(draftId, kit.session());

    assert.equal(JSON.parse(frozen).title, 'As submitted');
    assert.equal(replayed.title, 'As submitted');
    assert.equal(JSON.parse(frozen).idempotencyKey, replayed.idempotencyKey);
    // Reconciled in place: the draft gains the identity, and the writing since is untouched.
    assert.equal(draftOf(kit, draftId).serverNodeId, 42);
    assert.equal(draftOf(kit, draftId).title, 'Changed since');

    await kit.close();
  });

  it('proceeds when its own flush fails, and that failure forces the retain branch', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('submitted'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    // Refusing to resolve an unresolved attempt because local storage is full would strand the very
    // thing recovery exists for.
    editor.refuses('invalid_document');
    kit.respond(created());
    const outcome = await kit.owner.getState().retry(draftId, kit.session());

    assert.deepEqual(outcome, { kind: 'done' });
    assert.equal(attemptsOf(kit, draftId)[0].state, 'acknowledged');
    assert.equal(draftOf(kit, draftId).serverNodeId, 42);
    // Renderer-only writing may exist, so nothing is cleared.
    assert.notEqual(draftOf(kit, draftId).document.content[0].content[0].text, '');

    await kit.close();
  });

  it('is withdrawn once the window ends, and records a clock anomaly permanently', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('too late'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    kit.advance(RETRY_WINDOW_MS);

    const refused = await kit.owner.getState().retry(draftId, kit.session());

    assert.equal(refused.kind, 'refused');
    assert.equal(kit.owner.getState().standingFor(draftId).reason, 'unresolved_ineligible');
    // Nothing is resent and no replacement key is generated.
    assert.equal((await kit.owner.getState().save(draftId, kit.session())).reason, 'not_admitted');

    await kit.close();
  });

  it('refuses and records permanently when the clock has moved backwards', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('when?'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    kit.setClock(T0 - 60_000);
    assert.equal((await kit.owner.getState().retry(draftId, kit.session())).kind, 'refused');
    assert.equal(attemptsOf(kit, draftId)[0].clockAnomaly, true);

    // Restoring eligibility when the clock catches up would claim a guarantee from the measurement
    // that had just been wrong.
    kit.setClock(T0 + 60_000);
    assert.equal((await kit.owner.getState().retry(draftId, kit.session())).kind, 'refused');

    await kit.close();
  });

  it('refuses a replay to a different connection', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('elsewhere'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    const refused = await kit.owner.getState().retry(draftId, kit.session({ connectionId: 'c2' }));

    assert.equal(refused.kind, 'refused');
    assert.equal(attemptsOf(kit, draftId)[0].state, 'uncertain');

    await kit.close();
  });
});

describe('a replay that is withdrawn', () => {
  it('starts withdrawn for a recovered payload this build cannot prepare', async () => {
    const file = await temporaryFile();
    const kit = await harness({ file });
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('frozen by an older build'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    const attemptId = attemptsOf(kit, draftId)[0].attemptId;
    const frozen = attemptsOf(kit, draftId)[0].request;
    await kit.owner.getState().close();

    // What a narrowed contract leaves behind: the exact bytes that were sent, which this build can
    // no longer decode.
    const raw = await openNodeDatabase(file);
    await raw.run('UPDATE note_attempts SET request = ? WHERE attempt_id = ?', [
      '{"type":"resource"}',
      attemptId,
    ]);
    await raw.close();

    const restarted = await harness({ file });
    const standing = restarted.owner.getState().standingFor(draftId);

    // Withdrawn before anyone presses it, rather than offered and then failing.
    assert.deepEqual(
      { kind: standing.kind, reason: standing.reason, cause: standing.cause },
      { kind: 'blocked', reason: 'unresolved_unsendable', cause: 'unusable_payload' },
    );
    assert.equal(
      (await restarted.owner.getState().retry(draftId, restarted.session())).kind,
      'refused',
    );
    // Nothing was sent, the evidence is intact and ordinary Save is still refused.
    assert.equal(restarted.owner.getState().attempts[0].state, 'uncertain');
    assert.notEqual(restarted.owner.getState().attempts[0].request, frozen);
    assert.equal(
      (await restarted.owner.getState().save(draftId, restarted.session())).reason,
      'not_admitted',
    );

    await restarted.close();
    await kit.close();
  });

  it('records an unusable payload and sends nothing when the bytes fail at dispatch', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('valid when frozen'));
    // The row the owner is handed back does not carry the bytes that were frozen. This is the
    // defense the dispatch-time thaw exists for, and nothing must be sent under that key.
    kit.rewrites.insertIntent = (written) => ({
      ...written,
      attempt: { ...written.attempt, request: 'not json at all' },
    });

    const outcome = await kit.owner.getState().save(draftId, kit.session());

    assert.equal(outcome.kind, 'dispatched');
    const attempt = attemptsOf(kit, draftId)[0];

    assert.equal(attempt.state, 'blocked');
    assert.equal(attempt.lastOutcome.kind, 'unusable_payload');
    // Never sent: no response was queued, and the harness asserts if one is asked for.
    assert.deepEqual(kit.applied, []);
    // The draft is editable again. This attempt was never uncertain and nothing left the phone, so
    // it is a definite non-creation: correcting it under a new key is right, and there is no replay
    // to withdraw. Withdrawal is the projection's job on an *unresolved* attempt, which the
    // recovered-payload case above covers.
    assert.equal(draftOf(kit, draftId).state, 'composing');
    assert.equal(attempt.firstUncertainAt, null);
    assert.equal(kit.owner.getState().standingFor(draftId).kind, 'save_replacing');

    // And a corrected Save works, under a new key, without remounting anything.
    editor.captures(documentWith('corrected'));
    delete kit.rewrites.insertIntent;
    kit.respond(created());
    assert.equal((await kit.owner.getState().save(draftId, kit.session())).kind, 'dispatched');
    assert.equal(attemptsOf(kit, draftId).length, 1);

    await kit.close();
  });

  for (const code of ['idempotency_conflict', 'slug_conflict']) {
    it(`is withdrawn after uncertainty when the server answers ${code}`, async () => {
      const kit = await harness();
      const editor = fakeEditor();
      const { draftId } = await readyDraft(kit, editor);
      editor.captures(documentWith('conflicted'));
      kit.respond(failed('unknown'));
      await kit.owner.getState().save(draftId, kit.session());

      const frozen = attemptsOf(kit, draftId)[0].request;
      kit.respond(failed('rejected', code));
      await kit.owner.getState().retry(draftId, kit.session());

      const standing = kit.owner.getState().standingFor(draftId);

      assert.deepEqual(
        { kind: standing.kind, reason: standing.reason, cause: standing.cause },
        { kind: 'blocked', reason: 'unresolved_unsendable', cause: 'conflict' },
      );
      // Not a claim that the first attempt committed. The attempt stays unresolved, its frozen
      // evidence is unchanged, ordinary Save is still refused and no fresh key is minted.
      assert.equal(attemptsOf(kit, draftId)[0].firstUncertainAt !== null, true);
      assert.equal(attemptsOf(kit, draftId)[0].request, frozen);
      assert.equal(
        (await kit.owner.getState().save(draftId, kit.session())).reason,
        'not_admitted',
      );
      assert.equal((await kit.owner.getState().retry(draftId, kit.session())).kind, 'refused');

      await kit.close();
    });

    it(`treats a never-uncertain ${code} as a definite refusal to correct`, async () => {
      const kit = await harness();
      const editor = fakeEditor();
      const { draftId } = await readyDraft(kit, editor);
      editor.captures(documentWith('refused outright'));
      kit.respond(failed('rejected', code));
      await kit.owner.getState().save(draftId, kit.session());

      const refusedId = attemptsOf(kit, draftId)[0].attemptId;

      assert.equal(kit.owner.getState().standingFor(draftId).kind, 'save_replacing');

      editor.captures(documentWith('corrected'));
      kit.respond(created());
      assert.equal((await kit.owner.getState().save(draftId, kit.session())).kind, 'dispatched');

      const attempts = attemptsOf(kit, draftId);

      assert.equal(attempts.length, 1);
      assert.notEqual(attempts[0].attemptId, refusedId);

      await kit.close();
    });
  }

  it('leaves an authentication refusal replayable', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('unauthorized'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    kit.respond(failed('rejected', 'unauthorized'));
    await kit.owner.getState().retry(draftId, kit.session());

    // A 401 on a replay says nothing about whether the first request committed, and nothing about
    // whether these bytes can be sent again. It must not become permanently unsendable.
    assert.equal(kit.owner.getState().standingFor(draftId).kind, 'retry');

    kit.respond(created());
    assert.deepEqual(await kit.owner.getState().retry(draftId, kit.session()), { kind: 'done' });

    await kit.close();
  });
});

describe('recording an acknowledgement later', () => {
  it('clears with no editor mounted and retains against one it cannot lock', async () => {
    for (const [attached, expectCleared] of [
      [false, true],
      [true, false],
    ]) {
      const kit = await harness();
      const editor = fakeEditor();
      const { draftId, token } = await readyDraft(kit, editor);
      kit.owner.getState().editDraft(draftId, { title: 'Submitted' });
      editor.captures(documentWith('submitted'));
      kit.faults.acknowledge = 'the disk is full';
      kit.respond(created());

      const outcome = await kit.owner.getState().save(draftId, kit.session());

      delete kit.faults.acknowledge;
      if (!attached) kit.owner.getState().detachEditor(token);
      else editor.refuses('composing');

      await kit.owner.getState().saveAcknowledgement(outcome.attemptId);

      // Retaining is always safe: it leaves a remainder someone can read and discard, where
      // clearing wrongly destroys writing.
      assert.equal(draftOf(kit, draftId).title === '', expectCleared);
      assert.equal(draftOf(kit, draftId).serverNodeId, 42);

      await kit.close();
    }
  });
});

describe('consuming and discarding', () => {
  it('consumes only a written receipt, and the draft still refuses Save afterwards', async () => {
    const file = await temporaryFile();
    const kit = await harness({ file });
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('saved'));
    kit.respond(created());

    const outcome = await kit.owner.getState().save(draftId, kit.session());
    await kit.owner.getState().consumeReceipt(outcome.attemptId);

    assert.equal(attemptsOf(kit, draftId).length, 0);
    assert.equal(kit.owner.getState().standingFor(draftId).reason, 'created');
    await kit.close();

    // The dangerous case: the receipt is dismissed and the process restarts, so an attempt-only
    // rule would fall through to "no attempt" and create a second note for the same writing.
    const restarted = await harness({ file });

    assert.equal(restarted.owner.getState().standingFor(draftId).reason, 'created');
    assert.equal(
      (await restarted.owner.getState().save(draftId, restarted.session())).reason,
      'not_admitted',
    );

    await restarted.close();
  });

  it('cannot discard an attempt that was ever uncertain, and keeps it listable', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('unresolved'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    assert.deepEqual(await kit.owner.getState().discardDraft(draftId), { kind: 'done' });

    assert.equal(draftOf(kit, draftId), undefined);
    // An orphan remains listable and resolvable: discarding writing cannot un-ask a question.
    assert.equal(attemptsOf(kit, draftId).length, 1);

    await kit.close();
  });

  it('removes a definite refusal with the draft, and preserves an acknowledged receipt', async () => {
    const kit = await harness();
    const editor = fakeEditor();

    const refusedDraft = await readyDraft(kit, editor);
    editor.captures(documentWith('refused'));
    kit.respond(failed('rejected', 'slug_conflict'));
    await kit.owner.getState().save(refusedDraft.draftId, kit.session());
    await kit.owner.getState().discardDraft(refusedDraft.draftId);

    assert.equal(attemptsOf(kit, refusedDraft.draftId).length, 0);

    const savedEditor = fakeEditor();
    const savedDraft = await readyDraft(kit, savedEditor);
    savedEditor.captures(documentWith('saved'));
    kit.respond(created());
    await kit.owner.getState().save(savedDraft.draftId, kit.session());
    await kit.owner.getState().discardDraft(savedDraft.draftId);

    // Discard is not receipt consumption.
    assert.equal(attemptsOf(kit, savedDraft.draftId).length, 1);

    await kit.close();
  });

  it('refuses to discard work that is being sent', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('in flight'));

    let release;
    kit.respond(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(created());
          };
        }),
    );
    const saving = kit.owner.getState().save(draftId, kit.session());
    await until(() => kit.owner.getState().sending.length === 1, 'the request to be in flight');

    assert.equal((await kit.owner.getState().discardDraft(draftId)).kind, 'refused');

    release();
    await saving;

    await kit.close();
  });
});

describe('copying into a separate note', () => {
  it('places authored content on the connection that is active now, and only when asked', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    kit.owner
      .getState()
      .editDraft(draftId, { title: 'Written on A', description: 'why', tags: ['sync', 'design'] });
    editor.captures(documentWith('written on A'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    const elsewhere = kit.session({ connectionId: 'c2', endpoint: 'https://other.example' });
    const before = kit.owner.getState().drafts.length;
    const frozen = attemptsOf(kit, draftId)[0].request;

    // Merely operating under the new connection rebinds nothing. Every connection-scoped action on
    // the old draft is refused, and no draft appears on its own.
    assert.equal((await kit.owner.getState().save(draftId, elsewhere)).reason, 'wrong_connection');
    assert.equal((await kit.owner.getState().retry(draftId, elsewhere)).kind, 'refused');
    assert.equal(
      (await kit.owner.getState().selectDestination(draftId, { type: 'area', id: 9 }, elsewhere))
        .kind,
      'refused',
    );
    assert.equal(kit.owner.getState().drafts.length, before);

    // An unusable target is still refused: copying is explicit, not unconditional.
    assert.equal(
      (
        await kit.owner
          .getState()
          .copyDraft(draftId, kit.session({ connectionId: 'c2', usable: false }))
      ).kind,
      'refused',
    );

    const copy = await kit.owner.getState().copyDraft(draftId, elsewhere);

    assert.equal(copy.kind, 'created');
    const copied = draftOf(kit, copy.draftId);

    assert.notEqual(copy.draftId, draftId);
    assert.equal(copied.connectionId, 'c2');
    assert.equal(copied.endpoint, 'https://other.example');
    // Only what was authored travels.
    assert.equal(copied.title, 'Written on A');
    assert.equal(copied.description, 'why');
    assert.equal(copied.document.content[0].content[0].text, 'written on A');
    assert.deepEqual(copied.tags, ['sync', 'design']);
    // And nothing else does: no destination, no attempt, no key, no submitted state, no identity.
    assert.equal(copied.destination, null);
    assert.equal(copied.state, 'composing');
    assert.equal(copied.submittedVersion, null);
    assert.equal(copied.serverNodeId, null);
    assert.equal(attemptsOf(kit, copy.draftId).length, 0);

    // The original and its evidence are exactly as they were, still on A and still unresolved.
    const original = draftOf(kit, draftId);

    assert.equal(original.connectionId, 'c1');
    assert.equal(original.title, 'Written on A');
    assert.equal(attemptsOf(kit, draftId).length, 1);
    assert.equal(attemptsOf(kit, draftId)[0].connectionId, 'c1');
    assert.equal(attemptsOf(kit, draftId)[0].state, 'uncertain');
    assert.equal(attemptsOf(kit, draftId)[0].request, frozen);
    // Copying did not make the original sendable through the new connection either.
    assert.equal((await kit.owner.getState().save(draftId, elsewhere)).reason, 'wrong_connection');

    await kit.close();
  });

  it('leaves the original and its evidence exactly where they are', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    kit.owner.getState().editDraft(draftId, { title: 'Unresolved' });
    editor.captures(documentWith('unresolved'));
    kit.respond(failed('unknown'));
    await kit.owner.getState().save(draftId, kit.session());

    const copy = await kit.owner.getState().copyDraft(draftId, kit.session());

    assert.equal(copy.kind, 'created');
    const copied = draftOf(kit, copy.draftId);

    assert.equal(copied.title, 'Unresolved');
    // A fresh destination is required, the old identity, attempt and key are dropped, and the
    // original evidence is untouched.
    assert.equal(copied.destination, null);
    assert.equal(copied.serverNodeId, null);
    assert.equal(attemptsOf(kit, copy.draftId).length, 0);
    assert.equal(attemptsOf(kit, draftId).length, 1);
    assert.equal(draftOf(kit, draftId).title, 'Unresolved');

    await kit.close();
  });
});

describe('the store lifecycle', () => {
  it('closes the store exactly once, however many times it is asked', async () => {
    const kit = await harness();

    await kit.owner.getState().close();
    await kit.owner.getState().close();
    await kit.owner.getState().close();

    assert.equal(kit.storeCloses(), 1);
    assert.equal(kit.owner.getState().status, 'idle');
    // Back to unopened, not to a broken instance: the same owner opens again.
    await kit.owner.getState().initialize();
    assert.equal(kit.owner.getState().status, 'ready');

    await kit.close();
  });

  it('retires attachments, leases and published records when it closes', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId, token } = await readyDraft(kit, editor);

    await kit.owner.getState().close();

    const state = kit.owner.getState();

    assert.deepEqual(state.drafts, []);
    assert.deepEqual(state.protection, {});
    assert.deepEqual(state.sending, []);
    assert.equal(
      state.snapshotAccepted(token, { sessionId: 1, editSeq: 9, document: documentWith('late') }),
      'retired',
    );
    assert.equal(state.standingFor(draftId), null);

    await kit.close();
  });

  it('ends a flush the editor never answered, rather than leaving its caller waiting', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.hangs();

    const pending = kit.owner.getState().flush(draftId, { lock: true });
    await tick();
    await kit.owner.getState().close();

    // Clearing the timer instead would leave a promise nobody ever resolves.
    assert.deepEqual(await pending, { kind: 'unanswered' });

    await kit.close();
  });

  it('leaves a healthy store alone when asked to retry', async () => {
    const kit = await harness();
    const opens = kit.log.filter((entry) => entry === 'openStore').length;

    await kit.owner.getState().retryOpen();
    await kit.owner.getState().initialize();

    // Closing a live connection and swapping another in beneath work already running would be a
    // larger race than the handle it saves.
    assert.equal(kit.log.filter((entry) => entry === 'openStore').length, opens);
    assert.equal(kit.storeCloses(), 0);

    await kit.close();
  });

  it('joins an open already in progress instead of starting a second one', async () => {
    const kit = await harness({ open: false });
    const release = kit.holdOpens();

    const first = kit.owner.getState().initialize();
    const second = kit.owner.getState().retryOpen();
    release();
    await Promise.all([first, second]);

    assert.equal(kit.log.filter((entry) => entry === 'openStore').length, 1);
    assert.equal(kit.owner.getState().status, 'ready');

    await kit.close();
  });

  it('closes a store that an open produced after the owner had already closed', async () => {
    const kit = await harness({ open: false });
    const release = kit.holdOpens();

    const opening = kit.owner.getState().initialize();
    const closing = kit.owner.getState().close();
    release();
    await Promise.all([opening, closing]);

    // The open finished and found itself obsolete. It must neither publish the store nor leak it.
    assert.equal(kit.owner.getState().status, 'idle');
    assert.deepEqual(kit.owner.getState().drafts, []);
    assert.equal(kit.storeCloses(), 1);

    await kit.close();
  });

  it('keeps a persisted dispatch intent when cleanup overtakes a request in flight', async () => {
    const file = await temporaryFile();
    const kit = await harness({ file });
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('in flight'));
    kit.respond(() => new Promise(() => {}));

    void kit.owner.getState().save(draftId, kit.session());
    await until(() => kit.owner.getState().sending.length === 1, 'the intent to be written');
    // Closing is not cancelling. The request it records may already have reached a server.
    await kit.owner.getState().close();
    await kit.close();

    const restarted = await harness({ file });

    assert.equal(restarted.owner.getState().attempts[0].state, 'uncertain');
    assert.equal(restarted.owner.getState().standingFor(draftId).kind, 'retry');

    await restarted.close();
  });
});

describe('a store that cannot be opened', () => {
  it('publishes a bounded problem for a database written by a newer build', async () => {
    const kit = await harness({ open: false });
    kit.answerNextOpen({ kind: 'unsupported_version', found: 9, supported: 1 });

    await kit.owner.getState().initialize();

    assert.equal(kit.owner.getState().status, 'unavailable');
    assert.deepEqual(kit.owner.getState().problem, {
      kind: 'unsupported_version',
      found: 9,
      supported: 1,
    });
    // Nothing invents an empty database, and nothing falls back to memory.
    assert.deepEqual(kit.owner.getState().drafts, []);
    assert.deepEqual(kit.owner.getState().unusableDrafts, []);

    await kit.close();
  });

  it('publishes a bounded problem for a failed migration', async () => {
    const kit = await harness({ open: false });
    kit.answerNextOpen({ kind: 'failed', reason: 'migration_failed' });

    await kit.owner.getState().initialize();

    assert.deepEqual(kit.owner.getState().problem, { kind: 'failed', reason: 'migration_failed' });

    await kit.close();
  });

  it('turns a thrown open into an unavailable store rather than letting it escape', async () => {
    const kit = await harness({ open: false });
    kit.answerNextOpen('throw');

    await assert.doesNotReject(() => kit.owner.getState().initialize());

    assert.equal(kit.owner.getState().status, 'unavailable');
    assert.deepEqual(kit.owner.getState().problem, { kind: 'failed', reason: 'unopenable' });

    await kit.close();
  });

  it('refuses every operation rather than running one against a store it does not have', async () => {
    const kit = await harness({ open: false });
    kit.answerNextOpen({ kind: 'failed', reason: 'migration_failed' });
    await kit.owner.getState().initialize();

    const state = kit.owner.getState();

    assert.equal((await state.createDraft(kit.session())).kind, 'refused');
    assert.equal((await state.save('d1', kit.session())).reason, 'no_store');
    assert.equal((await state.retry('d1', kit.session())).kind, 'refused');
    assert.equal((await state.discardDraft('d1')).kind, 'refused');
    assert.equal((await state.saveAcknowledgement('a1')).kind, 'refused');
    assert.equal(state.standingFor('d1'), null);

    await kit.close();
  });

  it('clears the problem when a later retry succeeds', async () => {
    const kit = await harness({ open: false });
    kit.answerNextOpen({ kind: 'failed', reason: 'migration_failed' });
    await kit.owner.getState().initialize();

    await kit.owner.getState().retryOpen();

    assert.equal(kit.owner.getState().status, 'ready');
    assert.equal(kit.owner.getState().problem, null);
    assert.equal((await kit.owner.getState().createDraft(kit.session())).kind, 'created');

    await kit.close();
  });
});

describe('what survives the process', () => {
  it('reopens an interrupted dispatch as unresolved, not as something to send again', async () => {
    const file = await temporaryFile();
    const kit = await harness({ file });
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('interrupted'));
    // The process dies between the intent write and the answer.
    kit.respond(() => new Promise(() => {}));
    void kit.owner.getState().save(draftId, kit.session());
    await until(() => kit.owner.getState().sending.length === 1, 'the intent to be written');
    await kit.close();

    const restarted = await harness({ file });
    const attempt = restarted.owner.getState().attempts[0];

    assert.equal(attempt.state, 'uncertain');
    assert.equal(restarted.owner.getState().standingFor(draftId).kind, 'retry');
    assert.equal(
      (await restarted.owner.getState().save(draftId, restarted.session())).reason,
      'not_admitted',
    );

    await restarted.close();
  });

  it('refuses to call a database it cannot read a database with nothing in it', async () => {
    const kit = await harness({ open: false });
    kit.faults.list = 'unreadable';

    await kit.owner.getState().initialize();

    // Going ready with empty lists would say "there is nothing unfinished" about a store that has
    // not answered the question. The store is closed and the problem is reported instead.
    assert.equal(kit.owner.getState().status, 'unavailable');
    assert.deepEqual(kit.owner.getState().problem, { kind: 'failed', reason: 'unreadable' });
    assert.deepEqual(kit.owner.getState().drafts, []);
    assert.equal(kit.storeCloses(), 1);

    delete kit.faults.list;
    await kit.owner.getState().retryOpen();
    assert.equal(kit.owner.getState().status, 'ready');

    await kit.close();
  });
});

describe('the consequences of a creation, and the creation itself', () => {
  it('keeps a persisted creation when applying it to the caches fails', async () => {
    const kit = await harness({ applyCreationThrows: true });
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('saved'));
    kit.respond(created());

    const outcome = await kit.owner.getState().save(draftId, kit.session());

    assert.equal(outcome.kind, 'dispatched');
    // Seeding a cache is a consequence of the creation, not part of establishing it. A read that
    // fails here is a failed refresh, never a failed save, and it reclassifies nothing.
    assert.deepEqual(kit.applied, [{ id: 42, activation: 1 }]);
    assert.equal(attemptsOf(kit, draftId)[0].state, 'acknowledged');
    assert.equal(draftOf(kit, draftId).state, 'created');
    assert.equal(draftOf(kit, draftId).serverNodeId, 42);
    assert.equal(kit.owner.getState().unsaved[outcome.attemptId], undefined);

    await kit.close();
  });

  it('refuses a Save it cannot mint identifiers for, before anything is written or sent', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('never keyed'));
    kit.breakIdentifiers();

    const outcome = await kit.owner.getState().save(draftId, kit.session());

    // A weaker identifier is not the fallback: a key drawn twice would let one key stand for two
    // different requests. Refusing inside the guard also means nothing rejects out of an async
    // closure nobody is listening to.
    assert.equal(outcome.reason, 'not_recorded');
    assert.equal(attemptsOf(kit, draftId).length, 0);
    assert.equal(draftOf(kit, draftId).state, 'composing');
    assert.deepEqual(kit.owner.getState().saving, []);

    await kit.close();
  });
});

describe('what a storage failure is allowed to say', () => {
  it('never lets a driver message reach anything a screen can read', async () => {
    const leak = 'SQLITE_CORRUPT: /var/mobile/Containers/raphael-capture.db is malformed';
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);

    kit.faults.writeVersion = leak;
    editor.captures(documentWith('unwritten'));
    const flushed = await kit.owner.getState().flush(draftId, { lock: true });
    const saved = await kit.owner.getState().save(draftId, kit.session());

    kit.faults.insertDraft = leak;
    const drafted = await kit.owner.getState().createDraft(kit.session());
    delete kit.faults.insertDraft;

    kit.faults.discard = leak;
    const discarded = await kit.owner.getState().discardDraft(draftId);

    // Every outcome says what happened in this capability's own words. A SQLite message can name a
    // table, quote a CHECK constraint or carry a file path, and none of that belongs on a screen.
    const said = JSON.stringify([
      flushed,
      saved,
      drafted,
      discarded,
      kit.owner.getState().protection,
      kit.owner.getState().problem,
    ]);

    assert.equal(said.includes('SQLITE'), false, said);
    assert.equal(said.includes('malformed'), false, said);
    assert.equal(said.includes('raphael-capture.db'), false, said);
    // And the facts still survive: the work is unprotected and nothing was sent.
    assert.equal(kit.owner.getState().protection[draftId].failedWrite, true);
    assert.equal(saved.reason, 'not_recorded');
    assert.equal(attemptsOf(kit, draftId).length, 0);

    await kit.close();
  });

  it('keeps the three unopenable reasons apart without quoting the adapter', async () => {
    for (const [outcome, reason] of [
      ['throw', 'unopenable'],
      [{ kind: 'failed', reason: 'migration_failed' }, 'migration_failed'],
      [null, 'unreadable'],
    ]) {
      const kit = await harness({ open: false });

      if (outcome === null) kit.faults.list = 'SQLITE_IOERR: disk I/O error';
      else kit.answerNextOpen(outcome);

      await kit.owner.getState().initialize();

      assert.deepEqual(kit.owner.getState().problem, { kind: 'failed', reason });

      await kit.close();
    }
  });
});

describe('the response the client cannot represent', () => {
  it('is treated as unknown rather than as a success it may record', async () => {
    const kit = await harness();
    const editor = fakeEditor();
    const { draftId } = await readyDraft(kit, editor);
    editor.captures(documentWith('odd'));
    kit.respond({ ok: true, value: { entity: { ...entity(), type: 'area', kind: null } } });

    await kit.owner.getState().save(draftId, kit.session());

    // The server may well have created something, so the only honest answer is unresolved.
    assert.equal(attemptsOf(kit, draftId)[0].state, 'uncertain');
    assert.equal(draftOf(kit, draftId).serverNodeId, null);

    await kit.close();
  });
});

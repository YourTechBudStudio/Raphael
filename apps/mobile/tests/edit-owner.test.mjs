/**
 * The autosave loop, against real SQLite and a server that normalizes.
 *
 * What is defended here is the whole of A4 and A5: an honest distinction between "kept on this
 * phone" and "on your server", and a conflict that keeps the person's writing instead of resolving
 * it for them. The properties that decide those are all about *ordering* - what is persisted before
 * what is sent, which version may leave the phone, what the base becomes after an answer, and what a
 * lost answer is allowed to conclude - so every test here drives the real store and lets the real
 * rules run.
 *
 * The server model normalizes deliberately. A stub that echoed submissions back verbatim would pass
 * every one of these tests while the app spun forever against a real one.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { diff } from '../src/modules/capture/edit-envelope.ts';
import { editKeyOf } from '../src/modules/capture/edit-types.ts';
import { unfinishedEdits } from '../src/modules/capture/edit-unfinished.ts';
import { EDITS_TABLE } from '../src/modules/capture/schema.ts';
import { fakeEditor } from './support/capture-harness.mjs';
import {
  clientFailure,
  documentWith,
  editHarness,
  serverModel,
  SESSION,
  T0,
  until,
} from './support/edit-harness.mjs';

const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryFile = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-edit-'));

  temporaries.push(dir);

  return path.join(dir, 'capture.db');
};

const KEY = editKeyOf({ connectionId: 'c1', nodeId: 42 });

/**
 * Open the owner and one entity, with an editor attached.
 *
 * The attachment is not decoration. A record whose acknowledgement lands with nobody attached is
 * settled and forgotten on the spot - that is the background-flush and process-death path - so a test
 * that wants to inspect a record after it saved has to be holding it.
 *
 * **It is not the screen's ordering, and no test may claim it is.** `EditScreen` calls `open` first
 * and attaches from an effect in the composer it mounts once that resolves, so an editor is never
 * attached *during* an open. This helper attaches after `open` returns; where the sequence itself is
 * what is under test - the recovery path, where reconciliation can settle a record mid-open - the
 * test drives `initialize` and `open` directly instead, with nothing attached.
 */
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

/** Wait for the protection core to have written a version, since only a written one may be sent. */
const committed = (kit, version) =>
  until(
    () => (kit.state().protection[KEY]?.committedVersion ?? 0) >= version,
    `version ${String(version)} to be committed`,
  );

describe('opening an entity', () => {
  it('seeds a record from the server, with the base equal to what was read', async () => {
    const kit = await opened();
    const record = kit.record(KEY);

    assert.equal(record.baseRevision, 1);
    assert.equal(record.base.title, 'A note');
    assert.deepEqual(record.content, record.base, 'nothing is unsent the moment it is opened');
    assert.equal(record.acknowledgedVersion, record.draftVersion);
    assert.deepEqual(kit.owner.getState().standingFor(KEY), { kind: 'synced', revision: 1 });
  });

  /**
   * "At the root" and "I could not find out" are two facts, and the eyebrow draws them differently.
   *
   * A root-level container genuinely has no parent and reads "Areas"; an entity whose Get failed has
   * a parent this phone could not learn and must name no location at all. A bare `parentId: null`
   * would merge them, and an unreachable server would then quietly claim a note lives at the root.
   */
  it('tells a genuinely root-level parent from one it could not establish', async () => {
    const atRoot = await editHarness({
      server: serverModel({ type: 'area', kind: null, parentId: null }),
    });

    await atRoot.owner.getState().initialize();

    assert.deepEqual((await atRoot.owner.getState().open(42, SESSION)).location, {
      kind: 'known',
      parentId: null,
    });

    // A record that already exists opens over local content even when the read fails, and then the
    // location is the one thing this open learned nothing about.
    const kit = await opened();

    kit.server.getFailure = clientFailure('transport', null, 'not_applicable');

    const again = await kit.owner.getState().open(42, SESSION);

    assert.equal(again.kind, 'ready', 'a failed read still opens what is on this phone');
    assert.deepEqual(again.location, { kind: 'unknown' });
  });

  /**
   * A store write that fails on reopen must not take the editor down with it.
   *
   * `open` is total by contract: the screen renders an outcome and has nowhere to render the absence
   * of one, so a rejection would leave it on its opening skeleton forever with nothing said. The
   * record is tracked and published before either write is attempted, and a write that threw wrote
   * nothing - so what is left is exactly what the standing already describes.
   */
  it('opens over what is on this phone when the reopen write itself fails', async () => {
    const file = await temporaryFile();
    const first = await opened({ file });

    first.server.writeBehind({ title: 'Renamed elsewhere' });
    await first.owner.getState().close();

    const kit = await editHarness({
      file,
      server: first.server,
      store: () => ({
        rebaseEdit: () => {
          throw new Error('the database said no');
        },
      }),
    });

    await kit.owner.getState().initialize();

    const outcome = await kit.owner.getState().open(42, SESSION);

    assert.equal(outcome.kind, 'ready', 'the record is still editable');
    assert.deepEqual(outcome.location, { kind: 'known', parentId: 3 });
    assert.equal(kit.record(KEY).baseRevision, 1, 'the base it could not move stands');
    assert.equal(kit.record(KEY).content.title, 'A note', 'and nothing local was lost');
  });

  /**
   * The recovery path, in the order the screen actually performs it.
   *
   * A lost answer that turns out to have landed is acknowledged during `open`, and an acknowledgement
   * with nobody attached settles the record and forgets it. Nobody is attached here **by
   * construction**: the screen calls `open` first and attaches from an effect in the composer it
   * mounts once that resolves. Handing back `ready` for the forgotten key left the screen with a key
   * and no record, which it can only render as "this could not be opened, nothing has changed" - over
   * an intact entity whose edit reached the server, at the exact moment recovery exists for.
   *
   * Deliberately **not** written through `opened`: that helper attaches first, which is the one
   * ordering the screen cannot reproduce and the reason this went unseen.
   */
  it('opens a fresh record when the reconciliation settles the one it was reconciling', async () => {
    const file = await temporaryFile();
    const first = await opened({ file });

    await first.owner.getState().editFields(KEY, { title: 'landed' });
    first.server.lose = true;
    await committed(first, 2);
    first.fire();
    await until(() => first.record(KEY).inflightVersion === 2, 'an envelope left in flight');
    await first.owner.getState().close();

    // The screen's ordering exactly: open, and only then attach.
    const kit = await editHarness({ file, server: first.server });

    await kit.owner.getState().initialize();

    const outcome = await kit.owner.getState().open(42, SESSION);

    assert.equal(outcome.kind, 'ready');

    const record = kit.record(editKeyOf({ connectionId: 'c1', nodeId: 42 }));

    assert.notEqual(record, null, 'the key it handed back has a record behind it');
    assert.equal(record.content.title, 'landed', 'and it holds what the server took');
    assert.equal(record.baseRevision, 2, 'at the revision the write produced');
    assert.equal(record.inflightVersion, null, 'with nothing left unresolved');
    assert.deepEqual(kit.owner.getState().standingFor(outcome.editKey), {
      kind: 'synced',
      revision: 2,
    });
  });

  it('rebases a settled record onto a newer server revision', async () => {
    const kit = await opened();

    kit.server.writeBehind({ title: 'Renamed elsewhere' });

    const again = await kit.owner.getState().open(42, SESSION);

    assert.equal(again.kind, 'ready');

    const record = kit.record(KEY);

    assert.equal(record.baseRevision, 2);
    assert.equal(record.base.title, 'Renamed elsewhere');
    assert.equal(record.content.title, 'Renamed elsewhere', 'the editor adopts it too');
  });

  it('refuses to rebase over unsent writing, whatever the server now holds', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { title: 'Mine' });
    await committed(kit, 2);
    kit.server.writeBehind({ title: 'Theirs' });

    await kit.owner.getState().open(42, SESSION);

    const record = kit.record(KEY);

    assert.equal(record.content.title, 'Mine', 'unsent writing is never overwritten by a read');
    assert.equal(record.baseRevision, 1, 'and the base it was written against stands');
  });

  it('reports a row this build cannot open, without asking the server about it', async () => {
    const file = await temporaryFile();
    const first = await opened({ file });

    // A row from a build that stored content under a schema this one does not know.
    await first.db.run(`UPDATE ${EDITS_TABLE} SET content_schema_version = 99`, []);
    await first.db.close();

    const kit = await editHarness({ file });

    await kit.owner.getState().initialize();

    const before = kit.server.gets;
    const outcome = await kit.owner.getState().open(42, SESSION);

    assert.deepEqual(outcome, {
      kind: 'unusable',
      editKey: KEY,
      problem: 'unsupported_content_schema',
    });
    assert.equal(kit.server.gets, before, 'a row that cannot be opened is not a reason to ask');

    const listed = unfinishedEdits({
      edits: kit.state().edits,
      unusableEdits: kit.state().unusableEdits,
      standingFor: kit.owner.getState().standingFor,
      connectionId: 'c1',
    });

    assert.equal(listed.length, 1);
    assert.equal(listed[0].standing, 'unusable');
    assert.deepEqual(listed[0].actions, ['discard'], 'nothing offers to open what it cannot read');

    assert.deepEqual(await kit.owner.getState().discardChanges(KEY), { kind: 'done' });
    assert.equal(kit.state().unusableEdits.length, 0);
  });
});

describe('the autosave loop', () => {
  it('sends one envelope for what changed, and acknowledges at the server revision', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { title: 'A better title' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.updates.length === 1, 'the update to be sent');
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the acknowledgement');

    assert.deepEqual(kit.server.updates[0], {
      target: { id: 42 },
      revision: 1,
      title: 'A better title',
      format: 'tiptap',
    });

    const record = kit.record(KEY);

    assert.equal(record.baseRevision, 2);
    assert.equal(record.base.title, 'A better title', 'the base becomes what was sent');
    assert.equal(diff(record.base, record.content), null, 'and a re-diff is empty');
    assert.deepEqual(kit.owner.getState().standingFor(KEY), { kind: 'synced', revision: 2 });
  });

  it('coalesces every edit made while one envelope is in the air into exactly one more send', async () => {
    const kit = await opened();

    kit.server.hold = true;
    kit.owner.getState().editFields(KEY, { title: 'one' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.updates.length === 1, 'the first send');

    kit.owner.getState().editFields(KEY, { title: 'two' });
    kit.owner.getState().editFields(KEY, { title: 'three' });
    kit.owner.getState().editFields(KEY, { title: 'four' });
    await committed(kit, 5);

    // Every one of those armed the debounce while the first request was still out.
    kit.fire();
    assert.equal(
      kit.server.updates.length,
      1,
      'nothing is sent beside an envelope already in flight',
    );

    kit.server.hold = false;
    kit.server.release();

    await until(() => kit.record(KEY).acknowledgedVersion === 5, 'the second acknowledgement');

    assert.equal(kit.server.updates.length, 2, 'exactly one further send');
    assert.equal(kit.server.updates[1].title, 'four', 'carrying the newest committed version');
    assert.equal(kit.server.entity().title, 'four');
  });

  it('never moves the acknowledged mark past the version that was actually sent', async () => {
    const kit = await opened();

    kit.server.hold = true;
    kit.owner.getState().editFields(KEY, { title: 'sent' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.updates.length === 1, 'the send');

    kit.owner.getState().editFields(KEY, { title: 'written after' });
    await committed(kit, 3);

    kit.server.hold = false;
    kit.server.release();

    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the first acknowledgement');
    assert.equal(kit.record(KEY).acknowledgedVersion, 2, 'never 3: version 3 was never sent');
  });

  it('acknowledges an empty envelope locally, with no request at all', async () => {
    const kit = await opened();

    // A change and then its exact reversal: the version counter moved, the content did not.
    kit.owner.getState().editFields(KEY, { title: 'changed' });
    await committed(kit, 2);
    kit.owner.getState().editFields(KEY, { title: 'A note' });
    await committed(kit, 3);

    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 3, 'the local acknowledgement');
    assert.equal(kit.server.updates.length, 0, 'nothing differs from what the server was given');
  });

  it('does not loop against a server that normalizes what it was sent', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, {
      title: '  Padded  ',
      // Decomposed: the server stores the composed form, so its echo differs from what was typed.
      tags: ['café', 'work'],
    });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the acknowledgement');

    assert.equal(kit.server.entity().title, 'Padded', 'the server trimmed it');
    assert.deepEqual(kit.server.entity().tags, ['café', 'work'], 'and normalized the tags');

    const record = kit.record(KEY);

    assert.equal(record.base.title, '  Padded  ', 'the base is what was sent, not the echo');
    assert.equal(diff(record.base, record.content), null, 'so nothing further is owed');

    // The loop's own proof: firing again sends nothing, forever.
    kit.fire();
    await until(() => true, 'a turn');
    assert.equal(kit.server.updates.length, 1);
  });
});

describe('a verdict from the server', () => {
  it('stops on a stale revision, keeps everything local, and never sends again', async () => {
    const kit = await opened();

    kit.server.writeBehind({ title: 'someone else' });
    kit.owner.getState().editFields(KEY, { title: 'mine' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.record(KEY).syncState === 'conflicted', 'the conflict');

    assert.equal(kit.server.updates.length, 1);
    assert.equal(kit.timers.size, 0, 'the timer is cancelled and never rescheduled');

    const record = kit.record(KEY);

    assert.equal(record.content.title, 'mine', 'nothing local changed');
    assert.equal(kit.server.entity().title, 'someone else', 'and nothing on the server did');
    assert.deepEqual(kit.owner.getState().standingFor(KEY), { kind: 'conflicted' });

    // Even a further edit does not resume: a conflict is not repaired by writing more.
    kit.owner.getState().editFields(KEY, { title: 'mine again' });
    await committed(kit, 3);
    kit.fire();
    await until(() => true, 'a turn');
    assert.equal(kit.server.updates.length, 1, 'no send after a revision conflict, ever');
    assert.deepEqual(kit.owner.getState().standingFor(KEY), { kind: 'conflicted' });
  });

  it('records any other refusal, and resumes on the next accepted version', async () => {
    const kit = await opened();
    const rejections = [clientFailure('api_error', 'slug_conflict', 'rejected', { field: 'slug' })];

    const realUpdate = kit.server.update;

    kit.server.update = async (request) => {
      const queued = rejections.shift();

      if (queued !== undefined) {
        kit.server.updates.push(request);

        return queued;
      }

      return realUpdate(request);
    };

    kit.owner.getState().editFields(KEY, { slug: 'taken' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.record(KEY).syncState === 'refused', 'the refusal');

    assert.deepEqual(kit.record(KEY).lastRefusal, {
      code: 'slug_conflict',
      field: 'slug',
      reason: null,
      at: T0,
    });
    assert.equal(kit.owner.getState().standingFor(KEY).kind, 'refused');

    kit.owner.getState().editFields(KEY, { slug: 'free' });
    await committed(kit, 3);

    assert.equal(kit.record(KEY).syncState, 'syncing', 'the next version returns it to syncing');
    assert.equal(kit.record(KEY).lastRefusal, null, 'and takes the diagnostic with it');

    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 3, 'the acknowledgement');
    assert.equal(kit.server.entity().slug, 'free');
  });
});

describe('an answer that never arrived', () => {
  const lostSend = async (kit, fields) => {
    kit.server.lose = true;
    kit.owner.getState().editFields(KEY, fields);
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.record(KEY).inflightVersion === 2, 'the envelope to be left in flight');
  };

  it('is persisted before it is dispatched, so a process death can still resolve it', async () => {
    const file = await temporaryFile();
    const kit = await opened({ file });

    await lostSend(kit, { title: 'landed' });

    assert.equal(kit.owner.getState().standingFor(KEY).kind, 'unconfirmed');

    // A different process, over the same file: only what was written down survives.
    const next = await editHarness({ file, server: kit.server });

    await next.owner.getState().initialize();
    next.owner.getState().attachEditor(KEY, fakeEditor().port);

    const recovered = next.record(KEY);

    assert.equal(recovered.inflightVersion, 2, 'the envelope that was sent is on disk');
    assert.deepEqual(recovered.inflight, { kind: 'update', envelope: { title: 'landed' } });
    assert.equal(
      next.owner.getState().standingFor(KEY).kind,
      'unconfirmed',
      'and nobody is flying it, which is a different sentence from saving',
    );

    const before = next.server.updates.length;

    await next.owner.getState().open(42, SESSION);

    assert.equal(next.server.updates.length, before, 'reconciled rather than resent blindly');
    assert.equal(next.record(KEY).acknowledgedVersion, 2, 'and recognized as applied');
    assert.equal(next.record(KEY).baseRevision, 2);
  });

  it('reads the entity back by itself, rather than firing a send that would refuse itself', async () => {
    const kit = await opened();

    await lostSend(kit, { title: 'landed' });

    const updatesBefore = kit.server.updates.length;
    const getsBefore = kit.server.gets;

    // The retry the unresolved send armed. There is one timer per record, and what it owes here is a
    // read: a send would refuse itself for the very envelope it is waiting on, and nothing would ever
    // resolve the record while the person sat on the screen.
    assert.equal(kit.timers.size, 1, 'a retry is armed while an editor is attached');
    kit.fire();

    await until(() => kit.server.gets > getsBefore, 'the entity to be read back');
    assert.equal(kit.server.updates.length, updatesBefore, 'and nothing is resent blindly');
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the reconciliation');
  });

  it('recognizes its own applied change even when the server normalized it', async () => {
    const kit = await opened();

    await lostSend(kit, { title: '  Padded  ', tags: ['café'] });

    await kit.owner.getState().open(42, SESSION);

    assert.equal(kit.record(KEY).syncState, 'syncing', 'not a conflict over the person own change');
    assert.equal(kit.record(KEY).acknowledgedVersion, 2);
    assert.equal(kit.record(KEY).base.title, '  Padded  ', 'the base is still what was sent');
  });

  it('resends when the entity shows the write never happened', async () => {
    const kit = await opened();

    kit.server.hold = true;
    kit.owner.getState().editFields(KEY, { title: 'never landed' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.updates.length === 1, 'the send');

    // The request is in the air; make it fail without having applied anything.
    kit.server.update = async () => clientFailure('timeout', null, 'unknown');
    kit.server.hold = false;
    kit.server.release();
    await until(() => kit.record(KEY).inflightVersion === 2, 'the unresolved envelope');

    kit.server.update = serverModel().update;
    // Rule 3: the server is still at the base revision, so nothing was applied.
    await kit.owner.getState().open(42, SESSION);

    assert.equal(kit.record(KEY).inflightVersion, null, 'the mark is cleared');
    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the resend');
  });

  it('calls it a conflict when the server holds something else entirely', async () => {
    const kit = await opened();

    await lostSend(kit, { title: 'mine' });
    // A third party writes after ours, so the entity is neither at the base nor what we submitted.
    kit.server.writeBehind({ title: 'theirs' });

    await kit.owner.getState().open(42, SESSION);

    assert.equal(kit.record(KEY).syncState, 'conflicted');
    assert.equal(kit.record(KEY).content.title, 'mine', 'and the writing is kept');
  });

  it('records a refusal when the entity itself cannot be read back', async () => {
    const kit = await opened();

    await lostSend(kit, { title: 'mine' });
    kit.server.getFailure = clientFailure('api_error', 'node_not_found', 'not_applicable');

    await kit.owner.getState().open(42, SESSION);

    assert.equal(kit.record(KEY).syncState, 'refused');
    assert.equal(kit.record(KEY).lastRefusal.code, 'node_not_found');
  });

  it('stays unconfirmed when the read itself could not be made', async () => {
    const kit = await opened();

    await lostSend(kit, { title: 'mine' });
    kit.server.getFailure = clientFailure('transport', null, 'not_applicable');

    await kit.owner.getState().open(42, SESSION);

    assert.equal(kit.record(KEY).inflightVersion, 2, 'nothing is concluded from a failed read');
    assert.equal(kit.owner.getState().standingFor(KEY).kind, 'unconfirmed');
  });

  /**
   * The one field whose omission is silent and total.
   *
   * Markdown is the API's default, so a Get that leaves `format` out is a perfectly valid request
   * whose perfectly good answer `displayableDocument` refuses rather than converts - every entity
   * would open as "this could not be opened", and nothing would say why. It used to be asserted on
   * the note detail query, which is gone; the owner's Get is the read now, and it has two call
   * sites that can drift apart.
   */
  it('asks for the canonical format, on the open read and on the reconciling one alike', async () => {
    const kit = await opened();

    assert.deepEqual(
      kit.server.getRequests,
      [{ target: { id: 42 }, format: 'tiptap' }],
      'the read that opens an entity',
    );

    await lostSend(kit, { title: 'landed' });
    kit.fire();
    await until(() => kit.server.getRequests.length > 1, 'the reconciling read');

    for (const request of kit.server.getRequests) {
      assert.deepEqual(request, { target: { id: 42 }, format: 'tiptap' });
    }
  });
});

describe('leaving the editor', () => {
  it('deletes a settled record and refreshes what it changed, exactly once', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { title: 'saved' });
    await committed(kit, 2);

    assert.equal(await kit.owner.getState().leave(KEY), 'settled');
    assert.equal(kit.record(KEY), null, 'nothing unsent is left behind');
    assert.deepEqual(kit.applied, [{ ref: { type: 'resource', id: 42 }, activation: 1 }]);
  });

  it('refreshes nothing when nothing was changed', async () => {
    const kit = await opened();

    assert.equal(await kit.owner.getState().leave(KEY), 'settled');
    assert.equal(kit.record(KEY), null);
    assert.deepEqual(kit.applied, [], 'opening and backing out refetches nothing');
  });

  it('waits for a send that was already in the air', async () => {
    const kit = await opened();

    kit.server.hold = true;
    kit.owner.getState().editFields(KEY, { title: 'in the air' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.holding() === 1, 'the send to be in flight');

    let resolved = false;
    const leaving = kit.owner
      .getState()
      .leave(KEY)
      .then((outcome) => {
        resolved = true;

        return outcome;
      });

    await until(() => true, 'a turn');
    assert.equal(resolved, false, 'the exit does not release while an answer is outstanding');

    kit.server.hold = false;
    kit.server.release();

    assert.equal(await leaving, 'settled');
    assert.equal(kit.server.updates.length, 1, 'and it did not start a second send of its own');
    assert.deepEqual(kit.applied.length, 1);
  });

  it('keeps a conflicted record and still refreshes what did land', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { title: 'first' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the first acknowledgement');

    kit.owner.getState().editFields(KEY, { title: 'second' });
    await committed(kit, 3);
    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 3, 'the second acknowledgement');

    kit.server.writeBehind({ description: 'someone else' });
    kit.owner.getState().editFields(KEY, { title: 'third' });
    await committed(kit, 4);
    kit.fire();
    await until(() => kit.record(KEY).syncState === 'conflicted', 'the conflict');

    assert.equal(await kit.owner.getState().leave(KEY), 'kept');
    assert.notEqual(kit.record(KEY), null, 'the writing stays on this phone');
    assert.equal(
      kit.applied.length,
      1,
      'one consequence for the session, not one per acknowledgement',
    );
  });

  it('releases the exit when there is no connection, rather than trapping anyone', async () => {
    const kit = await opened({ sessionIsCurrent: () => true });

    kit.owner.getState().editFields(KEY, { title: 'offline' });
    await committed(kit, 2);
    kit.owner.getState().resume(KEY, { ...SESSION, usable: false });

    assert.equal(await kit.owner.getState().leave(KEY), 'kept');
    assert.equal(kit.server.updates.length, 0);
    assert.equal(kit.record(KEY).content.title, 'offline', 'and it waits in Recovery');
  });

  it('resolves unconfirmed when its one reconciliation also fails', async () => {
    const kit = await opened();

    kit.server.lose = true;
    kit.owner.getState().editFields(KEY, { title: 'lost twice' });
    await committed(kit, 2);
    kit.server.getFailure = clientFailure('transport', null, 'not_applicable');

    assert.equal(await kit.owner.getState().leave(KEY), 'unconfirmed');
    assert.equal(
      kit.record(KEY).inflightVersion,
      2,
      'and the record survives to be resolved later',
    );
  });

  it('settles a record whose acknowledgement lands with nobody attached', async () => {
    const kit = await opened({ detached: true });

    kit.server.hold = true;
    kit.owner.getState().editFields(KEY, { title: 'background' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.holding() === 1, 'the send');

    kit.server.hold = false;
    kit.server.release();

    await until(() => kit.record(KEY) === null, 'the record to be forgotten');
    assert.deepEqual(kit.applied, [{ ref: { type: 'resource', id: 42 }, activation: 1 }]);
  });
});

describe('what the owner refuses to do', () => {
  it('refuses to discard a change that is in the air', async () => {
    const kit = await opened();

    kit.server.hold = true;
    kit.owner.getState().editFields(KEY, { title: 'sent' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.holding() === 1, 'the send');

    const outcome = await kit.owner.getState().discardChanges(KEY);

    assert.equal(outcome.kind, 'refused');
    assert.match(outcome.problem, /Wait for an answer/);

    kit.server.hold = false;
    kit.server.release();
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the send to settle');

    assert.deepEqual(await kit.owner.getState().discardChanges(KEY), { kind: 'done' });
  });

  it('still refreshes what landed when the person discards the rest', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { title: 'this one landed' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the acknowledgement');

    // The likely ordering, and the only one the conflict band offers an action for: something was
    // acknowledged, the next send was refused, and Discard is the single way out.
    kit.server.writeBehind({ description: 'someone else' });
    kit.owner.getState().editFields(KEY, { title: 'this one did not' });
    await committed(kit, 3);
    kit.fire();
    await until(() => kit.record(KEY).syncState === 'conflicted', 'the conflict');

    assert.deepEqual(kit.applied, [], 'nothing has been refreshed yet: the editor is still open');
    assert.deepEqual(await kit.owner.getState().discardChanges(KEY), { kind: 'done' });

    assert.deepEqual(
      kit.applied,
      [{ ref: { type: 'resource', id: 42 }, activation: 1 }],
      'throwing away the record is not a reason to leave the screens behind it stale',
    );
    assert.equal(kit.record(KEY), null);
  });

  it('discards a record that never acknowledged anything without refreshing', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { title: 'never sent' });
    await committed(kit, 2);

    assert.deepEqual(await kit.owner.getState().discardChanges(KEY), { kind: 'done' });
    assert.deepEqual(kit.applied, [], 'nothing reached the server, so nothing is stale');
  });

  it('treats a rebuilt tag list holding the same tags as no change at all', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { tags: ['work', 'urgent'] });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the acknowledgement');

    const version = kit.state().protection[KEY].committedVersion;

    // A new array with the same contents, which is what a tag sheet hands back on every commit.
    kit.owner.getState().editFields(KEY, { tags: ['work', 'urgent'] });
    await until(() => true, 'a turn');

    assert.equal(
      kit.state().protection[KEY].committedVersion,
      version,
      'no version bumped, so no row written and no debounce armed',
    );
    assert.equal(kit.timers.size, 0);

    // And a real change is still a change.
    kit.owner.getState().editFields(KEY, { tags: ['work'] });
    await committed(kit, version + 1);
    kit.fire();
    await until(() => kit.server.updates.length === 2, 'the tag removal');
    assert.deepEqual(kit.server.updates[1].removeTags, ['urgent']);
  });

  it('never treats a write that lost a race as the version it just wrote', async () => {
    // The row this store answers with is at a *later* version than the write asked for, which is what
    // a coalesced write that lost a race looks like from here. Reporting that number back would
    // install the bytes of the write that lost under the version of the write that won - and this
    // owner is the only reader of the pairing `protection.ts` exists to keep.
    const kit = await opened({
      store: (real) => ({
        writeEditVersion: async (write) => {
          const record = await real.writeEditVersion(write);

          return record === null ? null : { ...record, draftVersion: write.draftVersion + 5 };
        },
      }),
    });

    kit.owner.getState().editFields(KEY, { title: 'raced' });
    await until(
      () => kit.state().protection[KEY]?.writing === false,
      'the write to have been attempted',
    );

    assert.equal(
      kit.state().protection[KEY].committedVersion,
      1,
      'the core does not adopt a version it did not write',
    );

    kit.fire();
    await until(() => true, 'a turn');
    assert.equal(kit.server.updates.length, 0, 'so nothing is sent under a revision claiming it');
  });

  it('never dispatches under a session the app has moved on from', async () => {
    const kit = await opened({ sessionIsCurrent: (session) => session.activation === 1 });

    kit.owner.getState().editFields(KEY, { title: 'retired' });
    await committed(kit, 2);
    kit.owner.getState().resume(KEY, { ...SESSION, activation: 2 });
    kit.fire();
    await until(() => true, 'a turn');

    assert.equal(kit.server.updates.length, 0);
    assert.deepEqual(kit.owner.getState().standingFor(KEY), { kind: 'offline' });
  });

  it('never sends a version the store has not confirmed', async () => {
    const kit = await opened();
    const record = kit.record(KEY);

    // The document the editor is holding, accepted but deliberately not yet written.
    assert.equal(diff(record.base, record.content), null);

    kit.owner.getState().editFields(KEY, { title: 'unwritten' });
    // Fired before the write settles: the committed version is still 1, and 1 is acknowledged.
    kit.fire();
    await until(() => true, 'a turn');

    assert.equal(kit.server.updates.length, 0, 'only a committed version may leave the phone');

    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.updates.length === 1, 'the send once it is safe');
  });

  it('sends a body only when the document actually changed', async () => {
    const kit = await opened({
      server: serverModel({ body: { format: 'tiptap', value: documentWith('first') } }),
    });

    kit.owner.getState().editFields(KEY, { description: 'about it' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.server.updates.length === 1, 'the send');

    assert.equal(kit.server.updates[0].body, undefined, 'an untouched body is not a change');
    assert.deepEqual(Object.keys(kit.server.updates[0]).sort(), [
      'description',
      'format',
      'revision',
      'target',
    ]);
  });

  it('refuses to open anything without a usable session', async () => {
    const kit = await editHarness();

    await kit.owner.getState().initialize();

    assert.deepEqual(await kit.owner.getState().open(42, { ...SESSION, usable: false }), {
      kind: 'unavailable',
      failure: null,
    });
    assert.equal(kit.server.gets, 0, 'and asks nothing');
  });

  it('reports the read failure when there is nothing local to fall back to', async () => {
    const kit = await editHarness();

    await kit.owner.getState().initialize();
    kit.server.getFailure = clientFailure('transport', null, 'not_applicable');

    const outcome = await kit.owner.getState().open(42, SESSION);

    assert.equal(outcome.kind, 'unavailable');
    assert.equal(outcome.failure.kind, 'transport');
  });

  it('refuses a body this build cannot open rather than emptying it', async () => {
    const kit = await editHarness({
      server: serverModel({
        body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'nope' }] } },
      }),
    });

    await kit.owner.getState().initialize();

    assert.deepEqual(await kit.owner.getState().open(42, SESSION), {
      kind: 'unavailable',
      failure: null,
    });
  });
});

describe('the record as something a list can draw', () => {
  it('reports an unsent change as unfinished, and a sent one as nothing at all', async () => {
    const kit = await opened();

    kit.owner.getState().editFields(KEY, { title: 'unsent' });
    await committed(kit, 2);

    const listed = () =>
      unfinishedEdits({
        edits: kit.state().edits,
        unusableEdits: kit.state().unusableEdits,
        standingFor: kit.owner.getState().standingFor,
        connectionId: 'c1',
      });

    assert.equal(listed().length, 1);
    assert.equal(listed()[0].standing, 'pending');
    assert.equal(listed()[0].title, 'unsent');

    kit.fire();
    await until(() => kit.record(KEY).acknowledgedVersion === 2, 'the acknowledgement');

    assert.deepEqual(listed(), [], 'everything on the server is not unfinished');
  });

  it('reports a conflicted record as conflicted', async () => {
    const kit = await opened();

    kit.server.writeBehind({ title: 'theirs' });
    kit.owner.getState().editFields(KEY, { title: 'mine' });
    await committed(kit, 2);
    kit.fire();
    await until(() => kit.record(KEY).syncState === 'conflicted', 'the conflict');

    const listed = unfinishedEdits({
      edits: kit.state().edits,
      unusableEdits: kit.state().unusableEdits,
      standingFor: kit.owner.getState().standingFor,
      connectionId: 'c1',
    });

    assert.equal(listed.length, 1);
    assert.equal(listed[0].standing, 'conflicted');
    assert.deepEqual(listed[0].actions, ['open', 'discard']);
  });
});

/**
 * What a list of unfinished notes says, and what it offers.
 *
 * The standings here are the real ones: `deriveStanding` decides what every record means, and this
 * checks only what the projection adds on top - grouping, ordering, scope and which actions are
 * actually performable. Faking the standing would make this a test of a fake, and the one rule worth
 * protecting is the one the standing owns.
 *
 * The rules being pinned: a created draft whose content was cleared is not a card; a created draft
 * with writing left in it is; an unresolved save never offers a correction; a retired connection
 * offers only copy and discard; and an attempt whose draft is gone offers nothing that would fail.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyDocument } from '@raphael/content';

import { deriveStanding } from './policy.ts';
import { pendingReceipts, unfinishedNotes } from './unfinished.ts';

const T0 = 1_700_000_000_000;
const CONNECTION = 'c1';

const document = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const draft = (over = {}) => ({
  draftId: 'd1',
  connectionId: CONNECTION,
  endpoint: 'https://raphael.example',
  state: 'composing',
  title: 'A note',
  description: '',
  document: document('written'),
  tags: [],
  contentSchemaVersion: 1,
  destination: { type: 'area', id: 3 },
  draftVersion: 2,
  submittedVersion: null,
  serverNodeId: null,
  serverRevision: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const attempt = (over = {}) => ({
  attemptId: 'a1',
  draftId: 'd1',
  connectionId: CONNECTION,
  endpoint: 'https://raphael.example',
  state: 'uncertain',
  request: '{}',
  submittedDraftVersion: 2,
  title: 'A note',
  destination: { type: 'area', id: 3 },
  firstDispatchAt: T0,
  firstUncertainAt: T0,
  clockAnomaly: false,
  lastOutcome: null,
  acknowledged: null,
  observedAt: T0,
  ...over,
});

const acknowledged = (over = {}) => ({
  id: 42,
  revision: 1,
  title: 'A note',
  kind: 'note',
  entity: { id: 42 },
  ...over,
});

/** The projection over real standings, with the clock a little after everything happened. */
const project = (drafts, attempts, over = {}) =>
  unfinishedNotes({
    drafts,
    unusableDrafts: over.unusableDrafts ?? [],
    attempts,
    unsaved: over.unsaved ?? {},
    sending: over.sending ?? [],
    connectionId: over.connectionId === undefined ? CONNECTION : over.connectionId,
    standingFor: (draftId) => {
      const record = drafts.find((candidate) => candidate.draftId === draftId);

      if (record === undefined) return null;

      return deriveStanding({
        draft: record,
        attempts,
        confirmed: (attemptId) => (over.unsaved ?? {})[attemptId],
        now: over.now ?? T0 + 1000,
        monotonicElapsedMs: () => null,
        payloadUsable: () => over.payloadUsable ?? true,
      });
    },
  });

test('a draft nobody has sent is a draft, and can only be opened or discarded', () => {
  const rows = project([draft()], []);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'draft');
  assert.deepEqual([...rows[0].actions], ['open', 'discard']);
  assert.equal(rows[0].onHome, true);
  assert.equal(rows[0].key, 'draft:d1');
});

test('a save with no answer offers a copy and a look, and never a correction', () => {
  const rows = project([draft({ state: 'composing' })], [attempt()]);

  assert.equal(rows[0].status, 'unresolved');
  // Copy is the escape, because a second save under a fresh key would be a second note. The bar's
  // own refusal is the owner's; this is the list agreeing with it.
  assert.deepEqual([...rows[0].actions], ['open', 'look_in', 'copy', 'discard']);
  assert.equal(rows[0].withdrawn, null);
});

test('a refusal that answered a replay stays unresolved and keeps its evidence', () => {
  // The attempt was uncertain first, and the server then refused the replay. That refusal answers
  // for the replay; the first dispatch may well have committed before its own answer was lost.
  const rows = project(
    [draft()],
    [
      attempt({
        state: 'blocked',
        firstUncertainAt: T0,
        lastOutcome: { kind: 'rejected', code: 'invalid_input', message: 'no', at: T0 },
      }),
    ],
  );

  assert.equal(rows[0].status, 'unresolved');
  assert.notEqual(rows[0].status, 'refused');
});

test('a refusal with no earlier uncertainty is a refusal', () => {
  const rows = project(
    [draft()],
    [
      attempt({
        state: 'blocked',
        firstUncertainAt: null,
        lastOutcome: { kind: 'rejected', code: 'title_required', message: 'no', at: T0 },
      }),
    ],
  );

  assert.equal(rows[0].status, 'refused');
  assert.deepEqual([...rows[0].actions], ['open', 'discard']);
});

test('a replay the window has closed on says why, without claiming nothing was created', () => {
  const rows = project([draft()], [attempt()], { now: T0 + 72 * 60 * 60 * 1000 });

  assert.equal(rows[0].status, 'unresolved_withdrawn');
  assert.equal(rows[0].withdrawn, 'window_ended');
  assert.ok(rows[0].actions.includes('copy'), 'copying is the way forward once a replay is gone');
});

test('a clock that moved is told apart from a window that ended', () => {
  const rows = project([draft()], [attempt({ clockAnomaly: true })]);

  assert.equal(rows[0].withdrawn, 'clock_anomaly');
});

test('a conflict withdraws the replay and says so as a conflict', () => {
  const rows = project(
    [draft()],
    [
      attempt({
        state: 'blocked',
        firstUncertainAt: T0,
        lastOutcome: { kind: 'rejected', code: 'slug_conflict', message: 'taken', at: T0 },
      }),
    ],
  );

  assert.equal(rows[0].status, 'unresolved_withdrawn');
  assert.equal(rows[0].withdrawn, 'conflict');
});

test('a created note whose content was cleared is not an unfinished note', () => {
  const rows = project(
    [
      draft({
        state: 'created',
        serverNodeId: 42,
        serverRevision: 1,
        title: '',
        description: '',
        document: createEmptyDocument(),
      }),
    ],
    [],
  );

  // The row stays on disk as the guard that stops a second creation. It is not a card, because
  // there is nothing unfinished about it.
  assert.deepEqual(rows, []);
});

test('a created note with writing left on the phone is a remainder, and is offered a copy', () => {
  const rows = project(
    [draft({ state: 'created', serverNodeId: 42, serverRevision: 1, title: 'kept on writing' })],
    [],
  );

  assert.equal(rows[0].status, 'remainder');
  assert.deepEqual(rows[0].server, { id: 42, revision: 1 });
  assert.ok(rows[0].actions.includes('copy'));
  // There is no update operation in this slice, so nothing here may offer to save it.
  assert.ok(!rows[0].actions.includes('record_again'));
});

/**
 * Tags are authored content, so they count as writing left behind like every other field.
 *
 * The acknowledgement clears all four fields together, so a non-empty list on a created draft means
 * tags written since the creation - which the server was never given and which the status line and
 * this list both have to report rather than calling the note finished.
 */
test('tags written after a creation are writing left on the phone, like any other field', () => {
  const cleared = {
    state: 'created',
    serverNodeId: 42,
    serverRevision: 1,
    title: '',
    description: '',
    document: createEmptyDocument(),
  };
  const rows = project([draft({ ...cleared, tags: ['sync'] })], []);

  assert.equal(rows[0].status, 'remainder');

  // And an entirely cleared draft is still not a card: there is nothing unfinished about it.
  assert.deepEqual(project([draft({ ...cleared, tags: [] })], []), []);
});

test('a server success this phone could not write down offers only the local retry', () => {
  const rows = project([draft()], [attempt({ state: 'uncertain' })], {
    unsaved: { a1: acknowledged() },
  });

  assert.equal(rows[0].status, 'unrecorded_success');
  assert.ok(rows[0].actions.includes('record_again'));
  assert.ok(!rows[0].actions.includes('copy'), 'a second creation is never the repair for this');
});

test('work for a connection this phone has left offers only copy and discard', () => {
  const rows = project([draft({ connectionId: 'other', endpoint: 'https://old.example' })], []);

  assert.equal(rows[0].scope, 'retired');
  assert.equal(rows[0].onHome, false, 'retired work never appears in the current Home');
  assert.deepEqual([...rows[0].actions], ['copy', 'discard']);
});

test('a note this build cannot open is reported, with the reason it cannot', () => {
  const rows = project([], [], {
    unusableDrafts: [
      {
        draftId: 'u1',
        connectionId: CONNECTION,
        endpoint: 'https://raphael.example',
        title: 'Written by a newer build',
        contentSchemaVersion: 99,
        problem: 'unsupported_content_schema',
      },
    ],
  });

  assert.equal(rows.length, 1, 'it is a row, never a count beside an empty list');
  assert.equal(rows[0].status, 'unusable');
  assert.equal(rows[0].problem, 'unsupported_content_schema');
  assert.equal(rows[0].key, 'unusable:u1');
  // The owner never adopted it, so there is no draft to open, copy or discard - and migrating it is
  // the one thing that is forbidden outright.
  assert.deepEqual([...rows[0].actions], []);
  // And it is not a card on Home, where every other card goes somewhere when it is tapped.
  assert.equal(rows[0].onHome, false);
});

test('an unreadable row claims no title and no time it cannot support', () => {
  const rows = project([], [], {
    unusableDrafts: [
      {
        draftId: 'u2',
        connectionId: null,
        endpoint: null,
        title: null,
        contentSchemaVersion: null,
        problem: 'unreadable_row',
      },
    ],
  });

  assert.equal(rows[0].title, '');
  assert.equal(rows[0].endpoint, '');
  assert.equal(rows[0].activityAt, 0);
  // Not `retired`: that is a claim about where it came from, and where it came from is exactly
  // what could not be read. The recovery screen keeps these out of both connection headings.
  assert.equal(rows[0].scope, 'unknown');
});

test('retained rows come last, because nothing is waiting on a decision about them', () => {
  const rows = project([draft()], [], {
    unusableDrafts: [
      {
        draftId: 'u1',
        connectionId: CONNECTION,
        endpoint: 'https://raphael.example',
        title: 'Kept',
        contentSchemaVersion: 99,
        problem: 'unusable_body',
      },
    ],
  });

  assert.deepEqual(
    rows.map((row) => row.status),
    ['draft', 'unusable'],
  );
});

test('an attempt whose draft is gone is reported and offers nothing that would fail', () => {
  const rows = project([], [attempt({ draftId: 'gone' })]);

  assert.equal(rows[0].key, 'attempt:a1');
  assert.equal(rows[0].draftId, null);
  // There is no draft to open, copy or discard, and the owner will not delete an attempt that may
  // stand for a creation. Offering any of them would be a control that answers no.
  assert.deepEqual([...rows[0].actions], ['look_in']);
});

test('the fixed order leads with what is waiting on a decision, and is total', () => {
  const rows = project(
    [
      draft({ draftId: 'plain', updatedAt: T0 + 5 }),
      draft({ draftId: 'refused', updatedAt: T0 + 6 }),
      draft({ draftId: 'unknown', updatedAt: T0 + 7 }),
      draft({ draftId: 'newer-draft', updatedAt: T0 + 9 }),
    ],
    [
      attempt({
        attemptId: 'r1',
        draftId: 'refused',
        state: 'blocked',
        firstUncertainAt: null,
        lastOutcome: { kind: 'rejected', code: 'title_required', message: 'no', at: T0 },
      }),
      attempt({ attemptId: 'u1', draftId: 'unknown' }),
    ],
  );

  assert.deepEqual(
    rows.map((row) => row.draftId),
    ['unknown', 'refused', 'newer-draft', 'plain'],
  );
  // Within a group, the latest local activity leads. Two renders of the same rows agree.
  assert.deepEqual(
    project(
      [draft({ draftId: 'a', updatedAt: T0 }), draft({ draftId: 'b', updatedAt: T0 + 1 })],
      [],
    ).map((row) => row.draftId),
    ['b', 'a'],
  );
});

test('receipts queue oldest first, and only for the connection being worked under', () => {
  const queue = pendingReceipts(
    [
      attempt({ attemptId: 'a2', firstDispatchAt: T0 + 10, acknowledged: acknowledged({ id: 2 }) }),
      attempt({ attemptId: 'a1', firstDispatchAt: T0, acknowledged: acknowledged({ id: 1 }) }),
      attempt({ attemptId: 'a3', connectionId: 'other', acknowledged: acknowledged({ id: 3 }) }),
    ],
    CONNECTION,
  );

  assert.deepEqual(
    queue.map((receipt) => receipt.attemptId),
    ['a1', 'a2'],
  );
});

test('an attempt with no acknowledgement is not a receipt', () => {
  assert.deepEqual(pendingReceipts([attempt()], CONNECTION), []);
});

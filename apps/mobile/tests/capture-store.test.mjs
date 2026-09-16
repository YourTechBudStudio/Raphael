/**
 * Capture's two tables, against real SQLite.
 *
 * The properties defended here are the ones that decide whether someone's unsent writing survives:
 * uncertainty outlives later definite failures, the observed-time mark never moves backwards, an
 * acknowledgement and the draft's creation commit together or not at all, consumed content is
 * cleared only when the transaction itself agrees nothing newer exists, and a row this build cannot
 * read is reported rather than repaired, downgraded, or counted as nothing unfinished.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createEmptyDocument } from '@raphael/content';

import { logicalStateOf, factsOf } from '../src/modules/capture/policy.ts';
import { ATTEMPTS_TABLE, DRAFTS_TABLE } from '../src/modules/capture/schema.ts';
import { openCaptureStore } from '../src/modules/capture/store.ts';
import { openNodeDatabase } from './support/node-sqlite.mjs';

const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryFile = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-capture-'));
  temporaries.push(dir);

  return path.join(dir, 'capture.db');
};

const T0 = 1_700_000_000_000;
const DESTINATION = { type: 'area', id: 3 };
const DOCUMENT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
};

const opened = async (location) => {
  const db = await openNodeDatabase(location);
  const outcome = await openCaptureStore(db, () => T0);
  assert.equal(outcome.kind, 'ready', outcome.kind === 'failed' ? outcome.message : '');

  return { db, store: outcome.store };
};

const newDraft = (over = {}) => ({
  draftId: 'd1',
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  title: '',
  description: '',
  document: DOCUMENT,
  destination: DESTINATION,
  at: T0,
  ...over,
});

const newIntent = (over = {}) => ({
  attemptId: 'a1',
  draftId: 'd1',
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  request: JSON.stringify({ type: 'resource', kind: 'note', idempotencyKey: 'k1' }),
  submittedDraftVersion: 1,
  title: '',
  destination: DESTINATION,
  at: T0,
  ...over,
});

const entity = (over = {}) => ({
  id: 42,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: 'a-note',
  revision: 1,
  title: 'A note',
  description: '',
  tags: [],
  body: { format: 'tiptap', value: DOCUMENT },
  metadata: {},
  ...over,
});

const acknowledgement = (over = {}) => ({
  attemptId: 'a1',
  draftId: 'd1',
  result: { id: 42, revision: 1, title: 'A note', kind: 'note', entity: entity() },
  response: JSON.stringify({ entity: entity() }),
  submittedVersion: 1,
  clearContent: true,
  emptyDocument: createEmptyDocument(),
  at: T0 + 100,
  ...over,
});

const one = async (store) => {
  const stored = await store.list();
  assert.equal(stored.unreadableAttempts, 0);
  assert.equal(stored.unusableDrafts.length, 0);

  return stored;
};

describe('drafts', () => {
  it('writes a draft that reads back as what was written, with no destination allowed', async () => {
    const { store } = await opened();

    const created = await store.insertDraft(newDraft({ destination: null, title: '' }));

    assert.equal(created.state, 'composing');
    // A note may legitimately have no title; the server resolves one from the content.
    assert.equal(created.title, '');
    assert.equal(created.destination, null);
    assert.equal(created.draftVersion, 1);
    assert.equal(created.submittedVersion, null);
    assert.equal(created.serverNodeId, null);

    await store.close();
  });

  it('refuses to let an older version become the latest protected one', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());

    await store.writeVersion({
      draftId: 'd1',
      title: 'later',
      description: '',
      document: DOCUMENT,
      destination: DESTINATION,
      draftVersion: 4,
      at: T0 + 1,
    });
    // A coalesced write that lost its race arrives with an older version. It must not overwrite.
    const record = await store.writeVersion({
      draftId: 'd1',
      title: 'earlier',
      description: '',
      document: DOCUMENT,
      destination: DESTINATION,
      draftVersion: 2,
      at: T0 + 2,
    });

    assert.equal(record.draftVersion, 4);
    assert.equal(record.title, 'later');

    await store.close();
  });

  it('retains a draft written under another content schema, and refuses to open it', async () => {
    const file = await temporaryFile();
    const { store, db } = await opened(file);
    await store.insertDraft(newDraft());
    await db.run(`UPDATE ${DRAFTS_TABLE} SET content_schema_version = 99 WHERE draft_id = ?`, [
      'd1',
    ]);

    const stored = await store.list();

    // Retained and reported as unrecoverable in this build. Never migrated, never downgraded, and
    // never "there is nothing unfinished".
    assert.equal(stored.drafts.length, 0);
    assert.deepEqual(stored.unusableDrafts, [
      {
        draftId: 'd1',
        connectionId: 'c1',
        endpoint: 'https://raphael.example',
        title: '',
        contentSchemaVersion: 99,
        problem: 'unsupported_content_schema',
      },
    ]);

    await store.close();
  });

  it('separates an unreadable row from a body this build cannot use', async () => {
    const { store, db } = await opened();
    await store.insertDraft(newDraft());
    await store.insertDraft(newDraft({ draftId: 'd2' }));
    // A destination that is itself a note. The type vocabulary deliberately has no CHECK - the
    // contract owns it, and a second authority in SQL could contradict it - so this is caught on
    // the way out instead.
    await db.run(`UPDATE ${DRAFTS_TABLE} SET destination_type = 'resource' WHERE draft_id = ?`, [
      'd1',
    ]);
    await db.run(`UPDATE ${DRAFTS_TABLE} SET body = ? WHERE draft_id = ?`, [
      JSON.stringify({ type: 'doc', content: [{ type: 'summary' }] }),
      'd2',
    ]);

    const stored = await store.list();

    assert.equal(stored.drafts.length, 0);
    assert.deepEqual(
      stored.unusableDrafts.map((draft) => [draft.draftId, draft.problem]),
      [
        ['d1', 'unreadable_row'],
        ['d2', 'unusable_body'],
      ],
    );

    await store.close();
  });
});

describe('attempts', () => {
  it('writes the intent and marks the draft submitted in one transaction', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());

    const written = await store.insertIntent(newIntent());

    assert.equal(written.attempt.state, 'dispatch_intent');
    assert.equal(written.attempt.submittedDraftVersion, 1);
    assert.equal(written.draft.state, 'submitted');
    assert.equal(written.draft.submittedVersion, 1);

    await store.close();
  });

  it('keeps uncertainty through a later rejection', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await store.markUncertain('a1', T0 + 1000);

    // The 401-on-replay case: this attempt was refused, and the creation is still unresolved.
    const record = await store.markBlocked(
      'a1',
      { kind: 'rejected', code: 'unauthorized', message: 'refused', at: T0 + 2000 },
      T0 + 2000,
    );

    assert.equal(record.state, 'blocked');
    assert.equal(record.firstUncertainAt, T0 + 1000);
    assert.equal(logicalStateOf(factsOf(record)), 'unresolved');

    await store.close();
  });

  it('writes the uncertainty timestamp once', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await store.markUncertain('a1', T0 + 1000);

    const record = await store.markUncertain('a1', T0 + 9000);

    assert.equal(record.firstUncertainAt, T0 + 1000);

    await store.close();
  });

  it('never lets the observed mark move backwards', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent({ at: T0 + 5000 }));

    const record = await store.markUncertain('a1', T0 + 1);

    // A clock set back an hour is invisible against the first dispatch and obvious against this.
    assert.equal(record.observedAt, T0 + 5000);

    await store.close();
  });

  it('replaces only a definite refusal, and never an ambiguous record', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await store.markUncertain('a1', T0 + 1);
    await store.markBlocked(
      'a1',
      { kind: 'rejected', code: null, message: 'no', at: T0 + 2 },
      T0 + 2,
    );

    await store.replaceIntent('a1', newIntent({ attemptId: 'a2', at: T0 + 3 }));

    const stored = await one(store);

    // The guard is in the SQL as well as in the policy, because the consequence of getting it wrong
    // is deleting the only record that an ambiguous creation ever happened.
    assert.deepEqual(stored.attempts.map((attempt) => attempt.attemptId).sort(), ['a1', 'a2']);

    await store.close();
  });

  it('reports an unreadable attempt row rather than repairing it', async () => {
    const { store, db } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await db.run(
      `UPDATE ${ATTEMPTS_TABLE} SET destination_type = 'resource' WHERE attempt_id = ?`,
      ['a1'],
    );

    const stored = await store.list();

    // A destination that is itself a note is not a destination. The row stays; the count says so.
    assert.equal(stored.attempts.length, 0);
    assert.equal(stored.unreadableAttempts, 1);

    await store.close();
  });

  it('treats an acknowledged row whose result cannot be read as unreadable', async () => {
    const { store, db } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await store.acknowledge(acknowledgement());
    await db.run(
      `UPDATE ${ATTEMPTS_TABLE} SET acknowledged = '{"entity":{}}' WHERE attempt_id = ?`,
      ['a1'],
    );

    const stored = await store.list();

    // The point of the state is that it reports what the server actually created.
    assert.equal(stored.attempts.length, 0);
    assert.equal(stored.unreadableAttempts, 1);

    await store.close();
  });
});

describe('acknowledgement', () => {
  it('records success, the draft creation and the clearing in one transaction', async () => {
    const file = await temporaryFile();
    const first = await opened(file);
    await first.store.insertDraft(newDraft({ title: 'Consumed' }));
    await first.store.insertIntent(newIntent());

    const written = await first.store.acknowledge(acknowledgement());

    assert.equal(written.cleared, true);
    assert.equal(written.attempt.state, 'acknowledged');
    assert.equal(written.attempt.acknowledged.id, 42);
    assert.equal(written.attempt.acknowledged.entity.slug, 'a-note');
    assert.equal(written.draft.state, 'created');
    assert.equal(written.draft.serverNodeId, 42);
    assert.equal(written.draft.serverRevision, 1);
    assert.equal(written.draft.title, '');
    await first.store.close();

    // And it is on disk, not merely in a returned object.
    const second = await opened(file);
    const stored = await one(second.store);

    assert.equal(stored.drafts[0].state, 'created');
    assert.equal(stored.drafts[0].serverNodeId, 42);
    assert.equal(stored.attempts[0].state, 'acknowledged');

    await second.store.close();
  });

  it('keeps the writing when the transaction finds a later draft version', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft({ title: 'Submitted' }));
    await store.insertIntent(newIntent());
    // A commit landing in the same moment as the answer. The decision was taken before it; the
    // transaction is what notices.
    await store.writeVersion({
      draftId: 'd1',
      title: 'Written since',
      description: '',
      document: DOCUMENT,
      destination: DESTINATION,
      draftVersion: 2,
      at: T0 + 50,
    });

    const written = await store.acknowledge(acknowledgement());

    assert.equal(written.cleared, false);
    // The creation and the base revision are still recorded; only the content is untouched.
    assert.equal(written.draft.state, 'created');
    assert.equal(written.draft.serverNodeId, 42);
    assert.equal(written.draft.title, 'Written since');
    assert.equal(written.draft.draftVersion, 2);

    await store.close();
  });

  it('records the creation without clearing when the owner says newer work exists', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft({ title: 'Submitted' }));
    await store.insertIntent(newIntent());

    const written = await store.acknowledge(acknowledgement({ clearContent: false }));

    assert.equal(written.cleared, false);
    assert.equal(written.draft.state, 'created');
    assert.equal(written.draft.title, 'Submitted');

    await store.close();
  });

  it('removes only a row whose acknowledgement was actually written', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());

    await store.removeAttempt('a1');
    assert.equal((await one(store)).attempts.length, 1, 'an unacknowledged row is not consumed');

    await store.acknowledge(acknowledgement());
    await store.removeAttempt('a1');

    const stored = await one(store);

    assert.equal(stored.attempts.length, 0);
    // Consumption is safe precisely because the draft carries the creation independently.
    assert.equal(stored.drafts[0].state, 'created');
    assert.equal(stored.drafts[0].serverNodeId, 42);

    await store.close();
  });
});

describe('discard', () => {
  it('removes the draft and leaves an unresolved attempt as a listable orphan', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await store.markUncertain('a1', T0 + 1);

    await store.discard({ draftId: 'd1', removeAttemptIds: ['a1'] });

    const stored = await one(store);

    assert.equal(stored.drafts.length, 0);
    // The SQL guard refuses it even when the caller asks: discarding writing cannot un-ask a
    // question the server may already have answered.
    assert.equal(stored.attempts.length, 1);
    assert.equal(stored.attempts[0].draftId, 'd1');

    await store.close();
  });

  it('removes a definite refusal with the draft it belongs to', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await store.markBlocked(
      'a1',
      { kind: 'rejected', code: null, message: 'no', at: T0 + 1 },
      T0 + 1,
    );

    await store.discard({ draftId: 'd1', removeAttemptIds: ['a1'] });

    const stored = await one(store);

    assert.equal(stored.drafts.length, 0);
    assert.equal(stored.attempts.length, 0);

    await store.close();
  });
});

describe('what a previous process left behind', () => {
  it('adopts an interrupted intent as uncertain and returns its draft to composing', async () => {
    const file = await temporaryFile();
    const first = await opened(file);
    await first.store.insertDraft(newDraft());
    await first.store.insertIntent(newIntent());
    // The process dies here: the intent row proves only that a request was about to be sent.
    await first.store.close();

    const second = await opened(file);
    const stored = await one(second.store);

    assert.equal(stored.attempts[0].state, 'uncertain');
    assert.equal(stored.attempts[0].firstUncertainAt, T0);
    // Editable again, while ordinary Save is still refused by the unresolved attempt rather than by
    // this column.
    assert.equal(stored.drafts[0].state, 'composing');
    assert.equal(stored.drafts[0].submittedVersion, 1);

    await second.store.close();
  });

  it('is idempotent, so a repeated sweep does not move the uncertainty timestamp', async () => {
    const file = await temporaryFile();
    const first = await opened(file);
    await first.store.insertDraft(newDraft());
    await first.store.insertIntent(newIntent());
    await first.store.close();

    const second = await opened(file);
    await second.store.reconcile(T0 + 90_000);

    assert.equal((await one(second.store)).attempts[0].firstUncertainAt, T0);

    await second.store.close();
  });

  it('leaves a submitted draft whose attempt is acknowledged exactly as it found it', async () => {
    const file = await temporaryFile();
    const { store, db } = await opened(file);
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await store.acknowledge(acknowledgement({ clearContent: false }));
    // A pair that contradicts itself. Repairing either half would be a guess about whether a note
    // exists, so the sweep does not touch it and `integrityProblemOf` reports it instead.
    await db.run(`UPDATE ${DRAFTS_TABLE} SET state = 'submitted' WHERE draft_id = ?`, ['d1']);

    await store.reconcile(T0 + 1);

    assert.equal((await one(store)).drafts[0].state, 'submitted');

    await store.close();
  });

  it('leaves a submitted draft with no attempt at all, because absence proves nothing', async () => {
    const { store, db } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());
    await db.run(`DELETE FROM ${ATTEMPTS_TABLE} WHERE attempt_id = ?`, ['a1']);

    await store.reconcile(T0 + 1);

    // The missing evidence cannot prove the request was never dispatched, so ordinary Save stays
    // refused rather than being restored by a sweep that found nothing.
    assert.equal((await one(store)).drafts[0].state, 'submitted');

    await store.close();
  });

  it('releases a submitted draft on demand, but never one that is created', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft());
    await store.insertIntent(newIntent());

    assert.equal((await store.releaseDraft('d1', T0 + 1)).state, 'composing');

    await store.acknowledge(acknowledgement({ clearContent: false, submittedVersion: 1 }));

    assert.equal((await store.releaseDraft('d1', T0 + 2)).state, 'created');

    await store.close();
  });
});

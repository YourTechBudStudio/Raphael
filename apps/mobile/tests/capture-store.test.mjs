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
import { RESOURCE_KINDS } from '@raphael/contracts/nodes';

import { logicalStateOf, factsOf } from '../src/modules/capture/policy.ts';
import { ATTEMPTS_TABLE, DRAFTS_TABLE, EDITS_TABLE } from '../src/modules/capture/schema.ts';
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
/** An update envelope as the edit owner persists it: bare on disk, tagged in memory. */
const updateOf = (envelope) => ({ kind: 'update', envelope });
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
  tags: [],
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
  active: false,
  archived: false,
  archiveCauses: [],
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

  it('carries tags as authored content, written and read back as given', async () => {
    const { store } = await opened();
    await store.insertDraft(newDraft({ tags: ['sync', 'design'] }));

    const created = (await one(store)).drafts[0];

    assert.deepEqual(created.tags, ['sync', 'design']);

    // A version write carries them like every other authored field, order included.
    const record = await store.writeVersion({
      draftId: 'd1',
      title: 'Field notes',
      description: '',
      document: DOCUMENT,
      tags: ['design', 'sync'],
      destination: DESTINATION,
      draftVersion: 2,
      at: T0 + 1,
    });

    assert.deepEqual(record.tags, ['design', 'sync']);

    await store.close();
  });

  /**
   * Authored content follows `title` and `description`, never `last_refusal`.
   *
   * The CHECK constraint guarantees a JSON array and says nothing about what is in it. A row whose
   * authored columns are not what they claim is retained and named, never repaired to a default:
   * degrading here would silently throw away tags someone wrote.
   */
  it('refuses a row whose tags are not tags, rather than emptying them', async () => {
    const file = await temporaryFile();
    const { store, db } = await opened(file);
    await store.insertDraft(newDraft({ tags: ['sync'] }));
    await db.run(`UPDATE ${DRAFTS_TABLE} SET tags = '[1,2]' WHERE draft_id = ?`, ['d1']);

    const stored = await store.list();

    assert.equal(stored.drafts.length, 0);
    assert.equal(stored.unusableDrafts.length, 1);
    assert.equal(stored.unusableDrafts[0].problem, 'unreadable_row');

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
      tags: [],
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
      tags: [],
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

describe('acknowledgements saved before archive existed', () => {
  /**
   * A capture file written by the previous build: the attempt is acknowledged with the Create response
   * of that time, which had no lifecycle fields, and the file is at schema version 2.
   */
  const savedAtVersionTwo = async (acknowledged) => {
    const file = await temporaryFile();
    const first = await opened(file);
    await first.store.insertDraft(newDraft());
    await first.store.insertIntent(newIntent());
    await first.store.acknowledge(acknowledgement());
    await first.db.run(`UPDATE ${ATTEMPTS_TABLE} SET acknowledged = ? WHERE attempt_id = ?`, [
      acknowledged,
      'a1',
    ]);
    await first.db.run('PRAGMA user_version = 2');
    await first.store.close();
    return file;
  };

  it('reads an old-shape acknowledgement back after the migration, as active with no causes', async () => {
    const { archived: _archived, archiveCauses: _causes, ...before } = entity();
    const file = await savedAtVersionTwo(JSON.stringify({ entity: before }));

    const { store } = await opened(file);
    const stored = await one(store);

    assert.equal(stored.attempts.length, 1);
    assert.equal(stored.attempts[0].state, 'acknowledged');
    assert.equal(stored.attempts[0].acknowledged.id, 42);
    assert.equal(stored.attempts[0].acknowledged.entity.archived, false);
    assert.deepEqual(stored.attempts[0].acknowledged.entity.archiveCauses, []);

    await store.close();
  });

  it('leaves a saved answer with no entity exactly as it was, and still unreadable', async () => {
    const unusable = '{ "entity" : "not an entity",  "kept": true }';
    const file = await savedAtVersionTwo(unusable);

    const { store, db } = await opened(file);
    const stored = await store.list();

    assert.equal(stored.attempts.length, 0);
    assert.equal(stored.unreadableAttempts, 1);
    const [row] = await db.all(`SELECT acknowledged FROM ${ATTEMPTS_TABLE} WHERE attempt_id = ?`, [
      'a1',
    ]);
    assert.equal(row.acknowledged, unusable, 'not rewritten, not even reformatted');

    await store.close();
  });
});

describe('acknowledgement', () => {
  it('records success, the draft creation and the clearing in one transaction', async () => {
    const file = await temporaryFile();
    const first = await opened(file);
    await first.store.insertDraft(newDraft({ title: 'Consumed', tags: ['sync'] }));
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
    // Every authored field, tags included: they went with the creation, so the draft holds nothing
    // unsent and must not show them back as though it did.
    assert.deepEqual(written.draft.tags, []);
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
      tags: [],
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

/**
 * The edit table.
 *
 * Every writer is guarded, and each guard is the concurrency argument for one transition. What is
 * defended here is that a guard which did not match returns the row **unchanged** rather than a
 * plausible one: the owner publishes from what was written, so a store that reported a hoped-for
 * transition would let it send a version the database never confirmed.
 *
 * The two that matter most. `rebaseEdit` refuses a record holding unsent writing, because adopting a
 * newer server state over it is exactly the loss the record exists to prevent. And a row this build
 * cannot open comes back named, never repaired, and is deletable by key without ever being parsed.
 */
describe('entity_edits', () => {
  const KEY = { connectionId: 'c1', nodeId: 7 };
  const CONTENT = {
    title: 'Contracts',
    description: 'what we agreed',
    slug: 'contracts',
    tags: ['work'],
    document: DOCUMENT,
  };

  const newEdit = (over = {}) => ({
    key: KEY,
    endpoint: 'https://raphael.example',
    nodeType: 'resource',
    kind: 'note',
    content: CONTENT,
    revision: 4,
    at: T0,
    ...over,
  });

  const seeded = async () => {
    const opening = await opened();
    await opening.store.insertEdit(newEdit());

    return opening;
  };

  const only = async (store) => {
    const { edits } = await store.listEdits();

    return edits[0];
  };

  it('seeds a record whose base is the content it was given', async () => {
    const { store } = await opened();

    const record = await store.insertEdit(newEdit());

    assert.deepEqual(record.key, KEY);
    assert.equal(record.nodeType, 'resource');
    assert.equal(record.kind, 'note');
    assert.deepEqual(record.content, CONTENT);
    assert.deepEqual(record.base, CONTENT);
    assert.equal(record.baseRevision, 4);
    assert.equal(record.draftVersion, 1);
    assert.equal(record.acknowledgedVersion, 1);
    assert.equal(record.inflightVersion, null);
    assert.equal(record.inflight, null);
    assert.equal(record.syncState, 'syncing');

    await store.close();
  });

  it('hands back the existing record when the same entity is seeded twice', async () => {
    const { store } = await seeded();

    const second = await store.insertEdit(
      newEdit({ content: { ...CONTENT, title: 'from a second open' }, revision: 9 }),
    );

    // Re-opening an entity is ordinary, and two open() calls racing is the same class of race every
    // other writer on this table absorbs. A throw would be the one path here where losing a race is
    // an exception the caller can only classify by reading a driver message.
    assert.equal(second.content.title, 'Contracts');
    assert.equal(second.baseRevision, 4);
    // Never DO UPDATE: the existing row may hold unsent writing, and overwriting its base with a
    // freshly-read server entity is the loss the record exists to prevent.
    assert.deepEqual(second.base, CONTENT);
    assert.equal((await store.listEdits()).edits.length, 1);

    await store.close();
  });

  it('keeps one row per connection and entity', async () => {
    const { store } = await seeded();
    await store.insertEdit(
      newEdit({ key: { connectionId: 'other', nodeId: 7 }, content: { ...CONTENT, title: 'B' } }),
    );

    const { edits } = await store.listEdits();

    assert.equal(edits.length, 2);
    // Never rewritten onto another connection: switching servers hides one server's pending edits
    // rather than sending them somewhere they do not belong.
    assert.deepEqual(edits.map((edit) => edit.key.connectionId).sort(), ['c1', 'other']);

    await store.close();
  });

  describe('writeEditVersion', () => {
    it('writes a version that moves forward', async () => {
      const { store } = await seeded();

      const record = await store.writeEditVersion({
        key: KEY,
        content: { ...CONTENT, title: 'Renamed' },
        draftVersion: 2,
        at: T0 + 1,
      });

      assert.equal(record.content.title, 'Renamed');
      assert.equal(record.draftVersion, 2);
      // The base is untouched: it is what the server holds, not what is being typed.
      assert.equal(record.base.title, 'Contracts');

      await store.close();
    });

    it('refuses a version that does not move forward, and says so by returning the row as it is', async () => {
      const { store } = await seeded();
      await store.writeEditVersion({ key: KEY, content: CONTENT, draftVersion: 5, at: T0 + 1 });

      const record = await store.writeEditVersion({
        key: KEY,
        content: { ...CONTENT, title: 'stale' },
        draftVersion: 3,
        at: T0 + 2,
      });

      assert.equal(record.draftVersion, 5);
      assert.equal(record.content.title, 'Contracts');

      await store.close();
    });

    it('returns a refused record to syncing in the same statement', async () => {
      const { store } = await seeded();
      await store.markEditRefused(
        KEY,
        { code: 'slug_conflict', field: 'slug', reason: null, at: T0 },
        T0 + 1,
      );

      const record = await store.writeEditVersion({
        key: KEY,
        content: { ...CONTENT, slug: 'fixed' },
        draftVersion: 2,
        at: T0 + 2,
      });

      // Two statements could commit the content and fail to clear the refusal, leaving a record that
      // says the server said no to writing the server has never seen.
      assert.equal(record.syncState, 'syncing');
      assert.equal(record.content.slug, 'fixed');

      await store.close();
    });

    it('clears the refusal diagnostic along with the state it described', async () => {
      const { store } = await seeded();
      await store.markEditRefused(
        KEY,
        { code: 'slug_conflict', field: 'slug', reason: null, at: T0 },
        T0 + 1,
      );

      const record = await store.writeEditVersion({
        key: KEY,
        content: { ...CONTENT, slug: 'fixed' },
        draftVersion: 2,
        at: T0 + 2,
      });

      assert.equal(record.syncState, 'syncing');
      // Otherwise the column would mean "the last refusal, possibly already repaired".
      assert.equal(record.lastRefusal, null);

      await store.close();
    });

    it('leaves a conflicted record conflicted', async () => {
      const { store } = await seeded();
      await store.markEditConflicted(KEY, T0 + 1);

      const record = await store.writeEditVersion({
        key: KEY,
        content: { ...CONTENT, title: 'still writing' },
        draftVersion: 2,
        at: T0 + 2,
      });

      // A conflict is not repaired by writing more; the writing is kept and the verdict stands.
      assert.equal(record.syncState, 'conflicted');
      assert.equal(record.content.title, 'still writing');

      await store.close();
    });
  });

  describe('markEditInflight', () => {
    it('records the envelope beside the version it answers for', async () => {
      const { store } = await seeded();
      const envelope = { title: 'Renamed' };

      const record = await store.markEditInflight(KEY, 1, updateOf(envelope), T0 + 1);

      assert.equal(record.inflightVersion, 1);
      assert.deepEqual(record.inflight, updateOf(envelope));

      await store.close();
    });

    it('refuses a second envelope while one is in the air', async () => {
      const { store } = await seeded();
      await store.markEditInflight(KEY, 1, updateOf({ title: 'first' }), T0 + 1);

      const record = await store.markEditInflight(KEY, 2, updateOf({ title: 'second' }), T0 + 2);

      assert.equal(record.inflightVersion, 1);
      assert.deepEqual(record.inflight, updateOf({ title: 'first' }));

      await store.close();
    });

    it('refuses to dispatch from a conflicted or refused record', async () => {
      const { store } = await seeded();
      await store.markEditConflicted(KEY, T0 + 1);

      assert.equal(
        (await store.markEditInflight(KEY, 1, updateOf({}), T0 + 2)).inflightVersion,
        null,
      );

      await store.close();
    });
  });

  /**
   * A move is the second thing that can be in flight, and each acknowledgement consumes only its own
   * kind. The owner never crosses them - one envelope is in the air at a time and it dispatches on the
   * kind - but these are durable boundaries, so the store refuses a mismatch rather than trusting that.
   */
  describe('moves in flight', () => {
    const MOVE = { kind: 'move', parentId: 9, expectsWrite: true };
    const NOOP = { kind: 'move', parentId: 3, expectsWrite: false };
    const SERVER = { ...CONTENT, title: 'Theirs', tags: ['work', 'theirs'] };
    const raw = (db) => db.get(`SELECT * FROM ${EDITS_TABLE} WHERE node_id = 7`);

    it('stores a move tagged and reads it back as a move', async () => {
      const { store, db } = await seeded();

      const record = await store.markEditInflight(KEY, 1, MOVE, T0 + 1);

      assert.deepEqual(record.inflight, MOVE);
      assert.deepEqual(JSON.parse((await raw(db)).inflight), MOVE);
      assert.deepEqual((await only(store)).inflight, MOVE);

      await store.close();
    });

    it('acknowledges a move by advancing only the base revision and clearing it', async () => {
      const { store } = await seeded();
      await store.markEditInflight(KEY, 1, MOVE, T0 + 1);

      const { applied, record } = await store.acknowledgeMove(KEY, 1, 5, T0 + 2);

      assert.equal(applied, true);
      assert.equal(record.baseRevision, 5);
      assert.equal(record.inflight, null);
      assert.equal(record.inflightVersion, null);
      assert.deepEqual(
        record.base,
        CONTENT,
        'a move carries nothing authored, so the base is kept',
      );
      assert.deepEqual(record.content, CONTENT);
      assert.equal(record.draftVersion, 1, 'a move is not an authored version');
      assert.equal(record.acknowledgedVersion, 1);
      assert.equal(record.syncState, 'syncing');

      await store.close();
    });

    it('does not acknowledge a move that is not the one dispatched', async () => {
      for (const setUp of [
        async () => {},
        (store) => store.markEditInflight(KEY, 1, updateOf({ title: 'x' }), T0 + 1),
        (store) => store.markEditInflight(KEY, 1, MOVE, T0 + 1),
      ]) {
        const { store, db } = await seeded();
        await setUp(store);
        const before = await raw(db);

        // Version 2 is dispatched nowhere; the move above is at version 1.
        const { applied, record } = await store.acknowledgeMove(KEY, 2, 5, T0 + 2);

        assert.equal(applied, false);
        assert.deepEqual(await raw(db), before, 'the row is exactly as it was');
        assert.equal(record.baseRevision, 4);

        await store.close();
      }

      const { store, db } = await seeded();
      await store.markEditInflight(KEY, 1, updateOf({ title: 'x' }), T0 + 1);
      const before = await raw(db);

      assert.equal((await store.acknowledgeMove(KEY, 1, 5, T0 + 2)).applied, false);
      assert.deepEqual(await raw(db), before, 'an update is not consumed as a move');

      await store.close();
    });

    it('does not acknowledge a move, or an unknown kind, as an update', async () => {
      const { store, db } = await seeded();
      await store.markEditInflight(KEY, 1, MOVE, T0 + 1);
      const before = await raw(db);

      await store.acknowledgeEdit(KEY, { ...CONTENT, title: 'Renamed' }, 5, T0 + 2);

      assert.deepEqual(await raw(db), before);

      await db.run(`UPDATE ${EDITS_TABLE} SET inflight = ?`, ['{"kind":null,"title":"x"}']);
      const tagged = await raw(db);

      await store.acknowledgeEdit(KEY, { ...CONTENT, title: 'Renamed' }, 5, T0 + 3);

      assert.deepEqual(await raw(db), tagged, 'a present null kind is not a bare update');

      await store.close();
    });

    it('adopts the server over a lost no-op move, in one transition', async () => {
      const { store } = await seeded();
      await store.markEditInflight(KEY, 1, NOOP, T0 + 1);

      const { applied, record } = await store.adoptAfterNoopMove(KEY, 1, SERVER, 5, T0 + 2);

      assert.equal(applied, true);
      assert.equal(record.inflight, null);
      assert.equal(record.inflightVersion, null);
      assert.equal(record.baseRevision, 5);
      assert.deepEqual(record.base, SERVER);
      assert.deepEqual(record.content, SERVER);
      assert.equal(record.syncState, 'syncing');

      await store.close();
    });

    it('adopts nothing outside exactly the situation it resolves', async () => {
      const cases = [
        [
          'a move that expected a write',
          (store) => store.markEditInflight(KEY, 1, MOVE, T0 + 1),
          1,
        ],
        [
          'an update',
          (store) => store.markEditInflight(KEY, 1, updateOf({ title: 'x' }), T0 + 1),
          1,
        ],
        ['another in-flight version', (store) => store.markEditInflight(KEY, 1, NOOP, T0 + 1), 2],
        [
          'unsent writing',
          async (store) => {
            await store.markEditInflight(KEY, 1, NOOP, T0 + 1);
            await store.writeEditVersion({
              key: KEY,
              content: { ...CONTENT, title: 'mine' },
              draftVersion: 2,
              at: T0 + 2,
            });
          },
          1,
        ],
      ];

      for (const [name, setUp, version] of cases) {
        const { store, db } = await seeded();
        await setUp(store);
        const before = await raw(db);

        const { applied } = await store.adoptAfterNoopMove(KEY, version, SERVER, 5, T0 + 3);

        assert.equal(applied, false, name);
        assert.deepEqual(await raw(db), before, `${name}: the row is exactly as it was`);

        await store.close();
      }
    });

    /**
     * The only proof that a failure inside either transition leaves the move in flight. A temporary
     * trigger aborts the `UPDATE` after the guard has been read, and the SQL port must roll the whole
     * transaction back: an envelope gone over a stale base would look settled and never retry.
     */
    it('rolls both transitions back entirely when their write fails', async () => {
      for (const [envelope, attempt] of [
        [NOOP, (store) => store.adoptAfterNoopMove(KEY, 1, SERVER, 5, T0 + 2)],
        [MOVE, (store) => store.acknowledgeMove(KEY, 1, 5, T0 + 2)],
      ]) {
        const { store, db } = await seeded();
        await store.markEditInflight(KEY, 1, envelope, T0 + 1);
        await db.run(
          `CREATE TEMP TRIGGER abort_edit BEFORE UPDATE OF base_revision ON ${EDITS_TABLE}
           BEGIN SELECT RAISE(ABORT, 'forced'); END`,
        );
        const before = await raw(db);

        await assert.rejects(attempt(store));
        assert.deepEqual(await raw(db), before, 'byte for byte, envelope included');

        await db.run('DROP TRIGGER abort_edit');
        assert.equal((await attempt(store)).applied, true, 'and it applies once the fault is gone');

        await store.close();
      }
    });

    it('retains a row with an unknown kind, or a move with a slug, as unreadable and deletable', async () => {
      for (const inflight of [
        '{"kind":"rename","title":"x"}',
        '{"kind":"move","parentId":9,"expectsWrite":true,"slug":"x"}',
      ]) {
        const { store, db } = await seeded();
        await db.run(`UPDATE ${EDITS_TABLE} SET inflight_version = 1, inflight = ?`, [inflight]);

        const { edits, unusableEdits } = await store.listEdits();

        assert.equal(edits.length, 0, inflight);
        assert.equal(unusableEdits[0].problem, 'unreadable_row');

        await store.deleteEdit(KEY);
        assert.deepEqual(await store.listEdits(), { edits: [], unusableEdits: [] });

        await store.close();
      }
    });

    it('still reads a stored bare envelope as an update', async () => {
      const { store, db } = await seeded();
      await db.run(`UPDATE ${EDITS_TABLE} SET inflight_version = 1, inflight = ?`, [
        '{"title":"x"}',
      ]);

      assert.deepEqual((await only(store)).inflight, updateOf({ title: 'x' }));

      await store.close();
    });
  });

  describe('acknowledgeEdit', () => {
    it('advances the acknowledged mark, makes the base what was sent, and clears the envelope', async () => {
      const { store } = await seeded();
      await store.writeEditVersion({
        key: KEY,
        content: { ...CONTENT, title: 'Renamed' },
        draftVersion: 2,
        at: T0 + 1,
      });
      await store.markEditInflight(KEY, 2, updateOf({ title: 'Renamed' }), T0 + 2);

      const record = await store.acknowledgeEdit(KEY, { ...CONTENT, title: 'Renamed' }, 5, T0 + 3);

      assert.equal(record.acknowledgedVersion, 2);
      assert.equal(record.base.title, 'Renamed');
      assert.equal(record.baseRevision, 5);
      assert.equal(record.inflightVersion, null);
      assert.equal(record.inflight, null);

      await store.close();
    });

    it('refuses when nothing is in flight, so an answer cannot be applied twice', async () => {
      const { store } = await seeded();

      const record = await store.acknowledgeEdit(KEY, { ...CONTENT, title: 'X' }, 9, T0 + 1);

      assert.equal(record.acknowledgedVersion, 1);
      assert.equal(record.baseRevision, 4);

      await store.close();
    });

    it('clears a refusal, because the record has just succeeded', async () => {
      const { store } = await seeded();
      await store.markEditRefused(
        KEY,
        { code: 'slug_conflict', field: 'slug', reason: null, at: T0 },
        T0 + 1,
      );
      await store.writeEditVersion({ key: KEY, content: CONTENT, draftVersion: 2, at: T0 + 2 });
      await store.markEditInflight(KEY, 2, updateOf({ title: 'x' }), T0 + 3);

      const record = await store.acknowledgeEdit(KEY, CONTENT, 5, T0 + 4);

      assert.equal(record.syncState, 'syncing');
      assert.equal(record.lastRefusal, null);

      await store.close();
    });
  });

  it('acknowledges an empty envelope locally, moving nothing but the mark', async () => {
    const { store } = await seeded();
    await store.writeEditVersion({ key: KEY, content: CONTENT, draftVersion: 4, at: T0 + 1 });

    const record = await store.acknowledgeEditLocally(KEY, 4, T0 + 2);

    assert.equal(record.acknowledgedVersion, 4);
    assert.equal(record.baseRevision, 4);
    assert.deepEqual(record.base, CONTENT);

    // Never backwards: a later local acknowledgement for an older version changes nothing.
    assert.equal((await store.acknowledgeEditLocally(KEY, 2, T0 + 3)).acknowledgedVersion, 4);

    await store.close();
  });

  it('refuses to acknowledge locally while an envelope is in the air', async () => {
    const { store } = await seeded();
    await store.writeEditVersion({ key: KEY, content: CONTENT, draftVersion: 3, at: T0 + 1 });
    await store.markEditInflight(KEY, 3, updateOf({ title: 'x' }), T0 + 2);

    const record = await store.acknowledgeEditLocally(KEY, 3, T0 + 3);

    // The rule the whole loop rests on: the acknowledged mark never passes the version that was
    // actually sent. Moving it here would report writing as on the server while its answer is still
    // outstanding. Also unreachable from the owner, and guarded at the durable boundary regardless.
    assert.equal(record.acknowledgedVersion, 1);
    assert.equal(record.inflightVersion, 3);

    await store.close();
  });

  it('clears an in-flight envelope without touching the verdict', async () => {
    const { store } = await seeded();
    await store.markEditInflight(KEY, 1, updateOf({ title: 'x' }), T0 + 1);

    const record = await store.clearEditInflight(KEY, T0 + 2);

    assert.equal(record.inflightVersion, null);
    assert.equal(record.inflight, null);
    assert.equal(record.syncState, 'syncing');
    assert.equal(record.acknowledgedVersion, 1);

    await store.close();
  });

  /**
   * Unreachable from the owner by construction, and guarded anyway.
   *
   * Phase 06's tick refuses unless `sync_state === 'syncing'`, and `reconcile` needs an in-flight
   * envelope, which a conflicted record does not have. So there is no caller to go hunting for: this
   * is defense at the durable boundary, exactly like the guards on `markEditInflight` and
   * `acknowledgeEdit`.
   */
  it('refuses to downgrade a conflict into a refusal', async () => {
    const { store } = await seeded();
    await store.markEditConflicted(KEY, T0 + 1);

    const record = await store.markEditRefused(
      KEY,
      { code: 'slug_conflict', field: 'slug', reason: null, at: T0 + 2 },
      T0 + 2,
    );

    // A refusal here would be returned to `syncing` by writeEditVersion's CASE on the next keystroke,
    // and autosave would resume on a record whose base revision the server has already rejected -
    // telling someone their work is saving while every send is doomed.
    assert.equal(record.syncState, 'conflicted');
    assert.equal(record.lastRefusal, null);

    await store.close();
  });

  it('records a refusal and drops the envelope with it', async () => {
    const { store } = await seeded();
    await store.markEditInflight(KEY, 1, updateOf({ slug: 'taken' }), T0 + 1);
    const refusal = { code: 'slug_conflict', field: 'slug', reason: null, at: T0 + 2 };

    const record = await store.markEditRefused(KEY, refusal, T0 + 2);

    assert.equal(record.syncState, 'refused');
    assert.deepEqual(record.lastRefusal, refusal);
    assert.equal(record.inflightVersion, null);

    await store.close();
  });

  it('degrades an unreadable refusal to none rather than losing the record', async () => {
    const { store, db } = await seeded();
    await store.markEditRefused(
      KEY,
      { code: 'slug_conflict', field: 'slug', reason: null, at: T0 },
      T0 + 1,
    );
    await db.run(`UPDATE ${EDITS_TABLE} SET last_refusal = ?`, ['{"nonsense":true}']);

    const record = await only(store);

    // `sync_state` carries the fact independently, so an unparseable diagnostic costs a sentence.
    // Calling the row unreadable would cost someone their unsent writing.
    assert.equal(record.syncState, 'refused');
    assert.equal(record.lastRefusal, null);

    await store.close();
  });

  it('drops a refusal field the contract does not name', async () => {
    const { store, db } = await seeded();
    await store.markEditRefused(
      KEY,
      { code: 'invalid_input', field: 'slug', reason: null, at: T0 },
      T0 + 1,
    );
    await db.run(`UPDATE ${EDITS_TABLE} SET last_refusal = ?`, [
      JSON.stringify({ code: 'invalid_input', field: 'not_a_field', reason: null, at: T0 }),
    ]);

    assert.equal((await only(store)).lastRefusal.field, null);

    await store.close();
  });

  it('marks a conflict and keeps every local column', async () => {
    const { store } = await seeded();
    await store.writeEditVersion({
      key: KEY,
      content: { ...CONTENT, title: 'mine' },
      draftVersion: 2,
      at: T0 + 1,
    });
    await store.markEditInflight(KEY, 2, updateOf({ title: 'mine' }), T0 + 2);

    const record = await store.markEditConflicted(KEY, T0 + 3);

    assert.equal(record.syncState, 'conflicted');
    assert.equal(record.inflightVersion, null);
    // The writing is kept, never merged and never resolved on someone's behalf.
    assert.equal(record.content.title, 'mine');
    assert.equal(record.acknowledgedVersion, 1);

    await store.close();
  });

  describe('rebaseEdit', () => {
    it('adopts a newer server state on a settled record', async () => {
      const { store } = await seeded();
      const newer = { ...CONTENT, title: 'From the server' };

      const record = await store.rebaseEdit(KEY, newer, 9, T0 + 1);

      assert.deepEqual(record.content, newer);
      assert.deepEqual(record.base, newer);
      assert.equal(record.baseRevision, 9);

      await store.close();
    });

    it('refuses a record holding unsent writing', async () => {
      const { store } = await seeded();
      await store.writeEditVersion({
        key: KEY,
        content: { ...CONTENT, title: 'mine, unsent' },
        draftVersion: 2,
        at: T0 + 1,
      });

      const record = await store.rebaseEdit(KEY, { ...CONTENT, title: 'theirs' }, 9, T0 + 2);

      // The one thing the record exists to prevent: adopting a server state over writing that has
      // never been sent.
      assert.equal(record.content.title, 'mine, unsent');
      assert.equal(record.baseRevision, 4);

      await store.close();
    });

    it('refuses while an envelope is in flight', async () => {
      const { store } = await seeded();
      await store.markEditInflight(KEY, 1, updateOf({ title: 'x' }), T0 + 1);

      assert.equal((await store.rebaseEdit(KEY, CONTENT, 9, T0 + 2)).baseRevision, 4);

      await store.close();
    });

    it('refuses a conflicted or refused record', async () => {
      const { store } = await seeded();
      await store.markEditConflicted(KEY, T0 + 1);

      assert.equal((await store.rebaseEdit(KEY, CONTENT, 9, T0 + 2)).baseRevision, 4);

      await store.close();
    });
  });

  describe('advanceEditRevision', () => {
    /** Refused, with writing: the record a phone archive most needs to leave intact. */
    const refused = async () => {
      const opening = await seeded();
      const { store } = opening;

      await store.writeEditVersion({
        key: KEY,
        content: { ...CONTENT, slug: 'taken' },
        draftVersion: 2,
        at: T0 + 1,
      });
      await store.markEditInflight(KEY, 2, updateOf({ slug: 'taken' }), T0 + 2);
      await store.markEditRefused(
        KEY,
        { code: 'slug_conflict', field: 'slug', reason: null, at: T0 + 3 },
        T0 + 3,
      );

      return opening;
    };

    it('moves only the base revision and the update time', async () => {
      const { store } = await refused();
      const before = await only(store);

      const record = await store.advanceEditRevision(KEY, 4, 5, T0 + 9);

      assert.deepEqual(record, { ...before, baseRevision: 5, updatedAt: T0 + 9 });
      assert.equal(record.syncState, 'refused', 'the state is kept');
      assert.deepEqual(record.lastRefusal, before.lastRefusal, 'with its refusal');
      assert.equal(record.content.slug, 'taken', 'and its writing');
      assert.deepEqual(record.base, CONTENT, 'the base content is untouched');

      await store.close();
    });

    it('matches nothing when the base revision is not the one the caller pinned', async () => {
      const { store } = await refused();
      const before = await only(store);

      assert.deepEqual(await store.advanceEditRevision(KEY, 3, 5, T0 + 9), before);

      await store.close();
    });

    it('matches nothing while an envelope is in flight', async () => {
      const { store } = await seeded();
      await store.markEditInflight(KEY, 1, updateOf({ title: 'x' }), T0 + 1);
      const before = await only(store);

      assert.deepEqual(await store.advanceEditRevision(KEY, 4, 5, T0 + 9), before);

      await store.close();
    });
  });

  describe('a row this build cannot open', () => {
    it('reports a foreign content schema, and never migrates it', async () => {
      const { store, db } = await seeded();
      await db.run(`UPDATE ${EDITS_TABLE} SET content_schema_version = 99`);

      const { edits, unusableEdits } = await store.listEdits();

      assert.deepEqual(edits, []);
      assert.equal(unusableEdits.length, 1);
      assert.deepEqual(unusableEdits[0], {
        key: KEY,
        endpoint: 'https://raphael.example',
        nodeType: 'resource',
        title: 'Contracts',
        problem: 'unsupported_content_schema',
      });
      // Retained exactly as it is. A newer build will be able to read it.
      assert.equal((await db.all(`SELECT * FROM ${EDITS_TABLE}`)).length, 1);

      await store.close();
    });

    it('reports a body it cannot validate', async () => {
      const { store, db } = await seeded();
      await db.run(`UPDATE ${EDITS_TABLE} SET body = ?`, ['{"type":"nonsense"}']);

      const { unusableEdits } = await store.listEdits();

      assert.equal(unusableEdits[0].problem, 'unusable_body');

      await store.close();
    });

    it('reports a base whose document it cannot validate', async () => {
      const { store, db } = await seeded();
      await db.run(`UPDATE ${EDITS_TABLE} SET base = ?`, [
        JSON.stringify({ ...CONTENT, document: { type: 'nonsense' } }),
      ]);

      // The base is what a conflict is judged against, so a base nobody can read is not a usable row.
      assert.equal((await store.listEdits()).unusableEdits[0].problem, 'unusable_body');

      await store.close();
    });

    /**
     * The coupling itself, not a value both a literal and the guard would refuse.
     *
     * This passes today with one kind, and dies the day a second is added to `RESOURCE_KINDS` while
     * this store is still comparing against `'note'` — which is the whole of what the guard buys.
     * A row this table refuses is retained forever and shown to its owner as unreadable, so a kind
     * the contract has widened to must open here.
     */
    it('opens a row for every kind the contract publishes', async () => {
      const { store, db } = await seeded();

      for (const kind of RESOURCE_KINDS) {
        await db.run(`UPDATE ${EDITS_TABLE} SET kind = ?`, [kind]);

        const { edits, unusableEdits } = await store.listEdits();

        assert.deepEqual(unusableEdits, [], `kind ${kind} was refused by the store`);
        assert.equal(edits[0].kind, kind);
      }

      await store.close();
    });

    it('refuses a kind the contract does not publish, and accepts a container having none', async () => {
      const { store, db } = await seeded();
      await db.run(`UPDATE ${EDITS_TABLE} SET kind = ?`, ['not_a_kind']);

      assert.equal((await store.listEdits()).unusableEdits[0].problem, 'unreadable_row');

      // A container legitimately has no kind, and that is not a damaged row.
      await db.run(`UPDATE ${EDITS_TABLE} SET kind = NULL, node_type = 'area'`);
      const record = (await store.listEdits()).edits[0];

      assert.equal(record.kind, null);
      assert.equal(record.nodeType, 'area');

      await store.close();
    });

    it('reports columns that are not what they claim', async () => {
      const { store, db } = await seeded();
      await db.run(`UPDATE ${EDITS_TABLE} SET node_type = ?`, ['nonsense']);

      const { unusableEdits } = await store.listEdits();

      assert.equal(unusableEdits[0].problem, 'unreadable_row');
      // Nothing invented: the type could not be read, so it is not reported as one.
      assert.equal(unusableEdits[0].nodeType, null);
      assert.equal(unusableEdits[0].title, 'Contracts');

      await store.close();
    });

    it('is deletable by key, without ever being parsed', async () => {
      const { store, db } = await seeded();
      await db.run(`UPDATE ${EDITS_TABLE} SET content_schema_version = 99`);

      await store.deleteEdit(KEY);

      assert.deepEqual(await store.listEdits(), { edits: [], unusableEdits: [] });

      await store.close();
    });

    it('does not make the other rows unreadable', async () => {
      const { store, db } = await seeded();
      await store.insertEdit(newEdit({ key: { connectionId: 'c1', nodeId: 8 } }));
      await db.run(`UPDATE ${EDITS_TABLE} SET content_schema_version = 99 WHERE node_id = 7`);

      const { edits, unusableEdits } = await store.listEdits();

      assert.equal(edits.length, 1);
      assert.equal(edits[0].key.nodeId, 8);
      assert.equal(unusableEdits.length, 1);

      await store.close();
    });
  });
});

/**
 * The `unsent` table over real SQLite (Node's), and the runner over a fake client.
 *
 * The store: the migration, a write bumping the version, the compare-and-set delete a runner's answer
 * makes, what Unfinished lists, and rows this build cannot read being deleted on open. The runner:
 * one request at a time, backoff that resets on success, nothing sent while offline, and `sync(id)`
 * resolving with its row's first outcome.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEmptyDocument } from '@raphael/content';

import { migrate } from '../src/infrastructure/sqlite/migrate.ts';
import { isUnfinished } from '../src/modules/unsent/row.ts';
import { BACKOFF_MS, createRunner, OFFLINE_MESSAGE } from '../src/modules/unsent/runner.ts';
import { MIGRATIONS, openUnsentStore } from '../src/modules/unsent/store.ts';
import { transition } from '../src/modules/unsent/transition.ts';
import { openNodeDatabase } from './support/node-sqlite.mjs';
import { createRow, editRow } from './support/unsent-rows.mjs';

const openStore = async () => {
  const db = await openNodeDatabase();

  assert.equal((await migrate(db, MIGRATIONS)).kind, 'ready');

  return { db, store: await openUnsentStore(db) };
};

const insert = (store, row) => store.change({ id: row.id }, () => row);

const entity = (over = {}) => ({
  id: 42,
  type: 'resource',
  kind: 'note',
  parentId: 1,
  slug: 'field-notes',
  revision: 8,
  title: 'Field notes',
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: false,
  archiveCauses: [],
  body: { format: 'tiptap', value: createEmptyDocument() },
  metadata: {},
  ...over,
});

describe('the unsent store', () => {
  it('stores a row, reads it back after reopening, and keeps one edit row per node', async () => {
    const { db, store } = await openStore();

    await insert(store, editRow(7, { tags: ['a'], destination: null }));
    await insert(store, createRow({ destination: { root: true } }));

    const reopened = await openUnsentStore(db);

    assert.deepEqual(
      reopened.rows().map((row) => row.id),
      ['edit-7', 'draft-1'],
      'oldest first',
    );
    assert.deepEqual(reopened.rows()[0].tags, ['a']);
    assert.deepEqual(reopened.rows()[1].destination, { root: true });

    await assert.rejects(insert(store, editRow(7, { id: 'another' })), 'one edit row per node');
  });

  it('finds an edit row by its node', async () => {
    const { store } = await openStore();

    await insert(store, editRow(7));

    let seen;

    await store.change({ nodeId: 7 }, (row) => {
      seen = row;

      return undefined;
    });
    assert.equal(seen.id, 'edit-7');
  });

  it('deletes a row only when the version it was sent at is still the latest', async () => {
    const { store } = await openStore();
    const sent = editRow(7, { version: 2, sentVersion: 1 });

    await insert(store, sent);
    // A keystroke lands while the request is out.
    await store.change({ id: sent.id }, (row) => ({ ...row, version: row.version + 1 }));
    await store.change(
      { id: sent.id },
      (row) => transition(row, sent, { kind: 'saved', entity: entity() }).row,
    );

    assert.equal(store.rows().length, 1, 'the newer writing stays');
    assert.equal(store.rows()[0].sentVersion, 2);
    assert.equal(store.rows()[0].baseRevision, 8);

    const latest = store.rows()[0];

    await store.change(
      { id: sent.id },
      (row) => transition(row, latest, { kind: 'saved', entity: entity({ revision: 9 }) }).row,
    );
    assert.equal(store.rows().length, 0, 'clean, so gone');
  });

  it('lists in Unfinished what needs the person or is stuck, and not what is syncing', () => {
    assert.equal(isUnfinished(createRow()), true, 'a draft');
    assert.equal(isUnfinished(createRow({ status: 'refused' })), true);
    assert.equal(isUnfinished(editRow(1, { status: 'conflict' })), true);
    assert.equal(isUnfinished(editRow(1, { error: 'down' })), true, 'waiting to sync');
    assert.equal(isUnfinished(editRow(1)), false, 'syncing normally');
  });

  it('deletes rows it cannot read when it opens', async () => {
    const { db, store } = await openStore();

    await insert(store, createRow());
    await db.run(`UPDATE unsent SET tags = 'not json' WHERE id = 'draft-1'`);

    const warned = [];
    const reopened = await openUnsentStore(db, (message) => warned.push(message));

    assert.equal(reopened.rows().length, 0);
    assert.equal(warned.length, 1);
    assert.equal((await db.all('SELECT id FROM unsent')).length, 0);
  });

  it('refuses to store a row it could not read back', async () => {
    const { store } = await openStore();

    await assert.rejects(insert(store, createRow({ body: 'markdown, not a document' })));
    assert.equal(store.rows().length, 0);
  });

  it('keeps its rows when a clear does not reach the table', async () => {
    const { db, store } = await openStore();

    await insert(store, createRow());
    await db.close();

    await assert.rejects(store.clear());
    assert.equal(store.rows().length, 1, 'still listed, so a switch cannot go ahead over them');
  });
});

/** A runner over a fake client whose answers the test gives, one request at a time. */
const harness = async ({ online = true } = {}) => {
  const { store } = await openStore();
  const requests = [];
  const timers = [];
  const cached = [];
  const state = { online };

  const answerNext = (result) => {
    const request = requests.find((candidate) => !candidate.answered);

    request.answered = true;
    request.resolve(result);
  };
  const pending = (kind, body) =>
    new Promise((resolve) => {
      requests.push({ kind, body, resolve, answered: false });
    });

  const runner = createRunner({
    store,
    session: () => ({ activation: 1, transport: {} }),
    online: () => state.online,
    create: (_transport, body) => pending('create', body),
    update: (_transport, body) => pending('update', body),
    get: (_transport, target) => pending('get', target),
    pathOf: (_transport, id) => pending('path', id),
    cache: (saved) => {
      cached.push({ entity: saved, rowsAtCache: store.rows().length });
    },
    refresh: () => {},
    setTimer: (run, ms) => {
      const timer = { run, ms, cancelled: false };

      timers.push(timer);

      return () => {
        timer.cancelled = true;
      };
    },
  });

  const settle = () =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  return { store, runner, requests, timers, cached, state, answerNext, settle };
};

const ok = (value) => ({ ok: true, value: { entity: value } });
const fail = (failure) => ({ ok: false, failure });

describe('the runner', () => {
  it('sends one request at a time, oldest first, with the row’s content at send time', async () => {
    const h = await harness();

    await insert(h.store, editRow(1, { title: 'first' }));
    await insert(h.store, editRow(2, { title: 'second' }));
    h.runner.kick();
    await h.settle();

    assert.equal(h.requests.length, 1, 'serial');
    assert.equal(h.requests[0].body.title, 'first');
    assert.equal(h.requests[0].body.revision, 1);

    h.answerNext(ok(entity({ id: 1 })));
    await h.settle();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].body.title, 'second');
  });

  it('writes the entity into the cache before it deletes the clean row', async () => {
    const h = await harness();

    await insert(h.store, editRow(1));
    h.runner.kick();
    await h.settle();
    h.answerNext(ok(entity({ id: 1 })));
    await h.settle();

    assert.equal(h.cached.length, 1);
    assert.equal(h.cached[0].rowsAtCache, 1, 'the row was still there');
    assert.equal(h.store.rows().length, 0);
  });

  it('backs off after a retryable failure, longer each time, and starts over after a success', async () => {
    const h = await harness();

    await insert(h.store, editRow(1));
    h.runner.kick();
    await h.settle();
    h.answerNext(fail({ kind: 'http', status: 503, message: 'down' }));
    await h.settle();

    assert.equal(h.timers.at(-1).ms, BACKOFF_MS[0]);
    assert.equal(h.store.rows()[0].error, 'down');

    h.runner.wake();
    await h.settle();
    assert.equal(h.requests.length, 1, 'a wake does not cut the backoff short');

    h.timers.at(-1).run();
    await h.settle();
    h.answerNext(fail({ kind: 'http', status: 503, message: 'down' }));
    await h.settle();
    assert.equal(h.timers.at(-1).ms, BACKOFF_MS[1]);

    h.timers.at(-1).run();
    await h.settle();
    h.answerNext(ok(entity({ id: 1 })));
    await h.settle();
    assert.equal(h.store.rows().length, 0);

    await insert(h.store, editRow(2));
    h.runner.kick();
    await h.settle();
    h.answerNext(fail({ kind: 'http', status: 503, message: 'down' }));
    await h.settle();
    assert.equal(h.timers.at(-1).ms, BACKOFF_MS[0], 'reset by the success');
  });

  it('sends nothing while offline, and goes when reachability wakes it', async () => {
    const h = await harness({ online: false });

    await insert(h.store, editRow(1));
    h.runner.kick();
    await h.settle();
    assert.equal(h.requests.length, 0);

    h.state.online = true;
    h.runner.kick();
    await h.settle();
    assert.equal(h.requests.length, 1);
  });

  it('resolves sync(id) with the row’s first outcome, and at once while offline', async () => {
    const h = await harness();

    await insert(h.store, createRow({ status: 'pending', slug: 'still-being-written' }));

    const synced = h.runner.sync('draft-1');

    await h.settle();
    h.answerNext(ok(entity({ id: 5 })));
    assert.deepEqual((await synced).outcome, 'saved');
    assert.equal((await synced).entity.id, 5);

    const offline = await harness({ online: false });

    await insert(offline.store, createRow({ status: 'pending' }));

    const waiting = await offline.runner.sync('draft-1');

    assert.equal(waiting.outcome, 'waiting');
    assert.equal(offline.store.rows()[0].error, OFFLINE_MESSAGE);
    assert.equal(offline.requests.length, 0);
  });

  it('looks up a create’s clash at its parent’s path, and adopts its own lost reply', async () => {
    const h = await harness();

    await insert(
      h.store,
      createRow({
        status: 'pending',
        title: 'Field notes',
        slug: 'field-notes',
        destination: { type: 'area', id: 1 },
      }),
    );
    h.runner.kick();
    await h.settle();
    h.answerNext(fail({ kind: 'http', status: 409, code: 'slug_conflict', message: 'taken' }));
    await h.settle();

    assert.equal(h.requests[1].kind, 'path');
    assert.equal(h.requests[1].body, 1);
    h.answerNext({ ok: true, value: '/work' });
    await h.settle();

    assert.deepEqual(h.requests[2].body, { path: '/work/field-notes' });
    h.answerNext(ok(entity({ title: 'Field notes' })));
    await h.settle();

    assert.equal(h.store.rows().length, 0, 'no duplicate: it was ours');
  });
});

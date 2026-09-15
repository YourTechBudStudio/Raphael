/**
 * The pending-attempt store, against real SQLite.
 *
 * The properties being defended are the ones that decide whether someone's unsent work survives:
 * uncertainty outlives later definite failures, an interrupted dispatch is adopted exactly once,
 * the observed-time mark never moves backwards, and an ambiguous record cannot be deleted by the
 * path that replaces a refused one.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { logicalStateOf } from '../src/modules/collections/creation/derive.ts';
import { createAttemptStore, openAttemptStore } from '../src/modules/collections/creation/store.ts';
import { openNodeDatabase } from './support/node-sqlite.mjs';

const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryFile = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-attempts-'));
  temporaries.push(dir);

  return path.join(dir, 'attempts.db');
};

const T0 = 1_700_000_000_000;

const attempt = (over = {}) => ({
  attemptId: 'a1',
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  request: JSON.stringify({ type: 'area', title: 'Work', idempotencyKey: 'k1' }),
  type: 'area',
  title: 'Work',
  parentAreaId: null,
  at: T0,
  ...over,
});

const opened = async (location) => {
  const db = await openNodeDatabase(location);
  const outcome = await openAttemptStore(db, () => T0);
  assert.equal(outcome.kind, 'ready');

  return { db, store: outcome.store };
};

const only = async (store) => {
  const { records, unreadable } = await store.list();
  assert.equal(unreadable, 0);
  assert.equal(records.length, 1);

  return records[0];
};

describe('the attempt store', () => {
  it('writes an intent that reads back as what was submitted', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());

    const record = await only(store);
    assert.equal(record.state, 'dispatch_intent');
    assert.equal(record.title, 'Work');
    assert.equal(record.firstUncertainAt, null);
    assert.equal(record.clockAnomaly, false);
    assert.equal(record.acknowledged, null);

    await store.close();
  });

  it('keeps uncertainty through a later rejection', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());
    await store.markUncertain('a1', T0 + 1000);

    // The 401-on-retry case: this attempt was refused, and the creation is still unresolved.
    await store.markBlocked(
      'a1',
      { kind: 'rejected', code: 'unauthorized', message: 'refused', at: T0 + 2000 },
      T0 + 2000,
    );

    const record = await only(store);
    assert.equal(record.state, 'blocked');
    assert.equal(record.firstUncertainAt, T0 + 1000);
    assert.equal(logicalStateOf(record), 'unresolved');

    await store.close();
  });

  it('reports a blocked attempt with no history as a refusal', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());
    await store.markBlocked(
      'a1',
      { kind: 'rejected', code: 'slug_conflict', message: 'taken', at: T0 + 1 },
      T0 + 1,
    );

    assert.equal(logicalStateOf(await only(store)), 'refused');

    await store.close();
  });

  it('writes the uncertainty timestamp once', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());
    await store.markUncertain('a1', T0 + 1000);
    await store.markUncertain('a1', T0 + 9000);

    assert.equal((await only(store)).firstUncertainAt, T0 + 1000);

    await store.close();
  });

  it('never lowers the observed mark, whatever the clock says', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt({ at: T0 + 5000 }));
    await store.markUncertain('a1', T0 + 1000);

    // A clock set backwards must not erase the evidence that later time was already seen.
    assert.equal((await only(store)).observedAt, T0 + 5000);

    await store.close();
  });

  it('records an acknowledgement whole, and clears the last failure with it', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());
    await store.markBlocked(
      'a1',
      { kind: 'not_dispatched', code: null, message: 'nope', at: T0 + 1 },
      T0 + 1,
    );
    await store.markAcknowledged('a1', { type: 'area', id: 42, title: 'Work' }, T0 + 2);

    const record = await only(store);
    assert.equal(record.state, 'acknowledged');
    assert.deepEqual(record.acknowledged, { type: 'area', id: 42, title: 'Work' });
    assert.equal(record.lastOutcome, null);
    assert.equal(logicalStateOf(record), 'created');

    await store.close();
  });

  it('will not move an acknowledged attempt back to an unresolved one', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());
    await store.markAcknowledged('a1', { type: 'area', id: 42, title: 'Work' }, T0 + 2);

    // A late answer from a dispatcher that did not know must not unresolve a known creation.
    await store.markUncertain('a1', T0 + 3);
    await store.markBlocked(
      'a1',
      { kind: 'rejected', code: null, message: 'late', at: T0 + 4 },
      T0 + 4,
    );

    assert.equal((await only(store)).state, 'acknowledged');

    await store.close();
  });

  it('replaces a refused record and refuses to replace an ambiguous one', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());
    await store.markBlocked(
      'a1',
      { kind: 'rejected', code: 'slug_conflict', message: 'taken', at: T0 + 1 },
      T0 + 1,
    );
    await store.replace('a1', attempt({ attemptId: 'a2', title: 'Work notes' }));

    let records = (await store.list()).records;
    assert.deepEqual(
      records.map((record) => record.attemptId),
      ['a2'],
    );

    // Now the same shape, but ambiguous. The delete half must not fire.
    await store.markUncertain('a2', T0 + 2);
    await store.markBlocked(
      'a2',
      { kind: 'rejected', code: null, message: 'no', at: T0 + 3 },
      T0 + 3,
    );
    await store.replace('a2', attempt({ attemptId: 'a3', title: 'Work log' }));

    records = (await store.list()).records;
    assert.deepEqual(records.map((record) => record.attemptId).sort(), ['a2', 'a3']);

    await store.close();
  });

  it('adopts an interrupted dispatch on reopen, exactly once', async () => {
    const file = await temporaryFile();

    const first = await opened(file);
    await first.store.insertIntent(attempt());
    // The process dies here, with the intent written and the outcome unknown.
    await first.store.close();

    const second = await openNodeDatabase(file);
    const outcome = await openAttemptStore(second, () => T0 + 60_000);
    assert.equal(outcome.kind, 'ready');

    let record = await only(outcome.store);
    assert.equal(record.state, 'uncertain');
    assert.equal(record.firstUncertainAt, T0 + 60_000);
    await outcome.store.close();

    // Repeating the sweep must not restamp what it already adopted.
    const third = await openNodeDatabase(file);
    const again = await openAttemptStore(third, () => T0 + 120_000);
    record = await only(again.store);
    assert.equal(record.firstUncertainAt, T0 + 60_000);

    await again.store.close();
  });

  it('reports the sweep as a no-op when there was nothing to adopt', async () => {
    const { db, store } = await opened();
    await store.insertIntent(attempt());
    await store.markUncertain('a1', T0 + 1);

    assert.equal(await createAttemptStore(db).reconcile(T0 + 2), 0);

    await store.close();
  });

  it('counts an unreadable row instead of deleting or repairing it', async () => {
    const { db, store } = await opened();
    await store.insertIntent(attempt());
    await db.run("UPDATE creation_attempts SET type = 'nonsense' WHERE attempt_id = 'a1'");

    const { records, unreadable } = await store.list();
    assert.equal(records.length, 0);
    assert.equal(unreadable, 1);

    // Still there. Nothing reaps a row it could not read.
    const rows = await db.all('SELECT attempt_id FROM creation_attempts');
    assert.equal(rows.length, 1);

    await store.close();
  });

  it('reads a stored row claiming to be a resource as unreadable, not as a container', async () => {
    const { db, store } = await opened();
    await store.insertIntent(attempt());

    // Every attempt in this database is a container creation. `resource` is now a real node type on
    // the server, so a guard written against the wider vocabulary would accept this row and hand a
    // note onward as a container. A type this subsystem never creates is unreadable.
    await db.run("UPDATE creation_attempts SET type = 'resource' WHERE attempt_id = 'a1'");

    const { records, unreadable } = await store.list();
    assert.equal(records.length, 0);
    assert.equal(unreadable, 1);

    // Unreadable, not reaped: nothing deletes a row it could not understand.
    const rows = await db.all('SELECT attempt_id FROM creation_attempts');
    assert.equal(rows.length, 1);

    await store.close();
  });

  it('reads an acknowledgement naming a resource as unreadable', async () => {
    const { db, store } = await opened();
    await store.insertIntent(attempt());
    await db.run(
      `UPDATE creation_attempts SET state = 'acknowledged', acknowledged = ? WHERE attempt_id = 'a1'`,
      [JSON.stringify({ type: 'resource', id: 7, title: 'A note' })],
    );

    // The acknowledgement is the record of what the server created. One naming something this
    // subsystem cannot have asked for is not an ordinary success to be shown.
    const { records, unreadable } = await store.list();
    assert.equal(records.length, 0);
    assert.equal(unreadable, 1);

    await store.close();
  });

  it('refuses a database written by a newer build, and closes it', async () => {
    const db = await openNodeDatabase();
    await db.run('PRAGMA user_version = 99');

    const outcome = await openAttemptStore(db, () => T0);
    assert.equal(outcome.kind, 'unsupported_version');
    assert.equal(outcome.found, 99);

    // Every way out that does not hand back a live store closes the connection. The caller retries
    // an open and each retry builds a new one, so leaving this alive would accumulate handles
    // against a database this process has already given up on.
    await assert.rejects(() => db.all('SELECT 1'), 'the connection was left open');
  });

  it('closes the database when the schema cannot be applied', async () => {
    const db = await openNodeDatabase();
    // Something already occupies the name the first migration needs.
    await db.run('CREATE TABLE creation_attempts (nonsense TEXT)');

    const outcome = await openAttemptStore(db, () => T0);
    assert.equal(outcome.kind, 'failed');

    await assert.rejects(() => db.all('SELECT 1'), 'the connection was left open');
  });

  it('keeps records across close and reopen', async () => {
    const file = await temporaryFile();

    const first = await opened(file);
    await first.store.insertIntent(attempt());
    await first.store.markUncertain('a1', T0 + 1);
    await first.store.close();

    const second = await opened(file);
    const record = await only(second.store);
    assert.equal(record.state, 'uncertain');
    assert.equal(record.request, attempt().request);

    await second.store.close();
  });

  it('answers every write with the row as it now stands', async () => {
    const { store } = await opened();

    // This is what lets a caller publish a transition without rereading the table. A write that
    // answered nothing would make a separate read the only way to learn what had just been done.
    const inserted = await store.insertIntent(attempt());
    assert.equal(inserted.state, 'dispatch_intent');
    assert.equal(inserted.title, 'Work');

    const uncertain = await store.markUncertain('a1', T0 + 1000);
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(uncertain.firstUncertainAt, T0 + 1000);

    const blocked = await store.markBlocked(
      'a1',
      { kind: 'rejected', code: 'slug_conflict', message: 'taken', at: T0 + 2000 },
      T0 + 2000,
    );
    assert.equal(blocked.state, 'blocked');
    // The rules that make the row what it is live in the SQL, and what comes back has been through
    // them: the uncertainty timestamp is still the first one.
    assert.equal(blocked.firstUncertainAt, T0 + 1000);

    const acknowledged = await store.markAcknowledged(
      'a1',
      { type: 'area', id: 3, title: 'Work' },
      T0 + 3000,
    );
    assert.equal(acknowledged.state, 'acknowledged');
    assert.equal(acknowledged.lastOutcome, null);

    await store.close();
  });

  it('answers with the row a declining guard left alone', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());
    await store.markAcknowledged('a1', { type: 'area', id: 3, title: 'Work' }, T0 + 1);

    // The guard refuses to unresolve a known creation, and says so by handing back what is there.
    const answered = await store.markUncertain('a1', T0 + 2);
    assert.equal(answered.state, 'acknowledged');

    await store.close();
  });

  it('answers with nothing when the row is gone', async () => {
    const { store } = await opened();

    assert.equal(await store.markUncertain('missing', T0), null);

    await store.close();
  });

  it('marks a clock anomaly permanently', async () => {
    const { store } = await opened();
    await store.insertIntent(attempt());
    await store.markClockAnomaly('a1', T0 + 1);

    assert.equal((await only(store)).clockAnomaly, true);

    await store.close();
  });
});

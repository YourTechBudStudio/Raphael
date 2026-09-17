/**
 * The migration runner, against real SQLite.
 *
 * What is being defended is that a database is never left in a shape no version describes, and never
 * quietly rebuilt. The interesting cases are the unhappy ones: a step that throws partway, a file
 * written by a build that does not exist yet, and an initialization interrupted between two steps.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { migrate } from '../src/infrastructure/sqlite/migrate.ts';
import { CAPTURE_MIGRATIONS } from '../src/modules/capture/schema.ts';
import { openNodeDatabase } from './support/node-sqlite.mjs';

const STEP_ONE = {
  version: 1,
  statements: ['CREATE TABLE thing (id TEXT PRIMARY KEY, label TEXT NOT NULL)'],
};
const STEP_TWO = { version: 2, statements: ['ALTER TABLE thing ADD COLUMN note TEXT'] };

const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryFile = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-sqlite-'));
  temporaries.push(dir);

  return path.join(dir, 'test.db');
};

const version = async (db) => (await db.get('PRAGMA user_version')).user_version;

describe('migrate', () => {
  it('applies every step and records the version it reached', async () => {
    const db = await openNodeDatabase();

    assert.deepEqual(await migrate(db, [STEP_ONE, STEP_TWO]), { kind: 'ready', version: 2 });
    assert.equal(await version(db), 2);

    await db.run('INSERT INTO thing (id, label, note) VALUES (?, ?, ?)', ['a', 'one', 'n']);
    assert.equal((await db.all('SELECT * FROM thing')).length, 1);

    await db.close();
  });

  it('is safe to repeat, and repeats nothing it already applied', async () => {
    const db = await openNodeDatabase();

    await migrate(db, [STEP_ONE, STEP_TWO]);
    await db.run('INSERT INTO thing (id, label) VALUES (?, ?)', ['a', 'one']);

    // The second run must not re-run CREATE TABLE, which would throw, nor drop what is stored.
    assert.deepEqual(await migrate(db, [STEP_ONE, STEP_TWO]), { kind: 'ready', version: 2 });
    assert.equal((await db.all('SELECT * FROM thing')).length, 1);

    await db.close();
  });

  it('resumes an initialization that was interrupted between steps', async () => {
    const db = await openNodeDatabase();

    // Exactly what a process killed after step one leaves behind.
    await migrate(db, [STEP_ONE]);
    assert.equal(await version(db), 1);

    assert.deepEqual(await migrate(db, [STEP_ONE, STEP_TWO]), { kind: 'ready', version: 2 });
    await db.run('INSERT INTO thing (id, label, note) VALUES (?, ?, ?)', ['a', 'one', 'n']);

    await db.close();
  });

  it('rolls a failed step back and stays at the previous version', async () => {
    const db = await openNodeDatabase();
    await migrate(db, [STEP_ONE]);

    const broken = {
      version: 2,
      statements: ['CREATE TABLE other (id TEXT PRIMARY KEY)', 'THIS IS NOT SQL'],
    };

    const outcome = await migrate(db, [STEP_ONE, broken]);
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.version, 1);

    // The half of the step that did succeed is gone with the transaction that carried it.
    assert.equal(await version(db), 1);
    await assert.rejects(() => db.all('SELECT * FROM other'));

    await db.close();
  });

  it('refuses a database written by a newer build without touching it', async () => {
    const db = await openNodeDatabase();
    await migrate(db, [STEP_ONE, STEP_TWO]);
    await db.run('PRAGMA user_version = 9');

    assert.deepEqual(await migrate(db, [STEP_ONE, STEP_TWO]), {
      kind: 'unsupported_version',
      found: 9,
      supported: 2,
    });
    // Refused means refused: the version is not lowered and the schema is not rewritten.
    assert.equal(await version(db), 9);

    await db.close();
  });

  it('keeps what it committed across close and reopen', async () => {
    const file = await temporaryFile();

    const first = await openNodeDatabase(file);
    await migrate(first, [STEP_ONE, STEP_TWO]);
    await first.run('INSERT INTO thing (id, label) VALUES (?, ?)', ['a', 'one']);
    await first.close();

    const second = await openNodeDatabase(file);
    assert.equal(await version(second), 2);
    assert.equal((await second.all('SELECT * FROM thing')).length, 1);
    await second.close();
  });

  it('refuses a step list that is not contiguous from 1', async () => {
    const db = await openNodeDatabase();

    await assert.rejects(() => migrate(db, [STEP_TWO]), /contiguous/);

    await db.close();
  });
});

describe('transactions', () => {
  it('rolls back everything in a body that throws', async () => {
    const db = await openNodeDatabase();
    await migrate(db, [STEP_ONE]);

    await assert.rejects(() =>
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO thing (id, label) VALUES (?, ?)', ['a', 'one']);
        throw new Error('no');
      }),
    );

    assert.equal((await db.all('SELECT * FROM thing')).length, 0);

    await db.close();
  });

  it('enforces the schema constraints rather than the caller doing it', async () => {
    const db = await openNodeDatabase();
    await migrate(db, [STEP_ONE]);
    await db.run('INSERT INTO thing (id, label) VALUES (?, ?)', ['a', 'one']);

    await assert.rejects(() => db.run('INSERT INTO thing (id, label) VALUES (?, ?)', ['a', 'two']));

    await db.close();
  });

  it('serializes overlapping transaction bodies', async () => {
    const db = await openNodeDatabase();
    await migrate(db, [STEP_ONE]);

    const order = [];
    const first = db.transaction(async (tx) => {
      order.push('first-in');
      await tx.run('INSERT INTO thing (id, label) VALUES (?, ?)', ['a', 'one']);
      order.push('first-out');
    });
    const second = db.transaction(async () => {
      order.push('second-in');
    });

    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-in', 'first-out', 'second-in']);

    await db.close();
  });

  it('keeps the queue alive after a transaction fails', async () => {
    const db = await openNodeDatabase();
    await migrate(db, [STEP_ONE]);

    const failing = db.transaction(async () => {
      throw new Error('no');
    });
    const following = db.transaction(async (tx) => {
      await tx.run('INSERT INTO thing (id, label) VALUES (?, ?)', ['a', 'one']);

      return 'done';
    });

    await assert.rejects(() => failing);
    assert.equal(await following, 'done');

    await db.close();
  });
});

/**
 * The two capability schemas, applied by the same runner.
 *
 * What is checked here is not that the tables exist - their own tests do that by using them - but
 * that each declared step list is one this runner will accept, that a file written by a newer build
 * is refused rather than downgraded, and that a step which fails leaves the database exactly where
 * it was. These are the properties that decide whether someone's unsent work is still there after a
 * bad upgrade.
 */
describe('the capability schemas', () => {
  for (const [name, migrations] of [['capture', CAPTURE_MIGRATIONS]]) {
    it(`brings a fresh ${name} database up, and is safe to repeat`, async () => {
      const db = await openNodeDatabase();
      const supported = migrations.at(-1).version;

      assert.deepEqual(await migrate(db, migrations), { kind: 'ready', version: supported });
      assert.deepEqual(await migrate(db, migrations), { kind: 'ready', version: supported });

      await db.close();
    });

    it(`refuses a ${name} database written by a newer build rather than downgrading it`, async () => {
      const db = await openNodeDatabase();
      const supported = migrations.at(-1).version;
      await migrate(db, migrations);
      await db.run(`PRAGMA user_version = ${String(supported + 7)}`);

      assert.deepEqual(await migrate(db, migrations), {
        kind: 'unsupported_version',
        found: supported + 7,
        supported,
      });
      // Nothing is deleted, recreated, or repaired: a build older than the file it opens cannot know
      // what the newer schema means, and a downgrade would be a guess about someone's unsent work.
      assert.equal(await version(db), supported + 7);

      await db.close();
    });
  }

  it('reaches version 2, which is where entity_edits and the drafts tag column arrive', async () => {
    const db = await openNodeDatabase();

    assert.deepEqual(await migrate(db, CAPTURE_MIGRATIONS), { kind: 'ready', version: 2 });
    assert.equal(await version(db), 2);
    assert.equal((await db.all('SELECT * FROM entity_edits')).length, 0);
    assert.equal((await db.all('SELECT tags FROM note_drafts')).length, 0);

    await db.close();
  });

  it('migrates a version-1 capture file forward with its draft rows intact', async () => {
    const location = await temporaryFile();
    const first = await openNodeDatabase(location);

    // Exactly what a build that shipped before edits existed wrote.
    await migrate(first, CAPTURE_MIGRATIONS.slice(0, 1));
    assert.equal(await version(first), 1);
    await first.run(
      `INSERT INTO note_drafts (draft_id, connection_id, endpoint, state, title, description, body,
         content_schema_version, draft_version, created_at, updated_at)
       VALUES ('d1', 'c1', 'https://raphael.example', 'composing', 'kept', '', '{"type":"doc"}',
         1, 3, 10, 20)`,
    );
    await first.close();

    const second = await openNodeDatabase(location);

    assert.deepEqual(await migrate(second, CAPTURE_MIGRATIONS), { kind: 'ready', version: 2 });

    const rows = await second.all('SELECT draft_id, title, draft_version, tags FROM note_drafts');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'kept');
    assert.equal(rows[0].draft_version, 3);
    // A draft written before tags existed asked for none, which is what the default says.
    assert.equal(rows[0].tags, '[]');

    await second.close();
  });

  it('rolls a failed capture step back to the version before it', async () => {
    const db = await openNodeDatabase();
    const broken = [
      ...CAPTURE_MIGRATIONS,
      {
        version: CAPTURE_MIGRATIONS.length + 1,
        statements: ['ALTER TABLE note_drafts ADD COLUMN a TEXT', 'NOT SQL'],
      },
    ];

    const outcome = await migrate(db, broken);

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.version, CAPTURE_MIGRATIONS.length);
    assert.equal(await version(db), CAPTURE_MIGRATIONS.length);
    // The half of the step that did succeed went with the transaction that carried it.
    await assert.rejects(() => db.all('SELECT a FROM note_drafts'));

    await db.close();
  });
});

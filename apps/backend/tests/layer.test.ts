import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Effect } from 'effect';

import { openDatabase } from '../src/infrastructure/database/connection.ts';
import { Db, layer } from '../src/infrastructure/database/layer.ts';
import { tempDatabase } from './support.ts';

/** Ownership is observable from outside: if the scope released, the database can be opened again. */
const isReleased = (file: string): boolean => {
  try {
    openDatabase({ databasePath: file, acquisitionTimeoutMs: 200 }).close();
    return true;
  } catch {
    return false;
  }
};

describe('scoped database layer', () => {
  test('provides a migrated database and releases it when the scope closes', async () => {
    const temp = tempDatabase('layer');
    try {
      const roots = await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Db;
          return (db.prepare('SELECT slug FROM nodes ORDER BY id').all() as { slug: string }[]).map(
            (r) => r.slug,
          );
        }).pipe(Effect.provide(layer({ databasePath: temp.file }))),
      );
      assert.deepEqual(roots, ['work', 'personal']);
      assert.ok(isReleased(temp.file), 'ownership must be released with the scope');
    } finally {
      temp.cleanup();
    }
  });

  test('releases ownership when the work inside the scope fails', async () => {
    const temp = tempDatabase('layer-fail');
    try {
      const outcome = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* Db;
          return yield* Effect.fail(new Error('work failed'));
        }).pipe(Effect.provide(layer({ databasePath: temp.file }))),
      );
      assert.equal(outcome._tag, 'Failure');
      assert.ok(
        isReleased(temp.file),
        'a failure inside the scope must not leave the database owned',
      );
    } finally {
      temp.cleanup();
    }
  });

  test('releases ownership when migration fails during acquisition', async () => {
    const temp = tempDatabase('layer-migrate-fail');
    try {
      // A database that is not ours: the compatibility guard rejects it after the connection is open,
      // which is exactly the window where a leaked lock would be easy to introduce.
      const seeded = openDatabase({ databasePath: temp.file });
      seeded.db.exec('CREATE TABLE someone_elses_notes (id INTEGER PRIMARY KEY)');
      seeded.close();

      const outcome = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* Db;
        }).pipe(Effect.provide(layer({ databasePath: temp.file }))),
      );
      assert.equal(outcome._tag, 'Failure');
      assert.ok(isReleased(temp.file), 'a failed startup must not leave the database owned');
    } finally {
      temp.cleanup();
    }
  });

  test('surfaces contention as a typed failure rather than hanging', async () => {
    const temp = tempDatabase('layer-busy');
    const holder = openDatabase({ databasePath: temp.file });
    try {
      const outcome = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* Db;
        }).pipe(Effect.provide(layer({ databasePath: temp.file, acquisitionTimeoutMs: 200 }))),
      );
      assert.equal(outcome._tag, 'Failure');
    } finally {
      holder.close();
      temp.cleanup();
    }
  });
});

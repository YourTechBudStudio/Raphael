/**
 * A `node:sqlite` driver, for tests only.
 *
 * This is genuine SQLite - the real schema, the real constraints, real transactions and real
 * rollback - run by Node's own binding instead of Expo's. It exists because `node --test` on this
 * runtime cannot load `expo-sqlite`, so without it every storage property this phase depends on
 * would be reviewed by reading rather than by running.
 *
 * **It is not evidence about the Expo binding.** Node's binding is synchronous, which means it
 * cannot reproduce an interleaving that only exists when a driver actually suspends between
 * statements. Tests about ordering and races therefore use a delaying port rather than this one, and
 * the production adapter's transaction ownership is verified separately. Nothing in the app imports
 * this file; the architecture test enforces that.
 */

import { DatabaseSync } from 'node:sqlite';

import { serializeTransactions } from '../../src/infrastructure/sqlite/port.ts';

/**
 * Wraps each call in a resolved promise so callers suspend exactly where they would against an
 * async driver. Without it, a caller that never yields would hide an ordering bug that the real
 * driver would expose.
 */
const settle = async (value) => value;

const reader = (db) => ({
  run: async (sql, params = []) => {
    db.prepare(sql).run(...params);
    await settle();
  },
  all: async (sql, params = []) => settle(db.prepare(sql).all(...params)),
  get: async (sql, params = []) => settle(db.prepare(sql).get(...params) ?? undefined),
});

/**
 * `location` defaults to an in-memory database. Pass a file path to exercise close and reopen,
 * which is the only way to test that what was committed is actually on disk.
 */
export const openNodeDatabase = async (location = ':memory:') => {
  const db = new DatabaseSync(location);
  const serialize = serializeTransactions();
  const base = reader(db);

  return {
    ...base,
    transaction: (body) =>
      serialize(async () => {
        // IMMEDIATE takes the write lock up front, so a transaction that will write cannot begin,
        // read, and then fail to upgrade - which is the shape of SQLITE_BUSY that is hardest to
        // reason about after the fact.
        db.exec('BEGIN IMMEDIATE');
        try {
          const value = await body(base);
          db.exec('COMMIT');

          return value;
        } catch (cause) {
          db.exec('ROLLBACK');
          throw cause;
        }
      }),
    close: async () => {
      db.close();
      await settle();
    },
  };
};

/** A driver over `openNodeDatabase`, for code that takes a `SqlDriver`. */
export const nodeDriver = (location = ':memory:') => ({
  open: () => openNodeDatabase(location),
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Effect, Either, Exit, Fiber } from 'effect';

import type { DatabaseConnection } from '../src/infrastructure/database/connection.ts';
import { Db } from '../src/infrastructure/database/layer.ts';
import {
  SweepFailure,
  collectExpiredReplays,
  sweepExpiredReplays,
} from '../src/modules/nodes/gc.ts';
import { clockAt, count, many, openMigrated, tempDatabase, withMigrated } from './support.ts';

/**
 * Collecting expired replay records.
 *
 * The clock is injected everywhere. Nothing here sleeps for hours, and nothing asserts on wall-clock
 * timing: expiry is a comparison against a stored value, and the schedule is exercised with Effect's
 * own test clock rather than by waiting.
 */

const NOW = 1_700_000_000_000;

const insertReplay = (connection: DatabaseConnection, key: string, expiresAt: number): void => {
  connection.db
    .prepare(
      'INSERT INTO creation_replays (key, fingerprint, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(key, 'f', '{}', 1, expiresAt);
};

/**
 * A sweep runs asynchronously whenever it needs more than one batch: the yield between batches is a
 * real macrotask, not a fiber yield, which is the whole point of it. `runPromise` is therefore not a
 * stylistic choice - `runSync` throws on a multi-batch sweep, which is itself evidence that the yield
 * reaches the event loop.
 */
const runSweep = (
  connection: DatabaseConnection,
  batchSize: number,
  now = NOW,
): Promise<Either.Either<{ deleted: number; batches: number }, SweepFailure>> =>
  Effect.runPromise(
    Effect.either(
      Effect.provideService(
        Effect.withClock(sweepExpiredReplays({ batchSize }), clockAt(now)),
        Db,
        {
          db: connection.db,
          databasePath: connection.databasePath,
        },
      ),
    ),
  );

/**
 * A migrated database for an asynchronous body.
 *
 * `withMigrated` is synchronous and closes the connection in a `finally`, which with an async body
 * would release the database while the sweep was still running - the sweeps below are asynchronous
 * whenever they need more than one batch.
 */
const withMigratedAsync = async <T>(
  tag: string,
  body: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> => {
  const temp = tempDatabase(tag);
  let connection: DatabaseConnection | undefined;
  try {
    connection = openMigrated(temp.file);
    return await body(connection);
  } finally {
    connection?.close();
    temp.cleanup();
  }
};

const remainingKeys = (connection: DatabaseConnection): string[] =>
  many<{ key: string }>(connection.db, 'SELECT key FROM creation_replays ORDER BY key').map(
    (row) => row.key,
  );

describe('what a sweep deletes', () => {
  test('expired rows go, unexpired rows stay, and the boundary is inclusive', async () => {
    await withMigratedAsync('gc-boundary', async (connection) => {
      insertReplay(connection, 'long-gone', NOW - 1_000);
      insertReplay(connection, 'exactly-now', NOW);
      insertReplay(connection, 'still-valid', NOW + 1);

      const outcome = await runSweep(connection, 500);
      assert.equal(Either.isRight(outcome), true);
      if (Either.isRight(outcome)) assert.equal(outcome.right.deleted, 2);
      // `expires_at <= now`: a record that expires at this instant has expired.
      assert.deepEqual(remainingKeys(connection), ['still-valid']);
    });
  });

  test('deletion reads the stored expiry and never recomputes one', async () => {
    await withMigratedAsync('gc-stored-expiry', async (connection) => {
      // `created_at` is ancient and `expires_at` is in the future. Anything that derived an expiry
      // from the creation time plus the retention window would delete this row; the stored value is
      // the only authority, so it stays.
      connection.db
        .prepare(
          'INSERT INTO creation_replays (key, fingerprint, result_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('ancient-but-live', 'f', '{}', 1, NOW + 1_000_000);

      const outcome = await runSweep(connection, 500);
      assert.equal(Either.isRight(outcome), true);
      assert.deepEqual(remainingKeys(connection), ['ancient-but-live']);
    });
  });

  test('nothing to collect is an ordinary, silent outcome', async () => {
    await withMigratedAsync('gc-empty', async (connection) => {
      const outcome = await runSweep(connection, 500);
      assert.equal(Either.isRight(outcome), true);
      if (Either.isRight(outcome)) {
        assert.deepEqual(outcome.right, { deleted: 0, batches: 1 });
      }
    });
  });
});

describe('batching', () => {
  test('a backlog larger than one batch is worked through in bounded batches', async () => {
    await withMigratedAsync('gc-batches', async (connection) => {
      for (let index = 0; index < 25; index += 1) {
        insertReplay(connection, `expired-${index}`, NOW - 1_000 - index);
      }
      insertReplay(connection, 'live', NOW + 1);

      const outcome = await runSweep(connection, 10);
      assert.equal(Either.isRight(outcome), true);
      if (Either.isRight(outcome)) {
        assert.equal(outcome.right.deleted, 25);
        // 10, 10, 5 - the short batch is the end condition, so there are three, not four.
        assert.equal(outcome.right.batches, 3);
      }
      assert.deepEqual(remainingKeys(connection), ['live']);
    });
  });

  test('a backlog that is an exact multiple needs one more batch to learn it is done', async () => {
    await withMigratedAsync('gc-exact-multiple', async (connection) => {
      for (let index = 0; index < 20; index += 1) {
        insertReplay(connection, `expired-${index}`, NOW - 1_000);
      }
      const outcome = await runSweep(connection, 10);
      assert.equal(Either.isRight(outcome), true);
      if (Either.isRight(outcome)) assert.deepEqual(outcome.right, { deleted: 20, batches: 3 });
    });
  });

  test('a large equal-expiry cohort is collected without a tiebreaker', async () => {
    await withMigratedAsync('gc-equal-expiry', async (connection) => {
      // Every row shares one expiry. Ordering by `expires_at, key` would sort this group through a
      // temporary B-tree on every batch; ordering by expiry alone does not, and progress is still
      // guaranteed because each batch deletes what it selected.
      for (let index = 0; index < 300; index += 1) {
        insertReplay(connection, `tied-${index}`, NOW - 5);
      }
      const outcome = await runSweep(connection, 50);
      assert.equal(Either.isRight(outcome), true);
      if (Either.isRight(outcome)) assert.equal(outcome.right.deleted, 300);
      assert.equal(count(connection.db, 'SELECT count(*) AS c FROM creation_replays'), 0);
    });
  });

  test('the delete uses the expiry index and sorts nothing', () => {
    withMigrated('gc-query-plan', (connection) => {
      const plan = many<{ detail: string }>(
        connection.db,
        'EXPLAIN QUERY PLAN DELETE FROM creation_replays WHERE expires_at <= ? ORDER BY expires_at LIMIT ?',
        NOW,
        500,
      )
        .map((row) => row.detail)
        .join('\n');

      assert.match(plan, /creation_replays_expires_at/u);
      // A temporary B-tree here would mean sorting the matching rows on every batch, which is worst
      // exactly when the backlog is largest.
      assert.equal(/TEMP B-TREE/u.test(plan), false, plan);
    });
  });

  test('this SQLite build supports the bounded delete the sweep depends on', () => {
    withMigrated('gc-delete-limit', (connection) => {
      // `DELETE ... ORDER BY ... LIMIT` needs a compile-time option. If a future build lacks it this
      // fails loudly here rather than at runtime on an operator's machine.
      insertReplay(connection, 'a', NOW - 1);
      insertReplay(connection, 'b', NOW - 1);
      const changes = connection.db
        .prepare('DELETE FROM creation_replays WHERE expires_at <= ? ORDER BY expires_at LIMIT ?')
        .run(NOW, 1).changes;
      assert.equal(changes, 1);
    });
  });
});

describe('the cutoff', () => {
  test('a sweep does not chase rows that expire while it runs', async () => {
    await withMigratedAsync('gc-cutoff', async (connection) => {
      insertReplay(connection, 'expired-a', NOW - 2);
      insertReplay(connection, 'expired-b', NOW - 1);
      // Expires after this sweep's cutoff, but before the sample a later batch would have taken.
      insertReplay(connection, 'expires-during', NOW + 1_500);

      // The clock advances a second on every sample. One cutoff is taken, at NOW + 1000, so the third
      // row is not in this sweep's candidate set. A per-batch cutoff would reach NOW + 2000 and take
      // it - and on a busy server a sweep that keeps picking up newly expired rows never ends.
      let sample = NOW;
      const advancing = {
        ...clockAt(NOW),
        currentTimeMillis: Effect.sync(() => {
          sample += 1_000;
          return sample;
        }),
        unsafeCurrentTimeMillis: () => {
          sample += 1_000;
          return sample;
        },
      };
      const outcome = await Effect.runPromise(
        Effect.either(
          Effect.provideService(
            Effect.withClock(sweepExpiredReplays({ batchSize: 1 }), advancing),
            Db,
            { db: connection.db, databasePath: connection.databasePath },
          ),
        ),
      );
      assert.equal(Either.isRight(outcome), true);
      if (Either.isRight(outcome)) assert.equal(outcome.right.deleted, 2);
      assert.deepEqual(remainingKeys(connection), ['expires-during']);
    });
  });
});

describe('failure', () => {
  test('a sweep that cannot start reports a failure and deletes nothing', async () => {
    await withMigratedAsync('gc-first-batch-failure', async (connection) => {
      connection.db.exec('ALTER TABLE creation_replays RENAME TO creation_replays_moved');
      const failed = await runSweep(connection, 5);

      assert.equal(Either.isLeft(failed), true);
      if (Either.isLeft(failed)) {
        assert.equal(failed.left._tag, 'SweepFailure');
        assert.equal(failed.left.deleted, 0);
        // Our own words. A driver message can carry SQL text and bound parameters, so none of it is
        // retained or reported.
        assert.equal(/creation_replays|SQL|no such table/u.test(failed.left.detail), false);
      }
      connection.db.exec('ALTER TABLE creation_replays_moved RENAME TO creation_replays');
    });
  });

  test('a sweep that fails part-way reports what it had already deleted', async () => {
    await withMigratedAsync('gc-partial-failure', async (connection) => {
      for (let index = 0; index < 200; index += 1) {
        insertReplay(connection, `expired-${index}`, NOW - 1);
      }

      // Break the table between batches. The yield between them is a macrotask, so a `setImmediate`
      // scheduled after the sweep starts lands part-way through it.
      const sweeping = runSweep(connection, 5);
      await new Promise((resolve) => setImmediate(resolve));
      connection.db.exec('ALTER TABLE creation_replays RENAME TO creation_replays_moved');
      const failed = await sweeping;

      assert.equal(Either.isLeft(failed), true);
      if (Either.isLeft(failed)) {
        // Those batches committed in their own transactions and are gone. Reporting zero here would
        // describe committed work as rolled back.
        assert.ok(failed.left.deleted > 0, 'committed batches must be reported, not discounted');
        assert.ok(
          failed.left.deleted < 200,
          'the sweep did not finish, so it cannot claim all of it',
        );

        connection.db.exec('ALTER TABLE creation_replays_moved RENAME TO creation_replays');
        assert.equal(
          count(connection.db, 'SELECT count(*) AS c FROM creation_replays'),
          200 - failed.left.deleted,
          'the reported count must match what actually went',
        );
      }
    });
  });
});

describe('the collection loop', () => {
  test('it sweeps immediately, and again on the interval, without overlapping', async () => {
    const temp = tempDatabase('gc-loop');
    let connection: DatabaseConnection | undefined;
    try {
      connection = openMigrated(temp.file);
      insertReplay(connection, 'first-round', 1);

      const sweeps: { deleted: number; batches: number }[] = [];
      let concurrent = 0;
      let maxConcurrent = 0;

      // `Effect.runFork`, not `Effect.fork` inside a `runPromise`: the latter forks into the calling
      // fiber's scope, and that fiber ends the moment `runPromise` resolves - taking the loop with it.
      // Production forks the same way, at the top level of the server's runtime.
      const fiber = Effect.runFork(
        Effect.provideService(
          collectExpiredReplays({
            batchSize: 5,
            intervalMs: 40,
            onSweep: (outcome) => {
              concurrent += 1;
              maxConcurrent = Math.max(maxConcurrent, concurrent);
              sweeps.push(outcome);
              concurrent -= 1;
            },
            onFailure: () => assert.fail('the loop must not fail here'),
          }),
          Db,
          { db: connection.db, databasePath: connection.databasePath },
        ),
      );

      // A short real interval rather than a test clock: what is being pinned is that the first sweep
      // does not wait for the interval and that the loop repeats, neither of which needs long waits.
      await new Promise((resolve) => setTimeout(resolve, 60));
      insertReplay(connection, 'second-round', 1);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await Effect.runPromise(Fiber.interrupt(fiber));

      assert.ok(sweeps.length >= 2, `expected a repeat, saw ${sweeps.length} reported sweeps`);
      assert.equal(maxConcurrent, 1, 'a sweep may not begin before the previous one returned');
      assert.equal(count(connection.db, 'SELECT count(*) AS c FROM creation_replays'), 0);
    } finally {
      connection?.close();
      temp.cleanup();
    }
  });

  test('interrupting the loop stops it rather than starting another sweep', async () => {
    const temp = tempDatabase('gc-interrupt');
    let connection: DatabaseConnection | undefined;
    try {
      connection = openMigrated(temp.file);
      let sweeps = 0;

      // `Effect.runFork`, not `Effect.fork` inside a `runPromise`: the latter forks into the calling
      // fiber's scope, and that fiber ends the moment `runPromise` resolves - taking the loop with it.
      // Production forks the same way, at the top level of the server's runtime.
      const fiber = Effect.runFork(
        Effect.provideService(
          collectExpiredReplays({
            batchSize: 5,
            intervalMs: 20,
            onSweep: () => {
              sweeps += 1;
            },
            onFailure: () => {},
          }),
          Db,
          { db: connection.db, databasePath: connection.databasePath },
        ),
      );

      const exit = await Effect.runPromise(Fiber.interrupt(fiber));
      assert.equal(Exit.isInterrupted(exit), true, 'interruption must not be swallowed');

      const observed = sweeps;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(sweeps, observed, 'no sweep may run after the loop was interrupted');
    } finally {
      connection?.close();
      temp.cleanup();
    }
  });

  test('interrupting a sweep that is genuinely mid-backlog stops it part-way', async () => {
    // The stronger half of the check above. That one interrupts a loop between sweeps, which
    // establishes that no *new* sweep starts; it says nothing about a sweep that is already running,
    // and shutdown interrupts the collector without knowing which of the two it has caught.
    //
    // Being inside a sweep is arranged rather than hoped for: a backlog far larger than one batch,
    // and a batch size small enough that finishing takes many of them. The yield between batches is a
    // real macrotask, so the interruption lands between batches with rows still to go - which is the
    // observable that proves the sweep was active, because a sweep that had not started would leave
    // every row and one that had finished would leave none.
    const temp = tempDatabase('gc-mid-sweep');
    let connection: DatabaseConnection | undefined;
    try {
      connection = openMigrated(temp.file);
      const total = 400;
      for (let index = 0; index < total; index += 1) {
        insertReplay(connection, `expired-${String(index).padStart(4, '0')}`, 1);
      }

      let failures = 0;
      const fiber = Effect.runFork(
        Effect.provideService(
          collectExpiredReplays({
            batchSize: 5,
            intervalMs: 60_000,
            onSweep: () => {},
            onFailure: () => {
              failures += 1;
            },
          }),
          Db,
          { db: connection.db, databasePath: connection.databasePath },
        ),
      );

      // Wait until the sweep has demonstrably started and demonstrably not finished.
      const deadline = Date.now() + 5_000;
      let midway = total;
      while (Date.now() < deadline) {
        midway = count(connection.db, 'SELECT count(*) AS c FROM creation_replays');
        if (midway < total && midway > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.ok(
        midway < total,
        'the sweep never started, so nothing here is about an active sweep',
      );
      assert.ok(midway > 0, 'the sweep finished before it could be interrupted; raise the backlog');

      const exit = await Effect.runPromise(Fiber.interrupt(fiber));
      assert.equal(Exit.isInterrupted(exit), true, 'interruption must not be swallowed');

      // Stopped part-way: committed batches are gone and the rest are still there. A sweep is a
      // series of short transactions, so an interrupted one leaves exactly this.
      const afterInterrupt = count(connection.db, 'SELECT count(*) AS c FROM creation_replays');
      assert.ok(afterInterrupt > 0, 'the sweep ran to completion despite being interrupted');

      // And nothing continues afterwards. This is the guarantee shutdown depends on: collection stops
      // before the drain, so nothing it started can still be touching the database later.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        count(connection.db, 'SELECT count(*) AS c FROM creation_replays'),
        afterInterrupt,
        'a batch ran after the collector was interrupted',
      );
      assert.equal(failures, 0, 'interruption must not be reported as a sweep failure');
    } finally {
      connection?.close();
      temp.cleanup();
    }
  });

  test('nothing touches the database after the collector is interrupted and storage is closed', async () => {
    // The order shutdown actually uses: stop collecting, then release the database. If an interrupted
    // sweep could still reach a closed connection, better-sqlite3 would throw "The database
    // connection is not open" from a fiber nobody is watching - so this closes storage underneath a
    // collector that was mid-backlog and asserts that nothing is raised and nothing is reported.
    const temp = tempDatabase('gc-after-close');
    let connection: DatabaseConnection | undefined;
    let closed = false;
    const raised: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      raised.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);
    try {
      connection = openMigrated(temp.file);
      for (let index = 0; index < 400; index += 1) {
        insertReplay(connection, `expired-${String(index).padStart(4, '0')}`, 1);
      }

      let failures = 0;
      const fiber = Effect.runFork(
        Effect.provideService(
          collectExpiredReplays({
            batchSize: 5,
            intervalMs: 60_000,
            onSweep: () => {},
            onFailure: () => {
              failures += 1;
            },
          }),
          Db,
          { db: connection.db, databasePath: connection.databasePath },
        ),
      );

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const remaining = count(connection.db, 'SELECT count(*) AS c FROM creation_replays');
        if (remaining < 400 && remaining > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      await Effect.runPromise(Fiber.interrupt(fiber));
      connection.close();
      closed = true;

      // Long enough for several more batches and several more intervals, had any been coming.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(raised, [], 'something reached the database after it was closed');
      assert.equal(failures, 0, 'a sweep failed after the collector was interrupted');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUnhandled);
      if (!closed) connection?.close();
      temp.cleanup();
    }
  });

  test('a failing sweep is reported and retried, never fatal and never a tight loop', async () => {
    const temp = tempDatabase('gc-loop-failure');
    let connection: DatabaseConnection | undefined;
    try {
      connection = openMigrated(temp.file);
      connection.db.exec('ALTER TABLE creation_replays RENAME TO creation_replays_moved');

      const failures: SweepFailure[] = [];
      // `Effect.runFork`, not `Effect.fork` inside a `runPromise`: the latter forks into the calling
      // fiber's scope, and that fiber ends the moment `runPromise` resolves - taking the loop with it.
      // Production forks the same way, at the top level of the server's runtime.
      const fiber = Effect.runFork(
        Effect.provideService(
          collectExpiredReplays({
            batchSize: 5,
            intervalMs: 30,
            onSweep: () => assert.fail('there is nothing to sweep'),
            onFailure: (failure) => failures.push(failure),
          }),
          Db,
          { db: connection.db, databasePath: connection.databasePath },
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      const stillRunning = await Effect.runPromise(Fiber.poll(fiber));
      // The loop is still alive: a maintenance failure does not take the server with it.
      assert.equal(stillRunning._tag, 'None');
      await Effect.runPromise(Fiber.interrupt(fiber));

      assert.ok(failures.length >= 2, 'a failing sweep must be retried on the ordinary interval');
      // Retried on the interval, not spun: roughly 150ms of a 30ms interval is a handful of attempts.
      assert.ok(failures.length < 20, `${failures.length} attempts in 150ms is a tight loop`);
      assert.equal(/creation_replays|SQL|no such table/u.test(failures[0]?.detail ?? ''), false);

      connection.db.exec('ALTER TABLE creation_replays_moved RENAME TO creation_replays');
    } finally {
      connection?.close();
      temp.cleanup();
    }
  });
});

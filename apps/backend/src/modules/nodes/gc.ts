import { Duration, Effect } from 'effect';

import { Db } from '../../infrastructure/database/layer.ts';
import { writeTransaction } from './store.ts';

/**
 * Collecting expired replay records.
 *
 * This is maintenance, not correctness. Expiry is already enforced at lookup, so a server whose GC
 * never ran still refuses an expired key; what accumulates without this is rows. That is why a
 * failure here is logged and retried rather than allowed to stop the server, and why a sweep never
 * blocks readiness.
 *
 * Deletion is by the stored `expires_at` and nothing else. The retention constant is not imported:
 * recomputing an expiry from `created_at` at collection time would make this module a second
 * authority on retention, and the two would disagree the moment either changed.
 *
 * Three properties are load-bearing.
 *
 * **A cutoff sampled once per sweep.** Without it a sweep chases rows that expire while it runs and a
 * busy server never reaches the end of one. With it, each batch strictly shrinks a fixed candidate
 * set, so "a batch deleted fewer than the batch size" is a real end condition.
 *
 * **Bounded batches in short transactions.** better-sqlite3 is synchronous, so a batch holds this
 * thread for as long as it runs and one large delete would stall every in-flight request. Batch size
 * is therefore a responsiveness setting as much as a transaction-size one.
 *
 * **A real scheduling yield between batches.** The yield is a macrotask, not a fiber yield: what has
 * to happen between batches is Node's event loop reaching its poll phase so socket reads and writes
 * progress. A yield that resolved as a microtask would satisfy the shape of this loop and starve the
 * server anyway. This creates the opportunity; it does not promise that any particular request runs.
 *
 * The backlog this faces is not bounded by the retention window. Downtime, or a sustained failure
 * here, leaves rows that expired long ago - retention governs when a key stops being replayable, not
 * when its row physically goes away - so the loop is written to work through an arbitrarily large
 * backlog without ever holding the thread for an unbounded stretch.
 */

export interface SweepOutcome {
  readonly deleted: number;
  readonly batches: number;
}

/**
 * A sweep that stopped part-way.
 *
 * It carries what was already deleted, because those batches committed in their own transactions and
 * are gone. Reporting a failed sweep as having deleted nothing would describe committed work as rolled
 * back. `detail` is our own sanitized words; the driver error behind it is not retained, since a
 * routine maintenance log must never print SQL text or bound parameters.
 */
export class SweepFailure {
  readonly _tag = 'SweepFailure';
  readonly deleted: number;
  readonly batches: number;
  readonly detail: string;
  constructor(deleted: number, batches: number, detail: string) {
    this.deleted = deleted;
    this.batches = batches;
    this.detail = detail;
  }
}

/**
 * Hand control back to the event loop.
 *
 * `Effect.async` rather than a detached promise, so an interruption during the pause cancels the
 * pending immediate instead of leaving a timer that fires into a torn-down runtime.
 */
const yieldToEventLoop: Effect.Effect<void> = Effect.async<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});

/**
 * One batch, in its own short transaction.
 *
 * `ORDER BY expires_at` with no tiebreaker is deliberate. Adding `key` forces SQLite to sort the
 * matching rows through a temporary B-tree on every batch - measured against this schema - and buys
 * nothing: GC publishes no ordering contract, and a cutoff plus a bounded delete guarantees progress
 * whatever order equal expiries come out in.
 *
 * `batchSize` arrives already validated as a positive integer. That matters here specifically:
 * SQLite reads a negative `LIMIT` as *no limit*, so an unvalidated batch size would silently turn one
 * batch into the whole backlog.
 */
const deleteBatch = (cutoff: number, batchSize: number): Effect.Effect<number, Error, Db> =>
  Effect.flatMap(Db, ({ db }) =>
    Effect.try({
      try: () =>
        writeTransaction(
          db,
          () =>
            db
              .prepare(
                'DELETE FROM creation_replays WHERE expires_at <= ? ORDER BY expires_at LIMIT ?',
              )
              .run(cutoff, batchSize).changes,
        ),
      catch: (cause) => cause as Error,
    }),
  );

/**
 * One sweep: sample a cutoff, then delete bounded batches until one comes back short.
 *
 * Interruption is observed between batches, at the yield. A sweep interrupted by shutdown leaves the
 * batches it already committed committed - they are independent deletions, not one logical unit -
 * and produces no outcome, because an interrupted sweep did not finish and must not report as if it
 * had.
 */
export const sweepExpiredReplays = (options: {
  readonly batchSize: number;
}): Effect.Effect<SweepOutcome, SweepFailure, Db> =>
  Effect.gen(function* () {
    const cutoff = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    let deleted = 0;
    let batches = 0;

    for (;;) {
      const removed = yield* Effect.mapError(
        deleteBatch(cutoff, options.batchSize),
        () =>
          new SweepFailure(deleted, batches, 'a replay-collection batch was rejected by storage'),
      );
      deleted += removed;
      batches += 1;
      if (removed < options.batchSize) return { deleted, batches };
      yield* yieldToEventLoop;
    }
  });

/**
 * The collection loop: sweep, wait, sweep again, for as long as the scope that forked it lives.
 *
 * A loop rather than a scheduler is what makes overlapping sweeps structurally impossible - the next
 * one cannot begin until this one has returned - so there is no overlap guard to write, reason about,
 * or get wrong.
 *
 * The first sweep runs immediately and is *not* awaited by startup. A server that came back after a
 * long outage would otherwise work through its entire backlog before accepting a request, which would
 * turn a maintenance task into an availability problem.
 *
 * A failure never ends the loop and never becomes a tight retry: the sweep is logged and the loop
 * waits out its ordinary interval before trying again. Interruption, by contrast, is never swallowed -
 * it propagates, so shutdown stops this loop rather than being absorbed into another sweep.
 */
export const collectExpiredReplays = (options: {
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly onSweep: (outcome: SweepOutcome) => void;
  readonly onFailure: (failure: SweepFailure) => void;
}): Effect.Effect<never, never, Db> =>
  Effect.gen(function* () {
    for (;;) {
      yield* sweepExpiredReplays({ batchSize: options.batchSize }).pipe(
        Effect.matchEffect({
          onSuccess: (outcome) =>
            Effect.sync(() => {
              // A sweep that found nothing is the ordinary case and says nothing worth a line.
              if (outcome.deleted > 0) options.onSweep(outcome);
            }),
          onFailure: (failure) => Effect.sync(() => options.onFailure(failure)),
        }),
      );
      yield* Effect.sleep(Duration.millis(options.intervalMs));
    }
  });

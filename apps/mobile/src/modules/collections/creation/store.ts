/**
 * Reading and writing pending attempts. Every statement is bound; every row is validated.
 *
 * Two things here are load-bearing beyond ordinary persistence.
 *
 * **`observed_at` only moves forward.** Every write takes the greater of the stored value and the
 * time being recorded, so a clock set backwards cannot lower the mark that later comparisons are
 * made against. Without that, one backward jump would erase the evidence of itself.
 *
 * **`first_uncertain_at` is written once.** `COALESCE` on every path that sets it means an attempt
 * that has been uncertain stays that way through any number of later definite failures. This is the
 * SQL half of the rule; `logicalStateOf` is the half that reads it.
 *
 * No transaction here spans anything but SQL. Dispatch happens between calls, never inside one.
 */

import { NODE_TYPES, type NodeType } from '@raphael/contracts/nodes';

import { migrate } from '../../../infrastructure/sqlite/migrate.ts';
import type { SqlConnection, SqlTransaction } from '../../../infrastructure/sqlite/port.ts';
import { CREATION_MIGRATIONS, ATTEMPTS_TABLE } from './schema.ts';
import type { AcknowledgedResult, AttemptOutcome, AttemptRecord, AttemptState } from './types.ts';

const STATES: readonly AttemptState[] = ['dispatch_intent', 'uncertain', 'blocked', 'acknowledged'];

interface AttemptRow {
  readonly attempt_id: string;
  readonly connection_id: string;
  readonly endpoint: string;
  readonly state: string;
  readonly request: string;
  readonly type: string;
  readonly title: string;
  readonly parent_area_id: number | null;
  readonly first_dispatch_at: number;
  readonly first_uncertain_at: number | null;
  readonly clock_anomaly: number;
  readonly last_outcome: string | null;
  readonly acknowledged: string | null;
  readonly observed_at: number;
}

const COLUMNS = `attempt_id, connection_id, endpoint, state, request, type, title, parent_area_id,
  first_dispatch_at, first_uncertain_at, clock_anomaly, last_outcome, acknowledged, observed_at`;

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isOutcome = (value: unknown): value is AttemptOutcome =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AttemptOutcome).kind === 'string' &&
  typeof (value as AttemptOutcome).message === 'string' &&
  typeof (value as AttemptOutcome).at === 'number';

const isAcknowledged = (value: unknown): value is AcknowledgedResult =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AcknowledgedResult).id === 'number' &&
  typeof (value as AcknowledgedResult).title === 'string' &&
  NODE_TYPES.includes((value as AcknowledgedResult).type);

/**
 * A row becomes a record only if every field is what it claims to be.
 *
 * Null for an unreadable row rather than a throw or a repair. One bad row must not make the others
 * unreadable, and it must not be silently rewritten into something plausible either - the caller
 * counts them and says so.
 */
const toRecord = (row: AttemptRow): AttemptRecord | null => {
  if (!STATES.includes(row.state as AttemptState)) return null;
  if (!NODE_TYPES.includes(row.type as NodeType)) return null;
  if (row.title === '') return null;
  if (!Number.isSafeInteger(row.first_dispatch_at)) return null;
  if (!Number.isSafeInteger(row.observed_at)) return null;

  const outcome = parseJson(row.last_outcome);
  const acknowledged = parseJson(row.acknowledged);

  // An acknowledged row whose result cannot be read is unreadable, not an ordinary success: the
  // whole point of the state is that it reports what the server actually created.
  if (row.state === 'acknowledged' && !isAcknowledged(acknowledged)) return null;

  return {
    attemptId: row.attempt_id,
    connectionId: row.connection_id,
    endpoint: row.endpoint,
    state: row.state as AttemptState,
    request: row.request,
    type: row.type as NodeType,
    title: row.title,
    parentAreaId: row.parent_area_id,
    firstDispatchAt: row.first_dispatch_at,
    firstUncertainAt: Number.isSafeInteger(row.first_uncertain_at) ? row.first_uncertain_at : null,
    clockAnomaly: row.clock_anomaly === 1,
    lastOutcome: isOutcome(outcome) ? outcome : null,
    acknowledged: isAcknowledged(acknowledged) ? acknowledged : null,
    observedAt: row.observed_at,
  };
};

export interface NewAttempt {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly request: string;
  readonly type: NodeType;
  readonly title: string;
  readonly parentAreaId: number | null;
  readonly at: number;
}

export interface StoredAttempts {
  readonly records: readonly AttemptRecord[];
  /** Rows that did not validate. Reported, never deleted or repaired. */
  readonly unreadable: number;
}

const insertStatement = `INSERT INTO ${ATTEMPTS_TABLE} (${COLUMNS})
  VALUES (?, ?, ?, 'dispatch_intent', ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?)`;

const insertParams = (attempt: NewAttempt) => [
  attempt.attemptId,
  attempt.connectionId,
  attempt.endpoint,
  attempt.request,
  attempt.type,
  attempt.title,
  attempt.parentAreaId,
  attempt.at,
  attempt.at,
];

/**
 * What a write answers with: the row as the database now holds it.
 *
 * Every mutating operation returns this so a caller can publish what it just did without reading
 * the whole table back. Null means no row matched - it was removed, or a guard declined.
 */
export type WrittenRecord = AttemptRecord | null;

export interface AttemptStore {
  list(): Promise<StoredAttempts>;
  /** Writes the intent. Nothing may be sent until this resolves. */
  insertIntent(attempt: NewAttempt): Promise<WrittenRecord>;
  /** Records uncertainty, setting the history the first time only. */
  markUncertain(attemptId: string, at: number): Promise<WrittenRecord>;
  markBlocked(attemptId: string, outcome: AttemptOutcome, at: number): Promise<WrittenRecord>;
  markAcknowledged(
    attemptId: string,
    result: AcknowledgedResult,
    at: number,
  ): Promise<WrittenRecord>;
  markClockAnomaly(attemptId: string, at: number): Promise<WrittenRecord>;
  remove(attemptId: string): Promise<void>;
  /** Replaces a definite non-creating record with a corrected attempt, in one transaction. */
  replace(previousId: string, attempt: NewAttempt): Promise<WrittenRecord>;
  /**
   * Adopts interrupted intents as uncertain. Run once at open, before any dispatcher exists.
   *
   * Transactional and idempotent: an initialization interrupted partway can be repeated without
   * compounding what it already wrote, because `COALESCE` leaves an adopted row alone.
   */
  reconcile(at: number): Promise<number>;
  close(): Promise<void>;
}

export type OpenOutcome =
  | { readonly kind: 'ready'; readonly store: AttemptStore }
  | { readonly kind: 'unsupported_version'; readonly found: number; readonly supported: number }
  | { readonly kind: 'failed'; readonly message: string };

/** `observed_at` never goes backwards, whatever the clock says. */
const observed = 'observed_at = MAX(observed_at, ?)';

/** Reads one row inside whatever transaction is running, and validates it on the way out. */
const readRecord = async (tx: SqlTransaction, attemptId: string): Promise<AttemptRecord | null> => {
  const row = await tx.get<AttemptRow>(
    `SELECT ${COLUMNS} FROM ${ATTEMPTS_TABLE} WHERE attempt_id = ?`,
    [attemptId],
  );

  return row === undefined ? null : toRecord(row);
};

export const createAttemptStore = (db: SqlConnection): AttemptStore => {
  /**
   * Apply one statement and hand back the row it produced, read inside the same transaction.
   *
   * The read-back is what makes a persisted transition publishable without a separate reread. The
   * caller used to write and then rely on `list()` to discover what it had done, so a failed read
   * could leave the app holding the row as it was *before* a success already committed - and the
   * sheet would then offer to create the same thing again under a new key.
   *
   * Reading here rather than reconstructing the new row in the caller keeps one authority for what
   * a transition does. `COALESCE` on the uncertainty timestamp and `MAX` on the observed mark are
   * rules that live in this SQL; a caller mirroring them in JavaScript would be a second copy, free
   * to drift. What comes back is what the database now holds.
   */
  const write = (sql: string, params: readonly (string | number | null)[], attemptId: string) =>
    db.transaction(async (tx: SqlTransaction) => {
      await tx.run(sql, params);

      return readRecord(tx, attemptId);
    });

  return {
    list: async () => {
      const rows = await db.all<AttemptRow>(
        `SELECT ${COLUMNS} FROM ${ATTEMPTS_TABLE} ORDER BY first_dispatch_at ASC`,
      );
      const records: AttemptRecord[] = [];
      let unreadable = 0;

      for (const row of rows) {
        const record = toRecord(row);
        if (record === null) unreadable += 1;
        else records.push(record);
      }

      return { records, unreadable };
    },

    insertIntent: (attempt) => write(insertStatement, insertParams(attempt), attempt.attemptId),

    markUncertain: (attemptId, at) =>
      write(
        `UPDATE ${ATTEMPTS_TABLE}
         SET state = 'uncertain', first_uncertain_at = COALESCE(first_uncertain_at, ?), ${observed}
         WHERE attempt_id = ? AND state != 'acknowledged'`,
        [at, at, attemptId],
        attemptId,
      ),

    markBlocked: (attemptId, outcome, at) =>
      write(
        `UPDATE ${ATTEMPTS_TABLE}
         SET state = 'blocked', last_outcome = ?, ${observed}
         WHERE attempt_id = ? AND state != 'acknowledged'`,
        [JSON.stringify(outcome), at, attemptId],
        attemptId,
      ),

    // Success is terminal and unconditional: it is the one answer that resolves the creation, and a
    // guard here could only ever refuse to record something the server has already done.
    markAcknowledged: (attemptId, result, at) =>
      write(
        `UPDATE ${ATTEMPTS_TABLE}
         SET state = 'acknowledged', acknowledged = ?, last_outcome = NULL, ${observed}
         WHERE attempt_id = ?`,
        [JSON.stringify(result), at, attemptId],
        attemptId,
      ),

    markClockAnomaly: (attemptId, at) =>
      write(
        `UPDATE ${ATTEMPTS_TABLE} SET clock_anomaly = 1, ${observed} WHERE attempt_id = ?`,
        [at, attemptId],
        attemptId,
      ),

    remove: async (attemptId) => {
      await db.transaction(async (tx) => {
        await tx.run(`DELETE FROM ${ATTEMPTS_TABLE} WHERE attempt_id = ?`, [attemptId]);
      });
    },

    replace: (previousId, attempt) =>
      db.transaction(async (tx) => {
        // Guarded in SQL as well as by `replacementAllowed`, because the consequence of getting it
        // wrong is deleting the only record that an ambiguous creation ever happened.
        await tx.run(
          `DELETE FROM ${ATTEMPTS_TABLE}
           WHERE attempt_id = ? AND state = 'blocked' AND first_uncertain_at IS NULL`,
          [previousId],
        );
        await tx.run(insertStatement, insertParams(attempt));

        return readRecord(tx, attempt.attemptId);
      }),

    reconcile: async (at) =>
      db.transaction(async (tx) => {
        const pending = await tx.all<{ attempt_id: string }>(
          `SELECT attempt_id FROM ${ATTEMPTS_TABLE} WHERE state = 'dispatch_intent'`,
        );

        await tx.run(
          `UPDATE ${ATTEMPTS_TABLE}
           SET state = 'uncertain', first_uncertain_at = COALESCE(first_uncertain_at, ?), ${observed}
           WHERE state = 'dispatch_intent'`,
          [at, at],
        );

        return pending.length;
      }),

    close: () => db.close(),
  };
};

/**
 * Open the database, bring it to the current schema, and adopt anything a previous process left
 * mid-dispatch. The sweep happens here, before the store is handed out, so no dispatcher can exist
 * while it runs.
 */
export const openAttemptStore = async (
  db: SqlConnection,
  now: () => number,
): Promise<OpenOutcome> => {
  /**
   * Every way out that does not hand back a live store closes the connection first.
   *
   * The caller retries an open, and each retry builds a new connection. Without this, an
   * unsupported version or a failed sweep would leave the previous one alive with whatever locks
   * it holds, and pressing Try again would quietly accumulate handles against a database this
   * process has already given up on.
   */
  const closing = async (outcome: OpenOutcome): Promise<OpenOutcome> => {
    try {
      await db.close();
    } catch {
      // Nothing better is available: the open already failed, and a close that also fails changes
      // neither the outcome nor what the person is told.
    }

    return outcome;
  };

  const outcome = await migrate(db, CREATION_MIGRATIONS);

  if (outcome.kind === 'unsupported_version') {
    return closing({
      kind: 'unsupported_version',
      found: outcome.found,
      supported: outcome.supported,
    });
  }
  if (outcome.kind === 'failed') return closing({ kind: 'failed', message: outcome.message });

  const store = createAttemptStore(db);

  try {
    await store.reconcile(now());
  } catch (cause) {
    return closing({
      kind: 'failed',
      message: cause instanceof Error ? cause.message : 'the saved attempts could not be read',
    });
  }

  return { kind: 'ready', store };
};

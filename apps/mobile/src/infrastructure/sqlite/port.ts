/**
 * The narrow SQL surface the app is allowed to use, and nothing about what it stores.
 *
 * A port rather than a direct dependency for two reasons, and only one of them is testing. The
 * first is that `expo-sqlite` cannot be loaded by `node --test` on this runtime, so a store written
 * against it directly would have its transactions, its rollbacks, and its reopen behaviour reviewed
 * by reading rather than by running. The second is that the production driver is native code with a
 * platform check in front of it, and a module that reached for it at import time would evaluate that
 * native path on web - where the connection gate prevents rendering, not module evaluation.
 *
 * The surface is deliberately small. No query builder, no schema knowledge, no capability
 * vocabulary: this file could serve any capability, and `infrastructure/` may not import one.
 *
 * **Transactions are serialized by the implementation, not by the caller.** One connection is shared,
 * and JavaScript can interleave two `await`s inside two overlapping transactions into one incoherent
 * `BEGIN`/`COMMIT` pair. Every driver here therefore runs transaction bodies one at a time.
 */

/** What a bound parameter may be. Deliberately not `unknown`: everything stored here is one of these. */
export type SqlParam = string | number | null;

export interface SqlReader {
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;
  all<R>(sql: string, params?: readonly SqlParam[]): Promise<readonly R[]>;
  get<R>(sql: string, params?: readonly SqlParam[]): Promise<R | undefined>;
}

/** The handle a transaction body is given. It cannot open another transaction or close the database. */
export type SqlTransaction = SqlReader;

export interface SqlConnection extends SqlReader {
  /**
   * Run `body` inside one transaction, serialized against every other transaction on this
   * connection. A throw rolls back and propagates; nothing is left half-applied.
   *
   * Never hold one of these across an HTTP request, a navigation, or a cache refresh. A transaction
   * is a lock on the database, and the point of this store is that the phone can be killed at any
   * moment - a transaction waiting on a network answer is a lock held for as long as the network
   * feels like taking.
   */
  transaction<A>(body: (tx: SqlTransaction) => Promise<A>): Promise<A>;
  close(): Promise<void>;
}

/**
 * Opening a database. The name is a file name, owned by the caller.
 *
 * Acquisition is async and lazy on purpose: the production driver imports native code, and that
 * import must not happen merely because something in the module graph was evaluated.
 */
export interface SqlDriver {
  open(name: string): Promise<SqlConnection>;
}

/**
 * Serializes transaction bodies on one connection.
 *
 * Shared by every driver rather than reimplemented per platform, because "two transactions
 * interleaved into one" is a bug whose symptoms appear in the data long after the interleaving, and
 * one implementation of it is one thing to get right.
 */
export const serializeTransactions = (): (<A>(body: () => Promise<A>) => Promise<A>) => {
  let tail: Promise<unknown> = Promise.resolve();

  return <A>(body: () => Promise<A>): Promise<A> => {
    // The queue must not break on a failed transaction: a rollback is an ordinary outcome, and a
    // rejected tail would deadlock every transaction queued behind it.
    const queued = tail.then(body, body);
    tail = queued.then(
      () => undefined,
      () => undefined,
    );

    return queued;
  };
};

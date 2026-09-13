/**
 * The native driver. This file is the one Metro resolves on iOS and Android.
 *
 * **Web resolves `driver.web.ts` instead, and that is the whole mechanism.** A lazy
 * `await import('expo-sqlite')` was tried first and is not enough: the connection gate stops web
 * from rendering, but Metro still walks a dynamic import when it builds the graph, and building it
 * pulls in `expo-sqlite`'s browser worker and the wasm asset beside it. The web bundle failed to
 * resolve that asset - so a runtime check cannot fix a build-time problem, and the import has to not
 * exist on that platform at all. Splitting the file makes the platform boundary structural, and the
 * architecture test holds it there.
 *
 * Transactions go through `withExclusiveTransactionAsync`, which is Expo's own serialization rather
 * than ours layered on top of it: it takes the database's exclusive lock for the body, so two
 * overlapping transactions cannot interleave their statements. `serializeTransactions` still wraps
 * it, because the queue also orders the *callers* - and a queue that is redundant on one platform is
 * cheaper than a race that only appears on the other.
 */

import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import {
  serializeTransactions,
  type SqlConnection,
  type SqlDriver,
  type SqlParam,
  type SqlReader,
  type SqlTransaction,
} from './port.ts';

export const SQLITE_SUPPORTED = true;

/** The subset of Expo's database this app uses, on both the connection and a transaction handle. */
type Statements = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

const reader = (source: Statements): SqlReader => ({
  run: async (sql, params = []) => {
    await source.runAsync(sql, params as SqlParam[]);
  },
  all: async <R>(sql: string, params: readonly SqlParam[] = []) =>
    source.getAllAsync<R>(sql, params as SqlParam[]),
  get: async <R>(sql: string, params: readonly SqlParam[] = []) =>
    (await source.getFirstAsync<R>(sql, params as SqlParam[])) ?? undefined,
});

export const sqlDriver: SqlDriver = {
  open: async (name: string): Promise<SqlConnection> => {
    const db = await openDatabaseAsync(name);
    const serialize = serializeTransactions();

    return {
      ...reader(db),
      transaction: <A>(body: (tx: SqlTransaction) => Promise<A>): Promise<A> =>
        serialize(async () => {
          // The result escapes through a holder rather than a return value, because Expo's
          // transaction body is typed as returning nothing. A throw inside still rolls back and
          // propagates, so the holder is only read where the body ran to completion.
          const holder: { settled: boolean; value?: A } = { settled: false };

          await db.withExclusiveTransactionAsync(async (tx) => {
            holder.value = await body(reader(tx));
            holder.settled = true;
          });

          if (!holder.settled) throw new Error('the transaction body did not complete');

          return holder.value as A;
        }),
      close: async (): Promise<void> => {
        await db.closeAsync();
      },
    };
  },
};

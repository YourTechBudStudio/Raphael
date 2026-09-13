/**
 * Reading and writing the stored connection, in an order nothing can get wrong.
 *
 * Two problems live here and neither is solved by checking a generation afterwards.
 *
 * The first is ordering. A write cannot be undone by noticing, once it has landed, that a newer
 * decision has since been taken. If a disconnect is decided while a save is still in flight, the
 * save must not be the thing the keychain ends up holding. So every operation is queued and runs
 * one at a time, in the order it was asked for, and a mutation that is still waiting when a newer
 * mutation arrives is dropped before it runs rather than written and then overwritten.
 *
 * The second is that "it did not work" has several meanings that a screen has to tell apart: there
 * is nothing stored, there is something stored that cannot be read, the platform has no secure
 * storage at all, and the write itself refused. Each is its own outcome here, and none of them is
 * an exception, because an exception at this boundary is exactly the thing that gets caught
 * somewhere generic and turned back into "no connection".
 *
 * The port is injected, so every one of those paths - including a delayed read that finishes after
 * a disconnect, and a write that refuses - is reachable from a test with no device in the room.
 */

import { decodeRecord, encodeRecord, type ConnectionRecord, type RecordProblem } from './record.ts';

/**
 * The platform's secure storage, or the fact that it has none.
 *
 * `unsupported` is a property of the platform, not a failure of an attempt, which is why it is a
 * shape of the port rather than an outcome of calling it. Nothing is ever attempted against a
 * platform that cannot store a secret, so no code path has to decide what a refused write means
 * when there was never a keychain to refuse.
 */
export type SecurePort =
  | {
      readonly kind: 'available';
      readonly get: () => Promise<string | null>;
      readonly set: (value: string) => Promise<void>;
      readonly remove: () => Promise<void>;
    }
  | { readonly kind: 'unsupported' };

export type ReadOutcome =
  | { readonly kind: 'absent' }
  | { readonly kind: 'loaded'; readonly record: ConnectionRecord }
  | { readonly kind: 'invalid'; readonly problem: RecordProblem }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unsupported' };

export type WriteOutcome =
  | { readonly kind: 'saved' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unsupported' }
  /** A newer decision replaced this one before it ran. Nothing was written. */
  | { readonly kind: 'superseded' };

export type RemoveOutcome =
  | { readonly kind: 'removed' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'superseded' };

export interface ConnectionStorage {
  read: () => Promise<ReadOutcome>;
  save: (record: ConnectionRecord) => Promise<WriteOutcome>;
  remove: () => Promise<RemoveOutcome>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : 'The reason was not reported.';

export const createConnectionStorage = (port: SecurePort): ConnectionStorage => {
  // The tail of the queue. Every operation chains onto it, so two callers can never be inside the
  // port at the same time and the order they asked in is the order the keychain sees.
  let tail: Promise<unknown> = Promise.resolve();
  // Issued mutations. A queued mutation whose ticket is no longer the latest has been overtaken by
  // a newer decision and must not run: writing it and letting the newer one overwrite it would
  // leave the correct value in place only by luck of scheduling.
  let latestMutation = 0;

  const enqueue = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = tail.then(operation, operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  };

  if (port.kind === 'unsupported') {
    return {
      read: () => Promise.resolve({ kind: 'unsupported' }),
      save: () => Promise.resolve({ kind: 'unsupported' }),
      remove: () => Promise.resolve({ kind: 'unsupported' }),
    };
  }

  return {
    read: () =>
      enqueue(async (): Promise<ReadOutcome> => {
        let raw: string | null;

        try {
          raw = await port.get();
        } catch (error) {
          return { kind: 'failed', message: messageOf(error) };
        }

        if (raw === null || raw === '') return { kind: 'absent' };

        const decoded = decodeRecord(raw);

        return decoded.ok
          ? { kind: 'loaded', record: decoded.record }
          : { kind: 'invalid', problem: decoded.problem };
      }),

    save: (record) => {
      latestMutation += 1;
      const ticket = latestMutation;

      return enqueue(async (): Promise<WriteOutcome> => {
        if (ticket !== latestMutation) return { kind: 'superseded' };

        try {
          await port.set(encodeRecord(record));

          return { kind: 'saved' };
        } catch (error) {
          return { kind: 'failed', message: messageOf(error) };
        }
      });
    },

    remove: () => {
      latestMutation += 1;
      const ticket = latestMutation;

      return enqueue(async (): Promise<RemoveOutcome> => {
        if (ticket !== latestMutation) return { kind: 'superseded' };

        try {
          await port.remove();

          return { kind: 'removed' };
        } catch (error) {
          return { kind: 'failed', message: messageOf(error) };
        }
      });
    },
  };
};

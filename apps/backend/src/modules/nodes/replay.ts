import { decodeCreateResponse, type CreateResponse } from '@raphael/contracts/nodes';
import { eq } from 'drizzle-orm';

import { IdempotencyConflict, InternalFailure } from './errors.ts';
import { checkedResponse } from './projection.ts';
import { creationReplays } from './schema.ts';
import { raise } from './storage-failures.ts';
import type { Orm } from './store.ts';

/**
 * Historical creation results.
 *
 * Retention is exactly 72 hours from the successful creation, and a replay does not extend it. Expiry is
 * decided at lookup against a sampled clock, independently of whether anything has physically deleted
 * the row - so an expired key behaves as absent whether or not collection has run, and collection can
 * therefore be scheduled on operational grounds rather than correctness ones.
 *
 * What a replay returns is the response that was saved, not a fresh rendering of the entity as it is
 * now. That is the whole guarantee: the caller learns what their original request did, even if the node
 * has since been relocated or renamed. It is also why the record has no cascade from `nodes`.
 */

export const REPLAY_TTL_MS = 72 * 60 * 60 * 1000;

export interface ReplayRow {
  readonly key: string;
  readonly fingerprint: string;
  readonly resultJson: string;
  readonly expiresAt: number;
}

export const findReplay = (orm: Orm, key: string): ReplayRow | undefined =>
  orm
    .select({
      key: creationReplays.key,
      fingerprint: creationReplays.fingerprint,
      resultJson: creationReplays.resultJson,
      expiresAt: creationReplays.expiresAt,
    })
    .from(creationReplays)
    .where(eq(creationReplays.key, key))
    .get();

/**
 * What an existing record means for the request in hand. The matching row travels with the decision, so
 * no caller has to re-narrow a value this function already inspected.
 */
export type ReplayDecision =
  | { readonly kind: 'absent' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'replay'; readonly row: ReplayRow }
  | { readonly kind: 'conflict' };

/**
 * Expiry is checked before the fingerprint, because an expired record is logically gone: it can neither
 * replay nor conflict, and treating it as a conflict would refuse a legitimate new request on the
 * strength of a record we have already promised to forget.
 */
export const replayDecision = (
  row: ReplayRow | undefined,
  fingerprint: string,
  now: number,
): ReplayDecision => {
  if (row === undefined) return { kind: 'absent' };
  if (row.expiresAt <= now) return { kind: 'expired' };
  return row.fingerprint === fingerprint ? { kind: 'replay', row } : { kind: 'conflict' };
};

/**
 * The saved response, validated against the contract it was written under.
 *
 * The complete response is re-decoded rather than spot-checked. A record that cannot be read is an
 * integrity failure and fails the operation: it must not fall through to ordinary creation, because the
 * original entity does exist and creating a second one is precisely the duplicate the key exists to
 * prevent. Nothing here re-renders the body or runs it through current content validation - a historical
 * success must not become a failure because the current parser grew stricter.
 */
export const savedResponse = (row: ReplayRow, operation: string): CreateResponse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.resultJson);
  } catch {
    return raise(
      new InternalFailure({ operation, detail: 'a saved creation result is not parseable JSON' }),
    );
  }
  return checkedResponse(decodeCreateResponse, parsed, operation);
};

export const conflict = (): never => raise(new IdempotencyConflict({ reason: 'different_input' }));

/**
 * Records a creation result.
 *
 * An expired record is removed first, as its own statement, rather than replaced by an upsert. The
 * intent is then visible in the code, and there is no dependence on SQLite's `REPLACE` semantics, which
 * delete the old row through a path with its own trigger and foreign-key behavior. Both statements run
 * inside the caller's write transaction, so the node, the removal, and the new record are one fact.
 */
export const recordReplay = (
  orm: Orm,
  input: {
    readonly key: string;
    readonly fingerprint: string;
    readonly resultJson: string;
    readonly now: number;
    readonly replaceExpired: boolean;
  },
): void => {
  if (input.replaceExpired) {
    orm.delete(creationReplays).where(eq(creationReplays.key, input.key)).run();
  }
  orm
    .insert(creationReplays)
    .values({
      key: input.key,
      fingerprint: input.fingerprint,
      resultJson: input.resultJson,
      createdAt: input.now,
      expiresAt: input.now + REPLAY_TTL_MS,
    })
    .run();
};

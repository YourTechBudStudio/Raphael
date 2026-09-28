/**
 * What one answer from the server does to a row. Pure, so the whole table is unit-tested.
 *
 * `sent` is the row as it was when the request left; `row` is the row as it is now, since typing can
 * land while a request is in flight. Content comparisons use `sent`, version checks use `row`.
 */

import { retryable, type ClientFailure } from '@raphael/client';
import type { NodeEntity } from '@raphael/contracts/nodes';

import { nextSlug, sameContent, slugFor, type UnsentRow } from './row.ts';

export type Answer =
  | { readonly kind: 'saved'; readonly entity: NodeEntity }
  | { readonly kind: 'failed'; readonly failure: ClientFailure }
  /** What the server holds where a 409 pointed: the create's address, or the edited node. */
  | { readonly kind: 'found'; readonly entity: NodeEntity };

/** How a `sync(id)` caller hears about its row. */
export type SyncOutcome = 'saved' | 'waiting' | 'refused' | 'conflict';

export interface Step {
  /** The row to store, or null to delete it. */
  readonly row: UnsentRow | null;
  /** The server's copy of our writing, for the cache. */
  readonly entity: NodeEntity | null;
  /** Null when the row goes straight back out, as after a suffix. */
  readonly outcome: SyncOutcome | null;
}

/** Which 409s are looked up before deciding: they may be our own lost reply. */
export const needsLookup = (sent: UnsentRow, failure: ClientFailure): boolean =>
  sent.op === 'create' ? failure.code === 'slug_conflict' : failure.code === 'revision_conflict';

const NO_FREE_SLUG = 'Too many things here already have this name. Change the title and try again.';

const saved = (row: UnsentRow, sent: UnsentRow, entity: NodeEntity): Step => {
  const sentVersion = Math.max(row.sentVersion, sent.version);
  const clean = row.version === sentVersion;

  if (clean) return { row: null, entity, outcome: 'saved' };

  // Typing landed while the request was out. A create becomes an edit of what it created.
  return {
    row: {
      ...row,
      op: 'edit',
      nodeId: entity.id,
      baseRevision: entity.revision,
      destination: null,
      status: row.status === 'conflict' ? 'conflict' : 'pending',
      error: null,
      sentVersion,
    },
    entity,
    outcome: 'saved',
  };
};

export const transition = (row: UnsentRow, sent: UnsentRow, answer: Answer): Step => {
  if (answer.kind === 'saved') return saved(row, sent, answer.entity);

  if (answer.kind === 'found') {
    if (sameContent(sent, answer.entity)) return saved(row, sent, answer.entity);

    if (sent.op === 'edit') {
      return {
        row: { ...row, status: 'conflict', error: null },
        entity: null,
        outcome: 'conflict',
      };
    }

    const slug = nextSlug(slugFor(row.title) ?? sent.slug, sent.slug);

    return slug === null
      ? {
          row: { ...row, status: 'refused', error: NO_FREE_SLUG },
          entity: null,
          outcome: 'refused',
        }
      : { row: { ...row, slug, error: null }, entity: null, outcome: null };
  }

  const { failure } = answer;

  if (retryable(failure)) {
    return { row: { ...row, error: failure.message }, entity: null, outcome: 'waiting' };
  }

  return {
    row: { ...row, status: 'refused', error: failure.message },
    entity: null,
    outcome: 'refused',
  };
};

/**
 * One piece of writing the server does not have yet, and the checks made against it.
 *
 * A row is either a `create` (a draft until Save) or an `edit` of a node the server already holds.
 * `version` counts local writes and `sentVersion` is the highest the server has confirmed, so a row is
 * clean only when the two are equal.
 */

import { createEmptyDocument } from '@raphael/content';
import { deriveTitle } from '@raphael/content/validation';
import {
  SLUG_MAX_CODE_POINTS,
  deriveSlug,
  normalizeTag,
  type NodeEntity,
  type NodeType,
  type ResourceKind,
} from '@raphael/contracts/nodes';
import { Either } from 'effect';

import type { ContainerRef } from '../../infrastructure/api/contracts';

/** Where a new item goes: the top level (areas only) or inside a container. */
export type Destination = { readonly root: true } | ContainerRef;

export type UnsentStatus = 'draft' | 'pending' | 'refused' | 'conflict';

export interface UnsentContent {
  readonly title: string;
  readonly description: string;
  /** A create's slug is fixed at Save and empty before it; an edit's is the current value. */
  readonly slug: string;
  readonly tags: readonly string[];
  /** Canonical TipTap JSON: the editor canonicalizes every snapshot before it leaves the WebView. */
  readonly body: unknown;
}

export interface UnsentRow extends UnsentContent {
  readonly id: string;
  readonly op: 'create' | 'edit';
  readonly nodeType: NodeType;
  readonly kind: ResourceKind | null;
  /** Edit only. */
  readonly nodeId: number | null;
  /** Edit only: the revision this writing is based on. */
  readonly baseRevision: number | null;
  /** Create only. Null until chosen. */
  readonly destination: Destination | null;
  readonly status: UnsentStatus;
  /** The server's reason for a refusal, or the last retryable failure. */
  readonly error: string | null;
  readonly version: number;
  readonly sentVersion: number;
  readonly updatedAt: number;
}

/** What Unfinished lists: drafts, refusals, conflicts, and anything a retry is waiting on. */
export const isUnfinished = (row: UnsentRow): boolean =>
  row.status !== 'pending' || row.error !== null;

export const parentIdOf = (destination: Destination | null): number | null =>
  destination === null || 'root' in destination ? null : destination.id;

const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);

  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && jsonEqual(left[key], right[key]))
  );
};

/** Whether two versions of a row hold the same writing, field for field. */
export const sameWriting = (a: UnsentContent, b: UnsentContent): boolean =>
  a.title === b.title &&
  a.description === b.description &&
  a.slug === b.slug &&
  jsonEqual(a.tags, b.tags) &&
  jsonEqual(a.body, b.body);

/**
 * Whether the server's entity holds exactly this writing, normalized the way the server normalizes
 * it. This is how a lost reply is told from someone else's change.
 */
export const sameContent = (
  row: UnsentContent & Pick<UnsentRow, 'op' | 'destination'>,
  entity: NodeEntity,
): boolean =>
  row.title.trim() === entity.title &&
  row.description === entity.description &&
  row.slug === entity.slug &&
  jsonEqual(row.tags.map(normalizeTag), entity.tags) &&
  entity.body.format === 'tiptap' &&
  jsonEqual(row.body, entity.body.value) &&
  (row.op === 'edit' || parentIdOf(row.destination) === entity.parentId);

/** The title a new item is saved under: what was typed, or else its first line of writing. */
export const titleFor = (row: UnsentContent): string | null => {
  const typed = row.title.trim();

  if (typed !== '') return typed;

  return deriveTitle(row.body as Parameters<typeof deriveTitle>[0], row.description) ?? null;
};

const EMPTY_BODY = JSON.stringify(createEmptyDocument());

/** Anything a person wrote, which an empty draft does not have. */
export const hasWriting = (row: UnsentContent): boolean =>
  row.title.trim() !== '' ||
  row.description !== '' ||
  row.tags.length > 0 ||
  JSON.stringify(row.body) !== EMPTY_BODY;

/** Why Save cannot go yet, in order of what to fix first; null when it can. */
export type CreateProblem = 'destination' | 'writing' | 'slug';

export const createProblem = (row: UnsentRow): CreateProblem | null => {
  if (row.destination === null) return 'destination';

  const title = titleFor(row);

  if (title === null) return 'writing';

  return slugFor(title) === null ? 'slug' : null;
};

const LAST_TOKEN = /[^\p{L}\p{N}\p{M}]*[\p{L}\p{N}\p{M}]+[^\p{L}\p{N}\p{M}]*$/u;

/**
 * The slug a new item is saved under, or null when its title has no letters or numbers. A title that
 * derives past the bound loses whole words from the end until it fits.
 */
export const slugFor = (title: string): string | null => {
  let candidate = title;

  for (;;) {
    const derived = deriveSlug(candidate);

    if (Either.isRight(derived)) return derived.right;
    if (derived.left.reason === 'slug_underivable') return null;

    const shorter = candidate.replace(LAST_TOKEN, '');
    // One word too long on its own: cut it instead.
    candidate =
      shorter.trim() !== ''
        ? shorter
        : [...candidate]
            .slice(0, Math.min([...candidate].length - 1, SLUG_MAX_CODE_POINTS))
            .join('');
  }
};

/** At most this many suffixes are tried before a create is refused. */
export const MAX_SUFFIX_TRIES = 20;

/** `base-n`, cutting `base` on a hyphen so the result stays within the bound. */
export const withSuffix = (base: string, n: number): string => {
  const tail = `-${String(n)}`;
  let head = base;

  while ([...head].length + tail.length > SLUG_MAX_CODE_POINTS) {
    const at = head.lastIndexOf('-');

    head =
      at > 0 ? head.slice(0, at) : [...head].slice(0, SLUG_MAX_CODE_POINTS - tail.length).join('');
  }

  return head + tail;
};

/** The slug after `current` clashed with something else: `-2`, then `-3`, or null past the cap. */
export const nextSlug = (base: string, current: string): string | null => {
  let n = 1;

  for (let tried = 2; tried <= MAX_SUFFIX_TRIES + 1; tried += 1) {
    if (withSuffix(base, tried) === current) n = tried;
  }

  // A title changed since Save leaves `current` unrelated to `base`, so suffix `current` itself.
  const from = n === 1 && current !== base ? current : base;

  return n > MAX_SUFFIX_TRIES ? null : withSuffix(from, n + 1);
};

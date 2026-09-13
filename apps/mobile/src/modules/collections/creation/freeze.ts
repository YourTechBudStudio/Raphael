/**
 * Freezing a creation request, and reading one back.
 *
 * A logical attempt is defined by the bytes that were sent. The server fingerprints the request to
 * decide whether a replay is the same ask, so anything reassembled from current form state is a
 * different request carrying someone else's key. The request is therefore normalized once, at the
 * moment of freezing, and what is stored is that normalized form.
 *
 * **Frozen means never silently rewritten. It does not mean never checked.** Every stored request is
 * validated again before it is replayed, and there are two ways that can fail. It may no longer
 * decode, because a later build narrowed the contract. Or it may decode and normalize to something
 * different, because a default moved or a field changed shape. Both are refusals: the record is kept
 * and the dispatch is declined, so the person still has their input and nothing is sent under their
 * key that they did not write. Silently migrating the payload would be the one unrecoverable move.
 *
 * The representation is frozen too, because the server's fingerprint is sensitive to all of it:
 * `description` omitted, `body` omitted only when its value is exactly empty, a present body
 * carrying an explicit `markdown` format, and every materialized default written out. Whitespace the
 * person typed is theirs and survives; only the title is normalized, by the shared contract's rule.
 */

import {
  ROOT_PATH,
  decodeCreateRequest,
  inspectTitleInput,
  type CreateRequestInput,
} from '@raphael/contracts/nodes';
import { Either } from 'effect';

import type { ContainerTarget } from './types.ts';

export interface AttemptInput {
  readonly target: ContainerTarget;
  readonly title: string;
  /** Markdown source, exactly as written. */
  readonly body: string;
  readonly idempotencyKey: string;
}

export type FreezeResult =
  | { readonly ok: true; readonly request: string; readonly title: string }
  | { readonly ok: false; readonly problem: string };

export type ThawResult =
  | { readonly ok: true; readonly request: unknown }
  /** The stored request cannot be sent. The record is kept; the dispatch is not made. */
  | { readonly ok: false; readonly reason: 'undecodable' | 'normalization_changed' };

/**
 * JSON with object keys in sorted order, at every depth.
 *
 * Stored requests are compared to freshly decoded ones, and two structurally identical objects that
 * were built in a different order are the same request. Comparing their default serializations would
 * report a difference that does not exist and refuse a perfectly good attempt.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);

  return `{${entries.join(',')}}`;
};

/** The one place a target becomes a wire selector. The root is a scope, and only areas live there. */
const selectorFor = (target: ContainerTarget): CreateRequestInput['parent'] =>
  target.parentAreaId === null ? { path: ROOT_PATH } : { id: target.parentAreaId };

export const EMPTY_TITLE_PROBLEM = 'Give it a title.';

/**
 * Build the request for one attempt and normalize it.
 *
 * Local decoding is not a second authority - the server still decides - it is the same schema
 * applied early, so an impossible request fails with a sentence naming the field instead of a round
 * trip. A title the contract will refuse is refused here, before anything is persisted or sent.
 */
export const freezeRequest = (input: AttemptInput): FreezeResult => {
  const title = input.title.trim();
  const rejection = inspectTitleInput(title);

  if (rejection !== undefined) {
    return {
      ok: false,
      problem:
        rejection.reason === 'title_too_long'
          ? 'That title is too long. Shorten it and save again.'
          : EMPTY_TITLE_PROBLEM,
    };
  }

  const request: CreateRequestInput = {
    type: input.target.type,
    parent: selectorFor(input.target),
    title,
    // The body is omitted only when there is nothing at all. Whitespace someone typed is content,
    // and trimming it here would quietly change what they wrote on the way to the server.
    ...(input.body === '' ? {} : { body: { format: 'markdown' as const, value: input.body } }),
    idempotencyKey: input.idempotencyKey,
    // Written out rather than left to the schema's default, so the stored request says what it
    // asked for instead of depending on what this build's default happened to be.
    format: 'markdown' as const,
  };

  const decoded = decodeCreateRequest(request);

  if (Either.isLeft(decoded)) {
    return { ok: false, problem: 'Raphael could not prepare that request. Check the title.' };
  }

  return { ok: true, request: canonicalJson(decoded.right), title };
};

/**
 * Read a stored request back, refusing anything this build would change.
 *
 * The comparison is the point. A stored request that still decodes but normalizes differently would
 * be sent as something other than what was frozen, under a key the server already associates with
 * the original - which is precisely the conflict the freezing exists to avoid.
 */
export const thawRequest = (stored: string): ThawResult => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stored);
  } catch {
    return { ok: false, reason: 'undecodable' };
  }

  const decoded = decodeCreateRequest(parsed);

  if (Either.isLeft(decoded)) return { ok: false, reason: 'undecodable' };

  if (canonicalJson(decoded.right) !== canonicalJson(parsed)) {
    return { ok: false, reason: 'normalization_changed' };
  }

  return { ok: true, request: decoded.right };
};

/** What was authored, read back out of a stored request. */
export interface RecoveredInput {
  readonly title: string;
  readonly body: string;
  /**
   * False when the stored request could not be read well enough to be sure the body is complete.
   *
   * The caller must not treat such a record as replaceable: deleting it would throw away the only
   * copy of something this build could not fully recover.
   */
  readonly complete: boolean;
}

/**
 * Recover the authored title and body from a stored request.
 *
 * Two readings, in order. A request that still decodes gives the authored values exactly, which is
 * the ordinary case. One that does not is read leniently instead - `JSON.parse` is not the contract
 * decoder, and a body this build can no longer validate is still a body the person wrote, so
 * showing it back to them is strictly better than showing them nothing. That reading is marked
 * incomplete, because "we read what we could" must not be mistaken for "we read it all".
 *
 * The column title is the last resort. It is written once at freeze time and never updated, which
 * is exactly why it survives a contract change that the request does not.
 */
export const recoverInput = (stored: string, fallbackTitle: string): RecoveredInput => {
  const thawed = thawRequest(stored);

  if (thawed.ok) {
    const request = thawed.request as {
      readonly title?: unknown;
      readonly body?: { readonly value?: unknown };
    };

    return {
      title: typeof request.title === 'string' ? request.title : fallbackTitle,
      body: typeof request.body?.value === 'string' ? request.body.value : '',
      complete: true,
    };
  }

  try {
    const parsed = JSON.parse(stored) as {
      readonly title?: unknown;
      readonly body?: { readonly value?: unknown };
    };
    const body = parsed.body?.value;

    return {
      title: typeof parsed.title === 'string' ? parsed.title : fallbackTitle,
      body: typeof body === 'string' ? body : '',
      // A lenient read cannot establish that it saw everything, whether or not it found a body.
      complete: false,
    };
  } catch {
    return { title: fallbackTitle, body: '', complete: false };
  }
};

export const UNUSABLE_PAYLOAD_MESSAGE =
  'This attempt was saved by a different version of Raphael and cannot be sent again. Your title and notes are kept below.';

/**
 * Freezing a note request, and reading one back.
 *
 * A logical attempt is defined by the bytes that were sent. The server fingerprints the request to
 * decide whether a replay is the same ask, so anything reassembled from current form state is a
 * different request carrying someone else's key. The request is normalized once, at the moment of
 * freezing, and what is stored is that normalized form.
 *
 * **Frozen means never silently rewritten. It does not mean never checked.** Every stored request is
 * validated again before it is replayed, and there are two ways that can fail: it may no longer
 * decode, because a later build narrowed the contract, or it may decode and normalize to something
 * different, because a default moved. Both are refusals - the record is kept and the dispatch is
 * declined - because silently migrating the payload is the one unrecoverable move.
 */

import {
  TAGS_MAX_COUNT,
  decodeCreateRequest,
  inspectTagsInput,
  inspectTitleInput,
  type CreateRequestInput,
  type TipTapDocumentTransport,
} from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { hasLineBreak } from './title.ts';
import type { Destination } from './types.ts';

export interface FreezeInput {
  readonly destination: Destination;
  /** '' when the person wrote none. Whitespace-only counts as none. */
  readonly title: string;
  readonly description: string;
  /** The accepted canonical snapshot. */
  readonly document: unknown;
  /** Normalized by whoever accepted them. Sent as given, empty or not. */
  readonly tags: readonly string[];
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
 * Stored requests are compared with freshly decoded ones, and two structurally identical objects
 * built in a different order are the same request. Comparing their default serializations would
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

export const TITLE_TOO_LONG_PROBLEM = 'That title is too long. Shorten it and save again.';
export const MULTILINE_TITLE_PROBLEM =
  'A note title is one line. Remove the line break from the title and save again.';
export const UNPREPARABLE_PROBLEM =
  'Raphael could not prepare that request, so nothing was sent. Your note is kept on this phone.';
export const TOO_MANY_TAGS_PROBLEM = `A note can have at most ${String(TAGS_MAX_COUNT)} tags. Remove some in Details and save again.`;
export const TAG_TOO_LONG_PROBLEM =
  'One of those tags is too long. Shorten it in Details and save again.';

/**
 * Build the request for one note and normalize it.
 *
 * Five decisions, each answering a question the container path never had:
 *
 * **The title is omitted, never trimmed into existence.** Whitespace-only input is an omitted title,
 * so core resolves one from the content; a title that was written is sent exactly as typed, and core
 * applies the trim it applies to everything. No first-line derivation exists anywhere on the client.
 *
 * **The body is always present**, even when it is the canonical empty document. Omitting it would be
 * equivalent on the server but would make the frozen request depend on a client-side emptiness test,
 * and the frozen request should say what it asked for.
 *
 * **`format: 'tiptap'` is explicit in both directions.** The submitted body is TipTap because that is
 * what the editor produced and what core validates without conversion; the returned body is TipTap so
 * an acknowledgement can seed the note's detail cache without a second request.
 *
 * **`tags` is always present**, for the same reason the body is. An empty list omitted and an empty
 * list sent are equivalent on the server, but choosing between them would make the frozen bytes depend
 * on a client-side emptiness test - and two drafts that are the same draft would freeze to two
 * different requests, under two different fingerprints. `tags: []` says what it asked for.
 *
 * **The parent is always `{ id }`**, never a path. Mobile holds a stable reference, and a path would
 * be a second address that can go stale.
 *
 * And two named refusals, because a generic one is a dead end. **A tag list this build would refuse
 * is named before the decode**, the way the title is: the decoder's own message carries the submitted
 * value so it can never be shown, and "Raphael could not prepare that request" over a tag someone can
 * see on screen leaves them pressing Save forever with nothing pointing at the cause. `inspectTagsInput`
 * is the decoder's own rule asked as a question, so the bounds stay the contract's; only the sentence
 * is this app's, and it names the same mistake the editor's `refusedStatus` names when the server
 * refuses it there.
 *
 * **A title carrying a line break is declined, not repaired.** The composer
 * normalizes one to a space as it is typed or pasted, which is where a person can still see it
 * happen. Anything that reaches here with a break came from somewhere else - a recovered draft
 * written by an older build, or a caller bypassing the field - and rewriting it at this boundary
 * would mean the frozen bytes are not the ones anyone approved, under a key the server may replay.
 */
export const freezeNoteRequest = (input: FreezeInput): FreezeResult => {
  const titled = input.title.trim().length > 0;

  // Asked before the contract's own checks, because those would accept it: `TitleInput` bounds the
  // length and refuses an empty title, and says nothing about lines.
  if (hasLineBreak(input.title)) return { ok: false, problem: MULTILINE_TITLE_PROBLEM };

  if (titled) {
    const rejection = inspectTitleInput(input.title);

    if (rejection !== undefined) {
      return {
        ok: false,
        problem:
          rejection.reason === 'title_too_long' ? TITLE_TOO_LONG_PROBLEM : UNPREPARABLE_PROBLEM,
      };
    }
  }

  // The two a person can reach from the details sheet, which bounds nothing on purpose - the
  // contract is the authority for the numbers. An empty or repeated tag cannot arrive from there, so
  // it falls through to the generic problem, exactly as a title with a line break does.
  const tagRejection = inspectTagsInput(input.tags);

  if (tagRejection !== undefined) {
    if (tagRejection.reason === 'tags_too_many') {
      return { ok: false, problem: TOO_MANY_TAGS_PROBLEM };
    }
    if (tagRejection.reason === 'tag_too_long') {
      return { ok: false, problem: TAG_TOO_LONG_PROBLEM };
    }

    return { ok: false, problem: UNPREPARABLE_PROBLEM };
  }

  const request: CreateRequestInput = {
    type: 'resource',
    kind: 'note',
    parent: { id: input.destination.id },
    ...(titled ? { title: input.title } : {}),
    // Only an entirely absent description is omitted. Whitespace someone typed is content, and
    // trimming it here would quietly change what they wrote on the way to the server.
    ...(input.description === '' ? {} : { description: input.description }),
    // The accepted snapshot is a document the editor canonicalized and the host structurally
    // validated; the decode immediately below is what proves it, so the assertion is checked at
    // runtime one line later rather than trusted.
    body: { format: 'tiptap' as const, value: input.document as TipTapDocumentTransport },
    tags: input.tags,
    idempotencyKey: input.idempotencyKey,
    // Written out rather than left to the schema's default, so the stored request says what it asked
    // for instead of depending on what this build's default happened to be.
    format: 'tiptap' as const,
  };

  const decoded = decodeCreateRequest(request);

  if (Either.isLeft(decoded)) return { ok: false, problem: UNPREPARABLE_PROBLEM };

  return {
    ok: true,
    request: canonicalJson(decoded.right),
    // The recovery label, written once beside the request and never updated. Empty is honest: it
    // records that no title was submitted, and it is never authority for the one core resolved.
    title: titled ? input.title : '',
  };
};

/**
 * Read a stored request back, refusing anything this build would change.
 *
 * The comparison is the point. A stored request that still decodes but normalizes differently would
 * be sent as something other than what was frozen, under a key the server already associates with
 * the original - precisely the conflict freezing exists to avoid.
 */
export const thawNoteRequest = (stored: string): ThawResult => {
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
export interface RecoveredNote {
  readonly title: string;
  readonly description: string;
  /** The submitted tags. Empty where the stored request named none, or named none readably. */
  readonly tags: readonly string[];
  /** The submitted document, or null when it could not be read out at all. */
  readonly document: unknown;
  /**
   * False when the stored request could not be read well enough to be sure this is all of it.
   *
   * A caller must not treat such a record as replaceable: deleting it would throw away the only copy
   * of something this build could not fully recover.
   */
  readonly complete: boolean;
}

/**
 * Recover what was submitted from a stored request.
 *
 * Two readings, in order. A request that still decodes gives the authored values exactly. One that
 * does not is read leniently instead - `JSON.parse` is not the contract decoder, and a body this
 * build can no longer validate is still a body the person wrote, so showing it back is strictly
 * better than showing nothing. That reading is marked incomplete, because "we read what we could"
 * must not be mistaken for "we read it all". Nothing here rewrites the stored bytes.
 *
 * The column title is the last resort. It is written once at freeze time and never updated, which is
 * exactly why it survives a contract change that the request does not.
 */
export const recoverNoteInput = (stored: string, fallbackTitle: string): RecoveredNote => {
  const read = (value: unknown, complete: boolean): RecoveredNote => {
    const request = value as {
      readonly title?: unknown;
      readonly description?: unknown;
      readonly tags?: unknown;
      readonly body?: { readonly value?: unknown };
    };
    const tags = request.tags;

    return {
      title: typeof request.title === 'string' ? request.title : fallbackTitle,
      description: typeof request.description === 'string' ? request.description : '',
      // A request frozen before tags existed has none, which is the same answer as a request that
      // asked for none. Neither is a failure to read it, so neither marks the reading incomplete.
      tags:
        Array.isArray(tags) && tags.every((tag) => typeof tag === 'string')
          ? (tags as readonly string[])
          : [],
      document: request.body?.value ?? null,
      complete,
    };
  };

  const thawed = thawNoteRequest(stored);

  if (thawed.ok) return read(thawed.request, true);

  try {
    return read(JSON.parse(stored), false);
  } catch {
    return { title: fallbackTitle, description: '', tags: [], document: null, complete: false };
  }
};

export const UNUSABLE_PAYLOAD_MESSAGE =
  'This request was saved by a different version of Raphael and cannot be sent again. What you wrote is kept on this phone.';

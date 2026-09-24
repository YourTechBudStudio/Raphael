import type { ContentFailure } from '@raphael/content';
import type { ApiErrorCode, JsonObject } from '@raphael/contracts';
import type { RequestField } from '@raphael/contracts/nodes';
import { Data } from 'effect';

import type { NodeType } from './types.ts';

/**
 * The expected failures of the node operations, and the single place where any of them becomes
 * something a caller may see.
 *
 * Two properties matter more than the shapes themselves.
 *
 * First, every class carries a fixed API error code, so the transport translates a tag into a status
 * rather than re-deciding what a failure means. Second, the public projection is explicit: it is
 * built field by field in `toPublicError`, never by serializing an error instance. That is not
 * defensive style. `JSON.stringify` on a tagged error includes every property it carries, a retained
 * cause included, so an error instance is not a wire value and must never be treated as one.
 *
 * `unauthorized` and `payload_too_large` are deliberately absent: they belong to the transport, which
 * rejects a request before any operation here runs.
 */

/** Structured reasons a caller can act on. Anything without a deliberate reason is `invalid`. */
export type InvalidInputReason =
  | 'invalid'
  | 'title_required'
  | 'title_too_long'
  | 'slug_underivable'
  | 'slug_too_long'
  | 'tags_too_many'
  | 'active_requires_project'
  | 'query_malformed'
  | 'query_too_long'
  | 'query_too_many_terms'
  | 'filter_unsupported';

/**
 * The request fields an operation can name in a failure.
 *
 * The vocabulary itself lives in `@raphael/contracts/nodes`, because both sides need the same list:
 * this module produces the names, and a client validates a received `details.field` against a closed
 * set before showing it to anyone. Re-exported here so callers of this capability keep one import.
 */
export type { RequestField };

export class InvalidInput extends Data.TaggedError('InvalidInput')<{
  readonly field?: RequestField;
  readonly reason: InvalidInputReason;
  /** The bound that was exceeded, when the reason is a limit. */
  readonly limit?: number;
}> {}

/** The request fields a selector can be named under when it does not resolve. */
export type SelectorField = 'target' | 'parent' | 'scopes' | 'destination';

/**
 * `index` is the position of the offending element in a submitted list, and is present only for a
 * field that *is* a list - `scopes` today. A position is not content: it says which of the caller's
 * own entries was at fault without repeating any of them, which is the one thing that makes a refused
 * multi-scope request actionable rather than merely refused.
 */
export class NodeNotFound extends Data.TaggedError('NodeNotFound')<{
  readonly field: SelectorField;
  readonly index?: number;
}> {}

/**
 * A parent that cannot hold this entity, for one of two reasons under one code.
 *
 * `parentage` is the product type rule (`root -> area`, ...): `parentType` is the type that cannot hold
 * the requested child, and `root` is the virtual root. `cycle` is a move destination that is the
 * target or lies inside it; the types may be perfectly legal, and the useful truth is "you cannot
 * move something inside itself". Both types are always published, because a cycle's parent has a real
 * type and one detail shape is simpler than an optional one. `field` is the request field that named
 * the parent.
 */
export class InvalidParent extends Data.TaggedError('InvalidParent')<{
  readonly field: 'parent' | 'destination';
  readonly reason: 'parentage' | 'cycle';
  readonly parentType: NodeType | 'root';
  readonly childType: NodeType;
}> {}

/**
 * An address that is already taken. `field` says which input to change: `slug` for an address the
 * write would have produced - submitted or retained - and `destination` for a move whose destination
 * path already names a resource.
 */
export class SlugConflict extends Data.TaggedError('SlugConflict')<{
  readonly field: 'slug' | 'destination';
  readonly slug: string;
  readonly scope: 'root' | 'sibling';
}> {}

export class IdempotencyConflict extends Data.TaggedError('IdempotencyConflict')<{
  readonly reason: 'different_input';
}> {}

/**
 * A write that named a revision the row is not at.
 *
 * `current` is published deliberately: it is not a diagnostic but the one fact a caller needs in order
 * to recover, since the only way forward is to re-read the entity and rebuild the change against what
 * is actually stored. It is a revision number, not content, so it discloses nothing.
 */
export class RevisionConflict extends Data.TaggedError('RevisionConflict')<{
  /** The revision the row holds now. */
  readonly current: number;
}> {}

/** A failure converting or validating *submitted* content. Stored content is never this error. */
export class UnsupportedContent extends Data.TaggedError('UnsupportedContent')<{
  readonly failure: ContentFailure;
}> {}

export class StorageBusy extends Data.TaggedError('StorageBusy')<{
  readonly operation: string;
}> {}

/**
 * Anything we did not expect, and every integrity violation in data we wrote ourselves.
 *
 * `detail` is our own sanitized words and is safe to surface in an operator-facing log. `cause` is
 * retained only for genuinely unexpected failures, because a driver error is often the only thing
 * that explains the bug - and it can carry SQL text and bound parameters, which is exactly why it is
 * excluded from the public projection and why no routine log may print it.
 */
export class InternalFailure extends Data.TaggedError('InternalFailure')<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export type NodeError =
  | InvalidInput
  | NodeNotFound
  | InvalidParent
  | SlugConflict
  | IdempotencyConflict
  | RevisionConflict
  | UnsupportedContent
  | StorageBusy
  | InternalFailure;

export interface PublicApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details: JsonObject;
}

const withoutUndefined = (entries: Record<string, unknown>): JsonObject => {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) details[key] = value;
  }
  return details as JsonObject;
};

const INVALID_INPUT_MESSAGES: Readonly<Record<InvalidInputReason, string>> = {
  invalid: 'The request was not valid.',
  title_required: 'A title is required.',
  title_too_long: 'The title is longer than the limit.',
  slug_underivable: 'No address could be derived from this title.',
  slug_too_long: 'The address is longer than the limit.',
  tags_too_many: 'Too many tags.',
  active_requires_project: 'Only a project can be marked active.',
  query_malformed: 'The search query is not well formed.',
  query_too_long: 'The search query is longer than the limit.',
  query_too_many_terms: 'The search query has more terms than the limit.',
  filter_unsupported: 'The filter uses a key or operator that is not supported.',
};

/**
 * The complete public projection. Every field is chosen here; nothing is spread from an error
 * instance, so a field added to an error for diagnostic purposes cannot reach a caller by accident.
 */
export const toPublicError = (error: NodeError): PublicApiError => {
  switch (error._tag) {
    case 'InvalidInput':
      return {
        code: 'invalid_input',
        message: INVALID_INPUT_MESSAGES[error.reason],
        details: withoutUndefined({
          field: error.field,
          reason: error.reason,
          limit: error.limit,
        }),
      };
    case 'NodeNotFound':
      return {
        code: 'node_not_found',
        message: 'No entity exists at that address.',
        details: withoutUndefined({ field: error.field, index: error.index }),
      };
    case 'InvalidParent':
      return {
        code: 'invalid_parent',
        message:
          error.reason === 'cycle'
            ? 'Something cannot be moved inside itself.'
            : error.parentType === 'root'
              ? 'Only areas can exist at the root.'
              : error.parentType === 'resource'
                ? 'A note holds nothing, so it cannot be a parent.'
                : 'That parent cannot contain this kind of entity.',
        details: {
          field: error.field,
          reason: error.reason,
          parentType: error.parentType,
          childType: error.childType,
        },
      };
    case 'SlugConflict':
      return {
        code: 'slug_conflict',
        message: 'Something here already uses that address.',
        details: { field: error.field, slug: error.slug, scope: error.scope },
      };
    case 'IdempotencyConflict':
      return {
        code: 'idempotency_conflict',
        message: 'That idempotency key was already used for a different request.',
        details: { field: 'idempotencyKey', reason: error.reason },
      };
    case 'RevisionConflict':
      return {
        code: 'revision_conflict',
        message: 'This has changed since that revision was read.',
        details: { field: 'revision', currentRevision: error.current },
      };
    case 'UnsupportedContent':
      return {
        code: 'unsupported_content',
        message: 'The submitted body is not supported.',
        details: withoutUndefined({
          field: 'body',
          reason: error.failure.reason,
          path: [...error.failure.path],
          element: error.failure.element,
          limit: error.failure.limit,
        }),
      };
    case 'StorageBusy':
      return {
        code: 'storage_busy',
        message: 'Storage was busy. The request was not applied; try again.',
        details: {},
      };
    case 'InternalFailure':
      // Neither `detail` nor `cause` is published. The operator reads those; the caller learns only
      // that the request failed for a reason that is ours to fix.
      return {
        code: 'internal_error',
        message: 'The request could not be completed.',
        details: {},
      };
  }
};

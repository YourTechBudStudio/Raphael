import type { ContentFailure } from '@raphael/content';
import type { ApiErrorCode, JsonObject } from '@raphael/contracts';
import type { RequestField } from '@raphael/contracts/nodes';
import { Data } from 'effect';

import type { NodeType, StoredNodeType } from './types.ts';

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
  | 'unsupported_node_type';

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
  /** The stored type a selector reached, when the reason is `unsupported_node_type`. */
  readonly nodeType?: StoredNodeType;
}> {}

export class NodeNotFound extends Data.TaggedError('NodeNotFound')<{
  readonly field: 'target' | 'parent';
}> {}

/**
 * Parentage is a product rule, not a schema accident, so the reason says which rule was broken.
 * `parent_type` is the type that cannot hold the requested child; `root` is the virtual root.
 */
export class InvalidParent extends Data.TaggedError('InvalidParent')<{
  readonly parentType: StoredNodeType | 'root';
  readonly childType: NodeType;
}> {}

export class SlugConflict extends Data.TaggedError('SlugConflict')<{
  readonly slug: string;
  readonly scope: 'root' | 'sibling';
}> {}

export class IdempotencyConflict extends Data.TaggedError('IdempotencyConflict')<{
  readonly reason: 'different_input';
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
  slug_too_long: 'The address derived from this title is longer than the limit.',
  unsupported_node_type: 'That entity is not one this release can return.',
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
          nodeType: error.nodeType,
        }),
      };
    case 'NodeNotFound':
      return {
        code: 'node_not_found',
        message: 'No entity exists at that address.',
        details: { field: error.field },
      };
    case 'InvalidParent':
      return {
        code: 'invalid_parent',
        message:
          error.parentType === 'root'
            ? 'Only areas can exist at the root.'
            : 'That parent cannot contain this kind of entity.',
        details: { field: 'parent', parentType: error.parentType, childType: error.childType },
      };
    case 'SlugConflict':
      return {
        code: 'slug_conflict',
        message: 'Something here already uses that address.',
        details: { field: 'slug', slug: error.slug, scope: error.scope },
      };
    case 'IdempotencyConflict':
      return {
        code: 'idempotency_conflict',
        message: 'That idempotency key was already used for a different request.',
        details: { field: 'idempotencyKey', reason: error.reason },
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

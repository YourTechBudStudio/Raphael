import { describeContentFailure, type ContentFailure } from '@raphael/content';
import type { ApiErrorCode } from '@raphael/contracts';
import { Data } from 'effect';

import type { NodeType } from './types.ts';

/**
 * The expected failures of the node operations, and the single place where any of them becomes
 * something a caller may see.
 *
 * Every class carries a fixed API error code, and the public projection is built field by field in
 * `toPublicError`, never by serializing an error instance, so a retained cause cannot leak. Messages
 * are shown to people as they are, so each one explains itself without repeating note content.
 */

export type InvalidInputReason =
  | 'invalid'
  | 'title_required'
  | 'title_too_long'
  | 'slug_too_long'
  | 'active_requires_project'
  | 'favorite_requires_container'
  | 'query_malformed'
  | 'query_too_long'
  | 'query_too_many_terms'
  | 'filter_unsupported';

/** Request fields a failure may name. Our own vocabulary, so naming one discloses nothing submitted. */
export const REQUEST_FIELDS = [
  'type',
  'kind',
  'parent',
  'target',
  'revision',
  'destination',
  'title',
  'slug',
  'description',
  'body',
  'tags',
  'active',
  'metadata',
  'format',
  'recursive',
  'scopes',
  'filter',
  'queries',
  'skip',
  'limit',
  'orderBy',
  'includeArchived',
] as const;

export type RequestField = (typeof REQUEST_FIELDS)[number];

export const isRequestField = (value: unknown): value is RequestField =>
  (REQUEST_FIELDS as readonly unknown[]).includes(value);

export class InvalidInput extends Data.TaggedError('InvalidInput')<{
  readonly field?: RequestField;
  readonly reason: InvalidInputReason;
  /** The bound that was exceeded, when the reason is a limit. */
  readonly limit?: number;
}> {}

/** The request fields a selector can be named under when it does not resolve. */
export type SelectorField = 'target' | 'parent' | 'scopes' | 'destination';

/** `index` is the position of the offending entry, for a field that is a list (`scopes`). */
export class NodeNotFound extends Data.TaggedError('NodeNotFound')<{
  readonly field: SelectorField;
  readonly index?: number;
}> {}

/**
 * A parent that cannot hold this entity: the type rule (`parentage`, where `root` is the virtual
 * root), or a move destination inside the target (`cycle`).
 */
export class InvalidParent extends Data.TaggedError('InvalidParent')<{
  readonly field: 'parent' | 'destination';
  readonly reason: 'parentage' | 'cycle';
  readonly parentType: NodeType | 'root';
  readonly childType: NodeType;
}> {}

/** An address that is already taken, by the slug the write would have produced. */
export class SlugConflict extends Data.TaggedError('SlugConflict')<{
  readonly field: 'slug' | 'destination';
  readonly slug: string;
  readonly scope: 'root' | 'sibling';
}> {}

/** A write that named a revision the row is not at. */
export class RevisionConflict extends Data.TaggedError('RevisionConflict')<{
  /** The revision the row holds now. */
  readonly current: number;
}> {}

/**
 * A mutation that would change something archived, or put something under an archived container.
 * `standing` says whether it is archived itself (`direct`) or only through a container above it.
 * Archive and restore never raise it.
 */
export class NodeArchived extends Data.TaggedError('NodeArchived')<{
  readonly field: 'target' | 'parent' | 'destination';
  readonly standing: 'direct' | 'inherited';
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
  | RevisionConflict
  | NodeArchived
  | UnsupportedContent
  | StorageBusy
  | InternalFailure;

export interface PublicApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
}

/** Fields named in the plural, so a sentence about them agrees. */
const PLURAL_FIELDS: ReadonlySet<RequestField> = new Set(['tags', 'scopes', 'queries']);

const invalidInputMessage = ({ field, reason, limit }: InvalidInput): string => {
  switch (reason) {
    case 'invalid':
      if (field === undefined) return 'The request was not valid.';
      return `The ${field} ${PLURAL_FIELDS.has(field) ? 'are' : 'is'} not valid.`;
    case 'title_required':
      return 'Title is required.';
    case 'title_too_long':
      return `Title is longer than ${limit} characters.`;
    case 'slug_too_long':
      return `The address is longer than ${limit} characters.`;
    case 'active_requires_project':
      return 'Only a project can be marked active.';
    case 'favorite_requires_container':
      return 'Only areas and projects can be favorites.';
    case 'query_malformed':
      return 'The search query is not well formed.';
    case 'query_too_long':
      return `The search query is longer than ${limit} characters.`;
    case 'query_too_many_terms':
      return `The search query has more than ${limit} terms.`;
    case 'filter_unsupported':
      return 'The filter uses a key or operator that is not supported.';
  }
};

const notFoundMessage = ({ field, index }: NodeNotFound): string => {
  switch (field) {
    case 'target':
      return 'Nothing exists at that address.';
    case 'parent':
      return 'The parent does not exist.';
    case 'destination':
      return 'The destination does not exist.';
    case 'scopes':
      return index === undefined ? 'A scope does not exist.' : `Scope ${index + 1} does not exist.`;
  }
};

const archivedMessage = ({ field, standing }: NodeArchived): string => {
  const subject =
    field === 'target' ? 'This' : field === 'parent' ? 'The parent' : 'The destination';
  return standing === 'direct'
    ? `${subject} is archived.`
    : `${subject} is inside something archived.`;
};

/** The complete public projection. Every field is chosen here; nothing is spread from an error. */
export const toPublicError = (error: NodeError): PublicApiError => {
  switch (error._tag) {
    case 'InvalidInput':
      return { code: 'invalid_input', message: invalidInputMessage(error) };
    case 'NodeNotFound':
      return { code: 'node_not_found', message: notFoundMessage(error) };
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
                : `A ${error.parentType} cannot contain a ${error.childType === 'resource' ? 'note' : error.childType}.`,
      };
    case 'SlugConflict':
      return { code: 'slug_conflict', message: `"${error.slug}" is already used here.` };
    case 'RevisionConflict':
      return {
        code: 'revision_conflict',
        message: `This changed on the server. It is now at revision ${error.current}.`,
      };
    case 'NodeArchived':
      return { code: 'node_archived', message: archivedMessage(error) };
    case 'UnsupportedContent':
      return {
        code: 'unsupported_content',
        message: `The body is not supported: ${describeContentFailure(error.failure)}.`,
      };
    case 'StorageBusy':
      return { code: 'storage_busy', message: 'The server is busy. Try again.' };
    case 'InternalFailure':
      // Neither `detail` nor `cause` is published; the operator reads those in the log.
      return { code: 'internal_error', message: 'The server could not complete the request.' };
  }
};

import { describeContentFailure, type ContentFailure } from '@raphael/content';
import type {
  ApiErrorCode,
  ApiErrorDetails,
  InvalidInputReason as ApiInvalidInputReason,
} from '@raphael/contracts';
import { PARENTAGE, RESOURCE_KINDS } from '@raphael/contracts/nodes';
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

/** The reasons an operation can refuse its input for; the rest belong to the HTTP host. */
export type InvalidInputReason = Exclude<
  ApiInvalidInputReason,
  'malformed_json' | 'invalid_utf8' | 'incomplete_body'
>;

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

/** The item that stands in the way of a change: an archived container, or a slug's holder. */
export interface BlockingNode {
  readonly id: number;
  readonly type: NodeType;
}

/**
 * An address that is already taken, by the slug the write would have produced.
 *
 * `parentId` is where the clash happened (`null` at the root), when the operation knows it, so the
 * holder can be looked up once the write has rolled back. `holder` is that lookup's answer, or the
 * occupant itself when the operation already had it in hand.
 */
export class SlugConflict extends Data.TaggedError('SlugConflict')<{
  readonly field: 'slug' | 'destination';
  readonly slug: string;
  readonly scope: 'root' | 'sibling';
  readonly parentId?: number | null;
  readonly holder?: BlockingNode;
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
  /** The nearest archived item: the node itself when `direct`, else the container it inherits from. */
  readonly blocking?: BlockingNode;
}> {}

/** A failure converting or validating *submitted* content. Stored content is never this error. */
export class UnsupportedContent extends Data.TaggedError('UnsupportedContent')<{
  readonly failure: ContentFailure;
}> {}

/**
 * Anything unexpected. `detail` is our own words and may be logged; `cause` can carry SQL and bound
 * parameters, so it is never published or routinely logged.
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
  | InternalFailure;

export interface PublicApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: ApiErrorDetails;
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
      return `The slug is longer than ${limit} characters.`;
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

/** How a type reads in a sentence. A resource is named by its kinds. */
const nounOf = (type: NodeType): string =>
  type === 'resource' ? RESOURCE_KINDS.join(' or ') : type;

const withArticle = (word: string): string => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The containment refusal, stated from `PARENTAGE` so it changes with the rule it describes. */
const parentMessage = ({ reason, parentType, childType }: InvalidParent): string => {
  if (reason === 'cycle') return 'Something cannot be moved inside itself.';
  if (parentType === 'root') {
    const allowed = PARENTAGE.root.map((type) => `${nounOf(type)}s`).join(' and ');
    return `Only ${allowed} can exist at the root.`;
  }
  const parent = capitalized(withArticle(nounOf(parentType)));
  return PARENTAGE[parentType].length === 0
    ? `${parent} holds nothing, so it cannot be a parent.`
    : `${parent} cannot contain ${withArticle(nounOf(childType))}.`;
};

/** Drops absent members, so a projection never carries `undefined` onto the wire. */
const detailsOf = (details: ApiErrorDetails): ApiErrorDetails =>
  Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  ) as ApiErrorDetails;

/** The complete public projection. Every field is chosen here; nothing is spread from an error. */
export const toPublicError = (error: NodeError): PublicApiError => {
  switch (error._tag) {
    case 'InvalidInput':
      return {
        code: 'invalid_input',
        message: invalidInputMessage(error),
        details: detailsOf({ field: error.field, reason: error.reason, limit: error.limit }),
      };
    case 'NodeNotFound':
      return {
        code: 'node_not_found',
        message: notFoundMessage(error),
        details: detailsOf({ field: error.field, index: error.index }),
      };
    case 'InvalidParent':
      return {
        code: 'invalid_parent',
        message: parentMessage(error),
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
        message: 'That slug is already used here.',
        details: detailsOf({
          field: error.field,
          reason: error.scope,
          blocking: error.holder === undefined ? undefined : { ...error.holder },
        }),
      };
    case 'RevisionConflict':
      return {
        code: 'revision_conflict',
        message: `This changed on the server. It is now at revision ${error.current}.`,
        details: { currentRevision: error.current },
      };
    case 'NodeArchived':
      return {
        code: 'node_archived',
        message: archivedMessage(error),
        details: detailsOf({
          field: error.field,
          reason: error.standing,
          blocking: error.blocking === undefined ? undefined : { ...error.blocking },
        }),
      };
    case 'UnsupportedContent':
      return {
        code: 'unsupported_content',
        message: `The body is not supported: ${describeContentFailure(error.failure)}.`,
        details: detailsOf({
          field: 'body',
          reason: error.failure.reason,
          location: [...error.failure.path],
          element: error.failure.element,
          limit: error.failure.limit,
        }),
      };
    case 'InternalFailure':
      // Neither `detail` nor `cause` is published; the operator reads those in the log.
      return { code: 'internal_error', message: 'The server could not complete the request.' };
  }
};

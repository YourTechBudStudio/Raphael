import { Schema } from 'effect';

import { responseDecoder } from './decode.ts';

/**
 * Every error this release can produce. Unused provider codes are deliberately absent: a code exists
 * here only when something returns it. `node_archived` is here because archive and restore now exist
 * and every other mutation refuses to change something archived.
 *
 * The catalog spans two owners. Most codes are operation outcomes, produced by a capability and
 * projected from its own tagged failure. `unauthorized`, `route_not_found`, `method_not_allowed`,
 * `payload_too_large`, and `unsupported_media_type` are *transport* outcomes: the HTTP host produces
 * them from its own fields before any operation runs, and no capability failure ever projects to one.
 */
export const API_ERROR_CODES = [
  'invalid_input',
  'unauthorized',
  'node_not_found',
  'route_not_found',
  'method_not_allowed',
  'slug_conflict',
  'revision_conflict',
  'node_archived',
  'payload_too_large',
  'unsupported_media_type',
  'invalid_parent',
  'unsupported_content',
  'storage_busy',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The HTTP status the server sends for each code. Several codes share a status. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  node_not_found: 404,
  route_not_found: 404,
  method_not_allowed: 405,
  slug_conflict: 409,
  revision_conflict: 409,
  node_archived: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_parent: 422,
  unsupported_content: 422,
  storage_busy: 503,
  internal_error: 500,
};

/** The code the server is constrained to when producing an error. */
export const ApiErrorCodeSchema = Schema.Literal(...API_ERROR_CODES);

/**
 * Why an `invalid_input` failure happened. The operation reasons come from a capability's own checks;
 * `malformed_json`, `invalid_utf8`, and `incomplete_body` come from the HTTP host before any operation
 * runs. A client words each one itself, so the server's sentence never has to echo what was sent.
 */
export const INVALID_INPUT_REASONS = [
  'invalid',
  'title_required',
  'title_too_long',
  'slug_too_long',
  'active_requires_project',
  'favorite_requires_container',
  'query_malformed',
  'query_too_long',
  'query_too_many_terms',
  'filter_unsupported',
  'malformed_json',
  'invalid_utf8',
  'incomplete_body',
] as const;

export type InvalidInputReason = (typeof INVALID_INPUT_REASONS)[number];

/**
 * Why an `invalid_parent` failure happened: the containment rule (`parentage`, where `root` is the top
 * level), or a move destination inside the item being moved (`cycle`).
 */
export const INVALID_PARENT_REASONS = ['parentage', 'cycle'] as const;

export type InvalidParentReason = (typeof INVALID_PARENT_REASONS)[number];

/** Where a `slug_conflict` happened: among the top-level items (`root`), or among siblings. */
export const SLUG_CONFLICT_REASONS = ['root', 'sibling'] as const;

export type SlugConflictReason = (typeof SLUG_CONFLICT_REASONS)[number];

/**
 * Why a `node_archived` failure happened: the item concerned is archived itself (`direct`), or only
 * through a container above it (`inherited`).
 */
export const NODE_ARCHIVED_REASONS = ['direct', 'inherited'] as const;

export type NodeArchivedReason = (typeof NODE_ARCHIVED_REASONS)[number];

/** Why an `unsupported_media_type` failure happened. */
export const UNSUPPORTED_MEDIA_REASONS = [
  'unsupported_media_type',
  'unsupported_content_encoding',
  'unsupported_charset',
] as const;

export type UnsupportedMediaReason = (typeof UNSUPPORTED_MEDIA_REASONS)[number];

/**
 * Structured facts about a failure, for a client to word it itself.
 *
 * Every member is optional and each code fills only the ones it has. Values are our own vocabulary
 * or numbers and identifiers the server already holds; nothing here is text the caller submitted.
 *
 * - `field` names the request field concerned, and `index` the entry within a list field (`scopes`).
 * - `reason` is the code-specific reason: one of `INVALID_INPUT_REASONS`, a content failure reason,
 *   `INVALID_PARENT_REASONS`, `SLUG_CONFLICT_REASONS` or `NODE_ARCHIVED_REASONS`.
 * - `limit` is the bound that was exceeded.
 * - `currentRevision` is the revision the target holds now.
 * - `blocking` is the item in the way: the archived container, or the holder of a slug.
 * - `parentType` and `childType` are the two sides of a containment refusal.
 * - `location` is the child-index path inside a submitted document, and `element` names one of our own
 *   supported document elements.
 *
 * Strings are decoded as strings, not as the literals above, so a newer server's reason still reaches
 * a client that does not know it yet.
 */
export const ApiErrorDetails = Schema.Struct({
  field: Schema.optional(Schema.String),
  index: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  currentRevision: Schema.optional(Schema.Number),
  blocking: Schema.optional(Schema.Struct({ id: Schema.Number, type: Schema.String })),
  parentType: Schema.optional(Schema.String),
  childType: Schema.optional(Schema.String),
  location: Schema.optional(Schema.Array(Schema.Number)),
  element: Schema.optional(Schema.String),
});
export type ApiErrorDetails = Schema.Schema.Type<typeof ApiErrorDetails>;

/**
 * The message is shown to people as it is, so it must explain itself. It stays generic and never
 * repeats what was submitted; `details` carries the facts a client needs to say more.
 */
const errorBody = <Code extends Schema.Schema.All>(code: Code) =>
  Schema.Struct({
    error: Schema.Struct({
      code,
      message: Schema.String,
      details: Schema.optional(ApiErrorDetails),
    }),
  });

/** What the server emits: the code must come from the known catalog. */
export const ApiErrorResponse = errorBody(ApiErrorCodeSchema);
export type ApiErrorResponse = Schema.Schema.Type<typeof ApiErrorResponse>;

/** What a client decodes: any code, so a newer server's unfamiliar code still reaches the caller. */
export const ApiErrorEnvelope = errorBody(Schema.String);
export type ApiErrorEnvelope = Schema.Schema.Type<typeof ApiErrorEnvelope>;

export const decodeApiErrorEnvelope = responseDecoder(ApiErrorEnvelope);

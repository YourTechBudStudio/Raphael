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

/** The message is shown to people as it is, so it must explain itself. */
const errorBody = <Code extends Schema.Schema.All>(code: Code) =>
  Schema.Struct({ error: Schema.Struct({ code, message: Schema.String }) });

/** What the server emits: the code must come from the known catalog. */
export const ApiErrorResponse = errorBody(ApiErrorCodeSchema);
export type ApiErrorResponse = Schema.Schema.Type<typeof ApiErrorResponse>;

/** What a client decodes: any code, so a newer server's unfamiliar code still reaches the caller. */
export const ApiErrorEnvelope = errorBody(Schema.String);
export type ApiErrorEnvelope = Schema.Schema.Type<typeof ApiErrorEnvelope>;

export const decodeApiErrorEnvelope = responseDecoder(ApiErrorEnvelope);

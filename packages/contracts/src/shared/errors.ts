import { Schema } from 'effect';

import { responseDecoder } from './decode.ts';
import { JsonObjectSafe, type JsonObject } from './json.ts';

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
  'idempotency_conflict',
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

/**
 * The HTTP status the server sends for each code.
 *
 * Deliberately one-directional. Several codes share a status, so a status cannot name a code, and a
 * bare status from a proxy or middleware is not evidence that Raphael produced an envelope at all.
 * Clients classify decoded envelopes by code and treat a missing or malformed envelope as a
 * transport or protocol failure carrying the observed status.
 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  node_not_found: 404,
  route_not_found: 404,
  method_not_allowed: 405,
  slug_conflict: 409,
  idempotency_conflict: 409,
  revision_conflict: 409,
  node_archived: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_parent: 422,
  unsupported_content: 422,
  storage_busy: 503,
  internal_error: 500,
};

export const isApiErrorCode = (code: string): code is ApiErrorCode =>
  (API_ERROR_CODES as readonly string[]).includes(code);

/** The code the server is constrained to when producing an error. */
export const ApiErrorCodeSchema = Schema.Literal(...API_ERROR_CODES);

const errorBody = <Code extends Schema.Schema.All>(code: Code) =>
  Schema.Struct({
    error: Schema.Struct({
      code,
      message: Schema.String,
      /**
       * Always present, `{}` when there is no structured context. An optional field here would leave
       * every client handling two shapes, and recovery that reads a structured reason — an underivable
       * title, a conflicting slug — would have to guess whether its absence meant anything.
       */
      details: JsonObjectSafe,
    }),
  });

/** What the server emits: the code must come from the known catalog. */
export const ApiErrorResponse = errorBody(ApiErrorCodeSchema);
export type ApiErrorResponse = Schema.Schema.Type<typeof ApiErrorResponse>;

/**
 * What a client decodes: the code is any string, so a newer server's unfamiliar code produces a
 * recognizable failure instead of a decoding error that hides the server's actual answer.
 */
export const ApiErrorEnvelope = errorBody(Schema.String);
export type ApiErrorEnvelope = Schema.Schema.Type<typeof ApiErrorEnvelope>;

export const decodeApiErrorEnvelope = responseDecoder(ApiErrorEnvelope);

export interface KnownApiError {
  readonly kind: 'known';
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details: JsonObject;
}

export interface UnrecognizedApiError {
  readonly kind: 'unrecognized';
  /** The code exactly as the server sent it, so operators can see what was actually returned. */
  readonly code: string;
  readonly message: string;
  readonly details: JsonObject;
}

export type ClassifiedApiError = KnownApiError | UnrecognizedApiError;

/**
 * Classifies an already-decoded envelope. A payload that is not a well-formed envelope never reaches
 * here: that is an invalid response, which is a different failure from an unrecognized error code.
 */
export const classifyApiError = (envelope: ApiErrorEnvelope): ClassifiedApiError => {
  const { code, message, details } = envelope.error;
  return isApiErrorCode(code)
    ? { kind: 'known', code, message, details }
    : { kind: 'unrecognized', code, message, details };
};

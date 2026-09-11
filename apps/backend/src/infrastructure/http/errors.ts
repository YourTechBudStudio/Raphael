import { API_ERROR_STATUS, type ApiErrorCode, type JsonObject } from '@raphael/contracts';

/**
 * Failures the transport produces on its own, before any operation runs.
 *
 * These are built from this module's own controlled fields. They are deliberately *not* routed
 * through a capability's error projection: a capability projects its own tagged failures, and casting
 * a transport condition into that family to reuse the function would put transport vocabulary inside
 * a capability's error contract and make each one able to produce the other's codes.
 *
 * Every message here is a fixed string chosen in this file. Nothing submitted is ever reflected: not
 * a path, not a header, not a byte of a body, not a parser's complaint about one. A caller learns
 * what was wrong with the shape of their request, never what the server read out of it.
 */

export interface TransportError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details: JsonObject;
  /** Response headers this failure requires. `405` has to name what the route does accept. */
  readonly headers?: Readonly<Record<string, string>>;
}

export const unauthorized = (): TransportError => ({
  code: 'unauthorized',
  message: 'A valid API key is required.',
  details: {},
});

export const routeNotFound = (): TransportError => ({
  code: 'route_not_found',
  message: 'This server publishes no operation at that address.',
  details: {},
});

export const methodNotAllowed = (): TransportError => ({
  code: 'method_not_allowed',
  message: 'Raphael operations are invoked with POST.',
  details: { allow: 'POST' },
  headers: { Allow: 'POST' },
});

export type MediaRejection =
  | 'unsupported_media_type'
  | 'unsupported_content_encoding'
  | 'unsupported_charset';

const MEDIA_MESSAGES: Readonly<Record<MediaRejection, string>> = {
  unsupported_media_type: 'Request bodies must be application/json.',
  unsupported_content_encoding:
    'Compressed request bodies are not accepted. Send the JSON uncompressed.',
  unsupported_charset: 'Request bodies must be encoded as UTF-8.',
};

export const unsupportedMedia = (reason: MediaRejection): TransportError => ({
  code: 'unsupported_media_type',
  message: MEDIA_MESSAGES[reason],
  details: { reason },
});

export const payloadTooLarge = (limit: number): TransportError => ({
  code: 'payload_too_large',
  message: 'The request body is larger than this server accepts.',
  details: { limit },
});

/**
 * The body was received but is not a JSON document we can read.
 *
 * `malformed_json` carries no position, no fragment, and no parser message. A parse error's text
 * routinely quotes the input around the failure, which for this server means note content, so the
 * error object behind this is discarded rather than kept as a diagnostic cause.
 *
 * `invalid_utf8` is separate on purpose: bytes that are not the encoding the request declared is
 * different advice from a document that is valid UTF-8 and invalid JSON.
 */
export type BodyRejection = 'malformed_json' | 'invalid_utf8';

const BODY_MESSAGES: Readonly<Record<BodyRejection, string>> = {
  malformed_json: 'The request body is not a JSON document.',
  invalid_utf8: 'The request body is not valid UTF-8.',
};

export const invalidBody = (reason: BodyRejection): TransportError => ({
  code: 'invalid_input',
  message: BODY_MESSAGES[reason],
  details: { reason },
});

/**
 * An upload that stopped before the declared body arrived.
 *
 * Distinct from malformed JSON, and deliberately so: nothing was decided about the content, because
 * the content never finished arriving. The response is usually unobservable - the peer has already
 * gone - but the distinction is what keeps the diagnostic honest.
 */
export const incompleteRequest = (): TransportError => ({
  code: 'invalid_input',
  message: 'The request body did not finish arriving.',
  details: { reason: 'incomplete_request' },
});

/**
 * The server has begun shutting down and is no longer admitting work.
 *
 * `storage_busy` is the honest code: the request was not applied, and retrying is the right recovery.
 * It is a transport outcome rather than a capability one - no operation ran to produce it.
 */
export const notAdmitting = (): TransportError => ({
  code: 'storage_busy',
  message: 'The server is shutting down. The request was not applied; try again.',
  details: { reason: 'shutting_down' },
});

export const internalError = (): TransportError => ({
  code: 'internal_error',
  message: 'The request could not be completed.',
  details: {},
});

export const statusOf = (error: TransportError): number => API_ERROR_STATUS[error.code];

/** The wire envelope. Built field by field; no error instance is ever serialized. */
export const envelopeOf = (error: TransportError): { error: JsonObject } => ({
  error: { code: error.code, message: error.message, details: error.details },
});

/**
 * Shared contract primitives: the error envelope, the decoding policies every capability uses, the
 * bounded JSON-safety machinery, and the transport-level budgets. Capability-specific vocabulary
 * lives behind `@raphael/contracts/nodes` and `@raphael/contracts/connection`; nothing node-specific
 * belongs here.
 */
export {
  type DecodeFailure,
  type DecodeIssue,
  type DecodeResult,
  type Decoder,
  requestDecoder,
  responseDecoder,
} from './shared/decode.ts';
export {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  ApiErrorCodeSchema,
  ApiErrorEnvelope,
  ApiErrorResponse,
  type ApiErrorCode,
  type ClassifiedApiError,
  type KnownApiError,
  type UnrecognizedApiError,
  classifyApiError,
  decodeApiErrorEnvelope,
  isApiErrorCode,
} from './shared/errors.ts';
export {
  JSON_SAFETY_LIMITS,
  JsonObjectSafe,
  JsonValueSafe,
  type JsonObject,
  type JsonRejection,
  type JsonRejectionReason,
  type JsonTraversalLimits,
  type JsonValue,
  codePointLength,
  describeJsonRejection,
  inspectJsonValue,
  isJsonObject,
  isJsonValue,
  makeJsonObjectSchema,
  makeJsonValueSchema,
  utf8ByteLength,
} from './shared/json.ts';
export {
  JSON_SAFETY_MAX_DEPTH,
  JSON_SAFETY_MAX_VALUES,
  REQUEST_MAX_BYTES,
} from './shared/limits.ts';
export { NonNegativeSafeInt, PositiveSafeInt, SafeInt } from './shared/numbers.ts';
export { type RouteDescriptor } from './shared/route.ts';

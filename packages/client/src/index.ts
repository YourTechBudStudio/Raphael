/**
 * The Raphael HTTP client: one transport, shared by the CLI and the mobile app.
 *
 * Capability operations live behind `@raphael/client/nodes` and `@raphael/client/connection`. What is
 * published here is the transport itself and the vocabulary for talking about what went wrong, since
 * both of those are the same whichever capability a caller uses.
 *
 * Nothing in this package imports a Node builtin or touches a Node global, and its build configuration
 * declares no Node types, so an accidental `node:` import fails to compile rather than failing to
 * bundle later. That is what lets the same code run under the CLI and under a mobile bundler.
 */
export {
  isEndpointRejection,
  parseEndpoint,
  routeUrl,
  type Endpoint,
  type EndpointPolicy,
  type EndpointRejection,
  type EndpointRejectionReason,
} from './shared/endpoint.ts';
export {
  isUnresolved,
  type ApiErrorFailure,
  type CancelledFailure,
  type ClientFailure,
  type ClientResult,
  type FailureKind,
  type InvalidRequestFailure,
  type InvalidResponseFailure,
  type InvalidResponseReason,
  type MutationOutcome,
  type TimeoutFailure,
  type TransportFailure,
  type UnsupportedFetchFailure,
} from './shared/failure.ts';
export {
  DEFAULT_TIMEOUT_MS,
  RESPONSE_MAX_BYTES,
  createTransport,
  isTransportRejection,
  type FetchLike,
  type Transport,
  type TransportOptions,
  type TransportRejection,
} from './shared/transport.ts';

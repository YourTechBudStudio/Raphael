/**
 * Asking a server what it is: the one verification request, read for diagnosis.
 *
 * `status` reports what this finds, and a remote command whose answer could not be read asks it once
 * to explain why (see `observedTransport`). The client's `verify` judges compatibility and keeps only
 * the protocol this release speaks; diagnosis needs what the server actually said, so the request is
 * made here with the same route, decoder and status.
 */

import type { ClientFailure, Transport } from '@raphael/client';
import { API_ERROR_CODES } from '@raphael/contracts';
import {
  CONNECTION_ROUTES,
  isPrintableRelease,
  PROTOCOL_VERSION,
  decodeVerifyResponse,
  describeProtocolMismatch,
  isCompatibleProtocolVersion,
  type ReceivedProtocolVersion,
  type VerifyResponse,
} from '@raphael/contracts/connection';

/** What a server said about itself. */
export interface ServerIdentity {
  readonly protocolVersion: ReceivedProtocolVersion;
  /** Absent from a server that predates reporting it. */
  readonly raphaelVersion: string | undefined;
}

export type ServerCheck =
  | { readonly ok: true; readonly server: ServerIdentity }
  | { readonly ok: false; readonly failure: ClientFailure };

export const checkServer = async (
  transport: Transport,
  signal?: AbortSignal,
): Promise<ServerCheck> => {
  const result = await transport.invoke<VerifyResponse>({
    route: CONNECTION_ROUTES.verify,
    effect: 'read',
    body: {},
    decode: decodeVerifyResponse,
    successStatus: 200,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!result.ok) return { ok: false, failure: result.failure };
  return {
    ok: true,
    server: {
      protocolVersion: result.value.protocolVersion,
      // Informational: one that cannot be printed is treated as not reported.
      raphaelVersion:
        result.value.raphaelVersion !== undefined && isPrintableRelease(result.value.raphaelVersion)
          ? result.value.raphaelVersion
          : undefined,
    },
  };
};

/**
 * Why an answer could not be read, once the server has been asked: it speaks another protocol, or the
 * endpoint is not a Raphael server at all.
 */
export type Diagnosis =
  | {
      readonly kind: 'incompatible';
      readonly protocolVersion: ReceivedProtocolVersion;
      readonly raphaelVersion: string | undefined;
    }
  | { readonly kind: 'not_raphael' };

/**
 * Whether a failure is one that verification can explain: an answer that could not be read, a status
 * with no Raphael error, a route the server lacks, or a code this release does not know - the likeliest
 * sign of a newer server.
 */
export const isUnexplainedAnswer = (failure: ClientFailure): boolean =>
  (failure.kind === 'bad_response' && failure.code !== 'incompatible_protocol') ||
  (failure.kind === 'http' &&
    (failure.code === undefined ||
      failure.code === 'route_not_found' ||
      failure.code === 'method_not_allowed' ||
      !(API_ERROR_CODES as readonly string[]).includes(failure.code)));

/**
 * Read a verification attempt as a diagnosis, on positive evidence only.
 *
 * A server that answers with another protocol is incompatible. An endpoint is "not Raphael" only when
 * the verification route itself is missing there (404, 405, or 501 for an unhandled method) or a success came back that is not a
 * verification answer. A proxy's 5xx, a redirect, a refused header, a timeout or a rejected key says
 * nothing about what is behind it, so it explains nothing and the original failure keeps its wording.
 */
export const diagnosisOf = (check: ServerCheck): Diagnosis | undefined => {
  if (check.ok) {
    return isCompatibleProtocolVersion(check.server.protocolVersion)
      ? undefined
      : { kind: 'incompatible', ...check.server };
  }
  const { failure } = check;
  const status = failure.status ?? 0;
  // 501 is what a generic HTTP server (python -m http.server) answers to a POST it does not handle.
  const missingRoute =
    failure.kind === 'http' &&
    (status === 404 || status === 405 || status === 501) &&
    (failure.code === undefined ||
      failure.code === 'route_not_found' ||
      failure.code === 'method_not_allowed');
  const notAnAnswer =
    failure.kind === 'bad_response' &&
    failure.code !== 'incompatible_protocol' &&
    status >= 200 &&
    status < 300;
  return missingRoute || notAnAnswer ? { kind: 'not_raphael' } : undefined;
};

/**
 * Verify a server for a command that verifies it itself (`status`, `login`): the request is the
 * verification, so what it finds is recorded as the diagnosis, and a server that answers with another
 * protocol is a failure, worded from that diagnosis with both releases.
 */
export const verifyServer = async (
  session: { diagnosis: Diagnosis | undefined },
  transport: Transport,
  signal?: AbortSignal,
): Promise<ServerCheck> => {
  const check = await checkServer(transport, signal);
  session.diagnosis = diagnosisOf(check);
  if (!check.ok || session.diagnosis?.kind !== 'incompatible') return check;
  return {
    ok: false,
    failure: {
      kind: 'bad_response',
      effect: 'read',
      delivery: 'answered',
      code: 'incompatible_protocol',
      message: describeProtocolMismatch(check.server.protocolVersion),
    },
  };
};

/** Whether the server is ahead of this release, so this side is the one to update. */
export const serverIsAhead = (version: ReceivedProtocolVersion): boolean =>
  typeof version === 'string' && version > PROTOCOL_VERSION;

export { PROTOCOL_VERSION, describeProtocolMismatch };

/**
 * Ask a server whether it is a Raphael server this app can talk to.
 *
 * The key is handed to `createTransport` and captured in its closure; nothing here keeps it, logs
 * it, or puts it in a query key. Verification is a one-off action rather than a React Query cache
 * entry for the same reason - a cached credential-bearing result is a credential with a lifetime
 * nobody chose.
 *
 * What comes back is the *address and version* the server answered with, not a connection. Whether
 * a verified server becomes the connection this device uses is the transition owner's decision,
 * and it depends on whether the record can be stored, which this function knows nothing about.
 */

import { isTransportRejection, type ClientFailure } from '@raphael/client';
import { verify } from '@raphael/client/connection';

import { buildTransport } from '../../../infrastructure/api';
import { describeVerifyFailure, type SetupProblem } from '../setup';

export interface VerifiedServer {
  readonly base: string;
  readonly origin: string;
  readonly apiKey: string;
  readonly protocolVersion: number;
}

export type VerifyOutcome =
  | { readonly ok: true; readonly server: VerifiedServer }
  | { readonly ok: false; readonly problem: SetupProblem };

export const verifyConnection = async (
  endpointInput: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<VerifyOutcome> => {
  const transport = buildTransport(endpointInput.trim(), apiKey);

  // Local validation already ran, so a rejection here means the two disagree. Report it against the
  // condition it concerns rather than asserting it cannot happen.
  if (isTransportRejection(transport)) {
    const aboutKey = transport.reason === 'api_key_missing';

    return {
      ok: false,
      problem: {
        step: aboutKey ? 'key' : 'address',
        title: 'That connection cannot be used.',
        detail: transport.message,
      },
    };
  }

  const result = await verify(transport, signal);

  if (!result.ok) {
    return { ok: false, problem: describeVerifyFailure(result.failure as ClientFailure) };
  }

  return {
    ok: true,
    server: {
      base: transport.endpoint.base,
      origin: transport.endpoint.origin,
      apiKey,
      protocolVersion: result.value.protocolVersion,
    },
  };
};

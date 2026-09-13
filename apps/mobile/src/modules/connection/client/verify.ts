/**
 * Ask a server whether it is a Raphael server this app can talk to.
 *
 * The key is handed to `createTransport` and captured in its closure; nothing here keeps it, logs
 * it, or puts it in a query key. Verification is a one-off action rather than a React Query cache
 * entry for the same reason - a cached credential-bearing result is a credential with a lifetime
 * nobody chose.
 */

import {
  createTransport,
  isTransportRejection,
  type ClientFailure,
  type FetchLike,
} from '@raphael/client';
import { verify } from '@raphael/client/connection';

import { describeVerifyFailure, type SetupProblem } from '../setup';
import type { Connection } from '../state/connection';

export type VerifyOutcome =
  | { readonly ok: true; readonly connection: Connection }
  | { readonly ok: false; readonly problem: SetupProblem };

export const verifyConnection = async (
  endpointInput: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<VerifyOutcome> => {
  const transport = createTransport({
    endpoint: endpointInput.trim(),
    apiKey,
    fetch: fetch as unknown as FetchLike,
  });

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
    connection: {
      base: transport.endpoint.base,
      origin: transport.endpoint.origin,
      protocolVersion: result.value.protocolVersion,
      // Nothing writes to a keychain yet, so a connection established here lasts exactly as long
      // as the process. Saying otherwise would advertise durability the app does not have, and a
      // relaunch would then look like data loss rather than the expected return to setup. Phase 08
      // sets this from the real outcome of the secure-storage write. The saved presentation is
      // still reviewable through the development fixture, which is what it was built for.
      remembered: false,
    },
  };
};

import {
  CONNECTION_ROUTES,
  PROTOCOL_VERSION,
  decodeVerifyRequest,
  decodeVerifyResponse,
} from '@raphael/contracts/connection';
import { Effect, Either } from 'effect';

import type { OperationFailure, OperationRoute } from '../../infrastructure/http/operation.ts';

/**
 * The connection capability: one operation, which answers "is this credential good, and do we speak
 * the same protocol".
 *
 * It touches no storage. Migrations complete before the listener exists, so a database round-trip
 * here would add no information and would quietly turn a credential check into a health check that
 * nobody specified and clients would start depending on. What this establishes is exactly what setup
 * needs: the endpoint is Raphael, the key works, and the protocol matches.
 *
 * The response says nothing else. No version string, no database path, no configuration, no provider
 * settings, no counts. A verification response is shown during setup on a device the owner may not
 * fully control, and there is nothing about this server a client needs in order to proceed.
 *
 * Being trivial is not a licence to be the exception to the shared contracts. The request is decoded
 * by the same strict decoder every other operation uses - `{"unexpected":true}` is refused - and the
 * response is validated by its own decoder before it leaves.
 */

const invalidInput = (): OperationFailure => ({
  error: {
    code: 'invalid_input',
    message: 'Verification takes no input.',
    details: { reason: 'invalid' },
  },
});

const internalFailure = (detail: string): OperationFailure => ({
  error: {
    code: 'internal_error',
    message: 'The request could not be completed.',
    details: {},
  },
  diagnostic: { stage: 'connection.verify', detail },
});

export const verifyConnection = (
  request: unknown,
): Effect.Effect<{ readonly protocolVersion: number }, OperationFailure> =>
  Effect.suspend(() => {
    // The decode failure is not described beyond its reason. There is one legal request and its
    // shape is published; naming the offending property would echo submitted input for no gain.
    if (Either.isLeft(decodeVerifyRequest(request))) return Effect.fail(invalidInput());

    const response = { protocolVersion: PROTOCOL_VERSION };
    // The self-check is the same discipline every other operation follows. It is cheap here and its
    // value is that no route is exempt: a response leaves this server only after its own contract
    // has accepted it.
    if (Either.isLeft(decodeVerifyResponse(response))) {
      return Effect.fail(internalFailure('the verification response failed its own contract'));
    }
    return Effect.succeed(response);
  });

export const connectionRoutes: readonly OperationRoute[] = [
  {
    descriptor: CONNECTION_ROUTES.verify,
    label: 'connection.verify',
    successStatus: 200,
    run: verifyConnection,
  },
];

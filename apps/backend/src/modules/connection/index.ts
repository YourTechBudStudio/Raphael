import {
  CONNECTION_ROUTES,
  PROTOCOL_VERSION,
  type DateProtocolVersion,
  decodeVerifyRequest,
  decodeVerifyResponse,
} from '@raphael/contracts/connection';
import { Effect, Either } from 'effect';

import type { OperationFailure, OperationRoute } from '../../infrastructure/http/operation.ts';

/**
 * The connection capability: one operation, which answers "is this credential good, do we speak the
 * same protocol, and which release is this".
 *
 * It touches no storage. Migrations complete before requests are admitted, so a database round-trip
 * here would add no information and would quietly turn a credential check into a health check that
 * nobody specified and clients would start depending on.
 *
 * The answer carries the protocol version, which decides compatibility, and the server's release,
 * which only explains it: `raphael status` shows both so an owner told to update one side can see
 * what each side runs. Nothing else - no database path, no configuration, no provider settings, no
 * counts. Verification needs the key, so only someone who already has full access learns the release.
 *
 * Being trivial is not a licence to be the exception to the shared contracts. The request is decoded
 * by the same strict decoder every other operation uses - `{"unexpected":true}` is refused - and the
 * response is validated by its own decoder before it leaves.
 */

const invalidInput = (): OperationFailure => ({
  error: {
    code: 'invalid_input',
    message: 'Verification takes no input.',
  },
});

const internalFailure = (detail: string): OperationFailure => ({
  error: {
    code: 'internal_error',
    message: 'The server could not complete the request.',
  },
  diagnostic: { stage: 'connection.verify', detail },
});

export const verifyConnection = (
  request: unknown,
  release: string,
): Effect.Effect<
  { readonly protocolVersion: DateProtocolVersion; readonly raphaelVersion: string },
  OperationFailure
> =>
  Effect.suspend(() => {
    // The decode failure is not described beyond its reason. There is one legal request and its
    // shape is published; naming the offending property would echo submitted input for no gain.
    if (Either.isLeft(decodeVerifyRequest(request))) return Effect.fail(invalidInput());

    const response = { protocolVersion: PROTOCOL_VERSION, raphaelVersion: release };
    // The self-check is the same discipline every other operation follows. It is cheap here and its
    // value is that no route is exempt: a response leaves this server only after its own contract
    // has accepted it.
    if (Either.isLeft(decodeVerifyResponse(response))) {
      return Effect.fail(internalFailure('the verification response failed its own contract'));
    }
    return Effect.succeed(response);
  });

/** The routes, for a server running `release`. */
export const connectionRoutes = (release: string): readonly OperationRoute[] => [
  {
    descriptor: CONNECTION_ROUTES.verify,
    label: 'connection.verify',
    successStatus: 200,
    run: (request) => verifyConnection(request, release),
  },
];

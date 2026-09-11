import { Schema } from 'effect';

import { requestDecoder, responseDecoder } from '../shared/decode.ts';
import { PositiveSafeInt } from '../shared/numbers.ts';
import type { RouteDescriptor } from '../shared/route.ts';

/**
 * The protocol version this release speaks. It expresses compatibility, not the server's release
 * number: adding an optional response property does not move it, while changing what an existing
 * operation can return to a client that already exists does.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Verification carries no input, and any property is refused. The explicit key check is necessary
 * because an empty struct alone accepts whatever it is given: excess-property handling has no declared
 * field to compare against.
 */
export const VerifyRequest = Schema.Struct({}).pipe(
  Schema.filter((value) =>
    Object.keys(value).length === 0 ? true : 'verification takes no input',
  ),
);

/**
 * The version is decoded as an ordinary positive integer rather than the literal this release knows,
 * so an incompatible server produces an actionable mismatch instead of a decoding error that says
 * nothing about why setup failed. No configuration or secret is reported here.
 */
export const VerifyResponse = Schema.Struct({ protocolVersion: PositiveSafeInt });

export type VerifyRequest = Schema.Schema.Type<typeof VerifyRequest>;
export type VerifyResponse = Schema.Schema.Type<typeof VerifyResponse>;

export const decodeVerifyRequest = requestDecoder(VerifyRequest);
export const decodeVerifyResponse = responseDecoder(VerifyResponse);

export const isCompatibleProtocolVersion = (version: number): boolean =>
  version === PROTOCOL_VERSION;

/**
 * Recovery wording for a mismatch. There is no negotiation or fallback: the owner updates one side.
 * A successful check also does not license skipping response validation later, because the server can
 * be upgraded after setup.
 */
export const describeProtocolMismatch = (version: number): string =>
  version > PROTOCOL_VERSION
    ? `This server speaks protocol ${version}; this client understands ${PROTOCOL_VERSION}. Update the client.`
    : `This server speaks protocol ${version}; this client understands ${PROTOCOL_VERSION}. Update the server.`;

export const CONNECTION_ROUTES = {
  verify: { method: 'POST', path: '/api/connection/verify' },
} as const satisfies Record<string, RouteDescriptor>;

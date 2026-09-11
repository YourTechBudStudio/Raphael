import { Schema } from 'effect';

import { requestDecoder, responseDecoder } from '../shared/decode.ts';
import { isJsonObject } from '../shared/json.ts';
import { PositiveSafeInt } from '../shared/numbers.ts';
import type { RouteDescriptor } from '../shared/route.ts';

/**
 * The protocol version this release speaks. It expresses compatibility, not the server's release
 * number: adding an optional response property does not move it, while changing what an existing
 * operation can return to a client that already exists does.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Verification carries no input, and any property is refused.
 *
 * The explicit check is doing more work than it looks like. An empty struct on its own accepts almost
 * anything: excess-property handling has no declared field to compare against, so it has nothing to
 * reject, and a number, an array, or any object with no own enumerable keys all satisfy it. Measured,
 * not assumed - `42` and `[]` both decoded as valid requests before this filter existed.
 *
 * `isJsonObject` is the same predicate the rest of the contracts use for an arbitrary JSON object, so
 * "an object" means one thing across the package rather than two nearly-identical spellings.
 */
export const VerifyRequest = Schema.Struct({}).pipe(
  Schema.filter((value) => {
    if (!isJsonObject(value)) return 'verification takes a JSON object';
    return Object.keys(value).length === 0 ? true : 'verification takes no input';
  }),
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

/**
 * How a credential travels. One header, one scheme, defined once so the server, the typed client, and
 * the mobile app cannot disagree about the spelling.
 *
 * This is a contract datum, not an authentication framework: there is no negotiation, no second
 * scheme, and no alternative location. The key never appears in a URL or a query string.
 */
export const AUTHORIZATION_HEADER = 'authorization';
export const AUTHORIZATION_SCHEME = 'Bearer';

/** The exact header value a client sends. The token is used verbatim; nothing trims or re-encodes it. */
export const authorizationHeaderValue = (key: string): string => `${AUTHORIZATION_SCHEME} ${key}`;

/**
 * The floor on a configured key, in characters.
 *
 * Length is not entropy - thirty-two repeated characters satisfy this and remain weak - so this is a
 * floor that rejects obviously unusable keys, not a strength guarantee. Generate a random 32-byte
 * secret and encode it for header transport.
 */
export const API_KEY_MIN_LENGTH = 32;

export const CONNECTION_ROUTES = {
  verify: { method: 'POST', path: '/api/connection/verify' },
} as const satisfies Record<string, RouteDescriptor>;

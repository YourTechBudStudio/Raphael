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
 *
 * "Raphael here" rather than "the client": this sentence is read on a phone as often as in a
 * terminal, and someone holding a phone does not think of it as a client.
 */
export const describeProtocolMismatch = (version: number): string =>
  version > PROTOCOL_VERSION
    ? `This server speaks protocol ${version}; Raphael here understands ${PROTOCOL_VERSION}. Update Raphael here.`
    : `This server speaks protocol ${version}; Raphael here understands ${PROTOCOL_VERSION}. Update the server.`;

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
 * The only thing Raphael asks of an API key: that there is one.
 *
 * There is deliberately no length floor, no character set, and no shape. The key is whatever the
 * owner configured their server with, and this is a single-owner product where that is their call.
 *
 * One consequence is worth knowing rather than guarding against. An HTTP header carries bytes, and
 * Node exposes a received header value as Latin-1 text, so a key containing any character above
 * U+007F is hashed from its UTF-8 string, arrives as those bytes reinterpreted one per character,
 * and never matches - measured in phase 05 for both an emoji key and a Latin-1-range key. A
 * well-behaved client cannot even send one: `fetch` refuses a header value outside Latin-1
 * outright. Such a key will fail as a transport error at the first request rather than as a setup
 * refusal. That is the accepted cost of not policing the value.
 *
 * Empty is not a restriction on what a key may be - it is the absence of one, which every caller
 * has to handle anyway.
 */
export const hasApiKey = (key: string): boolean => key !== '';

export const CONNECTION_ROUTES = {
  verify: { method: 'POST', path: '/api/connection/verify' },
} as const satisfies Record<string, RouteDescriptor>;

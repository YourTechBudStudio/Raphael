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

/**
 * The characters a key may contain: visible ASCII, from `!` through `~`.
 *
 * This is stricter than "no whitespace" for a measured reason. An HTTP header carries *bytes*, and
 * Node exposes a received header value as Latin-1 text. A key containing any character above U+007F
 * is hashed from its UTF-8 string, arrives as those bytes reinterpreted one-per-character, and never
 * matches - measured during phase 05 for both an emoji key and a Latin-1-range key. A well-behaved
 * client cannot even send one: `fetch` refuses a header value outside Latin-1 outright.
 *
 * So a non-ASCII key is not a key that behaves differently. It is a key that can never authenticate,
 * on a server that started and reported itself configured. Space and every control character are
 * excluded by the same range.
 */
const USABLE_KEY = /^[\u0021-\u007e]+$/u;

/**
 * Why a key is unusable. A reason, never the key: the caller chooses wording appropriate to where the
 * key came from - a server's environment variable, a login prompt, a mobile setup screen - and this
 * function has no idea which of those it is being asked from.
 */
export type ApiKeyRejectionReason = 'empty' | 'unusable_characters' | 'too_short';

export interface ApiKeyRejection {
  readonly reason: ApiKeyRejectionReason;
  /** The bound that was missed, for the reason that has one. */
  readonly limit?: number;
}

/**
 * The whole key policy, as a pure predicate: one definition for the server that refuses to start, the
 * CLI that refuses to save, and the mobile setup screen that refuses to continue.
 *
 * `undefined` means the key is usable. Hashing, comparison, storage, and prompting are all somewhere
 * else; this decides one thing and holds no secret beyond the argument it was handed.
 *
 * Length is checked in UTF-16 code units, which is unambiguous here only because the character range
 * above admits no astral character. It is a floor that rejects obviously unusable keys, not a
 * strength guarantee - 32 repeated characters satisfy it and remain weak.
 */
export const inspectApiKey = (key: string): ApiKeyRejection | undefined => {
  if (key.length === 0) return { reason: 'empty' };
  if (!USABLE_KEY.test(key)) return { reason: 'unusable_characters' };
  if (key.length < API_KEY_MIN_LENGTH) {
    return { reason: 'too_short', limit: API_KEY_MIN_LENGTH };
  }
  return undefined;
};

export const CONNECTION_ROUTES = {
  verify: { method: 'POST', path: '/api/connection/verify' },
} as const satisfies Record<string, RouteDescriptor>;

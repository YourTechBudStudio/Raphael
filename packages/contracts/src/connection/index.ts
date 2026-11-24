import { Schema } from 'effect';

import { requestDecoder, responseDecoder } from '../shared/decode.ts';
import { isJsonObject } from '../shared/json.ts';
import { PositiveSafeInt } from '../shared/numbers.ts';
import type { RouteDescriptor } from '../shared/route.ts';

/**
 * A protocol identifier, which is a calendar date: the day the protocol specification changed, not
 * the day an app was built. Two dates tell a reader which side is behind; two opaque integers say
 * only that they differ. Policy is one specification change per date, so no suffix exists.
 *
 * Validated as a real calendar date rather than merely a `YYYY-MM-DD` shape, so `2026-13-01` and
 * `2026-02-30` are refused. A valid fixed-width date also sorts lexicographically in chronological
 * order, which is what makes the directional guidance below a single comparison.
 */
const isCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return utc.toISOString().slice(0, 10) === value;
};

export const DateProtocolVersion = Schema.String.pipe(
  Schema.filter((value) =>
    isCalendarDate(value) ? true : 'a protocol version is a calendar date written YYYY-MM-DD',
  ),
);

/**
 * What a server may have answered with, which is not the same question as what this release speaks.
 *
 * A legacy positive integer is accepted so a server predating the date-based scheme still decodes
 * and can be diagnosed. It is read for diagnosis only: a number never equals the current identifier,
 * so a legacy version is never compatible.
 */
export const ReceivedProtocolVersion = Schema.Union(DateProtocolVersion, PositiveSafeInt);

export type DateProtocolVersion = Schema.Schema.Type<typeof DateProtocolVersion>;
export type ReceivedProtocolVersion = Schema.Schema.Type<typeof ReceivedProtocolVersion>;

/**
 * The protocol version this release speaks. It expresses compatibility, not the server's release
 * number: adding an optional response property does not move it, while changing what an existing
 * operation can return to a client that already exists does.
 */
export const PROTOCOL_VERSION: DateProtocolVersion = '2026-10-23';

/**
 * Whether a release a server reported is one a client can print: 1 to 64 visible ASCII characters.
 * The response decoder accepts any string, because a release is informational and an odd one must
 * not make verification fail; a client that shows it applies this and treats anything else as
 * unknown.
 */
export const isPrintableRelease = (value: string): boolean => /^[\x21-\x7E]{1,64}$/u.test(value);

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
 * The version is decoded as any identifier a server could plausibly have sent rather than the literal
 * this release knows, so an incompatible server produces an actionable mismatch instead of a decoding
 * error that says nothing about why setup failed. No configuration or secret is reported here.
 *
 * The line between the two is deliberate. An identifier that is merely *different* decodes and is
 * explained; an identifier that is malformed - an impossible date, arbitrary text, zero, a negative,
 * a fraction, or nothing at all - is a decoding failure, because there is no honest sentence to say
 * about it.
 */
export const VerifyResponse = Schema.Struct({
  protocolVersion: ReceivedProtocolVersion,
  /**
   * The server's release, such as `0.0.1`. Optional because the protocol rule above makes optional
   * additions compatible: a server that predates it still verifies, and a client says it does not know.
   * A release is informational. Compatibility is decided by the protocol version alone.
   */
  raphaelVersion: Schema.optional(Schema.String),
});

export type VerifyRequest = Schema.Schema.Type<typeof VerifyRequest>;
export type VerifyResponse = Schema.Schema.Type<typeof VerifyResponse>;

export const decodeVerifyRequest = requestDecoder(VerifyRequest);
export const decodeVerifyResponse = responseDecoder(VerifyResponse);

export const isCompatibleProtocolVersion = (version: ReceivedProtocolVersion): boolean =>
  version === PROTOCOL_VERSION;

/**
 * Recovery wording for a mismatch. There is no negotiation or fallback: the owner updates one side.
 * A successful check also does not license skipping response validation later, because the server can
 * be upgraded after setup.
 *
 * "Raphael here" rather than "the client": this sentence is read on a phone as often as in a
 * terminal, and someone holding a phone does not think of it as a client.
 */
export const describeProtocolMismatch = (version: ReceivedProtocolVersion): string => {
  // Two validated dates compare chronologically as plain strings. A legacy number is not a date and
  // is not treated as one: everything numeric precedes the date-based scheme, so that server is
  // behind by construction.
  const serverIsAhead = typeof version === 'string' && version > PROTOCOL_VERSION;

  return serverIsAhead
    ? `This server speaks protocol ${version}; Raphael here understands ${PROTOCOL_VERSION}. Update Raphael here.`
    : `This server speaks protocol ${version}; Raphael here understands ${PROTOCOL_VERSION}. Update the server.`;
};

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
 * Whether there is a key at all. This is the transport's own minimum, which mobile relies on.
 *
 * There is no length floor and no shape: the key is whatever the owner configured their server with.
 * What a key can be sent as is a separate question, answered by `isSendableApiKey` below, which the
 * server and the CLI apply so that an unsendable key is refused where it was configured rather than
 * surfacing as a transport error at the first request.
 *
 * Empty is not a restriction on what a key may be - it is the absence of one, which every caller
 * has to handle anyway.
 */
export const hasApiKey = (key: string): boolean => key !== '';

/**
 * The longest key a client sends. Generated keys (`openssl rand -hex 32`) are 64 characters; the bound
 * keeps a mistaken paste, such as a whole file, from being accepted as a key and sent with every
 * request.
 */
export const API_KEY_MAX_LENGTH = 512;

/**
 * Whether a key can travel in the authorization header and arrive as typed: 1 to
 * `API_KEY_MAX_LENGTH` visible ASCII characters, with no whitespace anywhere.
 *
 * This is about sending, not strength. `fetch` strips leading and trailing whitespace from a header
 * value and refuses characters outside Latin-1, and a Latin-1 character above U+007F arrives as a
 * different string than the one hashed, so any key outside this set would let a server start and then
 * refuse every client. The server applies it at startup and the CLI applies it before sending, so the
 * failure names where the key came from instead of surfacing as a network error. Generated keys
 * (`openssl rand -hex 32`) are always inside it.
 */
export const isSendableApiKey = (key: string): boolean =>
  key.length <= API_KEY_MAX_LENGTH && /^[\x21-\x7E]+$/u.test(key);

/** `isSendableApiKey` in words, for help and refusals. */
export const SENDABLE_API_KEY_RULE = `1 to ${API_KEY_MAX_LENGTH} visible ASCII characters with no spaces`;

export const CONNECTION_ROUTES = {
  verify: { method: 'POST', path: '/api/connection/verify' },
} as const satisfies Record<string, RouteDescriptor>;

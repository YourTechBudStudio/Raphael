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
export const PROTOCOL_VERSION: DateProtocolVersion = '2026-09-18';

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
export const VerifyResponse = Schema.Struct({ protocolVersion: ReceivedProtocolVersion });

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

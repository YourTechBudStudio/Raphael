/**
 * What this device writes down about its server, and how it reads it back.
 *
 * One record, not three keys. An endpoint, a key, and an identity that can be written separately
 * can also be torn apart: a write that lands for the address and fails for the key leaves the
 * device holding a server it cannot authenticate against, and nothing in the app could tell that
 * from a key that was simply wrong. One value means the stored configuration is either the old one
 * or the new one.
 *
 * The version field is the first thing read and the first thing checked. A record written by a
 * later build of this app is not a corrupt record and must not be reported as one - the difference
 * matters to whoever has to decide whether to reinstall.
 *
 * Decoding is strict on purpose. Every field is checked for presence and type, and anything that
 * fails becomes "invalid", never "absent". An unreadable keychain is not an empty keychain, and
 * silently treating one as the other would send someone back through setup with no explanation and
 * quietly discard a credential that might have been recoverable.
 *
 * This file holds no React Native import, so the whole shape and its decoder run under `node --test`.
 */

/** The version this build writes. */
export const RECORD_VERSION = 1;

/**
 * Either identifier a verification could have established: today's calendar date string, or the
 * positive integer an older build of this app wrote before the identifier became a date.
 *
 * Historical either way. It records what one exchange proved at one moment and says nothing about
 * whether the server still speaks it now, which is why it is read rather than trusted, and why a
 * record written by an older build is still a perfectly good record. A stored number is read as the
 * fact it is, never rewritten in place and never converted into a date it never was; the next
 * successful verification stores the date string on its own.
 */
export type StoredProtocolVersion = string | number;

export interface ConnectionRecord {
  readonly version: number;
  /**
   * This device's stable name for the server at `base`.
   *
   * Local, and local only. It survives a key rotation against the same address, which is what lets
   * session-only content stay attached across one. It is **not** a claim about server identity:
   * replacing the database behind an unchanged address produces a different server that this
   * device has no way to notice, which is an operational limitation rather than a guarantee.
   */
  readonly connectionId: string;
  /** Origin plus any base path, no trailing slash. The address requests are built from. */
  readonly base: string;
  /** Origin alone, for display. */
  readonly origin: string;
  readonly apiKey: string;
  /** What one verification established, whenever it happened. See `StoredProtocolVersion`. */
  readonly protocolVersion: StoredProtocolVersion;
  /** When that verification happened. Also historical, and only ever shown as such. */
  readonly verifiedAt: string;
}

export type RecordProblem =
  /** Not JSON, or JSON that is not a record of this shape. */
  | 'unreadable'
  /** A well-formed record written by a version of this app that is not this one. */
  | 'unsupported_version';

export type DecodedRecord =
  | { readonly ok: true; readonly record: ConnectionRecord }
  | { readonly ok: false; readonly problem: RecordProblem };

export const encodeRecord = (record: ConnectionRecord): string => JSON.stringify(record);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

/**
 * A calendar date, checked as a date rather than as a shape, so `2026-13-01` is refused.
 *
 * Spelled out here rather than imported: this file carries no dependency beyond the standard library
 * on purpose, so the whole record and its decoder run under `node --test`. The rule it mirrors lives
 * in `@raphael/contracts/connection`, and the two are checked against each other by a test.
 */
const isCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return utc.toISOString().slice(0, 10) === value;
};

/**
 * Accepting both identifiers is a widening of what can be *read*, not a softening of the check.
 * Anything that is neither is still "unreadable", exactly as before - a malformed identifier is a
 * record this build cannot vouch for, and saying so is what keeps a credential from being silently
 * discarded.
 */
const isStoredProtocolVersion = (value: unknown): value is StoredProtocolVersion => {
  if (typeof value === 'string') return isCalendarDate(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
};

/**
 * Reads a stored record, or says exactly what is wrong with it.
 *
 * The version check runs before the field checks. A future record may legitimately carry fields
 * this build has never heard of, and reporting that as corruption would be both wrong and alarming.
 */
export const decodeRecord = (raw: string): DecodedRecord => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'unreadable' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problem: 'unreadable' };
  }

  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate['version'] !== 'number') return { ok: false, problem: 'unreadable' };
  if (candidate['version'] !== RECORD_VERSION) {
    return { ok: false, problem: 'unsupported_version' };
  }

  const { connectionId, base, origin, apiKey, protocolVersion, verifiedAt } = candidate;

  if (
    !isNonEmptyString(connectionId) ||
    !isNonEmptyString(base) ||
    !isNonEmptyString(origin) ||
    !isNonEmptyString(apiKey) ||
    !isStoredProtocolVersion(protocolVersion) ||
    !isNonEmptyString(verifiedAt)
  ) {
    return { ok: false, problem: 'unreadable' };
  }

  return {
    ok: true,
    record: {
      version: RECORD_VERSION,
      connectionId,
      base,
      origin,
      apiKey,
      protocolVersion,
      verifiedAt,
    },
  };
};

/**
 * A local identity for a server this device has not named before.
 *
 * Not a credential and never compared against anything on a server, so it does not need to be
 * unguessable - it needs to be different from the last one. `crypto.randomUUID` is not reliably
 * present on this runtime, and reaching for a polyfill to produce a value nothing verifies would
 * be ceremony; the timestamp keeps two identities minted in the same millisecond apart.
 */
export const newConnectionId = (): string =>
  `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

import { AUTHORIZATION_HEADER, AUTHORIZATION_SCHEME } from '@raphael/contracts/connection';

import type { ApiCredential } from '../config/index.ts';

/**
 * Credential checking, and nothing else.
 *
 * One header, one scheme, one key. There is no negotiation, no second location, no session, and no
 * per-client identity - a single-owner instance has exactly one credential, and this module's whole
 * job is to decide whether the request presented it.
 *
 * It runs before the body is read, before the route is matched, and before the method is judged. That
 * ordering costs an unauthenticated caller nothing to be told about: they cannot discover which
 * addresses this server publishes, and they cannot make the server buy a megabyte of parsing with an
 * unauthenticated request.
 */

export type AuthOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AuthRejection };

/**
 * Why a credential was refused. Operator-facing only: every one of these becomes the same
 * `unauthorized` envelope, because telling a caller *which* part of their credential was wrong is
 * telling them how to get closer.
 */
export type AuthRejection = 'missing' | 'ambiguous' | 'malformed' | 'mismatch';

/**
 * Every `Authorization` field a request actually carried, read from the raw header list.
 *
 * `req.headers.authorization` cannot be used for this. Node does not join repeated `Authorization`
 * fields and does not expose them as an array: it keeps **one** of them and silently discards the
 * rest - measured on this version, the first, regardless of case. So a request carrying a valid key
 * followed by a second credential would authenticate against the first and the second would never be
 * seen, while an intermediary that kept the last one would read the same request differently. That is
 * an interpretation gap at the trust boundary, and it is exactly the kind of disagreement an
 * authorization decision must not contain.
 *
 * `rawHeaders` is a flat `[name, value, name, value, …]` list of what arrived, so it is the only
 * faithful source. Field names are case-insensitive, so the comparison folds case.
 */
export const authorizationFields = (rawHeaders: readonly string[]): string[] => {
  const found: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] as string).toLowerCase() === AUTHORIZATION_HEADER) {
      found.push(rawHeaders[index + 1] as string);
    }
  }
  return found;
};

/**
 * Two credentials in one request is an ambiguous request, not a request to try each. It is refused
 * rather than resolved, in either order, however the two compare.
 */
export const authenticate = (
  header: string | string[] | undefined,
  credential: ApiCredential,
): AuthOutcome => {
  if (Array.isArray(header)) {
    if (header.length > 1) return { ok: false, reason: 'ambiguous' };
    const only = header[0];
    if (only === undefined) return { ok: false, reason: 'missing' };
    return authenticate(only, credential);
  }
  if (header === undefined) return { ok: false, reason: 'missing' };

  // One space, exactly where the scheme ends. The token is taken verbatim from there: no trimming,
  // no unquoting, no case folding. A credential is used as configured or not at all.
  const separator = header.indexOf(' ');
  if (separator === -1) return { ok: false, reason: 'malformed' };

  const scheme = header.slice(0, separator);
  // The scheme is case-insensitive per RFC 9110; the token that follows it is not.
  if (scheme.toLowerCase() !== AUTHORIZATION_SCHEME.toLowerCase()) {
    return { ok: false, reason: 'malformed' };
  }

  const token = header.slice(separator + 1);
  if (token.length === 0) return { ok: false, reason: 'malformed' };

  return credential.matches(token) ? { ok: true } : { ok: false, reason: 'mismatch' };
};

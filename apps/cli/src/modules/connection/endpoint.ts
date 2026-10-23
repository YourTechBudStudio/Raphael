/**
 * What is wrong with an address, in words that name where it came from.
 *
 * The client's own rejection sentence is written for any caller. Here the subject is known - the
 * variable, the saved file, or what was typed at `login` - and the commonest mistake for a local
 * server, a bare `host:port`, gets its fix spelled out instead of reading as an unknown scheme.
 */

import {
  isEndpointRejection,
  parseEndpoint,
  type Endpoint,
  type EndpointRejectionReason,
} from '@raphael/client';

import { forTerminal } from '../../shared/output.ts';

export interface EndpointProblem {
  readonly reason: EndpointRejectionReason;
  /** Completes "<subject> is not a usable address: …". */
  readonly why: string;
  readonly fix: string;
}

const WHY: Readonly<Record<EndpointRejectionReason, string>> = {
  malformed: 'it is not a valid URL',
  unsupported_scheme: 'Raphael speaks only http and https',
  credentials_in_url:
    'it includes a user name or password, and the key is sent as a header instead',
  query_not_allowed: 'it includes a query string',
  fragment_not_allowed: 'it includes a fragment',
};

const FIX: Readonly<Record<EndpointRejectionReason, string>> = {
  malformed: 'Give the full address, such as http://127.0.0.1:3000.',
  unsupported_scheme: 'Give an address that starts with http:// or https://.',
  credentials_in_url: 'Remove the user name and password from the address.',
  query_not_allowed: 'Remove the part of the address after "?".',
  fragment_not_allowed: 'Remove the part of the address after "#".',
};

/**
 * A rejected address as it may be shown back, or undefined when it may not be shown at all.
 *
 * A rejected address is exactly the one that may carry a password or a token, and it is malformed by
 * definition, so no parser can be trusted to find where a credential sits in it (`//user:pw@host`,
 * `http:////user:pw@host`). Rather than redact, an address is echoed only when it has none of the
 * characters that introduce userinfo, a query or a fragment; otherwise the refusal does not quote it.
 */
export const shownAddress = (input: string): string | undefined =>
  /[@?#]/u.test(input) ? undefined : forTerminal(input);

/**
 * `localhost:3105`, `127.0.0.1:3105/prefix`: a host and port with the scheme left off. Nothing that
 * could introduce a credential, so the fix can quote it.
 */
const BARE_HOST_PORT = /^[\w.-]+:\d+(\/[^@?#]*)?$/u;

/** Parse an address, or say what is wrong with it. */
export const checkEndpoint = (input: string): Endpoint | EndpointProblem => {
  const parsed = parseEndpoint(input);
  if (!isEndpointRejection(parsed)) return parsed;
  if (BARE_HOST_PORT.test(input) || !input.includes('://')) {
    return {
      reason: parsed.reason,
      why: 'it has no scheme',
      fix: BARE_HOST_PORT.test(input)
        ? `Add the scheme, as in "http://${forTerminal(input)}".`
        : FIX.malformed,
    };
  }
  return { reason: parsed.reason, why: WHY[parsed.reason], fix: FIX[parsed.reason] };
};

export const isEndpointProblem = (value: Endpoint | EndpointProblem): value is EndpointProblem =>
  'why' in value;

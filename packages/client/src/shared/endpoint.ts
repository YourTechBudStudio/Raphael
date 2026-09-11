/**
 * Where a server is, and whether it is safe to send a full-access credential there.
 *
 * The rule: HTTPS anywhere, plain HTTP only to an address that is recognizably this machine, plus one
 * narrow opt-in for the Android emulator's host alias. There is no bypass, no "private networks are
 * fine" exception, and no way to turn off certificate verification. A credential that leaves this
 * machine in the clear is disclosed, and a policy with a lever eventually gets the lever pulled.
 *
 * An endpoint may carry a base path, because terminating TLS at a reverse proxy under a prefix is an
 * ordinary deployment. Joining is string concatenation against the trimmed base, never
 * `new URL(path, base)`: relative-URL resolution discards the prefix the moment the route begins with
 * a slash, and every route here does.
 */

export type EndpointRejectionReason =
  | 'malformed'
  | 'unsupported_scheme'
  | 'credentials_in_url'
  | 'query_not_allowed'
  | 'fragment_not_allowed'
  | 'insecure_scheme';

export interface EndpointRejection {
  readonly reason: EndpointRejectionReason;
  readonly message: string;
}

export interface Endpoint {
  /** Origin plus any base path, with no trailing slash. Route paths are appended to this verbatim. */
  readonly base: string;
  /** For diagnostics and policy explanation. */
  readonly origin: string;
}

export interface EndpointPolicy {
  /**
   * Permit plain HTTP to `10.0.2.2`, the alias an Android emulator uses for its host machine.
   *
   * Deliberately this one address rather than a general "allow insecure hosts": the emulator case is
   * real and cannot be solved with TLS, and every other private address can be. The CLI never sets
   * this; only a mobile build talking to a development machine does.
   */
  readonly androidEmulatorLoopback?: boolean;
}

/**
 * Addresses that are unambiguously this machine.
 *
 * `localhost` is included by name even though a hostile resolver could point it elsewhere. Excluding
 * it would make ordinary local development impossible while doing nothing about an attacker who
 * already controls name resolution; the honest position is that this is a name-based decision and it
 * inherits whatever the resolver says.
 */
const isLoopbackHost = (hostname: string): boolean => {
  if (hostname === 'localhost') return true;
  // URL keeps IPv6 literals in brackets.
  if (hostname === '[::1]' || hostname === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4 === null) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  return octets[0] === 127;
};

const ANDROID_EMULATOR_HOST = '10.0.2.2';

const reject = (reason: EndpointRejectionReason, message: string): EndpointRejection => ({
  reason,
  message,
});

/**
 * Validate an endpoint and reduce it to the one string that requests are built from.
 *
 * Returns a rejection rather than throwing, because this runs on input a person typed at a prompt and
 * the caller has better wording for that context than a thrown error does.
 */
export const parseEndpoint = (
  input: string,
  policy: EndpointPolicy = {},
): Endpoint | EndpointRejection => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return reject(
      'malformed',
      'That is not a valid URL. Include the scheme, as in "https://raphael.example.com".',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return reject(
      'unsupported_scheme',
      `Raphael speaks HTTP and HTTPS. "${url.protocol.replace(':', '')}" is not supported.`,
    );
  }

  // Userinfo in a URL is a credential in a place that gets logged, shell-historied, and copied into
  // bug reports. Raphael's credential travels in a header and nowhere else.
  if (url.username !== '' || url.password !== '') {
    return reject(
      'credentials_in_url',
      'Remove the username and password from the address. The API key is sent as a header, not in the URL.',
    );
  }
  if (url.search !== '') {
    return reject('query_not_allowed', 'The server address must not carry a query string.');
  }
  if (url.hash !== '') {
    return reject('fragment_not_allowed', 'The server address must not carry a fragment.');
  }

  if (url.protocol === 'http:') {
    const emulator =
      policy.androidEmulatorLoopback === true && url.hostname === ANDROID_EMULATOR_HOST;
    if (!isLoopbackHost(url.hostname) && !emulator) {
      return reject(
        'insecure_scheme',
        `Plain HTTP is only allowed to this machine. "${url.hostname}" needs https, or the API key would ` +
          `travel in the clear. Terminate TLS in front of Raphael and use its https address.`,
      );
    }
  }

  // `url.pathname` is at least "/", so trimming the trailing slash leaves either "" or "/prefix".
  const path = url.pathname.replace(/\/+$/, '');
  return { base: `${url.origin}${path}`, origin: url.origin };
};

export const isEndpointRejection = (
  value: Endpoint | EndpointRejection,
): value is EndpointRejection => 'reason' in value;

/**
 * Join a validated base to a route path.
 *
 * Route paths are exact: the server matches with strict, case-sensitive routing and no aliases, so a
 * stray slash produces a 404 rather than a redirect. That is the reason this is concatenation and not
 * URL resolution.
 */
export const routeUrl = (endpoint: Endpoint, routePath: string): string =>
  `${endpoint.base}${routePath}`;

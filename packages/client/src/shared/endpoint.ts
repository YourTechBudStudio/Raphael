/**
 * Where a server is.
 *
 * HTTP and HTTPS are both accepted, to any host. This is the owner's explicit decision, and the cost
 * is worth writing down rather than discovering: over plain HTTP the full-access API key travels in
 * a header in the clear on every request, so anyone who can observe the path - another device on the
 * network, a router, an upstream hop - can read it and then has the whole second brain. Raphael does
 * not warn about this per request; the decision is made once, here.
 *
 * What is still refused is an address that cannot safely carry a credential at all: userinfo in the
 * URL, a query string, a fragment, or a scheme that is not HTTP. Those are about the address being
 * malformed for this purpose, not about transport security.
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
  | 'fragment_not_allowed';

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
export const parseEndpoint = (input: string): Endpoint | EndpointRejection => {
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

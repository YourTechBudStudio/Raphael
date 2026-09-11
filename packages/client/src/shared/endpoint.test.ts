import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isEndpointRejection, parseEndpoint, routeUrl, type Endpoint } from './endpoint.ts';

const accept = (input: string, policy = {}): Endpoint => {
  const parsed = parseEndpoint(input, policy);
  assert.equal(isEndpointRejection(parsed), false, `${input} should have been accepted`);
  return parsed as Endpoint;
};

const rejection = (input: string, policy = {}): string => {
  const parsed = parseEndpoint(input, policy);
  assert.equal(isEndpointRejection(parsed), true, `${input} should have been refused`);
  return isEndpointRejection(parsed) ? parsed.reason : '';
};

describe('endpoint scheme policy', () => {
  it('accepts https anywhere', () => {
    assert.equal(accept('https://raphael.example.com').base, 'https://raphael.example.com');
    assert.equal(accept('https://192.168.1.10:8443').base, 'https://192.168.1.10:8443');
  });

  it('accepts plain http only to this machine', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]']) {
      accept(`http://${host}:3000`);
    }
  });

  it('refuses plain http to anywhere else, private addresses included', () => {
    // A blanket "private networks are safe" exception is exactly what this does not have: a key on a
    // home or office LAN is still a key in the clear.
    for (const host of ['192.168.1.10', '10.1.2.3', '172.16.0.5', 'raphael.example.com']) {
      assert.equal(rejection(`http://${host}:3000`), 'insecure_scheme', host);
    }
  });

  it('permits the Android emulator host alias only when that opt-in is set', () => {
    assert.equal(rejection('http://10.0.2.2:3000'), 'insecure_scheme');
    accept('http://10.0.2.2:3000', { androidEmulatorLoopback: true });
  });

  it('does not let the emulator opt-in become a general insecure-host switch', () => {
    const policy = { androidEmulatorLoopback: true };
    assert.equal(rejection('http://10.0.2.3:3000', policy), 'insecure_scheme');
    assert.equal(rejection('http://10.0.0.2:3000', policy), 'insecure_scheme');
    assert.equal(rejection('http://example.com', policy), 'insecure_scheme');
  });

  it('refuses schemes that are not http or https', () => {
    for (const input of ['ftp://host/x', 'file:///etc/passwd', 'ws://localhost:3000']) {
      assert.equal(rejection(input), 'unsupported_scheme', input);
    }
  });

  it('refuses an address with no scheme at all', () => {
    assert.equal(rejection('raphael.example.com'), 'malformed');
    assert.equal(rejection(''), 'malformed');
  });

  it('recognizes loopback through every spelling the URL parser canonicalizes', () => {
    // Measured, not assumed: `new URL` normalizes hex, decimal, and short-form IPv4 to a dotted quad
    // before the loopback test ever sees it, so these are not bypasses to defend against separately.
    for (const input of ['http://0x7f.0.0.1', 'http://2130706433', 'http://127.1']) {
      assert.equal(accept(input).origin, 'http://127.0.0.1', input);
    }
  });

  it('refuses hosts the URL parser will not accept at all', () => {
    // An octet out of range is not an address this client then has to reason about.
    for (const input of ['http://127.0.0.999', 'http://127.0.0.1.5']) {
      assert.equal(rejection(input), 'malformed', input);
    }
  });

  it('does not recognize IPv4-mapped IPv6 loopback, and that is deliberate', () => {
    // `[::ffff:127.0.0.1]` normalizes to `[::ffff:7f00:1]`, which this check does not read as
    // loopback. Refusing it is the conservative direction: an unusual spelling of "this machine" is
    // better answered with "use https" than with a second address parser to get subtly wrong.
    assert.equal(rejection('http://[::ffff:127.0.0.1]'), 'insecure_scheme');
  });
});

describe('endpoint hygiene', () => {
  it('refuses credentials embedded in the URL', () => {
    // A key in a URL ends up in shell history, logs, and bug reports. Raphael's travels in a header.
    assert.equal(rejection('https://user:secret@example.com'), 'credentials_in_url');
    assert.equal(rejection('https://user@example.com'), 'credentials_in_url');
  });

  it('refuses a query string or fragment', () => {
    assert.equal(rejection('https://example.com?token=x'), 'query_not_allowed');
    assert.equal(rejection('https://example.com#section'), 'fragment_not_allowed');
  });
});

describe('route joining', () => {
  it('joins a bare origin deterministically', () => {
    const endpoint = accept('https://example.com');
    assert.equal(routeUrl(endpoint, '/api/nodes/get'), 'https://example.com/api/nodes/get');
  });

  it('preserves a base path instead of discarding it', () => {
    // This is why joining is concatenation. `new URL('/api/nodes/get', 'https://example.com/raphael/')`
    // resolves to 'https://example.com/api/nodes/get' and silently drops the prefix.
    const endpoint = accept('https://example.com/raphael/');
    assert.equal(endpoint.base, 'https://example.com/raphael');
    assert.equal(routeUrl(endpoint, '/api/nodes/get'), 'https://example.com/raphael/api/nodes/get');

    const viaUrl = new URL('/api/nodes/get', 'https://example.com/raphael/').toString();
    assert.equal(viaUrl, 'https://example.com/api/nodes/get');
    assert.notEqual(viaUrl, routeUrl(endpoint, '/api/nodes/get'));
  });

  it('normalizes trailing slashes so one endpoint has one spelling', () => {
    // The server routes strictly and case-sensitively with no aliases, so a doubled slash is a 404
    // rather than a redirect. Normalizing here is what keeps that from being a user-visible quirk.
    for (const input of ['https://example.com', 'https://example.com/', 'https://example.com///']) {
      assert.equal(
        routeUrl(accept(input), '/api/connection/verify'),
        'https://example.com/api/connection/verify',
      );
    }
    for (const input of ['https://example.com/raphael', 'https://example.com/raphael//']) {
      assert.equal(
        routeUrl(accept(input), '/api/connection/verify'),
        'https://example.com/raphael/api/connection/verify',
      );
    }
  });

  it('keeps a non-default port', () => {
    assert.equal(accept('http://localhost:3000').base, 'http://localhost:3000');
    assert.equal(
      routeUrl(accept('http://localhost:3000'), '/api/nodes/list'),
      'http://localhost:3000/api/nodes/list',
    );
  });
});

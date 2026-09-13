import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isEndpointRejection, parseEndpoint, routeUrl, type Endpoint } from './endpoint.ts';

const accept = (input: string): Endpoint => {
  const parsed = parseEndpoint(input);
  assert.equal(isEndpointRejection(parsed), false, `${input} should have been accepted`);
  return parsed as Endpoint;
};

const rejection = (input: string): string => {
  const parsed = parseEndpoint(input);
  assert.equal(isEndpointRejection(parsed), true, `${input} should have been refused`);
  return isEndpointRejection(parsed) ? parsed.reason : '';
};

describe('endpoint schemes', () => {
  it('accepts https anywhere', () => {
    assert.equal(accept('https://raphael.example.com').base, 'https://raphael.example.com');
    assert.equal(accept('https://192.168.1.10:8443').base, 'https://192.168.1.10:8443');
  });

  it("accepts plain http to any host, which is the owner's decision", () => {
    // Deliberate, and the cost is real: over http the full-access key travels in the clear on every
    // request. Raphael does not decide this for the owner, and there is no host list that quietly
    // re-imposes it - a home LAN address is treated exactly like a public one.
    for (const host of [
      '127.0.0.1',
      'localhost',
      '[::1]',
      '10.0.2.2',
      '192.168.1.10',
      '172.16.0.5',
      'raphael.example.com',
    ]) {
      assert.equal(
        accept(`http://${host}:3000`).origin,
        new URL(`http://${host}:3000`).origin,
        host,
      );
    }
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

  it('canonicalizes the spellings the URL parser normalizes', () => {
    // Measured, not assumed: `new URL` normalizes hex, decimal, and short-form IPv4 to a dotted
    // quad, so requests are built from one spelling whatever was typed.
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

  it('accepts an IPv4-mapped IPv6 address without having to understand it', () => {
    // `[::ffff:127.0.0.1]` normalizes to `[::ffff:7f00:1]`. Nothing here needs to know whether that
    // means loopback any more, which is one address parser this client no longer has to get right.
    assert.equal(accept('http://[::ffff:127.0.0.1]').origin, 'http://[::ffff:7f00:1]');
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

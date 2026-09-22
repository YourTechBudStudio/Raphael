import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { REQUEST_MAX_BYTES } from '@raphael/contracts';
import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { call, envelope, rawRequest, withServer } from './server-support.ts';

/**
 * The transport boundary: what a request has to be before an operation ever sees it.
 *
 * Every assertion here is about a rejection the host produces on its own. None of these conditions
 * reaches a capability, and none of these envelopes comes from a capability's error projection.
 */

const ROUTES = [
  '/api/nodes/create',
  '/api/nodes/get',
  '/api/nodes/list',
  '/api/nodes/search',
  '/api/nodes/get-path',
  '/api/connection/verify',
] as const;

describe('authentication', () => {
  test('every published route requires a credential', async () => {
    await withServer('auth-all-routes', async (server) => {
      for (const path of ROUTES) {
        const response = await call(server, path, { body: '{}', authorize: false });
        assert.equal(response.status, 401, `${path} answered ${response.status}`);
        assert.equal(envelope(response.json).code, 'unauthorized');
      }
    });
  });

  test('a wrong key, a wrong scheme, and a bare token are all one answer', async () => {
    await withServer('auth-variants', async (server) => {
      const variants = [
        `Bearer ${'w'.repeat(45)}`,
        `Basic ${server.key}`,
        server.key,
        'Bearer ',
        '',
      ];
      for (const authorization of variants) {
        const response = await call(server, '/api/connection/verify', {
          body: '{}',
          authorize: false,
          headers: { authorization },
        });
        assert.equal(response.status, 401);
        const error = envelope(response.json);
        assert.equal(error.code, 'unauthorized');
        // The caller is never told which part was wrong: that would be a hint about how to get closer.
        assert.deepEqual(error.details, {});
      }
    });
  });

  test('the scheme is case-insensitive and the token is not', async () => {
    await withServer('auth-case', async (server) => {
      const lowered = await call(server, '/api/connection/verify', {
        body: '{}',
        authorize: false,
        headers: { authorization: `bearer ${server.key}` },
      });
      assert.equal(lowered.status, 200);

      const upperedToken = await call(server, '/api/connection/verify', {
        body: '{}',
        authorize: false,
        headers: { authorization: `Bearer ${server.key.toUpperCase()}` },
      });
      assert.equal(upperedToken.status, 401);
    });
  });

  test('an unknown address answers 401 before it answers 404', async () => {
    await withServer('auth-before-routing', async (server) => {
      const unauthenticated = await call(server, '/api/nodes/secret-admin', {
        body: '{}',
        authorize: false,
      });
      assert.equal(unauthenticated.status, 401);

      const authenticated = await call(server, '/api/nodes/secret-admin', { body: '{}' });
      assert.equal(authenticated.status, 404);
      assert.equal(envelope(authenticated.json).code, 'route_not_found');
    });
  });

  test('an unauthenticated oversized upload is refused without being read', async () => {
    await withServer('auth-before-body', async (server) => {
      // The outcome is deliberately one of two things. The credential is checked before the body is
      // read, so the server answers 401 and closes the connection while the upload is still in
      // progress - and a client that is mid-write may see the reset instead of the envelope. Both
      // mean the same thing, and both are correct: the caller was refused without the server buying
      // the parse, and without a megabyte being drained on their behalf.
      //
      // What must never happen is 413. That status would prove the body was read to its limit before
      // the credential was judged.
      let status: number | 'reset';
      try {
        status = (
          await call(server, '/api/nodes/create', {
            body: 'x'.repeat(REQUEST_MAX_BYTES * 2),
            authorize: false,
          })
        ).status;
      } catch {
        status = 'reset';
      }
      assert.ok(
        status === 401 || status === 'reset',
        `expected a refusal before the body was read, got ${status}`,
      );
    });
  });
});

describe('duplicate credentials', () => {
  const withTwo = (first: string, second: string): string =>
    `POST /api/connection/verify HTTP/1.1\r\nHost: x\r\n` +
    `Authorization: ${first}\r\nAuthorization: ${second}\r\n` +
    `Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`;

  test('two Authorization fields are refused, in either order', async () => {
    await withServer('auth-duplicate', async (server) => {
      // `fetch` cannot send duplicated fields, and Node does not expose them: it keeps one and
      // discards the rest. Reading the collapsed value would accept a request carrying a valid key
      // and a second, different credential - and an intermediary that kept the other one would read
      // the same request differently. Both orders are checked, because "keeps the first" is exactly
      // the behavior that made this pass before.
      const valid = await rawRequest(
        server,
        withTwo(`Bearer ${server.key}`, 'Bearer not-the-key-but-long-enough-value'),
      );
      assert.match(
        valid,
        /^HTTP\/1\.1 401 /u,
        `valid-then-other was answered: ${valid.slice(0, 60)}`,
      );

      const reversed = await rawRequest(
        server,
        withTwo('Bearer not-the-key-but-long-enough-value', `Bearer ${server.key}`),
      );
      assert.match(reversed, /^HTTP\/1\.1 401 /u);

      const mixedCase = await rawRequest(
        server,
        `POST /api/connection/verify HTTP/1.1\r\nHost: x\r\n` +
          `Authorization: Bearer ${server.key}\r\nauthorization: Bearer other-credential-entirely-ok\r\n` +
          `Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      );
      // Field names are case-insensitive, so this is the same request as the first one.
      assert.match(mixedCase, /^HTTP\/1\.1 401 /u);
    });
  });

  test('two identical Authorization fields are still ambiguous', async () => {
    await withServer('auth-duplicate-same', async (server) => {
      // Refused rather than resolved. The server does not decide that two credentials which happen to
      // agree today are one credential.
      const response = await rawRequest(
        server,
        `POST /api/connection/verify HTTP/1.1\r\nHost: x\r\n` +
          `Authorization: Bearer ${server.key}\r\nAuthorization: Bearer ${server.key}\r\n` +
          `Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      );
      assert.match(response, /^HTTP\/1\.1 401 /u);
    });
  });

  test('a key the policy accepts actually authenticates over HTTP', async () => {
    // The policy's promise is not "this string looks reasonable" - it is "a client can present this
    // and be recognized". That is only true if it survives the wire, so it is checked on the wire, for
    // each shape the setup guidance recommends.
    for (const key of [
      'a3f9'.repeat(16),
      'Zm9vYmFyLWJhei1xdXV4LWNvcmdlLWdyYXVsdA',
      `${'x'.repeat(30)}-_.~+/=`,
    ]) {
      await withServer(
        'auth-accepted-shape',
        async (server) => {
          const response = await call(server, '/api/connection/verify', { body: '{}' });
          assert.equal(response.status, 200, `a key of shape "${key.slice(0, 8)}…" did not work`);
        },
        { key },
      );
    }
  });

  test('exactly one Authorization field still authenticates', async () => {
    await withServer('auth-single-raw', async (server) => {
      const response = await rawRequest(
        server,
        `POST /api/connection/verify HTTP/1.1\r\nHost: x\r\n` +
          `Authorization: Bearer ${server.key}\r\n` +
          `Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      );
      assert.match(response, /^HTTP\/1\.1 200 /u);
      assert.match(response, new RegExp(`"protocolVersion":"${PROTOCOL_VERSION}"`, 'u'));
    });
  });
});

describe('routing and methods', () => {
  test('addresses are exact: no case folding and no trailing-slash alias', async () => {
    await withServer('routing-strict', async (server) => {
      for (const path of [
        '/api/nodes/Get',
        '/api/nodes/get/',
        '/API/nodes/get',
        '/api/nodes/get//',
      ]) {
        const response = await call(server, path, { body: '{}' });
        assert.equal(response.status, 404, `${path} answered ${response.status}`);
        assert.equal(envelope(response.json).code, 'route_not_found');
      }
    });
  });

  test('a known address with the wrong method answers 405 and names what it accepts', async () => {
    await withServer('routing-method', async (server) => {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await call(server, '/api/nodes/get', { method });
        assert.equal(response.status, 405, `${method} answered ${response.status}`);
        assert.equal(response.headers.get('allow'), 'POST');
        assert.equal(envelope(response.json).code, 'method_not_allowed');
      }
    });
  });

  test('HEAD gets the same status and headers, and no body', async () => {
    await withServer('routing-head', async (server) => {
      const response = await call(server, '/api/nodes/get', { method: 'HEAD' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'POST');
      // HEAD carries no body, error or otherwise. The route is not special-cased; its wire semantics
      // are honored.
      assert.equal(response.text, '');
    });
  });

  test('OPTIONS is a method, not a CORS preflight', async () => {
    await withServer('routing-cors', async (server) => {
      const response = await call(server, '/api/nodes/get', {
        method: 'OPTIONS',
        headers: { origin: 'https://example.test', 'access-control-request-method': 'POST' },
      });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    });
  });

  test('no fingerprinting headers are advertised', async () => {
    await withServer('routing-headers', async (server) => {
      const response = await call(server, '/api/connection/verify', { body: '{}' });
      assert.equal(response.headers.get('x-powered-by'), null);
      assert.equal(response.headers.get('etag'), null);
    });
  });
});

describe('representation', () => {
  test('a non-JSON content type is 415, with a reason', async () => {
    await withServer('media-type', async (server) => {
      const response = await call(server, '/api/connection/verify', {
        body: '{}',
        headers: { 'content-type': 'text/plain' },
      });
      assert.equal(response.status, 415);
      const error = envelope(response.json);
      assert.equal(error.code, 'unsupported_media_type');
      assert.equal(error.details.reason, 'unsupported_media_type');
    });
  });

  test('an absent content type is a missing declaration, not permission to guess', async () => {
    await withServer('media-absent', async (server) => {
      const response = await fetch(`http://${server.host}:${server.port}/api/connection/verify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.key}` },
        body: new Blob(['{}']),
      });
      assert.equal(response.status, 415);
    });
  });

  test('an explicit UTF-8 charset is accepted, and any other charset is not', async () => {
    await withServer('media-charset', async (server) => {
      const accepted = await call(server, '/api/connection/verify', {
        body: '{}',
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
      assert.equal(accepted.status, 200);

      const quoted = await call(server, '/api/connection/verify', {
        body: '{}',
        headers: { 'content-type': 'application/json; charset="UTF-8"' },
      });
      assert.equal(quoted.status, 200);

      const refused = await call(server, '/api/connection/verify', {
        body: '{}',
        headers: { 'content-type': 'application/json; charset=iso-8859-1' },
      });
      assert.equal(refused.status, 415);
      assert.equal(envelope(refused.json).details.reason, 'unsupported_charset');
    });
  });

  test('a compressed body is refused rather than decompressed', async () => {
    await withServer('media-encoding', async (server) => {
      const response = await call(server, '/api/connection/verify', {
        body: gzipSync(Buffer.from('{}', 'utf8')),
        headers: { 'content-encoding': 'gzip' },
      });
      assert.equal(response.status, 415);
      assert.equal(envelope(response.json).details.reason, 'unsupported_content_encoding');
    });
  });

  test('identity encoding is accepted, because it means no encoding was applied', async () => {
    await withServer('media-identity', async (server) => {
      const response = await call(server, '/api/connection/verify', {
        body: '{}',
        headers: { 'content-encoding': 'identity' },
      });
      assert.equal(response.status, 200);
    });
  });
});

describe('bodies', () => {
  test('a body over the budget is 413 and names the limit', async () => {
    await withServer('body-limit', async (server) => {
      const oversized = JSON.stringify({ pad: 'x'.repeat(REQUEST_MAX_BYTES) });
      const response = await call(server, '/api/nodes/create', { body: oversized });
      assert.equal(response.status, 413);
      const error = envelope(response.json);
      assert.equal(error.code, 'payload_too_large');
      assert.equal(error.details.limit, REQUEST_MAX_BYTES);
    });
  });

  test('malformed JSON says only that, with no position and nothing from the body', async () => {
    await withServer('body-malformed', async (server) => {
      const secret = 'correct-horse-battery-staple';
      const response = await call(server, '/api/nodes/create', {
        body: `{"title": "${secret}", `,
      });
      assert.equal(response.status, 400);
      const error = envelope(response.json);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.details.reason, 'malformed_json');
      // Nothing submitted is reflected: no fragment, no position, no parser message.
      assert.equal(response.text.includes(secret), false);
      assert.match(
        response.text,
        /^\{"error":\{"code":"invalid_input","message":"[^"]+","details":\{"reason":"malformed_json"\}\}\}$/u,
      );
    });
  });

  test('invalid UTF-8 is its own answer, not a JSON complaint', async () => {
    await withServer('body-utf8', async (server) => {
      // A lone continuation byte: valid JSON if the bytes were decoded leniently, invalid UTF-8.
      const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d]);
      const response = await call(server, '/api/nodes/create', { body: bytes });
      assert.equal(response.status, 400);
      assert.equal(envelope(response.json).details.reason, 'invalid_utf8');
    });
  });

  test('an empty body is refused rather than treated as an empty object', async () => {
    await withServer('body-empty', async (server) => {
      // Verification's only legal input is `{}`, so substituting one for absent bytes would make this
      // succeed. It must not: a request that said nothing did not say `{}`.
      const empty = await call(server, '/api/connection/verify', { body: '' });
      assert.equal(empty.status, 400);
      assert.equal(envelope(empty.json).details.reason, 'malformed_json');

      const absent = await call(server, '/api/connection/verify', {});
      assert.equal(absent.status, 400);
      assert.equal(envelope(absent.json).details.reason, 'malformed_json');
    });
  });

  test('JSON that is not an object reaches the capability and is judged there', async () => {
    await withServer('body-nonobject', async (server) => {
      for (const body of ['null', '[]', '42', '"text"']) {
        const response = await call(server, '/api/connection/verify', { body });
        // Parsed successfully by the transport, refused by the operation's own decoder.
        assert.equal(response.status, 400, `${body} answered ${response.status}`);
        assert.equal(envelope(response.json).code, 'invalid_input');
        assert.equal(envelope(response.json).details.reason, 'invalid');
      }
    });
  });
});

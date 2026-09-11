import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { AUTHORIZATION_SCHEME } from '@raphael/contracts/connection';

import type { ClientResult } from './failure.ts';
import {
  createTransport,
  isTransportRejection,
  RESPONSE_MAX_BYTES,
  type FetchLike,
  type Transport,
} from './transport.ts';

/**
 * Real sockets wherever the behaviour under test is a network behaviour.
 *
 * A stub `fetch` is used only where the point is how this code reacts to a response shape - a null
 * body, a missing stream API - which a real server cannot produce on demand. Everything about headers,
 * redirects, statuses, and body reading runs against `node:http`, because a fake that returns the
 * object we expect would assert our own assumptions rather than the runtime's behaviour.
 */

const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const listen = async (handler: Handler): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

const KEY = 'a'.repeat(32);

const transportFor = (endpoint: string, overrides: Record<string, unknown> = {}): Transport => {
  const built = createTransport({
    endpoint,
    apiKey: KEY,
    fetch: fetch as unknown as FetchLike,
    ...overrides,
  });
  assert.equal(isTransportRejection(built), false, 'transport should have been built');
  return built as Transport;
};

/** A decoder that accepts any object, so response-shape tests are not also schema tests. */
const anyObject = (input: unknown): ClientResult<unknown> extends never ? never : any =>
  input !== null && typeof input === 'object'
    ? { _tag: 'Right', right: input }
    : { _tag: 'Left', left: { kind: 'invalid_payload', message: 'not an object', issues: [] } };

const call = (transport: Transport, overrides: Record<string, unknown> = {}) =>
  transport.invoke({
    route: { method: 'POST', path: '/api/nodes/get' },
    body: { target: { id: 1 } },
    decode: anyObject,
    successStatus: 200,
    mutating: false,
    ...overrides,
  });

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
};

describe('transport construction', () => {
  it('refuses an endpoint that would send the key in the clear', () => {
    const built = createTransport({
      endpoint: 'http://raphael.example.com',
      apiKey: KEY,
      fetch: fetch as unknown as FetchLike,
    });
    assert.equal(isTransportRejection(built), true);
  });

  it('refuses an empty key rather than sending an empty credential', () => {
    const built = createTransport({
      endpoint: 'https://example.com',
      apiKey: '',
      fetch: fetch as unknown as FetchLike,
    });
    assert.equal(isTransportRejection(built) && built.reason, 'api_key_missing');
  });

  it('refuses a key that could never travel in a header, before any request exists', async () => {
    // `fetch` rejects a header value outside Latin-1 outright. Without this check that rejection
    // arrives as a transport failure - and for a creation, as post-dispatch uncertainty about work
    // that was never dispatched. A key that cannot work is a configuration answer, not a mystery.
    for (const apiKey of [`${KEY}\n`, `${KEY} `, 'é'.repeat(32), '🔑'.repeat(32)]) {
      const built = createTransport({
        endpoint: 'https://example.com',
        apiKey,
        fetch: fetch as unknown as FetchLike,
      });
      assert.equal(isTransportRejection(built), true, JSON.stringify(apiKey.slice(0, 4)));
      if (isTransportRejection(built)) assert.equal(built.reason, 'api_key_unusable');
    }
  });

  it('refuses a key below the shared minimum', () => {
    const built = createTransport({
      endpoint: 'https://example.com',
      apiKey: 'a'.repeat(31),
      fetch: fetch as unknown as FetchLike,
    });
    assert.equal(isTransportRejection(built) && built.reason, 'api_key_unusable');
  });

  it('never echoes the key it refused', () => {
    const secret = `${'z'.repeat(40)}\n`;
    const built = createTransport({
      endpoint: 'https://example.com',
      apiKey: secret,
      fetch: fetch as unknown as FetchLike,
    });
    assert.equal(isTransportRejection(built), true);
    if (isTransportRejection(built)) assert.equal(built.message.includes('zzz'), false);
  });

  it('bounds the timeout override', () => {
    for (const timeoutMs of [0, 999, 120_001, 1.5, Number.NaN]) {
      const built = createTransport({
        endpoint: 'https://example.com',
        apiKey: KEY,
        fetch: fetch as unknown as FetchLike,
        timeoutMs,
      });
      assert.equal(
        isTransportRejection(built) && built.reason,
        'timeout_out_of_range',
        `${timeoutMs}`,
      );
    }
  });

  it('snapshots configuration, so mutating the options later cannot redirect a credential', async () => {
    const endpoint = await listen((request, response) =>
      json(response, 200, { seen: request.url }),
    );
    const options = {
      endpoint,
      apiKey: KEY,
      fetch: fetch as unknown as FetchLike,
    };
    const transport = createTransport(options) as Transport;
    options.endpoint = 'https://attacker.example.com';
    options.apiKey = 'different';

    const result = await call(transport);
    assert.equal(result.ok, true);
    assert.equal(transport.endpoint.origin, endpoint);
  });
});

describe('what travels', () => {
  it('sends the credential as a bearer header and nothing else carries it', async () => {
    let seen: { url?: string; auth?: string; cookie?: string; body?: string } = {};
    const endpoint = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen = {
          url: request.url,
          auth: request.headers.authorization,
          cookie: request.headers.cookie,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        json(response, 200, { ok: true });
      });
    });

    await call(transportFor(endpoint));

    assert.equal(seen.auth, `${AUTHORIZATION_SCHEME} ${KEY}`);
    assert.equal(seen.url?.includes(KEY), false, 'the key must not appear in the path or query');
    assert.equal(seen.body?.includes(KEY), false, 'the key must not appear in the body');
    assert.equal(seen.cookie, undefined, 'no ambient cookies');
  });

  it('sends the decoded request, not the caller object, so later mutation cannot change it', async () => {
    let body = '';
    const endpoint = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        body = Buffer.concat(chunks).toString('utf8');
        json(response, 200, { ok: true });
      });
    });

    const payload: { target: { id: number } } = { target: { id: 7 } };
    const pending = call(transportFor(endpoint), { body: payload });
    // Mutate while the request is in flight. Serialization already happened.
    payload.target.id = 999;
    await pending;

    assert.equal(body, JSON.stringify({ target: { id: 7 } }));
  });
});

describe('redirects', () => {
  it('refuses a redirect instead of replaying the credential at the new address', async () => {
    let hops = 0;
    const endpoint = await listen((request, response) => {
      hops += 1;
      response.writeHead(302, { location: '/elsewhere' });
      response.end();
    });

    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'invalid_response');
      assert.equal(
        result.failure.kind === 'invalid_response' ? result.failure.reason : '',
        'redirect_refused',
      );
    }
    // The decisive assertion: the server was contacted exactly once. A followed redirect would be two.
    assert.equal(hops, 1);
  });

  it('refuses every redirect status, including 307 and 308', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const endpoint = await listen((_request, response) => {
        response.writeHead(status, { location: 'https://attacker.example.com/api/nodes/get' });
        response.end();
      });
      const result = await call(transportFor(endpoint));
      assert.equal(result.ok, false, `${status}`);
      if (!result.ok && result.failure.kind === 'invalid_response') {
        assert.equal(result.failure.reason, 'redirect_refused', `${status}`);
      }
    }
  });
});

describe('response reading', () => {
  it('decodes a successful answer', async () => {
    const endpoint = await listen((_request, response) =>
      json(response, 200, { entity: { id: 4 } }),
    );
    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, { entity: { id: 4 } });
  });

  it('requires the documented success status rather than any 2xx', async () => {
    const endpoint = await listen((_request, response) =>
      json(response, 202, { entity: { id: 4 } }),
    );
    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, false);
  });

  it('refuses statuses that carry no body, and 304 is not treated as a redirect', async () => {
    for (const status of [204, 304]) {
      const endpoint = await listen((_request, response) => {
        response.writeHead(status);
        response.end();
      });
      const result = await call(transportFor(endpoint));
      assert.equal(result.ok, false, `${status}`);
      if (!result.ok && result.failure.kind === 'invalid_response') {
        assert.equal(result.failure.reason, 'unexpected_status', `${status}`);
      }
    }
  });

  it('reports an empty body as an empty response, not as malformed JSON', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end();
    });
    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'invalid_response') {
      assert.equal(result.failure.reason, 'empty_response');
    }
  });

  it('reports invalid UTF-8 separately from malformed JSON', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    });
    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'invalid_response') {
      assert.equal(result.failure.reason, 'invalid_utf8');
    }
  });

  it('never quotes the response body in a parse failure', async () => {
    const secret = 'leaked-secret-value';
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`{not json, ${secret}`);
    });
    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'invalid_response');
      assert.equal(JSON.stringify(result.failure).includes(secret), false);
    }
  });

  it('answers HTML from a proxy as an unreadable error, never as a verified success', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'text/html' });
      response.end('<html><body>Please sign in</body></html>');
    });
    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'invalid_response') {
      assert.equal(result.failure.reason, 'unrecognized_error');
      assert.equal(result.failure.status, 401);
    }
  });
});

describe('the response ceiling', () => {
  it('aborts a response that exceeds the limit instead of buffering it', async () => {
    // The server offers far more than the ceiling and never finishes. If the limit were checked after
    // buffering, this test would exhaust memory rather than fail.
    let written = 0;
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const pump = (): void => {
        while (response.write(chunk)) {
          written += chunk.byteLength;
          if (written > RESPONSE_MAX_BYTES * 2) return;
        }
        response.once('drain', pump);
      };
      pump();
    });

    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'invalid_response') {
      assert.equal(result.failure.reason, 'response_too_large');
    }
  });

  it('reads a large but legal response', async () => {
    const payload = { entity: { description: 'x'.repeat(2 * 1024 * 1024) } };
    const endpoint = await listen((_request, response) => json(response, 200, payload));
    const result = await call(transportFor(endpoint));
    assert.equal(result.ok, true);
  });
});

describe('timeout and cancellation', () => {
  it('bounds the whole exchange, not just the wait for headers', async () => {
    // Headers arrive immediately; the body never finishes. A timer that stopped at headers would let
    // this hang forever.
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"partial":');
    });

    const result = await call(transportFor(endpoint, { timeoutMs: 1_000 }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'timeout');
  });

  it('reports cancellation before dispatch as not dispatched', async () => {
    const endpoint = await listen((_request, response) => json(response, 200, {}));
    const controller = new AbortController();
    controller.abort();
    const result = await call(transportFor(endpoint), { signal: controller.signal });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'cancelled');
      assert.equal(result.failure.mutationOutcome, 'not_dispatched');
    }
  });

  it('reports cancellation after dispatch as unknown for a mutation', async () => {
    // Aborting the local wait does not undo a transaction the server may already have committed.
    const endpoint = await listen((_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.write('{"entity":');
    });
    const controller = new AbortController();
    const pending = call(transportFor(endpoint), {
      signal: controller.signal,
      mutating: true,
      successStatus: 201,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'cancelled');
      assert.equal(result.failure.mutationOutcome, 'unknown');
    }
  });
});

describe('an unreachable server', () => {
  it('is uncertain for a mutation, even though the connection was refused', async () => {
    // Deliberate over-caution. Undici would let us read ECONNREFUSED and say "nothing was sent", but
    // React Native's fetch would not, and a certainty claim that depends on the platform is worse
    // than one that is uniformly conservative.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const transport = transportFor(`http://127.0.0.1:${port}`);
    const result = await transport.invoke({
      route: { method: 'POST', path: '/api/nodes/create' },
      body: {},
      decode: anyObject,
      successStatus: 201,
      mutating: true,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'transport');
      assert.equal(result.failure.mutationOutcome, 'unknown');
    }
  });

  it('is not applicable for a read', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const result = await call(transportFor(`http://127.0.0.1:${port}`));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.mutationOutcome, 'not_applicable');
  });
});

describe('a fetch implementation that cannot stream', () => {
  const respondWith =
    (body: unknown): FetchLike =>
    () =>
      Promise.resolve({ status: 200, type: 'default', body } as unknown as Response);

  it('fails loudly rather than falling back to buffering', async () => {
    const transport = createTransport({
      endpoint: 'https://example.com',
      apiKey: KEY,
      // A body object with no getReader: what a non-streaming implementation looks like.
      fetch: respondWith({}),
    }) as Transport;

    const result = await call(transport);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'unsupported_fetch');
  });

  it('distinguishes a genuinely empty body from a missing streaming API', async () => {
    // A null body is a broken response, not evidence about the implementation - so it must not be
    // reported as an unsupported fetch, which would send someone to fix the wrong thing.
    const transport = createTransport({
      endpoint: 'https://example.com',
      apiKey: KEY,
      fetch: respondWith(null),
    }) as Transport;

    const result = await call(transport);
    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'invalid_response') {
      assert.equal(result.failure.reason, 'empty_response');
    }
  });
});

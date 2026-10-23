import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { AUTHORIZATION_SCHEME } from '@raphael/contracts/connection';

import { retryable, type ClientResult } from './failure.ts';
import {
  createTransport,
  isTransportRejection,
  type FetchLike,
  type Transport,
} from './transport.ts';

/** Real sockets wherever the behaviour under test is a network behaviour. */

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
    effect: 'read',
    body: { target: { id: 1 } },
    decode: anyObject,
    successStatus: 200,
    ...overrides,
  });

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
};

describe('transport construction', () => {
  it('builds a transport for a plain-http endpoint, anywhere', () => {
    // The owner decides whether the key travels in the clear; the transport does not veto it.
    const built = createTransport({
      endpoint: 'http://raphael.example.com',
      apiKey: KEY,
      fetch: fetch as unknown as FetchLike,
    });
    assert.equal(isTransportRejection(built), false);
  });

  it('still refuses an endpoint that cannot carry a credential at all', () => {
    // Not a transport-security rule: userinfo lands in logs and shell history whatever the scheme.
    const built = createTransport({
      endpoint: 'https://user:secret@raphael.example.com',
      apiKey: KEY,
      fetch: fetch as unknown as FetchLike,
    });
    assert.equal(isTransportRejection(built) && built.reason, 'credentials_in_url');
  });

  it('refuses an empty key rather than sending an empty credential', () => {
    const built = createTransport({
      endpoint: 'https://example.com',
      apiKey: '',
      fetch: fetch as unknown as FetchLike,
    });
    assert.equal(isTransportRejection(built) && built.reason, 'api_key_missing');
  });

  it('accepts any key the owner configured, whatever its shape', () => {
    // There is no length floor and no character set: the key is whatever started the server. A key
    // outside Latin-1 cannot in fact travel in a header and will fail at the first request as a
    // transport error - that is the accepted cost of not policing the value here.
    for (const apiKey of ['a', `${KEY} `, 'a key with spaces', 'é'.repeat(32), '🔑']) {
      const built = createTransport({
        endpoint: 'https://example.com',
        apiKey,
        fetch: fetch as unknown as FetchLike,
      });
      assert.equal(isTransportRejection(built), false, JSON.stringify(apiKey.slice(0, 4)));
    }
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
      assert.equal(result.failure.kind, 'bad_response');
      assert.equal(result.failure.status, 302);
      // A relative target resolves against the request; only its origin is kept.
      assert.equal(result.failure.redirectOrigin, new URL(endpoint).origin);
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
      if (!result.ok) {
        assert.equal(result.failure.kind, 'bad_response', `${status}`);
        // The path and anything after it are the redirecting server's text and are never kept.
        assert.equal(result.failure.redirectOrigin, 'https://attacker.example.com', `${status}`);
      }
    }
  });

  it('keeps no origin for a target that is not an HTTP address', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(302, { location: 'javascript:alert(1)' });
      response.end();
    });
    const result = await call(transportFor(endpoint));
    assert.equal(!result.ok && result.failure.redirectOrigin, undefined);
  });
});

const failureOf = async (endpoint: string, overrides: Record<string, unknown> = {}) => {
  const result = await call(transportFor(endpoint), overrides);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  return result.failure;
};

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
    const failure = await failureOf(endpoint);
    assert.equal(failure.kind, 'bad_response');
    assert.equal(failure.status, 202);
  });

  it('reports an unreadable success body as a bad response without quoting it', async () => {
    const secret = 'leaked-secret-value';
    for (const body of ['', `{not json, ${secret}`, '"a string"']) {
      const endpoint = await listen((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      });
      const failure = await failureOf(endpoint);
      assert.equal(failure.kind, 'bad_response', body);
      assert.equal(JSON.stringify(failure).includes(secret), false);
    }
  });

  it('carries the code and message of a Raphael error envelope', async () => {
    const endpoint = await listen((_request, response) =>
      json(response, 409, {
        error: { code: 'slug_conflict', message: '"idea" is already used here.' },
      }),
    );
    assert.deepEqual(await failureOf(endpoint), {
      kind: 'http',
      effect: 'read',
      delivery: 'answered',
      status: 409,
      code: 'slug_conflict',
      message: '"idea" is already used here.',
    });
  });

  it('carries the structured details of an error envelope', async () => {
    const details = { field: 'slug', reason: 'sibling', blocking: { id: 4, type: 'resource' } };
    const endpoint = await listen((_request, response) =>
      json(response, 409, { error: { code: 'slug_conflict', message: 'x', details } }),
    );
    assert.deepEqual((await failureOf(endpoint)).details, details);
  });

  it('keeps an unfamiliar code as sent', async () => {
    const endpoint = await listen((_request, response) =>
      json(response, 429, { error: { code: 'quota_exhausted', message: 'Later.' } }),
    );
    const failure = await failureOf(endpoint);
    assert.equal(failure.code, 'quota_exhausted');
  });

  it('reports a page from a proxy as a bare status, never as a success', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(502, { 'content-type': 'text/html' });
      response.end('<html><body>Bad gateway</body></html>');
    });
    const failure = await failureOf(endpoint);
    assert.deepEqual(failure, {
      kind: 'http',
      effect: 'read',
      delivery: 'answered',
      status: 502,
      message: 'The server answered 502.',
    });
    assert.equal(retryable(failure), true);
  });
});

describe('timeout and cancellation', () => {
  it('bounds the whole exchange, not just the wait for headers', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"partial":');
      // Never finishes.
    });
    const result = await call(transportFor(endpoint, { timeoutMs: 1_000 }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'timeout');
      // The request was out; a timeout can never say it was not.
      assert.equal(result.failure.delivery, 'unknown');
    }
  });

  it('reports a caller cancellation before or after dispatch as cancelled', async () => {
    const endpoint = await listen(() => {
      // Never answers.
    });
    const early = new AbortController();
    early.abort();
    const unsent = await failureOf(endpoint, { signal: early.signal });
    assert.equal(unsent.kind, 'cancelled');
    assert.equal(unsent.delivery, 'not_sent');

    const late = new AbortController();
    setTimeout(() => late.abort(), 50);
    const sent = await failureOf(endpoint, { signal: late.signal, effect: 'write' });
    assert.equal(sent.kind, 'cancelled');
    assert.equal(sent.delivery, 'unknown');
    assert.equal(sent.effect, 'write');
  });
});

describe('an unreachable server', () => {
  it('is a network failure', async () => {
    const endpoint = await listen(() => {});
    const server = servers.at(-1);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const failure = await failureOf(endpoint);
    assert.equal(failure.kind, 'network');
    // Nothing listened, so nothing was sent.
    assert.equal(failure.delivery, 'not_sent');
    assert.equal(retryable(failure), true);
  });

  it('is unknown when the connection drops after the request was read', async () => {
    const endpoint = await listen((request) => {
      request.on('data', () => {});
      request.on('end', () => request.socket.destroy());
    });
    const failure = await failureOf(endpoint, { effect: 'write' });
    assert.equal(failure.kind, 'network');
    assert.equal(failure.delivery, 'unknown');
  });

  it('is unknown when the answer started and the body never finished', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      response.write('{"partial":');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    const failure = await failureOf(endpoint, { effect: 'write' });
    assert.equal(failure.delivery, 'unknown');
  });

  it('classifies a failed fetch by its cause, assuming it was sent when in doubt', async () => {
    const failing = (error: unknown) =>
      transportFor('http://127.0.0.1:9', {
        fetch: (async () => {
          throw error;
        }) as FetchLike,
      });
    const withCause = (cause: unknown) => new TypeError('fetch failed', { cause });
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [withCause(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), 'not_sent'],
      [withCause(Object.assign(new Error('dns'), { code: 'ENOTFOUND' })), 'not_sent'],
      [
        withCause(
          Object.assign(new AggregateError([], 'both'), {
            errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }],
          }),
        ),
        'not_sent',
      ],
      [
        withCause(Object.assign(new Error('tls'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' })),
        'not_sent',
      ],
      [withCause(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 'unknown'],
      [withCause(Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' })), 'unknown'],
      [withCause(new Error('no code')), 'unknown'],
      // The Fetch standard's port blocklist: refused before anything is opened.
      [withCause(new Error('bad port')), 'not_sent'],
      // A bare error proves nothing about how far the request got.
      [new TypeError('Network request failed'), 'unknown'],
      ['not even an error', 'unknown'],
    ];
    for (const [error, delivery] of cases) {
      const result = await call(failing(error), { effect: 'write' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failure.delivery, delivery, String(error));
    }
  });

  it('names the cause the system reported, and nothing when it did not say', async () => {
    const failing = (error: unknown) =>
      transportFor('http://127.0.0.1:9', {
        fetch: (async () => {
          throw error;
        }) as FetchLike,
      });
    const withCode = (code: string) =>
      new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    const cases: ReadonlyArray<readonly [unknown, string | undefined]> = [
      [withCode('ECONNREFUSED'), 'refused'],
      [withCode('ENOTFOUND'), 'dns'],
      [withCode('EAI_AGAIN'), 'dns'],
      [withCode('ECONNRESET'), 'reset'],
      [withCode('UND_ERR_SOCKET'), 'reset'],
      [withCode('EHOSTUNREACH'), 'unreachable'],
      [withCode('ERR_SSL_WRONG_VERSION_NUMBER'), 'tls'],
      [withCode('CERT_HAS_EXPIRED'), 'tls'],
      [withCode('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls'],
      [
        new TypeError('fetch failed', {
          cause: Object.assign(new AggregateError([], 'both'), {
            errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }],
          }),
        }),
        'refused',
      ],
      [
        new TypeError('fetch failed', {
          cause: Object.assign(new AggregateError([], 'mixed'), {
            errors: [{ code: 'ECONNREFUSED' }, { code: 'EHOSTUNREACH' }],
          }),
        }),
        undefined,
      ],
      [withCode('EWHATEVER'), undefined],
      [new TypeError('Network request failed'), undefined],
    ];
    for (const [error, cause] of cases) {
      const result = await call(failing(error));
      assert.equal(!result.ok && result.failure.cause, cause, String(error));
    }
  });

  it('reports a refused connection to a real closed port as refused and not sent', async () => {
    // Bind a port, then close it, so nothing listens there during the request.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const result = await call(transportFor(`http://127.0.0.1:${port}`));
    assert.equal(!result.ok && result.failure.cause, 'refused');
    assert.equal(!result.ok && result.failure.delivery, 'not_sent');
  });
});

describe('retryable', () => {
  it('is network, timeout and 5xx only', () => {
    assert.equal(retryable({ kind: 'timeout', message: '' }), true);
    assert.equal(retryable({ kind: 'http', status: 503, code: 'storage_busy', message: '' }), true);
    assert.equal(
      retryable({ kind: 'http', status: 409, code: 'slug_conflict', message: '' }),
      false,
    );
    assert.equal(retryable({ kind: 'bad_response', status: 500, message: '' }), false);
    assert.equal(retryable({ kind: 'cancelled', message: '' }), false);
    assert.equal(retryable({ kind: 'invalid_request', message: '' }), false);
  });
});

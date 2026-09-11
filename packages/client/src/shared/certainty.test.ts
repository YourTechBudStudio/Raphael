import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { API_ERROR_STATUS, SHUTTING_DOWN_REASON, type ApiErrorCode } from '@raphael/contracts';

import type { ClientFailure } from './failure.ts';
import { createTransport, type FetchLike, type Transport } from './transport.ts';

/**
 * What a failed creation establishes about whether anything was created.
 *
 * This is the table the whole client exists to get right. Reporting `rejected` when the truth is
 * `unknown` produces a silent duplicate when someone retries; reporting `unknown` when the truth is
 * `rejected` sends someone hunting for an entity that was never made. The first is worse, so every
 * ambiguous case resolves to `unknown`.
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

const KEY = 'a'.repeat(32);

const serverAnswering = async (
  status: number,
  payload: unknown,
  contentType = 'application/json',
): Promise<Transport> => {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': contentType });
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return createTransport({
    endpoint: `http://127.0.0.1:${port}`,
    apiKey: KEY,
    fetch: fetch as unknown as FetchLike,
  }) as Transport;
};

const envelope = (code: string, details: Record<string, unknown> = {}) => ({
  error: { code, message: `a ${code} happened`, details },
});

/** Attempt a creation and return how it failed. */
const attemptCreate = async (transport: Transport): Promise<ClientFailure> => {
  const result = await transport.invoke({
    route: { method: 'POST', path: '/api/nodes/create' },
    body: { title: 'x' },
    decode: (input) => ({ _tag: 'Right', right: input }) as never,
    successStatus: 201,
    mutating: true,
  });
  assert.equal(result.ok, false, 'the attempt was expected to fail');
  return result.ok ? (undefined as never) : result.failure;
};

describe('a server that states it refused', () => {
  /**
   * Every code the server produces before or instead of a write. These are the cases where the server
   * has told us, intelligibly and at the status it documents, that nothing happened.
   */
  const definiteCodes: ApiErrorCode[] = [
    'invalid_input',
    'unauthorized',
    'node_not_found',
    'route_not_found',
    'method_not_allowed',
    'slug_conflict',
    'idempotency_conflict',
    'payload_too_large',
    'unsupported_media_type',
    'invalid_parent',
    'unsupported_content',
  ];

  for (const code of definiteCodes) {
    it(`treats ${code} as a definite rejection`, async () => {
      const transport = await serverAnswering(API_ERROR_STATUS[code], envelope(code));
      const failure = await attemptCreate(transport);
      assert.equal(failure.kind, 'api_error');
      assert.equal(failure.mutationOutcome, 'rejected');
    });
  }

  it('includes the transport-owned codes, which are produced before any operation runs', async () => {
    // 401 in particular: the server authenticates before it buffers a body, so a rejected credential
    // proves the request never reached the hierarchy.
    const transport = await serverAnswering(401, envelope('unauthorized'));
    assert.equal((await attemptCreate(transport)).mutationOutcome, 'rejected');
  });
});

describe('a server that cannot say what happened', () => {
  it('treats internal_error as unknown, despite the current create rolling back', async () => {
    // Traced in phase 04: the response self-check and the replay write are both inside the one write
    // transaction, so an internal failure provably rolls back *today*. A client cannot verify a
    // server-internal commit boundary and that boundary can move, so this stays conservative.
    const transport = await serverAnswering(500, envelope('internal_error'));
    const failure = await attemptCreate(transport);
    assert.equal(failure.kind, 'api_error');
    assert.equal(failure.mutationOutcome, 'unknown');
  });

  it('treats a generic storage_busy as unknown', async () => {
    const transport = await serverAnswering(503, envelope('storage_busy'));
    assert.equal((await attemptCreate(transport)).mutationOutcome, 'unknown');
  });

  it("does not repeat the server's not-applied prose when it says unknown", async () => {
    // The server's generic storage_busy message literally reads "The request was not applied; try
    // again." That is a claim about one transaction, not about the whole exchange, and a client whose
    // own classification says `unknown` must not hand it on as though it were the answer - two
    // incompatible statements in one failure invite exactly the unsafe repeat this design prevents.
    const transport = await serverAnswering(503, {
      error: {
        code: 'storage_busy',
        message: 'Storage was busy. The request was not applied; try again.',
        details: {},
      },
    });
    const failure = await attemptCreate(transport);
    assert.equal(failure.mutationOutcome, 'unknown');
    assert.equal(failure.kind, 'api_error');

    // The claim must be gone from the message any consumer renders.
    assert.equal(failure.message.includes('not applied'), false);
    assert.match(failure.message, /did not confirm/);

    // And it must still be reachable, attributed to the server, for diagnosis.
    if (failure.kind === 'api_error') {
      assert.match(failure.error.message, /not applied/);
    }
  });

  it('keeps the server wording when the server really did refuse', async () => {
    // The substitution is narrow. A definite rejection is exactly the case where the server's own
    // sentence is the most useful thing to show.
    const transport = await serverAnswering(409, {
      error: {
        code: 'slug_conflict',
        message: 'Something here already uses that address.',
        details: { field: 'slug', slug: 'backend', scope: 'sibling' },
      },
    });
    const failure = await attemptCreate(transport);
    assert.equal(failure.mutationOutcome, 'rejected');
    assert.match(failure.message, /already uses that address/);
  });

  it('treats a shutting-down storage_busy as definite, because nothing ran', async () => {
    const transport = await serverAnswering(
      503,
      envelope('storage_busy', { reason: SHUTTING_DOWN_REASON }),
    );
    assert.equal((await attemptCreate(transport)).mutationOutcome, 'rejected');
  });

  it('does not accept a reason that merely resembles the shutting-down one', async () => {
    for (const reason of ['shutting_down_soon', 'shutdown', 'SHUTTING_DOWN']) {
      const transport = await serverAnswering(503, envelope('storage_busy', { reason }));
      assert.equal((await attemptCreate(transport)).mutationOutcome, 'unknown', reason);
    }
  });
});

describe('answers that break the contract', () => {
  it('treats a code at the wrong status as unreadable, not as a rejection', async () => {
    // A proxy or a confused server has contradicted itself. Neither field can now be trusted, and
    // guessing which one was right is how a duplicate gets created.
    const transport = await serverAnswering(500, envelope('slug_conflict'));
    const failure = await attemptCreate(transport);
    assert.equal(failure.kind, 'invalid_response');
    assert.equal(failure.kind === 'invalid_response' ? failure.reason : '', 'inconsistent_error');
    assert.equal(failure.mutationOutcome, 'unknown');
  });

  it('treats a bare error status with no envelope as unknown', async () => {
    const transport = await serverAnswering(409, '<html>Conflict</html>', 'text/html');
    assert.equal((await attemptCreate(transport)).mutationOutcome, 'unknown');
  });

  it('treats an unrecognized code as unknown rather than guessing', async () => {
    // A newer server's code decodes on purpose, so the code reaches the operator - but an unfamiliar
    // code is not a licence to claim nothing was created.
    const transport = await serverAnswering(409, envelope('quota_exceeded'));
    const failure = await attemptCreate(transport);
    assert.equal(failure.kind, 'api_error');
    assert.equal(failure.mutationOutcome, 'unknown');
    assert.equal(failure.kind === 'api_error' ? failure.error.kind : '', 'unrecognized');
  });

  it('treats a malformed success response as unknown, not as a failed creation', async () => {
    // The entity may well exist; what failed was our ability to read the answer describing it.
    const transport = await serverAnswering(201, { entity: null });
    const result = await transport.invoke({
      route: { method: 'POST', path: '/api/nodes/create' },
      body: {},
      decode: () =>
        ({ _tag: 'Left', left: { kind: 'invalid_payload', message: 'no', issues: [] } }) as never,
      successStatus: 201,
      mutating: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'invalid_response');
      assert.equal(result.failure.mutationOutcome, 'unknown');
    }
  });
});

describe('reads never claim a mutation outcome', () => {
  it('reports not_applicable whatever went wrong', async () => {
    const cases: Array<[number, unknown, string]> = [
      [404, envelope('node_not_found'), 'application/json'],
      [500, envelope('internal_error'), 'application/json'],
      [200, 'not json', 'application/json'],
    ];
    for (const [status, payload, contentType] of cases) {
      const transport = await serverAnswering(status, payload, contentType);
      const result = await transport.invoke({
        route: { method: 'POST', path: '/api/nodes/get' },
        body: {},
        decode: (input) => ({ _tag: 'Right', right: input }) as never,
        successStatus: 200,
        mutating: false,
      });
      assert.equal(result.ok, false, `${status}`);
      if (!result.ok) assert.equal(result.failure.mutationOutcome, 'not_applicable', `${status}`);
    }
  });
});

describe('recovery details reach the caller validated', () => {
  it('projects the fields a person needs and drops the rest', async () => {
    const transport = await serverAnswering(
      409,
      envelope('slug_conflict', {
        field: 'slug',
        slug: 'backend',
        scope: 'sibling',
        internalHint: 'a secret the server should not have sent',
      }),
    );
    const failure = await attemptCreate(transport);
    assert.equal(failure.kind, 'api_error');
    if (failure.kind === 'api_error') {
      assert.deepEqual(failure.details, { field: 'slug', slug: 'backend', scope: 'sibling' });
      assert.equal(JSON.stringify(failure.details).includes('secret'), false);
    }
  });
});

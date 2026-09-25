import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTransport, type FetchLike, type Transport } from '../shared/transport.ts';
import { move } from './index.ts';

/**
 * What `move` establishes, and what it leaves to the server.
 *
 * Driven through the real transport with a stubbed `fetch`, as `update.test.ts` is, so request
 * decoding, response decoding and error classification are the real ones. The destination is
 * asserted to travel exactly as given: whether a path names a container or a new address is the
 * server's decision, and nothing here may split or resolve it.
 */

const KEY = 'a'.repeat(32);

const transportOver = (fetchImpl: FetchLike): Transport =>
  createTransport({
    endpoint: 'http://127.0.0.1:1/',
    apiKey: KEY,
    fetch: fetchImpl,
  }) as Transport;

interface Sent {
  readonly url: string;
  readonly body: unknown;
}

const answering = (
  status: number,
  payload: unknown,
): { readonly transport: Transport; readonly sent: Sent[] } => {
  const sent: Sent[] = [];
  const transport = transportOver((url, init) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { transport, sent };
};

const node = {
  id: 7,
  type: 'project',
  kind: null,
  parentId: 3,
  slug: 'backend',
  revision: 9,
  title: 'Backend',
  description: '',
  tags: [],
  active: false,
  archived: false,
};

describe('move', () => {
  it('posts the destination verbatim to the move route and reads the summary back', async () => {
    const { transport, sent } = answering(200, { node });

    const result = await move(transport, {
      target: { id: 7 },
      revision: 8,
      destination: { path: '/engineering/platform' },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.node.revision, 9);
      assert.equal(result.value.node.parentId, 3);
    }

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.url ?? '', /\/api\/nodes\/move$/);
    assert.deepEqual(sent[0]?.body, {
      target: { id: 7 },
      revision: 8,
      destination: { path: '/engineering/platform' },
    });
  });

  it('sends an explicit parent and new slug as given', async () => {
    const { transport, sent } = answering(200, { node });

    const result = await move(transport, {
      target: { path: '/work/backend' },
      revision: 8,
      destination: { parent: { id: 3 }, slug: 'platform' },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(sent[0]?.body, {
      target: { path: '/work/backend' },
      revision: 8,
      destination: { parent: { id: 3 }, slug: 'platform' },
    });
  });

  it('refuses a malformed destination before anything is sent', async () => {
    const { transport, sent } = answering(200, { node });

    const result = await move(transport, {
      target: { id: 7 },
      revision: 8,
      destination: { path: 'relative' },
    });

    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'invalid_request') {
      assert.equal(result.failure.mutationOutcome, 'not_dispatched');
      assert.equal(result.failure.path[0], 'destination');
    } else {
      assert.fail('expected an invalid_request failure');
    }
    assert.equal(sent.length, 0);
  });

  it('refuses an answer that is not a move response', async () => {
    const { transport } = answering(200, { entity: node });

    const result = await move(transport, {
      target: { id: 7 },
      revision: 8,
      destination: { path: '/engineering' },
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'invalid_response');
  });

  it('reports a revision conflict as a definite rejection with the revision to re-read', async () => {
    const { transport } = answering(409, {
      error: {
        code: 'revision_conflict',
        message: 'This was changed since you read it.',
        details: { field: 'revision', currentRevision: 12 },
      },
    });

    const result = await move(transport, {
      target: { id: 7 },
      revision: 8,
      destination: { path: '/engineering' },
    });

    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'api_error') {
      assert.equal(result.failure.mutationOutcome, 'rejected');
      assert.equal(result.failure.status, 409);
      assert.equal(result.failure.details.currentRevision, 12);
    } else {
      assert.fail('expected an api_error failure');
    }
  });

  it('carries a cycle refusal with its reason and field', async () => {
    const { transport } = answering(422, {
      error: {
        code: 'invalid_parent',
        message: 'Something cannot be moved inside itself.',
        details: {
          field: 'destination',
          reason: 'cycle',
          parentType: 'project',
          childType: 'area',
        },
      },
    });

    const result = await move(transport, {
      target: { id: 7 },
      revision: 8,
      destination: { path: '/work/backend/inner' },
    });

    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'api_error') {
      assert.equal(result.failure.mutationOutcome, 'rejected');
      assert.equal(result.failure.error.code, 'invalid_parent');
      assert.equal(result.failure.details.reason, 'cycle');
      assert.equal(result.failure.details.field, 'destination');
    } else {
      assert.fail('expected an api_error failure');
    }
  });

  it('leaves a socket that dies after dispatch unresolved', async () => {
    const transport = transportOver(() => Promise.reject(new TypeError('fetch failed')));

    const result = await move(transport, {
      target: { id: 7 },
      revision: 8,
      destination: { path: '/engineering' },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'transport');
      assert.equal(result.failure.mutationOutcome, 'unknown');
    }
  });
});

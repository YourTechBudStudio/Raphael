import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTransport, type FetchLike, type Transport } from '../shared/transport.ts';
import { move } from './index.ts';

/**
 * What `move` establishes, and what it leaves to the server.
 *
 * Driven through the real transport with a stubbed `fetch`, as `update.test.ts` is. The destination is
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
  isFavorite: false,
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
    if (!result.ok) assert.equal(result.failure.kind, 'invalid_request');
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
    if (!result.ok) assert.equal(result.failure.kind, 'bad_response');
  });

  it('carries a refusal as the server code and sentence', async () => {
    const { transport } = answering(422, {
      error: { code: 'invalid_parent', message: 'Something cannot be moved inside itself.' },
    });

    const result = await move(transport, {
      target: { id: 7 },
      revision: 8,
      destination: { path: '/work/backend/inner' },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'http');
      assert.equal(result.failure.code, 'invalid_parent');
      assert.equal(result.failure.message, 'Something cannot be moved inside itself.');
    }
  });

  it('reports a socket that dies after dispatch as a network failure', async () => {
    const transport = transportOver(() => Promise.reject(new TypeError('fetch failed')));

    const result = await move(transport, {
      target: { id: 7 },
      revision: 8,
      destination: { path: '/engineering' },
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'network');
  });
});

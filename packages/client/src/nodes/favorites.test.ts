import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTransport, type FetchLike, type Transport } from '../shared/transport.ts';
import { addFavorite, listFavorites, removeFavorite } from './index.ts';

/**
 * What the three favorites functions establish: the route, the strict request, and an answer decoded
 * against the shared contract. Driven through the real transport with a stubbed `fetch`, as
 * `lifecycle.test.ts` is.
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

const summary = {
  id: 7,
  type: 'project',
  kind: null,
  parentId: 3,
  slug: 'backend',
  revision: 10,
  title: 'Backend',
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: true,
};

describe('favorites', () => {
  it('add and remove post the selector to their own routes and read the resulting state back', async () => {
    const added = answering(200, { nodeId: 7, isFavorite: true });
    const result = await addFavorite(added.transport, { target: { path: '/work/backend' } });
    assert.deepEqual(result, { ok: true, value: { nodeId: 7, isFavorite: true } });
    assert.deepEqual(added.sent, [
      {
        url: 'http://127.0.0.1:1/api/favorites/add',
        body: { target: { path: '/work/backend' } },
      },
    ]);

    const removed = answering(200, { nodeId: 7, isFavorite: false });
    const gone = await removeFavorite(removed.transport, { target: { id: 7 } });
    assert.deepEqual(gone, { ok: true, value: { nodeId: 7, isFavorite: false } });
    assert.deepEqual(removed.sent, [
      { url: 'http://127.0.0.1:1/api/favorites/remove', body: { target: { id: 7 } } },
    ]);
  });

  it('list posts the decoded window, defaults included, and reads an ordinary page', async () => {
    const page = { items: [summary], skip: 0, limit: 50, hasMore: false };
    const { transport, sent } = answering(200, page);
    const result = await listFavorites(transport, {});
    assert.deepEqual(result, { ok: true, value: page });
    assert.deepEqual(sent, [
      { url: 'http://127.0.0.1:1/api/favorites/list', body: { skip: 0, limit: 50 } },
    ]);
  });

  it('refuse an answer that contradicts the request', async () => {
    const { transport } = answering(200, { nodeId: 7, isFavorite: false });
    const result = await addFavorite(transport, { target: { id: 7 } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'invalid_response');
  });

  it('refuse a malformed request before sending it', async () => {
    const { transport, sent } = answering(200, {});
    for (const result of [
      await addFavorite(transport, { target: { path: '/' } }),
      await removeFavorite(transport, { target: { path: '/' } }),
    ]) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.failure.kind, 'invalid_request');
        assert.equal(result.failure.mutationOutcome, 'not_dispatched');
      }
    }
    const window = await listFavorites(transport, { limit: 0 });
    assert.equal(window.ok, false);
    if (!window.ok) assert.equal(window.failure.kind, 'invalid_request');
    assert.deepEqual(sent, []);
  });

  it('leave a lost add or remove unresolved, since either may have happened', async () => {
    const transport = transportOver(() => Promise.reject(new TypeError('fetch failed')));
    for (const result of [
      await addFavorite(transport, { target: { id: 7 } }),
      await removeFavorite(transport, { target: { id: 7 } }),
    ]) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.failure.kind, 'transport');
        assert.equal(result.failure.mutationOutcome, 'unknown');
      }
    }
  });
});

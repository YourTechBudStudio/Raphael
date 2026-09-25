import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTransport, type FetchLike, type Transport } from '../shared/transport.ts';
import { archive, restore } from './index.ts';

/**
 * What `archive` and `restore` establish: the route, the strict request, and a response whose status
 * and causes must agree. Driven through the real transport with a stubbed `fetch`, as `move.test.ts`
 * is.
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

const node = (archived: boolean) => ({
  id: 7,
  type: 'project',
  kind: null,
  parentId: 3,
  slug: 'backend',
  revision: 10,
  title: 'Backend',
  description: '',
  tags: [],
  active: true,
  archived,
});

const inherited = {
  origin: { id: 3, type: 'area', title: 'Work' },
  owner: 'user',
  reason: 'direct',
};

describe('archive and restore', () => {
  it('post the selector and revision to their own routes and read the resulting state back', async () => {
    const archived = answering(200, {
      node: node(true),
      archiveCauses: [{ ...inherited, origin: { id: 7, type: 'project', title: 'Backend' } }],
    });
    const result = await archive(archived.transport, { target: { id: 7 }, revision: 9 });
    assert.equal(result.ok, true);
    assert.deepEqual(archived.sent, [
      { url: 'http://127.0.0.1:1/api/nodes/archive', body: { target: { id: 7 }, revision: 9 } },
    ]);

    // A restore that leaves the node archived through its area is a success that says so.
    const still = answering(200, { node: node(true), archiveCauses: [inherited] });
    const restored = await restore(still.transport, { target: { id: 7 }, revision: 10 });
    assert.equal(restored.ok, true);
    if (restored.ok) {
      assert.equal(restored.value.node.archived, true);
      assert.deepEqual(restored.value.archiveCauses, [inherited]);
    }
    assert.equal(still.sent[0]?.url, 'http://127.0.0.1:1/api/nodes/restore');
  });

  it('refuse a response whose status contradicts its causes', async () => {
    const { transport } = answering(200, { node: node(false), archiveCauses: [inherited] });
    const result = await restore(transport, { target: { id: 7 }, revision: 10 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'invalid_response');
  });

  it('refuse a malformed request before sending it', async () => {
    const { transport, sent } = answering(200, {});
    const result = await archive(transport, { target: { path: '/' }, revision: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'invalid_request');
    assert.deepEqual(sent, []);
  });
});

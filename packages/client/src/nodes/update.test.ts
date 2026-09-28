import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTransport, type FetchLike, type Transport } from '../shared/transport.ts';
import { update } from './index.ts';

/** Driven through the real transport with a stubbed `fetch`, so request and response decoding are real. */

const KEY = 'a'.repeat(32);

const transportOver = (fetchImpl: FetchLike): Transport =>
  createTransport({
    endpoint: 'http://127.0.0.1:1/',
    apiKey: KEY,
    fetch: fetchImpl,
  }) as Transport;

/** The last request body this stub was handed, so a test can assert what actually travelled. */
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

const entity = {
  id: 7,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: 'contracts',
  revision: 9,
  title: 'Contracts',
  description: '',
  tags: ['reviewed'],
  active: false,
  archived: false,
  isFavorite: false,
  body: { format: 'markdown', value: '# Contracts\n' },
  metadata: {},
  archiveCauses: [],
};

describe('update', () => {
  it('posts the decoded envelope to the update route and reads a 200 back', async () => {
    const { transport, sent } = answering(200, { entity });

    const result = await update(transport, {
      target: { id: 7 },
      revision: 8,
      title: 'Contracts',
      tags: ['reviewed'],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entity.revision, 9);
      assert.deepEqual(result.value.entity.tags, ['reviewed']);
    }

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.url ?? '', /\/api\/nodes\/update$/);
    // `format` is defaulted by the contract, so what travels is the decoded value rather than the
    // caller's object. Everything else is exactly what was asked for, and nothing else is present:
    // identity, parentage and metadata are unpatchable because the envelope has no field for them.
    assert.deepEqual(sent[0]?.body, {
      target: { id: 7 },
      revision: 8,
      title: 'Contracts',
      tags: ['reviewed'],
      format: 'markdown',
    });
  });

  it('refuses an envelope with no change field before anything is sent', async () => {
    const { transport, sent } = answering(200, { entity });

    const result = await update(transport, { target: { id: 7 }, revision: 8 });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'invalid_request');
    }
    assert.equal(sent.length, 0);
  });

  it('reports a revision conflict with the server code and sentence', async () => {
    const { transport } = answering(409, {
      error: {
        code: 'revision_conflict',
        message: 'This changed on the server. It is now at revision 12.',
      },
    });

    const result = await update(transport, { target: { id: 7 }, revision: 8, title: 'Contracts' });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.failure, {
        kind: 'http',
        status: 409,
        code: 'revision_conflict',
        message: 'This changed on the server. It is now at revision 12.',
      });
    }
  });

  it('reports a socket that dies after dispatch as a network failure', async () => {
    const transport = transportOver(() => Promise.reject(new TypeError('fetch failed')));

    const result = await update(transport, { target: { id: 7 }, revision: 8, title: 'Contracts' });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'network');
  });
});

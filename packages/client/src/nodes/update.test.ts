import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTransport, type FetchLike, type Transport } from '../shared/transport.ts';
import { update } from './index.ts';

/**
 * What `update` establishes, and what it refuses to establish.
 *
 * Driven through the real transport with a stubbed `fetch` rather than a hand-rolled `Transport`.
 * The interesting half of this operation is not that it posts to a route - it is that a 409
 * `revision_conflict` becomes a *definite* refusal carrying a validated `currentRevision`, and that
 * a socket that dies after dispatch does not. Both of those are decided inside `transport.ts`, so a
 * fake transport would assert nothing about either. A stubbed `fetch` keeps real request decoding,
 * real response decoding and real error classification, and needs no socket.
 */

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
  body: { format: 'markdown', value: '# Contracts\n' },
  metadata: {},
};

describe('update', () => {
  it('posts the decoded envelope to the update route and reads a 200 back', async () => {
    const { transport, sent } = answering(200, { entity });

    const result = await update(transport, {
      target: { id: 7 },
      revision: 8,
      title: 'Contracts',
      addTags: ['reviewed'],
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
      addTags: ['reviewed'],
      format: 'markdown',
    });
  });

  it('refuses an envelope with no change field before anything is sent', async () => {
    const { transport, sent } = answering(200, { entity });

    const result = await update(transport, { target: { id: 7 }, revision: 8 });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'invalid_request');
      assert.equal(result.failure.mutationOutcome, 'not_dispatched');
    }
    assert.equal(sent.length, 0);
  });

  it('reports a revision conflict as a definite rejection with the revision to re-read', async () => {
    const { transport } = answering(409, {
      error: {
        code: 'revision_conflict',
        message: 'This was changed since you read it.',
        details: { field: 'revision', currentRevision: 12 },
      },
    });

    const result = await update(transport, { target: { id: 7 }, revision: 8, title: 'Contracts' });

    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'api_error') {
      // Nothing was written: the server's compare-and-set matched no row and said so at the status
      // it documents. This is the one thing the CLI's "do not retry" rule rests on.
      assert.equal(result.failure.mutationOutcome, 'rejected');
      assert.equal(result.failure.status, 409);
      assert.equal(result.failure.error.code, 'revision_conflict');
      assert.equal(result.failure.details.currentRevision, 12);
      // A definite refusal keeps the server's own sentence, which is the useful thing to show.
      assert.match(result.failure.message, /changed since you read it/);
    } else {
      assert.fail('expected an api_error failure');
    }
  });

  it('drops a currentRevision that is not a usable revision rather than carrying it', async () => {
    // The projection validates what it publishes. A server that answered `"12"` or `-1` would
    // otherwise put an unusable number into a `--revision` suggestion.
    const { transport } = answering(409, {
      error: {
        code: 'revision_conflict',
        message: 'This was changed since you read it.',
        details: { field: 'revision', currentRevision: '12' },
      },
    });

    const result = await update(transport, { target: { id: 7 }, revision: 8, title: 'Contracts' });
    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === 'api_error') {
      assert.equal(result.failure.details.currentRevision, undefined);
      assert.equal(result.failure.mutationOutcome, 'rejected');
    } else {
      assert.fail('expected an api_error failure');
    }
  });

  it('leaves a socket that dies after dispatch unresolved', async () => {
    const transport = transportOver(() => Promise.reject(new TypeError('fetch failed')));

    const result = await update(transport, { target: { id: 7 }, revision: 8, title: 'Contracts' });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'transport');
      // An update has no idempotency key and no replay, so this is the end of what the client can
      // say. Settling it is a read, and that belongs to the caller.
      assert.equal(result.failure.mutationOutcome, 'unknown');
    }
  });
});

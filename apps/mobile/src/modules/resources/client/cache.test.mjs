/**
 * What a write is allowed to do to what is cached.
 *
 * One property, and it goes wrong silently when it goes wrong: a refresh that reaches beyond its own
 * connection talks to caches read through a transport that no longer exists.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { scopeKey } from '../../../infrastructure/query/keys.ts';
import { invalidateResources, invalidateSessionMedia } from './cache.ts';
import { containerDescriptor, feedDescriptor, noteListKey } from './requests.ts';

const MEDIA_KEY = (activation) => scopeKey(activation, 'session-media');

const seeded = () => {
  const client = new QueryClient();

  client.setQueryData(noteListKey(1, feedDescriptor(0)), { pages: [], pageParams: [] });
  client.setQueryData(noteListKey(1, containerDescriptor(7, 0)), { pages: [], pageParams: [] });
  client.setQueryData(noteListKey(2, feedDescriptor(0)), { pages: [], pageParams: [] });
  client.setQueryData(MEDIA_KEY(1), []);
  client.setQueryData(scopeKey(1, 'hierarchy'), { roots: [] });

  return client;
};

const staleKeys = (client) =>
  client
    .getQueryCache()
    .findAll({ stale: true })
    .map((query) => JSON.stringify(query.queryKey));

describe('invalidating the notes this connection read', () => {
  it('covers Home and every container list under that activation', async () => {
    const client = seeded();
    await invalidateResources(client, 1);
    const stale = staleKeys(client);

    assert.ok(stale.includes(JSON.stringify(noteListKey(1, feedDescriptor(0)))));
    assert.ok(stale.includes(JSON.stringify(noteListKey(1, containerDescriptor(7, 0)))));
  });

  it('leaves another connection’s notes alone', async () => {
    const client = seeded();
    await invalidateResources(client, 1);

    assert.ok(!staleKeys(client).includes(JSON.stringify(noteListKey(2, feedDescriptor(0)))));
  });

  it('leaves this connection’s other caches alone', async () => {
    const client = seeded();
    await invalidateResources(client, 1);
    const stale = staleKeys(client);

    // Media has no server operation and the hierarchy holds no notes; a note write is not news to
    // either, and marking them stale would spend two reads to learn nothing.
    assert.ok(!stale.includes(JSON.stringify(MEDIA_KEY(1))));
    assert.ok(!stale.includes(JSON.stringify(scopeKey(1, 'hierarchy'))));
  });
});

describe('invalidating this session’s media', () => {
  it('touches the media of that activation and nothing else', async () => {
    const client = seeded();
    await invalidateSessionMedia(client, 1);
    const stale = staleKeys(client);

    assert.deepEqual(stale, [JSON.stringify(MEDIA_KEY(1))]);
  });
});

/**
 * What a write is allowed to do to what is cached.
 *
 * Two properties, both of which go wrong silently when they go wrong. A refresh that reaches beyond
 * its own connection talks to caches read through a transport that no longer exists. And a seed that
 * overwrites can replace a current note with an older copy of itself, because a create response may
 * be the replay of an attempt answered days ago.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { scopeKey } from '../../../infrastructure/query/keys.ts';
import { invalidateResources, invalidateSessionMedia, seedNoteDetail } from './cache.ts';
import { containerDescriptor, feedDescriptor, noteEntityKey, noteListKey } from './requests.ts';

const MEDIA_KEY = (activation) => scopeKey(activation, 'session-media');

const entity = (id, revision) => ({
  id,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: `note-${String(id)}`,
  revision,
  title: `Note ${String(id)}`,
  description: '',
  tags: [],
  body: { format: 'tiptap', value: { type: 'doc', content: [] } },
  metadata: {},
});

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

describe('seeding a created note', () => {
  it('records it where nothing is recorded', () => {
    const client = new QueryClient();
    seedNoteDetail(client, 1, entity(12, 1));

    assert.equal(client.getQueryData(noteEntityKey(1, 12)).revision, 1);
  });

  it('never overwrites a reading already held', () => {
    // The create response can be a replay of an attempt answered days ago. Writing it over a cached
    // reading would replace the current note with an older snapshot of itself.
    const client = new QueryClient();
    client.setQueryData(noteEntityKey(1, 12), entity(12, 7));
    seedNoteDetail(client, 1, entity(12, 1));

    assert.equal(client.getQueryData(noteEntityKey(1, 12)).revision, 7);
  });

  it('files it under the activation it was created by', () => {
    const client = new QueryClient();
    seedNoteDetail(client, 2, entity(12, 1));

    assert.equal(client.getQueryData(noteEntityKey(1, 12)), undefined);
    assert.notEqual(client.getQueryData(noteEntityKey(2, 12)), undefined);
  });
});

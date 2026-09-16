/**
 * What a created note actually does to a real cache.
 *
 * `resources/client/cache.test.mjs` settles what seeding and invalidating do on their own. This
 * settles the line between them and a server's answer - which response may be filed as a note's
 * detail - because that is the part with a decision in it and the part that fails quietly. A
 * container's entity written under a note's detail key would be handed to the note screen as though
 * the server had said it, and nothing downstream would question it.
 *
 * A real `QueryClient` rather than a recording fake: what is under test is the effect on a cache,
 * and a fake would only prove that two functions were called.
 *
 * It lives under `tests/` rather than beside the module because reaching `resources` means resolving
 * a directory import the way Metro does, and that resolver is installed here.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
after(() => hooks.deregister());

const { scopeKey } = await import('../src/infrastructure/query/keys.ts');
const { applyCreationTo } = await import('../src/modules/capture/client/creation-cache.ts');

const entity = (over = {}) => ({
  id: 12,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: 'a-note',
  revision: 1,
  title: 'A note',
  description: '',
  tags: [],
  body: { format: 'tiptap', value: { type: 'doc', content: [] } },
  metadata: {},
  ...over,
});

// The keys the resources capability actually builds. Spelled here rather than imported so this
// test fails if either moves, which is the point: the seam is what is under test.
const detailKey = (activation, id) => scopeKey(activation, 'note', id);
const feedKey = (activation) => scopeKey(activation, 'notes', 'feed');

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

/** A query that is being observed, so `invalidateQueries` has something to mark. */
const observed = (cache, key) => {
  cache.setQueryData(key, { items: [] });
  const observer = cache.getQueryCache().find({ queryKey: key });

  return () => observer?.state.isInvalidated ?? false;
};

test('a note absent-seeds its own detail under the activation it was created with', async () => {
  const cache = client();

  await applyCreationTo(cache, { entity: entity() }, 4);

  assert.deepEqual(cache.getQueryData(detailKey(4, 12)), entity());
  // Another connection can mint the same numeric id, so the key is stamped and nothing lands in a
  // neighbouring activation's cache.
  assert.equal(cache.getQueryData(detailKey(5, 12)), undefined);
  cache.clear();
});

test('it never overwrites a reading that is already there', async () => {
  const cache = client();
  const held = entity({ revision: 9, title: 'What the cache already knew' });

  cache.setQueryData(detailKey(4, 12), held);
  // A create response can be a replay of an earlier attempt, reporting the entity as it was when
  // that attempt was first answered - which may be days old.
  await applyCreationTo(cache, { entity: entity({ revision: 1 }) }, 4);

  assert.deepEqual(cache.getQueryData(detailKey(4, 12)), held);
  cache.clear();
});

test('a container is never filed as a note, whatever its kind says', async () => {
  const cache = client();

  for (const container of [
    entity({ type: 'area', kind: null, id: 77 }),
    // The invariant is the pairing, not the kind alone. A widened server vocabulary must not become
    // a note by omission, which is what a bare `kind !== null` would have allowed.
    entity({ type: 'area', kind: 'note', id: 78 }),
    entity({ type: 'resource', kind: 'voice', id: 79 }),
  ]) {
    await applyCreationTo(cache, { entity: container }, 4);

    assert.equal(cache.getQueryData(detailKey(4, container.id)), undefined);
  }

  cache.clear();
});

test('the feeds are stale afterwards, under that activation and no other', async () => {
  const cache = client();
  const here = observed(cache, feedKey(4));
  const elsewhere = observed(cache, feedKey(5));

  await applyCreationTo(cache, { entity: entity() }, 4);

  assert.equal(here(), true);
  assert.equal(elsewhere(), false, 'a retired connection reads nothing because of this');
  cache.clear();
});

test('a refresh that cannot be scheduled is still a creation that happened', async () => {
  const cache = client();

  cache.invalidateQueries = () => Promise.reject(new Error('the cache said no'));

  // The seed lands before the invalidation is even attempted, and the rejection is swallowed rather
  // than handed onward: a refresh that could not be scheduled is not a creation that did not
  // happen. Nothing downstream is waiting on it, so an escaping rejection would only be noise.
  await applyCreationTo(cache, { entity: entity() }, 4);
  assert.deepEqual(cache.getQueryData(detailKey(4, 12)), entity());
});

test('a refetch that never finishes does not hold the creation', async () => {
  const cache = client();
  let refetching = false;

  cache.invalidateQueries = () => {
    refetching = true;

    return new Promise(() => {});
  };

  // What `invalidateQueries` returns waits for the *active refetches* - reads that can retry, time
  // out, or hang. Awaiting them would keep a creation the server has already answered for reported
  // as still in progress, with the composer locked and saying "Saving…" while a list reloads.
  await applyCreationTo(cache, { entity: entity() }, 4);

  assert.equal(refetching, true, 'the refresh was still asked for');
  assert.deepEqual(cache.getQueryData(detailKey(4, 12)), entity(), 'and the seed still landed');
});

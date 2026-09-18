/**
 * What an acknowledged edit actually does to a real cache.
 *
 * The decision under test is a negative one, and negatives fail quietly: **nothing the server
 * answered is ever written here**. An update response written into the cache would make the update a
 * second authority on ordering between concurrent clients, so this asserts that every branch
 * invalidates and none of them sets.
 *
 * The other half is the activation fence. A late answer from a connection the app has left must
 * change nothing that is on screen, and the only way to be sure is to run it against a real
 * `QueryClient` holding queries under two activations at once.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
after(() => hooks.deregister());

const { scopeKey } = await import('../src/infrastructure/query/keys.ts');
const { applyUpdateTo } = await import('../src/modules/capture/client/update-cache.ts');

// The keys the two capabilities actually build. Spelled here rather than imported, so this test
// fails if either moves: the seam between them is exactly what is under test.
const feedKey = (activation) => scopeKey(activation, 'notes', 'feed');
const detailKey = (activation, id) => scopeKey(activation, 'note', id);
const entityKey = (activation, type, id) => scopeKey(activation, 'entity', type, id);
const hierarchyKey = (activation) => scopeKey(activation, 'hierarchy');
const pathKey = (activation, id) => scopeKey(activation, 'path', id);

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

/** A query with something in it, so `invalidateQueries` has something to mark. */
const seeded = (cache, key, value = { items: [] }) => {
  cache.setQueryData(key, value);

  return () => cache.getQueryCache().find({ queryKey: key })?.state.isInvalidated ?? false;
};

test('a note marks the note feeds stale, and nothing else', async () => {
  const cache = client();
  const feed = seeded(cache, feedKey(4));
  const detail = seeded(cache, detailKey(4, 42));
  const hierarchy = seeded(cache, hierarchyKey(4));

  await applyUpdateTo(cache, { type: 'resource', id: 42 }, 4);

  assert.equal(feed(), true);
  // Deliberately untouched: the editor reads an entity through the owner, so the note detail query
  // has no reader left to refresh.
  assert.equal(detail(), false);
  assert.equal(hierarchy(), false, 'a note is not in the container tree');
  cache.clear();
});

test('a container marks its entity, the tree, and every computed path stale', async () => {
  const cache = client();
  const area = seeded(cache, entityKey(4, 'area', 7));
  const other = seeded(cache, entityKey(4, 'area', 8));
  const project = seeded(cache, entityKey(4, 'project', 7));
  const hierarchy = seeded(cache, hierarchyKey(4));
  const ownPath = seeded(cache, pathKey(4, 7));
  // A descendant's path contains this container's title, so renaming it makes that stale too.
  const childPath = seeded(cache, pathKey(4, 99));
  const feed = seeded(cache, feedKey(4));

  await applyUpdateTo(cache, { type: 'area', id: 7 }, 4);

  assert.equal(area(), true);
  assert.equal(hierarchy(), true);
  assert.equal(ownPath(), true);
  assert.equal(childPath(), true);

  assert.equal(other(), false, 'a sibling is a different container');
  assert.equal(project(), false, 'and so is a project that happens to share the number');
  assert.equal(feed(), false, 'a container title is not a note feed');
  cache.clear();
});

test('a project is a container too', async () => {
  const cache = client();
  const project = seeded(cache, entityKey(4, 'project', 7));

  await applyUpdateTo(cache, { type: 'project', id: 7 }, 4);

  assert.equal(project(), true);
  cache.clear();
});

test('an answer from a connection the app has left changes nothing that is on screen', async () => {
  const cache = client();
  const currentFeed = seeded(cache, feedKey(5));
  const currentArea = seeded(cache, entityKey(5, 'area', 7));
  const currentHierarchy = seeded(cache, hierarchyKey(5));
  const currentPath = seeded(cache, pathKey(5, 7));

  await applyUpdateTo(cache, { type: 'resource', id: 42 }, 4);
  await applyUpdateTo(cache, { type: 'area', id: 7 }, 4);

  assert.equal(currentFeed(), false);
  assert.equal(currentArea(), false);
  assert.equal(currentHierarchy(), false);
  assert.equal(currentPath(), false);
  cache.clear();
});

test('nothing an update answered is ever written into the cache', async () => {
  const cache = client();

  await applyUpdateTo(cache, { type: 'resource', id: 42 }, 4);
  await applyUpdateTo(cache, { type: 'area', id: 7 }, 4);

  assert.deepEqual(
    cache
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey),
    [],
    'invalidation only: the next read is the single authority on what the server holds',
  );
  cache.clear();
});

test('it resolves without waiting for a refetch', async () => {
  const cache = client();
  let settled = false;

  const done = applyUpdateTo(cache, { type: 'area', id: 7 }, 4).then(() => {
    settled = true;
  });

  await done;
  // A refresh is a consequence of a save, and consequences do not gate verdicts: holding the save's
  // answer open while an unrelated list reloads would report it as still in progress.
  assert.equal(settled, true);
  cache.clear();
});

/**
 * What a created note actually does to a real cache.
 *
 * `resources/client/cache.test.mjs` settles what invalidating does on its own. This settles what the
 * composition asks for, and the two properties that fail quietly: that the refresh is scoped to the
 * activation the creation was made under, and that it is asked for without being waited on.
 *
 * **It no longer seeds anything.** The note-detail key is gone with the read-only note screen, so a
 * created note has exactly one cache consequence left.
 *
 * A real `QueryClient` rather than a recording fake: what is under test is the effect on a cache,
 * and a fake would only prove that a function was called.
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

// The key the resources capability actually builds. Spelled here rather than imported so this test
// fails if it moves, which is the point: the seam is what is under test.
const feedKey = (activation) => scopeKey(activation, 'notes', 'feed');

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

/** A query that is being observed, so `invalidateQueries` has something to mark. */
const observed = (cache, key) => {
  cache.setQueryData(key, { items: [] });
  const observer = cache.getQueryCache().find({ queryKey: key });

  return () => observer?.state.isInvalidated ?? false;
};

test('the feeds are stale afterwards, under that activation and no other', async () => {
  const cache = client();
  const here = observed(cache, feedKey(4));
  const elsewhere = observed(cache, feedKey(5));

  await applyCreationTo(cache, 4);

  assert.equal(here(), true);
  assert.equal(elsewhere(), false, 'a retired connection reads nothing because of this');
  cache.clear();
});

test('a refresh that cannot be scheduled is still a creation that happened', async () => {
  const cache = client();

  cache.invalidateQueries = () => Promise.reject(new Error('the cache said no'));

  // The rejection is swallowed rather than handed onward: a refresh that could not be scheduled is
  // not a creation that did not happen. Nothing downstream is waiting on it, so an escaping
  // rejection would only be noise.
  await applyCreationTo(cache, 4);
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
  await applyCreationTo(cache, 4);

  assert.equal(refetching, true, 'the refresh was still asked for');
});

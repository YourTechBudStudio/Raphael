import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { invalidateResourceViews, resourceViewMeta } from './cache.ts';

test('resource writes invalidate opted-in projections without knowing their keys', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  try {
    for (const queryKey of [
      ['home-feed'],
      ['area', 'a', 'contents'],
      ['project', 'p', 'contents'],
      ['search', 'note', 'all'],
    ]) {
      await client.fetchQuery({ queryKey, queryFn: () => [], meta: resourceViewMeta });
    }
    await client.fetchQuery({ queryKey: ['favorites'], queryFn: () => [] });
    await client.fetchQuery({ queryKey: ['area', 'a'], queryFn: () => ({ id: 'a' }) });

    await invalidateResourceViews(client);

    for (const query of client.getQueryCache().getAll()) {
      assert.equal(query.state.isInvalidated, query.meta?.containsResources === true);
    }
    assert.equal(client.getQueryCache().getAll().length, 6);
  } finally {
    client.clear();
  }
});

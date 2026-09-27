/**
 * Naming a row's parent for its pill, or declining to.
 *
 * The pill draws the parent's kind and title, so the lookup answers both - but only from a
 * hierarchy that has loaded and is current. A stale tree may name a container the node has since
 * left, and a pill has nowhere to say it is a guess, so it answers nothing then, exactly as
 * `containerTitleLookup` does.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();

const { fetchHierarchy } = await import('../src/modules/collections/client/hierarchy.ts');
const { containerLookup } = await import('../src/modules/collections/hierarchy.ts');

after(() => {
  hooks.deregister();
});

const node = (id, type, parentId, title) => ({
  id,
  type,
  kind: null,
  parentId,
  slug: title.toLowerCase(),
  revision: 1,
  title,
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: false,
});

const hierarchy = await fetchHierarchy((request) =>
  Promise.resolve({
    ok: true,
    value: {
      items: [node(1, 'area', null, 'Work'), node(12, 'project', 1, 'Auth rework')],
      skip: request.skip,
      limit: request.limit,
      hasMore: false,
    },
  }),
);

/** A hierarchy read as `useHierarchy` reports it. */
const tree = (over = {}) => ({
  hierarchy,
  isPending: false,
  isError: false,
  isFetching: false,
  isStale: false,
  refusal: null,
  refetch: () => undefined,
  ...over,
});

describe('containerLookup', () => {
  it('answers the kind, id and title of a container in a loaded tree', () => {
    const lookup = containerLookup(tree());

    assert.deepEqual(lookup(1), { type: 'area', id: 1, title: 'Work' });
    assert.deepEqual(lookup(12), { type: 'project', id: 12, title: 'Auth rework' });
  });

  it('answers nothing for a container the tree does not hold', () => {
    assert.equal(containerLookup(tree())(99), undefined);
  });

  it('answers nothing while the tree has not loaded', () => {
    assert.equal(containerLookup(tree({ hierarchy: undefined, isPending: true }))(1), undefined);
  });

  it('answers nothing from a tree kept after a failed refresh', () => {
    assert.equal(containerLookup(tree({ isStale: true, isError: true }))(1), undefined);
  });
});

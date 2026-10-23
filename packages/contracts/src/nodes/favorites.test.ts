import assert from 'node:assert/strict';
import test from 'node:test';

import { Either } from 'effect';

import {
  decodeAddFavoriteResponse,
  decodeFavoriteListRequest,
  decodeFavoriteRequest,
  decodeRemoveFavoriteResponse,
} from './favorites.ts';
import { LIST_LIMIT_MAX } from './fields.ts';

const summary = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 3,
  type: 'area',
  kind: null,
  parentId: null,
  slug: 'work',
  revision: 1,
  title: 'Work',
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: true,
  updatedAt: '2026-10-19T10:42:07.123Z',
  ...overrides,
});

test('a favorite request names one node by id or by path, and nothing else', () => {
  assert.deepEqual(Either.getOrUndefined(decodeFavoriteRequest({ target: { id: 3 } })), {
    target: { id: 3 },
    includePaths: false,
  });
  assert.equal(Either.isRight(decodeFavoriteRequest({ target: { path: '/work' } })), true);
  assert.deepEqual(
    Either.getOrUndefined(decodeFavoriteRequest({ target: { id: 3 }, includePaths: true })),
    { target: { id: 3 }, includePaths: true },
  );

  // The root is not a node, so it cannot be a favorite.
  assert.equal(Either.isLeft(decodeFavoriteRequest({ target: { path: '/' } })), true);
  assert.equal(Either.isLeft(decodeFavoriteRequest({ target: { id: 3, path: '/work' } })), true);
  assert.equal(Either.isLeft(decodeFavoriteRequest({ target: { id: 3 }, revision: 1 })), true);
  assert.equal(Either.isLeft(decodeFavoriteRequest({ nodeId: 3 })), true);
});

test('an add or remove answer states the resulting membership, and a contradiction is refused', () => {
  const added = { nodeId: 3, isFavorite: true, changed: true, node: summary() };
  assert.equal(Either.isRight(decodeAddFavoriteResponse(added)), true);
  assert.equal(Either.isLeft(decodeAddFavoriteResponse({ ...added, isFavorite: false })), true);
  assert.equal(Either.isLeft(decodeAddFavoriteResponse({ ...added, nodeId: 0 })), true);
  // Add always resolved its target, so it always names it.
  assert.equal(Either.isLeft(decodeAddFavoriteResponse({ ...added, node: null })), true);
  assert.equal(
    Either.isLeft(decodeAddFavoriteResponse({ nodeId: 3, isFavorite: true, node: summary() })),
    true,
  );

  const removed = {
    nodeId: 3,
    isFavorite: false,
    changed: true,
    node: summary({ isFavorite: false }),
  };
  assert.equal(Either.isRight(decodeRemoveFavoriteResponse(removed)), true);
  assert.equal(Either.isLeft(decodeRemoveFavoriteResponse({ ...removed, isFavorite: true })), true);
  // An id that names nothing: absence was the result asked for, so it is still an answer.
  assert.equal(
    Either.isRight(
      decodeRemoveFavoriteResponse({ nodeId: 9, isFavorite: false, changed: false, node: null }),
    ),
    true,
  );
});

test('the favorites list takes the ordinary page window, with its defaults and bounds', () => {
  const defaults = { includeArchived: false, includePaths: false };
  assert.deepEqual(Either.getOrUndefined(decodeFavoriteListRequest({})), {
    skip: 0,
    limit: 50,
    ...defaults,
  });
  assert.deepEqual(Either.getOrUndefined(decodeFavoriteListRequest({ skip: 5, limit: 500 })), {
    skip: 5,
    limit: 500,
    ...defaults,
  });
  assert.deepEqual(
    Either.getOrUndefined(decodeFavoriteListRequest({ includeArchived: true, includePaths: true })),
    { skip: 0, limit: 50, includeArchived: true, includePaths: true },
  );
  for (const window of [
    { limit: 0 },
    { limit: LIST_LIMIT_MAX + 1 },
    { skip: -1 },
    { skip: 1.5 },
    { limit: 2.5 },
    { limit: '10' },
    { includeArchived: 'yes' },
    { recursive: true },
  ]) {
    assert.equal(Either.isLeft(decodeFavoriteListRequest(window)), true, JSON.stringify(window));
  }
});

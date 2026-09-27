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

test('a favorite request names one node by id or by path, and nothing else', () => {
  assert.deepEqual(Either.getOrUndefined(decodeFavoriteRequest({ target: { id: 3 } })), {
    target: { id: 3 },
  });
  assert.equal(Either.isRight(decodeFavoriteRequest({ target: { path: '/work' } })), true);

  // The root is not a node, so it cannot be a favorite.
  assert.equal(Either.isLeft(decodeFavoriteRequest({ target: { path: '/' } })), true);
  assert.equal(Either.isLeft(decodeFavoriteRequest({ target: { id: 3, path: '/work' } })), true);
  assert.equal(Either.isLeft(decodeFavoriteRequest({ target: { id: 3 }, revision: 1 })), true);
  assert.equal(Either.isLeft(decodeFavoriteRequest({ nodeId: 3 })), true);
});

test('an add or remove answer states the resulting membership, and a contradiction is refused', () => {
  assert.equal(Either.isRight(decodeAddFavoriteResponse({ nodeId: 3, isFavorite: true })), true);
  assert.equal(Either.isLeft(decodeAddFavoriteResponse({ nodeId: 3, isFavorite: false })), true);
  assert.equal(
    Either.isRight(decodeRemoveFavoriteResponse({ nodeId: 3, isFavorite: false })),
    true,
  );
  assert.equal(Either.isLeft(decodeRemoveFavoriteResponse({ nodeId: 3, isFavorite: true })), true);
  assert.equal(Either.isLeft(decodeAddFavoriteResponse({ nodeId: 0, isFavorite: true })), true);
});

test('the favorites list takes the ordinary page window, with its defaults and bounds', () => {
  assert.deepEqual(Either.getOrUndefined(decodeFavoriteListRequest({})), { skip: 0, limit: 50 });
  assert.deepEqual(Either.getOrUndefined(decodeFavoriteListRequest({ skip: 5, limit: 500 })), {
    skip: 5,
    limit: 500,
  });
  for (const window of [
    { limit: 0 },
    { limit: LIST_LIMIT_MAX + 1 },
    { skip: -1 },
    { skip: 1.5 },
    { limit: 2.5 },
    { limit: '10' },
  ]) {
    assert.equal(Either.isLeft(decodeFavoriteListRequest(window)), true, JSON.stringify(window));
  }
  assert.equal(Either.isLeft(decodeFavoriteListRequest({ includeArchived: true })), true);
});

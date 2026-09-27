/**
 * Every failure a star can report has one sentence, and no failure has none.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAVORITE_FAILED_SENTENCE,
  FAVORITE_UNCONFIRMED_SENTENCE,
  favoriteFailureSentence,
} from './copy.ts';

test('a refusal asks for another try', () => {
  assert.equal(favoriteFailureSentence('failed'), FAVORITE_FAILED_SENTENCE);
  assert.equal(FAVORITE_FAILED_SENTENCE, 'Favorite did not update. Try again.');
});

test('a lost answer says the star shows what the server last said, not that it failed', () => {
  assert.equal(favoriteFailureSentence('unconfirmed'), FAVORITE_UNCONFIRMED_SENTENCE);
  assert.doesNotMatch(FAVORITE_UNCONFIRMED_SENTENCE, /did not update/);
});

test('no failure says nothing', () => {
  assert.equal(favoriteFailureSentence(null), null);
});

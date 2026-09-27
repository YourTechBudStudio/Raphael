/**
 * The order the favorite star's freshness rule depends on: a stamp taken later is always larger.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { nextReadStamp } from './read-stamp.ts';

test('every stamp is larger than the one before it, with no ties', () => {
  const stamps = Array.from({ length: 1000 }, () => nextReadStamp());

  stamps.slice(1).forEach((stamp, index) => {
    assert.ok(stamp > stamps[index], `stamp ${String(index + 1)} is larger than the one before`);
  });
});

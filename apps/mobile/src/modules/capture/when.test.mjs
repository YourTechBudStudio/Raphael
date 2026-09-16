/**
 * How long ago, coarsely.
 *
 * Worth its own test for the edge nobody thinks about: a clock that has moved backwards. A card
 * should not say a note was written in the future, and "just now" is the smallest claim available.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { since } from './when.ts';

const T0 = 1_700_000_000_000;
const MINUTE = 60 * 1000;

test('it says the coarse thing a person would say', () => {
  assert.equal(since(T0, T0 + 30 * 1000), 'just now');
  assert.equal(since(T0, T0 + 12 * MINUTE), '12 min ago');
  assert.equal(since(T0, T0 + 2 * 60 * MINUTE), '2 h ago');
  assert.equal(since(T0, T0 + 3 * 24 * 60 * MINUTE), '3 d ago');
});

test('beyond a week it is a date, because "nine days ago" is harder to place', () => {
  assert.equal(
    since(T0, T0 + 9 * 24 * 60 * MINUTE),
    new Date(T0).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    }),
  );
});

test('a clock that moved backwards does not produce a note from the future', () => {
  assert.equal(since(T0, T0 - 60 * MINUTE), 'just now');
});

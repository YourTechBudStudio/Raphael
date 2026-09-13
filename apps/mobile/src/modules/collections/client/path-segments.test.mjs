/**
 * Reading a canonical path for display, and only for display.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { pathSegments } from './hierarchy.ts';

test('a canonical path becomes the segments a chip renders', () => {
  assert.deepEqual(pathSegments('/work/clients/design'), ['work', 'clients', 'design']);
  assert.deepEqual(pathSegments('/work'), ['work']);
});

test('nothing to show is an empty path, which a chip is allowed to admit', () => {
  // The screens feed this straight to the location chip, which says only "Browse" when it is empty.
  // Anything invented here - "Areas", a placeholder - becomes a claim about where something is.
  assert.deepEqual(pathSegments(undefined), []);
  assert.deepEqual(pathSegments('/'), []);
  assert.deepEqual(pathSegments(''), []);
});

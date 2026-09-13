import assert from 'node:assert/strict';
import test from 'node:test';

import { usePendingStore } from './pending.ts';

const attempt = (attemptKey, title) => ({
  type: 'area',
  parentAreaId: 'creative-work',
  attemptKey,
  title,
  description: '',
  body: '',
});

test('an attempt is kept once per key and resolved only by its own key', () => {
  const { keep, resolve } = usePendingStore.getState();
  try {
    keep(attempt('k1', 'Design'));
    keep(attempt('k2', 'Writing'));
    assert.deepEqual(
      usePendingStore.getState().attempts.map((entry) => entry.attemptKey),
      ['k1', 'k2'],
      'kept in the order they became unresolved',
    );

    // Keeping the same attempt again is one attempt, not two: a retry that goes uncertain twice
    // must not leave the destination reporting the same creation as unresolved twice over.
    keep(attempt('k1', 'Design'));
    assert.equal(usePendingStore.getState().attempts.length, 2);

    resolve('k2');
    assert.deepEqual(
      usePendingStore.getState().attempts.map((entry) => entry.attemptKey),
      ['k1'],
    );

    resolve('nothing-by-this-key');
    assert.equal(usePendingStore.getState().attempts.length, 1, 'an unknown key resolves nothing');

    resolve('k1');
    assert.equal(usePendingStore.getState().attempts.length, 0);
  } finally {
    usePendingStore.setState(usePendingStore.getInitialState(), true);
  }
});

test('an attempt keeps the payload it was sent with', () => {
  const { keep } = usePendingStore.getState();
  try {
    const sent = {
      type: 'project',
      parentAreaId: 'design',
      attemptKey: 'k9',
      title: 'Interface studies',
      description: 'Explore layouts.',
      body: '## Why\n\nBecause it keeps coming up.',
    };
    keep(sent);
    assert.deepEqual(usePendingStore.getState().attempts[0], sent);
  } finally {
    usePendingStore.setState(usePendingStore.getInitialState(), true);
  }
});

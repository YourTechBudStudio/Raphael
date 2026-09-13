import assert from 'node:assert/strict';
import test from 'node:test';

import { NO_RETIREMENT_MEMORY, nextRetirement } from './retirement.ts';

const run = (activations) => {
  let memory = NO_RETIREMENT_MEMORY;

  return activations.map((activation) => {
    const step = nextRetirement(memory, activation);
    memory = step.memory;

    return step.retire;
  });
};

test('the first connection of a launch keeps the stack, so a deep link survives', () => {
  assert.deepEqual(run([null, 1]), [false, false]);
});

test('switching servers retires the stack', () => {
  assert.deepEqual(run([1, 2]), [false, true]);
});

test('rotating a key retires it too, because the activation is new work', () => {
  // Same server, same connection id, new activation: the requests in flight used the old key and
  // the screens on the stack were read under it.
  assert.deepEqual(run([1, 2]), [false, true]);
});

test('disconnecting and reconnecting retires the stack', () => {
  // The hole this function exists to close. Forgetting on disconnect made the reconnection look
  // like a first launch, leaving routes that named the old server's containers by id - and showing
  // an unrelated container if the new server happened to have minted the same one.
  assert.deepEqual(run([1, null, 2]), [false, false, true]);
});

test('being disconnected for a while changes nothing on its own', () => {
  assert.deepEqual(run([1, null, null, null]), [false, false, false, false]);
});

test('re-rendering on the same connection does not retire anything', () => {
  assert.deepEqual(run([1, 1, 1]), [false, false, false]);
});

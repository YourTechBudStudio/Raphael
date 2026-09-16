/**
 * The quiet window, under a clock that does exactly what the test says.
 *
 * These cases are the reason the coordinator takes its timing and its composition signal as inputs.
 * "A `compositionstart` arriving just before the window expires" is not something a real timer can be
 * asked for reliably, and getting it wrong means locking mid-word and reading a document that is
 * missing text the person can see on screen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLockCoordinator } from './lock.ts';

const SETTLE = 50;
const DEADLINE = 1300;

const scheduler = () => {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    timing: {
      settleMs: SETTLE,
      deadlineMs: DEADLINE,
      setTimer: (run, ms) => {
        next += 1;
        timers.set(next, { at: now + ms, run });
        return next;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
    pending: () => timers.size,
  };
};

const harness = (options = {}) => {
  const clock = scheduler();
  const outcomes = [];
  let composing = options.composing ?? false;
  const lock = createLockCoordinator(clock.timing, {
    isComposing: () => composing,
    onLocked: () => outcomes.push('locked'),
    onFailed: () => outcomes.push('failed'),
  });
  return {
    lock,
    outcomes,
    advance: clock.advance,
    pending: clock.pending,
    compose: (value) => {
      composing = value;
    },
  };
};

describe('the quiet window', () => {
  it('applies the lock once nothing has happened for the settle period', () => {
    const { lock, outcomes, advance } = harness();
    lock.request();
    assert.equal(lock.isPending(), true);
    advance(SETTLE - 1);
    assert.deepEqual(outcomes, []);
    advance(1);
    assert.deepEqual(outcomes, ['locked']);
    assert.equal(lock.isLocked(), true);
    assert.equal(lock.isPending(), false);
  });

  it('restarts on a composition that begins just before the window expires', () => {
    const { lock, outcomes, advance, compose } = harness();
    lock.request();
    advance(SETTLE - 1);
    compose(true);
    lock.noteCompositionStart();
    advance(SETTLE);
    // Still pending: the window does not run at all while a composition is in progress.
    assert.deepEqual(outcomes, []);
    assert.equal(lock.isPending(), true);

    compose(false);
    lock.noteCompositionEnd();
    advance(SETTLE);
    assert.deepEqual(outcomes, ['locked']);
  });

  it('restarts on every intervening transaction, without a limit', () => {
    const { lock, outcomes, advance } = harness();
    lock.request();
    for (let burst = 0; burst < 12; burst += 1) {
      advance(SETTLE - 5);
      lock.noteTransaction();
    }
    assert.deepEqual(outcomes, []);
    advance(SETTLE);
    assert.deepEqual(outcomes, ['locked']);
  });

  it('refuses to lock at the recheck when composition is still live', () => {
    const { lock, outcomes, advance, compose } = harness();
    lock.request();
    // The signal turns true after the window started, so only a recheck at the transition can see it.
    compose(true);
    advance(SETTLE);
    assert.deepEqual(outcomes, []);
    assert.equal(lock.isPending(), true);

    compose(false);
    lock.noteCompositionEnd();
    advance(SETTLE);
    assert.deepEqual(outcomes, ['locked']);
  });

  it('does not start the window while a composition is already in progress', () => {
    const { lock, outcomes, advance, compose } = harness({ composing: true });
    lock.request();
    advance(SETTLE * 4);
    assert.deepEqual(outcomes, []);

    compose(false);
    lock.noteCompositionEnd();
    advance(SETTLE);
    assert.deepEqual(outcomes, ['locked']);
  });
});

describe('the deadline', () => {
  it('ends continuous typing in a refusal rather than an unbounded wait', () => {
    const { lock, outcomes, advance } = harness();
    lock.request();
    for (let elapsed = 0; elapsed < DEADLINE + SETTLE; elapsed += SETTLE - 5) {
      advance(SETTLE - 5);
      lock.noteTransaction();
    }
    assert.deepEqual(outcomes, ['failed']);
    // The editor was never made read-only, so the person keeps typing into a live editor.
    assert.equal(lock.isLocked(), false);
    assert.equal(lock.isPending(), false);
  });

  it('ends continuous composition the same way', () => {
    const { lock, outcomes, advance, compose } = harness({ composing: true });
    lock.request();
    advance(DEADLINE);
    assert.deepEqual(outcomes, ['failed']);
    assert.equal(lock.isLocked(), false);

    // And nothing fires late: the window was dropped with the rest of the pending state.
    compose(false);
    lock.noteCompositionEnd();
    advance(SETTLE * 10);
    assert.deepEqual(outcomes, ['failed']);
  });

  it('reports exactly once, whichever way it goes', () => {
    const { lock, outcomes, advance } = harness();
    lock.request();
    advance(SETTLE);
    advance(DEADLINE * 2);
    assert.deepEqual(outcomes, ['locked']);
  });
});

describe('cancellation', () => {
  it('drops pending work immediately and leaves no timer behind', () => {
    const { lock, outcomes, advance, pending } = harness();
    lock.request();
    lock.cancel();
    assert.equal(pending(), 0);
    advance(DEADLINE * 2);
    assert.deepEqual(outcomes, []);
  });

  it('releases an applied lock', () => {
    const { lock, advance } = harness();
    lock.request();
    advance(SETTLE);
    assert.equal(lock.isLocked(), true);
    lock.cancel();
    assert.equal(lock.isLocked(), false);
  });

  it('ignores a request while one is pending or applied', () => {
    const { lock, outcomes, advance } = harness();
    lock.request();
    lock.request();
    advance(SETTLE);
    assert.deepEqual(outcomes, ['locked']);
    lock.request();
    advance(DEADLINE * 2);
    assert.deepEqual(outcomes, ['locked']);
  });
});

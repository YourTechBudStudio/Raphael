/**
 * The retry window, and what a moving clock does to it.
 *
 * Every rule here is conservative in the same direction: when the measurement is in doubt, the
 * window is closed. Ending it early costs someone a retry they could have had; leaving it open on a
 * bad measurement means sending a creation under a key the server may have forgotten.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { byAttemptAge, correctionAllowed, createdBy, logicalStateOf, viewOf } from './derive.ts';
import { evaluateEligibility, RETRY_WINDOW_MS } from './eligibility.ts';

const T0 = 1_700_000_000_000;

const at = (over = {}) => ({
  now: T0,
  firstDispatchAt: T0,
  lastObservedAt: T0,
  clockAnomaly: false,
  monotonicElapsedMs: null,
  ...over,
});

describe('eligibility', () => {
  it('is 71 hours, an hour inside the server’s retention', () => {
    assert.equal(RETRY_WINDOW_MS, 71 * 60 * 60 * 1000);
    assert.equal(evaluateEligibility(at({ now: T0 + RETRY_WINDOW_MS - 1 })).kind, 'eligible');
    assert.equal(evaluateEligibility(at({ now: T0 + RETRY_WINDOW_MS })).kind, 'window_ended');
  });

  it('takes the longer of wall and monotonic elapsed time', () => {
    // The clock barely moved; the process knows better.
    assert.equal(
      evaluateEligibility(at({ now: T0 + 1000, monotonicElapsedMs: RETRY_WINDOW_MS })).kind,
      'window_ended',
    );
    // And the other way: a clock that jumped forward closes it even without a monotonic mark.
    assert.equal(
      evaluateEligibility(at({ now: T0 + RETRY_WINDOW_MS, monotonicElapsedMs: 0 })).kind,
      'window_ended',
    );
  });

  it('detects time moving back against the latest observation, not only the first dispatch', () => {
    // An hour after dispatch, the clock is set back by a minute. Against `firstDispatchAt` that is
    // still forward; against what the attempt has already seen it is plainly backwards.
    const moved = at({
      firstDispatchAt: T0,
      lastObservedAt: T0 + 3_600_000,
      now: T0 + 3_540_000,
    });

    assert.equal(evaluateEligibility(moved).kind, 'clock_anomaly');
  });

  it('stays anomalous once recorded', () => {
    assert.equal(
      evaluateEligibility(at({ clockAnomaly: true, now: T0 + 1000 })).kind,
      'clock_anomaly',
    );
  });
});

const record = (over = {}) => ({
  attemptId: 'a1',
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  state: 'uncertain',
  request: '{}',
  type: 'area',
  title: 'Work',
  parentAreaId: null,
  firstDispatchAt: T0,
  firstUncertainAt: T0,
  clockAnomaly: false,
  lastOutcome: null,
  acknowledged: null,
  observedAt: T0,
  ...over,
});

const view = (over = {}) =>
  viewOf({
    record: record(over.record ?? {}),
    now: T0,
    monotonicElapsedMs: null,
    sending: false,
    activeConnectionId: 'c1',
    connectionUsable: true,
    payloadUsable: true,
    ...over,
  });

describe('what an attempt means', () => {
  it('separates a refusal from an unresolved creation by history alone', () => {
    const refused = record({ state: 'blocked', firstUncertainAt: null });
    const unresolved = record({ state: 'blocked', firstUncertainAt: T0 });

    assert.equal(logicalStateOf(refused), 'refused');
    assert.equal(logicalStateOf(unresolved), 'unresolved');
    assert.equal(correctionAllowed(refused), true);
    assert.equal(correctionAllowed(unresolved), false);
  });

  it('treats an acknowledged attempt as created whatever else is on it', () => {
    assert.equal(
      logicalStateOf(
        record({ state: 'acknowledged', acknowledged: { type: 'area', id: 1, title: 'Work' } }),
      ),
      'created',
    );
  });

  it('treats an intent as unresolved, because it may have left', () => {
    assert.equal(logicalStateOf(record({ state: 'dispatch_intent' })), 'unresolved');
  });

  it('treats a server success held in memory as created, whatever the row still says', () => {
    // The acknowledgement write failed, so the row is untouched. Reading the row alone would call a
    // creation the server demonstrably made "may not have been created", and then offer to send it
    // again - the exact inversion of the acknowledgement exception.
    const confirmed = { type: 'area', id: 9, title: 'Work' };

    assert.equal(logicalStateOf(record({ state: 'dispatch_intent' }), confirmed), 'created');
    assert.equal(logicalStateOf(record({ state: 'uncertain' }), confirmed), 'created');

    const held = view({ confirmed });
    assert.equal(held.logical, 'created');
    assert.equal(held.canRetry, false, 'a known creation is never dispatched again');
    assert.equal(held.canCorrect, false);
    assert.deepEqual(createdBy(held), confirmed);
  });

  it('reads the created entity from the row once it has been written', () => {
    const acknowledged = { type: 'area', id: 4, title: 'Work' };

    assert.deepEqual(
      createdBy(view({ record: { state: 'acknowledged', acknowledged } })),
      acknowledged,
    );
    assert.equal(createdBy(view()), null);
  });
});

describe('what a screen may offer', () => {
  it('offers a retry only when every condition holds', () => {
    assert.equal(view().canRetry, true);
    assert.equal(view({ activeConnectionId: 'c2' }).canRetry, false);
    assert.equal(view({ connectionUsable: false }).canRetry, false);
    assert.equal(view({ payloadUsable: false }).canRetry, false);
    assert.equal(view({ sending: true }).canRetry, false);
    assert.equal(view({ now: T0 + RETRY_WINDOW_MS }).canRetry, false);
    assert.equal(view({ record: { state: 'blocked', firstUncertainAt: null } }).canRetry, false);
  });

  it('will not navigate from an attempt made against another server', () => {
    // An old parent id against a different database points at a coincidence, not a place.
    assert.equal(view({ activeConnectionId: 'c2' }).canOpenDestination, false);
    assert.equal(view().canOpenDestination, true);
  });

  it('explains an unresolved attempt whose window has closed, and says nothing otherwise', () => {
    assert.match(view({ now: T0 + RETRY_WINDOW_MS }).note, /retry window has ended/i);
    assert.match(view({ record: { clockAnomaly: true } }).note, /clock changed/i);
    assert.equal(view().note, null);
    assert.equal(view({ record: { state: 'blocked', firstUncertainAt: null } }).note, null);
  });

  it('orders attempts by when they were first sent', () => {
    const older = record({ attemptId: 'a', firstDispatchAt: T0 });
    const newer = record({ attemptId: 'b', firstDispatchAt: T0 + 10 });

    assert.deepEqual(
      [newer, older].sort(byAttemptAge).map((r) => r.attemptId),
      ['a', 'b'],
    );
  });
});

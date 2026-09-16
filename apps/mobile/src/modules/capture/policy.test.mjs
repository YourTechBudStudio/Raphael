/**
 * The rules that decide whether someone's note gets duplicated.
 *
 * The pairs that differ only by history are the whole point: a refusal that was never uncertain is
 * correctable, and a refusal that follows any uncertainty is not, because the server's "no" is about
 * the replay while the creation stays genuinely unresolved.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  correctionAllowed,
  deriveStanding,
  evaluateEligibility,
  factsOf,
  integrityProblemOf,
  logicalStateOf,
  newestAttempt,
  replacementAllowed,
  RETRY_WINDOW_MS,
} from './policy.ts';

const T0 = 1_700_000_000_000;

const facts = (over = {}) => ({
  state: 'dispatch_intent',
  firstDispatchAt: T0,
  firstUncertainAt: null,
  observedAt: T0,
  clockAnomaly: false,
  ...over,
});

const attempt = (over = {}) => ({
  attemptId: 'a1',
  draftId: 'd1',
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  state: 'dispatch_intent',
  request: '{}',
  submittedDraftVersion: 1,
  title: 'Note',
  destination: { type: 'area', id: 3 },
  firstDispatchAt: T0,
  firstUncertainAt: null,
  clockAnomaly: false,
  lastOutcome: null,
  acknowledged: null,
  observedAt: T0,
  ...over,
});

const draft = (over = {}) => ({
  draftId: 'd1',
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  state: 'composing',
  title: '',
  description: '',
  document: { type: 'doc', content: [] },
  contentSchemaVersion: 1,
  destination: { type: 'area', id: 3 },
  draftVersion: 1,
  submittedVersion: null,
  serverNodeId: null,
  serverRevision: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const standing = (over = {}) =>
  deriveStanding({
    draft: draft(),
    attempts: [],
    confirmed: () => undefined,
    now: T0,
    monotonicElapsedMs: () => null,
    payloadUsable: () => true,
    ...over,
  });

describe('what an attempt means', () => {
  it('reports a definite refusal with no history as refused', () => {
    assert.equal(logicalStateOf(facts({ state: 'blocked' })), 'refused');
    assert.equal(correctionAllowed(facts({ state: 'blocked' })), true);
    assert.equal(replacementAllowed(facts({ state: 'blocked' })), true);
  });

  it('keeps a refusal after any uncertainty unresolved', () => {
    // The 401-on-replay case. That reply is about the replay; the creation is still unresolved.
    const after = facts({ state: 'blocked', firstUncertainAt: T0 + 1 });

    assert.equal(logicalStateOf(after), 'unresolved');
    assert.equal(correctionAllowed(after), false);
    assert.equal(replacementAllowed(after), false);
  });

  it('reports an in-flight or interrupted intent as unresolved, not settled', () => {
    assert.equal(logicalStateOf(facts()), 'unresolved');
    assert.equal(logicalStateOf(facts({ state: 'uncertain', firstUncertainAt: T0 })), 'unresolved');
  });

  it('lets a success held only in memory outrank the row it has not been written to', () => {
    assert.equal(logicalStateOf(facts({ state: 'uncertain' }), true), 'created');
  });
});

describe('eligibility', () => {
  it('is eligible inside the window and ended at it', () => {
    const input = {
      firstDispatchAt: T0,
      lastObservedAt: T0,
      clockAnomaly: false,
      monotonicElapsedMs: null,
    };

    assert.deepEqual(evaluateEligibility({ ...input, now: T0 + RETRY_WINDOW_MS - 1 }), {
      kind: 'eligible',
    });
    assert.deepEqual(evaluateEligibility({ ...input, now: T0 + RETRY_WINDOW_MS }), {
      kind: 'window_ended',
    });
  });

  it('takes the larger of wall time and monotonic elapsed', () => {
    // A clock that jumped backwards would otherwise reopen a window that has really closed.
    assert.deepEqual(
      evaluateEligibility({
        now: T0 + 1000,
        firstDispatchAt: T0,
        lastObservedAt: T0,
        clockAnomaly: false,
        monotonicElapsedMs: RETRY_WINDOW_MS + 1,
      }),
      { kind: 'window_ended' },
    );
  });

  it('calls time moving backwards an anomaly, and keeps calling it one', () => {
    assert.deepEqual(
      evaluateEligibility({
        now: T0 - 1,
        firstDispatchAt: T0 - 5000,
        lastObservedAt: T0,
        clockAnomaly: false,
        monotonicElapsedMs: null,
      }),
      { kind: 'clock_anomaly' },
    );
    // Once recorded it survives the clock catching up: restoring eligibility would claim a
    // guarantee from the measurement that had just been wrong.
    assert.deepEqual(
      evaluateEligibility({
        now: T0 + 1,
        firstDispatchAt: T0,
        lastObservedAt: T0,
        clockAnomaly: true,
        monotonicElapsedMs: null,
      }),
      { kind: 'clock_anomaly' },
    );
  });
});

describe('the newest attempt', () => {
  it('orders by dispatch, then observation, then id, so a tie is never insertion order', () => {
    const rows = [
      attempt({ attemptId: 'b', firstDispatchAt: T0, observedAt: T0 + 5 }),
      attempt({ attemptId: 'a', firstDispatchAt: T0, observedAt: T0 + 5 }),
      attempt({ attemptId: 'c', firstDispatchAt: T0 - 1 }),
      attempt({ attemptId: 'z', draftId: 'other', firstDispatchAt: T0 + 9999 }),
    ];

    assert.equal(newestAttempt(rows, 'd1').attemptId, 'b');
    assert.equal(newestAttempt(rows, 'missing'), null);
  });
});

describe('what the bar may offer', () => {
  it('admits an ordinary save for a draft with no attempt', () => {
    assert.deepEqual(standing(), { kind: 'save' });
  });

  it('replaces a definite refusal under a new key', () => {
    const refused = attempt({ state: 'blocked' });
    const result = standing({ attempts: [refused] });

    assert.equal(result.kind, 'save_replacing');
    assert.equal(result.attempt.attemptId, 'a1');
  });

  it('offers Retry instead of Save while an attempt is unresolved', () => {
    const result = standing({
      attempts: [attempt({ state: 'uncertain', firstUncertainAt: T0 })],
    });

    assert.equal(result.kind, 'retry');
  });

  it('withdraws Retry and still refuses Save once the window has ended', () => {
    const result = standing({
      attempts: [attempt({ state: 'uncertain', firstUncertainAt: T0 })],
      now: T0 + RETRY_WINDOW_MS,
    });

    assert.deepEqual(
      { kind: result.kind, reason: result.reason },
      { kind: 'blocked', reason: 'unresolved_ineligible' },
    );
  });

  it('refuses a created draft even after its receipt has been consumed', () => {
    // The attempt row is gone - consumed - and the draft columns are the only evidence left. An
    // attempt-only rule would fall through to `save` here and make a second note.
    const result = standing({
      draft: draft({ state: 'created', serverNodeId: 12, serverRevision: 1, submittedVersion: 1 }),
      attempts: [],
    });

    assert.deepEqual(
      { kind: result.kind, reason: result.reason },
      { kind: 'blocked', reason: 'created' },
    );
  });

  it('offers only the local write again for a success held in memory', () => {
    const pending = attempt({ state: 'uncertain', firstUncertainAt: T0 });
    const result = standing({
      attempts: [pending],
      confirmed: (id) =>
        id === 'a1' ? { id: 9, revision: 1, title: 'x', kind: 'note' } : undefined,
    });

    assert.equal(result.kind, 'record_again');
  });

  it('withdraws Retry when this build cannot prepare the frozen bytes', () => {
    const result = standing({
      attempts: [attempt({ state: 'uncertain', firstUncertainAt: T0 })],
      payloadUsable: () => false,
    });

    // Asked now, not remembered: a recovered payload this build cannot read must not advertise a
    // replay merely because nobody has pressed it yet.
    assert.deepEqual(
      { kind: result.kind, reason: result.reason, cause: result.cause },
      { kind: 'blocked', reason: 'unresolved_unsendable', cause: 'unusable_payload' },
    );
    // The evidence is untouched, and no correction key is on offer.
    assert.equal(result.attempt.attemptId, 'a1');
  });

  it('offers Retry again once a build can read the same bytes', () => {
    // The mirror of the case above: an older unusable-payload observation must not block a build
    // that can safely thaw the exact frozen request.
    const blocked = attempt({
      state: 'blocked',
      firstUncertainAt: T0,
      lastOutcome: { kind: 'unusable_payload', code: null, message: 'old build', at: T0 + 1 },
    });

    assert.equal(standing({ attempts: [blocked], payloadUsable: () => true }).kind, 'retry');
  });

  for (const code of ['idempotency_conflict', 'slug_conflict']) {
    it(`withdraws Retry after uncertainty when the server answered ${code}`, () => {
      const conflicted = attempt({
        state: 'blocked',
        firstUncertainAt: T0,
        lastOutcome: { kind: 'rejected', code, message: 'conflict', at: T0 + 2 },
      });
      const result = standing({ attempts: [conflicted] });

      assert.deepEqual(
        { kind: result.kind, reason: result.reason, cause: result.cause },
        { kind: 'blocked', reason: 'unresolved_unsendable', cause: 'conflict' },
      );
      // Not a claim that the first attempt committed: the attempt stays unresolved, so ordinary
      // Save is still refused and no fresh key is minted.
      assert.equal(logicalStateOf(factsOf(conflicted)), 'unresolved');
    });

    it(`treats a never-uncertain ${code} as an ordinary definite refusal`, () => {
      const refused = attempt({
        state: 'blocked',
        lastOutcome: { kind: 'rejected', code, message: 'conflict', at: T0 + 2 },
      });

      assert.equal(standing({ attempts: [refused] }).kind, 'save_replacing');
    });
  }

  it('leaves an ordinary recoverable refusal replayable', () => {
    // A 401 on a replay says nothing about whether the first request committed, and nothing about
    // whether these bytes can be sent again. It must not become permanently unsendable.
    const unauthorized = attempt({
      state: 'blocked',
      firstUncertainAt: T0,
      lastOutcome: { kind: 'rejected', code: 'unauthorized', message: 'refused', at: T0 + 2 },
    });

    assert.equal(standing({ attempts: [unauthorized] }).kind, 'retry');
  });

  it('stops counting a conflict once something later happened to the attempt', () => {
    // `last_outcome` is only rewritten by a definite answer, so an attempt that took a conflict and
    // then went uncertain again is read from its state rather than from a stale outcome.
    const later = attempt({
      state: 'uncertain',
      firstUncertainAt: T0,
      lastOutcome: { kind: 'rejected', code: 'slug_conflict', message: 'conflict', at: T0 + 2 },
    });

    assert.equal(standing({ attempts: [later] }).kind, 'retry');
  });

  it('reports an ended window over a conflict, because the receipt is gone either way', () => {
    const conflicted = attempt({
      state: 'blocked',
      firstUncertainAt: T0,
      lastOutcome: { kind: 'rejected', code: 'slug_conflict', message: 'conflict', at: T0 + 2 },
    });
    const result = standing({ attempts: [conflicted], now: T0 + RETRY_WINDOW_MS });

    assert.equal(result.reason, 'unresolved_ineligible');
  });

  it('refuses a submitted draft whose attempt is gone rather than guessing', () => {
    const result = standing({ draft: draft({ state: 'submitted', submittedVersion: 1 }) });

    assert.deepEqual(
      { kind: result.kind, reason: result.reason, integrity: result.integrity },
      { kind: 'blocked', reason: 'inconsistent', integrity: 'submitted_without_attempt' },
    );
  });
});

describe('integrity', () => {
  it('names each contradictory pair and repairs none of them', () => {
    assert.equal(integrityProblemOf(draft({ state: 'created' }), null), 'half_created');
    assert.equal(integrityProblemOf(draft({ serverNodeId: 4 }), null), 'half_created');
    assert.equal(
      integrityProblemOf(
        draft({ state: 'submitted' }),
        attempt({
          state: 'acknowledged',
          acknowledged: { id: 1, revision: 1, title: 't', kind: 'note' },
        }),
      ),
      'acknowledged_without_creation',
    );
    assert.equal(integrityProblemOf(draft(), null), null);
  });
});

/**
 * What an attempt means, whether it may still be replayed, and what a draft's bar may offer.
 *
 * These rules decide whether someone's work gets duplicated, so they live in one place and every
 * caller asks rather than reading a state string. The rule the file exists for: **a `blocked`
 * attempt that was once uncertain is not a refusal.** The server said no to the *latest* request; it
 * said nothing about whether the first one committed before its answer was lost. Reading `state`
 * alone gets that backwards, and it gets it backwards in the direction that creates a second note.
 *
 * The functions take an `AttemptFacts` shape rather than a whole record. It is the five fields the
 * rules actually read, which is what lets the same rules be applied to a row, to a projection, or to
 * a fact assembled in a test without a store. Container creation still carries its own copy over its
 * own record type; that duplication is temporary and ends when Phase 06 deletes it.
 */

import type {
  AcknowledgedNote,
  AttemptState,
  LogicalState,
  NoteAttemptRecord,
  NoteDraftRecord,
} from './types.ts';

/** 71 hours: one inside the server's 72-hour, non-extending receipt retention. */
export const RETRY_WINDOW_MS = 71 * 60 * 60 * 1000;

/** The five fields every rule below reads. Nothing here knows what a row looks like. */
export interface AttemptFacts {
  readonly state: AttemptState;
  readonly firstDispatchAt: number;
  readonly firstUncertainAt: number | null;
  readonly observedAt: number;
  readonly clockAnomaly: boolean;
}

export const factsOf = (record: NoteAttemptRecord): AttemptFacts => ({
  state: record.state,
  firstDispatchAt: record.firstDispatchAt,
  firstUncertainAt: record.firstUncertainAt,
  observedAt: record.observedAt,
  clockAnomaly: record.clockAnomaly,
});

/**
 * What the attempt means.
 *
 * `confirmedInMemory` is a validated server success this process holds because the local write of it
 * failed. It has to be part of the projection rather than a note beside it: the row is still at
 * whatever state it was before the answer arrived, so reading the row alone would call a creation
 * the server demonstrably made "may not have been created" - and would then offer to send it again.
 *
 * A `dispatch_intent` read after a restart has already been adopted as uncertain by the sweep. One
 * read while its own dispatcher is running is in flight, not interrupted, so reporting it as
 * unresolved is right in both cases.
 */
export const logicalStateOf = (facts: AttemptFacts, confirmedInMemory = false): LogicalState => {
  if (facts.state === 'acknowledged' || confirmedInMemory) return 'created';
  if (facts.state === 'blocked' && facts.firstUncertainAt === null) return 'refused';

  return 'unresolved';
};

/**
 * Whether the person may edit this input and send it under the same logical attempt.
 *
 * Only a known non-creating attempt qualifies. Everything else keeps its payload frozen, because
 * changing it would mean a second, different request under a key the server may already have used.
 */
export const correctionAllowed = (facts: AttemptFacts): boolean =>
  logicalStateOf(facts) === 'refused';

/**
 * Whether the record may be replaced atomically by a corrected one.
 *
 * The same question as correction, named separately because the consequence is worse: replacement
 * deletes a row, and deleting an ambiguous attempt would erase the only evidence that something may
 * exist on the server.
 */
export const replacementAllowed = correctionAllowed;

export interface EligibilityInput {
  /** Wall clock, now. */
  readonly now: number;
  readonly firstDispatchAt: number;
  /**
   * The latest wall-clock time this attempt is known to have observed. Time appearing to be earlier
   * than this is the clock moving, not the attempt aging.
   */
  readonly lastObservedAt: number;
  readonly clockAnomaly: boolean;
  /**
   * Elapsed milliseconds measured monotonically since this process dispatched the attempt, or null
   * when the dispatch happened in a process that is gone.
   */
  readonly monotonicElapsedMs: number | null;
}

export type Eligibility =
  | { readonly kind: 'eligible' }
  /** Too long has passed. Every record and recovery entry stays exactly where it is. */
  | { readonly kind: 'window_ended' }
  /** Time moved in a way that makes the window unmeasurable. Also permanent. */
  | { readonly kind: 'clock_anomaly' };

/**
 * Three things make this conservative rather than trusting: monotonic elapsed time supplements wall
 * time and the larger wins; backward movement is measured against the latest time the attempt was
 * known to observe rather than only its first dispatch; and an anomaly, once recorded, is permanent,
 * because restoring eligibility when the clock catches up would claim a guarantee from the same
 * measurement that had just been wrong.
 *
 * **At 71 hours we do not know the receipt has expired.** We know we will not claim it has not.
 */
export const evaluateEligibility = (input: EligibilityInput): Eligibility => {
  if (input.clockAnomaly || input.now < input.lastObservedAt) return { kind: 'clock_anomaly' };

  const byWall = input.now - input.firstDispatchAt;
  const elapsed = Math.max(byWall, input.monotonicElapsedMs ?? 0);

  return elapsed >= RETRY_WINDOW_MS ? { kind: 'window_ended' } : { kind: 'eligible' };
};

export const WINDOW_ENDED_MESSAGE =
  'The retry window has ended. Raphael can no longer send this request again, so look in the destination before creating it again.';

export const CLOCK_ANOMALY_MESSAGE =
  'The clock changed, so Raphael cannot establish whether this request can still be sent again. Look in the destination before creating it again.';

/** The sentence for a state, or null where there is nothing to explain. */
export const describeEligibility = (eligibility: Eligibility): string | null => {
  switch (eligibility.kind) {
    case 'eligible':
      return null;
    case 'window_ended':
      return WINDOW_ENDED_MESSAGE;
    case 'clock_anomaly':
      return CLOCK_ANOMALY_MESSAGE;
  }
};

/**
 * The newest attempt for a draft.
 *
 * Admission means at most one attempt per draft is ever non-terminal, so this is usually the only
 * one. The ordering is still total - dispatch time, then the observed mark, then the id - because a
 * tie decided by insertion order would make the answer depend on how the rows came back.
 */
export const newestAttempt = (
  attempts: readonly NoteAttemptRecord[],
  draftId: string,
): NoteAttemptRecord | null =>
  attempts
    .filter((attempt) => attempt.draftId === draftId)
    .reduce<NoteAttemptRecord | null>((newest, attempt) => {
      if (newest === null) return attempt;
      if (attempt.firstDispatchAt !== newest.firstDispatchAt) {
        return attempt.firstDispatchAt > newest.firstDispatchAt ? attempt : newest;
      }
      if (attempt.observedAt !== newest.observedAt) {
        return attempt.observedAt > newest.observedAt ? attempt : newest;
      }

      return attempt.attemptId > newest.attemptId ? attempt : newest;
    }, null);

/**
 * Why a draft's stored pair cannot be believed.
 *
 * These are not repaired. A guess about which half is right is a guess about whether a note exists,
 * and the only safe answer is to keep both halves, say so, and refuse ordinary Save - because the
 * missing evidence cannot prove that nothing was dispatched.
 */
export type DraftIntegrityProblem =
  /** `created` without a server identity, or a server identity without `created`. */
  | 'half_created'
  /** An acknowledged attempt whose draft never gained the creation. */
  | 'acknowledged_without_creation'
  /** A dispatched draft whose attempt is gone. */
  | 'submitted_without_attempt';

export const integrityProblemOf = (
  draft: NoteDraftRecord,
  attempt: NoteAttemptRecord | null,
): DraftIntegrityProblem | null => {
  if ((draft.state === 'created') !== (draft.serverNodeId !== null)) return 'half_created';
  if (attempt?.state === 'acknowledged' && draft.state !== 'created') {
    return 'acknowledged_without_creation';
  }
  if (draft.state === 'submitted' && attempt === null) return 'submitted_without_attempt';

  return null;
};

/**
 * What this draft's bar may offer, which is §8.6's admission table as one expression.
 *
 * Two questions in order, because "is a request in flight right now" is the wrong one - the
 * dangerous cases are an attempt that is not in flight and never resolved, and a draft whose attempt
 * row is gone. So the draft's own durable state is asked first, and only a draft with no server
 * identity goes on to ask about its newest attempt.
 */
export type Standing =
  /** The ordinary path. Mints a new attempt id and key. */
  | { readonly kind: 'save' }
  /**
   * The server refused that exact request and created nothing, so the corrected request is a
   * different request and must not reuse the key. The refused row is replaced in the same
   * transaction that writes the new one.
   */
  | { readonly kind: 'save_replacing'; readonly attempt: NoteAttemptRecord }
  /** Ordinary Save is refused; the frozen bytes may be replayed under their original key. */
  | { readonly kind: 'retry'; readonly attempt: NoteAttemptRecord }
  /** The server created it and only the local note of that failed. Never another creation. */
  | { readonly kind: 'record_again'; readonly attempt: NoteAttemptRecord }
  | {
      readonly kind: 'blocked';
      readonly reason: BlockedReason;
      readonly attempt: NoteAttemptRecord | null;
      readonly integrity?: DraftIntegrityProblem;
      /** Present only with `unresolved_unsendable`. */
      readonly cause?: UnsendableCause;
    };

export type BlockedReason =
  /** The note exists. This slice has no update operation; copying is the way forward. */
  | 'created'
  /** Unresolved and past the window, or with a recorded clock anomaly. Nothing is resent. */
  | 'unresolved_ineligible'
  /**
   * Unresolved and still inside the window, but replaying these exact bytes is not a recovery
   * action this build can offer. `cause` says which of the two it is.
   */
  | 'unresolved_unsendable'
  /** The stored pair contradicts itself. Retained and reported, never repaired. */
  | 'inconsistent';

/**
 * Why a frozen request cannot be replayed right now.
 *
 * Bounded vocabulary, not an outcome or a server string: a surface has two sentences to write and
 * must not have to infer which one from an arbitrary combination of recorded outcomes. Neither value
 * is a claim about whether the note exists.
 */
export type UnsendableCause =
  /**
   * The server answered the last attempt with a conflict. It says this key already stands for a
   * different request, or this parent already holds that slug - not that the original creation
   * succeeded.
   */
  | 'conflict'
  /** This build cannot prepare the stored bytes, so there is nothing valid to send. */
  | 'unusable_payload';

/**
 * The conflict codes that withdraw a replay.
 *
 * Both mean the same thing about the frozen request: sending it again under its own key cannot work
 * now. Neither is evidence that the first attempt committed, which is why the attempt stays
 * unresolved, its evidence stays intact and no fresh key is minted.
 */
const CONFLICT_CODES: readonly string[] = ['idempotency_conflict', 'slug_conflict'];

/**
 * Whether the latest thing observed about this attempt was a conflict.
 *
 * Read from `state` as well as the code, because `last_outcome` is only rewritten by a definite
 * answer: an attempt that took a conflict and then went uncertain again is at `uncertain`, and the
 * conflict is no longer the latest word on it.
 */
const conflicted = (attempt: NoteAttemptRecord): boolean =>
  attempt.state === 'blocked' &&
  attempt.lastOutcome !== null &&
  attempt.lastOutcome.code !== null &&
  CONFLICT_CODES.includes(attempt.lastOutcome.code);

export interface StandingInput {
  readonly draft: NoteDraftRecord;
  readonly attempts: readonly NoteAttemptRecord[];
  /** Validated successes this process holds because their local write failed. */
  readonly confirmed: (attemptId: string) => AcknowledgedNote | undefined;
  readonly now: number;
  /** Monotonic elapsed for attempts this process dispatched; null for recovered ones. */
  readonly monotonicElapsedMs: (attemptId: string) => number | null;
  /**
   * Whether this build can prepare the frozen bytes **now**.
   *
   * Asked rather than remembered, and injected rather than imported. A recovered payload this build
   * cannot read must not advertise a replay merely because nobody has pressed it yet; and a later
   * build that can read the same bytes again must not stay blocked by an older observation. Keeping
   * it a parameter is also what stops this file depending on how a request is frozen.
   */
  readonly payloadUsable: (attempt: NoteAttemptRecord) => boolean;
}

export const deriveStanding = (input: StandingInput): Standing => {
  const attempt = newestAttempt(input.attempts, input.draft.draftId);
  const integrity = integrityProblemOf(input.draft, attempt);

  if (integrity !== null) {
    // One exception, and it is the case the exception exists for: a server success whose local
    // acknowledgement write failed leaves exactly this contradiction, and the answer to it is the
    // local retry rather than a refusal that would read as "it may not have been created".
    const held = attempt === null ? undefined : input.confirmed(attempt.attemptId);

    if (held !== undefined && attempt !== null && integrity !== 'submitted_without_attempt') {
      return { kind: 'record_again', attempt };
    }

    return { kind: 'blocked', reason: 'inconsistent', attempt, integrity };
  }

  // The durable draft-level guard. It survives receipt consumption, a deleted attempt row and a
  // restart, which is what stops a dismissed receipt turning into a second note for the same
  // writing.
  if (input.draft.state === 'created' || input.draft.serverNodeId !== null) {
    return { kind: 'blocked', reason: 'created', attempt };
  }

  if (attempt === null) return { kind: 'save' };

  const held = input.confirmed(attempt.attemptId);
  const logical = logicalStateOf(factsOf(attempt), held !== undefined);

  if (logical === 'created') {
    return held === undefined
      ? { kind: 'blocked', reason: 'created', attempt }
      : { kind: 'record_again', attempt };
  }
  if (logical === 'refused') return { kind: 'save_replacing', attempt };

  const eligibility = evaluateEligibility({
    now: input.now,
    firstDispatchAt: attempt.firstDispatchAt,
    lastObservedAt: attempt.observedAt,
    clockAnomaly: attempt.clockAnomaly,
    monotonicElapsedMs: input.monotonicElapsedMs(attempt.attemptId),
  });

  // The window is asked first and its answer is permanent. A conflict or an unreadable payload is
  // about this request; an ended window or a moved clock is about the receipt itself, and reporting
  // the smaller problem over it would promise a replay that is gone either way.
  if (eligibility.kind !== 'eligible') {
    return { kind: 'blocked', reason: 'unresolved_ineligible', attempt };
  }

  // Asked before the conflict, because "this build cannot prepare these bytes" is the stronger
  // statement: there is nothing valid to send, whatever the server last said about it.
  if (!input.payloadUsable(attempt)) {
    return {
      kind: 'blocked',
      reason: 'unresolved_unsendable',
      attempt,
      cause: 'unusable_payload',
    };
  }

  if (conflicted(attempt)) {
    return { kind: 'blocked', reason: 'unresolved_unsendable', attempt, cause: 'conflict' };
  }

  return { kind: 'retry', attempt };
};

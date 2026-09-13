/**
 * What an attempt means, and what may be done about it. One place, so six screens cannot disagree.
 *
 * The rule this file exists for: a `blocked` attempt that was once uncertain is not a refusal. The
 * server said no to the *latest* request; it said nothing about whether the first one committed
 * before its answer was lost. Reading `state` alone gets that backwards, and it gets it backwards in
 * the direction that loses someone's work - by offering to "correct and resend" an attempt whose
 * original may already exist.
 */

import {
  describeEligibility,
  evaluateEligibility,
  type Eligibility,
  type EligibilityInput,
} from './eligibility.ts';
import type { AcknowledgedResult, AttemptRecord, LogicalState } from './types.ts';

/**
 * What the attempt means, as opposed to where it has got to.
 *
 * A `dispatch_intent` read after a restart has been adopted by the sweep and is already `uncertain`
 * by the time anything renders it. One read while its own dispatcher is still running is in flight,
 * not interrupted, which is why this reports it as unresolved rather than as anything settled.
 *
 * `confirmed` is a validated server success this process holds in memory because the local write of
 * it failed. It has to be part of the projection rather than a note beside it: the row is still at
 * whatever state it was before the answer arrived, so reading the row alone would call a creation
 * the server demonstrably made "may not have been created" - and would then offer to send it again.
 * That is the exact inversion of the acknowledgement exception, so the knowledge wins over the row.
 */
export const logicalStateOf = (
  record: AttemptRecord,
  confirmed?: AcknowledgedResult | undefined,
): LogicalState => {
  if (record.state === 'acknowledged' || confirmed !== undefined) return 'created';
  if (record.state === 'blocked' && record.firstUncertainAt === null) return 'refused';

  return 'unresolved';
};

/**
 * Whether the person may edit this input and send it under the same logical attempt.
 *
 * Only a known non-creating attempt qualifies. Everything else keeps its payload frozen, because
 * changing it would mean a second, different request under a key the server may already have used.
 */
export const correctionAllowed = (record: AttemptRecord): boolean =>
  logicalStateOf(record) === 'refused';

/**
 * Whether the record may be replaced atomically by a corrected one.
 *
 * The same question as correction, named separately because the consequence is different and worse:
 * replacement deletes a row. Deleting an ambiguous attempt would erase the only evidence that
 * something may exist on the server, so that is explicit discard and never a side effect of saving.
 */
export const replacementAllowed = correctionAllowed;

export interface AttemptView {
  readonly record: AttemptRecord;
  readonly logical: LogicalState;
  /**
   * The server's answer, when it is known but not yet written down here. Present only in the window
   * between a validated success and a local acknowledgement write that has not yet succeeded.
   */
  readonly confirmed: AcknowledgedResult | null;
  readonly eligibility: Eligibility;
  /** True when this attempt is being sent right now by this process. */
  readonly sending: boolean;
  /** True when the active connection is the one this attempt was made under. */
  readonly connected: boolean;
  readonly canRetry: boolean;
  readonly canCorrect: boolean;
  readonly canOpenDestination: boolean;
  /** The eligibility sentence, when there is one worth showing. */
  readonly note: string | null;
}

export interface ViewInput {
  readonly record: AttemptRecord;
  readonly now: number;
  readonly monotonicElapsedMs: number | null;
  readonly sending: boolean;
  readonly activeConnectionId: string | null;
  /** False when the connection has an unresolved authentication or protocol problem. */
  readonly connectionUsable: boolean;
  /** False when the stored request no longer survives validation. */
  readonly payloadUsable: boolean;
  /** A validated server success held in memory because its local write failed. */
  readonly confirmed?: AcknowledgedResult | undefined;
}

/**
 * Everything a screen needs about one attempt.
 *
 * Every retry condition is checked in one expression rather than distributed over the components
 * that happen to render a button: a matching connection, an eligible window, a payload that still
 * validates, a connection that is not already refusing, and no dispatcher already owning the
 * attempt. Missing any one of them somewhere would offer a send that cannot work, or worse, one that
 * works against the wrong server.
 */
export const viewOf = (input: ViewInput): AttemptView => {
  const { record } = input;
  const eligibility = evaluateEligibility({
    now: input.now,
    firstDispatchAt: record.firstDispatchAt,
    lastObservedAt: record.observedAt,
    clockAnomaly: record.clockAnomaly,
    monotonicElapsedMs: input.monotonicElapsedMs,
  } satisfies EligibilityInput);

  const logical = logicalStateOf(record, input.confirmed);
  const connected = input.activeConnectionId === record.connectionId;

  return {
    record,
    logical,
    confirmed: input.confirmed ?? null,
    eligibility,
    sending: input.sending,
    connected,
    canRetry:
      logical === 'unresolved' &&
      eligibility.kind === 'eligible' &&
      connected &&
      input.connectionUsable &&
      input.payloadUsable &&
      !input.sending,
    canCorrect: correctionAllowed(record) && !input.sending,
    // An old parent id means nothing against another server, so navigating anywhere from an
    // attempt whose connection is not active would be pointing at a coincidence.
    canOpenDestination: connected && !input.sending,
    note: logical === 'unresolved' ? describeEligibility(eligibility) : null,
  };
};

/**
 * What was created, from whichever of the two places knows it.
 *
 * The row once the acknowledgement is written, memory before that. A screen that reached for
 * `record.acknowledged` alone would show nothing during exactly the window this exception exists to
 * cover.
 */
export const createdBy = (view: AttemptView): AcknowledgedResult | null =>
  view.record.acknowledged ?? view.confirmed;

/** Oldest first: the order someone worked in, and the order they are most likely to resolve. */
export const byAttemptAge = (a: AttemptRecord, b: AttemptRecord): number =>
  a.firstDispatchAt - b.firstDispatchAt;

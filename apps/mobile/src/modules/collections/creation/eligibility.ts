/**
 * Whether an attempt may still be replayed, and how that is decided without trusting the clock.
 *
 * The server keeps a creation receipt for exactly 72 hours and expiry is enforced at lookup, so a
 * replay sent after that is not a replay at all - it is a fresh creation carrying a key the server
 * has forgotten. This client stops an hour earlier. One hour is a margin, not a guarantee: a request
 * dispatched just inside the window can still arrive after the server has expired the key, and
 * nothing here promises exactly-once creation across arbitrary clock and network behaviour.
 *
 * **At 71 hours we do not know the receipt has expired.** We know we will not claim it has not. The
 * wording follows that, and says the retry window has ended rather than that the attempt is gone.
 *
 * Three things make the decision conservative rather than trusting:
 *
 * Wall time is supplemented by monotonic elapsed time for attempts this process dispatched, and the
 * larger of the two wins. A clock that jumped backwards would otherwise reopen a window that has
 * really closed.
 *
 * Backward movement is detected against the latest time this attempt was known to observe, not only
 * against its first dispatch. A clock set back by an hour is invisible to the second comparison and
 * obvious to the first.
 *
 * An anomaly, once recorded, is permanent for that attempt. Restoring eligibility when the clock
 * catches up would mean claiming a guarantee from the same measurement that had just been wrong.
 */

/** 71 hours: one inside the server's 72-hour retention. */
export const RETRY_WINDOW_MS = 71 * 60 * 60 * 1000;

export interface EligibilityInput {
  /** Wall clock, now. */
  readonly now: number;
  readonly firstDispatchAt: number;
  /**
   * The latest wall-clock time this attempt is known to have observed - its last recorded
   * transition. Time appearing to be earlier than this is the clock moving, not the attempt aging.
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
  /** Too long has passed. The input, the record, and the recovery entry all stay. */
  | { readonly kind: 'window_ended' }
  /** Time moved in a way that makes the window unmeasurable. Also permanent. */
  | { readonly kind: 'clock_anomaly' };

export const evaluateEligibility = (input: EligibilityInput): Eligibility => {
  if (input.clockAnomaly || input.now < input.lastObservedAt) return { kind: 'clock_anomaly' };

  const byWall = input.now - input.firstDispatchAt;
  const elapsed = Math.max(byWall, input.monotonicElapsedMs ?? 0);

  return elapsed >= RETRY_WINDOW_MS ? { kind: 'window_ended' } : { kind: 'eligible' };
};

export const WINDOW_ENDED_MESSAGE =
  'The retry window has ended. Raphael can no longer resend this attempt, so check the destination before creating it again.';

export const CLOCK_ANOMALY_MESSAGE =
  'The clock changed, so Raphael cannot establish whether this attempt can still be resent. Check the destination before creating it again.';

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

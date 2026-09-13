/**
 * The two judgements every hierarchy failure needs, in one place and out of the components.
 *
 * Both were previously made by hand on each screen, and both were made wrongly. Screens hardcoded
 * "the most recent check did not reach the server", which is true of exactly one of the three ways
 * a reading can fail; and every screen offered a Try again, including against a refusal that says
 * trying again cannot work. Pulled out here so they can be tested rather than read.
 */

export interface HierarchyRefusal {
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Whether to offer a retry.
 *
 * Anything that is not a refusal is an unreachable or interrupted read, which is always worth
 * another go. A refusal is only worth retrying when it was a contradiction between pages - the next
 * reading is very likely to be consistent. A settled refusal, such as a hierarchy larger than this
 * app will read, gets no button, because one that can only fail again is worse than none.
 */
export const offersRetry = (refusal: HierarchyRefusal | null): boolean =>
  refusal === null || refusal.retryable;

/**
 * What to say over data that was complete when it was read and could not be refreshed.
 *
 * The refusal's own sentence when there is one. Blaming the network otherwise would send someone to
 * check a connection that was working perfectly - the server answered, and what it answered with is
 * the thing that could not be used.
 */
export const staleSentence = (refusal: HierarchyRefusal | null): string =>
  refusal === null
    ? 'This is the last complete reading Raphael could take. The most recent check did not reach the server, so anything changed since is not here.'
    : `This is the last complete reading Raphael could take, and it is not current. ${refusal.message}`;

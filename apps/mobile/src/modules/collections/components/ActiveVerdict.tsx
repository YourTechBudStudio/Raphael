import { Text } from 'react-native';

import type { ActiveFailure } from '../client/active';

const COPY = {
  failed: 'Active status did not update. Try again.',
  conflict: 'This project changed since you looked. Refreshing it; then try again.',
} as const;

interface ActiveVerdictProps {
  failure: ActiveFailure;
  className?: string | undefined;
}

/**
 * What became of the last attempt to change a project's active status.
 *
 * One component for both places that say it - the Home card and the Project header - because they
 * are the same sentence about the same write, and two copies of product wording drift.
 *
 * The two colours follow the app's existing rule rather than the two outcomes being equally bad. A
 * refusal is danger: the change did not happen and the person has to act. A conflict is soft ink:
 * the row moved under them, a refresh is already running, and that is information rather than a
 * failure of their write. The conflict sentence is careful not to claim the refresh has finished,
 * because the error path deliberately does not wait for it.
 *
 * Nothing is drawn while a write is in flight. The control is disabled and carries a turning ring,
 * which says everything there is to say; a sentence beside it would be a second voice on one fact.
 * Callers pass `null` for that case rather than this file guessing at it.
 */
export function ActiveVerdict({ failure, className }: ActiveVerdictProps) {
  if (failure === null) return null;

  return (
    <Text
      accessibilityLiveRegion="polite"
      className={[
        'font-body text-[14px] leading-[20px]',
        failure === 'failed' ? 'text-danger' : 'text-ink-soft',
        className ?? '',
      ].join(' ')}
    >
      {COPY[failure]}
    </Text>
  );
}

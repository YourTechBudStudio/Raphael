import { Text, View } from 'react-native';

import type { PendingAttempt } from '../../../infrastructure/api/contracts';
import { Chip } from '../../../ui';
import { useSheetsStore } from '../../navigation';
import { usePendingStore } from '../state/pending';

export interface UnresolvedAttemptsProps {
  /** The area whose unresolved creations to show; null for the top level. */
  parentAreaId: string | null;
  className?: string | undefined;
}

/**
 * A quiet line for each creation that was closed while its outcome was unknown, on the screen
 * where the result would appear. Tapping reopens the sheet on that same attempt. It renders
 * nothing when there is nothing unresolved, which is nearly always.
 */
export function UnresolvedAttempts({ parentAreaId, className }: UnresolvedAttemptsProps) {
  const attempts = usePendingStore((state) => state.attempts);
  const resume = useSheetsStore((state) => state.resumeContainer);
  const here = attempts.filter((attempt) => attempt.parentAreaId === parentAreaId);

  if (here.length === 0) return null;

  return (
    <View className={['gap-2', className ?? ''].join(' ')}>
      {here.map((attempt: PendingAttempt) => (
        <View
          className="flex-row flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-line bg-card px-4 py-3"
          key={attempt.attemptKey}
        >
          <Text className="flex-1 font-body text-[15px] leading-[22px] text-ink">
            {`Not sure whether the ${attempt.type} ${attempt.title} was created.`}
          </Text>
          <Chip
            accessibilityHint="Reopens the sheet to check or try again"
            label="Resolve"
            onPress={() => {
              resume(attempt);
            }}
          />
        </View>
      ))}
    </View>
  );
}

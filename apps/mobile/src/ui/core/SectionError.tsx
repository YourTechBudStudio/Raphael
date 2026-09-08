import { View } from 'react-native';

import { Chip } from './Chip';
import { EmptyState } from './EmptyState';

export interface SectionErrorProps {
  /** What failed, named so the message is about this section and not the whole screen. */
  title: string;
  onRetry: () => void;
  /** True while the retry is in flight, so the chip does not invite a second tap. */
  retrying?: boolean | undefined;
  testID?: string | undefined;
}

/**
 * A section that could not load. It says so plainly and offers the one useful next action,
 * rather than leaving a skeleton in place and implying the content is still on its way.
 */
export function SectionError({ title, onRetry, retrying = false, testID }: SectionErrorProps) {
  return (
    <View className="gap-3" testID={testID}>
      <EmptyState description="Something went wrong on the way here." title={title} />
      <Chip
        accessibilityHint="Loads this section again"
        disabled={retrying}
        label={retrying ? 'Trying again…' : 'Try again'}
        onPress={onRetry}
      />
    </View>
  );
}

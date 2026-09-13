import { View } from 'react-native';

import { Chip } from './Chip';
import { EmptyState } from './EmptyState';

export interface SectionErrorProps {
  /** What failed, named so the message is about this section and not the whole screen. */
  title: string;
  /**
   * What went wrong, when the section knows something more useful than "something went wrong".
   *
   * Worth passing whenever the failure carries its own sentence. A person who is told the server
   * holds more than this app will read has learned something they can act on; a person told a
   * section did not load has learned only that it did not load.
   */
  description?: string | undefined;
  /**
   * Omitted when trying again cannot help.
   *
   * A retry offered against a settled answer is worse than no retry: it invites someone to keep
   * pressing a button that will keep failing, and implies the failure is the transient kind.
   */
  onRetry?: (() => void) | undefined;
  /** True while the retry is in flight, so the chip does not invite a second tap. */
  retrying?: boolean | undefined;
  testID?: string | undefined;
}

/**
 * A section that could not load. It says so plainly and offers the one useful next action,
 * rather than leaving a skeleton in place and implying the content is still on its way.
 */
export function SectionError({
  title,
  description,
  onRetry,
  retrying = false,
  testID,
}: SectionErrorProps) {
  return (
    <View className="gap-3" testID={testID}>
      <EmptyState
        description={description ?? 'Something went wrong on the way here.'}
        title={title}
      />
      {onRetry === undefined ? null : (
        <Chip
          accessibilityHint="Loads this section again"
          disabled={retrying}
          label={retrying ? 'Trying again…' : 'Try again'}
          onPress={onRetry}
        />
      )}
    </View>
  );
}

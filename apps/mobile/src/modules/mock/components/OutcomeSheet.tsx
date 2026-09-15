/**
 * THROWAWAY MOCK. A bottom sheet for an outcome that needs a decision: heading, one paragraph,
 * the actions, and nothing else on screen competing with it.
 */

import { Text, View } from 'react-native';

import { Chip, PrimaryButton, Sheet } from '../../../ui';
import type { MockOutcome } from '../state';

export interface OutcomeSheetProps {
  outcome: MockOutcome | null;
  destinationTitle: string;
  onRetry: () => void;
  onClose: () => void;
}

export function OutcomeSheet({ outcome, destinationTitle, onRetry, onClose }: OutcomeSheetProps) {
  const refused = outcome === 'refused';

  return (
    <Sheet
      className="gap-4 px-5 pb-2 pt-1"
      label="the save outcome"
      onClose={onClose}
      visible={outcome !== null && outcome !== 'saved'}
    >
      <Text accessibilityRole="header" className="font-heading text-[24px] leading-[30px] text-ink">
        {refused ? 'Not saved' : 'Raphael cannot tell whether this saved'}
      </Text>
      <Text className="font-body text-[16px] leading-[24px] text-ink">
        {refused
          ? 'Your server refused this: the title is longer than 200 characters. Nothing was created, and everything you wrote is still here.'
          : 'The request went out, but no answer came back. Your note is kept on this phone. Trying again sends exactly the same request, so it cannot make a second copy.'}
      </Text>
      {refused ? (
        <PrimaryButton label="Back to the note" onPress={onClose} />
      ) : (
        <View className="gap-3">
          <PrimaryButton label="Try the same save again" onPress={onRetry} />
          <View className="flex-row flex-wrap gap-2">
            <Chip label={`Look in ${destinationTitle}`} onPress={onClose} />
            <Chip label="Keep editing" onPress={onClose} />
          </View>
        </View>
      )}
    </Sheet>
  );
}

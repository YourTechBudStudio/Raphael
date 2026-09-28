import { X } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, PrimaryButton } from '../../../ui';

/**
 * Why an entity could not be opened, in the distinctions that change what someone should do:
 * `retryable` might work next time, `missing` is the server having looked and found nothing, and
 * `unopenable` is settled.
 */
export type UnavailableReason = 'retryable' | 'missing' | 'unopenable';

/**
 * One heading and one sentence per reason.
 *
 * "Try again later" is either the whole remedy or actively misleading, and "it is not here" is a
 * claim about someone's data rather than about a request - there is no single wording that is honest
 * for all three, so each says only what is true of it.
 *
 * Generalized past "note": the same editor opens areas and projects, and by the time this screen is
 * drawn the read that would have said which kind it is has already failed.
 */
const COPY: Record<UnavailableReason, { heading: string; sentence: string }> = {
  retryable: {
    heading: 'This could not be opened',
    // Cause-neutral, because this one sentence covers a phone with no signal, a request that timed
    // out, and a server that answered 5xx. Naming the server as unreachable would be false for the
    // third, and there is nothing a person does differently across the three anyway.
    sentence: 'Raphael could not read it right now. Nothing has changed; try again later.',
  },
  missing: {
    heading: 'This is not here.',
    sentence: 'The link may be old, or it was removed since it was made.',
  },
  unopenable: {
    heading: 'This could not be opened',
    sentence:
      'Raphael could not open what your server sent back. Nothing has changed, and trying again will not help.',
  },
};

export interface EntityUnavailableProps {
  reason: UnavailableReason;
  onClose: () => void;
}

/**
 * An entity that could not be opened for editing. There is deliberately no editor here: an editor
 * holding nothing looks exactly like an empty entity, and autosave would send that emptiness over a
 * body the server still holds.
 */
export function EntityUnavailable({ reason, onClose }: EntityUnavailableProps) {
  const insets = useSafeAreaInsets();
  const copy = COPY[reason];

  return (
    <View className="flex-1 bg-canvas" testID="entity-unavailable">
      <View className="h-14 flex-row items-center px-3" style={{ marginTop: insets.top + 4 }}>
        <IconButton icon={X} label="Close" onPress={onClose} />
      </View>
      <View className="flex-1 justify-center px-5 pb-24">
        <Text
          accessibilityRole="header"
          className="font-heading text-[26px] leading-[32px] text-ink"
        >
          {copy.heading}
        </Text>
        <Text
          className="mt-3 font-body text-[16px] leading-[24px] text-ink"
          testID="entity-unavailable-reason"
        >
          {copy.sentence}
        </Text>
        <PrimaryButton className="mt-6" label="Back to Home" onPress={onClose} />
      </View>
    </View>
  );
}

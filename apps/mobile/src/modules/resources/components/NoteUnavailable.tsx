import { X } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, PrimaryButton } from '../../../ui';
import type { NoteUnavailableReason } from '../client/display';

/**
 * One heading and one sentence per reason.
 *
 * "Try again later" is either the whole remedy or actively misleading, and "it is not here" is a
 * claim about someone's data rather than about a request — there is no single wording that is honest
 * for all three, so each says only what is true of it.
 */
const COPY: Record<NoteUnavailableReason, { heading: string; sentence: string }> = {
  retryable: {
    heading: 'This note could not be opened',
    // Cause-neutral, because this one sentence covers a phone with no signal, a request that timed
    // out, and a server that answered 5xx. Naming the server as unreachable would be false for the
    // third, and there is nothing a person does differently across the three anyway.
    sentence:
      'Raphael could not read it right now. Nothing about the note has changed; try again later.',
  },
  missing: {
    heading: 'This note is not here.',
    sentence: 'The link may be old, or the note was removed since it was made.',
  },
  unopenable: {
    heading: 'This note could not be opened',
    sentence:
      'Raphael could not open what your server sent back. Nothing about the note has changed, and trying again will not help.',
  },
};

export interface NoteUnavailableProps {
  reason: NoteUnavailableReason;
  onHome: () => void;
}

/**
 * A note that could not be opened.
 *
 * There is no editor here, deliberately. An editor holding nothing looks exactly like a note that is
 * empty, and someone who then typed into it would be writing into a screen that never loaded what
 * they came to read. So a failed read is its own screen with one way out, and nothing on it can be
 * mistaken for the note.
 *
 * One heading, one sentence and one action, as the design freezes — chosen by cause, because a
 * server that answered "no such note" and a server that did not answer at all need different words
 * and there is no wording that is honest for both.
 */
export function NoteUnavailable({ reason, onHome }: NoteUnavailableProps) {
  const insets = useSafeAreaInsets();
  const copy = COPY[reason];

  return (
    <View className="flex-1 bg-canvas" testID="note-unavailable">
      <View className="h-14 flex-row items-center px-3" style={{ marginTop: insets.top + 4 }}>
        <IconButton icon={X} label="Close" onPress={onHome} />
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
          testID="note-unavailable-reason"
        >
          {copy.sentence}
        </Text>
        <PrimaryButton className="mt-6" label="Back to Home" onPress={onHome} />
      </View>
    </View>
  );
}

import { X } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, PrimaryButton, PressableFeedback } from '../../../ui';
import type { UnavailableReason } from '../edit-display.ts';

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

/**
 * Why there is no editor, in the two shapes that differ in what can be done about it.
 *
 * `unreadable` is a read that did not produce something to edit, and there is nothing on this phone
 * to lose. `retained` is the opposite: changes are sitting here that this build cannot open, and the
 * only thing anyone may do with them is throw them away deliberately.
 */
export type EntityUnavailableState =
  | { readonly kind: 'unreadable'; readonly reason: UnavailableReason }
  /** The sentence comes from `EDIT_PROBLEM_COPY`, so the card and this screen say the same thing. */
  | { readonly kind: 'retained'; readonly sentence: string };

export interface EntityUnavailableProps {
  state: EntityUnavailableState;
  onClose: () => void;
  /** Offered only for a retained record, and confirmed by whoever passes it. */
  onDiscard?: (() => void) | undefined;
}

/**
 * An entity that could not be opened for editing.
 *
 * There is no editor here, deliberately, and on an editing screen that is a data rule rather than a
 * presentational one. An editor holding nothing looks exactly like an entity that is empty, and
 * autosave would then send that emptiness over a body the server still holds intact. So anything
 * that leaves the editor without a document is its own screen with no editor on it at all.
 *
 * One heading, one sentence and one way out - plus, for changes this build cannot read, a deliberate
 * way to throw them away. Nothing here is reached by accident: the retained row stays exactly as it
 * is until someone says otherwise.
 */
export function EntityUnavailable({ state, onClose, onDiscard }: EntityUnavailableProps) {
  const insets = useSafeAreaInsets();
  const copy =
    state.kind === 'unreadable'
      ? COPY[state.reason]
      : { heading: 'These changes could not be opened', sentence: state.sentence };

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
        {onDiscard === undefined ? null : (
          <PressableFeedback
            accessibilityHint="Removes these changes from this phone. What is on your server stays as it is."
            accessibilityLabel="Discard these changes"
            accessibilityRole="button"
            className="mt-2 h-11 items-center justify-center rounded-full"
            onPress={onDiscard}
            testID="entity-unavailable-discard"
            treatment="button"
          >
            <Text className="font-body-semibold text-[15px] text-danger">Discard</Text>
          </PressableFeedback>
        )}
      </View>
    </View>
  );
}

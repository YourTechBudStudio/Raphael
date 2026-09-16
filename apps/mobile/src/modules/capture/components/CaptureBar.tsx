import { Mic } from 'lucide-react-native';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableFeedback, captureShadow, colors } from '../../../ui';

/** Capture control height and the mic circle diameter. */
const CONTROL_SIZE = 56;

export interface CaptureBarProps {
  onVoice: () => void;
  testID?: string | undefined;
}

/**
 * The floating capture control, pinned above the safe area.
 *
 * It used to name where a capture would land. It cannot and should not: a destination is chosen
 * while writing, so a bar that promised one beforehand would be naming a place nobody had picked.
 *
 * **The New note pill is temporarily absent.** Text capture used to open a sheet that wrote a
 * session-only mock note, and Phase 04 retired that rather than leave a control that looks like
 * saving a note and is not. It comes back in Phase 06, over the durable capture owner and its own
 * route, with the paired layout the design specifies. A disabled or no-op pill in the meantime would
 * be a worse answer than an honest absence, which is why `onNewNote` is gone from these props rather
 * than accepting a callback that does nothing.
 */
export function CaptureBar({ onVoice, testID }: CaptureBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="absolute inset-x-0 bottom-0 items-center"
      pointerEvents="box-none"
      style={{ paddingBottom: insets.bottom + 16 }}
      testID={testID}
    >
      <PressableFeedback
        accessibilityHint="Starts recording a voice note"
        accessibilityLabel="Record a voice note"
        className="items-center justify-center rounded-full bg-primary"
        onPress={onVoice}
        treatment="button"
        stateLayerColor={colors.onPrimary}
        style={{ borderRadius: CONTROL_SIZE / 2, boxShadow: captureShadow }}
      >
        <View
          className="items-center justify-center"
          style={{ height: CONTROL_SIZE, width: CONTROL_SIZE }}
        >
          <Mic color={colors.onPrimary} size={24} strokeWidth={2} />
        </View>
      </PressableFeedback>
    </View>
  );
}

import { Mic, Plus } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnimatedSurface, PressableFeedback, captureShadow, colors } from '../../../ui';

/** Capture control height and the mic circle diameter. */
const CONTROL_SIZE = 56;

export interface CaptureBarProps {
  onNewNote: () => void;
  onVoice: () => void;
  /** Names where the capture lands, e.g. `Design`, for the spoken hints. */
  targetName?: string | undefined;
  testID?: string | undefined;
}

/** The floating capture pair: a New note pill and a mic circle, pinned above the safe area. */
export function CaptureBar({ onNewNote, onVoice, targetName, testID }: CaptureBarProps) {
  const insets = useSafeAreaInsets();
  const hint = targetName === undefined ? undefined : `Saves to ${targetName}`;

  return (
    <View
      className="absolute inset-x-0 bottom-0 items-center"
      pointerEvents="box-none"
      style={{ paddingBottom: insets.bottom + 16 }}
      testID={testID}
    >
      <View className="flex-row items-center gap-3">
        <PressableFeedback
          accessibilityHint={hint}
          accessibilityLabel="New note"
          className="flex-row items-center justify-center gap-2 rounded-full bg-primary px-7"
          onPress={onNewNote}
          treatment="button"
          stateLayerColor={colors.onPrimary}
          style={{ borderRadius: CONTROL_SIZE / 2, boxShadow: captureShadow }}
        >
          {(stableContentStyle) => (
            <AnimatedSurface
              className="flex-row items-center gap-2"
              style={[{ height: CONTROL_SIZE }, stableContentStyle]}
            >
              <Plus color={colors.onPrimary} size={24} strokeWidth={2.2} />
              <Text className="font-body-semibold text-[18px] text-on-primary">New note</Text>
            </AnimatedSurface>
          )}
        </PressableFeedback>
        <PressableFeedback
          accessibilityHint={hint}
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
    </View>
  );
}

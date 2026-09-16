import { Mic, Pencil } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  PressableFeedback,
  SNACKBAR_IN_MS,
  SNACKBAR_OUT_MS,
  captureShadow,
  colors,
} from '../../../ui';

/** Capture control height and the mic circle diameter. */
const CONTROL_SIZE = 56;

export interface CaptureBarProps {
  onNewNote: () => void;
  onVoice: () => void;
  /** Lifted by a notice below it, so the snackbar never covers the pair. */
  lift?: number | undefined;
  /** True while a draft is being started, so a second tap cannot start a second one. */
  busy?: boolean | undefined;
  testID?: string | undefined;
}

/**
 * The floating capture pair, pinned above the safe area.
 *
 * It does not name where a capture would land and must not: a destination is chosen while writing,
 * so a bar promising one beforehand would be naming a place nobody had picked.
 *
 * New note is back, and it is real. Pressing it asks the owner for a durable draft **before** the
 * route opens, so there is never a composer over writing that has nowhere to be kept - which is why
 * it is busy-guarded rather than optimistic.
 */
export function CaptureBar({
  onNewNote,
  onVoice,
  lift = 0,
  busy = false,
  testID,
}: CaptureBarProps) {
  const insets = useSafeAreaInsets();
  const raised = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();

  // The same timing as the notice that causes it, so the pair and the snackbar move together
  // rather than one chasing the other.
  useEffect(() => {
    Animated.timing(raised, {
      toValue: lift,
      duration: reducedMotion ? 0 : lift > 0 ? SNACKBAR_IN_MS : SNACKBAR_OUT_MS,
      easing: lift > 0 ? Easing.out(Easing.ease) : Easing.in(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [lift, raised, reducedMotion]);

  return (
    <Animated.View
      className="absolute inset-x-0 bottom-0 flex-row items-center justify-center gap-3"
      pointerEvents="box-none"
      style={{
        paddingBottom: insets.bottom + 16,
        transform: [{ translateY: Animated.multiply(raised, -1) }],
      }}
      testID={testID}
    >
      <PressableFeedback
        accessibilityHint="Opens a new note to write"
        accessibilityLabel="New note"
        accessibilityState={{ disabled: busy }}
        className="flex-row items-center gap-2 rounded-full bg-primary px-5"
        disabled={busy}
        onPress={onNewNote}
        stateLayerColor={colors.onPrimary}
        style={{ borderRadius: CONTROL_SIZE / 2, boxShadow: captureShadow }}
        testID="new-note"
        treatment="button"
      >
        <View className="flex-row items-center gap-2" style={{ height: CONTROL_SIZE }}>
          <Pencil color={colors.onPrimary} size={20} strokeWidth={2} />
          <Text className="font-body-semibold text-[16px] text-on-primary">New note</Text>
        </View>
      </PressableFeedback>

      <PressableFeedback
        accessibilityHint="Starts recording a voice note"
        accessibilityLabel="Record a voice note"
        className="items-center justify-center rounded-full bg-primary"
        onPress={onVoice}
        stateLayerColor={colors.onPrimary}
        style={{ borderRadius: CONTROL_SIZE / 2, boxShadow: captureShadow }}
        treatment="button"
      >
        <View
          className="items-center justify-center"
          style={{ height: CONTROL_SIZE, width: CONTROL_SIZE }}
        >
          <Mic color={colors.onPrimary} size={24} strokeWidth={2} />
        </View>
      </PressableFeedback>
    </Animated.View>
  );
}

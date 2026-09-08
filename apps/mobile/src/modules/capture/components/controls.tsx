import { Pause, Play, Square } from 'lucide-react-native';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { CircleButton, colors, PressableFeedback, AnimatedSurface } from '../../../ui';

const PULSE_DURATION = 700;

/**
 * The one thing on this sheet that moves at rest, and only while the mock recorder is actually
 * running. With reduced motion on it holds still and the label carries the state instead.
 */
export function RecordingIndicator() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reducedMotion) {
      opacity.value = 1;

      return;
    }

    opacity.value = withRepeat(
      withTiming(0.25, { duration: PULSE_DURATION, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );

    return () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
  }, [opacity, reducedMotion]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <View accessible accessibilityLabel="Recording" className="flex-row items-center gap-2">
      <Animated.View
        style={[
          dotStyle,
          { backgroundColor: colors.primary, borderRadius: 5, height: 10, width: 10 },
        ]}
      />
      <Text className="font-body-medium text-[15px] text-primary">Recording</Text>
    </View>
  );
}

export interface StopButtonProps {
  onPress: () => void;
}

/** The primary recording action: one big violet target that ends the take. */
export function StopButton({ onPress }: StopButtonProps) {
  return (
    <CircleButton
      accessibilityHint="Ends the recording so you can play it back and save it."
      icon={Square}
      iconSize={26}
      label="Stop recording"
      onPress={onPress}
      size={72}
      tone="primary"
    />
  );
}

export interface ReviewPlayButtonProps {
  playing: boolean;
  onPress: () => void;
}

/** Playback for the take you just made, in the same peach as every saved voice note. */
export function ReviewPlayButton({ playing, onPress }: ReviewPlayButtonProps) {
  return (
    <CircleButton
      icon={playing ? Pause : Play}
      iconSize={20}
      label={playing ? 'Pause the recording' : 'Play the recording'}
      onPress={onPress}
      size={56}
    />
  );
}

export interface TextActionProps {
  label: string;
  onPress: () => void;
  accessibilityHint?: string | undefined;
}

/** A quiet secondary action: cancel, record again. Full 44pt target with no surface. */
export function TextAction({ label, onPress, accessibilityHint }: TextActionProps) {
  return (
    <PressableFeedback
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      className="h-11 items-center justify-center px-2"
      onPress={onPress}
      treatment="button"
      stateLayerColor={colors.primary}
    >
      {(stableContentStyle) => (
        <AnimatedSurface style={stableContentStyle}>
          <Text className="font-body-medium text-[16px] text-primary">{label}</Text>
        </AnimatedSurface>
      )}
    </PressableFeedback>
  );
}

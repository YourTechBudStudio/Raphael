import { useEffect } from 'react';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { colors } from '../theme';

/** One turn of the ring. Slow enough to read as waiting rather than as urgency. */
const TURN_DURATION = 1100;

/** How much of the circumference the arc covers. */
const ARC = 0.28;

interface BusyRingProps {
  /** The mark's box, which the ring is drawn around: 48 on a bare mark, 44 on a labelled one. */
  size: number;
}

/**
 * A thin lilac arc turning around a toggle's mark while its write, and the re-read that follows it,
 * are in flight.
 *
 * Lilac is a deliberate exception to the app's rule that in-progress indicators are `primary`. The
 * ring sits directly around a violet mark, and in primary the two read as one louder violet shape;
 * in lilac the ring stays legible as a separate, quieter thing. Do not "correct" it.
 *
 * It surrounds the mark rather than replacing it, because the mark underneath keeps showing the
 * state that was written. What is on screen during the wait is therefore true, not a placeholder.
 *
 * Under reduced motion the same arc is drawn and simply does not turn. That still distinguishes
 * busy from idle, which is the whole job; the rotation is emphasis, not the signal.
 *
 * Decorative and non-interactive. The owning control carries the semantics - `disabled` and
 * `accessibilityState.busy` - because a screen reader should hear one control, not a control and a
 * spinner.
 */
export function BusyRing({ size }: BusyRingProps) {
  const reducedMotion = useReducedMotion();
  const turn = useSharedValue(0);

  // The ring exists only while a write is in flight, so it mounts and unmounts on every toggle.
  // That makes the teardown an ordinary path rather than a rare one, and it is written the way
  // `RecordingIndicator` writes the same repeating shape: stop the animation and put the value back.
  useEffect(() => {
    if (reducedMotion) {
      turn.value = 0;

      return;
    }

    turn.value = withRepeat(
      withTiming(360, { duration: TURN_DURATION, easing: Easing.linear }),
      -1,
      false,
    );

    return () => {
      cancelAnimation(turn);
      turn.value = 0;
    };
  }, [reducedMotion, turn]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
  const radius = size / 2 - 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', left: 0, top: 0, width: size, height: size }, style]}
    >
      <Svg
        accessible={false}
        height={size}
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        width={size}
      >
        <Circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={colors.lilac}
          strokeDasharray={`${String(circumference * ARC)} ${String(circumference)}`}
          strokeLinecap="round"
          strokeWidth={2}
        />
      </Svg>
    </Animated.View>
  );
}

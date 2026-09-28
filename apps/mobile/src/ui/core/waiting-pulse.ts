import { useEffect } from 'react';
import {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

/** One breath: fade to soft and back. Slow enough to read as waiting, not blinking. */
const PULSE_DURATION = 900;
const PULSE_LOW = 0.45;

/**
 * The slow breath that says work is in flight: fade to soft and back, forever, until unmounted.
 *
 * Shared so every waiting thing breathes at one rhythm - a "Searching…" line, a list row being sent.
 * Under reduced motion it holds still; the words already say it.
 */
export function useWaitingPulse() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    // Cancelled rather than merely not started. Reduced motion can be turned on while the line is
    // showing, and an early return alone would leave the pulse it had already started running.
    if (reducedMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;

      return;
    }

    opacity.value = withRepeat(
      withTiming(PULSE_LOW, { duration: PULSE_DURATION, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );

    return () => {
      cancelAnimation(opacity);
    };
  }, [reducedMotion, opacity]);

  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

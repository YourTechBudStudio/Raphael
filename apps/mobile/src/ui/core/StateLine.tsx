import { useEffect } from 'react';
import { Text } from 'react-native';
import Animated, {
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

const LINE = 'font-body text-[15px] leading-[22px] text-ink-soft';

export interface StateLineProps {
  children: string;
  className?: string | undefined;
}

/**
 * A quiet sentence on the canvas, for states that are not content: empty, no match, ended.
 *
 * Plain soft ink with no card, so every list says "there is nothing here" the same way. Announced
 * politely, because it replaces whatever the list was showing a moment ago.
 */
export function StateLine({ children, className }: StateLineProps) {
  return (
    <Text accessibilityLiveRegion="polite" className={[LINE, className ?? ''].join(' ')}>
      {children}
    </Text>
  );
}

/**
 * A waiting sentence - "Searching…", "Loading more…" - with a slow pulse while the server looks.
 *
 * The pulse is the only motion, and it says work is in flight rather than decorating the wait.
 * Under reduced motion the sentence holds still: the words already say it.
 */
export function WaitingLine({ children }: { children: string }) {
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

  const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text accessibilityLiveRegion="polite" className={LINE} style={pulse}>
      {children}
    </Animated.Text>
  );
}

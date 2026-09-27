/**
 * Temporary: favorites mock for story #14. The quiet sentences a list shows when it has no rows,
 * shared by Favorites and Search so both say "empty" and "waiting" the same way Home and Search do
 * today: plain soft ink on the canvas, no card.
 */

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

const LINE = 'font-body text-[15px] leading-[22px] text-ink-soft';

export function StateLine({ children }: { children: string }) {
  return (
    <Text accessibilityLiveRegion="polite" className={LINE}>
      {children}
    </Text>
  );
}

/** A waiting sentence with Search's slow pulse. Under reduced motion it holds still. */
export function PulseLine({ children }: { children: string }) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;

      return;
    }

    opacity.value = withRepeat(
      withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.sin) }),
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

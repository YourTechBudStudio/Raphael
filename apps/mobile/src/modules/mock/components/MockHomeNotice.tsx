/**
 * THROWAWAY MOCK. What Home says after a save brought you back: one snackbar, gone on its own,
 * and the capture pair lifts to make room for it. Frozen decision.
 */

import { useEffect, type ReactNode } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { describeDestination } from '../data';
import { SNACKBAR_ENTER_MS, SNACKBAR_EXIT_MS, SNACKBAR_HEIGHT } from '../snackbar-motion';
import { useMockStore } from '../state';
import { Snackbar } from './Snackbar';

/** Gap between the snackbar and whatever sits above or below it. */
const GAP = 12;
const SUCCESS_VISIBLE_MS = 2000;

/** Render after the capture bar in Home's outer view. */
export function MockHomeSnackbar() {
  const insets = useSafeAreaInsets();
  const notice = useMockStore((state) => state.homeNotice);
  const setNotice = useMockStore((state) => state.setHomeNotice);

  if (notice === null) return null;

  return (
    <Snackbar
      autoHideMs={SUCCESS_VISIBLE_MS}
      bottom={insets.bottom + 16}
      dismissable={false}
      message={`Saved in ${describeDestination(notice.destination)}.`}
      onDismiss={() => {
        setNotice(null);
      }}
    />
  );
}

/** Wraps the capture bar so it lifts while the snackbar is showing. */
export function MockCaptureLift({ children }: { children: ReactNode }) {
  const notice = useMockStore((state) => state.homeNotice);
  const lift = useSharedValue(0);
  const lifted = notice !== null;

  useEffect(() => {
    lift.value = withTiming(lifted ? SNACKBAR_HEIGHT + GAP : 0, {
      duration: lifted ? SNACKBAR_ENTER_MS : SNACKBAR_EXIT_MS,
      easing: lifted ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    });
  }, [lift, lifted]);

  const style = useAnimatedStyle(() => ({ transform: [{ translateY: -lift.value }] }));

  return (
    <Animated.View className="absolute inset-x-0 bottom-0" pointerEvents="box-none" style={style}>
      {children}
    </Animated.View>
  );
}

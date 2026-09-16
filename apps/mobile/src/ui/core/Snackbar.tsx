import { useEffect, useRef } from 'react';
import { Animated, Easing, Text, View, type LayoutChangeEvent } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SNACKBAR_HOLD_MS, SNACKBAR_IN_MS, SNACKBAR_OUT_MS } from './snackbar-motion';

/** How far above the safe-area edge it sits. */
const BOTTOM_INSET = 16;

export interface SnackbarProps {
  /** The sentence, or null when there is nothing to say. Changing it restarts the appearance. */
  message: string | null;
  /** Called once the message has actually been on screen. Never on mount or on dismissal. */
  onShown?: (() => void) | undefined;
  /** Called after it has held its time and left, so the host can clear what it was showing. */
  onHidden?: (() => void) | undefined;
  /** Its measured height, so a host can lift what the snackbar would otherwise cover. */
  onHeight?: ((height: number) => void) | undefined;
  testID?: string | undefined;
}

/**
 * A deep ink notice that says one thing and leaves.
 *
 * No action, no dismiss control, gone after two seconds. It is a statement about something that has
 * already happened, which is why there is nothing on it to press: the note is on the server whether
 * or not anyone reads this.
 *
 * `onShown` is the important seam. The caller uses it to spend the receipt that made this appear,
 * and it fires when the message has been rendered - not when the component mounted, and not when it
 * left - so a success nobody was shown survives to be shown later instead of being quietly spent.
 */
export function Snackbar({ message, onShown, onHidden, onHeight, testID }: SnackbarProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();
  const shown = useRef<string | null>(null);
  // Read fresh, so a host that re-creates its callbacks cannot strand a stale one inside a timer.
  const callbacks = useRef({ onShown, onHidden });
  callbacks.current = { onShown, onHidden };

  useEffect(() => {
    if (message === null) {
      shown.current = null;
      Animated.timing(progress, {
        toValue: 0,
        duration: reducedMotion ? 0 : SNACKBAR_OUT_MS,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }).start();

      return;
    }

    Animated.timing(progress, {
      toValue: 1,
      duration: reducedMotion ? 0 : SNACKBAR_IN_MS,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();

    // Reported once per message. The animation starting is what makes this true: the view is
    // mounted, laid out and on its way in, so the thing it reports has been told.
    if (shown.current !== message) {
      shown.current = message;
      callbacks.current.onShown?.();
    }

    // It holds its time and leaves on its own. There is nothing to press, because it is a
    // statement about something that has already happened.
    const timer = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 0,
        duration: reducedMotion ? 0 : SNACKBAR_OUT_MS,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }).start(() => {
        callbacks.current.onHidden?.();
      });
    }, SNACKBAR_HOLD_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [message, progress, reducedMotion]);

  const insets = useSafeAreaInsets();

  return (
    <View
      className="absolute inset-x-0 bottom-0 px-5"
      pointerEvents="none"
      style={{ paddingBottom: insets.bottom + BOTTOM_INSET }}
      testID={testID}
    >
      <Animated.View
        className="rounded-card bg-ink px-4 py-3"
        onLayout={(event: LayoutChangeEvent) => {
          onHeight?.(event.nativeEvent.layout.height);
        }}
        style={{
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        }}
      >
        {/* Assertive, because it is the only report of something that has finished happening and
            it is gone in two seconds. */}
        <Text
          accessibilityLiveRegion="assertive"
          className="font-body text-[15px] leading-[22px] text-canvas"
        >
          {message ?? ''}
        </Text>
      </Animated.View>
    </View>
  );
}

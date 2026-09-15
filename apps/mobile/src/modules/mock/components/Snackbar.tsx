/**
 * THROWAWAY MOCK. An M3 snackbar in Raphael's clothes: deep ink surface, white text, one lilac
 * action, soft shadow, pinned near the bottom. It stays until dismissed when the message matters.
 */

import { X } from 'lucide-react-native';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, { Easing, FadeInDown, FadeOutDown } from 'react-native-reanimated';

import { colors, PressableFeedback, softShadow } from '../../../ui';
import { SNACKBAR_ENTER_MS, SNACKBAR_EXIT_MS, SNACKBAR_HEIGHT } from '../snackbar-motion';

export interface SnackbarProps {
  message: string;
  action?: { label: string; onPress: () => void } | undefined;
  onDismiss: () => void;
  /** Milliseconds before it leaves on its own. Omit for a message that waits to be read. */
  autoHideMs?: number | undefined;
  /** Distance from the bottom edge, so it clears whatever floats there. */
  bottom: number;
  /** Set false for a message that needs no action and leaves on its own. */
  dismissable?: boolean | undefined;
}

export function Snackbar({
  message,
  action,
  onDismiss,
  autoHideMs,
  bottom,
  dismissable = true,
}: SnackbarProps) {
  useEffect(() => {
    if (autoHideMs === undefined) return;
    const timer = setTimeout(onDismiss, autoHideMs);

    return () => {
      clearTimeout(timer);
    };
  }, [autoHideMs, onDismiss]);

  return (
    <Animated.View
      className="absolute inset-x-4 flex-row items-center gap-3 rounded-[18px] bg-ink py-3 pl-4 pr-1"
      entering={FadeInDown.duration(SNACKBAR_ENTER_MS).easing(Easing.out(Easing.cubic))}
      exiting={FadeOutDown.duration(SNACKBAR_EXIT_MS).easing(Easing.in(Easing.cubic))}
      style={[{ bottom, minHeight: SNACKBAR_HEIGHT }, softShadow]}
    >
      <Text
        accessibilityLiveRegion="polite"
        className="flex-1 font-body text-[15px] leading-[21px] text-on-primary"
      >
        {message}
      </Text>
      {action === undefined ? null : (
        <PressableFeedback
          accessibilityLabel={action.label}
          className="h-10 justify-center rounded-full px-3"
          onPress={action.onPress}
          stateLayerColor={colors.onPrimary}
          treatment="button"
        >
          <Text className="font-body-semibold text-[15px] text-lilac">{action.label}</Text>
        </PressableFeedback>
      )}
      {dismissable ? (
        <PressableFeedback
          accessibilityLabel="Dismiss"
          className="h-10 w-10 items-center justify-center rounded-full"
          onPress={onDismiss}
          stateLayerColor={colors.onPrimary}
          treatment="icon"
        >
          <X color={colors.onPrimary} size={18} strokeWidth={2} />
        </PressableFeedback>
      ) : (
        <View className="w-3" />
      )}
    </Animated.View>
  );
}

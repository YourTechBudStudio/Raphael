import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { interpolate, useAnimatedStyle } from 'react-native-reanimated';

/**
 * `paddingBottom` for a surface pinned to the bottom of the screen that rides up on the keyboard.
 *
 * At rest the surface sits on the screen's edge and has to clear the home indicator or navigation
 * bar. With the keyboard up it sits on the keyboard instead, which already covers that inset, so
 * keeping it would leave a band of empty space between the two. The padding follows the keyboard's
 * own motion from one to the other, so the surface never jumps while the keyboard moves.
 *
 * It only pads. Making room for the keyboard is the job of the `KeyboardAvoidingView` around it.
 */
export function useKeyboardClearance(resting: number, raised: number) {
  const keyboard = useReanimatedKeyboardAnimation();

  return useAnimatedStyle(() => ({
    paddingBottom: interpolate(keyboard.progress.value, [0, 1], [resting, raised]),
  }));
}

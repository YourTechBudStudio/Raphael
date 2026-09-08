import { type ComponentProps, type ReactNode, useEffect, useRef } from 'react';
import {
  Pressable,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type AccessibilityRole,
  type AccessibilityState,
  type AccessibilityValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { colors } from '../theme';
import { AnimatedSurface } from './animated-surface';
import {
  MATERIAL_EFFECTS,
  MATERIAL_STATE_OPACITY,
  PRESS_SCALE,
  PRESS_SPRING,
  RELEASE_SPRING,
} from './motion';

export interface PressableFeedbackProps {
  /** Render function lets text controls counter-scale their content while the background moves. */
  children:
    | ReactNode
    | ((stableContentStyle: ComponentProps<typeof AnimatedSurface>['style']) => ReactNode);
  onPress?: (() => void) | undefined;
  onLongPress?: (() => void) | undefined;
  disabled?: boolean | undefined;
  /** Capture buttons move most; icon buttons less; large surfaces barely compress. */
  treatment?: 'button' | 'icon' | 'surface' | undefined;
  /** M3 state layers use the content's on-container color. */
  stateLayerColor?: string | undefined;
  /** Classes for the visible surface. */
  className?: string | undefined;
  /** Layout for the outer pressable, which never animates. */
  style?: StyleProp<ViewStyle> | undefined;
  hitSlop?: number | undefined;
  accessibilityRole?: AccessibilityRole | undefined;
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string | undefined;
  accessibilityState?: AccessibilityState | undefined;
  accessibilityValue?: AccessibilityValue | undefined;
  accessibilityActions?: readonly AccessibilityActionInfo[] | undefined;
  onAccessibilityAction?: ((event: AccessibilityActionEvent) => void) | undefined;
  testID?: string | undefined;
}

/**
 * Raphael's soft press and tiny spring rebound, with M3 tonal state layers.
 * Resting corners and outer hit targets stay fixed. No burst, fill animation, or action delay.
 * Press/hover/focus state is retargetable; disabled controls reset and reduced motion is immediate.
 * The state layer is our cross-platform indication, not a reproduction of Android's native ripple.
 */
export function PressableFeedback({
  children,
  onPress,
  onLongPress,
  disabled = false,
  treatment = 'surface',
  stateLayerColor = colors.ink,
  className,
  style,
  hitSlop = 8,
  accessibilityRole = 'button',
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  accessibilityValue,
  accessibilityActions,
  onAccessibilityAction,
  testID,
}: PressableFeedbackProps) {
  const reducedMotion = useReducedMotion();
  const interaction = useRef({ pressed: false, hovered: false, focused: false });
  const scale = useSharedValue(1);
  const stateOpacity = useSharedValue(0);

  useEffect(() => {
    if (disabled) {
      interaction.current = { pressed: false, hovered: false, focused: false };
      scale.value = 1;
      stateOpacity.value = 0;
    }
    if (reducedMotion) {
      scale.value = 1;
    }
  }, [disabled, reducedMotion, scale, stateOpacity]);

  const surfaceStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const stableContentStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 / scale.value }],
  }));
  const stateStyle = useAnimatedStyle(() => ({ opacity: stateOpacity.value }));

  const updateInteraction = (state: 'pressed' | 'hovered' | 'focused', value: boolean) => {
    if (disabled) {
      return;
    }
    interaction.current[state] = value;
    const { pressed, hovered, focused } = interaction.current;
    const nextScale = pressed ? PRESS_SCALE[treatment] : 1;
    // Motion carries touch feedback; tone is the reduced-motion fallback only.
    // Preserve independent focus/hover cues even while the control is pressed.
    const nextOpacity = Math.max(
      pressed && reducedMotion ? MATERIAL_STATE_OPACITY.pressed : 0,
      focused ? MATERIAL_STATE_OPACITY.focused : 0,
      hovered ? MATERIAL_STATE_OPACITY.hovered : 0,
    );
    // Hover/focus must not restart an in-flight physical response.
    if (state === 'pressed') {
      scale.value = reducedMotion
        ? 1
        : withSpring(nextScale, pressed ? PRESS_SPRING : RELEASE_SPRING);
    }
    stateOpacity.value = reducedMotion ? nextOpacity : withSpring(nextOpacity, MATERIAL_EFFECTS);
  };

  return (
    <Pressable
      accessibilityActions={
        accessibilityActions === undefined ? undefined : [...accessibilityActions]
      }
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...accessibilityState, disabled }}
      accessibilityValue={accessibilityValue}
      disabled={disabled}
      hitSlop={hitSlop}
      onAccessibilityAction={onAccessibilityAction}
      onBlur={() => updateInteraction('focused', false)}
      onFocus={() => updateInteraction('focused', true)}
      onHoverIn={() => updateInteraction('hovered', true)}
      onHoverOut={() => updateInteraction('hovered', false)}
      onLongPress={onLongPress}
      onPress={onPress}
      onPressIn={() => updateInteraction('pressed', true)}
      onPressOut={() => updateInteraction('pressed', false)}
      style={style}
      testID={testID}
    >
      <AnimatedSurface className={className ?? ''} style={[{ overflow: 'hidden' }, surfaceStyle]}>
        {typeof children === 'function' ? children(stableContentStyle) : children}
        <AnimatedSurface
          accessible={false}
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              inset: 0,
              backgroundColor: stateLayerColor,
            },
            stateStyle,
          ]}
        />
      </AnimatedSurface>
    </Pressable>
  );
}

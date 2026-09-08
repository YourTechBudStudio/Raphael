import type { ReactNode } from 'react';
import {
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type AccessibilityValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { PressableFeedback } from './PressableFeedback';
import { Wave, type WaveVariant } from './Wave';

export type CardVariant = WaveVariant;

export interface CardProps {
  children: ReactNode;
  /** `lilac` is the default surface; `warm` carries text notes and image captions. */
  variant?: CardVariant | undefined;
  /** Draws a wave clipped to the bottom of the card. */
  wave?: boolean | undefined;
  waveHeight?: number | undefined;
  waveSeed?: number | undefined;
  onPress?: (() => void) | undefined;
  className?: string | undefined;
  /** Layout for the stable outer hit area; only the inner surface gently compresses. */
  style?: StyleProp<ViewStyle> | undefined;
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string | undefined;
  accessibilityValue?: AccessibilityValue | undefined;
  /** Screen-reader actions on the card itself, for controls nested inside its press surface. */
  accessibilityActions?: readonly AccessibilityActionInfo[] | undefined;
  onAccessibilityAction?: ((event: AccessibilityActionEvent) => void) | undefined;
  testID?: string | undefined;
}

const SURFACE = 'overflow-hidden rounded-card border border-line';

/**
 * The pale card surface every list and grid is built from: radius 20, a fine lilac
 * border, and `overflow-hidden` so the wave clips to the corners. Pass `onPress` to get
 * the shared press feedback.
 */
export function Card({
  children,
  variant = 'lilac',
  wave = false,
  waveHeight = 64,
  waveSeed = 0,
  onPress,
  className,
  style,
  accessibilityLabel,
  accessibilityHint,
  accessibilityValue,
  accessibilityActions,
  onAccessibilityAction,
  testID,
}: CardProps) {
  const surfaceClassName = [
    SURFACE,
    variant === 'warm' ? 'bg-card-warm' : 'bg-card',
    className ?? '',
  ].join(' ');

  const content = (
    <>
      {wave ? <Wave height={waveHeight} seed={waveSeed} variant={variant} /> : null}
      {children}
    </>
  );

  if (onPress === undefined) {
    return (
      <View className={surfaceClassName} style={style} testID={testID}>
        {content}
      </View>
    );
  }

  return (
    <PressableFeedback
      accessibilityActions={accessibilityActions}
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityValue}
      className={surfaceClassName}
      onAccessibilityAction={onAccessibilityAction}
      onPress={onPress}
      treatment="surface"
      style={style}
      testID={testID}
    >
      {content}
    </PressableFeedback>
  );
}

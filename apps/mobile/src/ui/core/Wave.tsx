import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors } from '../theme';

export type WaveVariant = 'lilac' | 'warm';

export interface WaveProps {
  /** Matches the card it sits in: `lilac` on `bg-card`, `warm` on `bg-card-warm`. */
  variant?: WaveVariant | undefined;
  /** Height of the wave band in logical pixels. */
  height?: number | undefined;
  /** Shifts the curve so neighbouring cards do not look stamped from one template. */
  seed?: number | undefined;
}

const clamp = (value: number) => Math.max(10, Math.min(86, value));

/** A broad, shallow S-curve. `seed` moves the crest without changing the character. */
function wavePath(seed: number): string {
  const phase = Math.sin(seed * 1.7);
  const start = clamp(48 + phase * 8);
  const firstControl = clamp(20 - phase * 6);
  const secondControl = clamp(74 + phase * 6);
  const middle = clamp(46 - phase * 5);
  const thirdControl = clamp(22 + phase * 7);
  const end = clamp(36 - phase * 5);

  return `M0 ${start} C 18 ${firstControl} 40 ${secondControl} 62 ${middle} C 78 ${thirdControl} 90 ${end} 100 ${end} L100 100 L0 100 Z`;
}

/**
 * The decorative wave clipped to the bottom of a card. Static at rest, never interactive.
 */
export function Wave({ variant = 'lilac', height = 64, seed = 0 }: WaveProps) {
  return (
    <View className="absolute inset-x-0 bottom-0" pointerEvents="none" style={{ height }}>
      <Svg height="100%" preserveAspectRatio="none" viewBox="0 0 100 100" width="100%">
        <Path d={wavePath(seed)} fill={variant === 'warm' ? colors.waveWarm : colors.wave} />
      </Svg>
    </View>
  );
}

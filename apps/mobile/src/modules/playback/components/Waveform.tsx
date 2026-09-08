import clsx from 'clsx';
import { View } from 'react-native';

import { colors } from '../../../ui';

const MIN_BAR_HEIGHT = 3;

export interface WaveformProps {
  /** Amplitudes in 0..1, one per bar. */
  values: readonly number[];
  /** How far playback has travelled, 0..1. Bars before it read as played. */
  progress?: number | undefined;
  /** Height of the tallest bar, in logical pixels. */
  height?: number | undefined;
  barWidth?: number | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/**
 * The still bars of a voice note. Nothing here animates on its own: the only movement is
 * the played portion turning violet as the playback store ticks.
 */
export function Waveform({
  values,
  progress = 0,
  height = 40,
  barWidth = 2,
  className,
  testID,
}: WaveformProps) {
  const played = Math.max(0, Math.min(1, progress)) * values.length;

  return (
    <View
      accessibilityElementsHidden
      className={clsx('flex-row items-center justify-between', className)}
      importantForAccessibility="no-hide-descendants"
      style={{ height }}
      testID={testID}
    >
      {values.map((value, index) => {
        const amplitude = Math.max(0, Math.min(1, value));

        return (
          <View
            // Bars have no identity beyond their position in the sample.
            key={index}
            style={{
              width: barWidth,
              borderRadius: barWidth / 2,
              height: Math.max(MIN_BAR_HEIGHT, amplitude * height),
              backgroundColor: index < played ? colors.primary : colors.ink,
            }}
          />
        );
      })}
    </View>
  );
}

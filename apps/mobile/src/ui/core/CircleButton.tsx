import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { colors } from '../theme';
import { PressableFeedback } from './PressableFeedback';

/** Peach is playback; violet is the primary action of the moment, such as stopping a recording. */
export type CircleButtonTone = 'peach' | 'primary';

const TONES: Record<CircleButtonTone, { surface: string; glyph: string }> = {
  peach: { surface: 'bg-peach', glyph: colors.primary },
  primary: { surface: 'bg-primary', glyph: colors.onPrimary },
};

export interface CircleButtonProps {
  icon: LucideIcon;
  /** Spoken name; the button is icon-only, so this is the only thing a screen reader has. */
  label: string;
  onPress: () => void;
  /** Diameter in logical pixels. The glyph scales with it. */
  size?: number | undefined;
  tone?: CircleButtonTone | undefined;
  iconSize?: number | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

/**
 * The round icon action used for playback and recording, with a quiet squish and rebound.
 * One implementation so the play disc on a voice card and the one in the capture sheet cannot
 * drift apart in size, colour, or feel.
 */
export function CircleButton({
  icon: Icon,
  label,
  onPress,
  size = 52,
  tone = 'peach',
  iconSize,
  accessibilityHint,
  testID,
}: CircleButtonProps) {
  const { surface, glyph } = TONES[tone];

  return (
    <PressableFeedback
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      className={`items-center justify-center rounded-full ${surface}`}
      onPress={onPress}
      treatment="icon"
      stateLayerColor={glyph}
      testID={testID}
    >
      <View className="items-center justify-center" style={{ height: size, width: size }}>
        <Icon color={glyph} fill={glyph} size={iconSize ?? Math.round(size * 0.36)} />
      </View>
    </PressableFeedback>
  );
}

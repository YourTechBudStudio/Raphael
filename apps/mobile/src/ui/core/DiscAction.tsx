import type { LucideIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { captureShadow, colors } from '../theme';
import { PressableFeedback } from './PressableFeedback';

/**
 * - `primary`: the one thing to do next, such as trying again after a refusal.
 * - `soft`: an ordinary action.
 * - `danger`: an action that takes something away. Its label is in danger ink as well as its icon,
 *   so the warning does not rest on colour inside a small disc alone.
 */
export type DiscActionTone = 'primary' | 'soft' | 'danger';

const TONES: Record<DiscActionTone, { disc: string; glyph: string; label: string }> = {
  primary: { disc: 'bg-primary', glyph: colors.onPrimary, label: 'text-ink' },
  soft: { disc: 'bg-primary-soft', glyph: colors.primary, label: 'text-ink' },
  danger: {
    disc: 'border-[1.5px] border-peach bg-card-warm',
    glyph: colors.danger,
    label: 'text-danger',
  },
};

const DISC = 64;

export interface DiscActionProps {
  icon: LucideIcon;
  /** Drawn under the disc and spoken as the button's name. */
  label: string;
  onPress: () => void;
  tone?: DiscActionTone | undefined;
  /** Stays a button, announced and drawn as unavailable, e.g. while the action's check runs. */
  disabled?: boolean | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

/**
 * A round expressive action with its name underneath, for a screen's handful of actions laid out
 * in a row rather than a list. The disc and the words are one button, so the whole column is the
 * target, and it moves as a unit like the other icon controls.
 *
 * The column is at least as wide as a short label and grows with a long one or a large text size,
 * wrapping only when the screen runs out, so the name is never cut short.
 */
export function DiscAction({
  icon: Icon,
  label,
  onPress,
  tone = 'soft',
  disabled = false,
  accessibilityHint,
  testID,
}: DiscActionProps) {
  const { disc, glyph, label: labelColor } = TONES[tone];

  return (
    <PressableFeedback
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      className={[
        'min-w-24 max-w-full items-center gap-2.5 rounded-[20px] px-1 py-1',
        disabled ? 'opacity-60' : '',
      ].join(' ')}
      disabled={disabled}
      onPress={onPress}
      stateLayerColor={colors.primary}
      testID={testID}
      treatment="icon"
    >
      <View
        className={`items-center justify-center rounded-full ${disc}`}
        style={{
          height: DISC,
          width: DISC,
          boxShadow: tone === 'primary' ? captureShadow : undefined,
        }}
      >
        <Icon color={glyph} size={24} strokeWidth={2} />
      </View>
      <Text className={`text-center font-body-medium text-[15px] leading-[19px] ${labelColor}`}>
        {label}
      </Text>
    </PressableFeedback>
  );
}

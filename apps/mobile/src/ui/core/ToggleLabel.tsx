import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { BloomIcon } from './BloomIcon';
import type { ToggleMark } from './toggle-marks';

/** The mark's box, which is also the touch target. */
const TARGET = 44;

export interface ToggleLabelProps {
  mark: ToggleMark;
  selected: boolean;
  onToggle: () => void;
  /** The word beside the mark, such as "Favorite". Sentence case, never a sentence. */
  label: string;
  /** Spoken name. It says what pressing does, which the visible word alone does not. */
  accessibilityLabel: string;
  accessibilityHint?: string | undefined;
  /** Announced and drawn as unavailable, e.g. while the server has not confirmed the last change. */
  disabled?: boolean | undefined;
  className?: string | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  testID?: string | undefined;
}

/**
 * A state mark with its word next to it: the whole thing is the control.
 *
 * The word is inside the pressable rather than beside it. A label that names a control it cannot
 * operate is a target a person will aim at and miss, and it made the mark announce itself twice -
 * once as a button, once as the text under it.
 *
 * State reads three ways at once, so none of them has to carry it alone: the mark fills, its stroke
 * turns violet, and the word darkens. The design system's pale lilac cannot be the only difference
 * between on and off.
 */
export function ToggleLabel({
  mark,
  selected,
  onToggle,
  label,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  className,
  style,
  testID,
}: ToggleLabelProps) {
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ checked: selected, disabled, selected }}
      className={[
        'flex-row items-center gap-1 pr-2',
        disabled ? 'opacity-60' : '',
        className ?? '',
      ].join(' ')}
      disabled={disabled}
      hitSlop={8}
      onPress={onToggle}
      style={style}
      testID={testID}
    >
      <View className="items-center justify-center" style={{ height: TARGET, width: TARGET }}>
        <BloomIcon
          dropColor={mark.dropColor}
          inactiveColor={mark.inactiveColor}
          path={mark.path}
          selected={selected}
        />
      </View>
      <Text
        className={['font-body text-[15px]', selected ? 'text-ink' : 'text-ink-soft'].join(' ')}
      >
        {label}
      </Text>
    </Pressable>
  );
}

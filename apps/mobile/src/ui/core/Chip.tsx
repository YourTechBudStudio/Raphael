import type { LucideIcon } from 'lucide-react-native';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '../theme';
import { PressableFeedback } from './PressableFeedback';

export interface ChipProps {
  label: string;
  /** Leading icon, such as the layers mark on the Browse and location chips. */
  icon?: LucideIcon | undefined;
  /** Trailing icon, usually a chevron that says the chip opens something. */
  trailingIcon?: LucideIcon | undefined;
  onPress?: (() => void) | undefined;
  /** Keeps the chip a button, announced and drawn as unavailable, e.g. while a retry runs. */
  disabled?: boolean | undefined;
  /** Spoken name when the label alone is not enough, such as a truncated path. */
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string | undefined;
  /** Marks the chip as the current selection: darker surface, `selected` state. */
  selected?: boolean | undefined;
  className?: string | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  testID?: string | undefined;
}

/** A pale pill with an icon and a label. */
export function Chip({
  label,
  icon: Icon,
  trailingIcon: TrailingIcon,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  selected = false,
  className,
  style,
  testID,
}: ChipProps) {
  const surfaceClassName = [
    'h-11 flex-row items-center gap-2 rounded-full px-4',
    selected ? 'bg-wave' : 'bg-card',
    disabled ? 'opacity-60' : '',
    className ?? '',
  ].join(' ');

  const content = (
    <>
      {Icon === undefined ? null : <Icon color={colors.primary} size={18} strokeWidth={2} />}
      <Text className="font-body-medium text-[15px] text-ink" numberOfLines={1}>
        {label}
      </Text>
      {TrailingIcon === undefined ? null : (
        <TrailingIcon color={colors.inkSoft} size={18} strokeWidth={2} />
      )}
    </>
  );

  // A chip that does nothing is a label. It stays a plain view rather than squishing under a
  // finger while announcing itself as text.
  if (onPress === undefined) {
    return (
      <View
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityRole="text"
        className={surfaceClassName}
        style={style}
        testID={testID}
      >
        {content}
      </View>
    );
  }

  return (
    <PressableFeedback
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      className={surfaceClassName}
      disabled={disabled}
      onPress={onPress}
      style={style}
      testID={testID}
    >
      {content}
    </PressableFeedback>
  );
}

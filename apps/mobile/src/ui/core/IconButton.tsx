import type { LucideIcon } from 'lucide-react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { colors } from '../theme';
import { PressableFeedback } from './PressableFeedback';

export interface IconButtonProps {
  icon: LucideIcon;
  /** Spoken name for the action, since the button shows no text. */
  label: string;
  onPress?: (() => void) | undefined;
  /** Violet fill with a white icon, for primary actions. */
  filled?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Icon size in logical pixels; the 44 button itself does not change. */
  iconSize?: number | undefined;
  color?: string | undefined;
  className?: string | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

/** A 44x44 circular icon action. */
export function IconButton({
  icon: Icon,
  label,
  onPress,
  filled = false,
  disabled = false,
  iconSize = 22,
  color,
  className,
  style,
  accessibilityHint,
  testID,
}: IconButtonProps) {
  const iconColor = color ?? (filled ? colors.onPrimary : colors.ink);

  return (
    <PressableFeedback
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      className={[
        'h-11 w-11 items-center justify-center rounded-full',
        filled ? 'bg-primary' : '',
        disabled ? 'opacity-40' : '',
        className ?? '',
      ].join(' ')}
      disabled={disabled}
      onPress={onPress}
      treatment="icon"
      stateLayerColor={iconColor}
      style={style}
      testID={testID}
    >
      <Icon color={iconColor} size={iconSize} strokeWidth={2} />
    </PressableFeedback>
  );
}

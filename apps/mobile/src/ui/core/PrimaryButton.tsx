import { ActivityIndicator, Text, View } from 'react-native';

import { colors } from '../theme';
import { AnimatedSurface } from './animated-surface';
import { PressableFeedback } from './PressableFeedback';

export interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  /** Shows a spinner beside the label and blocks further presses. */
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
  accessibilityHint?: string | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/** The full-width violet action at the foot of a form. */
export function PrimaryButton({
  label,
  onPress,
  busy = false,
  disabled = false,
  accessibilityHint,
  className,
  testID,
}: PrimaryButtonProps) {
  const unavailable = disabled || busy;

  return (
    <PressableFeedback
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityState={{ disabled: unavailable, busy }}
      className={[
        'h-14 items-center justify-center rounded-full bg-primary px-6',
        unavailable ? 'opacity-40' : '',
        className ?? '',
      ].join(' ')}
      disabled={unavailable}
      onPress={onPress}
      treatment="button"
      stateLayerColor={colors.onPrimary}
      testID={testID}
    >
      {(stableContentStyle) => (
        <AnimatedSurface style={stableContentStyle}>
          <View className="flex-row items-center gap-2.5">
            {busy ? <ActivityIndicator color={colors.onPrimary} size="small" /> : null}
            <Text className="font-body-semibold text-[17px] text-on-primary">{label}</Text>
          </View>
        </AnimatedSurface>
      )}
    </PressableFeedback>
  );
}

import { Text } from 'react-native';

import { colors } from '../theme';
import { AnimatedSurface } from './animated-surface';
import { PressableFeedback } from './PressableFeedback';

export interface SavePillProps {
  /** The visible label, which also carries the saving state ("Save" / "Saving…"). */
  label: string;
  onPress: () => void;
  disabled?: boolean | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

/** The violet confirm pill in a sheet header. Dims to 40% when it cannot be used. */
export function SavePill({
  label,
  onPress,
  disabled = false,
  accessibilityHint,
  testID,
}: SavePillProps) {
  return (
    <PressableFeedback
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      className={[
        'h-11 items-center justify-center rounded-full bg-primary px-5',
        disabled ? 'opacity-40' : '',
      ].join(' ')}
      disabled={disabled}
      onPress={onPress}
      treatment="button"
      stateLayerColor={colors.onPrimary}
      testID={testID}
    >
      {(stableContentStyle) => (
        <AnimatedSurface style={stableContentStyle}>
          <Text className="font-body-semibold text-[16px] text-on-primary">{label}</Text>
        </AnimatedSurface>
      )}
    </PressableFeedback>
  );
}

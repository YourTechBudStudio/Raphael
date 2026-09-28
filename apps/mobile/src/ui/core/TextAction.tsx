import { Text } from 'react-native';

import { colors } from '../theme';
import { AnimatedSurface } from './animated-surface';
import { PressableFeedback } from './PressableFeedback';

export interface TextActionProps {
  label: string;
  onPress: () => void;
  accessibilityHint?: string | undefined;
}

/** A quiet secondary action: cancel, record again, change. Violet words, 44pt target, no surface. */
export function TextAction({ label, onPress, accessibilityHint }: TextActionProps) {
  return (
    <PressableFeedback
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      className="h-11 items-center justify-center px-2"
      onPress={onPress}
      treatment="button"
      stateLayerColor={colors.primary}
    >
      {(stableContentStyle) => (
        <AnimatedSurface style={stableContentStyle}>
          <Text className="font-body-medium text-[16px] text-primary">{label}</Text>
        </AnimatedSurface>
      )}
    </PressableFeedback>
  );
}

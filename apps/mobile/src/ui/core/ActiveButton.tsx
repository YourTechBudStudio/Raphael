import { Pressable } from 'react-native';

import { BloomIcon } from './BloomIcon';
import { ACTIVE_MARK } from './toggle-marks';

interface ActiveButtonProps {
  active: boolean;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
}

/**
 * Shares the favorite's quick bloom, with violet drops instead of gold.
 *
 * The bare mark, for the Home card that already names the project beside it. Where the bolt needs
 * its own word - and on the Project screen it does, because nobody reads a lightning bolt cold -
 * use `ToggleLabel` with the same mark.
 */
export function ActiveButton({ active, disabled = false, label, onToggle }: ActiveButtonProps) {
  return (
    <Pressable
      accessibilityLabel={active ? `Mark ${label} as inactive` : `Mark ${label} as active`}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      className="h-12 w-12 items-center justify-center"
      disabled={disabled}
      onPress={onToggle}
    >
      <BloomIcon
        dropColor={ACTIVE_MARK.dropColor}
        inactiveColor={ACTIVE_MARK.inactiveColor}
        path={ACTIVE_MARK.path}
        selected={active}
      />
    </Pressable>
  );
}

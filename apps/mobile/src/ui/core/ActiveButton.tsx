import { Pressable } from 'react-native';

import { BloomIcon } from './BloomIcon';
import { BusyRing } from './BusyRing';
import { ACTIVE_MARK } from './toggle-marks';

/** The mark's box, which is also the touch target and what the ring is sized to. */
const TARGET = 48;

interface ActiveButtonProps {
  active: boolean;
  /**
   * A write is in flight. Announced as busy as well as unavailable, and drawn with the ring.
   *
   * For this control the two are the same fact: it is disabled exactly while the server has not
   * settled the last change, so saying only "unavailable" would leave a person told they cannot
   * press it and not told why.
   */
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
      accessibilityState={{ busy: disabled, selected: active, disabled }}
      className="items-center justify-center"
      disabled={disabled}
      onPress={onToggle}
      style={{ height: TARGET, width: TARGET }}
    >
      <BloomIcon
        dropColor={ACTIVE_MARK.dropColor}
        inactiveColor={ACTIVE_MARK.inactiveColor}
        path={ACTIVE_MARK.path}
        selected={active}
      />
      {disabled ? <BusyRing size={TARGET} /> : null}
    </Pressable>
  );
}

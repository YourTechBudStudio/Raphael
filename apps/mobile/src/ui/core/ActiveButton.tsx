import { Pressable } from 'react-native';

import { colors } from '../theme';
import { BloomIcon } from './BloomIcon';

/** Lucide Zap: a fillable energy cue for a project currently being worked on. */
const ACTIVE_PATH =
  'M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z';

interface ActiveButtonProps {
  active: boolean;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
}

/** Shares the favorite's quick bloom, with violet drops instead of gold. */
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
        dropColor={colors.primary}
        inactiveColor={colors.inkSoft}
        path={ACTIVE_PATH}
        selected={active}
      />
    </Pressable>
  );
}

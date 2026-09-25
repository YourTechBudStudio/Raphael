/**
 * Temporary: archive mock for story #8. The archive mark alone, as a 44pt icon control.
 *
 * The same bloom as Active and Favorite, so a filled box means "archived by you" wherever it is
 * drawn. It carries no word, so its spoken label has to say everything.
 */

import { Pressable, View } from 'react-native';

import { BloomIcon } from '../../../../ui/core/BloomIcon';
import { BusyRing } from '../../../../ui/core/BusyRing';
import { ARCHIVE_MARK } from './mock-state';

const TARGET = 44;

export interface ArchiveMarkProps {
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  size?: number | undefined;
}

export function ArchiveMark({ selected, busy, onToggle, size = 20 }: ArchiveMarkProps) {
  return (
    <Pressable
      accessibilityHint={
        selected ? 'Brings it back to lists and search' : 'Hides it from lists and search'
      }
      accessibilityLabel={selected ? 'Restore this note' : 'Archive this note'}
      accessibilityRole="button"
      accessibilityState={{ busy, checked: selected, disabled: busy }}
      className={busy ? 'opacity-60' : ''}
      disabled={busy}
      hitSlop={4}
      onPress={onToggle}
    >
      <View className="items-center justify-center" style={{ height: TARGET, width: TARGET }}>
        <BloomIcon
          dropColor={ARCHIVE_MARK.dropColor}
          inactiveColor={ARCHIVE_MARK.inactiveColor}
          path={ARCHIVE_MARK.path}
          selected={selected}
          size={size}
        />
        {busy ? <BusyRing size={TARGET} /> : null}
      </View>
    </Pressable>
  );
}

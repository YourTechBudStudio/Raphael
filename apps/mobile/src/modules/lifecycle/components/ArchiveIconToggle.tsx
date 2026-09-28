import { Pressable, View } from 'react-native';

import { ARCHIVE_MARK, BloomIcon, BusyRing } from '../../../ui';
import { iconToggleSpokenLabel, toggleHint } from '../copy.ts';
import type { LifecycleView } from '../view.ts';

/** The mark's box, which is also the touch target. */
const TARGET = 44;

export interface ArchiveIconToggleProps {
  /** Null when the phone could not read the causes: drawn unselected, and pressing it archives. */
  view: LifecycleView | null;
  /** A request is running: the busy ring turns and nothing can be pressed. */
  busy: boolean;
  /** Why it cannot be pressed right now, when it cannot: dimmed, and the hint says why. */
  unavailable?: string | undefined;
  /** What is being edited, lowercased, for the spoken label: "note", "project", "area". */
  noun: string;
  onArchive: () => void;
  onRestore: () => void;
  testID?: string | undefined;
}

/**
 * The Archive state toggle with its mark alone, for the edit screen's top bar.
 *
 * The same mark and meaning as the labelled toggle on container screens: filled while the user's own
 * archive is on this entity, and pressing it then restores. It stays live in every standing, because
 * adding your own archive to something archived through a container above is what keeps it archived
 * once that container is restored. With no visible word, its spoken label says everything.
 */
export function ArchiveIconToggle({
  view,
  busy,
  unavailable,
  noun,
  onArchive,
  onRestore,
  testID,
}: ArchiveIconToggleProps) {
  const selected = view?.canRestore === true;
  const disabled = busy || unavailable !== undefined;

  return (
    <Pressable
      accessibilityHint={unavailable ?? toggleHint(view)}
      accessibilityLabel={iconToggleSpokenLabel(view, noun)}
      accessibilityRole="button"
      accessibilityState={{ busy, checked: selected, disabled, selected }}
      className={disabled ? 'opacity-60' : ''}
      disabled={disabled}
      hitSlop={4}
      onPress={selected ? onRestore : onArchive}
      testID={testID}
    >
      <View className="items-center justify-center" style={{ height: TARGET, width: TARGET }}>
        <BloomIcon
          dropColor={ARCHIVE_MARK.dropColor}
          inactiveColor={ARCHIVE_MARK.inactiveColor}
          path={ARCHIVE_MARK.path}
          selected={selected}
          size={20}
        />
        {busy ? <BusyRing size={TARGET} /> : null}
      </View>
    </Pressable>
  );
}

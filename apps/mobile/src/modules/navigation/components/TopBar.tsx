import { ChevronDown, ChevronLeft, Layers, Plus, Search, Settings } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { Chip, IconButton } from '../../../ui';

/** How many trailing path segments the location chip shows before it elides the head. */
const VISIBLE_PATH_SEGMENTS = 2;

/**
 * The chip shows the tail of the path, the way the boards do: `Creative work / Design`.
 * Anything above it is replaced by a leading ellipsis, so the current location stays readable.
 *
 * An empty path means the location is genuinely not known - neither the hierarchy nor the server
 * could name it. The chip then says only what pressing it does. It used to say "Areas", which reads
 * as a location and is one the screens had no grounds to claim: a project can never sit at the top
 * level, so that was a statement about the hierarchy that could not have been true.
 */
function formatPath(path: readonly string[]): string {
  if (path.length === 0) return 'Browse';

  const visible = path.slice(-VISIBLE_PATH_SEGMENTS);
  const elided = path.length > visible.length;
  return `${elided ? '… / ' : ''}${visible.join(' / ')}`;
}

export interface HomeTopBarProps {
  onBrowse: () => void;
  onSearch: () => void;
  onSettings: () => void;
  testID?: string | undefined;
}

/** Home: the wordmark, the Browse chip, search, and settings. */
export function HomeTopBar({ onBrowse, onSearch, onSettings, testID }: HomeTopBarProps) {
  return (
    <View className="h-14 flex-row items-center justify-between" testID={testID}>
      <Text
        accessibilityRole="header"
        adjustsFontSizeToFit
        className="font-heading text-[34px] leading-[42px] text-ink"
        // The wordmark scales with the platform text size, but only so far: past this the row
        // would push the Browse chip and the two icon actions off the screen.
        maxFontSizeMultiplier={1.2}
        numberOfLines={1}
      >
        raphael
      </Text>
      <View className="flex-row items-center gap-2">
        <Chip
          accessibilityHint="Opens the list of areas and projects"
          icon={Layers}
          label="Browse"
          onPress={onBrowse}
        />
        <IconButton icon={Search} label="Search" onPress={onSearch} />
        <IconButton
          accessibilityHint="Opens settings, including the server connection"
          icon={Settings}
          label="Settings"
          onPress={onSettings}
        />
      </View>
    </View>
  );
}

export interface TitleTopBarProps {
  title: string;
  onBack: () => void;
  /** One quiet control at the trailing edge, such as Browse's plus for a top-level area. */
  trailing?: ReactNode | undefined;
  testID?: string | undefined;
}

/** Settings and Browse: back and the screen title, with no location or search chrome. */
export function TitleTopBar({ title, onBack, trailing, testID }: TitleTopBarProps) {
  return (
    <View className="h-14 flex-row items-center gap-2" testID={testID}>
      <IconButton icon={ChevronLeft} label="Back" onPress={onBack} />
      <Text
        accessibilityRole="header"
        className="flex-1 font-heading text-[24px] leading-[30px] text-ink"
        numberOfLines={1}
      >
        {title}
      </Text>
      {trailing}
    </View>
  );
}

export interface LocationTopBarProps {
  /** Where this screen sits, ending at its parent: `['Creative work']` for the area "Design". */
  path: readonly string[];
  onBack: () => void;
  onOpenBrowse: () => void;
  onSearch: () => void;
  /**
   * Adds something inside this container. Omitted where there is nothing to add: a project holds
   * no containers, so a plus on one would open a sheet with nothing to offer, and the only thing
   * left to suggest - a note - is what the capture pair on the same screen already does.
   */
  onAdd?: (() => void) | undefined;
  testID?: string | undefined;
}

/**
 * Area and Project: back, the location chip that opens Browse, search, and - where there is
 * something to add - a plus.
 *
 * The chip loses its chevron when the plus is there. Four controls leave it around 144px, and the
 * chevron is the one part that can go without losing a word: what it promised, that pressing opens
 * something, the chip's own hint already says.
 */
export function LocationTopBar({
  path,
  onBack,
  onOpenBrowse,
  onSearch,
  onAdd,
  testID,
}: LocationTopBarProps) {
  const label = formatPath(path);

  return (
    <View className="h-14 flex-row items-center gap-2" testID={testID}>
      <IconButton icon={ChevronLeft} label="Back" onPress={onBack} />
      <Chip
        accessibilityHint="Opens the list of areas and projects"
        accessibilityLabel={
          path.length === 0
            ? 'Browse. Raphael could not name where this is.'
            : `Location: ${path.join(', ')}`
        }
        icon={Layers}
        label={label}
        onPress={onOpenBrowse}
        style={{ flex: 1 }}
        trailingIcon={onAdd === undefined ? ChevronDown : undefined}
      />
      <IconButton icon={Search} label="Search" onPress={onSearch} />
      {onAdd === undefined ? null : (
        <IconButton
          accessibilityHint="Adds an area or a project inside this one"
          className="bg-primary-soft"
          icon={Plus}
          label="Add"
          onPress={onAdd}
        />
      )}
    </View>
  );
}

import { ChevronDown, ChevronLeft, Layers, Search } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Chip, IconButton } from '../../../ui';

/** How many trailing path segments the location chip shows before it elides the head. */
const VISIBLE_PATH_SEGMENTS = 2;

/**
 * The chip shows the tail of the path, the way the boards do: `Creative work / Design`.
 * Anything above it is replaced by a leading ellipsis, so the current location stays readable.
 */
function formatPath(path: readonly string[]): string {
  const visible = path.slice(-VISIBLE_PATH_SEGMENTS);
  const elided = path.length > visible.length;
  return `${elided ? '… / ' : ''}${visible.join(' / ')}`;
}

export interface HomeTopBarProps {
  onBrowse: () => void;
  onSearch: () => void;
  testID?: string | undefined;
}

/** Home: the wordmark, the Browse chip, and search. */
export function HomeTopBar({ onBrowse, onSearch, testID }: HomeTopBarProps) {
  return (
    <View className="h-14 flex-row items-center justify-between" testID={testID}>
      <Text
        accessibilityRole="header"
        adjustsFontSizeToFit
        className="font-heading text-[34px] leading-[42px] text-ink"
        // The wordmark scales with the platform text size, but only so far: past this the row
        // would push the Browse chip and search off the screen.
        maxFontSizeMultiplier={1.3}
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
      </View>
    </View>
  );
}

export interface LocationTopBarProps {
  /** The path from the root area down to this screen, e.g. `['Creative work', 'Design']`. */
  path: readonly string[];
  onBack: () => void;
  onOpenBrowse: () => void;
  onSearch: () => void;
  testID?: string | undefined;
}

/** Area and Project: back, the location path chip that opens Browse, and search. */
export function LocationTopBar({
  path,
  onBack,
  onOpenBrowse,
  onSearch,
  testID,
}: LocationTopBarProps) {
  const label = formatPath(path);

  return (
    <View className="h-14 flex-row items-center gap-2" testID={testID}>
      <IconButton icon={ChevronLeft} label="Back" onPress={onBack} />
      <Chip
        accessibilityHint="Opens the list of areas and projects"
        accessibilityLabel={`Location: ${path.join(', ')}`}
        icon={Layers}
        label={label}
        onPress={onOpenBrowse}
        style={{ flex: 1 }}
        trailingIcon={ChevronDown}
      />
      <IconButton icon={Search} label="Search" onPress={onSearch} />
    </View>
  );
}

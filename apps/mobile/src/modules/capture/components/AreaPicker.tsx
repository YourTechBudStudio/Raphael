import { Check, Search } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { EmptyState, PressableFeedback, SearchField, colors } from '../../../ui';
import {
  areaOptions,
  HierarchyError,
  HierarchyStale,
  useHierarchy,
  type AreaOption,
} from '../../collections';

export interface AreaPickerProps {
  /** The area chosen so far, or null. Nothing is ever chosen on the person's behalf. */
  selectedId: number | null;
  onSelect: (option: AreaOption) => void;
  disabled?: boolean | undefined;
}

/**
 * Choosing where a note goes.
 *
 * There is no default, and this is the reason the picker exists. The app used to write to a hidden
 * "inbox" area when nothing was chosen, and to the area you happened to be looking at when
 * something was. Both are the same mistake in different clothes: a note filed somewhere the person
 * did not pick is a note they will not find, and a second brain that quietly decides where your
 * thinking lives is not one you can trust. So nothing is preselected, opening this from inside an
 * area preselects nothing either, and Save stays disabled until a row here is tapped.
 *
 * Areas only. A project is a thing with an end, and this release has no note-in-project story worth
 * committing to; offering it here would be inventing one.
 *
 * Every row shows where its area sits, because two areas called "Notes" under different parents are
 * an ordinary thing to have and a list of bare names cannot be used correctly. That context comes
 * from the complete hierarchy, which is also why this waits for the whole thing rather than showing
 * the areas that have arrived so far.
 */
export function AreaPicker({ selectedId, onSelect, disabled = false }: AreaPickerProps) {
  const [filter, setFilter] = useState('');
  const tree = useHierarchy();
  const { hierarchy, isPending, isError } = tree;

  const options = useMemo(
    () => (hierarchy === undefined ? [] : areaOptions(hierarchy)),
    [hierarchy],
  );

  const needle = filter.trim().toLowerCase();
  const matches = useMemo(
    () => (needle === '' ? options : options.filter((option) => option.haystack.includes(needle))),
    [options, needle],
  );

  if (isError && hierarchy === undefined) {
    return (
      <HierarchyError
        title="Your areas did not load, so there is nowhere to file this yet."
        tree={tree}
      />
    );
  }

  if (isPending || hierarchy === undefined) {
    return (
      <View className="flex-row items-center gap-3 py-6">
        <ActivityIndicator accessibilityLabel="Loading your areas" color={colors.primary} />
        <Text className="font-body text-[15px] text-ink-soft">Finding your areas…</Text>
      </View>
    );
  }

  if (options.length === 0) {
    // The notice comes too: "there are no areas" is a claim about the server, and a reading that
    // could not be refreshed is not the reading to make it from without saying so.
    return (
      <View className="gap-2">
        <HierarchyStale tree={tree} />
        <EmptyState
          description="Notes are kept in areas, and this server has none yet. Areas are made on the server for now."
          title="There are no areas to file this in."
        />
      </View>
    );
  }

  return (
    <View className="gap-2">
      <HierarchyStale tree={tree} />

      {options.length > SEARCH_THRESHOLD ? (
        <SearchField
          accessibilityLabel="Filter areas"
          onChangeText={setFilter}
          onClear={() => {
            setFilter('');
          }}
          placeholder="Find an area"
          value={filter}
        />
      ) : null}

      {matches.length === 0 ? (
        <View className="flex-row items-center gap-2 py-4">
          <Search color={colors.inkSoft} size={18} />
          <Text className="font-body text-[15px] text-ink-soft">No area matches that.</Text>
        </View>
      ) : (
        <View>
          {matches.map((option) => (
            <AreaRow
              disabled={disabled}
              key={option.id}
              onPress={() => {
                onSelect(option);
              }}
              option={option}
              selected={option.id === selectedId}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Below this many areas a filter field is more furniture than help. */
const SEARCH_THRESHOLD = 6;

interface AreaRowProps {
  option: AreaOption;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}

function AreaRow({ option, selected, disabled, onPress }: AreaRowProps) {
  return (
    <PressableFeedback
      accessibilityHint={
        option.context === '' ? 'Files this note here' : `Files this note in ${option.context}`
      }
      accessibilityLabel={option.title}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      className={`flex-row items-center gap-3 rounded-card px-3 ${selected ? 'bg-wave' : ''}`}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: 52 }}
    >
      <View className="flex-1 justify-center py-2">
        <Text
          className={`font-body-semibold text-[16px] leading-[22px] ${selected ? 'text-primary' : 'text-ink'}`}
          numberOfLines={2}
        >
          {option.title}
        </Text>
        <Text className="font-body text-[13px] leading-[18px] text-ink-soft" numberOfLines={1}>
          {option.context === '' ? 'Top level' : option.context}
        </Text>
      </View>
      {selected ? <Check color={colors.primary} size={20} strokeWidth={2.4} /> : null}
    </PressableFeedback>
  );
}

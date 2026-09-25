/**
 * Type, archive and tag filters, kept off the search header and opened from one icon beside the field.
 *
 * Chip rows under the field competed with it and did not align past the back button, so the filters
 * live in a sheet and the header says only whether any of them are narrowing the search. Changes
 * apply as they are made; there is no Done, because there is nothing to commit - the search below
 * re-runs on the new descriptor either way and a Done button would only be a second way to do
 * nothing.
 *
 * The rejection sentence is shown **here as well as in the body**, and that is the point: this sheet
 * covers the body, so a person who adds an over-long tag would otherwise watch nothing happen. Both
 * places read the same `inspectTagsInput` verdict through `describeTagsRejection`, which lives in
 * `filter-copy.ts` so there is one rule, one sentence, and no second authority on what a usable tag
 * is.
 */

import { normalizeTag, type TagsRejection } from '@raphael/contracts/nodes';
import { Archive, Plus, X } from 'lucide-react-native';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Chip, IconButton, SectionHeading, Sheet, SheetHeader } from '../../../ui';
import { ARCHIVED_LABEL, INCLUDE_ARCHIVED_HINT, INCLUDE_ARCHIVED_LABEL } from '../../lifecycle';
import type { SearchTypeFilter } from '../client/requests.ts';
import { describeTagsRejection } from './filter-copy';

const TYPE_CHIPS: readonly { key: SearchTypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'area', label: 'Areas' },
  { key: 'project', label: 'Projects' },
  { key: 'note', label: 'Notes' },
];

export interface FilterSheetProps {
  visible: boolean;
  onClose: () => void;
  type: SearchTypeFilter;
  onType: (type: SearchTypeFilter) => void;
  tags: readonly string[];
  onTags: (tags: readonly string[]) => void;
  /** What `inspectTagsInput` says about the tags as they stand, or nothing. */
  rejection: TagsRejection | undefined;
  /** Archived areas, projects and notes are part of the results. */
  includeArchived: boolean;
  onIncludeArchived: (includeArchived: boolean) => void;
}

export function FilterSheet({
  visible,
  onClose,
  type,
  onType,
  tags,
  onTags,
  rejection,
  includeArchived,
  onIncludeArchived,
}: FilterSheetProps) {
  const [entry, setEntry] = useState('');

  // Normalized with the contract's own `normalizeTag`, so the chip drawn here is the tag that is
  // sent. An empty entry and one already in the list are refused silently: neither is a mistake
  // worth a sentence, and adding a duplicate chip nobody can tell apart would be worse than both.
  const addTag = () => {
    const tag = normalizeTag(entry);

    setEntry('');

    if (tag === '' || tags.includes(tag)) return;

    onTags([...tags, tag]);
  };

  return (
    <Sheet
      className="gap-5 px-5 pb-6 pt-3"
      keyboardAvoiding
      label="the filter sheet"
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        leading={<IconButton icon={X} label="Close" onPress={onClose} />}
        subtitle="Narrow the search. Applied as you change them."
        title="Filters"
        trailing={<View className="w-11" />}
      />
      <View className="gap-3">
        <SectionHeading>Show</SectionHeading>
        <View className="flex-row flex-wrap gap-2">
          {TYPE_CHIPS.map((chip) => (
            <Chip
              key={chip.key}
              label={chip.label}
              onPress={() => {
                onType(chip.key);
              }}
              selected={type === chip.key}
            />
          ))}
        </View>
      </View>
      <View className="gap-3">
        <SectionHeading>{ARCHIVED_LABEL}</SectionHeading>
        <View className="flex-row flex-wrap gap-2">
          <Chip
            accessibilityHint={INCLUDE_ARCHIVED_HINT}
            icon={Archive}
            label={INCLUDE_ARCHIVED_LABEL}
            onPress={() => {
              onIncludeArchived(!includeArchived);
            }}
            selected={includeArchived}
            testID="include-archived"
          />
        </View>
      </View>
      <View className="gap-3">
        <SectionHeading>Tags</SectionHeading>
        <View className="flex-row flex-wrap gap-2">
          {tags.map((tag) => (
            <Chip
              accessibilityHint="Removes this tag from the filter"
              accessibilityLabel={`Remove tag ${tag}`}
              key={tag}
              label={tag}
              onPress={() => {
                onTags(tags.filter((item) => item !== tag));
              }}
              trailingIcon={X}
            />
          ))}
          {tags.length === 0 ? (
            <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
              Any tag. Add one to narrow it down.
            </Text>
          ) : null}
        </View>
        {rejection === undefined ? null : (
          <Text
            accessibilityLiveRegion="polite"
            className="font-body text-[15px] leading-[22px] text-ink-soft"
          >
            {describeTagsRejection(rejection)}
          </Text>
        )}
        <View className="flex-row items-center gap-2">
          <TextInput
            accessibilityLabel="Tag to filter by"
            autoCapitalize="none"
            autoCorrect={false}
            blurOnSubmit={false}
            className="h-11 flex-1 rounded-full bg-card px-4 font-body text-[16px] text-ink"
            onChangeText={setEntry}
            onSubmitEditing={addTag}
            placeholder="Add a tag"
            returnKeyType="done"
            value={entry}
          />
          <IconButton disabled={entry.trim() === ''} icon={Plus} label="Add tag" onPress={addTag} />
        </View>
      </View>
    </Sheet>
  );
}

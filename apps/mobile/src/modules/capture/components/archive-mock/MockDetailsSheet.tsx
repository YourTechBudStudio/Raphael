/**
 * Temporary: archive mock for story #8. A copy of `DetailsSheet` with a read-only mode.
 *
 * Same layout either way. Read-only keeps every row where it is and stops it accepting changes: the
 * ID field and tag entry are unavailable, tags lose their remove mark, and Done never enables. The
 * subtitle says why, so a person does not have to guess.
 */

import { normalizeTag } from '@raphael/contracts/nodes';
import { Plus, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Chip, IconButton, SavePill, Sheet, SheetBody, SheetHeader } from '../../../../ui';

const SLUG = 'credential-rotation-runbook';
const TAGS: readonly string[] = ['security', 'runbook'];

export interface MockDetailsSheetProps {
  visible: boolean;
  sessionId: number;
  readOnly: boolean;
  onClose: () => void;
}

export function MockDetailsSheet({ visible, sessionId, readOnly, onClose }: MockDetailsSheetProps) {
  const [slug, setSlug] = useState(SLUG);
  const [tags, setTags] = useState<readonly string[]>(TAGS);
  const [entry, setEntry] = useState('');

  useEffect(() => {
    setSlug(SLUG);
    setTags(TAGS);
    setEntry('');
  }, [sessionId]);

  const changed = slug !== SLUG || tags.join() !== TAGS.join();
  const off = readOnly ? { opacity: 0.38 } : undefined;

  return (
    <Sheet
      className="gap-5 px-5 pb-4 pt-3"
      keyboardAvoiding
      label="the details sheet"
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        leading={<IconButton icon={X} label={readOnly ? 'Close' : 'Cancel'} onPress={onClose} />}
        subtitle={
          readOnly
            ? 'Archived, so these cannot change. Restore it to edit them.'
            : 'Applied when you press Done, and saved with everything else.'
        }
        title="Details"
        trailing={<SavePill disabled={readOnly || !changed} label="Done" onPress={onClose} />}
      />

      <SheetBody contentContainerStyle={{ gap: 20 }}>
        <View className="gap-2">
          <Text className="font-body-medium text-[14px] text-ink-soft">ID</Text>
          <TextInput
            accessibilityLabel="ID"
            accessibilityState={{ disabled: readOnly }}
            autoCapitalize="none"
            autoCorrect={false}
            className="h-11 rounded-full bg-card px-4 font-body text-[16px] text-ink"
            editable={!readOnly}
            onChangeText={setSlug}
            style={off}
            value={slug}
          />
          <Text className="font-body text-[13px] leading-[18px] text-ink-soft">
            The last part of the path, used to link to it. Your server decides whether it is free.
          </Text>
        </View>

        <View className="gap-2">
          <Text className="font-body-medium text-[14px] text-ink-soft">Tags</Text>
          <View className="flex-row flex-wrap gap-2">
            {tags.map((tag) =>
              readOnly ? (
                <Chip key={tag} label={tag} />
              ) : (
                <Chip
                  accessibilityHint="Removes this tag"
                  accessibilityLabel={`Remove tag ${tag}`}
                  key={tag}
                  label={tag}
                  onPress={() => {
                    setTags(tags.filter((item) => item !== tag));
                  }}
                  trailingIcon={X}
                />
              ),
            )}
          </View>
          <View
            accessibilityState={{ disabled: readOnly }}
            className="flex-row items-center gap-2"
            pointerEvents={readOnly ? 'none' : 'auto'}
            style={off}
          >
            <TextInput
              accessibilityLabel="New tag"
              autoCapitalize="none"
              blurOnSubmit={false}
              className="h-11 flex-1 rounded-full bg-card px-4 font-body text-[16px] text-ink"
              editable={!readOnly}
              onChangeText={setEntry}
              onSubmitEditing={() => {
                const value = normalizeTag(entry);
                setEntry('');
                if (value !== '' && !tags.includes(value)) setTags([...tags, value]);
              }}
              placeholder="Add a tag"
              returnKeyType="done"
              value={entry}
            />
            <IconButton disabled={readOnly || entry.trim() === ''} icon={Plus} label="Add tag" />
          </View>
        </View>
      </SheetBody>
    </Sheet>
  );
}

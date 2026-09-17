import { normalizeTag } from '@raphael/contracts/nodes';
import { Plus, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Chip, IconButton, SavePill, Sheet, SheetBody, SheetHeader } from '../../../ui';

export interface DetailsSheetProps {
  visible: boolean;
  /**
   * Changes per opening, and it is what the drafts are seeded from.
   *
   * The same device `DestinationSheet` uses, and here it is a correctness rule rather than a
   * convenience. Seeding from `slug` and `tags` directly would re-seed whenever those props changed
   * identity - and `publishRecord` re-reads the row on every acknowledgement, JSON-parsing a fresh
   * `tags` array each time, so an ordinary autosave landing while someone typed would silently
   * replace a half-typed ID with the stored one and disable Done. Nothing but a new opening may
   * forget what was typed.
   */
  sessionId: number;
  /** What the ID field is called on this entity: "note ID", "area ID", "project ID". Never "slug". */
  idLabel: string;
  /**
   * The stored ID, or null where there is not one yet.
   *
   * A new note has no ID until the server derives one from the title, so the sheet then shows tags
   * only. The edit screen always passes one.
   */
  slug: string | null;
  tags: readonly string[];
  /** Committed once, on Done. Nothing here reaches the owner per keystroke. */
  onDone: (details: { slug: string | null; tags: readonly string[] }) => void;
  onClose: () => void;
}

/** Sentence case for a label a person reads, from the lower-case name the status line uses. */
const sentenceCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * The ID and the tags, edited together and committed once.
 *
 * **One commit, on Done.** Everything typed here lives in this component until then, because the ID
 * is autosaved the moment it reaches the owner and a half-typed one is a real request to a real
 * server - refused, and refused again on the next keystroke. Closing any other way forgets what was
 * typed, which is what makes Cancel mean something.
 *
 * **What it says about saving differs, because the behaviour does.** An existing entity autosaves, so
 * what is applied here goes with everything else; a new note has no autosave and no ID, so the sheet
 * is tags alone and says they are kept until the note is saved. One sentence for both would be false
 * on one of them.
 *
 * **Tags are normalized on the way in, and the ID is not.** A tag's identity is the contract's to
 * decide and `normalizeTag` is that decision, so passing every entry through it is what keeps the
 * editor's tags and the server's in one identity - without it, an editor holding `work` and `work `
 * diffs to an addition the server refuses as a repeat, forever. The ID is free text on purpose: the
 * server is the only thing that knows whether one is taken, and a client that pre-normalized it would
 * be guessing at a rule it does not own.
 */
export function DetailsSheet({
  visible,
  sessionId,
  idLabel,
  slug,
  tags,
  onDone,
  onClose,
}: DetailsSheetProps) {
  const [draftSlug, setDraftSlug] = useState(slug ?? '');
  const [draftTags, setDraftTags] = useState<readonly string[]>(tags);
  const [entry, setEntry] = useState('');
  /** What this opening began with. Compared against, never re-read from the props as they move. */
  const opened = useRef({ slug, tags });

  // A fresh copy each time it opens - keyed on the opening alone, so a record moving underneath the
  // sheet cannot forget what someone is in the middle of typing.
  useEffect(() => {
    opened.current = { slug, tags };
    setDraftSlug(slug ?? '');
    setDraftTags(tags);
    setEntry('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the opening is the trigger; see `sessionId`
  }, [sessionId]);

  const addTag = () => {
    const value = normalizeTag(entry);

    setEntry('');
    // An empty entry and an exact repeat are both no-ops rather than errors; everything else about a
    // tag - its length, how many there are - is the server's to judge.
    if (value === '' || draftTags.includes(value)) return;

    setDraftTags([...draftTags, value]);
  };

  // Against what the sheet opened with, for the same reason the seeding is: a record that moved
  // underneath it must not decide whether Done is offered for what is on screen.
  const since = opened.current;
  const changed =
    (since.slug !== null && draftSlug !== since.slug) ||
    draftTags.length !== since.tags.length ||
    draftTags.some((tag, index) => tag !== since.tags[index]);

  return (
    <Sheet
      className="gap-5 px-5 pb-4 pt-3"
      keyboardAvoiding
      label="the details sheet"
      onClose={onClose}
      visible={visible}
      testID="details-sheet"
    >
      <SheetHeader
        leading={<IconButton icon={X} label="Cancel" onPress={onClose} />}
        subtitle={
          since.slug === null
            ? 'Applied when you press Done, and saved when you save the note.'
            : 'Applied when you press Done, and saved with everything else.'
        }
        title="Details"
        trailing={
          <SavePill
            accessibilityHint={
              since.slug === null ? 'Applies the tags' : `Applies the ${idLabel} and tags`
            }
            disabled={!changed}
            label="Done"
            onPress={() => {
              onDone({ slug: since.slug === null ? null : draftSlug.trim(), tags: draftTags });
            }}
            testID="details-done"
          />
        }
      />

      <SheetBody contentContainerStyle={{ gap: 20 }}>
        {since.slug === null ? null : (
          <View className="gap-2">
            <Text className="font-body-medium text-[14px] text-ink-soft">
              {sentenceCase(idLabel)}
            </Text>
            <TextInput
              accessibilityLabel={sentenceCase(idLabel)}
              autoCapitalize="none"
              autoCorrect={false}
              className="h-11 rounded-full bg-card px-4 font-body text-[16px] text-ink"
              onChangeText={setDraftSlug}
              placeholder={idLabel}
              testID="details-slug"
              value={draftSlug}
            />
            <Text className="font-body text-[13px] leading-[18px] text-ink-soft">
              The last part of the path, used to link to it. Your server decides whether it is free.
            </Text>
          </View>
        )}

        <View className="gap-2">
          <Text className="font-body-medium text-[14px] text-ink-soft">Tags</Text>
          <View className="flex-row flex-wrap gap-2">
            {draftTags.map((tag) => (
              <Chip
                accessibilityHint="Removes this tag"
                accessibilityLabel={`Remove tag ${tag}`}
                key={tag}
                label={tag}
                onPress={() => {
                  setDraftTags(draftTags.filter((item) => item !== tag));
                }}
                trailingIcon={X}
              />
            ))}
            {draftTags.length === 0 ? (
              <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
                No tags yet.
              </Text>
            ) : null}
          </View>
          <View className="flex-row items-center gap-2">
            <TextInput
              accessibilityLabel="New tag"
              autoCapitalize="none"
              blurOnSubmit={false}
              className="h-11 flex-1 rounded-full bg-card px-4 font-body text-[16px] text-ink"
              onChangeText={setEntry}
              onSubmitEditing={addTag}
              placeholder="Add a tag"
              returnKeyType="done"
              testID="details-tag-entry"
              value={entry}
            />
            <IconButton
              disabled={entry.trim() === ''}
              icon={Plus}
              label="Add tag"
              onPress={addTag}
            />
          </View>
        </View>
      </SheetBody>
    </Sheet>
  );
}

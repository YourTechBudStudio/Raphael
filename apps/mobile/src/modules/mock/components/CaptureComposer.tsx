/**
 * THROWAWAY MOCK — the capture screen, "Composer".
 *
 * Writing takes the whole screen: title, a description line, the body. Filing lives in one bar
 * pinned above the keyboard: the destination chip and Save. The formatting row sits above that
 * bar while the body is focused. A successful save leaves for Home, which says so in a snackbar;
 * a failure takes a sheet, because a failure needs a decision and room to explain itself.
 */

import { ChevronDown, Layers, X } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip, colors, IconButton, SavePill } from '../../../ui';
import { type MockDestination, type MockDraft, type MockNote } from '../data';
import { useMockStore } from '../state';
import { DestinationPicker } from './DestinationPicker';
import { FakeBody, FormattingBar } from './FakeEditor';
import { OutcomeSheet } from './OutcomeSheet';
import { ProtectSheet } from './ProtectSheet';
import { useMockSave } from './useMockSave';

/**
 * The chip names the leaf and its parent, the way the location chip on Area screens shows the
 * tail of a path. Anything above the parent is elided: two levels say where this is; five clip.
 */
const chipLabel = (destination: MockDestination): string => {
  const parent = destination.path.at(-1);
  if (parent === undefined) return destination.title;

  return `${destination.path.length > 1 ? '… / ' : ''}${parent} / ${destination.title}`;
};

export interface CaptureComposerProps {
  /** An existing note to open in the editor. Absent for a new capture. */
  note?: MockNote | undefined;
  /** An unfinished note kept on this phone. Saving it turns it into a note. */
  draft?: MockDraft | undefined;
  onSaved: () => void;
  onClose: () => void;
}

export function CaptureComposer({ note, draft, onSaved, onClose }: CaptureComposerProps) {
  const insets = useSafeAreaInsets();
  const setHomeNotice = useMockStore((state) => state.setHomeNotice);
  const addNote = useMockStore((state) => state.addNote);
  const updateNote = useMockStore((state) => state.updateNote);
  const saveDraft = useMockStore((state) => state.saveDraft);
  const putDraft = useMockStore((state) => state.putDraft);
  // What the server is known to hold, and the unfinished record on this phone. A replay that
  // gets an answer moves the note from the second to the first without leaving the screen.
  const [saved, setSaved] = useState<MockNote | undefined>(note);
  const [live, setLive] = useState<MockDraft | undefined>(draft);
  const initial = note ?? draft;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [bodyFocused, setBodyFocused] = useState(false);
  const [destination, setDestination] = useState<MockDestination | null>(
    initial?.destination ?? null,
  );
  const [picking, setPicking] = useState(false);
  const unconfirmed = live?.kind === 'unconfirmed';
  // THROWAWAY: what the phone's own storage is doing, from the gallery.
  const storage = useMockStore((state) => state.storage);
  const setStorage = useMockStore((state) => state.setStorage);
  const unprotected = storage !== 'fine';
  const [leaving, setLeaving] = useState(false);

  // The server derives a title when none was typed; the mock takes the body's first line.
  const resolveTitle = (rawTitle: string, rawBody: string): string =>
    rawTitle.trim() === ''
      ? (rawBody.split('\n').find((line) => line.trim() !== '') ?? 'Untitled note').trim()
      : rawTitle.trim();

  const { phase, save, reset, locked } = useMockSave((mode, outcome) => {
    if (mode === 'replay') {
      // The frozen request went again. Its content is the draft's, not the form's: the answer
      // is about what was sent, and anything typed since is an edit on top of it.
      if (live === undefined || live.destination === null) return;
      if (outcome === 'saved') {
        const frozen = {
          title: resolveTitle(live.title, live.body),
          description: live.description,
          body: live.body,
          destination: live.destination,
        };
        const id = saveDraft(live.id, frozen);
        setSaved({ ...frozen, id, revision: 1 });
        setLive(undefined);
      } else if (outcome === 'refused') {
        const refused: MockDraft = {
          ...live,
          kind: 'refused',
          when: 'Refused just now',
          reason: 'The title is longer than 200 characters.',
        };
        putDraft(refused);
        setLive(refused);
      }

      return;
    }

    if (destination === null) return;
    const input = {
      title: resolveTitle(title, body),
      description: description.trim(),
      body,
      destination,
    };

    if (outcome === 'saved') {
      if (saved !== undefined) updateNote(saved.id, input);
      else if (live !== undefined) saveDraft(live.id, input);
      else addNote(input);
      setHomeNotice({ title: input.title, destination });
      onSaved();

      return;
    }

    // Nothing certain happened. The writing stays on this phone as an unfinished note, with the
    // request frozen for a replay when the answer was lost.
    const record: MockDraft = {
      id: live?.id ?? Date.now(),
      kind: outcome === 'uncertain' ? 'unconfirmed' : 'refused',
      title,
      description,
      body,
      destination,
      when: outcome === 'uncertain' ? 'Sent just now' : 'Refused just now',
      ...(outcome === 'refused' ? { reason: 'The title is longer than 200 characters.' } : {}),
    };
    putDraft(record);
    setLive(record);
  });

  const hasContent = title.trim() !== '' || body.trim() !== '';
  const changed =
    saved === undefined ||
    title !== saved.title ||
    description !== saved.description ||
    body !== saved.body ||
    destination?.id !== saved.destination.id;
  const canSave =
    hasContent && changed && destination !== null && !locked && !unconfirmed && !unprotected;
  const failed = phase.kind === 'done' ? phase.outcome : null;
  const barBottom = Math.max(insets.bottom, 8);

  // The phone's own protection comes first: nothing the server says matters while the writing
  // here is not safe.
  const status = unprotected
    ? storage === 'write_failing'
      ? 'Not protected · the last change could not be written to this phone'
      : 'Not protected · too large to keep on this phone'
    : locked
      ? unconfirmed
        ? 'Checking with your server…'
        : 'Saving to your server…'
      : unconfirmed
        ? 'Last save not confirmed · Retry to check'
        : live?.kind === 'refused'
          ? 'Your server refused the last save · kept on this phone'
          : saved === undefined || changed
            ? 'Kept on this phone as you write'
            : `On your server · revision ${String(saved.revision)}`;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-canvas"
    >
      <View className="flex-1">
        <View className="h-14 flex-row items-center px-3" style={{ marginTop: insets.top + 4 }}>
          <IconButton
            icon={X}
            label="Close"
            onPress={() => {
              // Leaving is blocked while writing exists only here. The sheet forces the choice.
              if (unprotected) setLeaving(true);
              else onClose();
            }}
          />
          <Text
            accessibilityLiveRegion="polite"
            className={`ml-1 flex-1 font-body text-[14px] ${unprotected ? 'text-danger' : 'text-ink-soft'}`}
            numberOfLines={2}
          >
            {status}
          </Text>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            accessibilityLabel="Title"
            autoFocus={initial === undefined}
            blurOnSubmit
            className="font-heading text-[26px] leading-[32px] text-ink"
            editable={!locked}
            // Wraps, but never past two lines: a longer title scrolls within the field so the
            // body stays in reach rather than being pushed under the keyboard.
            multiline
            onChangeText={(value) => {
              setTitle(value.replace(/\n/g, ' '));
            }}
            placeholder="Title"
            placeholderTextColor={colors.inkSoft}
            returnKeyType="next"
            style={{ maxHeight: 64 }}
            value={title}
          />
          <TextInput
            accessibilityLabel="Description"
            className="mt-1 font-body text-[15px] leading-[22px] text-ink-soft"
            editable={!locked}
            multiline
            onChangeText={setDescription}
            placeholder="Add a description"
            placeholderTextColor={colors.lilac}
            value={description}
          />
          <View className="mt-4">
            <FakeBody
              editable={!locked}
              minHeight={260}
              onBlur={() => {
                setBodyFocused(false);
              }}
              onChangeText={setBody}
              onFocus={() => {
                setBodyFocused(true);
              }}
              value={body}
            />
          </View>
        </ScrollView>

        {/* The composer bar: pinned above the keyboard, on the sheet surface. */}
        <View className="border-t border-line bg-card" style={{ paddingBottom: barBottom }}>
          {bodyFocused ? (
            <View className="h-12 justify-center border-b border-line">
              <FormattingBar disabled={locked} />
            </View>
          ) : null}

          <View className="flex-row items-center gap-2 px-3 pt-2">
            <Chip
              accessibilityHint="Chooses the area or project this note is filed in"
              // A frozen request cannot change where it goes; the answer decides that first.
              disabled={locked || unconfirmed}
              icon={Layers}
              accessibilityLabel={
                destination === null
                  ? 'Where does this go? Nothing chosen yet.'
                  : `Filing in ${[...destination.path, destination.title].join(', ')}`
              }
              label={destination === null ? 'Where?' : chipLabel(destination)}
              onPress={() => {
                setPicking(true);
              }}
              selected={destination !== null}
              style={{ flexShrink: 1 }}
              trailingIcon={ChevronDown}
            />
            <View className="flex-1" />
            {unconfirmed ? (
              // Retry stands where Save would: the same request goes again, and the answer may
              // be yes, no, or still nothing. Nothing new can be created from this screen until
              // the server has said which.
              <SavePill
                accessibilityHint="Sends exactly the same save again. It cannot make a second copy."
                disabled={locked}
                label={locked ? 'Checking…' : 'Retry'}
                onPress={() => {
                  save('replay');
                }}
              />
            ) : (
              <SavePill
                accessibilityHint={
                  destination === null
                    ? 'Choose where this goes first'
                    : `Saves this note in ${destination.title}`
                }
                disabled={!canSave}
                label={locked ? 'Saving…' : 'Save'}
                onPress={() => {
                  save('save');
                }}
              />
            )}
          </View>
        </View>
      </View>

      <OutcomeSheet
        destinationTitle={destination?.title ?? 'there'}
        onClose={reset}
        onRetry={() => {
          reset();
          save('replay');
        }}
        outcome={failed}
      />

      <ProtectSheet
        onDiscard={() => {
          setStorage('fine');
          setLeaving(false);
          onClose();
        }}
        onKeepEditing={() => {
          setLeaving(false);
        }}
        onRepair={() => {
          // Writing it again, or undoing the last change, makes the note storable in the mock.
          setStorage('fine');
          setLeaving(false);
        }}
        storage={storage}
        visible={leaving}
      />

      <DestinationPicker
        onClose={() => {
          setPicking(false);
        }}
        onSelect={setDestination}
        selected={destination}
        visible={picking}
      />
    </KeyboardAvoidingView>
  );
}

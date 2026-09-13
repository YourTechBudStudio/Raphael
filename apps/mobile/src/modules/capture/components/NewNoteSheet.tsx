import { X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { TextInput, Text, View } from 'react-native';

import {
  colors,
  confirmDiscard,
  GrowingTextInput,
  IconButton,
  SavePill,
  Sheet,
  SheetBody,
} from '../../../ui';
import type { AreaOption } from '../../collections';
import { useSheetsStore } from '../../navigation';
import { useCreateNote } from '../client/mutations';
import { AreaPicker } from './AreaPicker';

/** Leaving with unsaved writing throws it away, so the sheet says so before it does. */
const DISCARD_PROMPT = {
  title: 'Discard this note?',
  message: 'What you wrote will not be saved.',
  keepLabel: 'Keep writing',
} as const;

/** The title takes focus after the sheet has settled, so the entry spring is not interrupted. */
const FOCUS_DELAY = 320;

/** The title falls back to the first written line of the body. */
function firstLine(body: string): string {
  const line = body
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');

  return line ?? '';
}

/**
 * The New note sheet: a title, a body, a destination, and one Save.
 *
 * The destination is chosen here, every time, and nothing chooses it for you. That is a deliberate
 * change: the sheet used to be handed a target when it opened, and when it was opened from Home
 * that target was a hidden inbox area. Filing someone's thinking somewhere they did not pick is the
 * failure mode a second brain cannot have, so Save stays off until an area is tapped.
 *
 * What is written stays written. The draft survives the area list loading, failing, and being
 * retried, because losing what someone typed because their server was slow would be a worse bug
 * than the one being fixed.
 *
 * These notes are kept on this device for the session. Nothing here reaches the server, and no copy
 * in this sheet says otherwise.
 */
export function NewNoteSheet() {
  const open = useSheetsStore((state) => state.open);
  const session = useSheetsStore((state) => state.session);
  const closeSheet = useSheetsStore((state) => state.close);
  // Keyed on the opening. The sheet stays mounted so it can animate out, which means without an
  // identity that changes per opening the next open would show the last one's aftermath.
  return <NoteForm key={session} onClose={closeSheet} visible={open?.kind === 'new-note'} />;
}

interface NoteFormProps {
  visible: boolean;
  onClose: () => void;
}

function NoteForm({ visible, onClose }: NoteFormProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [destination, setDestination] = useState<AreaOption | null>(null);
  const [failed, setFailed] = useState(false);
  const titleInput = useRef<TextInput>(null);
  const bodyInput = useRef<TextInput>(null);

  const createNote = useCreateNote();

  const hasContent = title.trim() !== '' || body.trim() !== '';
  const saving = createNote.isPending;
  const canSave = hasContent && destination !== null && !saving;

  useEffect(() => {
    if (!visible) return;

    const timer = setTimeout(() => {
      titleInput.current?.focus();
    }, FOCUS_DELAY);

    return () => {
      clearTimeout(timer);
    };
  }, [visible]);

  const handleSave = () => {
    if (!canSave || destination === null) return;

    setFailed(false);

    const trimmedTitle = title.trim();

    createNote.mutate(
      {
        parent: { type: 'area', id: destination.id },
        title: trimmedTitle === '' ? firstLine(body) : trimmedTitle,
        body: body.trim(),
      },
      {
        onSuccess: onClose,
        onError: () => {
          setFailed(true);
        },
      },
    );
  };

  const handleClose = () => {
    if (saving) return;

    if (!hasContent) {
      onClose();

      return;
    }

    void confirmDiscard(DISCARD_PROMPT).then((discard) => {
      if (discard) onClose();
    });
  };

  return (
    <Sheet
      className="px-5"
      keyboardAvoiding
      label="the new note sheet"
      onClose={handleClose}
      testID="new-note-sheet"
      visible={visible}
    >
      <View className="flex-row items-center justify-between">
        <IconButton
          accessibilityHint="Closes the new note sheet"
          className="bg-primary-soft"
          disabled={saving}
          icon={X}
          label="Close"
          onPress={handleClose}
        />
        <SavePill
          accessibilityHint={
            destination === null
              ? 'Choose an area below before saving'
              : `Saves this note in ${destination.title}`
          }
          disabled={!canSave}
          label={saving ? 'Saving…' : 'Save'}
          onPress={handleSave}
          testID="new-note-save"
        />
      </View>

      {/* Close and Save stay above; everything that grows with what you write scrolls. */}
      <SheetBody>
        <Text
          accessibilityRole="header"
          className="mt-4 font-heading text-[28px] leading-[34px] text-ink"
        >
          New note
        </Text>

        <TextInput
          accessibilityLabel="Title"
          className="mt-4 font-heading text-[22px] leading-[28px] text-ink"
          editable={!saving}
          onChangeText={setTitle}
          onSubmitEditing={() => {
            bodyInput.current?.focus();
          }}
          placeholder="Title"
          placeholderTextColor={colors.inkSoft}
          ref={titleInput}
          returnKeyType="next"
          submitBehavior="submit"
          testID="new-note-title"
          value={title}
        />

        <GrowingTextInput
          accessibilityLabel="Note"
          className="mt-3"
          editable={!saving}
          onChangeText={setBody}
          placeholder="Start writing…"
          ref={bodyInput}
          testID="new-note-body"
          value={body}
        />

        {failed ? (
          <Text
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            className="mt-3 font-body text-[15px] leading-[22px] text-danger"
          >
            That note did not save. Your writing is still here — try Save again.
          </Text>
        ) : null}

        <View accessibilityRole="radiogroup" className="mt-6 gap-2 border-t border-line pt-4">
          <Text accessibilityRole="header" className="font-heading text-[16px] text-ink">
            Where does this go?
          </Text>
          <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
            {destination === null
              ? 'Pick an area. Raphael will not choose one for you.'
              : `Filing in ${destination.title}${destination.context === '' ? '' : ` · ${destination.context}`}.`}
          </Text>
          <AreaPicker
            disabled={saving}
            onSelect={setDestination}
            selectedId={destination?.id ?? null}
          />
        </View>

        <Text className="mt-5 pb-5 font-body text-[13px] leading-[19px] text-ink-soft">
          Notes are kept on this device for now. Raphael does not store them on your server yet.
        </Text>
      </SheetBody>
    </Sheet>
  );
}

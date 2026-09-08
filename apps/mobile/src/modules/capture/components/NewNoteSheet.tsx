import { X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  TextInput,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from 'react-native';

import { colors, confirmDiscard, IconButton, SavePill, Sheet, SheetBody } from '../../../ui';
import { useSheetsStore } from '../../navigation';
import { useCreateNote } from '../client/mutations';
import { useCaptureLocation } from '../client/queries';

/** Leaving with unsaved writing throws it away, so the sheet says so before it does. */
const DISCARD_PROMPT = {
  title: 'Discard this note?',
  message: 'What you wrote will not be saved.',
  keepLabel: 'Keep writing',
} as const;

/** Four lines of body text at 22px line height, so the sheet opens with room to write. */
const BODY_MIN_HEIGHT = 88;
/**
 * The body stops growing here and scrolls within itself, so the caret stays with the keyboard
 * rather than running off the end of the sheet's own scroll.
 */
const BODY_MAX_HEIGHT = 220;
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
 * Where the note lands. The name arrives with the location query, so the line says it is still
 * loading rather than naming the wrong place, and still says something true if the name never
 * arrives: the note goes where the capture flow started either way.
 */
function destinationLine(parentName: string | undefined, failed: boolean): string {
  if (parentName !== undefined) {
    return `Saving to ${parentName}`;
  }

  return failed ? 'Saving to the place you opened this from.' : 'Finding where this note goes…';
}

/**
 * The New note sheet: a title, a body, and one Save. It is mounted for the whole app and reads
 * both its open state and where the note goes from the sheets store.
 *
 * Save waits for the note to actually exist before the sheet closes, and closing with unsaved
 * writing asks first.
 */
export function NewNoteSheet() {
  const open = useSheetsStore((state) => state.open);
  const target = useSheetsStore((state) => state.captureTarget);
  const closeSheet = useSheetsStore((state) => state.close);
  const visible = open === 'new-note';

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [bodyHeight, setBodyHeight] = useState(BODY_MIN_HEIGHT);
  const [failed, setFailed] = useState(false);
  const titleInput = useRef<TextInput>(null);
  const bodyInput = useRef<TextInput>(null);

  const createNote = useCreateNote();
  const path = useCaptureLocation(target, visible);
  const steps = path.data ?? [];
  const parentName = steps.length === 0 ? undefined : steps[steps.length - 1]?.name;

  const destination = destinationLine(parentName, path.isError);

  const hasContent = title.trim() !== '' || body.trim() !== '';
  const saving = createNote.isPending;
  const canSave = hasContent && !saving;

  useEffect(() => {
    if (!visible) {
      return;
    }

    const timer = setTimeout(() => {
      titleInput.current?.focus();
    }, FOCUS_DELAY);

    return () => {
      clearTimeout(timer);
    };
  }, [visible]);

  const reset = () => {
    setTitle('');
    setBody('');
    setBodyHeight(BODY_MIN_HEIGHT);
    setFailed(false);
    createNote.reset();
  };

  const handleSave = () => {
    if (!canSave) {
      return;
    }

    setFailed(false);

    const trimmedTitle = title.trim();

    createNote.mutate(
      {
        target,
        title: trimmedTitle === '' ? firstLine(body) : trimmedTitle,
        body: body.trim(),
      },
      {
        onSuccess: () => {
          reset();
          closeSheet();
        },
        onError: () => {
          setFailed(true);
        },
      },
    );
  };

  const handleClose = () => {
    if (saving) {
      return;
    }

    if (!hasContent) {
      reset();
      closeSheet();
      return;
    }

    void confirmDiscard(DISCARD_PROMPT).then((discard) => {
      if (discard) {
        reset();
        closeSheet();
      }
    });
  };

  const handleBodySize = (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
    const height = event.nativeEvent.contentSize.height;
    setBodyHeight(Math.min(Math.max(height, BODY_MIN_HEIGHT), BODY_MAX_HEIGHT));
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
            parentName === undefined ? 'Saves this note' : `Saves this note to ${parentName}`
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

        <TextInput
          accessibilityLabel="Note"
          className="mt-3 font-body text-[16px] leading-[22px] text-ink"
          editable={!saving}
          multiline
          onChangeText={setBody}
          onContentSizeChange={handleBodySize}
          placeholder="Start writing…"
          placeholderTextColor={colors.inkSoft}
          ref={bodyInput}
          style={{ height: bodyHeight }}
          testID="new-note-body"
          textAlignVertical="top"
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

        <Text
          accessibilityLiveRegion="polite"
          className="mt-4 pb-5 font-body text-[14px] text-ink-soft"
        >
          {destination}
        </Text>
      </SheetBody>
    </Sheet>
  );
}

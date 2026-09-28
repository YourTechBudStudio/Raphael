import type { ContainerType } from '@raphael/contracts/nodes';
import { X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Text, TextInput } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { GrowingTextInput, IconButton, SavePill, Sheet, SheetBody, SheetHeader } from '../../../ui';
import { announce, type CreateProblem, type UnsentRow } from '../../unsent';
import { useContainerDraft } from '../client/container-creation';

/** The title takes focus after the sheet has settled, so the entry spring is not interrupted. */
const FOCUS_DELAY = 320;

const NOUN = { area: 'area', project: 'project' } as const;

/** What the header says under the title. A refusal is said in red under the fields instead. */
const subtitleFor = (
  row: UnsentRow | undefined,
  problem: CreateProblem | null,
  saving: boolean,
  written: boolean,
) => {
  if (saving) return 'Saving…';
  if (row?.status === 'pending') return 'Couldn’t save · will retry';
  if (!written) return 'Add a title or some notes to save';
  if (problem === 'slug') return 'The title needs a letter or number to save';

  return 'Draft · on this phone';
};

export interface NewContainerSheetProps {
  visible: boolean;
  /** A kept draft to reopen, or null for a new one. */
  draftId: string | null;
  containerType: ContainerType;
  parentAreaId: number | null;
  onClose: () => void;
  onCreated: (container: ContainerRef) => void;
}

/**
 * Creating an area or a project: a title, optional notes (its description), and one Save.
 *
 * Closing keeps anything written as a draft in Unfinished; a Save that cannot reach the server keeps
 * trying from there.
 */
export function NewContainerSheet({
  visible,
  draftId,
  containerType,
  parentAreaId,
  onClose,
  onCreated,
}: NewContainerSheetProps) {
  const draft = useContainerDraft({ draftId, containerType, parentAreaId });
  const [title, setTitle] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [unwritable, setUnwritable] = useState(false);
  const titleInput = useRef<TextInput>(null);
  const noun = NOUN[containerType];
  const { row } = draft;

  useEffect(() => {
    if (!visible) return;

    const timer = setTimeout(() => {
      titleInput.current?.focus();
    }, FOCUS_DELAY);

    return () => {
      clearTimeout(timer);
    };
  }, [visible]);

  const onScreen = () => ({
    title: title ?? row?.title ?? '',
    description: notes ?? row?.description ?? '',
  });

  const save = () => {
    if (draft.saving) return;

    void draft.save(onScreen()).then((outcome) => {
      setUnwritable(outcome.kind === 'unwritable');
      if (outcome.kind === 'created') onCreated(outcome.container);
    });
  };

  const close = () => {
    if (draft.saving) return;

    void draft.leave(onScreen()).then((left) => {
      // What is on screen did not reach this phone, so the sheet stays and says so.
      if (left === 'unwritable') {
        setUnwritable(true);

        return;
      }
      if (left === 'kept') {
        announce(
          row?.status === 'pending'
            ? 'Kept in Unfinished. It will keep trying.'
            : 'Kept in Unfinished as a draft.',
        );
      }
      onClose();
    });
  };

  const retrying = row?.status === 'pending';
  // From what is on screen: the row catches up a moment after each keystroke.
  const written =
    (title ?? row?.title ?? '').trim() !== '' || (notes ?? row?.description ?? '') !== '';

  return (
    <Sheet
      className="gap-5 px-5 pb-6 pt-3"
      keyboardAvoiding
      label={`New ${noun}`}
      onClose={close}
      visible={visible}
    >
      <SheetHeader
        leading={<IconButton icon={X} label="Close" onPress={close} />}
        subtitle={subtitleFor(row, draft.problem, draft.saving, written)}
        title={`New ${noun}`}
        trailing={
          <SavePill
            accessibilityHint={`Creates this ${noun} on your server`}
            disabled={draft.saving || (!written && !retrying)}
            label={draft.saving ? 'Saving…' : retrying ? 'Try now' : 'Save'}
            onPress={save}
          />
        }
      />

      <SheetBody className="gap-4" contentContainerStyle={{ gap: 16 }}>
        <TextInput
          accessibilityLabel={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} title`}
          className="font-heading text-[24px] leading-[30px] text-ink"
          editable={!draft.saving}
          onChangeText={(value) => {
            setTitle(value);
            draft.write({ title: value });
          }}
          placeholder="Title"
          ref={titleInput}
          returnKeyType="next"
          value={title ?? row?.title ?? ''}
        />

        <GrowingTextInput
          accessibilityLabel="Notes"
          className="font-body text-[16px] leading-[24px] text-ink"
          editable={!draft.saving}
          onChangeText={(value) => {
            setNotes(value);
            draft.write({ description: value });
          }}
          placeholder="Anything worth writing down about it (optional)"
          value={notes ?? row?.description ?? ''}
        />

        {unwritable ? (
          <Text accessibilityLiveRegion="assertive" className="font-body text-[15px] text-danger">
            Couldn’t save on this phone.
          </Text>
        ) : row?.status === 'refused' ? (
          <Text accessibilityLiveRegion="assertive" className="font-body text-[15px] text-danger">
            {`Not saved: ${row.error ?? ''}`}
          </Text>
        ) : null}
      </SheetBody>
    </Sheet>
  );
}

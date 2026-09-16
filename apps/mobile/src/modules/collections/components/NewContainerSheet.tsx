import type { ContainerType } from '@raphael/contracts/nodes';
import { X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Text, TextInput } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import {
  confirmDiscard,
  GrowingTextInput,
  IconButton,
  SavePill,
  Sheet,
  SheetBody,
  SheetHeader,
} from '../../../ui';
import { useContainerCreationSession } from '../client/container-creation';

/** Leaving with a title nobody has sent throws it away, so the sheet says so before it does. */
const DISCARD_PROMPT = {
  title: 'Discard this?',
  message: 'What you wrote will not be saved.',
  keepLabel: 'Keep writing',
} as const;

/** The title takes focus after the sheet has settled, so the entry spring is not interrupted. */
const FOCUS_DELAY = 320;

const NOUN = { area: 'area', project: 'project' } as const;

export interface NewContainerSheetProps {
  visible: boolean;
  /** Changes per opening. What mints a new idempotency key and resets the form. */
  sessionId: number;
  containerType: ContainerType;
  parentAreaId: number | null;
  onClose: () => void;
  onCreated: (container: ContainerRef, title: string) => void;
}

/**
 * Creating an area or a project: a title, an optional note, and one Save.
 *
 * The sheet owns the whole thing now. There is no durable record behind it, no recovery list it
 * feeds and nothing on disk to clean up - an area is a title and a parent, and losing one in flight
 * costs a title. What protects the cheap case is the session's key: a press, a lost answer and
 * another press within one opening is a replay, not a second area.
 *
 * All three outcomes are said here. A refusal keeps the title for another go. A lost response says
 * it could not be confirmed and does not retry on its own; pressing again reuses the same key while
 * this sheet is open. Closing forgets the key, which is the accepted cost.
 */
export function NewContainerSheet({
  visible,
  sessionId,
  containerType,
  parentAreaId,
  onClose,
  onCreated,
}: NewContainerSheetProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleInput = useRef<TextInput>(null);
  const { submit, busy } = useContainerCreationSession(sessionId);
  const noun = NOUN[containerType];

  // A fresh opening is a fresh form. The host also re-keys the component, so this is the second of
  // two guards rather than the only one - and it is the one that survives a host that does not.
  useEffect(() => {
    setTitle('');
    setBody('');
    setProblem(null);
    setNotice(null);
  }, [sessionId]);

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
    void (async () => {
      setProblem(null);
      setNotice(null);

      const outcome = await submit({ containerType, parentAreaId, title, body });

      switch (outcome.kind) {
        case 'created':
          onCreated(outcome.container, outcome.title);

          return;
        case 'refused':
        case 'not_sent':
          if (outcome.message !== '') setProblem(outcome.message);

          return;
        case 'unconfirmed':
        case 'retired':
          setNotice(outcome.message);
      }
    })();
  };

  const handleClose = () => {
    if (busy) return;
    if (title.trim() === '' && body === '') {
      onClose();

      return;
    }

    void confirmDiscard(DISCARD_PROMPT).then((discard) => {
      if (discard) onClose();
    });
  };

  return (
    <Sheet
      className="gap-5 px-5 pb-6 pt-3"
      keyboardAvoiding
      label={`New ${noun}`}
      onClose={handleClose}
      visible={visible}
    >
      <SheetHeader
        leading={<IconButton icon={X} label="Close" onPress={handleClose} />}
        title={`New ${noun}`}
        trailing={
          <SavePill
            accessibilityHint={`Creates this ${noun} on your server`}
            disabled={busy || title.trim() === ''}
            label={busy ? 'Saving…' : 'Save'}
            onPress={handleSave}
          />
        }
      />

      <SheetBody className="gap-4" contentContainerStyle={{ gap: 16 }}>
        <TextInput
          accessibilityLabel={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} title`}
          className="font-heading text-[24px] leading-[30px] text-ink"
          editable={!busy}
          onChangeText={setTitle}
          placeholder="Title"
          ref={titleInput}
          returnKeyType="next"
          value={title}
        />

        <GrowingTextInput
          accessibilityLabel="Notes"
          className="font-body text-[16px] leading-[24px] text-ink"
          editable={!busy}
          onChangeText={setBody}
          placeholder="Anything worth writing down about it (optional)"
          value={body}
        />

        {problem === null ? null : (
          <Text accessibilityLiveRegion="assertive" className="font-body text-[15px] text-danger">
            {problem}
          </Text>
        )}

        {/* An unconfirmed creation is not a failure and is not said in the error colour. What it
            needs is looking, not trying again, and pressing Save again while this sheet is open
            replays the same request rather than making a second one. */}
        {notice === null ? null : (
          <Text
            accessibilityLiveRegion="assertive"
            className="font-body text-[15px] leading-[22px] text-ink"
          >
            {notice}
          </Text>
        )}
      </SheetBody>
    </Sheet>
  );
}

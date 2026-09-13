import { X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import {
  confirmDiscard,
  GrowingTextInput,
  IconButton,
  SavePill,
  Sheet,
  SheetBody,
  SheetHeader,
} from '../../../ui';
import { useAttemptViews, useCreationOwner, useCreationSession } from '../client/creation';
import {
  describeUnresolved,
  describeUnsendable,
  emptyDraft,
  hasContent,
  reduceDraft,
  type Draft,
} from './draft.ts';
import type { AttemptRecord, ContainerTarget } from './types.ts';

/** Leaving with unsaved writing throws it away, so the sheet says so before it does. */
const DISCARD_PROMPT = {
  title: 'Discard this?',
  message: 'What you wrote will not be saved.',
  keepLabel: 'Keep writing',
} as const;

/** The title takes focus after the sheet has settled, so the entry spring is not interrupted. */
const FOCUS_DELAY = 320;

export interface NewContainerSheetProps {
  visible: boolean;
  target: ContainerTarget;
  /** Input recovered from an earlier attempt, with the sentence explaining how it got here. */
  prefill?: { readonly draft: Draft; readonly replaces?: AttemptRecord | undefined } | undefined;
  onClose: () => void;
  /** Called once the server has confirmed, with what it actually created and which attempt made it. */
  onCreated: (container: { type: ContainerTarget['type']; id: number }, attemptId: string) => void;
}

const NOUN = { area: 'area', project: 'project' } as const;

const UNUSABLE_CONNECTION_NOTICE =
  'Your server is not accepting requests right now. Fix the connection and this can be saved.';

/**
 * Creating an area or a project: a title, an optional note, and one Save.
 *
 * The sheet owns the draft and nothing else. The moment Save is pressed the attempt becomes the
 * owner's - a durable record with a frozen payload and a key - and this becomes a view of it. That
 * is why closing the sheet mid-flight is safe: the request is not attached to this component, so
 * swiping it away cannot orphan an answer, and reopening cannot start a second one.
 *
 * The fields lock as soon as a request leaves. Editing a dispatched attempt would mean changing what
 * a key stands for after the server may already have acted on it, and there is no honest way to
 * present the result of that.
 */
export function NewContainerSheet({
  visible,
  target,
  prefill,
  onClose,
  onCreated,
}: NewContainerSheetProps) {
  const [draft, setDraft] = useState<Draft>(() => prefill?.draft ?? emptyDraft());
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const titleInput = useRef<TextInput>(null);

  const submit = useCreationOwner((state) => state.submit);
  const storeStatus = useCreationOwner((state) => state.status);
  const storeProblem = useCreationOwner((state) => state.problem);
  const sending = useCreationOwner((state) => state.sending);
  const unsaved = useCreationOwner((state) => state.unsaved);
  const session = useCreationSession();
  const views = useAttemptViews();

  const view = useMemo(
    () => views.find((candidate) => candidate.record.attemptId === attemptId) ?? null,
    [views, attemptId],
  );
  const inFlight = attemptId !== null && sending.includes(attemptId);
  const noun = NOUN[target.type];

  useEffect(() => {
    if (!visible) return;

    const timer = setTimeout(() => {
      titleInput.current?.focus();
    }, FOCUS_DELAY);

    return () => {
      clearTimeout(timer);
    };
  }, [visible]);

  // A success is reported once the server has confirmed it and the acknowledgement has been dealt
  // with - written, or held in memory and declared. Either way the creation happened.
  const acknowledged =
    view?.record.acknowledged ?? (attemptId === null ? undefined : unsaved[attemptId]);
  // Reported once. `list()` rebuilds its rows, so the acknowledged object is a new identity on
  // every refresh, and an effect keyed on it alone would navigate again on each one.
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (acknowledged === undefined || attemptId === null) return;
    if (reported.current === attemptId) return;

    reported.current = attemptId;
    onCreated({ type: acknowledged.type, id: acknowledged.id }, attemptId);
  }, [acknowledged, attemptId, onCreated]);

  const edit = (field: 'title' | 'body') => (value: string) => {
    setDraft((current) => reduceDraft(current, { type: 'edit', field, value }));
  };

  const handleSave = () => {
    if (session === null || inFlight) return;
    if (view?.logical === 'unresolved') return;

    void (async () => {
      const outcome = await submit({
        target,
        title: draft.title,
        body: draft.body,
        session,
        // Only ever a record known to have created nothing. `submit` checks it again, because the
        // consequence of getting it wrong is deleting evidence that a creation may exist.
        replaces: view?.record ?? prefill?.replaces,
      });

      if (outcome.kind === 'not_recorded') {
        setDraft((current) => reduceDraft(current, { type: 'problem', message: outcome.problem }));

        return;
      }

      setAttemptId(outcome.attemptId);
    })();
  };

  const handleClose = () => {
    // An unresolved attempt is never discarded by closing. It stays in the recovery list, which is
    // where someone comes back to it - dismissing this sheet is not a decision about the server.
    if (inFlight) return;
    if (view !== null || !hasContent(draft)) {
      onClose();

      return;
    }

    void confirmDiscard(DISCARD_PROMPT).then((discard) => {
      if (discard) onClose();
    });
  };

  const record = view?.record ?? null;
  // The view's projection, not the row's, so a confirmed-but-unwritten success is never presented
  // as something that may not have happened.
  const logical = view?.logical ?? null;
  const locked = inFlight || logical === 'unresolved';
  const storeUnavailable = storeStatus === 'unavailable';
  // A connection the app already knows is refusing requests cannot create anything. The owner
  // enforces this too, and that is the copy that matters - this one just stops someone pressing a
  // button that can only spend an attempt and leave a record to clean up.
  const connectionUnusable = session === null || !session.usable;
  const canSave = !locked && !storeUnavailable && !connectionUnusable && draft.title.trim() !== '';

  const problem =
    draft.problem ??
    (storeUnavailable ? unavailableMessage(storeProblem) : null) ??
    (session !== null && !session.usable ? UNUSABLE_CONNECTION_NOTICE : null) ??
    (logical === 'refused' ? (record?.lastOutcome?.message ?? null) : null);

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
            accessibilityHint={`Creates this ${noun} on the server`}
            disabled={!canSave}
            label={inFlight ? 'Saving…' : 'Save'}
            onPress={handleSave}
          />
        }
      />

      <SheetBody className="gap-4" contentContainerStyle={{ gap: 16 }}>
        {draft.notice === null ? null : (
          <Text
            accessibilityLiveRegion="polite"
            className="font-body text-[15px] leading-[22px] text-ink-soft"
          >
            {draft.notice}
          </Text>
        )}

        <TextInput
          accessibilityLabel={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} title`}
          className="font-heading text-[24px] leading-[30px] text-ink"
          editable={!locked}
          onChangeText={edit('title')}
          placeholder="Title"
          ref={titleInput}
          returnKeyType="next"
          value={draft.title}
        />

        <GrowingTextInput
          accessibilityLabel="Notes"
          className="font-body text-[16px] leading-[24px] text-ink"
          editable={!locked}
          onChangeText={edit('body')}
          placeholder="Anything worth writing down about it (optional)"
          value={draft.body}
        />

        {problem === null ? null : (
          <Text accessibilityLiveRegion="assertive" className="font-body text-[15px] text-danger">
            {problem}
          </Text>
        )}

        {logical === 'unresolved' && record !== null ? (
          <View className="gap-2">
            <Text
              accessibilityLiveRegion="assertive"
              className="font-body text-[15px] leading-[22px] text-ink"
            >
              {describeUnresolved(record.title)}
            </Text>
            <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
              {view?.canRetry === true
                ? 'Close this and Raphael will keep the attempt so you can try again or check where it was going.'
                : describeUnsendable(record)}
            </Text>
          </View>
        ) : null}
      </SheetBody>
    </Sheet>
  );
}

const unavailableMessage = (problem: { readonly kind: string } | null): string =>
  problem?.kind === 'unsupported_version'
    ? 'This phone holds saved attempts written by a newer version of Raphael, so nothing can be created until that is sorted out.'
    : 'Raphael cannot save a record of an attempt on this phone right now, so nothing can be created.';

import { X } from 'lucide-react-native';
import { useEffect, useReducer, useRef, type RefObject } from 'react';
import { Text, TextInput, View } from 'react-native';

import type {
  AttemptCheck,
  Collection,
  ContainerTarget,
  CreateContainerInput,
  CreateContainerOutcome,
  PendingAttempt,
} from '../../../infrastructure/api/contracts';
import {
  Chip,
  colors,
  confirmDiscard,
  GrowingTextInput,
  IconButton,
  SavePill,
  Sheet,
  SheetBody,
} from '../../../ui';
import { openCollection, useSheetsStore } from '../../navigation';
import { useCheckAttempt, useCreateContainer } from '../client/creation';
import { useArea } from '../client/queries';
import {
  describeExpired,
  describeUncertain,
  draftOf,
  hasContent,
  initialCreation,
  isDraftEditable,
  leavesPendingAttempt,
  newAttemptKey,
  reduceCreation,
  resumedCreation,
  type CreationField,
  type CreationState,
} from '../creation/attempt';
import { usePendingStore } from '../state/pending';

/** Leaving with anything written throws it away, so the sheet says so before it does. */
const DISCARD_PROMPT = {
  title: 'Discard this?',
  message: 'What you wrote will not be saved, and nothing has been created.',
  keepLabel: 'Keep writing',
} as const;

/** The title takes focus after the sheet has settled, so the entry spring is not interrupted. */
const FOCUS_DELAY = 320;

/**
 * The creation sheet: a title, a body, one Save, and the truth about what happened to it.
 *
 * There is no description field. The contract and the attempt payload both carry a description,
 * and an attempt simply sends it empty: the field is absent from this form by choice, not by a
 * gap in what creation can express, so adding it back later changes this file and nothing else.
 *
 * It is mounted for the whole app and reads its target from the sheets store, the way the
 * capture sheets do. The target is fixed by whichever button opened it, so nothing here chooses
 * a parent or a type.
 *
 * The form is keyed on the store's opening counter, not on the destination: the sheet stays
 * mounted while closed, so keying on the destination alone would let a second creation for the
 * same parent reopen the previous one's finished or unresolved state instead of a blank form.
 */
export function NewContainerSheet() {
  const open = useSheetsStore((state) => state.open);
  const target = useSheetsStore((state) => state.containerTarget);
  const resume = useSheetsStore((state) => state.resumeAttempt);
  const session = useSheetsStore((state) => state.containerSession);
  const closeSheet = useSheetsStore((state) => state.close);
  const keepPending = usePendingStore((state) => state.keep);
  const resolvePending = usePendingStore((state) => state.resolve);
  const visible = open === 'new-container';

  const create = useCreateContainer();
  const check = useCheckAttempt();
  const parent = useArea(target.parentAreaId ?? '');
  const parentName = target.parentAreaId === null ? null : (parent.data?.name ?? null);

  return (
    <CreationForm
      ask={(attemptKey) => check.mutateAsync({ attemptKey, parentAreaId: target.parentAreaId })}
      key={session}
      onClose={closeSheet}
      onCreated={(attemptKey, collection) => {
        resolvePending(attemptKey);
        closeSheet();
        openCollection(collection);
      }}
      onKeep={(attempt) => {
        keepPending(attempt);
        closeSheet();
      }}
      onResolved={resolvePending}
      parentName={parentName}
      resume={resume}
      send={(input) => create.mutateAsync(input)}
      target={target}
      visible={visible}
    />
  );
}

interface CreationFormProps {
  target: ContainerTarget;
  resume: PendingAttempt | null;
  parentName: string | null;
  visible: boolean;
  send: (input: CreateContainerInput) => Promise<CreateContainerOutcome>;
  ask: (attemptKey: string) => Promise<AttemptCheck>;
  onCreated: (attemptKey: string, collection: Collection) => void;
  onKeep: (attempt: PendingAttempt) => void;
  /** A definite answer arrived: this attempt is no longer unresolved, whatever it decided. */
  onResolved: (attemptKey: string) => void;
  onClose: () => void;
}

const initialFor = ({ target, resume }: CreationFormProps): CreationState =>
  resume === null ? initialCreation(target) : resumedCreation(resume);

function CreationForm(props: CreationFormProps) {
  const { target, parentName, visible, send, ask, onCreated, onKeep, onResolved, onClose } = props;
  const [state, dispatch] = useReducer(reduceCreation, props, initialFor);
  const titleInput = useRef<TextInput>(null);
  const bodyInput = useRef<TextInput>(null);
  const noun = target.type === 'area' ? 'area' : 'project';
  const draft = draftOf(state);

  useFocusOnOpen(visible && isDraftEditable(state), titleInput);

  const change = (field: CreationField) => (value: string) => {
    dispatch({ type: 'edit', field, value });
  };

  const pending = (): PendingAttempt | null =>
    state.attemptKey === null ? null : { ...target, attemptKey: state.attemptKey, ...draft };

  const settle = (attemptKey: string, outcome: CreateContainerOutcome) => {
    dispatch({ type: 'outcome', outcome });
    if (outcome.kind === 'created') {
      onCreated(attemptKey, outcome.collection);

      return;
    }
    // A refusal is as definite as a creation: the server answered about this key, so a resumed
    // attempt stops being unresolved even though the form stays open to correct the title.
    if (outcome.kind === 'rejected') onResolved(attemptKey);
  };

  const dispatchSend = (attemptKey: string) => {
    void send({ ...target, ...draft, attemptKey }).then(
      (outcome) => {
        settle(attemptKey, outcome);
      },
      // A thrown error is not "not created": the request may have left the phone.
      () => {
        settle(attemptKey, { kind: 'uncertain' });
      },
    );
  };

  const handleSave = () => {
    if (state.phase.kind !== 'editing') return;
    const key = state.attemptKey ?? newAttemptKey();
    const next = reduceCreation(state, { type: 'submit', key });
    dispatch({ type: 'submit', key });
    if (next.phase.kind === 'saving' && next.attemptKey !== null) dispatchSend(next.attemptKey);
  };

  const handleRetry = () => {
    if (state.attemptKey === null) return;
    dispatch({ type: 'retry' });
    dispatchSend(state.attemptKey);
  };

  const handleCheck = () => {
    if (state.attemptKey === null) return;
    const attemptKey = state.attemptKey;
    dispatch({ type: 'check' });
    void ask(attemptKey).then(
      (result) => {
        dispatch({ type: 'check_result', result });
        if (result.kind === 'created') {
          onCreated(attemptKey, result.collection);

          return;
        }
        // "It was not created" is an answer. The marker goes even though the key is kept for a
        // safe resend, so the destination stops reporting an uncertainty the server has settled.
        if (result.kind === 'not_created') onResolved(attemptKey);
      },
      // The check itself failed: the attempt is exactly as unresolved as before.
      () => {
        dispatch({ type: 'check_failed' });
      },
    );
  };

  const handleClose = () => {
    if (
      state.phase.kind === 'saving' ||
      (state.phase.kind === 'uncertain' && state.phase.checking)
    ) {
      return;
    }
    if (leavesPendingAttempt(state)) {
      const attempt = pending();
      if (attempt !== null) onKeep(attempt);
      return;
    }
    if (!hasContent(state)) {
      onClose();
      return;
    }
    void confirmDiscard(DISCARD_PROMPT).then((discard) => {
      if (discard) onClose();
    });
  };

  const saving = state.phase.kind === 'saving';
  const editable = isDraftEditable(state);
  const destination = parentName === null ? 'At the top level' : `In ${parentName}`;

  return (
    <Sheet
      className="px-5"
      keyboardAvoiding
      label={`the new ${noun} sheet`}
      onClose={handleClose}
      testID="new-container-sheet"
      visible={visible}
    >
      <View className="flex-row items-center justify-between">
        <IconButton
          accessibilityHint={
            leavesPendingAttempt(state)
              ? 'Closes the sheet and keeps this attempt to resolve later'
              : `Closes the new ${noun} sheet`
          }
          className="bg-primary-soft"
          disabled={saving}
          icon={X}
          label="Close"
          onPress={handleClose}
        />
        {editable ? (
          <SavePill
            accessibilityHint={`Creates this ${noun} ${destination.toLowerCase()}`}
            label={saving ? 'Saving…' : 'Save'}
            onPress={handleSave}
            testID="new-container-save"
          />
        ) : saving ? (
          <SavePill disabled label="Saving…" onPress={handleSave} />
        ) : null}
      </View>

      <SheetBody>
        <Text
          accessibilityRole="header"
          className="mt-4 font-heading text-[28px] leading-[34px] text-ink"
        >
          {target.type === 'area' ? 'New area' : 'New project'}
        </Text>
        <Text className="mt-1 font-body text-[15px] leading-[22px] text-ink-soft">
          {destination}
        </Text>

        <TextInput
          accessibilityLabel="Title"
          className={`mt-4 font-heading text-[22px] leading-[28px] ${editable ? 'text-ink' : 'text-ink-soft'}`}
          editable={editable}
          onChangeText={change('title')}
          onSubmitEditing={() => {
            bodyInput.current?.focus();
          }}
          placeholder="Title"
          placeholderTextColor={colors.inkSoft}
          ref={titleInput}
          returnKeyType="next"
          submitBehavior="submit"
          testID="new-container-title"
          value={state.title}
        />

        <GrowingTextInput
          accessibilityHint="Optional"
          accessibilityLabel={`About this ${noun}`}
          className={`mt-3 ${editable ? 'text-ink' : 'text-ink-soft'}`}
          editable={editable}
          onChangeText={change('body')}
          placeholder="Anything worth keeping here…"
          ref={bodyInput}
          testID="new-container-body"
          value={state.body}
        />

        {editable ? (
          <Text className="mt-2 font-body text-[14px] leading-[20px] text-ink-soft">
            Only the title is needed. The rest can wait.
          </Text>
        ) : null}

        {state.phase.kind === 'editing' && state.phase.problem !== null ? (
          <Text
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            className="mt-3 font-body text-[15px] leading-[22px] text-danger"
          >
            {state.phase.problem}
          </Text>
        ) : null}
        {state.phase.kind === 'editing' && state.phase.notice !== null ? (
          <Text
            accessibilityLiveRegion="polite"
            className="mt-3 font-body text-[15px] leading-[22px] text-ink-soft"
          >
            {state.phase.notice}
          </Text>
        ) : null}

        {state.phase.kind === 'uncertain' ? (
          <View className="mt-4 gap-3 pb-5">
            <Text
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              className="font-body text-[15px] leading-[22px] text-ink"
            >
              {describeUncertain(state.title, state.phase.checking)}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Chip
                accessibilityHint="Asks the server whether this attempt went through"
                disabled={state.phase.checking}
                label={state.phase.checking ? 'Checking…' : 'Check'}
                onPress={handleCheck}
              />
              <Chip
                accessibilityHint="Sends the same attempt again. It cannot create a second one."
                disabled={state.phase.checking}
                label="Try again"
                onPress={handleRetry}
              />
              <Chip
                accessibilityHint="Closes the sheet and keeps this attempt to resolve later"
                disabled={state.phase.checking}
                label="Close and keep"
                onPress={handleClose}
              />
            </View>
          </View>
        ) : null}

        {state.phase.kind === 'expired' ? (
          <View className="mt-4 gap-3 pb-5">
            <Text
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              className="font-body text-[15px] leading-[22px] text-ink"
            >
              {describeExpired(state.title, parentName)}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Chip
                accessibilityHint="Keeps this attempt noted and closes the sheet so you can look"
                label={parentName === null ? 'Look in Browse' : `Look in ${parentName}`}
                onPress={handleClose}
              />
              <Chip
                accessibilityHint="Starts a new attempt with this title"
                label="Create it again"
                onPress={() => {
                  dispatch({ type: 'start_over' });
                }}
              />
            </View>
          </View>
        ) : null}

        {state.phase.kind === 'editing' || state.phase.kind === 'saving' ? (
          <View className="pb-5" />
        ) : null}
      </SheetBody>
    </Sheet>
  );
}

/** Focuses the title once the sheet has settled, and only while it can be typed in. */
function useFocusOnOpen(active: boolean, input: RefObject<TextInput | null>) {
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      input.current?.focus();
    }, FOCUS_DELAY);
    return () => {
      clearTimeout(timer);
    };
  }, [active, input]);
}

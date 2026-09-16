import { createEmptyDocument } from '@raphael/content';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { PrimaryButton } from '../../../ui';
import type {
  EditorCommand,
  EditorPort,
  EditorRejectionCode,
  EditorSelectionState,
  EditorSnapshot,
} from '../../editor';
import { goBack, openContainer, openHome } from '../../navigation';
import { useBackgroundFlush } from '../client/background.ts';
import { useDestinationName } from '../client/destinations.ts';
import { useCaptureOwner, useCaptureSession } from '../client/owner.ts';
import { composerView, type ProtectionProblem } from '../composer.ts';
import type { CaptureSession } from '../owner.ts';
import type { AttachmentToken, FlushResult } from '../owner.ts';
import type { Standing } from '../policy.ts';
import type { NoteDraftRecord } from '../types.ts';
import { CaptureView } from './CaptureView';
import { DestinationSheet } from './DestinationSheet';
import { OutcomeSheet, type OutcomeKind } from './OutcomeSheet';
import { ProtectSheet } from './ProtectSheet';

const EMPTY_DOCUMENT_JSON = JSON.stringify(createEmptyDocument());

export interface CaptureScreenProps {
  draftId: string;
}

/**
 * The capture route's composition: one draft, the owner, and where the person goes next.
 *
 * Everything this holds is either a question asked of the owner or a decision about navigation. It
 * decides nothing about certainty, nothing about what may be sent and nothing about what a status
 * means - those are `standingFor` and `composerView`, both of which can be exercised without a
 * screen. What is genuinely here is the part that cannot be: attaching a renderer, keeping the
 * fields and the record in step, and holding a lock across a transition.
 */
export function CaptureScreen({ draftId }: CaptureScreenProps) {
  const draft = useCaptureOwner((state) =>
    state.drafts.find((candidate) => candidate.draftId === draftId),
  );

  if (draft === undefined) {
    return (
      <View className="flex-1 justify-center gap-4 bg-canvas px-6">
        <Text
          accessibilityRole="header"
          className="font-heading text-[24px] leading-[30px] text-ink"
        >
          That note is no longer on this phone.
        </Text>
        <PrimaryButton label="Back to Home" onPress={openHome} />
      </View>
    );
  }

  // Keyed on the draft so the composer's own state - the fields, the captured document, the sheets -
  // belongs to one note and cannot be carried into another.
  return <Composer draft={draft} key={draftId} />;
}

interface OutcomeState {
  readonly kind: OutcomeKind;
  readonly message: string;
  readonly detail: string | null;
  /** Offered where the remedy is somewhere else to put it. */
  readonly chooseDestination: boolean;
}

function Composer({ draft }: { draft: NoteDraftRecord }) {
  const draftId = draft.draftId;
  const owner = useCaptureOwner;
  const session = useCaptureSession();
  const nameOf = useDestinationName();

  const protection = useCaptureOwner((state) => state.protection[draftId]);
  const saving = useCaptureOwner((state) => state.saving.includes(draftId));
  const standingFor = useCaptureOwner((state) => state.standingFor);
  // Recomputed whenever a record moves, which is what makes the bar follow an answer arriving.
  const drafts = useCaptureOwner((state) => state.drafts);
  const attempts = useCaptureOwner((state) => state.attempts);
  const unsaved = useCaptureOwner((state) => state.unsaved);
  const standing = useMemo(
    () => standingFor(draftId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the records are what make it change
    [standingFor, draftId, drafts, attempts, unsaved],
  );

  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const pushed = useRef({ title: draft.title, description: draft.description });
  const [document] = useState<unknown>(() => draft.document);
  const [selection, setSelection] = useState<EditorSelectionState>({
    active: [],
    available: [],
  });
  const [lastRejection, setLastRejection] = useState<EditorRejectionCode | null>(null);
  const [outcome, setOutcome] = useState<OutcomeState | null>(null);
  const [protectProblem, setProtectProblem] = useState<ProtectionProblem | null>(null);
  const [pickerSession, setPickerSession] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  const port = useRef<EditorPort>(null);
  const token = useRef<AttachmentToken | null>(null);
  /** Held while the picker is open, so the lock taken for it is given back when it closes. */
  const pickerLock = useRef<(() => void) | null>(null);
  /**
   * One controlled transition at a time, decided in the same turn as the press.
   *
   * Close and the picker both take a lock and then await a flush, and the owner does not refuse a
   * second lease - `takeLease` replaces the one in place. So two Close presses in one frame would
   * navigate twice, and a Close racing a picker press would leave one of them holding a lease the
   * other had already replaced, with a sheet and a navigation both arriving. A ref rather than
   * state, for the reason New note uses one: both presses read the same rendered value.
   *
   * **Save, Retry and "Record it again" are in it too**, and that is the case with teeth. Each of
   * them takes the owner's lease synchronously and then awaits a request that can run for seconds,
   * during which Close was still live: taking a second lease breaks the first one's continuity, so
   * an acknowledgement that should have cleared the draft takes the retain branch instead and
   * leaves a remainder claiming newer writing that does not exist - purely because someone tapped
   * Close while their note was saving. The same window let Close navigate away and the save's own
   * handler navigate again behind it.
   *
   * It is released wherever the transition does not complete. A path that navigates keeps it, via
   * `leaving`: the screen is going, and nothing else on it should start anything.
   */
  const transitioning = useRef(false);
  /** Set once this screen has started going somewhere. Nothing on it may begin anything after. */
  const leaving = useRef(false);

  // Best effort, on the way out of the foreground. Never the barrier a Save relies on.
  useBackgroundFlush(draftId);

  /**
   * Adopt the record whenever it disagrees with what was last pushed into the owner.
   *
   * Ordinary typing never triggers this: the write lands with exactly the value that was pushed. An
   * acknowledgement that clears the content does, and the fields have to follow it rather than
   * typing the cleared text straight back in.
   */
  useEffect(() => {
    if (draft.title === pushed.current.title && draft.description === pushed.current.description) {
      return;
    }

    pushed.current = { title: draft.title, description: draft.description };
    setTitle(draft.title);
    setDescription(draft.description);
  }, [draft.title, draft.description]);

  useEffect(() => {
    const live = port.current;

    if (live === null) return;

    const attached = owner.getState().attachEditor(draftId, live);
    token.current = attached;

    return () => {
      if (attached !== null) owner.getState().detachEditor(attached);
      token.current = null;
    };
  }, [owner, draftId]);

  const edit = (fields: { title?: string; description?: string }) => {
    const next = {
      title: fields.title ?? pushed.current.title,
      description: fields.description ?? pushed.current.description,
    };
    pushed.current = next;
    if (fields.title !== undefined) setTitle(fields.title);
    if (fields.description !== undefined) setDescription(fields.description);
    owner.getState().editDraft(draftId, fields);
  };

  const onSnapshot = useCallback(
    (snapshot: EditorSnapshot) => {
      const held = token.current;

      if (held === null) return;

      owner.getState().snapshotAccepted(held, snapshot);
      // The editor answered, so whatever it refused before is no longer the latest word on it.
      setLastRejection(null);
    },
    [owner],
  );

  const destination = draft.destination;
  const name = nameOf(destination);
  const hasRemainder =
    draft.state === 'created' &&
    (draft.title !== '' ||
      draft.description !== '' ||
      JSON.stringify(draft.document) !== EMPTY_DOCUMENT_JSON);

  const view = composerView({
    standing,
    protection,
    lastRejection,
    saving,
    /**
     * Whether there is anything to save.
     *
     * The description is compared against empty rather than trimmed, because whitespace someone
     * typed is authored data and `freezeNoteRequest` sends it unchanged - a note whose content is a
     * whitespace-only description is a note this gate must not make unsavable.
     *
     * The title is the one field that *is* trimmed here, and for the opposite reason: a
     * whitespace-only title is omitted from the request entirely, so it is not content and cannot
     * be the only thing standing between a draft and a Save that core would refuse for having
     * nothing to name the note from.
     */
    hasContent:
      title.trim() !== '' ||
      description !== '' ||
      JSON.stringify(draft.document) !== EMPTY_DOCUMENT_JSON,
    hasDestination: destination !== null,
    revision: draft.serverRevision,
    hasRemainder,
  });

  /** What the bar offers, after the owner has answered. Never inferred from the button pressed. */
  const reportStanding = () => {
    const next = owner.getState().standingFor(draftId);

    if (next === null) return;

    if (next.kind === 'blocked' && next.reason === 'created') {
      // Reconciled. A first save closes to Home; a Retry that worked stays exactly where it is, so
      // the person sees the status flip rather than being moved somewhere by a background answer.
      return;
    }

    if (next.kind === 'save_replacing') {
      setOutcome({
        kind: 'refused',
        message:
          next.attempt.lastOutcome?.message ??
          'Your server refused this and created nothing. What you wrote is kept here.',
        detail: null,
        chooseDestination: isPlacementProblem(next.attempt.lastOutcome?.code ?? null),
      });

      return;
    }

    if (next.kind === 'retry' || (next.kind === 'blocked' && next.reason !== 'inconsistent')) {
      const attempt = next.attempt;
      // A refusal that answers a replay is reported as what it is - an answer about the replay -
      // and never as "nothing was created". The first dispatch may have committed before its own
      // answer was lost, and nothing since has said otherwise.
      const detail =
        attempt?.lastOutcome?.kind === 'rejected'
          ? `Your server refused the latest try: ${attempt.lastOutcome.message} That answers for the try, not for the first request.`
          : null;

      setOutcome({ kind: 'uncertain', message: '', detail, chooseDestination: false });
    }
  };

  const act = () => {
    if (session === null || transitioning.current) return;
    transitioning.current = true;

    void (async () => {
      try {
        await run(session);
      } finally {
        // Given back unless this screen is on its way out, so a refusal or an uncertainty leaves
        // the person able to press Close, open the picker, or try again.
        if (!leaving.current) transitioning.current = false;
      }
    })();
  };

  /** The action itself, so the admission latch above has one place to release. */
  const run = async (live: CaptureSession) => {
    setOutcome(null);

    if (view.action.kind === 'save') {
      const result = await owner.getState().save(draftId, live);

      if (result.kind === 'not_saved') {
        setOutcome({
          kind: 'refused',
          message: result.problem,
          detail: null,
          chooseDestination: result.reason === 'no_destination',
        });

        return;
      }

      const next = owner.getState().standingFor(draftId);

      if (next?.kind === 'blocked' && next.reason === 'created') {
        // Persisted, then presented. Home shows the receipt and spends it there; leaving before
        // it was written would be a success nobody could be told about.
        leaving.current = true;
        openHome();

        return;
      }

      reportStanding();

      return;
    }

    if (view.action.kind === 'retry') {
      const result = await owner.getState().retry(draftId, live);

      if (result.kind === 'refused') {
        setOutcome({
          kind: 'uncertain',
          message: '',
          detail: result.problem,
          chooseDestination: false,
        });

        return;
      }

      reportStanding();

      return;
    }

    if (view.action.kind === 'record_again') {
      const attemptId = standing?.kind === 'record_again' ? standing.attempt.attemptId : null;

      if (attemptId === null) return;

      const result = await owner.getState().saveAcknowledgement(attemptId);

      if (result.kind === 'refused') {
        setOutcome({
          kind: 'refused',
          message: result.problem,
          detail: null,
          chooseDestination: false,
        });
      }
    }
  };

  /**
   * Android's own Back is the same exit, not a shortcut past it.
   *
   * A system back that unmounted the route would destroy the renderer without a locked flush, which
   * is exactly the moment writing that exists only in the editor would be lost. It is intercepted
   * and runs the controlled exit instead. iOS's swipe-back is turned off for this route in the
   * navigator, for the same reason and because there is nothing to intercept there.
   */
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      // eslint-disable-next-line no-use-before-define -- defined below, called only from the event
      close();

      return true;
    });

    return () => {
      subscription.remove();
    };
  });

  /**
   * Leaving, under a lock.
   *
   * The flush is taken with the editor locked and the lock is kept until the route actually goes, so
   * "this snapshot is the last word" is true at the moment the renderer is destroyed. A flush that
   * did not land does not leave: the sheet opens over a live editor, which is the only place the
   * writing exists.
   */
  const close = () => {
    if (transitioning.current) return;
    transitioning.current = true;

    void (async () => {
      const { result, release } = await owner.getState().beginControlledExit(draftId);

      if (result.kind === 'flushed') {
        // The lock is handed to the unmount: `detachEditor` drops it with the renderer. The
        // transition latch is deliberately not released: this screen is leaving.
        leaving.current = true;
        goBack();

        return;
      }

      release();
      transitioning.current = false;
      setProtectProblem(problemFor(result));
    })();
  };

  const repair = () => {
    void (async () => {
      if (protectProblem === 'too_large') port.current?.send({ kind: 'undo' });

      const result = await owner.getState().flush(draftId);

      if (result.kind === 'flushed') setProtectProblem(null);
    })();
  };

  const discard = () => {
    void (async () => {
      const result = await owner.getState().discardDraft(draftId);

      if (result.kind === 'done') {
        setProtectProblem(null);
        leaving.current = true;
        openHome();
      }
    })();
  };

  const chooseDestination = (chosen: ContainerRef) => {
    if (session === null) return;

    void (async () => {
      const result = await owner.getState().selectDestination(draftId, chosen, session);

      closePicker();

      if (result.kind === 'refused') {
        // The container may well have been created; only recording where this note goes failed.
        setOutcome({
          kind: 'refused',
          message: result.problem,
          detail: null,
          chooseDestination: true,
        });
      }
    })();
  };

  /**
   * Opening the picker is a controlled transition, not a detour.
   *
   * The sheet takes the window while the editor stays mounted underneath it, so the same barrier
   * that protects a Back applies: lock, flush, and keep the lock until the sheet closes. A flush
   * that did not land does **not** open the sheet - the only copy of what is on screen is in the
   * renderer, and covering it with a sheet would hide both the unprotected status and the repair.
   */
  const openPicker = () => {
    if (transitioning.current) return;
    transitioning.current = true;

    void (async () => {
      const { result, release } = await owner.getState().beginControlledExit(draftId);

      if (result.kind !== 'flushed') {
        release();
        transitioning.current = false;
        setProtectProblem(problemFor(result));

        return;
      }

      pickerLock.current = release;
      setPickerSession((current) => current + 1);
      setPickerOpen(true);
    })();
  };

  /** Gives the editor back, whichever way the sheet was left, and admits the next transition. */
  const closePicker = () => {
    pickerLock.current?.();
    pickerLock.current = null;
    transitioning.current = false;
    setPickerOpen(false);
  };

  return (
    <>
      <CaptureView
        description={description}
        destinationLabel={name.chip}
        destinationSpoken={name.spoken}
        document={document}
        documentId={draftId}
        editorRef={port}
        onAction={act}
        onClose={close}
        onCommand={(command: EditorCommand) => {
          port.current?.send(command);
        }}
        onDescriptionChange={(value) => {
          edit({ description: value });
        }}
        onDestination={openPicker}
        onProblem={(problem) => {
          // Only the editor's own refusals say anything about whether native holds the document. A
          // handshake or envelope problem is about the bridge and has its own consequences.
          if (problem.stage === 'editor') setLastRejection(problem.code);
        }}
        onSelectionChange={setSelection}
        onSnapshot={onSnapshot}
        onTitleChange={(value) => {
          edit({ title: value });
        }}
        selection={selection}
        testID="capture-screen"
        title={title}
        view={view}
      />

      <DestinationSheet
        onClose={closePicker}
        onSelect={chooseDestination}
        selected={destination}
        sessionId={pickerSession}
        visible={pickerOpen}
      />

      <OutcomeSheet
        destination={name.leaf}
        detail={outcome?.detail ?? null}
        kind={outcome?.kind ?? 'refused'}
        message={outcome?.message ?? ''}
        onChooseDestination={
          outcome?.chooseDestination === true
            ? () => {
                setOutcome(null);
                openPicker();
              }
            : undefined
        }
        onClose={() => {
          setOutcome(null);
        }}
        onLookIn={
          destination === null
            ? undefined
            : () => {
                setOutcome(null);
                openContainer(destination);
              }
        }
        onRetry={
          standing?.kind === 'retry'
            ? () => {
                setOutcome(null);
                act();
              }
            : undefined
        }
        visible={outcome !== null}
      />

      {protectProblem === null ? null : (
        <ProtectSheet
          canUndo={selection.available.includes('undo')}
          // A save was sent and never answered, so discarding the writing keeps the record of the
          // question. The sheet says which of the two sentences applies rather than always saying
          // the stronger one, because a warning that is sometimes false is one nobody reads.
          hasUnresolvedEvidence={unresolved(standing)}
          onDiscard={discard}
          onKeepEditing={() => {
            setProtectProblem(null);
          }}
          onRepair={repair}
          problem={protectProblem}
          visible
        />
      )}
    </>
  );
}

/** Which repair a flush that did not land calls for. */
const problemFor = (result: FlushResult): ProtectionProblem => {
  if (result.kind === 'refused') return result.code === 'too_large' ? 'too_large' : 'failed_write';

  return result.kind === 'unanswered' ? 'unanswered' : 'failed_write';
};

/**
 * Whether this draft has a save that was sent and never answered.
 *
 * Read from the standing rather than from an attempt's state string, so the one thing that decides
 * what a record means stays the one thing that decides it.
 */
const unresolved = (standing: Standing | null): boolean =>
  standing?.kind === 'retry' ||
  (standing?.kind === 'blocked' &&
    (standing.reason === 'unresolved_ineligible' ||
      standing.reason === 'unresolved_unsendable' ||
      standing.reason === 'inconsistent'));

/** Refusals whose remedy is a different place, rather than a different title. */
const isPlacementProblem = (code: string | null): boolean =>
  code === 'slug_conflict' || code === 'invalid_parent';

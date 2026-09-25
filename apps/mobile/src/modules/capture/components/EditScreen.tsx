import { X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler } from 'react-native';

import {
  ComposerFrame,
  ComposerStatus,
  IconButton,
  SkeletonBlock,
  SkeletonGroup,
  confirmDiscard,
} from '../../../ui';
import {
  ancestorsOf,
  pathSegments,
  useContainerPath,
  useHierarchy,
} from '../../collections/hierarchy';
import type {
  EditorPort,
  EditorRejectionCode,
  EditorSelectionState,
  EditorSnapshot,
} from '../../editor';
import {
  archivedAlongside,
  briefOutcome,
  lifecycleView,
  outcomeSentence,
  readOnlyDetailsSubtitle,
  statusSentence,
  type LifecycleVerb,
  type LifecycleView,
} from '../../lifecycle';
import { goBack, openHome } from '../../navigation';
import { useBackgroundFlush } from '../client/background.ts';
import {
  useEditContentEpoch,
  useEditLifecycle,
  useEditLocation,
  useEditOwner,
} from '../client/edit-owner.ts';
import { useCaptureSession } from '../client/owner.ts';
import {
  problemFor,
  type ComposerStatus as StatusLine,
  type ProtectionProblem,
} from '../composer.ts';
import {
  EDIT_PROBLEM_COPY,
  MOVE_ROOT_LABEL,
  detailsChip,
  editComposerView,
  editKindWord,
  idLabelOf,
  lifecycleBesideKept,
  lifecycleNotSentSentence,
  moveControl,
  movedNotice,
  movedNoticeHolds,
} from '../edit-composer.ts';
import { isFatalEditorProblem, unavailableReasonOf } from '../edit-display.ts';
import type {
  EditLifecycle,
  EditLocation,
  EditOpenOutcome,
  LifecycleOutcome,
} from '../edit-owner.ts';
import { editKeyOf, type EditProblem } from '../edit-types.ts';
import type { AttachmentToken, CaptureSession } from '../owner.ts';
import { DetailsSheet } from './DetailsSheet';
import { EditView } from './EditView';
import { EntityUnavailable } from './EntityUnavailable';
import { MoveSheet } from './MoveSheet';
import { ProtectSheet } from './ProtectSheet';

export interface EditScreenProps {
  /** Null when the route parameter did not name an entity. */
  id: number | null;
}

/**
 * Opening something is editing it: one screen for notes, areas and projects alike.
 *
 * The composition, and deliberately only that. It opens the record through the owner, holds the
 * outcome, keeps the fields and the record in step, attaches a renderer and holds a lock across a
 * transition - the parts that cannot be exercised without a screen. Everything it *says* comes from
 * `edit-composer.ts` and everything it may do comes from the owner, so no screen can disagree with a
 * recovery card about what a record means.
 *
 * **It mounts no query for the entity it edits.** The owner's own Get is the read; the one query here
 * is the shared hierarchy, behind the eyebrow that names where this is filed - and that eyebrow is the
 * one Move control, opening the move sheet. There is no Save on an existing entity - autosave, and
 * the status line beside the close cross says where the writing stands.
 *
 * An archived entity opens read-only in the same layout, and the status line says why. Read-only is a
 * screen mode over the causes the owner holds, never a standing of the writing; the Archive toggle at
 * the end of the top bar is live in every standing.
 */
export function EditScreen({ id }: EditScreenProps) {
  const session = useCaptureSession();
  const open = useEditOwner((state) => state.open);
  const [outcome, setOutcome] = useState<EditOpenOutcome | null>(null);
  /** Bumped to re-open after a discard, so what follows is a fresh read rather than a stale record. */
  const [attempt, setAttempt] = useState(0);

  const connectionId = session?.connectionId ?? null;

  useEffect(() => {
    if (id === null || session === null) return;

    let live = true;

    setOutcome(null);
    void open(id, session).then((next) => {
      if (live) setOutcome(next);
    });

    return () => {
      live = false;
    };
    // The connection's identity is what re-opens this, not the session object: `resume` carries a
    // refreshed session to the record, and depending on the object would issue a Get per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [open, id, connectionId, attempt]);

  const reopen = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  if (id === null) {
    return (
      <EntityUnavailable onClose={openHome} state={{ kind: 'unreadable', reason: 'missing' }} />
    );
  }

  // No usable session is "ask again later", never "this cannot be opened": the entity is fine and
  // this phone simply could not ask about it yet.
  if (session === null) {
    return (
      <EntityUnavailable onClose={openHome} state={{ kind: 'unreadable', reason: 'retryable' }} />
    );
  }

  if (outcome === null) return <Opening />;

  if (outcome.kind === 'unavailable') {
    return (
      <EntityUnavailable
        onClose={openHome}
        state={{
          kind: 'unreadable',
          // A null failure is the app not having asked at all - no store, a session it has moved on
          // from, or a body it cannot open - and only the last of those is settled. Retryable is the
          // honest reading of the set, and the one that does not tell someone their note is gone.
          reason: outcome.failure === null ? 'retryable' : unavailableReasonOf(outcome.failure),
        }}
      />
    );
  }

  if (outcome.kind === 'unusable') {
    return <Retained editKey={outcome.editKey} onDiscarded={reopen} problem={outcome.problem} />;
  }

  return (
    <Opened
      editKey={outcome.editKey}
      initialLifecycle={outcome.lifecycle}
      initialLocation={outcome.location}
      key={outcome.editKey}
      nodeId={id}
      onDiscarded={reopen}
      session={session}
    />
  );
}

/**
 * What an archive or restore is doing, held above the composer's key.
 *
 * The composer remounts when the mode flips and when the owner adopts content under it, and both can
 * become due while an action is still running. What the action says belongs to the screen, not to one
 * mount of it, so it lives here.
 */
interface LifecycleSession {
  readonly view: LifecycleView | null;
  readonly readOnly: boolean;
  readonly pending: LifecycleVerb | null;
  /** The last action's outcome, until the next action or edit. */
  readonly said: StatusLine | null;
  /** The same outcome in a few words, when it failed, for beside a save status that outranks it. */
  readonly brief: string | null;
  begin(verb: LifecycleVerb): void;
  /** The action never started: the flush did not land, and the screen says that instead. */
  abandon(): void;
  /**
   * The action answered. `release` gives back the lock it took, and runs only once the screen has
   * rendered the answer - after any remount it made due, so no editable composer shows in between.
   */
  finish(verb: LifecycleVerb, outcome: LifecycleOutcome, release: () => void): void;
  /** An edit was made, so the last action's sentence no longer describes the screen. */
  clear(): void;
}

/** A not-sent reason or an outcome, as the one line the status shows after an action. */
const lifecycleLine = (
  verb: LifecycleVerb,
  outcome: LifecycleOutcome,
  nodeId: number,
): StatusLine | null => {
  if (outcome.kind === 'not_sent') {
    return { text: lifecycleNotSentSentence(verb, outcome.reason), tone: 'alert' };
  }

  const text = outcomeSentence(verb, outcome, nodeId);

  return text === null ? null : { text, tone: outcome.kind === 'done' ? 'quiet' : 'alert' };
};

/**
 * One opened record: its lifecycle, and the composer keyed on everything that must remount it.
 *
 * Keyed on the record, so the composer's own state - the fields, the captured document, the sheet -
 * belongs to one entity and cannot be carried into another. Keyed on the mode as well, because the
 * renderer reads whether it is editable only when it is created: remounting is how it becomes
 * read-only after Archive and editable after Restore or a move out. And keyed on the content epoch,
 * because a composer holds the document it first rendered, and content the owner adopted from the
 * server underneath it must be what the next keystroke is written against.
 *
 * **Never while an action runs.** An action holds the edit lock on the composer it started from, and
 * a remount would drop that lock and put an editable replacement on screen while the request is in the
 * air - writing typed there could be lost to the read-only remount the answer then makes. So the key
 * is held from the press, and whatever remount became due happens once the action has answered; the
 * lock is given back only after that render, to the composer then on screen or to nobody.
 */
function Opened({
  editKey,
  nodeId,
  initialLocation,
  initialLifecycle,
  session,
  onDiscarded,
}: {
  editKey: string;
  nodeId: number;
  initialLocation: EditLocation;
  initialLifecycle: EditLifecycle;
  session: CaptureSession;
  onDiscarded: () => void;
}) {
  const lifecycle = useEditLifecycle(editKey, initialLifecycle);
  const epoch = useEditContentEpoch(editKey);
  const [pending, setPending] = useState<LifecycleVerb | null>(null);
  const [said, setSaid] = useState<StatusLine | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  /** The composer key an action started under, held until it answers. */
  const [heldKey, setHeldKey] = useState<string | null>(null);
  /** An answered action's lock, given back once the answer has rendered. */
  const handedBack = useRef<(() => void) | null>(null);

  useEffect(() => {
    const release = handedBack.current;

    if (release === null) return;
    handedBack.current = null;
    release();
  });
  useEffect(
    () => () => {
      handedBack.current?.();
      handedBack.current = null;
    },
    [],
  );

  // An unknown lifecycle - a failed Get - stays editable over local content. The server remains the
  // authority, and refuses an update to anything archived.
  const view = lifecycle.kind === 'known' ? lifecycleView(nodeId, lifecycle.archiveCauses) : null;
  const readOnly = view !== null && view.standing !== 'active';
  const liveKey = `${editKey}:${readOnly ? 'read-only' : 'editable'}:${String(epoch)}`;

  const actions: LifecycleSession = {
    view,
    readOnly,
    pending,
    said,
    brief,
    begin: (verb) => {
      setSaid(null);
      setBrief(null);
      setPending(verb);
      setHeldKey(liveKey);
    },
    abandon: () => {
      setPending(null);
      setHeldKey(null);
    },
    finish: (verb, outcome, release) => {
      handedBack.current = release;
      setPending(null);
      setHeldKey(null);
      setSaid(lifecycleLine(verb, outcome, nodeId));
      setBrief(outcome.kind === 'done' ? null : briefOutcome(verb, outcome));
    },
    clear: () => {
      setSaid(null);
      setBrief(null);
    },
  };

  return (
    <Composer
      editKey={editKey}
      initialLocation={initialLocation}
      key={heldKey ?? liveKey}
      lifecycle={actions}
      onDiscarded={onDiscarded}
      session={session}
    />
  );
}

/** The read is in the air. The same frame, so nothing jumps when the answer lands. */
function Opening() {
  return (
    <ComposerFrame
      leading={<IconButton icon={X} label="Close" onPress={goBack} />}
      status={<ComposerStatus>Opening…</ComposerStatus>}
    >
      <SkeletonGroup className="gap-3 px-5 pt-2" label="Opening this">
        <SkeletonBlock height={32} width={240} />
        <SkeletonBlock height={20} width={180} />
        <SkeletonBlock height={220} />
      </SkeletonGroup>
    </ComposerFrame>
  );
}

/**
 * Changes this build cannot open, kept exactly as they are.
 *
 * There is no editor here and no repair: the row stays until someone deliberately throws it away. The
 * sentence is `EDIT_PROBLEM_COPY`'s, so this screen and the recovery card describe one row one way.
 */
function Retained({
  editKey,
  problem,
  onDiscarded,
}: {
  editKey: string;
  problem: EditProblem;
  onDiscarded: () => void;
}) {
  const discardChanges = useEditOwner((state) => state.discardChanges);

  const discard = () => {
    void confirmDiscard({
      title: 'Discard these changes?',
      message:
        'What was changed on this phone will be removed. What is on your server stays as it is.',
      keepLabel: 'Keep them',
    }).then((confirmed) => {
      if (!confirmed) return;

      void discardChanges(editKey).then((result) => {
        if (result.kind === 'done') onDiscarded();
      });
    });
  };

  return (
    <EntityUnavailable
      onClose={openHome}
      onDiscard={discard}
      state={{ kind: 'retained', sentence: EDIT_PROBLEM_COPY[problem] }}
    />
  );
}

/**
 * Where this is filed, named the way every other screen names a location.
 *
 * From the hierarchy while that is a current reading, and from the server's canonical path when it is
 * not. An **unknown** location - this open's Get did not answer - names nothing at all, which is a
 * different fact from a root-level container having no parent, and the two must never be confused: an
 * unreachable server would otherwise quietly claim a note lives at the root.
 *
 * This is the one read beside the owner's own Get, and it is the shared hierarchy query rather than a
 * query for the entity being edited.
 */
const useEntityLocation = (location: EditLocation): readonly string[] => {
  const tree = useHierarchy();
  const parentId = location.kind === 'known' ? location.parentId : null;
  const ancestors = ancestorsOf(tree.hierarchy, parentId);
  const namedHere = ancestors.length > 0 && !tree.isStale;
  const canonical = useContainerPath(namedHere || parentId === null ? null : parentId);

  if (location.kind === 'unknown') return [];
  if (parentId === null) return ['Areas'];

  return namedHere ? ancestors.map((step) => step.title) : pathSegments(canonical.data);
};

function Composer({
  editKey,
  initialLocation,
  lifecycle,
  session,
  onDiscarded,
}: {
  editKey: string;
  /** The open's answer, for the first render only. The owner's confirmed location follows it. */
  initialLocation: EditLocation;
  lifecycle: LifecycleSession;
  session: CaptureSession;
  onDiscarded: () => void;
}) {
  const owner = useEditOwner;
  const record = useEditOwner((state) =>
    state.edits.find((candidate) => editKeyOf(candidate.key) === editKey),
  );
  const protection = useEditOwner((state) => state.protection[editKey]);
  // Not read directly - a send or a check starting is exactly when a standing changes, and these
  // selectors are what make the memo below notice.
  const sending = useEditOwner((state) => state.sending);
  const checking = useEditOwner((state) => state.checking);
  const edits = useEditOwner((state) => state.edits);
  const standingFor = useEditOwner((state) => state.standingFor);
  const standing = useMemo(
    () => standingFor(editKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the records are what make it change
    [standingFor, editKey, edits, sending, checking],
  );

  const location = useEditLocation(editKey, initialLocation);
  const segments = useEntityLocation(location);

  const [title, setTitle] = useState(record?.content.title ?? '');
  const [description, setDescription] = useState(record?.content.description ?? '');
  const pushed = useRef({
    title: record?.content.title ?? '',
    description: record?.content.description ?? '',
  });
  const [document] = useState<unknown>(() => record?.content.document);
  const [selection, setSelection] = useState<EditorSelectionState>({ active: [], available: [] });
  /** The last thing the renderer refused, which tells a silent flush from a refused one. */
  const [lastRejection, setLastRejection] = useState<EditorRejectionCode | null>(null);
  const [protectProblem, setProtectProblem] = useState<ProtectionProblem | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** Bumped per opening, so the sheet seeds its drafts from that moment and from nothing since. */
  const [detailsSession, setDetailsSession] = useState(0);
  const [moveOpen, setMoveOpen] = useState(false);
  /** Bumped per opening of the move sheet, which seeds its selection from that moment. */
  const [moveSession, setMoveSession] = useState(0);
  const moveOpenings = useRef(0);
  /**
   * The move sheet opening that is the current transition, or null. A late answer closes the sheet
   * only if it belongs to the opening still on screen, never a sheet opened since.
   */
  const moveTransition = useRef<number | null>(null);
  /**
   * The last acknowledged move, said on the status line until the standing next changes.
   *
   * Dropped the first time the standing stops matching it, so it cannot come back if the record later
   * reads synced at the same revision again. The sheet's own lock is not a standing and leaves it be.
   * It holds where the entity went, not what that place was called: the name is read when the line is
   * drawn, from the same current reading the eyebrow draws.
   */
  const [movedTo, setMovedTo] = useState<{
    readonly parentId: number | null;
    readonly revision: number;
  } | null>(null);
  const [leaving, setLeaving] = useState(false);
  /**
   * The renderer reported something that leaves it holding nothing, before it ever answered.
   *
   * The qualification is the whole point. A fatal problem *at load* means there is no document on
   * screen, and an editor holding nothing over a body the server still holds intact is the one
   * arrangement where the next keystroke would send that emptiness over real content - through an
   * ordinary, revision-guarded write that nothing in this story would stop. Once the editor has
   * answered once, the same stages mean something else: a bridge that refused one oversized message,
   * with the writing still in the renderer, which is protection's question and the protect sheet's.
   * So this can only ever replace an editor that never loaded.
   */
  const [rendererFailed, setRendererFailed] = useState(false);
  const answered = useRef(false);

  const port = useRef<EditorPort>(null);
  const token = useRef<AttachmentToken | null>(null);
  /** Held while a sheet is open, so the lock taken for it is given back when it closes. */
  const sheetLock = useRef<(() => void) | null>(null);
  /** One controlled transition at a time, decided in the same turn as the press. See `CaptureScreen`. */
  const transitioning = useRef(false);

  useBackgroundFlush(
    useCallback(() => {
      void useEditOwner.getState().flush(editKey);
    }, [editKey]),
  );

  // The loop dispatches from a timer, so it needs the session this screen is working under now.
  useEffect(() => {
    owner.getState().resume(editKey, session);
  }, [owner, editKey, session]);

  /**
   * Adopt the record whenever it disagrees with what was last pushed into the owner.
   *
   * Ordinary typing never triggers this: the write lands with exactly the value that was pushed. A
   * rebase onto a newer server revision does, and the fields have to follow it rather than typing the
   * old text straight back in.
   */
  useEffect(() => {
    if (record === undefined) return;
    if (
      record.content.title === pushed.current.title &&
      record.content.description === pushed.current.description
    ) {
      return;
    }

    pushed.current = { title: record.content.title, description: record.content.description };
    setTitle(record.content.title);
    setDescription(record.content.description);
  }, [record]);

  useEffect(() => {
    if (movedTo !== null && (standing === null || !movedNoticeHolds(movedTo, standing))) {
      setMovedTo(null);
    }
  }, [movedTo, standing]);

  useEffect(() => {
    const live = port.current;

    if (live === null) return;

    const attached = owner.getState().attachEditor(editKey, live);
    token.current = attached;

    return () => {
      if (attached !== null) owner.getState().detachEditor(attached);
      token.current = null;
    };
  }, [owner, editKey]);

  /**
   * Android's own Back is the same exit, not a shortcut past it.
   *
   * A system back that unmounted the route would destroy the renderer without a locked flush, which is
   * exactly the moment writing that exists only in the editor would be lost. iOS's swipe-back is off
   * for this route in the navigator, for the same reason and because there is nothing to intercept.
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

  const onSnapshot = useCallback(
    (snapshot: EditorSnapshot) => {
      const held = token.current;

      answered.current = true;
      // The editor answered, so whatever it refused before is no longer the latest word on it.
      setLastRejection(null);
      if (held === null) return;

      owner.getState().snapshotAccepted(held, snapshot);
    },
    [owner],
  );

  /**
   * There is no editor on screen: the record went while this was mounted - discarded from elsewhere,
   * or a store that closed - or the renderer never loaded a document. Named once, because `close` and
   * the branch below have to agree about it exactly.
   */
  const noEditor = record === undefined || standing === null || rendererFailed;

  /**
   * Leaving, under a lock, and then waiting for the answer.
   *
   * The flush is taken with the editor locked and the lock is kept until the route actually goes, so
   * "this snapshot is the last word" is true at the moment the renderer is destroyed. Then `leave`
   * decides when going is allowed, and it resolves only once one of its three answers is true: the
   * writing is on the server, or it is known that it cannot get there right now. All three are
   * permission to go - what differs is what Recovery will say about it afterwards.
   *
   * Close is disabled throughout, because a control that silently does nothing is worse than one that
   * says it is unavailable. The status line is not touched here: the editor lock taken for the exit
   * is still held, so the view reads `locked`, and whatever the owner is doing - sending, checking,
   * or holding a verdict - is what the status says, exactly as it would if nobody were leaving.
   *
   * Defined above the branches that render no editor and reading the same condition, because
   * Android's Back runs this whatever is on screen. There is no writing to protect on an unavailable
   * screen, and a controlled exit over a record that is not there would take a lock, get nothing, and
   * set a repair sheet that branch never renders - a Back that silently does nothing.
   */
  const close = () => {
    if (noEditor) {
      goBack();

      return;
    }
    if (transitioning.current) return;
    transitioning.current = true;

    void (async () => {
      const { result, release } = await owner.getState().beginControlledExit(editKey);

      if (result.kind !== 'flushed') {
        release();
        transitioning.current = false;
        setProtectProblem(problemFor(result));

        return;
      }

      setLeaving(true);

      try {
        await owner.getState().leave(editKey);
      } finally {
        setLeaving(false);
      }

      // The lock is handed to the unmount: `detachEditor` drops it with the renderer. The transition
      // latch is deliberately not released - this screen is leaving.
      goBack();
    })();
  };

  // `noEditor` is the condition; the two clauses after it are the same facts spelled out, because
  // narrowing `record` and `standing` for everything below is what lets the rest of this read plainly.
  if (noEditor || record === undefined || standing === null) {
    return (
      <EntityUnavailable
        onClose={openHome}
        state={{
          kind: 'unreadable',
          // A renderer that never loaded is settled; a record that vanished is worth asking again.
          reason: rendererFailed ? 'unopenable' : 'retryable',
        }}
      />
    );
  }

  const view = editComposerView({
    standing,
    protection,
    lastRejection,
    nodeType: record.nodeType,
    kind: record.kind,
    moved: movedNotice(movedTo, location, segments.at(-1)),
  });

  const edit = (fields: { title?: string; description?: string }) => {
    const next = {
      title: fields.title ?? pushed.current.title,
      description: fields.description ?? pushed.current.description,
    };
    pushed.current = next;
    if (fields.title !== undefined) setTitle(fields.title);
    if (fields.description !== undefined) setDescription(fields.description);
    lifecycle.clear();
    owner.getState().editFields(editKey, fields);
  };

  /**
   * Archive and Restore take the same lock sequence as opening the move sheet: lock, flush, and act
   * only on writing that landed on this phone. The owner then sends what can be sent before the
   * request, pins its revision, and answers. The lock is always given back - harmlessly, if the
   * composer that took it was remounted meanwhile, since the unmount already dropped it.
   */
  const runLifecycle = (verb: LifecycleVerb) => {
    if (transitioning.current || lifecycle.pending !== null) return;
    transitioning.current = true;
    lifecycle.begin(verb);

    void (async () => {
      const { result, release } = await owner.getState().beginControlledExit(editKey);

      if (result.kind !== 'flushed') {
        release();
        transitioning.current = false;
        lifecycle.abandon();
        setProtectProblem(problemFor(result));

        return;
      }

      // The owner's actions always resolve; the lock is held until the answer has rendered.
      const outcome: LifecycleOutcome = await (verb === 'archive'
        ? owner.getState().archive(editKey)
        : owner.getState().restore(editKey));

      lifecycle.finish(verb, outcome, () => {
        release();
        transitioning.current = false;
      });
    })();
  };

  /**
   * What the status line says instead of the save status, or null to leave the save status standing.
   *
   * In order: the request running; then writing that is not on the server, which outranks everything
   * else a lifecycle action could say, because it is the one fact about this person's work that
   * nothing else on a read-only screen would show - so the save status stays, marked as archived
   * where it is, or, after a failed action, that action in a few words and that the writing is kept
   * here - short enough that neither is cut off; then what the last action
   * came to, in full; then, while archived, why nothing can change.
   * An outcome that claims to show what the server holds is therefore only ever said over a record
   * whose content is the server's.
   */
  const lifecycleStatus = ((): StatusLine | null => {
    const running = statusSentence(lifecycle.view, lifecycle.pending);

    if (lifecycle.pending !== null && running !== null) return { text: running, tone: 'quiet' };
    if (view.problem !== null || standing.kind !== 'synced') {
      // A failed action is still said, briefly and first, so it cannot pass in silence - unless the
      // writing is not even safe on this phone, which outranks everything, as it does everywhere.
      if (lifecycle.brief !== null && view.problem === null) {
        return { text: lifecycleBesideKept(lifecycle.brief), tone: 'alert' };
      }

      return lifecycle.readOnly
        ? { text: archivedAlongside(view.status.text), tone: view.status.tone }
        : null;
    }
    if (lifecycle.said !== null) return lifecycle.said;

    const why = lifecycle.readOnly ? statusSentence(lifecycle.view, null) : null;

    return why === null ? null : { text: why, tone: 'quiet' };
  })();

  const repair = () => {
    void (async () => {
      if (protectProblem === 'too_large') port.current?.send({ kind: 'undo' });

      const result = await owner.getState().flush(editKey);

      if (result.kind === 'flushed') setProtectProblem(null);
    })();
  };

  /** The conflict band's one action. No merge, no force, no save-as - and always confirmed. */
  const discard = () => {
    void confirmDiscard({
      title: 'Discard your changes?',
      message:
        'What you changed on this phone will be removed. What is on your server stays as it is.',
      keepLabel: 'Keep my changes',
    }).then((confirmed) => {
      if (!confirmed) return;

      void owner
        .getState()
        .discardChanges(editKey)
        .then((result) => {
          if (result.kind === 'done') onDiscarded();
        });
    });
  };

  /**
   * Opening the details sheet is a controlled transition, not a detour.
   *
   * The sheet takes the window while the editor stays mounted underneath it, so the same barrier that
   * protects a Back applies: lock, flush, and keep the lock until the sheet closes. A flush that did
   * not land does **not** open the sheet - the only copy of what is on screen is in the renderer, and
   * covering it would hide both the unprotected status and the repair.
   */
  const openDetails = () => {
    if (transitioning.current) return;
    transitioning.current = true;

    void (async () => {
      const { result, release } = await owner.getState().beginControlledExit(editKey);

      if (result.kind !== 'flushed') {
        release();
        transitioning.current = false;
        setProtectProblem(problemFor(result));

        return;
      }

      sheetLock.current = release;
      setDetailsSession((value) => value + 1);
      setDetailsOpen(true);
    })();
  };

  /**
   * Opening the move sheet is the same controlled transition as Details: lock, flush, and keep the lock
   * until the sheet closes. Writing that did not land does not open it, and a move would not be sent
   * over it anyway.
   */
  const openMove = () => {
    if (transitioning.current) return;
    transitioning.current = true;

    void (async () => {
      const { result, release } = await owner.getState().beginControlledExit(editKey);

      if (result.kind !== 'flushed') {
        release();
        transitioning.current = false;
        setProtectProblem(problemFor(result));

        return;
      }

      moveOpenings.current += 1;
      const opening = moveOpenings.current;

      sheetLock.current = release;
      moveTransition.current = opening;
      setMoveSession(opening);
      setMoveOpen(true);
    })();
  };

  /** Gives the editor back and admits the next transition, once, for the opening still on screen. */
  const closeMove = (opening: number | null = moveTransition.current) => {
    if (opening === null || moveTransition.current !== opening) return;

    moveTransition.current = null;
    sheetLock.current?.();
    sheetLock.current = null;
    transitioning.current = false;
    setMoveOpen(false);
  };

  /**
   * The owner moves; this only reads the answer.
   *
   * The location is the owner's to advance, and the eyebrow already follows it. The status line's
   * revision is the acknowledged record's own, never a guess: a server that had nothing to change
   * answers at the revision it held. On `unconfirmed` the location stays as it was, because this phone
   * does not know. A refusal or a move never sent stays in the sheet, which says why.
   */
  const move = async (destination: { readonly parentId: number | null }) => {
    const opening = moveTransition.current;
    const outcome = await owner.getState().move(editKey, destination);

    if (outcome.kind === 'refused' || outcome.kind === 'not_sent') return outcome;

    if (outcome.kind === 'moved') {
      const acknowledged = owner
        .getState()
        .edits.find((candidate) => editKeyOf(candidate.key) === editKey);

      if (acknowledged !== undefined) {
        setMovedTo({ parentId: outcome.parentId, revision: acknowledged.baseRevision });
      }
    }
    closeMove(opening);

    return outcome;
  };

  /** Gives the editor back, whichever way the sheet was left, and admits the next transition. */
  const closeDetails = () => {
    sheetLock.current?.();
    sheetLock.current = null;
    transitioning.current = false;
    setDetailsOpen(false);
  };

  return (
    <>
      <EditView
        description={description}
        details={detailsChip({
          nodeType: record.nodeType,
          kind: record.kind,
          slug: record.content.slug,
          tagCount: record.content.tags.length,
        })}
        document={document}
        documentId={editKey}
        editorRef={port}
        leaving={leaving}
        lifecycle={{
          view: lifecycle.view,
          busy: lifecycle.pending !== null,
          noun: editKindWord(record.nodeType, record.kind).toLowerCase(),
          status: lifecycleStatus,
          onArchive: () => {
            runLifecycle('archive');
          },
          onRestore: () => {
            runLifecycle('restore');
          },
        }}
        location={segments}
        move={(() => {
          const control = moveControl({
            locationKnown: location.kind === 'known',
            // Archived by a cause of its own, it cannot move until that is restored. Archived only
            // through a container above, moving somewhere active is exactly the way out.
            archivedDirectly: lifecycle.view?.standing === 'direct',
            locked: view.locked,
            leaving,
            moveInflight: record.inflight?.kind === 'move',
          });

          return control === null ? null : { ...control, onPress: openMove };
        })()}
        onClose={close}
        onCommand={(command) => {
          port.current?.send(command);
        }}
        onDescriptionChange={(value) => {
          edit({ description: value });
        }}
        onDetails={openDetails}
        onDiscard={discard}
        onProblem={(problem) => {
          // Only the editor's own refusals say anything about whether native holds the document. A
          // handshake or envelope problem is about the bridge and has its own consequences.
          if (problem.stage === 'editor') setLastRejection(problem.code);
          if (!answered.current && isFatalEditorProblem(problem)) setRendererFailed(true);
        }}
        onSelectionChange={setSelection}
        onSnapshot={onSnapshot}
        onTitleChange={(value) => {
          edit({ title: value });
        }}
        readOnly={lifecycle.readOnly}
        selection={selection}
        testID="edit-screen"
        title={title}
        view={view}
      />

      <DetailsSheet
        idLabel={idLabelOf(record.nodeType, record.kind)}
        sessionId={detailsSession}
        onClose={closeDetails}
        readOnly={
          lifecycle.readOnly && lifecycle.view !== null
            ? { subtitle: readOnlyDetailsSubtitle(lifecycle.view) }
            : null
        }
        onDone={(details) => {
          lifecycle.clear();
          // One write, not one per keystroke, so autosave can never send a half-typed ID.
          owner.getState().editFields(editKey, {
            ...(details.slug === null ? {} : { slug: details.slug }),
            tags: details.tags,
          });
          closeDetails();
        }}
        slug={record.content.slug}
        tags={record.content.tags}
        visible={detailsOpen}
      />

      {location.kind === 'known' ? (
        <MoveSheet
          currentName={segments.at(-1) ?? MOVE_ROOT_LABEL}
          entity={{
            id: record.key.nodeId,
            type: record.nodeType,
            kind: record.kind,
            slug: record.content.slug,
          }}
          onClose={() => {
            closeMove();
          }}
          onMove={move}
          parentId={location.parentId}
          sessionId={moveSession}
          visible={moveOpen}
        />
      ) : null}

      {protectProblem === null ? null : (
        <ProtectSheet
          canUndo={selection.available.includes('undo')}
          // An update was sent and never answered, so discarding the writing would throw away the
          // only local record of the question. The sheet says which sentence applies rather than
          // always saying the stronger one, because a warning that is sometimes false is one nobody
          // reads.
          hasUnresolvedEvidence={standing.kind === 'unconfirmed'}
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

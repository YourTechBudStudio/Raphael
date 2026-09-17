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
import { goBack, openHome } from '../../navigation';
import { useBackgroundFlush } from '../client/background.ts';
import { useEditOwner } from '../client/edit-owner.ts';
import { useCaptureSession } from '../client/owner.ts';
import { problemFor, type ProtectionProblem } from '../composer.ts';
import { EDIT_PROBLEM_COPY, detailsChip, editComposerView, idLabelOf } from '../edit-composer.ts';
import { isFatalEditorProblem, unavailableReasonOf } from '../edit-display.ts';
import type { EditLocation, EditOpenOutcome } from '../edit-owner.ts';
import { editKeyOf, type EditProblem } from '../edit-types.ts';
import type { AttachmentToken, CaptureSession } from '../owner.ts';
import { DetailsSheet } from './DetailsSheet';
import { EditView } from './EditView';
import { EntityUnavailable } from './EntityUnavailable';
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
 * is the shared hierarchy, behind the eyebrow that names where this is filed. There is no read-only
 * mode, no Save on an existing entity and nothing that offers to move one - autosave, and the status
 * line beside the close cross says where the writing stands.
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

  // Keyed on the record, so the composer's own state - the fields, the captured document, the sheet -
  // belongs to one entity and cannot be carried into another.
  return (
    <Composer
      editKey={outcome.editKey}
      key={outcome.editKey}
      location={outcome.location}
      onDiscarded={reopen}
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
  location,
  session,
  onDiscarded,
}: {
  editKey: string;
  location: EditLocation;
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
  /** Held while the details sheet is open, so the lock taken for it is given back when it closes. */
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
  });

  const edit = (fields: { title?: string; description?: string }) => {
    const next = {
      title: fields.title ?? pushed.current.title,
      description: fields.description ?? pushed.current.description,
    };
    pushed.current = next;
    if (fields.title !== undefined) setTitle(fields.title);
    if (fields.description !== undefined) setDescription(fields.description);
    owner.getState().editFields(editKey, fields);
  };

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
        location={segments}
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
        selection={selection}
        testID="edit-screen"
        title={title}
        view={view}
      />

      <DetailsSheet
        idLabel={idLabelOf(record.nodeType, record.kind)}
        sessionId={detailsSession}
        onClose={closeDetails}
        onDone={(details) => {
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

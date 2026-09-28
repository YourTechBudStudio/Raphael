import { retryable } from '@raphael/client';
import type { NodeEntity } from '@raphael/contracts/nodes';
import { X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';

import { asClientFailure, isNotFound } from '../../../infrastructure/query/failure';
import {
  ComposerFrame,
  ComposerStatus,
  IconButton,
  SkeletonBlock,
  SkeletonGroup,
  Snackbar,
} from '../../../ui';
import {
  ancestorsOf,
  pathSegments,
  useContainerPath,
  useHierarchy,
} from '../../collections/hierarchy';
import { useReachability } from '../../connection';
import type { EditorPort, EditorProblem, EditorSelectionState } from '../../editor';
import {
  archivedAlongside,
  failedActionSentence,
  lifecycleView,
  readOnlyDetailsSubtitle,
  statusSentence,
  useLifecycleAction,
  type LifecycleVerb,
} from '../../lifecycle';
import { goBack, openHome } from '../../navigation';
import { discardUnsent, keepMine, useNodeUnsent, writeEdit, type UnsentRow } from '../../unsent';
import { useMoveNode, useNode } from '../client/node.ts';
import { useRowWriting } from '../client/writing.ts';
import {
  MOVE_EYEBROW_HINT,
  MOVE_ROOT_LABEL,
  NOT_KEPT_STATUS,
  UNAVAILABLE_UNTIL_SAVED_HINT,
  detailsChip,
  editKindWord,
  editStatus,
  idLabelOf,
  type EditStanding,
  type StatusLine,
} from '../copy.ts';
import { DetailsSheet } from './DetailsSheet';
import { EditView } from './EditView';
import { EntityUnavailable } from './EntityUnavailable';
import { MoveSheet } from './MoveSheet';

export interface EditScreenProps {
  /** Null when the route parameter did not name an entity. */
  id: number | null;
}

/**
 * Opening something is editing it: one screen for notes, areas and projects alike.
 *
 * The entity comes from a fresh read; writing kept on the phone for it, when there is some, is what
 * the editor opens instead. Every change goes to that `unsent` row and the runner sends it.
 */
export function EditScreen({ id }: EditScreenProps) {
  const node = useNode(id);
  const row = useNodeUnsent(id);
  /** Bumped to remount the editor over what the server holds now. */
  const [epoch, setEpoch] = useState(0);
  const opened = useRef(false);
  const refetch = node.refetch;

  const reload = useCallback(() => {
    void refetch().then(() => {
      setEpoch((value) => value + 1);
    });
  }, [refetch]);

  if (id === null) return <EntityUnavailable onClose={openHome} reason="missing" />;

  const entity = node.data;

  if (entity === undefined) {
    if (!node.isError) return <Opening />;

    const failure = asClientFailure(node.error);

    return (
      <EntityUnavailable
        onClose={openHome}
        reason={
          failure !== null && isNotFound(failure)
            ? 'missing'
            : failure === null || retryable(failure)
              ? 'retryable'
              : 'unopenable'
        }
      />
    );
  }

  // Wait for the fresh read unless the phone's own writing is what opens.
  if (!opened.current && row === undefined && !node.isFetchedAfterMount && !node.isError) {
    return <Opening />;
  }
  opened.current = true;

  return (
    <Editor
      entity={entity}
      // The renderer reads whether it is editable once, so archiving remounts it.
      key={`${String(epoch)}:${entity.archived ? 'read-only' : 'editable'}`}
      onReload={reload}
      row={row}
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
 * Where this is filed: from the hierarchy while that is a current reading, else the server's path.
 */
const useLocation = (parentId: number | null): readonly string[] => {
  const tree = useHierarchy();
  const ancestors = ancestorsOf(tree.hierarchy, parentId);
  const namedHere = ancestors.length > 0 && !tree.isStale;
  const canonical = useContainerPath(namedHere || parentId === null ? null : parentId);

  if (parentId === null) return [MOVE_ROOT_LABEL];

  return namedHere ? ancestors.map((step) => step.title) : pathSegments(canonical.data);
};

const standingOf = (row: UnsentRow | undefined, online: boolean): EditStanding => {
  if (row === undefined) return { kind: 'saved' };
  if (row.status === 'conflict') return { kind: 'conflict' };
  if (row.status === 'refused') return { kind: 'refused', message: row.error ?? '' };
  if (!online) return { kind: 'offline' };

  return row.error === null ? { kind: 'saving' } : { kind: 'waiting' };
};

/** Fatal only before the editor has answered: then there is no document on screen at all. */
const isFatal = (problem: EditorProblem): boolean =>
  problem.stage === 'document' || problem.stage === 'handshake' || problem.stage === 'envelope';

const LIFECYCLE_ACTION: Record<LifecycleVerb, string> = {
  archive: 'Couldn’t archive',
  restore: 'Couldn’t restore',
};

function Editor({
  entity,
  row,
  onReload,
}: {
  entity: NodeEntity;
  row: UnsentRow | undefined;
  onReload: () => void;
}) {
  const port = useRef<EditorPort>(null);
  const online = useReachability((state) => state.online);
  const lifecycle = useLifecycleAction();
  const moveNode = useMoveNode();
  const location = useLocation(entity.parentId);

  // What opens: the phone's own writing when there is some, else the server's.
  const [title, setTitle] = useState(row?.title ?? entity.title);
  const [description, setDescription] = useState(row?.description ?? entity.description);
  // What Details committed is shown from here and flushed with the fields, so a write of it that did
  // not land is made again before Close rather than lost.
  const [slug, setSlug] = useState(row?.slug ?? entity.slug);
  const [tags, setTags] = useState(row?.tags ?? entity.tags);
  const writing = useRowWriting(
    (patch) => writeEdit(entity.id, patch),
    port,
    () => ({ title, description, slug, tags }),
  );
  const [document] = useState<unknown>(() => row?.body ?? entity.body.value);
  const [selection, setSelection] = useState<EditorSelectionState>({ active: [], available: [] });
  const [sheet, setSheet] = useState<'details' | 'move' | null>(null);
  const [sheetSession, setSheetSession] = useState(0);
  const [snack, setSnack] = useState<string | null>(null);
  const [rendererFailed, setRendererFailed] = useState(false);
  const answered = useRef(false);

  const view = lifecycleView(entity.id, entity.archiveCauses);
  const readOnly = view.standing !== 'active';
  const saved = row === undefined;
  const standing = standingOf(row, online);
  const pendingVerb: LifecycleVerb | null = lifecycle.pending
    ? view.canRestore
      ? 'restore'
      : 'archive'
    : null;

  const status = ((): StatusLine => {
    if (writing.failed) return NOT_KEPT_STATUS;

    const running = statusSentence(view, pendingVerb);
    const save = editStatus(standing);

    if (pendingVerb !== null && running !== null) return { text: running, tone: 'quiet' };
    if (!readOnly) return save;
    if (!saved) return { text: archivedAlongside(save.text), tone: save.tone };

    return { text: running ?? save.text, tone: 'quiet' };
  })();

  // Close waits for this phone, never for the server; writing that did not land here stays on screen.
  const close = () => {
    void writing.flush().then((ok) => {
      if (ok) goBack();
    });
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close();

      return true;
    });

    return () => {
      subscription.remove();
    };
  });

  const runLifecycle = (verb: LifecycleVerb) => {
    void lifecycle.run({ id: entity.id, revision: entity.revision, verb }).then((failure) => {
      if (failure === null) return;

      setSnack(failedActionSentence(LIFECYCLE_ACTION[verb], failure));
      if (failure.code === 'revision_conflict') onReload();
    });
  };

  const move = async ({ parentId }: { readonly parentId: number | null }) => {
    try {
      await moveNode.mutateAsync({ id: entity.id, revision: entity.revision, parentId });
    } catch (error) {
      const failure = asClientFailure(error);

      setSnack(failedActionSentence('Couldn’t move', failure));
      if (failure?.code === 'revision_conflict') onReload();
    }
    setSheet(null);
  };

  if (rendererFailed) return <EntityUnavailable onClose={openHome} reason="unopenable" />;

  return (
    <View className="flex-1">
      <EditView
        archive={{
          view,
          busy: lifecycle.pending,
          unavailable: saved ? undefined : UNAVAILABLE_UNTIL_SAVED_HINT,
          noun: editKindWord(entity.type, entity.kind).toLowerCase(),
          onArchive: () => {
            runLifecycle('archive');
          },
          onRestore: () => {
            runLifecycle('restore');
          },
        }}
        conflict={
          row?.status === 'conflict'
            ? {
                onTakeServers: () => {
                  // This editor's writing is what was just discarded: nothing of it may be written
                  // again, including on its way out when the reload remounts it.
                  writing.abandon();
                  void discardUnsent(row.id).then(onReload);
                },
                onKeepMine: () => {
                  void keepMine(row.id).then((kept) => {
                    if (!kept) setSnack(failedActionSentence('Couldn’t keep yours', null));
                  });
                },
              }
            : null
        }
        description={description}
        details={detailsChip({
          nodeType: entity.type,
          kind: entity.kind,
          slug,
          tagCount: tags.length,
        })}
        document={document}
        documentId={String(entity.id)}
        editorRef={port}
        location={location}
        // Archived by a cause of its own, it cannot move until that is restored.
        move={
          view.standing === 'direct'
            ? null
            : {
                disabled: !saved,
                hint: saved ? MOVE_EYEBROW_HINT : UNAVAILABLE_UNTIL_SAVED_HINT,
                onPress: () => {
                  setSheetSession((value) => value + 1);
                  setSheet('move');
                },
              }
        }
        onClose={close}
        onCommand={(command) => {
          port.current?.send(command);
        }}
        onDescriptionChange={(value) => {
          setDescription(value);
          writing.write({ description: value });
        }}
        onDetails={() => {
          setSheetSession((value) => value + 1);
          setSheet('details');
        }}
        onProblem={(problem) => {
          if (!answered.current && isFatal(problem)) setRendererFailed(true);
        }}
        onSelectionChange={setSelection}
        onSnapshot={(snapshot) => {
          answered.current = true;
          writing.onSnapshot(snapshot);
        }}
        onTitleChange={(value) => {
          setTitle(value);
          writing.write({ title: value });
        }}
        readOnly={readOnly}
        selection={selection}
        status={status}
        testID="edit-screen"
        title={title}
      />

      <DetailsSheet
        idLabel={idLabelOf(entity.type, entity.kind)}
        onClose={() => {
          setSheet(null);
        }}
        // Written once, on Done, so autosave never sends a half-typed ID.
        onDone={(details) => {
          if (details.slug !== null) setSlug(details.slug);
          setTags(details.tags);
          writing.write({
            ...(details.slug === null ? {} : { slug: details.slug }),
            tags: details.tags,
          });
          setSheet(null);
        }}
        readOnly={readOnly ? { subtitle: readOnlyDetailsSubtitle(view) } : null}
        sessionId={sheetSession}
        slug={slug}
        tags={tags}
        visible={sheet === 'details'}
      />

      <MoveSheet
        currentName={location.at(-1) ?? MOVE_ROOT_LABEL}
        entity={{ id: entity.id, type: entity.type, kind: entity.kind }}
        onClose={() => {
          setSheet(null);
        }}
        onMove={move}
        parentId={entity.parentId}
        sessionId={sheetSession}
        visible={sheet === 'move'}
      />

      <Snackbar
        message={snack}
        onHidden={() => {
          setSnack(null);
        }}
      />
    </View>
  );
}

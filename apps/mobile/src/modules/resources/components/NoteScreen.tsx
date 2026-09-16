import { useState } from 'react';

// The hierarchy facade, not the collections index: that index publishes the Area and Project
// screens, which render this capability's note sections, and importing it here would make the two
// modules mutually dependent for the sake of reading some titles.
import {
  ancestorsOf,
  pathSegments,
  useContainerPath,
  useHierarchy,
} from '../../collections/hierarchy';
import { isFatalEditorProblem, noteViewState } from '../client/display';
import { useResource } from '../client/notes';
import { NoteView } from './NoteView';

export interface NoteScreenProps {
  /** Null when the route parameter did not name a note. */
  id: number | null;
  onClose: () => void;
}

/**
 * One saved note: the read, the naming of where it is filed, and the decision about whether it can
 * be shown at all. `NoteView` draws whichever of those answers came back.
 */
export function NoteScreen({ id, onClose }: NoteScreenProps) {
  const note = useResource(id);
  const tree = useHierarchy();
  const [rendererFailed, setRendererFailed] = useState(false);

  const entity = note.data;
  const parentId = entity?.parentId ?? null;

  // Where it is filed, named the way every other screen names a location: from the hierarchy while
  // that is a current reading, and from the server's canonical path when it is not. One read for one
  // open note - not the per-card request a grid would need, which is why a card falls back to a kind
  // label instead of asking.
  const ancestors = ancestorsOf(tree.hierarchy, parentId);
  const namedHere = ancestors.length > 0 && !tree.isStale;
  const canonical = useContainerPath(namedHere || parentId === null ? null : parentId);
  const location = namedHere ? ancestors.map((step) => step.title) : pathSegments(canonical.data);

  const state = noteViewState({
    id,
    isError: note.isError,
    error: note.error,
    entity,
    rendererFailed,
  });

  return (
    <NoteView
      location={location}
      onClose={onClose}
      onProblem={(problem) => {
        if (isFatalEditorProblem(problem)) setRendererFailed(true);
      }}
      state={state}
    />
  );
}

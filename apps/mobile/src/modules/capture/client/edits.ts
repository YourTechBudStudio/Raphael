/**
 * The edit owner's records, as the screens that draw them need them.
 *
 * `notes.ts` for edits: a selector plus a memo over the pure projection in `../edit-unfinished.ts`.
 * Nothing here decides anything - `standingFor` is passed through, so the one authority on what a
 * record means stays the owner.
 */

import { useCallback, useMemo } from 'react';

import { openEditor } from '../../navigation';
import { unfinishedEdits, type UnfinishedEdit } from '../edit-unfinished.ts';
import { useEditOwner } from './edit-owner.ts';
import { useCaptureSession } from './owner.ts';

/** Every edit on this phone the server has not been given, most pressing first. */
export const useUnfinishedEdits = (): readonly UnfinishedEdit[] => {
  const edits = useEditOwner((state) => state.edits);
  const unusableEdits = useEditOwner((state) => state.unusableEdits);
  // Not read by the projection, which takes the standing itself - but a send starting or ending is
  // exactly when a standing changes, and the selector is what makes the memo notice.
  const sending = useEditOwner((state) => state.sending);
  const standingFor = useEditOwner((state) => state.standingFor);
  const session = useCaptureSession();
  const connectionId = session?.connectionId ?? null;

  return useMemo(
    () => unfinishedEdits({ edits, unusableEdits, standingFor, connectionId }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `sending` is a recomputation trigger.
    [edits, unusableEdits, sending, standingFor, connectionId],
  );
};

/** What a card may do with one edit. Discarding is confirmed by the surface, never here. */
export const useEditActions = (): {
  readonly open: (nodeId: number) => void;
  readonly discard: (editKey: string) => void;
} => {
  const discardChanges = useEditOwner((state) => state.discardChanges);

  return {
    open: useCallback((nodeId: number) => {
      openEditor(nodeId);
    }, []),
    discard: useCallback(
      (editKey: string) => {
        void discardChanges(editKey);
      },
      [discardChanges],
    ),
  };
};

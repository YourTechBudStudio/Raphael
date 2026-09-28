/**
 * Creating an area or a project: a draft row in `unsent`, written as the person types, and Save.
 *
 * The same mechanism as a note. Closing the sheet keeps anything written as a draft in Unfinished,
 * and a Save that cannot reach the server keeps trying from there.
 */

import type { ContainerType } from '@raphael/contracts/nodes';
import { useCallback, useRef, useState } from 'react';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import {
  createProblem,
  leaveDraft,
  saveDraft,
  startDraft,
  useUnsentRow,
  writeDraft,
  type CreateProblem,
  type UnsentRow,
} from '../../unsent';

/** How long Save waits for the server before saying it will keep trying. */
const SAVE_WAIT_MS = 10_000;

export type ContainerSaveOutcome =
  | { readonly kind: 'created'; readonly container: ContainerRef }
  /** Nothing to do: the row now says why (a refusal, a retry, or what is missing). */
  | { readonly kind: 'kept' }
  | { readonly kind: 'unwritable' };

export interface ContainerDraft {
  /** Undefined until the first write makes the draft row. */
  readonly row: UnsentRow | undefined;
  readonly problem: CreateProblem | null;
  readonly saving: boolean;
  readonly write: (patch: Fields) => void;
  /** Writes what is on screen, then saves. */
  readonly save: (onScreen: Fields) => Promise<ContainerSaveOutcome>;
  /**
   * Writes what is on screen, then drops the draft if there is nothing in it. `unwritable` means
   * what is on screen did not reach this phone, so the sheet must stay open.
   */
  readonly leave: (onScreen: Fields) => Promise<'kept' | 'dropped' | 'unwritable'>;
}

export interface Fields {
  readonly title?: string;
  readonly description?: string;
}

export interface ContainerDraftInput {
  /** A kept draft to reopen, or null to start one. */
  readonly draftId: string | null;
  readonly containerType: ContainerType;
  /** Null is the top level, which holds only areas. */
  readonly parentAreaId: number | null;
}

export const useContainerDraft = ({
  draftId,
  containerType,
  parentAreaId,
}: ContainerDraftInput): ContainerDraft => {
  const [id, setId] = useState<string | null>(draftId);
  const [saving, setSaving] = useState(false);
  const started = useRef<Promise<string | null> | null>(
    draftId === null ? null : Promise.resolve(draftId),
  );
  const row = useUnsentRow(id ?? '');

  // The row is made by the first write, so opening and closing an empty sheet leaves nothing behind.
  const ensure = useCallback((): Promise<string | null> => {
    started.current ??= startDraft({
      nodeType: containerType,
      kind: null,
      destination: parentAreaId === null ? { root: true } : { type: 'area', id: parentAreaId },
    }).then((created) => {
      setId(created);

      return created;
    });

    return started.current;
  }, [containerType, parentAreaId]);

  const write = useCallback(
    (patch: Fields) => {
      void ensure().then((live) => (live === null ? false : writeDraft(live, patch)));
    },
    [ensure],
  );

  /** Writes are run in order, so this one landing means every earlier one did too. */
  const writeOnScreen = useCallback(
    async (onScreen: Fields): Promise<string | null> => {
      const live = await ensure();

      return live !== null && (await writeDraft(live, onScreen)) ? live : null;
    },
    [ensure],
  );

  const save = useCallback(
    async (onScreen: Fields): Promise<ContainerSaveOutcome> => {
      const live = await writeOnScreen(onScreen);

      if (live === null) return { kind: 'unwritable' };
      setSaving(true);

      try {
        const result = await Promise.race([
          saveDraft(live),
          new Promise<null>((done) => setTimeout(() => done(null), SAVE_WAIT_MS)),
        ]);

        if (result?.kind === 'unwritable') return { kind: 'unwritable' };

        const entity = result?.kind === 'sent' ? result.entity : null;

        return entity !== null && (entity.type === 'area' || entity.type === 'project')
          ? { kind: 'created', container: { type: entity.type, id: entity.id } }
          : { kind: 'kept' };
      } finally {
        setSaving(false);
      }
    },
    [writeOnScreen],
  );

  const leave = useCallback(
    async (onScreen: Fields): Promise<'kept' | 'dropped' | 'unwritable'> => {
      const typed = (onScreen.title ?? '').trim() !== '' || (onScreen.description ?? '') !== '';

      // Nothing was ever written and nothing is on screen: there is no row to keep or drop.
      if (started.current === null && !typed) return 'dropped';

      const live = await writeOnScreen(onScreen);

      if (live === null) return 'unwritable';

      return (await leaveDraft(live)) ? 'kept' : 'dropped';
    },
    [writeOnScreen],
  );

  return {
    row,
    problem: row === undefined ? 'writing' : createProblem(row),
    saving,
    write,
    save,
    leave,
  };
};

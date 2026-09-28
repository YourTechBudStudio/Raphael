import { addFavorite, removeFavorite } from '@raphael/client/nodes';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';

import { asClientFailure, unwrap } from '../../../infrastructure/query/failure';
import { invalidateActivation } from '../../../infrastructure/query/invalidate';
import { scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';
import { failedActionSentence } from '../../lifecycle/copy.ts';

/**
 * The favorite star: an optimistic add or remove, then a re-read of everything.
 *
 * The star shows the wanted state while the write and its re-read are running, so it does not
 * flicker back before the new reads land. A failure puts it back and says why in one sentence.
 */

const FAVORITE_WRITE = 'favorite-write';

/** One node's favorite state as a read reported it. */
export interface FavoriteRead {
  readonly id: number;
  readonly isFavorite: boolean;
}

export interface FavoriteToggle {
  /** The wanted state while a write for this id is running, else the read. */
  isFavorite(read: FavoriteRead): boolean;
  isBusy(id: number): boolean;
  /** Sends the opposite of `isFavorite(read)`. Does nothing while busy. */
  toggle(read: FavoriteRead): void;
  /** This instance's last failure, for a snackbar, until `dismiss` or the next write. */
  readonly failureMessage: string | null;
  readonly dismiss: () => void;
}

interface FavoriteInput {
  readonly id: number;
  readonly wanted: boolean;
}

export function useFavoriteToggle(): FavoriteToggle {
  const session = useConnectionSession();
  const client = useQueryClient();
  const activation = session?.activation ?? -1;
  const writeKey = scopeKey(activation, FAVORITE_WRITE);

  // Every running write, so every star for one id agrees whichever control sent it.
  const pending = useMutationState({
    filters: { mutationKey: writeKey, status: 'pending' },
    select: (mutation) => mutation.state.variables as FavoriteInput,
  });

  const mutation = useMutation({
    mutationKey: writeKey,
    mutationFn: async ({ id, wanted }: FavoriteInput) => {
      if (session === null) throw new Error('No connection');

      const request = { target: { id } };

      return unwrap<{ readonly nodeId: number; readonly isFavorite: boolean }>(
        wanted
          ? await addFavorite(session.transport, request)
          : await removeFavorite(session.transport, request),
      );
    },
    // Every read carries `isFavorite`, so the whole activation is re-read. Awaited, so the star keeps
    // the wanted state until the reads that replace it have landed.
    onSettled: () => invalidateActivation(client, activation),
  });

  const intentFor = (id: number): FavoriteInput | undefined =>
    pending.findLast((input) => input.id === id);

  const isFavorite = (read: FavoriteRead): boolean => intentFor(read.id)?.wanted ?? read.isFavorite;

  const isBusy = (id: number): boolean => intentFor(id) !== undefined;

  return {
    isFavorite,
    isBusy,
    toggle: (read) => {
      if (isBusy(read.id)) return;

      mutation.mutate({ id: read.id, wanted: !isFavorite(read) });
    },
    failureMessage:
      mutation.error === null
        ? null
        : failedActionSentence(
            mutation.variables?.wanted === false
              ? 'Couldn’t remove from favorites'
              : 'Couldn’t add to favorites',
            asClientFailure(mutation.error),
          ),
    dismiss: mutation.reset,
  };
}

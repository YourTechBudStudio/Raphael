import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { localContent } from '../../../infrastructure/api';
import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';

/**
 * Starring, in one place, so the star behaves the same on Home as it does on a project.
 *
 * A favorite is a reference and nothing else: a type and the server's numeric id. It never holds a
 * copy of the container's title, so a rename on the server shows up here immediately and a stored
 * star can never disagree with the hierarchy about what it points at. Resolving a reference to
 * something displayable is the caller's job, from the hierarchy.
 *
 * Favorites are session-only and scoped to the connection. Two servers can both have a container 3,
 * and a star against one of them must never appear against the other.
 */

const FAVORITES = 'favorites';

const refKey = (ref: ContainerRef): string => `${ref.type}:${String(ref.id)}`;

const has = (refs: readonly ContainerRef[], key: string): boolean =>
  refs.some((ref) => refKey(ref) === key);

export function useFavorites() {
  const session = useConnectionSession();
  const connectionId = session?.connection.connectionId ?? null;

  return useQuery({
    queryKey: scopeKey(session?.activation ?? -1, FAVORITES),
    queryFn: (): Promise<ContainerRef[]> => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.getFavorites(connectionId);
    },
    enabled: connectionId !== null,
  });
}

export interface FavoriteToggle {
  /** True when this container is starred, counting a tap that has not been written yet. */
  isFavorite: (ref: ContainerRef) => boolean;
  toggle: (ref: ContainerRef) => void;
  /** True when the last write failed, so the screen can say the star did not stick. */
  isError: boolean;
}

/**
 * The store is the truth, but it takes a moment to answer, and a star that waits for the write
 * feels broken next to the pop it fires. So a tap is remembered as an intent and shown straight
 * away; the intent is dropped as soon as the stored list agrees with it, or when the write fails,
 * at which point the star returns to the truth and `isError` gives the screen something honest to
 * say.
 */
export function useFavoriteToggle(): FavoriteToggle {
  const session = useConnectionSession();
  const connectionId = session?.connection.connectionId ?? null;
  const client = useQueryClient();
  const favorites = useFavorites();
  const [intents, setIntents] = useState<Record<string, boolean>>({});

  const stored = favorites.data;

  const mutation = useMutation({
    mutationFn: (ref: ContainerRef) => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.toggleFavorite(connectionId, ref);
    },
    onSuccess: () => {
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[2] === FAVORITES,
      });
    },
  });

  // An intent only stands until the stored list catches up with it.
  useEffect(() => {
    if (stored === undefined) return;

    setIntents((current) => {
      const remaining = Object.fromEntries(
        Object.entries(current).filter(([key, wanted]) => wanted !== has(stored, key)),
      );

      return Object.keys(remaining).length === Object.keys(current).length ? current : remaining;
    });
  }, [stored]);

  const isFavorite = (ref: ContainerRef): boolean =>
    intents[refKey(ref)] ?? has(stored ?? [], refKey(ref));

  const toggle = (ref: ContainerRef): void => {
    const key = refKey(ref);
    const next = !isFavorite(ref);

    setIntents((current) => ({ ...current, [key]: next }));

    mutation.mutate(ref, {
      onError: () => {
        setIntents(({ [key]: _failed, ...rest }) => rest);
      },
    });
  };

  return { isFavorite, toggle, isError: mutation.isError };
}

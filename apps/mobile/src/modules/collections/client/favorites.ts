import { useEffect, useState } from 'react';

import type { Collection, FavoriteRef } from '../../../infrastructure/api/contracts';
import { useFavorites, useToggleFavorite } from './queries';

const refKey = (ref: FavoriteRef): string => `${ref.type}:${ref.id}`;

const storedHas = (collections: readonly Collection[], key: string): boolean =>
  collections.some((collection) => refKey(collection) === key);

export interface FavoriteToggle {
  /** True when this collection is starred, counting a tap that has not been written yet. */
  isFavorite: (ref: FavoriteRef) => boolean;
  toggle: (ref: FavoriteRef) => void;
  /** True when the last write failed, so the screen can say the star did not stick. */
  isError: boolean;
}

/**
 * Starring, in one place, so the star behaves the same on Home as it does on a project.
 *
 * The repository is the truth, but it takes a moment to answer, and a star that waits for the
 * write feels broken next to the pop it fires. So a tap is remembered as an intent and shown
 * straight away; the intent is dropped as soon as the stored list agrees with it, or when the
 * write fails, at which point the star returns to the truth and `isError` gives the screen
 * something honest to say.
 */
export function useFavoriteToggle(): FavoriteToggle {
  const favorites = useFavorites();
  const mutation = useToggleFavorite();
  const [intents, setIntents] = useState<Record<string, boolean>>({});

  const collections = favorites.data;

  // An intent only stands until the stored list catches up with it.
  useEffect(() => {
    if (collections === undefined) {
      return;
    }

    setIntents((current) => {
      const remaining = Object.fromEntries(
        Object.entries(current).filter(([key, wanted]) => wanted !== storedHas(collections, key)),
      );

      return Object.keys(remaining).length === Object.keys(current).length ? current : remaining;
    });
  }, [collections]);

  const isFavorite = (ref: FavoriteRef): boolean =>
    intents[refKey(ref)] ?? storedHas(collections ?? [], refKey(ref));

  const toggle = (ref: FavoriteRef): void => {
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

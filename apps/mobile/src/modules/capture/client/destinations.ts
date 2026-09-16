/**
 * Naming where a note is going, or declining to.
 *
 * A destination is stored as `{type, id}` and nothing else - never a copied title - so every screen
 * that wants to say where a note goes has to look it up. The rule is the one `collections` already
 * applies to cards: a title is offered only from a hierarchy that has loaded **and is current**. A
 * hierarchy retained after a failed refresh was true when it was read and may not be now, and a chip
 * has nowhere to say which of those it is showing.
 *
 * Declining is not deletion. A destination nobody can name right now is still chosen, and the chip
 * says so rather than reverting to "Where?", which would invite someone to pick again.
 */

import { useCallback } from 'react';

import { ancestorsOf, useHierarchy } from '../../collections';
import type { Destination } from '../types.ts';

export interface DestinationName {
  /** `parent / leaf`, with a leading ellipsis when the path is deeper. Null when nothing is chosen. */
  readonly chip: string | null;
  /** The whole path, for the accessible label. Null when nothing is chosen. */
  readonly spoken: string | null;
  /** Just the leaf, for a sentence like "Look in <leaf>". Null when it cannot be named. */
  readonly leaf: string | null;
}

const NOT_NAMEABLE: DestinationName = {
  chip: 'Chosen place',
  spoken: 'Where this note goes, which your server has not named here yet',
  leaf: null,
};

const NOTHING_CHOSEN: DestinationName = { chip: null, spoken: null, leaf: null };

export const useDestinationName = (): ((destination: Destination | null) => DestinationName) => {
  const tree = useHierarchy();
  const hierarchy = tree.hierarchy;
  const stale = tree.isStale;

  return useCallback(
    (destination) => {
      if (destination === null) return NOTHING_CHOSEN;
      if (hierarchy === undefined || stale) return NOT_NAMEABLE;

      const path = ancestorsOf(hierarchy, destination.id).map((node) => node.title);

      if (path.length === 0) return NOT_NAMEABLE;

      const tail = path.slice(-2).join(' / ');

      return {
        chip: path.length > 2 ? `… / ${tail}` : tail,
        spoken: path.join(' / '),
        leaf: path[path.length - 1] ?? null,
      };
    },
    [hierarchy, stale],
  );
};

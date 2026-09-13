import type { EmblemName } from './Emblem';

/**
 * Which mark stands for a container.
 *
 * The server has no such field and is not being asked for one: an emblem is decoration, it would
 * have to be authored by somebody if it were stored, and nothing in the product asks anyone to
 * choose one. So it is derived, here, from facts the container already has.
 *
 * Derived rather than random, because the same project has to look the same on Home, in a tile, in
 * the Browse tree, and in search results - a mark that changed between two screens would read as
 * two different things. Nothing persists the result and nothing compares one to another; this is
 * presentation, and it is shared so the four places that draw a container cannot drift apart.
 */
export const emblemFor = (type: 'area' | 'project', id: number): EmblemName => {
  if (type === 'area') return 'layers';

  return id % 2 === 0 ? 'petals' : 'arch';
};

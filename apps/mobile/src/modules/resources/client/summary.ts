/**
 * What a note card needs, and nothing a server summary does not already carry.
 *
 * The shape matters because the one it replaced was a different thing wearing the same word. The
 * session-only `Resource` had a string id, a `summary` that was a slice of the body, a `createdAt`
 * this app invented and a `parent` reference it stored. A server summary has a numeric id the server
 * minted, a `description` the author wrote, a revision, a parent id, and **no body and no timestamp**
 * - so there is nothing here to make an excerpt or a "2 h ago" line out of, and nothing pretends
 * otherwise.
 */

import type { NodeSummary } from '@raphael/contracts/nodes';

export interface NoteSummaryItem {
  readonly id: number;
  readonly title: string;
  /** The card's secondary line. The empty string when unset; never a body excerpt. */
  readonly description: string;
  readonly slug: string;
  readonly revision: number;
  /** The container the note sits in. Presentation looks its title up; nothing stores it. */
  readonly parentId: number;
}

/**
 * A note, or null for a summary that is not one.
 *
 * Three refusals, each for a thing that cannot be drawn honestly as a note card. A container is not a
 * note. A resource of some kind this build does not know is not a note, and drawing it as one would
 * be this client deciding that an unknown kind is close enough. And a resource with no parent cannot
 * exist - root holds only areas - so a response claiming one is a response to distrust rather than to
 * render with a missing location.
 *
 * Returning null rather than throwing is deliberate: one unrecognized row in a page of fifty is a row
 * to leave out, not a reason to tell someone their notes could not be loaded.
 */
export const toNoteSummaryItem = (summary: NodeSummary): NoteSummaryItem | null => {
  if (summary.type !== 'resource' || summary.kind !== 'note') return null;
  if (summary.parentId === null) return null;

  return {
    id: summary.id,
    title: summary.title,
    description: summary.description,
    slug: summary.slug,
    revision: summary.revision,
    parentId: summary.parentId,
  };
};

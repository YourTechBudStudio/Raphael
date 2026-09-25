/**
 * How the phone reads an entity's archive causes.
 *
 * Pure, and the one place a screen turns the server's cause list into what it can offer. Status is
 * never computed here: the server sends the causes that apply, nearest origin first, and this only
 * reads them - through the contracts' own helpers, so the phone and the CLI cannot disagree about
 * what "direct" or "can be restored" means.
 */

import {
  archiveStandingOf,
  hasDirectUserCause,
  type ArchiveCause,
  type ArchiveStanding,
} from '@raphael/contracts/nodes';

export interface LifecycleView {
  /** The entity the causes were read for. */
  readonly nodeId: number;
  /** As the server sent them, nearest origin first. Empty means active. */
  readonly causes: readonly ArchiveCause[];
  readonly standing: ArchiveStanding;
  /** The user's own direct cause is present, so pressing the toggle restores. */
  readonly canRestore: boolean;
  /**
   * The user's own direct cause is absent: active, archived only through a container above, or
   * archived by another owner. Archive stays available in all three, because adding the user's own
   * cause is what keeps something archived once the container above it is restored.
   */
  readonly canArchive: boolean;
  /** Archived only through a container above, which moving it somewhere active undoes. */
  readonly canMoveOut: boolean;
  /**
   * The nearest cause that starts above the entity, or null. Not simply the first cause: when the
   * entity has a cause of its own, that one comes first, and naming it would say "archived with"
   * the entity itself.
   */
  readonly nearestInherited: ArchiveCause | null;
}

export const lifecycleView = (nodeId: number, causes: readonly ArchiveCause[]): LifecycleView => {
  const standing = archiveStandingOf(nodeId, causes);
  const canRestore = hasDirectUserCause(nodeId, causes);

  return {
    nodeId,
    causes,
    standing,
    canRestore,
    canArchive: !canRestore,
    canMoveOut: standing === 'inherited',
    nearestInherited: causes.find((cause) => cause.origin.id !== nodeId) ?? null,
  };
};

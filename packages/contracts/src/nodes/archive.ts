import { Schema } from 'effect';

import { MACHINE_IDENTIFIER } from '../shared/identifier.ts';
import { NodeId, NodeTypeSchema } from './fields.ts';

/**
 * Archive causes: why something is archived, as both clients read it.
 *
 * A cause is a sticker on one node - its origin - naming who put it there (`owner`) and why
 * (`reason`). A node is archived when it or any current ancestor carries one; the server computes
 * that and sends the causes that apply, nearest origin first. Nothing here computes status: the two
 * helpers below only read a cause list the server already sent, so the CLI and the phone cannot
 * disagree about what "direct" or "can be restored" means.
 */

/** The owner of the causes people write through archive and restore. */
export const USER_ARCHIVE_OWNER = 'user';

/** The reason of a cause written by archiving a node itself. */
export const DIRECT_ARCHIVE_REASON = 'direct';

/**
 * An owner or a reason. Open identifiers rather than literals, so a cause written by a future owner
 * still decodes here; only `(user, direct)` is recognized, and anything else is displayed as-is.
 */
export const ArchiveIdentifier = Schema.String.pipe(
  Schema.filter(
    (value) =>
      MACHINE_IDENTIFIER.test(value) || 'an archive owner or reason is a lowercase identifier',
  ),
);

/**
 * One cause as it applies to a node. `origin` is where the sticker is: the node itself for a direct
 * archive, or the ancestor it is inherited through. It carries a title and a type so a client can
 * explain an inherited status without a second request, and no path, because Get Path stays explicit.
 */
export const ArchiveCause = Schema.Struct({
  origin: Schema.Struct({ id: NodeId, type: NodeTypeSchema, title: Schema.String }),
  owner: ArchiveIdentifier,
  reason: ArchiveIdentifier,
});

export type ArchiveCause = Schema.Schema.Type<typeof ArchiveCause>;

/** Active, archived only through an ancestor, or archived by a cause of its own. */
export type ArchiveStanding = 'active' | 'inherited' | 'direct';

/** `direct` when any cause originates at `nodeId`, `inherited` when causes exist but none does. */
export const archiveStandingOf = (
  nodeId: number,
  causes: readonly ArchiveCause[],
): ArchiveStanding => {
  if (causes.some((cause) => cause.origin.id === nodeId)) return 'direct';
  return causes.length > 0 ? 'inherited' : 'active';
};

/**
 * Whether ordinary restore applies: the user's own direct cause is on this node. A direct cause of
 * another owner makes the node directly archived without making it restorable by the user.
 */
export const hasDirectUserCause = (nodeId: number, causes: readonly ArchiveCause[]): boolean =>
  causes.some(
    (cause) =>
      cause.origin.id === nodeId &&
      cause.owner === USER_ARCHIVE_OWNER &&
      cause.reason === DIRECT_ARCHIVE_REASON,
  );

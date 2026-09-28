import { DIRECT_ARCHIVE_REASON, USER_ARCHIVE_OWNER } from '@raphael/contracts/nodes';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { InternalFailure, NodeArchived } from './errors.ts';
import { ancestorChain } from './resolve.ts';
import { archiveCauses, nodes } from './schema.ts';
import { raise } from './storage-failures.ts';
import type { Orm } from './store.ts';
import { isNodeType, type EffectiveCause, type StoredNode } from './types.ts';

/**
 * The lifecycle rule (ADR 0003), and the only reader and writer of `archive_causes`. A cause is stored
 * on the node that was archived; a node is archived when it or any current ancestor carries one, so
 * every mutation re-checks inside its own write transaction.
 *
 * One node is answered by walking its chain (`effectiveCauses`); a page is answered in SQL
 * (`ARCHIVED_CONTAINERS`, `IS_ARCHIVED`). `tests/nodes-lifecycle-parity.test.ts` pins the two together.
 */

export type ArchivedField = 'target' | 'parent' | 'destination';
export type Standing = 'active' | 'inherited' | 'direct';

/** The causes that apply to `node`: nearest origin first, then owner, then reason. */
export const effectiveCauses = (
  orm: Orm,
  node: StoredNode,
  operation: string,
): readonly EffectiveCause[] => {
  const chain = ancestorChain(orm, node, operation);
  const position = new Map(chain.map((step, index) => [step.id, index]));

  const rows = orm
    .select({
      nodeId: archiveCauses.nodeId,
      owner: archiveCauses.owner,
      reason: archiveCauses.reason,
      type: nodes.type,
      title: nodes.title,
    })
    .from(archiveCauses)
    .innerJoin(nodes, eq(nodes.id, archiveCauses.nodeId))
    .where(
      inArray(
        archiveCauses.nodeId,
        chain.map((step) => step.id),
      ),
    )
    .all();

  const causes = rows.map((row): EffectiveCause => {
    if (!isNodeType(row.type)) {
      return raise(
        new InternalFailure({
          operation,
          detail: 'an archive cause names a node with an unrecognized type',
        }),
      );
    }
    return {
      originId: row.nodeId,
      originType: row.type,
      originTitle: row.title,
      owner: row.owner,
      reason: row.reason,
    };
  });

  return causes.sort(
    (a, b) =>
      (position.get(a.originId) ?? 0) - (position.get(b.originId) ?? 0) ||
      compareCodeUnits(a.owner, b.owner) ||
      compareCodeUnits(a.reason, b.reason),
  );
};

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `direct` when a cause originates at the node, `inherited` when causes exist but none does. */
export const standingOf = (node: StoredNode, causes: readonly EffectiveCause[]): Standing => {
  if (causes.some((cause) => cause.originId === node.id)) return 'direct';
  return causes.length > 0 ? 'inherited' : 'active';
};

/**
 * Refuses when `node` is archived, directly or through an ancestor. `null` is the virtual root, which
 * is never archived and passes without a query.
 */
export const requireActive = (
  orm: Orm,
  node: StoredNode | null,
  field: ArchivedField,
  operation: string,
): void => {
  if (node === null) return;
  const standing = standingOf(node, effectiveCauses(orm, node, operation));
  if (standing !== 'active') raise(new NodeArchived({ field, standing }));
};

/** Something archived by its own cause is restored before it moves; an inherited-only one may move out. */
export const requireMovable = (orm: Orm, target: StoredNode, operation: string): void => {
  if (standingOf(target, effectiveCauses(orm, target, operation)) === 'direct') {
    raise(new NodeArchived({ field: 'target', standing: 'direct' }));
  }
};

/** `true` when a row was written; the primary key decides "already there". */
export const addDirectUserCause = (orm: Orm, nodeId: number, now: number): boolean =>
  orm
    .insert(archiveCauses)
    .values({ nodeId, owner: USER_ARCHIVE_OWNER, reason: DIRECT_ARCHIVE_REASON, createdAt: now })
    .onConflictDoNothing()
    .run().changes === 1;

/** Removes only the user's direct cause. `true` when a row was removed. */
export const removeDirectUserCause = (orm: Orm, nodeId: number): boolean =>
  orm
    .delete(archiveCauses)
    .where(
      and(
        eq(archiveCauses.nodeId, nodeId),
        eq(archiveCauses.owner, USER_ARCHIVE_OWNER),
        eq(archiveCauses.reason, DIRECT_ARCHIVE_REASON),
      ),
    )
    .run().changes === 1;

/** The archived containers, for a page's `WITH RECURSIVE`. `UNION` terminates on corrupt cycles. */
export const ARCHIVED_CONTAINERS: SQL = sql`archived_containers(id) AS (
    SELECT c.node_id FROM archive_causes c JOIN nodes x ON x.id = c.node_id WHERE x.type <> 'resource'
    UNION
    SELECT child.id FROM nodes child JOIN archived_containers a ON child.parent_id = a.id
     WHERE child.type <> 'resource'
  )`;

/**
 * Over the page alias `n`. The `IS NOT NULL` guard is required: `NULL IN (...)` is NULL, which would
 * silently drop every active root area from a default page.
 */
export const IS_ARCHIVED: SQL = sql`(EXISTS (SELECT 1 FROM archive_causes c WHERE c.node_id = n.id)
    OR (n.parent_id IS NOT NULL AND n.parent_id IN (SELECT id FROM archived_containers)))`;

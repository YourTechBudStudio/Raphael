import { DIRECT_ARCHIVE_REASON, USER_ARCHIVE_OWNER } from '@raphael/contracts/nodes';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { InternalFailure, NodeArchived } from './errors.ts';
import { ancestorChain } from './resolve.ts';
import { archiveCauses, nodes } from './schema.ts';
import { raise } from './storage-failures.ts';
import type { Orm } from './store.ts';
import { isNodeType, type EffectiveCause, type StoredNode } from './types.ts';

/**
 * The lifecycle rule: when is a node archived, and what may happen to it then (ADR 0003).
 *
 * Three rules explain everything, and this module is the one owner of all three:
 *
 * 1. **A cause is a sticker on one node.** Archiving stores `(node, owner, reason)` on the node that
 *    was archived - its origin - and nothing on its descendants. The user's own cause is
 *    `('user', 'direct')`.
 * 2. **Archived is computed, never stored.** A node is archived when it or any current ancestor
 *    carries a cause. Moving a node out from under an archived container makes it active with no
 *    cleanup; restoring an ancestor leaves a descendant with its own cause archived.
 * 3. **Every mutation re-checks archived state inside its own write transaction.** A revision proves
 *    only that the node itself did not change. It says nothing about its ancestors, whose causes can
 *    change without touching this node's row.
 *
 * This is the only module that reads or writes `archive_causes`. No other module computes effective
 * status; operations call `requireActive` or `requireMovable` at one named point in their order.
 *
 * ## Two evaluators of one rule
 *
 * One node is answered by walking its ancestor chain in TypeScript (`effectiveCauses`), which also
 * says *which* causes apply and in what order. A page is answered in SQL (`ARCHIVED_CONTAINERS` and
 * `IS_ARCHIVED`), because a page cannot afford a walk per row. They state the same rule, and
 * `tests/nodes-lifecycle-parity.test.ts` pins them to each other in both directions.
 *
 * The SQL form uses an equivalent statement of the rule: a node is archived when it has a cause of its
 * own, or when its parent is an *archived container*. By induction on depth, a container is archived
 * exactly when it has a cause or its parent is an archived container - so the recursive set of
 * archived containers, seeded by every container with a cause and extended to their container
 * children, is the set of archived containers, and one parent test per row finishes the rule. Only
 * containers need to be in the set, because a resource holds nothing.
 *
 * **`IS_ARCHIVED` must be two-valued.** A root area has `parent_id` NULL, and in SQL `NULL IN
 * (non-empty set)` is NULL, not false. Without the `n.parent_id IS NOT NULL` guard, as soon as any
 * container anywhere has a cause, an active root area evaluates to NULL, `NOT NULL` is NULL too, and a
 * default page silently drops every active root area. The guard keeps the uncorrelated `IN`, so the
 * archived set is computed once per statement; a correlated `EXISTS` would also be two-valued but
 * probes an unindexed CTE per row. Do not drop the guard.
 */

export type ArchivedField = 'target' | 'parent' | 'destination';
export type Standing = 'active' | 'inherited' | 'direct';

/**
 * The causes that apply to `node`, nearest origin first.
 *
 * The walk is `ancestorChain`, with its cycle and missing-ancestor detection as integrity failures. One
 * query then reads every cause on the chain. Order is chain position (the node itself first), then
 * owner, then reason, each by plain code-unit comparison, so both clients print causes the same way.
 */
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

/**
 * Refuses a move of something archived by a cause of its own; that is restored first. Something
 * archived only through a container above it may move, which is how it leaves the archived subtree
 * (AC5). Where it may move to is `requireActive` on the destination.
 */
export const requireMovable = (orm: Orm, target: StoredNode, operation: string): void => {
  if (standingOf(target, effectiveCauses(orm, target, operation)) === 'direct') {
    raise(new NodeArchived({ field: 'target', standing: 'direct' }));
  }
};

/**
 * Adds the user's direct cause. `true` when a row was written; `false` when it was already there,
 * which the primary key decides.
 */
export const addDirectUserCause = (orm: Orm, nodeId: number, now: number): boolean =>
  orm
    .insert(archiveCauses)
    .values({ nodeId, owner: USER_ARCHIVE_OWNER, reason: DIRECT_ARCHIVE_REASON, createdAt: now })
    .onConflictDoNothing()
    .run().changes === 1;

/**
 * Removes the user's direct cause and no other: never another owner's, and never an ancestor's or a
 * descendant's. `true` when a row was removed.
 */
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

/**
 * The archived containers, as one recursive CTE entry for a page's `WITH RECURSIVE`. Fixed text: no
 * caller input reaches it. `UNION` rather than `UNION ALL`, so corrupt cyclic parentage terminates.
 */
export const ARCHIVED_CONTAINERS: SQL = sql`archived_containers(id) AS (
    SELECT c.node_id FROM archive_causes c JOIN nodes x ON x.id = c.node_id WHERE x.type <> 'resource'
    UNION
    SELECT child.id FROM nodes child JOIN archived_containers a ON child.parent_id = a.id
     WHERE child.type <> 'resource'
  )`;

/**
 * Over the page alias `n`: true when `n` has a cause of its own or sits under an archived container.
 * Requires `ARCHIVED_CONTAINERS` in the statement. The `IS NOT NULL` guard keeps it two-valued; see
 * the module doc.
 */
export const IS_ARCHIVED: SQL = sql`(EXISTS (SELECT 1 FROM archive_causes c WHERE c.node_id = n.id)
    OR (n.parent_id IS NOT NULL AND n.parent_id IN (SELECT id FROM archived_containers)))`;

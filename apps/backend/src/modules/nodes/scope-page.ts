import type { NodeFilter } from '@raphael/contracts/nodes';
import { sql, type SQL } from 'drizzle-orm';

import { ARCHIVED_CONTAINERS, IS_ARCHIVED } from './lifecycle.ts';
import type { ResolvedScopes } from './types.ts';

/**
 * The half of a page that List and Search share, as SQL fragments.
 *
 * This module knows nothing about this capability's machinery - no `Orm`, no transaction, no
 * `resolve.ts`. It takes facts that are already resolved and produces fragments, which is what keeps
 * `resolve.ts` free of a dependency back on it and what makes every rule below testable by reading
 * one file. The one rule it does not own is "effectively archived": it takes that as two fixed
 * fragments from `lifecycle.ts`, the module that owns it.
 *
 * ## The invariants enforced here
 *
 * **Filtering applies to results and never prunes traversal.** A recursive search filtered to notes
 * still walks through every area and project to reach them; pruning the walk by a predicate would
 * silently hide everything that happens to live one level below something that did not match. The
 * predicate is applied in SQL, before `LIMIT`, so a page is a page of things the caller can actually
 * receive rather than one thinned out afterwards.
 *
 * **Membership is deduplicated before anything is ordered or cut.** Two scopes may overlap - `/work`
 * searched beside `/work/raphael` is the ordinary case - and a row inside both must appear once. A
 * non-recursive page dedupes structurally, because a row either satisfies a `WHERE` or does not; a
 * recursive page dedupes with `DISTINCT` over a tagged walk.
 *
 * **A scope is never its own result, but it may be another scope's.** The walk tags each row with the
 * scope it was reached from and drops a row only from *its own* scope's set. A blanket "exclude every
 * scope id" would hide `/work/raphael` from a search of `/work`, which is the thing a union of nested
 * scopes exists to do.
 *
 * **Nothing is assembled from caller text.** Every value travels as a bound parameter through
 * Drizzle's `sql` template. `sql.raw` is not used in this module, and the only closed vocabularies
 * that become SQL text are ones this file writes itself.
 *
 * ## The three membership shapes
 *
 * They are genuinely three, not one with options, and each exists because the query it produces is
 * the right one for a request people actually send:
 *
 * 1. **Root and recursive** - no clause at all. Membership is every row, which the schema guarantees
 *    (`nodes_root_is_area`, `nodes_parent_pair`, the parent foreign key). This is what every unscoped
 *    mobile search and every `raphael search /` sends, so it is the dominant shape, and walking the
 *    whole table to compute "everything" would charge the most common query for a uniformity nobody
 *    can observe. Its one behavioral difference is under corrupt data: rows caught in a multi-node
 *    parentage cycle are unreachable by a walk and would be excluded, while this branch includes
 *    them. That asymmetry is accepted.
 * 2. **Not recursive** - one predicate on `parent_id`, no CTE. This generalizes what listing has
 *    always done from a single parent to a set, and it keeps the plan index-driven on
 *    `nodes_sibling_slug`, which is what lets an ordered page stop early instead of materializing
 *    every child and sorting it. No scope exclusion is needed: `nodes_not_self_parent` makes a node
 *    its own child impossible, so a scope cannot appear among its own children.
 * 3. **Recursive with node scopes** - the tagged walk. Recursion collects identities with `UNION`
 *    rather than `UNION ALL`, so the deduplication *is* the visited set and corrupted cyclic
 *    parentage terminates instead of spinning. That guarantees termination; it does not certify that
 *    the hierarchy is acyclic, which is why Get Path does its own cycle detection rather than
 *    trusting this.
 *
 * The root can never appear in shape 3, because root-and-recursive is shape 1, so the walk has no
 * root seed and needs no synthetic tag for one.
 *
 * ## Archived nodes
 *
 * Both operations leave out effectively archived nodes by default - archived by a cause of their own
 * or through a container above them - and include them, marked, when the request asks (ADR 0001).
 *
 * **The walk is not pruned.** The archive predicate is evaluated per row against one global set of
 * archived containers, computed once per statement, so it applies identically in all three shapes and
 * needs no hook into the walk. A scope inside an archived subtree therefore needs no special handling:
 * its members' parents are archived containers, so a default page of it is empty and an inclusive page
 * shows everything, marked. Pruning the walk would be an optimization only, and nothing measured calls
 * for it.
 *
 * Every page statement has exactly one `WITH RECURSIVE`, because SQLite allows one `WITH` per statement:
 * the archived containers always come first, and shape 3 adds its walk and members after them. That is
 * why `pageFragments` assembles the clause rather than each shape writing its own.
 */

/**
 * What a page statement is assembled from. `conditions` are ANDed with the operation's own conditions
 * by `whereFragment`; `join` may be empty.
 */
export interface PageFragments {
  /** One `WITH RECURSIVE`, always present: the archived containers, then any membership entries. */
  readonly with: SQL;
  readonly join: SQL;
  /** Membership plus, in default mode, the archive exclusion. What a page selects under. */
  readonly conditions: readonly SQL[];
  /**
   * Membership alone, without the archive exclusion. For a caller that asks about the rows a default
   * page left out, which must not also carry the condition that left them out.
   */
  readonly membershipConditions: readonly SQL[];
  /** `… AS archived`: the constant `0` when archived rows are excluded, computed when included. */
  readonly archivedColumn: SQL;
  /**
   * The archive predicate over the page alias `n`, for a caller that must ask about the archived rows
   * a default page left out without restating the rule.
   */
  readonly archivedCondition: SQL;
}

/** Membership alone: CTE entries for the page's one `WITH RECURSIVE`, a join, and conditions. */
interface MembershipFragments {
  readonly ctes: readonly SQL[];
  readonly join: SQL;
  readonly conditions: readonly SQL[];
}

/** A bound list for an `IN (...)`. Every element is a parameter; none of it is text. */
const boundList = (values: readonly (string | number)[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** One condition from several alternatives, parenthesized only when there is a choice to make. */
const anyOf = (conditions: readonly SQL[]): SQL =>
  conditions.length === 1 ? (conditions[0] as SQL) : sql`(${sql.join([...conditions], sql` OR `)})`;

/**
 * The page's fragments: membership for the scopes, and archived rows excluded or marked.
 *
 * Default mode adds the exclusion as one more condition and reports every row as not archived, which is
 * true by construction of that condition. Inclusion mode adds no condition and computes the column.
 */
export const pageFragments = (
  scopes: ResolvedScopes,
  recursive: boolean,
  includeArchived: boolean,
): PageFragments => {
  const membership = membershipFragments(scopes, recursive);
  return {
    with: sql`WITH RECURSIVE ${sql.join([ARCHIVED_CONTAINERS, ...membership.ctes], sql`, `)}`,
    join: membership.join,
    membershipConditions: membership.conditions,
    conditions: includeArchived
      ? membership.conditions
      : [...membership.conditions, sql`NOT ${IS_ARCHIVED}`],
    archivedColumn: includeArchived ? sql`${IS_ARCHIVED} AS archived` : sql`0 AS archived`,
    archivedCondition: IS_ARCHIVED,
  };
};

const membershipFragments = (scopes: ResolvedScopes, recursive: boolean): MembershipFragments => {
  const noClause = { ctes: [], join: sql.empty() } as const;

  if (scopes.root && recursive) return { ...noClause, conditions: [] };

  if (!recursive) {
    const alternatives: SQL[] = [];
    if (scopes.root) alternatives.push(sql`n.parent_id IS NULL`);
    if (scopes.nodeIds.length > 0) {
      alternatives.push(sql`n.parent_id IN (${boundList(scopes.nodeIds)})`);
    }
    return { ...noClause, conditions: [anyOf(alternatives)] };
  }

  // Recursive without the root: the only shape that needs to walk. `id <> scope` drops a scope from
  // its own set and from no other, so a nested scope is still found under its ancestor while a
  // corrupt cycle cannot list a node as its own descendant.
  const seeds = sql`SELECT id, parent_id FROM nodes WHERE parent_id IN (${boundList(scopes.nodeIds)})`;
  return {
    ctes: [
      sql`walk(id, scope) AS (
        ${seeds}
        UNION
        SELECT child.id, walk.scope FROM nodes child JOIN walk ON child.parent_id = walk.id
      )`,
      sql`members(id) AS (SELECT DISTINCT id FROM walk WHERE id <> scope)`,
    ],
    join: sql`JOIN members ON members.id = n.id`,
    conditions: [],
  };
};

/**
 * The structured filter, as conditions to be ANDed.
 *
 * A scalar is `$in` of one, so both spellings take one path. `kind` on a container is NULL and simply
 * does not match, which is why a `kind` predicate does not have to imply a `type` one. Tags are
 * compared by exact equality of the normalized form the contract already fixed, which is what makes a
 * submitted `" backend "` find a stored `backend` - the request decoder normalized it before it got
 * here.
 */
export const predicateConditions = (filter: NodeFilter | undefined): readonly SQL[] => {
  if (filter === undefined) return [];
  const conditions: SQL[] = [];

  const valuesOf = (value: string | { readonly $in: readonly string[] }): readonly string[] =>
    typeof value === 'string' ? [value] : value.$in;

  if (filter.type !== undefined) {
    conditions.push(sql`n.type IN (${boundList(valuesOf(filter.type))})`);
  }
  if (filter.kind !== undefined) {
    conditions.push(sql`n.kind IN (${boundList(valuesOf(filter.kind))})`);
  }
  if (filter.tags !== undefined) {
    // At least one of the listed tags is on the node. `json_each` runs only when a tag predicate is
    // present, and `nodes_tags_json` guarantees the column is always a JSON array.
    conditions.push(
      sql`EXISTS (SELECT 1 FROM json_each(n.tags) WHERE json_each.value IN (${boundList(valuesOf(filter.tags))}))`,
    );
  }

  return conditions;
};

/** Joins conditions behind `WHERE`, or is empty. */
export const whereFragment = (conditions: readonly SQL[]): SQL =>
  conditions.length === 0 ? sql.empty() : sql`WHERE ${sql.join([...conditions], sql` AND `)}`;

/**
 * The page window.
 *
 * One row beyond the page, so `hasMore` is *observed* rather than inferred from a second count query
 * that could disagree with the page it describes.
 */
export const windowFragment = (skip: number, limit: number): SQL =>
  sql`LIMIT ${limit + 1} OFFSET ${skip}`;

import type { NodeFilter } from '@raphael/contracts/nodes';
import { sql, type SQL } from 'drizzle-orm';

import { ARCHIVED_CONTAINERS, IS_ARCHIVED } from './lifecycle.ts';
import type { ResolvedScopes } from './types.ts';

/**
 * The half of a page that List and Search share, as SQL fragments over resolved scopes.
 *
 * - Filtering applies to results and never prunes the walk, and it runs before `LIMIT`.
 * - Overlapping scopes contribute a row once; a scope is never its own result, but may be another's.
 * - Every value is a bound parameter; `sql.raw` is not used.
 *
 * Three membership shapes: root and recursive needs no clause at all; non-recursive is one
 * `parent_id` predicate; recursive with node scopes walks with `UNION`, which also terminates on
 * corrupt cycles. Archived rows are excluded or marked per row against one set of archived containers,
 * and SQLite allows one `WITH` per statement, so `pageFragments` assembles it.
 */

/** `conditions` are ANDed with the operation's own by `whereFragment`; `join` may be empty. */
export interface PageFragments {
  /** One `WITH RECURSIVE`, always present: the archived containers, then any membership entries. */
  readonly with: SQL;
  readonly join: SQL;
  /** Membership plus, in default mode, the archive exclusion. What a page selects under. */
  readonly conditions: readonly SQL[];
  /** Membership without the archive exclusion, for asking about what a default page left out. */
  readonly membershipConditions: readonly SQL[];
  /** `… AS archived`: the constant `0` when archived rows are excluded, computed when included. */
  readonly archivedColumn: SQL;
  /** The archive predicate over the page alias `n`. */
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

/** Membership for the scopes, with archived rows excluded (default) or marked. */
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

  // `id <> scope` drops a scope from its own set only, so a nested scope is still found under its
  // ancestor.
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
 * The structured filter, as ANDed conditions. A scalar is `$in` of one. Tags are already normalized by
 * the request decoder, so they compare by equality.
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
    // At least one of the listed tags is on the node.
    conditions.push(
      sql`EXISTS (SELECT 1 FROM json_each(n.tags) WHERE json_each.value IN (${boundList(valuesOf(filter.tags))}))`,
    );
  }

  return conditions;
};

/** Joins conditions behind `WHERE`, or is empty. */
export const whereFragment = (conditions: readonly SQL[]): SQL =>
  conditions.length === 0 ? sql.empty() : sql`WHERE ${sql.join([...conditions], sql` AND `)}`;

/** One row beyond the page, so `hasMore` is observed rather than counted. */
export const windowFragment = (skip: number, limit: number): SQL =>
  sql`LIMIT ${limit + 1} OFFSET ${skip}`;

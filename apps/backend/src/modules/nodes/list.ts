import { decodeListRequest, type ListResponse, type NodeOrderBy } from '@raphael/contracts/nodes';
import { sql, type SQL } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { invalidInputFrom } from './diagnostics.ts';
import type { NodeError } from './errors.ts';
import { pathsOf } from './paths.ts';
import { SUMMARY_COLUMNS, summaryProjection } from './projection.ts';
import { resolveScopes } from './resolve.ts';
import {
  pageFragments,
  predicateConditions,
  whereFragment,
  windowFragment,
  type PageFragments,
} from './scope-page.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction, type Orm } from './store.ts';
import type { StoredPageSummary } from './types.ts';

const OPERATION = 'nodes.list';

/**
 * Lists a scope over the shared scope page (`scope-page.ts`); only the ordering is list's own. It is
 * applied before the window, so pages agree with each other. A recursive listing is a flat, globally
 * ordered list of descendants, not a tree. Paths, when asked for, are computed for the visible window
 * only, in the same read transaction as the page.
 */
export const listNodes = (input: unknown): Effect.Effect<ListResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    return yield* Effect.try({
      try: () => {
        const request = decodeListRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, input));
        }
        const { scopes, recursive, filter, orderBy, skip, limit, includeArchived, includePaths } =
          request.right;
        const ordering = effectiveOrderBy(orderBy);

        const page = readTransaction(db, () => {
          const handle = orm(db);
          const resolved = resolveScopes(handle, scopes, OPERATION);
          const fragments = pageFragments(resolved, recursive, includeArchived);
          const filterConditions = predicateConditions(filter);

          const rows = handle.all<StoredPageSummary>(sql`
            ${fragments.with}
            SELECT ${SUMMARY_COLUMNS}, ${fragments.archivedColumn} FROM nodes n ${fragments.join}
            ${whereFragment([...fragments.conditions, ...filterConditions])}
            ORDER BY ${orderingFragment(ordering)} ${windowFragment(skip, limit)}`);
          const visible = rows.slice(0, limit);
          return {
            visible,
            hasMore: rows.length > limit,
            // With inclusion nothing was left out, and no second statement runs.
            archivedLeftOut:
              !includeArchived && archivedMemberExists(handle, fragments, filterConditions),
            paths: includePaths
              ? pathsOf(
                  handle,
                  visible.map((row) => row.id),
                  OPERATION,
                )
              : undefined,
          };
        });

        return {
          items: page.visible.map((row) =>
            summaryProjection(row, row.archived === 1, page.paths?.get(row.id)),
          ),
          skip,
          limit,
          hasMore: page.hasMore,
          archivedLeftOut: page.archivedLeftOut,
        };
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'page read' }, cause),
    });
  });

/** Whether an archived item belongs to the same scopes and filter, anywhere in the listing. */
const archivedMemberExists = (
  handle: Orm,
  fragments: PageFragments,
  filterConditions: readonly SQL[],
): boolean => {
  const row = handle.get<{ found: number }>(sql`
    ${fragments.with}
    SELECT EXISTS (
      SELECT 1 FROM nodes n ${fragments.join}
      ${whereFragment([...filterConditions, ...fragments.membershipConditions, fragments.archivedCondition])}
    ) AS found`);
  return row?.found === 1;
};

/** What the caller asked for, made total by a trailing id clause so page boundaries are stable. */
const effectiveOrderBy = (requested: NodeOrderBy | undefined): NodeOrderBy => {
  if (requested === undefined) {
    return [
      { field: 'slug', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ];
  }
  if (requested.some((clause) => clause.field === 'id')) return requested;
  return [...requested, { field: 'id', direction: 'asc' }];
};

/** Fixed fragments keyed by decoded values; nothing submitted is interpolated into `ORDER BY`. */
const ORDER_COLUMNS = {
  slug: sql`n.slug`,
  updatedAt: sql`n.updated_at`,
  id: sql`n.id`,
} as const;

const ORDER_DIRECTIONS_SQL = { asc: sql`ASC`, desc: sql`DESC` } as const;

const orderingFragment = (ordering: NodeOrderBy) =>
  sql.join(
    ordering.map(
      (clause) => sql`${ORDER_COLUMNS[clause.field]} ${ORDER_DIRECTIONS_SQL[clause.direction]}`,
    ),
    sql`, `,
  );

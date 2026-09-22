import {
  decodeListRequest,
  decodeListResponse,
  type ListResponse,
  type NodeOrderBy,
} from '@raphael/contracts/nodes';
import { sql } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { LIST_FIELDS, invalidInputFrom } from './diagnostics.ts';
import type { NodeError } from './errors.ts';
import { SUMMARY_COLUMNS, checkedResponse, summaryProjection } from './projection.ts';
import { resolveScopes } from './resolve.ts';
import {
  membershipFragments,
  predicateConditions,
  whereFragment,
  windowFragment,
} from './scope-page.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction } from './store.ts';
import type { StoredSummary } from './types.ts';

const OPERATION = 'nodes.list';

/**
 * Listing what a scope contains: ordering and assembly over the shared scope page.
 *
 * Where to look, how deep, which nodes qualify and which slice to return all live in
 * `scope-page.ts`, together with the traversal invariants they carry - filtering never prunes the
 * walk, membership is deduplicated before anything is ordered, and `hasMore` is observed rather than
 * counted. What stays here is the only thing listing does not share with searching: the ordering.
 *
 * Ordering is global and is applied *before* pagination, whichever clauses were asked for. Sorting an
 * already-limited page, or sorting per branch, would produce a page that is ordered internally and
 * wrong overall - the most convincing kind of wrong.
 *
 * A recursive result is a flat, globally ordered list of descendants. It is not depth-first, and a page
 * can contain a node whose ancestors are on another page - so it is a descendant listing, not a tree
 * source. Navigating a hierarchy is what the immediate-child query is for.
 *
 * Three consequences worth naming. Listing an area returns its resources alongside its containers,
 * because an omitted `filter` restricts nothing; a caller that means "containers" says so with
 * `filter`. Listing a resource returns an empty page rather than a refusal: a resource holds nothing,
 * and an empty page is the truthful answer for a valid scope. And several scopes are listed as one
 * union, so a row inside two of them appears once.
 */
export const listNodes = (input: unknown): Effect.Effect<ListResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    return yield* Effect.try({
      try: () => {
        const request = decodeListRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, LIST_FIELDS, input));
        }
        const { scopes, recursive, filter, orderBy, skip, limit } = request.right;
        const ordering = effectiveOrderBy(orderBy);

        const page = readTransaction(db, () => {
          const handle = orm(db);
          const resolved = resolveScopes(handle, scopes, OPERATION);
          const membership = membershipFragments(resolved, recursive);

          const rows = handle.all<StoredSummary>(sql`
            ${membership.with}
            SELECT ${SUMMARY_COLUMNS} FROM nodes n ${membership.join}
            ${whereFragment([...membership.conditions, ...predicateConditions(filter)])}
            ORDER BY ${orderingFragment(ordering)} ${windowFragment(skip, limit)}`);
          return { rows, skip, limit };
        });

        const visible = page.rows.slice(0, page.limit);
        return checkedResponse(
          decodeListResponse,
          {
            items: visible.map((row) => summaryProjection(row, OPERATION)),
            skip: page.skip,
            limit: page.limit,
            hasMore: page.rows.length > page.limit,
          },
          OPERATION,
        );
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'page read' }, cause),
    });
  });

/**
 * The effective ordering: what the caller asked for, made total.
 *
 * An omitted `orderBy` is the ordering listing has always had. An explicit one *replaces* that default
 * rather than extending it, and an id clause is appended only when the caller named no id clause - so a
 * caller who asked for `id:desc` gets exactly that, and is not silently given a second id comparison
 * behind it that could never be reached anyway.
 *
 * Appending id is what makes every ordering total. Without it, two rows with equal slugs under different
 * parents - or equal timestamps, which are ordinary rather than exotic - would come back in whatever
 * order SQLite found convenient, and two requests for the same offset could disagree about which row
 * sits on the boundary between pages.
 */
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

/**
 * Ordering fields and directions, as fixed SQL fragments.
 *
 * Closed maps, keyed by values the request decoder has already validated against a closed vocabulary.
 * Nothing a caller submitted is ever interpolated: `sql.raw` is not used here, and these fragments are
 * the only text that can reach an `ORDER BY`. The vocabulary check and this table are two independent
 * reasons the same injection cannot happen, which is the point of writing it this way rather than
 * formatting a validated string.
 *
 * Slug compares under the column's BINARY collation. `NOCASE` is never used: slugs are canonicalized
 * before storage, so case folding could not express a distinction the data does not already carry, and
 * it would make `spec` and `Spec` collide in a way the unique indexes do not. `updated_at` and `id` are
 * integers and compare numerically.
 */
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

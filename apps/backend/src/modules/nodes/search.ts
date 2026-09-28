import {
  decodeSearchRequest,
  parseSearchQuery,
  type SearchQuery,
  type SearchResponse,
} from '@raphael/contracts/nodes';
import { sql, type SQL } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { invalidInputFrom } from './diagnostics.ts';
import { InternalFailure, type NodeError } from './errors.ts';
import { SUMMARY_COLUMNS, summaryProjection } from './projection.ts';
import { resolveScopes } from './resolve.ts';
import {
  pageFragments,
  type PageFragments,
  predicateConditions,
  whereFragment,
  windowFragment,
} from './scope-page.ts';
import { SEARCH_WEIGHTS, matchExpression } from './search-match.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction, type Orm } from './store.ts';
import type { StoredPageSummary } from './types.ts';

const OPERATION = 'nodes.search';

/**
 * Text search over the shared scope page, ordered by bm25 (lower is better) then id.
 *
 * Verified against the pinned driver: the FTS table must be named, not aliased, for `bm25()` and
 * `MATCH`; the score is aliased `score` because FTS5 already has a hidden `rank` column.
 */
export const searchNodes = (input: unknown): Effect.Effect<SearchResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    return yield* Effect.try({
      try: () => {
        const request = decodeSearchRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, input));
        }
        const { scopes, recursive, filter, queries, skip, limit, includeArchived } = request.right;

        // The decoder already accepted each query, so a parse failure here is our bug.
        const parsed: SearchQuery[] = [];
        for (const query of queries) {
          const tree = parseSearchQuery(query);
          if (Either.isLeft(tree)) {
            return raise(
              new InternalFailure({
                operation: OPERATION,
                detail: 'a decoded query did not parse',
              }),
            );
          }
          parsed.push(tree.right);
        }
        const match = matchExpression(parsed);

        const page = readTransaction(db, () => {
          const handle = orm(db);
          const resolved = resolveScopes(handle, scopes, OPERATION);
          const fragments = pageFragments(resolved, recursive, includeArchived);
          const matchCondition = sql`nodes_fts MATCH ${match}`;
          const filterConditions = predicateConditions(filter);

          const rows = handle.all<StoredPageSummary>(sql`
            ${fragments.with}
            SELECT ${SUMMARY_COLUMNS}, ${fragments.archivedColumn},
              bm25(nodes_fts, ${SEARCH_WEIGHTS.title}, ${SEARCH_WEIGHTS.description}, ${SEARCH_WEIGHTS.body}) AS score
            FROM nodes n ${fragments.join}
            JOIN nodes_fts ON nodes_fts.rowid = n.id
            ${whereFragment([matchCondition, ...fragments.conditions, ...filterConditions])}
            ORDER BY score ASC, n.id ASC ${windowFragment(skip, limit)}`);

          // With inclusion nothing was left out, and no second statement runs.
          const archivedLeftOut =
            !includeArchived &&
            archivedMatchExists(handle, fragments, [matchCondition, ...filterConditions]);
          return { rows, archivedLeftOut };
        });

        const visible = page.rows.slice(0, limit);
        return {
          items: visible.map((row) => ({ node: summaryProjection(row, row.archived === 1) })),
          skip,
          limit,
          hasMore: page.rows.length > limit,
          archivedLeftOut: page.archivedLeftOut,
        };
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'page read' }, cause),
    });
  });

/** Whether an archived node matches the same query, scopes and filter anywhere in the match set. */
const archivedMatchExists = (
  handle: Orm,
  fragments: PageFragments,
  matchAndFilter: readonly SQL[],
): boolean => {
  const row = handle.get<{ found: number }>(sql`
    ${fragments.with}
    SELECT EXISTS (
      SELECT 1 FROM nodes n ${fragments.join}
      JOIN nodes_fts ON nodes_fts.rowid = n.id
      ${whereFragment([...matchAndFilter, ...fragments.membershipConditions, fragments.archivedCondition])}
    ) AS found`);
  return row?.found === 1;
};

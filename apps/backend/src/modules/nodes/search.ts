import {
  decodeSearchRequest,
  decodeSearchResponse,
  parseSearchQuery,
  type SearchQuery,
  type SearchResponse,
} from '@raphael/contracts/nodes';
import { sql, type SQL } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { SEARCH_FIELDS, invalidInputFrom } from './diagnostics.ts';
import { InternalFailure, type NodeError } from './errors.ts';
import { SUMMARY_COLUMNS, checkedResponse, summaryProjection } from './projection.ts';
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
 * Finding areas, projects and notes by their text: the shared scope page with a match join and a
 * relevance order.
 *
 * Everything about *where* to look is `scope-page.ts`, exactly as it is for listing. What is here is
 * the join onto the index and the ordering, which is the whole difference between the two operations.
 *
 * Three things in the statement below are load-bearing and were verified against the pinned driver
 * rather than assumed. **The FTS table is named, never aliased** - SQLite refuses `bm25()` and `MATCH`
 * against an alias, reporting "no such column". **The score is aliased `score`, not `rank`** - FTS5
 * exposes a hidden `rank` column on the virtual table, so `ORDER BY rank` beside a join on it would be
 * a name that means two things. And **bm25 weights travel as bound parameters**, so `sql.raw` stays
 * unused here as it is everywhere else in the query path.
 *
 * bm25 is lower-is-better, so `ASC` is best-first. `n.id ASC` behind it is the stable tie-break, which
 * is what makes two requests for the same page agree about the row on the boundary.
 *
 * **Legacy bodies.** A row whose `body_text` has not been projected yet is searchable by its title and
 * description from the moment it commits, and gains body matching when the backfill writes the
 * projection through the ordinary update trigger. No operation reads the backfill's state, and there
 * is no readiness gate: incomplete legacy body coverage is accepted, not tracked.
 *
 * A search that matches nothing is a successful empty page. `hasMore: false` means the page sequence
 * ended; it never claims coverage.
 *
 * **Archived matches left out.** A default search excludes archived nodes, and answers
 * `archivedLeftOut` so a client can offer to include them only when doing so adds results. It is one
 * more statement in the same read transaction, so it describes the same snapshot as the page.
 */
export const searchNodes = (input: unknown): Effect.Effect<SearchResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    return yield* Effect.try({
      try: () => {
        const request = decodeSearchRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, SEARCH_FIELDS, input));
        }
        const { scopes, recursive, filter, queries, skip, limit, includeArchived } = request.right;

        // The contract carries a query as a *string*, because the typed client puts the decoded
        // request on the wire and a decoded request must re-decode to itself. So it is parsed a second
        // time here. The decoder already accepted it, so a rejection now is a bug of ours rather than
        // anything the caller did.
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
        return checkedResponse(
          decodeSearchResponse,
          {
            // `summaryProjection` names its fields, so the `score` column never reaches the wire.
            items: visible.map((row) => ({
              node: summaryProjection(row, row.archived === 1, OPERATION),
            })),
            skip,
            limit,
            hasMore: page.rows.length > limit,
            archivedLeftOut: page.archivedLeftOut,
          },
          OPERATION,
        );
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'page read' }, cause),
    });
  });

/**
 * Whether an archived node matches what a default page asked for: the same `WITH`, join, query, scope
 * membership, and filter, with the page's archive exclusion replaced by the archive predicate itself.
 *
 * `EXISTS` stops at the first archived match. There is no ordering and no window, because the answer is
 * about the whole match set rather than the returned page.
 */
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

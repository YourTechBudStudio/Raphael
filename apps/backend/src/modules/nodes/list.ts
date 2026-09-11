import {
  NODE_TYPES,
  decodeListRequest,
  decodeListResponse,
  type ListResponse,
  type NodeType,
} from '@raphael/contracts/nodes';
import { sql } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { LIST_FIELDS, invalidInputFrom } from './diagnostics.ts';
import type { NodeError } from './errors.ts';
import { InvalidInput } from './errors.ts';
import { checkedResponse, summaryProjection } from './projection.ts';
import { resolveScope } from './resolve.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction } from './store.ts';
import { isExposedNodeType, type StoredSummary } from './types.ts';

const OPERATION = 'nodes.list';

/**
 * Listing what a scope contains.
 *
 * Two properties are easy to get wrong and are both deliberate here.
 *
 * Type filtering applies to *results*, never to traversal. A recursive listing filtered to projects still
 * walks through areas to reach them; pruning the walk by the filter would silently hide every project
 * that happens to live one level deeper. The supported-type restriction is applied in SQL, before
 * `LIMIT`, so a page is a page of things the caller can actually receive and `hasMore` is truthful rather
 * than an artifact of rows dropped after the fact.
 *
 * A recursive result is a flat, globally ordered list of descendants. It is ordered by slug and then id,
 * not depth-first, and a page can contain a node whose ancestors are on another page - so it is a
 * descendant listing, not a tree source. Navigating a hierarchy is what the immediate-child query is for.
 *
 * One consequence worth naming: a project can only contain resources, which this release does not expose,
 * so listing a project always returns an empty page. That is a successful empty result, and a client must
 * present it as one rather than as loading or failure.
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
        const { parent, recursive, types, skip, limit } = request.right;
        const wanted: readonly NodeType[] = types ?? NODE_TYPES;

        const page = readTransaction(db, () => {
          const handle = orm(db);
          const scope = resolveScope(handle, parent, 'parent', OPERATION);
          if (scope.kind === 'node' && !isExposedNodeType(scope.node.type)) {
            return raise(
              new InvalidInput({
                field: 'parent',
                reason: 'unsupported_node_type',
                nodeType: scope.node.type,
              }),
            );
          }
          const scopeId = scope.kind === 'root' ? null : scope.node.id;

          // One row beyond the page, so `hasMore` is observed rather than inferred from a second count
          // query that could disagree with the page it describes.
          const rows = handle.all<StoredSummary>(
            pageQuery({ scopeId, recursive, wanted, skip, limit }),
          );
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
 * The page query.
 *
 * Recursion collects identities with `UNION` rather than `UNION ALL`, so the deduplication *is* the
 * visited set and corrupted cyclic parentage terminates instead of spinning. That guarantees termination;
 * it does not certify that the hierarchy is acyclic, which is why Get Path does its own cycle detection
 * rather than trusting this. The scope node is excluded explicitly as well as by the seed, so a cycle that
 * makes it reachable again cannot list it as its own descendant.
 *
 * Ordering is by slug under the column's BINARY collation, then by id. `NOCASE` is never used: slugs are
 * canonicalized before storage, so case folding could not express a distinction the data does not already
 * carry, and it would make `spec` and `Spec` collide in a way the unique indexes do not.
 */
const pageQuery = (input: {
  readonly scopeId: number | null;
  readonly recursive: boolean;
  readonly wanted: readonly NodeType[];
  readonly skip: number;
  readonly limit: number;
}) => {
  const columns = sql`n.id AS id, n.type AS type, n.parent_id AS parentId, n.slug AS slug,
    n.revision AS revision, n.title AS title, n.description AS description, n.tags AS tags`;
  const types = sql.join(
    input.wanted.map((type) => sql`${type}`),
    sql`, `,
  );
  const window = sql`ORDER BY n.slug, n.id LIMIT ${input.limit + 1} OFFSET ${input.skip}`;

  if (!input.recursive) {
    const parent =
      input.scopeId === null ? sql`n.parent_id IS NULL` : sql`n.parent_id = ${input.scopeId}`;
    return sql`SELECT ${columns} FROM nodes n WHERE ${parent} AND n.type IN (${types}) ${window}`;
  }

  const seed =
    input.scopeId === null
      ? sql`SELECT id FROM nodes WHERE parent_id IS NULL`
      : sql`SELECT id FROM nodes WHERE parent_id = ${input.scopeId}`;
  const notScope = input.scopeId === null ? sql`` : sql`AND n.id <> ${input.scopeId}`;
  return sql`
    WITH RECURSIVE descendant(id) AS (
      ${seed}
      UNION
      SELECT child.id FROM nodes child JOIN descendant ON child.parent_id = descendant.id
    )
    SELECT ${columns} FROM nodes n JOIN descendant ON n.id = descendant.id
    WHERE n.type IN (${types}) ${notScope} ${window}`;
};

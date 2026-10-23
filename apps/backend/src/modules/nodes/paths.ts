import { formatPath } from '@raphael/contracts/nodes';
import { sql } from 'drizzle-orm';

import { InternalFailure } from './errors.ts';
import { ancestorChain } from './resolve.ts';
import { raise } from './storage-failures.ts';
import type { Orm } from './store.ts';
import type { StoredNode } from './types.ts';

/**
 * Paths on request (ADR 0004). A path is computed from the current ancestors whenever an answer asks
 * for one, inside the same transaction as the rest of that answer, and is never stored: a move writes
 * one row and every descendant's path follows from it.
 *
 * One item walks its chain (`pathOf`); a page asks one recursive statement for all of its items
 * (`pathsOf`), so a page of fifty costs one query rather than fifty walks. `nodes-paths.test.ts` holds
 * the two to the same answer.
 */

/** The path of one stored item, from `ancestorChain`, which refuses a cycle or a missing ancestor. */
export const pathOf = (orm: Orm, node: StoredNode, operation: string): string =>
  formatPath(
    ancestorChain(orm, node, operation)
      .map((step) => step.slug)
      .reverse(),
  );

interface ChainRow {
  readonly start: number;
  readonly parentId: number | null;
  readonly slug: string;
  readonly depth: number;
}

/**
 * The paths of a page's items, keyed by id, from one statement.
 *
 * The walk climbs from every item at once. It cannot recurse more often than there are rows, so a
 * corrupt cycle ends at that bound instead of looping; a chain whose top still has a parent - a cycle,
 * or an ancestor that does not exist - is the same integrity failure `ancestorChain` reports.
 */
export const pathsOf = (
  orm: Orm,
  ids: readonly number[],
  operation: string,
): ReadonlyMap<number, string> => {
  const paths = new Map<number, string>();
  if (ids.length === 0) return paths;

  const rows = orm.all<ChainRow>(sql`
    WITH RECURSIVE up(start, id, parent_id, slug, depth) AS (
      SELECT n.id, n.id, n.parent_id, n.slug, 0 FROM nodes n
       WHERE n.id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})
      UNION ALL
      SELECT up.start, p.id, p.parent_id, p.slug, up.depth + 1
        FROM up JOIN nodes p ON p.id = up.parent_id
       WHERE up.depth < (SELECT COUNT(*) FROM nodes)
    )
    SELECT start, parent_id AS parentId, slug, depth FROM up ORDER BY start, depth DESC`);

  const chains = new Map<number, ChainRow[]>();
  for (const row of rows) {
    const chain = chains.get(row.start);
    if (chain === undefined) chains.set(row.start, [row]);
    else chain.push(row);
  }

  for (const id of ids) {
    // Root first: the deepest step of the climb is the top of the chain.
    const chain = chains.get(id);
    if (chain === undefined) {
      return raise(new InternalFailure({ operation, detail: 'a listed node did not load' }));
    }
    if (chain[0]?.parentId !== null) {
      return raise(
        new InternalFailure({
          operation,
          detail: 'stored ancestry contains a cycle or names a node that does not exist',
        }),
      );
    }
    paths.set(id, formatPath(chain.map((step) => step.slug)));
  }
  return paths;
};

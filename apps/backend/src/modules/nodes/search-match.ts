import type { SearchQuery } from '@raphael/contracts/nodes';

/**
 * The only code that emits FTS5 syntax. Every operand is quoted, so FTS5 sees no operators of its own,
 * and the result is only ever a bound `MATCH` parameter.
 *
 * ```text
 * "auth tokens AND credentials"  ->  (("auth") OR ("tokens" AND "credentials"))
 * ```
 */

/** `bm25()` weights in the index's column order. Only the descending order is a commitment. */
export const SEARCH_WEIGHTS = { title: 10, description: 5, body: 1 } as const;

const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;

export const matchExpression = (queries: readonly SearchQuery[]): string =>
  queries
    .map((query) =>
      query.or
        .map(
          (conjunction) =>
            `(${conjunction.and.map((operand) => quote(operand.text)).join(' AND ')})`,
        )
        .join(' OR '),
    )
    .map((expression) => `(${expression})`)
    .join(' OR ');

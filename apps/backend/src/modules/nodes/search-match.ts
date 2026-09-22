import type { SearchQuery } from '@raphael/contracts/nodes';

/**
 * The only code in this repository that emits FTS5 syntax.
 *
 * A caller's query is parsed by the contract into an expression tree and translated here. The tree is
 * what crosses the boundary; the caller's text never does. That is the whole safety argument, and it
 * rests on one property of the output: **every operand becomes a quoted string.** Inside quotes FTS5
 * has no operators, no column filters, no prefix `*`, no `NEAR` and - the one that actually bites - no
 * implicit AND. A bare `credentials bank` handed to FTS5 means "both"; translated through here it
 * means "either", because the product rule lives in the parser rather than in the engine.
 *
 * ```text
 * "auth tokens AND credentials"  ->  { or: [ {and:[auth]}, {and:[tokens, credentials]} ] }
 *                                ->  (("auth") OR ("tokens" AND "credentials"))
 * [q1, q2]                       ->  (q1) OR (q2)
 * ```
 *
 * The quote doubling below is an invariant rather than a path with behavior: the grammar cannot
 * produce an operand containing a quote, and the contract's own tests assert that over every accepted
 * query. It is written anyway because this function's correctness must not depend on a property
 * enforced in another package.
 *
 * The result is only ever a **bound parameter** of `MATCH`. No part of it is interpolated into SQL.
 */

/**
 * Column weights for `bm25()`, in the column order `0004_search_index.sql` declares: title,
 * description, body.
 *
 * **Tuning, not contract.** Only the strict descending order - a title match outranks a description
 * match outranks a body match - is a commitment anything may rely on. The numbers themselves are
 * adjustable, and bm25 normalizes by field length anyway, so they express a preference rather than a
 * ratio. Reordering the columns in the migration would silently reweight every result, which is why
 * that file says so too.
 */
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

import { compareSlugBinary } from './slug.ts';

/**
 * The **default** listing order: slug ascending under binary comparison, then ID ascending as the
 * stable tiebreaker. It is what a listing returns when the caller asks for no particular order, and it
 * applies to immediate children and recursive descendants alike. Types do not group results, and
 * recursive results are not depth-first — a caller may group a page for presentation, but must not
 * present a group as complete before pagination finishes.
 *
 * It is a default, not the only order a listing can have. `ListRequest.orderBy` lets a caller replace
 * it with up to three clauses over slug, update time and ID, and **this comparator does not implement
 * that**: it is the default alone. Storage compiles requested clauses into SQL, and update time is not
 * a field any response carries, so an arbitrary requested ordering is not reproducible outside the
 * query that produced it. Anything holding a page ordered by something other than the default must
 * keep the server's sequence rather than re-deriving it here.
 *
 * What this exists for is agreement with SQL on the default, so nothing outside the database reaches
 * for `<` — which compares UTF-16 code units and diverges from binary collation on the astral
 * characters Unicode slugs allow. Phase 01 establishes the invariant; the order over real rows, and
 * every requested ordering, is verified against SQLite where the queries live.
 */
export const compareNodeOrder = (
  left: { readonly slug: string; readonly id: number },
  right: { readonly slug: string; readonly id: number },
): number => {
  const bySlug = compareSlugBinary(left.slug, right.slug);
  if (bySlug !== 0) return bySlug;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
};

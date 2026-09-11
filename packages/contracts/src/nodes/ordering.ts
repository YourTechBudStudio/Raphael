import { compareSlugBinary } from './slug.ts';

/**
 * The agreed listing order: slug ascending under binary comparison, then ID ascending as the stable
 * tiebreaker. It holds for immediate children and for recursive descendants alike. Types do not group
 * results, and recursive results are not depth-first — a caller may group a page for presentation, but
 * must not present a group as complete before pagination finishes.
 *
 * Storage applies this order in SQL. This comparator exists so anything outside SQL agrees with it
 * rather than reaching for `<`, which compares UTF-16 code units and diverges from binary collation on
 * the astral characters Unicode slugs allow. Phase 01 establishes the invariant; the order over real
 * rows and pagination is verified against SQLite where the queries live.
 */
export const compareNodeOrder = (
  left: { readonly slug: string; readonly id: number },
  right: { readonly slug: string; readonly id: number },
): number => {
  const bySlug = compareSlugBinary(left.slug, right.slug);
  if (bySlug !== 0) return bySlug;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
};

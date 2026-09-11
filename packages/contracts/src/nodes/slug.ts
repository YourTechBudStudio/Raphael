import { Either } from 'effect';

import { codePointLength } from '../shared/json.ts';

export const SLUG_MAX_CODE_POINTS = 100;

/**
 * A canonical slug is one or more tokens joined by single hyphens. A token starts with a Unicode
 * letter or number and may continue with letters, numbers, and combining marks, so scripts that need
 * combining marks are addressable without a leading mark ever standing alone.
 */
const CANONICAL_SLUG = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:-[\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*$/u;

const NON_SLUG_RUN = /[^\p{L}\p{N}\p{M}]+/gu;
const LEADING_MARKS = /^\p{M}+/u;

/**
 * Slugs are Unicode rather than ASCII-folded because mobile creation accepts a user's own title and
 * offers no slug override; transliterating someone's language into ASCII would be a worse address
 * than their own words. Canonical form is NFC, locale-independently lowercased, and within the length
 * bound. Validation rejects a noncanonical explicit slug rather than rewriting it, because silently
 * changing an address the caller chose would make the stored address differ from the requested one.
 */
export const isCanonicalSlugShape = (value: string): boolean => {
  if (value.length === 0) return false;
  if (value !== value.normalize('NFC')) return false;
  if (value !== value.toLowerCase()) return false;
  return CANONICAL_SLUG.test(value);
};

/**
 * Shape plus the submission bound. The bound is deliberately separate: it is a product limit on what
 * a caller may submit, so applying it to a stored slug in a response would turn raising that limit
 * into a change that breaks already-installed clients. Addresses read back from the server are checked
 * for shape, which is a real invariant, and not for today's submission length.
 */
export const isCanonicalSlug = (value: string): boolean =>
  codePointLength(value) <= SLUG_MAX_CODE_POINTS && isCanonicalSlugShape(value);

export type SlugDerivationReason =
  /** No letter or number survived normalization, so there is nothing to address the node by. */
  | 'slug_underivable'
  /** The title is within its own bound but derives past the slug bound. */
  | 'slug_too_long';

export interface SlugDerivationFailure {
  readonly reason: SlugDerivationReason;
}

/**
 * Derives a canonical slug from a title.
 *
 * NFKC first, so compatibility forms such as full-width characters collapse onto their ordinary
 * equivalents; then a locale-independent lowercase, so the same title never depends on the caller's
 * locale; then every run of other characters becomes one separator; then NFC, which is what gets
 * stored and compared. Failure is a deliberate result rather than an empty slug or an invented
 * fallback name: the agreed recovery is that the person changes the title.
 *
 * Sharing this function does not move policy out of core. Core decides when derivation happens,
 * rejects collisions, and owns what is saved.
 */
export const deriveSlug = (title: string): Either.Either<string, SlugDerivationFailure> => {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(NON_SLUG_RUN, '-')
    .split('-')
    .map((token) => token.replace(LEADING_MARKS, ''))
    .filter((token) => token.length > 0)
    .join('-')
    .normalize('NFC');

  if (slug.length === 0) return Either.left({ reason: 'slug_underivable' });
  if (codePointLength(slug) > SLUG_MAX_CODE_POINTS) return Either.left({ reason: 'slug_too_long' });
  /** Normalization is subtle enough that the grammar, not this pipeline, has the final word. */
  if (!isCanonicalSlug(slug)) return Either.left({ reason: 'slug_underivable' });
  return Either.right(slug);
};

/**
 * Compares slugs the way storage does: by UTF-8 bytes.
 *
 * UTF-8 preserves code point order, so comparing code points is the same comparison as comparing
 * encoded bytes, without needing an encoder. It is not the same as JavaScript's `<`, which compares
 * UTF-16 code units and disagrees once an astral character meets the U+E000–U+FFFF range — exactly the
 * inputs Unicode slugs make reachable. Storage compares and orders slugs with binary collation; this
 * is that comparison for anything outside SQL.
 */
export const compareSlugBinary = (left: string, right: string): number => {
  if (left === right) return 0;
  const a = [...left];
  const b = [...right];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const pointA = a[index]?.codePointAt(0) ?? 0;
    const pointB = b[index]?.codePointAt(0) ?? 0;
    if (pointA !== pointB) return pointA < pointB ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

import { Schema } from 'effect';

/**
 * Identity-bearing numbers are safe integers: beyond `Number.MAX_SAFE_INTEGER` a JSON number can no
 * longer round-trip, so accepting one would silently change the identity it refers to.
 */
export const SafeInt = Schema.Number.pipe(
  Schema.int(),
  Schema.between(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
);

export const PositiveSafeInt = SafeInt.pipe(Schema.greaterThanOrEqualTo(1));

export const NonNegativeSafeInt = SafeInt.pipe(Schema.greaterThanOrEqualTo(0));

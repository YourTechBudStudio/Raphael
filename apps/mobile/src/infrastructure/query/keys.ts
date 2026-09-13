/**
 * Every cached fact is stamped with the connection activation it was read under.
 *
 * Two servers can hand out the same numeric id for entirely different containers, so a key of
 * `['area', 3]` is not a description of anything on its own. Stamping the activation makes the key
 * mean "area 3, as read by the connection that was active then", which is the only form of the
 * statement that stays true.
 *
 * It also does the fencing for query results. A read that was in flight when the connection
 * changed resolves into the key it was issued under, which nothing is reading any more, so it can
 * neither be shown nor be mistaken for current data. Cancellation and clearing still happen on the
 * transition; this is what makes the ones that slip through harmless rather than wrong.
 *
 * Activation, not connection id: rotating the key against the same address keeps the identity but
 * is still a new activation, because the requests that were in flight were made with the old key.
 */

const SCOPE_ROOT = 'raphael';

export const scopeKey = (activation: number, ...rest: readonly unknown[]): readonly unknown[] => [
  SCOPE_ROOT,
  activation,
  ...rest,
];

/** The activation a cached query belongs to, or null when the key is not one of ours. */
export const activationOf = (key: readonly unknown[]): number | null => {
  if (key[0] !== SCOPE_ROOT) return null;

  const activation = key[1];

  return typeof activation === 'number' ? activation : null;
};

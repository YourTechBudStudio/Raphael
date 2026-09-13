import type { ContainerRef, ContainerType } from '../../infrastructure/api/contracts';

/**
 * Turning route parameters into container references.
 *
 * A route parameter is a string that arrived from outside: a deep link, a restored navigation
 * state, a link copied from a different server. Ids are numeric now, and `Number` is far too
 * willing - it accepts `'3.5'`, `' 3 '`, `'0x10'`, `'1e400'`, and answers `NaN` for the rest - so
 * the shape is checked before the conversion rather than after it. Anything that is not a positive
 * safe integer names no container, and a caller renders "not here" instead of asking the server
 * about `NaN`.
 *
 * Split from the route helpers so it can be tested without a router.
 */

export function parseNodeId(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return null;

  const id = Number(value);

  return Number.isSafeInteger(id) ? id : null;
}

const isContainerType = (value: string | undefined): value is ContainerType =>
  value === 'area' || value === 'project';

/**
 * A container reference out of route params, for the routes that take one as context: a search
 * scope, or the location Browse marks as current. Anything that is not one reads as "none" rather
 * than as an error, because a stale link is not the reader's mistake.
 */
export function parseContainerRef(
  type: string | undefined,
  id: string | undefined,
): ContainerRef | null {
  const parsed = parseNodeId(id);

  return parsed === null || !isContainerType(type) ? null : { type, id: parsed };
}

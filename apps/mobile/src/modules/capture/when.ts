/**
 * How long ago something happened, said the way a person would say it.
 *
 * Coarse on purpose. A card is read at a glance and "2 h ago" is what someone needs; a timestamp to
 * the second would be precision about a moment that does not matter, and a ticking relative time
 * would be a timer running for three days to change one label. Anything older than a week is a date,
 * because "9 days ago" is harder to place than "12 Sep".
 *
 * Pure, and takes `now`, so it can be tested and so a screen samples the clock once per render
 * rather than reading it inside a loop over cards.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const since = (at: number, now: number): string => {
  const elapsed = now - at;

  // A clock that has moved backwards is not a note from the future. Saying "just now" is the
  // smallest claim available and is the one that cannot be wrong in an interesting way.
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))} min ago`;
  if (elapsed < DAY) return `${String(Math.floor(elapsed / HOUR))} h ago`;
  if (elapsed < WEEK) return `${String(Math.floor(elapsed / DAY))} d ago`;

  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

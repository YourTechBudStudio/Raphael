/**
 * The one notion of "the same tags", shared by both owners.
 *
 * Element-wise, because `tags` is the one authored field that is not a string and `===` on an array
 * is reference identity. A tag sheet rebuilds its array on every commit, so an identity test would
 * call every no-op edit a change: a protection version bumped, a row written to SQLite, and - for an
 * edit - the debounce armed and an empty diff acknowledged locally. Correct, and a durable write for
 * nothing.
 *
 * It also has to agree with the edit envelope's `diff`, which compares tags by membership. Two halves
 * of one question answered by two notions of equality is how "nothing changed" and "nothing to send"
 * drift apart.
 *
 * Here rather than inside either owner: both ask it, and neither owns a rule they share.
 */
export const sameTags = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((tag, index) => tag === right[index]);

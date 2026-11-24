/**
 * The state column of a row: fixed words, so a script can match them and a title cannot imitate them.
 *
 * One home for the words, used by the row renderer and by the output help that lists them, so the
 * help cannot describe a word the rows never print.
 */

/** Every word the state column can hold, in the order help lists them. */
export const STATE_WORDS = {
  neither: '-',
  active: 'active',
  archived: 'archived',
  both: 'active,archived',
} as const;

/** An item's state word: whether it is an active project, and whether it is archived. */
export const stateLabel = (item: {
  readonly active: boolean;
  readonly archived: boolean;
}): string =>
  item.active && item.archived
    ? STATE_WORDS.both
    : item.active
      ? STATE_WORDS.active
      : item.archived
        ? STATE_WORDS.archived
        : STATE_WORDS.neither;

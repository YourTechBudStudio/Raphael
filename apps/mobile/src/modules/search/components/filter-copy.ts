/**
 * What to fix about the tags, in this app's words.
 *
 * The contract owns the verdict and this owns the sentence - the division `describeQueryRejection`
 * already makes for a query, except that tags have no contract-side sentence, because the four
 * reasons are about a list this screen assembled rather than about text someone typed.
 *
 * It sits beside the components rather than inside one because two of them say it: the filter sheet,
 * where the tag was added, and the screen behind it, which the sheet covers. One verdict, one
 * sentence, read in whichever place the person is actually looking.
 *
 * The bounds fall back to the contract's own constants rather than to a placeholder, as
 * `describeQueryRejection` does for a query: `inspectTagsInput` always carries the limit it broke,
 * and if a later one ever does not, the sentence must still name the real bound instead of naming
 * zero.
 */

import { TAGS_MAX_COUNT, TAG_MAX_CODE_POINTS, type TagsRejection } from '@raphael/contracts/nodes';

export const describeTagsRejection = (rejection: TagsRejection): string => {
  switch (rejection.reason) {
    case 'tag_empty':
      return 'A tag needs at least one character.';
    case 'tag_too_long':
      return `A tag can be at most ${String(rejection.limit ?? TAG_MAX_CODE_POINTS)} characters.`;
    case 'tags_too_many':
      return `Filter by at most ${String(rejection.limit ?? TAGS_MAX_COUNT)} tags at a time.`;
    case 'tags_repeat':
      return 'The same tag is in the filter twice.';
  }
};

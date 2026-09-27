/**
 * What a star says when its change did not go through. Pure, so every branch is tested under node.
 *
 * One refusal sentence for every star, headers and Favorites rows alike, so the same failure never
 * reads two ways. The unconfirmed sentence does not guess: the change may have landed, so it says
 * only what the star is showing.
 */

import type { FavoriteFailure } from './client/toggle.ts';

export const FAVORITE_FAILED_SENTENCE = 'Favorite did not update. Try again.';

export const FAVORITE_UNCONFIRMED_SENTENCE =
  'Could not confirm the favorite change. The star shows what Raphael last said.';

/** The sentence under a star for its control's last write, or null when there is nothing to say. */
export const favoriteFailureSentence = (failure: FavoriteFailure): string | null => {
  switch (failure) {
    case 'failed':
      return FAVORITE_FAILED_SENTENCE;
    case 'unconfirmed':
      return FAVORITE_UNCONFIRMED_SENTENCE;
    case null:
      return null;
  }
};

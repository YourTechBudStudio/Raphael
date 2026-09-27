/**
 * Favorites as the phone reads and writes them: the star's behavior and the paged favorites list.
 *
 * It renders nothing, and depends on no screen module. `collections` draws the star on its headers
 * and `browse` draws the list, so reaching either would be a cycle - the reason `lifecycle` stands
 * apart too. `capture` and `search` do not use it: notes cannot be favorites, and search rows carry
 * no star.
 */

export {
  useFavoriteToggle,
  type FavoriteFailure,
  type FavoriteRead,
  type FavoriteToggle,
} from './client/toggle';
export {
  useFavoritePages,
  type FavoriteItem,
  type FavoriteNode,
  type FavoritePages,
} from './client/list';
export {
  FAVORITE_FAILED_SENTENCE,
  FAVORITE_UNCONFIRMED_SENTENCE,
  favoriteFailureSentence,
} from './copy';

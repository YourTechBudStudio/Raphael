/**
 * The hierarchy capability. Each operation takes an undecoded request, because it is the only
 * validation boundary, and fails only with tagged errors.
 */

export { archiveNode, restoreNode } from './archive.ts';
export { createNode } from './create.ts';
export { addFavorite, listFavorites, removeFavorite } from './favorites.ts';
export { getNode } from './get.ts';
export { getNodePath } from './get-path.ts';
export { listNodes } from './list.ts';
export { moveNode } from './move.ts';
export { searchNodes } from './search.ts';
export { updateNode } from './update.ts';

export {
  InternalFailure,
  InvalidInput,
  InvalidParent,
  NodeArchived,
  NodeNotFound,
  RevisionConflict,
  SlugConflict,
  UnsupportedContent,
  toPublicError,
  type InvalidInputReason,
  type NodeError,
  type PublicApiError,
  type RequestField,
  type SelectorField,
} from './errors.ts';

/** Public because `InvalidParent` names a type; the table declarations stay private. */
export { type NodeType, type ResourceKind } from './types.ts';

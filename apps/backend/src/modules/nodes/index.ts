/**
 * The hierarchy capability.
 *
 * Twelve operations, each taking an undecoded request and returning an Effect whose failures are all
 * expected and tagged. Callers do not resolve selectors, open transactions, convert
 * content, or decide what a SQLite error meant - every one of those is settled behind this boundary.
 *
 * Requests arrive as `unknown` on purpose. This is the only validation boundary for an operation, so
 * there is no "already validated" entry point an internal caller could use to skip the rules. The
 * transport above owns authentication, JSON parsing, the byte budget, routing, and turning a public
 * error into a status; it does not re-decode what these operations decode.
 *
 * Not here, by intent: no HTTP or configuration objects, no delete, no users, no hook delivery.
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
  StorageBusy,
  UnsupportedContent,
  toPublicError,
  type InvalidInputReason,
  type NodeError,
  type PublicApiError,
  type RequestField,
  type SelectorField,
} from './errors.ts';

/**
 * The stored-type union is part of the error contract - `InvalidParent` names the parent type that
 * refused the child - so the type is public while the table declarations and the integer bound stay
 * private. Migration tooling reads `schema.ts` by path, and the tests that assert
 * storage behavior import it directly; nothing outside this capability needs to name its tables, and a
 * runtime that could would be able to write past every rule enforced here.
 */
export { type NodeType, type ResourceKind } from './types.ts';

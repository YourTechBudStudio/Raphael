/**
 * What an entity's body is, as something the editor can open.
 *
 * Its home is here rather than in `resources` because the editor is now its only consumer: opening an
 * entity is editing it, so there is no read-only note view left to ask the question. Phase 07 moves
 * the rest of that file here - the failure classification and the fatal-problem test - and deletes the
 * `resources` copy; this build holds the one function `contentOf` needs.
 *
 * **The note-only check is deliberately gone.** `resources` asked whether the entity was a `resource`
 * of kind `note`, because only notes had a screen. Containers are edited by the same editor now, so a
 * type check here would refuse an area whose body is perfectly displayable.
 *
 * `findDocumentFailure` is the DOM-free half of `@raphael/content` - the same allowlist the browser
 * half and the server use - so this is not a second opinion about what a valid document is. It is
 * necessary and not sufficient: the content model, such as a heading inside a code block, is enforced
 * only by the full schema, which runs in the browser.
 */

import { findDocumentFailure } from '@raphael/content/validation';
import type { NodeEntity } from '@raphael/contracts/nodes';

/**
 * The document this body is, or null when it is not one this build can display.
 *
 * Takes the body rather than the entity, because that is all the question is about, and it lets a
 * caller ask it of a body it is holding for some other reason.
 */
export const displayableDocument = (body: NodeEntity['body']): unknown | null => {
  if (body.format !== 'tiptap') return null;

  return findDocumentFailure(body.value) === undefined ? body.value : null;
};

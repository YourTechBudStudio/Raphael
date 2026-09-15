/**
 * The supported schema and everything that depends on it: the shared extension list, strict
 * validation, canonical serialization, and plain-text derivation.
 *
 * Markdown conversion deliberately does not live here, so a consumer that needs the schema — the
 * editor later — does not pull a Markdown parser with it.
 */

export { contentExtensions } from './extensions.ts';
export { canonicalizeDocument, contentSchema, emptyDocument } from './canonicalize.ts';
export { deriveText } from './text.ts';
/**
 * Structural validation lives in `@raphael/content/validation`, which has no ProseMirror or DOM
 * dependency. It is re-exported here so a caller that already holds the schema entry point does not
 * need a second import for one allowlist; there is no second implementation behind these names.
 */
export {
  CODE_LANGUAGE,
  LINK_HREF_MAX_CODE_POINTS,
  findDocumentFailure,
  inspectDocumentTransport,
  isAllowedHref,
} from '../validation/index.ts';

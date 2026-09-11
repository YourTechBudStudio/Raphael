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
export { CODE_LANGUAGE, findDocumentFailure } from './validate.ts';
export { LINK_HREF_MAX_CODE_POINTS, isAllowedHref } from './url.ts';

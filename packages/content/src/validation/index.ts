/**
 * Structural document validation with no editor, ProseMirror, Markdown parser, browser or DOM
 * dependency: the transport bounds, the supported vocabulary, and the link policy.
 *
 * This is the boundary native code takes. It answers "is this document structurally acceptable",
 * which is strictly less than "is this a valid ProseMirror document": the content model — a heading
 * inside a code block, a list item outside a list — is enforced only by `@raphael/content/schema`
 * and by core. Passing here is a necessary condition, never an acceptance.
 *
 * Full canonicalization consumes exactly these checks, so there is one allowlist and one URL policy
 * in the package rather than a native copy that can drift from the server's.
 */

export { inspectDocumentTransport } from './transport.ts';
export { CODE_LANGUAGE, findDocumentFailure } from './validate.ts';
export { LINK_HREF_MAX_CODE_POINTS, isAllowedHref } from './url.ts';

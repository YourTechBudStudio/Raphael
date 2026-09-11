/**
 * The canonical body vocabulary: schema version, supported element names, the canonical empty
 * document, and the structured failure shape.
 *
 * This entry point has no runtime dependencies. Validation and Markdown conversion need ProseMirror
 * and a Markdown parser respectively, so they live behind `@raphael/content/schema` and
 * `@raphael/content/conversion`; a client that only needs to know what the vocabulary is must not
 * pay for a parser to find out. Product limits are contracts' vocabulary and are not restated here.
 */

/**
 * The supported document version. It is deliberately not stored per body: the database migration
 * version is the authority for the stored representation, and a future incompatible content change
 * migrates existing bodies before the server accepts requests. A per-body version would introduce
 * mixed-version storage, a question we have not chosen to answer.
 */
export const CONTENT_SCHEMA_VERSION = 1;

/** Block and inline node names this version supports. */
export const SUPPORTED_NODES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'blockquote',
  'horizontalRule',
  'hardBreak',
] as const;

/** Mark names this version supports. */
export const SUPPORTED_MARKS = ['bold', 'italic', 'strike', 'code', 'link'] as const;

/** Heading levels this version supports. Levels 4-6 are not canonical. */
export const SUPPORTED_HEADING_LEVELS = [1, 2, 3] as const;

export type SupportedNode = (typeof SUPPORTED_NODES)[number];
export type SupportedMark = (typeof SUPPORTED_MARKS)[number];

/**
 * A document that has been validated and canonically serialized. The brand prevents accidental
 * TypeScript misuse; it is ergonomics, not a runtime or security boundary. Entry points accepting
 * `unknown` validate before extraction.
 */
export type CanonicalDocument = {
  readonly type: 'doc';
  readonly content: readonly unknown[];
} & { readonly __canonical: unique symbol };

/**
 * The canonical empty document: one empty paragraph. An omitted body, an empty Markdown string, and
 * a whitespace-only Markdown string all produce this. A fresh value is returned each time so no
 * caller can mutate a shared one.
 */
export const createEmptyDocument = (): CanonicalDocument =>
  ({ type: 'doc', content: [{ type: 'paragraph' }] }) as unknown as CanonicalDocument;

export {
  CONTENT_FAILURE_REASONS,
  FAILURE_PATH_MAX_SEGMENTS,
  contentFailure,
  describeContentFailure,
  type ContentFailure,
  type ContentFailureReason,
} from './failures.ts';

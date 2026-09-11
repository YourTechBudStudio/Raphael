/**
 * Structured content failures. These are transport-neutral: core decides which API error code each
 * reason becomes, and this package never mentions HTTP.
 *
 * Diagnostics deliberately carry a reason and a bounded structural location, never submitted
 * content. Node and mark names appear only when they are elements of our own supported vocabulary;
 * a name we do not recognize is attacker-controlled input and is omitted rather than reflected,
 * because "it matched an identifier pattern" is not a privacy argument.
 */

export const CONTENT_FAILURE_REASONS = [
  'invalid_json',
  'unsupported_node',
  'unsupported_mark',
  'unsupported_attribute',
  'invalid_attribute_value',
  'invalid_text',
  'duplicate_mark',
  'invalid_link',
  'invalid_document',
  'document_too_deep',
  'document_too_many_nodes',
  'document_too_complex',
  'markdown_too_large',
] as const;

export type ContentFailureReason = (typeof CONTENT_FAILURE_REASONS)[number];

/** How deep a reported location may be before it is truncated; locations are diagnostics, not paths. */
export const FAILURE_PATH_MAX_SEGMENTS = 16;

export interface ContentFailure {
  readonly reason: ContentFailureReason;
  /** Child indices from the document root. Truncated to `FAILURE_PATH_MAX_SEGMENTS`. */
  readonly path: readonly number[];
  /** Present only for elements of our own supported vocabulary. */
  readonly element?: string;
  /** The bound that was exceeded, when the reason is a limit. */
  readonly limit?: number;
}

export const contentFailure = (
  reason: ContentFailureReason,
  path: readonly number[] = [],
  extra: { readonly element?: string; readonly limit?: number } = {},
): ContentFailure => ({
  reason,
  path:
    path.length > FAILURE_PATH_MAX_SEGMENTS ? path.slice(0, FAILURE_PATH_MAX_SEGMENTS) : [...path],
  ...(extra.element === undefined ? {} : { element: extra.element }),
  ...(extra.limit === undefined ? {} : { limit: extra.limit }),
});

/** A human-readable summary safe to log: it never contains submitted content. */
export const describeContentFailure = (failure: ContentFailure): string => {
  const at =
    failure.path.length === 0 ? 'the document root' : `content[${failure.path.join('][')}]`;
  const element = failure.element === undefined ? '' : ` (${failure.element})`;
  const limit = failure.limit === undefined ? '' : ` (limit ${failure.limit})`;
  return `${failure.reason} at ${at}${element}${limit}`;
};

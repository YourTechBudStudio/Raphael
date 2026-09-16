import { inspectJsonValue } from '@raphael/contracts';
import { DOCUMENT_MAX_DEPTH, DOCUMENT_TRANSPORT_MAX_JSON_VALUES } from '@raphael/contracts/nodes';

import { contentFailure, type ContentFailure } from '../failures.ts';

/**
 * The JSON-safety and bounds pass that must run before any document walk.
 *
 * It exists separately from `canonicalizeDocument` because the vocabulary walk has no cycle
 * detection: a cyclic value would spin there forever. Depth and total value count are bounded here,
 * before anything recurses, and a caller that cannot afford ProseMirror — native, via
 * `@raphael/content/validation` — gets the same first gate rather than an approximation of it.
 */

const JSON_LIMITS = {
  maxDepth: DOCUMENT_MAX_DEPTH,
  maxValues: DOCUMENT_TRANSPORT_MAX_JSON_VALUES,
};

/** Returns the transport failure, or `undefined` when the value is safe to walk. */
export const inspectDocumentTransport = (input: unknown): ContentFailure | undefined => {
  const rejection = inspectJsonValue(input, JSON_LIMITS);
  if (rejection === undefined) return undefined;
  if (rejection.reason === 'too_deep') {
    return contentFailure('document_too_deep', [], { limit: DOCUMENT_MAX_DEPTH });
  }
  if (rejection.reason === 'too_many_values') {
    // Not the same measurement as document nodes, so it gets its own honest reason rather than
    // borrowing the node-count one or hiding behind "invalid JSON".
    return contentFailure('document_too_complex', [], {
      limit: DOCUMENT_TRANSPORT_MAX_JSON_VALUES,
    });
  }
  return contentFailure('invalid_json');
};

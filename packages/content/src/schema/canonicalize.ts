import { getSchema } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Schema } from '@tiptap/pm/model';
import { Either } from 'effect';

import { contentFailure, type ContentFailure } from '../failures.ts';
import { createEmptyDocument, type CanonicalDocument } from '../index.ts';
import { findDocumentFailure, inspectDocumentTransport } from '../validation/index.ts';
import { contentExtensions } from './extensions.ts';
import { normalizeHardBreakPlacement } from './hard-breaks.ts';
import { normalizeMarkBoundaries } from './mark-boundaries.ts';

/** Built once: a ProseMirror schema is immutable and safe to share. */
export const contentSchema: Schema = getSchema(contentExtensions());

/**
 * Validates a document and returns its canonical serialization.
 *
 * The order matters and is not an implementation detail:
 *
 * 1. JSON safety and depth, so nothing unbounded reaches a recursive call.
 * 2. Strict vocabulary validation, while unsupported data still exists to be rejected.
 * 3. Normalization of what gets stored: hard-break placement, then mark boundaries. Both rewrite
 *    documents into a form CommonMark can express, and both run *after* validation so that what is
 *    judged is what was submitted rather than something this function wrote.
 * 4. ProseMirror deserialization and `check()`, which enforces the content model.
 * 5. `toJSON()`, whose output is what we store.
 *
 * Step 5 normalizes further: it inserts schema default attributes and merges adjacent text nodes
 * carrying identical marks. That is canonical serialization, not discarded authored data. The result is what
 * callers store; it is never the request fingerprint, which is computed from the normalized request
 * so that two different inputs converging on one document still conflict under one idempotency key.
 */
export const canonicalizeDocument = (
  input: unknown,
): Either.Either<CanonicalDocument, ContentFailure> => {
  // JSON safety runs first because the vocabulary walk has no cycle detection: a cyclic value would
  // spin there forever. This pass also bounds depth and total values before anything recurses, and
  // it is the same one `@raphael/content/validation` gives native callers.
  const transportRejection = inspectDocumentTransport(input);
  if (transportRejection !== undefined) return Either.left(transportRejection);

  const failure = findDocumentFailure(input);
  if (failure !== undefined) return Either.left(failure);

  // Validation judges what was submitted; these rewrite what gets stored.
  //
  // Hard-break placement runs first: a break that ends a block is dropped and a break inside a
  // heading becomes a space, because neither placement has a CommonMark encoding and export would
  // otherwise return different content and structure on every read. Mark boundaries run on that
  // result, so a space standing in for a break is subject to the same emphasis rule as any other.
  const placed = normalizeHardBreakPlacement(input);
  // Emphasis never begins or ends with whitespace — a span CommonMark cannot express once anything
  // precedes it.
  const normalized = normalizeMarkBoundaries(placed);

  let node: ProseMirrorNode;
  try {
    node = ProseMirrorNode.fromJSON(contentSchema, normalized);
    node.check();
  } catch {
    // The vocabulary is already known-good, so this is a content-model violation: a heading inside a
    // code block, a list item outside a list. The parser's message is not forwarded.
    return Either.left(contentFailure('invalid_document'));
  }

  // ProseMirror emits `attrs` with a null prototype. That serializes identically but is a surprising
  // value to hand a caller: ordinary deep comparisons and prototype-based checks behave differently
  // on it. The canonical document is described as JSON, so it is returned as plain JSON.
  const canonical = JSON.parse(JSON.stringify(node.toJSON())) as CanonicalDocument;

  // The result is validated again, because canonicalization is not size-preserving: moving
  // whitespace out of an emphasis mark splits one text node into as many as three, so a document
  // that was inside the node limit on submission can leave canonicalization outside it. Checking the
  // input alone would let this boundary hand back a "canonical" document it would itself refuse.
  //
  // The invariant is that a returned document is always acceptable to this boundary, which also
  // makes canonicalization idempotent. The second walk is bounded by the node limit it enforces.
  const expansionFailure = findDocumentFailure(canonical);
  if (expansionFailure !== undefined) return Either.left(expansionFailure);

  return Either.right(canonical);
};

/** The canonical empty document, validated through the same boundary as any other document. */
export const emptyDocument = (): CanonicalDocument => createEmptyDocument();

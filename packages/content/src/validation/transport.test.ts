import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DOCUMENT_MAX_DEPTH, DOCUMENT_TRANSPORT_MAX_JSON_VALUES } from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { canonicalizeDocument } from '../schema/canonicalize.ts';
import { inspectDocumentTransport } from './transport.ts';

/**
 * The transport gate is now a named boundary rather than the first paragraph of canonicalization, so
 * it is tested on its own terms: the reasons and limits it reports, and the fact that
 * canonicalization still refuses exactly what this refuses. It answers a narrower question than
 * `findDocumentFailure` — is this value safe to walk at all — and neither answers the content model.
 */

const nest = (depth: number): unknown => {
  let value: unknown = { type: 'paragraph' };
  for (let level = 0; level < depth; level += 1) value = { type: 'doc', content: [value] };
  return value;
};

describe('inspectDocumentTransport', () => {
  it('accepts an ordinary document', () => {
    assert.equal(
      inspectDocumentTransport({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      }),
      undefined,
    );
  });

  it('accepts a value it is not the judge of', () => {
    // It bounds the shape of a JSON value; whether the value is a document is a later question.
    assert.equal(inspectDocumentTransport({ type: 'not-a-doc' }), undefined);
    assert.equal(inspectDocumentTransport(42), undefined);
  });

  it('reports depth with the depth limit', () => {
    const failure = inspectDocumentTransport(nest(DOCUMENT_MAX_DEPTH + 2));
    assert.equal(failure?.reason, 'document_too_deep');
    assert.equal(failure?.limit, DOCUMENT_MAX_DEPTH);
  });

  it('reports value count with its own reason rather than the node-count one', () => {
    // Values are not nodes. Borrowing `document_too_many_nodes` here would name a limit the author
    // did not exceed and send them after the wrong correction.
    const wide = {
      type: 'doc',
      content: Array.from({ length: DOCUMENT_TRANSPORT_MAX_JSON_VALUES }, () => ({
        type: 'paragraph',
      })),
    };
    const failure = inspectDocumentTransport(wide);
    assert.equal(failure?.reason, 'document_too_complex');
    assert.equal(failure?.limit, DOCUMENT_TRANSPORT_MAX_JSON_VALUES);
  });

  it('rejects values JSON cannot carry', () => {
    assert.equal(inspectDocumentTransport(undefined)?.reason, 'invalid_json');
    assert.equal(
      inspectDocumentTransport({ type: 'doc', content: [() => 1] })?.reason,
      'invalid_json',
    );
    assert.equal(inspectDocumentTransport({ type: 'doc', n: Number.NaN })?.reason, 'invalid_json');
  });

  it('rejects a cycle, which is why it runs before the vocabulary walk', () => {
    // The vocabulary walk has no cycle detection and would spin here forever.
    const cyclic: Record<string, unknown> = { type: 'doc' };
    cyclic['content'] = [cyclic];
    assert.equal(inspectDocumentTransport(cyclic)?.reason, 'invalid_json');
  });

  it('is the same gate canonicalization runs first', () => {
    for (const input of [nest(DOCUMENT_MAX_DEPTH + 2), undefined, Number.NaN]) {
      const direct = inspectDocumentTransport(input);
      const canonical = canonicalizeDocument(input);
      assert.ok(direct !== undefined, 'expected the transport gate to refuse');
      assert.ok(Either.isLeft(canonical));
      assert.deepEqual(canonical.left, direct);
    }
  });
});

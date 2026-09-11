import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import { createEmptyDocument } from '../index.ts';
import { canonicalizeDocument } from './canonicalize.ts';

const doc = (...content: unknown[]): unknown => ({ type: 'doc', content });
const para = (...content: unknown[]): unknown => ({ type: 'paragraph', content });
const text = (value: string, marks?: unknown[]): unknown =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };

const canonical = (input: unknown): unknown => {
  const result = canonicalizeDocument(input);
  assert.ok(Either.isRight(result), `expected a canonical document, got ${JSON.stringify(result)}`);
  return result.right;
};

const failure = (input: unknown): { reason: string; element?: string } => {
  const result = canonicalizeDocument(input);
  assert.ok(Either.isLeft(result), `expected a failure, got ${JSON.stringify(result)}`);
  return result.left;
};

describe('canonicalizeDocument', () => {
  it('accepts the canonical empty document', () => {
    assert.deepEqual(canonical(createEmptyDocument()), {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });

  it('rejects an unknown node without reflecting its name', () => {
    const result = failure(doc({ type: 'table', content: [] }));
    assert.equal(result.reason, 'unsupported_node');
    assert.equal(result.element, undefined);
    assert.ok(!JSON.stringify(result).includes('table'));
  });

  it('rejects an unknown mark', () => {
    assert.equal(failure(doc(para(text('x', [{ type: 'highlight' }])))).reason, 'unsupported_mark');
  });

  it('returns plain JSON, not objects with a null prototype', () => {
    const result = canonical(
      doc({ type: 'heading', attrs: { level: 1 }, content: [text('h')] }),
    ) as {
      content: { attrs: object }[];
    };
    const attrs = result.content[0]?.attrs;
    assert.equal(Object.getPrototypeOf(attrs), Object.prototype);
  });

  it('rejects an unknown attribute instead of silently dropping it', () => {
    // ProseMirror would discard `evil` without complaint, which is why validation runs first.
    const result = failure(doc({ type: 'paragraph', attrs: { evil: 'x' }, content: [] }));
    assert.equal(result.reason, 'unsupported_attribute');
  });

  it('rejects an out-of-range heading level that ProseMirror would accept', () => {
    const result = failure(doc({ type: 'heading', attrs: { level: 6 }, content: [text('h')] }));
    assert.equal(result.reason, 'invalid_attribute_value');
    assert.equal(result.element, 'heading.level');
  });

  it('accepts supported heading levels', () => {
    for (const level of [1, 2, 3]) {
      assert.deepEqual(
        canonical(doc({ type: 'heading', attrs: { level }, content: [text('h')] })),
        {
          type: 'doc',
          content: [{ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'h' }] }],
        },
      );
    }
  });

  it('rejects duplicate marks', () => {
    const result = failure(doc(para(text('x', [{ type: 'bold' }, { type: 'bold' }]))));
    assert.equal(result.reason, 'duplicate_mark');
    assert.equal(result.element, 'bold');
  });

  it('rejects a code-block language that is not a bare language token', () => {
    const result = failure(
      doc({ type: 'codeBlock', attrs: { language: 'js title="a.js"' }, content: [text('x')] }),
    );
    assert.equal(result.element, 'codeBlock.language');
  });

  describe('link policy', () => {
    const linked = (href: unknown): unknown =>
      doc(para(text('x', [{ type: 'link', attrs: { href } }])));

    for (const href of ['https://example.com', 'http://example.com/a?b=c#d', 'mailto:a@b.com']) {
      it(`accepts ${href}`, () => {
        assert.ok(Either.isRight(canonicalizeDocument(linked(href))));
      });
    }

    for (const [label, href] of [
      ['javascript', 'javascript:alert(1)'],
      ['data', 'data:text/html,<script>alert(1)</script>'],
      ['file', 'file:///etc/passwd'],
      ['relative', '/work/api-design'],
      ['protocol-relative', '//example.com'],
      ['credentials', 'https://user:pw@example.com'],
      ['tab obfuscated', 'java\tscript:alert(1)'],
      ['empty', ''],
      ['null', null],
    ] as const) {
      it(`rejects a ${label} href`, () => {
        const result = failure(linked(href));
        assert.equal(result.reason, 'invalid_link');
        // The rejected destination is never echoed back in diagnostics.
        assert.ok(!JSON.stringify(result).includes('alert'));
      });
    }
  });

  it('merges adjacent text nodes carrying identical marks', () => {
    const result = canonical(doc(para(text('a'), text('b')))) as {
      content: { content: unknown[] }[];
    };
    assert.deepEqual(result.content[0]?.content, [{ type: 'text', text: 'ab' }]);
  });

  it('rejects a document that violates the content model', () => {
    // A list item outside a list: vocabulary is fine, structure is not.
    assert.equal(
      failure(doc({ type: 'listItem', content: [para(text('x'))] })).reason,
      'invalid_document',
    );
  });

  it('rejects a document nested past the depth limit', () => {
    let node: unknown = para(text('x'));
    for (let index = 0; index < 40; index += 1) node = { type: 'blockquote', content: [node] };
    assert.equal(failure(doc(node)).reason, 'document_too_deep');
  });

  it('rejects a document with too many nodes', () => {
    const many = Array.from({ length: 10_001 }, () => para(text('x')));
    const result = failure(doc(...many));
    assert.equal(result.reason, 'document_too_many_nodes');
    assert.equal(result.limit, 10_000);
  });

  it('rejects values a JSON parser could not have produced', () => {
    assert.equal(
      failure(doc(para({ type: 'text', text: 'x', marks: undefined }))).reason,
      'invalid_json',
    );
    const cyclic: Record<string, unknown> = { type: 'doc' };
    cyclic['content'] = [cyclic];
    assert.equal(failure(cyclic).reason, 'invalid_json');
  });

  it('is idempotent: canonicalizing a canonical document changes nothing', () => {
    const once = canonical(doc(para(text('a', [{ type: 'bold' }])), { type: 'horizontalRule' }));
    assert.deepEqual(canonical(once), once);
  });

  describe('the boundary never returns a document it would refuse', () => {
    const nodeCount = (value: unknown): number => {
      let nodes = 0;
      const stack: unknown[] = [value];
      while (stack.length > 0) {
        const node = stack.pop();
        if (typeof node !== 'object' || node === null) continue;
        nodes += 1;
        const content = (node as { content?: unknown }).content;
        if (Array.isArray(content)) for (const child of content) stack.push(child);
      }
      return nodes;
    };

    const emphasisedParagraphs = (count: number): unknown =>
      doc(
        ...Array.from({ length: count }, () => ({
          type: 'paragraph',
          content: [{ type: 'text', text: ' x ', marks: [{ type: 'bold' }] }],
        })),
      );

    it('rejects input whose canonical form would exceed the node limit', () => {
      // Moving whitespace out of emphasis splits one text node into three, so canonicalization is
      // not size-preserving and a document inside the limit on submission can leave it outside.
      const input = emphasisedParagraphs(3_000);
      assert.ok(nodeCount(input) < 10_000, 'the submitted document should be within the limit');
      const result = failure(input);
      assert.equal(result.reason, 'document_too_many_nodes');
      assert.equal(result.limit, 10_000);
    });

    it('accepts input whose canonical form stays within the node limit', () => {
      const result = canonical(emphasisedParagraphs(2_400));
      assert.ok(nodeCount(result) > 9_000, 'expected the expansion to be exercised');
      assert.ok(nodeCount(result) <= 10_000);
    });

    it('returns documents that survive a second canonicalization unchanged', () => {
      const documents: unknown[] = [
        emphasisedParagraphs(2_400),
        doc(para(text('x'), text(' y ', [{ type: 'bold' }]), text('z'))),
        doc(para(text('  a  ', [{ type: 'italic' }]))),
        doc(para(text('only ', [{ type: 'strike' }]), text('text'))),
        doc(para(text(' l ', [{ type: 'link', attrs: { href: 'https://e.com' } }]))),
        doc({ type: 'blockquote', content: [para(text(' q ', [{ type: 'bold' }]))] }),
        doc({
          type: 'bulletList',
          content: [{ type: 'listItem', content: [para(text(' i ', [{ type: 'bold' }]))] }],
        }),
      ];
      for (const input of documents) {
        const once = canonical(input);
        assert.deepEqual(canonical(once), once, 'a returned canonical document changed on reuse');
      }
    });
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeCreateRequest } from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { canonicalRequestJson, fingerprintOf, prepareCreate } from './fingerprint.ts';

/** Decodes and normalizes, the way the operation does, so the tests exercise the real pipeline. */
const prepare = (request: Record<string, unknown>) => {
  const decoded = decodeCreateRequest({
    type: 'project',
    parent: { path: '/work' },
    title: 'Quarterly plan',
    ...request,
  });
  if (Either.isLeft(decoded))
    throw new Error(`the fixture did not decode: ${decoded.left.message}`);
  return prepareCreate(decoded.right);
};

const fingerprint = (request: Record<string, unknown> = {}) => fingerprintOf(prepare(request));

test('the same request fingerprints identically every time', () => {
  assert.equal(fingerprint(), fingerprint());
  assert.match(fingerprint(), /^[0-9a-f]{64}$/);
});

test('omitted fields and their explicit defaults are one request', () => {
  const base = fingerprint();
  assert.equal(base, fingerprint({ description: '' }));
  assert.equal(base, fingerprint({ tags: [] }));
  assert.equal(base, fingerprint({ metadata: {} }));
  assert.equal(base, fingerprint({ format: 'markdown' }));
  assert.equal(base, fingerprint({ body: { value: '' } }));
  assert.equal(base, fingerprint({ body: { format: 'markdown', value: '' } }));
  assert.equal(
    base,
    fingerprint({ slug: 'quarterly-plan' }),
    'a derived and equal explicit slug agree',
  );
  assert.equal(base, fingerprint({ title: '  Quarterly plan  ' }), 'the title is trimmed first');
});

test('deliberately different requests do not collide', () => {
  const base = fingerprint();
  const different: readonly Record<string, unknown>[] = [
    { type: 'area' },
    { parent: { id: 1 } },
    { title: 'Quarterly Plan' },
    { slug: 'other-address' },
    { description: 'x' },
    { tags: ['a'] },
    { metadata: { a: 1 } },
    { format: 'tiptap' },
    { body: { value: ' ' } },
    { body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'paragraph' }] } } },
  ];
  for (const overrides of different) {
    assert.notEqual(fingerprint(overrides), base, JSON.stringify(overrides));
  }
});

test('the idempotency key is not part of the request it identifies', () => {
  assert.equal(fingerprint({ idempotencyKey: 'one' }), fingerprint({ idempotencyKey: 'two' }));
  assert.equal(fingerprint({ idempotencyKey: 'one' }), fingerprint());
});

test('tag order is significant, and object key order is not', () => {
  assert.notEqual(fingerprint({ tags: ['a', 'b'] }), fingerprint({ tags: ['b', 'a'] }));
  assert.equal(
    fingerprint({ metadata: { a: 1, b: 2 } }),
    fingerprint({ metadata: { b: 2, a: 1 } }),
    'a JSON object has no order, so two spellings of one object are one request',
  );
});

test('object keys are sorted without ever being assigned to an object', () => {
  // `__proto__` is an ordinary own property on a JSON-parsed object and must survive as data. Sorting
  // keys into an intermediate object would either lose it or mutate a prototype; the canonical form is
  // written as a string, so there is nothing to assign to.
  const metadata = JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}') as Record<
    string,
    unknown
  >;
  const canonical = canonicalRequestJson(prepare({ metadata }));

  assert.match(canonical, /"metadata":\{"__proto__":\{"polluted":true\},"a":2,"z":1\}/);
  assert.equal(
    ({} as Record<string, unknown>)['polluted'],
    undefined,
    'fingerprinting must not have touched Object.prototype',
  );
  assert.notEqual(fingerprint({ metadata }), fingerprint({ metadata: { z: 1, a: 2 } }));
});

test('nested object keys are sorted at every level', () => {
  assert.equal(
    fingerprint({ metadata: { outer: { b: 1, a: { d: 1, c: 2 } } } }),
    fingerprint({ metadata: { outer: { a: { c: 2, d: 1 }, b: 1 } } }),
  );
});

test('strings are escaped by the serializer rather than interpolated', () => {
  const canonical = canonicalRequestJson(prepare({ description: 'a "quote", a \\ and a \n' }));
  assert.match(canonical, /"description":"a \\"quote\\", a \\\\ and a \\n"/);
  assert.equal(
    JSON.parse(canonical).description,
    'a "quote", a \\ and a \n',
    'it is still valid JSON',
  );
});

test('a submitted TipTap body participates as submitted, not as it would be stored', () => {
  // Canonicalization inserts default attributes, so the stored document differs from this input. The
  // fingerprint must reflect the input: two submissions that converge on one stored body are still two
  // different requests under one key.
  const submitted = fingerprint({
    body: {
      format: 'tiptap',
      value: {
        type: 'doc',
        content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }],
      },
    },
  });
  const canonicalForm = fingerprint({
    body: {
      format: 'tiptap',
      value: {
        type: 'doc',
        content: [
          { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x' }] },
        ],
      },
    },
  });
  assert.notEqual(submitted, canonicalForm);
});

test('the canonical form carries no timestamp or generated identity', () => {
  const canonical = canonicalRequestJson(prepare({ idempotencyKey: 'k' }));
  for (const absent of ['idempotencyKey', 'createdAt', 'updatedAt', 'id', 'revision']) {
    assert.equal(canonical.includes(absent), false, `${absent} must not be fingerprinted`);
  }
  assert.deepEqual(Object.keys(JSON.parse(canonical)).sort(), [
    'body',
    'description',
    'format',
    'metadata',
    'parent',
    'slug',
    'tags',
    'title',
    'type',
  ]);
});

test('preparation detaches the values the decoder hands through by reference', () => {
  const metadata = { nested: { value: 'original' } };
  const tags = ['first'];
  const body = {
    format: 'tiptap' as const,
    value: { type: 'doc', content: [{ type: 'paragraph' }] },
  };
  const prepared = prepare({ metadata, tags, body });
  const before = fingerprintOf(prepared);

  metadata.nested.value = 'mutated';
  tags.push('second');
  (body.value.content as Record<string, unknown>[]).push({ type: 'paragraph' });

  assert.deepEqual(prepared.metadata, { nested: { value: 'original' } });
  assert.deepEqual(prepared.tags, ['first']);
  assert.deepEqual(prepared.body.value, { type: 'doc', content: [{ type: 'paragraph' }] });
  assert.equal(
    fingerprintOf(prepared),
    before,
    'the prepared request is the one that was fingerprinted',
  );
});

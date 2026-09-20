import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import { TAGS_MAX_COUNT, TAG_MAX_CODE_POINTS } from './fields.ts';
import {
  FILTER_KEYS,
  NodeFilter,
  describeFilterRejection,
  inspectFilterInput,
  type FilterRejectionReason,
} from './filter.ts';

const decode = Schema.decodeUnknownEither(NodeFilter);

const accepts = (value: unknown): boolean => Either.isRight(decode(value));

test('each key accepts a scalar and the $in of one', () => {
  for (const value of [
    { type: 'area' },
    { type: { $in: ['area', 'project'] } },
    { kind: 'note' },
    { kind: { $in: ['note'] } },
    { tags: 'backend' },
    { tags: { $in: ['backend', 'auth'] } },
    { type: 'resource', kind: 'note', tags: { $in: ['backend'] } },
    {},
  ]) {
    assert.ok(accepts(value), `expected ${JSON.stringify(value)} to be accepted`);
  }
});

test('the closed vocabulary is closed', () => {
  assert.equal(inspectFilterInput({ metadata: { x: 1 } })?.reason, 'unsupported_key');
  assert.equal(inspectFilterInput({ 'metadata.x': 1 })?.reason, 'unsupported_key');
  assert.equal(inspectFilterInput({ type: 'area', active: true })?.reason, 'unsupported_key');
  assert.deepEqual(inspectFilterInput({ type: { $nin: ['area'] } }), {
    reason: 'unsupported_operator',
    key: 'type',
  });
  assert.deepEqual(inspectFilterInput({ tags: { $all: ['a'] } }), {
    reason: 'unsupported_operator',
    key: 'tags',
  });
  assert.deepEqual(inspectFilterInput({ kind: {} }), {
    reason: 'unsupported_operator',
    key: 'kind',
  });
  assert.deepEqual(inspectFilterInput({ type: { $in: ['area'], extra: 1 } }), {
    reason: 'unsupported_operator',
    key: 'type',
  });
});

test('a bare array is a bad value, not an unsupported operator', () => {
  // `{ type: ["area"] }` is the shorthand other filter languages allow. Calling it an unsupported
  // operator would name the wrong thing to whoever typed it.
  assert.deepEqual(inspectFilterInput({ type: ['area'] }), {
    reason: 'invalid_value',
    key: 'type',
  });
});

test('values are refused for the reasons the contract owns', () => {
  assert.deepEqual(inspectFilterInput({ type: 'folder' }), {
    reason: 'invalid_value',
    key: 'type',
  });
  assert.deepEqual(inspectFilterInput({ type: { $in: [] } }), {
    reason: 'invalid_value',
    key: 'type',
  });
  assert.deepEqual(inspectFilterInput({ type: { $in: ['area', 'area'] } }), {
    reason: 'invalid_value',
    key: 'type',
  });
  assert.deepEqual(inspectFilterInput({ tags: '   ' }), { reason: 'invalid_value', key: 'tags' });
  assert.deepEqual(inspectFilterInput({ tags: 'x'.repeat(TAG_MAX_CODE_POINTS + 1) }), {
    reason: 'invalid_value',
    key: 'tags',
  });
  assert.deepEqual(
    inspectFilterInput({
      tags: { $in: Array.from({ length: TAGS_MAX_COUNT + 1 }, (_, i) => `t${i}`) },
    }),
    { reason: 'invalid_value', key: 'tags' },
  );
  assert.deepEqual(inspectFilterInput({ kind: 'folder' }), {
    reason: 'invalid_value',
    key: 'kind',
  });
});

test('a filter that is not an object is refused before any key is read', () => {
  for (const value of [null, 'type', 7, true, ['type']]) {
    assert.deepEqual(inspectFilterInput(value), { reason: 'not_object' });
  }
});

test('tags normalize on decode, so a submitted tag finds a stored one', () => {
  const decoded = decode({ tags: ' Work ' });
  assert.ok(Either.isRight(decoded));
  assert.equal(decoded.right.tags, 'Work');

  const list = decode({ tags: { $in: [' backend ', 'auth'] } });
  assert.ok(Either.isRight(list));
  assert.deepEqual(list.right.tags, { $in: ['backend', 'auth'] });

  // Normalization runs before the repeat check, so two spellings of one tag are a repeat.
  assert.ok(Either.isLeft(decode({ tags: { $in: ['backend', ' backend '] } })));
});

test('inspectFilterInput agrees with the decoder on every case', () => {
  const cases: readonly unknown[] = [
    {},
    { type: 'area' },
    { type: { $in: ['area', 'project'] } },
    { kind: 'note' },
    { tags: 'backend' },
    { tags: { $in: ['backend'] } },
    { type: 'resource', kind: 'note', tags: 'auth' },
    { type: ' Work ' },
    { type: 'folder' },
    { type: ['area'] },
    { type: { $in: [] } },
    { type: { $in: ['area', 'area'] } },
    { type: { $nin: ['area'] } },
    { kind: {} },
    { tags: '' },
    { tags: 7 },
    null,
    'filter',
    ['type'],
  ];
  for (const value of cases) {
    const rejected = inspectFilterInput(value) !== undefined;
    assert.equal(
      rejected,
      !accepts(value),
      `helper and decoder disagree on ${JSON.stringify(value)}`,
    );
  }
});

test('an unknown key is refused by the decoder too, once decoding is strict', () => {
  // The helper says `unsupported_key`; strict request decoding is what actually refuses it, which is
  // why "unknown key rejects" is a property of the shape rather than a rule someone must apply.
  const strict = Schema.decodeUnknownEither(NodeFilter, { onExcessProperty: 'error' });
  assert.ok(Either.isLeft(strict({ metadata: { x: 1 } })));
  assert.ok(Either.isRight(strict({ type: 'area' })));
});

test('every reason has a sentence, and no sentence repeats the input', () => {
  const reasons: readonly FilterRejectionReason[] = [
    'not_object',
    'unsupported_key',
    'unsupported_operator',
    'invalid_value',
  ];
  for (const reason of reasons) {
    assert.ok(describeFilterRejection({ reason }).length > 0);
  }
  assert.match(describeFilterRejection({ reason: 'unsupported_operator', key: 'tags' }), /tags/);
  assert.equal(
    describeFilterRejection({ reason: 'unsupported_key' }),
    'a filter may only use type, kind, tags',
  );

  // The one thing a sentence must never do.
  const sentence = describeFilterRejection(
    inspectFilterInput({ topsecret: 1 }) ?? { reason: 'not_object' },
  );
  assert.ok(!sentence.includes('topsecret'));
});

test('the key vocabulary and the schema cannot drift apart', () => {
  assert.deepEqual([...FILTER_KEYS].sort(), Object.keys(NodeFilter.fields).sort());
});

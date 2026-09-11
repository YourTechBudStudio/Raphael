import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import { requestDecoder, responseDecoder } from './decode.ts';

const Shape = Schema.Struct({
  name: Schema.String,
  nested: Schema.Struct({ count: Schema.Number }),
  choice: Schema.Union(
    Schema.Struct({ kind: Schema.Literal('a'), value: Schema.String }),
    Schema.Struct({ kind: Schema.Literal('b'), value: Schema.Number }),
  ),
});

const valid = { name: 'n', nested: { count: 1 }, choice: { kind: 'a', value: 'x' } };

const decodeRequest = requestDecoder(Shape);
const decodeResponse = responseDecoder(Shape);

test('both policies accept a well-formed payload', () => {
  assert.equal(Either.isRight(decodeRequest(valid)), true);
  assert.equal(Either.isRight(decodeResponse(valid)), true);
});

test('requests reject properties the server does not recognize', () => {
  const result = decodeRequest({ ...valid, surprise: 1 });
  assert.equal(Either.isLeft(result), true);
  if (Either.isLeft(result)) {
    assert.equal(result.left.kind, 'invalid_payload');
    assert.deepEqual(result.left.issues[0]?.path, ['surprise']);
  }
});

test('responses tolerate additive properties at every level', () => {
  const result = decodeResponse({
    ...valid,
    added: true,
    nested: { count: 1, added: 'later' },
    choice: { kind: 'a', value: 'x', added: null },
  });
  assert.equal(Either.isRight(result), true);
});

test('tolerance does not extend to missing, invalid, or unsupported values', () => {
  const missing = decodeResponse({ nested: { count: 1 }, choice: { kind: 'a', value: 'x' } });
  assert.equal(Either.isLeft(missing), true);
  if (Either.isLeft(missing)) assert.deepEqual(missing.left.issues[0]?.path, ['name']);

  const invalid = decodeResponse({ ...valid, nested: { count: 'one' } });
  assert.equal(Either.isLeft(invalid), true);

  const unsupportedDiscriminant = decodeResponse({
    ...valid,
    choice: { kind: 'c', value: 'x' },
  });
  assert.equal(Either.isLeft(unsupportedDiscriminant), true);
});

test('a failed decode names every problem it found, not just the first', () => {
  const result = decodeResponse({ nested: {}, choice: { kind: 'a' } });
  assert.equal(Either.isLeft(result), true);
  if (Either.isLeft(result)) {
    assert.ok(result.left.issues.length >= 2);
    assert.ok(result.left.message.length > 0);
  }
});

test('no policy fills in a missing field', () => {
  const result = decodeResponse({ name: 'n', choice: { kind: 'a', value: 'x' } });
  assert.equal(Either.isLeft(result), true);
});

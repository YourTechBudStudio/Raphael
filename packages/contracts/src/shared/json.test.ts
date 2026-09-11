import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codePointLength,
  inspectJsonValue,
  isJsonObject,
  isJsonValue,
  utf8ByteLength,
} from './json.ts';
import { JSON_SAFETY_MAX_DEPTH, JSON_SAFETY_MAX_VALUES } from './limits.ts';

const nest = (depth: number): unknown => {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
};

test('accepts values that survive a JSON round trip', () => {
  for (const value of [null, true, 0, -1.5, '', 'text', [], {}, { a: [1, { b: null }] }]) {
    assert.equal(inspectJsonValue(value), undefined, JSON.stringify(value));
  }
});

test('rejects values JSON cannot represent, including ones a parser never produces', () => {
  const cases: readonly [unknown, string][] = [
    [undefined, 'not_json'],
    [() => 1, 'not_json'],
    [Symbol('s'), 'not_json'],
    [10n, 'not_json'],
    [new Date(), 'not_json'],
    [new Map(), 'not_json'],
    [Number.NaN, 'non_finite_number'],
    [Number.POSITIVE_INFINITY, 'non_finite_number'],
    [{ nested: Number.NaN }, 'non_finite_number'],
    [Array.from({ length: 1 }) as unknown[], 'not_json'],
  ];
  for (const [value, reason] of cases) {
    assert.equal(inspectJsonValue(value)?.reason, reason, String(reason));
  }
});

test('rejects symbol keys rather than dropping them on serialization', () => {
  const value = { kept: 1, [Symbol('lost')]: 2 };
  assert.equal(inspectJsonValue(value)?.reason, 'symbol_key');
});

test('rejects cycles, which only reach us from programmatic input', () => {
  const value: Record<string, unknown> = { name: 'a' };
  value['self'] = value;
  const rejection = inspectJsonValue(value);
  assert.equal(rejection?.reason, 'cyclic');
  assert.deepEqual(rejection?.path, ['self']);
});

test('bounds depth and reports where the limit was exceeded', () => {
  assert.equal(inspectJsonValue(nest(JSON_SAFETY_MAX_DEPTH - 1)), undefined);
  const rejection = inspectJsonValue(nest(JSON_SAFETY_MAX_DEPTH + 5));
  assert.equal(rejection?.reason, 'too_deep');
  assert.equal(rejection?.path.length, JSON_SAFETY_MAX_DEPTH);
});

test('bounds total values without bounding breadth by depth', () => {
  const wide = Array.from({ length: 50_000 }, (_, index) => index);
  assert.equal(inspectJsonValue(wide), undefined);

  const tooMany = Array.from({ length: JSON_SAFETY_MAX_VALUES + 2 }, () => 0);
  assert.equal(inspectJsonValue(tooMany)?.reason, 'too_many_values');
});

test('enforces key length only when a caller asks for it', () => {
  const value = { ['k'.repeat(12)]: 1 };
  assert.equal(inspectJsonValue(value)?.reason, undefined);
  assert.equal(
    inspectJsonValue(value, { maxDepth: 5, maxValues: 100, maxKeyCodePoints: 8 })?.reason,
    'key_too_long',
  );
});

test('distinguishes objects from other JSON values', () => {
  assert.equal(isJsonObject({ a: 1 }), true);
  assert.equal(isJsonObject([1]), false);
  assert.equal(isJsonObject(null), false);
  assert.equal(isJsonValue([1]), true);
});

test('measures code points and UTF-8 bytes, not UTF-16 units', () => {
  assert.equal('é'.length, 1);
  assert.equal(codePointLength('é'), 1);
  assert.equal(utf8ByteLength('é'), 2);

  assert.equal('🔥'.length, 2);
  assert.equal(codePointLength('🔥'), 1);
  assert.equal(utf8ByteLength('🔥'), 4);

  assert.equal(codePointLength('日本語'), 3);
  assert.equal(utf8ByteLength('日本語'), 9);
});

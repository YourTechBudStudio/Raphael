import assert from 'node:assert/strict';
import test from 'node:test';

import { JSON_SAFETY_MAX_DEPTH } from '../shared/limits.ts';
import {
  METADATA_MAX_DEPTH,
  METADATA_MAX_KEY_CODE_POINTS,
  METADATA_MAX_SERIALIZED_BYTES,
  METADATA_MAX_TOP_LEVEL_KEYS,
  inspectMetadataInput,
} from './fields.ts';

test('metadata rejections name the limit that was actually exceeded', () => {
  const tooDeep = inspectMetadataInput({ a: { b: { c: { d: { e: { f: 1 } } } } } });
  assert.equal(tooDeep?.reason, 'invalid_json');
  assert.match(tooDeep?.detail ?? '', new RegExp(`deeper than ${METADATA_MAX_DEPTH} levels`));
  assert.doesNotMatch(tooDeep?.detail ?? '', new RegExp(String(JSON_SAFETY_MAX_DEPTH)));
  assert.match(tooDeep?.detail ?? '', /"a\.b\.c\.d\.e"/);

  const keyTooLong = inspectMetadataInput({ ['k'.repeat(METADATA_MAX_KEY_CODE_POINTS + 1)]: 1 });
  assert.equal(keyTooLong?.reason, 'invalid_json');
  assert.match(keyTooLong?.detail ?? '', new RegExp(`${METADATA_MAX_KEY_CODE_POINTS} characters`));
});

test('metadata rejections distinguish what the caller has to change', () => {
  assert.equal(inspectMetadataInput([])?.reason, 'not_object');
  assert.equal(inspectMetadataInput(null)?.reason, 'not_object');
  assert.equal(inspectMetadataInput({ bad: Number.NaN })?.reason, 'invalid_json');
  assert.equal(
    inspectMetadataInput(
      Object.fromEntries(
        Array.from({ length: METADATA_MAX_TOP_LEVEL_KEYS + 1 }, (_, index) => [`k${index}`, 1]),
      ),
    )?.reason,
    'too_many_keys',
  );
  assert.equal(
    inspectMetadataInput({ big: 'a'.repeat(METADATA_MAX_SERIALIZED_BYTES) })?.reason,
    'too_large',
  );
  assert.equal(inspectMetadataInput({ fine: { nested: [1, 'two', null] } }), undefined);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import { JSON_SAFETY_MAX_DEPTH } from '../shared/limits.ts';
import {
  METADATA_MAX_DEPTH,
  METADATA_MAX_KEY_CODE_POINTS,
  METADATA_MAX_SERIALIZED_BYTES,
  METADATA_MAX_TOP_LEVEL_KEYS,
  TITLE_MAX_CODE_POINTS,
  TitleInput,
  inspectMetadataInput,
  inspectTitleInput,
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

test('title inspection names every rejection the server can act on', () => {
  assert.equal(inspectTitleInput('Reading list'), undefined);
  assert.equal(inspectTitleInput('  padded  '), undefined);

  assert.deepEqual(inspectTitleInput(''), { reason: 'title_required' });
  assert.deepEqual(inspectTitleInput('   \t\n '), { reason: 'title_required' });

  // An absent title is a missing title. JSON never produces an explicit `undefined`, so this value can
  // only mean the property was not there.
  assert.deepEqual(inspectTitleInput(undefined), { reason: 'title_required' });

  // Present but wrong: "a title is required" would be misleading advice here.
  assert.deepEqual(inspectTitleInput(null), { reason: 'not_string' });
  assert.deepEqual(inspectTitleInput(42), { reason: 'not_string' });
  assert.deepEqual(inspectTitleInput({ title: 'x' }), { reason: 'not_string' });
});

test('title length is measured on the trimmed value, in code points', () => {
  const exact = 'a'.repeat(TITLE_MAX_CODE_POINTS);
  assert.equal(inspectTitleInput(`   ${exact}   `), undefined);
  assert.deepEqual(inspectTitleInput(`${exact}a`), {
    reason: 'title_too_long',
    limit: TITLE_MAX_CODE_POINTS,
  });

  // Astral characters are one code point each, not two UTF-16 units, so a title of this many emoji
  // fits even though its `.length` is twice the limit.
  const astral = '\u{1F600}'.repeat(TITLE_MAX_CODE_POINTS);
  assert.equal(astral.length, TITLE_MAX_CODE_POINTS * 2);
  assert.equal(inspectTitleInput(astral), undefined);
  assert.deepEqual(inspectTitleInput(astral + '\u{1F600}'), {
    reason: 'title_too_long',
    limit: TITLE_MAX_CODE_POINTS,
  });
});

test('the refinement and the helper cannot disagree about a title', () => {
  const decode = Schema.decodeUnknownEither(TitleInput);
  for (const candidate of ['ok', '', '   ', 'a'.repeat(TITLE_MAX_CODE_POINTS + 1), '\u{1F600}']) {
    assert.equal(
      Either.isRight(decode(candidate)),
      inspectTitleInput(candidate) === undefined,
      `disagreement over ${JSON.stringify(candidate)}`,
    );
  }
});

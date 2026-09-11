import assert from 'node:assert/strict';
import test from 'node:test';

import { Either } from 'effect';

import {
  SLUG_MAX_CODE_POINTS,
  compareSlugBinary,
  deriveSlug,
  isCanonicalSlug,
  isCanonicalSlugShape,
} from './slug.ts';

const derived = (title: string): string | undefined => Either.getOrUndefined(deriveSlug(title));

/**
 * These examples are the frozen normalization policy, not illustrations. Changing one changes an
 * address a person may already have bookmarked or typed into the CLI.
 */
test('derives slugs under the agreed normalization policy', () => {
  const cases: readonly [string, string][] = [
    ['Backend', 'backend'],
    ['  Trimmed Title  ', 'trimmed-title'],
    ['Work & Personal', 'work-personal'],
    ['Q1 2026 Goals', 'q1-2026-goals'],
    ['multiple---separators', 'multiple-separators'],
    ['Ünïcödé Notes', 'ünïcödé-notes'],
    ['Café', 'café'],
    ['日本語のノート', '日本語のノート'],
    ['Ｆｕｌｌｗｉｄｔｈ', 'fullwidth'],
    ['ⅠⅡⅢ', 'iiiiii'],
    ['Ⅻ', 'xii'],
    ['snake_case_title', 'snake-case-title'],
    ['slash/in/title', 'slash-in-title'],
    ['emoji 🔥 in title', 'emoji-in-title'],
    ['ß sharp', 'ß-sharp'],
    ['İstanbul', 'i̇stanbul'],
  ];
  for (const [title, slug] of cases) {
    assert.equal(derived(title), slug, title);
  }
});

test('combining marks survive inside a token but never start one', () => {
  const composed = derived('étude');
  assert.equal(composed, 'étude');
  assert.equal(composed, composed?.normalize('NFC'));
  assert.equal(derived('a ́ b'), 'a-b');
});

test('every successful derivation satisfies the canonical grammar', () => {
  const titles = [
    'Backend',
    'Ünïcödé Notes',
    '日本語のノート',
    'Ｆｕｌｌｗｉｄｔｈ',
    'İstanbul',
    'étude',
    'ß sharp',
    'Q1 2026 Goals',
    'emoji 🔥 in title',
    '  Trimmed Title  ',
  ];
  for (const title of titles) {
    const result = deriveSlug(title);
    assert.equal(Either.isRight(result), true, title);
    if (Either.isRight(result)) {
      assert.equal(isCanonicalSlug(result.right), true, `${title} -> ${result.right}`);
    }
  }
});

test('derivation fails deliberately instead of inventing a slug', () => {
  for (const title of ['🔥', '???', '---', '  ', '́']) {
    const result = deriveSlug(title);
    assert.equal(Either.isLeft(result), true, title);
    if (Either.isLeft(result)) assert.equal(result.left.reason, 'slug_underivable', title);
  }

  const long = deriveSlug('a'.repeat(SLUG_MAX_CODE_POINTS + 1));
  assert.equal(Either.isLeft(long), true);
  if (Either.isLeft(long)) assert.equal(long.left.reason, 'slug_too_long');
});

test('validation rejects a noncanonical explicit slug rather than rewriting it', () => {
  for (const slug of [
    '',
    'Backend',
    'back end',
    'back--end',
    '-backend',
    'backend-',
    'back/end',
    '.',
    '..',
    'a'.repeat(SLUG_MAX_CODE_POINTS + 1),
    'étude',
    '́mark',
  ]) {
    assert.equal(isCanonicalSlug(slug), false, JSON.stringify(slug));
  }

  for (const slug of ['backend', 'q1-2026', 'café', '日本語', '\u00e9tude']) {
    assert.equal(isCanonicalSlug(slug), true, slug);
  }
});

test('shape and submission length are separate checks', () => {
  const long = 'a'.repeat(SLUG_MAX_CODE_POINTS + 1);
  assert.equal(isCanonicalSlugShape(long), true);
  assert.equal(isCanonicalSlug(long), false);
  for (const slug of ['Backend', 'back end', '', '-backend']) {
    assert.equal(isCanonicalSlugShape(slug), false, JSON.stringify(slug));
  }
});

test('binary comparison follows code point order, which UTF-16 comparison does not', () => {
  assert.equal(compareSlugBinary('a', 'b'), -1);
  assert.equal(compareSlugBinary('b', 'a'), 1);
  assert.equal(compareSlugBinary('a', 'a'), 0);
  assert.equal(compareSlugBinary('a', 'ab'), -1);

  // U+1F525 sorts after U+F8FF by code point, but before it by UTF-16 code unit.
  const astral = '🔥';
  const privateUse = '';
  assert.equal(astral < privateUse, true);
  assert.equal(compareSlugBinary(astral, privateUse), 1);
});

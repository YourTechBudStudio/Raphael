/**
 * A title is one line, and two lines of it are visible at any text size.
 *
 * Both halves are here because both were defects rather than preferences: a pasted break made a
 * multi-line title submittable, and a fixed height made the second line visible only to people
 * reading at the default scale.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { hasLineBreak, singleLineTitle, titleMaxHeight } from './title.ts';

test('a break of any kind becomes one ordinary space', () => {
  assert.equal(singleLineTitle('Field\nnotes'), 'Field notes');
  assert.equal(singleLineTitle('Field\rnotes'), 'Field notes');
  // CRLF is a run of two characters and must not become two spaces.
  assert.equal(singleLineTitle('Field\r\nnotes'), 'Field notes');
  assert.equal(singleLineTitle('Field\n\n\nnotes'), 'Field notes');
  // The separators a paste from a word processor carries.
  assert.equal(singleLineTitle('Field notes'), 'Field notes');
  assert.equal(singleLineTitle('Field notes'), 'Field notes');
});

test('nothing else about the authored spacing is touched', () => {
  // No trimming, no collapsing of runs, no tidying of tabs. Whitespace someone typed is theirs, and
  // the mock's title derivation is exactly what this phase was told not to port.
  assert.equal(singleLineTitle('  Field   notes\t'), '  Field   notes\t');
  assert.equal(singleLineTitle(''), '');
});

test('it recognizes a break wherever one is', () => {
  assert.equal(hasLineBreak('one line'), false);
  assert.equal(hasLineBreak('two\nlines'), true);
  assert.equal(hasLineBreak('two lines'), true);
});

test('two lines stay two lines as the text scale grows', () => {
  const atDefault = titleMaxHeight(1);

  assert.ok(titleMaxHeight(1.5) > atDefault);
  assert.ok(titleMaxHeight(2) > titleMaxHeight(1.5));
  // The field never shrinks below two lines at the default size, whatever is reported.
  assert.equal(titleMaxHeight(0.5), atDefault);
  assert.equal(titleMaxHeight(Number.NaN), atDefault);
});

test('it stops growing before the field is taller than the screen', () => {
  // Past this the field's own scrolling is the answer, which is what it is there for.
  assert.equal(titleMaxHeight(9), titleMaxHeight(4));
});

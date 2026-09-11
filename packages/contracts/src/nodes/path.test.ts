import assert from 'node:assert/strict';
import test from 'node:test';

import { Either } from 'effect';

import { ROOT_PATH, formatPath, isCanonicalPath, isEntityPath, parsePath } from './path.ts';

const segments = (path: string): readonly string[] | undefined =>
  Either.getOrUndefined(parsePath(path));

test('the root parses to no segments and is a scope, not an entity', () => {
  assert.deepEqual(segments(ROOT_PATH), []);
  assert.equal(isCanonicalPath(ROOT_PATH), true);
  assert.equal(isEntityPath(ROOT_PATH), false);
});

test('parses canonical absolute paths', () => {
  assert.deepEqual(segments('/work'), ['work']);
  assert.deepEqual(segments('/work/backend'), ['work', 'backend']);
  assert.deepEqual(segments('/日本語/ノート'), ['日本語', 'ノート']);
  assert.equal(isEntityPath('/work/backend'), true);
});

test('rejects malformed paths with the reason and the offending segment', () => {
  const cases: readonly [string, string, number | undefined][] = [
    ['work', 'not_absolute', undefined],
    ['', 'not_absolute', undefined],
    ['/work/', 'trailing_separator', undefined],
    ['/work//backend', 'empty_segment', 1],
    ['/work/./backend', 'noncanonical_segment', 1],
    ['/work/../backend', 'noncanonical_segment', 1],
    ['/Work', 'noncanonical_segment', 0],
    ['/work/back end', 'noncanonical_segment', 1],
    ['/work/-backend', 'noncanonical_segment', 1],
  ];
  for (const [path, reason, segment] of cases) {
    const result = parsePath(path);
    assert.equal(Either.isLeft(result), true, path);
    if (Either.isLeft(result)) {
      assert.equal(result.left.reason, reason, path);
      assert.equal(result.left.segment, segment, path);
    }
  }
});

test('a percent-encoded segment is not decoded a second time', () => {
  // The JSON parser has already produced the final string; "%2F" is literal text, not a separator.
  assert.equal(isCanonicalPath('/work%2Fbackend'), false);
});

test('formats segments back into the path they came from', () => {
  assert.equal(formatPath([]), ROOT_PATH);
  assert.equal(formatPath(['work', 'backend']), '/work/backend');
  for (const path of [ROOT_PATH, '/work', '/work/backend', '/日本語/ノート']) {
    assert.equal(formatPath(segments(path) ?? []), path);
  }
});

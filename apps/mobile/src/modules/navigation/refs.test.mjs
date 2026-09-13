/**
 * Route parameters are strings from outside, and most strings are not ids.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseContainerRef, parseNodeId } from './refs.ts';

test('only a positive safe integer names a container', () => {
  assert.equal(parseNodeId('1'), 1);
  assert.equal(parseNodeId('4207'), 4207);

  for (const rejected of [
    undefined,
    '',
    '0',
    '-3',
    '3.5',
    ' 3',
    '3 ',
    '03',
    '0x10',
    '1e3',
    'abc',
    'NaN',
    'Infinity',
    // Number() would happily answer here, and the answer would be a different container.
    '9007199254740993',
  ]) {
    assert.equal(parseNodeId(rejected), null, `${String(rejected)} should not be an id`);
  }
});

test('a reference needs both a known type and an id, and a stale link is not an error', () => {
  assert.deepEqual(parseContainerRef('area', '7'), { type: 'area', id: 7 });
  assert.deepEqual(parseContainerRef('project', '7'), { type: 'project', id: 7 });

  assert.equal(parseContainerRef('note', '7'), null);
  assert.equal(parseContainerRef(undefined, '7'), null);
  assert.equal(parseContainerRef('area', undefined), null);
  assert.equal(parseContainerRef('area', 'work'), null);
});

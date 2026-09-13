/**
 * Filtering the tree. It filters exactly what is loaded, and what is loaded is everything.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { filterTree } from './tree.ts';

const node = (id, title, children = []) => ({
  id,
  type: children.length > 0 ? 'area' : 'project',
  parentId: null,
  slug: title.toLowerCase(),
  title,
  description: '',
  children,
});

const tree = [
  node(1, 'Work', [node(2, 'Clients', [node(3, 'Acme')]), node(4, 'Design')]),
  node(5, 'Personal', [node(6, 'Garden')]),
];

test('an empty filter changes nothing', () => {
  assert.equal(filterTree(tree, ''), tree);
  assert.equal(filterTree(tree, '   '), tree);
});

test('a match keeps its ancestors, so it is never orphaned', () => {
  const filtered = filterTree(tree, 'acme');

  assert.deepEqual(
    filtered.map((branch) => branch.title),
    ['Work'],
  );
  assert.deepEqual(
    filtered[0].children.map((child) => child.title),
    ['Clients'],
  );
  assert.deepEqual(
    filtered[0].children[0].children.map((child) => child.title),
    ['Acme'],
  );
});

test('a matching branch keeps its whole subtree, so you can still walk below it', () => {
  const filtered = filterTree(tree, 'work');

  assert.equal(filtered.length, 1);
  assert.deepEqual(
    filtered[0].children.map((child) => child.title),
    ['Clients', 'Design'],
  );
});

test('no match is no match, not a partially loaded tree', () => {
  assert.deepEqual(filterTree(tree, 'nothing here'), []);
});

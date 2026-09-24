/**
 * Which places the move sheet offers, by what is moving.
 *
 * Pruning rather than disabling, and presentation only: the server stays the authority, so this is
 * about not offering places a person cannot use, never about deciding a move.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eligibleDestinations, offersRoot } from '../src/modules/capture/move-eligibility.ts';

const node = (id, type, title, children = []) => ({
  id,
  type,
  parentId: null,
  slug: title.toLowerCase(),
  title,
  description: '',
  children,
});

/** Work { Raphael (project), Research { Papers (project), Deep { } } }, Personal { Garden (project) } */
const roots = [
  node(1, 'area', 'Work', [
    node(2, 'project', 'Raphael'),
    node(3, 'area', 'Research', [node(4, 'project', 'Papers'), node(6, 'area', 'Deep')]),
  ]),
  node(5, 'area', 'Personal', [node(7, 'project', 'Garden')]),
];

/** Every id in a tree, depth first. */
const ids = (nodes) => nodes.flatMap((each) => [each.id, ...ids(each.children)]);

describe('eligibleDestinations', () => {
  it('offers a note every area and project', () => {
    assert.deepEqual(
      ids(eligibleDestinations(roots, { type: 'resource', id: 42 })),
      [1, 2, 3, 4, 6, 5, 7],
    );
  });

  it('offers a project areas only', () => {
    assert.deepEqual(ids(eligibleDestinations(roots, { type: 'project', id: 2 })), [1, 3, 6, 5]);
  });

  it('offers an area every area except itself and everything beneath it', () => {
    assert.deepEqual(ids(eligibleDestinations(roots, { type: 'area', id: 3 })), [1, 5]);
    assert.deepEqual(ids(eligibleDestinations(roots, { type: 'area', id: 1 })), [5]);
  });

  it('leaves the tree it was given alone', () => {
    eligibleDestinations(roots, { type: 'area', id: 3 });

    assert.equal(roots[0].children.length, 2);
  });
});

describe('offersRoot', () => {
  it('offers the top level to an area only', () => {
    assert.equal(offersRoot('area'), true);
    assert.equal(offersRoot('project'), false);
    assert.equal(offersRoot('resource'), false);
  });
});

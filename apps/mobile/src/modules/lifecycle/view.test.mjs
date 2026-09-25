/**
 * The phone's reading of a cause list: what it can offer, and which container explains it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { lifecycleView } from './view.ts';

const NOTE = 41;
const cause = (id, type, title, owner = 'user', reason = 'direct') => ({
  origin: { id, type, title },
  owner,
  reason,
});
const own = cause(NOTE, 'resource', 'Runbook');
const project = cause(12, 'project', 'Auth rework');
const area = cause(5, 'area', 'Work');
const foreign = cause(NOTE, 'resource', 'Runbook', 'retention', 'expired');

test('an active entity offers Archive and nothing else', () => {
  const view = lifecycleView(NOTE, []);

  assert.equal(view.standing, 'active');
  assert.equal(view.canArchive, true);
  assert.equal(view.canRestore, false);
  assert.equal(view.canMoveOut, false);
  assert.equal(view.nearestInherited, null);
});

test("the user's own cause offers Restore, and nothing can move it out", () => {
  const view = lifecycleView(NOTE, [own]);

  assert.equal(view.standing, 'direct');
  assert.equal(view.canRestore, true);
  assert.equal(view.canArchive, false);
  assert.equal(view.canMoveOut, false);
  assert.equal(view.nearestInherited, null);
});

test('archived only through a container above: Archive stays offered, and it can move out', () => {
  const view = lifecycleView(NOTE, [project, area]);

  assert.equal(view.standing, 'inherited');
  assert.equal(view.canArchive, true);
  assert.equal(view.canRestore, false);
  assert.equal(view.canMoveOut, true);
  assert.equal(view.nearestInherited, project);
});

test("another owner's direct cause is direct, and still leaves Archive to the user", () => {
  const view = lifecycleView(NOTE, [foreign]);

  assert.equal(view.standing, 'direct');
  assert.equal(view.canArchive, true);
  assert.equal(view.canRestore, false);
  assert.equal(view.canMoveOut, false);
});

test('the nearest inherited cause skips past a cause of its own, which comes first', () => {
  const view = lifecycleView(NOTE, [own, project, area]);

  assert.equal(view.standing, 'direct');
  assert.equal(view.canRestore, true);
  assert.equal(view.canMoveOut, false);
  assert.equal(view.nearestInherited, project);
});

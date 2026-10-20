import assert from 'node:assert/strict';
import test from 'node:test';

import { InternalFailure, SlugConflict } from './errors.ts';
import { withSlugHolder } from './resolve.ts';
import type { Orm } from './store.ts';

/** An ORM handle whose every read fails, standing for a database that cannot answer right now. */
const failingOrm = {
  select: () => {
    throw new Error('database is locked');
  },
} as unknown as Orm;

test('a holder lookup that fails leaves the slug conflict exactly as it was', () => {
  const conflict = new SlugConflict({
    field: 'slug',
    slug: 'taken',
    scope: 'sibling',
    parentId: 4,
  });
  const result = withSlugHolder(failingOrm, conflict);
  assert.equal(result, conflict, 'never replaced, least of all by an internal failure');
  assert.equal(result._tag, 'SlugConflict');
});

test('only a slug conflict that knows where it happened, and has no holder yet, is looked up', () => {
  const unplaced = new SlugConflict({ field: 'slug', slug: 'taken', scope: 'sibling' });
  assert.equal(withSlugHolder(failingOrm, unplaced), unplaced);

  const known = new SlugConflict({
    field: 'destination',
    slug: 'taken',
    scope: 'sibling',
    holder: { id: 9, type: 'resource' },
  });
  assert.equal(withSlugHolder(failingOrm, known), known);

  const other = new InternalFailure({ operation: 'nodes.create', detail: 'x' });
  assert.equal(withSlugHolder(failingOrm, other), other);
});

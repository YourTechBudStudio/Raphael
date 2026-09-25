/**
 * What may be drawn as a note card, and what may not.
 *
 * The guard is the only thing between a widened server vocabulary and a card drawn from a row it
 * does not describe. Each refusal below is a response this build cannot render honestly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toNoteSummaryItem } from './summary.ts';

const summary = (over = {}) => ({
  id: 12,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: 'a-note',
  revision: 2,
  title: 'A note',
  description: 'What it is about',
  tags: [],
  active: false,
  archived: false,
  ...over,
});

describe('a note summary', () => {
  it('carries exactly what a card needs and nothing invented', () => {
    assert.deepEqual(toNoteSummaryItem(summary()), {
      id: 12,
      title: 'A note',
      description: 'What it is about',
      slug: 'a-note',
      revision: 2,
      parentId: 3,
    });
  });

  it('keeps an empty description empty rather than filling it in', () => {
    // There is no body in a list response, so the only thing an "excerpt" could be made of is a
    // guess. An empty description means the card shows no second line.
    assert.equal(toNoteSummaryItem(summary({ description: '' })).description, '');
  });
});

describe('what is refused', () => {
  it('refuses a container', () => {
    assert.equal(toNoteSummaryItem(summary({ type: 'area', kind: null })), null);
    assert.equal(toNoteSummaryItem(summary({ type: 'project', kind: null })), null);
  });

  it('refuses a resource kind this build does not know', () => {
    // The day core admits a second kind, its rows arrive in the same `types: ['resource']` page.
    // Drawing one as a note would be this client deciding an unknown kind is close enough.
    assert.equal(toNoteSummaryItem(summary({ kind: 'bookmark' })), null);
    assert.equal(toNoteSummaryItem(summary({ kind: null })), null);
  });

  it('refuses a resource with no parent', () => {
    // Root holds only areas, so a resource claiming no parent is a response to distrust rather than
    // one to render with a blank location.
    assert.equal(toNoteSummaryItem(summary({ parentId: null })), null);
  });
});

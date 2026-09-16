/**
 * What this app asks for, and what it files the answer under.
 *
 * The request is pinned field by field because every field changes what comes back, and a feed that
 * quietly asked for the wrong thing would look exactly like a feed that worked. The keys are pinned
 * because two questions that differ must not share an answer - and because the ordering a caller
 * asked for is part of the question, priority and all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  containerDescriptor,
  feedDescriptor,
  nextPageSkip,
  noteEntityKey,
  noteListKey,
  noteListRequest,
  NOTE_PAGE_SIZE,
} from './requests.ts';

const hash = (key) => JSON.stringify(key);

describe('the request Home sends', () => {
  it('is the whole server, resources only, newest first, one fixed page', () => {
    assert.deepEqual(noteListRequest(feedDescriptor(0)), {
      parent: { path: '/' },
      recursive: true,
      types: ['resource'],
      orderBy: [{ field: 'updatedAt', direction: 'desc' }],
      skip: 0,
      limit: NOTE_PAGE_SIZE,
    });
  });

  it('names no id clause, because core is what makes an ordering total', () => {
    // Appending `id asc` here would be a second authority on ordering beside `effectiveOrderBy`,
    // and the two could disagree about the boundary between two pages.
    const { orderBy } = noteListRequest(feedDescriptor(0));

    assert.equal(orderBy.length, 1);
    assert.ok(!orderBy.some((clause) => clause.field === 'id'));
  });

  it('advances by the page size and nothing else', () => {
    assert.equal(noteListRequest(feedDescriptor(50)).skip, 50);
    assert.equal(noteListRequest(feedDescriptor(100)).skip, 100);
  });
});

describe("the request a container's notes send", () => {
  it('asks for that container only, in the default order', () => {
    const request = noteListRequest(containerDescriptor(7, 0));

    assert.deepEqual(request.parent, { id: 7 });
    assert.equal(request.recursive, false);
    assert.deepEqual(request.types, ['resource']);
    // Omitted entirely rather than sent as null: omission is how the wire contract asks for slug
    // then id, and a container list has no recency to offer.
    assert.ok(!('orderBy' in request));
  });
});

describe('where the next page starts', () => {
  const page = (over) => ({ items: [], skip: 0, limit: 50, hasMore: false, ...over });

  it('comes from the server’s own offsets, not from the cards that survived', () => {
    // Fifty rows were sent and two were dropped by the kind guard. Counting cards would ask for
    // offset 48 next and re-read rows the server had already handed over.
    assert.equal(nextPageSkip(page({ skip: 0, limit: 50, hasMore: true, items: [1, 2] })), 50);
  });

  it('is null when the server says there is no more', () => {
    assert.equal(nextPageSkip(page({ skip: 50, limit: 50, hasMore: false })), null);
  });

  it('follows the limit the server echoed, not the one that was asked for', () => {
    assert.equal(nextPageSkip(page({ skip: 20, limit: 10, hasMore: true })), 30);
  });
});

describe('cache keys', () => {
  it('separate two connections that both numbered a container 7', () => {
    assert.notEqual(
      hash(noteListKey(1, containerDescriptor(7, 0))),
      hash(noteListKey(2, containerDescriptor(7, 0))),
    );
  });

  it('separate Home from a container list, and one container from another', () => {
    assert.notEqual(
      hash(noteListKey(1, feedDescriptor(0))),
      hash(noteListKey(1, containerDescriptor(7, 0))),
    );
    assert.notEqual(
      hash(noteListKey(1, containerDescriptor(7, 0))),
      hash(noteListKey(1, containerDescriptor(8, 0))),
    );
  });

  it('separate two orderings, and two priorities of the same clauses', () => {
    const base = containerDescriptor(7, 0);
    const bySlug = { ...base, orderBy: [{ field: 'slug', direction: 'asc' }] };
    const byUpdated = { ...base, orderBy: [{ field: 'updatedAt', direction: 'desc' }] };

    assert.notEqual(hash(noteListKey(1, base)), hash(noteListKey(1, bySlug)));
    assert.notEqual(hash(noteListKey(1, bySlug)), hash(noteListKey(1, byUpdated)));

    // Array order is priority order, so the same two clauses in the other order are a different
    // question and must not read one another's answer.
    const first = { ...base, orderBy: [bySlug.orderBy[0], byUpdated.orderBy[0]] };
    const second = { ...base, orderBy: [byUpdated.orderBy[0], bySlug.orderBy[0]] };

    assert.notEqual(hash(noteListKey(1, first)), hash(noteListKey(1, second)));
  });

  it('separate two page sizes and two starting offsets', () => {
    const base = containerDescriptor(7, 0);

    assert.notEqual(hash(noteListKey(1, base)), hash(noteListKey(1, { ...base, limit: 10 })));
    assert.notEqual(hash(noteListKey(1, base)), hash(noteListKey(1, { ...base, skip: 50 })));
  });

  it('are stable for the same question asked twice', () => {
    assert.equal(hash(noteListKey(3, feedDescriptor(0))), hash(noteListKey(3, feedDescriptor(0))));
  });

  it('keep one note’s entity apart from the lists and from another connection', () => {
    assert.notEqual(hash(noteEntityKey(1, 4)), hash(noteEntityKey(2, 4)));
    assert.notEqual(hash(noteEntityKey(1, 4)), hash(noteEntityKey(1, 5)));
    assert.notEqual(hash(noteEntityKey(1, 4)), hash(noteListKey(1, containerDescriptor(4, 0))));
  });
});

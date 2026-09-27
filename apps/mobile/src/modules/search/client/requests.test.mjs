/**
 * What this app asks the server to search for, and what it files the answer under.
 *
 * The request is pinned field by field because every field changes what comes back, and a search
 * that quietly asked a wider question would look exactly like a search that worked. The keys are
 * pinned because two searches that differ must not share an answer. And the joining of pages is
 * pinned: relevance is the server's answer, so the one thing this app must never do is reorder the
 * hits it was given, and a node seen on two pages must still be one row.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  flattenSearchPages,
  searchFilter,
  searchKey,
  searchRequest,
  SEARCH_PAGE_LIMIT,
  toSearchResultItem,
} from './requests.ts';

const summary = (id, type, over = {}) => ({
  id,
  type,
  kind: type === 'resource' ? 'note' : null,
  parentId: type === 'area' ? null : 1,
  slug: `n${String(id)}`,
  revision: 1,
  title: `Node ${String(id)}`,
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: false,
  ...over,
});

const hit = (...args) => ({ node: summary(...args) });

const descriptor = (over = {}) => ({
  scope: null,
  query: 'credentials',
  type: 'all',
  tags: [],
  includeArchived: false,
  ...over,
});

const hash = (key) => JSON.stringify(key);

describe('the request a search sends', () => {
  it('searches the whole server, recursively, one page from the offset it is given', () => {
    assert.deepEqual(searchRequest(descriptor(), 0), {
      scopes: [{ path: '/' }],
      recursive: true,
      queries: ['credentials'],
      skip: 0,
      limit: SEARCH_PAGE_LIMIT,
    });
    assert.equal(searchRequest(descriptor(), 50).skip, 50);
    assert.equal(searchRequest(descriptor(), 50).limit, SEARCH_PAGE_LIMIT);
  });

  it('searches one container by its id when the screen was opened from one', () => {
    const request = searchRequest(descriptor({ scope: { type: 'project', id: 12 } }), 0);

    assert.deepEqual(request.scopes, [{ id: 12 }]);
    // Recursive from that container: a project's results are everything underneath it, which is
    // what someone searching from a project is asking about.
    assert.equal(request.recursive, true);
  });

  it('asks for the contract default page size', () => {
    assert.equal(SEARCH_PAGE_LIMIT, 50);
  });

  it('asks for archived nodes only when "Include archived" is on', () => {
    // Off is the server's default, so it is left out rather than restated.
    assert.ok(!('includeArchived' in searchRequest(descriptor(), 0)));
    assert.equal(searchRequest(descriptor({ includeArchived: true }), 0).includeArchived, true);
  });

  it('omits the filter entirely when there is nothing to say', () => {
    assert.ok(!('filter' in searchRequest(descriptor(), 0)));
  });

  it('carries the query exactly as it was typed', () => {
    // Parsed by the contract and translated by the backend. Nothing here rewrites, escapes or
    // splits it, because every one of those would be this client deciding what matching means.
    const request = searchRequest(descriptor({ query: 'auth AND "login flow"' }), 0);

    assert.deepEqual(request.queries, ['auth AND "login flow"']);
  });
});

describe('the filter the chips and tags add up to', () => {
  it('is nothing at all for All with no tags', () => {
    assert.equal(searchFilter(descriptor()), undefined);
  });

  it('names one container type for Areas and for Projects', () => {
    assert.deepEqual(searchFilter(descriptor({ type: 'area' })), { type: 'area' });
    assert.deepEqual(searchFilter(descriptor({ type: 'project' })), { type: 'project' });
  });

  it('names both the type and the kind for Notes', () => {
    // A note is a resource of one kind. Asking only for `resource` would widen the answer the
    // moment core admits a second kind.
    assert.deepEqual(searchFilter(descriptor({ type: 'note' })), {
      type: 'resource',
      kind: 'note',
    });
  });

  it('asks for any of the tags, alongside the type', () => {
    assert.deepEqual(searchFilter(descriptor({ tags: ['sync', 'design'] })), {
      tags: { $in: ['sync', 'design'] },
    });
    assert.deepEqual(searchFilter(descriptor({ type: 'note', tags: ['sync'] })), {
      type: 'resource',
      kind: 'note',
      tags: { $in: ['sync'] },
    });
  });

  it('reaches the request when there is something to say', () => {
    assert.deepEqual(searchRequest(descriptor({ type: 'area', tags: ['sync'] }), 0).filter, {
      type: 'area',
      tags: { $in: ['sync'] },
    });
  });
});

describe('cache keys', () => {
  it('separate two connections that both numbered a container 12', () => {
    const scoped = descriptor({ scope: { type: 'project', id: 12 } });

    assert.notEqual(hash(searchKey(1, scoped)), hash(searchKey(2, scoped)));
  });

  it('change when any part of the question changes', () => {
    const base = descriptor();

    for (const over of [
      { scope: { type: 'project', id: 12 } },
      { query: 'credential' },
      { type: 'note' },
      { tags: ['sync'] },
      // The archived and active readings of one search never share an answer.
      { includeArchived: true },
    ]) {
      assert.notEqual(
        hash(searchKey(1, base)),
        hash(searchKey(1, { ...base, ...over })),
        `${JSON.stringify(over)} must not read another question's answer`,
      );
    }
  });

  it('separate two different scopes, and a scope from the root', () => {
    const one = descriptor({ scope: { type: 'project', id: 12 } });
    const other = descriptor({ scope: { type: 'area', id: 13 } });

    assert.notEqual(hash(searchKey(1, one)), hash(searchKey(1, other)));
    assert.notEqual(hash(searchKey(1, one)), hash(searchKey(1, descriptor())));
  });

  it('are stable for the same question asked twice', () => {
    assert.equal(hash(searchKey(3, descriptor())), hash(searchKey(3, descriptor())));
  });
});

describe('a hit, as something drawable', () => {
  it('becomes a row for an area and a project', () => {
    assert.deepEqual(toSearchResultItem(hit(3, 'area', { title: 'Security', description: 'x' })), {
      id: 3,
      type: 'area',
      title: 'Security',
      parentId: null,
      archived: false,
    });
    assert.equal(toSearchResultItem(hit(12, 'project', { archived: true })).archived, true);
    assert.equal(toSearchResultItem(hit(12, 'project')).type, 'project');
  });

  it('becomes a note row for a resource of kind note', () => {
    assert.deepEqual(toSearchResultItem(hit(41, 'resource', { title: 'Runbook', parentId: 12 })), {
      id: 41,
      type: 'note',
      title: 'Runbook',
      parentId: 12,
      archived: false,
    });
  });

  it('is dropped when this build has no honest row for it', () => {
    // A resource kind this release has never heard of. Dropped rather than refused, exactly as
    // `toNoteSummaryItem` drops one: a row to leave out is not a reason to fail the search.
    assert.equal(toSearchResultItem(hit(50, 'resource', { kind: 'sketch' })), null);
  });
});

describe('joining pages into one list', () => {
  const row = (id, title = `Node ${String(id)}`) => ({
    id,
    type: 'project',
    title,
    parentId: 1,
    archived: false,
  });
  const page = (items, skip) => ({ items, skip, limit: 3, hasMore: true, archivedLeftOut: false });

  it("keeps the server's order across pages", () => {
    const items = flattenSearchPages([page([row(12), row(3), row(41)], 0), page([row(9)], 3)]);

    assert.deepEqual(
      items.map((item) => item.id),
      [12, 3, 41, 9],
    );
  });

  it('keeps one copy of a node seen on two pages: the newest, where the newest page put it', () => {
    // Pages are not a snapshot. An edit between the two requests can rank one node on both.
    const items = flattenSearchPages([
      page([row(12), row(3, 'Old title'), row(41)], 0),
      page([row(3, 'New title'), row(9)], 3),
    ]);

    assert.deepEqual(
      items.map((item) => item.id),
      [12, 41, 3, 9],
    );
    assert.equal(items.find((item) => item.id === 3).title, 'New title');
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  });

  it('answers with nothing for no pages', () => {
    assert.deepEqual(flattenSearchPages([]), []);
  });
});

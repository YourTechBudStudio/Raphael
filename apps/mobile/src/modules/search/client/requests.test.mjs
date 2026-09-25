/**
 * What this app asks the server to search for, and what it files the answer under.
 *
 * The request is pinned field by field because every field changes what comes back, and a search
 * that quietly asked a wider question would look exactly like a search that worked. The keys are
 * pinned because two searches that differ must not share an answer. And the grouping is pinned as a
 * partition: relevance is the server's answer, so the one thing this app must never do is reorder
 * the hits it was given.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  groupSearchResults,
  searchFilter,
  searchKey,
  searchRequest,
  SEARCH_LIMIT,
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
  it('searches the whole server, recursively, one page from the top', () => {
    assert.deepEqual(searchRequest(descriptor()), {
      scopes: [{ path: '/' }],
      recursive: true,
      queries: ['credentials'],
      skip: 0,
      limit: SEARCH_LIMIT,
    });
  });

  it('searches one container by its id when the screen was opened from one', () => {
    const request = searchRequest(descriptor({ scope: { type: 'project', id: 12 } }));

    assert.deepEqual(request.scopes, [{ id: 12 }]);
    // Recursive from that container: a project's results are everything underneath it, which is
    // what someone searching from a project is asking about.
    assert.equal(request.recursive, true);
  });

  it('never asks for a second page', () => {
    // A stated cap is the honest answer to a full page; a second request would be a paged view in
    // a modal that fills from the top and has nowhere to append.
    assert.equal(searchRequest(descriptor()).skip, 0);
    assert.equal(SEARCH_LIMIT, 100);
  });

  it('asks for archived nodes only when "Include archived" is on', () => {
    // Off is the server's default, so it is left out rather than restated.
    assert.ok(!('includeArchived' in searchRequest(descriptor())));
    assert.equal(searchRequest(descriptor({ includeArchived: true })).includeArchived, true);
  });

  it('omits the filter entirely when there is nothing to say', () => {
    assert.ok(!('filter' in searchRequest(descriptor())));
  });

  it('carries the query exactly as it was typed', () => {
    // Parsed by the contract and translated by the backend. Nothing here rewrites, escapes or
    // splits it, because every one of those would be this client deciding what matching means.
    const request = searchRequest(descriptor({ query: 'auth AND "login flow"' }));

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
    assert.deepEqual(searchRequest(descriptor({ type: 'area', tags: ['sync'] })).filter, {
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
  it('becomes a container reference for an area and a project', () => {
    assert.deepEqual(toSearchResultItem(hit(3, 'area', { title: 'Security', description: 'x' })), {
      kind: 'container',
      ref: { type: 'area', id: 3 },
      title: 'Security',
      description: 'x',
      archived: false,
    });
    assert.equal(toSearchResultItem(hit(12, 'project', { archived: true })).archived, true);
    assert.deepEqual(toSearchResultItem(hit(12, 'project')).ref, { type: 'project', id: 12 });
  });

  it('becomes a note card for a resource of kind note', () => {
    const item = toSearchResultItem(hit(41, 'resource', { title: 'Runbook', parentId: 12 }));

    assert.equal(item.kind, 'note');
    assert.deepEqual(item.note, {
      id: 41,
      title: 'Runbook',
      description: '',
      slug: 'n41',
      revision: 1,
      parentId: 12,
      archived: false,
    });
  });

  it('is dropped when this build has no honest card for it', () => {
    // A resource kind this release has never heard of. Dropped rather than refused, exactly as
    // `toNoteSummaryItem` drops one: a row to leave out is not a reason to fail the search.
    assert.equal(toSearchResultItem(hit(50, 'resource', { kind: 'sketch' })), null);
  });
});

describe('grouping one page', () => {
  const page = [
    toSearchResultItem(hit(12, 'project', { title: 'Authentication rework' })),
    toSearchResultItem(hit(41, 'resource', { title: 'Credential rotation' })),
    toSearchResultItem(hit(3, 'area', { title: 'Security' })),
    toSearchResultItem(hit(17, 'project', { title: 'Mobile login' })),
    toSearchResultItem(hit(58, 'resource', { title: 'Why we dropped basic auth' })),
    toSearchResultItem(hit(9, 'area', { title: 'Backend' })),
  ];

  it('partitions the page into areas, projects and notes', () => {
    const groups = groupSearchResults(page);

    assert.deepEqual(
      groups.areas.map((item) => item.ref.id),
      [3, 9],
    );
    assert.deepEqual(
      groups.projects.map((item) => item.ref.id),
      [12, 17],
    );
    assert.deepEqual(
      groups.notes.map((note) => note.id),
      [41, 58],
    );
  });

  it("keeps the server's order inside each group", () => {
    // The page above is in relevance order and the groups read it front to back, so a hit that
    // ranked above another of its own kind is still above it. Sorting here would be a second
    // authority on relevance, and this app has no basis for one.
    const reversed = groupSearchResults([...page].reverse());

    assert.deepEqual(
      reversed.areas.map((item) => item.ref.id),
      [9, 3],
    );
    assert.deepEqual(
      reversed.notes.map((note) => note.id),
      [58, 41],
    );
  });

  it('answers with three empty groups for an empty page', () => {
    assert.deepEqual(groupSearchResults([]), { areas: [], projects: [], notes: [] });
  });
});

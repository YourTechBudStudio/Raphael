/**
 * The screen states, pinned where they can be read without a server, a renderer or a clock.
 *
 * These distinctions were never test-covered before, and they are the part of search that is worth
 * covering most: every one of them is a different sentence to a person, and collapsing any two of
 * them is a lie the code could tell without ever failing. "Nothing matched" is not "could not
 * search". A query nobody has finished typing has not returned nothing. And a failed next page is
 * neither a failed search nor the end of the list.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ClientFailureError } from '../../../infrastructure/query/failure.ts';
import { deriveSearchView, isScopeGone } from './view.ts';

const observation = (over = {}) => ({
  query: 'credentials',
  queryRejection: undefined,
  tagsRejection: undefined,
  scopeGone: false,
  pages: undefined,
  isPending: false,
  isError: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  ...over,
});

const page = (items = [], hasMore = false, archivedLeftOut = false, skip = 0) => ({
  items,
  skip,
  limit: 50,
  hasMore,
  archivedLeftOut,
});

const containerItem = (id, type = 'area') => ({
  id,
  type,
  title: `Node ${String(id)}`,
  parentId: null,
  archived: false,
});

/** Every flag but the ones named, so a state cannot quietly also be another one. */
const onlyFlag = (view, name) => {
  for (const flag of [
    'isIdle',
    'isScopeGone',
    'isLoading',
    'isUnavailable',
    'isStale',
    'isEmpty',
    'isLoadingMore',
    'isMoreError',
    'hasMore',
  ]) {
    assert.equal(view[flag], flag === name, `${flag} should be ${String(flag === name)}`);
  }
};

describe('nothing has been asked', () => {
  it('is idle for an empty query', () => {
    const view = deriveSearchView(observation({ query: '', isPending: true }));

    onlyFlag(view, 'isIdle');
    assert.equal(view.invalid, undefined);
  });

  it('is idle, not invalid, while a phrase is still open', () => {
    // An opening quote is what every phrase looks like until it is closed. Reporting it as a
    // mistake for the whole of that time would be noise about a query nobody has finished.
    const view = deriveSearchView(
      observation({ query: 'auth "login', queryRejection: { reason: 'unterminated_phrase' } }),
    );

    onlyFlag(view, 'isIdle');
    assert.equal(view.invalid, undefined);
  });

  it('shows no results while idle, whatever else arrived', () => {
    const view = deriveSearchView(
      observation({ query: '', pages: [page([containerItem(3)], true)], isError: true }),
    );

    onlyFlag(view, 'isIdle');
    assert.deepEqual(view.items, []);
  });
});

describe('the request was refused before it left', () => {
  it('reports a query rejection, and says it was the query', () => {
    const rejection = { reason: 'dangling_operator' };
    const view = deriveSearchView(observation({ queryRejection: rejection }));

    // The source travels with the rejection. The two contract types share no discriminant, so a
    // screen given only the rejection would have to guess its origin from the reason names.
    assert.deepEqual(view.invalid, { source: 'query', rejection });
    onlyFlag(view, null);
  });

  it('reports a tag rejection when the query itself is fine', () => {
    const rejection = { reason: 'tag_too_long', limit: 40 };
    const view = deriveSearchView(observation({ tagsRejection: rejection }));

    assert.deepEqual(view.invalid, { source: 'tags', rejection });
    onlyFlag(view, null);
  });

  it('reports the query first when both are wrong', () => {
    const rejection = { reason: 'empty_phrase' };
    const view = deriveSearchView(
      observation({ queryRejection: rejection, tagsRejection: { reason: 'tags_repeat' } }),
    );

    assert.deepEqual(view.invalid, { source: 'query', rejection });
  });
});

/** The one place mobile depends on how the server spells this failure. */
describe('reading a scope that is gone out of a failure', () => {
  const apiFailure = (code) =>
    new ClientFailureError({ kind: 'http', message: 'Scope 1 does not exist.', status: 404, code });

  it('is the not-found code', () => {
    assert.equal(isScopeGone(apiFailure('node_not_found')), true);
  });

  it('is not another refusal', () => {
    assert.equal(isScopeGone(apiFailure('invalid_input')), false);
  });

  it('is not a network failure, and not something that is not a client failure at all', () => {
    assert.equal(
      isScopeGone(new ClientFailureError({ kind: 'network', message: 'unreachable' })),
      false,
    );
    assert.equal(isScopeGone(new Error('No connection')), false);
    assert.equal(isScopeGone(undefined), false);
  });
});

describe('the scope is gone', () => {
  it('takes precedence over a failed read, because it is the more specific answer', () => {
    // The read *did* fail; saying only that would offer a retry that cannot succeed, and would
    // hide that the container being searched no longer exists.
    const view = deriveSearchView(observation({ scopeGone: true, isError: true }));

    onlyFlag(view, 'isScopeGone');
  });

  it('takes precedence over results from an earlier reading', () => {
    const view = deriveSearchView(
      observation({ scopeGone: true, isError: true, pages: [page([containerItem(3)])] }),
    );

    onlyFlag(view, 'isScopeGone');
    assert.deepEqual(view.items, []);
  });
});

describe('reading the server', () => {
  it('is loading while nothing has arrived and nothing has failed', () => {
    onlyFlag(deriveSearchView(observation({ isPending: true })), 'isLoading');
  });

  it('is unavailable when nothing arrived and the read failed', () => {
    onlyFlag(deriveSearchView(observation({ isError: true })), 'isUnavailable');
  });

  it('is stale, not unavailable, when results are on screen and a later read failed', () => {
    // The results already shown were true when they were read. Clearing them because a refresh
    // went wrong would throw away a good reading over a later failure.
    const view = deriveSearchView(
      observation({ pages: [page([containerItem(3)])], isError: true }),
    );

    onlyFlag(view, 'isStale');
    assert.deepEqual(
      view.items.map((item) => item.id),
      [3],
    );
  });

  it('is empty when the server answered, nothing matched, and nothing more is coming', () => {
    onlyFlag(deriveSearchView(observation({ pages: [page([])] })), 'isEmpty');
  });

  it('is not empty when the first page drew no rows but the server has more', () => {
    // Every hit on it was a kind this build cannot draw. "Nothing matches" would be a claim about
    // pages nobody has read.
    const view = deriveSearchView(observation({ pages: [page([], true)] }));

    onlyFlag(view, 'hasMore');
    assert.deepEqual(view.items, []);
  });

  it('reports plain results with no flag at all', () => {
    const view = deriveSearchView(observation({ pages: [page([containerItem(3)])] }));

    onlyFlag(view, null);
    assert.equal(view.items.length, 1);
    assert.equal(view.archivedLeftOut, false);
  });

  it('has no cap and no groups: one list, every page, in order', () => {
    const view = deriveSearchView(
      observation({
        pages: [
          page([containerItem(12, 'project'), containerItem(3)], true),
          page([containerItem(41, 'note')], false, false, 50),
        ],
      }),
    );

    onlyFlag(view, null);
    assert.ok(!('isCapped' in view));
    assert.ok(!('groups' in view));
    assert.deepEqual(
      view.items.map((item) => item.id),
      [12, 3, 41],
    );
  });
});

describe('walking the pages', () => {
  it('says there is more while the newest page says so', () => {
    const view = deriveSearchView(observation({ pages: [page([containerItem(3)], true)] }));

    onlyFlag(view, 'hasMore');
  });

  it('is loading more while the next page is read, over the rows already here', () => {
    const view = deriveSearchView(
      observation({ pages: [page([containerItem(3)], true)], isFetchingNextPage: true }),
    );

    assert.equal(view.isLoadingMore, true);
    assert.equal(view.hasMore, true);
    assert.equal(view.isStale, false);
    assert.equal(view.items.length, 1);
  });

  it('reports a failed next page as that, not as a stale or failed search', () => {
    // The library reports a failed next page as an error too. It is not the held pages going
    // stale: they were not read again, and they stay exactly as true as they were.
    const view = deriveSearchView(
      observation({
        pages: [page([containerItem(3)], true)],
        isError: true,
        isFetchNextPageError: true,
      }),
    );

    assert.equal(view.isMoreError, true);
    assert.equal(view.isStale, false);
    assert.equal(view.isUnavailable, false);
    assert.equal(view.hasMore, true, 'a failed page never makes the list look finished');
    assert.equal(view.items.length, 1);
  });
});

describe('archived matches that were left out', () => {
  it('are carried from the page the server answered, with results or without', () => {
    // The left-out line reads this, so it is only ever offered when turning the filter on adds
    // something - including over an answer where nothing active matched.
    assert.equal(
      deriveSearchView(observation({ pages: [page([containerItem(3)], false, true)] }))
        .archivedLeftOut,
      true,
    );

    const empty = deriveSearchView(observation({ pages: [page([], false, true)] }));

    onlyFlag(empty, 'isEmpty');
    assert.equal(empty.archivedLeftOut, true);
  });

  it('are read from the newest page', () => {
    const view = deriveSearchView(
      observation({
        pages: [page([containerItem(3)], true, false), page([containerItem(9)], false, true, 50)],
      }),
    );

    assert.equal(view.archivedLeftOut, true);
  });

  it('are never claimed without a page to claim them from', () => {
    assert.equal(deriveSearchView(observation({ isPending: true })).archivedLeftOut, false);
    assert.equal(deriveSearchView(observation({ isError: true })).archivedLeftOut, false);
    assert.equal(deriveSearchView(observation({ query: '' })).archivedLeftOut, false);
  });
});

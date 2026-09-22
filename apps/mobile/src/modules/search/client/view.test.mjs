/**
 * The screen states, pinned where they can be read without a server, a renderer or a clock.
 *
 * These distinctions were never test-covered before, and they are the part of search that is worth
 * covering most: every one of them is a different sentence to a person, and collapsing any two of
 * them is a lie the code could tell without ever failing. "Nothing matched" is not "could not
 * search". A query nobody has finished typing has not returned nothing. And a full page is not the
 * whole answer.
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
  page: undefined,
  isPending: false,
  isError: false,
  ...over,
});

const page = (items = [], hasMore = false) => ({ items, hasMore });

const containerItem = (id, type = 'area') => ({
  kind: 'container',
  ref: { type, id },
  title: `Node ${String(id)}`,
  description: '',
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
    'isCapped',
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
      observation({ query: '', page: page([containerItem(3)], true), isError: true }),
    );

    onlyFlag(view, 'isIdle');
    assert.deepEqual(view.groups, { areas: [], projects: [], notes: [] });
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

/**
 * The one place mobile depends on how the server spells this failure.
 *
 * If the field is ever reported differently, nothing else in the app would notice: the screen would
 * fall back from "That project is no longer here." to a retry button that cannot succeed, which is
 * the state the whole scope-gone branch exists to prevent.
 */
describe('reading a scope that is gone out of a failure', () => {
  const apiFailure = (code, details) =>
    new ClientFailureError({
      kind: 'api_error',
      message: 'refused',
      status: 404,
      error: { code, message: 'refused' },
      details,
    });

  it('is the not-found code reported against the scopes field', () => {
    assert.equal(isScopeGone(apiFailure('node_not_found', { field: 'scopes', index: 0 })), true);
  });

  it('is not the same code about some other field', () => {
    // A parent that does not exist is a different failure with a different answer, and widening
    // this predicate would put "that project is no longer here" in front of it.
    assert.equal(isScopeGone(apiFailure('node_not_found', { field: 'parent' })), false);
    assert.equal(isScopeGone(apiFailure('node_not_found', {})), false);
  });

  it('is not another failure that happens to be about the scopes field', () => {
    assert.equal(isScopeGone(apiFailure('invalid_input', { field: 'scopes' })), false);
  });

  it('is not a transport failure, and not something that is not a client failure at all', () => {
    assert.equal(
      isScopeGone(new ClientFailureError({ kind: 'transport', message: 'unreachable' })),
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
      observation({ scopeGone: true, isError: true, page: page([containerItem(3)]) }),
    );

    onlyFlag(view, 'isScopeGone');
    assert.deepEqual(view.groups, { areas: [], projects: [], notes: [] });
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
    const view = deriveSearchView(observation({ page: page([containerItem(3)]), isError: true }));

    onlyFlag(view, 'isStale');
    assert.deepEqual(
      view.groups.areas.map((item) => item.ref.id),
      [3],
    );
  });

  it('is empty when the server answered and nothing matched', () => {
    onlyFlag(deriveSearchView(observation({ page: page([]) })), 'isEmpty');
  });

  it('is capped when the server says it has more than it sent', () => {
    const view = deriveSearchView(observation({ page: page([containerItem(3)], true) }));

    onlyFlag(view, 'isCapped');
  });

  it('reports plain results with no flag at all', () => {
    const view = deriveSearchView(observation({ page: page([containerItem(3)]) }));

    onlyFlag(view, null);
    assert.equal(view.groups.areas.length, 1);
  });
});

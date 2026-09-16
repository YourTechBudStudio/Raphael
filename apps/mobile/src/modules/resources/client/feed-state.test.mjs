/**
 * Six states, told apart.
 *
 * Each case below is one a screen would otherwise get wrong by collapsing it into its neighbour:
 * loading read as empty, a failure read as empty, a failed page read as a failed feed, or cards
 * thrown away because a later read went wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveNoteFeed } from './feed-state.ts';

const note = (id) => ({
  id,
  title: `Note ${String(id)}`,
  description: '',
  slug: `note-${String(id)}`,
  revision: 1,
  parentId: 3,
});

const page = (ids, over = {}) => ({
  items: ids.map(note),
  skip: 0,
  limit: 50,
  hasMore: false,
  ...over,
});

const observation = (over = {}) => ({
  pages: undefined,
  isPending: false,
  isError: false,
  isFetchNextPageError: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  ...over,
});

describe('nothing has arrived', () => {
  it('is loading, and is not empty', () => {
    const view = deriveNoteFeed(observation({ isPending: true }));

    assert.equal(view.isLoading, true);
    assert.equal(view.isEmpty, false);
    assert.equal(view.isUnavailable, false);
    assert.deepEqual(view.items, []);
  });
});

describe('nothing arrived and the read failed', () => {
  it('is unavailable, and is neither loading nor empty', () => {
    const view = deriveNoteFeed(observation({ isPending: true, isError: true }));

    // "Could not be read" and "there is nothing here" are claims about different things, and only
    // one of them is about someone's notes.
    assert.equal(view.isUnavailable, true);
    assert.equal(view.isEmpty, false);
    assert.equal(view.isLoading, false);
  });
});

describe('a page arrived with nothing in it', () => {
  it('is empty, and is not a failure', () => {
    const view = deriveNoteFeed(observation({ pages: [page([])] }));

    assert.equal(view.isEmpty, true);
    assert.equal(view.isUnavailable, false);
    assert.equal(view.isStale, false);
  });
});

describe('cards are on screen and a later read failed', () => {
  it('keeps the cards and reports the failure', () => {
    const view = deriveNoteFeed(observation({ pages: [page([1, 2])], isError: true }));

    assert.deepEqual(
      view.items.map((item) => item.id),
      [1, 2],
    );
    assert.equal(view.isStale, true);
    assert.equal(view.isUnavailable, false);
    assert.equal(view.isEmpty, false);
  });
});

describe('the next page failed', () => {
  const failed = observation({
    pages: [page([1, 2], { hasMore: true })],
    isError: true,
    isFetchNextPageError: true,
    hasNextPage: true,
  });

  it('keeps every earlier row', () => {
    assert.deepEqual(
      deriveNoteFeed(failed).items.map((item) => item.id),
      [1, 2],
    );
  });

  it('is not the whole feed failing', () => {
    const view = deriveNoteFeed(failed);

    assert.equal(view.nextPageFailed, true);
    assert.equal(view.isStale, false);
    assert.equal(view.isUnavailable, false);
  });

  it('stops the automatic walk, so scrolling does not re-ask a refused question', () => {
    assert.equal(deriveNoteFeed(failed).canLoadMore, false);
  });
});

describe('another page is on its way', () => {
  it('keeps the rows and says so', () => {
    const view = deriveNoteFeed(
      observation({
        pages: [page([1], { hasMore: true })],
        isFetchingNextPage: true,
        hasNextPage: true,
      }),
    );

    assert.deepEqual(
      view.items.map((item) => item.id),
      [1],
    );
    assert.equal(view.isLoadingMore, true);
  });

  it('does not ask for a second copy of it', () => {
    // `onEndReached` fires on every qualifying scroll event; without this one flick queues a dozen
    // identical requests for the same offset.
    const view = deriveNoteFeed(
      observation({
        pages: [page([1], { hasMore: true })],
        isFetchingNextPage: true,
        hasNextPage: true,
      }),
    );

    assert.equal(view.canLoadMore, false);
  });
});

describe('there is more to read', () => {
  it('allows exactly one more request', () => {
    const view = deriveNoteFeed(
      observation({ pages: [page([1], { hasMore: true })], hasNextPage: true }),
    );

    assert.equal(view.canLoadMore, true);
  });

  it('allows none when the server says the list has ended', () => {
    assert.equal(deriveNoteFeed(observation({ pages: [page([1])] })).canLoadMore, false);
  });
});

describe('pages in sequence', () => {
  it('are flattened in the order the server produced them', () => {
    const view = deriveNoteFeed(
      observation({
        pages: [page([1, 2], { hasMore: true }), page([3, 4], { skip: 50 })],
      }),
    );

    // No local sort. There is no timestamp in a summary to sort by, and re-deriving the server's
    // order from what happens to be held would be a different order over a partial list.
    assert.deepEqual(
      view.items.map((item) => item.id),
      [1, 2, 3, 4],
    );
  });
});

/**
 * Search's page walk, driven against the real query library.
 *
 * What Search promises about paging is a promise about how the library behaves under its options:
 * that the next page starts where the server said the last one ended, that scrolling while any read
 * is in the air asks for nothing - above all, that a page request never cancels a refetch of the
 * pages already held - and that a failed page stops the walk until someone asks again. None of that
 * shows in an options object, so a real `QueryClient` and a real observer run here.
 *
 * The transport answers on demand, so a test can hold a read open and scroll into it. Every answer
 * still goes through the contract's own decoder.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { Either } from 'effect';

import {
  requestMoreResults,
  retryMoreResults,
  searchPagesOptions,
} from '../src/modules/search/client/options.ts';

const summary = (id) => ({
  id,
  type: 'project',
  kind: null,
  parentId: 1,
  slug: `p${String(id)}`,
  revision: 1,
  title: `Project ${String(id)}`,
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: false,
});

const answer = (ids, { skip = 0, limit = 50, hasMore = false } = {}) => ({
  items: ids.map((id) => ({ node: summary(id) })),
  skip,
  limit,
  hasMore,
  archivedLeftOut: false,
});

const transportFailure = {
  kind: 'transport',
  mutationOutcome: 'not_applicable',
  message: 'offline',
};

/** A transport whose every request waits until the test answers it. */
const onDemandTransport = () => {
  const pending = [];
  const requests = [];

  return {
    requests,
    /** Requests asked and not yet answered. */
    inFlight: () => pending.length,
    /** Answers the oldest unanswered request. */
    answer: (value) => {
      const next = pending.shift();
      assert.ok(next !== undefined, 'a request is waiting to be answered');
      next.answer(value);
    },
    fail: () => {
      const next = pending.shift();
      assert.ok(next !== undefined, 'a request is waiting to be answered');
      next.fail();
    },
    transport: {
      endpoint: { origin: 'https://example.invalid', basePath: '' },
      timeoutMs: 1000,
      invoke: (call) => {
        requests.push(call.body);

        return new Promise((resolve) => {
          pending.push({
            answer: (value) => {
              const decoded = call.decode(value);
              if (Either.isLeft(decoded)) {
                throw new Error(`stub answer was refused: ${decoded.left.message}`);
              }
              resolve({ ok: true, value: decoded.right });
            },
            fail: () => {
              resolve({ ok: false, failure: transportFailure });
            },
          });
        });
      },
    },
  };
};

const descriptor = {
  scope: null,
  query: 'auth',
  type: 'all',
  tags: [],
  includeArchived: false,
};

const flush = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** A client that does not retry, so a failed page is observed as one. */
const freshClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Starts a search and waits for its first request to be asked. */
const start = async () => {
  const server = onDemandTransport();
  const client = freshClient();
  const observer = new InfiniteQueryObserver(
    client,
    searchPagesOptions(1, server.transport, descriptor, true),
  );
  const unsubscribe = observer.subscribe(() => undefined);
  await flush();

  const result = () => observer.getCurrentResult();

  return {
    server,
    result,
    /** What the screen's `onEndReached` does. */
    loadMore: () => requestMoreResults(result()),
    retryMore: () => {
      retryMoreResults(result());
    },
    stop: () => {
      unsubscribe();
      client.clear();
    },
  };
};

const ids = (result) => result.data?.pages.flatMap((page) => page.items.map((item) => item.id));

describe('walking the pages of a search', () => {
  it('asks for the first page from 0, and the next from where the server said it ended', async () => {
    const search = await start();

    try {
      assert.equal(search.server.requests[0].skip, 0);
      assert.equal(search.server.requests[0].limit, 50);
      search.server.answer(answer([1, 2], { skip: 0, limit: 50, hasMore: true }));
      await flush();

      assert.equal(search.loadMore(), true);
      await flush();

      // From the server's own `skip + limit`, not from how many rows arrived.
      assert.equal(search.server.requests[1].skip, 50);
      search.server.answer(answer([3], { skip: 50, limit: 50 }));
      await flush();

      assert.deepEqual(ids(search.result()), [1, 2, 3]);
    } finally {
      search.stop();
    }
  });

  it('asks for nothing when the server said it has no more', async () => {
    const search = await start();

    try {
      search.server.answer(answer([1, 2]));
      await flush();

      assert.equal(search.loadMore(), false);
      await flush();
      assert.equal(search.server.requests.length, 1);
    } finally {
      search.stop();
    }
  });

  it('asks for nothing while the first page is still being read', async () => {
    const search = await start();

    try {
      assert.equal(search.loadMore(), false);
      await flush();
      assert.equal(search.server.requests.length, 1);
    } finally {
      search.stop();
    }
  });

  it('asks once, however often the end is reached while the next page is read', async () => {
    const search = await start();

    try {
      search.server.answer(answer([1], { hasMore: true }));
      await flush();

      assert.equal(search.loadMore(), true);
      await flush();
      assert.equal(search.loadMore(), false);
      assert.equal(search.loadMore(), false);
      await flush();

      assert.equal(search.server.requests.length, 2);
    } finally {
      search.stop();
    }
  });

  it('asks for nothing while the held pages are refetched, and leaves that refetch alone', async () => {
    const search = await start();

    try {
      search.server.answer(answer([1], { hasMore: true }));
      await flush();

      // A refetch of the held pages, as coming back to the app starts one.
      const refetch = search.result().refetch();
      await flush();
      assert.equal(search.server.inFlight(), 1);

      assert.equal(search.loadMore(), false, 'no page while the held pages are being read');
      await flush();
      assert.equal(search.server.requests.length, 2);

      search.server.answer(answer([1, 9], { hasMore: true }));
      await refetch;
      await flush();

      // The refetch was not cancelled: its answer is what the list now holds.
      assert.deepEqual(ids(search.result()), [1, 9]);
      assert.equal(search.loadMore(), true);
    } finally {
      search.stop();
    }
  });

  it('stops at a failed page, keeps the pages before it, and asks again on retry', async () => {
    const search = await start();

    try {
      search.server.answer(answer([1, 2], { hasMore: true }));
      await flush();

      assert.equal(search.loadMore(), true);
      await flush();
      search.server.fail();
      await flush();

      assert.equal(search.result().isFetchNextPageError, true);
      assert.deepEqual(ids(search.result()), [1, 2], 'the rows already read stay');

      assert.equal(search.loadMore(), false, 'scrolling does not ask a server that said no');
      await flush();
      assert.equal(search.server.requests.length, 2);

      search.retryMore();
      await flush();

      assert.equal(search.server.requests.length, 3);
      assert.equal(search.server.requests[2].skip, 50, 'the same page, asked again');
      search.server.answer(answer([3], { skip: 50 }));
      await flush();

      assert.equal(search.result().isFetchNextPageError, false);
      assert.deepEqual(ids(search.result()), [1, 2, 3]);
    } finally {
      search.stop();
    }
  });
});

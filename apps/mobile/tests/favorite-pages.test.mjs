/**
 * The favorites list, paged against a real cache and a transport that answers on demand.
 *
 * Three properties carry it. **Completing never cancels a refresh:** the filter asks for every page,
 * and a page request made while the list is being refreshed would cancel that refresh and leave the
 * list showing what it held before a favorite change. **A failed page stops automatic loading** until
 * the person asks again. **Every page carries its own request's stamp,** which is what the star on
 * each row is judged by.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { installDom } from './support/browser-dom.mjs';
import { LIST, onDemandServer, page, summary, unreachable } from './support/favorites-server.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { invalidateActivation } = await import('../src/infrastructure/query/invalidate.ts');
const { useFavoritePages } = await import('../src/modules/favorites/client/list.ts');
const { flattenFavoritePages } = await import('../src/modules/favorites/client/options.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');

after(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const PAGE = 500;

const flush = async (step) => {
  await act(async () => {
    step?.();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

/** One mounted `useFavoritePages`, whose `complete` the test can turn on and off. */
const mountList = (client) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  let pages;

  function List({ complete }) {
    pages = useFavoritePages({ complete });

    return null;
  }

  const render = (complete) => {
    act(() => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(List, { complete })),
      );
    });
  };

  return {
    render,
    pages: () => pages,
    ids: () => pages.items?.map((item) => item.node.id),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

let client;
let server;
let list;

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  server = onDemandServer();
  useConnectionStore.setState({
    phase: {
      kind: 'active',
      rejection: null,
      session: {
        activation: 1,
        transport: server.transport,
        connection: {
          connectionId: 'c1',
          base: 'https://raphael.example',
          origin: 'https://raphael.example',
          protocolVersion: PROTOCOL_VERSION,
        },
      },
    },
  });
  list = mountList(client);
});

afterEach(async () => {
  await flush(() => {
    server.drain();
  });
  list.unmount();
  client.clear();
});

/** Answers the next list request with `ids`, saying whether more follow. */
const answerPage = (ids, hasMore) =>
  flush(() => {
    server.settle(LIST, (body) =>
      page(
        body,
        ids.map((id) => summary(id)),
        hasMore,
      ),
    );
  });

describe('reading the list', () => {
  it('asks for pages of 500 from the start, and stops when the server says it has no more', async () => {
    list.render(false);
    await flush();

    assert.deepEqual(server.pending(LIST), { skip: 0, limit: PAGE });
    await answerPage([1, 2], true);

    assert.deepEqual(list.ids(), [1, 2]);
    assert.equal(list.pages().isComplete, false);
    assert.equal(server.inFlight(LIST), 0, 'nothing more is asked for on its own');
  });

  it('with complete, loads every page and then says it is complete', async () => {
    list.render(true);
    await flush();
    await answerPage([1], true);

    assert.deepEqual(server.pending(LIST), { skip: PAGE, limit: PAGE });
    await answerPage([2], true);
    assert.deepEqual(server.pending(LIST), { skip: 2 * PAGE, limit: PAGE });
    await answerPage([3], false);

    assert.deepEqual(list.ids(), [1, 2, 3]);
    assert.equal(list.pages().isComplete, true);
    assert.equal(server.inFlight(LIST), 0);
  });

  it('does not ask for the next page while a refresh is in flight, and continues after it', async () => {
    list.render(false);
    await flush();
    await answerPage([1], true);

    // A favorite change elsewhere refreshes the list, and the answer is held.
    await flush(() => {
      void invalidateActivation(client, 1);
    });
    assert.equal(server.inFlight(LIST), 1);
    assert.deepEqual(server.pending(LIST), { skip: 0, limit: PAGE });

    list.render(true);
    await flush();
    assert.equal(server.inFlight(LIST), 1, 'the filter waits rather than cancel the refresh');
    assert.equal(server.of(LIST).length, 2);

    await answerPage([1, 5], true);
    assert.deepEqual(list.ids(), [1, 5], 'the refresh is what the list holds');
    assert.deepEqual(server.pending(LIST), { skip: PAGE, limit: PAGE }, 'then page 2');
    await answerPage([6], false);

    assert.deepEqual(list.ids(), [1, 5, 6]);
    assert.equal(list.pages().isComplete, true);
  });

  it('stops after a failed page until retried, and retry asks for that page again', async () => {
    list.render(true);
    await flush();
    await answerPage([1], true);
    await flush(() => {
      server.settle(LIST, unreachable);
    });

    assert.equal(list.pages().isMoreError, true);
    assert.equal(list.pages().isComplete, false);
    assert.deepEqual(list.ids(), [1], 'the rows above the failure stay');

    act(() => {
      list.pages().loadMore();
    });
    await flush();
    assert.equal(server.inFlight(LIST), 0, 'nothing is asked for after a failed page');

    act(() => {
      list.pages().retry();
    });
    await flush();
    assert.deepEqual(server.pending(LIST), { skip: PAGE, limit: PAGE });
    await answerPage([2], false);

    assert.equal(list.pages().isMoreError, false);
    assert.equal(list.pages().isComplete, true);
  });

  it('does not complete a filter over a refresh that failed, until Retry rereads the list', async () => {
    list.render(false);
    await flush();
    await answerPage([1], true);

    // The refresh a favorite change starts, and it fails.
    await flush(() => {
      void invalidateActivation(client, 1);
    });
    await flush(() => {
      server.settle(LIST, unreachable);
    });
    assert.equal(list.pages().isStale, true);

    list.render(true);
    await flush();
    // A page asked for now would clear the refresh error and keep the unrefreshed page 1, and the
    // list would then call itself complete.
    assert.equal(server.inFlight(LIST), 0, 'no page is asked for over a failed refresh');
    act(() => {
      list.pages().loadMore();
    });
    await flush();
    assert.equal(server.inFlight(LIST), 0, 'nor on request');
    assert.equal(list.pages().isStale, true);
    assert.equal(list.pages().isComplete, false);

    act(() => {
      list.pages().retry();
    });
    await flush();
    assert.deepEqual(server.pending(LIST), { skip: 0, limit: PAGE }, 'Retry rereads page 1');
    await answerPage([1, 7], true);
    assert.deepEqual(server.pending(LIST), { skip: PAGE, limit: PAGE }, 'then loading resumes');
    await answerPage([8], false);

    assert.deepEqual(list.ids(), [1, 7, 8]);
    assert.equal(list.pages().isStale, false);
    assert.equal(list.pages().isComplete, true);
  });

  it('re-stamps every held page when a refetch lands', async () => {
    list.render(true);
    await flush();
    await answerPage([1], true);
    await answerPage([2], false);
    const [first, second] = list.pages().items.map((item) => item.read.requestedAt);
    assert.ok(second > first, 'a later page is a later request');

    await flush(() => {
      void invalidateActivation(client, 1);
    });
    await answerPage([1], true);
    await answerPage([2], false);

    const [again, againSecond] = list.pages().items.map((item) => item.read.requestedAt);
    assert.ok(again > second, 'page 1 is stamped by the refetch');
    assert.ok(againSecond > again, 'and so is page 2');
  });

  it('says a first page that failed is an error, not an empty list', async () => {
    list.render(false);
    await flush();
    await flush(() => {
      server.settle(LIST, unreachable);
    });

    assert.equal(list.pages().isError, true);
    assert.equal(list.pages().items, undefined);
  });

  it('keeps the pages and says they are stale when a refresh fails', async () => {
    list.render(false);
    await flush();
    await answerPage([1], false);
    const stamp = list.pages().items[0].read.requestedAt;

    await flush(() => {
      void invalidateActivation(client, 1);
    });
    await flush(() => {
      server.settle(LIST, unreachable);
    });

    assert.equal(list.pages().isStale, true);
    assert.equal(list.pages().isError, false);
    assert.deepEqual(list.ids(), [1]);
    assert.equal(list.pages().items[0].read.requestedAt, stamp, 'the old stamp stays');
  });
});

describe('flattenFavoritePages', () => {
  const pageOf = (ids, requestedAt, over = {}) => ({
    page: {
      items: ids.map((id) => summary(id, over[id])),
      skip: 0,
      limit: PAGE,
      hasMore: false,
    },
    requestedAt,
  });

  it('keeps page order when no node repeats', () => {
    const items = flattenFavoritePages([pageOf([1, 2], 10), pageOf([3, 4], 11)]);

    assert.deepEqual(
      items.map((item) => item.node.id),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      items.map((item) => item.read.requestedAt),
      [10, 10, 11, 11],
    );
  });

  it('keeps only the newest copy of a node seen on two pages, where that page put it', () => {
    // B was renamed between the two requests, so it sorted after C on page 2.
    const items = flattenFavoritePages([
      pageOf([1, 2], 10, { 2: { title: 'Bee' } }),
      pageOf([3, 2], 11, { 2: { title: 'Zed' } }),
    ]);

    assert.deepEqual(
      items.map((item) => item.node.id),
      [1, 3, 2],
    );
    const renamed = items.find((item) => item.node.id === 2);
    assert.equal(renamed.node.title, 'Zed');
    assert.equal(renamed.read.requestedAt, 11);
    assert.equal(new Set(items.map((item) => item.node.id)).size, items.length, 'ids are unique');
  });

  it('carries each node favorite state into its read', () => {
    const [item] = flattenFavoritePages([pageOf([1], 7, { 1: { isFavorite: false } })]);

    assert.deepEqual(item.read, { id: 1, isFavorite: false, requestedAt: 7 });
  });

  it('drops an item that is not a container rather than draw it', () => {
    const items = flattenFavoritePages([
      pageOf([1, 2], 10, { 2: { type: 'resource', kind: 'note' } }),
    ]);

    assert.deepEqual(
      items.map((item) => item.node.id),
      [1],
    );
  });
});

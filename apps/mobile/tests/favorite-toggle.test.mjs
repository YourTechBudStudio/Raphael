/**
 * The favorite star, against a real cache and a transport that answers when this test says so.
 *
 * The property that carries the design is the freshness boundary: a confirmed answer shows until a
 * read of that node *requested after* the confirmation replaces it, and nothing else replaces it - a
 * read requested earlier, another page of the same list, or a refetch that failed. Each of those is
 * a separate case here, because each one would fail quietly if it regressed: the star would flick
 * back to a value the server had already replaced.
 *
 * Reads come from the real paged list where paging is the point, and are otherwise built from a
 * stamp taken at the moment the test says the read was requested.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { installDom } from './support/browser-dom.mjs';
import {
  ADD,
  LIST,
  REMOVE,
  lost,
  ok,
  onDemandServer,
  page,
  refused,
  summary,
  unreachable,
} from './support/favorites-server.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { InfiniteQueryObserver, QueryClient, QueryClientProvider } =
  await import('@tanstack/react-query');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');
const { nextReadStamp } = await import('../src/infrastructure/query/read-stamp.ts');
const { useFavoriteToggle } = await import('../src/modules/favorites/client/toggle.ts');
const { useFavoritePages } = await import('../src/modules/favorites/client/list.ts');
const { favoritePagesOptions } = await import('../src/modules/favorites/client/options.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');

after(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

// The keys the favorites module builds. Spelled here rather than imported: the seam between the
// write and the entries it may and may not touch is what is under test.
const confirmedKey = (activation) => scopeKey(activation, 'favorite-confirmed');
const listKey = (activation) => scopeKey(activation, 'favorites');

const A = 3;
const B = 4;

/** A read of `id` saying `isFavorite`, requested now. */
const readNow = (id, isFavorite) => ({ id, isFavorite, requestedAt: nextReadStamp() });

const answer = (isFavorite) => (body) => ok({ nodeId: body.target.id, isFavorite });

const freshClient = (queryGcTime = Infinity) =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: queryGcTime, staleTime: Infinity },
      mutations: { retry: false, gcTime: 0 },
    },
  });

const connect = (activation, transport) => {
  useConnectionStore.setState({
    phase: {
      kind: 'active',
      rejection: null,
      session: {
        activation,
        transport,
        connection: {
          connectionId: 'c1',
          base: 'https://raphael.example',
          origin: 'https://raphael.example',
          protocolVersion: PROTOCOL_VERSION,
        },
      },
    },
  });
};

const flush = async (step) => {
  await act(async () => {
    step?.();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

/**
 * Named controls, each holding its own `useFavoriteToggle()`, and optionally one reading the list.
 *
 * `show(['header', 'row'])` mounts two stars; `list: true` mounts the paged list beside them, which
 * is where page-stamped reads come from.
 */
const controls = (client) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const latest = new Map();
  let pages;

  function Control({ name }) {
    latest.set(name, useFavoriteToggle());

    return null;
  }

  function List() {
    pages = useFavoritePages({ complete: false });

    return null;
  }

  const show = (names, { list = false } = {}) => {
    act(() => {
      root.render(
        createElement(QueryClientProvider, { client }, [
          ...names.map((name) => createElement(Control, { key: name, name })),
          list ? createElement(List, { key: 'list' }) : null,
        ]),
      );
    });
  };

  return {
    show,
    at: (name) => latest.get(name),
    pages: () => pages,
    /** The read the list holds for `id`, stamped with its own page's request. */
    readOf: (id) => pages.items.find((item) => item.node.id === id).read,
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
let screen;

beforeEach(() => {
  client = freshClient();
  server = onDemandServer();
  connect(1, server.transport);
  screen = controls(client);
});

afterEach(async () => {
  await flush(() => {
    server.drain();
  });
  screen.unmount();
  client.clear();
});

describe('a write in flight', () => {
  it('sends the desired state, and every star for the node shows it and is busy', async () => {
    screen.show(['header', 'row']);
    const read = readNow(A, false);

    act(() => {
      screen.at('header').toggle(read);
    });
    await flush();

    assert.deepEqual(
      server.of(ADD).map((call) => call.body),
      [{ target: { id: A } }],
    );
    // The intent is read from the mutation cache, so a star that did not send it agrees.
    for (const name of ['header', 'row']) {
      assert.equal(screen.at(name).isFavorite(read), true, `${name} shows the intent`);
      assert.equal(screen.at(name).isBusy(A), true, `${name} is busy`);
    }
    assert.equal(screen.at('row').isBusy(B), false, 'another node is not');

    act(() => {
      screen.at('row').toggle(read);
    });
    await flush();
    assert.equal(server.asked.length, 1, 'a star is not pressable while its write is in flight');

    await flush(() => {
      server.settle(ADD, answer(true));
    });
    assert.equal(screen.at('header').isBusy(A), false);
    assert.equal(screen.at('header').failure, null);
  });

  it('sends remove for a star that shows starred', async () => {
    screen.show(['header']);

    act(() => {
      screen.at('header').toggle(readNow(A, true));
    });
    await flush();

    assert.deepEqual(
      server.of(REMOVE).map((call) => call.body),
      [{ target: { id: A } }],
    );
    assert.equal(server.of(ADD).length, 0);
  });
});

describe('a write the server accepts', () => {
  it('shows the answer over any read requested before it, even one that arrives after', async () => {
    screen.show(['header']);
    const before = readNow(A, false);

    act(() => {
      screen.at('header').toggle(before);
    });
    await flush();

    // Requested while the write was in flight, so it may have been read before the commit.
    const racing = readNow(A, false);

    await flush(() => {
      server.settle(ADD, answer(true));
    });

    assert.equal(screen.at('header').isFavorite(before), true);
    assert.equal(screen.at('header').isFavorite(racing), true, 'an earlier-requested read loses');
  });

  it('gives way to a read requested after it, even one that disagrees', async () => {
    screen.show(['header']);

    act(() => {
      screen.at('header').toggle(readNow(A, false));
    });
    await flush();
    await flush(() => {
      server.settle(ADD, answer(true));
    });

    // Another client removed it after this phone's write committed. A later read is the truth.
    assert.equal(screen.at('header').isFavorite(readNow(A, false)), false);
    assert.equal(screen.at('header').isFavorite(readNow(A, true)), true);
  });

  it('writes nothing into any read: only its own entry, and it refreshes the rest', async () => {
    screen.show(['header'], { list: true });
    await flush();
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(A)]));
    });
    const held = client.getQueryData(listKey(1));

    act(() => {
      screen.at('header').toggle(screen.readOf(A));
    });
    await flush();
    await flush(() => {
      server.settle(REMOVE, answer(false));
    });

    // The list is being read again, and until that lands its cached pages are exactly what the
    // server said: the answer was not written into them.
    assert.equal(server.inFlight(LIST), 1, 'the list is re-read');
    assert.equal(client.getQueryData(listKey(1)), held);
    assert.equal(client.getQueryData(listKey(1)).pages[0].page.items[0].isFavorite, true);
    assert.deepEqual(
      client
        .getQueryCache()
        .findAll()
        .map((query) => query.queryKey[2])
        .sort(),
      ['favorite-confirmed', 'favorites'],
      'no other entry was created',
    );
    assert.deepEqual(Object.keys(client.getQueryData(confirmedKey(1))), [String(A)]);
    assert.equal(screen.at('header').isFavorite(screen.readOf(A)), false);
  });

  it('still shows the answer when the reread fails', async () => {
    screen.show(['header'], { list: true });
    await flush();
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(A)]));
    });

    act(() => {
      screen.at('header').toggle(screen.readOf(A));
    });
    await flush();
    await flush(() => {
      server.settle(REMOVE, answer(false));
    });
    await flush(() => {
      server.settle(LIST, unreachable);
    });

    assert.equal(screen.pages().isStale, true, 'the list says its refresh failed');
    // The page kept its old stamp, so it is still older than the answer.
    assert.equal(screen.at('header').isFavorite(screen.readOf(A)), false);
  });

  it('is not replaced by a later page, though the list data moved on, but is by a refetch', async () => {
    screen.show(['header'], { list: true });
    await flush();
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(A)], true));
    });

    act(() => {
      screen.at('header').toggle(screen.readOf(A));
    });
    await flush();
    await flush(() => {
      server.settle(REMOVE, answer(false));
    });
    // The refresh the write started fails, so page 1 keeps the copy that says starred.
    await flush(() => {
      server.settle(LIST, unreachable);
    });
    const updatedBefore = client.getQueryState(listKey(1)).dataUpdatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Page 2 is asked for directly on the same query. The tab's own guard waits for Retry after a
    // failed refresh, but the star's rule must hold whatever order the pages arrive in.
    const direct = new InfiniteQueryObserver(client, {
      ...favoritePagesOptions(1, server.transport),
      refetchOnMount: false,
    });
    const stopDirect = direct.subscribe(() => undefined);
    await flush(() => {
      void direct.fetchNextPage();
    });
    assert.equal(server.pending(LIST).skip, 500, 'page 2 is asked for');
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(B)]));
    });

    assert.ok(
      client.getQueryState(listKey(1)).dataUpdatedAt > updatedBefore,
      'the whole query counts as updated',
    );
    assert.equal(screen.readOf(A).isFavorite, true, 'page 1 still says starred');
    assert.equal(screen.at('header').isFavorite(screen.readOf(A)), false, 'the answer holds');
    stopDirect();

    // A full refetch requests page 1 again, after the answer, so it is the truth now - here, that
    // another client starred it again.
    act(() => {
      screen.pages().retry();
    });
    await flush();
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(A)], true));
    });
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(B)]));
    });

    assert.equal(screen.at('header').isFavorite(screen.readOf(A)), true);
  });
});

describe('a write that does not go through', () => {
  it('reports a refusal as failed, records nothing, and rereads', async () => {
    screen.show(['header'], { list: true });
    await flush();
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(A)]));
    });

    act(() => {
      screen.at('header').toggle(screen.readOf(A));
    });
    await flush();
    await flush(() => {
      server.settle(REMOVE, refused);
    });

    assert.equal(screen.at('header').failure, 'failed');
    assert.equal(screen.at('header').isBusy(A), false);
    assert.equal(screen.at('header').isFavorite(screen.readOf(A)), true, 'back to the read');
    assert.deepEqual(client.getQueryData(confirmedKey(1)), {});
    assert.equal(server.inFlight(LIST), 1, 'and the list is re-read');
  });

  it('reports a lost answer as unconfirmed, and records nothing', async () => {
    screen.show(['header']);
    const read = readNow(A, false);

    act(() => {
      screen.at('header').toggle(read);
    });
    await flush();
    await flush(() => {
      server.settle(ADD, lost);
    });

    assert.equal(screen.at('header').failure, 'unconfirmed');
    assert.equal(screen.at('header').isFavorite(read), false);
    assert.deepEqual(client.getQueryData(confirmedKey(1)), {});
  });

  it('keeps each verdict with the star that earned it', async () => {
    screen.show(['a', 'b']);

    act(() => {
      screen.at('a').toggle(readNow(A, false));
    });
    await flush();
    act(() => {
      screen.at('b').toggle(readNow(B, false));
    });
    await flush();

    await flush(() => {
      server.settle(ADD, refused);
    });
    await flush(() => {
      server.settle(ADD, answer(true));
    });

    assert.equal(screen.at('a').failure, 'failed');
    assert.equal(screen.at('b').failure, null);
  });
});

describe('the confirmed answers', () => {
  it('outlive every star unmounting, and garbage collection', async () => {
    // Every other query is collected almost at once; the answers opt out of that.
    client = freshClient(1);
    screen.unmount();
    screen = controls(client);
    screen.show(['header']);
    const before = readNow(A, false);

    act(() => {
      screen.at('header').toggle(before);
    });
    await flush();
    await flush(() => {
      server.settle(ADD, answer(true));
    });

    screen.show([]);
    // Something collectable, to prove collection ran while the answers stayed.
    client.setQueryData(scopeKey(1, 'collectable'), 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flush();

    assert.equal(client.getQueryData(scopeKey(1, 'collectable')), undefined, 'collection ran');
    assert.equal(client.getQueryData(confirmedKey(1))[A].isFavorite, true);

    screen.show(['later']);
    assert.equal(screen.at('later').isFavorite(before), true, 'a later star still shows it');
  });

  it('belong to the connection that confirmed them', async () => {
    screen.show(['header']);
    const before = readNow(A, false);

    act(() => {
      screen.at('header').toggle(before);
    });
    await flush();
    await flush(() => {
      server.settle(ADD, answer(true));
    });

    act(() => {
      connect(2, server.transport);
    });
    await flush();

    assert.equal(screen.at('header').isFavorite(before), false, 'a new activation has none');
  });
});

/**
 * Browse → Favorites, rendered: the server's list as one flat list of rows, in its order.
 *
 * Three things are pinned here, and each would be easy to lose without anything else failing.
 *
 * **A failure is never an empty list, and never "no match".** The first page failing is an error with
 * Retry; a refresh failing keeps the rows and says they may be out of date; a later page failing keeps
 * the rows above it. A filter says "No favorite matches" only once every page has loaded, and a page
 * that fails while it is checking is reported as exactly that.
 *
 * **The hierarchy only names parents.** The server decides which favorites exist and in what order;
 * the tree only supplies the parent pill, and a stale tree supplies nothing.
 *
 * **Each row owns its verdict.** A refusal for one row stays on that row when another row is tapped
 * while the first is still in flight.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { installDom } from './support/browser-dom.mjs';
import {
  ADD,
  LIST,
  REMOVE,
  ok,
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');
const { FavoritesList } = await import('../src/modules/browse/components/FavoritesList.tsx');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');

after(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const HIERARCHY = '/api/nodes/list';
const PAGE = 500;

const WORK = summary(1, { title: 'Work', slug: 'work', isFavorite: false });
const HOME = summary(2, { title: 'Home', slug: 'home', isFavorite: false });
const AUTH = summary(10, { type: 'project', parentId: 1, title: 'Auth rework' });
const BIKE = summary(11, { type: 'project', parentId: 2, title: 'Bike repair' });
const GARDEN = summary(3, { title: 'Garden', slug: 'garden' });

/**
 * A server holding favorites as explicit pages, one array per page, and a hierarchy.
 *
 * `next(path, mode)` decides what the next request on `path` gets: `'hold'` keeps it open until
 * `release(path, reply)`, `'fail'` answers unreachable. Writes are always held, so the test decides
 * each one's outcome; an accepted remove takes the node off the pages, as the server would.
 */
const fakeServer = (pages, hierarchy = [WORK, HOME, AUTH, BIKE]) => {
  const modes = new Map();
  const held = [];
  const asked = [];

  const favoritesPage = (body) => {
    const index = body.skip / PAGE;

    return ok({
      items: pages[index] ?? [],
      skip: body.skip,
      limit: body.limit,
      hasMore: index < pages.length - 1,
    });
  };

  const answer = (path, body) =>
    path === LIST
      ? favoritesPage(body)
      : ok({ items: hierarchy, skip: 0, limit: body.limit ?? 200, hasMore: false });

  return {
    asked,
    of: (path) => asked.filter((call) => call.path === path),
    next: (path, mode) => {
      modes.set(path, mode);
    },
    /** Answers the oldest held request on `path`, with `reply(body)` or as the server would. */
    release: (path, reply) => {
      const index = held.findIndex((call) => call.path === path);
      assert.ok(index !== -1, `a request on ${path} is being held`);
      const [call] = held.splice(index, 1);

      if (reply === 'accept') {
        const wanted = path === ADD;
        const id = call.body.target.id;
        if (!wanted) pages.forEach((p, i) => (pages[i] = p.filter((node) => node.id !== id)));
        call.resolve(ok({ nodeId: id, isFavorite: wanted }));

        return;
      }

      call.resolve(reply === undefined ? answer(path, call.body) : reply(call.body));
    },
    drain: () => {
      for (const call of held.splice(0)) call.resolve(unreachable());
    },
    transport: {
      endpoint: { origin: 'https://example.invalid', basePath: '' },
      timeoutMs: 1000,
      invoke: (call) => {
        const path = call.route.path;
        const mode = path === ADD || path === REMOVE ? 'hold' : modes.get(path);
        modes.delete(path);
        asked.push({ path, body: call.body });

        if (mode === 'fail') return Promise.resolve(unreachable());
        if (mode === 'hold') {
          return new Promise((resolve) => {
            held.push({ path, body: call.body, resolve });
          });
        }

        return Promise.resolve(answer(path, call.body));
      },
    },
  };
};

const flush = async (step) => {
  await act(async () => {
    step?.();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

let client;
let server;
const mounted = [];

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false, gcTime: 0 },
    },
  });
});

afterEach(async () => {
  await flush(() => {
    server?.drain();
  });
  for (const unmount of mounted.splice(0)) unmount();
  client.clear();
});

const connect = (pages, hierarchy) => {
  server = fakeServer(pages, hierarchy);
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
};

/** The tab over a server holding `pages`, filtered by `query`. */
const openTab = async (pages, { query = '', hierarchy, before } = {}) => {
  connect(pages, hierarchy);
  before?.(server);

  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const selected = [];

  const render = (text) => {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(FavoritesList, {
            query: text,
            onSelect: (ref) => {
              selected.push(ref);
            },
          }),
        ),
      );
    });
  };

  render(query);
  await flush();
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  const $ = (selector) => host.querySelector(selector);
  const rowOf = (title) =>
    [...host.querySelectorAll('[data-testid="favorite-row"]')].find((row) =>
      (row.textContent ?? '').includes(title),
    );

  return {
    selected,
    filter: async (text) => {
      render(text);
      await flush();
    },
    text: () => host.textContent ?? '',
    has: (selector) => $(selector) !== null,
    /** The spoken label of every row, top to bottom. */
    rows: () =>
      [
        ...host.querySelectorAll('[data-testid="favorite-row"] [role="button"][aria-description]'),
      ].map((row) => row.getAttribute('aria-label')),
    rowOf,
    starOf: (title) =>
      rowOf(title).querySelector(
        `[aria-label="Add ${title} to favorites"], [aria-label="Remove ${title} from favorites"]`,
      ),
    press: async (element) => {
      assert.ok(element !== null && element !== undefined, 'the control is on screen');
      await flush(() => {
        element.click();
      });
    },
    pressText: async (label) => {
      const element = [...host.querySelectorAll('[role="button"]')].find(
        (candidate) => candidate.getAttribute('aria-label') === label,
      );
      assert.ok(element !== undefined, `${label} is on screen`);
      await flush(() => {
        element.click();
      });
    },
  };
};

const EMPTY = 'No favorites yet. Star an area or project to keep a shortcut here.';

describe('the list', () => {
  it('is flat rows in the server order, each naming its kind and parent', async () => {
    const tab = await openTab([[AUTH, BIKE, GARDEN]]);

    assert.deepEqual(tab.rows(), [
      'Auth rework, Project, in Work',
      'Bike repair, Project, in Home',
      'Garden, Area',
    ]);
    assert.ok(tab.starOf('Auth rework') !== null, 'each row carries its star');
  });

  it('opens the container a row stands for', async () => {
    const tab = await openTab([[AUTH, GARDEN]]);

    await tab.press(tab.rowOf('Garden').querySelector('[aria-description]'));

    assert.deepEqual(tab.selected, [{ type: 'area', id: 3 }]);
  });

  it('leaves the parent out while the hierarchy is stale, and still lists every favorite', async () => {
    const tab = await openTab([[AUTH, GARDEN]]);

    server.next(HIERARCHY, 'fail');
    await flush(() => {
      void client.invalidateQueries({ queryKey: scopeKey(1, 'hierarchy') });
    });

    assert.deepEqual(tab.rows(), ['Auth rework, Project', 'Garden, Area']);
  });

  it('says it is loading in a plain sentence', async () => {
    const tab = await openTab([[AUTH]], { before: (s) => s.next(LIST, 'hold') });

    assert.ok(tab.text().includes('Loading favorites…'));
    assert.deepEqual(tab.rows(), []);
  });

  it('says there are none in a plain sentence, with no card', async () => {
    const tab = await openTab([[]]);

    assert.equal(tab.text(), EMPTY);
  });

  it('says a first page that failed did not load, and Retry reads it again', async () => {
    const tab = await openTab([[AUTH]], { before: (s) => s.next(LIST, 'fail') });

    assert.ok(tab.text().includes('Favorites did not load.'));
    assert.ok(!tab.text().includes(EMPTY), 'a failure is never an empty list');

    await tab.pressText('Try again');

    assert.deepEqual(tab.rows(), ['Auth rework, Project, in Work']);
  });

  it('keeps the rows and says they may be out of date when a refresh fails', async () => {
    const tab = await openTab([[AUTH]]);

    server.next(LIST, 'fail');
    await flush(() => {
      void client.invalidateQueries({ queryKey: scopeKey(1, 'favorites') });
    });

    assert.ok(tab.text().includes('Favorites may be out of date. The last refresh did not load.'));
    assert.deepEqual(tab.rows(), ['Auth rework, Project, in Work']);

    await tab.pressText('Retry');

    assert.ok(!tab.has('[data-testid="favorites-stale"]'), 'a refresh that lands clears it');
  });

  it('shows more on request, and says so under the rows when the next page fails', async () => {
    const tab = await openTab([[AUTH], [GARDEN]]);

    assert.ok(tab.has('[data-testid="favorites-show-more"]'));
    assert.equal(server.of(LIST).length, 1, 'nothing more is asked for on its own');

    server.next(LIST, 'fail');
    await tab.pressText('Show more');

    assert.ok(tab.text().includes('More favorites did not load.'));
    assert.deepEqual(tab.rows(), ['Auth rework, Project, in Work'], 'the rows above stay');
    assert.ok(!tab.has('[data-testid="favorites-show-more"]'));

    await tab.pressText('Retry');

    assert.deepEqual(server.of(LIST).at(-1).body, { skip: PAGE, limit: PAGE });
    assert.deepEqual(tab.rows(), ['Auth rework, Project, in Work', 'Garden, Area']);
    assert.ok(!tab.has('[data-testid="favorites-show-more"]'), 'and ends when the list does');
  });
});

describe('the filter', () => {
  it('loads every page before it says anything, then matches titles in any case', async () => {
    const tab = await openTab([[AUTH], [BIKE], [GARDEN]]);

    server.next(LIST, 'hold');
    await tab.filter('  GARDEN ');

    assert.ok(tab.text().includes('Checking every favorite…'));
    assert.deepEqual(tab.rows(), []);

    await flush(() => {
      server.release(LIST);
    });

    assert.deepEqual(
      server.of(LIST).map((call) => call.body.skip),
      [0, PAGE, 2 * PAGE],
    );
    assert.deepEqual(tab.rows(), ['Garden, Area']);
  });

  it('says nothing matches only once every page has been checked', async () => {
    const tab = await openTab([[AUTH], [GARDEN]]);

    server.next(LIST, 'hold');
    await tab.filter('zebra');
    assert.ok(!tab.text().includes('No favorite matches'));

    await flush(() => {
      server.release(LIST);
    });

    assert.equal(tab.text(), 'No favorite matches “zebra”.');
  });

  it('reports a page that failed while checking, not as no match', async () => {
    const tab = await openTab([[AUTH], [GARDEN]]);

    server.next(LIST, 'fail');
    await tab.filter('zebra');

    assert.ok(
      tab.text().includes('Could not check every favorite, so the filter cannot say what matches.'),
    );
    assert.ok(!tab.text().includes('No favorite matches'));

    await tab.pressText('Retry');

    assert.equal(tab.text(), 'No favorite matches “zebra”.');
  });
});

describe('a failed refresh', () => {
  it('keeps a filter from saying nothing matches until Retry rereads the list', async () => {
    const pages = [[AUTH], [BIKE]];
    const tab = await openTab(pages);

    server.next(LIST, 'fail');
    await flush(() => {
      void client.invalidateQueries({ queryKey: scopeKey(1, 'favorites') });
    });
    assert.ok(!tab.has('[data-testid="favorites-show-more"]'), 'no next page over a stale list');

    // A match moved into page 1 after the refresh failed.
    pages[0] = [AUTH, GARDEN];
    await tab.filter('garden');

    assert.ok(
      tab.text().includes('Could not check every favorite, so the filter cannot say what matches.'),
    );
    assert.ok(!tab.text().includes('No favorite matches'));
    assert.equal(server.of(LIST).length, 2, 'no page was read over the failed refresh');

    await tab.pressText('Retry');

    assert.deepEqual(tab.rows(), ['Garden, Area']);
  });
});

describe('the row star', () => {
  it('is busy while its change is in flight, and the row leaves once the list refreshes', async () => {
    const tab = await openTab([[AUTH, GARDEN]]);

    await tab.press(tab.starOf('Garden'));

    const star = tab.starOf('Garden');
    assert.equal(star.getAttribute('aria-busy'), 'true');
    assert.equal(star.getAttribute('aria-label'), 'Add Garden to favorites', 'shows the intent');
    assert.deepEqual(server.of(REMOVE).at(-1).body, { target: { id: 3 } });

    await flush(() => {
      server.release(REMOVE, 'accept');
    });

    assert.deepEqual(tab.rows(), ['Auth rework, Project, in Work']);
  });

  it('keeps each verdict with its own row', async () => {
    const tab = await openTab([[AUTH, GARDEN]]);

    await tab.press(tab.starOf('Auth rework'));
    await tab.press(tab.starOf('Garden'));
    assert.equal(server.of(REMOVE).length, 2, 'both are in flight');

    await flush(() => {
      server.release(REMOVE, refused);
    });
    await flush(() => {
      server.release(REMOVE, 'accept');
    });

    assert.deepEqual(tab.rows(), ['Auth rework, Project, in Work']);
    assert.ok(tab.rowOf('Auth rework').textContent.includes('Favorite did not update. Try again.'));
    assert.equal(
      tab.starOf('Auth rework').getAttribute('aria-label'),
      'Remove Auth rework from favorites',
    );
  });
});

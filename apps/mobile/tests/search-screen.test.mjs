/**
 * Search, rendered: one ranked list that pages on scroll, and the way back to archived material.
 *
 * The list is the server's answer in the server's order, one `ListRow` per hit with no headings. It
 * grows as the end scrolls into view; a page that is loading says so, a page that failed keeps
 * every row above it and offers Retry, and the list never looks finished while a page is missing.
 *
 * On the phone there is no archive page: Search with "Include archived" is how something archived is
 * found again, then opened and restored where it lives. Two things make that work and are pinned
 * here.
 *
 * **The filter is a filter like the others.** It lives in the sheet, it marks the filter button
 * active, and archived hits say so with the Archived pill - a word, not color alone.
 *
 * **The left-out line never promises nothing.** It is drawn only when the server said an archived
 * node matched and was left out, so pressing its button always adds results - including when
 * nothing active matched at all. It describes the whole match set, so it waits for the list to end.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';
import { describeQueryRejection, inspectQueryInput } from '@raphael/contracts/nodes';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { SearchScreen } = await import('../src/modules/search/components/SearchScreen.tsx');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { navigations, resetNavigations } = await import('./support/stubs/expo-router.mjs');

queryClient.setDefaultOptions({
  queries: { retry: false, gcTime: 0 },
  mutations: { retry: false, gcTime: 0 },
});

after(async () => {
  queryClient.clear();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const summary = (id, type, parentId, title, archived = false) => ({
  id,
  type,
  kind: type === 'resource' ? 'note' : null,
  parentId,
  slug: title.toLowerCase().replace(/\s+/g, '-'),
  revision: 1,
  title,
  description: '',
  tags: [],
  active: false,
  archived,
  isFavorite: false,
});

const WORK = summary(1, 'area', null, 'Work');
const ACTIVE_PROJECT = summary(12, 'project', 1, 'Auth rework');
const ARCHIVED_PROJECT = summary(13, 'project', 1, 'Auth spike', true);
const ARCHIVED_NOTE = summary(41, 'resource', 13, 'Auth runbook', true);

/** Active projects under Work, numbered from 100, for lists long enough to page. */
const many = (count) =>
  Array.from({ length: count }, (_, index) =>
    summary(100 + index, 'project', 1, `Auth ${String(100 + index)}`),
  );

const transportFailure = { kind: 'network', message: 'The server could not be reached.' };

const scopeGoneFailure = {
  kind: 'http',
  status: 404,
  code: 'node_not_found',
  message: 'Scope 1 does not exist.',
};

/**
 * Answers Search from `hits` the way the server does: in the order given, a page at a time from the
 * request's `skip`, archived hits only when asked for, and `archivedLeftOut` exactly when one matched
 * and was left out.
 *
 * `server.next` decides what the next search request gets: `'answer'` (the default), `'hold'` (kept
 * open until `release()`), `'fail'`, or `'gone'` (the scope is not there). It applies to one request
 * and then goes back to answering.
 */
const fakeServer = (hits) => {
  const searches = [];
  const held = [];
  const server = { searches, next: 'answer' };

  const answerFor = (body) => {
    const included = body.includeArchived === true;
    const matched = hits.filter((hit) => included || !hit.archived);
    const items = matched.slice(body.skip, body.skip + body.limit);

    return {
      ok: true,
      value: {
        items: items.map((node) => ({ node })),
        skip: body.skip,
        limit: body.limit,
        hasMore: body.skip + body.limit < matched.length,
        archivedLeftOut: !included && matched.length < hits.length,
      },
    };
  };

  server.release = () => {
    const next = held.shift();
    assert.ok(next !== undefined, 'a search is being held');
    next();
  };

  server.transport = {
    endpoint: { origin: 'https://example.invalid', basePath: '' },
    timeoutMs: 1000,
    invoke: (call) => {
      if (call.route.path === '/api/nodes/list') {
        return Promise.resolve({
          ok: true,
          value: { items: [WORK, ACTIVE_PROJECT], skip: 0, limit: 200, hasMore: false },
        });
      }

      searches.push(call.body);
      const mode = server.next;
      server.next = 'answer';

      if (mode === 'fail') return Promise.resolve({ ok: false, failure: transportFailure });
      if (mode === 'gone') return Promise.resolve({ ok: false, failure: scopeGoneFailure });
      if (mode === 'hold') {
        return new Promise((resolve) => {
          held.push(() => {
            resolve(answerFor(call.body));
          });
        });
      }

      return Promise.resolve(answerFor(call.body));
    },
  };

  return server;
};

let server;

const connect = (hits) => {
  server = fakeServer(hits);
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

beforeEach(() => {
  queryClient.clear();
});

const mounted = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

/** Past the screen's debounce, and long enough for the answer to reach the screen. */
const settle = async (step) => {
  await act(async () => {
    step?.();
    await new Promise((resolve) => setTimeout(resolve, 350));

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

/**
 * Search for `query` over a server holding `hits`. `first` is what the first search request gets;
 * `scope` limits the search to a container.
 */
const searchFor = async (query, hits, { first = 'answer', scope } = {}) => {
  connect(hits);
  server.next = first;

  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SearchScreen, scope === undefined ? {} : { scope }),
      ),
    );
  });
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  const field = host.querySelector('input[aria-label="Search"]');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value');

  await settle(() => {
    setter.set.call(field, query);
    field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  // The search is issued once the debounced query has rendered; this lets its answer arrive.
  await settle();

  const $ = (selector) => host.querySelector(selector);

  return {
    text: () => host.textContent ?? '',
    has: (selector) => $(selector) !== null,
    count: (selector) => host.querySelectorAll(selector).length,
    /** The spoken label of every result row, top to bottom. */
    rows: () =>
      [...host.querySelectorAll('[data-testid="search-result"] [role="button"]')].map((row) =>
        row.getAttribute('aria-label'),
      ),
    /** Scrolls to the end of the list, which is what asks for the next page. */
    reachEnd: async () => {
      const scroller = $('[data-scrollview]');

      assert.ok(scroller !== null, 'the screen scrolls');
      await settle(() => {
        const event = new dom.window.Event('scroll');
        Object.assign(event, {
          contentOffset: { x: 0, y: 4000 },
          contentSize: { width: 400, height: 4800 },
          layoutMeasurement: { width: 400, height: 800 },
        });
        scroller.dispatchEvent(event);
      });
    },
    filterButton: () => $('[aria-label="Filters"]') ?? $('[aria-label="Filters, active"]'),
    press: async (selector) => {
      const element = $(selector);

      assert.ok(element !== null, `${selector} is on screen`);
      await settle(() => {
        element.click();
      });
    },
  };
};

const LEFT_OUT = 'Archived matches are left out.';

describe('the Include archived filter', () => {
  it('is its own section in the filter sheet, and marks the filter button active', async () => {
    const screen = await searchFor('auth', [ACTIVE_PROJECT, ARCHIVED_PROJECT, ARCHIVED_NOTE]);

    assert.equal(screen.filterButton().getAttribute('aria-label'), 'Filters');
    await screen.press('[aria-label="Filters"]');

    assert.ok(screen.text().includes('Archived'), 'the sheet has an Archived section');
    await screen.press('[data-testid="include-archived"]');

    assert.equal(screen.filterButton().getAttribute('aria-label'), 'Filters, active');
    assert.equal(server.searches.at(-1).includeArchived, true);
  });

  it('adds archived hits, each with the Archived pill and saying so aloud', async () => {
    const screen = await searchFor('auth', [ACTIVE_PROJECT, ARCHIVED_PROJECT, ARCHIVED_NOTE]);

    assert.ok(!screen.text().includes('Auth spike'));
    assert.equal(screen.count('[data-testid="search-result"] [data-icon="Archive"]'), 0);

    await screen.press('[aria-label="Filters"]');
    await screen.press('[data-testid="include-archived"]');

    assert.ok(screen.text().includes('Auth spike'));
    assert.ok(screen.text().includes('Auth runbook'));
    // One on the archived project's row, one on the archived note's row, none on the active one.
    assert.equal(screen.count('[data-testid="search-result"] [data-icon="Archive"]'), 2);
    // The pill is silent, so the row says it. The note's parent is not in the loaded tree, so it
    // is named without one rather than with a guess.
    assert.deepEqual(screen.rows(), [
      'Auth rework, Project, in Work',
      'Auth spike, Project, archived, in Work',
      'Auth runbook, Note, archived',
    ]);
  });
});

describe('the left-out line', () => {
  it('shows when an archived node matched, and its button turns the filter on in place', async () => {
    const screen = await searchFor('auth', [ACTIVE_PROJECT, ARCHIVED_PROJECT]);

    assert.ok(screen.text().includes(LEFT_OUT));
    await screen.press('[data-testid="include-archived-inline"]');

    assert.equal(server.searches.at(-1).includeArchived, true);
    assert.ok(screen.text().includes('Auth spike'), 'pressing it added results');
    assert.ok(!screen.text().includes(LEFT_OUT), 'and it is gone once they are included');
    assert.equal(screen.filterButton().getAttribute('aria-label'), 'Filters, active');
  });

  it('shows on an empty result too, when only archived nodes matched', async () => {
    const screen = await searchFor('spike', [ARCHIVED_PROJECT]);

    assert.ok(screen.text().includes('Nothing matches “spike”.'));
    assert.ok(screen.text().includes(LEFT_OUT));
    assert.ok(screen.has('[data-testid="include-archived-inline"]'));
  });

  it('is not drawn when nothing archived matched, with results or without', async () => {
    const some = await searchFor('auth', [ACTIVE_PROJECT]);

    assert.ok(!some.text().includes(LEFT_OUT));
    assert.ok(!some.has('[data-testid="include-archived-inline"]'));

    const none = await searchFor('zebra', []);

    assert.ok(none.text().includes('Nothing matches “zebra”.'));
    assert.ok(!none.text().includes(LEFT_OUT));
    assert.ok(!none.has('[data-testid="include-archived-inline"]'));
  });
});

describe('one ranked list', () => {
  it("draws every hit as a row, in the server's order, with no section headings", async () => {
    const note = summary(41, 'resource', 12, 'Auth checklist');
    const screen = await searchFor('auth', [note, ACTIVE_PROJECT, WORK]);

    assert.deepEqual(screen.rows(), [
      'Auth checklist, Note, in Auth rework',
      'Auth rework, Project, in Work',
      'Work, Area',
    ]);
    for (const heading of ['Areas', 'Projects', 'Notes']) {
      assert.ok(!screen.text().includes(heading), `no "${heading}" heading`);
    }
  });

  it('opens each kind where it lives, and says so before it is pressed', async () => {
    const note = summary(41, 'resource', 12, 'Auth checklist');
    const screen = await searchFor('auth', [note, ACTIVE_PROJECT, WORK]);
    const row = (label) => `[data-testid="search-result"] [aria-label="${label}"]`;

    assert.equal(
      screen.count(
        `${row('Auth rework, Project, in Work')}[aria-description="Opens this project"]`,
      ),
      1,
    );
    assert.equal(screen.count(`${row('Work, Area')}[aria-description="Opens this area"]`), 1);

    resetNavigations();
    await screen.press(row('Work, Area'));
    await screen.press(row('Auth rework, Project, in Work'));
    await screen.press(row('Auth checklist, Note, in Auth rework'));

    assert.deepEqual(
      navigations.map((navigation) => navigation.target),
      [
        { pathname: '/area/[id]', params: { id: '1' } },
        { pathname: '/project/[id]', params: { id: '12' } },
        { pathname: '/edit/[id]', params: { id: '41' } },
      ],
    );
  });
});

describe('paging on scroll', () => {
  it('asks for the next page at the end of the list, and appends it', async () => {
    const screen = await searchFor('auth', many(60));

    assert.equal(screen.count('[data-testid="search-result"]'), 50);
    assert.equal(server.searches.length, 1);

    await screen.reachEnd();

    assert.equal(server.searches.length, 2);
    assert.equal(server.searches[1].skip, 50);
    assert.equal(screen.count('[data-testid="search-result"]'), 60);
    assert.ok(!screen.text().includes('Showing the first'), 'there is no cap to announce');

    await screen.reachEnd();
    assert.equal(server.searches.length, 2, 'nothing more to ask for once the list has ended');
  });

  it('says it is loading more while the next page is read', async () => {
    const screen = await searchFor('auth', many(60));

    server.next = 'hold';
    await screen.reachEnd();

    assert.ok(screen.text().includes('Loading more…'));
    assert.equal(screen.count('[data-testid="search-result"]'), 50);

    await settle(() => {
      server.release();
    });

    assert.ok(!screen.text().includes('Loading more…'));
    assert.equal(screen.count('[data-testid="search-result"]'), 60);
  });

  it('keeps every row when a page fails, and Retry asks for it again', async () => {
    const screen = await searchFor('auth', many(60));

    server.next = 'fail';
    await screen.reachEnd();

    assert.ok(screen.text().includes('More results did not load.'));
    assert.equal(screen.count('[data-testid="search-result"]'), 50, 'the rows already read stay');
    assert.ok(!screen.text().includes('Search could not be refreshed'), 'not a stale search');

    await screen.reachEnd();
    assert.equal(server.searches.length, 2, 'scrolling does not ask again after a failure');

    await screen.press('[data-testid="more-failed"] [role="button"]');

    assert.equal(server.searches.length, 3);
    assert.equal(server.searches[2].skip, 50);
    assert.ok(!screen.text().includes('More results did not load.'));
    assert.equal(screen.count('[data-testid="search-result"]'), 60);
  });

  it('offers archived matches only once the list has ended', async () => {
    const screen = await searchFor('auth', [...many(60), ARCHIVED_PROJECT]);

    assert.ok(!screen.text().includes(LEFT_OUT), 'not while more rows are still to come');

    await screen.reachEnd();

    assert.ok(screen.text().includes(LEFT_OUT));
  });

  it('never offers them while a page has failed', async () => {
    const screen = await searchFor('auth', [...many(60), ARCHIVED_PROJECT]);

    server.next = 'fail';
    await screen.reachEnd();

    assert.ok(screen.text().includes('More results did not load.'));
    assert.ok(!screen.text().includes(LEFT_OUT));
  });
});

describe('the states that are not a list', () => {
  it('explains itself before anything is typed, and asks nothing', async () => {
    const screen = await searchFor('', [ACTIVE_PROJECT]);

    assert.ok(screen.text().includes('Titles, descriptions and note text all count.'));
    assert.equal(server.searches.length, 0);
  });

  it('says what is wrong with a query instead of sending it', async () => {
    const query = 'auth AND';
    const rejection = inspectQueryInput(query);

    assert.ok(rejection !== undefined, 'the query is one the contract refuses');
    const screen = await searchFor(query, [ACTIVE_PROJECT]);

    assert.ok(screen.text().includes(describeQueryRejection(rejection)));
    assert.equal(server.searches.length, 0);
  });

  it('says a scope is gone, and offers to search everything', async () => {
    const screen = await searchFor('auth', [ACTIVE_PROJECT], {
      first: 'gone',
      scope: { type: 'project', id: 99 },
    });

    assert.ok(screen.text().includes('That project is no longer here.'));
    await screen.press('[aria-label="Search everything"]');

    assert.deepEqual(server.searches.at(-1).scopes, [{ path: '/' }]);
    assert.deepEqual(screen.rows(), ['Auth rework, Project, in Work']);
  });

  it('says it is searching while the first page is read', async () => {
    const screen = await searchFor('auth', [ACTIVE_PROJECT], { first: 'hold' });

    assert.ok(screen.text().includes('Searching…'));
    await settle(() => {
      server.release();
    });
    assert.deepEqual(screen.rows(), ['Auth rework, Project, in Work']);
  });

  it('says search did not answer when the first page fails', async () => {
    const screen = await searchFor('auth', [ACTIVE_PROJECT], { first: 'fail' });

    assert.ok(screen.text().includes('Search did not answer.'));
    assert.equal(screen.count('[data-testid="search-result"]'), 0);
  });

  it('keeps the last reading when reading it again fails, and says so', async () => {
    const screen = await searchFor('auth', [ACTIVE_PROJECT]);

    server.next = 'fail';
    await settle(() => {
      void queryClient.refetchQueries();
    });

    assert.ok(screen.text().includes('Search could not be refreshed. This is the last reading.'));
    assert.deepEqual(screen.rows(), ['Auth rework, Project, in Work']);
  });

  it('says nothing matched when nothing did', async () => {
    const screen = await searchFor('zebra', []);

    assert.ok(screen.text().includes('Nothing matches “zebra”.'));
    assert.equal(screen.count('[data-testid="search-result"]'), 0);
  });
});

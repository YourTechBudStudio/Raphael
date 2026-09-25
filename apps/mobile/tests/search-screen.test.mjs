/**
 * Search as the way back to archived material, rendered.
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
 * nothing active matched at all.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

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
});

const WORK = summary(1, 'area', null, 'Work');
const ACTIVE_PROJECT = summary(12, 'project', 1, 'Auth rework');
const ARCHIVED_PROJECT = summary(13, 'project', 1, 'Auth spike', true);
const ARCHIVED_NOTE = summary(41, 'resource', 13, 'Auth runbook', true);

/**
 * Answers Search from `hits` the way the server does: archived hits only when asked for, and
 * `archivedLeftOut` exactly when one matched and was left out.
 */
const fakeServer = (hits) => {
  const searches = [];

  return {
    searches,
    transport: {
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

        const included = call.body.includeArchived === true;
        const items = hits.filter((hit) => included || !hit.archived);

        return Promise.resolve({
          ok: true,
          value: {
            items: items.map((node) => ({ node })),
            skip: 0,
            limit: call.body.limit,
            hasMore: false,
            archivedLeftOut: !included && items.length < hits.length,
          },
        });
      },
    },
  };
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

/** Search for `query` over a server holding `hits`. */
const searchFor = async (query, hits) => {
  connect(hits);

  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(SearchScreen)),
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

  it('adds archived hits, each with the Archived pill, on tiles and note cards alike', async () => {
    const screen = await searchFor('auth', [ACTIVE_PROJECT, ARCHIVED_PROJECT, ARCHIVED_NOTE]);

    assert.ok(!screen.text().includes('Auth spike'));
    assert.equal(screen.count('[data-testid="archived-pill"]'), 0);

    await screen.press('[aria-label="Filters"]');
    await screen.press('[data-testid="include-archived"]');

    assert.ok(screen.text().includes('Auth spike'));
    assert.ok(screen.text().includes('Auth runbook'));
    // One on the archived project's tile, one on the archived note's card, none on the active one.
    assert.equal(screen.count('[data-testid="archived-pill"]'), 2);
    assert.ok(screen.has('[aria-label="Auth spike, Archived"]'));
    assert.ok(screen.has('[aria-label="Auth rework"]'));
    assert.ok(screen.has('[aria-label^="Note. Archived. Auth runbook"]'));
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

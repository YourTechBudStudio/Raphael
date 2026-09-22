/**
 * What Home shows for the projects someone is working on.
 *
 * The section reads the server's own answer out of the one hierarchy traversal the app already
 * performs, so every state it can be in is a state of that traversal: not arrived, arrived, arrived
 * and then failed to refresh, or never arrived at all. Each of those says something different, and
 * each is drawn differently, which is what these cases pin.
 *
 * Two of them are worth naming because they look like bugs and are not.
 *
 * **A refused toggle's sentence belongs to one card.** Each card holds its own hook instance, so a
 * refusal on one must not appear under another. With a single screen-level instance this test would
 * pass for the wrong reason, because there would be only one card's worth of state to get right.
 *
 * **A successful deactivate whose refresh then fails leaves the card on screen**, showing the value
 * from the retained reading, under the banner that says the reading is not current. That is the
 * accepted tail of awaiting the re-read, and it is documented here rather than hidden.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { navigations, resetNavigations } = await import('./support/stubs/expo-router.mjs');
const { HomeScreen } = await import('../src/modules/home/components/HomeScreen.tsx');
const { useCaptureOwner } = await import('../src/modules/capture/client/owner.ts');
const { useEditOwner } = await import('../src/modules/capture/client/edit-owner.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');

// `gcTime: 0` on mutations matters as much as on queries here: a settled mutation otherwise holds a
// five-minute collection timer, and the test process stays alive for it.
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

/**
 * A container as the server lists it.
 *
 * The tree is built by the app's own traversal from these rather than hand-assembled and seeded, so
 * these cases exercise the projection that carries `revision` and `active` through instead of
 * restating its output. Slugs decide sibling order, so they are chosen to make the expected order
 * unambiguous.
 */
const summary = (id, type, parentId, title, slug, active = false) => ({
  id,
  type,
  kind: null,
  parentId,
  slug,
  revision: 3,
  title,
  description: '',
  tags: [],
  active,
});

/** Alpha holds a selected project and an unselected one; Beta holds the other selected one. */
const CONTAINERS = [
  summary(1, 'area', null, 'Alpha', 'alpha'),
  summary(2, 'area', null, 'Beta', 'beta'),
  summary(11, 'project', 1, 'Backend', 'backend', true),
  summary(12, 'project', 1, 'Dormant', 'dormant'),
  summary(21, 'project', 2, 'Kitchen', 'kitchen', true),
];

const ONE_EMPTY_AREA = [summary(1, 'area', null, 'Alpha', 'alpha')];

const listed = (items) => ({
  ok: true,
  value: { items, skip: 0, limit: 200, hasMore: false },
});

/**
 * Which request an answer is for.
 *
 * The route alone is not enough to tell them apart: the container traversal and the note feed are
 * both List, and they differ only in what they ask for. Classifying by the decoded body is what lets
 * a test answer one and leave the other in flight, which every case below depends on.
 */
const TRAVERSAL = 'the container traversal';
const WRITE = 'the active write';

const classify = (call) => {
  if (call.route.path === '/api/nodes/update') return WRITE;
  if (call.route.path !== '/api/nodes/list') return call.route.path;

  const type = call.body.filter?.type;

  return [...(type?.$in ?? [type])].includes('area') ? TRAVERSAL : '/api/nodes/list (notes)';
};

/**
 * A transport that answers only when this test says so, and only the request it is asked about.
 *
 * Answering in arrival order would be wrong here rather than merely fragile: Home issues the
 * traversal, the note feed and the session media together, so "the next request" is not something a
 * test can name. A test that asks for a request nobody made fails, rather than quietly resolving
 * something else and passing for the wrong reason.
 */
const deferredTransport = () => {
  const waiting = [];

  return {
    settle: (what, answer) => {
      const index = waiting.findIndex((call) => call.what === what);
      if (index === -1) throw new Error(`nothing in flight for ${what}`);
      waiting.splice(index, 1)[0].resolve(answer);
    },
    transport: {
      endpoint: { origin: 'https://example.invalid', basePath: '' },
      timeoutMs: 1000,
      invoke: (call) =>
        new Promise((resolve) => {
          waiting.push({ what: classify(call), resolve });
        }),
    },
  };
};

const refused = () => ({
  ok: false,
  failure: {
    kind: 'transport',
    mutationOutcome: 'unknown',
    message: 'The server could not be reached.',
  },
});

let server;

const connect = (transport) => {
  useConnectionStore.setState({
    phase: {
      kind: 'active',
      rejection: null,
      session: {
        activation: 1,
        transport,
        connection: {
          connectionId: 'c1',
          base: 'https://raphael.example',
          origin: 'https://raphael.example',
          protocolVersion: '2026-09-18',
        },
      },
    },
  });
};

const render = () => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(HomeScreen)),
    );
  });

  const cards = () => [...host.querySelectorAll('[aria-description="Opens project"]')];

  return {
    host,
    text: () => host.textContent ?? '',
    /** The project names on screen, in the order they are drawn. */
    titles: () => cards().map((card) => card.textContent ?? ''),
    open: (title) => {
      cards()
        .find((card) => (card.textContent ?? '').includes(title))
        ?.click();
    },
    /** The bolt beside a card, found the way a screen reader would find it. */
    bolt: (title) =>
      host.querySelector(`[aria-label="Mark ${title} as inactive"]`) ??
      host.querySelector(`[aria-label="Mark ${title} as active"]`),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

const flush = async (answer) => {
  await act(async () => {
    answer?.();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

beforeEach(() => {
  resetNavigations();
  queryClient.clear();
  server = deferredTransport();
  connect(server.transport);
  useCaptureOwner.setState({
    status: 'ready',
    problem: null,
    drafts: [],
    unusableDrafts: [],
    attempts: [],
    unsaved: {},
    sending: [],
    saving: [],
    unreadableAttempts: 0,
  });
  useEditOwner.setState({ status: 'ready', problem: null, edits: [], unusableEdits: [] });
});

/** Render Home and let the traversal it issues on mount complete. */
const homeWith = async (items) => {
  const screen = render();
  await flush(() => {
    server.settle(TRAVERSAL, listed(items));
  });

  return screen;
};

describe('the active projects section', () => {
  it('draws one card per selected project, in hierarchy order', async () => {
    const screen = await homeWith(CONTAINERS);

    try {
      // Pre-order over the roots: Alpha's selected project before Beta's, and the unselected one in
      // between is not drawn at all.
      assert.deepEqual(
        screen.titles().map((title) => title.replace(/\s+/g, ' ').trim()),
        ['Backend', 'Kitchen'],
      );
      assert.ok(!screen.text().includes('Dormant'), 'an unselected project is not on Home');
      assert.ok(!screen.text().includes('Alpha'), 'and neither is an area');
    } finally {
      screen.unmount();
    }
  });

  it('opens the project a card names', async () => {
    const screen = await homeWith(CONTAINERS);

    try {
      act(() => {
        screen.open('Kitchen');
      });
      assert.deepEqual(navigations, [
        { method: 'push', target: { pathname: '/project/[id]', params: { id: '21' } } },
      ]);
    } finally {
      screen.unmount();
    }
  });

  it('says so quietly when nothing is selected', async () => {
    const screen = await homeWith(ONE_EMPTY_AREA);

    try {
      assert.ok(
        screen
          .text()
          .includes('No active projects. Mark one as Active from its page to keep it here.'),
      );
    } finally {
      screen.unmount();
    }
  });

  it('shows placeholders while the tree has not arrived', () => {
    // Nothing answered yet: the traversal is in flight, which is not the same as an empty selection
    // and must not be drawn as one.
    const screen = render();

    try {
      assert.ok(screen.host.querySelector('[aria-label="Loading active projects"]') !== null);
      assert.ok(!screen.text().includes('No active projects'));
    } finally {
      screen.unmount();
    }
  });

  it('admits it when the tree could not be read at all', async () => {
    const screen = render();

    try {
      await flush(() => {
        server.settle(TRAVERSAL, refused());
      });
      assert.ok(screen.text().includes('Unable to load active projects.'));
      assert.ok(
        !screen.text().includes('No active projects'),
        'a failure is not an empty selection',
      );
    } finally {
      screen.unmount();
    }
  });
});

describe('a toggle from a card', () => {
  it('puts a refusal beneath the card that issued it, and no other', async () => {
    const screen = await homeWith(CONTAINERS);

    try {
      act(() => {
        screen.bolt('Backend')?.click();
      });
      await flush();
      // While the write is in flight the control is busy and carries no sentence of its own.
      assert.equal(screen.bolt('Backend')?.getAttribute('aria-busy'), 'true');
      assert.ok(!screen.text().includes('Active status did not update'));

      await flush(() => {
        server.settle(WRITE, refused());
      });

      assert.ok(screen.text().includes('Active status did not update. Try again.'));
      // One sentence, under one card. A screen-level instance would have drawn it once for the
      // whole section, or lost it the moment another card wrote.
      assert.equal(screen.text().split('Active status did not update').length - 1, 1);
      assert.equal(screen.bolt('Kitchen')?.getAttribute('aria-busy'), 'false');
    } finally {
      screen.unmount();
    }
  });

  it('keeps the card, with what it last read, when the refresh after a success fails', async () => {
    const screen = await homeWith(CONTAINERS);

    try {
      act(() => {
        screen.bolt('Backend')?.click();
      });
      await flush();
      // The server accepts the deactivation, and the tree is read back.
      await flush(() => {
        server.settle(WRITE, {
          ok: true,
          value: { entity: { id: 11, revision: 4, active: false } },
        });
      });
      // That read back is a fresh traversal, and its first page fails.
      await flush(() => {
        server.settle(TRAVERSAL, refused());
      });

      // The card is still here, showing the value from the reading that is still on hand, and the
      // banner says that reading is not current. The next successful refresh removes it. This is the
      // cost of awaiting the re-read, not a lost write.
      assert.ok(screen.text().includes('Backend'));
      assert.equal(screen.bolt('Backend')?.getAttribute('aria-busy'), 'false');
      assert.equal(screen.bolt('Backend')?.getAttribute('aria-label'), 'Mark Backend as inactive');
      assert.ok(screen.text().includes('The most recent check did not reach the server'));
      // No sentence of its own beside the banner: one explanation of one failure is enough.
      assert.ok(!screen.text().includes('Active status did not update'));
    } finally {
      screen.unmount();
    }
  });
});

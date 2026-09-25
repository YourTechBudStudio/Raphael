/**
 * Archive and restore on the project and area screens, rendered through their real routes.
 *
 * The routes are mounted rather than the screens, because the capture pair is the route's and it is
 * one of the controls that must stay in place while a container is archived. The server is a fake
 * holding a small tree: reads answer from it at once, and the lifecycle requests wait until the test
 * answers them, so what is on screen while a request and its re-read are in the air can be looked at.
 *
 * Four properties carry the design and are pinned here.
 *
 * **Nothing moves.** An archived container keeps every control where it was. The ones the server
 * would refuse are drawn unavailable, and Active and Favorite keep their saved values.
 *
 * **The screen shows what it re-read, never what it sent.** The toggle's fill comes from the Get
 * after the action, so a restore that leaves something archived through a container above reads as
 * exactly that.
 *
 * **The busy ring lasts until that re-read lands.** Otherwise a second press would go out at the old
 * revision and be refused as a conflict with the person's own write.
 *
 * **An archived area answers for itself.** The hierarchy never contains one, so its children come
 * from their own read, complete or an error, and never as an empty area.
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
const { navigations, resetNavigations, setLocalSearchParams } =
  await import('./support/stubs/expo-router.mjs');
const { pullToRefresh } = await import('./support/stubs/react-native.mjs');
const { default: ProjectRoute } = await import('../src/app/project/[id].tsx');
const { default: AreaRoute } = await import('../src/app/area/[id].tsx');
const { useCaptureOwner } = await import('../src/modules/capture/client/owner.ts');
const { useEditOwner } = await import('../src/modules/capture/client/edit-owner.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { MAX_CONTAINERS, PAGE_LIMIT } =
  await import('../src/modules/collections/client/hierarchy.ts');

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

/* ------------------------------------------------------------------------------------ the server */

const WORK = 1;
const BACKEND = 2;
const PROJECT = 12;
const EMPTY = 3;

const cause = (origin, owner = 'user') => ({ origin, owner, reason: 'direct' });

/**
 * The tree the fake server holds: Work holds the area Backend and the project Auth rework, and
 * Empty has no prose. Each test changes it the way the server would.
 */
const freshTree = () => ({
  [WORK]: node(WORK, 'area', null, 'Work', { description: 'Everything that keeps the lights on.' }),
  [BACKEND]: node(BACKEND, 'area', WORK, 'Backend'),
  [PROJECT]: node(PROJECT, 'project', WORK, 'Auth rework', { active: true }),
  [EMPTY]: node(EMPTY, 'area', null, 'Empty'),
});

function node(id, type, parentId, title, over = {}) {
  return {
    id,
    type,
    kind: null,
    parentId,
    slug: title.toLowerCase().replace(/\s+/g, '-'),
    revision: 3,
    title,
    description: '',
    tags: [],
    active: false,
    archived: false,
    archiveCauses: [],
    body: { format: 'markdown', value: '' },
    metadata: {},
    ...over,
  };
}

/** Archives `id` with the user's own cause, as the server would, and bumps only its revision. */
const archiveIn = (tree, id) => {
  const target = tree[id];
  const own = cause({ id, type: target.type, title: target.title });

  tree[id] = {
    ...target,
    revision: target.revision + 1,
    archived: true,
    archiveCauses: [own, ...target.archiveCauses],
  };
  for (const child of Object.values(tree)) {
    if (child.parentId === id) inheritIn(tree, child.id, own);
  }
};

const inheritIn = (tree, id, origin) => {
  const target = tree[id];

  tree[id] = { ...target, archived: true, archiveCauses: [...target.archiveCauses, origin] };
};

const summaryOf = ({ body: _body, metadata: _metadata, archiveCauses: _causes, ...rest }) => rest;

const ok = (value) => ({ ok: true, value });
const page = (items, over = {}) =>
  ok({ items, skip: 0, limit: PAGE_LIMIT, hasMore: false, ...over });

const refusal = (code, message) => ({
  ok: false,
  failure: {
    kind: 'api_error',
    status: 409,
    mutationOutcome: 'rejected',
    message,
    error: { code, message },
    details: {},
  },
});

const unreachable = () => ({
  ok: false,
  failure: {
    kind: 'transport',
    mutationOutcome: 'not_applicable',
    message: 'The server could not be reached.',
  },
});

/** Which request an answer is for. List differs only by what it asks. */
const classify = (call) => {
  const path = call.route.path.replace('/api/nodes/', '');

  if (path !== 'list') return path;

  const { filter, scopes, includeArchived } = call.body;

  if (filter?.type === 'resource') return 'notes';
  if ('id' in scopes[0] && includeArchived === true) return 'children';

  return 'traversal';
};

/**
 * Reads answer from `tree` straight away unless a test holds them; `archive`, `restore` and
 * `update` always wait to be answered.
 */
const fakeServer = () => {
  const tree = freshTree();
  const waiting = [];
  const asked = [];
  const held = new Set(['archive', 'restore', 'update']);
  const overrides = new Map();

  const answer = (what, body) => {
    const override = overrides.get(what);

    if (override !== undefined) return override(body);

    switch (what) {
      case 'get':
        return ok({ entity: tree[body.target.id] });
      case 'get-path':
        return ok({ id: body.target.id, path: `/${tree[body.target.id]?.slug ?? 'gone'}` });
      case 'traversal':
        // The server's default: nothing archived is in the hierarchy.
        return page(
          Object.values(tree)
            .filter((n) => !n.archived)
            .map(summaryOf),
        );
      case 'children':
        return page(
          Object.values(tree)
            .filter((n) => n.parentId === body.scopes[0].id)
            .map(summaryOf),
        );
      case 'notes':
        return page([]);
      default:
        throw new Error(`the fake server has no answer for ${what}`);
    }
  };

  return {
    tree,
    asked,
    /** Everything asked for `what`, in order. */
    of: (what) => asked.filter((call) => call.what === what),
    inFlight: (what) => waiting.filter((call) => call.what === what).length,
    hold: (what) => {
      held.add(what);
    },
    release: (what) => {
      held.delete(what);
    },
    /** Answer `what` with `fn(body)` from now on. */
    answerWith: (what, fn) => {
      overrides.set(what, fn);
    },
    /** Answers everything still waiting as unreachable, so nothing outlives its test. */
    drain: () => {
      for (const call of waiting.splice(0)) call.resolve(unreachable());
    },
    /** Answers the first waiting `what`, with `reply` or from the tree. */
    settle: (what, reply) => {
      const index = waiting.findIndex((call) => call.what === what);
      if (index === -1) throw new Error(`nothing in flight for ${what}`);
      const call = waiting.splice(index, 1)[0];
      call.resolve(reply ?? answer(what, call.body));
    },
    transport: {
      endpoint: { origin: 'https://example.invalid', basePath: '' },
      timeoutMs: 1000,
      invoke: (call) => {
        const what = classify(call);

        asked.push({ what, body: call.body });

        if (!held.has(what)) return Promise.resolve(answer(what, call.body));

        return new Promise((resolve) => {
          waiting.push({ what, body: call.body, resolve });
        });
      },
    },
  };
};

/* -------------------------------------------------------------------------------- the screens */

let server;

beforeEach(() => {
  resetNavigations();
  queryClient.clear();
  server = fakeServer();
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

afterEach(async () => {
  await flush(() => {
    server.drain();
  });
});

const flush = async (step) => {
  await act(async () => {
    step?.();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

const open = async (Route, id) => {
  setLocalSearchParams({ id: String(id) });

  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  await flush(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Route)));
  });
  // The reads start once the first render has committed; this lets their answers reach the screen.
  await flush();

  const $ = (selector) => host.querySelector(selector);
  // Asked as a boolean: a failed assertion on a DOM node serializes the whole tree.
  const has = (selector) => $(selector) !== null;
  const byLabel = (label) => $(`[aria-label="${label}"]`);
  const archiveToggle = () => $('[data-testid="archive-toggle"]');

  return {
    host,
    $,
    has,
    byLabel,
    text: () => host.textContent ?? '',
    archiveToggle,
    /** The header toggles, in the order they are drawn, by the word each shows. */
    toggleWords: () =>
      // Only `ToggleLabel` states whether it is busy, so this is the toggle row and nothing else.
      [...host.querySelectorAll('button[aria-busy]')].map((b) => b.textContent.trim()),
    press: async (element) => {
      assert.ok(element !== null, 'the control is on screen');
      await flush(() => {
        element.click();
      });
    },
    pull: async () => {
      await flush(() => {
        pullToRefresh(host);
      });
    },
    refreshing: () => $('[data-refresh]')?.getAttribute('data-refreshing') === 'true',
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

const openProject = (id = PROJECT) => open(ProjectRoute, id);
const openArea = (id = WORK) => open(AreaRoute, id);

const unavailable = (element) => element?.getAttribute('aria-disabled') === 'true';
const selected = (element) => element?.getAttribute('aria-selected') === 'true';
const busy = (element) => element?.getAttribute('aria-busy') === 'true';

/** The row "About this …" sits in, which is where Edit must be. */
const aboutRow = (screen, kind) =>
  [...screen.host.querySelectorAll('[data-view]')].find(
    (view) =>
      view.children.length === 2 &&
      (view.children[0].textContent ?? '').trim() === `About this ${kind}`,
  );

/* ---------------------------------------------------------------------------------- the tests */

describe('the project header', () => {
  it('holds states only, with Edit beside "About this project"', async () => {
    const screen = await openProject();

    try {
      assert.deepEqual(screen.toggleWords(), ['Active', 'Favorite', 'Archive']);

      const row = aboutRow(screen, 'project');
      assert.ok(row !== undefined, 'the heading renders');
      assert.ok(row.querySelector('[data-testid="container-edit"]') !== null);
      // No prose: the heading stays and says so, because Edit sits on its row.
      assert.ok(screen.text().includes('Nothing written about this project yet.'));
      // The capture pair's archived state comes from the same Get the screen made.
      assert.equal(server.of('get').length, 1);
    } finally {
      screen.unmount();
    }
  });

  it('archives at the revision it read, stays busy until the re-read lands, then fills', async () => {
    server.hold('get');
    const screen = await openProject();

    try {
      await flush(() => {
        server.settle('get');
      });
      await screen.press(screen.archiveToggle());

      assert.deepEqual(server.of('archive')[0].body, { target: { id: PROJECT }, revision: 3 });
      assert.ok(busy(screen.archiveToggle()));

      archiveIn(server.tree, PROJECT);
      await flush(() => {
        server.settle('archive', ok({ node: summaryOf(server.tree[PROJECT]), archiveCauses: [] }));
      });

      // Answered, and the re-read is still in the air: the ring stays, over the state last read.
      assert.equal(server.inFlight('get'), 1);
      assert.ok(busy(screen.archiveToggle()));
      assert.ok(!selected(screen.archiveToggle()));

      await flush(() => {
        server.settle('get');
      });

      assert.ok(!busy(screen.archiveToggle()));
      assert.ok(selected(screen.archiveToggle()), 'the fill comes from the re-read');
      assert.equal(screen.archiveToggle().getAttribute('aria-label'), 'Restore Auth rework');
    } finally {
      screen.unmount();
    }
  });

  it('keeps every control in place while archived, with the saved values, and restores', async () => {
    archiveIn(server.tree, PROJECT);
    const screen = await openProject();

    try {
      assert.deepEqual(screen.toggleWords(), ['Active', 'Favorite', 'Archive']);

      const active = screen.byLabel('Mark Auth rework as inactive');
      assert.ok(unavailable(active), 'Active is unavailable');
      assert.ok(selected(active), 'and still shows the saved selection');
      assert.ok(!busy(active), 'unavailable is not in flight');
      assert.equal(active.getAttribute('aria-description'), 'Unavailable while this is archived');

      const favorite = screen.byLabel('Add Auth rework to favorites');
      assert.ok(unavailable(favorite));
      assert.ok(unavailable(screen.$('[data-testid="container-edit"]')));
      assert.ok(unavailable(screen.$('[data-testid="new-note"]')));
      assert.ok(unavailable(screen.byLabel('Record a voice note')));

      assert.ok(!unavailable(screen.archiveToggle()), 'Archive stays live');
      assert.ok(selected(screen.archiveToggle()));
      // The user's own archive only: the filled toggle says it, and no line repeats it.
      assert.ok(!screen.has('[data-testid="inherited-line"]'));
      // Its notes are read with archived ones included; all of them are archived with it.
      assert.equal(server.of('notes').at(-1).body.includeArchived, true);

      await screen.press(screen.archiveToggle());
      assert.deepEqual(server.of('restore')[0].body, { target: { id: PROJECT }, revision: 4 });
    } finally {
      screen.unmount();
    }
  });

  it('says a failure under the row at once, without claiming a refresh', async () => {
    server.hold('get');
    const screen = await openProject();

    try {
      await flush(() => {
        server.settle('get');
      });
      await screen.press(screen.archiveToggle());
      await flush(() => {
        server.settle('archive', refusal('revision_conflict', 'revision mismatch'));
      });

      // Settled while the re-read is still in flight: the refusal does not wait for it.
      assert.equal(server.inFlight('get'), 1);
      assert.ok(!busy(screen.archiveToggle()));
      assert.equal(
        screen.$('[data-testid="archive-failure"]')?.textContent,
        'This changed since you looked. Check it, then try again.',
      );

      await flush(() => {
        server.settle('get');
      });
      await screen.press(screen.archiveToggle());
      assert.ok(!screen.has('[data-testid="archive-failure"]'), 'the next press clears it');

      await flush(() => {
        server.settle('archive', refusal('revision_conflict', 'revision mismatch'));
      });
      await flush(() => {
        server.settle('get');
      });
    } finally {
      screen.unmount();
    }
  });
});

describe('a project archived with the area above it', () => {
  it('shows the toggle unselected and one line that opens that area', async () => {
    archiveIn(server.tree, WORK);
    const screen = await openProject();

    try {
      assert.ok(!selected(screen.archiveToggle()));
      assert.ok(unavailable(screen.byLabel('Mark Auth rework as inactive')));

      const line = screen.$('[data-testid="inherited-line"]');
      assert.equal(line.getAttribute('aria-label'), 'Archived with Area “Work”');
      assert.equal(line.getAttribute('aria-description'), 'Opens Work');

      await screen.press(line);
      assert.deepEqual(navigations.at(-1), {
        method: 'push',
        target: { pathname: '/area/[id]', params: { id: String(WORK) } },
      });
    } finally {
      screen.unmount();
    }
  });

  it('still archives, and then says it is also archived with the area', async () => {
    archiveIn(server.tree, WORK);
    const screen = await openProject();

    try {
      await screen.press(screen.archiveToggle());
      assert.equal(server.of('archive').length, 1, 'adding your own cause is always available');

      server.tree[PROJECT] = {
        ...server.tree[PROJECT],
        revision: 4,
        archiveCauses: [
          cause({ id: PROJECT, type: 'project', title: 'Auth rework' }),
          ...server.tree[PROJECT].archiveCauses,
        ],
      };
      await flush(() => {
        server.settle('archive', ok({ node: summaryOf(server.tree[PROJECT]), archiveCauses: [] }));
      });

      assert.ok(selected(screen.archiveToggle()));
      assert.equal(
        screen.$('[data-testid="inherited-line"]').getAttribute('aria-label'),
        'Also archived with Area “Work”',
      );
    } finally {
      screen.unmount();
    }
  });

  it('stays archived when the area is restored, because its own cause is independent', async () => {
    archiveIn(server.tree, WORK);
    server.tree[PROJECT] = {
      ...server.tree[PROJECT],
      archiveCauses: [
        cause({ id: PROJECT, type: 'project', title: 'Auth rework' }),
        ...server.tree[PROJECT].archiveCauses,
      ],
    };

    const area = await openArea();

    try {
      assert.ok(selected(area.archiveToggle()));
      await area.press(area.archiveToggle());
      assert.deepEqual(server.of('restore')[0].body, { target: { id: WORK }, revision: 4 });

      // The server removes only Work's own cause. The project keeps the one it was given.
      const restored = freshTree()[WORK];
      server.tree[WORK] = { ...restored, revision: 5 };
      server.tree[BACKEND] = freshTree()[BACKEND];
      server.tree[PROJECT] = {
        ...server.tree[PROJECT],
        archiveCauses: [cause({ id: PROJECT, type: 'project', title: 'Auth rework' })],
      };
      await flush(() => {
        server.settle('restore', ok({ node: summaryOf(server.tree[WORK]), archiveCauses: [] }));
      });

      assert.ok(!selected(area.archiveToggle()));
    } finally {
      area.unmount();
    }

    const project = await openProject();

    try {
      assert.ok(selected(project.archiveToggle()), 'still archived, by its own cause');
      assert.ok(!project.has('[data-testid="inherited-line"]'));
      assert.ok(unavailable(project.byLabel('Mark Auth rework as inactive')));
    } finally {
      project.unmount();
    }
  });
});

describe('the area header', () => {
  it('is Favorite, Archive, with Edit beside "About this area" even with no prose', async () => {
    const screen = await openArea(EMPTY);

    try {
      assert.deepEqual(screen.toggleWords(), ['Favorite', 'Archive']);
      assert.ok(aboutRow(screen, 'area').querySelector('[data-testid="container-edit"]') !== null);
      assert.ok(screen.text().includes('Nothing written about this area yet.'));
      assert.ok(!unavailable(screen.byLabel('Add')));
    } finally {
      screen.unmount();
    }
  });

  it('keeps the add button, Favorite, Edit and the capture pair in place while archived', async () => {
    archiveIn(server.tree, WORK);
    const screen = await openArea();

    try {
      const add = screen.byLabel('Add');
      assert.ok(add !== null, 'the add button stays in the top bar');
      assert.ok(unavailable(add));
      assert.equal(add.getAttribute('aria-description'), 'Unavailable while this is archived');
      assert.ok(unavailable(screen.byLabel('Add Work to favorites')));
      assert.ok(unavailable(screen.$('[data-testid="container-edit"]')));
      assert.ok(unavailable(screen.$('[data-testid="new-note"]')));
      assert.ok(!unavailable(screen.archiveToggle()));
    } finally {
      screen.unmount();
    }
  });
});

describe("an archived area's contents", () => {
  it('lists its children and notes with inclusion, without markers', async () => {
    archiveIn(server.tree, WORK);
    const screen = await openArea();

    try {
      assert.ok(screen.text().includes('Backend'));
      assert.ok(screen.text().includes('Auth rework'));
      assert.ok(!screen.text().includes('was not in the hierarchy'));
      assert.ok(!screen.has('[data-testid="archived-pill"]'));
      assert.deepEqual(server.of('children')[0].body.scopes, [{ id: WORK }]);
      assert.equal(server.of('notes').at(-1).body.includeArchived, true);
    } finally {
      screen.unmount();
    }
  });

  it('says it is loading, then shows the sections', async () => {
    archiveIn(server.tree, WORK);
    server.hold('children');
    const screen = await openArea();

    try {
      assert.ok(screen.text().includes('Loading what this area holds…'));
      assert.ok(!screen.text().includes('Backend'));

      await flush(() => {
        server.settle('children');
      });

      assert.ok(!screen.text().includes('Loading what this area holds…'));
      assert.ok(screen.text().includes('Backend'));
    } finally {
      screen.unmount();
    }
  });

  it('says a failed first read failed, with a retry, and never shows an empty area', async () => {
    archiveIn(server.tree, WORK);
    server.answerWith('children', unreachable);
    const screen = await openArea();

    try {
      assert.ok(screen.text().includes('Unable to load what this area holds.'));
      assert.ok(screen.byLabel('Try again') !== null);
      assert.ok(!screen.text().includes('Backend'));
    } finally {
      screen.unmount();
    }
  });

  it('offers no retry when the area holds more than the phone reads', async () => {
    archiveIn(server.tree, WORK);
    let next = 100;
    server.answerWith('children', (body) => {
      const items = Array.from({ length: PAGE_LIMIT }, () => {
        next += 1;

        return summaryOf(node(next, 'project', WORK, `P${String(next).padStart(8, '0')}`));
      });

      return page(items, { skip: body.skip, hasMore: true });
    });
    const screen = await openArea();

    try {
      assert.ok(next - 100 > MAX_CONTAINERS);
      assert.ok(screen.text().includes('Unable to load what this area holds.'));
      assert.ok(screen.text().includes('This area holds more than'));
      assert.ok(!screen.has('[aria-label="Try again"]'));
    } finally {
      screen.unmount();
    }
  });

  it('keeps the previous sections under the stale notice when a refresh fails', async () => {
    archiveIn(server.tree, WORK);
    const screen = await openArea();

    try {
      server.answerWith('children', unreachable);
      await screen.pull();

      assert.ok(screen.text().includes('This is the last complete reading Raphael could take.'));
      assert.ok(screen.text().includes('Backend'));
    } finally {
      screen.unmount();
    }
  });

  it('is refreshed by a pull, which stays on until that read settles', async () => {
    archiveIn(server.tree, WORK);
    const screen = await openArea();

    try {
      assert.ok(screen.text().includes('Backend'));

      // Moved out by another client between the two reads.
      server.tree[BACKEND] = { ...server.tree[BACKEND], parentId: EMPTY };
      server.hold('children');
      await screen.pull();

      assert.equal(server.inFlight('children'), 1);
      assert.ok(screen.refreshing(), 'the indicator covers the children read');

      await flush(() => {
        server.settle('children');
      });

      assert.ok(!screen.refreshing());
      assert.ok(!screen.text().includes('Backend'), 'the moved child is gone');
    } finally {
      screen.unmount();
    }
  });

  it('is never read for an active area, not even by a pull', async () => {
    const screen = await openArea();

    try {
      assert.ok(screen.text().includes('Backend'), 'from the hierarchy');
      await screen.pull();
      assert.equal(server.of('children').length, 0);
    } finally {
      screen.unmount();
    }
  });
});

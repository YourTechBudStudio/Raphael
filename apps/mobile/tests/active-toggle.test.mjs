/**
 * Marking a project active, against a real cache and a transport that answers when this test says so.
 *
 * Three properties carry the design, and every one of them fails quietly if it regresses.
 *
 * **The window belongs to the mutation.** A successful write stays `pending` until both re-reads have
 * landed, so the control stays disabled and busy while it is showing a state the display authority
 * has not caught up with yet. If that window closed early, the control would come back alive against
 * the pre-toggle revision and a person's own successful write could become the conflicting party.
 * Nothing about that is visible from the outside except by holding a refetch open and looking.
 *
 * **A refusal does not wait.** The error path fires the same two invalidations without awaiting them,
 * so the screen reverts and explains itself at once rather than after a refresh that may itself be
 * failing. The assertion for this is the mirror of the one above: settled while the re-reads are
 * still in flight.
 *
 * **A verdict belongs to the control that earned it.** A mutation observer reports only its most
 * recent dispatch, so verdicts are per-instance while the pending intent is shared through the
 * mutation cache. Two instances are driven here precisely because that split is invisible with one.
 *
 * The transport is a fake that never aborts and answers only on demand. The re-read queries are
 * driven by real `QueryObserver`s with deferred functions, because "resolves when the refetches
 * settle" is a claim about a real cache and cannot be made against a stub.
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
const { QueryClient, QueryClientProvider, QueryObserver } = await import('@tanstack/react-query');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');
const { useProjectActive } = await import('../src/modules/collections/client/active.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');

after(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

// The keys the collections capability actually builds. Spelled here rather than imported, the same
// way `update-cache.test.mjs` does it: the seam between the write and the reads it refreshes is
// exactly what is under test, so this should fail if either side moves.
const entityKey = (activation, id) => scopeKey(activation, 'entity', 'project', id);
const hierarchyKey = (activation) => scopeKey(activation, 'hierarchy');

const PROJECT = 5;
const OTHER = 6;

/** What a screen read, and therefore what a write from it is guarded by. */
const target = (id = PROJECT, revision = 3, active = false) => ({ id, revision, active });

const conflict = () => ({
  kind: 'api_error',
  status: 409,
  mutationOutcome: 'rejected',
  message: 'This project changed since you read it.',
  error: { code: 'revision_conflict', message: 'revision mismatch' },
  details: {},
});

const unreachable = () => ({
  kind: 'transport',
  mutationOutcome: 'unknown',
  message: 'The server could not be reached.',
});

/**
 * A transport that records what it was asked and answers only when told.
 *
 * `signal` is ignored: nothing here is about cancellation, and the write has to behave correctly in
 * the ordinary case where the answer simply arrives later.
 */
const deferredTransport = () => {
  const waiting = [];
  const bodies = [];

  return {
    bodies,
    inFlight: () => waiting.length,
    settle: (answer) => {
      const next = waiting.shift();
      if (next === undefined) throw new Error('the transport had nothing in flight');
      next(answer);
    },
    transport: {
      endpoint: { origin: 'https://example.invalid', basePath: '' },
      timeoutMs: 1000,
      invoke: (call) =>
        new Promise((resolve) => {
          bodies.push(call.body);
          waiting.push(resolve);
        }),
    },
  };
};

const accepted = () => ({
  ok: true,
  value: { entity: { id: PROJECT, revision: 4, active: true } },
});
const refused = (failure) => ({ ok: false, failure });

/** A query someone is actually looking at, whose refetch this test decides the timing of. */
const deferredQuery = (client, key) => {
  const waiting = [];
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => new Promise((resolve) => waiting.push(resolve)),
    retry: false,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const stop = observer.subscribe(() => undefined);

  return {
    inFlight: () => waiting.length,
    settle: (value = { read: true }) => {
      const next = waiting.shift();
      if (next === undefined) throw new Error(`nothing in flight for ${key.join('/')}`);
      next(value);
    },
    stop,
  };
};

/**
 * A cache per test, with both halves collected immediately.
 *
 * `gcTime: 0` on mutations is not a detail: a settled mutation otherwise schedules its collection
 * five minutes out, and that timer keeps the test process alive long after the assertions have
 * passed. `home-screen.test.mjs` does the same thing for queries, for the same reason.
 */
const freshClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
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

/**
 * One or more independent controls, each holding its own `useProjectActive()`.
 *
 * Named rather than positional so a test can unmount one and keep the other, which is what the
 * verdict-ownership and mid-flight-unmount cases need.
 */
const controls = (client) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const latest = new Map();

  function Control({ name }) {
    latest.set(name, useProjectActive());

    return null;
  }

  const show = (names) => {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          names.map((name) => createElement(Control, { key: name, name })),
        ),
      );
    });
  };

  return {
    show,
    at: (name) => latest.get(name),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

/**
 * Let everything that is ready settle, optionally answering something first.
 *
 * The answer is given inside the `act` block rather than before it: resolving a deferred promise is
 * what causes the re-render, and React is entitled to complain when that happens outside one.
 */
const flush = async (answer) => {
  await act(async () => {
    answer?.();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
};

let client;
let server;
let entity;
let hierarchy;
let screen;

beforeEach(async () => {
  client = freshClient();
  server = deferredTransport();
  connect(1, server.transport);
  entity = deferredQuery(client, entityKey(1, PROJECT));
  hierarchy = deferredQuery(client, hierarchyKey(1));
  await flush();
  await flush(() => {
    entity.settle();
    hierarchy.settle();
  });
  screen = controls(client);
  screen.show(['home']);
});

afterEach(async () => {
  // Answer whatever a test deliberately left hanging, so nothing is still in flight when the next
  // test builds its own cache.
  while (server.inFlight() > 0) {
    await flush(() => {
      server.settle(accepted());
    });
  }
  while (entity.inFlight() > 0 || hierarchy.inFlight() > 0) {
    await flush(() => {
      if (entity.inFlight() > 0) entity.settle();
      if (hierarchy.inFlight() > 0) hierarchy.settle();
    });
  }
  screen.unmount();
  entity.stop();
  hierarchy.stop();
  client.clear();
});

describe('a write that the server accepts', () => {
  it('sends the opposite of what the screen read, against the revision it read', async () => {
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();

    // Desired state, never a toggle: the field says what the resulting state is, so two clients
    // sending the same value from the same revision are harmless. What travels is the request the
    // shared contract decoded, which carries its own defaults - so the three fields this write owns
    // are named rather than the whole body compared.
    assert.equal(server.bodies.length, 1);
    assert.deepEqual(server.bodies[0].target, { id: PROJECT });
    assert.equal(server.bodies[0].revision, 3);
    assert.equal(server.bodies[0].active, true);
  });

  it('stays busy until both re-reads have landed, showing what the server accepted', async () => {
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();

    assert.equal(screen.at('home').isDisabled(PROJECT), true);
    // The shared intent is what is on screen, not the stale reading underneath it.
    assert.equal(screen.at('home').isActive(target()), true);

    await flush(() => {
      server.settle(accepted());
    });

    // The write is answered and the mutation is still pending, because the display authority is not
    // yet fresh. This is the whole of D6, and it is invisible except from here.
    assert.equal(entity.inFlight(), 1, 'the entity is being read back');
    assert.equal(hierarchy.inFlight(), 1, 'and so is the tree Home draws from');
    assert.equal(screen.at('home').isDisabled(PROJECT), true);
    assert.equal(screen.at('home').isActive(target()), true);

    await flush(() => {
      entity.settle();

      hierarchy.settle();
    });

    assert.equal(screen.at('home').isDisabled(PROJECT), false);
    assert.equal(screen.at('home').failure, null);
  });

  it('refreshes only the connection the write was issued under', async () => {
    // A connection the app has since left, holding the same numeric project. Nothing about this
    // write may reach it.
    client.setQueryData(entityKey(2, PROJECT), { read: true });
    client.setQueryData(hierarchyKey(2), { read: true });

    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();
    await flush(() => {
      server.settle(accepted());
    });
    await flush(() => {
      entity.settle();
      hierarchy.settle();
    });

    const stale = (key) => client.getQueryCache().find({ queryKey: key })?.state.isInvalidated;
    assert.equal(stale(entityKey(2, PROJECT)), false);
    assert.equal(stale(hierarchyKey(2)), false);
  });

  it('still refreshes when the control that issued it has gone', async () => {
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();

    // Exactly what a successful deactivate does: the card leaves Home. The callbacks belong to the
    // mutation rather than to the observer, so the re-reads it owes still happen.
    screen.show([]);
    await flush(() => {
      server.settle(accepted());
    });

    assert.equal(entity.inFlight(), 1);
    assert.equal(hierarchy.inFlight(), 1);
    await flush(() => {
      entity.settle();
      hierarchy.settle();
    });
  });
});

describe('a write the server refuses', () => {
  it('names a revision conflict and does not hold the screen while it refreshes', async () => {
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();
    await flush(() => {
      server.settle(refused(conflict()));
    });

    assert.equal(screen.at('home').failure, 'conflict');
    // Settled at once, with the re-reads still running: the sentence appears now rather than after a
    // refresh that may itself be failing, and it is careful not to claim that refresh has finished.
    assert.equal(screen.at('home').isDisabled(PROJECT), false);
    assert.equal(screen.at('home').isActive(target()), false, 'reverted to what it last read');
    assert.equal(entity.inFlight(), 1);
    assert.equal(hierarchy.inFlight(), 1);

    await flush(() => {
      entity.settle();

      hierarchy.settle();
    });
  });

  it('reports anything else as a write that simply did not happen', async () => {
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();
    await flush(() => {
      server.settle(refused(unreachable()));
    });

    assert.equal(screen.at('home').failure, 'failed');
    assert.equal(screen.at('home').isDisabled(PROJECT), false);

    await flush(() => {
      entity.settle();

      hierarchy.settle();
    });
  });

  it('clears the verdict on the next success from the same control', async () => {
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();
    await flush(() => {
      server.settle(refused(unreachable()));
    });
    await flush(() => {
      entity.settle();
      hierarchy.settle();
    });
    assert.equal(screen.at('home').failure, 'failed');

    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();
    // Held until this instance's next dispatch, and gone from the moment there is one.
    assert.equal(screen.at('home').failure, null);

    await flush(() => {
      server.settle(accepted());
    });
    await flush(() => {
      entity.settle();
      hierarchy.settle();
    });
    assert.equal(screen.at('home').failure, null);
  });
});

describe('two controls at once', () => {
  it('lets the second project move while the first is still reading back', async () => {
    screen.show(['home', 'project']);
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();
    await flush(() => {
      server.settle(accepted());
    });

    // The first write's re-reads are deliberately left in flight.
    assert.equal(screen.at('home').isDisabled(PROJECT), true);

    act(() => {
      screen.at('project').toggle(target(OTHER));
    });
    await flush();

    // Unscoped mutations run independently, which is the property a per-project scope was going to
    // buy and cannot express: `scope` is a per-hook option, so one shared scope would serialize
    // every toggle instead.
    assert.equal(server.bodies.length, 2);
    assert.equal(screen.at('project').isDisabled(OTHER), true);

    await flush(() => {
      entity.settle();

      hierarchy.settle();
    });
  });

  it('keeps each verdict with the control that earned it', async () => {
    screen.show(['home', 'project']);
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();
    await flush(() => {
      server.settle(refused(conflict()));
    });
    assert.equal(screen.at('home').failure, 'conflict');

    act(() => {
      screen.at('project').toggle(target(OTHER));
    });
    await flush();

    // A single screen-level instance would have lost the first sentence here, because an observer
    // reports only its latest dispatch. This is why each control holds its own.
    assert.equal(screen.at('home').failure, 'conflict');
    assert.equal(screen.at('project').failure, null);

    await flush(() => {
      server.settle(accepted());
    });
    await flush(() => {
      entity.settle();
      hierarchy.settle();
    });
  });

  it('shows one control what another has in flight', async () => {
    screen.show(['home', 'project']);
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();

    // The intent is read from the mutation cache, not from an observer, so Home and the project
    // screen agree about what is happening even though neither issued the other's write.
    assert.equal(screen.at('project').isDisabled(PROJECT), true);
    assert.equal(screen.at('project').isActive(target()), true);

    await flush(() => {
      server.settle(accepted());
    });
    await flush(() => {
      entity.settle();
      hierarchy.settle();
    });
  });

  it('sends nothing for a project whose write is still in flight', async () => {
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();

    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();

    // The control is disabled for this whole span, so a screen cannot offer the second tap in the
    // first place; the guard inside `toggle` is what makes that a property of the hook rather than
    // of every caller remembering to pass `disabled`.
    assert.equal(screen.at('home').isDisabled(PROJECT), true);
    assert.equal(
      server.bodies.length,
      1,
      'a second tap against the pre-toggle revision is refused',
    );

    await flush(() => {
      server.settle(accepted());
    });
    await flush(() => {
      entity.settle();
      hierarchy.settle();
    });
  });
});

describe('a write in flight when the connection changes', () => {
  it('is invisible to the connection that replaces it', async () => {
    act(() => {
      screen.at('home').toggle(target());
    });
    await flush();
    assert.equal(screen.at('home').isDisabled(PROJECT), true);

    act(() => {
      connect(2, server.transport);
    });
    await flush();

    // The key the write was stamped with belongs to the connection that issued it, so the new
    // connection neither shows its intent nor disables a control over it.
    assert.equal(screen.at('home').isDisabled(PROJECT), false);
    assert.equal(screen.at('home').isActive(target()), false);

    await flush(() => {
      server.settle(accepted());
    });
  });
});

/**
 * The favorite star, against a real cache and a transport that answers when this test says so.
 *
 * It is optimistic: the wanted state shows while the write and the re-read after it are running, so
 * the star does not flick back before the new reads land. A failure puts it back and says why.
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useFavoriteToggle } = await import('../src/modules/favorites/client/toggle.ts');
const { useFavoritePages } = await import('../src/modules/favorites/client/list.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');

after(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const A = 3;

const answer = (isFavorite) => (body) => ok({ nodeId: body.target.id, isFavorite });

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

/** Two stars for the same node, and the favorites list, whose re-read the write waits for. */
const mount = (client) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const latest = new Map();

  function Control({ name }) {
    latest.set(name, useFavoriteToggle());

    return null;
  }

  function List() {
    useFavoritePages({ complete: false });

    return null;
  }

  act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, [
        createElement(Control, { key: 'header', name: 'header' }),
        createElement(Control, { key: 'row', name: 'row' }),
        createElement(List, { key: 'list' }),
      ]),
    );
  });

  return {
    at: (name) => latest.get(name),
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

beforeEach(async () => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  server = onDemandServer();
  connect(server.transport);
  screen = mount(client);
  await flush(() => {
    server.settle(LIST, (body) => page(body, [summary(A, { isFavorite: false })]));
  });
});

afterEach(async () => {
  await flush(() => {
    server.drain();
  });
  screen.unmount();
  client.clear();
});

const read = { id: A, isFavorite: false };

describe('the favorite star', () => {
  it('sends the wanted state, and every star shows it and is busy while it runs', async () => {
    await flush(() => {
      screen.at('header').toggle(read);
    });

    assert.deepEqual(server.pending(ADD), { target: { id: A } });
    for (const name of ['header', 'row']) {
      assert.equal(screen.at(name).isFavorite(read), true, name);
      assert.equal(screen.at(name).isBusy(A), true, name);
    }

    // A second tap while busy sends nothing.
    await flush(() => {
      screen.at('row').toggle(read);
    });
    assert.equal(server.of(ADD).length, 1);
    assert.equal(server.of(REMOVE).length, 0);
  });

  it('keeps the wanted state until the re-read after it has landed', async () => {
    await flush(() => {
      screen.at('header').toggle(read);
    });
    await flush(() => {
      server.settle(ADD, answer(true));
    });

    assert.equal(server.inFlight(LIST), 1, 'the list is read again');
    assert.equal(screen.at('header').isFavorite(read), true, 'no flicker back meanwhile');
    assert.equal(screen.at('header').isBusy(A), true);

    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(A)]));
    });

    assert.equal(screen.at('header').isBusy(A), false);
    assert.equal(screen.at('header').failureMessage, null);
  });

  it('puts the star back and says why when the server refuses, until dismissed', async () => {
    await flush(() => {
      screen.at('header').toggle(read);
    });
    await flush(() => {
      server.settle(ADD, refused);
    });
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(A, { isFavorite: false })]));
    });

    assert.equal(screen.at('header').isFavorite(read), false);
    assert.equal(
      screen.at('header').failureMessage,
      'Couldn’t add to favorites. Node 3 does not exist.',
    );

    await flush(() => {
      screen.at('header').dismiss();
    });
    assert.equal(screen.at('header').failureMessage, null);
  });

  it('says it could not reach the server when the request was lost', async () => {
    await flush(() => {
      screen.at('header').toggle({ id: A, isFavorite: true });
    });
    await flush(() => {
      server.settle(REMOVE, unreachable);
    });
    await flush(() => {
      server.settle(LIST, (body) => page(body, [summary(A)]));
    });

    assert.equal(
      screen.at('header').failureMessage,
      'Couldn’t remove from favorites. Can’t reach your server.',
    );
  });
});

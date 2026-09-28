/**
 * What Home says about work that is not on the server.
 *
 * It draws no cards for it: one chip beside the Notes heading, counting what Unfinished lists, and
 * nothing at all when there is nothing to count. A chip reading "0 unfinished" is a permanent
 * reminder about nothing.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';
import { createRow, editRow } from './support/unsent-rows.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { navigations, resetNavigations } = await import('./support/stubs/expo-router.mjs');
const { HomeScreen } = await import('../src/modules/home/components/HomeScreen.tsx');
const { useUnsentState } = await import('../src/modules/unsent/client/unsent.ts');
const { announce } = await import('../src/modules/unsent/state/notice.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');

queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });

after(async () => {
  queryClient.clear();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const CONNECTION = 'c1';

const render = () => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(HomeScreen)),
    );
  });

  return {
    host,
    text: () => host.textContent ?? '',
    chip: () => host.querySelector('[data-testid="home-unfinished-chip"]'),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

beforeEach(() => {
  resetNavigations();
  queryClient.clear();
  queryClient.setQueryData(scopeKey(1, 'hierarchy'), { roots: [], byId: new Map() });
  useConnectionStore.setState({
    phase: {
      kind: 'active',
      rejection: null,
      session: {
        activation: 1,
        transport: () => Promise.reject(new Error('no server in this test')),
        connection: {
          connectionId: CONNECTION,
          base: 'https://raphael.example',
          origin: 'https://raphael.example',
          protocolVersion: 1,
        },
      },
    },
  });
  useUnsentState.setState({ status: 'ready', rows: [] });
});

describe('Home’s one indicator for unfinished work', () => {
  it('says nothing at all when there is nothing to say', () => {
    const screen = render();

    try {
      assert.equal(screen.chip(), null);
      assert.ok(!screen.text().includes('unfinished'));
    } finally {
      screen.unmount();
    }
  });

  it('counts what needs the person or is stuck, and not what is syncing normally', () => {
    act(() => {
      useUnsentState.setState({
        rows: [
          createRow(),
          createRow({ id: 'd2', status: 'refused', error: '"idea" is already used here.' }),
          editRow(7, { status: 'conflict' }),
          editRow(8, { error: 'The server could not be reached.' }),
          // Syncing normally: not the person's business.
          editRow(9),
        ],
      });
    });

    const screen = render();

    try {
      assert.equal(screen.chip()?.textContent, '4 unfinished');
    } finally {
      screen.unmount();
    }
  });

  it('opens Unfinished', () => {
    act(() => {
      useUnsentState.setState({ rows: [createRow()] });
    });

    const screen = render();

    try {
      act(() => {
        screen.chip()?.click();
      });
      assert.deepEqual(navigations, [{ method: 'push', target: '/unfinished' }]);
    } finally {
      screen.unmount();
    }
  });

  it('draws no card for any of it', () => {
    act(() => {
      useUnsentState.setState({ rows: [createRow(), editRow(7, { status: 'conflict' })] });
    });

    const screen = render();

    try {
      assert.ok(screen.chip() !== null);
      assert.ok(!screen.text().includes('Still being written'), 'no draft card');
      assert.ok(!screen.text().includes('note 7'), 'no edit card');
    } finally {
      screen.unmount();
    }
  });

  it('says once what happened to someone’s writing', () => {
    act(() => {
      announce('Kept in Unfinished as a draft.');
    });

    const screen = render();

    try {
      assert.ok(screen.text().includes('Kept in Unfinished as a draft.'));
    } finally {
      screen.unmount();
    }
  });
});

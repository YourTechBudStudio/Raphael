/**
 * What Home says about work that is not on the server.
 *
 * It draws no cards for it, of either kind: one chip beside the Notes heading, counting everything
 * Recovery lists, and nothing at all when there is nothing to count. Three claims are worth a test
 * because each fails silently.
 *
 * **The count has to agree with the screen it opens.** The chip is now the only way into Recovery,
 * so anything Recovery reports and the chip omits becomes unreachable - which is why an unreadable
 * attempt record, reported there as a line rather than a card, is counted here too.
 *
 * **Absent at zero.** A chip reading "0 unfinished" is a permanent reminder about nothing.
 *
 * **No unfinished cards, in any state.** The feed's own states - loading, empty, failed - used to be
 * drawn around local cards, and the removal has to hold in all of them.
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

const draft = (over = {}) => ({
  draftId: 'd1',
  connectionId: CONNECTION,
  endpoint: 'https://raphael.example',
  state: 'composing',
  title: 'Still being written',
  description: '',
  document: { type: 'doc', content: [] },
  contentSchemaVersion: 1,
  destination: null,
  draftVersion: 1,
  submittedVersion: null,
  serverNodeId: null,
  serverRevision: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const edit = (nodeId, over = {}) => ({
  key: { connectionId: CONNECTION, nodeId },
  endpoint: 'https://raphael.example',
  nodeType: 'resource',
  kind: 'note',
  base: { title: '', description: '', slug: '', tags: [], document: {} },
  baseRevision: 1,
  content: { title: `note ${String(nodeId)}`, description: '', slug: 's', tags: [], document: {} },
  contentSchemaVersion: 1,
  // Ahead of what has been answered for, which is what makes it unsent rather than synced.
  draftVersion: 2,
  acknowledgedVersion: 1,
  inflightVersion: null,
  inflight: null,
  syncState: 'syncing',
  lastRefusal: null,
  createdAt: 0,
  updatedAt: 100,
  ...over,
});

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

  it('counts notes, edits and records it could not read, as one number', () => {
    act(() => {
      useCaptureOwner.setState({
        drafts: [draft(), draft({ draftId: 'd2', connectionId: 'c-old' })],
        // Reported on Recovery as a line rather than a card, and unreachable if left out of this.
        unreadableAttempts: 1,
      });
      useEditOwner.setState({ edits: [edit(7)] });
    });

    const screen = render();

    try {
      // Two drafts - the retired one included, because Recovery lists it - one edit, one record.
      assert.equal(screen.chip()?.textContent, '4 unfinished');
    } finally {
      screen.unmount();
    }
  });

  it('still opens the door when a store could not be read, and claims no number', () => {
    act(() => {
      // The capture store is fine and holds nothing; the edit store never answered. Zero is what
      // this phone can count, not what it knows - and this chip is the only way into Recovery.
      useEditOwner.setState({
        status: 'unavailable',
        problem: { kind: 'failed', reason: 'unopenable' },
      });
    });

    const screen = render();

    try {
      assert.ok(screen.chip() !== null, 'a failure must not read as nothing unfinished');
      assert.equal(screen.chip()?.textContent, 'Unfinished');
      assert.ok(!/\d/.test(screen.chip()?.textContent ?? ''), 'no total it cannot support');
    } finally {
      screen.unmount();
    }
  });

  it('drops the number rather than undercounting what it can see', () => {
    act(() => {
      useCaptureOwner.setState({ drafts: [draft()] });
      useEditOwner.setState({
        status: 'unavailable',
        problem: { kind: 'failed', reason: 'unreadable' },
      });
    });

    const screen = render();

    try {
      // One draft is readable, so "1 unfinished" would be a floor presented as a total.
      assert.equal(screen.chip()?.textContent, 'Unfinished');
    } finally {
      screen.unmount();
    }
  });

  it('says nothing while a store is merely still opening', () => {
    act(() => {
      useEditOwner.setState({ status: 'opening', problem: null });
    });

    const screen = render();

    try {
      // An open in flight settles on its own; a chip here would appear on every cold launch of a
      // phone with nothing unfinished.
      assert.equal(screen.chip(), null);
    } finally {
      screen.unmount();
    }
  });

  it('opens the screen that shows them', () => {
    act(() => {
      useEditOwner.setState({ edits: [edit(7)] });
    });

    const screen = render();

    try {
      act(() => {
        screen.chip()?.click();
      });
      assert.deepEqual(navigations, [{ method: 'push', target: '/recovery' }]);
    } finally {
      screen.unmount();
    }
  });

  it('draws no card for any of it, whatever the feed is doing', () => {
    act(() => {
      useCaptureOwner.setState({ drafts: [draft()] });
      useEditOwner.setState({ edits: [edit(7)] });
    });

    const screen = render();

    try {
      // The feed has no server here, so this is Home with a failed read - the state the local cards
      // were once drawn above.
      assert.ok(screen.chip() !== null);
      assert.ok(!screen.text().includes('Still being written'), 'no unfinished note card');
      assert.ok(!screen.text().includes('note 7'), 'no unfinished edit card');
      assert.ok(!screen.text().includes('Draft · on this phone'));
    } finally {
      screen.unmount();
    }
  });
});

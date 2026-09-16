/**
 * Where a retained note is filed on the recovery screen, and what that placement claims.
 *
 * Every heading here is an assertion about origin, so the screen must not put a row under one it
 * cannot support. A note whose own record could not be read has no readable connection either, and
 * "From another server" would be this app inventing the one fact that is missing.
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
const { RecoveryScreen } = await import('../src/modules/capture/components/RecoveryScreen.tsx');
const { useCaptureOwner } = await import('../src/modules/capture/client/owner.ts');
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

const unusable = (over = {}) => ({
  draftId: 'u1',
  connectionId: CONNECTION,
  endpoint: 'https://raphael.example',
  title: 'Kept',
  contentSchemaVersion: 99,
  problem: 'unsupported_content_schema',
  ...over,
});

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

const render = () => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(RecoveryScreen)),
    );
  });

  const text = () => host.textContent ?? '';

  return {
    text,
    /** Whether `what` is written after `heading`, which is what "under a heading" means here. */
    isUnder: (heading, what) => {
      const body = text();
      const start = body.indexOf(heading);

      if (start < 0) return false;

      const at = body.indexOf(what);

      return at > start;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

beforeEach(() => {
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
});

describe('a note whose origin could not be read', () => {
  it('is not filed under another server', () => {
    act(() => {
      useCaptureOwner.setState({
        unusableDrafts: [
          unusable({
            draftId: 'u2',
            connectionId: null,
            endpoint: null,
            title: null,
            contentSchemaVersion: null,
            problem: 'unreadable_row',
          }),
        ],
      });
    });

    const screen = render();

    try {
      const body = screen.text();

      assert.ok(body.includes('could not read this note’s record'), 'it is on the screen');
      // The claim this screen must not make.
      assert.ok(!body.includes('From another server'));
      assert.ok(body.includes('Server not readable'));
      assert.ok(body.includes('could not read which server these belong to'));
    } finally {
      screen.unmount();
    }
  });

  it('keeps a readable retired note under the heading that is true of it', () => {
    act(() => {
      useCaptureOwner.setState({
        drafts: [draft({ connectionId: 'c-old', endpoint: 'https://old.example' })],
        unusableDrafts: [
          unusable({ connectionId: null, endpoint: null, title: null, problem: 'unreadable_row' }),
        ],
      });
    });

    const screen = render();

    try {
      // Two different facts, two different headings: one came from somewhere known, the other from
      // somewhere this build could not read.
      assert.ok(screen.isUnder('From another server', 'Still being written'));
      assert.ok(screen.isUnder('Server not readable', 'could not read this note’s record'));
      assert.ok(
        screen.text().indexOf('From another server') < screen.text().indexOf('Server not readable'),
      );
    } finally {
      screen.unmount();
    }
  });

  it('never says nothing is unfinished while it is holding one', () => {
    act(() => {
      useCaptureOwner.setState({ unusableDrafts: [unusable()] });
    });

    const screen = render();

    try {
      assert.ok(!screen.text().includes('Nothing unfinished.'));
      assert.ok(screen.text().includes('written by a different version'));
    } finally {
      screen.unmount();
    }
  });

  it('says nothing is unfinished only when that is true of everything', () => {
    const empty = render();

    try {
      assert.ok(empty.text().includes('Nothing unfinished.'));
    } finally {
      empty.unmount();
    }

    act(() => {
      useCaptureOwner.setState({ unreadableAttempts: 1 });
    });

    const withUnreadable = render();

    try {
      // A record that could not be read is not nothing, even though it is not a card either.
      assert.ok(!withUnreadable.text().includes('Nothing unfinished.'));
      assert.ok(withUnreadable.text().includes('One saved record could not be read.'));
    } finally {
      withUnreadable.unmount();
    }
  });
});

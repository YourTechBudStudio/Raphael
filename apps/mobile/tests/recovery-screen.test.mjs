/**
 * Where a retained note is filed on the recovery screen, and what that placement claims.
 *
 * Every heading here is an assertion about origin, so the screen must not put a row under one it
 * cannot support. A note whose own record could not be read has no readable connection either, and
 * "From another server" would be this app inventing the one fact that is missing.
 *
 * The second half is the edits section. It is a separate projection under its own heading for the
 * same reason the note headings are separate: a creation that may have happened and writing that is
 * ahead of the server are different facts, and one list would make one policy answer for the other.
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
const { Alert } = await import('./support/stubs/react-native.mjs');
const { RecoveryScreen } = await import('../src/modules/capture/components/RecoveryScreen.tsx');
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
    byLabel: (label) => host.querySelector(`[aria-label="${label}"]`),
    press: (label) => {
      const control = host.querySelector(`[aria-label="${label}"]`);

      assert.ok(control !== null, `no control called ${label}`);
      act(() => {
        control.click();
      });
    },
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

const editRecord = (nodeId, over = {}) => ({
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
  Alert.calls.length = 0;
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

describe('the edits that are not on the server', () => {
  it('lists them under their own heading, with the standing and the two things that help', () => {
    act(() => {
      useEditOwner.setState({ edits: [editRecord(7)] });
    });

    const screen = render();

    try {
      assert.ok(screen.isUnder('Edits not on your server', 'note 7'));
      assert.ok(screen.text().includes('kept on this phone'));
      assert.ok(screen.byLabel('Open') !== null);
      assert.ok(screen.byLabel('Discard') !== null);
      // A separate projection, under a separate heading, never mixed into the notes above it.
      assert.ok(!screen.text().includes('Nothing unfinished.'));
    } finally {
      screen.unmount();
    }
  });

  it('carries the reason a refusal gave, in the editor’s own words', () => {
    act(() => {
      useEditOwner.setState({
        edits: [
          editRecord(7, {
            syncState: 'refused',
            lastRefusal: { code: 'slug_conflict', field: 'slug', reason: null, at: 1 },
          }),
        ],
      });
    });

    const screen = render();

    try {
      assert.ok(screen.text().includes('that note ID is already used'));
    } finally {
      screen.unmount();
    }
  });

  it('gives an unopenable row no title, no time and nothing but a discard', () => {
    act(() => {
      useEditOwner.setState({
        unusableEdits: [
          {
            key: { connectionId: CONNECTION, nodeId: 9 },
            endpoint: 'https://raphael.example',
            nodeType: null,
            title: null,
            problem: 'unusable_body',
          },
        ],
      });
    });

    const screen = render();

    try {
      const body = screen.text();

      assert.ok(body.includes('not something this version of Raphael can open'));
      assert.ok(!body.includes('Untitled'));
      assert.ok(screen.byLabel('Open') === null);
      assert.ok(screen.byLabel('Discard') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('opens one in the editor', () => {
    act(() => {
      useEditOwner.setState({ edits: [editRecord(7)] });
    });

    const screen = render();

    try {
      screen.press('Open');
      assert.deepEqual(navigations, [
        { method: 'push', target: { pathname: '/edit/[id]', params: { id: '7' } } },
      ]);
    } finally {
      screen.unmount();
    }
  });

  it('asks before discarding, and says the server is left as it is', () => {
    act(() => {
      useEditOwner.setState({ edits: [editRecord(7, { syncState: 'conflicted' })] });
    });

    const screen = render();

    try {
      screen.press('Discard');
      assert.equal(Alert.calls.length, 1, 'nothing is removed on the press alone');

      const [title, message] = Alert.calls[0];

      assert.equal(title, 'Discard your changes?');
      assert.ok(message.includes('What is on your server stays as it is.'));
      // Still listed: the confirmation was asked, not answered.
      assert.ok(screen.text().includes('note 7'));
    } finally {
      screen.unmount();
    }
  });

  it('reaches the owner with the right key once the confirmation is answered', async () => {
    const discarded = [];

    act(() => {
      useEditOwner.setState({
        edits: [editRecord(7, { syncState: 'conflicted' })],
        discardChanges: (editKey) => {
          discarded.push(editKey);

          return Promise.resolve({ kind: 'done' });
        },
      });
    });

    const screen = render();

    try {
      screen.press('Discard');

      const buttons = Alert.calls[0][2];

      act(() => {
        buttons.find((button) => button.style === 'destructive').onPress();
      });
      // The confirmation resolves a promise, so the call lands on the next turn.
      await act(async () => {
        await Promise.resolve();
      });

      assert.deepEqual(discarded, ['c1/7'], 'the accepted path reaches the owner, by edit key');
    } finally {
      screen.unmount();
    }
  });
});

/**
 * A store that could not be read is not a store with nothing in it.
 *
 * The capture owner has always said so. The edit owner refuses to go `ready` with empty lists for the
 * same reason, and after this phase that matters twice over: Home's chip is the only way to this
 * screen, so an unreadable edit store reported as "nothing unfinished" would hide the unsent writing
 * *and* the failure behind a door nothing opens.
 */
describe('a store that could not be read', () => {
  it('is reported rather than drawn as nothing unfinished', () => {
    act(() => {
      useEditOwner.setState({
        status: 'unavailable',
        problem: { kind: 'failed', reason: 'unreadable' },
      });
    });

    const screen = render();

    try {
      const body = screen.text();

      assert.ok(!body.includes('Nothing unfinished.'), 'the claim this screen must not make');
      assert.ok(body.includes('Unfinished work could not be read.'));
      assert.ok(body.includes('Nothing has been removed.'));
    } finally {
      screen.unmount();
    }
  });

  it('says it once when the one shared database is what failed', () => {
    act(() => {
      useCaptureOwner.setState({
        status: 'unavailable',
        problem: { kind: 'failed', reason: 'unopenable' },
      });
      useEditOwner.setState({
        status: 'unavailable',
        problem: { kind: 'failed', reason: 'unopenable' },
      });
    });

    const screen = render();

    try {
      // Both owners open the same file, so the common failure must not be reported twice in
      // identical words.
      const body = screen.text();
      const occurrences = body.split('Unfinished work could not be read.').length - 1;

      assert.equal(occurrences, 1);
    } finally {
      screen.unmount();
    }
  });
});

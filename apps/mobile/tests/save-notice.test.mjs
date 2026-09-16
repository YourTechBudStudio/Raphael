/**
 * Telling someone their note saved, once.
 *
 * The receipt is the point of contention. It is retained precisely so a success nobody was shown
 * survives the process that earned it — which means the queue keeps offering it until it is spent,
 * and spending it can fail. Without a guard, a failed spend is the very next thing the queue offers
 * and the notice reappears the instant it leaves, for as long as the write keeps failing.
 *
 * So the rule is: **announced once per mount, whether or not spending worked**, and offered again
 * after a later recovery or a restart. That is what this drives, through the real hook over the real
 * owner store.
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
const { useSaveNotice } = await import('../src/modules/capture/client/notes.ts');
const { useCaptureOwner } = await import('../src/modules/capture/client/owner.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');

/**
 * No retries in this file.
 *
 * The hierarchy read behind the destination's name has no server to answer it, and the app's retry
 * policy would keep a timer alive past the last unmount. Retry behaviour is the query layer's and is
 * tested there; here it is only noise that outlives the window.
 */
queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });

/**
 * One teardown, in order.
 *
 * The cache goes first: `useDestinationName` reads the hierarchy, so a query and its retry timer
 * outlive the last unmount, and tearing the window down under one is what turns a passing file into
 * "asynchronous activity after the test ended".
 */
after(async () => {
  queryClient.clear();
  // React's scheduler can have one callback still queued after the last unmount, and it reaches for
  // `window`. Letting the loop turn once lets it run against a window that is still there, rather
  // than against one this hook has just removed.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const CONNECTION = 'c1';

const acknowledged = (id) => ({
  id,
  revision: 1,
  title: 'A note',
  kind: 'note',
  entity: { id },
});

const attempt = (over = {}) => ({
  attemptId: 'a1',
  draftId: 'd1',
  connectionId: CONNECTION,
  endpoint: 'https://raphael.example',
  state: 'acknowledged',
  request: '{}',
  submittedDraftVersion: 1,
  title: 'A note',
  destination: { type: 'area', id: 3 },
  firstDispatchAt: 1,
  firstUncertainAt: null,
  clockAnomaly: false,
  lastOutcome: null,
  acknowledged: acknowledged(42),
  observedAt: 1,
  ...over,
});

/** Mounts the hook and reports what it says, plus the two callbacks a snackbar drives. */
const mount = () => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const seen = [];
  const live = { onShown: null, onHidden: null };

  function Probe() {
    const notice = useSaveNotice();

    live.onShown = notice.onShown;
    live.onHidden = notice.onHidden;
    seen.push(notice.message);

    return null;
  }

  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });

  return {
    seen,
    /** What the notice says right now. */
    message: () => seen.at(-1),
    /** Every distinct thing it has said, in order, ignoring re-renders that changed nothing. */
    announcements: () => seen.filter((message, index) => message !== seen[index - 1]),
    shown: () => {
      act(() => {
        live.onShown();
      });
    },
    hidden: () => {
      act(() => {
        live.onHidden();
      });
    },
    settle: async () => {
      await act(async () => {
        for (let turn = 0; turn < 10; turn += 1) {
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
        }
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

/** The owner, holding receipts and answering consumption the way the test asks it to. */
const owner = (attempts, consume) => {
  useCaptureOwner.setState({
    status: 'ready',
    problem: null,
    drafts: [],
    attempts,
    unsaved: {},
    sending: [],
    saving: [],
    consumeReceipt: async (attemptId) => {
      await consume(attemptId);
    },
  });
};

/** Where the note went, as the hierarchy would answer it. Seeded, so nothing is ever fetched. */
const hierarchy = () => {
  const work = {
    id: 3,
    type: 'area',
    parentId: null,
    slug: 'work',
    title: 'Work',
    description: '',
    children: [],
  };

  return { roots: [work], byId: new Map([[3, work]]) };
};

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryData(scopeKey(1, 'hierarchy'), hierarchy());
  useConnectionStore.setState({
    phase: {
      kind: 'active',
      rejection: null,
      session: {
        activation: 1,
        // Reached only by the hierarchy read behind the destination's name, which has nothing to
        // answer here. It refuses at once rather than hanging, so nothing outlives the test.
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
});

describe('the success notice', () => {
  it('says a save landed, and spends the receipt only once it has', async () => {
    const spent = [];

    owner([attempt()], (attemptId) => {
      spent.push(attemptId);
      useCaptureOwner.setState({ attempts: [] });
    });

    const probe = mount();

    try {
      await probe.settle();

      // Named from the hierarchy, because that is where a destination's title comes from.
      assert.equal(probe.message(), 'Saved in Work.');
      assert.deepEqual(spent, [], 'and nothing is spent by rendering it');

      probe.shown();
      assert.deepEqual(spent, ['a1']);

      // The message survives its own spending: the record is gone, and the notice stays until it
      // has had its time on screen.
      assert.ok(probe.message() !== null);

      probe.hidden();
      assert.equal(probe.message(), null);
    } finally {
      probe.unmount();
    }
  });

  it('does not loop when the receipt cannot be spent', async () => {
    const attempts = [];

    // The write fails, so the row stays exactly where it is - and the queue keeps offering it.
    owner([attempt()], (attemptId) => {
      attempts.push(attemptId);
    });

    const probe = mount();

    try {
      await probe.settle();
      probe.shown();
      probe.hidden();
      await probe.settle();

      assert.equal(
        useCaptureOwner.getState().attempts.length,
        1,
        'the success is still recoverable',
      );
      // One announcement, then nothing: without the per-mount guard this is where the notice would
      // reappear the instant it left, over and over.
      assert.equal(probe.message(), null);
      assert.deepEqual(
        probe.announcements().filter((message) => message !== null),
        [probe.announcements().find((message) => message !== null)],
      );
    } finally {
      probe.unmount();
    }
  });

  it('offers it again to a later session, which is what the retained row is for', async () => {
    owner([attempt()], () => {});

    const first = mount();

    await first.settle();
    first.shown();
    first.hidden();
    await first.settle();
    assert.equal(first.message(), null);
    first.unmount();

    // A restart, or coming back to Home later. The guard is per mount, not per record.
    const second = mount();

    try {
      await second.settle();
      assert.ok(second.message()?.startsWith('Saved'));
    } finally {
      second.unmount();
    }
  });

  it('says one thing at a time, oldest first', async () => {
    const spent = [];

    owner(
      [
        attempt({ attemptId: 'a2', firstDispatchAt: 20, acknowledged: acknowledged(2) }),
        attempt({ attemptId: 'a1', firstDispatchAt: 10, acknowledged: acknowledged(1) }),
      ],
      (attemptId) => {
        spent.push(attemptId);
        useCaptureOwner.setState({
          attempts: useCaptureOwner
            .getState()
            .attempts.filter((held) => held.attemptId !== attemptId),
        });
      },
    );

    const probe = mount();

    try {
      await probe.settle();
      probe.shown();
      assert.deepEqual(spent, ['a1'], 'the older one goes first');

      probe.hidden();
      await probe.settle();
      probe.shown();
      assert.deepEqual(spent, ['a1', 'a2']);
    } finally {
      probe.unmount();
    }
  });

  it('says nothing about a success that belongs to another server', async () => {
    owner([attempt({ connectionId: 'c-other' })], () => {});

    const probe = mount();

    try {
      await probe.settle();

      // It stays in recovery, with its own explicit dismissal. The current Home is not the place to
      // report something that happened somewhere this phone has left.
      assert.equal(probe.message(), null);
    } finally {
      probe.unmount();
    }
  });
});

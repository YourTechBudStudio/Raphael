/**
 * Leaving the composer, and opening the picker, are the same kind of act — and only one may run.
 *
 * Both take a lock and then await a flush, and the owner does not refuse a second lease: taking one
 * replaces the one in place. So without a guard decided in the same turn as the press, two Close
 * taps navigate twice, and a Close racing a picker tap leaves one of them holding a lease the other
 * has already replaced, with a sheet and a navigation both arriving.
 *
 * This mounts the real screen, because the latch is the screen's and the presses are what drive it.
 * The owner beneath it is seeded and its transition is held open by hand, which is the only way the
 * window between a press and its flush is reachable at all.
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
const { CaptureScreen } = await import('../src/modules/capture/components/CaptureScreen.tsx');
const { useCaptureOwner } = await import('../src/modules/capture/client/owner.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');
const { navigations, resetNavigations } = await import('expo-router');

queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });

after(async () => {
  queryClient.clear();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const DRAFT = {
  draftId: 'd1',
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  state: 'composing',
  title: 'Field notes',
  description: '',
  document: { type: 'doc', content: [] },
  contentSchemaVersion: 1,
  destination: { type: 'area', id: 3 },
  draftVersion: 1,
  submittedVersion: null,
  serverNodeId: null,
  serverRevision: null,
  createdAt: 1,
  updatedAt: 1,
};

const PROTECTION = {
  committedVersion: 1,
  latestAcceptedVersion: 1,
  pending: false,
  writing: false,
  failedWrite: false,
  rendererUnknown: false,
  locked: false,
  attached: true,
};

/** An owner whose controlled exit - and, when asked, whose save - is held open by the test. */
const heldOwner = (result, options = {}) => {
  const calls = [];
  const releases = [];
  const saves = [];
  let answer;
  let answerSave;

  useCaptureOwner.setState({
    status: 'ready',
    problem: null,
    drafts: [DRAFT],
    unusableDrafts: [],
    attempts: [],
    unsaved: {},
    sending: [],
    saving: [],
    protection: { d1: PROTECTION },
    standingFor: () => ({ kind: 'save' }),
    attachEditor: () => ({ draftId: 'd1', generation: 1 }),
    detachEditor: () => {},
    snapshotAccepted: () => 'accepted',
    flush: async () => ({ kind: 'flushed', version: 1, captured: 'editor' }),
    save: async () => {
      saves.push(1);

      if (options.holdSave !== true) return { kind: 'dispatched', attemptId: 'a1' };

      // As the real owner does: the draft is in flight for as long as the request is, which is what
      // the bar and the close control read to know the screen is busy.
      useCaptureOwner.setState({ saving: ['d1'] });

      await new Promise((resolve) => {
        answerSave = resolve;
      });

      useCaptureOwner.setState({ saving: [] });

      return { kind: 'dispatched', attemptId: 'a1' };
    },
    beginControlledExit: async () => {
      calls.push(1);

      await new Promise((resolve) => {
        answer = resolve;
      });

      const release = () => {
        releases.push(1);
      };

      return { result, release };
    },
  });

  return {
    calls,
    releases,
    saves,
    settle: async () => {
      answer?.();
      answerSave?.();
      await act(async () => {
        for (let turn = 0; turn < 10; turn += 1) {
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
        }
      });
    },
  };
};

const render = () => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(CaptureScreen, { draftId: 'd1' }),
      ),
    );
  });

  const find = (label) => host.querySelector(`[aria-label="${label}"]`);
  const byTestId = (id) => host.querySelector(`[data-testid="${id}"]`);

  return {
    find,
    byTestId,
    text: () => host.textContent ?? '',
    /**
     * Press several controls without letting React settle in between, as one frame does.
     *
     * A label finds a control by the name a screen reader would read; a `#testid` finds one whose
     * name depends on data this test does not seed.
     */
    pressTogether: (...names) => {
      act(() => {
        for (const name of names) {
          const control = name.startsWith('#') ? byTestId(name.slice(1)) : find(name);

          assert.ok(control !== null, `no control called ${name}`);
          control.click();
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
          connectionId: 'c1',
          base: 'https://raphael.example',
          origin: 'https://raphael.example',
          protocolVersion: 1,
        },
      },
    },
  });
});

describe('an action and a transition are the same admission', () => {
  it('ignores Close pressed in the same turn as Save', async () => {
    const owner = heldOwner(
      { kind: 'flushed', version: 1, captured: 'editor' },
      { holdSave: true },
    );
    const screen = render();

    try {
      screen.pressTogether('#capture-action', 'Close');

      assert.equal(owner.saves.length, 1);
      // The one that matters: a second lease taken here would break the save's own, so an
      // acknowledgement that should clear the draft would take the retain branch instead and leave
      // a remainder claiming newer writing that does not exist.
      assert.equal(owner.calls.length, 0, 'no controlled exit begins under a save');

      await owner.settle();

      assert.deepEqual(navigations, [], 'and nothing navigated out from under it');
    } finally {
      screen.unmount();
    }
  });

  it('will not leave while a save is still in the air', async () => {
    const owner = heldOwner(
      { kind: 'flushed', version: 1, captured: 'editor' },
      { holdSave: true },
    );
    const screen = render();

    try {
      await act(async () => {
        screen.pressTogether('#capture-action');
        await Promise.resolve();
      });

      // Seconds can pass here on a slow connection, which is the window this closes - the latch is
      // not only about one frame.
      screen.pressTogether('Close');
      assert.equal(owner.calls.length, 0);

      // And the control says so rather than swallowing the tap in silence.
      assert.equal(screen.find('Close').disabled, true);

      await owner.settle();
    } finally {
      screen.unmount();
    }
  });

  it('admits Close again once the save has answered', async () => {
    const owner = heldOwner(
      { kind: 'flushed', version: 1, captured: 'editor' },
      { holdSave: true },
    );
    const screen = render();

    try {
      screen.pressTogether('#capture-action');
      await owner.settle();

      // The save came back unresolved rather than created, so the screen stays and the person is
      // free to leave it.
      screen.pressTogether('Close');
      assert.equal(owner.calls.length, 1);
    } finally {
      screen.unmount();
    }
  });
});

describe('one controlled transition at a time', () => {
  it('leaves once for two Close presses in the same turn', async () => {
    const owner = heldOwner({ kind: 'flushed', version: 1, captured: 'editor' });
    const screen = render();

    try {
      screen.pressTogether('Close', 'Close');

      // Decided in the same turn as the press: the owner is asked once, so only one lease is taken
      // and only one navigation can follow.
      assert.equal(owner.calls.length, 1);

      await owner.settle();

      // One navigation, whichever form it takes: `goBack` lands on Home when there is no stack
      // behind the composer, which is what a deep link leaves.
      assert.equal(navigations.length, 1);
    } finally {
      screen.unmount();
    }
  });

  it('does not open the picker while a Close is in flight', async () => {
    const owner = heldOwner({ kind: 'flushed', version: 1, captured: 'editor' });
    const screen = render();

    try {
      screen.pressTogether('Close', '#capture-destination');

      assert.equal(owner.calls.length, 1, 'the second press finds the latch closed');

      await owner.settle();

      // One outcome, not a sheet and a navigation arriving over each other.
      assert.equal(navigations.length, 1);
      assert.ok(!screen.text().includes('Where does this go?'));
    } finally {
      screen.unmount();
    }
  });

  it('admits the next transition after one that could not flush', async () => {
    const owner = heldOwner({ kind: 'refused', code: 'too_large' });
    const screen = render();

    try {
      screen.pressTogether('Close');
      await owner.settle();

      // Nothing left, the lock went back, and the repair sheet is over a live editor.
      assert.deepEqual(navigations, []);
      assert.equal(owner.releases.length, 1);
      assert.ok(screen.text().includes('too large to keep here'));

      // The latch is open again: the person can act on the sheet rather than being stuck.
      screen.pressTogether('Keep editing');
      screen.pressTogether('Close');
      assert.equal(owner.calls.length, 2);
    } finally {
      screen.unmount();
    }
  });
});

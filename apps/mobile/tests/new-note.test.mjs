/**
 * Starting a note, and the two things that must not happen twice.
 *
 * A double tap is one turn, not two renders. Admitting both presses would insert two drafts and push
 * two routes, leaving one of them behind a screen nobody came back to - writing kept on a phone that
 * nothing on screen points at.
 *
 * And leaving the foreground asks the editor for a copy, unlocked, because the renderer is the one
 * place writing can exist that a process death takes with it.
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
const { useNewNote } = await import('../src/modules/capture/client/new-note.ts');
const { useBackgroundFlush } = await import('../src/modules/capture/client/background.ts');
const { useCaptureOwner } = await import('../src/modules/capture/client/owner.ts');
const { useStorageGate } = await import('../src/modules/capture/state/storage-gate.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { setAppState } = await import('./support/stubs/react-native.mjs');
const { navigations, resetNavigations } = await import('expo-router');

after(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const mount = (element) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(element);
  });

  return {
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
  useStorageGate.setState({ fatal: false });
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

describe('pressing New note', () => {
  it('starts one note for two presses in the same turn', async () => {
    let release;
    const created = [];
    const held = new Promise((resolve) => {
      release = resolve;
    });

    useCaptureOwner.setState({
      status: 'ready',
      problem: null,
      createDraft: async () => {
        created.push(1);
        await held;

        return { kind: 'created', draftId: `d${String(created.length)}` };
      },
    });

    const handle = {};

    function Probe() {
      Object.assign(handle, useNewNote());

      return null;
    }

    const probe = mount(createElement(Probe));

    try {
      // Both calls happen before anything has re-rendered, which is exactly what a double tap is.
      // A guard held in React state would let both through: they read the same rendered value.
      handle.start();
      handle.start();

      assert.equal(created.length, 1, 'one draft is asked for');

      release();
      await act(async () => {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      });

      assert.equal(created.length, 1);
      assert.deepEqual(navigations, [
        {
          method: 'push',
          target: { pathname: '/capture/[draftId]', params: { draftId: 'd1' } },
        },
      ]);
    } finally {
      probe.unmount();
    }
  });

  it('admits a later press once the first has finished', async () => {
    const created = [];

    useCaptureOwner.setState({
      status: 'ready',
      problem: null,
      createDraft: async () => {
        created.push(1);

        return { kind: 'created', draftId: `d${String(created.length)}` };
      },
    });

    const handle = {};

    function Probe() {
      Object.assign(handle, useNewNote());

      return null;
    }

    const probe = mount(createElement(Probe));

    try {
      await act(async () => {
        handle.start();
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      });
      await act(async () => {
        handle.start();
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      });

      assert.equal(created.length, 2, 'admission is released, not spent');
      assert.equal(navigations.length, 2);
    } finally {
      probe.unmount();
    }
  });
});

describe('leaving the foreground', () => {
  it('asks the editor for a copy, without taking the lock', async () => {
    const flushes = [];

    useCaptureOwner.setState({
      status: 'ready',
      problem: null,
      flush: async (draftId, options) => {
        flushes.push({ draftId, options });

        return { kind: 'flushed', version: 1, captured: 'editor' };
      },
    });

    function Probe() {
      useBackgroundFlush('d1');

      return null;
    }

    const probe = mount(createElement(Probe));

    try {
      act(() => {
        setAppState('inactive');
      });
      assert.deepEqual(flushes, [{ draftId: 'd1', options: undefined }], 'unlocked, by design');

      act(() => {
        setAppState('background');
      });
      assert.equal(flushes.length, 2);

      // Coming back is not a reason to ask: the editor is right there, and the next thing typed
      // schedules its own write.
      act(() => {
        setAppState('active');
      });
      assert.equal(flushes.length, 2);
    } finally {
      probe.unmount();
    }
  });

  it('stops asking once the composer is gone', () => {
    const flushes = [];

    useCaptureOwner.setState({
      status: 'ready',
      problem: null,
      flush: async (draftId) => {
        flushes.push(draftId);

        return { kind: 'flushed', version: 1, captured: 'editor' };
      },
    });

    function Probe() {
      useBackgroundFlush('d1');

      return null;
    }

    const probe = mount(createElement(Probe));

    probe.unmount();

    act(() => {
      setAppState('background');
    });

    assert.deepEqual(flushes, [], 'a listener outliving its screen would flush a draft nobody has');
  });
});

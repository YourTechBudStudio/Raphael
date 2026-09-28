/**
 * Starting a note, and keeping what is on screen in its row.
 *
 * A double tap is one turn, not two renders: admitting both presses would make two drafts and push
 * two routes. And leaving the foreground asks the editor for a copy, because the renderer is the one
 * place writing can exist that a process death takes with it.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';
import { nodeDriver } from './support/node-sqlite.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useNewNote } = await import('../src/modules/capture/client/new-note.ts');
const { useRowWriting } = await import('../src/modules/capture/client/writing.ts');
const { discardAllUnsent, resumeUnsent, startUnsent, useUnsentState, writeEdit } =
  await import('../src/modules/unsent/client/unsent.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { nodeKey } = await import('../src/infrastructure/query/keys.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { setAppState } = await import('./support/stubs/react-native.mjs');
const { navigations, resetNavigations } = await import('expo-router');

await startUnsent(nodeDriver());

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

const settle = () =>
  act(async () => {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  });

beforeEach(async () => {
  resetNavigations();
  await discardAllUnsent();
  // The wipe seals writes for a server switch; a test's reset is not one.
  resumeUnsent();
});

describe('pressing New note', () => {
  it('starts one note for two presses in the same turn', async () => {
    const handle = {};

    function Probe() {
      Object.assign(handle, useNewNote());

      return null;
    }

    const probe = mount(createElement(Probe));

    try {
      // Both calls happen before anything has re-rendered, which is exactly what a double tap is.
      handle.start();
      handle.start();
      await settle();

      const rows = useUnsentState.getState().rows;

      assert.equal(rows.length, 1, 'one draft');
      assert.equal(rows[0].status, 'draft');
      assert.deepEqual(navigations, [
        {
          method: 'push',
          target: { pathname: '/capture/[draftId]', params: { draftId: rows[0].id } },
        },
      ]);
    } finally {
      probe.unmount();
    }
  });

  it('admits a later press once the first has finished', async () => {
    const handle = {};

    function Probe() {
      Object.assign(handle, useNewNote());

      return null;
    }

    const probe = mount(createElement(Probe));

    try {
      handle.start();
      await settle();
      handle.start();
      await settle();

      assert.equal(useUnsentState.getState().rows.length, 2);
      assert.equal(navigations.length, 2);
    } finally {
      probe.unmount();
    }
  });
});

describe('keeping a row in step with the screen', () => {
  const editorGiving = (document) => {
    const asked = [];

    return {
      asked,
      port: {
        current: {
          requestSnapshot: (options) => {
            asked.push(options);

            return Promise.resolve({
              kind: 'captured',
              unchanged: false,
              snapshot: { sessionId: 1, editSeq: 1, document },
            });
          },
        },
      },
    };
  };

  const probe = (save, editor, onScreen = () => ({ title: 'On screen' })) => {
    const handle = {};

    function Probe() {
      Object.assign(handle, useRowWriting(save, editor.port, onScreen));

      return null;
    }

    return { handle, mounted: mount(createElement(Probe)) };
  };

  it('asks the editor for a copy when the app leaves the foreground, and writes it', async () => {
    const written = [];
    const editor = editorGiving({ type: 'doc', content: [] });
    const { mounted } = probe(async (patch) => {
      written.push(patch);

      return true;
    }, editor);

    try {
      act(() => {
        setAppState('inactive');
      });
      await settle();
      assert.deepEqual(editor.asked, [undefined], 'unlocked, by design');
      assert.deepEqual(written, [{ title: 'On screen', body: { type: 'doc', content: [] } }]);

      // Coming back is not a reason to ask: the editor is right there.
      act(() => {
        setAppState('active');
      });
      await settle();
      assert.equal(editor.asked.length, 1);
    } finally {
      mounted.unmount();
    }
  });

  it('answers a flush only once what is on screen has reached the phone', async () => {
    let finish;
    const editor = editorGiving({ type: 'doc', content: ['typed'] });
    const { handle, mounted } = probe(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      editor,
    );

    try {
      let answered = null;

      void handle.flush().then((ok) => {
        answered = ok;
      });
      await settle();
      assert.equal(answered, null, 'still waiting on the write');

      finish(true);
      await settle();
      assert.equal(answered, true);
    } finally {
      mounted.unmount();
    }
  });

  it('says so when a flush did not reach the phone, until a later one does', async () => {
    let ok = false;
    const editor = editorGiving({ type: 'doc', content: [] });
    const { handle, mounted } = probe(async () => ok, editor);

    try {
      let answered;

      await act(async () => {
        answered = await handle.flush();
      });
      assert.equal(answered, false, 'Close and Save stay put');
      assert.equal(handle.failed, true);

      ok = true;
      await act(async () => {
        answered = await handle.flush();
      });
      assert.equal(answered, true);
      assert.equal(handle.failed, false, 'the full write made up for it');
    } finally {
      mounted.unmount();
    }
  });

  it('writes what the editor last reported when the screen goes', async () => {
    const written = [];
    const handle = {};
    const editor = editorGiving(null);

    function Probe() {
      Object.assign(
        handle,
        useRowWriting(
          async (patch) => {
            written.push(patch);

            return true;
          },
          editor.port,
          () => ({}),
        ),
      );

      return null;
    }

    const screen = mount(createElement(Probe));

    handle.onSnapshot({ sessionId: 1, editSeq: 2, document: { type: 'doc', content: ['late'] } });
    screen.unmount();

    assert.deepEqual(written, [{ body: { type: 'doc', content: ['late'] } }]);
  });

  it('will not let the screen go when the editor does not hand over what it holds', async () => {
    const written = [];
    const unanswering = {
      port: { current: { requestSnapshot: async () => ({ kind: 'unanswered' }) } },
    };
    const { handle, mounted } = probe(async (patch) => {
      written.push(patch);

      return true;
    }, unanswering);

    try {
      let answered;

      // Before the editor's first, delayed edit report: nothing reported yet is not nothing typed.
      await act(async () => {
        answered = await handle.flush();
      });
      assert.equal(answered, false);
      assert.equal(handle.failed, true);

      handle.onSnapshot({
        sessionId: 1,
        editSeq: 1,
        document: { type: 'doc', content: ['typed'] },
      });
      await act(async () => {
        answered = await handle.flush();
      });
      assert.equal(answered, false, 'nor after a report');
    } finally {
      mounted.unmount();
    }
  });

  it('still writes what the editor reported when it stops answering as the app backgrounds', async () => {
    const written = [];
    const unanswering = {
      port: { current: { requestSnapshot: async () => ({ kind: 'unanswered' }) } },
    };
    const { handle, mounted } = probe(async (patch) => {
      written.push(patch);

      return true;
    }, unanswering);

    try {
      // Reported, with its debounced write not yet due when the app goes to the background.
      handle.onSnapshot({
        sessionId: 1,
        editSeq: 1,
        document: { type: 'doc', content: ['typed'] },
      });
      act(() => {
        setAppState('background');
      });
      await settle();

      assert.deepEqual(written, [
        { title: 'On screen', body: { type: 'doc', content: ['typed'] } },
      ]);
      assert.equal(handle.failed, true, 'and still says the flush did not take everything');
    } finally {
      act(() => {
        setAppState('active');
      });
      mounted.unmount();
    }
  });

  it('will not let the screen go when the editor refuses to hand over what it holds', async () => {
    const refusing = {
      port: { current: { requestSnapshot: async () => ({ kind: 'refused', code: 'too_large' }) } },
    };
    const { handle, mounted } = probe(async () => true, refusing);

    try {
      let answered;

      await act(async () => {
        answered = await handle.flush();
      });
      assert.equal(answered, false);
    } finally {
      mounted.unmount();
    }
  });

  it('writes nothing more once its writing was discarded, not even on its way out', async () => {
    const written = [];
    const handle = {};
    const editor = editorGiving(null);

    function Probe() {
      Object.assign(
        handle,
        useRowWriting(
          async (patch) => {
            written.push(patch);

            return true;
          },
          editor.port,
          () => ({ title: 'Mine' }),
        ),
      );

      return null;
    }

    const screen = mount(createElement(Probe));

    handle.onSnapshot({ sessionId: 1, editSeq: 2, document: { type: 'doc', content: ['mine'] } });
    // Take server's.
    handle.abandon();
    screen.unmount();
    await settle();

    assert.deepEqual(written, [], 'the discarded writing does not come back');
  });
});

describe('an edit after a server switch', () => {
  const connect = (activation) => {
    useConnectionStore.setState({
      phase: {
        kind: 'active',
        rejection: null,
        session: {
          activation,
          transport: {},
          connection: {
            connectionId: 'c1',
            base: 'https://raphael.example',
            origin: 'https://raphael.example',
            protocolVersion: '2026-09-24',
          },
        },
      },
    });
  };

  const node = {
    id: 42,
    type: 'resource',
    kind: 'note',
    parentId: 1,
    slug: 'field-notes',
    revision: 3,
    title: 'Field notes',
    description: '',
    tags: [],
    active: false,
    archived: false,
    isFavorite: false,
    archiveCauses: [],
    body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'paragraph' }] } },
    metadata: {},
  };

  it('is kept for a node this connection read, and not for one an earlier connection read', async () => {
    connect(1);
    queryClient.setQueryData(nodeKey(1, node.id), node);
    assert.equal(await writeEdit(node.id, { title: 'Edited' }), true);
    assert.equal(useUnsentState.getState().rows.length, 1);
    assert.equal(useUnsentState.getState().rows[0].baseRevision, 3);

    // The switch wipes the rows first and activates the new server only after its hold. An editor
    // of the old server writing in between, with the old server's read still cached, is refused.
    await discardAllUnsent();
    assert.equal(await writeEdit(node.id, { title: 'Edited during the hold' }), false);
    assert.equal(useUnsentState.getState().rows.length, 0);

    // After activation, an editor from before the switch writes on its way out.
    queryClient.clear();
    connect(2);
    await writeEdit(node.id, { title: 'Edited on the way out' });

    assert.equal(useUnsentState.getState().rows.length, 0, 'nothing for the new server to send');
  });
});

describe('a switch that does not happen', () => {
  it('lets this server’s screens write again', async () => {
    await discardAllUnsent();
    resumeUnsent();

    useConnectionStore.setState({
      phase: {
        kind: 'active',
        rejection: null,
        session: {
          activation: 7,
          transport: {},
          connection: {
            connectionId: 'c1',
            base: 'https://raphael.example',
            origin: 'https://raphael.example',
            protocolVersion: '2026-09-24',
          },
        },
      },
    });
    queryClient.setQueryData(nodeKey(7, 9), {
      id: 9,
      type: 'resource',
      kind: 'note',
      parentId: 1,
      slug: 'kept',
      revision: 1,
      title: 'Kept',
      description: '',
      tags: [],
      active: false,
      archived: false,
      isFavorite: false,
      archiveCauses: [],
      body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'paragraph' }] } },
      metadata: {},
    });

    assert.equal(await writeEdit(9, { title: 'Still writing here' }), true);
    assert.equal(useUnsentState.getState().rows.length, 1);
    await discardAllUnsent();
    resumeUnsent();
    queryClient.clear();
  });
});

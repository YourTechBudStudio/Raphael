/**
 * What the app shows before it shows the app.
 *
 * Two gates, in order, and the order is the decision. **Setup is a prerequisite for using Raphael**,
 * not a screen with the app behind it: without a configured connection there is no Home, no
 * composer and - the part that changed in this phase - no unfinished-note list underneath the form.
 * Everything on the phone stays exactly where it is and becomes reachable once a connection exists,
 * because nothing is ever rebound to a new connection by matching an endpoint, so offering to read
 * or copy it beforehand would only offer actions that cannot be honest.
 *
 * Inside that, the storage gate: a phone that cannot keep a note does not open a composer over one.
 * What it must never do is replace a live editor later, which is why the two conditions it latches
 * are the ones that happen before anything is on screen.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';
import { openNodeDatabase } from './support/node-sqlite.mjs';

const hooks = installNativeStubs();
after(() => hooks.deregister());

const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.teardown());

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { StorageGate } = await import('../src/modules/capture/components/StorageGate.tsx');
const { useCaptureOwner } = await import('../src/modules/capture/client/owner.ts');
const { useStorageGate } = await import('../src/modules/capture/state/storage-gate.ts');
const { ConnectionGate } = await import('../src/modules/connection/components/ConnectionGate.tsx');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { openCaptureStore } = await import('../src/modules/capture/store.ts');

const temporaries = [];

after(async () => {
  queryClient.clear();
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const temporaryFile = async (name) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-gate-'));
  temporaries.push(dir);

  return path.join(dir, name);
};

/** Open the real store over the real schema, do something, and close it again. */
const withStore = async (file, body) => {
  const outcome = await openCaptureStore(await openNodeDatabase(file), () => Date.now());

  assert.equal(outcome.kind, 'ready');

  try {
    return await body(outcome.store);
  } finally {
    await outcome.store.close();
  }
};

const render = (element) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(element);
  });

  return {
    text: () => host.textContent ?? '',
    byLabel: (label) => host.querySelector(`[aria-label="${label}"]`),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

const APP = createElement('span', { 'aria-label': 'the app' }, 'Home');

beforeEach(() => {
  useStorageGate.setState({ fatal: false });
  useCaptureOwner.setState({ status: 'ready', problem: null, drafts: [], attempts: [] });
});

describe('the storage gate', () => {
  it('shows the app once this phone can keep a note', () => {
    const screen = render(createElement(StorageGate, null, APP));

    try {
      assert.ok(screen.byLabel('the app') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('holds everything back while it is still opening', () => {
    act(() => {
      useCaptureOwner.setState({ status: 'opening' });
    });
    const screen = render(createElement(StorageGate, null, APP));

    try {
      assert.equal(screen.byLabel('the app'), null);
      assert.ok(screen.byLabel('Opening Raphael') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('says the app cannot open, and offers to try again', () => {
    act(() => {
      useCaptureOwner.setState({
        status: 'unavailable',
        problem: { kind: 'failed', reason: 'unopenable' },
      });
    });
    const screen = render(createElement(StorageGate, null, APP));

    try {
      assert.equal(screen.byLabel('the app'), null);
      assert.ok(screen.text().includes('Raphael cannot open.'));
      assert.ok(screen.text().includes('nothing has been reset'));
      assert.ok(screen.byLabel('Try again') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('does not offer a second attempt at a database a newer build wrote', () => {
    act(() => {
      useCaptureOwner.setState({
        status: 'unavailable',
        problem: { kind: 'unsupported_version', found: 9, supported: 1 },
      });
    });
    const screen = render(createElement(StorageGate, null, APP));

    try {
      assert.ok(screen.text().includes('newer version of Raphael'));
      assert.ok(screen.text().includes('Nothing has been changed or removed'));
      // A second attempt cannot fix a schema from the future, so none is offered.
      assert.equal(screen.byLabel('Try again'), null);
    } finally {
      screen.unmount();
    }
  });

  it('latches a draft that could not be created, and offers no retry that would do nothing', () => {
    act(() => {
      useStorageGate.getState().latch();
    });
    const screen = render(createElement(StorageGate, null, APP));

    try {
      assert.equal(screen.byLabel('the app'), null);
      assert.ok(screen.text().includes('could not start a new note'));
      // The store is open; reopening it is not the remedy and would answer nothing.
      assert.equal(screen.byLabel('Try again'), null);
    } finally {
      screen.unmount();
    }
  });
});

describe('a phone holding writing, with no server to send it to', () => {
  /**
   * The database half is real: the same store, the same schema, the same migrations, over
   * `node:sqlite` through the same port. The composition half is real too. The one seam a Node test
   * can never exercise is `expo-sqlite` itself, which is device evidence and is recorded as such.
   */
  it('keeps the draft, opens setup, and shows nothing of it', async () => {
    const file = await temporaryFile('capture.db');
    const at = Date.now();

    const written = await withStore(file, (store) =>
      store.insertDraft({
        draftId: 'd1',
        connectionId: 'c-old',
        endpoint: 'https://raphael.example',
        title: 'Written before the server went away',
        description: '',
        document: { type: 'doc', content: [] },
        destination: null,
        at,
      }),
    );

    assert.ok(written !== null);

    // Reopened by a second process, exactly as a relaunch does.
    const stored = await withStore(file, (store) => store.list());

    assert.equal(stored.drafts.length, 1);
    assert.equal(stored.drafts[0].title, 'Written before the server went away');

    act(() => {
      useCaptureOwner.setState({ status: 'ready', problem: null, drafts: stored.drafts });
      useConnectionStore.setState({ phase: { kind: 'absent', removalProblem: null } });
    });

    const screen = render(
      createElement(ConnectionGate, null, createElement(StorageGate, null, APP)),
    );

    try {
      assert.equal(screen.byLabel('the app'), null);

      const text = screen.text();

      // The writing is on this phone and is readable by the code underneath, and none of it is on
      // screen: there is no route to recovery before setup, and nothing is ever rebound to a new
      // connection by matching an endpoint, so offering to copy it here would offer an action that
      // could not be honest.
      assert.ok(!text.includes('Written before the server went away'));
      assert.ok(!text.includes('Unfinished'));
      assert.ok(!text.includes('Copy into a new note'));
      assert.ok(!text.includes('Discard'));
    } finally {
      screen.unmount();
    }

    // And nothing that happened above touched it.
    const reread = await withStore(file, (store) => store.list());

    assert.deepEqual(reread.drafts, stored.drafts);
  });

  it('shows nothing of it behind an unreadable keychain either', async () => {
    const file = await temporaryFile('capture.db');

    await withStore(file, (store) =>
      store.insertDraft({
        draftId: 'd2',
        connectionId: 'c-old',
        endpoint: 'https://raphael.example',
        title: 'Also kept',
        description: '',
        document: { type: 'doc', content: [] },
        destination: null,
        at: Date.now(),
      }),
    );

    const stored = await withStore(file, (store) => store.list());

    act(() => {
      useCaptureOwner.setState({ status: 'ready', problem: null, drafts: stored.drafts });
      useConnectionStore.setState({
        phase: { kind: 'unreadable', problem: 'failed', message: 'the keychain did not answer' },
      });
    });

    const screen = render(
      createElement(ConnectionGate, null, createElement(StorageGate, null, APP)),
    );

    try {
      assert.equal(screen.byLabel('the app'), null);
      assert.ok(!screen.text().includes('Also kept'));
      assert.ok(!screen.text().includes('Unfinished'));
    } finally {
      screen.unmount();
    }

    const reread = await withStore(file, (store) => store.list());

    assert.equal(reread.drafts.length, 1, 'a keychain that cannot be read erases nothing');
  });
});

describe('the connection gate', () => {
  it('shows setup and nothing else when this device has no server', () => {
    act(() => {
      useConnectionStore.setState({ phase: { kind: 'absent', removalProblem: null } });
    });
    const screen = render(createElement(ConnectionGate, null, APP));

    try {
      assert.equal(screen.byLabel('the app'), null, 'the app is not behind the setup form');
      // No unfinished list, no copy, no discard: there is no route to any of it before setup, and
      // nothing on this phone is ever rebound to a new connection by matching an endpoint.
      const text = screen.text();
      assert.ok(!text.includes('Unfinished'));
      assert.ok(!text.includes('Copy into a new note'));
      assert.ok(!text.includes('Discard'));
    } finally {
      screen.unmount();
    }
  });

  it('keeps its own repair flow for a keychain it cannot read, still with nothing underneath', () => {
    act(() => {
      useConnectionStore.setState({
        phase: { kind: 'unreadable', problem: 'failed', message: 'the keychain did not answer' },
      });
    });
    const screen = render(createElement(ConnectionGate, null, APP));

    try {
      assert.equal(screen.byLabel('the app'), null);
      assert.ok(screen.text().includes('the keychain did not answer'));
      assert.ok(!screen.text().includes('Unfinished'));
    } finally {
      screen.unmount();
    }
  });

  it('is a spinner while storage is being read, which is not the same as having read nothing', () => {
    act(() => {
      useConnectionStore.setState({ phase: { kind: 'loading' } });
    });
    const screen = render(createElement(ConnectionGate, null, APP));

    try {
      assert.equal(screen.byLabel('the app'), null);
      assert.ok(screen.byLabel('Opening Raphael') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('opens the app on a stored connection, without waiting for the server to answer', () => {
    act(() => {
      useConnectionStore.setState({
        phase: {
          kind: 'active',
          rejection: null,
          session: {
            activation: 1,
            transport: {},
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
    const screen = render(createElement(ConnectionGate, null, APP));

    try {
      // Having a server means having one written down, not reaching one. The screens inside report
      // what they cannot reach; a network gate would lock someone out of the app whose connection
      // they were trying to fix.
      assert.ok(screen.byLabel('the app') !== null);
    } finally {
      screen.unmount();
    }
  });
});

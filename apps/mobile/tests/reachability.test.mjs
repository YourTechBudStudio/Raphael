/**
 * Whether the phone can reach its server, and the offline screen that follows from it.
 *
 * A network failure or a timeout is offline; any answer from the server, even a 5xx, is not; a caller
 * cancelling says nothing. Every transport the connection builds reports its results, and while
 * offline the gate checks again and brings the app back when the server answers.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { isOnline, noteResult, onBackOnline, useReachability } =
  await import('../src/modules/connection/state/reachability.ts');
const { createTransportPort } = await import('../src/modules/connection/client/ports.ts');
const { OfflineGate } = await import('../src/modules/connection/components/OfflineGate.tsx');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');

after(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  dom.teardown();
  hooks.deregister();
});

const failure = (over) => ({ ok: false, failure: { message: 'x', ...over } });

beforeEach(() => {
  useReachability.setState({ online: true });
});

describe('reachability', () => {
  it('goes offline on a network failure or a timeout, and online on any answer', () => {
    noteResult(failure({ kind: 'network' }));
    assert.equal(isOnline(), false);

    noteResult(failure({ kind: 'http', status: 404, code: 'node_not_found' }));
    assert.equal(isOnline(), true, 'a refusal is an answer');

    noteResult(failure({ kind: 'timeout' }));
    assert.equal(isOnline(), false);

    noteResult({ ok: true, value: {} });
    assert.equal(isOnline(), true);
  });

  it('does not call a server error offline', () => {
    noteResult(failure({ kind: 'http', status: 503 }));
    noteResult(failure({ kind: 'http', status: 502 }));
    assert.equal(isOnline(), true);
  });

  it('learns nothing from a request the caller cancelled or never sent', () => {
    noteResult(failure({ kind: 'network' }));
    noteResult(failure({ kind: 'cancelled' }));
    noteResult(failure({ kind: 'invalid_request' }));
    assert.equal(isOnline(), false);
  });

  it('tells a listener once each time the server comes back', () => {
    const heard = [];
    const stop = onBackOnline(() => heard.push(true));

    noteResult(failure({ kind: 'network' }));
    noteResult({ ok: true, value: {} });
    noteResult({ ok: true, value: {} });
    stop();

    assert.deepEqual(heard, [true]);
  });

  it('is fed by every transport the connection builds', async () => {
    const built = createTransportPort('https://raphael.example', `test-${'k'.repeat(40)}`);

    assert.equal(built.ok, true);
    // The stubbed fetch throws, which is what an unreachable server looks like.
    await built.transport.invoke({
      route: { method: 'POST', path: '/api/connection/verify' },
      body: {},
      decode: () => ({ _tag: 'Right', right: {} }),
      successStatus: 200,
    });

    assert.equal(isOnline(), false);
  });
});

describe('the offline gate', () => {
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
            base: 'https://pi.local',
            origin: 'https://pi.local',
            protocolVersion: PROTOCOL_VERSION,
          },
        },
      },
    });
  };

  const mount = (exempt) => {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const root = createRoot(host);

    act(() => {
      root.render(createElement(OfflineGate, { exempt }, createElement('p', null, 'the app')));
    });

    return {
      text: () => host.textContent ?? '',
      press: (label) => {
        act(() => {
          host.querySelector(`[aria-label="${label}"]`).click();
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

  it('covers the app while offline, and a check that is answered brings it back', async () => {
    const answers = [];

    connect({
      endpoint: { origin: 'https://pi.local', basePath: '' },
      timeoutMs: 1000,
      invoke: async () => {
        const result = answers.shift() ?? {
          ok: true,
          value: { protocolVersion: PROTOCOL_VERSION },
        };

        noteResult(result);

        return result;
      },
    });

    const screen = mount(false);

    try {
      assert.ok(!screen.text().includes('Can’t reach your server.'));

      act(() => {
        noteResult(failure({ kind: 'network' }));
      });
      assert.ok(screen.text().includes('Can’t reach your server.'));
      assert.ok(screen.text().includes('the app'), 'the app stays mounted underneath');

      await act(async () => {
        screen.press('Try now');
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      });

      assert.equal(isOnline(), true);
      assert.ok(!screen.text().includes('Can’t reach your server.'));
    } finally {
      screen.unmount();
    }
  });

  it('leaves the composer and the editor working while offline', () => {
    connect({ endpoint: {}, timeoutMs: 1000, invoke: async () => failure({ kind: 'network' }) });

    const screen = mount(true);

    try {
      act(() => {
        noteResult(failure({ kind: 'network' }));
      });
      assert.ok(!screen.text().includes('Can’t reach your server.'));
    } finally {
      screen.unmount();
    }
  });
});

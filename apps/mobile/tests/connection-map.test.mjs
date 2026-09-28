/**
 * Settings' connection map and its round actions, rendered.
 *
 * The drawing is decorative, so what is pinned here is what the words beside it say: where the key
 * is, next to the phone, and the address, next to the server, in each state the connection can be
 * in. Each end speaks as one sentence, because a screen reader should hear the fact, not its parts.
 *
 * The native stubs never report a layout, so the thread itself is never drawn here - which is also
 * what a person using a screen reader gets, since it is hidden from them.
 *
 * Trying again after a refusal is pinned on the whole Settings screen, against a fake transport:
 * the refusal stays up while the server is asked, and comes down only when it accepts this phone.
 */

import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Unplug } = await import('lucide-react-native');
const { ConnectionMap } = await import('../src/modules/connection/components/ConnectionMap.tsx');
const { DiscAction } = await import('../src/ui/index.ts');
const { SettingsScreen } = await import('../src/modules/connection/components/SettingsScreen.tsx');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');

after(() => {
  dom.teardown();
  hooks.deregister();
});

const mounted = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const render = (element) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(element);
  });

  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  return {
    $: (selector) => host.querySelector(selector),
    text: () => host.textContent ?? '',
    press: (label) => {
      act(() => {
        host.querySelector(`[aria-label="${label}"]`).click();
      });
    },
  };
};

const ORIGIN = 'http://10.0.2.2:3000';

const connection = (storage = { kind: 'saved' }) => ({
  connectionId: 'c1',
  base: ORIGIN,
  origin: ORIGIN,
  protocolVersion: 1,
  verifiedAt: '2026-09-28T12:00:00.000Z',
  storage,
});

const map = ({ storage, rejection = null } = {}) =>
  render(createElement(ConnectionMap, { connection: connection(storage), rejection }));

const phone = (view) => view.$('[aria-label^="This phone"]').getAttribute('aria-label');
const server = (view) => view.$('[aria-label^="Your server"]').getAttribute('aria-label');

describe('the connection map', () => {
  it('says the key is saved beside the phone, and the address beside the server', () => {
    const view = map();

    assert.equal(phone(view), 'This phone. Key saved here.');
    assert.equal(server(view), `Your server, ${ORIGIN}, connected`);
    assert.ok(view.text().includes(ORIGIN));
  });

  it('says a key the keychain would not take is only held, and why', () => {
    const view = map({ storage: { kind: 'write_failed', message: 'Keychain locked.' } });

    assert.equal(phone(view), 'This phone. Key held until you close the app.');
    assert.ok(view.text().includes('Keychain locked.'));
  });

  it('says the same for a platform with no secure storage, with its own reason', () => {
    const view = map({ storage: { kind: 'unsupported' } });

    assert.equal(phone(view), 'This phone. Key held until you close the app.');
    assert.ok(view.text().includes('This platform has no secure storage'));
  });

  it('puts a refused key on the phone, and stops calling the server connected', () => {
    const view = map({ rejection: 'unauthorized' });

    assert.equal(phone(view), 'This phone. Its key was refused.');
    assert.equal(server(view), `Your server, ${ORIGIN}`);
    assert.ok(view.text().includes('does not accept the key this device is holding'));
  });

  it('puts a protocol mismatch on the server, and leaves the key where it is', () => {
    const view = map({ rejection: 'incompatible_protocol' });

    assert.equal(phone(view), 'This phone. Key saved here.');
    assert.equal(server(view), `Your server, ${ORIGIN}, speaks a different version`);
  });
});

describe('a disc action', () => {
  it('is one button named by the words under the disc', () => {
    const view = render(
      createElement(DiscAction, {
        icon: Unplug,
        label: 'Disconnect',
        onPress: () => undefined,
        tone: 'danger',
      }),
    );
    const button = view.$('[role="button"]');

    assert.equal(button.getAttribute('aria-label'), 'Disconnect');
    assert.ok(button.querySelector('[data-icon="Unplug"]'));
    assert.ok(button.textContent.includes('Disconnect'));
  });
});

describe('trying again after a refusal', () => {
  const refused = {
    ok: false,
    failure: { kind: 'http', status: 401, code: 'unauthorized', message: 'Refused.' },
  };
  const accepted = { ok: true, value: { protocolVersion: PROTOCOL_VERSION } };

  /** A server whose answers the test hands over one at a time, when it chooses. */
  const connectRefused = (activation = 1) => {
    const pending = [];

    useConnectionStore.setState({
      phase: {
        kind: 'active',
        rejection: 'unauthorized',
        session: {
          activation,
          transport: {
            endpoint: { origin: ORIGIN, basePath: '' },
            timeoutMs: 1000,
            invoke: () =>
              new Promise((resolve) => {
                pending.push(resolve);
              }),
          },
          connection: connection(),
        },
      },
    });

    return {
      /** Answers the oldest check still waiting, or the one at `index` among those waiting. */
      answer: async (result, index = 0) => {
        await act(async () => {
          pending.splice(index, 1)[0](result);
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
        });
      },
    };
  };

  it('keeps the refusal up while it asks, and after the server refuses again', async () => {
    const remote = connectRefused();
    const view = render(createElement(SettingsScreen));

    view.press('Try again');
    assert.ok(view.$('[aria-label="Checking…"]'), 'the button says it is checking');
    assert.equal(phone(view), 'This phone. Its key was refused.', 'nothing claimed yet');

    await remote.answer(refused);
    assert.equal(useConnectionStore.getState().phase.rejection, 'unauthorized');
    assert.equal(phone(view), 'This phone. Its key was refused.');
    assert.ok(view.$('[aria-label="Try again"]'), 'and it can be asked again');
  });

  it('takes the refusal down only once the server accepts this phone', async () => {
    const remote = connectRefused();
    const view = render(createElement(SettingsScreen));

    view.press('Try again');
    await remote.answer(accepted);

    assert.equal(useConnectionStore.getState().phase.rejection, null);
    assert.equal(phone(view), 'This phone. Key saved here.');
    assert.equal(view.$('[aria-label="Try again"]'), null);
  });

  it('does not let an answer about a replaced connection clear the new one', async () => {
    const remote = connectRefused(1);
    const view = render(createElement(SettingsScreen));

    view.press('Try again');
    act(() => {
      useConnectionStore.setState(({ phase }) => ({
        phase: { ...phase, session: { ...phase.session, activation: 2 } },
      }));
    });
    await remote.answer(accepted);

    assert.equal(useConnectionStore.getState().phase.rejection, 'unauthorized');
  });

  it('lets only the newest check decide, whichever answer arrives last', async () => {
    // Settings over Home: two screens, each with its own Try again, on one connection.
    const acceptedLast = connectRefused();
    const settings = render(createElement(SettingsScreen));
    const home = render(createElement(SettingsScreen));

    settings.press('Try again');
    home.press('Try again');
    await acceptedLast.answer(refused, 1);
    await acceptedLast.answer(accepted);
    assert.equal(
      useConnectionStore.getState().phase.rejection,
      'unauthorized',
      'an older acceptance does not undo a newer refusal',
    );

    const refusedLast = connectRefused();
    settings.press('Try again');
    home.press('Try again');
    await refusedLast.answer(accepted, 1);
    await refusedLast.answer(refused);
    assert.equal(
      useConnectionStore.getState().phase.rejection,
      null,
      'an older refusal does not undo a newer acceptance',
    );
  });
});

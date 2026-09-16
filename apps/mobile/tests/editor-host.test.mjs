/**
 * The component, rendered.
 *
 * The reducer decides and the controller wires, and both are tested on their own. What only this can
 * show is that the component actually connects them: that `onMessage` reaches the controller, that a
 * returned promise is the one that settles, that a dead renderer is replaced under its new session,
 * and that the WebView is configured to load the bundled document and nothing else.
 *
 * It is not device evidence. A substituted WebView proves the JavaScript wiring and says nothing
 * about what a real WKWebView or Android WebView does with the same props; that is Phase 07's.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
after(() => hooks.deregister());

const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.teardown());

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { webViews, resetWebViews } = await import('./support/stubs/react-native-webview.mjs');
const { EditorHost } = await import('../src/modules/editor/host/EditorHost.tsx');
const { EDITOR_DOCUMENT_HTML, EDITOR_DOCUMENT_STAMP } =
  await import('../src/modules/editor/generated/document.ts');

const doc = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Reads back what the host injected, the way the WebView would have parsed it. */
const delivered = (script) => {
  let received;
  const window = {
    __raphaelEditor: {
      receive: (raw) => {
        received = raw;
      },
    },
  };
  new Function('window', script)(window);
  return JSON.parse(received);
};

const mounts = [];

const mount = (props = {}) => {
  resetWebViews();
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);

  const port = { current: null };
  const events = { snapshot: [], locked: [], problem: [], link: [], selection: [] };
  const element = () =>
    createElement(EditorHost, {
      documentId: 'd1',
      document: doc('hello'),
      editable: true,
      ref: port,
      onSnapshot: (value) => events.snapshot.push(value),
      onLockedChange: (value) => events.locked.push(value),
      onProblem: (value) => events.problem.push(value),
      onLinkPress: (value) => events.link.push(value),
      onSelectionChange: (value) => events.selection.push(value),
      ...props,
    });

  act(() => root.render(element()));

  const harness = {
    port,
    events,
    root,
    /** The live renderer: the newest one that mounted. */
    webView: () => webViews[webViews.length - 1],
    injected: () => harness.webView().injected.map(delivered),
    from: (message) =>
      act(() => {
        harness.webView().props.onMessage({ nativeEvent: { data: JSON.stringify(message) } });
      }),
    rerender: (next = {}) => act(() => root.render(element(next))),
    unmount: () => act(() => root.unmount()),
    live: () => {
      harness.from({ type: 'ready', ...EDITOR_DOCUMENT_STAMP });
      harness.from({ type: 'initialized', sessionId: 1 });
      harness.webView().injected.length = 0;
    },
  };
  mounts.push(harness);
  return harness;
};

after(() => {
  for (const harness of mounts) {
    try {
      harness.unmount();
    } catch {
      // Already unmounted by its own test; tearing down twice is not a failure.
    }
  }
});

describe('the WebView the host configures', () => {
  it('loads the bundled document and locks the surface down', () => {
    const app = mount();
    const { props } = app.webView();

    assert.deepEqual(props.source, { html: EDITOR_DOCUMENT_HTML });
    assert.deepEqual(props.originWhitelist, ['about:blank']);
    assert.equal(props.javaScriptEnabled, true);
    assert.equal(props.allowFileAccess, false);
    assert.equal(props.allowFileAccessFromFileURLs, false);
    assert.equal(props.allowUniversalAccessFromFileURLs, false);
    assert.equal(props.allowsLinkPreview, false);
    assert.equal(props.setSupportMultipleWindows, false);
  });

  it('admits the initial load once, and nothing afterwards', () => {
    const app = mount();
    const allow = app.webView().props.onShouldStartLoadWithRequest;

    assert.equal(allow({ url: 'about:blank' }), true);
    // Everything after it, including the link the person tapped, is refused.
    assert.equal(allow({ url: 'about:blank' }), false);
    assert.equal(allow({ url: 'https://example.com/' }), false);
    assert.equal(allow({ url: 'file:///etc/passwd' }), false);
  });

  it('refuses navigation whether or not anyone is listening for links', () => {
    const app = mount({ onLinkPress: undefined });
    const allow = app.webView().props.onShouldStartLoadWithRequest;
    assert.equal(allow({ url: 'about:blank' }), true);
    assert.equal(allow({ url: 'https://example.com/' }), false);
  });
});

describe('messages from the renderer', () => {
  it('turn a matching ready into the initialization injection', () => {
    const app = mount({ document: doc('written') });
    app.from({ type: 'ready', ...EDITOR_DOCUMENT_STAMP });

    assert.deepEqual(app.injected(), [
      { type: 'init', sessionId: 1, document: doc('written'), editable: true },
    ]);
  });

  it('inject nothing when the bundle does not match', () => {
    const app = mount();
    app.from({ type: 'ready', ...EDITOR_DOCUMENT_STAMP, payloadDigest: 'sha256-stale' });

    assert.deepEqual(app.injected(), []);
    assert.equal(app.events.problem[0].stage, 'handshake');
  });

  it('reach the owner as authored changes', () => {
    const app = mount();
    app.live();
    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 1,
      document: doc('typed'),
      reason: 'edit',
    });

    assert.equal(app.events.snapshot.length, 1);
    assert.deepEqual(app.events.snapshot[0].document, doc('typed'));
  });
});

describe('the port the component hands out', () => {
  it('settles the promise the caller is holding, once', async () => {
    const app = mount();
    app.live();

    let settled = 0;
    const barrier = app.port.current.requestSnapshot({ lock: true }).then((result) => {
      settled += 1;
      return result;
    });

    const request = app.injected().find((message) => message.type === 'requestSnapshot');
    assert.notEqual(request, undefined);
    assert.deepEqual(app.events.locked, [true]);

    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 1,
      document: doc('flushed'),
      reason: 'requested',
      requestId: request.requestId,
    });

    const result = await barrier;
    assert.equal(result.kind, 'captured');
    assert.deepEqual(result.snapshot.document, doc('flushed'));

    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 1,
      document: doc('flushed'),
      reason: 'requested',
      requestId: request.requestId,
    });
    await Promise.resolve();
    assert.equal(settled, 1);
  });

  it('survives a parent that re-creates its callbacks', () => {
    const app = mount();
    app.live();
    const before = app.webView();

    app.rerender({ onSnapshot: (value) => app.events.snapshot.push(value) });
    // Same renderer, same session: a rerender is not a replacement.
    assert.equal(app.webView(), before);

    app.from({ type: 'snapshot', sessionId: 1, editSeq: 1, document: doc('kept'), reason: 'edit' });
    assert.equal(app.events.snapshot.length, 1);
  });

  it('settles outstanding work when the route goes', async () => {
    const app = mount();
    app.live();
    const barrier = app.port.current.requestSnapshot({ lock: true });

    app.unmount();
    assert.deepEqual(await barrier, { kind: 'unanswered' });
  });
});

describe('a renderer that dies', () => {
  it('is replaced, and the replacement is initialized from the newest work held', () => {
    const app = mount();
    app.live();
    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 2,
      document: doc('newest'),
      reason: 'edit',
    });

    const first = app.webView();
    act(() => first.props.onContentProcessDidTerminate());

    const second = app.webView();
    assert.notEqual(second, first, 'the dead renderer must be replaced, not reused');
    assert.equal(first.mounted, false);

    app.from({ type: 'ready', ...EDITOR_DOCUMENT_STAMP });
    assert.deepEqual(app.injected(), [
      { type: 'init', sessionId: 2, document: doc('newest'), editable: true },
    ]);
  });
});

describe('links', () => {
  it('reach the consumer only after the shared URL policy has passed them', () => {
    const app = mount();
    app.live();

    app.from({ type: 'link', sessionId: 1, href: 'https://example.com/a' });
    assert.deepEqual(app.events.link, ['https://example.com/a']);

    app.from({ type: 'link', sessionId: 1, href: 'javascript:alert(1)' });
    assert.deepEqual(app.events.link, ['https://example.com/a']);
    assert.deepEqual(app.events.problem.at(-1), { stage: 'link', sessionId: 1 });
  });
});

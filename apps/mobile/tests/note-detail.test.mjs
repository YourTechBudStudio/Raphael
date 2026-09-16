/**
 * Opening a saved note, and refusing to.
 *
 * Two things are being pinned. The first is that a note that cannot be read never produces an
 * editor: an editor holding nothing looks exactly like a note that is empty, and someone who then
 * typed into it would be writing into a screen that never loaded what they came to read. The second
 * is that the screen which *can* be shown is read-only in fact and not only by intention - it asks
 * for no snapshot, wires no save, and hands the renderer a permanently locked document.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

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
const { EDITOR_DOCUMENT_HTML, EDITOR_DOCUMENT_STAMP } =
  await import('../src/modules/editor/generated/document.ts');
const { NoteView } = await import('../src/modules/resources/components/NoteView.tsx');
const { displayableBody, isFatalEditorProblem, noteViewState, readFailureReason } =
  await import('../src/modules/resources/client/display.ts');
const { ClientFailureError } = await import('../src/infrastructure/query/failure.ts');

const doc = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const entity = (over = {}) => ({
  id: 12,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: 'a-note',
  revision: 4,
  title: 'A note',
  description: 'What it is about',
  tags: [],
  body: { format: 'tiptap', value: doc('Hello') },
  metadata: {},
  ...over,
});

const ready = (over = {}) => ({
  kind: 'ready',
  documentId: '12',
  title: 'A note',
  description: 'What it is about',
  revision: 4,
  body: doc('Hello'),
  ...over,
});

const render = (element) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(element);
  });

  return {
    container,
    text: () => container.textContent,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const has = (container, selector) => container.querySelector(selector) !== null;

/** Reads back what the host injected, the way the WebView would have parsed it. */
const delivered = (script) => {
  let received;
  const window = { __raphaelEditor: { receive: (raw) => (received = raw) } };
  new Function('window', script)(window);

  return JSON.parse(received);
};

/** Delivers one renderer message to the mounted host. */
const fromRenderer = (message) => {
  act(() => {
    webViews[0].props.onMessage({ nativeEvent: { data: JSON.stringify(message) } });
  });
};

beforeEach(() => {
  resetWebViews();
});

describe('a body that may be displayed', () => {
  it('is a note whose document uses the vocabulary the editor renders', () => {
    assert.deepEqual(displayableBody(entity()), doc('Hello'));
  });

  it('is not a container that happens to have been asked for', () => {
    assert.equal(displayableBody(entity({ type: 'area', kind: null })), null);
  });

  it('is not a resource of a kind this build does not draw', () => {
    assert.equal(displayableBody(entity({ kind: 'bookmark' })), null);
  });

  it('is not Markdown, however readable it looks', () => {
    // The screen renders a document. Converting Markdown here would make this a second content
    // authority beside `@raphael/content`, which is the whole reason Get is asked for TipTap.
    assert.equal(displayableBody(entity({ body: { format: 'markdown', value: '# Hello' } })), null);
  });

  it('is not a document carrying something outside the allowlist', () => {
    const outside = { type: 'doc', content: [{ type: 'table', content: [] }] };

    assert.equal(displayableBody(entity({ body: { format: 'tiptap', value: outside } })), null);
  });
});

describe('which renderer problems mean it cannot be shown', () => {
  it('a refused document, an unexpected bundle, and an oversized payload do', () => {
    assert.equal(isFatalEditorProblem({ stage: 'document', failure: {}, sessionId: 1 }), true);
    assert.equal(isFatalEditorProblem({ stage: 'handshake', expected: {}, received: {} }), true);
    assert.equal(
      isFatalEditorProblem({ stage: 'envelope', refusal: 'too_large', sessionId: 1 }),
      true,
    );
  });

  it('a refused link does not, because the note is still perfectly readable', () => {
    assert.equal(isFatalEditorProblem({ stage: 'link', sessionId: 1 }), false);
  });

  it('a renderer that died does not, because the host loads the document again', () => {
    assert.equal(
      isFatalEditorProblem({ stage: 'recovery', sessionId: 1, lostRendererWriting: false }),
      false,
    );
  });
});

/** A failure the shared client would actually have thrown, carried the way `unwrap` carries it. */
const thrown = (failure) => new ClientFailureError(failure);

const apiError = (status) =>
  thrown({ kind: 'api_error', mutationOutcome: 'not_applicable', message: 'refused', status });

describe('classifying a read that failed', () => {
  it('calls a transport fault and a timeout retryable, because trying again could work', () => {
    assert.equal(
      readFailureReason(
        thrown({ kind: 'transport', mutationOutcome: 'not_applicable', message: 'offline' }),
      ),
      'retryable',
    );
    assert.equal(
      readFailureReason(
        thrown({ kind: 'timeout', mutationOutcome: 'not_applicable', message: 'timed out' }),
      ),
      'retryable',
    );
  });

  it('calls a server having a bad moment retryable, and an opinion settled', () => {
    assert.equal(readFailureReason(apiError(503)), 'retryable');
    assert.equal(readFailureReason(apiError(400)), 'unopenable');
  });

  it('calls a note the server looked for and did not find missing', () => {
    // The ordinary case: a card opened from a list read before the note was deleted. The server was
    // perfectly reachable, so telling someone to wait for it would be advice that cannot work.
    assert.equal(readFailureReason(apiError(404)), 'missing');
  });

  it('calls an answer it could not read settled, not a server to wait for', () => {
    assert.equal(
      readFailureReason(
        thrown({
          kind: 'invalid_response',
          mutationOutcome: 'not_applicable',
          message: 'unreadable',
          reason: 'malformed',
        }),
      ),
      'unopenable',
    );
  });

  it('calls anything that is not a client failure settled', () => {
    // It came from this app's own code, and repeating it will not fix it.
    assert.equal(readFailureReason(new Error('boom')), 'unopenable');
  });
});

describe('what the detail screen decides to show', () => {
  const observation = (over = {}) => ({
    id: 12,
    isError: false,
    error: null,
    entity: undefined,
    rendererFailed: false,
    ...over,
  });

  it('waits while the read is still running', () => {
    assert.deepEqual(noteViewState(observation()), { kind: 'loading' });
  });

  it('opens a note whose document this build can display', () => {
    const state = noteViewState(observation({ entity: entity() }));

    assert.equal(state.kind, 'ready');
    assert.equal(state.documentId, '12');
    assert.equal(state.revision, 4);
    assert.deepEqual(state.body, doc('Hello'));
  });

  it('carries the failure\u2019s own classification through, rather than one reason for all', () => {
    assert.deepEqual(noteViewState(observation({ isError: true, error: apiError(404) })), {
      kind: 'unavailable',
      reason: 'missing',
    });
    assert.deepEqual(
      noteViewState(
        observation({
          isError: true,
          error: thrown({ kind: 'transport', mutationOutcome: 'not_applicable', message: 'x' }),
        }),
      ),
      { kind: 'unavailable', reason: 'retryable' },
    );
    assert.deepEqual(noteViewState(observation({ isError: true, error: apiError(400) })), {
      kind: 'unavailable',
      reason: 'unopenable',
    });
  });

  it('refuses a body this build cannot display, however well the read went', () => {
    assert.deepEqual(
      noteViewState(observation({ entity: entity({ body: { format: 'markdown', value: '#' } }) })),
      { kind: 'unavailable', reason: 'unopenable' },
    );
    assert.deepEqual(noteViewState(observation({ entity: entity({ type: 'area', kind: null }) })), {
      kind: 'unavailable',
      reason: 'unopenable',
    });
  });

  it('refuses once the renderer has said it cannot show it', () => {
    assert.deepEqual(noteViewState(observation({ entity: entity(), rendererFailed: true })), {
      kind: 'unavailable',
      reason: 'unopenable',
    });
  });

  it('treats a route that named no note as nothing to find, not a failed read', () => {
    // Nothing was ever asked, so no failure describes it and no server can be blamed for it.
    assert.deepEqual(noteViewState(observation({ id: null })), {
      kind: 'unavailable',
      reason: 'missing',
    });
  });
});

describe('the note, open', () => {
  it('shows the title, the description and the revision it is at', () => {
    const view = render(createElement(NoteView, { state: ready(), onClose: () => undefined }));

    assert.ok(view.text().includes('A note'));
    assert.ok(view.text().includes('What it is about'));
    assert.ok(view.text().includes('On your server · revision 4'));
    view.unmount();
  });

  it('omits the description line when there is none', () => {
    const view = render(
      createElement(NoteView, { state: ready({ description: '' }), onClose: () => undefined }),
    );

    assert.ok(!view.text().includes('What it is about'));
    view.unmount();
  });

  it('loads the bundled document, not anything fetched', () => {
    const view = render(createElement(NoteView, { state: ready(), onClose: () => undefined }));

    assert.deepEqual(webViews[0].props.source, { html: EDITOR_DOCUMENT_HTML });
    view.unmount();
  });

  it('initializes the renderer read-only, with the document that was validated', () => {
    const view = render(createElement(NoteView, { state: ready(), onClose: () => undefined }));
    fromRenderer({ type: 'ready', ...EDITOR_DOCUMENT_STAMP });

    // `editable: false` is permanent for this host by contract: a read-only host refuses to become
    // editable later. This is the message that makes the claim true rather than intended.
    assert.deepEqual(webViews[0].injected.map(delivered), [
      { type: 'init', sessionId: 1, document: doc('Hello'), editable: false },
    ]);
    view.unmount();
  });

  it('asks for no snapshot, so nothing on this screen can write', () => {
    const view = render(createElement(NoteView, { state: ready(), onClose: () => undefined }));
    fromRenderer({ type: 'ready', ...EDITOR_DOCUMENT_STAMP });
    fromRenderer({ type: 'initialized', sessionId: 1 });

    const asked = webViews[0].injected.map(delivered).map((message) => message.type);

    // A snapshot is the only way a document leaves the renderer. Never requesting one is what makes
    // this screen incapable of producing a draft or a save, rather than merely not offering them.
    assert.ok(!asked.includes('requestSnapshot'));
    assert.ok(!asked.includes('setEditable'));
    view.unmount();
  });

  it('offers nothing in the bar but where the note is filed', () => {
    const view = render(createElement(NoteView, { state: ready(), onClose: () => undefined }));

    assert.equal(has(view.container, '[data-testid="note-destination"]'), true);
    assert.ok(!view.text().includes('Save'), 'editing a saved note is story #4');
    view.unmount();
  });

  it('names where it is filed, eliding anything above the parent', () => {
    const view = render(
      createElement(NoteView, {
        state: ready(),
        location: ['Home', 'Kitchen', 'Renovation'],
        onClose: () => undefined,
      }),
    );

    assert.ok(view.text().includes('… / Kitchen / Renovation'));
    const chip = view.container.querySelector('[data-testid="note-destination"]');
    assert.equal(chip.getAttribute('aria-label'), 'Filed in Home, Kitchen, Renovation');
    view.unmount();
  });

  it('says only that it is on the server when the location is not known', () => {
    const view = render(createElement(NoteView, { state: ready(), onClose: () => undefined }));

    assert.ok(view.text().includes('Filed on your server'));
    view.unmount();
  });
});

describe('a note that could not be opened', () => {
  const unavailable = (reason) => ({ kind: 'unavailable', reason });

  it('is one plain screen with one way out, and no editor at all', () => {
    const view = render(
      createElement(NoteView, { state: unavailable('retryable'), onClose: () => undefined }),
    );

    assert.ok(view.text().includes('This note could not be opened'));
    assert.equal(has(view.container, '[data-webview]'), false, 'never an empty editor');
    assert.ok(view.text().includes('Back to Home'));
    view.unmount();
  });

  it('offers to try again only when trying again could work', () => {
    const retryable = render(
      createElement(NoteView, { state: unavailable('retryable'), onClose: () => undefined }),
    );
    assert.ok(retryable.text().includes('try again later'));
    retryable.unmount();

    // An answer this build cannot read comes back the same way every time. Telling someone to wait
    // for the server would send them round that loop for as long as they were willing.
    const unopenable = render(
      createElement(NoteView, { state: unavailable('unopenable'), onClose: () => undefined }),
    );
    assert.ok(unopenable.text().includes('trying again will not help'));
    assert.ok(!unopenable.text().includes('try again later'));
    unopenable.unmount();
  });

  it('never tells someone a server that answered was unreachable', () => {
    // The whole chain, not a hand-picked reason: a real 5xx failure classified by the real mapping
    // and drawn by the real screen. A 503 is a server that was reached, listened, and said it was
    // having a bad moment - so "try again" is right and "once the server is reachable" is not.
    const state = noteViewState({
      id: 12,
      isError: true,
      error: apiError(503),
      entity: undefined,
      rendererFailed: false,
    });
    const view = render(createElement(NoteView, { state, onClose: () => undefined }));

    assert.ok(view.text().includes('try again later'));
    assert.ok(!view.text().includes('reachable'));
    assert.ok(!view.text().includes('will not help'), 'a 5xx is worth another go');
    view.unmount();
  });

  it('says a note that is not there is not there, and blames no server for it', () => {
    const view = render(
      createElement(NoteView, { state: unavailable('missing'), onClose: () => undefined }),
    );

    assert.ok(view.text().includes('This note is not here.'));
    assert.ok(view.text().includes('The link may be old, or the note was removed'));
    assert.ok(!view.text().includes('server'), 'the server answered; it is not the problem');
    view.unmount();
  });

  it('goes home from the button and from the close control alike', () => {
    let closed = 0;
    const view = render(
      createElement(NoteView, {
        state: unavailable('retryable'),
        onClose: () => {
          closed += 1;
        },
      }),
    );

    for (const button of view.container.querySelectorAll('button')) button.click();
    assert.equal(closed, 2);
    view.unmount();
  });
});

describe('while it is still being read', () => {
  it('shows the shape of the screen and no editor', () => {
    const view = render(
      createElement(NoteView, { state: { kind: 'loading' }, onClose: () => undefined }),
    );

    assert.equal(has(view.container, '[aria-label="Opening this note"]'), true);
    assert.equal(has(view.container, '[data-webview]'), false);
    view.unmount();
  });
});

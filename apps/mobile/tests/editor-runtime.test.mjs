/**
 * The browser half, driving the real TipTap editor.
 *
 * Every command here goes through the same chain the toolbar sends, every snapshot is canonicalized
 * by the same function core uses, and the lock is the production coordinator wired to the editor's
 * own `view.composing` and the document's own composition events. A model of this code would prove
 * that the model agrees with itself.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { installDom, scheduler } from './support/browser-dom.mjs';

const dom = installDom();
after(() => dom.teardown());

const { createEditorRuntime } = await import('../src/modules/editor/webview/runtime.ts');

const SETTLE = 50;
const DEADLINE = 1300;
const DEBOUNCE = 300;

const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content) => ({ type: 'doc', content });

const open = ({ editable = true, document = doc(paragraph('hello')) } = {}) => {
  const clock = scheduler();
  const sent = [];
  const element = dom.window.document.createElement('div');
  dom.window.document.body.append(element);

  const runtime = createEditorRuntime({
    element,
    post: (raw) => sent.push(JSON.parse(raw)),
    payloadDigest: 'sha256-test',
    timers: clock.timers,
    debounceMs: DEBOUNCE,
    settleMs: SETTLE,
    deadlineMs: DEADLINE,
  });

  const send = (message) => runtime.receive(JSON.stringify(message));
  send({ type: 'init', sessionId: 1, document, editable });
  clock.advance(0);

  return {
    runtime,
    element,
    sent,
    send,
    advance: clock.advance,
    of: (type) => sent.filter((message) => message.type === type),
    drain: () => sent.splice(0, sent.length),
    close: () => {
      runtime.destroy();
      element.remove();
    },
  };
};

/** Types into the editor the way a person would: a real transaction, not a direct state write. */
const type = (session, text) => {
  session.runtime.editor.commands.insertContent(text);
};

describe('initialization', () => {
  it('announces the bundle it actually is', () => {
    const session = open();
    session.drain();
    session.runtime.announce();
    assert.deepEqual(session.of('ready')[0], {
      type: 'ready',
      bridgeVersion: 1,
      contentSchemaVersion: 1,
      payloadDigest: 'sha256-test',
    });
    session.close();
  });

  it('loads the document without authoring a change', () => {
    const session = open();
    assert.equal(session.of('initialized').length, 1);
    assert.equal(session.of('snapshot').length, 0);
    session.advance(DEBOUNCE * 2);
    // `emitUpdate: false` is the whole point: initialization cannot produce a snapshot.
    assert.equal(session.of('snapshot').length, 0);
    assert.equal(session.runtime.editor.getText(), 'hello');
    session.close();
  });

  it('retains the supplied draft when it cannot be loaded, rather than repairing it', () => {
    const session = open();
    session.drain();
    session.send({
      type: 'init',
      sessionId: 2,
      document: { type: 'doc', content: [{ type: 'image' }] },
      editable: true,
    });
    assert.deepEqual(session.of('rejected')[0].code, 'invalid_document');
    assert.equal(session.of('initialized').length, 0);
    // Nothing was loaded and nothing was rewritten into something loadable.
    assert.equal(session.runtime.editor.getText(), 'hello');
    session.close();
  });

  it('ignores a message addressed to a session it is not in', () => {
    const session = open();
    session.drain();
    session.send({ type: 'requestSnapshot', sessionId: 99, requestId: 1 });
    assert.deepEqual(session.drain(), []);
    session.close();
  });

  it('refuses a malformed envelope without throwing', () => {
    const session = open();
    session.drain();
    session.runtime.receive('{"type":');
    assert.equal(session.of('rejected')[0].code, 'unsupported_message');
    session.close();
  });
});

describe('edit snapshots', () => {
  it('coalesces a burst into one trailing snapshot', () => {
    const session = open();
    session.drain();
    type(session, ' a');
    session.advance(DEBOUNCE - 10);
    type(session, ' b');
    session.advance(DEBOUNCE - 10);
    type(session, ' c');
    assert.equal(session.of('snapshot').length, 0);

    session.advance(DEBOUNCE);
    const snapshots = session.of('snapshot');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].reason, 'edit');
    assert.equal(snapshots[0].editSeq, 3);
    assert.equal(snapshots[0].document.content[0].content[0].text, 'hello a b c');
    session.close();
  });

  it("sends canonical content, not the editor's own JSON", () => {
    const session = open({ document: doc(paragraph('x')) });
    session.drain();
    session.send({ type: 'command', sessionId: 1, command: { kind: 'setHeading', level: 2 } });
    session.advance(DEBOUNCE);
    const snapshot = session.of('snapshot')[0];
    assert.equal(snapshot.document.content[0].type, 'heading');
    assert.equal(snapshot.document.content[0].attrs.level, 2);
    session.close();
  });
});

describe('the requested barrier', () => {
  it('cancels a pending debounce and answers once', () => {
    const session = open();
    session.drain();
    type(session, '!');
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 7 });

    const answers = session.of('snapshot');
    assert.equal(answers.length, 1);
    assert.equal(answers[0].reason, 'requested');
    assert.equal(answers[0].requestId, 7);

    // A debounced snapshot can never arrive after the flush carrying work the flush did not report.
    session.advance(DEBOUNCE * 3);
    assert.equal(session.of('snapshot').length, 1);
    session.close();
  });

  it('answers an unchanged document rather than staying silent', () => {
    const session = open();
    session.drain();
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 1 });
    const answer = session.of('snapshot')[0];
    assert.equal(answer.reason, 'requested');
    // No edit has happened, so the sequence has not moved: a confirmation, not new work.
    assert.equal(answer.editSeq, 0);
    session.close();
  });

  it('answers a read-only editor too', () => {
    const session = open({ editable: false });
    session.drain();
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 2 });
    assert.equal(session.of('snapshot')[0].requestId, 2);
    session.close();
  });

  it('refuses a document it cannot canonicalize, against the request that asked', () => {
    const session = open();
    session.drain();
    // Past DOCUMENT_MAX_NODES: a long note really can cross this, and the document then exists only
    // in the renderer. It is never repaired, never dropped, and never reported as saved.
    const many = Array.from({ length: 10_001 }, (_, index) => paragraph(`p${index}`));
    session.runtime.editor.commands.insertContent(many);
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 3 });

    const rejection = session.of('rejected')[0];
    assert.equal(rejection.code, 'invalid_document');
    assert.equal(rejection.requestId, 3);
    assert.equal(session.of('snapshot').length, 0);
    // The renderer keeps it, so it can be brought back into range by undo or by editing.
    assert.ok(session.runtime.editor.state.doc.childCount > 10_000);
    session.close();
  });

  it('admits one barrier at a time', () => {
    const session = open();
    session.drain();
    session.send({ type: 'setEditable', sessionId: 1, editable: false });
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 1 });
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 2 });

    const refusal = session.of('rejected')[0];
    assert.equal(refusal.code, 'unsupported_message');
    assert.equal(refusal.requestId, 2);
    session.close();
  });
});

describe('the lock', () => {
  it('waits out the quiet window, then locks and answers the retained request', () => {
    const session = open();
    session.drain();
    session.send({ type: 'setEditable', sessionId: 1, editable: false });
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 5 });

    // Pending, not applied: the editor stays editable while the window runs.
    assert.equal(session.runtime.editor.isEditable, true);
    assert.equal(session.of('snapshot').length, 0);

    session.advance(SETTLE);
    assert.equal(session.runtime.editor.isEditable, false);
    assert.equal(session.of('snapshot')[0].requestId, 5);
    session.close();
  });

  it('refuses a command that races the lock, and mutates nothing', () => {
    const session = open({ document: doc(paragraph('body')) });
    session.drain();
    const before = session.runtime.editor.getJSON();

    session.send({ type: 'setEditable', sessionId: 1, editable: false });
    session.send({ type: 'command', sessionId: 1, command: { kind: 'toggleBold' } });
    assert.equal(session.of('rejected')[0].code, 'locked');
    assert.deepEqual(session.runtime.editor.getJSON(), before);

    session.advance(SETTLE);
    session.send({ type: 'command', sessionId: 1, command: { kind: 'toggleBold' } });
    assert.equal(session.of('rejected').length, 2);
    assert.deepEqual(session.runtime.editor.getJSON(), before);
    session.close();
  });

  it('does not replay a refused command when the lock is released', () => {
    const session = open({ document: doc(paragraph('body')) });
    session.drain();
    session.runtime.editor.commands.selectAll();
    const before = session.runtime.editor.getJSON();

    session.send({ type: 'setEditable', sessionId: 1, editable: false });
    session.send({ type: 'command', sessionId: 1, command: { kind: 'toggleBold' } });
    session.advance(SETTLE);
    session.send({ type: 'setEditable', sessionId: 1, editable: true });
    session.advance(SETTLE * 4);

    assert.equal(session.runtime.editor.isEditable, true);
    assert.deepEqual(session.runtime.editor.getJSON(), before);
    session.close();
  });

  it('stays pending through a live composition and settles after it ends', () => {
    const session = open();
    session.drain();
    session.send({ type: 'setEditable', sessionId: 1, editable: false });
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 9 });

    session.element.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
    session.advance(SETTLE * 4);
    assert.equal(session.runtime.editor.isEditable, true);
    assert.equal(session.of('snapshot').length, 0);

    session.element.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true }));
    session.advance(SETTLE);
    assert.equal(session.runtime.editor.isEditable, false);
    assert.equal(session.of('snapshot')[0].requestId, 9);
    session.close();
  });

  it('refuses honestly when composition never settles, and leaves editing live', () => {
    const session = open();
    session.drain();
    session.send({ type: 'setEditable', sessionId: 1, editable: false });
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 11 });

    for (let elapsed = 0; elapsed < DEADLINE + SETTLE; elapsed += SETTLE - 5) {
      session.element.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
      session.advance(SETTLE - 5);
    }

    const rejection = session.of('rejected')[0];
    assert.equal(rejection.code, 'composing');
    assert.equal(rejection.requestId, 11);
    assert.equal(session.runtime.editor.isEditable, true);
    session.close();
  });

  it("is wired to the editor's own composing flag, not only to the events", () => {
    const session = open();
    session.drain();
    // What the recheck reads is `view.composing`; the events only start and restart the window.
    session.runtime.editor.view.input.composing = true;
    session.send({ type: 'setEditable', sessionId: 1, editable: false });
    session.advance(SETTLE * 3);
    assert.equal(session.runtime.editor.isEditable, true);

    session.runtime.editor.view.input.composing = false;
    session.element.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true }));
    session.advance(SETTLE);
    assert.equal(session.runtime.editor.isEditable, false);
    session.close();
  });
});

describe('the repair path, end to end', () => {
  /** Lock the editor for real, then have the flush refuse, then release it the way the host does. */
  const lockedRefusalThenRelease = (session, requestId) => {
    session.send({ type: 'setEditable', sessionId: 1, editable: false });
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId });
    session.advance(SETTLE);
    assert.equal(session.runtime.editor.isEditable, false, 'the lock should have applied');

    const rejection = session.of('rejected')[0];
    assert.equal(rejection.requestId, requestId);
    assert.equal(session.of('snapshot').length, 0);

    session.send({ type: 'setEditable', sessionId: 1, editable: true });
    return rejection.code;
  };

  it('brings an oversized document back into range with undo', () => {
    const session = open({ document: doc(paragraph('start')) });
    session.drain();

    // Over the bridge envelope, not over the node limit: it canonicalizes perfectly well and simply
    // cannot be sent. The renderer is the only thing holding it.
    session.runtime.editor.commands.insertContent('x'.repeat(1_200_000));
    assert.equal(lockedRefusalThenRelease(session, 21), 'too_large');

    assert.equal(session.runtime.editor.isEditable, true);
    session.send({ type: 'command', sessionId: 1, command: { kind: 'undo' } });
    assert.equal(session.runtime.editor.getText(), 'start');

    // And now it fits, so the same flush succeeds.
    session.drain();
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 22 });
    assert.equal(session.of('snapshot')[0].requestId, 22);
  });

  it('brings a document past the node limit back into range with undo', () => {
    const session = open({ document: doc(paragraph('start')) });
    session.drain();

    const many = Array.from({ length: 10_001 }, (_, index) => paragraph(`p${index}`));
    session.runtime.editor.commands.insertContent(many);
    assert.equal(lockedRefusalThenRelease(session, 31), 'invalid_document');

    assert.equal(session.runtime.editor.isEditable, true);
    session.send({ type: 'command', sessionId: 1, command: { kind: 'undo' } });

    session.drain();
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 32 });
    assert.equal(session.of('snapshot')[0].requestId, 32);
    assert.equal(session.of('rejected').length, 0);
  });

  it('accepts ordinary editing again, not only undo', () => {
    const session = open({ document: doc(paragraph('start')) });
    session.drain();
    session.runtime.editor.commands.insertContent('x'.repeat(1_200_000));
    lockedRefusalThenRelease(session, 41);

    // Cutting the note down by hand is the other way back, and it needs a live editor rather than a
    // command: the person types.
    session.runtime.editor.commands.selectAll();
    session.runtime.editor.commands.insertContent('trimmed');
    assert.equal(session.runtime.editor.getText(), 'trimmed');

    session.drain();
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 42 });
    assert.equal(session.of('snapshot')[0].document.content[0].content[0].text, 'trimmed');
  });
});

describe('commands and their availability', () => {
  /**
   * Selection travels on transactions, so reading it means producing one. An empty transaction
   * changes no document and is exactly what a caret move would look like.
   */
  const selectionAfter = (session) => {
    const editor = session.runtime.editor;
    editor.view.dispatch(editor.state.tr);
    session.advance(0);
    const messages = session.of('selection');
    return messages[messages.length - 1].state;
  };

  it('runs every command the toolbar can send', () => {
    const session = open({ document: doc(paragraph('text')) });
    const editor = session.runtime.editor;
    editor.commands.selectAll();

    const applied = [
      [{ kind: 'setHeading', level: 3 }, () => editor.isActive('heading', { level: 3 })],
      [{ kind: 'setParagraph' }, () => editor.isActive('paragraph')],
      [{ kind: 'toggleBulletList' }, () => editor.isActive('bulletList')],
      [{ kind: 'toggleOrderedList' }, () => editor.isActive('orderedList')],
      [{ kind: 'toggleBold' }, () => editor.isActive('bold')],
      [{ kind: 'toggleItalic' }, () => editor.isActive('italic')],
      [{ kind: 'toggleStrike' }, () => editor.isActive('strike')],
      [{ kind: 'setBlockquote' }, () => editor.isActive('blockquote')],
      [{ kind: 'toggleCodeBlock' }, () => editor.isActive('codeBlock')],
    ];

    for (const [command, active] of applied) {
      session.send({ type: 'command', sessionId: 1, command });
      assert.equal(active(), true, `${command.kind} did not take effect`);
    }
    session.close();
  });

  it('inserts a rule, and keeps a code block as source', () => {
    const session = open({ document: doc(paragraph('x')) });
    session.send({ type: 'command', sessionId: 1, command: { kind: 'insertHorizontalRule' } });
    assert.ok(
      session.runtime.editor.getJSON().content.some((node) => node.type === 'horizontalRule'),
    );

    session.drain();
    const mermaid = 'graph TD;\n  a-->b;';
    session.runtime.editor.commands.setContent(
      doc({
        type: 'codeBlock',
        attrs: { language: 'mermaid' },
        content: [{ type: 'text', text: mermaid }],
      }),
      { emitUpdate: false },
    );
    session.send({ type: 'requestSnapshot', sessionId: 1, requestId: 1 });
    const block = session.of('snapshot')[0].document.content[0];
    // Mermaid is an ordinary language-labelled code block. Nothing renders it.
    assert.equal(block.type, 'codeBlock');
    assert.equal(block.attrs.language, 'mermaid');
    assert.equal(block.content[0].text, mermaid);
    session.close();
  });

  it('reports undo as unavailable until there is something to undo, and exhausts honestly', () => {
    const session = open({ document: doc(paragraph('start')) });
    session.drain();
    assert.equal(selectionAfter(session).available.includes('undo'), false);

    type(session, ' more');
    assert.equal(selectionAfter(session).available.includes('undo'), true);

    session.send({ type: 'command', sessionId: 1, command: { kind: 'undo' } });
    assert.equal(session.runtime.editor.getText(), 'start');
    assert.equal(selectionAfter(session).available.includes('redo'), true);

    session.send({ type: 'command', sessionId: 1, command: { kind: 'undo' } });
    // Undo being exhausted is a state the surface can see and state, not one it discovers by failing.
    assert.equal(selectionAfter(session).available.includes('undo'), false);
    session.close();
  });

  it('reports nesting as unavailable outside a list, and available inside one', () => {
    const session = open({ document: doc(paragraph('one')) });
    session.drain();
    assert.equal(selectionAfter(session).available.includes('nest'), false);

    session.send({ type: 'command', sessionId: 1, command: { kind: 'toggleBulletList' } });
    // A second item, so there is a previous sibling for the first one to nest under.
    session.runtime.editor.commands.splitListItem('listItem');
    session.runtime.editor.commands.insertContent('two');
    const state = selectionAfter(session);
    assert.equal(state.active.includes('bulletList'), true);
    assert.equal(state.available.includes('nest'), true);
    session.close();
  });

  it('refuses every command in a read-only session, and refuses to be unlocked', () => {
    const session = open({ editable: false, document: doc(paragraph('saved')) });
    session.drain();
    const before = session.runtime.editor.getJSON();

    session.send({ type: 'command', sessionId: 1, command: { kind: 'toggleBold' } });
    assert.equal(session.of('rejected')[0].code, 'locked');

    session.send({ type: 'setEditable', sessionId: 1, editable: true });
    assert.equal(session.of('rejected')[1].code, 'unsupported_message');
    assert.equal(session.runtime.editor.isEditable, false);
    assert.deepEqual(session.runtime.editor.getJSON(), before);

    session.advance(DEBOUNCE * 2);
    assert.equal(session.of('snapshot').length, 0);
    session.close();
  });
});

describe('links', () => {
  it('reports a tap instead of navigating, and never follows the href itself', () => {
    const session = open({
      document: doc({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'go',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }],
          },
        ],
      }),
    });
    session.drain();

    const anchor = session.element.querySelector('a');
    assert.ok(anchor, 'the link should render as an anchor');
    const event = new dom.window.Event('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);

    assert.deepEqual(session.of('link')[0], {
      type: 'link',
      sessionId: 1,
      href: 'https://example.com/a',
    });
    assert.equal(event.defaultPrevented, true);
    session.close();
  });
});

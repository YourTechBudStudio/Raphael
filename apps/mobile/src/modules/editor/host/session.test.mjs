/**
 * The host's sequencing rules, driven as production code rather than as a model of it.
 *
 * These are the races the capability has to survive, and every one of them is a way someone's
 * writing could quietly disappear: a retired session answering for the current one, an out-of-order
 * message overwriting newer work, a Save waiting out its timeout because nothing changed, a renderer
 * dying with the only copy of a document native never received.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSession, reduce } from './session.ts';

const STAMP = { bridgeVersion: 1, contentSchemaVersion: 1, payloadDigest: 'sha256-abc' };

const doc = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const start = (over = {}) =>
  createSession({
    stamp: STAMP,
    documentId: 'd1',
    document: doc('start'),
    editable: true,
    ...over,
  });

const raw = (message) => ({ type: 'message', raw: JSON.stringify(message) });

const drive = (state, events) => {
  const effects = [];
  for (const event of events) {
    const reduction = reduce(state, event);
    state = reduction.state;
    effects.push(...reduction.effects);
  }
  return { state, effects };
};

const ready = (over = {}) => raw({ type: 'ready', ...STAMP, ...over });

/** Through the handshake and into an initialized session. */
const initialized = (over = {}) =>
  drive(start(over), [ready(), raw({ type: 'initialized', sessionId: 1 })]);

const only = (effects, kind) => effects.filter((effect) => effect.kind === kind);

describe('the handshake', () => {
  it('sends the document only when the whole stamp matches', () => {
    const { state, effects } = drive(start(), [ready()]);
    assert.equal(state.phase, 'handshaking');
    const sent = only(effects, 'send');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.type, 'init');
    assert.deepEqual(sent[0].message.document, doc('start'));
    assert.equal(sent[0].message.editable, true);
  });

  for (const [label, over] of [
    ['a bridge version', { bridgeVersion: 2 }],
    ['a content schema version', { contentSchemaVersion: 2 }],
    // A version-only handshake would pass an independently stale bundle. The digest is what stops it.
    ['a payload digest', { payloadDigest: 'sha256-stale' }],
  ]) {
    it(`refuses to start when ${label} differs, and sends nothing`, () => {
      const { state, effects } = drive(start(), [ready(over)]);
      assert.equal(state.phase, 'incompatible');
      assert.equal(only(effects, 'send').length, 0);
      // The draft is untouched: nothing was handed to a bundle that may not understand it.
      assert.equal(state.latestAccepted, null);
      assert.equal(only(effects, 'problem')[0].problem.stage, 'handshake');
    });
  }

  it('does not author a change by initializing', () => {
    const { effects } = initialized();
    assert.equal(only(effects, 'snapshot').length, 0);
  });
});

describe('snapshot ordering', () => {
  it('drops a snapshot from a retired session without a word', () => {
    const { state } = initialized();
    const after = reduce(
      state,
      raw({
        type: 'snapshot',
        sessionId: 99,
        editSeq: 5,
        document: doc('other'),
        reason: 'edit',
      }),
    );
    assert.deepEqual(after.effects, []);
    assert.equal(after.state.latestAccepted, null);
  });

  it('drops an out-of-order edit sequence rather than overwriting newer work', () => {
    const live = initialized().state;
    const { state } = drive(live, [
      raw({ type: 'snapshot', sessionId: 1, editSeq: 4, document: doc('newer'), reason: 'edit' }),
    ]);
    assert.equal(state.lastAcceptedSeq, 4);

    const late = reduce(
      state,
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 2,
        document: doc('older'),
        reason: 'edit',
      }),
    );
    assert.deepEqual(late.effects, []);
    assert.deepEqual(late.state.latestAccepted.document, doc('newer'));
  });

  it('drops a duplicate edit message at the same sequence', () => {
    const live = drive(initialized().state, [
      raw({ type: 'snapshot', sessionId: 1, editSeq: 1, document: doc('a'), reason: 'edit' }),
    ]);
    const duplicate = reduce(
      live.state,
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 1,
        document: doc('a'),
        reason: 'edit',
      }),
    );
    assert.deepEqual(duplicate.effects, []);
  });

  it('refuses a structurally unsupported document and leaves the draft alone', () => {
    const live = initialized().state;
    const { state, effects } = drive(live, [
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 1,
        document: { type: 'doc', content: [{ type: 'image' }] },
        reason: 'edit',
      }),
    ]);
    assert.equal(state.latestAccepted, null);
    const problem = only(effects, 'problem')[0].problem;
    assert.equal(problem.stage, 'document');
    assert.equal(problem.failure.reason, 'unsupported_node');
    // The refusal names our own vocabulary only, and carries no submitted content.
    assert.equal(JSON.stringify(problem).includes('image'), false);
  });
});

describe('the snapshot barrier', () => {
  const openBarrier = (state, lock = true) => drive(state, [{ type: 'barrierRequested', lock }]);

  it('locks before it asks, and says so', () => {
    const { state, effects } = openBarrier(initialized().state);
    assert.deepEqual(
      only(effects, 'locked').map((e) => e.locked),
      [true],
    );
    assert.deepEqual(
      only(effects, 'send').map((e) => e.message.type),
      ['setEditable', 'requestSnapshot'],
    );
    assert.equal(state.locked, true);
    assert.equal(only(effects, 'barrierOpened')[0].requestId, 1);
  });

  it('settles a requested answer that reports no change, without calling it an authored change', () => {
    const edited = drive(initialized().state, [
      raw({ type: 'snapshot', sessionId: 1, editSeq: 3, document: doc('a'), reason: 'edit' }),
    ]);
    const opened = openBarrier(edited.state);
    const { effects } = drive(opened.state, [
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 3,
        document: doc('a'),
        reason: 'requested',
        requestId: 1,
      }),
    ]);
    const settled = only(effects, 'settle')[0];
    assert.equal(settled.result.kind, 'captured');
    assert.equal(settled.result.unchanged, true);
    // One route to the owner per snapshot: a barrier's answer is its result, never also a callback.
    assert.equal(only(effects, 'snapshot').length, 0);
  });

  it('reports a newer requested answer as changed', () => {
    const opened = openBarrier(initialized().state);
    const { effects } = drive(opened.state, [
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 1,
        document: doc('typed'),
        reason: 'requested',
        requestId: 1,
      }),
    ]);
    assert.equal(only(effects, 'settle')[0].result.unchanged, false);
  });

  it('settles on a correlated refusal instead of waiting out the timeout', () => {
    const opened = openBarrier(initialized().state);
    const { state, effects } = drive(opened.state, [
      raw({ type: 'rejected', sessionId: 1, code: 'invalid_document', requestId: 1 }),
    ]);
    assert.deepEqual(only(effects, 'settle')[0].result, {
      kind: 'refused',
      code: 'invalid_document',
    });
    // The live document exists only in the renderer: nothing here claims to have preserved it.
    assert.equal(state.rendererOnlyWriting, true);
    assert.equal(state.latestAccepted, null);
  });

  it('settles a locking barrier on a composing refusal that arrives without a correlation', () => {
    const opened = openBarrier(initialized().state);
    const { state, effects } = drive(opened.state, [
      raw({ type: 'rejected', sessionId: 1, code: 'composing' }),
    ]);
    assert.deepEqual(only(effects, 'settle')[0].result, { kind: 'refused', code: 'composing' });
    // Continuous typing ends in an honest refusal with the editor still live and editable.
    assert.equal(state.locked, false);
    assert.deepEqual(
      only(effects, 'locked').map((e) => e.locked),
      [false],
    );
  });

  it('answers a correlated document refusal for a snapshot native itself cannot accept', () => {
    const opened = openBarrier(initialized().state);
    const { effects } = drive(opened.state, [
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 1,
        document: { type: 'doc', content: [{ type: 'image' }] },
        reason: 'requested',
        requestId: 1,
      }),
    ]);
    assert.deepEqual(only(effects, 'settle')[0].result, {
      kind: 'refused',
      code: 'invalid_document',
    });
  });

  it('ends on its own timeout, and a late reply then satisfies nothing', () => {
    const opened = openBarrier(initialized().state);
    const timedOut = drive(opened.state, [{ type: 'barrierTimedOut', requestId: 1 }]);
    assert.deepEqual(only(timedOut.effects, 'settle')[0].result, { kind: 'unanswered' });
    assert.equal(timedOut.state.barrier, null);

    const late = drive(timedOut.state, [
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 1,
        document: doc('late'),
        reason: 'requested',
        requestId: 1,
      }),
    ]);
    assert.equal(only(late.effects, 'settle').length, 0);
    // It was genuinely newer work, so it is kept - as an authored change, not as that barrier's answer.
    assert.equal(only(late.effects, 'snapshot').length, 1);
  });

  it('admits one barrier at a time', () => {
    const opened = openBarrier(initialized().state);
    const second = drive(opened.state, [{ type: 'barrierRequested', lock: true }]);
    assert.deepEqual(only(second.effects, 'barrierRefused')[0].result, {
      kind: 'refused',
      code: 'unsupported_message',
    });
    assert.equal(only(second.effects, 'send').length, 0);
    assert.equal(second.state.barrier.requestId, 1);
  });

  it('answers unanswered when there is no editor to ask', () => {
    const { effects } = drive(start(), [{ type: 'barrierRequested', lock: true }]);
    assert.deepEqual(only(effects, 'barrierRefused')[0].result, { kind: 'unanswered' });
    assert.equal(only(effects, 'send').length, 0);
  });

  it('settles a pending barrier when the route cancels it', () => {
    const opened = openBarrier(initialized().state);
    const { effects } = drive(opened.state, [{ type: 'barrierCancelled' }]);
    assert.deepEqual(only(effects, 'settle')[0].result, { kind: 'unanswered' });
  });
});

describe('what a lock-taking barrier does with the lock', () => {
  const lockAndOpen = (state) => drive(state, [{ type: 'barrierRequested', lock: true }]);

  /** Both halves come back: the host sends again, and the renderer accepts input again. */
  const releasedIn = (effects) => ({
    host: only(effects, 'locked').map((effect) => effect.locked),
    renderer: only(effects, 'send')
      .filter((effect) => effect.message.type === 'setEditable')
      .map((effect) => effect.message.editable),
  });

  it('keeps it when the barrier captured a snapshot', () => {
    const opened = lockAndOpen(initialized().state);
    const { state, effects } = drive(opened.state, [
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 1,
        document: doc('saved'),
        reason: 'requested',
        requestId: 1,
      }),
    ]);
    // Lock-then-flush is a closed interval, and Save holds it across the request that follows.
    assert.equal(state.locked, true);
    assert.deepEqual(releasedIn(effects), { host: [], renderer: [] });
  });

  it('gives it back when the barrier times out', () => {
    const opened = lockAndOpen(initialized().state);
    const { state, effects } = drive(opened.state, [{ type: 'barrierTimedOut', requestId: 1 }]);

    assert.equal(state.locked, false);
    assert.deepEqual(releasedIn(effects), { host: [false], renderer: [true] });
  });

  for (const code of ['invalid_document', 'too_large', 'composing', 'unsupported_message']) {
    it(`gives it back when the editor answers ${code}`, () => {
      const opened = lockAndOpen(initialized().state);
      const { state, effects } = drive(opened.state, [
        raw({ type: 'rejected', sessionId: 1, code, requestId: 1 }),
      ]);

      // A document past the node limit exists only in the renderer, and undo or cutting it down are
      // the ways back. Both need an editable editor and an enabled toolbar.
      assert.equal(state.locked, false);
      assert.deepEqual(releasedIn(effects), { host: [false], renderer: [true] });
    });
  }

  it('gives it back when native itself refuses the document', () => {
    const opened = lockAndOpen(initialized().state);
    const { state, effects } = drive(opened.state, [
      raw({
        type: 'snapshot',
        sessionId: 1,
        editSeq: 1,
        document: { type: 'doc', content: [{ type: 'image' }] },
        reason: 'requested',
        requestId: 1,
      }),
    ]);
    assert.equal(state.locked, false);
    assert.deepEqual(releasedIn(effects), { host: [false], renderer: [true] });
  });

  it('gives it back when the route cancels the navigation', () => {
    const opened = lockAndOpen(initialized().state);
    const { state, effects } = drive(opened.state, [{ type: 'barrierCancelled' }]);
    assert.equal(state.locked, false);
    assert.deepEqual(releasedIn(effects), { host: [false], renderer: [true] });
  });

  it('can send a command again once it has been given back', () => {
    const opened = lockAndOpen(initialized().state);
    const failed = drive(opened.state, [{ type: 'barrierTimedOut', requestId: 1 }]);
    const { effects } = drive(failed.state, [
      { type: 'commandRequested', command: { kind: 'undo' } },
    ]);
    // The repair path the refusal leaves open is undo, so undo has to be sendable.
    assert.deepEqual(only(effects, 'send')[0].message.command, { kind: 'undo' });
    assert.equal(only(effects, 'problem').length, 0);
  });

  it('does not give away a lock it never took', () => {
    const held = drive(initialized().state, [{ type: 'editableRequested', editable: false }]);
    const opened = drive(held.state, [{ type: 'barrierRequested', lock: true }]);
    const { state, effects } = drive(opened.state, [{ type: 'barrierTimedOut', requestId: 1 }]);

    // The caller locked for its own reasons; ending this barrier is not permission to undo that.
    assert.equal(state.locked, true);
    assert.deepEqual(releasedIn(effects), { host: [], renderer: [] });
  });

  it('releases nothing for a barrier that never asked to lock', () => {
    const opened = drive(initialized().state, [{ type: 'barrierRequested', lock: false }]);
    const { state, effects } = drive(opened.state, [{ type: 'barrierTimedOut', requestId: 1 }]);
    assert.equal(state.locked, false);
    assert.deepEqual(releasedIn(effects), { host: [], renderer: [] });
  });

  it('does not tell a read-only host to become editable', () => {
    const readOnly = drive(start({ editable: false }), [
      ready(),
      raw({ type: 'initialized', sessionId: 1 }),
    ]);
    const opened = drive(readOnly.state, [{ type: 'barrierRequested', lock: true }]);
    const { effects } = drive(opened.state, [{ type: 'barrierTimedOut', requestId: 1 }]);
    // There was no lock to take, so there is nothing to give back - and `setEditable: true` is the
    // one thing a permanently read-only session must never be asked for.
    assert.deepEqual(releasedIn(effects), { host: [], renderer: [] });
  });

  it('does not address a renderer that has already died', () => {
    const opened = lockAndOpen(initialized().state);
    const { effects } = drive(opened.state, [{ type: 'rendererTerminated' }]);
    assert.deepEqual(
      only(effects, 'send').filter((effect) => effect.message.type === 'setEditable'),
      [],
    );
    // The host still drops its own half, so the replacement does not come up with a stale lock.
    assert.deepEqual(
      only(effects, 'locked').map((effect) => effect.locked),
      [false],
    );
  });
});

describe('the lock, from the host side', () => {
  it('refuses to send a command while locked', () => {
    const opened = drive(initialized().state, [{ type: 'barrierRequested', lock: true }]);
    const { effects } = drive(opened.state, [
      { type: 'commandRequested', command: { kind: 'toggleBold' } },
    ]);
    assert.equal(only(effects, 'send').length, 0);
    assert.equal(only(effects, 'problem')[0].problem.code, 'locked');
  });

  it('sends a command when it is not locked', () => {
    const { effects } = drive(initialized().state, [
      { type: 'commandRequested', command: { kind: 'setHeading', level: 2 } },
    ]);
    assert.deepEqual(only(effects, 'send')[0].message.command, { kind: 'setHeading', level: 2 });
  });

  it('never lets an ordinary unlock make a read-only host editable', () => {
    const readOnly = drive(start({ editable: false }), [
      ready(),
      raw({ type: 'initialized', sessionId: 1 }),
    ]);
    const { state, effects } = drive(readOnly.state, [
      { type: 'editableRequested', editable: true },
    ]);
    assert.equal(only(effects, 'send').length, 0);
    assert.equal(only(effects, 'problem')[0].problem.code, 'unsupported_message');
    assert.equal(state.editable, false);
  });

  it('asks a read-only host for a snapshot without pretending to lock it', () => {
    const readOnly = drive(start({ editable: false }), [
      ready(),
      raw({ type: 'initialized', sessionId: 1 }),
    ]);
    const { effects } = drive(readOnly.state, [{ type: 'barrierRequested', lock: true }]);
    assert.deepEqual(
      only(effects, 'send').map((e) => e.message.type),
      ['requestSnapshot'],
    );
    assert.equal(only(effects, 'locked').length, 0);
  });

  it('releases the lock on request', () => {
    const opened = drive(initialized().state, [{ type: 'barrierRequested', lock: true }]);
    const { state, effects } = drive(opened.state, [{ type: 'editableRequested', editable: true }]);
    assert.equal(state.locked, false);
    assert.deepEqual(only(effects, 'send')[0].message, {
      type: 'setEditable',
      sessionId: 1,
      editable: true,
    });
  });
});

describe('recovery', () => {
  it('restarts from the newest work it holds, not from what it was given', () => {
    const live = drive(initialized().state, [
      raw({ type: 'snapshot', sessionId: 1, editSeq: 2, document: doc('newest'), reason: 'edit' }),
    ]);
    const crashed = drive(live.state, [{ type: 'rendererTerminated' }]);
    assert.equal(crashed.state.sessionId, 2);
    assert.equal(crashed.state.lastAcceptedSeq, 0);
    assert.deepEqual(crashed.state.pendingDocument, doc('newest'));

    const restarted = drive(crashed.state, [ready()]);
    const init = only(restarted.effects, 'send')[0].message;
    assert.equal(init.sessionId, 2);
    assert.deepEqual(init.document, doc('newest'));
  });

  it('does not claim to have preserved bytes it never received', () => {
    const refused = drive(initialized().state, [
      raw({ type: 'rejected', sessionId: 1, code: 'invalid_document' }),
    ]);
    const crashed = drive(refused.state, [{ type: 'rendererTerminated' }]);
    const recovery = only(crashed.effects, 'problem').find((e) => e.problem.stage === 'recovery');
    assert.equal(recovery.problem.lostRendererWriting, true);
  });

  it('carries the owner-supplied unprotected status through a restart unchanged', () => {
    const marked = drive(initialized().state, [
      { type: 'unprotectedChanged', unprotected: true },
      { type: 'rendererTerminated' },
    ]);
    assert.equal(marked.state.unprotected, true);
  });

  it('treats an unasked-for ready as the restart it is', () => {
    const live = drive(initialized().state, [
      raw({ type: 'snapshot', sessionId: 1, editSeq: 1, document: doc('held'), reason: 'edit' }),
    ]);
    const { state, effects } = drive(live.state, [ready()]);
    assert.equal(state.sessionId, 2);
    const init = only(effects, 'send')[0].message;
    assert.equal(init.sessionId, 2);
    assert.deepEqual(init.document, doc('held'));
  });

  it('settles a barrier that the renderer died holding', () => {
    const opened = drive(initialized().state, [{ type: 'barrierRequested', lock: true }]);
    const { effects } = drive(opened.state, [{ type: 'rendererTerminated' }]);
    assert.deepEqual(only(effects, 'settle')[0].result, { kind: 'unanswered' });
  });
});

describe('document identity', () => {
  it('ignores a rerender that supplies the same document identity', () => {
    const live = drive(initialized().state, [
      raw({ type: 'snapshot', sessionId: 1, editSeq: 2, document: doc('typed'), reason: 'edit' }),
    ]);
    const again = reduce(live.state, {
      type: 'documentReplaced',
      documentId: 'd1',
      document: doc('start'),
    });
    assert.deepEqual(again.effects, []);
    assert.deepEqual(again.state.latestAccepted.document, doc('typed'));
  });

  it('mints a new identity for a genuine replacement and forgets the old sequence', () => {
    const live = drive(initialized().state, [
      raw({ type: 'snapshot', sessionId: 1, editSeq: 7, document: doc('first'), reason: 'edit' }),
    ]);
    const { state, effects } = drive(live.state, [
      { type: 'documentReplaced', documentId: 'd2', document: doc('second') },
    ]);
    assert.equal(state.sessionId, 2);
    assert.equal(state.lastAcceptedSeq, 0);
    assert.equal(state.latestAccepted, null);
    const init = only(effects, 'send')[0].message;
    assert.equal(init.sessionId, 2);
    assert.deepEqual(init.document, doc('second'));
  });
});

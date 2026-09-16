/**
 * The wiring, driven as the thing capture will actually hold.
 *
 * The reducer decides what should happen; this is what turns those decisions into an injected
 * script, a promise that resolves once, and a timer that is cleared. Every case below is a way work
 * could be lost or a caller could wait forever: a barrier that never settles, one that settles
 * twice, a timer outliving the route that started it, a link reaching the app unchecked.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EDITOR_ACTIONS } from '../bridge.ts';
import { createEditorController } from './controller.ts';

const STAMP = { bridgeVersion: 1, contentSchemaVersion: 1, payloadDigest: 'sha256-abc' };
const TIMEOUT = 1500;

const doc = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** The clock the host would otherwise take from the platform. */
const scheduler = () => {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    setTimer: (run, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, run });
      return next;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
    pending: () => timers.size,
  };
};

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

const host = ({ editable = true, document = doc('start') } = {}) => {
  const clock = scheduler();
  const injected = [];
  const restarts = [];
  const events = { snapshot: [], selection: [], locked: [], problem: [], link: [] };

  const controller = createEditorController(
    { stamp: STAMP, documentId: 'd1', document, editable, snapshotTimeoutMs: TIMEOUT },
    {
      inject: (script) => injected.push(delivered(script)),
      restartRenderer: (sessionId) => restarts.push(sessionId),
      callbacks: () => ({
        onSnapshot: (value) => events.snapshot.push(value),
        onSelectionChange: (value) => events.selection.push(value),
        onLockedChange: (value) => events.locked.push(value),
        onProblem: (value) => events.problem.push(value),
        onLinkPress: (value) => events.link.push(value),
      }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );

  const from = (message) => controller.receive(JSON.stringify(message));

  return {
    controller,
    injected,
    restarts,
    events,
    from,
    clock,
    /** Through the handshake into a live session, with the handshake traffic dropped. */
    live: () => {
      from({ type: 'ready', ...STAMP });
      from({ type: 'initialized', sessionId: 1 });
      injected.length = 0;
      return controller;
    },
  };
};

describe('the script channel', () => {
  it('injects the initialization the handshake asks for, as data', () => {
    const app = host({ document: doc('hello') });
    app.from({ type: 'ready', ...STAMP });

    assert.equal(app.injected.length, 1);
    assert.deepEqual(app.injected[0], {
      type: 'init',
      sessionId: 1,
      document: doc('hello'),
      editable: true,
    });
  });

  it('injects nothing when the bundle does not match', () => {
    const app = host();
    app.from({ type: 'ready', ...STAMP, payloadDigest: 'sha256-stale' });
    assert.deepEqual(app.injected, []);
    assert.equal(app.events.problem[0].stage, 'handshake');
  });

  it('refuses to inject a message that would not fit the envelope', () => {
    const app = host({ document: doc('x'.repeat(2_000_000)) });
    app.from({ type: 'ready', ...STAMP });
    assert.deepEqual(app.injected, []);
    assert.deepEqual(app.events.problem[0], {
      stage: 'envelope',
      refusal: 'too_large',
      sessionId: 1,
    });
  });

  it('carries every command through as one injected message', () => {
    const app = host();
    app.live();
    for (const action of EDITOR_ACTIONS) {
      app.controller.send({ kind: 'toggleBold' });
      void action;
    }
    assert.equal(app.injected.length, EDITOR_ACTIONS.length);
    assert.equal(app.injected[0].type, 'command');
  });
});

describe('a barrier as its caller experiences it', () => {
  it('resolves the actual returned promise, exactly once', async () => {
    const app = host();
    app.live();

    let settled = 0;
    const barrier = app.controller.requestSnapshot({ lock: true }).then((result) => {
      settled += 1;
      return result;
    });

    const request = app.injected.find((message) => message.type === 'requestSnapshot');
    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 1,
      document: doc('typed'),
      reason: 'requested',
      requestId: request.requestId,
    });

    const result = await barrier;
    assert.equal(result.kind, 'captured');
    assert.equal(result.unchanged, false);
    assert.deepEqual(result.snapshot.document, doc('typed'));

    // A repeat of the same answer must not resolve anything a second time, and must not reach the
    // owner as a separate authored change.
    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 1,
      document: doc('typed'),
      reason: 'requested',
      requestId: request.requestId,
    });
    await Promise.resolve();
    assert.equal(settled, 1);
    assert.deepEqual(app.events.snapshot, []);
  });

  it('ends on the host timeout and clears its own timer', async () => {
    const app = host();
    app.live();
    const barrier = app.controller.requestSnapshot({ lock: true });

    assert.equal(app.clock.pending(), 1);
    app.clock.advance(TIMEOUT);
    assert.deepEqual(await barrier, { kind: 'unanswered' });
    assert.equal(app.clock.pending(), 0);
  });

  it('clears the timer when an answer arrives first', async () => {
    const app = host();
    app.live();
    const barrier = app.controller.requestSnapshot();
    const request = app.injected.find((message) => message.type === 'requestSnapshot');

    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 1,
      document: doc('a'),
      reason: 'requested',
      requestId: request.requestId,
    });
    await barrier;
    assert.equal(app.clock.pending(), 0);

    // And the timeout that would have fired cannot re-settle anything.
    app.clock.advance(TIMEOUT * 2);
    assert.equal(app.events.problem.length, 0);
  });

  it('resolves a barrier that could not be opened, rather than leaving the caller waiting', async () => {
    const app = host();
    assert.deepEqual(await app.controller.requestSnapshot({ lock: true }), { kind: 'unanswered' });

    app.live();
    const first = app.controller.requestSnapshot({ lock: true });
    const second = app.controller.requestSnapshot({ lock: true });
    assert.deepEqual(await second, { kind: 'refused', code: 'unsupported_message' });

    app.clock.advance(TIMEOUT);
    assert.deepEqual(await first, { kind: 'unanswered' });
  });

  it('reports the lock to the surface before it asks for anything', () => {
    const app = host();
    app.live();
    void app.controller.requestSnapshot({ lock: true });
    assert.deepEqual(app.events.locked, [true]);
    assert.deepEqual(
      app.injected.map((message) => message.type),
      ['setEditable', 'requestSnapshot'],
    );
  });
});

describe('the repair path after a lock-taking barrier fails', () => {
  /** What the caller can do next: is the toolbar back, and is the renderer accepting input again. */
  const afterFailure = (app) => ({
    hostUnlocked: app.events.locked.at(-1) === false,
    rendererUnlocked: app.injected.some(
      (message) => message.type === 'setEditable' && message.editable === true,
    ),
  });

  it('restores editing when the barrier times out', async () => {
    const app = host();
    app.live();
    const barrier = app.controller.requestSnapshot({ lock: true });

    app.clock.advance(TIMEOUT);
    assert.deepEqual(await barrier, { kind: 'unanswered' });
    assert.deepEqual(afterFailure(app), { hostUnlocked: true, rendererUnlocked: true });
  });

  for (const code of ['invalid_document', 'too_large', 'composing']) {
    it(`restores editing when the editor answers ${code}`, async () => {
      const app = host();
      app.live();
      const barrier = app.controller.requestSnapshot({ lock: true });
      const request = app.injected.find((message) => message.type === 'requestSnapshot');

      app.from({ type: 'rejected', sessionId: 1, code, requestId: request.requestId });

      assert.deepEqual(await barrier, { kind: 'refused', code });
      assert.deepEqual(afterFailure(app), { hostUnlocked: true, rendererUnlocked: true });
    });
  }

  it('lets undo through afterwards, which is the repair a refusal offers', async () => {
    const app = host();
    app.live();
    const barrier = app.controller.requestSnapshot({ lock: true });
    const request = app.injected.find((message) => message.type === 'requestSnapshot');
    app.from({
      type: 'rejected',
      sessionId: 1,
      code: 'invalid_document',
      requestId: request.requestId,
    });
    await barrier;

    app.injected.length = 0;
    app.controller.send({ kind: 'undo' });
    // A document past the node limit exists only in the renderer. Undo is how it comes back into
    // range, so a refusal that leaves undo unsendable has taken away the only way out.
    assert.deepEqual(
      app.injected.map((message) => message.command),
      [{ kind: 'undo' }],
    );
    assert.deepEqual(
      app.events.problem.filter((problem) => problem.code === 'locked'),
      [],
    );
  });

  it('keeps the lock when the barrier succeeded', async () => {
    const app = host();
    app.live();
    const barrier = app.controller.requestSnapshot({ lock: true });
    const request = app.injected.find((message) => message.type === 'requestSnapshot');

    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 1,
      document: doc('saved'),
      reason: 'requested',
      requestId: request.requestId,
    });
    assert.equal((await barrier).kind, 'captured');

    // Save holds the lock across the request that follows; releasing here would let a keystroke land
    // between the snapshot and the send.
    assert.deepEqual(afterFailure(app), { hostUnlocked: false, rendererUnlocked: false });
    app.controller.send({ kind: 'undo' });
    assert.equal(app.events.problem.at(-1).code, 'locked');
  });
});

describe('the end of a mount', () => {
  it('settles outstanding work and clears every timer', async () => {
    const app = host();
    app.live();
    const barrier = app.controller.requestSnapshot({ lock: true });

    app.controller.dispose();
    assert.deepEqual(await barrier, { kind: 'unanswered' });
    assert.equal(app.clock.pending(), 0);
  });

  it('stops driving the editor once disposed', async () => {
    const app = host();
    app.live();
    app.controller.dispose();

    app.controller.send({ kind: 'toggleBold' });
    app.from({ type: 'snapshot', sessionId: 1, editSeq: 9, document: doc('late'), reason: 'edit' });
    assert.deepEqual(app.injected, []);
    assert.deepEqual(app.events.snapshot, []);
    assert.deepEqual(await app.controller.requestSnapshot(), { kind: 'unanswered' });
  });
});

describe('a renderer that dies', () => {
  it('asks for a replacement under the new session, and reinitializes from the newest work held', () => {
    const app = host();
    app.live();
    app.from({
      type: 'snapshot',
      sessionId: 1,
      editSeq: 2,
      document: doc('newest'),
      reason: 'edit',
    });
    app.injected.length = 0;

    app.controller.rendererTerminated();
    assert.deepEqual(app.restarts, [2]);

    app.from({ type: 'ready', ...STAMP });
    assert.deepEqual(app.injected[0], {
      type: 'init',
      sessionId: 2,
      document: doc('newest'),
      editable: true,
    });
  });
});

describe('links', () => {
  it('passes a permitted href through to the consumer exactly as authored', () => {
    const app = host();
    app.live();
    const href = 'https://example.com/a?b=1&c=%20#frag';
    app.from({ type: 'link', sessionId: 1, href });
    assert.deepEqual(app.events.link, [href]);
  });

  for (const href of ['http://example.com/', 'mailto:someone@example.com']) {
    it(`permits ${href.split(':')[0]}`, () => {
      const app = host();
      app.live();
      app.from({ type: 'link', sessionId: 1, href });
      assert.deepEqual(app.events.link, [href]);
    });
  }

  for (const [label, href] of [
    ['javascript', 'javascript:alert(1)'],
    ['an obfuscated scheme', 'java\tscript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
    ['a local app scheme', 'raphael://settings'],
    ['a relative reference', '/area/1'],
    ['a protocol-relative reference', '//example.com/a'],
    ['embedded credentials', 'https://user:pass@example.com/'],
    ['a control character', 'https://example.com/ '],
    ['an excessive length', `https://example.com/${'a'.repeat(2_100)}`],
    ['an empty href', ''],
  ]) {
    it(`refuses ${label}, without repeating it back`, () => {
      const app = host();
      app.live();
      app.from({ type: 'link', sessionId: 1, href });

      assert.deepEqual(app.events.link, []);
      assert.deepEqual(app.events.problem[0], { stage: 'link', sessionId: 1 });
      // The refusal names a stage and a session and nothing else, so there is nothing to leak.
      assert.deepEqual(Object.keys(app.events.problem[0]).sort(), ['sessionId', 'stage']);
      if (href !== '') {
        assert.equal(JSON.stringify(app.events.problem).includes(href.slice(0, 12)), false);
      }
    });
  }

  it('ignores a link from a retired session, and one that arrives before a document is loaded', () => {
    const app = host();
    app.from({ type: 'ready', ...STAMP });
    // Handshaking: no document has been confirmed loaded yet.
    app.from({ type: 'link', sessionId: 1, href: 'https://example.com/' });
    assert.deepEqual(app.events.link, []);

    app.from({ type: 'initialized', sessionId: 1 });
    app.from({ type: 'link', sessionId: 99, href: 'https://example.com/' });
    assert.deepEqual(app.events.link, []);
    assert.deepEqual(app.events.problem, []);
  });
});

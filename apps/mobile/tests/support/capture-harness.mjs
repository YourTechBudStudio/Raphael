/**
 * A capture owner over the real store, with every race reachable.
 *
 * The store is genuine SQLite through the same port the app uses, because the properties under test
 * are about what is on disk when a process dies. What is faked is only the things a test cannot
 * otherwise reach: the clock, the monotonic mark, the timer the flush deadline runs on, the HTTP
 * call, and an editor that can be made to answer late, refuse, or not answer at all.
 *
 * Every store method can be made to fail or be held open, so "the acknowledgement write failed" and
 * "the answer arrived while a snapshot was still being written" are things that actually happen here
 * rather than things asserted about a fake.
 */

import assert from 'node:assert/strict';

import { createCaptureOwner } from '../../src/modules/capture/owner.ts';
import { openCaptureStore } from '../../src/modules/capture/store.ts';
import { openNodeDatabase } from './node-sqlite.mjs';

export const T0 = 1_700_000_000_000;
export const DESTINATION = { type: 'area', id: 3 };

export const documentWith = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

export const entity = (over = {}) => ({
  id: 42,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: 'a-note',
  revision: 1,
  title: 'A note',
  description: '',
  tags: [],
  active: false,
  body: { format: 'tiptap', value: documentWith('first') },
  metadata: {},
  ...over,
});

export const created = (over = {}) => ({ ok: true, value: { entity: entity(over) } });

export const failed = (mutationOutcome, code = null) => ({
  ok: false,
  failure: {
    kind: code === null ? 'transport_error' : 'api_error',
    ...(code === null ? {} : { error: { code } }),
    message: 'the server said no',
    mutationOutcome,
  },
});

/** Yield to the microtask queue so an owner's in-flight work can reach its next await. */
export const tick = async (times = 3) => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

/**
 * Wait for something the owner is doing in the background to become true.
 *
 * Counting microtasks would be counting `await`s in the implementation, which makes a test fail
 * when a line moves rather than when behaviour changes. This waits for the condition instead, and
 * fails loudly rather than hanging.
 */
export const until = async (condition, what) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  assert.fail(`timed out waiting for ${what}`);
};

/**
 * An editor that can be held, made to refuse, or made never to answer.
 *
 * `setEditable` is recorded rather than acted on: what matters is whether the owner gave the lock
 * back, and on which exits.
 */
export const fakeEditor = () => {
  const editable = [];
  const barriers = [];
  const state = { answer: null, hang: false, held: null, sessionId: 1, seq: 0 };

  return {
    state,
    editable,
    barriers,
    /** The next barrier answers with a captured snapshot carrying this document. */
    captures(document, over = {}) {
      state.answer = () => ({
        kind: 'captured',
        snapshot: {
          sessionId: over.sessionId ?? state.sessionId,
          editSeq: over.editSeq ?? (state.seq += 1),
          document,
        },
        unchanged: false,
      });
    },
    refuses(code = 'invalid_document') {
      state.answer = () => ({ kind: 'refused', code });
    },
    unanswered() {
      state.answer = () => ({ kind: 'unanswered' });
    },
    /** Never settles. The owner's own deadline is what has to end this. */
    hangs() {
      state.hang = true;
    },
    /** Answer barriers by hand, so two of them can be in flight at once. */
    holds() {
      state.held = [];
    },
    answerNext(result) {
      const next = state.held.shift();

      assert.ok(next !== undefined, 'no barrier is waiting to be answered');
      next(result);
    },
    port: {
      requestSnapshot: (options) => {
        barriers.push(options ?? {});
        if (state.hang) return new Promise(() => {});
        if (state.held !== null) {
          return new Promise((resolve) => {
            state.held.push(resolve);
          });
        }

        return Promise.resolve(state.answer?.() ?? { kind: 'unanswered' });
      },
      setEditable: (value) => {
        editable.push(value);
      },
      send: () => {},
    },
  };
};

/**
 * Wrap a real store so any one operation can throw or be held open.
 *
 * Holding is what makes "the answer arrived while the snapshot write was still running" reachable;
 * throwing is what makes "the server created it and only the local note failed" reachable. Neither
 * changes what the store does when it is allowed to run.
 */
const decorate = (store, faults, gates, log, rewrites) => {
  const wrapped = {};

  for (const name of Object.keys(store)) {
    wrapped[name] = async (...args) => {
      log.push(name);
      const gate = gates[name];
      if (gate !== undefined) await gate;
      const fault = faults[name];
      if (fault !== undefined) throw new Error(fault);

      const result = await store[name](...args);
      const rewrite = rewrites[name];

      return rewrite === undefined ? result : rewrite(result);
    };
  }

  return wrapped;
};

export const harness = async (options = {}) => {
  const faults = {};
  const gates = {};
  /**
   * Rewrite what a store call answers with, after it has really run.
   *
   * For the one situation that is otherwise unreachable: the bytes on disk are not the bytes that
   * were frozen, because a later build reads them differently. The write happened; what the owner
   * is handed back is what a narrowed contract would hand it.
   */
  const rewrites = {};
  const log = [];
  const responses = [];
  const applied = [];
  const timers = new Set();
  const ids = [];
  /** Outcomes to answer the next opens with, in place of actually opening a database. */
  const openOutcomes = [];
  const databases = [];
  let openGate = null;
  let activation = 1;
  let brokenIdentifiers = false;
  let identifiers = 0;
  let clock = options.now ?? T0;
  let monotonic = 0;
  let db = null;

  const owner = createCaptureOwner({
    openStore: async () => {
      log.push('openStore');
      if (openGate !== null) await openGate;

      const override = openOutcomes.shift();

      if (override !== undefined) {
        if (override === 'throw') throw new Error('the database could not be opened');

        return override;
      }

      db = await openNodeDatabase(options.file);
      databases.push(db);
      const outcome = await openCaptureStore(db, () => clock);

      if (outcome.kind !== 'ready') return outcome;

      return { kind: 'ready', store: decorate(outcome.store, faults, gates, log, rewrites) };
    },
    create: async (_transport, request) => {
      const next = responses.shift();

      assert.ok(next !== undefined, 'the test did not queue a response for this dispatch');

      return typeof next === 'function' ? next(request) : next;
    },
    now: () => clock,
    monotonic: () => monotonic,
    newId: () => {
      if (brokenIdentifiers) throw new Error('no generator');
      identifiers += 1;
      const id = `id-${String(identifiers)}`;
      ids.push(id);

      return id;
    },
    applyCreation: async (response, madeUnder) => {
      applied.push({ id: response.entity.id, activation: madeUnder });
      if (options.applyCreationThrows === true) throw new Error('cache refresh failed');
    },
    // What the composition will answer with: the activation the app is working under right now.
    sessionIsCurrent: (session) => session.activation === activation,
    flushTimeoutMs: 1500,
    setTimer: (run, ms) => {
      const handle = { run, ms };
      timers.add(handle);

      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
  });

  if (options.open !== false) {
    await owner.getState().initialize();
    assert.equal(owner.getState().status, 'ready', JSON.stringify(owner.getState().problem));
  }

  return {
    owner,
    faults,
    gates,
    rewrites,
    log,
    ids,
    applied,
    /** Make every later identifier request fail, as a platform without a usable generator would. */
    breakIdentifiers: () => {
      brokenIdentifiers = true;
    },
    /** Move the app on to a new activation, as a rotation or a server switch does. */
    retireActivation: () => {
      activation += 1;
    },
    session: (over = {}) => ({
      activation,
      connectionId: 'c1',
      endpoint: 'https://raphael.example',
      transport: {},
      usable: true,
      ...over,
    }),
    respond: (...values) => {
      responses.push(...values);
    },
    advance: (ms) => {
      clock += ms;
      monotonic += ms;
    },
    setClock: (value) => {
      clock = value;
    },
    fireTimers: () => {
      for (const handle of [...timers]) {
        timers.delete(handle);
        handle.run();
      }
    },
    /** Answer the next open with this instead of touching a database. `'throw'` makes it throw. */
    answerNextOpen: (...outcomes) => {
      openOutcomes.push(...outcomes);
    },
    /** Hold every open until the returned function is called, so a close can race one. */
    holdOpens: () => {
      let release;
      openGate = new Promise((resolve) => {
        release = resolve;
      });

      return () => {
        openGate = null;
        release();
      };
    },
    /** How many times a store this harness opened has been closed. */
    storeCloses: () => log.filter((entry) => entry === 'close').length,
    close: async () => {
      // Whatever the owner did or did not close, the test's own handles go here. Closing twice is
      // harmless; leaving one open would leak a file handle into the next test.
      for (const handle of databases) {
        try {
          await handle.close();
        } catch {
          // Already closed by the owner, which is the ordinary case.
        }
      }
    },
  };
};

/** A draft that exists, with a destination chosen, ready to be saved. */
export const readyDraft = async (kit, editor) => {
  const outcome = await kit.owner.getState().createDraft(kit.session());

  assert.equal(outcome.kind, 'created', outcome.kind === 'refused' ? outcome.problem : '');

  const { draftId } = outcome;
  const selected = await kit.owner
    .getState()
    .selectDestination(draftId, DESTINATION, kit.session());

  assert.equal(selected.kind, 'done');

  const token =
    editor === undefined ? null : kit.owner.getState().attachEditor(draftId, editor.port);

  return { draftId, token };
};

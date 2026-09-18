/**
 * The protection core, driven over a content type that is nothing in particular.
 *
 * The point of these cases is that none of them mentions a note, a draft, a destination, an attempt
 * or a server. What is pinned is the machinery itself: that a long payload being typed into cannot
 * accumulate a queue of writes, that the four flush outcomes stay four distinguishable sentences,
 * that a caller holding a barrier is always released even when the core closes underneath it, that
 * "saved on this phone" is claimed only up to a version the store confirmed, and that the version
 * and the bytes behind that claim always come from the same write.
 *
 * The content is `{ letter, document }`, which exists so that a field change and a document change
 * can be told apart. The clock, the flush deadline's timer, the store and the editor are all
 * substituted, because every race worth having a test for lives in exactly those four.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProtection } from '../src/modules/capture/protection.ts';
import { fakeEditor } from './support/capture-harness.mjs';

const documentWith = (text) => ({ type: 'doc', content: [{ type: 'text', text }] });

const deferred = () => {
  let settle;
  let fail;
  const promise = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  return { promise, settle, fail };
};

/**
 * A core over a fake content type, with every port observable.
 *
 * `writes.hold()` makes the store stop answering, which is the only way to have a write genuinely in
 * progress while further changes arrive - the situation coalescing exists for.
 */
const kit = (over = {}) => {
  const timers = [];
  const published = new Map();
  /** Every publish in order, so a test can assert that one did *not* happen. */
  const log = [];
  // `answer` is what the store reports as committed: undefined means the ordinary "it advanced to
  // this version", and null is a coalesced write that lost its race and moved nothing.
  const writes = { calls: [], held: null, fail: false, answer: undefined };
  const core = createProtection({
    now: () => 1_000,
    setTimer: (run) => {
      const handle = { run, cleared: false };
      timers.push(handle);

      return handle;
    },
    clearTimer: (handle) => {
      if (handle !== null) handle.cleared = true;
    },
    flushTimeoutMs: 50,
    documentOf: (content) => content.document,
    withDocument: (content, document) => ({ ...content, document }),
    writeVersion: async (id, content, version, at) => {
      writes.calls.push({ id, content, version, at });

      if (writes.held !== null) {
        const pending = deferred();
        writes.held.push(pending);
        await pending.promise;
      }
      if (writes.fail) throw new Error('the store said no');

      return writes.answer === undefined ? version : writes.answer;
    },
    publish: (id, protection) => {
      log.push({ id, protection });
      if (protection === null) published.delete(id);
      else published.set(id, protection);
    },
    ...over,
  });

  return {
    core,
    timers,
    published,
    log,
    writes,
    hold: () => {
      writes.held = [];
    },
    /** Let the write that is waiting finish. */
    release: async () => {
      const next = writes.held.shift();

      assert.ok(next !== undefined, 'no write is waiting');
      next.settle();
      await Promise.resolve();
      await Promise.resolve();
    },
    settle: async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    },
  };
};

const tracked = (k, letter = 'a', version = 1) => {
  k.core.track('x', { letter, document: documentWith(letter) }, version);
};

describe('the coalescing writer', () => {
  it('keeps one write in progress and at most one behind it, and the latest change wins', async () => {
    const k = kit();

    tracked(k);
    k.hold();

    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.settle();

    // One write is in progress. Everything that arrives while it runs replaces the pending slot
    // rather than queueing behind it, so a long payload cannot accumulate a queue of full copies.
    assert.equal(k.writes.calls.length, 1);
    k.core.edit('x', (content) => ({ ...content, letter: 'c' }));
    k.core.edit('x', (content) => ({ ...content, letter: 'd' }));
    assert.equal(k.published.get('x').pending, true);
    assert.equal(k.published.get('x').writing, true);

    await k.release();
    await k.settle();

    assert.equal(k.writes.calls.length, 2);
    assert.equal(k.writes.calls[1].version, 4);
    assert.equal(k.writes.calls[1].content.letter, 'd');

    await k.release();
    await k.settle();

    assert.equal(k.writes.calls.length, 2);
    assert.deepEqual(k.published.get('x'), {
      committedVersion: 4,
      latestAcceptedVersion: 4,
      pending: false,
      writing: false,
      failedWrite: false,
      rendererUnknown: false,
      locked: false,
      attached: false,
    });
  });

  it('writes nothing when nothing is owed', async () => {
    const k = kit();

    tracked(k);
    await k.core.drain('x');
    assert.equal(k.writes.calls.length, 0);
    assert.equal(
      k.core.edit('x', () => null),
      false,
    );
    await k.core.drain('x');
    assert.equal(k.writes.calls.length, 0);
  });

  it('reports a failed write as unprotected and keeps the newer work in memory', async () => {
    const k = kit();

    tracked(k);
    k.writes.fail = true;
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.core.drain('x');

    assert.equal(k.published.get('x').failedWrite, true);
    assert.equal(k.published.get('x').committedVersion, 1);
    assert.equal(k.core.content('x').letter, 'b');
    // The claim about the phone is unchanged: only a confirmed write moves it.
    assert.equal(k.core.committed('x').version, 1);
    assert.equal(k.core.committed('x').content.letter, 'a');
  });
});

describe('what may be sent', () => {
  it('pairs the committed version with the bytes of that same write', async () => {
    const k = kit();

    tracked(k);
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.core.drain('x');

    assert.deepEqual(k.core.committed('x'), {
      version: 2,
      content: { letter: 'b', document: documentWith('a') },
    });

    // Typing continues. The latest content moves; what may be sent does not.
    k.hold();
    k.core.edit('x', (content) => ({ ...content, letter: 'c' }));
    await k.settle();

    assert.equal(k.core.content('x').letter, 'c');
    assert.equal(k.core.committed('x').version, 2);
    assert.equal(k.core.committed('x').content.letter, 'b');
  });

  it('commits the bytes the write carried, not whatever was typed while it ran', async () => {
    const k = kit();

    tracked(k);
    k.hold();

    // Version 3 is handed to the store, and version 4 is authored before it answers.
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.settle();
    k.core.edit('x', (content) => ({ ...content, letter: 'c' }));
    await k.settle();

    assert.equal(k.writes.calls.length, 1);
    assert.equal(k.writes.calls[0].content.letter, 'b');

    await k.release();
    await k.settle();

    // The claim is about what reached the store. Reading the latest content here instead would put
    // one version's number on another version's bytes, which is the whole reason the pair exists.
    assert.deepEqual(k.core.committed('x'), {
      version: 2,
      content: { letter: 'b', document: documentWith('a') },
    });
    assert.equal(k.core.content('x').letter, 'c');
  });

  it('does not move the committed pair when the store did not advance', async () => {
    const k = kit();

    tracked(k);
    // A coalesced write that lost a race: the store answers with no new version.
    k.writes.answer = null;
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.core.drain('x');

    assert.equal(k.core.committed('x').version, 1);
    assert.equal(k.core.committed('x').content.letter, 'a');
    assert.equal(k.published.get('x').failedWrite, false);
  });

  it('takes on a version it did not write, bumping nothing and scheduling nothing', async () => {
    const k = kit();

    tracked(k);
    k.core.confirm('x', 7, { letter: 'z', document: documentWith('z') });
    await k.settle();

    assert.equal(k.writes.calls.length, 0);
    assert.equal(k.core.content('x').letter, 'z');
    assert.deepEqual(k.core.committed('x'), {
      version: 7,
      content: { letter: 'z', document: documentWith('z') },
    });
    assert.equal(k.published.get('x').latestAcceptedVersion, 7);

    // A transaction that wrote no new version still reports the content it changed.
    k.core.confirm('x', null, { letter: '', document: documentWith('') });
    assert.equal(k.core.content('x').letter, '');
    assert.equal(k.core.committed('x').version, 7);
  });

  it('leaves the committed bytes alone when the transaction named none', async () => {
    const k = kit();

    tracked(k);
    // A write that failed, so the latest content is ahead of what the row actually holds.
    k.writes.fail = true;
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.core.drain('x');
    assert.equal(k.core.content('x').letter, 'b');

    // The acknowledgement transaction moved the row's own columns and touched no authored field, so
    // what is on disk is still what was last committed - never what is sitting in memory unwritten.
    k.core.confirm('x', 4);

    assert.deepEqual(k.core.committed('x'), {
      version: 4,
      content: { letter: 'a', document: documentWith('a') },
    });
    assert.equal(k.core.content('x').letter, 'b');
  });

  it('pairs the bytes with the version even when that version did not move', async () => {
    const k = kit();

    tracked(k);
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.core.drain('x');
    assert.equal(k.core.committed('x').version, 2);

    // The creation acknowledgement's clearing UPDATE rewrites the row *at the version it already
    // has*, so the number never moves and only the bytes do. Reading the committed content as
    // "whatever the last core write carried" would hand out the pre-clear text under a version whose
    // row on disk is empty - one version's bytes under another version's number.
    k.core.confirm('x', 2, { letter: '', document: documentWith('') });

    assert.deepEqual(k.core.committed('x'), {
      version: 2,
      content: { letter: '', document: documentWith('') },
    });
  });

  it('schedules nothing even when the entry was owed a write', async () => {
    const k = kit();

    tracked(k);
    k.writes.fail = true;
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.core.drain('x');

    assert.equal(k.published.get('x').failedWrite, true);

    const attempted = k.writes.calls.length;

    // The owner's own transaction wrote this row. Putting the same bytes back through the store
    // behind it would race the transaction that just landed.
    k.writes.fail = false;
    k.core.confirm('x', 5, { letter: 'z', document: documentWith('z') });
    await k.settle();

    assert.equal(k.writes.calls.length, attempted);
    assert.equal(k.core.committed('x').version, 5);
  });

  it('keeps in-memory work that a stored record cannot see, and takes a version it is behind', () => {
    const k = kit();

    tracked(k);
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));

    // A re-read of the store must not discard an accepted version the database has not got yet.
    k.core.track('x', { letter: 'a', document: documentWith('a') }, 1);
    assert.equal(k.core.content('x').letter, 'b');
    assert.equal(k.core.committed('x').version, 1);

    k.core.track('x', { letter: 'q', document: documentWith('q') }, 5);
    assert.deepEqual(k.core.committed('x'), {
      version: 5,
      content: { letter: 'q', document: documentWith('q') },
    });
  });
});

describe('accepting a snapshot', () => {
  it('is accepted, unchanged or retired, and only one of those is a write', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);

    const token = k.core.attach('x', editor.port);

    assert.equal(
      k.core.accept(token, { sessionId: 1, editSeq: 1, document: documentWith('b') }),
      'accepted',
    );
    await k.settle();
    assert.equal(k.core.content('x').document.content[0].text, 'b');

    // A sequence already seen within the same session is an expected race.
    assert.equal(
      k.core.accept(token, { sessionId: 1, editSeq: 1, document: documentWith('c') }),
      'unchanged',
    );
    // A document identical to what is held confirms the barrier without inventing a change.
    assert.equal(
      k.core.accept(token, { sessionId: 1, editSeq: 2, document: documentWith('b') }),
      'unchanged',
    );
    // A restarted renderer restarts the sequence, so it is compared within its own session.
    assert.equal(
      k.core.accept(token, { sessionId: 2, editSeq: 1, document: documentWith('d') }),
      'accepted',
    );

    const replaced = k.core.attach('x', editor.port);

    assert.notEqual(replaced.generation, token.generation);
    assert.equal(
      k.core.accept(token, { sessionId: 3, editSeq: 9, document: documentWith('e') }),
      'retired',
    );
    assert.equal(k.core.accept({ draftId: 'nothing', generation: 0 }, {}), 'retired');
  });

  it('does not let a late detach from a retired token tear down its replacement', () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);

    const first = k.core.attach('x', editor.port);
    const second = k.core.attach('x', editor.port);

    k.core.detach(first);
    assert.equal(k.core.attached('x'), true);
    k.core.detach(second);
    assert.equal(k.core.attached('x'), false);
  });
});

describe('flush', () => {
  it('says so when there was no renderer to ask', async () => {
    const k = kit();

    tracked(k);
    assert.deepEqual(await k.core.flush('x', false), {
      kind: 'flushed',
      version: 1,
      captured: 'no_editor',
    });
  });

  it('folds the editor answer in and awaits the commit', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.attach('x', editor.port);
    editor.captures(documentWith('body'));

    assert.deepEqual(await k.core.flush('x', true), {
      kind: 'flushed',
      version: 2,
      captured: 'editor',
    });
    assert.deepEqual(editor.barriers, [{ lock: true }]);
  });

  it('reports an accepted snapshot whose write failed as not persisted', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.attach('x', editor.port);
    editor.captures(documentWith('body'));
    k.writes.fail = true;

    assert.deepEqual(await k.core.flush('x', false), { kind: 'not_persisted', version: 2 });
  });

  it('keeps a refusal and an unanswered barrier as two different sentences', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.attach('x', editor.port);

    editor.refuses('invalid_document');
    assert.deepEqual(await k.core.flush('x', false), {
      kind: 'refused',
      code: 'invalid_document',
    });
    assert.equal(k.published.get('x').rendererUnknown, true);

    editor.unanswered();
    assert.deepEqual(await k.core.flush('x', false), { kind: 'unanswered' });
    assert.equal(k.published.get('x').rendererUnknown, true);
  });

  it('ends a barrier nobody is answering, by its own deadline', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.attach('x', editor.port);
    editor.hangs();

    const flushing = k.core.flush('x', true);

    await k.settle();
    assert.equal(k.timers.length, 1);
    k.timers[0].run();

    assert.deepEqual(await flushing, { kind: 'unanswered' });
  });

  it('answers an untracked entry rather than hanging its caller', async () => {
    const k = kit();

    assert.deepEqual(await k.core.flush('nothing', true), { kind: 'unanswered' });
    await k.core.drain('nothing');
  });

  it('serializes flushes, so a locked one is never answered by someone else barrier', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.attach('x', editor.port);
    editor.holds();

    const first = k.core.flush('x', false);
    const second = k.core.flush('x', true);

    await k.settle();
    assert.equal(editor.barriers.length, 1);

    editor.answerNext({ kind: 'unanswered' });
    assert.deepEqual(await first, { kind: 'unanswered' });
    await k.settle();

    assert.deepEqual(editor.barriers, [{ lock: false }, { lock: true }]);
    editor.answerNext({ kind: 'unanswered' });
    assert.deepEqual(await second, { kind: 'unanswered' });
  });
});

describe('closing', () => {
  it('abandons every waiting deadline rather than leaving a promise nobody resolves', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.attach('x', editor.port);
    editor.hangs();

    const flushing = k.core.flush('x', true);

    await k.settle();
    k.core.close();

    const publishes = k.log.length;

    assert.deepEqual(await flushing, { kind: 'unanswered' });
    // A barrier that outlived the close does not put a forgotten entry back on screen. Removal is
    // the owner's to publish here, and this one says nothing at all.
    assert.equal(k.log.length, publishes);
    assert.equal(k.core.has('x'), false);
  });

  it('leaves the core usable, because an owner may open again', async () => {
    const k = kit();

    tracked(k);
    k.core.close();
    tracked(k, 'n', 3);

    k.core.edit('x', (content) => ({ ...content, letter: 'o' }));
    await k.core.drain('x');

    assert.equal(k.core.committed('x').version, 4);
  });

  it('announces a removal exactly once', () => {
    const k = kit();

    tracked(k);
    assert.equal(k.published.has('x'), true);
    k.core.untrack('x');
    assert.equal(k.published.has('x'), false);
    assert.equal(k.core.has('x'), false);
    assert.equal(k.core.content('x'), undefined);
    assert.equal(k.core.committed('x'), undefined);
    assert.equal(k.core.protectionOf('x'), undefined);
  });
});

describe('the lease', () => {
  it('re-enables the editor only when the owner says it may be', () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.attach('x', editor.port);

    const held = k.core.takeLease('x');

    assert.equal(k.published.get('x').locked, true);
    k.core.releaseLease('x', held, false);
    assert.deepEqual(editor.editable, []);
    assert.equal(k.published.get('x').locked, false);

    const again = k.core.takeLease('x');

    k.core.releaseLease('x', again, true);
    assert.deepEqual(editor.editable, [true]);

    // A lease that is no longer the entry's releases nothing, so a stale exit cannot unlock a path
    // that has since taken the lock for itself.
    const current = k.core.takeLease('x');

    k.core.releaseLease('x', again, true);
    assert.equal(k.published.get('x').locked, true);
    k.core.releaseLease('x', current, true);
    assert.equal(k.published.get('x').locked, false);
  });

  it('goes with the editor, because one that is gone cannot be holding it', () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);

    const token = k.core.attach('x', editor.port);

    k.core.takeLease('x');
    k.core.detach(token);
    assert.equal(k.published.get('x').locked, false);
  });

  it('returns nothing for an entry the core does not hold', () => {
    const k = kit();

    assert.equal(k.core.takeLease('nothing'), null);
    assert.equal(k.core.attach('nothing', fakeEditor().port), null);
    assert.equal(
      k.core.edit('nothing', (content) => content),
      false,
    );
  });
});

describe('settledAt', () => {
  it('is true with no live editor when nothing newer exists', async () => {
    const k = kit();

    tracked(k);
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.core.drain('x');

    assert.equal(k.core.settledAt('x', null, 2), true);
    assert.equal(k.core.settledAt('x', null, 1), false);
    assert.equal(k.core.settledAt('nothing', null, 1), false);
  });

  it('with a live editor demands the unbroken lease that produced the version', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.attach('x', editor.port);
    editor.captures(documentWith('body'));

    const lease = k.core.takeLease('x');
    const flushed = await k.core.flush('x', true);

    lease.version = flushed.version;

    assert.equal(k.core.settledAt('x', lease, flushed.version), true);
    // Without the lease, an edit made a moment after the drain would sit where nothing could see it.
    assert.equal(k.core.settledAt('x', null, flushed.version), false);

    // A lease that was broken and retaken is not the same lease.
    k.core.releaseLease('x', lease, true);
    assert.equal(k.core.settledAt('x', lease, flushed.version), false);
  });

  it('is false whenever anything newer or unknown exists', async () => {
    const k = kit();
    const editor = fakeEditor();

    tracked(k);
    k.core.edit('x', (content) => ({ ...content, letter: 'b' }));
    await k.core.drain('x');
    assert.equal(k.core.settledAt('x', null, 2), true);

    k.core.attach('x', editor.port);
    editor.unanswered();
    await k.core.flush('x', false);
    // The renderer may hold writing native never saw, so nothing may be cleared on its word.
    assert.equal(k.published.get('x').rendererUnknown, true);

    const lease = k.core.takeLease('x');

    lease.version = 2;
    assert.equal(k.core.settledAt('x', lease, 2), false);
  });
});

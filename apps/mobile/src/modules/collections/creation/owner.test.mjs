/**
 * The creation owner, driven through its ports.
 *
 * The happy path is the least of it. What is pinned here is that a logical attempt survives every
 * individually definite failure that can follow it: a 401 on a retry after the first dispatch was
 * lost, a local write that fails after the server has already created something, a window that
 * closes, a clock that moves, and a connection that changes underneath a request in flight.
 *
 * This is orchestration evidence. The store is a fake whose every operation can be held open or
 * made to fail, which is what makes those races reachable at all; storage behaviour itself is
 * exercised against real SQLite in `tests/creation-store.test.mjs`, and the Expo binding is not
 * exercised by any automated test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { correctionAllowed, logicalStateOf } from './derive.ts';
import { RETRY_WINDOW_MS } from './eligibility.ts';
import { recoverInput } from './freeze.ts';
import { createCreationOwner } from './owner.ts';

const T0 = 1_700_000_000_000;

/** An in-memory attempt store with the real one's rules, and a gate on every operation. */
const fakeStore = () => {
  const rows = new Map();
  const faults = {};
  const gates = {};
  const log = [];

  const run = async (name, effect) => {
    log.push(name);
    if (gates[name] !== undefined) await gates[name];
    if (faults[name] !== undefined) throw new Error(faults[name]);

    return effect();
  };

  /**
   * Apply a change and answer with the row as it now stands, which is what the real store does: it
   * reads the row back inside the write's own transaction. A fake that answered `undefined` would
   * let the owner's publication path go untested in exactly the tests that exist to cover it.
   */
  const patch = (attemptId, fields) => {
    const row = rows.get(attemptId);
    if (row === undefined) return null;
    const next = {
      ...row,
      ...fields,
      observedAt: Math.max(row.observedAt, fields.observedAt ?? row.observedAt),
    };
    rows.set(attemptId, next);

    return next;
  };

  const insert = (attempt) => {
    const row = {
      attemptId: attempt.attemptId,
      connectionId: attempt.connectionId,
      endpoint: attempt.endpoint,
      state: 'dispatch_intent',
      request: attempt.request,
      type: attempt.type,
      title: attempt.title,
      parentAreaId: attempt.parentAreaId,
      firstDispatchAt: attempt.at,
      firstUncertainAt: null,
      clockAnomaly: false,
      lastOutcome: null,
      acknowledged: null,
      observedAt: attempt.at,
    };
    rows.set(attempt.attemptId, row);

    return row;
  };

  const store = {
    rows,
    faults,
    gates,
    log,
    hold(name) {
      let release = () => {};
      gates[name] = new Promise((resolve) => {
        release = resolve;
      });

      return () => {
        delete gates[name];
        release();
      };
    },
    list: () =>
      run('list', () => ({
        records: [...rows.values()].sort((a, b) => a.firstDispatchAt - b.firstDispatchAt),
        unreadable: 0,
      })),
    insertIntent: (attempt) => run('insertIntent', () => insert(attempt)),
    markUncertain: (attemptId, at) =>
      run('markUncertain', () => {
        const row = rows.get(attemptId);
        // A guard that declines still answers with the row as it stands, exactly as the SQL does.
        if (row?.state === 'acknowledged') return row;

        return patch(attemptId, {
          state: 'uncertain',
          firstUncertainAt: row?.firstUncertainAt ?? at,
          observedAt: at,
        });
      }),
    markBlocked: (attemptId, outcome, at) =>
      run('markBlocked', () => {
        const row = rows.get(attemptId);
        if (row?.state === 'acknowledged') return row;

        return patch(attemptId, { state: 'blocked', lastOutcome: outcome, observedAt: at });
      }),
    markAcknowledged: (attemptId, result, at) =>
      run('markAcknowledged', () =>
        patch(attemptId, {
          state: 'acknowledged',
          acknowledged: result,
          lastOutcome: null,
          observedAt: at,
        }),
      ),
    markClockAnomaly: (attemptId, at) =>
      run('markClockAnomaly', () => patch(attemptId, { clockAnomaly: true, observedAt: at })),
    remove: (attemptId) =>
      run('remove', () => {
        rows.delete(attemptId);
      }),
    replace: (previousId, attempt) =>
      run('replace', () => {
        const previous = rows.get(previousId);
        if (previous?.state === 'blocked' && previous.firstUncertainAt === null) {
          rows.delete(previousId);
        }

        return insert(attempt);
      }),
    reconcile: () => run('reconcile', () => 0),
    close: () => run('close', () => {}),
  };

  return store;
};

const failure = (over) => ({
  kind: 'transport',
  mutationOutcome: 'unknown',
  message: 'it did not arrive',
  ...over,
});

const created = (id = 7, title = 'Work') => ({
  ok: true,
  value: { entity: { type: 'area', id, title } },
});

/** An owner with controllable time, identifiers, network, and cache. */
const harness = (over = {}) => {
  const store = over.store ?? fakeStore();
  const clock = { wall: T0, mono: 0 };
  const applied = [];
  const ids = [];
  let nth = 0;
  const responses = [];
  const harnessState = { failIds: false };

  const ports = {
    openStore: async () => over.openOutcome ?? { kind: 'ready', store },
    create: async (transport, request) => {
      // What was already on disk at the moment the request was handed to the network. The
      // persist-before-send rule is only meaningful as a statement about this instant.
      responses.push({
        transport,
        request,
        persisted: [...store.rows.values()].map((row) => row.attemptId),
      });
      const next = over.answers?.shift();

      return typeof next === 'function' ? next() : (next ?? { ok: false, failure: failure({}) });
    },
    now: () => clock.wall,
    monotonic: () => clock.mono,
    newId: () => {
      if (harnessState.failIds) throw new Error('no generator on this platform');
      nth += 1;
      const id = `id-${String(nth)}`;
      ids.push(id);

      return id;
    },
    applyCreation: async (response, activation) => {
      if (over.holdCache !== undefined) await over.holdCache;
      applied.push({ response, activation });
    },
  };

  const built = { store, clock, applied, ids, responses, owner: createCreationOwner(ports) };

  // A setter rather than a field, so a test can make the identifier provider start failing partway
  // through - which is the only way to reach the refusal without a second harness.
  Object.defineProperty(built, 'failIds', {
    set: (value) => {
      harnessState.failIds = value;
    },
    get: () => harnessState.failIds,
  });

  return built;
};

const session = (over = {}) => ({
  activation: 1,
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  transport: { id: 'transport-1' },
  usable: true,
  ...over,
});

const submission = (over = {}) => ({
  target: { type: 'area', parentAreaId: null },
  title: 'Work',
  body: '',
  session: session(),
  ...over,
});

/** Lets every already-scheduled continuation run. */
const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const recordOf = (owner) => owner.getState().records[0];

describe('submitting', () => {
  it('persists before it sends, and reports what the server created', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();

    const outcome = await h.owner.getState().submit(submission());
    assert.equal(outcome.kind, 'dispatched');

    await settle();
    // The intent was already on disk when the request was handed to the network.
    assert.deepEqual(h.responses[0].persisted, [recordOf(h.owner).attemptId]);

    const record = recordOf(h.owner);
    assert.equal(record.state, 'acknowledged');
    assert.deepEqual(record.acknowledged, { type: 'area', id: 7, title: 'Work' });
    assert.deepEqual(h.applied[0].activation, 1);
  });

  it('sends the request even when the read-back afterwards fails', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();
    h.store.faults.list = 'locked';

    const outcome = await h.owner.getState().submit(submission());

    // The write is what mattered and it succeeded. Reporting "not saved" for a row that is on disk
    // would be the one wrong answer available here, and withholding the request compounds it.
    assert.equal(outcome.kind, 'dispatched');
    await settle();
    assert.equal(h.responses.length, 1);
  });

  it('refuses rather than rejecting when no identifier can be minted', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();
    h.failIds = true;

    // Not a thrown promise out of an async closure nothing is listening to: the form keeps what was
    // typed and is told nothing was sent. A weaker identifier is not the alternative, because an
    // idempotency key drawn twice would let one key stand for two different requests.
    const outcome = await h.owner.getState().submit(submission());

    assert.equal(outcome.kind, 'not_recorded');
    assert.match(outcome.problem, /identifier/i);
    assert.equal(h.responses.length, 0);
    assert.equal(h.store.log.includes('insertIntent'), false);
  });

  it('sends nothing when the local record cannot be written', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();
    h.store.faults.insertIntent = 'disk full';

    const outcome = await h.owner.getState().submit(submission());

    assert.equal(outcome.kind, 'not_recorded');
    assert.equal(h.responses.length, 0);
    assert.equal(h.owner.getState().records.length, 0);
  });

  it('refuses an empty title locally, before anything is written', async () => {
    const h = harness();
    await h.owner.getState().initialize();

    const outcome = await h.owner.getState().submit(submission({ title: '   ' }));

    assert.equal(outcome.kind, 'not_recorded');
    assert.match(outcome.problem, /title/i);
    assert.equal(h.store.log.includes('insertIntent'), false);
  });

  it('sends nothing at all when there is no database', async () => {
    const h = harness({ openOutcome: { kind: 'failed', message: 'no' } });
    await h.owner.getState().initialize();

    assert.equal(h.owner.getState().status, 'unavailable');
    const outcome = await h.owner.getState().submit(submission());

    assert.equal(outcome.kind, 'not_recorded');
    assert.equal(h.responses.length, 0);
  });

  it('freezes the request, key and all, and resends exactly it', async () => {
    const h = harness({
      answers: [{ ok: false, failure: failure({}) }, created()],
    });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission({ title: 'Work', body: '  keep  me  ' }));
    await settle();

    const first = h.responses[0].request;
    await h.owner.getState().retry(recordOf(h.owner).attemptId, session());
    await settle();

    assert.deepEqual(h.responses[1].request, first);
    // Whitespace the person typed is content, and survives into the frozen request.
    assert.equal(first.body.value, '  keep  me  ');
    assert.equal(first.format, 'markdown');
    assert.equal('description' in first, false);
  });

  it('omits an empty body rather than sending an empty one', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission({ body: '' }));
    await settle();

    assert.equal('body' in h.responses[0].request, false);
  });
});

describe('an attempt that has ever been uncertain', () => {
  it('stays unresolved when a retry is definitely rejected', async () => {
    const h = harness({
      answers: [
        { ok: false, failure: failure({}) },
        {
          ok: false,
          failure: {
            kind: 'api_error',
            status: 401,
            mutationOutcome: 'rejected',
            message: 'refused',
            error: { code: 'unauthorized' },
            details: {},
          },
        },
      ],
    });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    assert.equal(recordOf(h.owner).state, 'uncertain');

    await h.owner.getState().retry(recordOf(h.owner).attemptId, session());
    await settle();

    const record = recordOf(h.owner);
    // The retry was genuinely rejected. The creation is still genuinely unknown.
    assert.equal(record.state, 'blocked');
    assert.equal(record.lastOutcome.kind, 'rejected');
    assert.equal(record.lastOutcome.code, 'unauthorized');
    assert.equal(logicalStateOf(record), 'unresolved');
  });

  it('stays unresolved when a later attempt never leaves the phone', async () => {
    const h = harness({
      answers: [
        { ok: false, failure: failure({}) },
        {
          ok: false,
          failure: {
            kind: 'invalid_request',
            mutationOutcome: 'not_dispatched',
            message: 'no',
            path: [],
          },
        },
      ],
    });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();
    await h.owner.getState().retry(recordOf(h.owner).attemptId, session());
    await settle();

    assert.equal(logicalStateOf(recordOf(h.owner)), 'unresolved');
  });

  it('reports a first-attempt rejection as a refusal that may be corrected', async () => {
    const h = harness({
      answers: [
        {
          ok: false,
          failure: {
            kind: 'api_error',
            status: 409,
            mutationOutcome: 'rejected',
            message: 'taken',
            error: { code: 'slug_conflict' },
            details: {},
          },
        },
      ],
    });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    assert.equal(logicalStateOf(recordOf(h.owner)), 'refused');
  });

  it('is resolved only by a success', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }, created(11, 'Work')] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();
    await h.owner.getState().retry(recordOf(h.owner).attemptId, session());
    await settle();

    const record = recordOf(h.owner);
    assert.equal(logicalStateOf(record), 'created');
    assert.equal(record.acknowledged.id, 11);
  });
});

describe('concurrency', () => {
  it('will not send the same attempt twice at once', async () => {
    const h = harness({
      answers: [() => new Promise(() => {}), created()],
    });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    const attemptId = recordOf(h.owner).attemptId;
    const refused = await h.owner.getState().retry(attemptId, session());

    assert.equal(refused.kind, 'refused');
    assert.equal(h.responses.length, 1);
  });

  it('records a result that arrives after the connection changed, without touching the cache', async () => {
    const h = harness({ answers: [created(9)] });
    await h.owner.getState().initialize();
    const dispatchSession = session({ activation: 4, connectionId: 'c-old' });
    await h.owner.getState().submit(submission({ session: dispatchSession }));
    await settle();

    const record = recordOf(h.owner);
    // The result is recorded under the connection it was made against.
    assert.equal(record.connectionId, 'c-old');
    assert.equal(record.state, 'acknowledged');
    // And the cache effect carries that activation, so the port can refuse it.
    assert.equal(h.applied[0].activation, 4);
  });

  it('refuses a retry against a different connection', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    const outcome = await h.owner
      .getState()
      .retry(recordOf(h.owner).attemptId, session({ connectionId: 'c2', activation: 2 }));

    assert.equal(outcome.kind, 'refused');
    assert.equal(h.responses.length, 1);
  });

  it('refuses a retry while the connection is unusable', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    const outcome = await h.owner
      .getState()
      .retry(recordOf(h.owner).attemptId, session({ usable: false }));

    assert.equal(outcome.kind, 'refused');
    assert.equal(h.responses.length, 1);
  });
});

describe('consuming a success', () => {
  it('removes the record once the UI has shown it', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    const attemptId = recordOf(h.owner).attemptId;
    await h.owner.getState().consume(attemptId);

    assert.equal(h.owner.getState().records.length, 0);
  });

  it('leaves a success whose acknowledgement is only in memory', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();
    h.store.faults.markAcknowledged = 'disk full';
    await h.owner.getState().submit(submission());
    await settle();

    const attemptId = recordOf(h.owner).attemptId;
    await h.owner.getState().consume(attemptId);

    // Nothing was written down, so nothing may be thrown away: the row and its warning stand.
    assert.equal(h.owner.getState().records.length, 1);
    assert.notEqual(h.owner.getState().unsaved[attemptId], undefined);
  });

  it('will not remove an attempt that is not a success', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    await h.owner.getState().consume(recordOf(h.owner).attemptId);

    assert.equal(h.owner.getState().records.length, 1);
  });

  it('keeps a recoverable row when the cleanup itself fails', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();
    h.store.faults.remove = 'locked';

    await h.owner.getState().consume(recordOf(h.owner).attemptId);

    const record = recordOf(h.owner);
    assert.equal(record.state, 'acknowledged');
    // Acknowledged means it is never sent again, whatever happens to the row afterwards.
    assert.equal(h.responses.length, 1);
  });
});

describe('the cache effect', () => {
  it('runs after the success is published, not before', async () => {
    let releaseCache = () => {};
    const cacheHeld = new Promise((resolve) => {
      releaseCache = resolve;
    });
    const h = harness({ answers: [created(5)], holdCache: cacheHeld });

    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    // Seeding and invalidating a cache is a consequence of the creation, not part of establishing
    // it. A slow hierarchy read must not leave the sheet saying "Saving…" over a result that is
    // already durable on the server and on this phone.
    assert.equal(recordOf(h.owner).state, 'acknowledged');
    assert.deepEqual(h.owner.getState().sending, []);

    releaseCache();
    await settle();
    assert.equal(h.applied.length, 1);
  });

  it('does not run at all when the creation did not succeed', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    assert.equal(h.applied.length, 0);
  });
});

describe('a success whose acknowledgement cannot be written', () => {
  it('is reported as the success it is, and kept for another try', async () => {
    const h = harness({ answers: [created(13, 'Work')] });
    await h.owner.getState().initialize();
    h.store.faults.markAcknowledged = 'disk full';

    await h.owner.getState().submit(submission());
    await settle();

    const attemptId = recordOf(h.owner).attemptId;
    // Known server success, held in memory. Never reported as a failed creation.
    assert.deepEqual(h.owner.getState().unsaved[attemptId], {
      type: 'area',
      id: 13,
      title: 'Work',
    });
    assert.equal(recordOf(h.owner).state, 'dispatch_intent');
    assert.equal(h.applied.length, 1);

    // The row is untouched, so the row alone would read as unresolved. What the process knows wins.
    const record = recordOf(h.owner);
    assert.equal(logicalStateOf(record), 'unresolved', 'the row on its own says nothing yet');
    assert.equal(
      logicalStateOf(record, h.owner.getState().unsaved[attemptId]),
      'created',
      'the confirmed result makes it a creation',
    );

    // What is offered is the local write again, not another creation.
    delete h.store.faults.markAcknowledged;
    const outcome = await h.owner.getState().saveAcknowledgement(attemptId);

    assert.equal(outcome.kind, 'done');
    assert.equal(h.responses.length, 1);
    assert.equal(recordOf(h.owner).state, 'acknowledged');
    assert.equal(h.owner.getState().unsaved[attemptId], undefined);
  });
});

describe('a transition whose read-back of the whole table fails', () => {
  /**
   * The dangerous shape: the write lands, the reconciling read does not.
   *
   * Publication used to be a full reread, so a failed `list()` left the app holding the row as it
   * was *before* a transition already committed. For a success that is the worst version of it -
   * the creation would present as unresolved, and the sheet would offer to make it again under a
   * fresh key.
   */
  const withBrokenList = async (answers) => {
    const h = harness({ answers });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();
    h.store.faults.list = 'locked';

    return h;
  };

  it('still publishes a success', async () => {
    const h = await withBrokenList([created(21, 'Work')]);

    const record = recordOf(h.owner);
    assert.equal(record.state, 'acknowledged');
    assert.deepEqual(record.acknowledged, { type: 'area', id: 21, title: 'Work' });
    assert.equal(logicalStateOf(record), 'created');
    // Nothing is held in memory, because the write itself succeeded.
    assert.deepEqual(h.owner.getState().unsaved, {});
  });

  it('still publishes a definite refusal', async () => {
    const h = await withBrokenList([
      {
        ok: false,
        failure: {
          kind: 'api_error',
          status: 409,
          mutationOutcome: 'rejected',
          message: 'taken',
          error: { code: 'slug_conflict' },
          details: {},
        },
      },
    ]);

    const record = recordOf(h.owner);
    assert.equal(record.state, 'blocked');
    assert.equal(record.lastOutcome.code, 'slug_conflict');
    assert.equal(logicalStateOf(record), 'refused');
  });

  it('still publishes uncertainty', async () => {
    const h = await withBrokenList([{ ok: false, failure: failure({}) }]);

    const record = recordOf(h.owner);
    assert.equal(record.state, 'uncertain');
    assert.equal(record.firstUncertainAt, T0);
  });

  it('still publishes the intent itself, so a second Save cannot mint a new key', async () => {
    const h = harness({ answers: [() => new Promise(() => {}), created()] });
    await h.owner.getState().initialize();
    h.store.faults.list = 'locked';

    const outcome = await h.owner.getState().submit(submission());
    await settle();

    assert.equal(outcome.kind, 'dispatched');
    // The row is on screen, so the sheet is looking at an attempt rather than at nothing - which is
    // what would let it start a second one under a fresh key against the same creation.
    assert.equal(h.owner.getState().records.length, 1);
    assert.equal(recordOf(h.owner).attemptId, outcome.attemptId);
  });

  it('still removes a consumed record', async () => {
    const h = await withBrokenList([created()]);

    await h.owner.getState().consume(recordOf(h.owner).attemptId);

    assert.equal(h.owner.getState().records.length, 0);
  });
});

describe('a connection the app knows is refusing', () => {
  it('takes no new creation, and records nothing', async () => {
    const h = harness({ answers: [created()] });
    await h.owner.getState().initialize();

    const outcome = await h.owner
      .getState()
      .submit(submission({ session: session({ usable: false }) }));

    // The owner holds this, not the Save button. Dispatching against a connection already known to
    // be refusing only spends an attempt and leaves a record to clean up.
    assert.equal(outcome.kind, 'not_recorded');
    assert.match(outcome.problem, /not accepting requests/i);
    assert.equal(h.responses.length, 0);
    assert.equal(h.store.log.includes('insertIntent'), false);
    assert.equal(h.owner.getState().records.length, 0);
  });
});

describe('the retry window', () => {
  it('is checked immediately before the send, not when a sheet opened', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }, created()] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    const attemptId = recordOf(h.owner).attemptId;
    h.clock.wall = T0 + RETRY_WINDOW_MS;

    const outcome = await h.owner.getState().retry(attemptId, session());

    assert.equal(outcome.kind, 'refused');
    assert.equal(h.responses.length, 1);
  });

  it('still allows a retry just inside it', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }, created()] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    h.clock.wall = T0 + RETRY_WINDOW_MS - 1000;
    await h.owner.getState().retry(recordOf(h.owner).attemptId, session());
    await settle();

    assert.equal(h.responses.length, 2);
  });

  it('uses monotonic elapsed time when the clock disagrees with it', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }, created()] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    // The wall clock says almost no time has passed; the monotonic mark says three days have.
    h.clock.mono = RETRY_WINDOW_MS + 1;
    h.clock.wall = T0 + 1000;

    const outcome = await h.owner.getState().retry(recordOf(h.owner).attemptId, session());

    assert.equal(outcome.kind, 'refused');
    assert.equal(h.responses.length, 1);
  });

  it('records a backwards clock permanently, and does not reopen when it catches up', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }, created(), created()] });
    await h.owner.getState().initialize();
    h.clock.wall = T0 + 60_000;
    await h.owner.getState().submit(submission());
    await settle();

    const attemptId = recordOf(h.owner).attemptId;
    h.clock.wall = T0;

    assert.equal((await h.owner.getState().retry(attemptId, session())).kind, 'refused');
    assert.equal(recordOf(h.owner).clockAnomaly, true);

    // The clock catches up. The anomaly is a fact about this attempt now, not a transient state.
    h.clock.wall = T0 + 120_000;
    assert.equal((await h.owner.getState().retry(attemptId, session())).kind, 'refused');
    assert.equal(h.responses.length, 1);
  });
});

describe('a stored request this build cannot send', () => {
  /** An attempt left behind by a build whose contract this one no longer accepts. */
  const stale = (request) => {
    const store = fakeStore();
    store.rows.set('old', {
      attemptId: 'old',
      connectionId: 'c1',
      endpoint: 'https://raphael.example',
      state: 'uncertain',
      request,
      type: 'area',
      title: 'Work',
      parentAreaId: null,
      firstDispatchAt: T0,
      firstUncertainAt: T0,
      clockAnomaly: false,
      lastOutcome: null,
      acknowledged: null,
      observedAt: T0,
    });

    return store;
  };

  it('is kept and refused when it no longer decodes', async () => {
    const h = harness({ store: stale('{"type":"nonsense"}') });
    await h.owner.getState().initialize();

    await h.owner.getState().retry('old', session());
    await settle();

    const record = recordOf(h.owner);
    assert.equal(record.lastOutcome.kind, 'unusable_payload');
    // Nothing was sent, and the person's input is still here.
    assert.equal(h.responses.length, 0);
    assert.equal(record.title, 'Work');
  });

  it('is kept and refused when it decodes but would normalize differently', async () => {
    // Valid against the contract, but not the normalized form this build would freeze: the
    // materialized `format` default is missing, so replaying it would send something other than
    // what was stored under that key.
    const h = harness({
      store: stale(
        JSON.stringify({
          type: 'area',
          parent: { path: '/' },
          title: 'Work',
          idempotencyKey: 'k1',
        }),
      ),
    });
    await h.owner.getState().initialize();

    await h.owner.getState().retry('old', session());
    await settle();

    assert.equal(recordOf(h.owner).lastOutcome.kind, 'unusable_payload');
    assert.equal(h.responses.length, 0);
  });
});

describe('discarding and replacing', () => {
  it('replaces a refused record and leaves an ambiguous one alone', async () => {
    const h = harness({
      answers: [
        {
          ok: false,
          failure: {
            kind: 'api_error',
            status: 409,
            mutationOutcome: 'rejected',
            message: 'taken',
            error: { code: 'slug_conflict' },
            details: {},
          },
        },
        { ok: false, failure: failure({}) },
        { ok: false, failure: failure({}) },
      ],
    });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    const refused = recordOf(h.owner);
    await h.owner.getState().submit(submission({ title: 'Work log', replaces: refused }));
    await settle();

    assert.equal(h.owner.getState().records.length, 1);
    assert.equal(h.owner.getState().records[0].title, 'Work log');

    // Now the ambiguous case: recovering its input must not delete the evidence.
    const ambiguous = recordOf(h.owner);
    await h.owner.getState().submit(submission({ title: 'Work notes', replaces: ambiguous }));
    await settle();

    const titles = h.owner
      .getState()
      .records.map((record) => record.title)
      .sort();
    assert.deepEqual(titles, ['Work log', 'Work notes']);
  });

  it('carries the authored body through a correction', async () => {
    const h = harness({
      answers: [
        {
          ok: false,
          failure: {
            kind: 'api_error',
            status: 409,
            mutationOutcome: 'rejected',
            message: 'taken',
            error: { code: 'slug_conflict' },
            details: {},
          },
        },
        created(),
      ],
    });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission({ title: 'Work', body: '  the note  ' }));
    await settle();

    const refused = recordOf(h.owner);
    assert.equal(correctionAllowed(refused), true);

    // What the recovery UI does: read the input back out of the frozen request, and resubmit it.
    // Correcting a refusal replaces the record atomically, so the frozen request is the only copy
    // of the body in existence at this point - recovering the title alone would destroy it.
    const recovered = recoverInput(refused.request, refused.title);
    assert.equal(recovered.body, '  the note  ');
    assert.equal(recovered.complete, true);

    await h.owner
      .getState()
      .submit(submission({ title: 'Work log', body: recovered.body, replaces: refused }));
    await settle();

    assert.equal(h.owner.getState().records.length, 1);
    assert.equal(h.responses[1].request.body.value, '  the note  ');
  });

  it('reports a discard that did not happen', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();
    h.store.faults.remove = 'locked';

    const outcome = await h.owner.getState().discard(recordOf(h.owner).attemptId);

    assert.equal(outcome.kind, 'refused');
    assert.equal(h.owner.getState().records.length, 1);
  });

  it('will not discard an attempt that is being sent', async () => {
    const h = harness({ answers: [() => new Promise(() => {})] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    const outcome = await h.owner.getState().discard(recordOf(h.owner).attemptId);

    assert.equal(outcome.kind, 'refused');
  });
});

describe('the database', () => {
  it('reports an unsupported version rather than rebuilding anything', async () => {
    const h = harness({
      openOutcome: { kind: 'unsupported_version', found: 9, supported: 1 },
    });
    await h.owner.getState().initialize();

    assert.equal(h.owner.getState().status, 'unavailable');
    assert.equal(h.owner.getState().problem.kind, 'unsupported_version');
  });

  it('keeps the records it last read when a refresh fails', async () => {
    const h = harness({ answers: [{ ok: false, failure: failure({}) }] });
    await h.owner.getState().initialize();
    await h.owner.getState().submit(submission());
    await settle();

    h.store.faults.list = 'locked';
    await h.owner.getState().discard('nothing-here');

    assert.equal(h.owner.getState().records.length, 1);
  });
});

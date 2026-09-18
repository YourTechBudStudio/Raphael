/**
 * The transition owner, driven through its ports.
 *
 * What is being pinned here is not that the happy path works. It is that every way a completion can
 * race a decision ends with the decision winning: a storage read that lands after a disconnect, a
 * write that is overtaken, a delete that fails, an authorization failure from a connection two
 * switches ago. Each of those was reachable in a design without one owner, and each would have been
 * a silent wrong answer rather than a crash.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION, decodeVerifyResponse } from '@raphael/contracts/connection';
import { Either } from 'effect';

import { decodeRecord, encodeRecord, newConnectionId } from './record.ts';
import { createConnectionStorage } from './storage.ts';
import { createConnectionStore } from './transition.ts';

/** A fake keychain whose every operation can be delayed, refused, or watched. */
const fakePort = () => {
  const state = { value: null, log: [] };
  const gates = { get: null, set: null, remove: null };
  const faults = { get: null, set: null, remove: null };

  const run = async (name, effect) => {
    state.log.push(name);
    if (gates[name] !== null) await gates[name];
    if (faults[name] !== null) throw new Error(faults[name]);

    return effect();
  };

  return {
    state,
    gates,
    faults,
    /**
     * Holds the next call of `name` open until the returned function is called, and offers a
     * promise that settles once the call has actually entered the port.
     *
     * The distinction matters: a queued operation can still be dropped, but one that has entered
     * the keychain will finish whatever happens next, and that is the case the ordering guarantee
     * has to survive.
     */
    hold(name) {
      let release = () => {};
      let entered = () => {};
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      gates[name] = new Promise((resolve) => {
        release = resolve;
      }).then(() => undefined);
      const original = gates[name];
      gates[name] = {
        then: (onFulfilled, onRejected) => {
          entered();

          return original.then(onFulfilled, onRejected);
        },
      };

      return Object.assign(
        () => {
          gates[name] = null;
          release();
        },
        { started },
      );
    },
    port: {
      kind: 'available',
      get: () => run('get', () => state.value),
      set: (value) =>
        run('set', () => {
          state.value = value;
        }),
      remove: () =>
        run('remove', () => {
          state.value = null;
        }),
    },
  };
};

const ports = (port, overrides = {}) => {
  const retired = { count: 0 };
  const forgotten = [];
  let ids = 0;

  return {
    retired,
    forgotten,
    value: {
      storage: createConnectionStorage(port),
      createTransport: (base) => ({ ok: true, transport: { base } }),
      retireCaches: () => {
        retired.count += 1;
      },
      forgetLocalContent: (id) => {
        forgotten.push(id);
      },
      newConnectionId: () => {
        ids += 1;

        return `id-${ids}`;
      },
      now: () => '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  };
};

const SERVER = {
  base: 'https://pi.local:4000',
  origin: 'https://pi.local:4000',
  apiKey: 'a-key',
  protocolVersion: PROTOCOL_VERSION,
};

/** What an older build of this app wrote: a protocol identifier from before it became a date. */
const LEGACY_PROTOCOL_VERSION = 1;

const OTHER = { ...SERVER, base: 'https://other:4000', origin: 'https://other:4000' };

const storedRecord = (overrides = {}) =>
  encodeRecord({
    version: 1,
    connectionId: 'stored-id',
    base: SERVER.base,
    origin: SERVER.origin,
    apiKey: 'stored-key',
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    verifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

describe('the stored record', () => {
  it('round-trips, and every way of being wrong is told apart from being absent', () => {
    const decoded = decodeRecord(storedRecord());
    assert.equal(decoded.ok, true);
    assert.equal(decoded.record.apiKey, 'stored-key');

    assert.deepEqual(decodeRecord('not json'), { ok: false, problem: 'unreadable' });
    assert.deepEqual(decodeRecord('[]'), { ok: false, problem: 'unreadable' });
    assert.deepEqual(decodeRecord('null'), { ok: false, problem: 'unreadable' });
    // A record from a later build is not a corrupt one, and must not be reported as one.
    assert.deepEqual(decodeRecord(storedRecord({ version: 2 })), {
      ok: false,
      problem: 'unsupported_version',
    });
    // Every field is required: a half-written record is unreadable, not usable-with-gaps.
    assert.deepEqual(decodeRecord(storedRecord({ apiKey: '' })), {
      ok: false,
      problem: 'unreadable',
    });
    assert.deepEqual(decodeRecord(storedRecord({ protocolVersion: 0 })), {
      ok: false,
      problem: 'unreadable',
    });
  });

  /**
   * One table, two implementations.
   *
   * `record.ts` spells out its own calendar-date rule so that file keeps its standard-library-only
   * dependency, which means the rule exists twice. Two hand-kept lists of edge cases would drift the
   * first time either side changed, so both are driven from this one instead.
   */
  const IDENTIFIERS = [
    [PROTOCOL_VERSION, true],
    ['2026-09-10', true],
    [1, true],
    ['2026-13-01', false],
    ['2026-02-30', false],
    ['2026-9-18', false],
    ['0026-01-01', false],
    ['latest', false],
    ['', false],
    [0, false],
    [-1, false],
    [1.5, false],
  ];

  it('holds the stored rule and the wire rule to the same table', () => {
    for (const [protocolVersion, accepted] of IDENTIFIERS) {
      assert.equal(
        decodeRecord(storedRecord({ protocolVersion })).ok,
        accepted,
        `stored: ${JSON.stringify(protocolVersion)}`,
      );
      assert.equal(
        Either.isRight(decodeVerifyResponse({ protocolVersion })),
        accepted,
        `wire: ${JSON.stringify(protocolVersion)}`,
      );
    }
  });

  it('reads both protocol identifiers, and refuses anything that is neither', () => {
    // The default fixture carries the number an older build wrote. It is a true account of a
    // verification that happened, so it is read as one rather than repaired or thrown away.
    const legacy = decodeRecord(storedRecord());
    assert.equal(legacy.ok, true);
    assert.equal(legacy.record.protocolVersion, LEGACY_PROTOCOL_VERSION);
    assert.equal(
      legacy.record.apiKey,
      'stored-key',
      'a historical version is not a bad credential',
    );
    assert.equal(legacy.record.connectionId, 'stored-id');

    const dated = decodeRecord(storedRecord({ protocolVersion: PROTOCOL_VERSION }));
    assert.equal(dated.ok, true);
    assert.equal(dated.record.protocolVersion, PROTOCOL_VERSION);

    // Widening what can be read is not softening the check, and a refusal is "unreadable" rather
    // than anything softer - that is the phase which surfaces a diagnosis without discarding the
    // credential. Which values are refused is the shared table's job; this is about the verdict.
    assert.deepEqual(decodeRecord(storedRecord({ protocolVersion: '2026-13-01' })), {
      ok: false,
      problem: 'unreadable',
    });
  });

  it('mints a different local identity each time', () => {
    const ids = new Set(Array.from({ length: 200 }, newConnectionId));
    assert.equal(ids.size, 200);
  });
});

describe('hydration', () => {
  it('reads a stored connection and activates it as saved', async () => {
    const fake = fakePort();
    fake.state.value = storedRecord();
    const store = createConnectionStore(ports(fake.port).value);

    assert.equal(store.getState().phase.kind, 'loading');
    await store.getState().hydrate();

    const { phase } = store.getState();
    assert.equal(phase.kind, 'active');
    assert.deepEqual(phase.session.connection.storage, { kind: 'saved' });
    assert.equal(phase.session.connection.connectionId, 'stored-id');
    // The key reached the transport and nothing else.
    assert.equal(JSON.stringify(phase.session.connection).includes('stored-key'), false);
  });

  it('tells an empty keychain from one it could not read', async () => {
    const empty = fakePort();
    const emptyStore = createConnectionStore(ports(empty.port).value);
    await emptyStore.getState().hydrate();
    assert.equal(emptyStore.getState().phase.kind, 'absent');

    const corrupt = fakePort();
    corrupt.state.value = '{';
    const corruptStore = createConnectionStore(ports(corrupt.port).value);
    await corruptStore.getState().hydrate();
    assert.equal(corruptStore.getState().phase.kind, 'unreadable');

    const broken = fakePort();
    broken.faults.get = 'the keychain is locked';
    const brokenStore = createConnectionStore(ports(broken.port).value);
    await brokenStore.getState().hydrate();
    assert.deepEqual(
      { kind: brokenStore.getState().phase.kind, problem: brokenStore.getState().phase.problem },
      { kind: 'unreadable', problem: 'failed' },
    );
  });

  it('runs once however many callers ask', async () => {
    const fake = fakePort();
    fake.state.value = storedRecord();
    const store = createConnectionStore(ports(fake.port).value);

    await Promise.all([
      store.getState().hydrate(),
      store.getState().hydrate(),
      store.getState().hydrate(),
    ]);

    assert.equal(fake.state.log.filter((entry) => entry === 'get').length, 1);
  });

  it('a stored connection naming an address the transport refuses is reported, not left loading', async () => {
    const fake = fakePort();
    fake.state.value = storedRecord();
    const store = createConnectionStore(
      ports(fake.port, {
        createTransport: () => ({ ok: false, message: 'That address cannot carry a credential.' }),
      }).value,
    );

    await store.getState().hydrate();

    const { phase } = store.getState();
    assert.equal(phase.kind, 'unreadable', 'not a spinner with nothing to press');
    assert.match(phase.message, /cannot carry a credential/);
  });

  it('a read that lands after a disconnect does not reactivate anything', async () => {
    const fake = fakePort();
    fake.state.value = storedRecord();
    const store = createConnectionStore(ports(fake.port).value);

    const release = fake.hold('get');
    const hydrating = store.getState().hydrate();
    // The person gives up waiting and disconnects while the keychain is still being read.
    const disconnecting = store.getState().disconnect();
    release();
    await Promise.all([hydrating, disconnecting]);

    assert.equal(store.getState().phase.kind, 'absent');
  });

  it('a read that lands after a connection does not replace it', async () => {
    const fake = fakePort();
    fake.state.value = storedRecord();
    const store = createConnectionStore(ports(fake.port).value);

    const release = fake.hold('get');
    const hydrating = store.getState().hydrate();
    const establishing = store.getState().establish(OTHER);
    release();
    await Promise.all([hydrating, establishing]);

    assert.equal(store.getState().phase.session.connection.base, OTHER.base);
  });
});

describe('establishing a connection', () => {
  it('persists before it switches, and reports what it stored', async () => {
    const fake = fakePort();
    const wired = ports(fake.port);
    const store = createConnectionStore(wired.value);
    await store.getState().hydrate();

    const outcome = await store.getState().establish(SERVER);

    assert.deepEqual(outcome, { kind: 'activated' });
    assert.deepEqual(store.getState().phase.session.connection.storage, { kind: 'saved' });
    assert.equal(decodeRecord(fake.state.value).record.apiKey, SERVER.apiKey);
    assert.equal(wired.retired.count, 1);
  });

  it('connects anyway when there was nothing to lose and the write refused', async () => {
    const fake = fakePort();
    fake.faults.set = 'the keychain is full';
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();

    const outcome = await store.getState().establish(SERVER);

    assert.deepEqual(outcome, { kind: 'activated' });
    assert.deepEqual(store.getState().phase.session.connection.storage, {
      kind: 'write_failed',
      message: 'the keychain is full',
    });
  });

  it('keeps a working connection when a replacement cannot be stored', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();
    await store.getState().establish(SERVER);

    fake.faults.set = 'the keychain is full';
    const outcome = await store.getState().establish(OTHER);

    assert.equal(outcome.kind, 'replace_not_saved');
    // The old connection is still the live one, and still the stored one.
    assert.equal(store.getState().phase.session.connection.base, SERVER.base);
    assert.equal(decodeRecord(fake.state.value).record.base, SERVER.base);
  });

  it('keeps its identity when only the key changes, and takes a new one for a new address', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();

    await store.getState().establish(SERVER);
    const first = store.getState().phase.session.connection.connectionId;

    await store.getState().establish({ ...SERVER, apiKey: 'rotated' });
    const rotated = store.getState().phase.session;
    assert.equal(rotated.connection.connectionId, first, 'a rotation keeps the identity');
    assert.notEqual(rotated.activation, 1, 'but it is still new work');

    await store.getState().establish(OTHER);
    assert.notEqual(store.getState().phase.session.connection.connectionId, first);
  });

  it('replaces a historical numeric version with the date, without minting a new identity', async () => {
    const fake = fakePort();
    fake.state.value = storedRecord();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();

    const hydrated = store.getState().phase.session.connection;
    assert.equal(hydrated.protocolVersion, LEGACY_PROTOCOL_VERSION);

    // Verifying the same address again is not a new server. The stored version moves forward because
    // a fresh verification established it, and the local identity stays put because the address did.
    await store.getState().establish(SERVER);

    const session = store.getState().phase.session;
    assert.equal(session.connection.protocolVersion, PROTOCOL_VERSION);
    assert.equal(session.connection.connectionId, 'stored-id');
    assert.equal(decodeRecord(fake.state.value).record.protocolVersion, PROTOCOL_VERSION);
  });

  it('every switch is a new activation, and every switch retires the caches', async () => {
    const fake = fakePort();
    const wired = ports(fake.port);
    const store = createConnectionStore(wired.value);
    await store.getState().hydrate();

    await store.getState().establish(SERVER);
    const first = store.getState().phase.session.activation;
    await store.getState().establish(OTHER);
    const second = store.getState().phase.session.activation;

    assert.equal(second, first + 1);
    assert.equal(wired.retired.count, 2);
  });

  it('a write overtaken by a newer decision writes nothing', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();

    // Two connections decided in quick succession. The first is still queued when the second
    // arrives, so it must never reach the keychain - not even to be overwritten a moment later.
    const release = fake.hold('set');
    const first = store.getState().establish(SERVER);
    const second = store.getState().establish(OTHER);
    release();

    assert.deepEqual(await first, { kind: 'superseded' });
    assert.deepEqual(await second, { kind: 'activated' });
    assert.equal(decodeRecord(fake.state.value).record.base, OTHER.base);
    assert.equal(store.getState().phase.session.connection.base, OTHER.base);
  });

  it('a write overtaken by a disconnect leaves the keychain empty', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();

    const release = fake.hold('set');
    const establishing = store.getState().establish(SERVER);
    const disconnecting = store.getState().disconnect();
    release();
    await Promise.all([establishing, disconnecting]);

    assert.equal(fake.state.value, null);
    assert.equal(store.getState().phase.kind, 'absent');
  });

  it('a write already inside the keychain still cannot reactivate after a disconnect', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();

    // The case the queue alone does not cover. Once a write has entered the keychain it will
    // finish, so dropping queued work is not enough - the decision waiting on it has to notice it
    // is no longer the one in charge. Without that the app ended up live against a server whose
    // record the following delete had just removed.
    const release = fake.hold('set');
    const establishing = store.getState().establish(SERVER);
    await release.started;
    const disconnecting = store.getState().disconnect();
    release();

    assert.deepEqual(await establishing, { kind: 'superseded' });
    await disconnecting;
    assert.equal(store.getState().phase.kind, 'absent');
    assert.equal(fake.state.value, null);
  });
});

describe('disconnecting', () => {
  it('drops the session content and leaves the warning where a screen can still show it', async () => {
    const fake = fakePort();
    const wired = ports(fake.port);
    const store = createConnectionStore(wired.value);
    await store.getState().hydrate();
    await store.getState().establish(SERVER);
    const { connectionId } = store.getState().phase.session.connection;

    fake.faults.remove = 'the keychain is locked';
    const outcome = await store.getState().disconnect();

    assert.equal(outcome.kind, 'still_stored');
    assert.deepEqual(wired.forgotten, [connectionId]);
    // The screen that asked is unmounted the moment the phase changes, so the warning has to
    // outlive it. Returned-and-forgotten was how a credential could stay on the device in silence.
    assert.deepEqual(store.getState().phase, {
      kind: 'absent',
      removalProblem: 'the keychain is locked',
    });
  });

  it('a retried deletion clears the warning when it works', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();
    await store.getState().establish(SERVER);

    fake.faults.remove = 'the keychain is locked';
    await store.getState().disconnect();
    assert.notEqual(store.getState().phase.removalProblem, null);

    fake.faults.remove = null;
    assert.deepEqual(await store.getState().retryRemoval(), { kind: 'removed' });
    assert.deepEqual(store.getState().phase, { kind: 'absent', removalProblem: null });
    assert.equal(fake.state.value, null);
  });

  it('a retried deletion that arrives after a new connection changes nothing', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();
    await store.getState().establish(SERVER);
    fake.faults.remove = 'the keychain is locked';
    await store.getState().disconnect();

    const release = fake.hold('remove');
    const retrying = store.getState().retryRemoval();
    await release.started;
    // Not awaited before the release: the new connection's write queues behind the held delete, so
    // waiting for it here would deadlock the test rather than test anything.
    const establishing = store.getState().establish(OTHER);
    release();

    assert.deepEqual(await retrying, { kind: 'superseded' });
    await establishing;
    assert.equal(store.getState().phase.kind, 'active');
    assert.equal(decodeRecord(fake.state.value).record.base, OTHER.base);
  });

  it('reports a clean removal as one', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();
    await store.getState().establish(SERVER);

    assert.deepEqual(await store.getState().disconnect(), { kind: 'removed' });
    assert.equal(fake.state.value, null);
  });

  it('leaves session content alone when the connection merely changes', async () => {
    const fake = fakePort();
    const wired = ports(fake.port);
    const store = createConnectionStore(wired.value);
    await store.getState().hydrate();
    await store.getState().establish(SERVER);
    await store.getState().establish({ ...SERVER, apiKey: 'rotated' });

    assert.deepEqual(wired.forgotten, [], 'a rotation keeps what was captured under it');
  });
});

describe('connection-level refusals', () => {
  it('are recorded for the current connection and ignored from an older one', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();
    await store.getState().establish(SERVER);

    const stale = store.getState().phase.session.activation;
    await store.getState().establish(OTHER);
    const current = store.getState().phase.session.activation;

    // A 401 from the server that was just replaced arrives now. Believing it would mark a brand
    // new connection as refused on the strength of the old one's answer.
    store.getState().noteRejection(stale, 'unauthorized');
    assert.equal(store.getState().phase.rejection, null);

    store.getState().noteRejection(current, 'unauthorized');
    assert.equal(store.getState().phase.rejection, 'unauthorized');

    store.getState().clearRejection();
    assert.equal(store.getState().phase.rejection, null);
  });

  it('never delete the stored credential', async () => {
    const fake = fakePort();
    const store = createConnectionStore(ports(fake.port).value);
    await store.getState().hydrate();
    await store.getState().establish(SERVER);

    store.getState().noteRejection(store.getState().phase.session.activation, 'unauthorized');

    assert.equal(decodeRecord(fake.state.value).ok, true);
    assert.equal(store.getState().phase.kind, 'active');
  });
});

describe('a platform with no secure storage', () => {
  it('is not a failed write, and never leaves the app claiming the key was saved', async () => {
    const store = createConnectionStore(ports({ kind: 'unsupported' }).value);

    await store.getState().hydrate();
    assert.equal(store.getState().phase.kind, 'absent');

    await store.getState().establish(SERVER);
    assert.deepEqual(store.getState().phase.session.connection.storage, { kind: 'unsupported' });
  });
});

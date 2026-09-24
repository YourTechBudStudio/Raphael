/**
 * An edit owner over real SQLite, with a server model that behaves like the real one.
 *
 * Two things here are deliberately *not* stubs. The store is genuine SQLite through the same port
 * the app uses, so every guard on `entity_edits` is actually enforced. And the server model
 * **normalizes** - it trims titles, NFC-normalizes tags and reorders them the way `resultingTags`
 * does, and it refuses a stale revision - because the one failure mode the autosave loop can have is
 * to diff against a normalized echo forever, and a server model that echoed submissions back
 * verbatim could never show it.
 *
 * Time is injected. Both timers - the autosave debounce and the protection core's flush deadline -
 * come through `setTimer`, so a test fires them rather than waiting for them.
 */

import { normalizeTag } from '@raphael/contracts/nodes';

import { createEditOwner } from '../../src/modules/capture/edit-owner.ts';
import { editKeyOf } from '../../src/modules/capture/edit-types.ts';
import { openCaptureStore } from '../../src/modules/capture/store.ts';
import { entity, T0 } from './capture-harness.mjs';
import { openNodeDatabase } from './node-sqlite.mjs';

export { documentWith, entity, tick, until, T0 } from './capture-harness.mjs';

export const SESSION = {
  activation: 1,
  connectionId: 'c1',
  endpoint: 'https://raphael.example',
  transport: { endpoint: 'https://raphael.example' },
  usable: true,
};

/** A well-formed client failure, in the shape `@raphael/client` produces. */
export const clientFailure = (kind, code, mutationOutcome, details = {}) => ({
  ok: false,
  failure: {
    kind,
    ...(code === null ? {} : { error: { code }, status: 409, details }),
    message: 'the server said no',
    mutationOutcome,
  },
});

/**
 * A server that holds one entity and applies the contract's own rules to an update.
 *
 * `hold()` makes the next answer wait, so a test can have a request genuinely in the air. `lose()`
 * makes the next answer never arrive as an answer: the update is applied and the caller is told
 * nothing definite, which is the case reconciliation exists for. Both apply to a move as well.
 *
 * A move follows core's rules for an explicit parent: a stale revision is refused, and a request for
 * the parent the entity already has with no new slug writes nothing and keeps the revision.
 */
export const serverModel = (seed = {}) => {
  let held = entity(seed);
  const pending = [];
  const model = {
    entity: () => held,
    set: (over) => {
      held = { ...held, ...over };
    },
    /** Apply a write the way a third party would: a new revision nobody on this phone asked for. */
    writeBehind: (over) => {
      held = { ...held, ...over, revision: held.revision + 1 };
    },
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    holding: () => pending.length,
    hold: false,
    lose: false,
    gets: 0,
    /** Every Get request, as sent. The one field whose omission fails silently is asserted on it. */
    getRequests: [],
    updates: [],
    /** Every move request, as sent. */
    moves: [],
    /** A definite answer the next move gets instead of being applied, then cleared. */
    moveFailure: null,
    getFailure: null,
  };

  const wait = async () => {
    if (!model.hold) return;
    await new Promise((resolve) => pending.push(resolve));
  };

  model.get = async (request) => {
    model.gets += 1;
    model.getRequests.push(request);
    await wait();
    if (model.getFailure !== null) return model.getFailure;

    return { ok: true, value: { entity: { ...held } } };
  };

  model.update = async (request) => {
    model.updates.push(request);
    await wait();

    if (request.revision !== held.revision) {
      return clientFailure('api_error', 'revision_conflict', 'rejected', {
        currentRevision: held.revision,
      });
    }

    const next = { ...held, revision: held.revision + 1 };

    if (request.title !== undefined) next.title = request.title.trim();
    if (request.description !== undefined) next.description = request.description;
    if (request.slug !== undefined) next.slug = request.slug;
    if (request.body !== undefined) next.body = { format: 'tiptap', value: request.body.value };

    const removed = new Set((request.removeTags ?? []).map(normalizeTag));
    const kept = held.tags.filter((tag) => !removed.has(tag));
    const added = (request.addTags ?? []).map(normalizeTag).filter((tag) => !kept.includes(tag));

    next.tags = [...kept, ...added];
    held = next;

    // Applied, and the caller is told nothing. Exactly a post-commit response loss.
    if (model.lose) {
      model.lose = false;

      return clientFailure('transport', null, 'unknown');
    }

    return { ok: true, value: { entity: { ...held } } };
  };

  /** A move publishes a summary: the entity without its body or metadata. */
  const summaryOf = ({ body: _body, metadata: _metadata, ...summary }) => summary;

  model.move = async (request) => {
    model.moves.push(request);
    await wait();

    if (model.moveFailure !== null) {
      const failure = model.moveFailure;

      model.moveFailure = null;

      return failure;
    }

    if (request.revision !== held.revision) {
      return clientFailure('api_error', 'revision_conflict', 'rejected', {
        currentRevision: held.revision,
      });
    }

    const { parent, slug } = request.destination;
    const parentId = parent.path === '/' ? null : parent.id;

    if (parentId !== held.parentId || (slug !== undefined && slug !== held.slug)) {
      held = { ...held, parentId, slug: slug ?? held.slug, revision: held.revision + 1 };
    }

    if (model.lose) {
      model.lose = false;

      return clientFailure('transport', null, 'unknown');
    }

    return { ok: true, value: { node: summaryOf(held) } };
  };

  return model;
};

export const editHarness = async (options = {}) => {
  const db = await openNodeDatabase(options.file ?? ':memory:');
  const opened = await openCaptureStore(db, () => T0);

  if (opened.kind !== 'ready') throw new Error(`store ${opened.kind}`);

  const server = options.server ?? serverModel();
  const timers = new Map();
  const applied = [];
  let handles = 0;
  let closed = false;

  const owner = createEditOwner({
    openStore: async () => ({
      kind: 'ready',
      store: {
        ...opened.store,
        // A seam for the one case the guards exist for: a writer that answers with a row at some
        // other version than the one it was asked to write.
        ...(options.store === undefined ? {} : options.store(opened.store)),
        // The shared lifetime makes a second close a no-op; here the file outlives the owner so a
        // test can reopen it and prove what survived a process death.
        close: async () => {
          closed = true;
        },
      },
    }),
    get: (_transport, request) => server.get(request),
    update: (_transport, request) => server.update(request),
    move: (_transport, request) => server.move(request),
    now: () => T0,
    applyUpdate: async (ref, activation) => {
      applied.push({ ref, activation });
    },
    sessionIsCurrent: options.sessionIsCurrent ?? ((session) => session.activation === 1),
    /**
     * A zero-delay timer is "the next turn", so it runs by itself; everything else waits to be fired.
     *
     * The owner uses a zero delay to chain a further send after an acknowledgement rather than
     * recursing into a promise the caller is still awaiting. Making a test fire that by hand would be
     * testing the implementation's turn structure, not its behaviour.
     */
    setTimer: (run, ms) => {
      handles += 1;

      const handle = handles;

      if (ms === 0) {
        const immediate = setImmediate(() => {
          if (timers.delete(handle)) run();
        });

        timers.set(handle, { run, ms, immediate });

        return handle;
      }

      timers.set(handle, { run, ms });

      return handle;
    },
    clearTimer: (handle) => {
      const timer = timers.get(handle);

      if (timer?.immediate !== undefined) clearImmediate(timer.immediate);

      return timers.delete(handle);
    },
    autosaveDelayMs: 1500,
    autosaveRetryMs: 10_000,
  });

  return {
    db,
    store: opened.store,
    owner,
    server,
    applied,
    timers,
    wasClosed: () => closed,
    /** Fire every armed timer, as the phone's clock would. */
    fire: () => {
      const armed = [...timers.values()];

      for (const timer of armed) {
        if (timer.immediate !== undefined) clearImmediate(timer.immediate);
      }
      timers.clear();
      for (const timer of armed) timer.run();
    },
    state: () => owner.getState(),
    record: (editKey) =>
      owner.getState().edits.find((candidate) => editKeyOf(candidate.key) === editKey) ?? null,
  };
};

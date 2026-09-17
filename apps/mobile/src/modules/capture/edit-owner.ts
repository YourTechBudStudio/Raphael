/**
 * The one thing that autosaves a change to an existing entity, and the only thing allowed to.
 *
 * `owner.ts`'s sibling, app-scoped for the same reason and answering a different question. The
 * creation owner asks **"did this creation happen, and may its key be replayed"**; this asks **"what
 * does the server hold for this entity, and is my writing ahead of it, behind it, or in conflict with
 * it"**. Neither question is answerable from the other's records, which is why there are two owners
 * over two tables rather than one owner over a widened one - and why the only thing they share is
 * `protection.ts`, which answers a third question that belongs to neither: is what is on screen safely
 * on this phone.
 *
 * The loop is one sentence: **diff the local writing against a stored base, send only a version the
 * store has confirmed, and make the base what was sent - never what the server echoed back.**
 *
 * Every clause carries weight.
 *
 * *Diff against a stored base* - so an update names exactly what changed, and two clients that added
 * different tags to the same entity both keep their tag.
 *
 * *Only a committed version* - `core.committed()` hands back the content whose write the store
 * confirmed, paired with that write's own version number. `core.content()` is the latest *accepted*
 * one, which may still be in memory, and it never reaches the wire. A request carrying content the
 * phone has not managed to keep would report writing as on the server that a process death would take.
 *
 * *The base is what was sent* - the server normalizes, and a base re-seeded from its echo while the
 * editor keeps its own form would diff as changed after every acknowledgement, forever. This is the
 * anti-loop rule and it is `edit-envelope.ts`'s whole subject.
 *
 * There is no idempotency key, no replay and no retry after a verdict. An update's safety is the
 * revision it names: the server's compare-and-set either applies the change to that exact version or
 * refuses it, and a refusal is a fact to be reported rather than a thing to try again.
 */

import type { ClientFailure, ClientResult } from '@raphael/client';
import {
  isRequestField,
  type GetRequestInput,
  type GetResponse,
  type NodeType,
  type UpdateRequestInput,
  type UpdateResponse,
} from '@raphael/contracts/nodes';
import { create as createStore } from 'zustand';

import type { Transport } from '../../infrastructure/api/transport';
import type { EditorPort, EditorSnapshot } from '../editor';
import { applyEnvelope, contentOf, diff, matchesSubmitted } from './edit-envelope.ts';
import { editStandingOf, type EditStanding } from './edit-policy.ts';
import {
  editKeyOf,
  type EditContent,
  type EditKey,
  type EditProblem,
  type EditRefusal,
  type EntityEditRecord,
  type UnusableEdit,
} from './edit-types.ts';
import type { ActionOutcome, CaptureSession, StoreProblem } from './owner.ts';
import {
  createProtection,
  FLUSH_TIMEOUT_MS,
  type AttachmentToken,
  type DraftProtection,
  type FlushResult,
  type SnapshotResult,
} from './protection.ts';
import type { CaptureStore, OpenOutcome, StoredEdits } from './store.ts';
import { sameTags } from './tags.ts';

/** How long typing settles before a version is sent. Long enough that a sentence is one update. */
export const AUTOSAVE_DELAY_MS = 1500;
/** How long an unresolved send waits before the entity is read back. Only while an editor is attached. */
export const AUTOSAVE_RETRY_MS = 10_000;

/**
 * How leaving the editor ended.
 *
 * Three answers, and the person is held on the screen until one of them is true, because the rule for
 * this screen is that going back is allowed once the writing is on the server **or** it is known that
 * it cannot get there right now. `kept` is the second half of that sentence and it is always a
 * definite reason - a conflict, a refusal, or no connection - never "it has not finished".
 *
 * `unconfirmed` is the one fall-through: a send whose answer was lost, and the one reconciliation the
 * exit is allowed also failed. Holding the person there would not teach the phone anything, the record
 * survives, and Recovery lists it.
 */
export type LeaveOutcome = 'settled' | 'kept' | 'unconfirmed';

/**
 * Where the entity sits, as far as this open could establish.
 *
 * Two facts that a bare `parentId: number | null` would merge, and the eyebrow draws them
 * differently: a root-level container genuinely has no parent and reads "Areas", while an entity
 * whose Get failed has a parent this phone could not learn and must name no location at all.
 * Collapsing them would make an unreachable server quietly claim a note lives at the root.
 *
 * It comes from the entity the owner's own Get read, never from a second query - the screen mounts
 * no query for the entity it edits, and this is what keeps that true while the eyebrow still has
 * something to name.
 */
export type EditLocation =
  | { readonly kind: 'known'; readonly parentId: number | null }
  | { readonly kind: 'unknown' };

export type EditOpenOutcome =
  | { readonly kind: 'ready'; readonly editKey: string; readonly location: EditLocation }
  /** A retained row this build cannot open. The screen names the problem and offers Discard. */
  | { readonly kind: 'unusable'; readonly editKey: string; readonly problem: EditProblem }
  /**
   * `failure` is the Get's own failure. Null means the app itself could not ask: no store, no usable
   * session, a body this build cannot open, or a local write that failed.
   */
  | { readonly kind: 'unavailable'; readonly failure: ClientFailure | null };

/** What the owner needs from the world. Everything platform-shaped, so a test can drive all of it. */
export interface EditPorts {
  openStore(): Promise<OpenOutcome>;
  get(transport: Transport, request: GetRequestInput): Promise<ClientResult<GetResponse>>;
  update(transport: Transport, request: UpdateRequestInput): Promise<ClientResult<UpdateResponse>>;
  /** Wall clock. */
  now(): number;
  /**
   * The cache consequence of an editing session that acknowledged something, fenced by the activation
   * it was made under. A failure here is a failed refresh, never a failed save.
   */
  applyUpdate(
    ref: { readonly type: NodeType; readonly id: number },
    activation: number,
  ): Promise<void>;
  /**
   * Whether this session is the one the app is working under right now. The same question - and the
   * same answer - as `CapturePorts.sessionIsCurrent`, for the same reasons.
   */
  sessionIsCurrent(session: CaptureSession): boolean;
  readonly autosaveDelayMs?: number | undefined;
  readonly autosaveRetryMs?: number | undefined;
  readonly flushTimeoutMs?: number | undefined;
  setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((handle: unknown) => void) | undefined;
}

export interface EditState {
  readonly status: 'idle' | 'opening' | 'ready' | 'unavailable';
  /** Why the store is unavailable. Never a reason to fall back to memory. */
  readonly problem: StoreProblem | null;
  readonly edits: readonly EntityEditRecord[];
  readonly unusableEdits: readonly UnusableEdit[];
  /** Edit keys with a request in the air from this process. */
  readonly sending: readonly string[];
  /** Edit keys being reconciled by a Get. */
  readonly checking: readonly string[];
  readonly protection: Readonly<Record<string, DraftProtection>>;

  initialize(): Promise<void>;
  retryOpen(): Promise<void>;
  close(): Promise<void>;

  /**
   * Open one entity for editing, and **always resolve**.
   *
   * Every way this can go wrong is an `EditOpenOutcome`, never a rejection. The screen has one place
   * to render an answer and no place to render the absence of one, so a rejection here would leave it
   * on its opening skeleton indefinitely with nothing said about why.
   */
  open(nodeId: number, session: CaptureSession): Promise<EditOpenOutcome>;
  /** The screen's current session, so the loop dispatches under the live one. Re-runs the tick. */
  resume(editKey: string, session: CaptureSession): void;
  editFields(
    editKey: string,
    fields: Partial<Pick<EditContent, 'title' | 'description' | 'slug' | 'tags'>>,
  ): void;
  attachEditor(editKey: string, port: EditorPort): AttachmentToken | null;
  detachEditor(token: AttachmentToken): void;
  snapshotAccepted(token: AttachmentToken, snapshot: EditorSnapshot): SnapshotResult;
  flush(editKey: string, options?: { lock?: boolean }): Promise<FlushResult>;
  beginControlledExit(editKey: string): Promise<{ result: FlushResult; release: () => void }>;
  /** Leaving: see `LeaveOutcome`. Resolves only once one of its three answers is true. */
  leave(editKey: string): Promise<LeaveOutcome>;
  /** Works for a usable and an unusable record alike; both are deleted by key. */
  discardChanges(editKey: string): Promise<ActionOutcome>;
  standingFor(editKey: string): EditStanding | null;
}

const SENDING_PROBLEM = 'This change is being sent. Wait for an answer before discarding it.';
const NO_RECORD_PROBLEM = 'There is nothing here to discard.';
const NO_STORE_PROBLEM = 'This phone cannot open its local storage right now.';

/**
 * A refusal, as the record keeps it.
 *
 * `code` is the server's own classified code where there is an error envelope, and the failure's kind
 * otherwise - so `invalid_request`, which never reaches a server, is still nameable. `field` and
 * `reason` come from the validated recovery details and from nowhere else; a decoder's message is not
 * something a person should read.
 */
const refusalOf = (failure: ClientFailure, at: number): EditRefusal => {
  const details = failure.kind === 'api_error' ? failure.details : {};
  const field = details.field;

  return {
    code: failure.kind === 'api_error' ? failure.error.code : failure.kind,
    field: field !== undefined && isRequestField(field) ? field : null,
    reason: details.reason ?? null,
    at,
  };
};

/**
 * What this open could establish about where the entity sits.
 *
 * A Get that failed leaves the location unknown rather than null, because a record opened over local
 * content is still perfectly editable and the eyebrow must say nothing rather than say "Areas".
 */
const locationOf = (result: ClientResult<GetResponse>): EditLocation =>
  result.ok ? { kind: 'known', parentId: result.value.entity.parentId } : { kind: 'unknown' };

export const createEditOwner = (ports: EditPorts) =>
  createStore<EditState>((set, get) => {
    let store: CaptureStore | null = null;

    /** The sessions the screens are working under, one per open record. */
    const sessions = new Map<string, CaptureSession>();
    /** The structured key behind each tracked edit key, so nothing ever parses the string apart. */
    const keys = new Map<string, EditKey>();
    const timers = new Map<string, unknown>();
    /** Edit keys with an update in the air from this process. */
    const sending = new Set<string>();
    /** Edit keys with a reconciling Get in the air. */
    const checking = new Set<string>();
    /**
     * Edit keys that received at least one acknowledgement in this process and whose cache
     * consequence has not been applied yet. One consequence per editing session, not per
     * acknowledgement: opening an entity and backing out without a change refetches nothing.
     */
    const acknowledged = new Set<string>();

    /**
     * The send and the reconciliation currently in the air, as joinable promises.
     *
     * This is what makes `leave` honest. Without it, an exit 200ms after the debounce fired would find
     * the tick refusing itself for `sending` and resolve immediately - returning from the one case
     * refinement 6 was written for. A caller that arrives while work is in the air joins it rather than
     * starting a second one.
     */
    const ticks = new Map<string, Promise<void>>();
    const checks = new Map<string, Promise<void>>();

    let lifetime = 0;
    let opening: Promise<void> | null = null;

    /**
     * Whether the store a piece of work started against is still the owner's. The store object *is*
     * the lifetime, exactly as in `owner.ts`.
     */
    const current = (active: CaptureStore | null): boolean => active !== null && store === active;

    const setTimer = ports.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer =
      ports.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const flushTimeoutMs = ports.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;
    const autosaveDelayMs = ports.autosaveDelayMs ?? AUTOSAVE_DELAY_MS;
    const autosaveRetryMs = ports.autosaveRetryMs ?? AUTOSAVE_RETRY_MS;

    const publishWorking = (): void => {
      set({ sending: [...sending], checking: [...checking] });
    };

    /**
     * Publish one record the store has just written.
     *
     * From what was written, never from a re-read: a failed refresh would otherwise leave the app
     * holding a row as it was before a success that has already committed.
     */
    const publishRecord = (editKey: string, written: EntityEditRecord | null): void => {
      set((state) => {
        const without = state.edits.filter((record) => editKeyOf(record.key) !== editKey);

        return written === null ? { edits: without } : { edits: [...without, written] };
      });
    };

    const recordOf = (editKey: string): EntityEditRecord | null =>
      get().edits.find((record) => editKeyOf(record.key) === editKey) ?? null;

    /**
     * Everything about whether writing is safely on this phone, and nothing about updating.
     *
     * The same four things the creation owner supplies. The core never learns that any of this is an
     * entity, a base, or a revision.
     */
    const core = createProtection<EditContent>({
      now: () => ports.now(),
      setTimer,
      clearTimer,
      flushTimeoutMs,
      documentOf: (content) => content.document,
      withDocument: (content, document) => ({ ...content, document }),
      /**
       * One accepted version, persisted and published.
       *
       * The version is reported back **only when the row actually carries it**. This table's writers
       * return the row whether or not their guard matched, so a coalesced write that lost a race comes
       * back as a row at some other version - and reporting that number would install the bytes of the
       * write that lost under the version of the write that won. The core pairs committed bytes with
       * the committed number deliberately, and only this port can keep that promise.
       */
      writeVersion: async (editKey, content, version, at) => {
        const active = store;
        const key = keys.get(editKey);

        if (active === null || key === undefined) return null;

        const record = await active.writeEditVersion({ key, content, draftVersion: version, at });

        if (!current(active)) return null;
        if (record !== null) publishRecord(editKey, record);

        return record?.draftVersion === version ? version : null;
      },
      publish: (editKey, protection) => {
        set((state) => {
          if (protection === null) {
            const { [editKey]: _removed, ...rest } = state.protection;

            return { protection: rest };
          }

          return { protection: { ...state.protection, [editKey]: protection } };
        });
      },
    });

    /** Whether there is a live session on this record's own connection able to send for it. */
    const sessionUsableFor = (editKey: string, key: EditKey): boolean => {
      const session = sessions.get(editKey);

      return (
        session !== undefined &&
        ports.sessionIsCurrent(session) &&
        session.usable &&
        session.connectionId === key.connectionId
      );
    };

    const standingOf = (editKey: string): EditStanding | null => {
      const record = recordOf(editKey);

      if (record === null) return null;

      return editStandingOf({
        record,
        committedVersion: core.committed(editKey)?.version ?? record.draftVersion,
        sending: sending.has(editKey),
        sessionUsable: sessionUsableFor(editKey, record.key),
      });
    };

    const cancelTimer = (editKey: string): void => {
      const handle = timers.get(editKey);

      if (handle === undefined) return;
      clearTimer(handle);
      timers.delete(editKey);
    };

    /**
     * What a record's one timer does when it fires.
     *
     * A record with an envelope in the air needs the entity read back; one without needs what changed
     * sent. They are different jobs and there is exactly one timer per record, so the timer asks which
     * is owed rather than the callers having to remember - and a retry armed for a lost answer cannot
     * fire a send that would refuse itself for the very envelope it is waiting on.
     */
    const resumeWork = (editKey: string): void => {
      const record = recordOf(editKey);

      if (record !== null && record.inflightVersion !== null) {
        void reconcile(editKey);

        return;
      }

      void tick(editKey);
    };

    const scheduleTick = (editKey: string, delayMs: number): void => {
      cancelTimer(editKey);
      timers.set(
        editKey,
        setTimer(() => {
          timers.delete(editKey);
          resumeWork(editKey);
        }, delayMs),
      );
    };

    /**
     * The cache consequence of this editing session, at most once.
     *
     * Gated on an acknowledgement rather than on the record settling, so opening an entity and backing
     * out refetches nothing while a session that acknowledged twice and then hit a conflict still
     * refreshes what it changed. Never awaited: a refresh is a consequence of a save, and consequences
     * do not gate verdicts. The activation may well be a retired one - `applyUpdate` is fenced by it
     * and will then invalidate nothing, which is the correct outcome rather than a missed one.
     */
    const consequence = (editKey: string): void => {
      if (!acknowledged.has(editKey)) return;

      const record = recordOf(editKey);
      const session = sessions.get(editKey);

      acknowledged.delete(editKey);
      if (record === null || session === undefined) return;

      void ports
        .applyUpdate({ type: record.nodeType, id: record.key.nodeId }, session.activation)
        .catch(() => {
          // A failed refresh, never a failed save. The next ordinary read corrects a stale screen.
        });
    };

    /**
     * Forget a record that is entirely on the server.
     *
     * Guarded on the committed version not being ahead of the acknowledged one. Nothing reachable calls
     * this with unsent writing, and that guard is why: deleting the row is the one operation here that
     * cannot be undone, so it refuses rather than trusting its callers to have checked.
     */
    const forget = async (editKey: string): Promise<void> => {
      const active = store;
      const record = recordOf(editKey);
      const key = keys.get(editKey);

      if (active === null || record === null || key === undefined) return;
      // `?? record.draftVersion`, not `?? 0`: a row's own `draft_version` is committed by definition
      // of being in the row, so "the core is not tracking this" has to read as "there may be unsent
      // writing" and refuse. Defaulting to zero would make the one guard against an irreversible
      // delete trust precisely the case where it knows nothing - and it would disagree with
      // `standingOf`, which asks the same question of the same entry and already defaults this way.
      if ((core.committed(editKey)?.version ?? record.draftVersion) > record.acknowledgedVersion) {
        return;
      }
      if (record.inflightVersion !== null || record.syncState !== 'syncing') return;

      cancelTimer(editKey);

      try {
        await active.deleteEdit(key);
      } catch {
        // The record stays and Recovery lists it. Retaining is the only direction that loses nothing.
        return;
      }

      if (!current(active)) return;
      core.untrack(editKey);
      keys.delete(editKey);
      sessions.delete(editKey);
      publishRecord(editKey, null);
    };

    /**
     * Start a record for an entity this phone is not already editing.
     *
     * Both of `open`'s paths end here: an entity opened for the first time, and one whose reconciled
     * session settled and was forgotten inside the very call that reconciled it.
     */
    const seed = async (
      active: CaptureStore,
      key: EditKey,
      editKey: string,
      session: CaptureSession,
      result: ClientResult<GetResponse>,
    ): Promise<EditOpenOutcome> => {
      if (!result.ok) return { kind: 'unavailable', failure: result.failure };

      const entity = result.value.entity;
      const content = contentOf(entity);

      if (content === null) return { kind: 'unavailable', failure: null };

      let seeded: EntityEditRecord | null;

      try {
        seeded = await active.insertEdit({
          key,
          endpoint: session.endpoint,
          nodeType: entity.type,
          kind: entity.kind,
          content,
          revision: entity.revision,
          at: ports.now(),
        });
      } catch {
        return { kind: 'unavailable', failure: null };
      }

      if (!current(active)) return { kind: 'unavailable', failure: null };
      if (seeded === null) return { kind: 'unavailable', failure: null };

      keys.set(editKey, key);
      core.track(editKey, seeded.content, seeded.draftVersion);
      publishRecord(editKey, seeded);
      sessions.set(editKey, session);
      // Seeding usually has nothing to send, but `insertEdit` hands back an existing row rather than
      // throwing, and that row may hold writing this process has not seen yet.
      scheduleTick(editKey, autosaveDelayMs);

      return { kind: 'ready', editKey, location: locationOf(result) };
    };

    /**
     * An acknowledgement has landed and been written down.
     *
     * Two consequences, in this order: send again at once if the person has written more since the
     * envelope left, and otherwise, if no editor is attached, this session is over - which is the
     * background flush and the process-death path, and the only way a record settles with nobody
     * looking at it.
     */
    const afterAcknowledgement = async (editKey: string): Promise<void> => {
      acknowledged.add(editKey);

      const record = recordOf(editKey);

      if (record === null) return;

      if ((core.committed(editKey)?.version ?? 0) > record.acknowledgedVersion) {
        // A new turn rather than a recursive call: this one is still inside the promise `leave` and
        // every other joiner is awaiting, and a chain that awaited itself would never resolve.
        scheduleTick(editKey, 0);

        return;
      }

      if (core.attached(editKey)) return;

      consequence(editKey);
      await forget(editKey);
    };

    /**
     * Apply the four reconciliation rules to an entity that has just been read.
     *
     * Factored out of `reconcile` so `open` can answer with the entity it already holds. Reading the
     * same entity twice in the recovery path is not merely wasteful: two reads can disagree, and these
     * rules assume one consistent view of the server.
     */
    const applyReconciliation = async (
      editKey: string,
      result: ClientResult<GetResponse>,
    ): Promise<void> => {
      const active = store;
      const record = recordOf(editKey);
      const key = keys.get(editKey);

      if (active === null || record === null || key === undefined) return;

      const envelope = record.inflight;

      if (record.inflightVersion === null || envelope === null) return;

      const at = ports.now();

      if (!result.ok) {
        // A definite refusal of the *read* is a refusal of the change: an entity the server will not
        // show cannot have a change applied against it, and there is nothing further to learn.
        if (result.failure.kind === 'api_error') {
          publishRecord(
            editKey,
            await active.markEditRefused(key, refusalOf(result.failure, at), at),
          );
        }

        // Anything else leaves the record unconfirmed. The standing says so, and the retry timer -
        // while an editor is attached - asks again.
        return;
      }

      const entity = result.value.entity;

      if (entity.revision === record.baseRevision) {
        // Nothing has been written since the base, so the envelope never applied. Clear the mark and
        // let the ordinary loop send it again.
        publishRecord(editKey, await active.clearEditInflight(key, at));
        if (!current(active)) return;
        scheduleTick(editKey, 0);

        return;
      }

      if (matchesSubmitted(entity, envelope, record.base, record.baseRevision)) {
        // Exactly one write since the base, and every field we sent is what the server holds: the
        // write was ours. Acknowledged at the entity's revision, with the base being what was *sent*.
        publishRecord(
          editKey,
          await active.acknowledgeEdit(
            key,
            applyEnvelope(record.base, envelope),
            entity.revision,
            at,
          ),
        );
        if (!current(active)) return;
        await afterAcknowledgement(editKey);

        return;
      }

      // Something else is true of the server than what we sent would have made true. The local writing
      // is kept and the only offered action is to discard it.
      cancelTimer(editKey);
      publishRecord(editKey, await active.markEditConflicted(key, at));
    };

    const runReconcile = async (editKey: string): Promise<void> => {
      const record = recordOf(editKey);
      const session = sessions.get(editKey);

      if (record === null || record.inflightVersion === null) return;
      if (session === undefined || !sessionUsableFor(editKey, record.key)) return;

      checking.add(editKey);
      publishWorking();

      try {
        const result = await ports.get(session.transport, {
          target: { id: record.key.nodeId },
          format: 'tiptap',
        });

        checking.delete(editKey);
        publishWorking();

        await applyReconciliation(editKey, result);

        // Still unresolved, and an editor is there to see it: ask again later. A detached record waits
        // for its next open instead, which bounds background work to nothing.
        if (recordOf(editKey)?.inflightVersion !== null && core.attached(editKey)) {
          scheduleTick(editKey, autosaveRetryMs);
        }
      } finally {
        checking.delete(editKey);
        publishWorking();
      }
    };

    /** One reconciliation at a time per record; a second caller joins the first. */
    const reconcile = (editKey: string): Promise<void> => {
      const running = checks.get(editKey);

      if (running !== undefined) return running;

      const started = runReconcile(editKey).finally(() => {
        if (checks.get(editKey) === started) checks.delete(editKey);
      });

      checks.set(editKey, started);

      return started;
    };

    /**
     * One pass of the autosave loop: what must be sent, sent, and its answer written down.
     *
     * The preconditions are all refusals rather than failures. Every one of them is a state in which
     * sending would either be impossible or would say something untrue - a second envelope in the air,
     * a version the store has not confirmed, a verdict already given, a session the app has moved on
     * from - and none of them is worth reporting, because the next accepted version tries again.
     */
    const runTick = async (editKey: string): Promise<void> => {
      const active = store;
      const record = recordOf(editKey);
      const key = keys.get(editKey);
      const session = sessions.get(editKey);
      const committed = core.committed(editKey);

      if (active === null || record === null || key === undefined || committed === undefined)
        return;
      if (record.syncState !== 'syncing') return;
      if (record.inflightVersion !== null) return;
      if (sending.has(editKey)) return;
      if (committed.version <= record.acknowledgedVersion) {
        // A version has been accepted but the store has not confirmed it yet, so there is nothing
        // this owner may send. Nothing else would re-arm the loop - the debounce is armed by an
        // edit, not by a write - so a write slower than the debounce would leave writing sitting
        // unsent until the next keystroke, under a status line saying it was saving soon. Ask again.
        const protection = core.protectionOf(editKey);

        if (protection?.pending === true || protection?.writing === true) {
          scheduleTick(editKey, autosaveDelayMs);
        }

        return;
      }
      // Writing that is not on this phone must not be reported as being on a server.
      if (core.protectionOf(editKey)?.failedWrite === true) return;
      if (session === undefined || !sessionUsableFor(editKey, key)) return;

      const envelope = diff(record.base, committed.content);

      if (envelope === null) {
        // The escape hatch, and the reason a normalizing server cannot make this spin: nothing differs
        // from what the server was last given, so the version is acknowledged with no request at all.
        publishRecord(
          editKey,
          await active.acknowledgeEditLocally(key, committed.version, ports.now()),
        );

        return;
      }

      // Persisted before it is dispatched, so a process that dies mid-request reconciles on its next
      // open rather than running into a false conflict.
      const written = await active.markEditInflight(key, committed.version, envelope, ports.now());

      if (!current(active)) return;
      if (written === null || written.inflightVersion !== committed.version) return;
      publishRecord(editKey, written);

      sending.add(editKey);
      publishWorking();

      let result: ClientResult<UpdateResponse>;

      try {
        result = await ports.update(session.transport, {
          target: { id: key.nodeId },
          // From the row that was just written, not from the copy read before it: the revision that
          // goes on the wire is the one the durable record carries.
          revision: written.baseRevision,
          ...envelope,
          format: 'tiptap',
        });
      } finally {
        sending.delete(editKey);
        publishWorking();
      }

      if (!current(active)) return;

      const at = ports.now();

      if (result.ok) {
        publishRecord(
          editKey,
          await active.acknowledgeEdit(
            key,
            applyEnvelope(written.base, envelope),
            result.value.entity.revision,
            at,
          ),
        );
        if (!current(active)) return;
        await afterAcknowledgement(editKey);

        return;
      }

      const failure = result.failure;

      if (failure.kind === 'api_error' && failure.error.code === 'revision_conflict') {
        // Terminal for the loop. Nothing local changes, the timer is cancelled and never rescheduled,
        // and the only offered action is to discard.
        cancelTimer(editKey);
        publishRecord(editKey, await active.markEditConflicted(key, at));

        return;
      }

      if (failure.mutationOutcome === 'unknown') {
        // The envelope stays in flight and the record says so. An answer is not guessed at; the entity
        // is read back, and only while an editor is attached.
        if (core.attached(editKey)) scheduleTick(editKey, autosaveRetryMs);

        return;
      }

      // Every other definite refusal. The person fixes the thing the status names, and the next
      // accepted version returns the row to `syncing` inside the store's own guarded write.
      publishRecord(editKey, await active.markEditRefused(key, refusalOf(failure, at), at));
    };

    /** One send at a time per record; a second caller joins the first rather than queueing behind it. */
    const tick = (editKey: string): Promise<void> => {
      const running = ticks.get(editKey);

      if (running !== undefined) return running;

      const started = runTick(editKey).finally(() => {
        if (ticks.get(editKey) === started) ticks.delete(editKey);
      });

      ticks.set(editKey, started);

      return started;
    };

    /** Wait for whatever this record already has in the air, send or reconciliation, in either order. */
    const settleInFlight = async (editKey: string): Promise<void> => {
      for (;;) {
        const running = ticks.get(editKey) ?? checks.get(editKey);

        if (running === undefined) return;
        await running;
      }
    };

    /** Take up what the store holds. An entry this process already has is kept, as `owner.ts` does. */
    const adopt = (stored: StoredEdits): void => {
      for (const record of stored.edits) {
        const editKey = editKeyOf(record.key);

        keys.set(editKey, record.key);
        core.track(editKey, record.content, record.draftVersion);
      }
      for (const record of get().edits) {
        const editKey = editKeyOf(record.key);

        if (!stored.edits.some((candidate) => editKeyOf(candidate.key) === editKey)) {
          core.untrack(editKey);
          keys.delete(editKey);
        }
      }

      set({ edits: stored.edits, unusableEdits: stored.unusableEdits });
    };

    const open = async (): Promise<void> => {
      const generation = lifetime;
      const obsolete = (): boolean => generation !== lifetime;

      set({ status: 'opening', problem: null });

      let outcome: OpenOutcome;

      try {
        outcome = await ports.openStore();
      } catch {
        if (obsolete()) return;
        set({ status: 'unavailable', problem: { kind: 'failed', reason: 'unopenable' } });

        return;
      }

      const release = async (): Promise<void> => {
        if (outcome.kind !== 'ready') return;
        try {
          await outcome.store.close();
        } catch {
          // Closing anyway; a close that also fails changes nothing that can be reported.
        }
      };

      if (obsolete()) {
        await release();

        return;
      }

      if (outcome.kind !== 'ready') {
        set({ status: 'unavailable', problem: outcome });

        return;
      }

      // Strict, exactly as the creation owner's first read is: a database that opens and cannot be
      // read is not a database with nothing in it, and going `ready` with empty lists would say there
      // is nothing unsent about a store that has not answered the question.
      let stored: StoredEdits;

      try {
        stored = await outcome.store.listEdits();
      } catch {
        await release();
        if (obsolete()) return;
        set({ status: 'unavailable', problem: { kind: 'failed', reason: 'unreadable' } });

        return;
      }

      if (obsolete()) {
        await release();

        return;
      }

      store = outcome.store;
      adopt(stored);
      // Nothing is marked and no timer is restored. A record with an envelope in flight reports
      // `unconfirmed` and reconciles on its next open, which bounds background work to nothing.
      set({ status: 'ready', problem: null });
    };

    const ensureOpen = (): Promise<void> => {
      if (get().status === 'ready') return Promise.resolve();
      if (opening !== null) return opening;

      const running = open().finally(() => {
        if (opening === running) opening = null;
      });

      opening = running;

      return running;
    };

    return {
      status: 'idle',
      problem: null,
      edits: [],
      unusableEdits: [],
      sending: [],
      checking: [],
      protection: {},

      initialize: ensureOpen,

      retryOpen: ensureOpen,

      close: async () => {
        lifetime += 1;

        const pending = opening;
        const active = store;

        opening = null;
        store = null;

        for (const handle of timers.values()) clearTimer(handle);
        timers.clear();
        core.close();
        sessions.clear();
        keys.clear();
        sending.clear();
        checking.clear();
        acknowledged.clear();
        ticks.clear();
        checks.clear();

        set({
          status: 'idle',
          problem: null,
          edits: [],
          unusableEdits: [],
          sending: [],
          checking: [],
          protection: {},
        });

        if (pending !== null) {
          try {
            await pending;
          } catch {
            // A failed open has nothing to close.
          }
        }

        if (active !== null) {
          try {
            await active.close();
          } catch {
            // The owner is gone and there is nothing left to tell.
          }
        }
      },

      open: async (nodeId, session) => {
        const active = store;

        if (active === null) return { kind: 'unavailable', failure: null };
        if (!ports.sessionIsCurrent(session) || !session.usable) {
          return { kind: 'unavailable', failure: null };
        }

        const key: EditKey = { connectionId: session.connectionId, nodeId };
        const editKey = editKeyOf(key);

        // A row this build cannot open is named without any request at all. It stays until discarded.
        const unusable = get().unusableEdits.find(
          (candidate) => editKeyOf(candidate.key) === editKey,
        );

        if (unusable !== undefined) {
          return { kind: 'unusable', editKey, problem: unusable.problem };
        }

        const result = await ports.get(session.transport, {
          target: { id: nodeId },
          format: 'tiptap',
        });

        if (!current(active)) return { kind: 'unavailable', failure: null };

        const existing = recordOf(editKey);

        if (existing === null) return await seed(active, key, editKey, session, result);

        keys.set(editKey, key);
        core.track(editKey, existing.content, existing.draftVersion);
        sessions.set(editKey, session);

        const settled =
          existing.inflightVersion === null &&
          existing.syncState === 'syncing' &&
          existing.acknowledgedVersion >= existing.draftVersion &&
          (core.committed(editKey)?.version ?? 0) <= existing.acknowledgedVersion;

        /**
         * Bringing the record up to date, and neither half may take the editor down with it.
         *
         * Both branches are SQLite writes, and a write that throws must not reject `open`: the record
         * is already tracked and published, so what a failed write leaves behind is precisely the
         * state the standing already describes - an un-rebased base, or an envelope still in flight
         * reading `unconfirmed`. Opening over local content is the same answer a failed Get gets, and
         * it is the one that keeps someone's unsent writing reachable. Rejecting instead would leave
         * the screen on its opening skeleton with nothing said, because a caller cannot render an
         * outcome it was never given.
         */
        try {
          if (settled && result.ok && result.value.entity.revision !== existing.baseRevision) {
            // Nothing local is unsent, so adopting the server's newer state loses nothing. A body this
            // build cannot open is the one case that is left alone: the stale base revision then makes
            // any later send refuse as a conflict, which is the safe direction, and it can be discarded.
            const content = contentOf(result.value.entity);

            if (content !== null) {
              const rebased = await active.rebaseEdit(
                key,
                content,
                result.value.entity.revision,
                ports.now(),
              );

              if (!current(active)) return { kind: 'unavailable', failure: null };
              if (rebased !== null) {
                publishRecord(editKey, rebased);
                // The row's authored content changed without its version moving, which is exactly what
                // `confirm` expresses. Without it the core would keep the content it was tracking and
                // the next diff would be taken against writing nobody did.
                core.confirm(editKey, null, rebased.content);
              }
            }
          } else if (existing.inflightVersion !== null) {
            // An answer was lost. Reconciled from the entity this very call read, rather than by a
            // second Get: it is strictly fresher, and two reads can disagree in ways these rules assume
            // away. A failed Get leaves the record unconfirmed, and its standing says so.
            await applyReconciliation(editKey, result);
            if (!current(active)) return { kind: 'unavailable', failure: null };
          }
        } catch {
          // Whatever was written is what the standing already describes, so the record opens as it
          // stands. The row is tracked and published before either branch runs, and neither leaves
          // anything half-applied that a later read could misinterpret.
        }

        /**
         * The reconciliation may have ended the session it was reconciling, and then this is a first
         * open after all.
         *
         * A lost answer that turns out to have landed is acknowledged, and an acknowledgement with no
         * editor attached settles the record and forgets it - the background-flush and process-death
         * path. **Nobody is attached here by construction**: the screen calls `open` first and attaches
         * from an effect in the composer it mounts once this resolves, so the recovery path always
         * takes that branch. Returning `ready` for the forgotten key would hand the screen a key with
         * no record behind it, which it can only read as a failed read - "this could not be opened,
         * nothing has changed" - over an entity that is intact and an edit that reached the server.
         *
         * So it seeds instead, from the entity this call already read. That entity is current by
         * construction: `matchesSubmitted` only acknowledges when the server is exactly one revision
         * past the base, which is the revision the acknowledgement then recorded.
         */
        if (recordOf(editKey) === null) return await seed(active, key, editKey, session, result);

        scheduleTick(editKey, autosaveDelayMs);

        return { kind: 'ready', editKey, location: locationOf(result) };
      },

      resume: (editKey, session) => {
        if (!keys.has(editKey)) return;
        sessions.set(editKey, session);
        void tick(editKey);
      },

      editFields: (editKey, fields) => {
        const changed = core.edit(editKey, (content) => {
          const next: EditContent = {
            ...content,
            title: fields.title ?? content.title,
            description: fields.description ?? content.description,
            slug: fields.slug ?? content.slug,
            tags: fields.tags ?? content.tags,
          };

          if (
            next.title === content.title &&
            next.description === content.description &&
            next.slug === content.slug &&
            sameTags(next.tags, content.tags)
          ) {
            return null;
          }

          return next;
        });

        if (changed) scheduleTick(editKey, autosaveDelayMs);
      },

      attachEditor: (editKey, port) => core.attach(editKey, port),

      detachEditor: (token) => {
        core.detach(token);
      },

      snapshotAccepted: (token, snapshot) => {
        const result = core.accept(token, snapshot);

        if (result === 'accepted') scheduleTick(token.id, autosaveDelayMs);

        return result;
      },

      flush: (editKey, options) => core.flush(editKey, options?.lock ?? false),

      beginControlledExit: async (editKey) => {
        const lease = core.takeLease(editKey);

        if (lease === null) {
          return { result: { kind: 'unanswered' } as FlushResult, release: () => {} };
        }

        const result = await core.flush(editKey, true);

        if (result.kind === 'flushed') lease.version = result.version;
        // Always editable again: `locked` for an edit means a barrier is settling, never that a
        // request is in the air. Inheriting the creation owner's in-flight lock here would freeze the
        // editor every couple of seconds while someone types.
        else core.releaseLease(editKey, lease, true);

        return {
          result,
          release: () => {
            core.releaseLease(editKey, lease, true);
          },
        };
      },

      /**
       * Leaving, with a stated budget.
       *
       * It **waits** for any send or reconciliation already in the air, **starts at most one send of
       * its own**, and **runs at most one reconciliation of its own**. The bound on how far it must
       * push is the version committed when it was called: the editor is locked through
       * `beginControlledExit`, so nothing can commit past that while this runs, and the loop therefore
       * terminates.
       *
       * `unconfirmed` is the only fall-through, and it is honest. The phone cannot learn more right
       * now, the record survives, and Recovery lists it. There is no retry beyond it.
       */
      leave: async (editKey) => {
        const committedAtEntry = core.committed(editKey)?.version ?? 0;

        cancelTimer(editKey);
        await settleInFlight(editKey);

        let sendsLeft = 1;
        let reconciliationsLeft = 1;

        for (;;) {
          const record = recordOf(editKey);

          // Already gone: an acknowledgement that landed detached forgot it while this was waiting.
          if (record === null) return 'settled';

          if (record.syncState !== 'syncing') {
            // A conflict or a refusal is a definite reason it cannot be sent now, and neither is
            // repaired by waiting. The record stays.
            consequence(editKey);

            return 'kept';
          }

          if (record.inflightVersion !== null) {
            if (reconciliationsLeft === 0) {
              consequence(editKey);

              return 'unconfirmed';
            }

            reconciliationsLeft -= 1;
            await reconcile(editKey);

            continue;
          }

          const committedNow = core.committed(editKey)?.version ?? 0;

          if (
            record.acknowledgedVersion >= committedAtEntry &&
            record.acknowledgedVersion >= committedNow
          ) {
            consequence(editKey);
            await forget(editKey);

            return 'settled';
          }

          if (!sessionUsableFor(editKey, record.key)) {
            // No connection. The exit is released deliberately: blocking here would trap a person with
            // no signal on a screen they cannot leave, and the edit waits in Recovery instead.
            consequence(editKey);

            return 'kept';
          }

          if (sendsLeft === 0) {
            consequence(editKey);

            return 'unconfirmed';
          }

          sendsLeft -= 1;
          // The acknowledgement may schedule a further send for writing committed since the envelope
          // left. That chain is deliberately not cancelled: this exit has spent its budget and answers
          // `unconfirmed`, but the work still completes detached rather than being silently dropped.
          await tick(editKey);
        }
      },

      discardChanges: async (editKey) => {
        const active = store;

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };
        // Refused while an envelope is in the air: the change may already be on the server, and
        // throwing away the record that knows what was sent would lose the ability to say so.
        if (sending.has(editKey)) return { kind: 'refused', problem: SENDING_PROBLEM };

        const key =
          keys.get(editKey) ??
          get().unusableEdits.find((candidate) => editKeyOf(candidate.key) === editKey)?.key ??
          null;

        if (key === null) return { kind: 'refused', problem: NO_RECORD_PROBLEM };

        cancelTimer(editKey);

        try {
          await active.deleteEdit(key);
        } catch {
          return { kind: 'refused', problem: NO_STORE_PROBLEM };
        }

        if (!current(active)) return { kind: 'done' };

        // Before anything this method needs is cleared. Discard is the *only* action a conflict
        // offers, so the likely ordering is an acknowledged change, then a refused one, then this -
        // and the acknowledged one really is on the server. Throwing away the local record is not a
        // reason to leave the screens behind it showing a title the server no longer has.
        consequence(editKey);

        core.untrack(editKey);
        keys.delete(editKey);
        sessions.delete(editKey);
        acknowledged.delete(editKey);
        publishRecord(editKey, null);
        set((state) => ({
          unusableEdits: state.unusableEdits.filter(
            (candidate) => editKeyOf(candidate.key) !== editKey,
          ),
        }));

        return { kind: 'done' };
      },

      standingFor: standingOf,
    };
  });

export type EditOwner = ReturnType<typeof createEditOwner>;

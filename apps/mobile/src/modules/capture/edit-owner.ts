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
  type ArchiveCause,
  type GetRequestInput,
  type GetResponse,
  type LifecycleRequestInput,
  type LifecycleResponse,
  type MoveRequestInput,
  type MoveResponse,
  type NodeEntity,
  type NodeSummary,
  type NodeType,
  type UpdateRequestInput,
  type UpdateResponse,
} from '@raphael/contracts/nodes';
import { create as createStore } from 'zustand';

import type { Transport } from '../../infrastructure/api/transport';
import type { EditorPort, EditorSnapshot } from '../editor';
import {
  applyEnvelope,
  contentOf,
  diff,
  matchesSubmitted,
  type InflightEnvelope,
} from './edit-envelope.ts';
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
  type Lease,
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

/**
 * Why a move was never dispatched. The record is exactly as it was.
 *
 * `conflicted`, `refused` and `unconfirmed` are the autosave's own verdicts on the writing, reported as
 * the autosave's rather than as the move's: a move is never sent over writing that is not settled on
 * the server, and `unsent_writing` says the writing is still on its way there.
 */
export type MoveNotSentReason =
  | 'unsent_writing'
  | 'no_session'
  | 'conflicted'
  | 'refused'
  | 'unconfirmed'
  | 'unknown_location';

/**
 * How a move ended.
 *
 * `refused` carries the failure rather than a sentence, so the one place composing sentences about an
 * edit stays `edit-composer.ts`; nothing local changed, and the writing's own standing is untouched.
 * `conflicted` is the move itself meeting a stale revision, which the record now carries.
 * `unconfirmed` is a move that was dispatched and whose outcome this phone cannot state: the record
 * keeps it in flight and reconciliation answers it later.
 */
export type MoveOutcome =
  | { readonly kind: 'moved'; readonly parentId: number | null }
  | { readonly kind: 'refused'; readonly failure: ClientFailure }
  | { readonly kind: 'conflicted' }
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'not_sent'; readonly reason: MoveNotSentReason };

/**
 * What the owner knows about why the entity is archived, if it is.
 *
 * Held beside `EditLocation` rather than inside the record's standing: archived is a fact about the
 * server's entity, not about this phone's writing, so the standings in `edit-policy.ts` stay a pure
 * statement about writing. `unknown` is a Get that failed; the screen then stays editable over local
 * content and the server remains the authority.
 */
export type EditLifecycle =
  | { readonly kind: 'known'; readonly archiveCauses: readonly ArchiveCause[] }
  | { readonly kind: 'unknown' };

/**
 * Why an archive or restore was never dispatched. Nothing was sent.
 *
 * `unconfirmed` is an envelope whose answer is still pending: the one record state that cannot take a
 * lifecycle action, because what the server holds is not known yet. `unread` is the fresh read that
 * pins the request's revision failing.
 */
export type LifecycleNotSentReason = 'no_session' | 'unconfirmed' | 'unsent_writing' | 'unread';

/**
 * How an archive or restore ended.
 *
 * `done` carries the resulting state from the response, which is what the screen words - a restore
 * can leave the entity archived through a container above. `reread` on the uncertain outcomes means a
 * Get after the request succeeded and was adopted, so the screen now shows what the server holds; it
 * is what lets the wording claim a refresh only when one happened.
 */
export type LifecycleOutcome =
  | { readonly kind: 'done'; readonly archived: boolean; readonly causes: readonly ArchiveCause[] }
  | { readonly kind: 'refused'; readonly failure: ClientFailure; readonly reread: boolean }
  | { readonly kind: 'unconfirmed'; readonly reread: boolean }
  | { readonly kind: 'not_sent'; readonly reason: LifecycleNotSentReason };

export type EditOpenOutcome =
  | {
      readonly kind: 'ready';
      readonly editKey: string;
      readonly location: EditLocation;
      readonly lifecycle: EditLifecycle;
    }
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
  move(transport: Transport, request: MoveRequestInput): Promise<ClientResult<MoveResponse>>;
  archive(
    transport: Transport,
    request: LifecycleRequestInput,
  ): Promise<ClientResult<LifecycleResponse>>;
  restore(
    transport: Transport,
    request: LifecycleRequestInput,
  ): Promise<ClientResult<LifecycleResponse>>;
  /**
   * The cache consequence of an archive or restore, or of moving something out of an archived
   * container: every read made under the activation. Membership changes across lists, feeds, search
   * and the hierarchy in ways the phone cannot enumerate. A failure is a failed refresh, never a
   * failed action.
   */
  applyLifecycle(activation: number): Promise<void>;
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
  /**
   * Where each open record's entity sits, as far as the owner has confirmed.
   *
   * Seeded from the open's own Get and advanced by the owner alone: on an acknowledged move, whether
   * its answer arrived or was recovered by reconciliation with no sheet on screen, and when a settled
   * record adopts the server. The owner holds this because it is the one thing that knows when a move
   * was acknowledged; a screen reads it rather than keeping a copy. In memory only: after a process
   * death the next open's Get establishes it again, and every move is judged against it.
   */
  readonly locations: Readonly<Record<string, EditLocation>>;
  /**
   * Why each open record's entity is archived, as far as the owner has confirmed. Beside `locations`
   * and advanced the same way: from an open's or a lifecycle action's Get, from a lifecycle response,
   * and from an acknowledged move. In memory only.
   */
  readonly lifecycles: Readonly<Record<string, EditLifecycle>>;
  /**
   * How many times the owner replaced a record's content under the screen with the server's.
   *
   * A screen holds what it first rendered, so content adopted while an editor is attached - a lifecycle
   * action's read finding someone else's newer edit - would otherwise sit behind stale text, and the
   * next keystroke would send that text at the new revision. The edit screen keys its composer on this,
   * which remounts it over the adopted content. Only a rebase moves it; acknowledging this phone's own
   * writing does not, because the screen already shows that.
   */
  readonly contentEpochs: Readonly<Record<string, number>>;

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
  /**
   * Move the entity under another parent, keeping its slug. Always resolves.
   *
   * Serialized with the autosave loop and reconciliation for the record: writing is settled on the
   * server first, the move is persisted before it is sent, and an answer that is lost stays in flight
   * until a re-read can say what happened. The confirmed location advances only on an acknowledgement.
   */
  move(editKey: string, destination: { readonly parentId: number | null }): Promise<MoveOutcome>;
  /**
   * Archive or restore the entity. Always resolves.
   *
   * Serialized with the autosave loop like `move`: sendable writing is sent first, then a fresh Get
   * pins the revision the request carries - never the record's own base, which a refused or conflicted
   * record can hold behind the server. A success is adopted from its response; a refusal or a lost
   * answer is followed by a read-back.
   */
  archive(editKey: string): Promise<LifecycleOutcome>;
  restore(editKey: string): Promise<LifecycleOutcome>;
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

/** What a Get established about why the entity is archived. A failed Get establishes nothing. */
const lifecycleOf = (result: ClientResult<GetResponse>): EditLifecycle =>
  result.ok
    ? { kind: 'known', archiveCauses: result.value.entity.archiveCauses }
    : { kind: 'unknown' };

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
     * The one piece of work in the air for a record - a send, a re-read, a move, or an open's
     * read-and-reconcile - as a completion signal that never rejects.
     *
     * One map rather than one per kind of work, because each of them reads or writes the record's
     * in-flight state, and a read that predates a dispatch is not evidence about it: an open whose Get
     * was in the air while a timer persisted and sent an envelope could otherwise clear that envelope
     * through the unchanged-revision rule. It is also what makes `leave` honest: an exit 200ms after the
     * debounce fired joins the send in the air rather than finding it refusing itself for `sending`.
     */
    const work = new Map<string, Promise<void>>();
    /** The lease each controlled exit or barrier currently holds for a record, by identity. */
    const heldLeases = new Map<string, Lease>();
    /** The barrier in progress for a record, so a release requested meanwhile waits for it. */
    const barriers = new Map<string, Promise<void>>();
    /** Deferred releases in progress, so nothing acquires while a release is still owed. */
    const releasing = new Map<string, Promise<void>>();

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
    const publishRecord = (
      editKey: string,
      written: EntityEditRecord | null,
      location?: EditLocation,
    ): void => {
      set((state) => {
        const without = state.edits.filter((record) => editKeyOf(record.key) !== editKey);
        const edits = written === null ? without : [...without, written];

        // In the same `set` as the record it follows, so nothing can read a location ahead of it.
        return location === undefined
          ? { edits }
          : { edits, locations: { ...state.locations, [editKey]: location } };
      });
    };

    /**
     * Take in what an open could establish about where the entity sits.
     *
     * A reading that could not be made replaces nothing already known: a failed Get says nothing about
     * where the entity is, only that this open could not learn it.
     */
    const learnLocation = (editKey: string, location: EditLocation): void => {
      set((state) =>
        location.kind === 'unknown' && state.locations[editKey] !== undefined
          ? {}
          : { locations: { ...state.locations, [editKey]: location } },
      );
    };

    const bumpContentEpoch = (editKey: string): void => {
      set((state) => ({
        contentEpochs: {
          ...state.contentEpochs,
          [editKey]: (state.contentEpochs[editKey] ?? 0) + 1,
        },
      }));
    };

    /** `learnLocation`'s twin: an unknown reading never replaces a known one. */
    const learnLifecycle = (editKey: string, lifecycle: EditLifecycle): void => {
      set((state) =>
        lifecycle.kind === 'unknown' && state.lifecycles[editKey] !== undefined
          ? {}
          : { lifecycles: { ...state.lifecycles, [editKey]: lifecycle } },
      );
    };

    /** Drop everything the owner holds about a record beside the record itself. */
    const dropRecordState = (editKey: string): void => {
      heldLeases.delete(editKey);
      set((state) => {
        const { [editKey]: _location, ...locations } = state.locations;
        const { [editKey]: _lifecycle, ...lifecycles } = state.lifecycles;
        const { [editKey]: _epoch, ...contentEpochs } = state.contentEpochs;

        return { locations, lifecycles, contentEpochs };
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

    /**
     * Run `body` as the record's work, registered before it starts.
     *
     * The registration happens before `body` is invoked, so nothing `body` does synchronously - and
     * nothing that runs after it - can find the record free. The entry is removed before its signal
     * resolves, so a waiter woken by it finds the slot empty.
     */
    const occupy = <T>(editKey: string, body: () => Promise<T>): Promise<T> => {
      let done: () => void = () => {};
      const tracked = new Promise<void>((resolve) => {
        done = resolve;
      });

      work.set(editKey, tracked);

      let started: Promise<T>;

      try {
        started = body();
      } catch (error) {
        started = Promise.reject(error as Error);
      }

      void started
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (work.get(editKey) === tracked) work.delete(editKey);
          done();
        });

      return started;
    };

    /** Join whatever is in the air for the record, or start `body` as its work when nothing is. */
    const joinOrStart = (editKey: string, body: () => Promise<void>): Promise<void> =>
      work.get(editKey) ?? occupy(editKey, body);

    /**
     * Wait until nothing is in the air for the record, then run `body` as its work.
     *
     * The check and the registration are one synchronous segment, so a timer cannot start work in the
     * gap between the wait and the read.
     */
    const claim = async <T>(editKey: string, body: () => Promise<T>): Promise<T> => {
      for (;;) {
        const running = work.get(editKey);

        if (running === undefined) return occupy(editKey, body);
        await running;
      }
    };

    /**
     * Acquire the record's lease through the owner, the one gate over who holds it.
     *
     * Waits for any barrier and any deferred release first, so a new lease can never replace the
     * identity that protects a transition in progress - `core.takeLease` itself would silently
     * overwrite it. Both maps hold completion signals that never reject, so a failed transition reopens
     * the gate rather than poisoning it. Null when the entry is gone. A barrier acquiring for itself
     * names its own signal as `own`, so it does not wait for its own completion.
     */
    const acquireLease = async (editKey: string, own?: Promise<void>): Promise<Lease | null> => {
      for (;;) {
        const barrier = barriers.get(editKey);
        const busy = (barrier === own ? undefined : barrier) ?? releasing.get(editKey);

        if (busy === undefined) break;
        await busy;
      }

      const lease = core.takeLease(editKey);

      if (lease !== null) heldLeases.set(editKey, lease);

      return lease;
    };

    /**
     * Release a lease this owner handed out, once any barrier using it has completed, however it did.
     *
     * The identity is dropped and the core released unconditionally: a leaked lock is a screen nobody
     * can type into, which is the one outcome worse than any failed transition. With no barrier in
     * progress this runs at once.
     */
    const releaseHeld = (editKey: string, lease: Lease, editable: boolean): void => {
      const done = (async () => {
        try {
          const barrier = barriers.get(editKey);

          if (barrier !== undefined) await barrier;
        } finally {
          if (heldLeases.get(editKey) === lease) heldLeases.delete(editKey);
          core.releaseLease(editKey, lease, editable);
        }
      })().finally(() => {
        if (releasing.get(editKey) === done) releasing.delete(editKey);
      });

      releasing.set(editKey, done);
    };

    /**
     * Hold the record still while `body` rewrites its authored columns and the core's content.
     *
     * Binary: `body` runs only once the core's own predicate, `settledAt`, says the writing is at rest,
     * and otherwise this answers `unsettled` without running it. Settlement is asked under a lease this
     * owner handed out and can name, or with no editor at all:
     * - a controlled exit already holds one: its version was recorded when its flush landed, and its
     *   release defers until this finishes, so it stays the lease for the whole transition;
     * - an editor is attached and no lease is held: take one, flush under it, record the flushed version
     *   on it - exactly as `beginControlledExit` does - and release it afterwards;
     * - no editor is attached: drain, then `settledAt(editKey, null, committed)`, which is the core's
     *   complete statement for an unattached entry.
     *
     * The gate waits on completion, never on the result, so a body that throws still lets a deferred
     * release and the next acquisition proceed. The throw reaches this caller alone.
     */
    const withBarrier = <T>(editKey: string, body: () => Promise<T>): Promise<T | 'unsettled'> => {
      let complete: () => void = () => {};
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const run = async (): Promise<T | 'unsettled'> => {
        if (!core.has(editKey)) return 'unsettled';

        const held = heldLeases.get(editKey);

        if (held !== undefined) {
          if (held.version === null || !core.settledAt(editKey, held, held.version)) {
            return 'unsettled';
          }

          return body();
        }

        if (!core.attached(editKey)) {
          await core.drain(editKey);

          const committed = core.committed(editKey);

          if (committed === undefined || !core.settledAt(editKey, null, committed.version)) {
            return 'unsettled';
          }

          return body();
        }

        const lease = await acquireLease(editKey, completed);

        if (lease === null) return 'unsettled';

        try {
          const flushed = await core.flush(editKey, true);

          if (flushed.kind !== 'flushed') return 'unsettled';
          lease.version = flushed.version;
          if (!core.settledAt(editKey, lease, lease.version)) return 'unsettled';

          return await body();
        } finally {
          if (heldLeases.get(editKey) === lease) heldLeases.delete(editKey);
          core.releaseLease(editKey, lease, true);
        }
      };

      // Registered before `run` starts, so nothing it does can find the gate open.
      barriers.set(editKey, completed);

      const started = run();

      void started
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (barriers.get(editKey) === completed) barriers.delete(editKey);
          complete();
        });

      return started;
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
      dropRecordState(editKey);
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
      publishRecord(editKey, seeded, locationOf(result));
      learnLifecycle(editKey, lifecycleOf(result));
      sessions.set(editKey, session);
      // Seeding usually has nothing to send, but `insertEdit` hands back an existing row rather than
      // throwing, and that row may hold writing this process has not seen yet.
      scheduleTick(editKey, autosaveDelayMs);

      return {
        kind: 'ready',
        editKey,
        location: locationOf(result),
        lifecycle: lifecycleOf(result),
      };
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
     * The shared acknowledgement for a move, whether its answer arrived or was recovered by a re-read.
     *
     * Deliberately outside the protection barrier, as the ordinary update acknowledgement is: a move
     * carries no authored field, so the store transition rewrites no current column and the core is not
     * confirmed. A pending version that lands after it changes nothing it decided.
     *
     * True only when the store says its guarded transition applied. It is not inferred from the row: an
     * envelope another path already cleared leaves a row that looks the same. A write that throws is a
     * transaction that rolled back, so the move is still in flight and the loop asks again.
     */
    const acknowledgeMovement = async (
      active: CaptureStore,
      editKey: string,
      key: EditKey,
      record: EntityEditRecord,
      node: NodeSummary,
    ): Promise<boolean> => {
      if (record.inflight?.kind !== 'move' || record.inflightVersion === null) return false;

      let transition: Awaited<ReturnType<CaptureStore['acknowledgeMove']>>;

      try {
        transition = await active.acknowledgeMove(
          key,
          record.inflightVersion,
          node.revision,
          ports.now(),
        );
      } catch {
        return false;
      }

      if (!current(active)) return false;

      const { applied, record: written } = transition;

      if (!applied || written === null) {
        publishRecord(editKey, written);

        return false;
      }

      // The server's answer is authoritative for where the entity now sits.
      publishRecord(editKey, written, { kind: 'known', parentId: node.parentId });
      // Now rather than at leave: a move changes where things are listed, and a screen showing where
      // this entity lives re-derives it from the refreshed tree.
      acknowledged.add(editKey);
      consequence(editKey);

      return true;
    };

    /**
     * What an acknowledged move says about the entity's archive.
     *
     * Nothing can move into an archived place, so an entity the server reports active after the move
     * has no causes at all. One it still reports archived is a race this phone cannot explain, so the
     * causes it knew are kept. Moving out of an archived container changes what lists and feeds hold,
     * and the ordinary move consequence refreshes no feed for a container, so the broad one runs too.
     */
    const learnMovedLifecycle = (editKey: string, node: NodeSummary): void => {
      const before = get().lifecycles[editKey];
      const wasArchived = before?.kind === 'known' && before.archiveCauses.length > 0;

      learnLifecycle(
        editKey,
        node.archived ? { kind: 'unknown' } : { kind: 'known', archiveCauses: [] },
      );

      const session = sessions.get(editKey);

      if (wasArchived && session !== undefined) {
        void ports.applyLifecycle(session.activation).catch(() => {
          // A failed refresh, never a failed move.
        });
      }
    };

    /**
     * An acknowledged move's consequences for the session, after `acknowledgeMovement`.
     *
     * `afterAcknowledgement`'s two, without a second cache consequence: send at once if writing is
     * waiting, and otherwise, with no editor attached, the session is over.
     */
    const afterMoveAcknowledgement = async (editKey: string): Promise<void> => {
      const record = recordOf(editKey);

      if (record === null) return;

      if ((core.committed(editKey)?.version ?? 0) > record.acknowledgedVersion) {
        scheduleTick(editKey, 0);

        return;
      }

      if (core.attached(editKey)) return;

      await forget(editKey);
    };

    /**
     * Whether writing is outstanding on a record, as far as the durable row and the core can say.
     *
     * Accepted counts, not just committed: a version the core has accepted and not yet written is
     * writing all the same.
     */
    const hasOutstandingWriting = (editKey: string, record: EntityEditRecord): boolean =>
      record.draftVersion > record.acknowledgedVersion ||
      (core.protectionOf(editKey)?.latestAcceptedVersion ?? record.draftVersion) >
        record.acknowledgedVersion;

    /**
     * A lost move that expected no write, and a server whose revision has moved past the base.
     *
     * That move cannot have written, so the Get has proved someone else did. Two settled outcomes,
     * decided by whether this phone has writing to keep:
     * - **Writing outstanding**: the external-write case the loop already has one answer for. Marked
     *   `conflicted`, which clears the move and keeps every byte - now rather than after a send the
     *   server would refuse, since the Get already holds the proof.
     * - **Nothing outstanding**: `conflicted` would say something false. The server is adopted in one
     *   guarded transaction that clears the move and rewrites base and current together, under the
     *   protection barrier, since it replaces the core's content: a pending version landing after it
     *   would otherwise put writing nobody did back over the server's.
     *
     * Evidence of writing is enough to conflict without the barrier; only "nothing outstanding" needs
     * the writing at rest. Anything unsettled, not applied or rolled back changes nothing: the move stays
     * in flight and the retry asks again. Neither outcome schedules a send; the first has nothing to send
     * and the second may never send again.
     */
    const resolveLostNoopMove = async (
      active: CaptureStore,
      editKey: string,
      key: EditKey,
      record: EntityEditRecord,
      entity: NodeEntity,
    ): Promise<void> => {
      const conflict = async (): Promise<void> => {
        cancelTimer(editKey);
        publishRecord(editKey, await active.markEditConflicted(key, ports.now()));
      };

      if (hasOutstandingWriting(editKey, record)) {
        await conflict();

        return;
      }

      const inflightVersion = record.inflightVersion;
      // A body this build cannot open cannot be adopted; the move stays in flight.
      const content = contentOf(entity);

      if (inflightVersion === null || content === null) return;

      await withBarrier(editKey, async () => {
        const settled = recordOf(editKey);

        if (settled === null || settled.inflightVersion !== inflightVersion) return;
        if (hasOutstandingWriting(editKey, settled)) {
          await conflict();

          return;
        }

        const { applied, record: adopted } = await active.adoptAfterNoopMove(
          key,
          inflightVersion,
          content,
          entity.revision,
          ports.now(),
        );

        if (!current(active)) return;
        if (!applied || adopted === null) {
          publishRecord(editKey, adopted);

          return;
        }

        publishRecord(editKey, adopted, { kind: 'known', parentId: entity.parentId });
        // The row's authored content changed without its version moving, which is what `confirm`
        // expresses; the next diff is then taken against what the server holds.
        core.confirm(editKey, null, adopted.content);
      }).catch(() => {
        // A rolled-back transaction: the move is provably still in flight, and the retry asks again.
      });
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
        // Nothing has been written since the base, so the envelope never applied - or it was a move
        // the server answered as a no-op. Clear the mark and let the ordinary loop send any writing.
        publishRecord(editKey, await active.clearEditInflight(key, at));
        if (!current(active)) return;
        scheduleTick(editKey, 0);

        return;
      }

      if (envelope.kind === 'move' && !envelope.expectsWrite) {
        await resolveLostNoopMove(active, editKey, key, record, entity);

        return;
      }

      if (envelope.kind === 'move') {
        if (!matchesSubmitted(entity, envelope, record.base, record.baseRevision)) {
          cancelTimer(editKey);
          publishRecord(editKey, await active.markEditConflicted(key, at));

          return;
        }

        // Ours: acknowledged at the entity's revision. On a store that did not apply it, the record
        // is left as published and the retry asks again.
        if (await acknowledgeMovement(active, editKey, key, record, entity)) {
          learnMovedLifecycle(editKey, entity);
          await afterMoveAcknowledgement(editKey);
        }

        return;
      }

      if (matchesSubmitted(entity, envelope, record.base, record.baseRevision)) {
        // Exactly one write since the base, and every field we sent is what the server holds: the
        // write was ours. Acknowledged at the entity's revision, with the base being what was *sent*.
        publishRecord(
          editKey,
          await active.acknowledgeEdit(
            key,
            applyEnvelope(record.base, envelope.envelope),
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
      } finally {
        checking.delete(editKey);
        publishWorking();

        // Still unresolved, and an editor is there to see it: ask again later - including after a
        // transition that threw. A detached record waits for its next open instead, which bounds
        // background work to nothing.
        const after = recordOf(editKey);

        if (after !== null && after.inflightVersion !== null && core.attached(editKey)) {
          scheduleTick(editKey, autosaveRetryMs);
        }
      }
    };

    /** One piece of work at a time per record; a reconciliation joins whatever is in the air. */
    const reconcile = (editKey: string): Promise<void> =>
      joinOrStart(editKey, () => runReconcile(editKey));

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
      const written = await active.markEditInflight(
        key,
        committed.version,
        { kind: 'update', envelope },
        ports.now(),
      );

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

    /**
     * One piece of work at a time per record; a send joins whatever is in the air rather than queueing
     * behind it. A timer that fires into an open or a move therefore sends nothing, and whichever is
     * running re-arms the loop when it finishes.
     */
    const tick = (editKey: string): Promise<void> => joinOrStart(editKey, () => runTick(editKey));

    /** Wait for whatever this record already has in the air: a send, a re-read, a move, or an open. */
    const settleInFlight = async (editKey: string): Promise<void> => {
      for (;;) {
        const running = work.get(editKey);

        if (running === undefined) return;
        await running;
      }
    };

    /** A verdict the autosave already holds for the record, which a move must not be sent over. */
    const standingReason = (record: EntityEditRecord): MoveNotSentReason | null => {
      if (record.syncState === 'conflicted') return 'conflicted';
      if (record.syncState === 'refused') return 'refused';
      // An envelope from a dead process, or a lost answer: reconciliation resolves it, not a move.
      if (record.inflightVersion !== null) return 'unconfirmed';

      return null;
    };

    /**
     * Whether every accepted version is written on this phone and acknowledged by the server.
     *
     * Asked of the core as well as the row, because `core.committed()` lags an accepted version still
     * waiting for its write, and a failed write or a renderer that did not answer means there may be
     * writing nobody has counted. None of those is settled writing.
     */
    const writingSettled = (editKey: string, record: EntityEditRecord): boolean => {
      const protection = core.protectionOf(editKey);

      return (
        protection !== undefined &&
        !protection.pending &&
        !protection.writing &&
        !protection.failedWrite &&
        !protection.rendererUnknown &&
        protection.latestAcceptedVersion === protection.committedVersion &&
        protection.committedVersion <= record.acknowledgedVersion &&
        record.draftVersion <= record.acknowledgedVersion
      );
    };

    /**
     * One move, run as the record's work (`move` holds the claim).
     *
     * Writing is settled on the server first, through `runTick` - never `tick`, which would join this
     * very claim. The move is then persisted before it is dispatched, so a process that dies mid-request
     * reconciles it on its next open, and the answer is read without guessing: only the store's own word
     * acknowledges it, and only a response that agrees with the confirmed location is a no-op.
     */
    const runMove = async (editKey: string, parentId: number | null): Promise<MoveOutcome> => {
      const notSent = (reason: MoveNotSentReason): MoveOutcome => ({ kind: 'not_sent', reason });
      const active = store;
      const key = keys.get(editKey);
      const session = sessions.get(editKey);
      let record = recordOf(editKey);

      if (active === null || key === undefined || session === undefined || record === null) {
        return notSent('no_session');
      }
      if (!sessionUsableFor(editKey, key)) return notSent('no_session');

      const known = get().locations[editKey];

      // A move cannot be judged against a location the phone never learned.
      if (known === undefined || known.kind === 'unknown') return notSent('unknown_location');

      cancelTimer(editKey);

      const before = standingReason(record);

      if (before !== null) return notSent(before);

      if (!writingSettled(editKey, record)) {
        try {
          await core.drain(editKey);
          if ((core.committed(editKey)?.version ?? 0) > record.acknowledgedVersion) {
            await runTick(editKey);
          }
        } catch {
          return notSent('unsent_writing');
        }

        record = recordOf(editKey);
        if (record === null || !current(active)) return notSent('no_session');

        // A verdict the autosave earned is reported as the autosave's, not the move's.
        const after = standingReason(record);

        if (after !== null) return notSent(after);
        if (!writingSettled(editKey, record)) return notSent('unsent_writing');
      }

      const location = get().locations[editKey];

      if (location === undefined || location.kind === 'unknown') {
        return notSent('unknown_location');
      }

      const inflight: InflightEnvelope = {
        kind: 'move',
        parentId,
        expectsWrite: parentId !== location.parentId,
      };
      const inflightVersion = record.acknowledgedVersion;
      let written: EntityEditRecord | null;

      try {
        written = await active.markEditInflight(key, inflightVersion, inflight, ports.now());
      } catch {
        // Nothing was persisted, so nothing may be sent.
        return notSent('unsent_writing');
      }

      if (!current(active)) return notSent('no_session');
      if (
        written === null ||
        written.inflightVersion !== inflightVersion ||
        written.inflight?.kind !== 'move' ||
        written.inflight.parentId !== parentId
      ) {
        publishRecord(editKey, written);

        return notSent('unsent_writing');
      }
      publishRecord(editKey, written);

      sending.add(editKey);
      publishWorking();

      let result: ClientResult<MoveResponse>;

      try {
        result = await ports.move(session.transport, {
          target: { id: key.nodeId },
          // From the row just written: the revision on the wire is the one the durable record carries.
          revision: written.baseRevision,
          // Never a slug: on this phone an entity keeps its slug when it moves; its path may still change.
          destination: { parent: parentId === null ? { path: '/' } : { id: parentId } },
        });
      } finally {
        sending.delete(editKey);
        publishWorking();
      }

      if (!current(active)) return { kind: 'unconfirmed' };

      try {
        return await answerMove(active, editKey, key, written, inflight, location, result);
      } catch {
        // A local transition that rolled back: the move is still in flight, and reconciliation will
        // read what the server holds.
        return { kind: 'unconfirmed' };
      }
    };

    /** What a move's answer means for the record. Only the store's word acknowledges it. */
    const answerMove = async (
      active: CaptureStore,
      editKey: string,
      key: EditKey,
      written: EntityEditRecord,
      inflight: Extract<InflightEnvelope, { kind: 'move' }>,
      location: Extract<EditLocation, { kind: 'known' }>,
      result: ClientResult<MoveResponse>,
    ): Promise<MoveOutcome> => {
      const at = ports.now();

      if (result.ok) {
        const node = result.value.node;

        if (node.revision === written.baseRevision) {
          // The server wrote nothing. That is the no-op this phone expected only when it did not ask
          // for a different parent and the server agrees on where the entity is; anything else is
          // something this phone cannot explain, and reconciliation reads what is true.
          if (inflight.expectsWrite || node.parentId !== location.parentId) {
            return { kind: 'unconfirmed' };
          }

          publishRecord(editKey, await active.clearEditInflight(key, at));

          return { kind: 'moved', parentId: location.parentId };
        }

        if (!(await acknowledgeMovement(active, editKey, key, written, node))) {
          // The server applied the move; this process cannot say what the record now holds.
          return { kind: 'unconfirmed' };
        }

        learnMovedLifecycle(editKey, node);
        await afterMoveAcknowledgement(editKey);

        return { kind: 'moved', parentId: node.parentId };
      }

      const failure = result.failure;

      if (failure.kind === 'api_error' && failure.error.code === 'revision_conflict') {
        cancelTimer(editKey);
        publishRecord(editKey, await active.markEditConflicted(key, at));

        return { kind: 'conflicted' };
      }

      // Lost: the move stays in flight and reconciliation answers it.
      if (failure.mutationOutcome === 'unknown') return { kind: 'unconfirmed' };

      // A definite refusal of the move, not of the writing: only the move is cleared, and the
      // record's standing is untouched.
      publishRecord(editKey, await active.clearEditInflight(key, at));

      return { kind: 'refused', failure };
    };

    /**
     * What the loop owes a record after a move, whichever step ended it: a re-read while a move is
     * still in flight and an editor is there to see it, or a send for writing a move did not carry.
     */
    const rearmAfterMove = (editKey: string): void => {
      const record = recordOf(editKey);

      if (record === null) return;
      if (record.inflightVersion !== null) {
        if (core.attached(editKey)) scheduleTick(editKey, autosaveRetryMs);

        return;
      }
      if (
        record.syncState === 'syncing' &&
        (core.committed(editKey)?.version ?? 0) > record.acknowledgedVersion
      ) {
        scheduleTick(editKey, autosaveDelayMs);
      }
    };

    /**
     * One archive or restore, run as the record's work (`lifecycleAction` holds the claim).
     *
     * The request carries the revision of a Get made here, after sendable writing was sent - never the
     * record's own base. That base is the server's revision only while the record is settled; a refused
     * or conflicted record, or one whose earlier lifecycle answer was lost, can sit behind the server
     * for good, and a request made from it would refuse as a conflict forever. Archive and restore carry
     * no content, so all the guard needs to bind is "the entity this phone just read".
     *
     * `live()` is asked after every await that precedes the dispatch. `close` retires the store and the
     * sessions while work is pending, and a pin that resolved after a connection switch must not lead
     * to an archive on the old server with the old transport. A session replaced through `resume` fails
     * it too: nothing was sent, and the next press runs under the current one.
     */
    const runLifecycle = async (
      editKey: string,
      verb: 'archive' | 'restore',
    ): Promise<LifecycleOutcome> => {
      const notSent = (reason: LifecycleNotSentReason): LifecycleOutcome => ({
        kind: 'not_sent',
        reason,
      });
      const active = store;
      const key = keys.get(editKey);
      const session = sessions.get(editKey);
      let record = recordOf(editKey);

      if (active === null || key === undefined || session === undefined || record === null) {
        return notSent('no_session');
      }

      const live = (): boolean =>
        current(active) && sessions.get(editKey) === session && sessionUsableFor(editKey, key);

      if (!live()) return notSent('no_session');
      // An answer still owed: what the server holds is not known until reconciliation says.
      if (record.inflightVersion !== null) return notSent('unconfirmed');

      // Only writing that can still be sent is sent first. A refused or conflicted record keeps its
      // writing and goes on: the pin supplies the revision, so its stale base does not matter here.
      if (record.syncState === 'syncing' && !writingSettled(editKey, record)) {
        try {
          await core.drain(editKey);
          if ((core.committed(editKey)?.version ?? 0) > record.acknowledgedVersion) {
            await runTick(editKey);
          }
        } catch {
          return notSent('unsent_writing');
        }

        if (!live()) return notSent('no_session');

        record = recordOf(editKey);
        if (record === null) return notSent('no_session');
        // The send's answer was lost, so the record is not known yet.
        if (record.inflightVersion !== null) return notSent('unconfirmed');
        // A send refused here (the entity was archived elsewhere, say) makes the record `refused`,
        // which goes on to the pin; only writing still waiting to be sent stops the action.
        if (record.syncState === 'syncing' && !writingSettled(editKey, record)) {
          return notSent('unsent_writing');
        }
      }

      const pin = await ports.get(session.transport, {
        target: { id: key.nodeId },
        format: 'tiptap',
      });

      if (!live()) return notSent('no_session');
      if (!pin.ok) return notSent('unread');
      // A pin whose content could not be adopted still names the revision; the advance below then
      // sees a base behind it and leaves the record alone.
      if ((await adoptRead(active, editKey, key, pin)) === 'ended' || !live()) {
        return notSent('no_session');
      }

      const before = recordOf(editKey);

      if (before === null) return notSent('no_session');

      const revision = pin.value.entity.revision;
      const request: LifecycleRequestInput = { target: { id: key.nodeId }, revision };
      const result = await (verb === 'archive'
        ? ports.archive(session.transport, request)
        : ports.restore(session.transport, request));

      if (!current(active)) return { kind: 'unconfirmed', reread: false };

      const refresh = (): void => {
        void ports.applyLifecycle(session.activation).catch(() => {
          // A failed refresh, never a failed action.
        });
      };

      if (result.ok) {
        const { node, archiveCauses } = result.value;

        // The pin showed the base current, and the server's only change since is this one, which
        // altered no content: the base content still describes the server at the new revision.
        if (before.baseRevision === revision && node.revision !== revision) {
          try {
            const advanced = await active.advanceEditRevision(
              key,
              revision,
              node.revision,
              ports.now(),
            );

            if (advanced !== null && current(active)) publishRecord(editKey, advanced);
          } catch {
            // Nothing is stranded: the next lifecycle action pins afresh, and kept writing that is
            // sent at the old revision conflicts rather than overwriting.
          }
        }
        if (current(active)) learnLifecycle(editKey, { kind: 'known', archiveCauses });
        refresh();

        return { kind: 'done', archived: node.archived, causes: archiveCauses };
      }

      const failure = result.failure;
      const lost = failure.mutationOutcome === 'unknown';
      // Neither a refusal nor a lost answer says what the server holds now, so it is read back the
      // way an open reads it. A failed read-back leaves the previous state, and says so.
      let reread = false;

      if (live()) {
        const back = await ports.get(session.transport, {
          target: { id: key.nodeId },
          format: 'tiptap',
        });

        // A refresh is claimed only when the screen now shows what this read found.
        reread = back.ok && live() && (await adoptRead(active, editKey, key, back)) === 'adopted';
      }
      if (lost) refresh();

      return lost ? { kind: 'unconfirmed', reread } : { kind: 'refused', failure, reread };
    };

    /** `runLifecycle` as the record's work, re-armed afterwards like a move. */
    const lifecycleAction = (
      editKey: string,
      verb: 'archive' | 'restore',
    ): Promise<LifecycleOutcome> =>
      claim(editKey, async () => {
        try {
          return await runLifecycle(editKey, verb);
        } finally {
          rearmAfterMove(editKey);
        }
      }).catch((): LifecycleOutcome => ({ kind: 'unconfirmed', reread: false }));

    /**
     * Bring an existing record up to date with a Get its own work just made.
     *
     * `open`'s reconciliation, factored out so a lifecycle action can apply its pin and its read-back
     * the same way: rebase a settled record whose revision moved, otherwise answer an envelope in
     * flight from the entity just read. Then take in what the read established about the entity.
     *
     * Never rejects. `ended` is the owner stopping being current along the way, so the caller answers
     * as though the work had been cut short. `stale` is a newer server content this record should have
     * adopted and did not - a body this build cannot open, or a write that failed - so what the screen
     * shows is not what the server holds, and no caller may say it is. `adopted` is everything else,
     * including a record that keeps unsent writing on purpose.
     */
    const adoptRead = async (
      active: CaptureStore,
      editKey: string,
      key: EditKey,
      result: ClientResult<GetResponse>,
    ): Promise<'adopted' | 'stale' | 'ended'> => {
      const existing = recordOf(editKey);

      if (existing === null) return 'adopted';

      let adopted: 'adopted' | 'stale' = 'adopted';

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

          adopted = 'stale';
          if (content !== null) {
            const rebased = await active.rebaseEdit(
              key,
              content,
              result.value.entity.revision,
              ports.now(),
            );

            if (!current(active)) return 'ended';
            if (rebased !== null) {
              if (rebased.baseRevision === result.value.entity.revision) adopted = 'adopted';
              publishRecord(editKey, rebased);
              // The row's authored content changed without its version moving, which is exactly what
              // `confirm` expresses. Without it the core would keep the content it was tracking and
              // the next diff would be taken against writing nobody did.
              core.confirm(editKey, null, rebased.content);
              // And the screen must show it. `open` rebases before any editor is attached, but a
              // lifecycle action's read runs under one, which holds the text it first rendered.
              bumpContentEpoch(editKey);
            }
          }
        } else if (existing.inflightVersion !== null) {
          // An answer was lost. Reconciled from the entity this very call read, rather than by a
          // second Get: it is strictly fresher, and two reads can disagree in ways these rules assume
          // away. A failed Get leaves the record unconfirmed, and its standing says so.
          await applyReconciliation(editKey, result);
          if (!current(active)) return 'ended';
        }
      } catch {
        adopted = 'stale';
        // Whatever was written is what the standing already describes, so the record opens as it
        // stands. The row is tracked and published before either branch runs, and neither leaves
        // anything half-applied that a later read could misinterpret.
      }

      // A reconciliation that settled and forgot the record leaves nothing to describe.
      if (recordOf(editKey) !== null) {
        learnLocation(editKey, locationOf(result));
        learnLifecycle(editKey, lifecycleOf(result));
      }

      return adopted;
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
      locations: {},
      lifecycles: {},
      contentEpochs: {},

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
        work.clear();
        heldLeases.clear();
        barriers.clear();
        releasing.clear();

        set({
          status: 'idle',
          problem: null,
          edits: [],
          unusableEdits: [],
          sending: [],
          checking: [],
          protection: {},
          locations: {},
          lifecycles: {},
          contentEpochs: {},
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

        /**
         * The read and everything done with it, as the record's work.
         *
         * Registered before the Get is issued and released only once the record is up to date, because
         * a read that predates a dispatch is not evidence about it: a move or a send started while this
         * Get was in the air could otherwise have its envelope cleared by the unchanged-revision rule.
         * A timer that fires meanwhile joins this and sends nothing; the tick scheduled at the end
         * picks it up.
         */
        return claim(editKey, async (): Promise<EditOpenOutcome> => {
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

          if ((await adoptRead(active, editKey, key, result)) === 'ended') {
            return { kind: 'unavailable', failure: null };
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

          return {
            kind: 'ready',
            editKey,
            location: locationOf(result),
            lifecycle: lifecycleOf(result),
          };
        }).catch((): EditOpenOutcome => ({ kind: 'unavailable', failure: null }));
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
        // A successful exit hands its lock to the unmount and never calls `release`, and `detach` drops
        // the lease on its own. A tracked identity the core no longer holds would send every later
        // barrier down the held-lease branch, where it could never settle.
        heldLeases.delete(token.id);
        core.detach(token);
      },

      snapshotAccepted: (token, snapshot) => {
        const result = core.accept(token, snapshot);

        if (result === 'accepted') scheduleTick(token.id, autosaveDelayMs);

        return result;
      },

      flush: (editKey, options) => core.flush(editKey, options?.lock ?? false),

      beginControlledExit: async (editKey) => {
        // Through the owner's gate: a lease requested while a barrier or a deferred release is in
        // progress waits for it rather than displacing the identity that protects it.
        const lease = await acquireLease(editKey);

        if (lease === null) {
          return { result: { kind: 'unanswered' } as FlushResult, release: () => {} };
        }

        const result = await core.flush(editKey, true);

        if (result.kind === 'flushed') lease.version = result.version;
        // Always editable again: `locked` for an edit means a barrier is settling, never that a
        // request is in the air. Inheriting the creation owner's in-flight lock here would freeze the
        // editor every couple of seconds while someone types.
        else releaseHeld(editKey, lease, true);

        return {
          result,
          // Deferred past any barrier using this lease, so the transition it protects finishes first.
          release: () => {
            releaseHeld(editKey, lease, true);
          },
        };
      },

      move: (editKey, destination) =>
        claim(editKey, async () => {
          try {
            return await runMove(editKey, destination.parentId);
          } finally {
            rearmAfterMove(editKey);
          }
        }).catch((): MoveOutcome => ({ kind: 'unconfirmed' })),

      archive: (editKey) => lifecycleAction(editKey, 'archive'),

      restore: (editKey) => lifecycleAction(editKey, 'restore'),

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
            // As the record's work: a move or send started meanwhile persists its envelope before it
            // is marked as sending, and deleting the row in that interval would lose its intent.
            await claim(editKey, () => forget(editKey));

            // The row was judged settled before this waited for its turn, and a move started in the
            // meantime may have left it unconfirmed, conflicted, or refused. Answer from what it is
            // now: gone, or still settled because the delete failed and Recovery keeps it, is
            // `settled`; anything else goes round again against the remaining budget.
            const after = recordOf(editKey);

            if (
              after === null ||
              (after.inflightVersion === null &&
                after.syncState === 'syncing' &&
                after.acknowledgedVersion >= (core.committed(editKey)?.version ?? 0))
            ) {
              return 'settled';
            }

            continue;
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

        /**
         * The deletion is the record's work, like a send or a move. A send persists its envelope before
         * it is marked as sending, so between the two a record looks idle; deleting it then would let
         * the request leave with no durable intent behind it to reconcile a lost answer. Waiting for
         * the slot means a send or move that has begun is answered first, and nothing can mark the
         * record while it is being deleted.
         */
        return claim(editKey, async (): Promise<ActionOutcome> => {
          // The owner may have closed while this waited for its turn.
          if (!current(active)) return { kind: 'refused', problem: NO_STORE_PROBLEM };

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
          dropRecordState(editKey);
          publishRecord(editKey, null);
          set((state) => ({
            unusableEdits: state.unusableEdits.filter(
              (candidate) => editKeyOf(candidate.key) !== editKey,
            ),
          }));

          return { kind: 'done' };
        });
      },

      standingFor: standingOf,
    };
  });

export type EditOwner = ReturnType<typeof createEditOwner>;

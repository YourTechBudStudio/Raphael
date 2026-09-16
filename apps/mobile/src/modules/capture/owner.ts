/**
 * The one thing that protects writing and sends a creation, and the only thing allowed to.
 *
 * It is app-scoped rather than screen-scoped, and that is the design rather than a convenience. A
 * dispatcher that lived in a route would be destroyed when the route unmounted, so an answer
 * arriving after someone navigated away would have nowhere to be written; reopening the route would
 * build a second dispatcher for the same attempt; and a connection switch mid-flight would leave a
 * result with no owner at all. Concurrency is prevented here, by in-flight sets keyed on durable
 * ids - a disabled button is a hint, not an invariant.
 *
 * The order of writes is the whole discipline, and it is the same in every path:
 *
 *   persist, then send. A local write that fails means nothing was sent, and says so.
 *   persist the answer, then present it. A success nobody wrote down is a success that is lost.
 *   clear only what has been consumed, and only when both memory and the database agree nothing
 *   newer exists. Either one saying otherwise retains, because retention is the only direction that
 *   cannot lose writing.
 *
 * The store holds evidence; this holds the rules. Every rule that decides whether writing may be
 * cleared or a request may be sent is one expression here or in `policy.ts`, never spread across the
 * components that draw the buttons.
 */

import type { ClientFailure, ClientResult } from '@raphael/client';
import { createEmptyDocument } from '@raphael/content';
import type { CreateResponse } from '@raphael/contracts/nodes';
import { create as createStore } from 'zustand';

import type { Transport } from '../../infrastructure/api/transport';
import type { BarrierResult, EditorPort, EditorRejectionCode, EditorSnapshot } from '../editor';
import { freezeNoteRequest, thawNoteRequest, UNUSABLE_PAYLOAD_MESSAGE } from './freeze.ts';
import { deriveStanding, evaluateEligibility, type Standing } from './policy.ts';
import type {
  AcknowledgeWrite,
  CaptureStore,
  NewIntent,
  OpenOutcome,
  StoreFailure,
  StoredCapture,
} from './store.ts';
import type {
  AcknowledgedNote,
  AttemptOutcome,
  Destination,
  NoteAttemptRecord,
  NoteDraftRecord,
  UnusableDraft,
} from './types.ts';

/** How long a flush waits for the editor before concluding it knows nothing about newer writing. */
export const FLUSH_TIMEOUT_MS = 1500;

/** What the owner needs from the world. Everything platform-shaped, so a test can drive all of it. */
export interface CapturePorts {
  /** Opens, migrates, and reconciles. The sweep runs inside this, before anything can dispatch. */
  openStore(): Promise<OpenOutcome>;
  create(transport: Transport, request: unknown): Promise<ClientResult<CreateResponse>>;
  /** Wall clock. */
  now(): number;
  /** Monotonic milliseconds, immune to the clock being set. */
  monotonic(): number;
  newId(): string;
  /**
   * Report an acknowledged creation to whatever caches it affects, fenced by the activation it was
   * made under. A late completion from a retired connection must change nothing that is on screen.
   * A failure here is a failed refresh, never a failed save.
   */
  applyCreation(response: CreateResponse, activation: number): Promise<void>;
  /**
   * Whether this session is the one the app is working under **right now**.
   *
   * Asked synchronously during admission, and it is not the same question as "does this session's
   * connection id match the draft's". A credential rotation against the same address keeps the
   * connection id and mints a new activation, so a callback holding the session from before it would
   * pass every other check and then dispatch with a transport the server has stopped accepting -
   * spending an attempt and recording a refusal that says nothing about the creation. A switch to a
   * different server is worse: `createDraft` would happily file new writing under the connection
   * that is gone.
   *
   * The owner cannot answer this itself - only the composition knows which session is live - so it
   * is a port rather than a field, and it is required rather than optional, because a default of
   * "yes" would be an escape hatch that silently reopens exactly this hole.
   *
   * It governs **starting** work only. A response to a request already in flight still resolves its
   * own attempt, because that attempt is evidence about something that may already have reached a
   * server; what it may not do is populate a cache, which `applyCreation` fences separately.
   */
  sessionIsCurrent(session: CaptureSession): boolean;
  readonly flushTimeoutMs?: number | undefined;
  setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((handle: unknown) => void) | undefined;
}

/** The connection an operation is performed under, captured when it starts. */
export interface CaptureSession {
  readonly activation: number;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly transport: Transport;
  /** False when the connection has an unresolved authentication or protocol problem. */
  readonly usable: boolean;
}

/**
 * Why capture cannot work on this phone right now.
 *
 * Bounded on purpose. The wording a person sees is the surface's, written from `reason`; nothing a
 * driver said reaches it, and there is no free-text field for one to arrive through.
 */
export type StoreProblem =
  | { readonly kind: 'unsupported_version'; readonly found: number; readonly supported: number }
  | { readonly kind: 'failed'; readonly reason: StoreFailure };

/**
 * A live editor bound to one draft.
 *
 * The token names the draft, the attachment generation and the specific port. Replacing an
 * attachment retires the earlier token, and a late `detachEditor` from the retired one removes
 * nothing - which is what stops a slow unmount tearing down its own replacement.
 */
export interface AttachmentToken {
  readonly draftId: string;
  readonly generation: number;
}

/**
 * What accepting a snapshot did.
 *
 * `unchanged` is an ordinary outcome, not a failure: a requested snapshot that matches what the
 * owner already holds confirms the barrier without inventing an authored change. `retired` means the
 * message came from an attachment, session or sequence that is no longer current - an expected race,
 * never a user-facing editor problem, and never a write.
 */
export type SnapshotResult = 'accepted' | 'unchanged' | 'retired';

/**
 * How a flush ended. The fourth outcome exists because the editor can answer a flush with a refusal.
 *
 * `captured: 'no_editor'` is deliberately distinguishable. It means the owner committed what it
 * already held plus the current native fields, and it is **not** a claim that renderer-only writing
 * was captured - there was no renderer to ask. A live but unresponsive editor answers `unanswered`
 * instead, which is a different sentence and has to stay one.
 */
export type FlushResult =
  | {
      readonly kind: 'flushed';
      readonly version: number;
      readonly captured: 'editor' | 'no_editor';
    }
  /** No reply in time. Nothing is known about work since the last accepted snapshot. */
  | { readonly kind: 'unanswered' }
  /** The document exists only in the live editor. Never repaired, dropped, or reported as saved. */
  | { readonly kind: 'refused'; readonly code: EditorRejectionCode }
  /** Snapshot accepted, the local write failed. The last committed snapshot is intact. */
  | { readonly kind: 'not_persisted'; readonly version: number };

export type NotSavedReason =
  | 'no_store'
  | 'no_connection'
  /** The app has moved on from this session. Nothing is sent under a retired activation. */
  | 'retired_connection'
  | 'wrong_connection'
  | 'no_destination'
  | 'already_saving'
  | 'not_admitted'
  | 'editor_unanswered'
  | 'editor_refused'
  | 'not_recorded';

export type SaveOutcome =
  /** Persisted and dispatched. The attempt is the owner's now; watch its record for the rest. */
  | { readonly kind: 'dispatched'; readonly attemptId: string }
  | {
      readonly kind: 'not_saved';
      readonly reason: NotSavedReason;
      readonly problem: string;
      readonly code?: EditorRejectionCode;
    };

export type ActionOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'refused'; readonly problem: string };

export type DraftOutcome =
  | { readonly kind: 'created'; readonly draftId: string }
  | { readonly kind: 'refused'; readonly problem: string };

/**
 * What the owner knows about a draft that the database cannot see.
 *
 * Published because the surface has to be able to say "everything you have written is saved on this
 * phone" only up to `committedVersion`, and has to say something different when it is not.
 */
export interface DraftProtection {
  readonly committedVersion: number;
  readonly latestAcceptedVersion: number;
  /** A newer accepted version is waiting for its turn to be written. */
  readonly pending: boolean;
  readonly writing: boolean;
  /**
   * The last local write failed, so the newer work is in memory and is not protected.
   *
   * A flag, not the driver's sentence: the surface has its own wording for this, and a SQLite
   * message would be both worse to read and a way for implementation detail to reach a screen.
   */
  readonly failedWrite: boolean;
  /** The last flush went unanswered or was refused, so the renderer may hold writing native never saw. */
  readonly rendererUnknown: boolean;
  readonly locked: boolean;
  readonly attached: boolean;
}

export interface CaptureState {
  readonly status: 'idle' | 'opening' | 'ready' | 'unavailable';
  /** Why the store is unavailable. Never a reason to fall back to memory. */
  readonly problem: StoreProblem | null;
  readonly drafts: readonly NoteDraftRecord[];
  /** Retained drafts this build cannot open. Never silently dropped, never counted as zero. */
  readonly unusableDrafts: readonly UnusableDraft[];
  readonly attempts: readonly NoteAttemptRecord[];
  readonly unreadableAttempts: number;
  /** Attempt ids this process is sending right now. */
  readonly sending: readonly string[];
  /** Draft ids with an admitted Save or Retry. */
  readonly saving: readonly string[];
  /**
   * Server successes whose local acknowledgement could not be written, by attempt id.
   *
   * Known creations, held until the write succeeds. The creation is not reported as failed - it
   * demonstrably was not - and what is offered is a retry of the local write, never another
   * creation to repair local storage.
   */
  readonly unsaved: Readonly<Record<string, AcknowledgedNote>>;
  readonly protection: Readonly<Record<string, DraftProtection>>;

  /** Open the database, migrate it, and adopt anything a previous process left mid-dispatch. */
  initialize(): Promise<void>;
  /**
   * Try again after an unavailable store. A no-op while one is already open.
   *
   * It deliberately cannot replace a healthy store. Closing a live connection and swapping another
   * in beneath work that is already running would be a larger race than the handle it saves.
   */
  retryOpen(): Promise<void>;
  /**
   * Close the owner and return it to its unopened state.
   *
   * For the app-scoped composition being torn down, and for tests that must not depend on process
   * exit. Idempotent; the current store is closed exactly once; an open still in progress is awaited
   * and its result closed rather than published; attachments, leases and flush deadlines are
   * retired; and nothing in flight can publish through the closed lifecycle.
   *
   * It is not a cancellation. A persisted `dispatch_intent` stays exactly where it is, because the
   * request it records may already have reached a server - the next open's sweep adopts it as
   * uncertain, which is what that state is for.
   */
  close(): Promise<void>;
  createDraft(session: CaptureSession): Promise<DraftOutcome>;
  /**
   * Copy authored content into a separate new draft under the current connection.
   *
   * The only way a second creation for the same writing can ever be started, and it is always
   * user-initiated. The original draft, its attempt and its evidence are left exactly as they are;
   * the copy drops the server identity, the base revision, the attempt and the key, and requires a
   * fresh destination.
   */
  copyDraft(draftId: string, session: CaptureSession): Promise<DraftOutcome>;
  editDraft(draftId: string, fields: { title?: string; description?: string }): void;
  selectDestination(
    draftId: string,
    destination: Destination,
    session: CaptureSession,
  ): Promise<ActionOutcome>;
  attachEditor(draftId: string, port: EditorPort): AttachmentToken | null;
  detachEditor(token: AttachmentToken): void;
  snapshotAccepted(token: AttachmentToken, snapshot: EditorSnapshot): SnapshotResult;
  flush(draftId: string, options?: { lock?: boolean }): Promise<FlushResult>;
  /**
   * Controlled navigation: flush under a lock and keep it until the route actually goes.
   *
   * The lock is what makes "this snapshot is the last word" true at the moment the editor is
   * destroyed. `release` exists because cancelling the navigation has to give the editor back;
   * successful navigation holds it through `detachEditor`.
   */
  beginControlledExit(draftId: string): Promise<{ result: FlushResult; release: () => void }>;
  save(draftId: string, session: CaptureSession): Promise<SaveOutcome>;
  retry(draftId: string, session: CaptureSession): Promise<ActionOutcome>;
  saveAcknowledgement(attemptId: string): Promise<ActionOutcome>;
  /** The UI has shown a success, so the record has done its job. Never removes an unwritten one. */
  consumeReceipt(attemptId: string): Promise<void>;
  discardDraft(draftId: string): Promise<ActionOutcome>;
  standingFor(draftId: string): Standing | null;
}

const NO_STORE_PROBLEM = 'Raphael cannot save notes on this phone right now, so nothing was sent.';
const NO_DRAFT_PROBLEM = 'That note is no longer on this phone.';
const NO_CONNECTION_PROBLEM =
  'Your server is not accepting requests right now, so nothing was sent. Fix the connection and save again.';
const WRONG_CONNECTION_PROBLEM =
  'This note belongs to a different server. Connect to it to send it again.';
const RETIRED_CONNECTION_PROBLEM =
  'Your connection changed, so nothing was sent. Open this note again to save it.';
const NO_DESTINATION_PROBLEM = 'Choose where this note goes before saving it.';
const ALREADY_SAVING_PROBLEM = 'This note is already being saved.';
const NOT_RECORDED_PROBLEM =
  'Raphael could not save a record of this attempt on this phone, so it was not sent. Save again to try.';
const NO_IDENTIFIER_PROBLEM =
  'Raphael could not generate an identifier for this attempt on this phone, so nothing was sent.';
const EDITOR_UNANSWERED_PROBLEM =
  'The editor did not answer, so Raphael does not know what you have written since the last saved change. Nothing was sent.';
const EDITOR_REFUSED_PROBLEM =
  'Raphael could not take a copy of this note, so nothing was sent. What you wrote is still in the editor.';
const WRITE_FAILED_PROBLEM = 'Raphael could not write this change to this phone.';
const DISCARD_FAILED_PROBLEM = 'Raphael could not remove this note. It is still on this phone.';
const DISCARD_SENDING_PROBLEM = 'This note is being sent. Wait for an answer before discarding it.';
const NOT_ADMITTED_PROBLEM = 'This note cannot be saved again.';
const RETRY_INELIGIBLE_PROBLEM = 'This request can no longer be sent again.';
const RETRY_CONFLICT_PROBLEM =
  'Your server refused this request as a conflict, so sending it again cannot help. Look in the destination before creating the note again.';
const RETRY_UNUSABLE_PROBLEM = UNUSABLE_PAYLOAD_MESSAGE;
const ACK_UNSAVED_PROBLEM = 'Raphael still could not record this result on this phone.';

/** The sentence for a replay that was refused, chosen from the standing rather than an outcome. */
const unsendableProblem = (standing: Standing | null): string => {
  if (standing?.kind !== 'blocked' || standing.reason !== 'unresolved_unsendable') {
    return RETRY_INELIGIBLE_PROBLEM;
  }

  return standing.cause === 'conflict' ? RETRY_CONFLICT_PROBLEM : RETRY_UNUSABLE_PROBLEM;
};

const outcomeOf = (failure: ClientFailure, at: number): AttemptOutcome => ({
  kind:
    failure.mutationOutcome === 'unknown'
      ? 'unknown'
      : failure.mutationOutcome === 'rejected'
        ? 'rejected'
        : 'not_dispatched',
  // Only a well-formed Raphael envelope carries a code, and only its code is kept - never the
  // envelope, never an exception, never a decoder's own words.
  code: failure.kind === 'api_error' ? failure.error.code : null,
  message: failure.message,
  at,
});

/** The lock one path holds. Identity matters: continuity is "this same lease, unbroken". */
interface Lease {
  readonly draftId: string;
  /** The version the flush under this lease produced, or null when it never got one. */
  version: number | null;
}

interface Attachment {
  readonly token: AttachmentToken;
  readonly port: EditorPort;
  sessionId: number | null;
  lastSeq: number;
}

/** Everything the owner holds about one draft that is not in the database. */
interface Work {
  readonly draftId: string;
  title: string;
  description: string;
  destination: Destination | null;
  document: unknown;
  committed: number;
  latestAccepted: number;
  /** At most one, replaced rather than queued behind. Depth one, latest wins. */
  pending: number | null;
  writing: number | null;
  runner: Promise<void> | null;
  failedWrite: boolean;
  rendererUnknown: boolean;
  attachment: Attachment | null;
  generation: number;
  lease: Lease | null;
  inFlight: boolean;
  flushing: Promise<FlushResult> | null;
  /** Flushes run one at a time per draft, in the order they were asked for. */
  flushTail: Promise<unknown>;
}

export const createCaptureOwner = (ports: CapturePorts) =>
  createStore<CaptureState>((set, get) => {
    let store: CaptureStore | null = null;
    const works = new Map<string, Work>();
    /** One dispatcher per durable attempt, ever. Enforced here, not by a disabled control. */
    const sending = new Set<string>();
    /** Monotonic marks for attempts this process dispatched. Absent for recovered ones. */
    const dispatchedAt = new Map<string, number>();

    /**
     * Which lifetime the owner is on. Incremented by `close`, so an open that comes back afterwards
     * can tell that the decision it is about to publish has been overtaken.
     */
    let lifetime = 0;
    /** An open that has not finished, so `close` can await it rather than race it. */
    let opening: Promise<void> | null = null;
    /**
     * Abandon callbacks for flush deadlines that are still waiting.
     *
     * A barrier whose editor never answers is ended by its own timer. If the owner closes first that
     * timer is the only thing left holding the caller, so closing settles them rather than clearing
     * them: a cleared timer would leave a promise nobody ever resolves.
     */
    const deadlines = new Set<() => void>();

    /**
     * Whether the store a piece of work started against is still the owner's.
     *
     * The store object *is* the lifetime: a close nulls it and a later open produces a different
     * one, so this single comparison fences every late completion - a write, a dispatch, an
     * acknowledgement - out of a lifecycle it no longer belongs to.
     */
    const current = (active: CaptureStore | null): boolean => active !== null && store === active;

    const setTimer = ports.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer =
      ports.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const flushTimeoutMs = ports.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;

    const protectionOf = (work: Work): DraftProtection => ({
      committedVersion: work.committed,
      latestAcceptedVersion: work.latestAccepted,
      pending: work.pending !== null,
      writing: work.writing !== null,
      failedWrite: work.failedWrite,
      rendererUnknown: work.rendererUnknown,
      locked: work.lease !== null,
      attached: work.attachment !== null,
    });

    const publishProtection = (): void => {
      const protection: Record<string, DraftProtection> = {};
      for (const [draftId, work] of works) protection[draftId] = protectionOf(work);
      set({ protection });
    };

    const publishWorking = (): void => {
      set({
        sending: [...sending],
        saving: [...works.values()].filter((w) => w.inFlight).map((w) => w.draftId),
      });
    };

    /**
     * Publish one record the store has just written.
     *
     * This, not a whole-table reread, is how a transition becomes visible. Writing and then
     * rereading to discover what had been written means a failed read can leave the app holding the
     * row as it was *before* a success already committed - the creation would present as unresolved
     * and the bar would offer to make it again under a new key.
     */
    const publishDraft = (draftId: string, written: NoteDraftRecord | null): void => {
      set((state) => {
        const without = state.drafts.filter((draft) => draft.draftId !== draftId);

        return written === null ? { drafts: without } : { drafts: [...without, written] };
      });
    };

    const publishAttempt = (attemptId: string, written: NoteAttemptRecord | null): void => {
      set((state) => {
        const without = state.attempts.filter((attempt) => attempt.attemptId !== attemptId);

        return written === null ? { attempts: without } : { attempts: [...without, written] };
      });
    };

    const workFrom = (record: NoteDraftRecord): Work => ({
      draftId: record.draftId,
      title: record.title,
      description: record.description,
      destination: record.destination,
      document: record.document,
      committed: record.draftVersion,
      latestAccepted: record.draftVersion,
      pending: null,
      writing: null,
      runner: null,
      failedWrite: false,
      rendererUnknown: false,
      attachment: null,
      generation: 0,
      lease: null,
      inFlight: false,
      flushing: null,
      flushTail: Promise.resolve(),
    });

    /**
     * Take up what the store holds without discarding what this process knows.
     *
     * An existing `Work` is kept: it may hold an accepted version the database has not got yet, a
     * live attachment, or a failed write, and none of that is recoverable from a row.
     */
    const adopt = (stored: StoredCapture): void => {
      for (const record of stored.drafts) {
        const existing = works.get(record.draftId);
        if (existing === undefined) works.set(record.draftId, workFrom(record));
        else existing.committed = Math.max(existing.committed, record.draftVersion);
      }
      for (const draftId of [...works.keys()]) {
        if (!stored.drafts.some((draft) => draft.draftId === draftId)) works.delete(draftId);
      }

      set({
        drafts: stored.drafts,
        unusableDrafts: stored.unusableDrafts,
        attempts: stored.attempts,
        unreadableAttempts: stored.unreadableAttempts,
      });
      publishProtection();
    };

    /**
     * The coalescing writer: one write in progress, at most one pending version behind it.
     *
     * A new change replaces the pending slot rather than queueing behind it, so a long note being
     * typed into cannot accumulate a queue of full documents. The write itself is guarded in SQL on
     * the version moving forward, so a write that lost a race cannot make an older snapshot the
     * latest protected one.
     */
    const runWrites = async (work: Work): Promise<void> => {
      const active = store;
      if (active === null) return;

      while (work.pending !== null) {
        if (!current(active)) return;

        const version = work.pending;
        work.pending = null;
        work.writing = version;
        const snapshot = {
          draftId: work.draftId,
          title: work.title,
          description: work.description,
          document: work.document,
          destination: work.destination,
          draftVersion: version,
          at: ports.now(),
        };
        publishProtection();

        try {
          const record = await active.writeVersion(snapshot);

          if (!current(active)) return;
          work.failedWrite = false;
          if (record !== null) {
            work.committed = Math.max(work.committed, record.draftVersion);
            publishDraft(work.draftId, record);
          }
        } catch {
          // The newer work stays in memory and is reported unprotected. The last committed snapshot
          // is intact, and nothing here resets, recreates, or falls back to memory for storage. The
          // cause is not carried outward: it is a driver's sentence about our own schema.
          if (!current(active)) return;
          work.failedWrite = true;
        } finally {
          work.writing = null;
          if (current(active)) publishProtection();
        }
      }
    };

    const schedule = (work: Work): void => {
      // Nothing to write is not a write. A drain that scheduled unconditionally would put a full
      // document through SQLite every time anything asked whether the draft was protected.
      if (
        work.committed >= work.latestAccepted &&
        work.writing === null &&
        work.pending === null &&
        !work.failedWrite
      ) {
        return;
      }

      work.pending = work.latestAccepted;
      if (work.runner !== null) return;

      work.runner = runWrites(work).finally(() => {
        work.runner = null;
      });
    };

    /** Wait until nothing is queued or in progress for this draft. */
    const drain = async (work: Work): Promise<void> => {
      schedule(work);
      while (work.runner !== null) await work.runner;
    };

    const commitOutcome = (work: Work): FlushResult =>
      work.committed >= work.latestAccepted
        ? { kind: 'flushed', version: work.committed, captured: 'editor' }
        : { kind: 'not_persisted', version: work.latestAccepted };

    const accept = (token: AttachmentToken, snapshot: EditorSnapshot): SnapshotResult => {
      const work = works.get(token.draftId);
      const attachment = work?.attachment ?? null;

      if (work === undefined || attachment === null || attachment.token !== token) {
        return 'retired';
      }
      // Within one session the sequence orders the messages; a new session restarts it, so a
      // sequence comparison across sessions would silently drop a restarted renderer's first
      // snapshot. Both are expected races and neither is an editor problem.
      if (attachment.sessionId === snapshot.sessionId && snapshot.editSeq <= attachment.lastSeq) {
        return 'unchanged';
      }

      attachment.sessionId = snapshot.sessionId;
      attachment.lastSeq = snapshot.editSeq;
      // The editor answered, so whatever it was holding, native has it now.
      work.rendererUnknown = false;

      if (JSON.stringify(snapshot.document) === JSON.stringify(work.document)) {
        publishProtection();

        return 'unchanged';
      }

      work.document = snapshot.document;
      work.latestAccepted += 1;
      schedule(work);
      publishProtection();

      return 'accepted';
    };

    /**
     * A promise that answers `unanswered` if the editor does not.
     *
     * The port applies its own deadline, and this is not a second guess at the same one: a port that
     * never settles at all - a renderer that is gone, a controller that was disposed mid-call - would
     * otherwise hold a Save open forever with the editor locked.
     */
    const withDeadline = (pending: Promise<BarrierResult>): Promise<BarrierResult> =>
      new Promise<BarrierResult>((resolve) => {
        let handle: unknown = null;
        let settled = false;

        const finish = (result: BarrierResult): void => {
          if (settled) return;
          settled = true;
          clearTimer(handle);
          // eslint-disable-next-line no-use-before-define -- assigned before anything can call this
          deadlines.delete(abandon);
          resolve(result);
        };
        const abandon = (): void => {
          finish({ kind: 'unanswered' });
        };

        handle = setTimer(abandon, flushTimeoutMs);
        deadlines.add(abandon);

        void pending.then(finish, abandon);
      });

    /**
     * The one barrier, used by lifecycle, by controlled navigation, and by Save.
     *
     * Three things in order, rather than only awaiting a native write: ask the editor for a snapshot
     * (locking first when asked, so nothing can change under the flush), fold the reply into the
     * draft together with the current native fields, and await the SQLite commit of that version.
     */
    const flushWork = async (work: Work, lock: boolean): Promise<FlushResult> => {
      const attachment = work.attachment;

      if (attachment === null) {
        // Nothing renderer-only can exist to lose: there is no renderer. What is committed is what
        // the owner already holds plus the current native fields, and the outcome says so.
        await drain(work);
        const committed = commitOutcome(work);

        return committed.kind === 'flushed' ? { ...committed, captured: 'no_editor' } : committed;
      }

      let asked: Promise<BarrierResult>;

      try {
        asked = Promise.resolve(attachment.port.requestSnapshot({ lock }));
      } catch {
        asked = Promise.resolve<BarrierResult>({ kind: 'unanswered' });
      }

      const barrier = await withDeadline(asked);

      if (barrier.kind === 'unanswered') {
        work.rendererUnknown = true;
        publishProtection();

        return { kind: 'unanswered' };
      }
      if (barrier.kind === 'refused') {
        // The document was never handed over: the live editor is the sole copy. It is never
        // repaired, never dropped, and never reported as saved.
        work.rendererUnknown = true;
        publishProtection();

        return { kind: 'refused', code: barrier.code };
      }

      accept(attachment.token, barrier.snapshot);
      await drain(work);

      return commitOutcome(work);
    };

    const flushOnce = (draftId: string, lock: boolean): Promise<FlushResult> => {
      const work = works.get(draftId);

      if (work === undefined) {
        return Promise.resolve({ kind: 'unanswered' } satisfies FlushResult);
      }
      // Serialized rather than shared. A caller that asked for a lock cannot be answered by a
      // barrier someone else took without one: the whole point of locking first is that no edit can
      // be generated between the capture and the commit, and a shared unlocked flush would report a
      // version taken with that window wide open. Two flushes in a row cost a drain with nothing to
      // write, which is nothing.
      const body = work.flushTail.then(
        () => flushWork(work, lock),
        () => flushWork(work, lock),
      );
      // The published promise clears the slot as it settles, and only if it is still the current
      // one - a later flush queued behind it owns the slot from the moment it was asked for.
      const running: Promise<FlushResult> = body.finally(() => {
        if (work.flushing === running) work.flushing = null;
      });

      work.flushTail = running.then(
        () => undefined,
        () => undefined,
      );
      work.flushing = running;

      return running;
    };

    const takeLease = (work: Work): Lease => {
      const lease: Lease = { draftId: work.draftId, version: null };
      work.lease = lease;
      publishProtection();

      return lease;
    };

    /**
     * Give the lock back, unless an attempt is still in flight for this draft.
     *
     * Every exit runs this, including the ones an HTTP-shaped rule would miss: a flush that came
     * back unanswered, refused or unpersisted, a freeze rejection, and a failed intent write. Each
     * of those must leave the person able to correct the input and press Save again without
     * remounting the route, which is exactly what a leaked lock would prevent.
     */
    const releaseLease = (work: Work, lease: Lease): void => {
      if (work.lease !== lease) return;
      work.lease = null;
      if (!work.inFlight) work.attachment?.port.setEditable(true);
      publishProtection();
    };

    /**
     * Whether consumed content may be cleared, from everything the owner knows.
     *
     * The database asks the same question again inside the acknowledgement transaction. Either
     * saying newer work exists takes the retain branch, so the pair can only err toward retention -
     * the only direction that cannot lose writing.
     *
     * The lock is what makes this a statement about the moment of acknowledgement rather than about
     * the instant the flush was taken: an edit made a moment after a drain sits in the editor's own
     * debounce where neither condition could see it. So either the lease that produced the submitted
     * version is still held unbroken, or there is no live editor for this draft at all.
     */
    const clearable = (work: Work, lease: Lease | null, submittedVersion: number): boolean => {
      const locked =
        work.attachment === null ||
        (lease !== null && work.lease === lease && lease.version === submittedVersion);

      return (
        locked &&
        work.latestAccepted === submittedVersion &&
        work.pending === null &&
        work.writing === null &&
        !work.failedWrite &&
        !work.rendererUnknown &&
        work.flushing === null
      );
    };

    /** Write a clock anomaly down. Once recorded it is permanent for that attempt. */
    const recordAnomaly = async (
      active: CaptureStore,
      attempt: NoteAttemptRecord,
    ): Promise<void> => {
      try {
        publishAttempt(
          attempt.attemptId,
          await active.markClockAnomaly(attempt.attemptId, ports.now()),
        );
      } catch {
        // The refusal stands either way; only its persistence failed.
      }
    };

    const standingOf = (draftId: string): Standing | null => {
      const draft = get().drafts.find((candidate) => candidate.draftId === draftId);

      if (draft === undefined) return null;

      return deriveStanding({
        draft,
        attempts: get().attempts,
        confirmed: (attemptId) => get().unsaved[attemptId],
        now: ports.now(),
        monotonicElapsedMs: (attemptId) => {
          const mark = dispatchedAt.get(attemptId);

          return mark === undefined ? null : ports.monotonic() - mark;
        },
        // Asked now rather than read from an older observation, and asked only for an attempt that
        // is otherwise replayable, so the cost is a decode on a path that is already rare.
        payloadUsable: (attempt) => thawNoteRequest(attempt.request).ok,
      });
    };

    /**
     * Put the draft back to editable `composing` after an attempt that created nothing we know of.
     *
     * The unresolved attempt, not this column, is what still refuses ordinary Save. Leaving the
     * draft at `submitted` would refuse editing too, which is the opposite of what an unresolved
     * attempt calls for.
     */
    const releaseDraft = async (active: CaptureStore, work: Work): Promise<void> => {
      try {
        const written = await active.releaseDraft(work.draftId, ports.now());
        if (written !== null && current(active)) publishDraft(work.draftId, written);
      } catch {
        // The next open's sweep does the same thing, which is what it is for.
      }
    };

    const recordAcknowledgement = async (
      active: CaptureStore,
      work: Work,
      attempt: NoteAttemptRecord,
      response: CreateResponse,
      result: AcknowledgedNote,
      lease: Lease | null,
    ): Promise<void> => {
      const write: AcknowledgeWrite = {
        attemptId: attempt.attemptId,
        draftId: attempt.draftId,
        result,
        response: JSON.stringify(response),
        submittedVersion: attempt.submittedDraftVersion,
        clearContent: clearable(work, lease, attempt.submittedDraftVersion),
        emptyDocument: createEmptyDocument(),
        at: ports.now(),
      };

      try {
        const written = await active.acknowledge(write);

        // The write landed, whatever the owner has done since. What must not happen is publishing
        // it into a lifetime that has already been closed and reset.
        if (!current(active)) return;

        if (written.cleared) {
          work.title = '';
          work.description = '';
          work.document = createEmptyDocument();
        }
        if (written.draft !== null) {
          work.committed = Math.max(work.committed, written.draft.draftVersion);
          work.latestAccepted = Math.max(work.latestAccepted, written.draft.draftVersion);
        }
        publishDraft(attempt.draftId, written.draft);
        publishAttempt(attempt.attemptId, written.attempt);
        set((state) => {
          const { [attempt.attemptId]: _saved, ...rest } = state.unsaved;

          return { unsaved: rest };
        });
        publishProtection();
      } catch {
        // The server created it. Only the local note of that failed, so the creation is reported as
        // the success it is, with the result held here until the write lands. What is offered is a
        // retry of that write, never a second creation.
        if (current(active)) {
          set((state) => ({ unsaved: { ...state.unsaved, [attempt.attemptId]: result } }));
        }
      }
    };

    /**
     * Send one attempt, whatever brought us here.
     *
     * Shared by the first dispatch and every replay, because what happens to the answer must not
     * depend on which button was pressed. The frozen request is validated on the way out and the
     * record is kept if it does not survive: a payload this build would change is refused, never
     * rewritten.
     */
    const dispatch = async (
      work: Work,
      attempt: NoteAttemptRecord,
      session: CaptureSession,
      lease: Lease | null,
    ): Promise<void> => {
      const active = store;
      if (active === null) return;

      /**
       * Publish a transition, unless the owner has been closed underneath this dispatch.
       *
       * The write itself is never skipped - it is evidence about a request that may already have
       * reached a server, and it belongs on disk either way. What is skipped is republishing it into
       * a lifetime that has been torn down and reset.
       */
      const settle = (record: NoteAttemptRecord | null): void => {
        if (current(active)) publishAttempt(attempt.attemptId, record);
      };

      const thawed = thawNoteRequest(attempt.request);

      if (!thawed.ok) {
        settle(
          await active.markBlocked(
            attempt.attemptId,
            {
              kind: 'unusable_payload',
              code: null,
              message: UNUSABLE_PAYLOAD_MESSAGE,
              at: ports.now(),
            },
            ports.now(),
          ),
        );
        await releaseDraft(active, work);

        return;
      }

      sending.add(attempt.attemptId);
      dispatchedAt.set(attempt.attemptId, ports.monotonic());
      publishWorking();

      // Held until after the outcome is recorded and published. Seeding a cache is a consequence of
      // the creation, not part of establishing it.
      let created: CreateResponse | null = null;

      try {
        const result = await ports.create(session.transport, thawed.request);

        if (result.ok) {
          const entity = result.value.entity;

          if (entity.kind === null) {
            // A response this client cannot represent is not a success it may record. It is treated
            // as unknown, because the server may well have created something.
            settle(await active.markUncertain(attempt.attemptId, ports.now()));
            await releaseDraft(active, work);
          } else {
            created = result.value;
            await recordAcknowledgement(
              active,
              work,
              attempt,
              result.value,
              {
                id: entity.id,
                revision: entity.revision,
                title: entity.title,
                kind: entity.kind,
                entity,
              },
              lease,
            );
          }
        } else {
          const at = ports.now();

          settle(
            result.failure.mutationOutcome === 'unknown'
              ? await active.markUncertain(attempt.attemptId, at)
              : await active.markBlocked(attempt.attemptId, outcomeOf(result.failure, at), at),
          );
          await releaseDraft(active, work);
        }
      } catch {
        // The dispatcher itself came apart after the request left. Nothing is known about what the
        // server did, which is exactly what uncertain means.
        try {
          settle(await active.markUncertain(attempt.attemptId, ports.now()));
          await releaseDraft(active, work);
        } catch {
          // Recorded on the next open by the sweep, which is what it is for.
        }
      } finally {
        sending.delete(attempt.attemptId);
        if (current(active)) publishWorking();
      }

      if (created !== null) {
        // Fenced inside the port: a completion from a retired connection changes no cache. A read
        // that fails here is a failed refresh, never a failed save.
        try {
          await ports.applyCreation(created, session.activation);
        } catch {
          // Cache refresh is not what establishes a creation, and its failure cannot undo one.
        }
      }
    };

    /**
     * One open, fenced against a close that overtakes it.
     *
     * `generation` is captured before the await and compared after it. A close that lands in between
     * must not get a published store it has already decided is gone - and must not leak the
     * connection either, so an open that finds itself obsolete closes what it just opened.
     */
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

      if (obsolete()) {
        if (outcome.kind === 'ready') {
          try {
            await outcome.store.close();
          } catch {
            // The owner is closing anyway; a close that also fails changes nothing it can report.
          }
        }

        return;
      }

      if (outcome.kind !== 'ready') {
        set({ status: 'unavailable', problem: outcome });

        return;
      }

      // The first read is part of opening, not a refresh afterwards, and it is strict.
      //
      // A database that opens and then cannot be read is not a database with nothing in it. Going
      // `ready` with empty lists would say "there is nothing unfinished" about a store that has not
      // answered the question - the one sentence this capability must never produce - so the store
      // is closed and reported unavailable instead. Nothing falls back to memory.
      let stored: StoredCapture;

      try {
        stored = await outcome.store.list();
      } catch {
        try {
          await outcome.store.close();
        } catch {
          // The open already failed; a close that also fails changes nothing it can report.
        }
        if (obsolete()) return;
        set({ status: 'unavailable', problem: { kind: 'failed', reason: 'unreadable' } });

        return;
      }

      if (obsolete()) {
        try {
          await outcome.store.close();
        } catch {
          // Closing anyway.
        }

        return;
      }

      store = outcome.store;
      adopt(stored);
      set({ status: 'ready', problem: null });
    };

    /**
     * Open if there is anything to open, and never more than once at a time.
     *
     * This is what both `initialize` and `retryOpen` are. A ready store is left alone: swapping a
     * live connection out from under work that is already running would be a larger race than the
     * one it saves. An open already in progress is joined rather than duplicated.
     */
    const ensureOpen = (): Promise<void> => {
      if (get().status === 'ready') return Promise.resolve();
      if (opening !== null) return opening;

      const running = open().finally(() => {
        if (opening === running) opening = null;
      });
      opening = running;

      return running;
    };

    const newDraft = async (
      session: CaptureSession,
      seed: { title: string; description: string; document: unknown },
    ): Promise<DraftOutcome> => {
      const active = store;

      if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };
      // Asked before `usable`, because a session the app has moved on from is stale about that too.
      if (!ports.sessionIsCurrent(session)) {
        return { kind: 'refused', problem: RETIRED_CONNECTION_PROBLEM };
      }
      if (!session.usable) return { kind: 'refused', problem: NO_CONNECTION_PROBLEM };

      let draftId: string;

      try {
        draftId = ports.newId();
      } catch {
        return { kind: 'refused', problem: NO_IDENTIFIER_PROBLEM };
      }

      try {
        const at = ports.now();
        const record = await active.insertDraft({
          draftId,
          connectionId: session.connectionId,
          endpoint: session.endpoint,
          title: seed.title,
          description: seed.description,
          document: seed.document,
          // A copy always requires a fresh destination: the old one belonged to another attempt,
          // and on another connection it would not even be the same place.
          destination: null,
          at,
        });

        if (record === null) return { kind: 'refused', problem: NOT_RECORDED_PROBLEM };

        works.set(draftId, workFrom(record));
        publishDraft(draftId, record);
        publishProtection();

        return { kind: 'created', draftId };
      } catch {
        return { kind: 'refused', problem: NOT_RECORDED_PROBLEM };
      }
    };

    return {
      status: 'idle',
      problem: null,
      drafts: [],
      unusableDrafts: [],
      attempts: [],
      unreadableAttempts: 0,
      sending: [],
      saving: [],
      unsaved: {},
      protection: {},

      initialize: ensureOpen,

      retryOpen: ensureOpen,

      close: async () => {
        // Bumped first, so everything already in flight is obsolete from this moment on - including
        // an open that has not come back yet, and every write and dispatch holding the old store.
        lifetime += 1;

        const pending = opening;
        const active = store;

        opening = null;
        store = null;

        for (const abandon of [...deadlines]) abandon();
        deadlines.clear();
        for (const work of works.values()) {
          work.attachment = null;
          work.lease = null;
        }
        works.clear();
        sending.clear();
        dispatchedAt.clear();

        set({
          status: 'idle',
          problem: null,
          drafts: [],
          unusableDrafts: [],
          attempts: [],
          unreadableAttempts: 0,
          sending: [],
          saving: [],
          unsaved: {},
          protection: {},
        });

        // An open racing this close finishes and closes its own result, because it can see it is
        // obsolete. Awaiting it is what makes that ordering deterministic rather than hopeful.
        if (pending !== null) {
          try {
            await pending;
          } catch {
            // A failed open has nothing to close.
          }
        }

        // Exactly once: the handle was taken above, so a second close finds nothing to do.
        if (active !== null) {
          try {
            await active.close();
          } catch {
            // Reported nowhere, because the owner is gone and there is nothing left to tell.
          }
        }
      },

      createDraft: (session) =>
        newDraft(session, { title: '', description: '', document: createEmptyDocument() }),

      copyDraft: async (draftId, session) => {
        const work = works.get(draftId);

        if (work === undefined) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };

        // The original draft, its attempt, its key and its evidence are untouched; the copy carries
        // only what was written.
        return newDraft(session, {
          title: work.title,
          description: work.description,
          document: work.document,
        });
      },

      editDraft: (draftId, fields) => {
        const work = works.get(draftId);
        if (work === undefined) return;

        const title = fields.title ?? work.title;
        const description = fields.description ?? work.description;

        if (title === work.title && description === work.description) return;

        work.title = title;
        work.description = description;
        // One counter for every authored field, so a title edit is protected exactly like a body
        // edit - which is the whole reason the counter is not the editor's.
        work.latestAccepted += 1;
        schedule(work);
        publishProtection();
      },

      selectDestination: async (draftId, destination, session) => {
        const work = works.get(draftId);
        const draft = get().drafts.find((candidate) => candidate.draftId === draftId);

        if (work === undefined || draft === undefined) {
          return { kind: 'refused', problem: NO_DRAFT_PROBLEM };
        }
        // A destination chosen on one server is a coincidence on another: ids are not portable, so a
        // reference from a retired activation is never persisted. Both halves are needed - the
        // connection id catches another server, the activation catches this one after it moved on.
        if (!ports.sessionIsCurrent(session)) {
          return { kind: 'refused', problem: RETIRED_CONNECTION_PROBLEM };
        }
        if (draft.connectionId !== session.connectionId || !session.usable) {
          return { kind: 'refused', problem: WRONG_CONNECTION_PROBLEM };
        }
        if (work.destination?.id === destination.id && work.destination.type === destination.type) {
          return { kind: 'done' };
        }

        work.destination = destination;
        work.latestAccepted += 1;
        await drain(work);

        return work.failedWrite
          ? { kind: 'refused', problem: WRITE_FAILED_PROBLEM }
          : { kind: 'done' };
      },

      attachEditor: (draftId, port) => {
        const work = works.get(draftId);
        if (work === undefined) return null;

        work.generation += 1;
        // Replacing an attachment retires the earlier token, so a late detach from it removes
        // nothing and a snapshot arriving from it is an expected race rather than a write.
        const token: AttachmentToken = { draftId, generation: work.generation };
        work.attachment = { token, port, sessionId: null, lastSeq: -1 };
        publishProtection();

        return token;
      },

      detachEditor: (token) => {
        const work = works.get(token.draftId);
        if (work?.attachment?.token !== token) return;

        work.attachment = null;
        work.lease = null;
        publishProtection();
      },

      snapshotAccepted: accept,

      flush: (draftId, options) => flushOnce(draftId, options?.lock ?? false),

      beginControlledExit: async (draftId) => {
        const work = works.get(draftId);

        if (work === undefined) {
          return { result: { kind: 'unanswered' } as FlushResult, release: () => {} };
        }

        const lease = takeLease(work);
        const result = await flushOnce(draftId, true);

        if (result.kind === 'flushed') lease.version = result.version;
        else releaseLease(work, lease);

        return {
          result,
          release: () => {
            releaseLease(work, lease);
          },
        };
      },

      save: async (draftId, session) => {
        const notSaved = (reason: NotSavedReason, problem: string): SaveOutcome => ({
          kind: 'not_saved',
          reason,
          problem,
        });
        const active = store;

        // Everything up to the in-flight entry happens in this one synchronous turn, so two Save
        // presses - or a press and a programmatic call - cannot both pass. A disabled button is a
        // hint; this is the invariant.
        if (active === null) return notSaved('no_store', NO_STORE_PROBLEM);

        const work = works.get(draftId);
        const draft = get().drafts.find((candidate) => candidate.draftId === draftId);

        if (work === undefined || draft === undefined)
          return notSaved('no_store', NO_DRAFT_PROBLEM);
        if (!ports.sessionIsCurrent(session)) {
          return notSaved('retired_connection', RETIRED_CONNECTION_PROBLEM);
        }
        if (!session.usable) return notSaved('no_connection', NO_CONNECTION_PROBLEM);
        if (draft.connectionId !== session.connectionId) {
          return notSaved('wrong_connection', WRONG_CONNECTION_PROBLEM);
        }
        if (work.inFlight) return notSaved('already_saving', ALREADY_SAVING_PROBLEM);
        if (work.destination === null) return notSaved('no_destination', NO_DESTINATION_PROBLEM);

        const standing = standingOf(draftId);

        if (standing === null || (standing.kind !== 'save' && standing.kind !== 'save_replacing')) {
          return notSaved('not_admitted', NOT_ADMITTED_PROBLEM);
        }

        let attemptId: string;
        let idempotencyKey: string;

        try {
          // Minted inside the guard, because a platform without a usable generator must refuse the
          // save rather than reject out of an async closure nothing is listening to. A weaker
          // identifier is not the fallback: a key drawn twice would let one key stand for two
          // different requests.
          attemptId = ports.newId();
          idempotencyKey = ports.newId();
        } catch {
          return notSaved('not_recorded', NO_IDENTIFIER_PROBLEM);
        }

        work.inFlight = true;
        publishWorking();

        const lease = takeLease(work);

        try {
          const flushed = await flushOnce(draftId, true);

          if (flushed.kind === 'unanswered') {
            return notSaved('editor_unanswered', EDITOR_UNANSWERED_PROBLEM);
          }
          if (flushed.kind === 'refused') {
            return {
              kind: 'not_saved',
              reason: 'editor_refused',
              problem: EDITOR_REFUSED_PROBLEM,
              code: flushed.code,
            };
          }
          if (flushed.kind === 'not_persisted')
            return notSaved('not_recorded', WRITE_FAILED_PROBLEM);

          lease.version = flushed.version;

          const destination = work.destination;

          if (destination === null) return notSaved('no_destination', NO_DESTINATION_PROBLEM);

          const frozen = freezeNoteRequest({
            destination,
            title: work.title,
            description: work.description,
            document: work.document,
            idempotencyKey,
          });

          if (!frozen.ok) return notSaved('not_recorded', frozen.problem);

          const intent: NewIntent = {
            attemptId,
            draftId,
            connectionId: session.connectionId,
            endpoint: session.endpoint,
            request: frozen.request,
            submittedDraftVersion: flushed.version,
            title: frozen.title,
            destination,
            at: ports.now(),
          };

          let written;

          try {
            // Replacement is only ever of a record known to have created nothing. An ambiguous one
            // is the evidence that something may exist, and saving a correction must never delete
            // it.
            written =
              standing.kind === 'save_replacing'
                ? await active.replaceIntent(standing.attempt.attemptId, intent)
                : await active.insertIntent(intent);
          } catch {
            return notSaved('not_recorded', NOT_RECORDED_PROBLEM);
          }

          if (written.attempt === null) return notSaved('not_recorded', NOT_RECORDED_PROBLEM);

          if (standing.kind === 'save_replacing') publishAttempt(standing.attempt.attemptId, null);
          publishDraft(draftId, written.draft);
          publishAttempt(attemptId, written.attempt);

          await dispatch(work, written.attempt, session, lease);

          return { kind: 'dispatched', attemptId };
        } finally {
          work.inFlight = false;
          publishWorking();
          releaseLease(work, lease);
        }
      },

      retry: async (draftId, session) => {
        const active = store;

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };

        const work = works.get(draftId);
        const draft = get().drafts.find((candidate) => candidate.draftId === draftId);

        if (work === undefined || draft === undefined) {
          return { kind: 'refused', problem: NO_DRAFT_PROBLEM };
        }
        if (work.inFlight) return { kind: 'refused', problem: ALREADY_SAVING_PROBLEM };
        if (!ports.sessionIsCurrent(session)) {
          return { kind: 'refused', problem: RETIRED_CONNECTION_PROBLEM };
        }
        if (!session.usable || draft.connectionId !== session.connectionId) {
          return { kind: 'refused', problem: WRONG_CONNECTION_PROBLEM };
        }

        const standing = standingOf(draftId);

        if (standing?.kind !== 'retry') {
          // A withdrawal is still an observation. If the reason the replay is unavailable is that
          // time moved backwards, that has to be written down here, because an anomaly that
          // vanished when the clock caught up would be a guarantee drawn from the measurement that
          // had just been wrong.
          if (
            standing?.kind === 'blocked' &&
            standing.reason === 'unresolved_ineligible' &&
            standing.attempt !== null &&
            !standing.attempt.clockAnomaly
          ) {
            await recordAnomaly(active, standing.attempt);
          }

          return { kind: 'refused', problem: unsendableProblem(standing) };
        }

        const attempt = standing.attempt;

        if (sending.has(attempt.attemptId)) {
          return { kind: 'refused', problem: ALREADY_SAVING_PROBLEM };
        }

        // Checked immediately before the send rather than when a screen rendered. A window that was
        // eligible two hours ago is not a fact about now.
        const mark = dispatchedAt.get(attempt.attemptId);
        const eligibility = evaluateEligibility({
          now: ports.now(),
          firstDispatchAt: attempt.firstDispatchAt,
          lastObservedAt: attempt.observedAt,
          clockAnomaly: attempt.clockAnomaly,
          monotonicElapsedMs: mark === undefined ? null : ports.monotonic() - mark,
        });

        if (eligibility.kind !== 'eligible') {
          if (eligibility.kind === 'clock_anomaly' && !attempt.clockAnomaly) {
            await recordAnomaly(active, attempt);
          }

          return { kind: 'refused', problem: RETRY_INELIGIBLE_PROBLEM };
        }

        work.inFlight = true;
        publishWorking();

        const lease = takeLease(work);

        try {
          // A flush that fails does not block a Retry: refusing to resolve an unresolved attempt
          // because local storage is full would strand the very thing recovery exists for. It does
          // force the retain branch, because the lease never gets its version.
          const flushed = await flushOnce(draftId, true);

          if (flushed.kind === 'flushed') lease.version = flushed.version;

          // The frozen bytes, never the current form values. The lock protects the draft, not the
          // request.
          await dispatch(work, attempt, session, lease);

          return { kind: 'done' };
        } finally {
          work.inFlight = false;
          publishWorking();
          releaseLease(work, lease);
        }
      },

      saveAcknowledgement: async (attemptId) => {
        const active = store;
        const result = get().unsaved[attemptId];

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };
        if (result === undefined) return { kind: 'done' };

        const attempt = get().attempts.find((candidate) => candidate.attemptId === attemptId);

        if (attempt === undefined) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };

        const work = works.get(attempt.draftId);

        if (work === undefined) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };

        // With no editor mounted the second limb of the clearing rule applies and this may clear.
        // With a live one it takes the lock like any other path, and if it cannot, it retains -
        // which leaves a remainder someone can read and discard, where clearing wrongly destroys
        // writing.
        let lease: Lease | null = null;

        if (work.attachment !== null) {
          lease = takeLease(work);
          const flushed = await flushOnce(attempt.draftId, true);

          if (flushed.kind === 'flushed') lease.version = flushed.version;
        }

        try {
          await recordAcknowledgement(
            active,
            work,
            attempt,
            { entity: result.entity },
            result,
            lease,
          );
        } finally {
          if (lease !== null) releaseLease(work, lease);
        }

        return get().unsaved[attemptId] === undefined
          ? { kind: 'done' }
          : { kind: 'refused', problem: ACK_UNSAVED_PROBLEM };
      },

      consumeReceipt: async (attemptId) => {
        const active = store;
        const attempt = get().attempts.find((candidate) => candidate.attemptId === attemptId);

        // Only ever removes a row whose acknowledgement was actually written. A success still held
        // in memory because the local write failed is not acknowledged, so this leaves it alone and
        // its warning stands. Removing the row is safe precisely because the draft carries the
        // creation independently.
        if (active === null || attempt?.acknowledged === null || attempt === undefined) return;

        try {
          await active.removeAttempt(attemptId);
        } catch {
          // Cleanup that fails leaves a recoverable acknowledged row, which is the safe direction.
          return;
        }

        dispatchedAt.delete(attemptId);
        publishAttempt(attemptId, null);
      },

      discardDraft: async (draftId) => {
        const active = store;

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };

        const work = works.get(draftId);

        if (work === undefined) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };
        if (work.inFlight) return { kind: 'refused', problem: DISCARD_SENDING_PROBLEM };

        const standing = standingOf(draftId);

        // Discard removes deliberately discarded editable work and nothing else. Only an attempt
        // known to have created nothing goes with it; everything unresolved, acknowledged, held in
        // memory, or contradictory stays as an orphan, still listable and still resolvable.
        const removeAttemptIds =
          standing?.kind === 'save_replacing' ? [standing.attempt.attemptId] : [];

        try {
          await active.discard({ draftId, removeAttemptIds });
        } catch {
          return { kind: 'refused', problem: DISCARD_FAILED_PROBLEM };
        }

        works.delete(draftId);
        for (const attemptId of removeAttemptIds) publishAttempt(attemptId, null);
        publishDraft(draftId, null);
        publishProtection();

        return { kind: 'done' };
      },

      standingFor: standingOf,
    };
  });

export type CaptureOwner = ReturnType<typeof createCaptureOwner>;

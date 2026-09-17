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
import type { EditorPort, EditorRejectionCode, EditorSnapshot } from '../editor';
import { freezeNoteRequest, thawNoteRequest, UNUSABLE_PAYLOAD_MESSAGE } from './freeze.ts';
import { deriveStanding, evaluateEligibility, type Standing } from './policy.ts';
import {
  createProtection,
  FLUSH_TIMEOUT_MS,
  type AttachmentToken,
  type DraftProtection,
  type FlushResult,
  type Lease,
  type SnapshotResult,
} from './protection.ts';
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

/**
 * What is protected, what an attachment is, and how a flush ended are the core's vocabulary now.
 *
 * Re-exported unchanged, so the capability's interface, the composer and the screens cannot tell the
 * extraction happened: there is exactly one name for each of these ideas and it is still reached
 * through the owner.
 */
export { FLUSH_TIMEOUT_MS };
export type { AttachmentToken, DraftProtection, FlushResult, SnapshotResult };

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

/**
 * The authored payload of one draft, as the protection core carries it.
 *
 * The core never reads it. It is the owner's shape, threaded through the core as its content type so
 * that one piece of machinery can protect a creation here and an edit elsewhere without either
 * knowing about the other.
 */
interface DraftContent {
  readonly title: string;
  readonly description: string;
  readonly destination: Destination | null;
  readonly document: unknown;
}

const contentOf = (record: NoteDraftRecord): DraftContent => ({
  title: record.title,
  description: record.description,
  destination: record.destination,
  document: record.document,
});

export const createCaptureOwner = (ports: CapturePorts) =>
  createStore<CaptureState>((set, get) => {
    let store: CaptureStore | null = null;
    /** One dispatcher per durable attempt, ever. Enforced here, not by a disabled control. */
    const sending = new Set<string>();
    /** Draft ids with an admitted Save or Retry running in this process. */
    const inFlight = new Set<string>();
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

    const publishWorking = (): void => {
      set({ sending: [...sending], saving: [...inFlight] });
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

    /**
     * Everything about whether writing is safely on this phone, and nothing about creation.
     *
     * The owner supplies four things and keeps the rest of its business to itself: how to read and
     * replace the document inside its own content, how to persist one version, and where a changed
     * protection goes. The core never learns that any of this is a note, a destination or a request.
     */
    const core = createProtection<DraftContent>({
      now: () => ports.now(),
      setTimer,
      clearTimer,
      flushTimeoutMs,
      documentOf: (content) => content.document,
      withDocument: (content, document) => ({ ...content, document }),
      /**
       * One accepted version, persisted and published.
       *
       * The store's own guard is what makes a coalesced write that lost a race return no record, and
       * that null is what the core reads as "the store did not advance". A store this owner has let
       * go of answers the same way rather than throwing, because a failed write is a claim about
       * protection and there is no longer anything to make that claim about.
       */
      writeVersion: async (draftId, content, version, at) => {
        const active = store;
        if (active === null) return null;

        const record = await active.writeVersion({
          draftId,
          title: content.title,
          description: content.description,
          document: content.document,
          destination: content.destination,
          draftVersion: version,
          at,
        });

        if (!current(active)) return null;
        if (record !== null) publishDraft(draftId, record);

        return record?.draftVersion ?? null;
      },
      publish: (draftId, protection) => {
        set((state) => {
          if (protection === null) {
            const { [draftId]: _removed, ...rest } = state.protection;

            return { protection: rest };
          }

          return { protection: { ...state.protection, [draftId]: protection } };
        });
      },
    });

    /**
     * Give the lock back, unless an attempt is still in flight for this draft.
     *
     * In-flight editability is this owner's policy rather than the core's: the composer stays locked
     * from Save until the answer lands, because a second press would be a second creation. An
     * autosave loop that inherited the same rule would lock the editor for the duration of every
     * send, every couple of seconds while someone types.
     */
    const releaseLease = (draftId: string, lease: Lease): void => {
      core.releaseLease(draftId, lease, !inFlight.has(draftId));
    };

    /**
     * Take up what the store holds without discarding what this process knows.
     *
     * An existing entry is kept by `track`: it may hold an accepted version the database has not got
     * yet, a live attachment, or a failed write, and none of that is recoverable from a row.
     */
    const adopt = (stored: StoredCapture): void => {
      for (const record of stored.drafts) {
        core.track(record.draftId, contentOf(record), record.draftVersion);
      }
      for (const draft of get().drafts) {
        if (!stored.drafts.some((candidate) => candidate.draftId === draft.draftId)) {
          core.untrack(draft.draftId);
        }
      }

      set({
        drafts: stored.drafts,
        unusableDrafts: stored.unusableDrafts,
        attempts: stored.attempts,
        unreadableAttempts: stored.unreadableAttempts,
      });
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
    const releaseDraft = async (active: CaptureStore, draftId: string): Promise<void> => {
      try {
        const written = await active.releaseDraft(draftId, ports.now());
        if (written !== null && current(active)) publishDraft(draftId, written);
      } catch {
        // The next open's sweep does the same thing, which is what it is for.
      }
    };

    const recordAcknowledgement = async (
      active: CaptureStore,
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
        clearContent: core.settledAt(attempt.draftId, lease, attempt.submittedDraftVersion),
        emptyDocument: createEmptyDocument(),
        at: ports.now(),
      };

      try {
        const written = await active.acknowledge(write);

        // The write landed, whatever the owner has done since. What must not happen is publishing
        // it into a lifetime that has already been closed and reset.
        if (!current(active)) return;

        // This transaction wrote the row, so what it produced is taken on rather than accepted: the
        // core adopts the version and the cleared content as committed without bumping a counter or
        // scheduling a write that would put the same bytes back through SQLite.
        const held = core.content(attempt.draftId);

        core.confirm(
          attempt.draftId,
          written.draft?.draftVersion ?? null,
          written.cleared && held !== undefined
            ? { ...held, title: '', description: '', document: createEmptyDocument() }
            : undefined,
        );
        publishDraft(attempt.draftId, written.draft);
        publishAttempt(attempt.attemptId, written.attempt);
        set((state) => {
          const { [attempt.attemptId]: _saved, ...rest } = state.unsaved;

          return { unsaved: rest };
        });
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
        await releaseDraft(active, attempt.draftId);

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
            await releaseDraft(active, attempt.draftId);
          } else {
            created = result.value;
            await recordAcknowledgement(
              active,
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
          await releaseDraft(active, attempt.draftId);
        }
      } catch {
        // The dispatcher itself came apart after the request left. Nothing is known about what the
        // server did, which is exactly what uncertain means.
        try {
          settle(await active.markUncertain(attempt.attemptId, ports.now()));
          await releaseDraft(active, attempt.draftId);
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

        core.track(draftId, contentOf(record), record.draftVersion);
        publishDraft(draftId, record);

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

        core.close();
        sending.clear();
        inFlight.clear();
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
        const content = core.content(draftId);

        if (content === undefined) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };

        // The original draft, its attempt, its key and its evidence are untouched; the copy carries
        // only what was written.
        return newDraft(session, {
          title: content.title,
          description: content.description,
          document: content.document,
        });
      },

      editDraft: (draftId, fields) => {
        // One counter for every authored field, so a title edit is protected exactly like a body
        // edit - which is the whole reason the counter is not the editor's.
        core.edit(draftId, (content) => {
          const title = fields.title ?? content.title;
          const description = fields.description ?? content.description;

          if (title === content.title && description === content.description) return null;

          return { ...content, title, description };
        });
      },

      selectDestination: async (draftId, destination, session) => {
        const content = core.content(draftId);
        const draft = get().drafts.find((candidate) => candidate.draftId === draftId);

        if (content === undefined || draft === undefined) {
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
        if (
          content.destination?.id === destination.id &&
          content.destination.type === destination.type
        ) {
          return { kind: 'done' };
        }

        core.edit(draftId, (held) => ({ ...held, destination }));
        await core.drain(draftId);

        return core.protectionOf(draftId)?.failedWrite === true
          ? { kind: 'refused', problem: WRITE_FAILED_PROBLEM }
          : { kind: 'done' };
      },

      attachEditor: (draftId, port) => core.attach(draftId, port),

      detachEditor: (token) => {
        core.detach(token);
      },

      snapshotAccepted: (token, snapshot) => core.accept(token, snapshot),

      flush: (draftId, options) => core.flush(draftId, options?.lock ?? false),

      beginControlledExit: async (draftId) => {
        const lease = core.takeLease(draftId);

        if (lease === null) {
          return { result: { kind: 'unanswered' } as FlushResult, release: () => {} };
        }

        const result = await core.flush(draftId, true);

        if (result.kind === 'flushed') lease.version = result.version;
        else releaseLease(draftId, lease);

        return {
          result,
          release: () => {
            releaseLease(draftId, lease);
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

        const content = core.content(draftId);
        const draft = get().drafts.find((candidate) => candidate.draftId === draftId);

        if (content === undefined || draft === undefined)
          return notSaved('no_store', NO_DRAFT_PROBLEM);
        if (!ports.sessionIsCurrent(session)) {
          return notSaved('retired_connection', RETIRED_CONNECTION_PROBLEM);
        }
        if (!session.usable) return notSaved('no_connection', NO_CONNECTION_PROBLEM);
        if (draft.connectionId !== session.connectionId) {
          return notSaved('wrong_connection', WRONG_CONNECTION_PROBLEM);
        }
        if (inFlight.has(draftId)) return notSaved('already_saving', ALREADY_SAVING_PROBLEM);
        if (content.destination === null) return notSaved('no_destination', NO_DESTINATION_PROBLEM);

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

        const lease = core.takeLease(draftId);

        if (lease === null) return notSaved('no_store', NO_DRAFT_PROBLEM);

        inFlight.add(draftId);
        publishWorking();

        try {
          const flushed = await core.flush(draftId, true);

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

          // Read again after the barrier: the flush is what folded the renderer's writing in, so
          // what is frozen is the version the lease now names rather than the one Save opened with.
          const flushedContent = core.content(draftId);
          const destination = flushedContent?.destination ?? null;

          if (flushedContent === undefined || destination === null) {
            return notSaved('no_destination', NO_DESTINATION_PROBLEM);
          }

          const frozen = freezeNoteRequest({
            destination,
            title: flushedContent.title,
            description: flushedContent.description,
            document: flushedContent.document,
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

          await dispatch(written.attempt, session, lease);

          return { kind: 'dispatched', attemptId };
        } finally {
          inFlight.delete(draftId);
          publishWorking();
          releaseLease(draftId, lease);
        }
      },

      retry: async (draftId, session) => {
        const active = store;

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };

        const draft = get().drafts.find((candidate) => candidate.draftId === draftId);

        if (!core.has(draftId) || draft === undefined) {
          return { kind: 'refused', problem: NO_DRAFT_PROBLEM };
        }
        if (inFlight.has(draftId)) return { kind: 'refused', problem: ALREADY_SAVING_PROBLEM };
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

        const lease = core.takeLease(draftId);

        if (lease === null) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };

        inFlight.add(draftId);
        publishWorking();

        try {
          // A flush that fails does not block a Retry: refusing to resolve an unresolved attempt
          // because local storage is full would strand the very thing recovery exists for. It does
          // force the retain branch, because the lease never gets its version.
          const flushed = await core.flush(draftId, true);

          if (flushed.kind === 'flushed') lease.version = flushed.version;

          // The frozen bytes, never the current form values. The lock protects the draft, not the
          // request.
          await dispatch(attempt, session, lease);

          return { kind: 'done' };
        } finally {
          inFlight.delete(draftId);
          publishWorking();
          releaseLease(draftId, lease);
        }
      },

      saveAcknowledgement: async (attemptId) => {
        const active = store;
        const result = get().unsaved[attemptId];

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };
        if (result === undefined) return { kind: 'done' };

        const attempt = get().attempts.find((candidate) => candidate.attemptId === attemptId);

        if (attempt === undefined) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };

        if (!core.has(attempt.draftId)) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };

        // With no editor mounted the second limb of the clearing rule applies and this may clear.
        // With a live one it takes the lock like any other path, and if it cannot, it retains -
        // which leaves a remainder someone can read and discard, where clearing wrongly destroys
        // writing.
        let lease: Lease | null = null;

        if (core.attached(attempt.draftId)) {
          lease = core.takeLease(attempt.draftId);
          const flushed = await core.flush(attempt.draftId, true);

          if (flushed.kind === 'flushed' && lease !== null) lease.version = flushed.version;
        }

        try {
          await recordAcknowledgement(active, attempt, { entity: result.entity }, result, lease);
        } finally {
          if (lease !== null) releaseLease(attempt.draftId, lease);
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

        if (!core.has(draftId)) return { kind: 'refused', problem: NO_DRAFT_PROBLEM };
        if (inFlight.has(draftId)) return { kind: 'refused', problem: DISCARD_SENDING_PROBLEM };

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

        core.untrack(draftId);
        for (const attemptId of removeAttemptIds) publishAttempt(attemptId, null);
        publishDraft(draftId, null);

        return { kind: 'done' };
      },

      standingFor: standingOf,
    };
  });

export type CaptureOwner = ReturnType<typeof createCaptureOwner>;

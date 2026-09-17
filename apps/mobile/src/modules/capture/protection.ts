/**
 * The one answer to "is what is on screen safely on this phone?", and the only thing allowed to give
 * it.
 *
 * This is deliberately ignorant of what it is protecting. It never learns that a payload is a note,
 * a creation or an edit, never learns that a version travels anywhere, and never touches a network,
 * a key or an attempt. It holds one question per entry and the machinery that keeps its answer
 * honest: the editor barrier and its generations, snapshot acceptance, the coalescing writer, flush
 * and drain with their four outcomes, and the lease that makes "this snapshot is the last word" true
 * at the moment it is needed.
 *
 * Two contents are kept per entry, and the distinction is the whole reason this file exists:
 *
 *   the latest accepted content, which may not be written yet, and
 *   the content of the last write the store confirmed, which is the only one anything may send.
 *
 * **Committed content and committed version always come from the same write.** They are set together
 * by a write this core performed, by `track` when it raises a newly tracked or lagging entry, or by
 * `confirm` when a write this core did not perform reports what it committed - and by nothing else.
 * A caller that sends `committed()` therefore cannot put one version's bytes on the wire under
 * another version's number.
 *
 * What is *not* here is policy. Whether the editor may be typed into while a send is in flight is a
 * decision about what the owner is doing with the version, not about whether writing is safe, so
 * `releaseLease` takes that decision as an argument rather than making it. An owner whose loop saves
 * every few seconds and one whose composer locks from Save until the answer lands share every line
 * of this file and disagree about exactly that one boolean.
 */

import type { BarrierResult, EditorPort, EditorRejectionCode, EditorSnapshot } from '../editor';

/** How long a flush waits for the editor before concluding it knows nothing about newer writing. */
export const FLUSH_TIMEOUT_MS = 1500;

/**
 * A live editor bound to one entry.
 *
 * The token names the entry, the attachment generation and the specific port. Replacing an
 * attachment retires the earlier token, and a late `detach` from the retired one removes nothing -
 * which is what stops a slow unmount tearing down its own replacement.
 *
 * Opaque to everyone who holds one: a screen keeps it across renders and hands it back, and nothing
 * outside this file reads a field of it.
 */
export interface AttachmentToken {
  readonly id: string;
  readonly generation: number;
}

/**
 * What accepting a snapshot did.
 *
 * `unchanged` is an ordinary outcome, not a failure: a requested snapshot that matches what the core
 * already holds confirms the barrier without inventing an authored change. `retired` means the
 * message came from an attachment, session or sequence that is no longer current - an expected race,
 * never a user-facing editor problem, and never a write.
 */
export type SnapshotResult = 'accepted' | 'unchanged' | 'retired';

/**
 * How a flush ended. The fourth outcome exists because the editor can answer a flush with a refusal.
 *
 * `captured: 'no_editor'` is deliberately distinguishable. It means the core committed what it
 * already held plus whatever the owner had already folded in, and it is **not** a claim that
 * renderer-only writing was captured - there was no renderer to ask. A live but unresponsive editor
 * answers `unanswered` instead, which is a different sentence and has to stay one.
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

/**
 * What the core knows about an entry that the database cannot see.
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
   * A flag, not the driver's sentence: the surface has its own wording for this, and a storage
   * driver's message would be both worse to read and a way for implementation detail to reach a
   * screen.
   */
  readonly failedWrite: boolean;
  /** The last flush went unanswered or was refused, so the renderer may hold writing native never saw. */
  readonly rendererUnknown: boolean;
  readonly locked: boolean;
  readonly attached: boolean;
}

/** Everything platform- or owner-shaped the core needs, so a test can drive all of it. */
export interface ProtectionPorts<C> {
  /** Wall clock. */
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  flushTimeoutMs: number;
  /** The document the editor renders, read from the content. */
  documentOf(content: C): unknown;
  /** The content with a newly accepted document. Must not mutate its argument. */
  withDocument(content: C, document: unknown): C;
  /**
   * Persist one accepted version. Returns the version now committed by the store, or null when the
   * store did not advance - a coalesced write that lost a race, or a store this owner has since let
   * go of. The owner publishes its own record inside this port; the core only learns the committed
   * number. Throwing means a failed write, and only that.
   */
  writeVersion(id: string, content: C, version: number, at: number): Promise<number | null>;
  /** Called whenever an entry's protection changes, and with null when the entry is removed. */
  publish(id: string, protection: DraftProtection | null): void;
}

/** The lock one path holds. Identity matters: continuity is "this same lease, unbroken". */
export interface Lease {
  readonly id: string;
  /** The version the flush under this lease produced, or null when it never got one. */
  version: number | null;
}

export interface ProtectionCore<C> {
  /** Adopt an entry. A no-op for a tracked entry already at or ahead of `committedVersion`. */
  track(id: string, content: C, committedVersion: number): void;
  untrack(id: string): void;
  has(id: string): boolean;
  /** The latest accepted content, which may not be written yet. */
  content(id: string): C | undefined;
  /** The content of the last version the store confirmed, and that version. Only this may be sent. */
  committed(id: string): { readonly content: C; readonly version: number } | undefined;
  /**
   * Take on a version this core did not write.
   *
   * For an owner whose own transaction wrote the entry behind the core's back - a creation
   * acknowledgement that clears consumed content, and, in the edit owner, the acknowledgement that
   * makes the base what was sent rather than what the server echoed back. It bumps nothing and
   * schedules nothing, because the row on disk already says this.
   *
   * `content`, when given, is what that transaction put on disk: it becomes the latest *and* the
   * committed bytes, whether or not the version moved. Omit it when the transaction changed no
   * authored content, and the committed bytes stay as they are. `version` is the version the row now
   * carries, or null when the transaction did not touch it; it never moves backwards.
   */
  confirm(id: string, version: number | null, content?: C): void;
  /** Apply a field change; bumps latestAccepted and schedules a write. Returns false when unchanged. */
  edit(id: string, change: (content: C) => C | null): boolean;
  attach(id: string, port: EditorPort): AttachmentToken | null;
  /** Also drops the lease: an editor that is gone cannot be holding one. */
  detach(token: AttachmentToken): void;
  accept(token: AttachmentToken, snapshot: EditorSnapshot): SnapshotResult;
  flush(id: string, lock: boolean): Promise<FlushResult>;
  /** Wait until nothing is queued or in progress for this entry. */
  drain(id: string): Promise<void>;
  takeLease(id: string): Lease | null;
  /** `editable` says whether to re-enable the editor now; each owner decides. */
  releaseLease(id: string, lease: Lease, editable: boolean): void;
  /** Whether `version` is the last word for this entry under this lease. */
  settledAt(id: string, lease: Lease | null, version: number): boolean;
  protectionOf(id: string): DraftProtection | undefined;
  attached(id: string): boolean;
  /** Abandon every deadline, drop every attachment and lease, forget every entry. */
  close(): void;
}

interface Attachment {
  readonly token: AttachmentToken;
  readonly port: EditorPort;
  sessionId: number | null;
  lastSeq: number;
}

/** Everything the core holds about one entry. */
interface Entry<C> {
  readonly id: string;
  /** The latest accepted content. Ahead of `committedContent` whenever a write is owed. */
  content: C;
  /** The content of the write behind `committed`. Always from the same write as that number. */
  committedContent: C;
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
  flushing: Promise<FlushResult> | null;
  /** Flushes run one at a time per entry, in the order they were asked for. */
  flushTail: Promise<unknown>;
}

export const createProtection = <C>(ports: ProtectionPorts<C>): ProtectionCore<C> => {
  const entries = new Map<string, Entry<C>>();
  /**
   * Abandon callbacks for flush deadlines that are still waiting.
   *
   * A barrier whose editor never answers is ended by its own timer. If the core closes first that
   * timer is the only thing left holding the caller, so closing settles them rather than clearing
   * them: a cleared timer would leave a promise nobody ever resolves.
   */
  const deadlines = new Set<() => void>();
  /**
   * Which lifetime the core is on. Incremented by `close`, so a write that comes back afterwards can
   * tell that the entry it is about to publish belongs to a lifetime that has been torn down.
   */
  let lifetime = 0;

  const protectionOf = (entry: Entry<C>): DraftProtection => ({
    committedVersion: entry.committed,
    latestAcceptedVersion: entry.latestAccepted,
    pending: entry.pending !== null,
    writing: entry.writing !== null,
    failedWrite: entry.failedWrite,
    rendererUnknown: entry.rendererUnknown,
    locked: entry.lease !== null,
    attached: entry.attachment !== null,
  });

  /**
   * Publish an entry's protection, unless it is no longer tracked.
   *
   * A flush that was waiting on an editor outlives a `close` or an `untrack` - its deadline settles
   * it afterwards - and without this guard it would publish protection for an entry the owner has
   * already forgotten, putting a discarded or closed entry back on screen as something being looked
   * after. Removal is announced by `untrack` alone, and it is announced once.
   */
  const publish = (entry: Entry<C>): void => {
    if (entries.get(entry.id) !== entry) return;

    ports.publish(entry.id, protectionOf(entry));
  };

  /**
   * The coalescing writer: one write in progress, at most one pending version behind it.
   *
   * A new change replaces the pending slot rather than queueing behind it, so a long document being
   * typed into cannot accumulate a queue of full payloads. The write itself is expected to be
   * guarded on the version moving forward, so a write that lost a race cannot make an older snapshot
   * the latest protected one - which is what the port's null answer means.
   */
  const runWrites = async (entry: Entry<C>): Promise<void> => {
    const generation = lifetime;
    const current = (): boolean => generation === lifetime;

    while (entry.pending !== null) {
      if (!current()) return;

      const version = entry.pending;
      const written = entry.content;

      entry.pending = null;
      entry.writing = version;
      publish(entry);

      try {
        const committed = await ports.writeVersion(entry.id, written, version, ports.now());

        if (!current()) return;
        entry.failedWrite = false;
        if (committed !== null && committed > entry.committed) {
          entry.committed = committed;
          // Paired deliberately: the number and the bytes come from this one write.
          entry.committedContent = written;
        }
      } catch {
        // The newer work stays in memory and is reported unprotected. The last committed snapshot is
        // intact, and nothing here resets, recreates, or falls back to memory for storage. The cause
        // is not carried outward: it is a driver's sentence about someone else's schema.
        if (!current()) return;
        entry.failedWrite = true;
      } finally {
        entry.writing = null;
        if (current()) publish(entry);
      }
    }
  };

  const schedule = (entry: Entry<C>): void => {
    // Nothing to write is not a write. A drain that scheduled unconditionally would put a full
    // payload through the store every time anything asked whether the entry was protected.
    if (
      entry.committed >= entry.latestAccepted &&
      entry.writing === null &&
      entry.pending === null &&
      !entry.failedWrite
    ) {
      return;
    }

    entry.pending = entry.latestAccepted;
    if (entry.runner !== null) return;

    entry.runner = runWrites(entry).finally(() => {
      entry.runner = null;
    });
  };

  const drainEntry = async (entry: Entry<C>): Promise<void> => {
    schedule(entry);
    while (entry.runner !== null) await entry.runner;
  };

  const commitOutcome = (entry: Entry<C>): FlushResult =>
    entry.committed >= entry.latestAccepted
      ? { kind: 'flushed', version: entry.committed, captured: 'editor' }
      : { kind: 'not_persisted', version: entry.latestAccepted };

  const accept = (token: AttachmentToken, snapshot: EditorSnapshot): SnapshotResult => {
    const entry = entries.get(token.id);
    const attachment = entry?.attachment ?? null;

    if (entry === undefined || attachment === null || attachment.token !== token) {
      return 'retired';
    }
    // Within one session the sequence orders the messages; a new session restarts it, so a sequence
    // comparison across sessions would silently drop a restarted renderer's first snapshot. Both are
    // expected races and neither is an editor problem.
    if (attachment.sessionId === snapshot.sessionId && snapshot.editSeq <= attachment.lastSeq) {
      return 'unchanged';
    }

    attachment.sessionId = snapshot.sessionId;
    attachment.lastSeq = snapshot.editSeq;
    // The editor answered, so whatever it was holding, native has it now.
    entry.rendererUnknown = false;

    if (JSON.stringify(snapshot.document) === JSON.stringify(ports.documentOf(entry.content))) {
      publish(entry);

      return 'unchanged';
    }

    entry.content = ports.withDocument(entry.content, snapshot.document);
    entry.latestAccepted += 1;
    schedule(entry);
    publish(entry);

    return 'accepted';
  };

  /**
   * A promise that answers `unanswered` if the editor does not.
   *
   * The port applies its own deadline, and this is not a second guess at the same one: a port that
   * never settles at all - a renderer that is gone, a controller that was disposed mid-call - would
   * otherwise hold a caller open forever with the editor locked.
   */
  const withDeadline = (pending: Promise<BarrierResult>): Promise<BarrierResult> =>
    new Promise<BarrierResult>((resolve) => {
      let handle: unknown = null;
      let settled = false;

      const finish = (result: BarrierResult): void => {
        if (settled) return;
        settled = true;
        ports.clearTimer(handle);
        // eslint-disable-next-line no-use-before-define -- assigned before anything can call this
        deadlines.delete(abandon);
        resolve(result);
      };
      const abandon = (): void => {
        finish({ kind: 'unanswered' });
      };

      handle = ports.setTimer(abandon, ports.flushTimeoutMs);
      deadlines.add(abandon);

      void pending.then(finish, abandon);
    });

  /**
   * The one barrier, used by lifecycle, by controlled navigation, and by whatever sends.
   *
   * Three things in order, rather than only awaiting a local write: ask the editor for a snapshot
   * (locking first when asked, so nothing can change under the flush), fold the reply into the
   * entry, and await the store's commit of that version.
   */
  const flushEntry = async (entry: Entry<C>, lock: boolean): Promise<FlushResult> => {
    const attachment = entry.attachment;

    if (attachment === null) {
      // Nothing renderer-only can exist to lose: there is no renderer. What is committed is what the
      // core already holds, and the outcome says so.
      await drainEntry(entry);
      const committed = commitOutcome(entry);

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
      entry.rendererUnknown = true;
      publish(entry);

      return { kind: 'unanswered' };
    }
    if (barrier.kind === 'refused') {
      // The document was never handed over: the live editor is the sole copy. It is never repaired,
      // never dropped, and never reported as saved.
      entry.rendererUnknown = true;
      publish(entry);

      return { kind: 'refused', code: barrier.code };
    }

    accept(attachment.token, barrier.snapshot);
    await drainEntry(entry);

    return commitOutcome(entry);
  };

  const flushOnce = (id: string, lock: boolean): Promise<FlushResult> => {
    const entry = entries.get(id);

    if (entry === undefined) {
      return Promise.resolve({ kind: 'unanswered' } satisfies FlushResult);
    }
    // Serialized rather than shared. A caller that asked for a lock cannot be answered by a barrier
    // someone else took without one: the whole point of locking first is that no edit can be
    // generated between the capture and the commit, and a shared unlocked flush would report a
    // version taken with that window wide open. Two flushes in a row cost a drain with nothing to
    // write, which is nothing.
    const body = entry.flushTail.then(
      () => flushEntry(entry, lock),
      () => flushEntry(entry, lock),
    );
    // The published promise clears the slot as it settles, and only if it is still the current one -
    // a later flush queued behind it owns the slot from the moment it was asked for.
    const running: Promise<FlushResult> = body.finally(() => {
      if (entry.flushing === running) entry.flushing = null;
    });

    entry.flushTail = running.then(
      () => undefined,
      () => undefined,
    );
    entry.flushing = running;

    return running;
  };

  return {
    track: (id, content, committedVersion) => {
      const existing = entries.get(id);

      if (existing === undefined) {
        const entry: Entry<C> = {
          id,
          content,
          committedContent: content,
          committed: committedVersion,
          latestAccepted: committedVersion,
          pending: null,
          writing: null,
          runner: null,
          failedWrite: false,
          rendererUnknown: false,
          attachment: null,
          generation: 0,
          lease: null,
          flushing: null,
          flushTail: Promise.resolve(),
        };

        entries.set(id, entry);
        publish(entry);

        return;
      }
      // An existing entry is kept: it may hold an accepted version the store has not got yet, a live
      // attachment, or a failed write, and none of that is recoverable from a stored record. Only a
      // committed version the core is behind is taken, and its content comes with it.
      if (committedVersion <= existing.committed) return;

      existing.committed = committedVersion;
      existing.committedContent = content;
      publish(existing);
    },

    untrack: (id) => {
      const entry = entries.get(id);
      if (entry === undefined) return;

      entries.delete(id);
      ports.publish(id, null);
    },

    has: (id) => entries.has(id),

    content: (id) => entries.get(id)?.content,

    committed: (id) => {
      const entry = entries.get(id);

      return entry === undefined
        ? undefined
        : { content: entry.committedContent, version: entry.committed };
    },

    confirm: (id, version, content) => {
      const entry = entries.get(id);
      if (entry === undefined) return;

      const written = version ?? entry.committed;

      // Named content *is* what the caller's transaction put on disk, so it becomes both the latest
      // and the committed bytes; naming none means the transaction changed none, and the bytes
      // behind `committed` are still the ones already held. Either way the pair stays together.
      //
      // The version is taken separately and may not move at all. A transaction that rewrites a row
      // in place - the creation acknowledgement's clearing UPDATE is exactly that - changes the
      // bytes without advancing the number, so pairing the content with a version *advance* would
      // leave the pre-clear text standing under a version whose row on disk is empty.
      if (content !== undefined) {
        entry.content = content;
        entry.committedContent = content;
      }
      if (written > entry.committed) entry.committed = written;
      if (written > entry.latestAccepted) entry.latestAccepted = written;

      publish(entry);
    },

    edit: (id, change) => {
      const entry = entries.get(id);
      if (entry === undefined) return false;

      const next = change(entry.content);
      if (next === null) return false;

      entry.content = next;
      // One counter for every authored field, so a title edit is protected exactly like a body edit -
      // which is the whole reason the counter is not the editor's.
      entry.latestAccepted += 1;
      schedule(entry);
      publish(entry);

      return true;
    },

    attach: (id, port) => {
      const entry = entries.get(id);
      if (entry === undefined) return null;

      entry.generation += 1;
      // Replacing an attachment retires the earlier token, so a late detach from it removes nothing
      // and a snapshot arriving from it is an expected race rather than a write.
      const token: AttachmentToken = { id, generation: entry.generation };
      entry.attachment = { token, port, sessionId: null, lastSeq: -1 };
      publish(entry);

      return token;
    },

    detach: (token) => {
      const entry = entries.get(token.id);
      if (entry?.attachment?.token !== token) return;

      entry.attachment = null;
      entry.lease = null;
      publish(entry);
    },

    accept,

    flush: flushOnce,

    drain: async (id) => {
      const entry = entries.get(id);
      if (entry === undefined) return;

      await drainEntry(entry);
    },

    takeLease: (id) => {
      const entry = entries.get(id);
      if (entry === undefined) return null;

      const lease: Lease = { id, version: null };
      entry.lease = lease;
      publish(entry);

      return lease;
    },

    /**
     * Give the lock back, re-enabling the editor only if the owner says it may be.
     *
     * Every exit runs this, including the ones a success-or-failure rule would miss: a flush that
     * came back unanswered, refused or unpersisted, and every refusal on the way out. Each must
     * leave the person able to correct the input and act again without remounting the route, which
     * is exactly what a leaked lock would prevent.
     */
    releaseLease: (id, lease, editable) => {
      const entry = entries.get(id);
      if (entry === undefined || entry.lease !== lease) return;

      entry.lease = null;
      if (editable) entry.attachment?.port.setEditable(true);
      publish(entry);
    },

    /**
     * Whether this version is the last word for this entry, from everything the core knows.
     *
     * A caller that also has durable evidence asks it again there; either saying newer work exists
     * takes the retaining branch, so the pair can only err toward retention - the only direction
     * that cannot lose writing.
     *
     * The lock is what makes this a statement about the moment it is asked rather than about the
     * instant the flush was taken: an edit made a moment after a drain sits in the editor's own
     * debounce where neither condition could see it. So either the lease that produced the version
     * is still held unbroken, or there is no live editor for this entry at all.
     */
    settledAt: (id, lease, version) => {
      const entry = entries.get(id);
      if (entry === undefined) return false;

      const locked =
        entry.attachment === null ||
        (lease !== null && entry.lease === lease && lease.version === version);

      return (
        locked &&
        entry.latestAccepted === version &&
        entry.pending === null &&
        entry.writing === null &&
        !entry.failedWrite &&
        !entry.rendererUnknown &&
        entry.flushing === null
      );
    },

    protectionOf: (id) => {
      const entry = entries.get(id);

      return entry === undefined ? undefined : protectionOf(entry);
    },

    attached: (id) => (entries.get(id)?.attachment ?? null) !== null,

    close: () => {
      // Bumped first, so every write already in flight is obsolete from this moment on and can tell.
      lifetime += 1;

      for (const abandon of [...deadlines]) abandon();
      deadlines.clear();
      for (const entry of entries.values()) {
        entry.attachment = null;
        entry.lease = null;
      }
      entries.clear();
    },
  };
};

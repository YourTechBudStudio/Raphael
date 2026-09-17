/**
 * What an edit record is, and what it means.
 *
 * The edit owner's counterpart to `types.ts`, and the parallel is deliberate: a draft and an edit are
 * both local writing that a server has not been given, and both have to survive a process death with
 * their meaning intact. What differs is the question each one answers.
 *
 * A draft asks **"did this creation happen, and may its key be replayed"**. An edit asks **"what does
 * the server hold for this entity, and is my writing ahead of it, behind it, or in conflict with
 * it"**. That second question is answered by two facts held apart here and never merged:
 *
 * **`base` is what this phone last knew the server to hold, as submitted or read by this phone.** At
 * `open()` it is the server's entity; at every acknowledgement it becomes *what was sent*, never what
 * the server echoed back. The server normalizes - it trims titles, NFC-normalizes tags, canonicalizes
 * documents - so a base re-seeded from the server's form while the editor keeps its own form would
 * diff as changed after every write, forever. Local-versus-local equality cannot loop.
 *
 * **`inflight` is the envelope that was dispatched for `inflightVersion`, exactly as sent.** A lost
 * answer is reconciled by comparing the server's entity to what was sent, and after a process death
 * `content` may already be newer than that. `base` is never rewritten while an envelope is in flight,
 * so base plus envelope is exactly what was sent, with no second copy of the content.
 *
 * There is no attempt record and no idempotency key. An update's safety is its base revision.
 */

import type { NodeType, RequestField, ResourceKind } from '@raphael/contracts/nodes';

import type { UpdateEnvelope } from './edit-envelope.ts';

/** One entity being edited on one connection. The pair is the identity; neither half alone is. */
export interface EditKey {
  readonly connectionId: string;
  readonly nodeId: number;
}

/** A single string for the places that need one key: a map, a `sending` list, a card's React key. */
export const editKeyOf = (key: EditKey): string => `${key.connectionId}/${String(key.nodeId)}`;

/**
 * Every field an update can carry, in the editor's own representation.
 *
 * Raw, never normalized. This is both what the person is writing and - as `base` - what was sent, and
 * those have to be the same shape for the comparison between them to be local-versus-local.
 */
export interface EditContent {
  readonly title: string;
  readonly description: string;
  readonly slug: string;
  readonly tags: readonly string[];
  /** Canonical TipTap, as the editor produced it. Validated structurally on the way out of the store. */
  readonly document: unknown;
}

/**
 * Where a record stands with its server, as stored.
 *
 * Three values, not a spectrum. `syncing` is ordinary - it covers having nothing to send as well as
 * having something. `refused` and `conflicted` are both verdicts the server gave, and they are kept
 * apart because they take different repairs: a refusal is fixed by changing what is being sent, and a
 * conflict cannot be fixed at all, only discarded.
 */
export type EditSyncState = 'syncing' | 'refused' | 'conflicted';

/**
 * The last refusal, as a controlled projection.
 *
 * `field` is validated against the contract's own closed list on the way out of the store, so an
 * unrecognized name degrades to null rather than reaching a screen. `code` is
 * `failure.error.code` for a well-formed error envelope, and the failure's own kind otherwise.
 */
export interface EditRefusal {
  readonly code: string;
  readonly field: RequestField | null;
  readonly reason: string | null;
  readonly at: number;
}

export interface EntityEditRecord {
  readonly key: EditKey;
  /** Identification only. Never matched against a current connection to infer sameness. */
  readonly endpoint: string;
  readonly nodeType: NodeType;
  readonly kind: ResourceKind | null;
  /** What this phone last knew the server to hold. Never the server's normalized echo. */
  readonly base: EditContent;
  readonly baseRevision: number;
  /** The current columns, assembled. What the person is writing. */
  readonly content: EditContent;
  readonly contentSchemaVersion: number;
  /** Every authored field participates, so a title edit is protected like a body edit. */
  readonly draftVersion: number;
  /** The highest version an acknowledgement has answered for. Zero before the first one. */
  readonly acknowledgedVersion: number;
  readonly inflightVersion: number | null;
  /** The envelope sent for `inflightVersion`. Present exactly when that version is. */
  readonly inflight: UpdateEnvelope | null;
  readonly syncState: EditSyncState;
  /**
   * The last refusal, where one could be read.
   *
   * Null on a `refused` record is a legitimate reading, not a contradiction: the refusal is a
   * diagnostic label and `syncState` carries the fact independently. Losing someone's unsent writing
   * over an unparseable status sentence would be the wrong direction entirely.
   */
  readonly lastRefusal: EditRefusal | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A record being seeded from the server's entity. `base` is `content`; nothing has been sent. */
export interface NewEdit {
  readonly key: EditKey;
  readonly endpoint: string;
  readonly nodeType: NodeType;
  readonly kind: ResourceKind | null;
  readonly content: EditContent;
  readonly revision: number;
  readonly at: number;
}

/** One accepted authored version: every field the person can change, and the counter that names it. */
export interface EditVersionWrite {
  readonly key: EditKey;
  readonly content: EditContent;
  readonly draftVersion: number;
  readonly at: number;
}

/**
 * Why a stored edit cannot be opened in this build.
 *
 * `types.ts`'s three problems, for the same three reasons. A row written under a different content
 * schema is not damaged - it is simply not something this build may open, and it must never be
 * migrated or downgraded on the way to being shown.
 */
export type EditProblem =
  /** Columns are not what they claim to be. */
  | 'unreadable_row'
  /** Written under a different content schema. Retained, never migrated or downgraded. */
  | 'unsupported_content_schema'
  /** A stored JSON column does not survive this build's structural validation. */
  | 'unusable_body';

/**
 * A retained row this build cannot open, with just enough to name it and discard it.
 *
 * The key is present because discarding works by key: an unusable row can be thrown away without
 * ever being parsed, which is the only operation that must keep working when parsing does not.
 */
export interface UnusableEdit {
  readonly key: EditKey;
  readonly endpoint: string | null;
  readonly nodeType: NodeType | null;
  /** The title column, read as plain text. Empty is a legitimate title, not a failure to read one. */
  readonly title: string | null;
  readonly problem: EditProblem;
}

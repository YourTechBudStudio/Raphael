/**
 * Reading and writing drafts and attempts. Every statement is bound; every row is validated.
 *
 * Four things here are load-bearing beyond ordinary persistence.
 *
 * **`observed_at` only moves forward.** Every write takes the greater of the stored value and the
 * time being recorded, so a clock set backwards cannot lower the mark later comparisons are made
 * against. Without that, one backward jump would erase the evidence of itself.
 *
 * **`first_uncertain_at` is written once.** `COALESCE` on every path that sets it means an attempt
 * that has been uncertain stays that way through any number of later definite failures. This is the
 * SQL half of the rule; `logicalStateOf` is the half that reads it.
 *
 * **An acknowledgement is one transaction.** The attempt's success, the draft's server identity and
 * the conditional clearing of consumed content commit together, because a receipt that cannot be
 * related to a draft version is a receipt that cannot decide what may be cleaned up.
 *
 * **A row that does not validate is reported, never repaired.** One bad row must not make the others
 * unreadable, and it must not be quietly rewritten into something plausible either. "There is
 * nothing unfinished" and "Raphael cannot read its record of unfinished work" are different
 * sentences, and this file is where the difference starts.
 *
 * No transaction here spans anything but SQL. Dispatch happens between calls, never inside one.
 */

import { CONTENT_SCHEMA_VERSION } from '@raphael/content';
import { findDocumentFailure } from '@raphael/content/validation';
import {
  CONTAINER_TYPES,
  NODE_TYPES,
  RESOURCE_KINDS,
  decodeCreateResponse,
  isRequestField,
  type ContainerType,
  type NodeType,
  type ResourceKind,
} from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { migrate } from '../../infrastructure/sqlite/migrate.ts';
import type { SqlConnection, SqlParam, SqlTransaction } from '../../infrastructure/sqlite/port.ts';
import type { UpdateEnvelope } from './edit-envelope.ts';
import type {
  EditContent,
  EditKey,
  EditRefusal,
  EditSyncState,
  EditVersionWrite,
  EntityEditRecord,
  NewEdit,
  UnusableEdit,
} from './edit-types.ts';
import { newestAttempt } from './policy.ts';
import { ATTEMPTS_TABLE, CAPTURE_MIGRATIONS, DRAFTS_TABLE, EDITS_TABLE } from './schema.ts';
import type {
  AcknowledgedNote,
  AttemptOutcome,
  AttemptState,
  Destination,
  DraftState,
  NoteAttemptRecord,
  NoteDraftRecord,
  UnusableDraft,
} from './types.ts';

const DRAFT_STATES: readonly DraftState[] = ['composing', 'submitted', 'created'];
const ATTEMPT_STATES: readonly AttemptState[] = [
  'dispatch_intent',
  'uncertain',
  'blocked',
  'acknowledged',
];

const DRAFT_COLUMNS = `draft_id, connection_id, endpoint, state, title, description, body, tags,
  content_schema_version, destination_type, destination_id, draft_version, submitted_version,
  server_node_id, server_revision, created_at, updated_at`;

const ATTEMPT_COLUMNS = `attempt_id, draft_id, connection_id, endpoint, state, request,
  submitted_draft_version, title, destination_type, destination_id, first_dispatch_at,
  first_uncertain_at, clock_anomaly, last_outcome, acknowledged, observed_at`;

interface DraftRow {
  readonly draft_id: string;
  readonly connection_id: string;
  readonly endpoint: string;
  readonly state: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly tags: string;
  readonly content_schema_version: number;
  readonly destination_type: string | null;
  readonly destination_id: number | null;
  readonly draft_version: number;
  readonly submitted_version: number | null;
  readonly server_node_id: number | null;
  readonly server_revision: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface AttemptRow {
  readonly attempt_id: string;
  readonly draft_id: string;
  readonly connection_id: string;
  readonly endpoint: string;
  readonly state: string;
  readonly request: string;
  readonly submitted_draft_version: number;
  readonly title: string;
  readonly destination_type: string;
  readonly destination_id: number;
  readonly first_dispatch_at: number;
  readonly first_uncertain_at: number | null;
  readonly clock_anomaly: number;
  readonly last_outcome: string | null;
  readonly acknowledged: string | null;
  readonly observed_at: number;
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Whether a persisted string still names a container.
 *
 * `CONTAINER_TYPES`, not `NODE_TYPES`. A destination is a place a note can go, and the server's node
 * vocabulary now also contains `resource` - so validating against the wider set would accept a
 * stored destination that is itself a note.
 */
const isContainerType = (value: unknown): value is ContainerType =>
  typeof value === 'string' && (CONTAINER_TYPES as readonly string[]).includes(value);

const isOutcome = (value: unknown): value is AttemptOutcome =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AttemptOutcome).kind === 'string' &&
  typeof (value as AttemptOutcome).message === 'string' &&
  typeof (value as AttemptOutcome).at === 'number';

/**
 * The stored answer, re-validated by the same decoder that accepted it.
 *
 * Not a hand-written field check: this is the full entity, and the contract already owns what a
 * valid one is. A row that no longer decodes is unreadable rather than plausible, which is the
 * distinction that stops a half-read success being presented as a whole one.
 */
const toAcknowledged = (value: unknown): AcknowledgedNote | null => {
  if (value === null) return null;

  const decoded = decodeCreateResponse(value);

  if (Either.isLeft(decoded)) return null;

  const { entity } = decoded.right;

  if (entity.kind === null) return null;

  return {
    id: entity.id,
    revision: entity.revision,
    title: entity.title,
    kind: entity.kind,
    entity,
  };
};

const toAttemptRecord = (row: AttemptRow): NoteAttemptRecord | null => {
  if (!ATTEMPT_STATES.includes(row.state as AttemptState)) return null;
  if (!isContainerType(row.destination_type)) return null;
  if (!Number.isSafeInteger(row.destination_id)) return null;
  if (!Number.isSafeInteger(row.submitted_draft_version) || row.submitted_draft_version < 1) {
    return null;
  }
  if (!Number.isSafeInteger(row.first_dispatch_at)) return null;
  if (!Number.isSafeInteger(row.observed_at)) return null;
  if (typeof row.title !== 'string') return null;

  const outcome = parseJson(row.last_outcome);
  const acknowledged = toAcknowledged(parseJson(row.acknowledged));

  // An acknowledged row whose result cannot be read is unreadable, not an ordinary success: the
  // whole point of the state is that it reports what the server actually created.
  if (row.state === 'acknowledged' && acknowledged === null) return null;

  return {
    attemptId: row.attempt_id,
    draftId: row.draft_id,
    connectionId: row.connection_id,
    endpoint: row.endpoint,
    state: row.state as AttemptState,
    request: row.request,
    submittedDraftVersion: row.submitted_draft_version,
    title: row.title,
    destination: { type: row.destination_type, id: row.destination_id },
    firstDispatchAt: row.first_dispatch_at,
    firstUncertainAt: Number.isSafeInteger(row.first_uncertain_at) ? row.first_uncertain_at : null,
    clockAnomaly: row.clock_anomaly === 1,
    lastOutcome: isOutcome(outcome) ? outcome : null,
    acknowledged,
    observedAt: row.observed_at,
  };
};

type DraftReading =
  | { readonly kind: 'usable'; readonly record: NoteDraftRecord }
  | { readonly kind: 'unusable'; readonly draft: UnusableDraft };

/**
 * A row becomes a record only if every field is what it claims to be, the content schema is this
 * build's, and the stored document still passes native-safe structural validation.
 *
 * The three failures are kept apart rather than collapsed into "bad row". A draft written under a
 * different content version is not damaged - it is simply not something this build may open, and it
 * must never be migrated or downgraded on the way to being shown. A body that no longer validates is
 * a third thing again, and none of the three is an empty recovery list.
 */
const readDraft = (row: DraftRow): DraftReading => {
  const unusable = (problem: UnusableDraft['problem']): DraftReading => ({
    kind: 'unusable',
    draft: {
      draftId: row.draft_id,
      connectionId: typeof row.connection_id === 'string' ? row.connection_id : null,
      endpoint: typeof row.endpoint === 'string' ? row.endpoint : null,
      title: typeof row.title === 'string' ? row.title : null,
      contentSchemaVersion: Number.isSafeInteger(row.content_schema_version)
        ? row.content_schema_version
        : null,
      problem,
    },
  });

  if (!DRAFT_STATES.includes(row.state as DraftState)) return unusable('unreadable_row');
  if (typeof row.title !== 'string' || typeof row.description !== 'string') {
    return unusable('unreadable_row');
  }
  if (!Number.isSafeInteger(row.draft_version) || row.draft_version < 1) {
    return unusable('unreadable_row');
  }
  if (!Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at)) {
    return unusable('unreadable_row');
  }
  if ((row.destination_type === null) !== (row.destination_id === null)) {
    return unusable('unreadable_row');
  }

  let destination: Destination | null = null;

  if (row.destination_type !== null) {
    if (!isContainerType(row.destination_type) || !Number.isSafeInteger(row.destination_id)) {
      return unusable('unreadable_row');
    }
    destination = { type: row.destination_type, id: row.destination_id as number };
  }

  // A server identity that is present must be a real one. A `created`/identity pair that
  // contradicts itself is **not** refused here: it is a usable record carrying a contradiction, and
  // `integrityProblemOf` reports it rather than this hiding it behind "unreadable".
  if (row.server_node_id !== null && !Number.isSafeInteger(row.server_node_id)) {
    return unusable('unreadable_row');
  }
  if (row.server_revision !== null && !Number.isSafeInteger(row.server_revision)) {
    return unusable('unreadable_row');
  }

  if (row.content_schema_version !== CONTENT_SCHEMA_VERSION) {
    return unusable('unsupported_content_schema');
  }

  const document = parseJson(row.body);

  if (document === null || findDocumentFailure(document) !== undefined) {
    return unusable('unusable_body');
  }

  // Authored content, so it follows `title` and `description` rather than `last_refusal`: a row whose
  // authored columns are not what they claim is retained and named, never repaired to a default. The
  // CHECK constraint guarantees a JSON array; it says nothing about what is in it.
  const tags = parseJson(row.tags);

  if (!isStringArray(tags)) return unusable('unreadable_row');

  return {
    kind: 'usable',
    record: {
      draftId: row.draft_id,
      connectionId: row.connection_id,
      endpoint: row.endpoint,
      state: row.state as DraftState,
      title: row.title,
      description: row.description,
      document,
      tags,
      contentSchemaVersion: row.content_schema_version,
      destination,
      draftVersion: row.draft_version,
      submittedVersion: Number.isSafeInteger(row.submitted_version) ? row.submitted_version : null,
      serverNodeId: Number.isSafeInteger(row.server_node_id) ? row.server_node_id : null,
      serverRevision: Number.isSafeInteger(row.server_revision) ? row.server_revision : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
};

const EDIT_COLUMNS = `connection_id, node_id, endpoint, node_type, kind, base, base_revision,
  title, description, slug, tags, body, content_schema_version, draft_version,
  acknowledged_version, inflight_version, inflight, sync_state, last_refusal, created_at, updated_at`;

const SYNC_STATES: readonly EditSyncState[] = ['syncing', 'refused', 'conflicted'];

interface EditRow {
  readonly connection_id: string;
  readonly node_id: number;
  readonly endpoint: string;
  readonly node_type: string;
  readonly kind: string | null;
  readonly base: string;
  readonly base_revision: number;
  readonly title: string;
  readonly description: string;
  readonly slug: string;
  readonly tags: string;
  readonly body: string;
  readonly content_schema_version: number;
  readonly draft_version: number;
  readonly acknowledged_version: number;
  readonly inflight_version: number | null;
  readonly inflight: string | null;
  readonly sync_state: string;
  readonly last_refusal: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

const isNodeType = (value: unknown): value is NodeType =>
  typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value);

/**
 * Whether a persisted string still names a resource kind.
 *
 * Consulted from `RESOURCE_KINDS` rather than compared against a literal, because this table forbids
 * repair: a row it refuses is retained forever and shown to its owner as unreadable. A literal would
 * mean that the day a second kind is added, every stored edit of that kind becomes permanently
 * unopenable and undiscardable-except-by-key - from a change that touched nothing in capture.
 */
const isResourceKind = (value: unknown): value is ResourceKind =>
  typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);

/**
 * The stored refusal, or null.
 *
 * Degrading to null rather than refusing the row is the deciding direction: `sync_state` carries the
 * fact that the server refused, so an unparseable diagnostic costs a sentence, while calling the row
 * unreadable would cost someone their unsent writing. `field` is validated against the contract's own
 * closed list, so an unrecognized name never reaches a screen.
 */
const toRefusal = (value: unknown): EditRefusal | null => {
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.code !== 'string') return null;
  if (!Number.isSafeInteger(candidate.at)) return null;

  return {
    code: candidate.code,
    field:
      typeof candidate.field === 'string' && isRequestField(candidate.field)
        ? candidate.field
        : null,
    reason: typeof candidate.reason === 'string' ? candidate.reason : null,
    at: candidate.at as number,
  };
};

/** A stored `EditContent`. The document is structurally validated; the scalars must be what they claim. */
const toContent = (value: unknown, document: unknown): EditContent | null => {
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.title !== 'string') return null;
  if (typeof candidate.description !== 'string') return null;
  if (typeof candidate.slug !== 'string') return null;
  if (!isStringArray(candidate.tags)) return null;

  return {
    title: candidate.title,
    description: candidate.description,
    slug: candidate.slug,
    tags: candidate.tags,
    document,
  };
};

type EditReading =
  | { readonly kind: 'usable'; readonly record: EntityEditRecord }
  | { readonly kind: 'unusable'; readonly edit: UnusableEdit };

/**
 * A row becomes a record only if every field is what it claims to be, the content schema is this
 * build's, and both stored documents still pass native-safe structural validation.
 *
 * `readDraft`'s rule applied to the second table, with the same three problems kept apart rather than
 * collapsed into "bad row". A record written under a different content version is not damaged - it is
 * simply not something this build may open, and it must never be migrated or downgraded on the way to
 * being shown.
 *
 * The `inflight` envelope is validated only as far as being an object. What it means is the envelope
 * module's business, and a record whose current columns are perfectly readable must not be thrown away
 * because a reconciliation payload is odd; `matchesSubmitted` compares fields it finds and refuses
 * otherwise, which is the safe direction anyway.
 */
const readEdit = (row: EditRow): EditReading => {
  const key: EditKey = { connectionId: row.connection_id, nodeId: row.node_id };
  const unusable = (problem: UnusableEdit['problem']): EditReading => ({
    kind: 'unusable',
    edit: {
      key,
      endpoint: typeof row.endpoint === 'string' ? row.endpoint : null,
      nodeType: isNodeType(row.node_type) ? row.node_type : null,
      title: typeof row.title === 'string' ? row.title : null,
      problem,
    },
  });

  if (!Number.isSafeInteger(row.node_id)) return unusable('unreadable_row');
  if (typeof row.connection_id !== 'string' || typeof row.endpoint !== 'string') {
    return unusable('unreadable_row');
  }
  if (!isNodeType(row.node_type)) return unusable('unreadable_row');
  // A kind is the resource vocabulary, not the node one. A container legitimately has none.
  if (row.kind !== null && !isResourceKind(row.kind)) return unusable('unreadable_row');
  if (!SYNC_STATES.includes(row.sync_state as EditSyncState)) return unusable('unreadable_row');
  if (typeof row.title !== 'string' || typeof row.description !== 'string') {
    return unusable('unreadable_row');
  }
  if (typeof row.slug !== 'string') return unusable('unreadable_row');
  if (!Number.isSafeInteger(row.base_revision) || row.base_revision < 1) {
    return unusable('unreadable_row');
  }
  if (!Number.isSafeInteger(row.draft_version) || row.draft_version < 1) {
    return unusable('unreadable_row');
  }
  if (!Number.isSafeInteger(row.acknowledged_version) || row.acknowledged_version < 0) {
    return unusable('unreadable_row');
  }
  if (!Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at)) {
    return unusable('unreadable_row');
  }
  // The pairing is a CHECK in SQL as well. Asserted again here because a record whose halves disagree
  // could not say what was sent, which is the one question reconciliation exists to answer.
  if ((row.inflight_version === null) !== (row.inflight === null))
    return unusable('unreadable_row');
  if (row.inflight_version !== null && !Number.isSafeInteger(row.inflight_version)) {
    return unusable('unreadable_row');
  }

  if (row.content_schema_version !== CONTENT_SCHEMA_VERSION) {
    return unusable('unsupported_content_schema');
  }

  const document = parseJson(row.body);

  if (document === null || findDocumentFailure(document) !== undefined) {
    return unusable('unusable_body');
  }

  const baseValue = parseJson(row.base);
  const baseDocument =
    typeof baseValue === 'object' && baseValue !== null
      ? (baseValue as Record<string, unknown>).document
      : undefined;

  if (baseDocument === undefined || findDocumentFailure(baseDocument) !== undefined) {
    return unusable('unusable_body');
  }

  const base = toContent(baseValue, baseDocument);
  const tags = parseJson(row.tags);

  if (base === null || !isStringArray(tags)) return unusable('unreadable_row');

  const inflight = parseJson(row.inflight);

  if (row.inflight !== null && (typeof inflight !== 'object' || inflight === null)) {
    return unusable('unreadable_row');
  }

  return {
    kind: 'usable',
    record: {
      key,
      endpoint: row.endpoint,
      nodeType: row.node_type,
      kind: row.kind,
      base,
      baseRevision: row.base_revision,
      content: {
        title: row.title,
        description: row.description,
        slug: row.slug,
        tags,
        document,
      },
      contentSchemaVersion: row.content_schema_version,
      draftVersion: row.draft_version,
      acknowledgedVersion: row.acknowledged_version,
      inflightVersion: row.inflight_version,
      inflight: row.inflight === null ? null : (inflight as UpdateEnvelope),
      syncState: row.sync_state as EditSyncState,
      lastRefusal: toRefusal(parseJson(row.last_refusal)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
};

export interface StoredEdits {
  readonly edits: readonly EntityEditRecord[];
  /** Retained rows this build cannot open. Reported, never deleted, repaired or counted as zero. */
  readonly unusableEdits: readonly UnusableEdit[];
}

export interface StoredCapture {
  readonly drafts: readonly NoteDraftRecord[];
  /** Retained drafts this build cannot open. Reported, never deleted, repaired or counted as zero. */
  readonly unusableDrafts: readonly UnusableDraft[];
  readonly attempts: readonly NoteAttemptRecord[];
  /** Attempt rows that did not validate. Reported, never repaired. */
  readonly unreadableAttempts: number;
}

export interface NewDraft {
  readonly draftId: string;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly title: string;
  readonly description: string;
  readonly document: unknown;
  readonly tags: readonly string[];
  readonly destination: Destination | null;
  readonly at: number;
}

/** One accepted authored version: every field the person can change, and the counter that names it. */
export interface DraftVersionWrite {
  readonly draftId: string;
  readonly title: string;
  readonly description: string;
  readonly document: unknown;
  readonly tags: readonly string[];
  readonly destination: Destination | null;
  readonly draftVersion: number;
  readonly at: number;
}

export interface NewIntent {
  readonly attemptId: string;
  readonly draftId: string;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly request: string;
  readonly submittedDraftVersion: number;
  readonly title: string;
  readonly destination: Destination;
  readonly at: number;
}

export interface IntentWritten {
  readonly draft: NoteDraftRecord | null;
  readonly attempt: NoteAttemptRecord | null;
}

export interface AcknowledgeWrite {
  readonly attemptId: string;
  readonly draftId: string;
  readonly result: AcknowledgedNote;
  /** The raw validated response, stored whole. */
  readonly response: string;
  readonly submittedVersion: number;
  /**
   * Whether the owner's own knowledge says nothing newer exists. The transaction asks the database
   * the same question again, and content is cleared only if both say so.
   */
  readonly clearContent: boolean;
  readonly emptyDocument: unknown;
  readonly at: number;
}

export interface AcknowledgeResult {
  readonly draft: NoteDraftRecord | null;
  readonly attempt: NoteAttemptRecord | null;
  /** True only when the transaction actually cleared the consumed content. */
  readonly cleared: boolean;
}

export interface DiscardWrite {
  readonly draftId: string;
  /**
   * Attempts the owner has decided may go with the draft. Only ever definite refusals; the SQL
   * guards it again, because deleting an ambiguous attempt would erase the only evidence that
   * something may exist on the server.
   */
  readonly removeAttemptIds: readonly string[];
}

export interface ReconcileReport {
  /** Interrupted dispatch intents adopted as uncertain. */
  readonly adopted: number;
  /** Drafts returned to editable `composing` because their attempt is no longer in flight. */
  readonly released: number;
}

export interface CaptureStore {
  list(): Promise<StoredCapture>;
  insertDraft(draft: NewDraft): Promise<NoteDraftRecord | null>;
  writeVersion(write: DraftVersionWrite): Promise<NoteDraftRecord | null>;
  /** Writes the intent and marks the draft submitted, in one transaction. Nothing may be sent first. */
  insertIntent(intent: NewIntent): Promise<IntentWritten>;
  /** Replaces a definite non-creating attempt with a corrected one, in one transaction. */
  replaceIntent(previousAttemptId: string, intent: NewIntent): Promise<IntentWritten>;
  markUncertain(attemptId: string, at: number): Promise<NoteAttemptRecord | null>;
  markBlocked(
    attemptId: string,
    outcome: AttemptOutcome,
    at: number,
  ): Promise<NoteAttemptRecord | null>;
  markClockAnomaly(attemptId: string, at: number): Promise<NoteAttemptRecord | null>;
  /**
   * Return a dispatched draft to editable `composing` after an attempt that created nothing known.
   *
   * Guarded on `submitted`, so it can never reopen a draft whose creation has been acknowledged.
   * What still refuses ordinary Save there is the unresolved attempt, not this column.
   */
  releaseDraft(draftId: string, at: number): Promise<NoteDraftRecord | null>;
  acknowledge(write: AcknowledgeWrite): Promise<AcknowledgeResult>;
  /** Consumption. Removes only a row whose acknowledgement was actually written. */
  removeAttempt(attemptId: string): Promise<void>;
  discard(write: DiscardWrite): Promise<void>;
  /**
   * Adopts interrupted intents and releases the drafts behind them. Run once at open, before any
   * dispatcher exists. Transactional and idempotent.
   */
  reconcile(at: number): Promise<ReconcileReport>;

  /**
   * The edit records, and the rows this build cannot open.
   *
   * Separate from `list()` rather than folded into it, so the creation owner's `StoredCapture` and its
   * tests do not move. The two owners read the same database and nothing else about them is shared.
   *
   * Every writer below runs its `UPDATE` and its `SELECT` in one transaction and returns the row it
   * produced, as `writeAttempt` does: a transition is published from what was written, never from what
   * the caller hoped it wrote. A guard that did not match returns the row unchanged, which is how the
   * caller learns it lost the race.
   */
  listEdits(): Promise<StoredEdits>;
  /**
   * Seed a record from the server's entity, or hand back the one that is already there.
   *
   * `ON CONFLICT DO NOTHING`, so a second open for the same entity returns the existing record rather
   * than throwing. Re-opening an entity is ordinary, and two `open()` calls racing is the same class
   * of race the other writers are shaped to survive; a rejected promise would be the one path on this
   * table where losing a race is an exception, and the caller could only tell "already open" from a
   * real storage failure by reading a driver message this boundary exists to stop.
   *
   * Never `DO UPDATE`: the existing row may hold unsent writing, and overwriting its base with a
   * freshly-read server entity is exactly the loss the record exists to prevent.
   */
  insertEdit(edit: NewEdit): Promise<EntityEditRecord | null>;
  /**
   * One accepted authored version. Guarded on `draft_version < ?`, like `writeVersion`, so a coalesced
   * write that lost a race cannot make an older snapshot the latest protected one.
   *
   * It also returns a `refused` record to `syncing`, in the same statement. That is how "the person
   * fixes the thing the status names and autosave resumes" works, and it must not be a second write:
   * a separate statement could commit the content and fail to clear the refusal, leaving a record that
   * says the server said no to writing the server has never seen.
   */
  writeEditVersion(write: EditVersionWrite): Promise<EntityEditRecord | null>;
  /**
   * Adopt a newer server state on a record with nothing outstanding: base and current both become
   * `content`.
   *
   * Guarded on nothing in flight, on `syncing`, **and on the record being settled**
   * (`draft_version = acknowledged_version`). Without that third conjunct, reopening an entity whose
   * server copy had moved would silently overwrite unsent local writing - the one thing the record
   * exists to prevent.
   */
  rebaseEdit(
    key: EditKey,
    content: EditContent,
    revision: number,
    at: number,
  ): Promise<EntityEditRecord | null>;
  /** Guarded on `inflight_version IS NULL AND sync_state = 'syncing'`: one envelope in the air at a time. */
  markEditInflight(
    key: EditKey,
    version: number,
    envelope: UpdateEnvelope,
    at: number,
  ): Promise<EntityEditRecord | null>;
  /**
   * An acknowledged update: `acknowledged_version` becomes the in-flight version, the base becomes what
   * was sent, and the envelope is cleared. One statement, because a base that advanced without its
   * revision - or the reverse - would describe a server state that never existed.
   */
  acknowledgeEdit(
    key: EditKey,
    base: EditContent,
    revision: number,
    at: number,
  ): Promise<EntityEditRecord | null>;
  /**
   * For an empty envelope: nothing was sent, so only the acknowledged mark moves.
   *
   * Guarded on nothing being in flight, and on the mark moving forward. The acknowledged mark never
   * passing the version that was actually sent is the rule the whole loop rests on: advancing it past
   * a version whose answer has not landed would report someone's writing as on the server when it is
   * not. `../design/program-design.md` §5.3 specifies no guard here; this is a durable boundary, like
   * the four it does specify.
   */
  acknowledgeEditLocally(
    key: EditKey,
    version: number,
    at: number,
  ): Promise<EntityEditRecord | null>;
  /**
   * The envelope is no longer in the air and nothing is known about it. `sync_state` is untouched.
   *
   * Deliberately unguarded. Clearing a record with nothing in flight writes the same NULLs over the
   * same NULLs, so a guard would only suppress a redundant `updated_at` bump - and every other `WHERE`
   * clause on this table is an argument about concurrency. One that is not would dilute the signal for
   * the next reader deciding which guards matter.
   */
  clearEditInflight(key: EditKey, at: number): Promise<EntityEditRecord | null>;
  /**
   * Guarded on the record not already being conflicted, which is a correctness rule rather than a
   * precedence one.
   *
   * A conflict downgraded to `refused` would be returned to `syncing` by `writeEditVersion`'s
   * `CASE` on the person's very next keystroke, and autosave would resume on a record whose base
   * revision the server has already rejected - telling someone their work is saving while every send
   * is doomed. That is the composer's overclaim, arrived at through the store instead of the screen.
   */
  markEditRefused(key: EditKey, refusal: EditRefusal, at: number): Promise<EntityEditRecord | null>;
  markEditConflicted(key: EditKey, at: number): Promise<EntityEditRecord | null>;
  /** By key, so a row this build cannot parse can still be thrown away. */
  deleteEdit(key: EditKey): Promise<void>;

  close(): Promise<void>;
}

/**
 * Why a store could not be opened, in this capability's own vocabulary.
 *
 * A code rather than the driver's sentence. A SQLite message can name a table, quote a CHECK
 * constraint, or carry a file path, and none of that belongs on a screen or in a bug report someone
 * pastes from one. The three values keep the distinction that is actually worth having - it would
 * not open, it opened and could not be migrated, it migrated and could not be read - without letting
 * an adapter decide what the app says.
 */
export type StoreFailure = 'unopenable' | 'migration_failed' | 'unreadable';

export type OpenOutcome =
  | { readonly kind: 'ready'; readonly store: CaptureStore }
  | { readonly kind: 'unsupported_version'; readonly found: number; readonly supported: number }
  | { readonly kind: 'failed'; readonly reason: StoreFailure };

/** `observed_at` never goes backwards, whatever the clock says. */
const OBSERVED = 'observed_at = MAX(observed_at, ?)';

const readDraftRow = async (
  tx: SqlTransaction,
  draftId: string,
): Promise<NoteDraftRecord | null> => {
  const row = await tx.get<DraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM ${DRAFTS_TABLE} WHERE draft_id = ?`,
    [draftId],
  );

  if (row === undefined) return null;
  const reading = readDraft(row);

  return reading.kind === 'usable' ? reading.record : null;
};

const readAttemptRow = async (
  tx: SqlTransaction,
  attemptId: string,
): Promise<NoteAttemptRecord | null> => {
  const row = await tx.get<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM ${ATTEMPTS_TABLE} WHERE attempt_id = ?`,
    [attemptId],
  );

  return row === undefined ? null : toAttemptRecord(row);
};

const readEditRow = async (tx: SqlTransaction, key: EditKey): Promise<EntityEditRecord | null> => {
  const row = await tx.get<EditRow>(
    `SELECT ${EDIT_COLUMNS} FROM ${EDITS_TABLE} WHERE connection_id = ? AND node_id = ?`,
    [key.connectionId, key.nodeId],
  );

  if (row === undefined) return null;
  const reading = readEdit(row);

  return reading.kind === 'usable' ? reading.record : null;
};

const contentParams = (content: EditContent): readonly SqlParam[] => [
  content.title,
  content.description,
  content.slug,
  JSON.stringify(content.tags),
  JSON.stringify(content.document),
];

const INSERT_ATTEMPT = `INSERT INTO ${ATTEMPTS_TABLE} (${ATTEMPT_COLUMNS})
  VALUES (?, ?, ?, ?, 'dispatch_intent', ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?)`;

const attemptParams = (intent: NewIntent): readonly SqlParam[] => [
  intent.attemptId,
  intent.draftId,
  intent.connectionId,
  intent.endpoint,
  intent.request,
  intent.submittedDraftVersion,
  intent.title,
  intent.destination.type,
  intent.destination.id,
  intent.at,
  intent.at,
];

export const createCaptureStore = (db: SqlConnection): CaptureStore => {
  /**
   * Apply one statement and hand back the attempt row it produced, read inside the same
   * transaction. This, not a whole-table reread, is how a transition becomes publishable: a failed
   * read afterwards could otherwise leave the app holding the row as it was *before* a success
   * already committed, and the bar would then offer to create the same note again under a new key.
   */
  const writeAttempt = (sql: string, params: readonly SqlParam[], attemptId: string) =>
    db.transaction(async (tx) => {
      await tx.run(sql, params);

      return readAttemptRow(tx, attemptId);
    });

  /**
   * Apply one statement to one edit row and hand back the row it produced, read inside the same
   * transaction. `writeAttempt`'s pattern, for `writeAttempt`'s reason: a guard that did not match
   * returns the row unchanged, and the caller must be able to see that rather than assume its write
   * landed. Publishing a hoped-for transition is how an owner ends up sending a version the store
   * never confirmed.
   */
  const writeEdit = (sql: string, params: readonly SqlParam[], key: EditKey) =>
    db.transaction(async (tx) => {
      await tx.run(sql, params);

      return readEditRow(tx, key);
    });

  const writeIntent = (
    intent: NewIntent,
    before: (tx: SqlTransaction) => Promise<void>,
  ): Promise<IntentWritten> =>
    db.transaction(async (tx) => {
      await before(tx);
      await tx.run(INSERT_ATTEMPT, attemptParams(intent));
      // One transaction, because a receipt that cannot be related to a draft version is a receipt
      // that cannot decide what may be cleaned up.
      await tx.run(
        `UPDATE ${DRAFTS_TABLE}
         SET state = 'submitted', submitted_version = ?, updated_at = ?
         WHERE draft_id = ? AND state != 'created' AND server_node_id IS NULL`,
        [intent.submittedDraftVersion, intent.at, intent.draftId],
      );

      return {
        draft: await readDraftRow(tx, intent.draftId),
        attempt: await readAttemptRow(tx, intent.attemptId),
      };
    });

  return {
    list: async () => {
      const draftRows = await db.all<DraftRow>(
        `SELECT ${DRAFT_COLUMNS} FROM ${DRAFTS_TABLE} ORDER BY created_at ASC, draft_id ASC`,
      );
      const attemptRows = await db.all<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM ${ATTEMPTS_TABLE} ORDER BY first_dispatch_at ASC, attempt_id ASC`,
      );

      const drafts: NoteDraftRecord[] = [];
      const unusableDrafts: UnusableDraft[] = [];

      for (const row of draftRows) {
        const reading = readDraft(row);
        if (reading.kind === 'usable') drafts.push(reading.record);
        else unusableDrafts.push(reading.draft);
      }

      const attempts: NoteAttemptRecord[] = [];
      let unreadableAttempts = 0;

      for (const row of attemptRows) {
        const record = toAttemptRecord(row);
        if (record === null) unreadableAttempts += 1;
        else attempts.push(record);
      }

      return { drafts, unusableDrafts, attempts, unreadableAttempts };
    },

    insertDraft: (draft) =>
      db.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO ${DRAFTS_TABLE} (${DRAFT_COLUMNS})
           VALUES (?, ?, ?, 'composing', ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?)`,
          [
            draft.draftId,
            draft.connectionId,
            draft.endpoint,
            draft.title,
            draft.description,
            JSON.stringify(draft.document),
            JSON.stringify(draft.tags),
            CONTENT_SCHEMA_VERSION,
            draft.destination?.type ?? null,
            draft.destination?.id ?? null,
            draft.at,
            draft.at,
          ],
        );

        return readDraftRow(tx, draft.draftId);
      }),

    writeVersion: (write) =>
      db.transaction(async (tx) => {
        // Guarded on the version moving forward, so a coalesced write that lost a race cannot make
        // an older snapshot the latest protected one.
        await tx.run(
          `UPDATE ${DRAFTS_TABLE}
           SET title = ?, description = ?, body = ?, tags = ?, destination_type = ?,
               destination_id = ?, draft_version = ?, updated_at = ?
           WHERE draft_id = ? AND draft_version < ?`,
          [
            write.title,
            write.description,
            JSON.stringify(write.document),
            JSON.stringify(write.tags),
            write.destination?.type ?? null,
            write.destination?.id ?? null,
            write.draftVersion,
            write.at,
            write.draftId,
            write.draftVersion,
          ],
        );

        return readDraftRow(tx, write.draftId);
      }),

    insertIntent: (intent) => writeIntent(intent, async () => {}),

    replaceIntent: (previousAttemptId, intent) =>
      writeIntent(intent, async (tx) => {
        // Guarded in SQL as well as by `replacementAllowed`, because the consequence of getting it
        // wrong is deleting the only record that an ambiguous creation ever happened.
        await tx.run(
          `DELETE FROM ${ATTEMPTS_TABLE}
           WHERE attempt_id = ? AND state = 'blocked' AND first_uncertain_at IS NULL`,
          [previousAttemptId],
        );
      }),

    markUncertain: (attemptId, at) =>
      writeAttempt(
        `UPDATE ${ATTEMPTS_TABLE}
         SET state = 'uncertain', first_uncertain_at = COALESCE(first_uncertain_at, ?), ${OBSERVED}
         WHERE attempt_id = ? AND state != 'acknowledged'`,
        [at, at, attemptId],
        attemptId,
      ),

    markBlocked: (attemptId, outcome, at) =>
      writeAttempt(
        `UPDATE ${ATTEMPTS_TABLE}
         SET state = 'blocked', last_outcome = ?, ${OBSERVED}
         WHERE attempt_id = ? AND state != 'acknowledged'`,
        [JSON.stringify(outcome), at, attemptId],
        attemptId,
      ),

    markClockAnomaly: (attemptId, at) =>
      writeAttempt(
        `UPDATE ${ATTEMPTS_TABLE} SET clock_anomaly = 1, ${OBSERVED} WHERE attempt_id = ?`,
        [at, attemptId],
        attemptId,
      ),

    /**
     * The acknowledgement: success, identity and cleanup, or none of them.
     *
     * The clearing condition is evaluated **inside** this transaction, against `draft_version`, so a
     * commit landing in the same moment cannot be overwritten by a decision taken before it. The
     * owner's own memory condition has already been asked; either saying newer work exists takes the
     * retain branch, which is the only direction that cannot lose writing.
     */
    releaseDraft: (draftId, at) =>
      db.transaction(async (tx) => {
        await tx.run(
          `UPDATE ${DRAFTS_TABLE} SET state = 'composing', updated_at = ?
           WHERE draft_id = ? AND state = 'submitted'`,
          [at, draftId],
        );

        return readDraftRow(tx, draftId);
      }),

    acknowledge: (write) =>
      db.transaction(async (tx) => {
        await tx.run(
          `UPDATE ${ATTEMPTS_TABLE}
           SET state = 'acknowledged', acknowledged = ?, last_outcome = NULL, ${OBSERVED}
           WHERE attempt_id = ?`,
          [write.response, write.at, write.attemptId],
        );

        const current = await tx.get<{ draft_version: number }>(
          `SELECT draft_version FROM ${DRAFTS_TABLE} WHERE draft_id = ?`,
          [write.draftId],
        );
        const cleared = write.clearContent && current?.draft_version === write.submittedVersion;

        await tx.run(
          `UPDATE ${DRAFTS_TABLE}
           SET state = 'created', server_node_id = ?, server_revision = ?, updated_at = ?
           WHERE draft_id = ?`,
          [write.result.id, write.result.revision, write.at, write.draftId],
        );

        if (cleared) {
          // Every authored field, tags included. Leaving them behind would make the composer show
          // tags the server already holds as though they were still unsent, and would make the
          // remainder test - which asks whether anything authored is left - answer for three of the
          // four fields.
          await tx.run(
            `UPDATE ${DRAFTS_TABLE}
             SET title = '', description = '', body = ?, tags = '[]', updated_at = ?
             WHERE draft_id = ? AND draft_version = ?`,
            [JSON.stringify(write.emptyDocument), write.at, write.draftId, write.submittedVersion],
          );
        }

        return {
          draft: await readDraftRow(tx, write.draftId),
          attempt: await readAttemptRow(tx, write.attemptId),
          cleared,
        };
      }),

    removeAttempt: async (attemptId) => {
      await db.transaction(async (tx) => {
        await tx.run(
          `DELETE FROM ${ATTEMPTS_TABLE} WHERE attempt_id = ? AND state = 'acknowledged'`,
          [attemptId],
        );
      });
    },

    discard: async (write) => {
      await db.transaction(async (tx) => {
        for (const attemptId of write.removeAttemptIds) {
          await tx.run(
            `DELETE FROM ${ATTEMPTS_TABLE}
             WHERE attempt_id = ? AND draft_id = ? AND state = 'blocked' AND first_uncertain_at IS NULL`,
            [attemptId, write.draftId],
          );
        }
        await tx.run(`DELETE FROM ${DRAFTS_TABLE} WHERE draft_id = ?`, [write.draftId]);
      });
    },

    /**
     * What a previous process left behind.
     *
     * A `dispatch_intent` row proves only that a request was about to be sent - never that it was
     * not - so it is adopted as uncertain, exactly once, and the draft behind it goes back to
     * editable `composing`. Ordinary Save is still refused there, by the unresolved attempt rather
     * than by the draft's column.
     *
     * A draft whose attempt is gone, or whose attempt is acknowledged while the draft is not
     * created, is **not** touched. Those pairs contradict each other, and repairing one half would
     * be a guess about whether a note exists; they are retained and reported instead.
     */
    reconcile: (at) =>
      db.transaction(async (tx) => {
        const pending = await tx.all<{ attempt_id: string }>(
          `SELECT attempt_id FROM ${ATTEMPTS_TABLE} WHERE state = 'dispatch_intent'`,
        );

        await tx.run(
          `UPDATE ${ATTEMPTS_TABLE}
           SET state = 'uncertain', first_uncertain_at = COALESCE(first_uncertain_at, ?), ${OBSERVED}
           WHERE state = 'dispatch_intent'`,
          [at, at],
        );

        const submitted = await tx.all<DraftRow>(
          `SELECT ${DRAFT_COLUMNS} FROM ${DRAFTS_TABLE} WHERE state = 'submitted'`,
        );
        let released = 0;

        for (const row of submitted) {
          const attemptRows = await tx.all<AttemptRow>(
            `SELECT ${ATTEMPT_COLUMNS} FROM ${ATTEMPTS_TABLE} WHERE draft_id = ?`,
            [row.draft_id],
          );
          const records = attemptRows
            .map(toAttemptRecord)
            .filter((record): record is NoteAttemptRecord => record !== null);
          const newest = newestAttempt(records, row.draft_id);

          // No attempt at all, or one that says the note exists: both contradict a `submitted`
          // draft, and neither is repaired here.
          if (newest === null || newest.state === 'acknowledged') continue;

          await tx.run(
            `UPDATE ${DRAFTS_TABLE} SET state = 'composing', updated_at = ? WHERE draft_id = ?`,
            [at, row.draft_id],
          );
          released += 1;
        }

        return { adopted: pending.length, released };
      }),

    listEdits: async () => {
      const rows = await db.all<EditRow>(
        `SELECT ${EDIT_COLUMNS} FROM ${EDITS_TABLE} ORDER BY created_at ASC, connection_id ASC, node_id ASC`,
      );

      const edits: EntityEditRecord[] = [];
      const unusableEdits: UnusableEdit[] = [];

      for (const row of rows) {
        const reading = readEdit(row);
        if (reading.kind === 'usable') edits.push(reading.record);
        else unusableEdits.push(reading.edit);
      }

      return { edits, unusableEdits };
    },

    insertEdit: (edit) =>
      db.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO ${EDITS_TABLE} (${EDIT_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, NULL, 'syncing', NULL, ?, ?)
           ON CONFLICT (connection_id, node_id) DO NOTHING`,
          [
            edit.key.connectionId,
            edit.key.nodeId,
            edit.endpoint,
            edit.nodeType,
            edit.kind,
            // The base is the content it was seeded from, which at open is the server's own entity.
            // From here on it only ever becomes what this phone sent.
            JSON.stringify(edit.content),
            edit.revision,
            ...contentParams(edit.content),
            CONTENT_SCHEMA_VERSION,
            edit.at,
            edit.at,
          ],
        );

        return readEditRow(tx, edit.key);
      }),

    writeEditVersion: (write) =>
      writeEdit(
        `UPDATE ${EDITS_TABLE}
         SET title = ?, description = ?, slug = ?, tags = ?, body = ?, draft_version = ?,
             updated_at = ?,
             sync_state = CASE WHEN sync_state = 'refused' THEN 'syncing' ELSE sync_state END,
             -- The diagnostic goes with the state it described. Leaving it would make the column mean
             -- "the last refusal, possibly already repaired", which is weaker than the field claims.
             last_refusal = CASE WHEN sync_state = 'refused' THEN NULL ELSE last_refusal END
         WHERE connection_id = ? AND node_id = ? AND draft_version < ?`,
        [
          ...contentParams(write.content),
          write.draftVersion,
          write.at,
          write.key.connectionId,
          write.key.nodeId,
          write.draftVersion,
        ],
        write.key,
      ),

    rebaseEdit: (key, content, revision, at) =>
      writeEdit(
        `UPDATE ${EDITS_TABLE}
         SET base = ?, base_revision = ?, title = ?, description = ?, slug = ?, tags = ?, body = ?,
             updated_at = ?
         WHERE connection_id = ? AND node_id = ?
           AND inflight_version IS NULL AND sync_state = 'syncing'
           AND draft_version = acknowledged_version`,
        [
          JSON.stringify(content),
          revision,
          ...contentParams(content),
          at,
          key.connectionId,
          key.nodeId,
        ],
        key,
      ),

    markEditInflight: (key, version, envelope, at) =>
      writeEdit(
        `UPDATE ${EDITS_TABLE}
         SET inflight_version = ?, inflight = ?, updated_at = ?
         WHERE connection_id = ? AND node_id = ?
           AND inflight_version IS NULL AND sync_state = 'syncing'`,
        [version, JSON.stringify(envelope), at, key.connectionId, key.nodeId],
        key,
      ),

    acknowledgeEdit: (key, base, revision, at) =>
      writeEdit(
        `UPDATE ${EDITS_TABLE}
         SET acknowledged_version = inflight_version, base = ?, base_revision = ?,
             inflight_version = NULL, inflight = NULL, last_refusal = NULL,
             sync_state = 'syncing', updated_at = ?
         WHERE connection_id = ? AND node_id = ? AND inflight_version IS NOT NULL`,
        [JSON.stringify(base), revision, at, key.connectionId, key.nodeId],
        key,
      ),

    acknowledgeEditLocally: (key, version, at) =>
      writeEdit(
        `UPDATE ${EDITS_TABLE}
         SET acknowledged_version = ?, updated_at = ?
         WHERE connection_id = ? AND node_id = ? AND inflight_version IS NULL
           AND acknowledged_version < ?`,
        [version, at, key.connectionId, key.nodeId, version],
        key,
      ),

    clearEditInflight: (key, at) =>
      writeEdit(
        `UPDATE ${EDITS_TABLE}
         SET inflight_version = NULL, inflight = NULL, updated_at = ?
         WHERE connection_id = ? AND node_id = ?`,
        [at, key.connectionId, key.nodeId],
        key,
      ),

    markEditRefused: (key, refusal, at) =>
      writeEdit(
        `UPDATE ${EDITS_TABLE}
         SET sync_state = 'refused', last_refusal = ?, inflight_version = NULL, inflight = NULL,
             updated_at = ?
         WHERE connection_id = ? AND node_id = ? AND sync_state != 'conflicted'`,
        [JSON.stringify(refusal), at, key.connectionId, key.nodeId],
        key,
      ),

    markEditConflicted: (key, at) =>
      writeEdit(
        `UPDATE ${EDITS_TABLE}
         SET sync_state = 'conflicted', inflight_version = NULL, inflight = NULL, updated_at = ?
         WHERE connection_id = ? AND node_id = ?`,
        [at, key.connectionId, key.nodeId],
        key,
      ),

    deleteEdit: async (key) => {
      await db.transaction(async (tx) => {
        await tx.run(`DELETE FROM ${EDITS_TABLE} WHERE connection_id = ? AND node_id = ?`, [
          key.connectionId,
          key.nodeId,
        ]);
      });
    },

    close: () => db.close(),
  };
};

/**
 * Open the database, bring it to the current schema, and adopt anything a previous process left
 * mid-dispatch. The sweep happens here, before the store is handed out, so no dispatcher can exist
 * while it runs.
 */
export const openCaptureStore = async (
  db: SqlConnection,
  now: () => number,
): Promise<OpenOutcome> => {
  /**
   * Every way out that does not hand back a live store closes the connection first, so a retried
   * open cannot accumulate handles against a database this process has already given up on.
   */
  const closing = async (outcome: OpenOutcome): Promise<OpenOutcome> => {
    try {
      await db.close();
    } catch {
      // Nothing better is available: the open already failed, and a close that also fails changes
      // neither the outcome nor what the person is told.
    }

    return outcome;
  };

  const outcome = await migrate(db, CAPTURE_MIGRATIONS);

  if (outcome.kind === 'unsupported_version') {
    return closing({
      kind: 'unsupported_version',
      found: outcome.found,
      supported: outcome.supported,
    });
  }
  // The migration runner's message is deliberately dropped here rather than carried outward: it is
  // the driver's words about our schema, and this is the boundary where that stops.
  if (outcome.kind === 'failed') return closing({ kind: 'failed', reason: 'migration_failed' });

  const store = createCaptureStore(db);

  try {
    await store.reconcile(now());
  } catch {
    return closing({ kind: 'failed', reason: 'unreadable' });
  }

  return { kind: 'ready', store };
};

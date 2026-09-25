/**
 * Capture's own database, and the one migration that builds it.
 *
 * Declared by the capability that owns the data and applied by generic infrastructure, the same
 * split container creation used. Three tables live here because they answer three different
 * questions and have to be able to answer them in one transaction: `note_drafts` is what someone has
 * written on this phone, `note_attempts` is what was asked of a server, and `entity_edits` is what
 * someone is changing about something the server already holds.
 *
 * `entity_edits` is the second owner's table, and it is a second table rather than a second draft
 * kind for one reason: creation certainty and edit conflicts are different questions. A creation
 * asks "did this happen, and may its key be replayed"; an edit asks "what does the server hold, and
 * is my writing ahead of it, behind it, or in conflict with it". Entangling them in one row would
 * make one set of columns answer both.
 *
 * Five properties of the creation tables are deliberate rather than incidental.
 *
 * **`note_attempts.title` is duplicated from the frozen request.** A recovery list has to be able to
 * name an attempt even when the stored request no longer decodes - which is precisely the case where
 * reading the title out of the request fails. It is written once and never updated, and it may be
 * empty, because a note may legitimately have been submitted without one. It is a recovery label,
 * never authority for the title the server resolved.
 *
 * **`note_drafts.title` may be empty.** The server resolves a title from content when none was
 * given, so a `length(title) > 0` check - which containers do have - would be wrong here.
 *
 * **There is no foreign key from `note_attempts` to `note_drafts`.** An attempt is evidence about a
 * request that may already have created something; discarding a draft must never be able to delete
 * it. The owner enforces the relationship, and an orphaned attempt stays listable and resolvable.
 *
 * **`note_drafts.state` is about local content, not about the server.** `composing` is ordinary,
 * `submitted` means a version was frozen and dispatched, `created` means an acknowledged creation
 * exists for the version in `submitted_version`. `server_node_id`/`server_revision` are written only
 * from a validated response, and together with `created` they are the durable guard that outlives
 * receipt consumption.
 *
 * **Node types are not spelled into SQL.** `@raphael/contracts` owns that vocabulary; a CHECK here
 * would be a second authority free to contradict it. Stored values are validated on the way out.
 */

import type { Migration } from '../../infrastructure/sqlite/migrate.ts';

export const CAPTURE_DATABASE = 'raphael-capture.db';
export const DRAFTS_TABLE = 'note_drafts';
export const ATTEMPTS_TABLE = 'note_attempts';
export const EDITS_TABLE = 'entity_edits';

export const CAPTURE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE ${DRAFTS_TABLE} (
        draft_id TEXT PRIMARY KEY NOT NULL,
        connection_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('composing', 'submitted', 'created')),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body) AND json_type(body) = 'object'),
        content_schema_version INTEGER NOT NULL,
        destination_type TEXT,
        destination_id INTEGER,
        draft_version INTEGER NOT NULL CHECK (draft_version >= 1),
        submitted_version INTEGER,
        server_node_id INTEGER,
        server_revision INTEGER,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        CHECK ((destination_type IS NULL) = (destination_id IS NULL))
      )`,
      `CREATE INDEX ${DRAFTS_TABLE}_connection ON ${DRAFTS_TABLE} (connection_id)`,
      `CREATE TABLE ${ATTEMPTS_TABLE} (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        draft_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatch_intent', 'uncertain', 'blocked', 'acknowledged')),
        request TEXT NOT NULL CHECK (json_valid(request)),
        submitted_draft_version INTEGER NOT NULL,
        title TEXT NOT NULL,
        destination_type TEXT NOT NULL,
        destination_id INTEGER NOT NULL,
        first_dispatch_at INTEGER NOT NULL CHECK (first_dispatch_at >= 0),
        first_uncertain_at INTEGER CHECK (first_uncertain_at IS NULL OR first_uncertain_at >= 0),
        clock_anomaly INTEGER NOT NULL DEFAULT 0 CHECK (clock_anomaly IN (0, 1)),
        last_outcome TEXT CHECK (last_outcome IS NULL OR json_valid(last_outcome)),
        acknowledged TEXT CHECK (acknowledged IS NULL OR json_valid(acknowledged)),
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0)
      )`,
      `CREATE INDEX ${ATTEMPTS_TABLE}_draft ON ${ATTEMPTS_TABLE} (draft_id)`,
      `CREATE INDEX ${ATTEMPTS_TABLE}_connection ON ${ATTEMPTS_TABLE} (connection_id)`,
    ],
  },
  /**
   * The edit record, and one column the creation table will need.
   *
   * `entity_edits` holds one row per (connection, entity) being edited on this phone. The primary key
   * is the pair, so a record is never rewritten onto another connection: switching servers hides one
   * server's pending edits rather than sending them somewhere they do not belong.
   *
   * Three column groups, and the boundaries between them are the whole design.
   *
   * **`base` and `base_revision` are what this phone last knew the server to hold, as submitted or
   * read by this phone** - never the server's normalized echo. The server trims titles, NFC-normalizes
   * tags and canonicalizes documents, so re-seeding the base from the server's form while the editor
   * keeps its own form would make an untouched entity diff as changed after every write, and autosave
   * would never stop. Local-versus-local equality cannot loop.
   *
   * **The current columns are the local writing**, versioned by `draft_version` exactly as a draft is.
   *
   * **`inflight` is the envelope that was dispatched for `inflight_version`, stored exactly as sent.**
   * Reconciling a lost answer has to compare the server's entity to *what was sent*, and after a
   * process death the current columns may already be newer than that. `base` is never rewritten while
   * `inflight` is set, so base plus envelope is exactly what was sent, with no second copy of the
   * content. The paired CHECK is what makes "there is an envelope in flight" one fact rather than two
   * columns free to disagree.
   *
   * There is no attempt row and no idempotency key here. An update's safety is its base revision, and
   * a lost answer is resolved by reading the entity back rather than by replaying bytes.
   *
   * `note_drafts.tags` arrives in this migration rather than a later one so the creation draft can
   * carry tags without a second schema step. Nothing writes it yet.
   */
  {
    version: 2,
    statements: [
      `CREATE TABLE ${EDITS_TABLE} (
        connection_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL,
        node_type TEXT NOT NULL,
        kind TEXT,
        base TEXT NOT NULL CHECK (json_valid(base) AND json_type(base) = 'object'),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        slug TEXT NOT NULL,
        tags TEXT NOT NULL CHECK (json_valid(tags) AND json_type(tags) = 'array'),
        body TEXT NOT NULL CHECK (json_valid(body) AND json_type(body) = 'object'),
        content_schema_version INTEGER NOT NULL,
        draft_version INTEGER NOT NULL CHECK (draft_version >= 1),
        acknowledged_version INTEGER NOT NULL CHECK (acknowledged_version >= 0),
        inflight_version INTEGER,
        inflight TEXT CHECK (inflight IS NULL OR (json_valid(inflight) AND json_type(inflight) = 'object')),
        sync_state TEXT NOT NULL CHECK (sync_state IN ('syncing', 'refused', 'conflicted')),
        last_refusal TEXT CHECK (last_refusal IS NULL OR json_valid(last_refusal)),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (connection_id, node_id),
        CHECK ((inflight_version IS NULL) = (inflight IS NULL))
      )`,
      `CREATE INDEX ${EDITS_TABLE}_connection ON ${EDITS_TABLE} (connection_id)`,
      // Existing drafts take the empty list, which is what they have: a draft written before tags
      // existed asked for none. The default is what makes the column addable to rows already there.
      `ALTER TABLE ${DRAFTS_TABLE} ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(tags) AND json_type(tags) = 'array')`,
    ],
  },
  /**
   * Saved creation answers gain the two lifecycle fields every entity now carries (story #8).
   *
   * `note_attempts.acknowledged` is the Create response exactly as the server sent it, and the store
   * decodes it again on every read with the current contract, which now requires `archived` and
   * `archiveCauses`. Without this step every acknowledgement saved before the change would read as
   * unreadable - an integrity problem where there is none.
   *
   * The values written are historically true, not a guess: nothing could be archived before archive
   * causes existed, so every entity acknowledged here was active, with no causes, when it was created.
   * The server rewrites its own saved replays the same way for the same reason (R11). A Create
   * response is a historical confirmation, never current state, so this does not claim anything about
   * the entity now.
   *
   * A row the `WHERE` does not match is left exactly as it is. It already fails its decode, and
   * inventing fields inside it would present an unreadable row as a plausible one.
   */
  {
    version: 3,
    statements: [
      `UPDATE ${ATTEMPTS_TABLE}
          SET acknowledged = json_set(acknowledged, '$.entity.archived', json('false'),
                                                    '$.entity.archiveCauses', json('[]'))
        WHERE acknowledged IS NOT NULL
          AND json_valid(acknowledged)
          AND json_type(acknowledged, '$.entity') = 'object'`,
    ],
  },
];

/**
 * Capture's own database, and the one migration that builds it.
 *
 * Declared by the capability that owns the data and applied by generic infrastructure, the same
 * split container creation used. Two tables live here because they answer two different questions
 * and have to be able to answer them in one transaction: `note_drafts` is what someone has written
 * on this phone, `note_attempts` is what was asked of a server.
 *
 * Five properties are deliberate rather than incidental.
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
];

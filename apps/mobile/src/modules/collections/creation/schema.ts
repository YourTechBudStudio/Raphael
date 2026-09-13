/**
 * The pending-attempt table, and the steps that build it.
 *
 * Declared by the capability that owns the data, applied by generic infrastructure - the same split
 * the backend uses, where `modules/nodes` declares its tables and composition collects them. The
 * migration runner here knows nothing about creation, and this file knows nothing about how a
 * migration is executed.
 *
 * The constraints are the ones that are genuinely invariant: a state the app can read, a request
 * that is JSON, a title that exists, and timestamps that are timestamps. Node types deliberately do
 * **not** get a CHECK - `NODE_TYPES` in the contracts is their authority, and spelling them into SQL
 * would be a second one that a future release could contradict without noticing. Stored types are
 * validated on the way out instead.
 */

import type { Migration } from '../../../infrastructure/sqlite/migrate.ts';

export const ATTEMPTS_DATABASE = 'raphael-creation.db';
export const ATTEMPTS_TABLE = 'creation_attempts';

export const CREATION_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE ${ATTEMPTS_TABLE} (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        connection_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatch_intent', 'uncertain', 'blocked', 'acknowledged')),
        request TEXT NOT NULL CHECK (json_valid(request)),
        type TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) > 0),
        parent_area_id INTEGER,
        first_dispatch_at INTEGER NOT NULL CHECK (first_dispatch_at >= 0),
        first_uncertain_at INTEGER CHECK (first_uncertain_at IS NULL OR first_uncertain_at >= 0),
        clock_anomaly INTEGER NOT NULL DEFAULT 0 CHECK (clock_anomaly IN (0, 1)),
        last_outcome TEXT CHECK (last_outcome IS NULL OR json_valid(last_outcome)),
        acknowledged TEXT CHECK (acknowledged IS NULL OR json_valid(acknowledged)),
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0)
      )`,
      `CREATE INDEX ${ATTEMPTS_TABLE}_connection ON ${ATTEMPTS_TABLE} (connection_id)`,
    ],
  },
];

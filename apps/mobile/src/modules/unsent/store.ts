/**
 * The `unsent` table, and an in-memory copy of it for screens and the runner to read synchronously.
 *
 * Every change is a read-modify-write inside one serialized transaction, so a keystroke and a
 * runner's compare-and-set delete can never interleave: whichever runs second sees the other's row.
 */

import type { NodeType, ResourceKind } from '@raphael/contracts/nodes';

import type { Migration, SqlConnection, SqlParam, SqlReader } from '../../infrastructure/sqlite';
import type { Destination, UnsentRow, UnsentStatus } from './row.ts';

export const DATABASE_NAME = 'raphael.db';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE unsent (
        id TEXT PRIMARY KEY NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('create', 'edit')),
        node_type TEXT NOT NULL CHECK (node_type IN ('area', 'project', 'resource')),
        kind TEXT,
        node_id INTEGER,
        base_revision INTEGER,
        destination TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        slug TEXT NOT NULL,
        tags TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'refused', 'conflict')),
        error TEXT,
        version INTEGER NOT NULL,
        sent_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX unsent_edit_node ON unsent (node_id) WHERE op = 'edit'`,
    ],
  },
];

interface StoredRow {
  readonly id: string;
  readonly op: string;
  readonly node_type: string;
  readonly kind: string | null;
  readonly node_id: number | null;
  readonly base_revision: number | null;
  readonly destination: string | null;
  readonly title: string;
  readonly description: string;
  readonly slug: string;
  readonly tags: string;
  readonly body: string;
  readonly status: string;
  readonly error: string | null;
  readonly version: number;
  readonly sent_version: number;
  readonly updated_at: number;
}

const isDestination = (value: unknown): value is Destination => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    candidate['root'] === true ||
    ((candidate['type'] === 'area' || candidate['type'] === 'project') &&
      typeof candidate['id'] === 'number')
  );
};

/** A row this build can use, or null. The table's CHECKs cover the enums. */
const decode = (stored: StoredRow): UnsentRow | null => {
  try {
    const tags: unknown = JSON.parse(stored.tags);
    const body: unknown = JSON.parse(stored.body);
    const destination: unknown =
      stored.destination === null ? null : JSON.parse(stored.destination);

    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) return null;
    if (typeof body !== 'object' || body === null) return null;
    if (destination !== null && !isDestination(destination)) return null;
    if (stored.op === 'edit' && (stored.node_id === null || stored.base_revision === null)) {
      return null;
    }

    return {
      id: stored.id,
      op: stored.op as UnsentRow['op'],
      nodeType: stored.node_type as NodeType,
      kind: stored.kind as ResourceKind | null,
      nodeId: stored.node_id,
      baseRevision: stored.base_revision,
      destination,
      title: stored.title,
      description: stored.description,
      slug: stored.slug,
      tags: tags as string[],
      body,
      status: stored.status as UnsentStatus,
      error: stored.error,
      version: stored.version,
      sentVersion: stored.sent_version,
      updatedAt: stored.updated_at,
    };
  } catch {
    return null;
  }
};

const COLUMNS =
  'op, node_type, kind, node_id, base_revision, destination, title, description, slug, tags, body, status, error, version, sent_version, updated_at';

const valuesOf = (row: UnsentRow): SqlParam[] => [
  row.op,
  row.nodeType,
  row.kind,
  row.nodeId,
  row.baseRevision,
  row.destination === null ? null : JSON.stringify(row.destination),
  row.title,
  row.description,
  row.slug,
  JSON.stringify(row.tags),
  JSON.stringify(row.body),
  row.status,
  row.error,
  row.version,
  row.sentVersion,
  row.updatedAt,
];

const storedOf = (row: UnsentRow): StoredRow => {
  const [
    op,
    nodeType,
    kind,
    nodeId,
    baseRevision,
    destination,
    title,
    description,
    slug,
    tags,
    body,
    status,
    error,
    version,
    sentVersion,
    updatedAt,
  ] = valuesOf(row);

  return {
    id: row.id,
    op: op as string,
    node_type: nodeType as string,
    kind: kind as string | null,
    node_id: nodeId as number | null,
    base_revision: baseRevision as number | null,
    destination: destination as string | null,
    title: title as string,
    description: description as string,
    slug: slug as string,
    tags: tags as string,
    body: body as string,
    status: status as string,
    error: error as string | null,
    version: version as number,
    sent_version: sentVersion as number,
    updated_at: updatedAt as number,
  };
};

const read = async (tx: SqlReader, select: Select): Promise<UnsentRow | undefined> => {
  const stored =
    'id' in select
      ? await tx.get<StoredRow>('SELECT * FROM unsent WHERE id = ?', [select.id])
      : await tx.get<StoredRow>("SELECT * FROM unsent WHERE op = 'edit' AND node_id = ?", [
          select.nodeId,
        ]);

  return stored === undefined ? undefined : (decode(stored) ?? undefined);
};

export type Select = { readonly id: string } | { readonly nodeId: number };

/**
 * Given the row as it is now (if any), what it should become: a row to store, null to delete it, or
 * undefined to leave it alone.
 */
export type Change = (row: UnsentRow | undefined) => UnsentRow | null | undefined;

export interface UnsentStore {
  /** Every row, oldest first. */
  rows(): readonly UnsentRow[];
  subscribe(listener: () => void): () => void;
  /** Applies `change` to the selected row in one transaction, and returns what was stored. */
  change(select: Select, change: Change): Promise<UnsentRow | null | undefined>;
  clear(): Promise<void>;
}

/** Loads the table, deleting any row this build cannot read. */
export const openUnsentStore = async (
  db: SqlConnection,
  log: (message: string) => void = () => {},
): Promise<UnsentStore> => {
  let rows: readonly UnsentRow[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly UnsentRow[]): void => {
    rows = next;
    for (const listener of listeners) listener();
  };

  const stored = await db.all<StoredRow>('SELECT * FROM unsent ORDER BY rowid');
  const loaded: UnsentRow[] = [];

  for (const candidate of stored) {
    const row = decode(candidate);

    if (row !== null) {
      loaded.push(row);
      continue;
    }

    log(`unsent: deleting a row this build cannot read (${candidate.id})`);
    await db.run('DELETE FROM unsent WHERE id = ?', [candidate.id]);
  }

  rows = loaded;

  return {
    rows: () => rows,

    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    change: async (select, change) => {
      const result = await db.transaction(async (tx) => {
        const before = await read(tx, select);
        const after = change(before);

        if (after === undefined) return { before, after };
        if (after !== null && decode(storedOf(after)) === null) {
          throw new Error('unsent: refusing to store a row it could not read back');
        }
        if (after === null) {
          if (before !== undefined) await tx.run('DELETE FROM unsent WHERE id = ?', [before.id]);

          return { before, after };
        }
        if (before === undefined) {
          await tx.run(`INSERT INTO unsent (id, ${COLUMNS}) VALUES (?${', ?'.repeat(16)})`, [
            after.id,
            ...valuesOf(after),
          ]);
        } else {
          const assignments = COLUMNS.split(', ')
            .map((column) => `${column} = ?`)
            .join(', ');

          await tx.run(`UPDATE unsent SET ${assignments} WHERE id = ?`, [
            ...valuesOf(after),
            before.id,
          ]);
        }

        return { before, after };
      });

      const { before, after } = result;

      if (after === undefined) return before;
      if (after === null) {
        if (before !== undefined) publish(rows.filter((row) => row.id !== before.id));

        return null;
      }

      publish(
        before === undefined
          ? [...rows, after]
          : rows.map((row) => (row.id === before.id ? after : row)),
      );

      return after;
    },

    clear: async () => {
      await db.transaction((tx) => tx.run('DELETE FROM unsent'));
      publish([]);
    },
  };
};

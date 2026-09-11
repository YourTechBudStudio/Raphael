import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDatabase,
  type DatabaseConnection,
} from '../src/infrastructure/database/connection.ts';
import { migrateToLatest } from '../src/infrastructure/database/migrate.ts';

/** The canonical empty body, as the seed migration writes it. */
export const EMPTY_BODY = '{"type":"doc","content":[{"type":"paragraph"}]}';

export type TempDatabase = {
  readonly dir: string;
  readonly file: string;
  readonly cleanup: () => void;
};

/** A real on-disk database in a throwaway directory. Nothing here uses an in-memory database: the
 * behavior under test - file modes, WAL sidecars, exclusive ownership - does not exist in memory. */
export const tempDatabase = (tag: string): TempDatabase => {
  const dir = mkdtempSync(join(tmpdir(), `raphael-${tag}-`));
  return {
    dir,
    file: join(dir, 'raphael.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/** Open, take ownership, and migrate. Returns the connection so tests can release it explicitly. */
export const openMigrated = (file: string): DatabaseConnection => {
  const connection = openDatabase({ databasePath: file });
  try {
    migrateToLatest(connection.db);
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
};

/** Run a body against a fresh migrated database, always releasing ownership and removing the files. */
export const withMigrated = <T>(tag: string, body: (connection: DatabaseConnection) => T): T => {
  const temp = tempDatabase(tag);
  let connection: DatabaseConnection | undefined;
  try {
    connection = openMigrated(temp.file);
    return body(connection);
  } finally {
    connection?.close();
    temp.cleanup();
  }
};

/**
 * Typed query helpers. better-sqlite3 returns `unknown` rows, and the shape a test expects is part of
 * what the test asserts, so each call names it once here instead of casting inline.
 */
export const one = <T>(
  db: import('better-sqlite3').Database,
  sql: string,
  ...params: unknown[]
): T => db.prepare(sql).get(...params) as T;

export const many = <T>(
  db: import('better-sqlite3').Database,
  sql: string,
  ...params: unknown[]
): T[] => db.prepare(sql).all(...params) as T[];

export const count = (
  db: import('better-sqlite3').Database,
  sql: string,
  ...params: unknown[]
): number => one<{ c: number }>(db, sql, ...params).c;

/** Assert that a statement is rejected, and that it is rejected for the expected reason. */
export const rejects = (run: () => unknown, pattern: RegExp): string => {
  try {
    run();
  } catch (error) {
    const message = (error as Error).message;
    if (!pattern.test(message)) {
      throw new Error(
        `rejected, but not for the expected reason.\n  expected: ${pattern}\n  actual:   ${message}`,
        {
          cause: error,
        },
      );
    }
    return message;
  }
  throw new Error(`expected rejection matching ${pattern}, but the statement was accepted.`);
};

/** Insert a node directly, bypassing core validation. Test setup only. */
export const insertNode = (
  db: import('better-sqlite3').Database,
  values: {
    type: string;
    parentId?: number | null;
    parentType?: string | null;
    slug: string;
    title?: string;
    body?: string;
    id?: number;
    revision?: number;
    createdAt?: number;
    updatedAt?: number;
  },
): void => {
  const columns = [
    'type',
    'parent_id',
    'parent_type',
    'slug',
    'title',
    'body',
    'revision',
    'created_at',
    'updated_at',
  ];
  const params: unknown[] = [
    values.type,
    values.parentId ?? null,
    values.parentType ?? null,
    values.slug,
    values.title ?? 'Title',
    values.body ?? EMPTY_BODY,
    values.revision ?? 1,
    values.createdAt ?? 1_700_000_000_000,
    values.updatedAt ?? 1_700_000_000_000,
  ];
  if (values.id !== undefined) {
    columns.unshift('id');
    params.unshift(values.id);
  }
  db.prepare(
    `INSERT INTO nodes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...params);
};

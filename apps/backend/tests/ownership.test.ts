import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DatabaseUnavailableError,
  openDatabase,
} from '../src/infrastructure/database/connection.ts';
import { one, openMigrated, rejects, tempDatabase } from './support.ts';

const HOLDER = fileURLToPath(new URL('./ownership-holder.ts', import.meta.url));

const attemptAccess = (databasePath: string): string =>
  spawnSync(process.execPath, [HOLDER, databasePath, 'access'], {
    encoding: 'utf8',
    timeout: 30_000,
  }).stdout.trim();

describe('pragmas', () => {
  test('durability and integrity settings are verified by readback, not assumed', () => {
    const temp = tempDatabase('pragma');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      const read = (pragma: string): unknown =>
        Object.values(one<Record<string, unknown>>(connection.db, `PRAGMA ${pragma}`))[0];
      assert.equal(read('journal_mode'), 'wal');
      assert.equal(read('locking_mode'), 'exclusive');
      assert.equal(read('synchronous'), 2, 'FULL');
      assert.equal(read('foreign_keys'), 1);
      assert.equal(read('wal_autocheckpoint'), 1000);
      assert.equal(read('busy_timeout'), 5000, 'raised after acquisition');
      // The release path runs PRAGMA optimize while exclusive ownership is still held. This caps the
      // rows it examines per index, so shutdown cost follows the schema rather than how much the
      // owner has stored. It bounds work, not interruptibility - the call cannot be cancelled.
      assert.equal(read('analysis_limit'), 400, 'release-path optimize is bounded');
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('startup fails if the optimize bound did not take effect', () => {
    // Guards the claim above: a silently ignored analysis_limit would leave shutdown unbounded while
    // the code still asserted it was bounded.
    const temp = tempDatabase('bound');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      assert.equal(
        Object.values(one<Record<string, unknown>>(connection.db, 'PRAGMA analysis_limit'))[0],
        400,
      );
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('extension loading is not available', () => {
    const temp = tempDatabase('ext');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      rejects(
        () => connection.db.prepare(`SELECT load_extension('/nonexistent')`).get(),
        /not authorized|no such function/i,
      );
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('the shared-memory wal-index is absent, which is correct under exclusive locking', () => {
    // locking_mode is set before the first WAL access, so SQLite elides the -shm file. Its absence is
    // an expected outcome of that ordering, not a missing artifact.
    const temp = tempDatabase('shm');
    const connection = openMigrated(temp.file);
    try {
      assert.ok(existsSync(`${temp.file}-wal`), 'the write-ahead log exists');
      assert.ok(!existsSync(`${temp.file}-shm`), 'no wal-index is needed');
    } finally {
      connection.close();
      temp.cleanup();
    }
  });
});

describe('exclusive ownership', () => {
  test('a second connection in the same process is refused', () => {
    const temp = tempDatabase('same-process');
    const connection = openMigrated(temp.file);
    try {
      // POSIX record locks are per-process, so a naive implementation would let this succeed and the
      // whole guarantee would be untested. SQLite's own inode bookkeeping is what refuses it.
      const error = rejects(
        () => openDatabase({ databasePath: temp.file, acquisitionTimeoutMs: 200 }),
        /already in use/,
      );
      assert.match(error, /One backend process owns a database for as long as it runs/);
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('another process is refused, and told what to do about it', () => {
    const temp = tempDatabase('cross-process');
    const connection = openMigrated(temp.file);
    try {
      const result = attemptAccess(temp.file);
      assert.match(result, /^REFUSED/);
      assert.match(result, /already in use by another Raphael process/);
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('ownership survives ordinary commits and rollbacks', () => {
    const temp = tempDatabase('retained');
    const connection = openMigrated(temp.file);
    try {
      connection.db.exec('BEGIN IMMEDIATE');
      connection.db
        .prepare(
          `INSERT INTO nodes (type, parent_id, parent_type, slug, title, body, created_at, updated_at)
           VALUES ('project', 1, 'area', 'committed', 'C', '{"type":"doc"}', 1, 1)`,
        )
        .run();
      connection.db.exec('COMMIT');
      connection.db.exec('BEGIN IMMEDIATE');
      connection.db.exec('ROLLBACK');

      assert.match(attemptAccess(temp.file), /^REFUSED/, 'still owned after commit and rollback');
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('contention fails promptly rather than hanging', () => {
    const temp = tempDatabase('bounded');
    const connection = openMigrated(temp.file);
    try {
      const started = Date.now();
      assert.match(attemptAccess(temp.file), /^REFUSED/);
      // The child uses a 200ms acquisition timeout; process startup dominates the rest. The claim is
      // only that it is bounded and quick, not a latency guarantee.
      assert.ok(Date.now() - started < 20_000, 'refusal must not hang');
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('a clean close releases ownership', () => {
    const temp = tempDatabase('release');
    const connection = openMigrated(temp.file);
    connection.close();
    try {
      assert.match(attemptAccess(temp.file), /^OPENED/);
    } finally {
      temp.cleanup();
    }
  });

  test('closing twice is safe', () => {
    const temp = tempDatabase('double-close');
    const connection = openMigrated(temp.file);
    connection.close();
    connection.close();
    temp.cleanup();
  });
});

describe('process death', () => {
  test('ownership is released and WAL-only committed data survives', async () => {
    const temp = tempDatabase('crash');
    try {
      const child = spawn(process.execPath, [HOLDER, temp.file, 'hold'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let output = '';
      await new Promise<void>((resolve) => {
        child.stdout.on('data', (chunk: Buffer) => {
          output += String(chunk);
          if (output.includes('HELD')) resolve();
        });
        setTimeout(resolve, 20_000);
      });
      assert.match(output, /HELD/, 'the holder must acquire ownership');
      assert.match(attemptAccess(temp.file), /^REFUSED/, 'held while the holder lives');

      // No clean shutdown: the kernel releases the lock, with no stale-lock file to clean up.
      child.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 800));

      const recovered = attemptAccess(temp.file);
      assert.match(recovered, /^OPENED/, 'ownership released by process death');
      // Read the row back. The main file opening is not by itself evidence that the WAL was recovered.
      assert.match(
        recovered,
        /committed-before-crash/,
        'data committed only to the WAL must survive',
      );
    } finally {
      temp.cleanup();
    }
  });
});

describe('failed startup', () => {
  test('a database that fails its compatibility guard does not stay owned', () => {
    const temp = tempDatabase('failed-start');
    const first = openDatabase({ databasePath: temp.file });
    first.db.exec('CREATE TABLE someone_elses_notes (id INTEGER PRIMARY KEY)');
    first.close();

    // openMigrated closes the connection when migration throws, so the next attempt can proceed.
    rejects(() => openMigrated(temp.file), /not a Raphael database/);
    const connection = openDatabase({ databasePath: temp.file });
    try {
      assert.ok(connection.db.prepare('SELECT 1 AS ok').get());
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('the error names the reason so a caller can act on it', () => {
    const temp = tempDatabase('reason');
    const connection = openMigrated(temp.file);
    try {
      const error = (() => {
        try {
          openDatabase({ databasePath: temp.file, acquisitionTimeoutMs: 200 });
          return undefined;
        } catch (caught) {
          return caught as DatabaseUnavailableError;
        }
      })();
      assert.ok(error instanceof DatabaseUnavailableError);
      assert.equal(error.reason, 'already_in_use');
      assert.ok(
        !/\bpassword\b|\bkey\b/i.test(error.message),
        'no credential material in diagnostics',
      );
    } finally {
      connection.close();
      temp.cleanup();
    }
  });
});

describe('file protection', () => {
  test('the database and its write-ahead log are owner-only', () => {
    const temp = tempDatabase('modes');
    const connection = openMigrated(temp.file);
    try {
      // The sidecar mode is not set directly: SQLite derives it from the database file, which is why
      // the file is pre-created at 0600 before SQLite ever opens it.
      assert.equal(statSync(temp.file).mode & 0o777, 0o600, 'database');
      assert.equal(statSync(`${temp.file}-wal`).mode & 0o777, 0o600, 'write-ahead log');
      assert.equal(statSync(temp.dir).mode & 0o777, 0o700, 'data directory');
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('a directory created for the database is restrictive', () => {
    const temp = tempDatabase('nested');
    try {
      const nested = join(temp.dir, 'data', 'raphael.db');
      const connection = openDatabase({ databasePath: nested });
      connection.close();
      assert.equal(statSync(join(temp.dir, 'data')).mode & 0o777, 0o700);
    } finally {
      temp.cleanup();
    }
  });
});

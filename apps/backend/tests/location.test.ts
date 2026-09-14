import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { isNativeLoadFailure, openDatabase } from '../src/infrastructure/database/connection.ts';
import {
  DatabaseLocationError,
  prepareDataDirectory,
  prepareDatabaseFile,
  supportsPosixModes,
} from '../src/infrastructure/database/location.ts';
import { rejects, tempDatabase } from './support.ts';

// Storage protection rests on the POSIX permission model. Where that model is absent the backend
// refuses to open storage at all, so these expectations are only meaningful where it applies.
describe(
  'filesystem verification',
  { skip: supportsPosixModes() ? false : 'POSIX modes unavailable' },
  () => {
    test('a new database is created owner-only before SQLite opens it', () => {
      const temp = tempDatabase('create');
      try {
        prepareDataDirectory(temp.dir);
        prepareDatabaseFile(temp.file);
        assert.equal(statSync(temp.file).mode & 0o777, 0o600);
        // Creating it ourselves is what makes the write-ahead log owner-only: SQLite copies the mode of
        // the database file onto its sidecars, so leaving creation to SQLite would hand the WAL whatever
        // the ambient umask allowed.
      } finally {
        temp.cleanup();
      }
    });

    test('a symbolic link at the database path is refused', () => {
      const temp = tempDatabase('symlink');
      try {
        const target = join(temp.dir, 'elsewhere.db');
        writeFileSync(target, '');
        chmodSync(target, 0o600);
        const link = join(temp.dir, 'link.db');
        symlinkSync(target, link);
        const message = rejects(() => prepareDatabaseFile(link), /symbolic link/);
        assert.match(message, /point the configured path at a regular file/);
      } finally {
        temp.cleanup();
      }
    });

    test('a directory at the database path is refused', () => {
      const temp = tempDatabase('dirpath');
      try {
        const asDirectory = join(temp.dir, 'raphael.db');
        mkdirSync(asDirectory);
        rejects(() => prepareDatabaseFile(asDirectory), /not a regular file/);
      } finally {
        temp.cleanup();
      }
    });

    test('an existing database readable by others is refused, not silently repaired', () => {
      const temp = tempDatabase('loose-file');
      try {
        writeFileSync(temp.file, '');
        chmodSync(temp.file, 0o644);
        const message = rejects(
          () => prepareDatabaseFile(temp.file),
          /readable or writable by other users/,
        );
        assert.match(message, /chmod 600/, 'the operator is told how to fix it');
        // Deliberately unchanged: repairing someone else's configuration silently would hide the problem.
        assert.equal(statSync(temp.file).mode & 0o777, 0o644);
      } finally {
        temp.cleanup();
      }
    });

    test('a permissive sidecar is refused before SQLite can follow it', () => {
      const temp = tempDatabase('loose-wal');
      try {
        writeFileSync(temp.file, '');
        chmodSync(temp.file, 0o600);
        writeFileSync(`${temp.file}-wal`, '');
        chmodSync(`${temp.file}-wal`, 0o644);
        rejects(
          () => prepareDatabaseFile(temp.file),
          /"-wal" sidecar.*readable or writable by other users/s,
        );
      } finally {
        temp.cleanup();
      }
    });

    test('a symlinked sidecar is refused', () => {
      const temp = tempDatabase('wal-link');
      try {
        writeFileSync(temp.file, '');
        chmodSync(temp.file, 0o600);
        const target = join(temp.dir, 'target');
        writeFileSync(target, '');
        symlinkSync(target, `${temp.file}-wal`);
        rejects(() => prepareDatabaseFile(temp.file), /"-wal" sidecar.*symbolic link/s);
      } finally {
        temp.cleanup();
      }
    });

    test('an existing write-ahead log is normal and is left strictly alone', () => {
      // A -wal after an unclean shutdown holds committed data. Its presence is not an error, and nothing
      // in this code may delete, truncate, or otherwise "repair" it.
      const temp = tempDatabase('leftover');
      try {
        writeFileSync(temp.file, '');
        chmodSync(temp.file, 0o600);
        writeFileSync(`${temp.file}-wal`, 'leftover');
        chmodSync(`${temp.file}-wal`, 0o600);
        prepareDatabaseFile(temp.file);
        assert.equal(
          statSync(`${temp.file}-wal`).size,
          'leftover'.length,
          'the log must be untouched',
        );
      } finally {
        temp.cleanup();
      }
    });

    test('a group- or world-writable data directory is refused', () => {
      const temp = tempDatabase('loose-dir');
      try {
        const directory = join(temp.dir, 'shared');
        mkdirSync(directory, { mode: 0o777 });
        chmodSync(directory, 0o777);
        const message = rejects(() => prepareDataDirectory(directory), /group- or world-writable/);
        assert.match(message, /chmod go-w/, 'actionable guidance rather than a bare refusal');
      } finally {
        temp.cleanup();
      }
    });

    test('a directory that is merely readable by others is permitted', () => {
      // The database and its sidecars are owner-only, so a traversable directory exposes a filename and
      // nothing more. This deliberately permits directory-entry visibility; it is not a claim that the
      // directory is confidential.
      const temp = tempDatabase('readable-dir');
      try {
        const directory = join(temp.dir, 'visible');
        mkdirSync(directory, { mode: 0o755 });
        chmodSync(directory, 0o755);
        const resolved = prepareDataDirectory(directory);
        assert.equal(statSync(resolved).mode & 0o777, 0o755, 'left as the operator configured it');
      } finally {
        temp.cleanup();
      }
    });

    test('a shared system temporary directory is an acceptable ancestor', () => {
      // /tmp is world-writable and sticky. It passes because a trusted user owns it, not because of the
      // sticky bit - which restricts removal but still lets an untrusted directory owner replace entries.
      const temp = tempDatabase('ancestor');
      try {
        const connection = openDatabase({ databasePath: temp.file });
        connection.close();
      } finally {
        temp.cleanup();
      }
    });

    test('refusals carry a machine-readable reason', () => {
      const temp = tempDatabase('reason');
      try {
        const asDirectory = join(temp.dir, 'raphael.db');
        mkdirSync(asDirectory);
        const error = (() => {
          try {
            prepareDatabaseFile(asDirectory);
            return undefined;
          } catch (caught) {
            return caught as DatabaseLocationError;
          }
        })();
        assert.ok(error instanceof DatabaseLocationError);
        assert.equal(error.reason, 'not_regular_file');
      } finally {
        temp.cleanup();
      }
    });
  },
);

describe('telling a broken driver apart from a broken database', () => {
  // These lead to completely different actions. "Cannot open the database" sends someone to check
  // permissions, the path, and the disk, none of which is wrong on a machine whose prebuilt binary
  // is missing or was built for another version of Node - and nothing they try there will work.
  // These cases pin the classification of native driver load failures.
  for (const [what, cause] of [
    [
      'a failed dlopen',
      Object.assign(new Error('something failed'), { code: 'ERR_DLOPEN_FAILED' }),
    ],
    ['a missing bindings file', new Error('Could not locate the bindings file. Tried: ...')],
    ['an addon path in the message', new Error('cannot open better_sqlite3.node')],
    ['a Node ABI mismatch', new Error('was compiled against a different NODE_MODULE_VERSION')],
    ['a foreign architecture', new Error('invalid ELF header')],
  ] as const) {
    test(`recognises ${what}`, () => {
      assert.equal(isNativeLoadFailure(cause), true);
    });
  }

  for (const [what, cause] of [
    [
      'an ordinary SQLite failure',
      Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' }),
    ],
    [
      'a permission failure',
      new Error("EACCES: permission denied, open '/somewhere/raphael.sqlite'"),
    ],
    ['nothing at all', null],
    ['a string', 'dlopen'],
  ] as const) {
    test(`does not claim ${what} is a driver problem`, () => {
      assert.equal(isNativeLoadFailure(cause), false);
    });
  }
});

describe('unsupported platforms', () => {
  test('storage is refused where the protection cannot be established', () => {
    // Recorded as behavior rather than a note: a decision log does not protect anyone's database.
    if (supportsPosixModes()) {
      assert.equal(process.platform === 'win32', false);
      return;
    }
    const temp = tempDatabase('unsupported');
    try {
      rejects(() => openDatabase({ databasePath: temp.file }), /supported on macOS and Linux only/);
    } finally {
      temp.cleanup();
    }
  });
});

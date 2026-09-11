import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

import {
  formatMode,
  inspectAncestors,
  inspectProtectedFile,
  isGroupOrWorldWritable,
  supportsPosixModes as posixModesSupported,
  type PathRejection,
} from '@raphael/fs-trust';

/**
 * Filesystem preparation and verification for the database location.
 *
 * What this establishes: under the POSIX permission model, no *other unprivileged user* can read the
 * database, its write-ahead log, or a rollback journal, and none can replace the directory entries
 * they live in. What it does not establish: isolation from another process running as the same user,
 * from a privileged administrator, or anything at all about ACLs, mount options, or network
 * filesystems. Those are outside the model, not gaps that further mode checks would close.
 *
 * Ordering matters and is load-bearing. SQLite derives the mode of `-wal` and `-shm` from the mode of
 * the database file, so the database must already exist at 0600 before SQLite opens it; otherwise the
 * sidecars inherit whatever the ambient umask allows, and the write-ahead log - which holds committed
 * note content - becomes readable by others.
 */

/** Modes for artifacts this code creates. Directory 0700, database file 0600. */
const DATA_DIR_MODE = 0o700;
const DATABASE_FILE_MODE = 0o600;

/** Sidecars SQLite may place beside the database. */
export const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export class DatabaseLocationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'DatabaseLocationError';
    this.reason = reason;
  }
}

// Annotated on the binding, not only on the arrow, so control-flow analysis treats a call as
// terminating and narrows the values checked before it.
const fail: (reason: string, message: string) => never = (reason, message) => {
  throw new DatabaseLocationError(reason, message);
};

/** POSIX mode support. On platforms without it, callers refuse to open storage at all. */
export const supportsPosixModes = posixModesSupported;

/**
 * Verify the ancestor chain of a resolved directory.
 *
 * The rule - a trusted owner, not group- or world-writable, the sticky bit not sufficient on its own -
 * lives in `@raphael/fs-trust`, because the CLI applies the identical rule to the directory holding an
 * API key. What stays here is the wording, which is about a database and is written for someone who
 * configured a database path.
 */
const verifyAncestors = (directory: string): void => {
  const rejection = inspectAncestors(directory);
  if (rejection === undefined) return;
  switch (rejection.reason) {
    case 'ancestor_unreadable':
      fail(
        'ancestor_unreadable',
        `cannot inspect "${rejection.path}" while verifying the data directory.`,
      );
      break;
    case 'ancestor_untrusted_owner':
      fail(
        'ancestor_untrusted_owner',
        `"${rejection.path}" is owned by uid ${rejection.uid}, which is neither this process's user nor root. ` +
          `That owner can change its permissions at any time, so the database beneath it cannot be protected. ` +
          `Choose a database path whose parent directories you own.`,
      );
      break;
    case 'ancestor_writable':
      fail(
        'ancestor_writable',
        `"${rejection.path}" is group- or world-writable (mode ${formatMode(rejection.mode ?? 0)}), so another user ` +
          `could replace the directories leading to the database. Restrict it, or choose a different database path.`,
      );
      break;
    default:
      // The artifact reasons cannot arise from an ancestor walk. Naming them as unreachable is better
      // than a silent fall-through that would treat an untrusted path as acceptable.
      fail(rejection.reason, `"${rejection.path}" could not be verified.`);
  }
};

/**
 * Ensure the data directory exists with restrictive permissions and verify it is safe to use.
 *
 * A directory we create is 0700. An existing directory is inspected, never silently repaired: it must
 * be owned by the effective user and must not be group- or world-writable. Group or world *read* and
 * traversal are permitted, because the database and its sidecars are themselves owner-only - this
 * deliberately allows directory-entry visibility and is not a claim of directory confidentiality.
 */
export const prepareDataDirectory = (directory: string): string => {
  const absolute = resolve(directory);
  try {
    mkdirSync(absolute, { recursive: true, mode: DATA_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      const message = (error as Error).message;
      fail(
        'data_directory_uncreatable',
        `cannot create the data directory "${absolute}": ${message}`,
      );
    }
  }

  const link = lstatSync(absolute, { throwIfNoEntry: false });
  if (link === undefined)
    fail('data_directory_missing', `the data directory "${absolute}" does not exist.`);
  if (!link.isDirectory() && !link.isSymbolicLink()) {
    fail('data_directory_not_directory', `"${absolute}" exists but is not a directory.`);
  }

  // An ordinary symlink in the path (a platform directory alias, for instance) is acceptable; what
  // matters is the location it actually resolves to, which is what gets verified.
  const resolved = realpathSync(absolute);
  const info = statSync(resolved);
  if (!info.isDirectory())
    fail('data_directory_not_directory', `"${resolved}" is not a directory.`);
  if (info.uid !== process.getuid?.()) {
    fail(
      'data_directory_foreign_owner',
      `the data directory "${resolved}" is owned by uid ${info.uid}, not by this process's user. ` +
        `Raphael will not adopt storage it does not own.`,
    );
  }
  if (isGroupOrWorldWritable(info.mode)) {
    fail(
      'data_directory_writable',
      `the data directory "${resolved}" is group- or world-writable (mode ${(info.mode & 0o7777).toString(8)}). ` +
        `Another user could replace the database file. Run "chmod go-w ${resolved}" or choose a different location.`,
    );
  }
  // An existing directory that is merely stricter or looser than 0700 - while still not
  // group- or world-writable - is left exactly as the operator configured it. Silently tightening
  // someone else's directory would change behavior beyond what was asked for.
  verifyAncestors(resolved);
  return resolved;
};

/**
 * Create the database file at 0600 if absent, or verify an existing one, and check any sidecars that
 * are already present. Runs before SQLite opens anything.
 *
 * `O_NOFOLLOW` is used rather than an `lstat` decision alone, but it does not make this race-free:
 * SQLite takes a path, not the descriptor opened here, so a window remains between this check and
 * SQLite's own open. The guarantee comes from the verified directory and ancestor chain above - the
 * only party who can swap the entry is the user running this process. `O_NOFOLLOW` is defence in
 * depth on top of that, not the protection itself.
 */
export const prepareDatabaseFile = (databasePath: string): void => {
  const absolute = resolve(databasePath);
  const existing = lstatSync(absolute, { throwIfNoEntry: false });

  if (existing === undefined) {
    let fd: number;
    try {
      fd = openSync(
        absolute,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        DATABASE_FILE_MODE,
      );
    } catch (error) {
      const message = (error as Error).message;
      fail(
        'database_file_uncreatable',
        `cannot create the database file "${absolute}": ${message}`,
      );
      throw error;
    }
    closeSync(fd);
  } else {
    verifyExistingFile(absolute, existing, 'database');
    // Confirm we can open it without following a link. The descriptor is closed immediately; SQLite
    // opens the path itself.
    let fd: number;
    try {
      fd = openSync(absolute, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (error) {
      const message = (error as Error).message;
      fail('database_file_unopenable', `cannot open the database file "${absolute}": ${message}`);
      throw error;
    }
    closeSync(fd);
  }

  verifySidecars(absolute);
};

/**
 * Inspect sidecars that exist. Their presence is entirely normal - a `-wal` left by an unclean
 * shutdown holds committed data that SQLite recovers on open - so this verifies safety and then
 * leaves them alone. Nothing here creates, deletes, truncates, or otherwise repairs a sidecar.
 */
export const verifySidecars = (databasePath: string): void => {
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = databasePath + suffix;
    const info = lstatSync(sidecar, { throwIfNoEntry: false });
    if (info === undefined) continue;
    verifyExistingFile(sidecar, info, `"${suffix}" sidecar`);
  }
};

/**
 * Verify an artifact that already exists: a regular file, ours, and unreadable by anyone else.
 *
 * The checks and their order live in `@raphael/fs-trust`; the labels and remediation are storage's.
 */
const verifyExistingFile = (path: string, info: import('node:fs').Stats, label: string): void => {
  const rejection: PathRejection | undefined = inspectProtectedFile(path, info);
  if (rejection === undefined) return;
  switch (rejection.reason) {
    case 'symlink_rejected':
      fail(
        'symlink_rejected',
        `the ${label} at "${path}" is a symbolic link. Raphael will not follow a link to storage; ` +
          `point the configured path at a regular file instead.`,
      );
      break;
    case 'not_regular_file':
      fail('not_regular_file', `the ${label} at "${path}" is not a regular file.`);
      break;
    case 'foreign_owner':
      fail(
        'foreign_owner',
        `the ${label} at "${path}" is owned by uid ${rejection.uid}, not by this process's user.`,
      );
      break;
    case 'permissive_mode':
      fail(
        'permissive_mode',
        `the ${label} at "${path}" is readable or writable by other users (mode ${formatMode(rejection.mode ?? 0)}). ` +
          `Raphael will not report storage as protected when it is not. Run "chmod 600 ${path}" if the file is yours.`,
      );
      break;
    default:
      fail(rejection.reason, `the ${label} at "${path}" could not be verified.`);
  }
};

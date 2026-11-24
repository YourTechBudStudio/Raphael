/**
 * Where a full-access credential lives on this machine, and what has to be true before it is written.
 *
 * The file holds one API key with complete access to someone's second brain. That sets the bar: the
 * directory and the file are owner-only, the chain above them cannot be replaced by another user, and
 * a path that fails any of that is **refused rather than repaired**. Silently running `chmod` on
 * something an operator configured is a change they did not ask for, made at the moment they were
 * least likely to notice it.
 *
 * The trust rules themselves live in `@raphael/fs-trust`. This directory must not be traversable by
 * others, since its listing names a credential file.
 *
 * Windows is not supported for persistent login. `chmod` bits do not exist there and a disclaimer is
 * not protection for a stored full-access key, so `login` refuses and remote commands use the
 * environment pair instead. That is a recorded boundary rather than a verified platform.
 */

import {
  accessSync,
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  describeSystemError,
  formatMode,
  inspectAncestors,
  inspectProtectedFile,
  isGroupOrWorldAccessible,
  supportsPosixModes,
} from '@raphael/fs-trust';

import { CLIENT_API_KEY_VARIABLE, CLIENT_ENDPOINT_VARIABLE } from '../../shared/variables.ts';

const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const CONFIG_FILE_NAME = 'config.json';
const CONFIG_DIR_NAME = 'raphael';
/** A stored configuration is small; anything larger is not one. */
const CONFIG_MAX_BYTES = 64 * 1024;

export type ConfigReason =
  | 'unsupported_platform'
  | 'no_home'
  | 'relative_xdg_config_home'
  | 'relative_home'
  | 'directory_unusable'
  | 'directory_uncreatable'
  | 'file_unusable'
  | 'file_unreadable'
  | 'file_too_large'
  | 'file_malformed'
  | 'not_configured'
  | 'write_failed';

export class ConfigError extends Error {
  readonly reason: ConfigReason;
  /** The one next step, when this failure has a more specific one than its reason's. */
  readonly hint: string | undefined;
  constructor(reason: ConfigReason, message: string, hint?: string) {
    super(message);
    this.name = 'ConfigError';
    this.reason = reason;
    this.hint = hint;
  }
}

export interface StoredConfig {
  readonly endpoint: string;
  readonly apiKey: string;
}

export interface ConfigLocation {
  readonly directory: string;
  readonly file: string;
}

/**
 * Where the configuration goes.
 *
 * XDG on macOS as well as Linux. That is a deliberate choice and worth naming: macOS convention would
 * be `~/Library/Application Support`, but a command-line tool's configuration is something people
 * edit, back up, and put in dotfile repositories, and `~/.config/raphael` is where they will look for
 * it. `XDG_CONFIG_HOME` and `HOME` are honored when they are absolute; a relative value is refused
 * rather than resolved against the current directory, because that would put a credential somewhere
 * that changes with `cd`.
 */
export const configLocation = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): ConfigLocation => {
  if (platform === 'win32') {
    throw new ConfigError(
      'unsupported_platform',
      'Saved logins are not supported on Windows yet: Raphael cannot protect a stored API key with ' +
        'file permissions there.',
    );
  }

  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '') {
    if (!isAbsolute(xdg)) {
      throw new ConfigError(
        'relative_xdg_config_home',
        `XDG_CONFIG_HOME must be an absolute path. Got "${xdg}". Raphael will not resolve a credential ` +
          'location against the current directory.',
      );
    }
    const directory = join(xdg, CONFIG_DIR_NAME);
    return { directory, file: join(directory, CONFIG_FILE_NAME) };
  }

  const home = environment.HOME;
  // The same rule as XDG_CONFIG_HOME: a relative HOME would put the credential under whatever
  // directory the command happens to run in.
  if (home !== undefined && home !== '' && !isAbsolute(home)) {
    throw new ConfigError(
      'relative_home',
      `HOME must be an absolute path. Got "${home}". Raphael will not resolve a credential ` +
        'location against the current directory.',
    );
  }
  // An unset HOME falls back to the account's home directory, as `os.homedir()` finds it. An empty
  // one is not looked past: Node reports it as the home directory, and an empty path is no place.
  const resolved = home !== undefined && home !== '' ? home : homedir();
  if (resolved === '') {
    throw new ConfigError(
      'no_home',
      home === ''
        ? 'Cannot work out where to store configuration: HOME is empty and XDG_CONFIG_HOME is not set.'
        : 'Cannot work out where to store configuration: HOME and XDG_CONFIG_HOME are not set, and this account has no home directory.',
    );
  }
  const directory = join(resolved, '.config', CONFIG_DIR_NAME);
  return { directory, file: join(directory, CONFIG_FILE_NAME) };
};

/**
 * Verify the directory, and report the resolved path that everything else must use.
 *
 * The resolved path is the point. An ancestor may legitimately be a symbolic link - platform
 * directory aliases are ordinary - so the chain is verified after resolution, and every subsequent
 * read and write goes through that resolved path. Checking one path and writing through another is
 * exactly the substitution the check exists to prevent.
 */
/** The one message for having no saved login, whichever part of the path was missing. */
const notConfigured = (file: string): ConfigError =>
  new ConfigError(
    'not_configured',
    `Not connected to a Raphael server: there is no saved login at ${file}, and ` +
      `${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} are not set.`,
  );

/**
 * A filesystem call on the way to the credential, with its failure described rather than thrown raw:
 * a permission problem or a file where a directory should be is a setup problem with a next step.
 */
const inspected = <T>(path: string, look: () => T): T => {
  try {
    return look();
  } catch (error) {
    throw new ConfigError(
      'directory_unusable',
      `Cannot inspect "${path}", where your saved login is kept: ${describeSystemError(error)}.`,
      `Make that path a directory you own and can open, or set ${CLIENT_ENDPOINT_VARIABLE} and ` +
        `${CLIENT_API_KEY_VARIABLE} instead.`,
    );
  }
};

const verifiedDirectory = (location: ConfigLocation, create: boolean): string => {
  const { directory } = location;
  if (!supportsPosixModes()) {
    throw new ConfigError(
      'unsupported_platform',
      'Raphael cannot verify file permissions on this platform.',
    );
  }

  const existing = inspected(directory, () => lstatSync(directory, { throwIfNoEntry: false }));
  if (existing === undefined) {
    if (!create) throw notConfigured(location.file);
    try {
      mkdirSync(directory, { recursive: true, mode: CONFIG_DIR_MODE });
    } catch (error) {
      throw new ConfigError(
        'directory_uncreatable',
        `Cannot create "${directory}": ${describeSystemError(error)}.`,
      );
    }
  }

  return verifiedExisting(directory);
};

/** The trust checks on a directory that exists, returning its resolved path. */
const verifiedExisting = (directory: string): string => {
  const resolved = inspected(directory, () => realpathSync(directory));
  const info = inspected(resolved, () => lstatSync(resolved));
  if (!info.isDirectory()) {
    throw new ConfigError('directory_unusable', `"${resolved}" is not a directory.`);
  }
  if (info.uid !== process.getuid?.()) {
    throw new ConfigError(
      'directory_unusable',
      `"${resolved}" is owned by uid ${info.uid}, not by you. Raphael will not store a credential in a ` +
        'directory it does not own.',
    );
  }
  // Stricter than the database directory: this one's listing names a credential file.
  if (isGroupOrWorldAccessible(info.mode)) {
    throw new ConfigError(
      'directory_unusable',
      `"${resolved}" is accessible to other users (mode ${formatMode(info.mode)}). Raphael will not ` +
        'report a credential as protected when it is not.',
      `If it is yours, run "chmod 700 ${resolved}".`,
    );
  }

  const ancestor = inspectAncestors(resolved);
  if (ancestor !== undefined) throw ancestorRefusal(ancestor);

  return resolved;
};

const ancestorRefusal = (ancestor: NonNullable<ReturnType<typeof inspectAncestors>>): ConfigError =>
  new ConfigError(
    'directory_unusable',
    ancestor.reason === 'ancestor_untrusted_owner'
      ? `"${ancestor.path}" is owned by uid ${ancestor.uid}, who could change its permissions at any ` +
          'time, so nothing beneath it can be protected.'
      : ancestor.reason === 'ancestor_writable'
        ? `"${ancestor.path}" is writable by other users (mode ${formatMode(ancestor.mode ?? 0)}), so ` +
          'another user could replace the directories leading to your credential.'
        : `"${ancestor.path}" could not be inspected while verifying where your credential is stored.`,
  );

/** Read the saved configuration, verifying protection before trusting what is in it. */
export const loadConfig = (location: ConfigLocation): StoredConfig => {
  const directory = verifiedDirectory(location, false);
  const file = join(directory, CONFIG_FILE_NAME);

  const info = inspected(file, () => lstatSync(file, { throwIfNoEntry: false }));
  if (info === undefined) throw notConfigured(location.file);

  const rejection = inspectProtectedFile(file, info);
  if (rejection !== undefined) {
    throw new ConfigError(
      'file_unusable',
      rejection.reason === 'symlink_rejected'
        ? `"${file}" is a symbolic link. Raphael will not read a credential through a link.`
        : rejection.reason === 'permissive_mode'
          ? `"${file}" is readable by other users (mode ${formatMode(rejection.mode ?? 0)}).`
          : rejection.reason === 'foreign_owner'
            ? `"${file}" is owned by uid ${rejection.uid}, not by you.`
            : `"${file}" is not a regular file.`,
      rejection.reason === 'permissive_mode'
        ? `Run "chmod 600 ${file}", or run "raphael login" again.`
        : rejection.reason === 'not_regular_file'
          ? `Move "${file}" out of the way, then run "raphael login".`
          : rejection.reason === 'symlink_rejected'
            ? 'Replace the link with a regular file by running "raphael login" again, or keep the key ' +
              `out of your dotfiles and set ${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} instead.`
            : undefined,
    );
  }

  if (info.size > CONFIG_MAX_BYTES) {
    throw new ConfigError('file_too_large', `"${file}" is larger than a configuration should be.`);
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(
      'file_unreadable',
      `Cannot read "${file}": ${describeSystemError(error)}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parse error would quote the file, which holds a key.
    throw new ConfigError('file_malformed', `"${file}" is not valid JSON.`);
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).endpoint !== 'string' ||
    typeof (parsed as Record<string, unknown>).apiKey !== 'string'
  ) {
    throw new ConfigError(
      'file_malformed',
      `"${file}" does not contain an endpoint and an API key.`,
    );
  }

  const { endpoint, apiKey } = parsed as { endpoint: string; apiKey: string };
  return { endpoint, apiKey };
};

export interface SaveOutcome {
  /** True when the replacement is on disk but its durability could not be confirmed. */
  readonly durabilityUnconfirmed: boolean;
  readonly file: string;
}

/**
 * Replace the configuration atomically, and be honest about what survived a crash.
 *
 * The sequence is: write a temporary file in the same directory at 0600, flush it, rename it over the
 * target, then flush the directory so the rename itself is durable. Rename is the atomic step - there
 * is no moment where the file exists half-written.
 *
 * The boundary that must not be blurred: **before the rename succeeds, nothing has changed and the
 * previous configuration is intact. After it succeeds, the replacement has happened.** A directory
 * flush that then fails cannot be reported as "login failed", because the new credential is what the
 * file now contains. It is reported as applied-but-unconfirmed, and nothing is rolled back or retried
 * on the caller's behalf.
 */
export const saveConfig = (location: ConfigLocation, config: StoredConfig): SaveOutcome => {
  const directory = verifiedDirectory(location, true);
  checkReplaceable(directory);
  const file = join(directory, CONFIG_FILE_NAME);
  const temporary = join(directory, `.${CONFIG_FILE_NAME}.${process.pid}.tmp`);

  const payload = `${JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey }, undefined, 2)}\n`;

  try {
    // `wx` refuses an existing entry, so a leftover temporary file is never written through.
    writeFileSync(temporary, payload, { mode: CONFIG_FILE_MODE, flag: 'wx' });
    // The mode argument is subject to umask; set it explicitly so the file is 0600 regardless.
    chmodSync(temporary, CONFIG_FILE_MODE);

    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new ConfigError(
      'write_failed',
      `Could not write the new configuration in "${directory}": ${describeSystemError(error)}.`,
    );
  }

  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new ConfigError(
      'write_failed',
      `Could not replace "${file}": ${describeSystemError(error)}.`,
    );
  }

  // Past this point the replacement has happened. Everything below is about durability only.
  try {
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { durabilityUnconfirmed: true, file };
  }

  return { durabilityUnconfirmed: false, file };
};

export const configDirectoryOf = (file: string): string => dirname(file);

/**
 * What a save needs from a directory that already passed the trust checks: that this user can write
 * in it, and that anything at `config.json` is a file a rename can replace. A save checks it first, and
 * login checks it before anyone types a key, so both say the same thing.
 */
const checkReplaceable = (directory: string): void => {
  try {
    accessSync(directory, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new ConfigError(
      'write_failed',
      `Could not write the new configuration in "${directory}": ${describeSystemError(error)}.`,
    );
  }
  const file = join(directory, CONFIG_FILE_NAME);
  const info = inspected(file, () => lstatSync(file, { throwIfNoEntry: false }));
  // A link is replaced as a link, so only something else in the way is refused.
  if (info !== undefined && !info.isFile() && !info.isSymbolicLink()) {
    throw new ConfigError(
      'write_failed',
      `Could not replace "${file}": ${info.isDirectory() ? 'it is a directory' : 'it is not a regular file'}.`,
      `Move "${file}" out of the way, then run "raphael login" again.`,
    );
  }
};

/** Whether this user can create entries in a directory: the nearest one a save would create under. */
const checkCreatable = (directory: string, target: string): void => {
  try {
    accessSync(directory, constants.W_OK | constants.X_OK);
  } catch (error) {
    // The same sentence the save's own `mkdir` would give.
    throw new ConfigError(
      'directory_uncreatable',
      `Cannot create "${target}": ${describeSystemError(error)}.`,
    );
  }
};

/**
 * Check, before anyone types a key, that `saveConfig` will be able to keep it: the directory passes
 * every trust check, can be written, and holds nothing at `config.json` that is not a file, if it
 * exists; otherwise the nearest existing ancestor is a directory this user can create in, whose chain
 * no other user can replace. Nothing is created.
 */
export const checkConfigDestination = (location: ConfigLocation): void => {
  if (!supportsPosixModes()) {
    throw new ConfigError(
      'unsupported_platform',
      'Raphael cannot verify file permissions on this platform.',
    );
  }
  let current = location.directory;
  for (;;) {
    const path = current;
    const info = inspected(path, () => lstatSync(path, { throwIfNoEntry: false }));
    if (info !== undefined) break;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  if (current === location.directory) {
    checkReplaceable(verifiedExisting(current));
    return;
  }
  const resolved = inspected(current, () => realpathSync(current));
  const info = inspected(resolved, () => lstatSync(resolved));
  if (!info.isDirectory()) {
    throw new ConfigError(
      'directory_uncreatable',
      `Cannot create "${location.directory}": "${resolved}" is not a directory.`,
    );
  }
  const ancestor = inspectAncestors(resolved);
  if (ancestor !== undefined) throw ancestorRefusal(ancestor);
  checkCreatable(resolved, location.directory);
};

/** The endpoint of the saved login, if there is a readable one; never a reason to fail. */
export const savedEndpoint = (location: ConfigLocation): string | undefined => {
  try {
    return loadConfig(location).endpoint;
  } catch {
    return undefined;
  }
};

export interface RemoveOutcome {
  readonly removed: boolean;
  /** The endpoint the removed login pointed at, when it could be read. */
  readonly endpoint: string | undefined;
  readonly file: string;
}

/**
 * Remove the saved login, after the same directory checks a save makes.
 *
 * A link is removed as a link - `unlink` never follows it - and a file with loose permissions is still
 * removed, since removing it is the fix. Anything that is not a file or a link is refused.
 */
export const removeConfig = (location: ConfigLocation): RemoveOutcome => {
  let directory: string;
  try {
    directory = verifiedDirectory(location, false);
  } catch (error) {
    if (error instanceof ConfigError && error.reason === 'not_configured') {
      return { removed: false, endpoint: undefined, file: location.file };
    }
    throw error;
  }
  const file = join(directory, CONFIG_FILE_NAME);
  const info = inspected(file, () => lstatSync(file, { throwIfNoEntry: false }));
  if (info === undefined) return { removed: false, endpoint: undefined, file };
  if (!info.isFile() && !info.isSymbolicLink()) {
    throw new ConfigError(
      'file_unusable',
      `"${file}" is not a regular file, so it is not a saved login.`,
      'Move it out of the way, then run the command again.',
    );
  }
  const endpoint = info.isFile() ? savedEndpoint(location) : undefined;
  try {
    unlinkSync(file);
  } catch (error) {
    throw new ConfigError(
      'write_failed',
      `Could not remove "${file}": ${describeSystemError(error)}.`,
      'Check that you can write to that directory, then run "raphael logout" again.',
    );
  }
  return { removed: true, endpoint, file };
};

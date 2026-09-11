/**
 * Where a full-access credential lives on this machine, and what has to be true before it is written.
 *
 * The file holds one API key with complete access to someone's second brain. That sets the bar: the
 * directory and the file are owner-only, the chain above them cannot be replaced by another user, and
 * a path that fails any of that is **refused rather than repaired**. Silently running `chmod` on
 * something an operator configured is a change they did not ask for, made at the moment they were
 * least likely to notice it.
 *
 * The trust rules themselves live in `@raphael/fs-trust`, shared with the backend's database
 * protection. The policy differences stay here, and they are real: a database *directory* may be
 * traversable by others because the files inside it are owner-only, while this directory may not,
 * since its listing names a credential file.
 *
 * Windows is not supported for persistent login. `chmod` bits do not exist there and a disclaimer is
 * not protection for a stored full-access key, so `login` refuses and remote commands use the
 * environment pair instead. That is a recorded boundary rather than a verified platform.
 */

import {
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
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  formatMode,
  inspectAncestors,
  inspectProtectedFile,
  isGroupOrWorldAccessible,
  supportsPosixModes,
} from '@raphael/fs-trust';

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
  | 'directory_unusable'
  | 'directory_uncreatable'
  | 'file_unusable'
  | 'file_unreadable'
  | 'file_too_large'
  | 'file_malformed'
  | 'not_configured'
  | 'write_failed'
  /** The replacement happened; only the durability of it is unconfirmed. */
  | 'durability_unconfirmed';

export class ConfigError extends Error {
  readonly reason: ConfigReason;
  constructor(reason: ConfigReason, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.reason = reason;
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
 * it. `XDG_CONFIG_HOME` is honored when it is absolute; a relative value is refused rather than
 * resolved against the current directory, because that would put a credential somewhere that changes
 * with `cd`.
 */
export const configLocation = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): ConfigLocation => {
  if (platform === 'win32') {
    throw new ConfigError(
      'unsupported_platform',
      'Saved logins are not supported on Windows yet: Raphael cannot protect a stored API key with ' +
        'file permissions there. Set RAPHAEL_ENDPOINT and RAPHAEL_API_KEY in the environment instead.',
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
  const resolved = home !== undefined && home !== '' ? home : homedir();
  if (resolved === '') {
    throw new ConfigError(
      'no_home',
      'Cannot work out where to store configuration: neither XDG_CONFIG_HOME nor HOME is set.',
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
const verifiedDirectory = (directory: string, create: boolean): string => {
  if (!supportsPosixModes()) {
    throw new ConfigError(
      'unsupported_platform',
      'Raphael cannot verify file permissions on this platform.',
    );
  }

  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing === undefined) {
    if (!create) throw new ConfigError('not_configured', 'No saved login was found.');
    try {
      mkdirSync(directory, { recursive: true, mode: CONFIG_DIR_MODE });
    } catch (error) {
      throw new ConfigError(
        'directory_uncreatable',
        `Cannot create "${directory}": ${(error as Error).message}`,
      );
    }
  }

  const resolved = realpathSync(directory);
  const info = lstatSync(resolved);
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
        `report a credential as protected when it is not. Run "chmod 700 ${resolved}" if it is yours.`,
    );
  }

  const ancestor = inspectAncestors(resolved);
  if (ancestor !== undefined) {
    throw new ConfigError(
      'directory_unusable',
      ancestor.reason === 'ancestor_untrusted_owner'
        ? `"${ancestor.path}" is owned by uid ${ancestor.uid}, who could change its permissions at any ` +
            'time, so nothing beneath it can be protected.'
        : ancestor.reason === 'ancestor_writable'
          ? `"${ancestor.path}" is writable by other users (mode ${formatMode(ancestor.mode ?? 0)}), so ` +
            'another user could replace the directories leading to your credential.'
          : `"${ancestor.path}" could not be inspected while verifying where your credential is stored.`,
    );
  }

  return resolved;
};

/** Read the saved configuration, verifying protection before trusting what is in it. */
export const loadConfig = (location: ConfigLocation): StoredConfig => {
  const directory = verifiedDirectory(location.directory, false);
  const file = join(directory, CONFIG_FILE_NAME);

  const info = lstatSync(file, { throwIfNoEntry: false });
  if (info === undefined) {
    throw new ConfigError('not_configured', 'No saved login was found. Run "raphael login" first.');
  }

  const rejection = inspectProtectedFile(file, info);
  if (rejection !== undefined) {
    throw new ConfigError(
      'file_unusable',
      rejection.reason === 'symlink_rejected'
        ? `"${file}" is a symbolic link. Raphael will not read a credential through a link.`
        : rejection.reason === 'permissive_mode'
          ? `"${file}" is readable by other users (mode ${formatMode(rejection.mode ?? 0)}). Run ` +
            `"chmod 600 ${file}", or run "raphael login" again.`
          : rejection.reason === 'foreign_owner'
            ? `"${file}" is owned by uid ${rejection.uid}, not by you.`
            : `"${file}" is not a regular file.`,
    );
  }

  if (info.size > CONFIG_MAX_BYTES) {
    throw new ConfigError('file_too_large', `"${file}" is larger than a configuration should be.`);
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError('file_unreadable', `Cannot read "${file}": ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parse error would quote the file, which holds a key.
    throw new ConfigError(
      'file_malformed',
      `"${file}" is not valid JSON. Run "raphael login" again to replace it.`,
    );
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).endpoint !== 'string' ||
    typeof (parsed as Record<string, unknown>).apiKey !== 'string'
  ) {
    throw new ConfigError(
      'file_malformed',
      `"${file}" does not contain an endpoint and an API key. Run "raphael login" again.`,
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
  const directory = verifiedDirectory(location.directory, true);
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
      `Could not write the new configuration: ${(error as Error).message}. Your existing configuration is unchanged.`,
    );
  }

  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new ConfigError(
      'write_failed',
      `Could not replace the configuration: ${(error as Error).message}. Your existing configuration is unchanged.`,
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

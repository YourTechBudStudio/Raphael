import { lstatSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { describeSystemError } from '@raphael/fs-trust';

import { configurationFailure } from './errors.ts';

/**
 * The environment, read as a value rather than mutated as a global.
 *
 * This module builds a *snapshot*: the process environment, with an optional `.env` filling in
 * variables the process environment does not define. Nothing here writes to `process.env`. That is
 * not tidiness - this is an importable library, and a startup path that mutated the global
 * environment would change the behavior of every other thing running in the same process, including a
 * CLI that had already read its own configuration.
 *
 * Precedence distinguishes missing from empty. A variable the process actually defines wins even when
 * its value is the empty string: an operator who exported an empty variable has said something, and
 * the right outcome is a validation failure they can see, not a silent fall back to a file value they
 * may have forgotten about.
 *
 * `.env` parsing is `node:util`'s own, and inherits its documented behavior rather than a grammar of
 * ours: quoting and comments are handled, interpolation is not performed, a repeated assignment takes
 * the last value, and a line that is not an assignment is skipped. That leniency is deliberate and is
 * *not* the YAML policy - a configuration file is a contract we define, while `.env` is a convenience
 * format shared with other tools. What protects us is not strict parsing but the key policy below: any
 * value that survives parsing still has to be a usable credential.
 */

/** The largest `.env` that will be read. A `.env` holds a handful of variables. */
export const ENV_MAX_BYTES = 64 * 1024;

export const ENV_FILE_NAME = '.env';

/**
 * The only variable the server consults. Everything else in the snapshot is ignored.
 *
 * It is not the clients' `RAPHAEL_API_KEY`. A shell that starts a server and then runs client
 * commands would otherwise hold half of the clients' environment pair, and every client command in it
 * would refuse to run until the variable was unset.
 */
export const API_KEY_VARIABLE = 'RAPHAEL_SERVER_API_KEY';

/**
 * The clients' variable. The server never reads it; it is named only so a missing server key can say
 * that this one was set instead.
 */
export const CLIENT_API_KEY_VARIABLE = 'RAPHAEL_API_KEY';

export interface EnvironmentSnapshot {
  /** The `.env` that was checked, whether or not it existed. Absent when file reading was skipped. */
  readonly envFile: string | undefined;
  /** The value, or `undefined` when no source defined the variable at all. */
  readonly get: (name: string) => string | undefined;
  /** Where the effective value came from. Used for diagnostics; never reports a value. */
  readonly sourceOf: (name: string) => 'process' | 'file' | 'absent';
  /**
   * Whether the `.env` line that sets `name` has an unquoted `#` right after other text, as in
   * `KEY=ab#cd`. Following the dotenv convention
   * `parseEnv` keeps, that starts a comment, so the value stops before it. Never reports a value.
   */
  readonly cutAtComment: (name: string) => boolean;
}

/**
 * Whether the last assignment to `name` in a `.env` text is unquoted and holds a `#` right after
 * other text: the value it yields stops there. A quoted value keeps its `#`.
 */
const assignmentCutAtComment = (text: string, name: string): boolean => {
  let cut = false;
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/u.exec(line);
    if (match?.[1] !== name) continue;
    const value = match[2] ?? '';
    // `KEY=value # note` is a comment as written; `KEY=ab#cd` is a value that lost its end.
    cut = !/^["'`]/u.test(value) && /\S#/u.test(value);
  }
  return cut;
};

/**
 * Read an own data property from a parsed `.env` result.
 *
 * `parseEnv` returns an ordinary object, and a `.env` containing `__proto__=x` produces it as an own
 * property. Reading through a plain member access would therefore be reading something a file
 * controls; reading the own descriptor's value is not.
 */
const ownValue = (source: object, name: string): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return typeof descriptor.value === 'string' ? descriptor.value : undefined;
};

interface EnvFile {
  readonly values: Record<string, unknown>;
  readonly text: string;
}

const readEnvFile = (path: string): EnvFile | undefined => {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (cause) {
    // An absent `.env` is the ordinary case and says nothing. Any other stat failure - a permission
    // problem, a broken link - is a real condition an operator needs told about, because it is
    // exactly the case where a present file is silently not being used.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      // A link that points nowhere is a present file that is not being used, not an absent one.
      if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
      configurationFailure(
        'env_unreadable',
        `"${path}" is a link to a file that does not exist. Raphael will not start while a ` +
          `${ENV_FILE_NAME} it cannot read is present.`,
        { cause, hint: `Point the link at the right file, or remove "${path}".` },
      );
    }
    configurationFailure(
      'env_unreadable',
      `Cannot read "${path}": ${describeSystemError(cause)}. Raphael will not start while a ` +
        `${ENV_FILE_NAME} it cannot read is present.`,
      { cause, hint: `Fix the permissions on "${path}", or remove it.` },
    );
  }
  if (size > ENV_MAX_BYTES) {
    configurationFailure(
      'env_too_large',
      `"${path}" is ${size} bytes, larger than the ${ENV_MAX_BYTES}-byte limit.`,
    );
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    // Present but unreadable (mode 000, say): refused like a stat failure, even when the key is set
    // in the environment, because a file that is there and not being used is what an operator
    // needs told about.
    configurationFailure(
      'env_unreadable',
      `Cannot read "${path}": ${describeSystemError(cause)}. Raphael will not start while a ` +
        `${ENV_FILE_NAME} it cannot read is present.`,
      {
        cause,
        hint:
          (cause as NodeJS.ErrnoException).code === 'EISDIR'
            ? `Remove the directory "${path}", or replace it with a ${ENV_FILE_NAME} file.`
            : `Fix the permissions on "${path}", or remove it.`,
      },
    );
  }
  // Editors on some systems start a UTF-8 file with a byte order mark, which would otherwise become
  // part of the first variable's name.
  const content = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return { values: parseEnv(content) as Record<string, unknown>, text: content };
};

/**
 * Build the snapshot: the process environment, with an optional `.env` from `directory` supplying only
 * what the process environment does not define.
 *
 * `directory` is the configuration file's directory when one was given, and the invocation directory
 * otherwise, so a `.env` and the file that configures the same server sit together.
 */
export const loadEnvironment = (context: {
  readonly directory: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  /** Skip the file entirely. Tests that are asserting precedence use this. */
  readonly readEnvFile?: boolean;
}): EnvironmentSnapshot => {
  const processEnv = context.processEnv ?? process.env;
  const envFile =
    context.readEnvFile === false ? undefined : resolve(context.directory, ENV_FILE_NAME);
  const file = envFile === undefined ? undefined : readEnvFile(envFile);
  const fromFile = file?.values;

  const sourceOf = (name: string): 'process' | 'file' | 'absent' => {
    if (ownValue(processEnv, name) !== undefined) return 'process';
    if (fromFile !== undefined && ownValue(fromFile, name) !== undefined) return 'file';
    return 'absent';
  };

  return {
    envFile,
    sourceOf,
    cutAtComment: (name) =>
      file !== undefined && sourceOf(name) === 'file' && assignmentCutAtComment(file.text, name),
    get: (name) => {
      const fromProcess = ownValue(processEnv, name);
      if (fromProcess !== undefined) return fromProcess;
      return fromFile === undefined ? undefined : ownValue(fromFile, name);
    },
  };
};

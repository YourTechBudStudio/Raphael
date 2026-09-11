import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

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

/** The only variable the server consults. Everything else in the snapshot is ignored. */
export const API_KEY_VARIABLE = 'RAPHAEL_API_KEY';

export interface EnvironmentSnapshot {
  /** The value, or `undefined` when no source defined the variable at all. */
  readonly get: (name: string) => string | undefined;
  /** Where the effective value came from. Used for diagnostics; never reports a value. */
  readonly sourceOf: (name: string) => 'process' | 'file' | 'absent';
}

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

const readEnvFile = (path: string): Record<string, unknown> | undefined => {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (cause) {
    // An absent `.env` is the ordinary case and says nothing. Any other stat failure - a permission
    // problem, a broken link - is a real condition an operator needs told about, because it is
    // exactly the case where a present file is silently not being used.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    configurationFailure(
      'env_unreadable',
      `cannot read "${path}": ${(cause as Error).message}. ` +
        `Remove the file or fix its permissions; Raphael will not start while a ${ENV_FILE_NAME} it cannot read is present.`,
      { cause },
    );
  }
  if (size > ENV_MAX_BYTES) {
    configurationFailure(
      'env_too_large',
      `"${path}" is ${size} bytes, larger than the ${ENV_MAX_BYTES}-byte limit.`,
    );
  }

  try {
    return parseEnv(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (cause) {
    configurationFailure('env_unreadable', `cannot read "${path}": ${(cause as Error).message}`, {
      cause,
    });
  }
};

/**
 * Build the snapshot: the process environment, with an optional `.env` from the invocation directory
 * supplying only what the process environment does not define.
 */
export const loadEnvironment = (context: {
  readonly cwd: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  /** Skip the file entirely. Tests that are asserting precedence use this. */
  readonly readEnvFile?: boolean;
}): EnvironmentSnapshot => {
  const processEnv = context.processEnv ?? process.env;
  const fromFile =
    context.readEnvFile === false ? undefined : readEnvFile(resolve(context.cwd, ENV_FILE_NAME));

  const sourceOf = (name: string): 'process' | 'file' | 'absent' => {
    if (ownValue(processEnv, name) !== undefined) return 'process';
    if (fromFile !== undefined && ownValue(fromFile, name) !== undefined) return 'file';
    return 'absent';
  };

  return {
    sourceOf,
    get: (name) => {
      const fromProcess = ownValue(processEnv, name);
      if (fromProcess !== undefined) return fromProcess;
      return fromFile === undefined ? undefined : ownValue(fromFile, name);
    },
  };
};

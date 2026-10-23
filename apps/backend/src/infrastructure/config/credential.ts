import { createHash, timingSafeEqual } from 'node:crypto';

import { SENDABLE_API_KEY_RULE, hasApiKey, isSendableApiKey } from '@raphael/contracts/connection';

import { API_KEY_VARIABLE, CLIENT_API_KEY_VARIABLE, type EnvironmentSnapshot } from './env.ts';
import { configurationFailure } from './errors.ts';

/**
 * The configured credential, reduced to what the server actually needs.
 *
 * A running server never needs the key itself - only the ability to decide whether a presented token
 * is it. So the key is hashed once here and the digest is what the rest of the process holds. That
 * reduces the number of places a credential can be read from, printed, or captured in a closure.
 *
 * It is **not** erasure. The caller's string, the process environment, and any intermediate copy the
 * JavaScript engine made all remain, and strings cannot be zeroed. This narrows exposure; it does not
 * eliminate it, and nothing downstream should describe it as though it did.
 *
 * The digest is treated as sensitive in its own right: it is never logged, never serialized, and the
 * object carries no `toJSON`, so an accidental `JSON.stringify` of a configuration object produces
 * nothing useful.
 */

const digestOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export class ApiCredential {
  readonly #digest: Buffer;

  private constructor(digest: Buffer) {
    this.#digest = digest;
  }

  /**
   * The only way to build a credential.
   *
   * A key's strength is the owner's business: there is no length floor. What this refuses is a key
   * that is missing or that no client could send (`isSendableApiKey`), and it refuses here rather than
   * trusting the loader, because `serve` is an importable boundary and a programmatic caller could
   * otherwise start a server that every client fails against.
   *
   * `source` names where the key came from, so an operator reading the failure knows what to edit.
   */
  static fromKey(key: string, source = 'The API key'): ApiCredential {
    if (!hasApiKey(key)) {
      configurationFailure(
        'api_key_missing',
        `${source} is empty. Raphael will not start without one.`,
        { hint: GENERATE_HINT },
      );
    }
    if (!isSendableApiKey(key)) {
      configurationFailure(
        'api_key_unsendable',
        `${source} has characters no client could send: a key must be ${SENDABLE_API_KEY_RULE}.`,
        { hint: GENERATE_HINT },
      );
    }
    return new ApiCredential(digestOf(key));
  }

  /**
   * Whether a presented token is the configured key.
   *
   * Both sides are hashed first, so the comparison runs over two fixed-length buffers and cannot end
   * early on the first differing byte, and a presented token's *length* does not change the work done.
   * This removes a secret-dependent comparison; it does not make request handling as a whole
   * constant-time, and no claim of that kind should be built on it - routing, parsing, and the
   * database all take input-dependent time.
   */
  matches(presented: string): boolean {
    return timingSafeEqual(this.#digest, digestOf(presented));
  }

  /** Deliberately opaque. A credential must not become readable by being printed. */
  toString(): string {
    return '[ApiCredential]';
  }
}

const GENERATE_HINT = `Generate a key with "openssl rand -hex 32" and set ${API_KEY_VARIABLE} to it.`;

/** Where the key was looked for, as a sentence fragment. */
const lookedIn = (environment: EnvironmentSnapshot): string =>
  environment.envFile === undefined
    ? 'the environment'
    : `the environment or in "${environment.envFile}"`;

/** The next step when the key is missing: the clients' variable was set instead, or make one. */
const missingKeyHint = (environment: EnvironmentSnapshot): string => {
  const clientSource = environment.sourceOf(CLIENT_API_KEY_VARIABLE);
  if (clientSource === 'process') {
    return `${CLIENT_API_KEY_VARIABLE} is set in the environment, but only clients read it. Set ${API_KEY_VARIABLE} instead.`;
  }
  if (clientSource === 'file') {
    return `"${environment.envFile}" sets ${CLIENT_API_KEY_VARIABLE}, which only clients read. Rename it to ${API_KEY_VARIABLE}.`;
  }
  return environment.envFile === undefined
    ? GENERATE_HINT
    : `Generate a key with "openssl rand -hex 32" and add ${API_KEY_VARIABLE}=<key> to "${environment.envFile}".`;
};

/**
 * Resolve the credential from the environment, or fail closed.
 *
 * This runs before any database or listener is acquired, so a missing or unusable key costs nothing
 * and leaves nothing to unwind. There is no fallback, no generated default, and no development
 * exception: a server with no configured key does not start. The policy itself lives in `fromKey`,
 * which is the only constructor, so it holds for a programmatic caller too.
 *
 * An empty value in the process environment wins over `.env` (see `env.ts`), and the message says so,
 * because "not set" would point the operator at the file they already filled in.
 */
export const resolveCredential = (environment: EnvironmentSnapshot): ApiCredential => {
  const key = environment.get(API_KEY_VARIABLE);
  const source = environment.sourceOf(API_KEY_VARIABLE);

  if (key === undefined) {
    configurationFailure(
      'api_key_missing',
      `${API_KEY_VARIABLE} is not set in ${lookedIn(environment)}. Raphael will not start without a key.`,
      { hint: missingKeyHint(environment) },
    );
  }
  if (key === '' && source === 'process') {
    configurationFailure(
      'api_key_missing',
      environment.envFile === undefined
        ? `${API_KEY_VARIABLE} is set to an empty value in the environment.`
        : `${API_KEY_VARIABLE} is set to an empty value in the environment, which overrides "${environment.envFile}".`,
      { hint: `Unset it with "unset ${API_KEY_VARIABLE}", or give it a value.` },
    );
  }

  return ApiCredential.fromKey(
    key,
    source === 'file'
      ? `${API_KEY_VARIABLE} in "${environment.envFile}"`
      : `${API_KEY_VARIABLE} in the environment`,
  );
};

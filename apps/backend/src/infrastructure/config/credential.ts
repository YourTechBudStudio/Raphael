import { createHash, timingSafeEqual } from 'node:crypto';

import {
  API_KEY_MIN_LENGTH,
  inspectApiKey,
  type ApiKeyRejectionReason,
} from '@raphael/contracts/connection';

import { API_KEY_VARIABLE, type EnvironmentSnapshot } from './env.ts';
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

/**
 * Server-side wording for a shared rejection.
 *
 * The policy itself - the length floor and the visible-ASCII range - lives in the contracts, because
 * the login command and the mobile setup screen have to apply exactly the same rule and a second copy
 * of a credential check is a drift hazard. What stays here is the part that is genuinely the server's:
 * which configuration reason an operator sees, and guidance phrased for someone editing an
 * environment variable rather than someone typing at a prompt.
 *
 * The reason vocabulary is exhaustive, so a value added to it upstream fails to compile here rather
 * than silently acquiring a default message.
 */
const explainRejection = (
  reason: ApiKeyRejectionReason,
  source: string,
): { readonly code: 'api_key_missing' | 'api_key_unusable'; readonly message: string } => {
  switch (reason) {
    case 'empty':
      return {
        code: 'api_key_missing',
        message: `${source} is empty. Raphael will not start without one.`,
      };
    case 'unusable_characters':
      return {
        code: 'api_key_unusable',
        message:
          `${source} contains a character that cannot travel in an HTTP header: keys must be visible ASCII, ` +
          `with no spaces, control characters, or non-ASCII characters. A non-ASCII key would let the server ` +
          `start and then fail every client, because headers carry bytes rather than text. Raphael will not trim ` +
          `or re-encode a credential. If the value came from a .env file, check that it is quoted and has no ` +
          `trailing spaces; otherwise generate a new key with "openssl rand -hex 32".`,
      };
    case 'too_short':
      return {
        code: 'api_key_unusable',
        message:
          `${source} is shorter than the ${API_KEY_MIN_LENGTH}-character minimum. ` +
          `Length is not strength - ${API_KEY_MIN_LENGTH} repeated characters would pass this check and still be a ` +
          `weak key - so generate a random one with "openssl rand -hex 32".`,
      };
  }
};

export class ApiCredential {
  readonly #digest: Buffer;

  private constructor(digest: Buffer) {
    this.#digest = digest;
  }

  /**
   * The only way to build a credential, and therefore the only place the key policy lives.
   *
   * It enforces the policy rather than trusting a caller to have done so. `serve` is an importable
   * boundary, so "the loader checks it" would only be true of keys that came through the loader - a
   * programmatic caller could otherwise hand the server a one-character key and the 32-character
   * minimum would be a rule that applied to configuration files rather than to this server.
   *
   * `source` names where the key came from, so an operator reading the failure knows what to edit.
   */
  static fromKey(key: string, source = 'The API key'): ApiCredential {
    const rejection = inspectApiKey(key);
    if (rejection !== undefined) {
      const { code, message } = explainRejection(rejection.reason, source);
      configurationFailure(code, message);
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

/**
 * Resolve the credential from the environment, or fail closed.
 *
 * This runs before any database or listener is acquired, so a missing or unusable key costs nothing
 * and leaves nothing to unwind. There is no fallback, no generated default, and no development
 * exception: a server with no configured key does not start. The policy itself lives in `fromKey`,
 * which is the only constructor, so it holds for a programmatic caller too.
 */
export const resolveCredential = (environment: EnvironmentSnapshot): ApiCredential => {
  const key = environment.get(API_KEY_VARIABLE);

  if (key === undefined || key.length === 0) {
    configurationFailure(
      'api_key_missing',
      `${API_KEY_VARIABLE} is not set. Raphael's API requires a key and will not start without one. ` +
        `Generate one with "openssl rand -hex 32" and set ${API_KEY_VARIABLE} in your environment or in a .env file ` +
        `beside the command you run.`,
    );
  }

  return ApiCredential.fromKey(key, API_KEY_VARIABLE);
};

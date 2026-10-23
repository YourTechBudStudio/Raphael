/**
 * The one failure configuration loading can produce.
 *
 * Startup diagnostics are operator-facing and go to a terminal, so `message` is written for a person
 * who has to fix a file. `reason` is machine-readable, which is what lets the CLI in phase 06 decide
 * whether to print setup guidance without parsing prose.
 *
 * Nothing here ever carries a credential. A message may name the *variable* that was missing or the
 * file that could not be read; it never carries a value read from the environment or a `.env` file,
 * and it never echoes a key's length, prefix, or shape.
 */
export type ConfigurationReason =
  | 'config_unreadable'
  | 'config_too_large'
  | 'config_malformed'
  | 'config_unsafe'
  | 'config_invalid'
  | 'env_unreadable'
  | 'env_too_large'
  | 'api_key_missing'
  | 'api_key_unsendable'
  /** A value given as a `server serve` flag. A mistake in the command, not in the configuration. */
  | 'option_invalid';

export class ConfigurationError extends Error {
  readonly reason: ConfigurationReason;
  /** One next step, when the failure has a more specific one than "fix the configuration". */
  readonly hint: string | undefined;
  constructor(
    reason: ConfigurationReason,
    message: string,
    options?: { readonly cause?: unknown; readonly hint?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConfigurationError';
    this.reason = reason;
    this.hint = options?.hint;
  }
}

export const configurationFailure: (
  reason: ConfigurationReason,
  message: string,
  options?: { readonly cause?: unknown; readonly hint?: string },
) => never = (reason, message, options) => {
  throw new ConfigurationError(reason, message, options);
};

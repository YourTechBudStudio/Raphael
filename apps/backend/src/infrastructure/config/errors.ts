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
  | 'api_key_missing';

export class ConfigurationError extends Error {
  readonly reason: ConfigurationReason;
  constructor(reason: ConfigurationReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigurationError';
    this.reason = reason;
  }
}

export const configurationFailure: (
  reason: ConfigurationReason,
  message: string,
  options?: { cause?: unknown },
) => never = (reason, message, options) => {
  throw new ConfigurationError(reason, message, options);
};

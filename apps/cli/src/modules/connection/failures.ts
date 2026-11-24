/**
 * How a connection that cannot be set up reads: one next step per reason.
 *
 * Keyed by the reason unions, so a new reason without a hint fails the typecheck. A failure that has
 * a more specific step of its own - the exact `chmod` to run - carries it and that wins.
 */

import { EXIT_NOT_CONFIGURED } from '../../shared/exit.ts';
import type { Failure } from '../../shared/failure.ts';
import { forTerminal } from '../../shared/output.ts';
import {
  CLIENT_API_KEY_VARIABLE as API_KEY_VARIABLE,
  CLIENT_ENDPOINT_VARIABLE as ENDPOINT_VARIABLE,
  SERVER_API_KEY_VARIABLE,
  TIMEOUT_VARIABLE,
} from '../../shared/variables.ts';
import { ConfigError, type ConfigReason } from './config.ts';
import { ConnectionError, type ConnectionReason } from './remote.ts';

const USE_ENVIRONMENT = `set ${ENDPOINT_VARIABLE} and ${API_KEY_VARIABLE} in the environment`;

const CONFIG_HINTS: Readonly<Record<ConfigReason, string>> = {
  unsupported_platform: `On this platform, ${USE_ENVIRONMENT} instead.`,
  // Not the environment pair: it does not give login or logout a place for the saved login.
  no_home: 'Set HOME to your home directory, or set XDG_CONFIG_HOME.',
  relative_xdg_config_home:
    'Set XDG_CONFIG_HOME to an absolute path, such as $HOME/.config, or unset it to use ~/.config.',
  relative_home: `Set HOME to your home directory's absolute path, or ${USE_ENVIRONMENT}.`,
  directory_unusable: `Fix the permissions on that directory, or ${USE_ENVIRONMENT} instead.`,
  directory_uncreatable: `Check that you can create that directory, or ${USE_ENVIRONMENT} instead.`,
  file_unusable: 'Run "raphael login" again to replace it.',
  file_unreadable: 'Check the permissions on that file, or run "raphael login" again.',
  file_too_large: 'Run "raphael login" again to replace it.',
  file_malformed: 'Run "raphael login" again to replace it.',
  not_configured: `Run "raphael login", or set ${ENDPOINT_VARIABLE} and ${API_KEY_VARIABLE}.`,
  write_failed: 'Check that you can write to that directory, then run "raphael login" again.',
};

const CONNECTION_HINTS: Readonly<Record<ConnectionReason, string>> = {
  incomplete_environment: `Set both ${ENDPOINT_VARIABLE} and ${API_KEY_VARIABLE}, or neither.`,
  malformed: 'Give the full address, such as http://127.0.0.1:3000.',
  unsupported_scheme: 'Give an address that starts with http:// or https://.',
  credentials_in_url: 'Remove the user name and password from the address.',
  query_not_allowed: 'Remove the part of the address after "?".',
  fragment_not_allowed: 'Remove the part of the address after "#".',
  api_key_missing: `Run "raphael login" again, or ${USE_ENVIRONMENT}.`,
  api_key_unsendable: `Use the server's ${SERVER_API_KEY_VARIABLE} exactly.`,
  timeout_out_of_range: `Set ${TIMEOUT_VARIABLE} to a whole number of seconds, or unset it.`,
};

/** A connection that could not be set up: nothing was sent. */
export const connectionFailure = (error: ConfigError | ConnectionError): Failure => ({
  code: error.reason,
  exitCode: EXIT_NOT_CONFIGURED,
  message: forTerminal(error.message),
  hint:
    error.hint ??
    (error instanceof ConfigError
      ? CONFIG_HINTS[error.reason]
      : CONNECTION_HINTS[error.reason as ConnectionReason]),
  state: 'not_sent',
  fromServer: false,
});

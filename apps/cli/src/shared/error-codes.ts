/**
 * Every code a failure can carry in `error.code`, defined once.
 *
 * A failure the server answered keeps the server's code: one of the contract's `API_ERROR_CODES`,
 * exiting as `SERVER_CODE_EXIT` says. Every other failure carries one of this CLI's own codes,
 * listed in `CLI_ERROR_CODES` with how it exits and what it means. `Failure.code` is typed from both,
 * so a code nobody documented cannot be emitted, and the reasons the codes come from (`ConfigReason`,
 * `ConnectionReason`, the login address check, the backend's `ConfigurationReason`, serve's startup
 * failures) must each have an entry or the typecheck fails. Help renders the same table.
 *
 * The one exception is a newer server's code that this release does not know. It is passed through
 * as the server sent it, so it is marked as such rather than typed as one of ours.
 */

import { API_ERROR_CODES, type ApiErrorCode } from '@raphael/contracts';

import {
  EXIT_FAILURE,
  EXIT_NOT_CONFIGURED,
  EXIT_RETRYABLE,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_UNKNOWN,
  EXIT_USAGE,
  SERVER_CODE_EXIT,
  categoryOf,
  type ExitCode,
  type FailureCategory,
} from './exit.ts';
import {
  CLIENT_API_KEY_VARIABLE,
  CLIENT_ENDPOINT_VARIABLE,
  TIMEOUT_VARIABLE,
} from './variables.ts';

/** Where a CLI code comes from, which is also how help groups them. */
export type ErrorCodeSource =
  | 'command'
  | 'saved login'
  | 'connection settings'
  | 'connection'
  | 'server serve';

export interface ErrorCodeEntry {
  readonly source: ErrorCodeSource;
  /** Every exit code this code can come with; `meaning` says which applies when. */
  readonly exits: readonly Exclude<ExitCode, 0>[];
  readonly meaning: string;
}

const PAIR = `${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE}`;

/** The table, in the order help lists it. */
export const CLI_ERROR_CODES = {
  usage: {
    source: 'command',
    exits: [EXIT_USAGE],
    meaning:
      'The command as typed was refused before anything was sent: an unknown command or option, a missing or malformed value, or input the rules refuse.',
  },
  cancelled: {
    source: 'command',
    exits: [EXIT_USAGE],
    meaning: 'A login prompt was cancelled; nothing was saved.',
  },
  interrupted: {
    source: 'command',
    exits: [EXIT_SIGINT, EXIT_SIGTERM],
    meaning:
      'SIGINT or SIGTERM stopped the command. After a write was sent, applied is null: read before retrying.',
  },
  invalid_request: {
    source: 'command',
    exits: [EXIT_USAGE],
    meaning: "The request failed the client's own check, so it was not sent.",
  },
  unexpected: {
    source: 'command',
    exits: [EXIT_FAILURE, EXIT_UNKNOWN],
    meaning:
      'A fault in this CLI. Exit 7 when a write had already been sent, otherwise 1. Run it again with RAPHAEL_DEBUG=1 to see where it failed.',
  },
  not_configured: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: `There is no saved login, and ${PAIR} are not set.`,
  },
  unsupported_platform: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: `Saved logins are not supported on this platform; set ${PAIR} instead.`,
  },
  no_home: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning:
      "XDG_CONFIG_HOME is not set, and HOME is empty, or unset on an account with no home directory, so there is no place for a saved login. An unset HOME otherwise falls back to the account's home directory.",
  },
  relative_xdg_config_home: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'XDG_CONFIG_HOME is not an absolute path.',
  },
  relative_home: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'HOME is not an absolute path.',
  },
  directory_unusable: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning:
      'The directory for the saved login, or a directory above it, cannot be inspected, is not a directory, or is not private to you.',
  },
  directory_uncreatable: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The directory for the saved login could not be created.',
  },
  file_unusable: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The saved login file is a link, not a regular file, or readable by other users.',
  },
  file_unreadable: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The saved login file could not be read.',
  },
  file_too_large: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The saved login file is larger than a saved login can be.',
  },
  file_malformed: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The saved login file is not JSON with an endpoint and an API key.',
  },
  write_failed: {
    source: 'saved login',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'login could not save, or logout could not remove, the saved login file.',
  },
  incomplete_environment: {
    source: 'connection settings',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: `Only one of ${PAIR} is set; set both or neither.`,
  },
  malformed: {
    source: 'connection settings',
    exits: [EXIT_USAGE, EXIT_NOT_CONFIGURED],
    meaning: 'The server address is not a URL. Exit 2 for an address typed at login, 5 otherwise.',
  },
  unsupported_scheme: {
    source: 'connection settings',
    exits: [EXIT_USAGE, EXIT_NOT_CONFIGURED],
    meaning:
      'The server address does not start with http:// or https://. Exit 2 for an address typed at login, 5 otherwise.',
  },
  credentials_in_url: {
    source: 'connection settings',
    exits: [EXIT_USAGE, EXIT_NOT_CONFIGURED],
    meaning:
      'The server address carries a user name or password. Exit 2 for an address typed at login, 5 otherwise.',
  },
  query_not_allowed: {
    source: 'connection settings',
    exits: [EXIT_USAGE, EXIT_NOT_CONFIGURED],
    meaning:
      'The server address has a part after "?". Exit 2 for an address typed at login, 5 otherwise.',
  },
  fragment_not_allowed: {
    source: 'connection settings',
    exits: [EXIT_USAGE, EXIT_NOT_CONFIGURED],
    meaning:
      'The server address has a part after "#". Exit 2 for an address typed at login, 5 otherwise.',
  },
  api_key_missing: {
    source: 'connection settings',
    exits: [EXIT_USAGE, EXIT_NOT_CONFIGURED],
    meaning:
      'No API key: none was given at login (exit 2), the saved login has none, or the server has none configured (exit 5).',
  },
  api_key_unsendable: {
    source: 'connection settings',
    exits: [EXIT_USAGE, EXIT_NOT_CONFIGURED],
    meaning:
      'The API key cannot be sent in a request header. Exit 2 for a key given at login, 5 for a saved, environment or server key.',
  },
  timeout_out_of_range: {
    source: 'connection settings',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: `${TIMEOUT_VARIABLE} is not a whole number of seconds in the allowed range.`,
  },
  unreachable: {
    source: 'connection',
    exits: [EXIT_NOT_CONFIGURED, EXIT_RETRYABLE],
    meaning:
      "Could not connect to the server, so nothing was sent. Exit 5 when the secure connection could not be set up or the server's certificate is not trusted, which retrying cannot change; otherwise 6.",
  },
  blocked_port: {
    source: 'connection',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The address uses a port that requests are never sent to, so nothing was sent.',
  },
  not_http: {
    source: 'connection',
    exits: [EXIT_NOT_CONFIGURED, EXIT_UNKNOWN],
    meaning:
      'Something answered at the address, but not in HTTP. Exit 7 when a write may have been sent, otherwise 5.',
  },
  connection_lost: {
    source: 'connection',
    exits: [EXIT_NOT_CONFIGURED, EXIT_RETRYABLE, EXIT_UNKNOWN],
    meaning:
      'The connection failed after the request was sent. Exit 7 for a write, 5 when the secure connection failed, otherwise 6.',
  },
  timeout: {
    source: 'connection',
    exits: [EXIT_RETRYABLE, EXIT_UNKNOWN],
    meaning: `No answer within the timeout (${TIMEOUT_VARIABLE}). Exit 7 when a write may have been sent, otherwise 6.`,
  },
  incompatible_protocol: {
    source: 'connection',
    exits: [EXIT_NOT_CONFIGURED, EXIT_UNKNOWN],
    meaning:
      'The server speaks another protocol version; details names both sides. Exit 7 when a write may have been applied, otherwise 5; after a write answered with a redirect or a bare 3xx or 4xx status, applied is null with exit 5.',
  },
  not_raphael: {
    source: 'connection',
    exits: [EXIT_NOT_CONFIGURED, EXIT_UNKNOWN],
    meaning:
      'The address does not answer as a Raphael server. Exit 7 when a write may have been applied, otherwise 5; after a write answered with a redirect or a bare 3xx or 4xx status, applied is null with exit 5.',
  },
  bad_response: {
    source: 'connection',
    exits: [EXIT_FAILURE, EXIT_NOT_CONFIGURED, EXIT_UNKNOWN],
    meaning:
      'The answer could not be read, or was a redirect or a status the command does not expect. Exit 7 for an unreadable success after a write, 1 for one on a read, otherwise 5; after a write, applied is null, because something in front of the server may have forwarded it.',
  },
  http_status: {
    source: 'connection',
    exits: [EXIT_FAILURE, EXIT_NOT_CONFIGURED, EXIT_UNKNOWN],
    meaning:
      'The answer was a bare HTTP status with no Raphael error, often from a proxy. For a 5xx status: exit 7 after a write, 1 on a read. Otherwise 5; after a write, applied is null, because a proxy may have forwarded it.',
  },
  port_in_use: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The port is already in use.',
  },
  listen_denied: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'This user may not listen on that port.',
  },
  host_unavailable: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The host is not an address on this machine.',
  },
  listen_failed: {
    source: 'server serve',
    exits: [EXIT_FAILURE],
    meaning: 'The server could not listen for another reason the error names.',
  },
  database_in_use: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'Another process, such as another Raphael server, is using the database.',
  },
  database_newer: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The database was migrated by a newer or different Raphael release.',
  },
  database_unusable: {
    source: 'server serve',
    exits: [EXIT_FAILURE, EXIT_NOT_CONFIGURED],
    meaning:
      'The database could not be opened or created. Exit 1 when the cause is not a setting, such as a broken installation, otherwise 5.',
  },
  start_failed: {
    source: 'server serve',
    exits: [EXIT_FAILURE],
    meaning: 'The server could not start for a reason of its own.',
  },
  option_invalid: {
    source: 'server serve',
    exits: [EXIT_USAGE],
    meaning: 'A server serve flag has a value the server cannot use.',
  },
  config_unreadable: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The server configuration file could not be read.',
  },
  config_too_large: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The server configuration file is too large.',
  },
  config_malformed: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The server configuration file is empty or not valid YAML.',
  },
  config_unsafe: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning:
      'The server configuration file uses YAML that is not read literally: an anchor, an alias, a tag, or more than one document.',
  },
  config_invalid: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'A server setting has a value the server cannot use.',
  },
  env_unreadable: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The .env file the server reads could not be read.',
  },
  env_too_large: {
    source: 'server serve',
    exits: [EXIT_NOT_CONFIGURED],
    meaning: 'The .env file the server reads is too large.',
  },
} as const satisfies Readonly<Record<string, ErrorCodeEntry>>;

export type CliErrorCode = keyof typeof CLI_ERROR_CODES;

/**
 * What each server code means, one line each, as help lists them beside this CLI's own. Keyed by
 * the contract's catalog, so a code added there without a meaning here fails the typecheck.
 */
export const SERVER_CODE_MEANINGS: Readonly<Record<ApiErrorCode, string>> = {
  invalid_input:
    'The server refused a value in the request because a rule refuses it, or could not read the request at all.',
  unauthorized: 'The server did not accept the API key.',
  node_not_found: 'Nothing exists at the path or id given, or at the parent or destination named.',
  route_not_found:
    'The server has no such operation: it runs another version of Raphael, or is not Raphael.',
  method_not_allowed:
    'The server does not take the operation as it was sent: it runs another version of Raphael, or is not Raphael.',
  slug_conflict: 'An item already holds that slug in that place, possibly an archived one.',
  revision_conflict: 'The item changed after the revision given was read.',
  node_archived:
    'The item, or a container above it, is archived, so it cannot be changed that way.',
  payload_too_large: 'The request is larger than the server accepts.',
  unsupported_media_type: "The server cannot read the request's content type, charset or encoding.",
  invalid_parent:
    'The item cannot go there: that parent cannot hold its type, or the move would put it inside itself.',
  unsupported_content:
    'The body has an element, style, attribute or link that the server does not store.',
  storage_busy: "The server's database was busy and nothing was applied; trying again may work.",
  internal_error:
    'The server failed for a reason of its own; after a write, the change may or may not have been applied.',
};

declare const newerServerCode: unique symbol;

/** A code a newer server sent that this release does not know, passed through as it came. */
export type NewerServerCode = string & { readonly [newerServerCode]: true };

/** Every value `error.code` can take. */
export type ErrorCode = ApiErrorCode | CliErrorCode | NewerServerCode;

const isApiErrorCode = (code: string): code is ApiErrorCode =>
  (API_ERROR_CODES as readonly string[]).includes(code);

/** A server's code, as itself when this release knows it, and marked as a newer one otherwise. */
export const serverCode = (code: string): ApiErrorCode | NewerServerCode =>
  isApiErrorCode(code) ? code : (code as NewerServerCode);

/** The words for each exit code a code can come with, as `category` carries them. */
const categoriesOf = (exits: readonly Exclude<ExitCode, 0>[]): readonly FailureCategory[] => [
  ...new Set(exits.map(categoryOf)),
];

/** Every code with how it exits, as `help --json` carries them: the server's first, then ours. */
export const errorCodeList = (): readonly {
  readonly code: string;
  readonly source: ErrorCodeSource | 'server';
  readonly exitCodes: readonly Exclude<ExitCode, 0>[];
  readonly categories: readonly FailureCategory[];
  readonly meaning: string;
}[] => [
  ...API_ERROR_CODES.map((code) => {
    const exit = SERVER_CODE_EXIT[code];
    const exitCodes: readonly Exclude<ExitCode, 0>[] =
      exit === 'server_fault' ? [EXIT_FAILURE, EXIT_UNKNOWN] : [exit as Exclude<ExitCode, 0>];
    return {
      code,
      source: 'server' as const,
      exitCodes,
      categories: categoriesOf(exitCodes),
      meaning: SERVER_CODE_MEANINGS[code],
    };
  }),
  ...Object.entries(CLI_ERROR_CODES).map(([code, entry]: [string, ErrorCodeEntry]) => ({
    code,
    source: entry.source,
    exitCodes: entry.exits,
    categories: categoriesOf(entry.exits),
    meaning: entry.meaning,
  })),
];

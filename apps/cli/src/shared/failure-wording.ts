/**
 * The CLI's own sentence for every client failure and every server code.
 *
 * The server's messages are generic on purpose: it does not know what the caller typed and never
 * echoes what it was sent. This CLI does know, so it words each failure itself, naming the path, the
 * id, or the flag the caller used, and the server's sentence is kept only in JSON as `serverMessage`.
 *
 * Rules are described from the contract's constants - containment from `PARENTAGE`, type names from
 * the type and kind lists, content limits from the content package - so a rule change is a data
 * change here, not a copy edit.
 */

import type { ClientFailure } from '@raphael/client';
import {
  CHECKED_ATTRIBUTES,
  CONTENT_FAILURE_REASONS,
  SUPPORTED_HEADING_LEVELS,
  SUPPORTED_MARKS,
  SUPPORTED_NODES,
  type ContentFailure,
  type ContentFailureReason,
} from '@raphael/content';
import {
  API_ERROR_CODES,
  INVALID_INPUT_REASONS,
  INVALID_PARENT_REASONS,
  NODE_ARCHIVED_REASONS,
  SLUG_CONFLICT_REASONS,
  type ApiErrorCode,
  type ApiErrorDetails,
  type InvalidInputReason,
  type InvalidParentReason,
} from '@raphael/contracts';
import {
  CONTAINER_TYPES,
  NODE_TYPES,
  PARENTAGE,
  RESOURCE_KINDS,
  ROOT_PATH,
  asSentence,
  describeInvalidInput,
  type InvalidRequestIssue,
  type NodeType,
} from '@raphael/contracts/nodes';

import { version } from '../distribution.ts';
import type { ConnectionInfo } from './command.ts';
import { serverCode, type CliErrorCode, type ErrorCode } from './error-codes.ts';
import type { ChangeState, RequestContext, Subject } from './failure.ts';
import type { InterruptSignal } from './interrupt.ts';
import { forTerminal } from './output.ts';
import { SERVE_DEFAULTS } from './serve-defaults.ts';
import { describeProtocolMismatch, serverIsAhead, type Diagnosis } from './server-check.ts';
import {
  CLIENT_API_KEY_VARIABLE,
  CLIENT_ENDPOINT_VARIABLE,
  SERVER_API_KEY_VARIABLE,
} from './variables.ts';

export interface Worded {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint: string;
  readonly field?: string;
  readonly target?: Subject;
}

export interface WordingInput {
  readonly context: RequestContext;
  readonly endpoint: string | undefined;
  /** Where the endpoint came from; absent for an address typed at `login`. */
  readonly connection?: ConnectionInfo | undefined;
  /** What one verification said about an answer that could not be read. */
  readonly diagnosis?: Diagnosis | undefined;
  readonly command: string | null;
  readonly state: ChangeState;
  readonly signal: InterruptSignal | undefined;
}

// ---- Words -------------------------------------------------------------------------------------

/** A type as people say it. A resource is named by its kinds. */
const noun = (type: string, plural = false): string => {
  const words = type === 'resource' ? [...RESOURCE_KINDS] : [type];
  return words.map((word) => (plural ? `${word}s` : word)).join(' or ');
};

const withArticle = (word: string): string => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const listWith = (conjunction: 'and' | 'or', items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1) ?? ''}`;

const isNodeType = (value: string | undefined): value is NodeType =>
  (NODE_TYPES as readonly (string | undefined)[]).includes(value);

/** Where a type may live, from `PARENTAGE`: "at the top level or inside an area". */
const placesFor = (child: NodeType): string => {
  const parents = (Object.keys(PARENTAGE) as ('root' | NodeType)[]).filter((parent) =>
    PARENTAGE[parent].includes(child),
  );
  const places: string[] = [];
  if (parents.includes('root')) places.push('at the top level');
  const containers = parents.filter((parent): parent is NodeType => parent !== 'root');
  if (containers.length > 0) {
    places.push(
      `inside ${listWith(
        'or',
        containers.map((type) => withArticle(noun(type))),
      )}`,
    );
  }
  return listWith('or', places);
};

/** The containment rule that refused a parent, from `PARENTAGE`. */
const containmentRule = (parent: string | undefined, child: string | undefined): string => {
  if (!isNodeType(child)) return 'That is not a place this item can go.';
  const where = `${capitalized(withArticle(noun(child)))} can go ${placesFor(child)}.`;
  if (parent === 'root') {
    return `Only ${listWith(
      'and',
      PARENTAGE.root.map((type) => noun(type, true)),
    )} can be at the top level. ${where}`;
  }
  if (!isNodeType(parent)) return where;
  const holds =
    PARENTAGE[parent].length === 0
      ? `${capitalized(withArticle(noun(parent)))} cannot contain anything.`
      : `${capitalized(withArticle(noun(parent)))} cannot contain ${withArticle(noun(child))}.`;
  return `${holds} ${where}`;
};

/** A subject as it appears in a sentence. */
const label = (subject: Subject): string =>
  'path' in subject ? forTerminal(subject.path) : `--id ${subject.id}`;

/** An argument as it would be typed into a shell, quoted only when it has to be. */
export const shellArg = (value: string): string =>
  /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** A subject as command arguments. */
const args = (subject: Subject): string =>
  'path' in subject ? shellArg(forTerminal(subject.path)) : `--id ${subject.id}`;

const parentPath = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? ROOT_PATH : path.slice(0, index);
};

const run = (command: string): string => `Run "${command}"`;

const helpHint = (command: string | null): string =>
  command === null
    ? `${run('raphael help')} to see the commands.`
    : `${run(`raphael ${command} --help`)} for usage.`;

const versionHint =
  'Check that this CLI and the server are the same version with "raphael status".';

/** The next step after a write whose outcome is unknown: look before sending it again. */
const checkHint = (context: RequestContext): string => {
  const check =
    context.check ??
    (context.subject === undefined ? undefined : `raphael get ${args(context.subject)}`);
  if (check === undefined) return 'Check whether it was applied before sending it again.';
  const steps =
    context.checkThen === undefined ? run(check) : `${run(check)}, then "${context.checkThen}",`;
  const otherwise =
    context.checkOtherwise === undefined
      ? ''
      : ` If ${context.checkOtherwise.when}, run "${context.checkOtherwise.check}" instead.`;
  return `${steps} to check whether it was applied before sending it again.${otherwise}`;
};

const listHint = (path: string, what = 'to see what is there'): string =>
  `${run(`raphael list ${shellArg(forTerminal(path))}`)} ${what}.`;

const findIdHint = `${run('raphael list / -r')} to find the right id.`;

/**
 * Where to look after nothing was found at a path. The server says only that the path is missing,
 * not how much of it is, so a parent is named only when it is the root, which always exists: listing
 * a parent that is missing too would only fail again.
 */
const missingPathHint = (path: string): string =>
  parentPath(path) === ROOT_PATH
    ? listHint(ROOT_PATH)
    : `${run(`raphael list ${ROOT_PATH} -r`)} to see which paths exist.`;

/**
 * What the caller typed for a request field, for a sentence: the value itself where a placeholder
 * would stand for it (`/personal/long` rather than `<destination>`), else the flag.
 */
const typedFor = (context: RequestContext, field: string | undefined): string | undefined => {
  if (field === 'destination' && context.destination !== undefined) {
    return forTerminal(context.destination);
  }
  const flag = flagFor(context, field);
  if (flag?.startsWith('<') === true && context.subject !== undefined)
    return label(context.subject);
  return flag;
};

/** The flag a request field was typed as. */
const flagFor = (context: RequestContext, field: string | undefined): string | undefined => {
  if (field === undefined) return undefined;
  const given = context.flags?.[field];
  if (given !== undefined) return given;
  return `--${field}`;
};

// ---- Client failures ---------------------------------------------------------------------------

/** Where an endpoint came from, as a parenthetical. */
const sourceOf = (connection: ConnectionInfo | undefined): string =>
  connection === undefined
    ? ''
    : connection.source === 'environment'
      ? ` (from ${CLIENT_ENDPOINT_VARIABLE})`
      : ` (from the saved login at ${forTerminal(connection.configFile ?? '')})`;

/** The server, by address and source: "the server at http://… (from RAPHAEL_ENDPOINT)". */
const where = (endpoint: string | undefined, connection?: ConnectionInfo): string =>
  endpoint === undefined
    ? 'the server'
    : `the server at ${forTerminal(endpoint)}${sourceOf(connection)}`;

/** How to point at a different address, for the source the address came from. */
const fixAddress = (connection: ConnectionInfo | undefined): string =>
  connection === undefined
    ? 'give the right address'
    : connection.source === 'environment'
      ? `fix ${CLIENT_ENDPOINT_VARIABLE}`
      : 'run "raphael login" with the right address';

/** The next step that points this CLI at `address`, for the source the current one came from. */
const useAddress = (connection: ConnectionInfo | undefined, address: string): string =>
  connection === undefined
    ? `Run "raphael login ${address}" instead.`
    : connection.source === 'environment'
      ? `Set ${CLIENT_ENDPOINT_VARIABLE} to ${address}.`
      : `Run "raphael login ${address}".`;

/** The root of an address that carries a path, which is the likelier server address. */
const rootOf = (endpoint: string | undefined): string | undefined => {
  if (endpoint === undefined) return undefined;
  try {
    const url = new URL(endpoint);
    return url.pathname === '/' || url.pathname === '' ? undefined : forTerminal(url.origin);
  } catch {
    return undefined;
  }
};

const originOf = (endpoint: string | undefined): string | undefined => {
  try {
    return endpoint === undefined ? undefined : new URL(endpoint).origin;
  } catch {
    return undefined;
  }
};

const EXAMPLE_ADDRESS = `http://${SERVE_DEFAULTS.host}:${SERVE_DEFAULTS.port}`;

/** How to correct an address that reached something other than an HTTP server. */
const schemeFix = (connection: ConnectionInfo | undefined): string =>
  connection === undefined
    ? 'give the right address and scheme (http or https)'
    : connection.source === 'environment'
      ? `fix the address or its scheme (http or https) in ${CLIENT_ENDPOINT_VARIABLE}`
      : 'run "raphael login" with the right address and scheme (http or https)';

/**
 * The next step when the address does not lead to the Raphael API itself: its root, when the address
 * has a path, or else the address of a server started with the defaults, as an example.
 */
const addressHint = (connection: ConnectionInfo | undefined, endpoint?: string): string => {
  const root = rootOf(endpoint);
  if (root !== undefined) return useAddress(connection, root);
  return connection === undefined
    ? `Give the server's root address, such as ${EXAMPLE_ADDRESS}, and run "raphael login" again.`
    : connection.source === 'environment'
      ? `Point ${CLIENT_ENDPOINT_VARIABLE} at the server's root address, such as ${EXAMPLE_ADDRESS}.`
      : `Run "raphael login" with the server's root address, such as ${EXAMPLE_ADDRESS}.`;
};

const NETWORK_CAUSES: Readonly<Record<NonNullable<ClientFailure['cause']>, string>> = {
  refused: 'nothing is listening there (connection refused)',
  dns: 'the host name could not be resolved',
  tls: 'the secure connection could not be set up',
  certificate: "the server's certificate is not trusted on this machine",
  reset: 'the connection was reset',
  unreachable: 'the network has no route to it',
  blocked_port: 'its port is one that HTTP clients refuse to use',
  not_http: 'it does not speak HTTP',
};

/** The CLI's code for a connection that was never opened, by what the system said. */
const UNOPENED_CODES: Readonly<Partial<Record<NonNullable<ClientFailure['cause']>, CliErrorCode>>> =
  {
    blocked_port: 'blocked_port',
    not_http: 'not_http',
  };

/** The port a URL names, its scheme's default when it names none. */
const portOf = (endpoint: string | undefined): string | undefined => {
  if (endpoint === undefined) return undefined;
  try {
    const url = new URL(endpoint);
    return url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
  } catch {
    return undefined;
  }
};

/** The next step for a connection that was never opened, by what the system said. */
const unreachableHint = (
  cause: ClientFailure['cause'],
  connection: ConnectionInfo | undefined,
  endpoint?: string,
): string => {
  switch (cause) {
    case 'refused': {
      // A server on this machine that is not on the default port is started on the one asked for.
      const port = portOf(endpoint);
      const local =
        endpoint !== undefined &&
        /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/u.test(endpoint);
      const serve =
        local && port !== undefined && port !== String(SERVE_DEFAULTS.port)
          ? `raphael server serve --port ${port}`
          : 'raphael server serve';
      return `Start the server with "${serve}", or ${fixAddress(connection)}.`;
    }
    case 'dns':
      return `Check the host name, or ${fixAddress(connection)}.`;
    case 'tls':
      return `If the server speaks http rather than https, ${fixAddress(connection)}.`;
    case 'certificate':
      return `Give the server a certificate this machine trusts, or set NODE_EXTRA_CA_CERTS to the file of the certificate that issued it.`;
    case 'blocked_port':
      return `Serve Raphael on another port, then ${fixAddress(connection)}.`;
    case 'not_http':
      return `${capitalized(schemeFix(connection))}.`;
    default:
      return `Check that the server is running, or ${fixAddress(connection)}.`;
  }
};

/**
 * The next step after a write whose outcome is unknown, when the address itself has to change first:
 * the check would meet the same failure until it does.
 */
const fixThenCheck = (fix: string, context: RequestContext): string => {
  const check = checkHint(context);
  return `${capitalized(fix)}. Then ${check.charAt(0).toLowerCase()}${check.slice(1)}`;
};

/**
 * What verification found, as the sentence that replaces "could not read": the shared mismatch
 * sentence with this CLI's release added, or that the endpoint is not a Raphael server.
 */
const diagnosed = (
  diagnosis: Diagnosis,
  endpoint: string | undefined,
  connection: ConnectionInfo | undefined,
): {
  readonly code: CliErrorCode;
  readonly message: string;
  readonly hint: string;
  /** What has to change before an uncertain write can be checked. */
  readonly fix: string;
} =>
  diagnosis.kind === 'incompatible'
    ? {
        code: 'incompatible_protocol',
        fix: serverIsAhead(diagnosis.protocolVersion)
          ? 'update raphael on this machine'
          : 'update the server',
        message:
          `Cannot use ${where(endpoint, connection)}. ` +
          `${forTerminal(describeProtocolMismatch(diagnosis.protocolVersion))} This CLI is ` +
          `release ${version()}; the server's release is ` +
          `${diagnosis.raphaelVersion === undefined ? 'unknown' : forTerminal(diagnosis.raphaelVersion)}.`,
        hint:
          `${serverIsAhead(diagnosis.protocolVersion) ? 'Update raphael on this machine' : 'Update the server'}, then ` +
          // An address typed at login is not saved yet, so status would check something else.
          (connection === undefined
            ? `run "raphael login${endpoint === undefined ? '' : ` ${forTerminal(endpoint)}`}" again.`
            : 'check with "raphael status".'),
      }
    : {
        code: 'not_raphael',
        message: `${capitalized(where(endpoint, connection))} does not look like a Raphael server.`,
        hint: addressHint(connection, endpoint),
        fix: fixAddress(connection),
      };

/** Word one client failure. */
export const clientFailureWording = (failure: ClientFailure, input: WordingInput): Worded => {
  const { context, endpoint, command, state, connection, diagnosis } = input;
  const server = where(endpoint, connection);
  const afterWrite = state === 'unknown';
  // Once verification has explained an unreadable answer, that explanation is the message.
  const explained =
    diagnosis === undefined
      ? undefined
      : (() => {
          const { fix, ...found } = diagnosed(diagnosis, endpoint, connection);
          return afterWrite ? { ...found, hint: fixThenCheck(fix, context) } : found;
        })();

  switch (failure.kind) {
    case 'invalid_request': {
      const issue = failure.issues?.[0];
      const flag = flagFor(context, issue?.field);
      return {
        code: 'invalid_request',
        message:
          issue === undefined
            ? 'The request is not valid.'
            : INVALID_INPUT_SENTENCES[issue.reason](flag, issue, context),
        hint: helpHint(command),
        ...(flag === undefined ? {} : { field: flag }),
      };
    }
    case 'cancelled':
      return {
        code: 'interrupted',
        message: `Interrupted${input.signal === undefined ? '' : ` by ${input.signal}`}.`,
        hint: afterWrite ? checkHint(context) : 'Run the command again.',
      };
    case 'network':
      if (failure.cause === 'not_http') {
        // Bytes came back, and they were not an HTTP answer: no retry can change that.
        return {
          code: 'not_http',
          message: `${capitalized(server)} does not speak HTTP; check the address and scheme.`,
          hint: afterWrite
            ? fixThenCheck(schemeFix(connection), context)
            : unreachableHint('not_http', connection),
        };
      }
      if (failure.delivery === 'not_sent') {
        const cause = failure.cause === undefined ? undefined : NETWORK_CAUSES[failure.cause];
        return {
          code:
            (failure.cause === undefined ? undefined : UNOPENED_CODES[failure.cause]) ??
            'unreachable',
          message: `Could not connect to ${server}${cause === undefined ? '' : `: ${cause}`}.`,
          hint: unreachableHint(failure.cause, connection, endpoint),
        };
      }
      if (failure.cause === 'tls' || failure.cause === 'certificate') {
        return {
          code: 'connection_lost',
          message: `The secure connection to ${server} failed.`,
          hint: afterWrite ? checkHint(context) : unreachableHint(failure.cause, connection),
        };
      }
      return {
        code: 'connection_lost',
        message: `The connection to ${server} was lost before an answer arrived.`,
        // A TLS server spoken to in plain http closes or resets the connection without a word, which
        // looks the same as any lost connection, so the scheme is named as the other likely cause.
        hint: `${afterWrite ? checkHint(context) : 'Run the command again.'}${
          endpoint?.startsWith('http://') === true
            ? ` If the server speaks https rather than http, ${fixAddress(connection)}.`
            : ''
        }`,
      };
    case 'timeout':
      return {
        code: 'timeout',
        message: `${capitalized(server)} did not answer in time.`,
        hint: afterWrite
          ? checkHint(context)
          : 'Run the command again, or allow longer by setting RAPHAEL_TIMEOUT in seconds.',
      };
    case 'bad_response':
      if (explained !== undefined) return explained;
      if (failure.code === 'incompatible_protocol') {
        return {
          code: 'incompatible_protocol',
          message: `Cannot use ${server}. ${forTerminal(failure.message)}`,
          hint: 'Update this CLI or the server so their versions match.',
        };
      }
      if (failure.status !== undefined && failure.status >= 200 && failure.status < 300) {
        return {
          code: 'bad_response',
          message: `${capitalized(server)} answered in a form this version of the CLI cannot read.`,
          hint: afterWrite ? checkHint(context) : versionHint,
        };
      }
      if (
        failure.status !== undefined &&
        failure.status >= 300 &&
        failure.status < 400 &&
        failure.status !== 304
      ) {
        const target =
          failure.redirectOrigin === undefined ? '' : ` to ${forTerminal(failure.redirectOrigin)}`;
        return {
          code: 'bad_response',
          message: `${capitalized(server)} redirected the request${target}.`,
          hint: afterWrite
            ? // Something in front of the server may have forwarded the write before redirecting.
              fixThenCheck(fixAddress(connection), context)
            : // A redirect within the same server says the path is wrong, not the server.
              failure.redirectOrigin === undefined || failure.redirectOrigin === originOf(endpoint)
              ? addressHint(connection, endpoint)
              : useAddress(connection, forTerminal(failure.redirectOrigin)),
        };
      }
      return {
        code: 'bad_response',
        message: `${capitalized(server)} answered ${failure.status ?? 'without a status'}, which this command does not expect.`,
        hint: afterWrite
          ? fixThenCheck(fixAddress(connection), context)
          : addressHint(connection, endpoint),
      };
    case 'http':
      // A route the server lacks already says the address is wrong; verification refines that only
      // when it found a protocol mismatch.
      if (
        explained !== undefined &&
        (failure.code === undefined ||
          (diagnosis?.kind === 'incompatible' &&
            (failure.code === 'route_not_found' ||
              failure.code === 'method_not_allowed' ||
              !(API_ERROR_CODES as readonly string[]).includes(failure.code))))
      ) {
        return explained;
      }
      if (failure.code === undefined) {
        // A bare status, and verification did not say the endpoint is wrong: most often a proxy or
        // gateway in front of the server, so the address may well be right and is not blamed.
        return {
          code: 'http_status',
          message: `${capitalized(server)} answered ${failure.status ?? ''} without a Raphael error.`,
          hint: afterWrite
            ? (failure.status ?? 0) >= 500
              ? checkHint(context)
              : // Not the server's own refusal: a proxy may have forwarded the write first, and the
                // check would meet the same proxy.
                fixThenCheck(PROXY_CHECK, context)
            : statusHint(failure.status ?? 0),
        };
      }
      if (!(API_ERROR_CODES as readonly string[]).includes(failure.code)) {
        // A newer server's code: name it, and keep the server's sentence for JSON only.
        return {
          code: serverCode(failure.code),
          // A server-side fault is not a refusal: after a write it may have been applied.
          message: `${capitalized(server)} ${(failure.status ?? 0) >= 500 ? 'answered' : 'refused the request'} with a code this CLI does not know (${forTerminal(failure.code)}).`,
          hint: afterWrite ? checkHint(context) : versionHint,
        };
      }
      return serverCodeWording(failure.code as ApiErrorCode, failure.details ?? {}, input);
  }
};

const PROXY_CHECK = 'check any proxy in front of the server';

/** The next step for a status that came with no Raphael error, by what that status means. */
const statusHint = (status: number): string => {
  if (status === 408 || status === 429) return 'Wait a moment, then run the command again.';
  if (status === 413) {
    return "The request is larger than the server or a proxy in front of it accepts; send less, or raise the proxy's limit.";
  }
  if (status === 401 || status === 403 || status === 407) {
    return 'Check that any proxy in front of the server lets this machine through.';
  }
  if (status >= 500) {
    return "Run the command again; if it keeps failing, check the server's log and any proxy in front of it.";
  }
  return 'Check any proxy in front of the server, then run the command again.';
};

// ---- Server codes ------------------------------------------------------------------------------

type CodeWording = (details: ApiErrorDetails, input: WordingInput) => Worded;

/** The neutral end of a refusal whose reason a newer server added: nothing is guessed about it. */
const UNKNOWN_REASON = 'the server gave a reason this CLI does not know.';

const isReason = <Reason extends string>(
  reasons: readonly Reason[],
  value: string,
): value is Reason => (reasons as readonly string[]).includes(value);

const EARLIER_ATTEMPT = 'it may be this same item, created by an earlier attempt';

/** A slug already held, where the server said whether at the top level or among siblings. */
const takenSlug = (details: ApiErrorDetails, { context }: WordingInput): Worded => {
  const holder = holderOf(details);
  const taken = takenAddress(details, context);
  const message = `${taken} is already taken${holder === undefined ? '' : ` by ${holder}`}.`;
  const holderCommand =
    details.blocking !== undefined
      ? `raphael get --id ${details.blocking.id}`
      : context.subject !== undefined && 'path' in context.subject && context.parent !== undefined
        ? `raphael get ${args(context.subject)}`
        : undefined;
  // A create sent again after an unknown outcome meets its own first attempt here (ADR 0002), and
  // the CLI cannot tell that from someone else's item, so another slug is offered only after a look.
  const creating = context.parent !== undefined;
  const hint =
    holderCommand === undefined
      ? creating
        ? `${capitalized(EARLIER_ATTEMPT)}. If not, choose another slug.`
        : 'Choose another slug.'
      : creating
        ? `${run(holderCommand)} to see what holds it; ${EARLIER_ATTEMPT}. If not, choose another slug.`
        : `${run(holderCommand)} to see what holds it, or choose another slug.`;
  return { code: 'slug_conflict', message, hint };
};

/** What could not be placed, and where: `/work/a cannot be created`, `--id 4 cannot move to /x`. */
const placement = (details: ApiErrorDetails, context: RequestContext): string => {
  const subject = context.subject === undefined ? 'This item' : label(context.subject);
  if (details.field === 'destination') {
    return `${subject} cannot move to ${context.destination === undefined ? 'that destination' : forTerminal(context.destination)}`;
  }
  if (context.subject !== undefined) return `${label(context.subject)} cannot be created`;
  const parent = context.parent;
  if (parent !== undefined && 'id' in parent) {
    return `${context.slug === undefined ? 'It' : `"${forTerminal(context.slug)}"`} cannot be created under --parent-id ${parent.id}`;
  }
  return 'It cannot be created there';
};

/** One sentence per containment reason. Keyed by the contract's list. */
const PARENT_WORDING: Readonly<Record<InvalidParentReason, CodeWording>> = {
  parentage: (details, { context }) => {
    const rule = containmentRule(details.parentType, details.childType);
    return {
      code: 'invalid_parent',
      message: `${placement(details, context)}: ${rule.charAt(0).toLowerCase()}${rule.slice(1)}`,
      hint: listHint(ROOT_PATH, 'to choose another place'),
    };
  },
  cycle: (_details, { context }) => {
    const subject = context.subject === undefined ? 'This item' : label(context.subject);
    const destination =
      context.destination === undefined ? 'there' : `into ${forTerminal(context.destination)}`;
    return {
      code: 'invalid_parent',
      message: `${subject} cannot move ${destination}, which is inside it.`,
      hint: listHint(ROOT_PATH, 'to choose a destination outside it'),
      field: '<destination>',
    };
  },
};

/** The item an archive refusal is about, as typed. */
const archivedSubject = (
  details: ApiErrorDetails,
  context: RequestContext,
  direct: boolean,
): string => {
  const blocking = details.blocking;
  const parent = context.parent;
  return details.field === 'parent'
    ? parent === undefined
      ? 'The parent'
      : 'path' in parent
        ? `The parent ${label(parent)}`
        : // Archived directly, the parent is the blocking item, so its type is known.
          `The parent ${direct && blocking !== undefined ? noun(blocking.type) : 'item'} ${parent.id}`
    : details.field === 'destination'
      ? context.destination === undefined
        ? 'The destination'
        : `The destination ${forTerminal(context.destination)}`
      : context.subject === undefined
        ? 'It'
        : label(context.subject);
};

const archivedReadHint = (context: RequestContext): string =>
  `${run(`raphael get ${context.subject === undefined ? '' : args(context.subject)}`.trim())} to see what is archived.`;

/** Archived itself (`direct`) or through a container above it (`inherited`). */
const archived = (details: ApiErrorDetails, { context }: WordingInput, direct: boolean): Worded => {
  const blocking = details.blocking;
  const named = archivedSubject(details, context, direct);
  const inside =
    blocking === undefined
      ? 'inside something archived'
      : `inside archived ${noun(blocking.type)} ${blocking.id}`;
  // A destination is either an existing container or a new path inside one, and the answer does
  // not say which, so the archived container is named by what the server gave: its type and id. A
  // new path does not exist, so calling it archived would name the wrong thing.
  const message =
    details.field === 'destination' && blocking !== undefined
      ? `${capitalized(noun(blocking.type))} ${blocking.id} is archived, so nothing can move to ${context.destination === undefined ? 'that destination' : forTerminal(context.destination)}.`
      : `${named} is ${direct ? 'archived' : inside}, so ${details.field === 'target' ? 'it cannot be changed' : 'nothing can go there'}.`;
  const restore =
    blocking !== undefined
      ? `raphael restore --id ${blocking.id}`
      : direct && details.field === 'target' && context.subject !== undefined
        ? `raphael restore ${args(context.subject)}`
        : undefined;
  return {
    code: 'node_archived',
    message,
    hint:
      restore === undefined ? archivedReadHint(context) : `${run(restore)} first to bring it back.`,
  };
};

/** One entry per server code, so a new code without a sentence fails the typecheck. */
const SERVER_CODES: Readonly<Record<ApiErrorCode, CodeWording>> = {
  invalid_input: (details, { context, command }) => {
    const reason = details.reason;
    const flag = flagFor(context, details.field);
    const typed = typedFor(context, details.field);
    const known = (INVALID_INPUT_REASONS as readonly (string | undefined)[]).includes(reason);
    const message = known
      ? INVALID_INPUT_SENTENCES[reason as InvalidInputReason](typed, details, context)
      : `The server refused the request${typed === undefined ? '' : ` (${typed})`}.`;
    const transport =
      reason === 'malformed_json' || reason === 'invalid_utf8' || reason === 'incomplete_body';
    return {
      code: 'invalid_input',
      message,
      hint: transport ? versionHint : helpHint(command),
      ...(flag === undefined ? {} : { field: flag }),
    };
  },

  node_not_found: (details, { context }) => {
    const { field, index } = details;
    if (field === 'scopes' && index !== undefined) {
      const scope = context.scopes?.[index];
      if (scope !== undefined) return notFound(scope);
    }
    if (field === 'parent' && context.parent !== undefined) {
      const parent = context.parent;
      if ('id' in parent) {
        return {
          code: 'node_not_found',
          message: `Nothing has id ${parent.id}, so it cannot be the parent.`,
          hint: findIdHint,
          field: '--parent-id',
          target: parent,
        };
      }
      const created =
        context.subject === undefined ? '' : `, so ${label(context.subject)} cannot be created`;
      return {
        code: 'node_not_found',
        message: `Nothing exists at ${label(parent)}${created}.`,
        hint: missingPathHint(parent.path),
        target: parent,
      };
    }
    if (field === 'destination' && context.destination !== undefined) {
      const missing = parentPath(context.destination);
      return {
        code: 'node_not_found',
        message: `Nothing exists at ${forTerminal(missing)}, so ${forTerminal(context.destination)} cannot be the destination.`,
        hint: missingPathHint(missing),
        field: '<destination>',
      };
    }
    if (context.subject !== undefined) return notFound(context.subject);
    // A server that did not say which scope: with only one, it can only be that one.
    const [only, ...others] = context.scopes ?? [];
    if (only !== undefined && others.length === 0) return notFound(only);
    return { code: 'node_not_found', message: 'Nothing exists there.', hint: findIdHint };
  },

  slug_conflict: (details, input) => {
    const reason = details.reason;
    return reason === undefined || isReason(SLUG_CONFLICT_REASONS, reason)
      ? takenSlug(details, input)
      : {
          code: 'slug_conflict',
          message: `${takenAddress(details, input.context)} cannot be used here: ${UNKNOWN_REASON}`,
          hint: `Choose another slug. ${versionHint}`,
        };
  },

  invalid_parent: (details, input) => {
    const reason = details.reason;
    if (reason === undefined || isReason(INVALID_PARENT_REASONS, reason)) {
      return PARENT_WORDING[reason ?? 'parentage'](details, input);
    }
    return {
      code: 'invalid_parent',
      message: `${placement(details, input.context)}: ${UNKNOWN_REASON}`,
      hint: `${listHint(ROOT_PATH, 'to choose another place')} ${versionHint}`,
    };
  },

  node_archived: (details, input) => {
    const reason = details.reason;
    return reason === undefined || isReason(NODE_ARCHIVED_REASONS, reason)
      ? archived(details, input, reason === 'direct')
      : {
          code: 'node_archived',
          message: `${archivedSubject(details, input.context, false)} cannot be changed because something is archived: ${UNKNOWN_REASON}`,
          hint: `${archivedReadHint(input.context)} ${versionHint}`,
        };
  },

  revision_conflict: (details, { context }) => {
    const current = details.currentRevision;
    const subject = context.subject === undefined ? 'It' : label(context.subject);
    const read =
      context.subject === undefined ? 'raphael get' : `raphael get ${args(context.subject)}`;
    const sent = context.revision;
    const now = current === undefined ? '' : `: it is now at revision ${current}`;
    if (sent === undefined || !sent.given) {
      return {
        code: 'revision_conflict',
        message: `${subject} changed while this change was being sent${now}.`,
        hint: `${run(read)} to see what changed, then run this command again.`,
        field: '--revision',
      };
    }
    if (current !== undefined && sent.sent > current) {
      return {
        code: 'revision_conflict',
        message: `Revision ${sent.sent} of ${subject} does not exist yet${now}.`,
        hint: sent.required
          ? `${run(read)} and pass the revision it shows with --revision.`
          : `Pass --revision ${current}, or leave out --revision to use the current one.`,
        field: '--revision',
      };
    }
    return {
      code: 'revision_conflict',
      message: `${subject} changed after revision ${sent.sent}${now}.`,
      hint: `${run(read)} to see the change, then send yours again with the revision it shows.`,
      field: '--revision',
    };
  },

  unsupported_content: (details) => {
    const reason = details.reason;
    const known = (CONTENT_FAILURE_REASONS as readonly (string | undefined)[]).includes(reason);
    const block = details.location?.[0];
    const at = block === undefined ? '' : ` (block ${block + 1})`;
    return {
      code: 'unsupported_content',
      message: known
        ? CONTENT_SENTENCES[reason as ContentFailureReason](at, details)
        : `The body has something Raphael cannot store${at}.`,
      hint: CONTENT_HINT,
      field: '--body',
    };
  },

  payload_too_large: (details) => ({
    code: 'payload_too_large',
    message: `The request is larger than ${details.limit === undefined ? 'the server accepts' : `the ${details.limit} bytes the server accepts`}.`,
    hint: 'Send a smaller body, for example by splitting the note in two.',
  }),

  unsupported_media_type: () => ({
    code: 'unsupported_media_type',
    message: 'The server refused how the request was encoded.',
    hint: versionHint,
  }),

  unauthorized: (_details, { endpoint, connection }) => {
    const server = endpoint === undefined ? 'the server' : `the server at ${forTerminal(endpoint)}`;
    if (connection === undefined) {
      return {
        code: 'unauthorized',
        message: `${capitalized(server)} rejected the API key.`,
        hint:
          `Run "raphael login${endpoint === undefined ? '' : ` ${forTerminal(endpoint)}`}" again with the ` +
          `server's ${SERVER_API_KEY_VARIABLE}, from its environment or .env. It is compared exactly.`,
      };
    }
    return connection.source === 'environment'
      ? {
          code: 'unauthorized',
          message: `${capitalized(server)} rejected the API key from ${CLIENT_API_KEY_VARIABLE}.`,
          hint:
            `Set ${CLIENT_API_KEY_VARIABLE} to the server's ${SERVER_API_KEY_VARIABLE}, or unset ` +
            `${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} to use your saved login.`,
        }
      : {
          code: 'unauthorized',
          message: `${capitalized(server)} rejected the API key saved in ${forTerminal(connection.configFile ?? '')}.`,
          hint: `Run "raphael login" with the server's ${SERVER_API_KEY_VARIABLE} to replace it.`,
        };
  },

  route_not_found: (_details, input) => notRaphael(input),
  method_not_allowed: (_details, input) => notRaphael(input),

  storage_busy: () => ({
    code: 'storage_busy',
    message: 'The server is starting or shutting down, and did not take the request.',
    hint: 'Run the command again in a moment.',
  }),

  internal_error: (_details, { endpoint, connection, context, state }) => ({
    code: 'internal_error',
    message: `${capitalized(where(endpoint, connection))} could not complete the request.`,
    hint:
      state === 'unknown'
        ? checkHint(context)
        : "Check the server's log for what failed, then run the command again.",
  }),
};

/**
 * Details arrive over the network and decode as any string, so every string in them is escaped before
 * a sentence can include it. Known values carry no control characters and pass through unchanged; JSON
 * output keeps the originals.
 */
const escapedDetails = (details: ApiErrorDetails): ApiErrorDetails => {
  const text = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : forTerminal(value);
  return Object.fromEntries(
    Object.entries({
      ...details,
      field: text(details.field),
      reason: text(details.reason),
      parentType: text(details.parentType),
      childType: text(details.childType),
      element: text(details.element),
      blocking:
        details.blocking === undefined
          ? undefined
          : { id: details.blocking.id, type: forTerminal(details.blocking.type) },
    }).filter(([, value]) => value !== undefined),
  ) as ApiErrorDetails;
};

const serverCodeWording = (
  code: ApiErrorCode,
  details: ApiErrorDetails,
  input: WordingInput,
): Worded => SERVER_CODES[code](escapedDetails(details), input);

const notFound = (subject: Subject): Worded => ({
  code: 'node_not_found',
  message:
    'path' in subject ? `Nothing exists at ${label(subject)}.` : `Nothing has id ${subject.id}.`,
  hint: 'path' in subject ? missingPathHint(subject.path) : findIdHint,
  target: subject,
});

const notRaphael = ({ endpoint, connection }: WordingInput): Worded => ({
  code: 'not_raphael',
  message: `${capitalized(where(endpoint, connection))} has no Raphael API at that address.`,
  hint: addressHint(connection, endpoint),
});

const holderOf = (details: ApiErrorDetails): string | undefined =>
  details.blocking === undefined
    ? undefined
    : `${noun(details.blocking.type)} ${details.blocking.id}`;

/** The address a slug conflict is about, as precisely as what was typed allows. */
const takenAddress = (details: ApiErrorDetails, context: RequestContext): string => {
  if (details.field === 'destination' && context.destination !== undefined) {
    return forTerminal(context.destination);
  }
  // A create by path: the new path itself.
  if (context.parent !== undefined && context.subject !== undefined) return label(context.subject);
  if (context.parent !== undefined && 'id' in context.parent && context.slug !== undefined) {
    return `The slug "${forTerminal(context.slug)}" under --parent-id ${context.parent.id}`;
  }
  // An update renaming by path: the sibling address it would take.
  if (context.slug !== undefined && context.subject !== undefined && 'path' in context.subject) {
    const parent = parentPath(context.subject.path);
    return forTerminal(`${parent === ROOT_PATH ? '' : parent}/${context.slug}`);
  }
  if (context.slug !== undefined) return `The slug "${forTerminal(context.slug)}"`;
  if (context.destination !== undefined) {
    return `The slug this item would have at ${forTerminal(context.destination)}`;
  }
  return 'That slug';
};

/**
 * A rule's refusal: the flag it concerns, then the contract's sentence for the rule - the sentence the
 * server sends and the one this CLI prints when it catches the rule before sending - so the same rule
 * reads the same whichever side caught it.
 */
const ruleSentence = (
  flag: string,
  reason: InvalidRequestIssue['reason'],
  details: ApiErrorDetails & { readonly rule?: string },
): string =>
  `${flag}: ${asSentence(
    describeInvalidInput({
      reason,
      ...(details.limit === undefined ? {} : { limit: details.limit }),
      ...(details.rule === undefined ? {} : { rule: details.rule }),
    }),
  )}`;

/** One sentence per invalid-input reason. Keyed by the contract's list, so none is missing. */
const INVALID_INPUT_SENTENCES: Readonly<
  Record<
    InvalidInputReason,
    (flag: string | undefined, details: ApiErrorDetails, context: RequestContext) => string
  >
> = {
  invalid: (flag) => (flag === undefined ? 'The request is not valid.' : `${flag} is not valid.`),
  title_required: (flag, details) => ruleSentence(flag ?? '--title', 'title_required', details),
  title_too_long: (flag, details) => ruleSentence(flag ?? '--title', 'title_too_long', details),
  slug_too_long: (flag, details) => ruleSentence(flag ?? '--slug', 'slug_too_long', details),
  active_requires_project: (_flag, _details, context) =>
    `Only a project can be active, and ${context.subject === undefined ? 'this' : label(context.subject)} is not a project.`,
  favorite_requires_container: (_flag, _details, context) =>
    `Only ${listWith(
      'and',
      CONTAINER_TYPES.map((type) => noun(type, true)),
    )} can be favorites, and ${context.subject === undefined ? 'this' : label(context.subject)} is neither.`,
  query_malformed: (flag, details) => ruleSentence(flag ?? '-q', 'query_malformed', details),
  query_too_long: (flag, details) => ruleSentence(flag ?? '-q', 'query_too_long', details),
  query_too_many_terms: (flag, details) =>
    ruleSentence(flag ?? '-q', 'query_too_many_terms', details),
  filter_unsupported: (flag, details) =>
    ruleSentence(flag ?? '--filter', 'filter_unsupported', details),
  malformed_json: () => 'The server could not read the request: it was not a JSON document.',
  invalid_utf8: () => 'The server could not read the request: it was not valid UTF-8.',
  incomplete_body: () => 'The server could not read the request: it did not finish arriving.',
};

/** Where the elements, styles and limits a body may use are listed, for any refused body. */
export const CONTENT_HINT = `${run('raphael help content')} for the elements Raphael accepts.`;

/** The attributes the content package checks, by the name a failure gives them. */
const ATTRIBUTE_SENTENCES: Readonly<Record<string, (at: string) => string>> = {
  [CHECKED_ATTRIBUTES.headingLevel]: (at) =>
    `The body has a heading level Raphael does not support${at}. Use ${SUPPORTED_HEADING_LEVELS[0]} to ${SUPPORTED_HEADING_LEVELS.at(-1)}.`,
  [CHECKED_ATTRIBUTES.codeBlockLanguage]: (at) =>
    `The body has a code block language Raphael does not accept${at}.`,
  [CHECKED_ATTRIBUTES.orderedListStart]: (at) =>
    `The body has a numbered list that does not start at a whole number of 0 or more${at}.`,
  [CHECKED_ATTRIBUTES.orderedListType]: (at) =>
    `The body has a numbered list marker style Raphael does not support${at}.`,
};

/** Blocks a body may hold, as TipTap names them. */
const BLOCKS = SUPPORTED_NODES.filter((name) => name !== 'doc' && name !== 'text');

/** One sentence per content failure reason. Keyed by the content package's list. */
const CONTENT_SENTENCES: Readonly<
  Record<ContentFailureReason, (at: string, details: ApiErrorDetails) => string>
> = {
  invalid_json: () => 'The body is not valid JSON.',
  unsupported_node: (at) =>
    `The body has an element Raphael does not support${at}. Supported: ${BLOCKS.join(', ')}.`,
  unsupported_mark: (at) =>
    `The body has a text style Raphael does not support${at}. Supported: ${SUPPORTED_MARKS.join(', ')}.`,
  unsupported_attribute: (at, { element }) =>
    `The body has an attribute Raphael does not support${element === undefined ? '' : ` on ${element}`}${at}.`,
  invalid_attribute_value: (at, { element }) =>
    ATTRIBUTE_SENTENCES[element ?? '']?.(at) ??
    `The body has an attribute value Raphael does not accept${element === undefined ? '' : ` on ${element}`}${at}.`,
  invalid_text: (at) => `The body has text Raphael cannot store${at}.`,
  duplicate_mark: (at) => `The body applies the same text style twice to the same text${at}.`,
  invalid_link: (at) => `The body has a link Raphael does not accept${at}.`,
  invalid_document: () => 'The body is not a TipTap document Raphael can read.',
  document_too_deep: (_at, { limit }) =>
    `The body is nested more than ${limit ?? 'the allowed number of'} levels deep, counting each JSON object and array.`,
  document_too_many_nodes: (_at, { limit }) =>
    `The body has more than ${limit ?? 'the allowed number of'} elements.`,
  document_too_complex: () => 'The body is too complex for Raphael to store.',
  markdown_too_large: (_at, { limit }) =>
    `The Markdown body is larger than ${limit === undefined ? 'Raphael accepts' : `${limit} bytes`}.`,
};

/**
 * A body the CLI converted before sending and could not, in the sentence the server's refusal of the
 * same body would get. Used where the CLI must convert first: taking a note's title from its body.
 */
export const bodyFailureSentence = (failure: ContentFailure): string => {
  const block = failure.path[0];
  return CONTENT_SENTENCES[failure.reason](block === undefined ? '' : ` (block ${block + 1})`, {
    ...(failure.element === undefined ? {} : { element: failure.element }),
    ...(failure.limit === undefined ? {} : { limit: failure.limit }),
  });
};

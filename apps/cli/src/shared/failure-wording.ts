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
  type ContentFailureReason,
} from '@raphael/content';
import {
  API_ERROR_CODES,
  INVALID_INPUT_REASONS,
  type ApiErrorCode,
  type ApiErrorDetails,
  type InvalidInputReason,
} from '@raphael/contracts';
import {
  CONTAINER_TYPES,
  FILTER_KEYS,
  NODE_TYPES,
  PARENTAGE,
  RESOURCE_KINDS,
  ROOT_PATH,
  type NodeType,
} from '@raphael/contracts/nodes';

import type { ChangeState, RequestContext, Subject } from './failure.ts';
import type { InterruptSignal } from './interrupt.ts';
import { forTerminal } from './output.ts';

export interface Worded {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly field?: string;
  readonly target?: Subject;
}

export interface WordingInput {
  readonly context: RequestContext;
  readonly endpoint: string | undefined;
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
const shellArg = (value: string): string =>
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

/** The next step when the address may not be the Raphael server's own. */
const addressHint =
  'Check that the address points at the Raphael server itself, then run "raphael login" again.';

const versionHint =
  'Check that this CLI and the server are the same version with "raphael version".';

/** The next step after a write whose outcome is unknown: look before sending it again. */
const checkHint = (context: RequestContext): string => {
  const check =
    context.check ??
    (context.subject === undefined ? undefined : `raphael get ${args(context.subject)}`);
  return check === undefined
    ? 'Check whether it was applied before sending it again.'
    : `${run(check)} to check whether it was applied before sending it again.`;
};

const listHint = (path: string, what = 'to see what is there'): string =>
  `${run(`raphael list ${shellArg(forTerminal(path))}`)} ${what}.`;

const findIdHint = `${run('raphael list / -r')} to find the right id.`;

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

const where = (endpoint: string | undefined): string =>
  endpoint === undefined ? 'the server' : `the server at ${forTerminal(endpoint)}`;

/** Word one client failure. */
export const clientFailureWording = (failure: ClientFailure, input: WordingInput): Worded => {
  const { context, endpoint, command, state } = input;
  const server = where(endpoint);
  const afterWrite = state === 'unknown';

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
      return failure.delivery === 'not_sent'
        ? {
            code: 'unreachable',
            message: `Could not connect to ${server}.`,
            hint: 'Check that the server is running and the address is right, then run the command again.',
          }
        : {
            code: 'connection_lost',
            message: `The connection to ${server} was lost before an answer arrived.`,
            hint: afterWrite ? checkHint(context) : 'Run the command again.',
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
      if (failure.code === 'incompatible_protocol') {
        return {
          code: 'incompatible_protocol',
          message: forTerminal(failure.message),
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
      return {
        code: 'bad_response',
        message:
          failure.status !== undefined &&
          failure.status >= 300 &&
          failure.status < 400 &&
          failure.status !== 304
            ? `${capitalized(server)} redirected the request.`
            : `${capitalized(server)} answered ${failure.status ?? 'without a status'}, which this command does not expect.`,
        hint: addressHint,
      };
    case 'http':
      if (failure.code === undefined) {
        return {
          code: 'not_raphael',
          message: `${capitalized(server)} answered ${failure.status ?? ''} without a Raphael error.`,
          hint: afterWrite
            ? checkHint(context)
            : 'Check that the address points at a Raphael server.',
        };
      }
      if (!(API_ERROR_CODES as readonly string[]).includes(failure.code)) {
        return {
          code: failure.code,
          message: forTerminal(failure.message),
          hint: afterWrite ? checkHint(context) : versionHint,
        };
      }
      return serverCodeWording(failure.code as ApiErrorCode, failure.details ?? {}, input);
  }
};

// ---- Server codes ------------------------------------------------------------------------------

type CodeWording = (details: ApiErrorDetails, input: WordingInput) => Worded;

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
        hint: listHint(parentPath(parent.path)),
        target: parent,
      };
    }
    if (field === 'destination' && context.destination !== undefined) {
      const missing = parentPath(context.destination);
      return {
        code: 'node_not_found',
        message: `Nothing exists at ${forTerminal(missing)}, so ${forTerminal(context.destination)} cannot be the destination.`,
        hint: listHint(parentPath(missing)),
        field: '<destination>',
      };
    }
    if (context.subject !== undefined) return notFound(context.subject);
    // A server that did not say which scope: with only one, it can only be that one.
    const [only, ...others] = context.scopes ?? [];
    if (only !== undefined && others.length === 0) return notFound(only);
    return { code: 'node_not_found', message: 'Nothing exists there.', hint: findIdHint };
  },

  slug_conflict: (details, { context }) => {
    const holder = holderOf(details);
    const taken = takenAddress(details, context);
    const message = `${taken} is already taken${holder === undefined ? '' : ` by ${holder}`}.`;
    const hint =
      details.blocking !== undefined
        ? `${run(`raphael get --id ${details.blocking.id}`)} to see what holds it, or choose another slug.`
        : context.subject !== undefined && 'path' in context.subject && context.parent !== undefined
          ? `${run(`raphael get ${args(context.subject)}`)} to see what holds it, or choose another slug.`
          : 'Choose another slug.';
    return { code: 'slug_conflict', message, hint };
  },

  invalid_parent: (details, { context }) => {
    const subject = context.subject === undefined ? 'This item' : label(context.subject);
    if (details.reason === 'cycle') {
      const destination =
        context.destination === undefined ? 'there' : `into ${forTerminal(context.destination)}`;
      return {
        code: 'invalid_parent',
        message: `${subject} cannot move ${destination}, which is inside it.`,
        hint: listHint(ROOT_PATH, 'to choose a destination outside it'),
        field: '<destination>',
      };
    }
    const rule = containmentRule(details.parentType, details.childType);
    const what =
      details.field === 'destination'
        ? `${subject} cannot move to ${context.destination === undefined ? 'that destination' : forTerminal(context.destination)}`
        : context.subject !== undefined
          ? `${label(context.subject)} cannot be created`
          : 'It cannot be created there';
    return {
      code: 'invalid_parent',
      message: `${what}: ${rule.charAt(0).toLowerCase()}${rule.slice(1)}`,
      hint: listHint(ROOT_PATH, 'to choose another place'),
    };
  },

  node_archived: (details, { context }) => {
    const blocking = details.blocking;
    const direct = details.reason === 'direct';
    const named =
      details.field === 'parent'
        ? context.parent === undefined
          ? 'The parent'
          : `The parent ${label(context.parent)}`
        : details.field === 'destination'
          ? context.destination === undefined
            ? 'The destination'
            : `The destination ${forTerminal(context.destination)}`
          : context.subject === undefined
            ? 'It'
            : label(context.subject);
    const inside =
      blocking === undefined
        ? 'inside something archived'
        : `inside archived ${noun(blocking.type)} ${blocking.id}`;
    const message = `${named} is ${direct ? 'archived' : inside}, so ${details.field === 'target' ? 'it cannot be changed' : 'nothing can go there'}.`;
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
        restore === undefined
          ? `${run(`raphael get ${context.subject === undefined ? '' : args(context.subject)}`.trim())} to see what is archived.`
          : `${run(restore)} first to bring it back.`,
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

  unsupported_content: (details, { command }) => {
    const reason = details.reason;
    const known = (CONTENT_FAILURE_REASONS as readonly (string | undefined)[]).includes(reason);
    const block = details.location?.[0];
    const at = block === undefined ? '' : ` (block ${block + 1})`;
    return {
      code: 'unsupported_content',
      message: known
        ? CONTENT_SENTENCES[reason as ContentFailureReason](at, details)
        : `The body has something Raphael cannot store${at}.`,
      hint: `${run(`raphael ${command ?? 'create'} --help`)} for the body formats Raphael accepts.`,
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

  unauthorized: (_details, { endpoint }) => ({
    code: 'unauthorized',
    message: `${capitalized(where(endpoint))} refused the API key.`,
    hint: 'Run "raphael login" with the server\'s key, or set RAPHAEL_ENDPOINT and RAPHAEL_API_KEY.',
  }),

  route_not_found: (_details, { endpoint }) => notRaphael(endpoint),
  method_not_allowed: (_details, { endpoint }) => notRaphael(endpoint),

  storage_busy: () => ({
    code: 'storage_busy',
    message: 'The server is shutting down and did not take the request.',
    hint: 'Run the command again once the server is back.',
  }),

  internal_error: (_details, { endpoint, context, state }) => ({
    code: 'internal_error',
    message: `${capitalized(where(endpoint))} could not complete the request.`,
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
  hint: 'path' in subject ? listHint(parentPath(subject.path)) : findIdHint,
  target: subject,
});

const notRaphael = (endpoint: string | undefined): Worded => ({
  code: 'not_raphael',
  message: `${capitalized(where(endpoint))} does not offer this command; it may not be a Raphael server, or not this version.`,
  hint: addressHint,
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

/** One sentence per invalid-input reason. Keyed by the contract's list, so none is missing. */
const INVALID_INPUT_SENTENCES: Readonly<
  Record<
    InvalidInputReason,
    (flag: string | undefined, details: ApiErrorDetails, context: RequestContext) => string
  >
> = {
  invalid: (flag) => (flag === undefined ? 'The request is not valid.' : `${flag} is not valid.`),
  title_required: (flag) => `${flag ?? '--title'} must not be empty.`,
  title_too_long: (flag, { limit }) =>
    `${flag ?? '--title'} is longer than ${limit ?? 'the limit of'} characters.`,
  slug_too_long: (flag, { limit }) =>
    flag?.startsWith('--') === true
      ? `${flag} is longer than ${limit ?? 'the limit of'} characters.`
      : `The slug in ${flag ?? 'the path'} is longer than ${limit ?? 'the limit of'} characters.`,
  active_requires_project: (_flag, _details, context) =>
    `Only a project can be active, and ${context.subject === undefined ? 'this' : label(context.subject)} is not a project.`,
  favorite_requires_container: (_flag, _details, context) =>
    `Only ${listWith(
      'and',
      CONTAINER_TYPES.map((type) => noun(type, true)),
    )} can be favorites, and ${context.subject === undefined ? 'this' : label(context.subject)} is neither.`,
  query_malformed: (flag) => `${flag ?? '-q'} is not a well-formed query.`,
  query_too_long: (flag, { limit }) =>
    `${flag ?? '-q'} is longer than ${limit ?? 'the limit of'} characters.`,
  query_too_many_terms: (flag, { limit }) =>
    `${flag ?? '-q'} has more than ${limit ?? 'the allowed number of'} terms.`,
  filter_unsupported: (flag) =>
    `${flag ?? '--filter'} uses a key or an operator that is not supported. Keys: ${FILTER_KEYS.join(', ')}.`,
  malformed_json: () => 'The server could not read the request: it was not a JSON document.',
  invalid_utf8: () => 'The server could not read the request: it was not valid UTF-8.',
  incomplete_body: () => 'The server could not read the request: it did not finish arriving.',
};

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
    `The body is nested more than ${limit ?? 'the allowed number of'} levels deep.`,
  document_too_many_nodes: (_at, { limit }) =>
    `The body has more than ${limit ?? 'the allowed number of'} elements.`,
  document_too_complex: () => 'The body is too complex for Raphael to store.',
  markdown_too_large: (_at, { limit }) =>
    `The Markdown body is larger than ${limit === undefined ? 'Raphael accepts' : `${limit} bytes`}.`,
};

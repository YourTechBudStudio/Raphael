/**
 * The seven hierarchy commands.
 *
 * Each one assembles a request, sends it, and renders the answer. No hierarchy rule is implemented
 * here and none may be: slug derivation, parentage, conflict detection, and content conversion all
 * belong to the server, and a CLI that reimplemented any of them would be a second authority that
 * could disagree with the first.
 */

import { randomUUID } from 'node:crypto';

import type { ClientFailure, Transport } from '@raphael/client';
import { create, get, getPath, list, move, search, update } from '@raphael/client/nodes';
import {
  BODY_FORMATS,
  FILTER_KEYS,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  NODE_ORDER_FIELDS,
  ORDER_DIRECTIONS,
  SCOPES_MAX_COUNT,
  type NodeEntity,
  type NodeFilterInput,
  type NodeSummary,
  type ScopeSelector,
} from '@raphael/contracts/nodes';

import {
  UsageError,
  booleanOption,
  choiceOption,
  integerOption,
  parseArgs,
  stringListOption,
  stringOption,
  type OptionConfig,
  type ParsedArgs,
} from '../../shared/args.ts';
import { EXIT_OK, type ExitCode } from '../../shared/exit.ts';
import {
  forTerminal,
  forTerminalBlock,
  writeJson,
  writeLine,
  type Streams,
} from '../../shared/output.ts';
import { reportFailure } from '../../shared/report.ts';
import {
  CREATE_TARGETS,
  destinationFrom,
  parseCreateTarget,
  parseId,
  parseOrderBy,
  parseQueries,
  resolveBody,
  resolveFilter,
  resolveMetadata,
  scopesFrom,
  selectorFrom,
  splitCreatePath,
  type Selector,
} from './input.ts';

/**
 * How a node's type reads in output: `area`, `project`, or `resource.note`.
 *
 * One helper rather than a spelling per command, so create, get, and list cannot come to describe the
 * same node differently. The qualified form is what the create command accepts, so what is printed back
 * is a token that could be typed again.
 */
const qualifiedType = (entity: Pick<NodeEntity | NodeSummary, 'type' | 'kind'>): string =>
  entity.kind === null ? entity.type : `${entity.type}.${entity.kind}`;

/**
 * The page footer both `list` and `search` print.
 *
 * Never implies completeness. A page that ends is not the same as a hierarchy that ends, and the
 * difference is what tells someone whether to ask for more.
 *
 * One helper rather than a copy per command, because the two footers are byte-identical and the next
 * change to this wording must land once. The summary *lines* above it are deliberately not shared: a
 * search hit prints the title that matched and a listing does not, and collapsing two honest formats
 * behind one flag would be worse than two clear literals.
 */
const writePageFooter = (
  streams: Streams,
  page: {
    readonly items: readonly unknown[];
    readonly skip: number;
    readonly limit: number;
    readonly hasMore: boolean;
  },
): void => {
  writeLine(
    streams.out,
    page.items.length === 0
      ? `Nothing here (skip ${page.skip}, limit ${page.limit}).`
      : `${page.items.length} shown, skip ${page.skip}, limit ${page.limit}${
          page.hasMore ? `. More available: --skip ${page.skip + page.limit}` : '. No more.'
        }`,
  );
};

/**
 * Report a scope-page failure, and name the scope when the server says one could not be resolved.
 *
 * `reportFailure` already prints `index: 0` from the projected details, because the projection carries
 * it and the detail lines are generic. That number counts the list that was *sent* - paths first, then
 * ids - which is not the order the person typed, so leaving them to count it themselves would be
 * unkind. This adds the one translation on top and changes nothing else about the report.
 *
 * Silent whenever the failure is anything else, or the index falls outside the list. An out-of-range
 * index is a server answer this build cannot interpret, and inventing a scope for it would be worse
 * than printing only what was actually said.
 */
const reportScopeFailure = (
  streams: Streams,
  failure: ClientFailure,
  scopes: readonly ScopeSelector[],
): ExitCode => {
  const code = reportFailure(streams, failure);
  if (failure.kind !== 'api_error' || failure.error.code !== 'node_not_found') return code;
  const { field, index } = failure.details;
  if (field !== 'scopes' || index === undefined) return code;
  const scope = scopes[index];
  if (scope === undefined) return code;
  writeLine(
    streams.err,
    `  scope: ${'id' in scope ? `--id ${scope.id}` : forTerminal(scope.path)}`,
  );
  return code;
};

/**
 * The options every scope page accepts, declared once.
 *
 * List and Search take the same request and differ only in how they order what they found, so the
 * flags that say *where to look* have one spelling here for the same reason they have one spelling in
 * the contract. Each command spreads this and adds its own: `--order-by` for a listing, `-q` for a
 * search.
 */
const SCOPE_PAGE_OPTIONS = {
  id: { type: 'string', multiple: true },
  recursive: { type: 'boolean', short: 'r' },
  filter: { type: 'string' },
  skip: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

/**
 * Adapt the shared half of a scope-page request, for either command.
 *
 * Returns the request fragment ready to spread, and the assembled scopes beside it, because a failure
 * The archive flag #8 brings, and any other field both operations come to share, lands here once.
 *
 * The fragment carries its own scopes, which is also what a failure is reported against: the list a
 * caller sends *is* the list the server indexes into, so `reportScopeFailure` reads it back off the
 * fragment rather than being handed a second copy to keep in step - see `reportScopeFailure`.
 */
const scopePageFrom = (
  parsed: ParsedArgs,
  command: string,
): {
  readonly scopes: readonly ScopeSelector[];
  readonly recursive?: boolean;
  readonly filter?: NodeFilterInput;
  readonly skip?: number;
  readonly limit?: number;
} => {
  // Every positional is a scope. There is no "unexpected argument" case, because a second path is a
  // second place to look rather than a mistake.
  const scopes = scopesFrom(parsed.positionals, stringListOption(parsed, 'id'), command);
  const recursive = booleanOption(parsed, 'recursive');
  const filter = resolveFilter(stringOption(parsed, 'filter', command), command);
  const skip = integerOption(parsed, 'skip', command, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = integerOption(parsed, 'limit', command, {
    min: LIST_LIMIT_MIN,
    max: LIST_LIMIT_MAX,
  });

  return {
    scopes,
    ...(recursive ? { recursive } : {}),
    ...(filter === undefined ? {} : { filter }),
    ...(skip === undefined ? {} : { skip }),
    ...(limit === undefined ? {} : { limit }),
  };
};

export interface CommandContext {
  readonly streams: Streams;
  readonly transport: () => Transport;
}

export const CREATE_HELP = `Usage: raphael create <type> <path> [--title <title>] [options]
       raphael create <type> --parent-id <id> --slug <slug> [--title <title>] [options]

Create an area, a project, or a note. The path form splits a complete absolute path into the
parent it goes under and the slug it will occupy, so "/work/raphael/backend" creates "backend"
under "/work/raphael". The id form addresses the parent by its durable identifier instead.

Types: ${CREATE_TARGETS.join(', ')}

A note may omit --title, in which case the server names it from the first line of its body, or
from its description. A note with no usable text in either is refused rather than named for you.

Examples:
  raphael create resource.note /work/api-design --title "API design" --body '# API design'
  raphael create resource.note /work/api-design --body @./note.md
  raphael create resource.note /work/api-design --body @-
  raphael get /work/api-design

Options:
      --title <text>         The human name. Required for an area or a project.
      --parent-id <id>       Parent by identifier. Use instead of a path.
      --slug <slug>          Address within the parent. Required with --parent-id.
      --description <text>   Plain description.
      --tag <tag>            Repeatable.
      --metadata <json>      A JSON object, or @file containing one.
      --body <text|@file|@-> Body content. @file reads a file, @- reads standard input.
      --body-literal <text>  Body text that starts with "@" and is not a path.
      --body-format <fmt>    Format of the submitted body: ${BODY_FORMATS.join(' or ')}. Default markdown.
      --format <fmt>         Format of the returned body: ${BODY_FORMATS.join(' or ')}. Default markdown.
      --idempotency-key <k>  Reuse a key from an earlier uncertain attempt.
      --json                 Print the result as JSON.
  -h, --help                 Show this help.`;

export const runCreate = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    {
      title: { type: 'string' },
      'parent-id': { type: 'string' },
      slug: { type: 'string' },
      description: { type: 'string' },
      tag: { type: 'string', multiple: true },
      metadata: { type: 'string' },
      body: { type: 'string' },
      'body-literal': { type: 'string' },
      'body-format': { type: 'string' },
      format: { type: 'string' },
      'idempotency-key': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    'create',
  );

  const [typeToken, path, ...extra] = parsed.positionals;
  if (typeToken === undefined) {
    throw new UsageError(`Give a type to create: ${CREATE_TARGETS.join(', ')}.`, 'create');
  }
  const target = parseCreateTarget(typeToken, 'create');
  if (extra.length > 0) {
    throw new UsageError(`Unexpected argument "${extra[0]}".`, 'create');
  }

  // A container must be named here; a resource need not be. The CLI does not decide whether a kind may
  // omit a title - it declines to invent one, omits the field, and lets the server answer. A refusal
  // comes back as the server's own `title_required` sentence, which the recovery projection already
  // carries.
  const title = stringOption(parsed, 'title', 'create');

  const parentId = stringOption(parsed, 'parent-id', 'create');
  const slugFlag = stringOption(parsed, 'slug', 'create');

  // The two addressing forms are mutually exclusive. Mixing them would leave two answers to "where
  // does this go", and choosing between them silently is how something lands in the wrong place.
  let parent: { id: number } | { path: string };
  let slug: string;
  if (path !== undefined) {
    if (parentId !== undefined || slugFlag !== undefined) {
      throw new UsageError(
        'Give either a complete path or --parent-id with --slug, not both.',
        'create',
      );
    }
    const split = splitCreatePath(path, 'create');
    parent = split.parent;
    slug = split.slug;
  } else {
    if (parentId === undefined || slugFlag === undefined) {
      throw new UsageError('Give a complete path, or --parent-id together with --slug.', 'create');
    }
    parent = { id: parseId(parentId, 'create') };
    slug = slugFlag;
  }

  const body = await resolveBody(
    stringOption(parsed, 'body', 'create'),
    stringOption(parsed, 'body-literal', 'create'),
    choiceOption(parsed, 'body-format', 'create', BODY_FORMATS),
    'create',
  );
  const metadata = resolveMetadata(stringOption(parsed, 'metadata', 'create'), 'create');
  const tags = stringListOption(parsed, 'tag');
  const description = stringOption(parsed, 'description', 'create');
  const format = choiceOption(parsed, 'format', 'create', BODY_FORMATS);

  // A key is always present. Generated here rather than inside the client, because
  // `crypto.randomUUID` does not exist on every runtime the client has to run on, and a transport
  // that silently produced a weaker identifier on one platform would be worse than one that asks.
  const suppliedKey = stringOption(parsed, 'idempotency-key', 'create');
  const idempotencyKey = suppliedKey ?? randomUUID();

  const common = {
    parent,
    slug,
    idempotencyKey,
    ...(description === undefined ? {} : { description }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(body === undefined ? {} : { body }),
    ...(format === undefined ? {} : { format }),
  };

  // Assembled per branch rather than by spreading the target over one object. A container request and a
  // note request are genuinely different requests - one must carry a title and cannot carry a kind, the
  // other the reverse - and the shared request type says so. The container branch is where the title
  // becomes mandatory, so the usage error and the type narrowing are the same check rather than two that
  // could drift apart.
  let request;
  if (target.type === 'resource') {
    request = {
      ...common,
      type: target.type,
      kind: target.kind,
      ...(title === undefined ? {} : { title }),
    };
  } else {
    if (title === undefined) {
      throw new UsageError('--title is required. Every container has a name.', 'create');
    }
    request = { ...common, type: target.type, title };
  }

  const dispatchedAt = new Date();
  const result = await create(context.transport(), request);

  if (!result.ok) {
    return reportFailure(context.streams, result.failure, {
      operation: 'create',
      idempotencyKey,
      dispatchedAt,
      keyWasSupplied: suppliedKey !== undefined,
    });
  }

  if (booleanOption(parsed, 'json')) {
    writeJson(context.streams.out, result.value);
  } else {
    const { entity } = result.value;
    writeLine(
      context.streams.out,
      `Created ${qualifiedType(entity)} ${entity.id}: ${forTerminal(entity.title)}`,
    );
    writeLine(context.streams.out, `  slug: ${forTerminal(entity.slug)}`);
  }
  return EXIT_OK;
};

export const UPDATE_HELP = `Usage: raphael update <path> [changes] [--revision <n>] [options]
       raphael update --id <id> [changes] [--revision <n>] [options]

Change an area, a project, or a note. An update names the revision it was written against, so a
newer version on the server is refused rather than overwritten. Raphael does not retry a change
on its own.

Examples:
  raphael update /work/contracts --body @./contracts.md --revision 8
  raphael update /work/contracts --add-tag reviewed --remove-tag draft
  raphael update --id 42 --title "Contract review" --description ""

Changes (at least one):
      --title <text>          Replace the name. The address does not follow it.
      --description <text>    Replace the description. "" clears it.
      --slug <slug>           Replace the address within the parent.
      --body <text|@file|@->  Replace the body. "" clears it. Requires --revision.
      --body-literal <text>   Body text that starts with "@" and is not a path. Requires --revision.
      --body-format <fmt>     Format of the submitted body: ${BODY_FORMATS.join(' or ')}. Default markdown.
      --add-tag <tag>         Repeatable.
      --remove-tag <tag>      Repeatable.
      --active                Mark the project as currently being worked on.
      --inactive              Mark it as not being worked on. Only a project can be either.

Options:
      --id <id>               Address by identifier instead of by path.
      --revision <n>          The revision you read. Without it, and without a body change, the
                              current revision is read for you just before the update is sent.
      --format <fmt>          Format of the returned body: ${BODY_FORMATS.join(' or ')}. Default markdown.
      --json                  Print the result as JSON.
  -h, --help                  Show this help.`;

/** Every flag that asks for something to change. Presence is the rule; an empty value still changes. */
const CHANGE_FLAGS = [
  'title',
  'description',
  'slug',
  'body',
  'body-literal',
  'add-tag',
  'remove-tag',
  'active',
  'inactive',
] as const;

/** Whether a flag was given at all, whatever it was given as. */
const wasGiven = (parsed: ParsedArgs, name: string): boolean => parsed.values[name] !== undefined;

/** What the convenience read establishes: which entity, at which version. */
interface PinnedTarget {
  /** By identifier, whatever the caller typed. See `pinTarget`. */
  readonly target: { readonly id: number };
  readonly revision: number;
}

/**
 * Read the current revision for an update or a move that did not name one, and pin the entity it
 * belongs to.
 *
 * The identifier is carried forward deliberately, and it is the whole reason this returns a target
 * rather than a number. The server's guard answers "is this the version of entity 7 that I read?" -
 * it cannot answer "is /work/contracts still entity 7?". Sending the caller's path again would
 * resolve that name a second time, so a slug freed and reoccupied between the two calls could land
 * the change on an entity nobody looked at, with a revision that happens to match and therefore no
 * conflict. Resolving once and comparing-and-setting on that exact row removes the second question.
 *
 * Returns the failure rather than reporting it, so the caller reports it through the one path every
 * other failure takes.
 *
 * The projected body is discarded. There is no revision-only read in the contract, so this pays for a
 * full body projection to learn one integer; see the decision log. It is affordable because a person
 * updates one entity at a time.
 */
const pinTarget = async (
  transport: Transport,
  target: Selector,
): Promise<PinnedTarget | { readonly failure: ClientFailure }> => {
  const result = await get(transport, { target });
  return result.ok
    ? { target: { id: result.value.entity.id }, revision: result.value.entity.revision }
    : { failure: result.failure };
};

export const runUpdate = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      slug: { type: 'string' },
      body: { type: 'string' },
      'body-literal': { type: 'string' },
      'body-format': { type: 'string' },
      'add-tag': { type: 'string', multiple: true },
      'remove-tag': { type: 'string', multiple: true },
      active: { type: 'boolean' },
      inactive: { type: 'boolean' },
      revision: { type: 'string' },
      format: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    'update',
  );

  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, 'update');

  const target = selectorFrom(path, stringOption(parsed, 'id', 'update'), 'update');
  const revisionFlag = integerOption(parsed, 'revision', 'update', {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });

  // Both usage refusals are decided from flag *presence*, and both come before anything is read or
  // sent. Presence is not an approximation of the resolved value: `--description ""` and `--body ""`
  // are changes precisely because presence is the rule. Deciding them here is what stops
  // `--body @-` with no --revision from making someone type a whole document into a terminal before
  // being told the command was wrong.
  if (!CHANGE_FLAGS.some((flag) => wasGiven(parsed, flag))) {
    throw new UsageError(
      'Give at least one change: --title, --description, --slug, --body, --add-tag, --remove-tag, --active or --inactive.',
      'update',
    );
  }
  // After the "at least one change" check, so someone who gave only these two is told the more useful
  // thing first, and before anything is read or sent: this is decided from presence alone, like every
  // other refusal above and below it.
  if (wasGiven(parsed, 'active') && wasGiven(parsed, 'inactive')) {
    throw new UsageError('Give --active or --inactive, not both.', 'update');
  }
  if (
    (wasGiven(parsed, 'body') || wasGiven(parsed, 'body-literal')) &&
    revisionFlag === undefined
  ) {
    throw new UsageError(
      'A body change needs --revision: pass the revision you read the body at, so a newer version on the server is not overwritten.',
      'update',
    );
  }

  const body = await resolveBody(
    stringOption(parsed, 'body', 'update'),
    stringOption(parsed, 'body-literal', 'update'),
    choiceOption(parsed, 'body-format', 'update', BODY_FORMATS),
    'update',
  );
  const title = stringOption(parsed, 'title', 'update');
  const description = stringOption(parsed, 'description', 'update');
  const slug = stringOption(parsed, 'slug', 'update');
  const addTags = stringListOption(parsed, 'add-tag');
  const removeTags = stringListOption(parsed, 'remove-tag');
  // Desired state, never a toggle: the two flags name the state to result in, so neither has to know
  // what the current one is. Neither needs --revision - the pre-read below pins the target by
  // identifier exactly as it does for a title change.
  const active = wasGiven(parsed, 'active')
    ? true
    : wasGiven(parsed, 'inactive')
      ? false
      : undefined;
  const format = choiceOption(parsed, 'format', 'update', BODY_FORMATS);

  const transport = context.transport();

  // One Get, immediately before the update, and only when no body is being replaced. It is a
  // convenience, not a blessing: a change that lands between this read and the update is caught by
  // the server's guard and reported as a conflict, exactly as a stale explicit --revision would be.
  // What it reads is then addressed by identifier, so the guard is comparing versions of one entity
  // rather than of whatever the path names by the time the update arrives.
  let sendTo: Selector = target;
  let revision: number;
  if (revisionFlag !== undefined) {
    revision = revisionFlag;
  } else {
    const pinned = await pinTarget(transport, target);
    if ('failure' in pinned) {
      return reportFailure(context.streams, pinned.failure, {
        operation: 'update',
        beforeDispatch: true,
      });
    }
    sendTo = pinned.target;
    revision = pinned.revision;
  }

  const dispatchedAt = new Date();
  const result = await update(transport, {
    target: sendTo,
    revision,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(slug === undefined ? {} : { slug }),
    ...(body === undefined ? {} : { body }),
    ...(addTags.length === 0 ? {} : { addTags }),
    ...(removeTags.length === 0 ? {} : { removeTags }),
    ...(active === undefined ? {} : { active }),
    ...(format === undefined ? {} : { format }),
  });

  if (!result.ok) {
    return reportFailure(context.streams, result.failure, { operation: 'update', dispatchedAt });
  }

  if (booleanOption(parsed, 'json')) {
    writeJson(context.streams.out, result.value);
  } else {
    const { entity } = result.value;
    writeLine(
      context.streams.out,
      `Updated ${qualifiedType(entity)} ${entity.id}: ${forTerminal(entity.title)}`,
    );
    writeLine(context.streams.out, `  revision: ${entity.revision}`);
    writeLine(context.streams.out, `  slug: ${forTerminal(entity.slug)}`);
  }
  return EXIT_OK;
};

export const MOVE_HELP = `Usage: raphael move <path> <destination> [--revision <n>] [options]
       raphael move --id <id> <destination> [--revision <n>] [options]

Move an area, a project, or a note somewhere else, keeping its identifier and everything inside it.

  raphael move /work/backend /engineering            into the area /engineering, keeping "backend"
  raphael move /work/backend /engineering/platform   under /engineering, as "platform"
  raphael move /work/inbox /                         an area to the top level

If <destination> is an existing area or project, it is where this goes. Otherwise its last
segment becomes the new address and the rest must already exist. Nothing is ever overwritten:
an address that is taken, including one held by a note, is refused.

Options:
      --id <id>        Address the thing to move by identifier instead of by path.
      --revision <n>   The revision you read. Without it, the current revision is read for you
                       just before the move is sent.
      --json           Print the result as JSON.
  -h, --help           Show this help.`;

export const runMove = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    {
      id: { type: 'string' },
      revision: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    'move',
  );

  // With --id the only positional is the destination; without it, the source path comes first. A
  // positional beyond those is extra, not a second source, so it is reported as what it is.
  const id = stringOption(parsed, 'id', 'move');
  const positionals = [...parsed.positionals];
  const source = id === undefined ? positionals.shift() : undefined;
  const [destination, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, 'move');

  const target = selectorFrom(source, id, 'move');
  const destinationPath = destinationFrom(destination, 'move');
  const revisionFlag = integerOption(parsed, 'revision', 'move', {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });

  const transport = context.transport();

  // The same convenience `update` takes for a change without a body, and for the same reason it pins
  // by identifier. A move carries no content, so there is no older read for a newer revision to bless.
  let sendTo: Selector = target;
  let revision: number;
  if (revisionFlag !== undefined) {
    revision = revisionFlag;
  } else {
    const pinned = await pinTarget(transport, target);
    if ('failure' in pinned) {
      return reportFailure(context.streams, pinned.failure, {
        operation: 'move',
        beforeDispatch: true,
      });
    }
    sendTo = pinned.target;
    revision = pinned.revision;
  }

  const dispatchedAt = new Date();
  const result = await move(transport, {
    target: sendTo,
    revision,
    destination: { path: destinationPath },
  });

  if (!result.ok) {
    return reportFailure(context.streams, result.failure, {
      operation: 'move',
      dispatchedAt,
      ...('id' in sendTo ? { targetId: sendTo.id } : {}),
    });
  }

  if (booleanOption(parsed, 'json')) {
    writeJson(context.streams.out, result.value);
  } else {
    // A move to where it already is reads the same, with the revision unchanged: the server reported
    // a success, not a separate outcome. The new full path is one `raphael path` away, not a second
    // request made here.
    const { node } = result.value;
    writeLine(
      context.streams.out,
      `Moved ${qualifiedType(node)} ${node.id}: ${forTerminal(node.title)}`,
    );
    writeLine(context.streams.out, `  revision: ${node.revision}`);
    writeLine(context.streams.out, `  slug: ${forTerminal(node.slug)}`);
    writeLine(
      context.streams.out,
      `  parent: ${node.parentId === null ? 'top level' : node.parentId}`,
    );
  }
  return EXIT_OK;
};

export const GET_HELP = `Usage: raphael get <path> [options]
       raphael get --id <id> [options]

Read one area, project, or note.

Options:
      --id <id>       Address by identifier instead of by path.
      --format <fmt>  Format of the returned body: ${BODY_FORMATS.join(' or ')}. Default markdown.
      --json          Print the result as JSON.
  -h, --help          Show this help.`;

export const runGet = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    {
      id: { type: 'string' },
      format: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    'get',
  );
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, 'get');

  const target = selectorFrom(path, stringOption(parsed, 'id', 'get'), 'get');
  const format = choiceOption(parsed, 'format', 'get', BODY_FORMATS);

  const result = await get(context.transport(), {
    target,
    ...(format === undefined ? {} : { format }),
  });
  if (!result.ok) return reportFailure(context.streams, result.failure);

  if (booleanOption(parsed, 'json')) {
    writeJson(context.streams.out, result.value);
    return EXIT_OK;
  }

  const { entity } = result.value;
  const { out } = context.streams;
  writeLine(out, `${qualifiedType(entity)} ${entity.id}  (revision ${entity.revision})`);
  writeLine(out, `title: ${forTerminal(entity.title)}`);
  writeLine(out, `slug:  ${forTerminal(entity.slug)}`);
  // Only for a project. An area is never active, so printing `active: no` on one would answer a
  // question nobody can ask of it - `type` is what says the field does not apply.
  if (entity.type === 'project') writeLine(out, `active: ${entity.active ? 'yes' : 'no'}`);
  if (entity.description !== '') writeLine(out, `description: ${forTerminal(entity.description)}`);
  if (entity.tags.length > 0) {
    writeLine(out, `tags: ${entity.tags.map((tag) => forTerminal(tag)).join(', ')}`);
  }
  writeLine(out);
  writeLine(
    out,
    entity.body.format === 'markdown'
      ? forTerminalBlock(entity.body.value)
      : JSON.stringify(entity.body.value, undefined, 2),
  );
  return EXIT_OK;
};

export const PATH_HELP = `Usage: raphael path <path> [options]
       raphael path --id <id> [options]

Print the current full path of an area, project, or note. Paths change when things are renamed
or moved; identifiers do not.

Options:
      --id <id>   Address by identifier instead of by path.
      --json      Print the result as JSON.
  -h, --help      Show this help.`;

export const runPath = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    { id: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    'path',
  );
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, 'path');

  const target = selectorFrom(path, stringOption(parsed, 'id', 'path'), 'path');
  const result = await getPath(context.transport(), { target });
  if (!result.ok) return reportFailure(context.streams, result.failure);

  if (booleanOption(parsed, 'json')) writeJson(context.streams.out, result.value);
  else writeLine(context.streams.out, forTerminal(result.value.path));
  return EXIT_OK;
};

export const LIST_HELP = `Usage: raphael list <path>... [options]
       raphael list --id <id> [options]

List what is inside an area or project. Use "/" for the root. A note holds nothing, so listing
one is an empty page rather than an error.

Several paths list all of them at once, as one page. Repeat --id to address a scope by its
durable identifier instead, and mix the two forms freely. At most ${SCOPES_MAX_COUNT} scopes.

Ordering applies to everything in scope before the page is cut, so paging through a sorted
listing is paging through one order rather than sorting each page on its own.

Examples:
  raphael list / -r --filter '{"type":"resource"}' --order-by updatedAt:desc --limit 4
  raphael list /work -r --filter '{"type":"resource"}' --order-by updatedAt:desc --order-by slug:asc
  raphael list /work /personal --filter '{"tags":{"$in":["urgent"]}}'

Options:
      --id <id>       Address a scope by identifier. Repeatable.
  -r, --recursive     Include everything underneath, not just direct children.
      --filter <json> A JSON object, or @file containing one. Keys: ${FILTER_KEYS.join(', ')}.
                      A value is either the value itself or {"$in": [...]}.
      --order-by <f:d>  Repeatable, in priority order. Fields: ${NODE_ORDER_FIELDS.join(', ')}.
                      Directions: ${ORDER_DIRECTIONS.join(', ')}. Default slug:asc then id:asc.
      --skip <n>      How many to skip. Default 0.
      --limit <n>     How many to return, ${LIST_LIMIT_MIN} to ${LIST_LIMIT_MAX}.
      --json          Print the result as JSON.
  -h, --help          Show this help.`;

export const runList = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    { ...SCOPE_PAGE_OPTIONS, 'order-by': { type: 'string', multiple: true } },
    'list',
  );

  const scopePage = scopePageFrom(parsed, 'list');
  const orderBy = parseOrderBy(stringListOption(parsed, 'order-by'), 'list');

  const result = await list(context.transport(), {
    ...scopePage,
    ...(orderBy === undefined ? {} : { orderBy }),
  });
  if (!result.ok) return reportScopeFailure(context.streams, result.failure, scopePage.scopes);

  if (booleanOption(parsed, 'json')) {
    writeJson(context.streams.out, result.value);
    return EXIT_OK;
  }

  const { out } = context.streams;
  const page = result.value;
  for (const item of page.items) {
    writeLine(
      out,
      `${String(item.id).padStart(6)}  ${qualifiedType(item).padEnd(13)}  ${forTerminal(item.slug)}${
        item.active ? '  active' : ''
      }`,
    );
  }
  writePageFooter(context.streams, page);
  return EXIT_OK;
};

export const SEARCH_HELP = `Usage: raphael search <path>... -q <query> [options]
       raphael search --id <id> -q <query> [options]

Find areas, projects and notes by their text. Title, description and body are all searched, and
results come back with the closest match first.

Words match any of them.
Quote a phrase to match it exactly.
Uppercase AND narrows; OR is the default.

Several paths search all of them at once, as one page. Repeat --id to address a scope by its
durable identifier instead, and mix the two forms freely. At most ${SCOPES_MAX_COUNT} scopes.
Repeat -q to ask more than one question of the same scopes.

Examples:
  raphael search /work -q 'auth tokens'
  raphael search /work -r -q '"login flow" AND retry'
  raphael search / -r -q auth --filter '{"type":"resource","kind":"note"}'
  raphael search /work /personal -r -q auth --limit 20

Options:
      --id <id>       Address a scope by identifier. Repeatable.
  -q, --query <text>  What to look for. Repeatable. At least one is required.
  -r, --recursive     Search everything underneath, not just direct children.
      --filter <json> A JSON object, or @file containing one. Keys: ${FILTER_KEYS.join(', ')}.
                      A value is either the value itself or {"$in": [...]}.
      --skip <n>      How many to skip. Default 0.
      --limit <n>     How many to return, ${LIST_LIMIT_MIN} to ${LIST_LIMIT_MAX}.
      --json          Print the result as JSON.
  -h, --help          Show this help.

There is no --order-by. A search answers in relevance order; ask "raphael list" for an
authored one.`;

export const runSearch = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    { ...SCOPE_PAGE_OPTIONS, query: { type: 'string', multiple: true, short: 'q' } },
    'search',
  );

  const scopePage = scopePageFrom(parsed, 'search');
  const queries = parseQueries(stringListOption(parsed, 'query'), 'search');

  const result = await search(context.transport(), { ...scopePage, queries });
  if (!result.ok) return reportScopeFailure(context.streams, result.failure, scopePage.scopes);

  if (booleanOption(parsed, 'json')) {
    writeJson(context.streams.out, result.value);
    return EXIT_OK;
  }

  const { out } = context.streams;
  const page = result.value;
  for (const { node } of page.items) {
    // The title comes after the slug, because a hit's title is usually the thing that matched, and a
    // slug alone does not tell someone which of two similarly addressed notes they found. The active
    // marker stays, for the same reason `list` prints it: wherever a node summary is printed, an
    // active project says so rather than reading as one that is not.
    writeLine(
      out,
      `${String(node.id).padStart(6)}  ${qualifiedType(node).padEnd(13)}  ${forTerminal(
        node.slug,
      )}  ${forTerminal(node.title)}${node.active ? '  active' : ''}`,
    );
  }
  writePageFooter(context.streams, page);
  return EXIT_OK;
};

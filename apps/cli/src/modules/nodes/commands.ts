/**
 * The twelve hierarchy commands.
 *
 * Each one assembles a request, sends it, and hands the answer to the shared renderers: one for a
 * success, one for a failure. No command writes output of its own. No hierarchy rule is implemented
 * here and none may be: slug derivation, parentage, conflict detection, and content conversion all
 * belong to the server, and a CLI that reimplemented any of them would be a second authority that
 * could disagree with the first.
 */

import type { ClientFailure, Transport } from '@raphael/client';
import {
  addFavorite,
  archive,
  create,
  get,
  getPath,
  list,
  listFavorites,
  move,
  removeFavorite,
  restore,
  search,
  update,
} from '@raphael/client/nodes';
import {
  BODY_FORMATS,
  DIRECT_ARCHIVE_REASON,
  FILTER_KEYS,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  NODE_ORDER_FIELDS,
  ORDER_DIRECTIONS,
  SCOPES_MAX_COUNT,
  type ArchiveCause,
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
import type { CommandContext } from '../../shared/command.ts';
import type { ExitCode } from '../../shared/exit.ts';
import { reportClientFailure, type RequestContext, type Subject } from '../../shared/failure.ts';
import { forTerminal, forTerminalBlock } from '../../shared/output.ts';
import { renderSuccess, type Success } from '../../shared/success.ts';
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
  titleFromContent,
  type Selector,
} from './input.ts';

const failed = (
  context: CommandContext,
  failure: ClientFailure,
  request: RequestContext = {},
): ExitCode => reportClientFailure(context.streams, context.session, failure, request);

const succeeded = (context: CommandContext, success: Success): ExitCode =>
  renderSuccess(context.streams, context.session, success);

/**
 * How a node's type reads in output: `area`, `project`, or `resource.note`.
 *
 * One helper rather than a spelling per command, so create, get, and list cannot come to describe the
 * same node differently. The qualified form is what the create command accepts, so what is printed back
 * is a token that could be typed again.
 */
const qualifiedType = (entity: Pick<NodeEntity | NodeSummary, 'type' | 'kind'>): string =>
  entity.kind === null ? entity.type : `${entity.type}.${entity.kind}`;

/** The command that shows an item, as the caller addressed it. */
const getCommand = (subject: Subject): string =>
  'path' in subject ? `raphael get ${subject.path}` : `raphael get --id ${subject.id}`;

/**
 * Labelled fields under a headline, labels padded to one width so the values line up.
 *
 * A value is escaped by the caller when it is server text; a missing or empty one prints `-`, so every
 * field is always present and a reader never has to infer a value from an absent line.
 */
const fields = (entries: ReadonlyArray<readonly [string, string]>, indent = '  '): string[] => {
  const width = Math.max(...entries.map(([name]) => name.length)) + 2;
  return entries.map(
    ([name, value]) => `${indent}${`${name}:`.padEnd(width)}${value === '' ? '-' : value}`,
  );
};

const parentLabel = (parentId: number | null): string =>
  parentId === null ? 'top level' : String(parentId);

/**
 * A tag as it can be read back: quoted when it would otherwise be ambiguous, so `a, b` and the two
 * tags `a` and `b` never print the same.
 */
const tagLabel = (tag: string): string =>
  /^[^\s,"][^,"]*$/u.test(tag) && tag.trim() === tag
    ? forTerminal(tag)
    : forTerminal(JSON.stringify(tag));

/**
 * Why something is archived: one line per cause, nearest first.
 *
 * One helper for `get` and for archive and restore, so the two cannot describe causes differently. A
 * cause on the item itself reads "directly"; one on a container above it names that container, because
 * that is where it is restored. The reason is printed only when it is not the ordinary direct one, and
 * an owner or reason this build does not recognize is printed as it came rather than interpreted.
 */
const causeLines = (nodeId: number, causes: readonly ArchiveCause[], indent: string): string[] =>
  causes.map((cause) => {
    const where =
      cause.origin.id === nodeId
        ? 'directly'
        : `through ${cause.origin.type} ${cause.origin.id} "${forTerminal(cause.origin.title)}"`;
    const who =
      cause.reason === DIRECT_ARCHIVE_REASON
        ? forTerminal(cause.owner)
        : `${forTerminal(cause.owner)}, ${forTerminal(cause.reason)}`;
    return `${indent}${where} (${who})`;
  });

/** The state column: fixed words, printed before any free text so a title cannot imitate them. */
const stateLabel = (item: Pick<NodeSummary, 'active' | 'archived'>): string =>
  item.active && item.archived
    ? 'active,archived'
    : item.active
      ? 'active'
      : item.archived
        ? 'archived'
        : '-';

/**
 * Rows of a page, columns padded to the widest value on this page. The last column is free text and
 * is never padded, so it can hold anything without shifting the others.
 */
const table = (rows: ReadonlyArray<readonly string[]>): string[] => {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  '),
  );
};

interface Page {
  readonly items: readonly unknown[];
  readonly skip: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/** The page window as the JSON envelope carries it. */
const pageData = (page: Page): Record<string, unknown> => ({
  skip: page.skip,
  limit: page.limit,
  hasMore: page.hasMore,
  nextSkip: page.hasMore ? page.skip + page.limit : null,
});

/**
 * The note under a page, for a person. It goes to stderr: it describes the page, it is not one of
 * its rows, and `raphael list / | wc -l` must count rows.
 *
 * Never implies completeness. A page that ends is not the same as a hierarchy that ends, and the
 * difference is what tells someone whether to ask for more.
 */
const pageNote = (page: Page): string =>
  page.items.length === 0
    ? `Nothing here (skip ${page.skip}, limit ${page.limit}).`
    : `${page.items.length} shown, skip ${page.skip}, limit ${page.limit}${
        page.hasMore ? `. More available: --skip ${page.skip + page.limit}` : '. No more.'
      }`;

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
  'include-archived': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

/**
 * Adapt the shared half of a scope-page request, for either command.
 *
 * Returns the request fragment ready to spread. `--include-archived`, and any other field both
 * operations come to share, lands here once.
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
  readonly includeArchived?: boolean;
} => {
  // Every positional is a scope. There is no "unexpected argument" case, because a second path is a
  // second place to look rather than a mistake.
  const scopes = scopesFrom(parsed.positionals, stringListOption(parsed, 'id'), command);
  const recursive = booleanOption(parsed, 'recursive');
  const filter = resolveFilter(stringOption(parsed, 'filter'), command);
  const skip = integerOption(parsed, 'skip', command, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = integerOption(parsed, 'limit', command, {
    min: LIST_LIMIT_MIN,
    max: LIST_LIMIT_MAX,
  });
  const includeArchived = booleanOption(parsed, 'include-archived');

  return {
    scopes,
    ...(recursive ? { recursive } : {}),
    ...(filter === undefined ? {} : { filter }),
    ...(skip === undefined ? {} : { skip }),
    ...(limit === undefined ? {} : { limit }),
    ...(includeArchived ? { includeArchived } : {}),
  };
};

/** How a selector was typed: `<path>` or `--id`. Request fields name it as `target`. */
const selectorFlags = (subject: Subject): Partial<Record<string, string>> => ({
  target: 'path' in subject ? '<path>' : '--id',
});

/** A page request's scopes, in the order they were sent, so a failing one is named as typed. */
const scopeRequest = (scopes: readonly ScopeSelector[]): RequestContext => ({
  scopes: scopes.map((scope): Subject => ('id' in scope ? { id: scope.id } : { path: scope.path })),
  flags: { scopes: '<path>' },
});

export const CREATE_HELP = `Usage: raphael create <type> <path> [--title <title>] [options]
       raphael create <type> --parent-id <id> --slug <slug> [--title <title>] [options]

Create an area, a project, or a note. The path form splits a complete absolute path into the
parent it goes under and the slug it will occupy, so "/work/raphael/backend" creates "backend"
under "/work/raphael". The id form addresses the parent by its durable identifier instead.

Types: ${CREATE_TARGETS.join(', ')}

A note may omit --title, in which case it is named from the first line of its body, or from its
description. A note with no usable text in either needs --title.

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
      --json                 Print the result as JSON.
  -h, --help                 Show this help.`;

export const CREATE_OPTIONS = {
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
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runCreate = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, CREATE_OPTIONS, 'create');

  const [typeToken, path, ...extra] = parsed.positionals;
  if (typeToken === undefined) {
    throw new UsageError(`Give a type to create: ${CREATE_TARGETS.join(', ')}.`, 'create');
  }
  const target = parseCreateTarget(typeToken, 'create');
  if (extra.length > 0) {
    throw new UsageError(`Unexpected argument "${extra[0]}".`, 'create');
  }

  const titleFlag = stringOption(parsed, 'title');

  const parentId = stringOption(parsed, 'parent-id');
  const slugFlag = stringOption(parsed, 'slug');

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
    stringOption(parsed, 'body'),
    stringOption(parsed, 'body-literal'),
    choiceOption(parsed, 'body-format', 'create', BODY_FORMATS),
    'create',
    context.signal,
  );
  const metadata = resolveMetadata(stringOption(parsed, 'metadata'), 'create');
  const tags = stringListOption(parsed, 'tag');
  const description = stringOption(parsed, 'description');
  const format = choiceOption(parsed, 'format', 'create', BODY_FORMATS);

  // Every creation is named by the caller. A container must be named here; a note may be named from
  // what it already says, the same way every client does it.
  let title = titleFlag;
  if (title === undefined) {
    if (target.type !== 'resource') {
      throw new UsageError('--title is required. Every container has a name.', 'create');
    }
    title = titleFromContent(body, description ?? '');
    if (title === undefined) {
      throw new UsageError(
        '--title is required: nothing in the body or description can name this note.',
        'create',
      );
    }
  }

  const common = {
    parent,
    slug,
    title,
    ...(description === undefined ? {} : { description }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(body === undefined ? {} : { body }),
    ...(format === undefined ? {} : { format }),
  };

  // A container request cannot carry a kind, so the two are assembled separately.
  const request =
    target.type === 'resource'
      ? { ...common, type: target.type, kind: target.kind }
      : { ...common, type: target.type };

  const result = await create(context.transport(), request, context.signal);
  if (!result.ok) {
    const byPath = path !== undefined;
    return failed(context, result.failure, {
      ...(byPath ? { subject: { path } } : {}),
      parent,
      slug,
      flags: {
        parent: byPath ? '<path>' : '--parent-id',
        slug: byPath ? '<path>' : '--slug',
      },
      check:
        'path' in parent
          ? `raphael get ${path}`
          : `raphael list --id ${parent.id} --include-archived`,
    });
  }

  const { entity } = result.value;
  return succeeded(context, {
    data: { entity },
    lines: () => [
      `Created ${qualifiedType(entity)} ${entity.id}: ${forTerminal(entity.title)}`,
      ...fields([
        ['revision', String(entity.revision)],
        ['slug', forTerminal(entity.slug)],
        ['parent', parentLabel(entity.parentId)],
      ]),
    ],
  });
};

export const UPDATE_HELP = `Usage: raphael update <path> [changes] [--revision <n>] [options]
       raphael update --id <id> [changes] [--revision <n>] [options]

Change an area, a project, or a note. An update names the revision it was written against, so a
newer version on the server is refused rather than overwritten. Raphael does not retry a change
on its own.

Examples:
  raphael update /work/contracts --body @./contracts.md --revision 8
  raphael update /work/contracts --tag reviewed --tag contracts
  raphael update --id 42 --title "Contract review" --description ""

Changes (at least one):
      --title <text>          Replace the name. The address does not follow it.
      --description <text>    Replace the description. "" clears it.
      --slug <slug>           Replace the address within the parent.
      --body <text|@file|@->  Replace the body. "" clears it. Requires --revision.
      --body-literal <text>   Body text that starts with "@" and is not a path. Requires --revision.
      --body-format <fmt>     Format of the submitted body: ${BODY_FORMATS.join(' or ')}. Default markdown.
      --tag <tag>             Repeatable. Replaces the whole tag list with the tags given.
      --no-tags               Remove every tag.
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
  'tag',
  'no-tags',
  'active',
  'inactive',
] as const;

/** Whether a flag was given at all, whatever it was given as. */
const wasGiven = (parsed: ParsedArgs, name: string): boolean => parsed.values[name] !== undefined;

/** What the change is sent against: which entity, at which version. */
interface Pinned {
  /** By identifier when the convenience read made it; otherwise as the caller typed it. */
  readonly sendTo: Selector;
  readonly revision: number;
}

/**
 * The revision a change is sent against: the caller's `--revision`, or the current one, read for an
 * update, a move, an archive or a restore that did not name one.
 *
 * The read pins the entity it belongs to, and that is the whole reason it returns a target rather
 * than a number. The server's guard answers "is this the version of entity 7 that I read?" - it
 * cannot answer "is /work/contracts still entity 7?". Sending the caller's path again would resolve
 * that name a second time, so a slug freed and reoccupied between the two calls could land the change
 * on an entity nobody looked at, with a revision that happens to match and therefore no conflict.
 * Resolving once and comparing-and-setting on that exact row removes the second question.
 *
 * A failed read is reported here, as a read made before the change: the change itself was not sent.
 *
 * The projected body is discarded. There is no revision-only read in the contract, so this pays for a
 * full body projection to learn one integer; see the decision log. It is affordable because a person
 * updates one entity at a time.
 */
const pinRevision = async (
  context: CommandContext,
  transport: Transport,
  target: Selector,
  revision: number | undefined,
  request: RequestContext,
): Promise<Pinned | { readonly exit: ExitCode }> => {
  if (revision !== undefined) return { sendTo: target, revision };
  const result = await get(transport, { target }, context.signal);
  if (!result.ok) {
    return { exit: failed(context, result.failure, { ...request, beforeChange: true }) };
  }
  return {
    sendTo: { id: result.value.entity.id },
    revision: result.value.entity.revision,
  };
};

export const UPDATE_OPTIONS = {
  id: { type: 'string' },
  title: { type: 'string' },
  description: { type: 'string' },
  slug: { type: 'string' },
  body: { type: 'string' },
  'body-literal': { type: 'string' },
  'body-format': { type: 'string' },
  tag: { type: 'string', multiple: true },
  'no-tags': { type: 'boolean' },
  active: { type: 'boolean' },
  inactive: { type: 'boolean' },
  revision: { type: 'string' },
  format: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runUpdate = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, UPDATE_OPTIONS, 'update');

  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, 'update');

  const target = selectorFrom(path, stringOption(parsed, 'id'), 'update');
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
      'Give at least one change: --title, --description, --slug, --body, --tag, --no-tags, --active or --inactive.',
      'update',
    );
  }
  // After the "at least one change" check, so someone who gave only these two is told the more useful
  // thing first, and before anything is read or sent: this is decided from presence alone, like every
  // other refusal above and below it.
  if (wasGiven(parsed, 'active') && wasGiven(parsed, 'inactive')) {
    throw new UsageError('Give --active or --inactive, not both.', 'update');
  }
  if (wasGiven(parsed, 'tag') && wasGiven(parsed, 'no-tags')) {
    throw new UsageError('Give --tag or --no-tags, not both.', 'update');
  }
  const changesBody = wasGiven(parsed, 'body') || wasGiven(parsed, 'body-literal');
  if (changesBody && revisionFlag === undefined) {
    throw new UsageError(
      'A body change needs --revision: pass the revision you read the body at, so a newer version on the server is not overwritten.',
      'update',
    );
  }

  const body = await resolveBody(
    stringOption(parsed, 'body'),
    stringOption(parsed, 'body-literal'),
    choiceOption(parsed, 'body-format', 'update', BODY_FORMATS),
    'update',
    context.signal,
  );
  const title = stringOption(parsed, 'title');
  const description = stringOption(parsed, 'description');
  const slug = stringOption(parsed, 'slug');
  // The full resulting list: given tags replace the stored ones, and --no-tags clears them.
  const tags = wasGiven(parsed, 'no-tags')
    ? []
    : wasGiven(parsed, 'tag')
      ? stringListOption(parsed, 'tag')
      : undefined;
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
  const request: RequestContext = {
    subject: target,
    ...(slug === undefined ? {} : { slug }),
    flags: { ...selectorFlags(target), active: active === false ? '--inactive' : '--active' },
  };

  // One Get, immediately before the update, and only when no body is being replaced. It is a
  // convenience, not a blessing: a change that lands between this read and the update is caught by
  // the server's guard and reported as a conflict, exactly as a stale explicit --revision would be.
  // What it reads is then addressed by identifier, so the guard is comparing versions of one entity
  // rather than of whatever the path names by the time the update arrives.
  const pinned = await pinRevision(context, transport, target, revisionFlag, request);
  if ('exit' in pinned) return pinned.exit;

  const result = await update(
    transport,
    {
      target: pinned.sendTo,
      revision: pinned.revision,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(slug === undefined ? {} : { slug }),
      ...(body === undefined ? {} : { body }),
      ...(tags === undefined ? {} : { tags }),
      ...(active === undefined ? {} : { active }),
      ...(format === undefined ? {} : { format }),
    },
    context.signal,
  );

  if (!result.ok) {
    return failed(context, result.failure, {
      ...request,
      revision: { sent: pinned.revision, given: revisionFlag !== undefined, required: changesBody },
      check: getCommand(pinned.sendTo),
    });
  }

  const { entity } = result.value;
  return succeeded(context, {
    data: { entity },
    lines: () => [
      `Updated ${qualifiedType(entity)} ${entity.id}: ${forTerminal(entity.title)}`,
      ...fields([
        ['revision', String(entity.revision)],
        ['slug', forTerminal(entity.slug)],
      ]),
    ],
  });
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

Something archived directly must be restored before it moves. Something archived only because a
container above it is archived can move somewhere active.

Options:
      --id <id>        Address the thing to move by identifier instead of by path.
      --revision <n>   The revision you read. Without it, the current revision is read for you
                       just before the move is sent.
      --json           Print the result as JSON.
  -h, --help           Show this help.`;

export const MOVE_OPTIONS = {
  id: { type: 'string' },
  revision: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runMove = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, MOVE_OPTIONS, 'move');

  // With --id the only positional is the destination; without it, the source path comes first. A
  // positional beyond those is extra, not a second source, so it is reported as what it is.
  const id = stringOption(parsed, 'id');
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
  const request: RequestContext = {
    subject: target,
    destination: destinationPath,
    flags: { ...selectorFlags(target), destination: '<destination>' },
  };

  // The same convenience `update` takes for a change without a body, and for the same reason it pins
  // by identifier. A move carries no content, so there is no older read for a newer revision to bless.
  const pinned = await pinRevision(context, transport, target, revisionFlag, request);
  if ('exit' in pinned) return pinned.exit;

  const result = await move(
    transport,
    { target: pinned.sendTo, revision: pinned.revision, destination: { path: destinationPath } },
    context.signal,
  );

  if (!result.ok) {
    return failed(context, result.failure, {
      ...request,
      revision: { sent: pinned.revision, given: revisionFlag !== undefined, required: false },
      // After a move the old path may name nothing, so the check goes by id whenever there is one.
      check: getCommand(pinned.sendTo),
    });
  }

  // A move to where it already is reads the same, with the revision unchanged: the server reported
  // a success, not a separate outcome. The new full path is one `raphael path` away, not a second
  // request made here.
  const { node } = result.value;
  return succeeded(context, {
    data: { node },
    lines: () => [
      `Moved ${qualifiedType(node)} ${node.id}: ${forTerminal(node.title)}`,
      ...fields([
        ['revision', String(node.revision)],
        ['slug', forTerminal(node.slug)],
        ['parent', parentLabel(node.parentId)],
      ]),
    ],
  });
};

export const ARCHIVE_HELP = `Usage: raphael archive <path> [--revision <n>] [options]
       raphael archive --id <id> [--revision <n>] [options]

Hide an area, a project, or a note from lists and search. Nothing is deleted: everything inside
an archived area or project is hidden with it, keeps its address, and comes back on restore.
A project's selection is kept too.

Archiving something that is already archived because a container above it is, keeps it
archived when that container is restored.

Options:
      --id <id>        Address by identifier instead of by path.
      --revision <n>   The revision you read. Without it, the current revision is read for you
                       just before the archive is sent.
      --json           Print the result as JSON.
  -h, --help           Show this help.`;

export const RESTORE_HELP = `Usage: raphael restore <path> [--revision <n>] [options]
       raphael restore --id <id> [--revision <n>] [options]

Bring back something you archived. Only your own archive of this item is removed: if a container
above it is archived too, it stays archived, and the answer says which container to restore.

Options:
      --id <id>        Address by identifier instead of by path.
      --revision <n>   The revision you read. Without it, the current revision is read for you
                       just before the restore is sent.
      --json           Print the result as JSON.
  -h, --help           Show this help.`;

/** Archive and restore take the same options. */
export const LIFECYCLE_OPTIONS = {
  id: { type: 'string' },
  revision: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runArchive = (argv: readonly string[], context: CommandContext): Promise<ExitCode> =>
  runLifecycle('archive', argv, context);

export const runRestore = (argv: readonly string[], context: CommandContext): Promise<ExitCode> =>
  runLifecycle('restore', argv, context);

/**
 * Archive or restore: one command shape with a direction.
 *
 * The headline is worded by the resulting state, never by the verb alone. A restore that leaves the
 * item archived through a container above it is a success, and says "Still archived" with the causes
 * that remain, so nobody reads "Restored" and assumes it is back in their lists.
 */
const runLifecycle = async (
  verb: 'archive' | 'restore',
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, LIFECYCLE_OPTIONS, verb);
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, verb);

  const target = selectorFrom(path, stringOption(parsed, 'id'), verb);
  const revisionFlag = integerOption(parsed, 'revision', verb, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });

  const transport = context.transport();
  const request: RequestContext = { subject: target, flags: selectorFlags(target) };

  // The convenience read `update` and `move` take, pinning by identifier for the same reason.
  const pinned = await pinRevision(context, transport, target, revisionFlag, request);
  if ('exit' in pinned) return pinned.exit;

  const send = verb === 'archive' ? archive : restore;
  const result = await send(
    transport,
    { target: pinned.sendTo, revision: pinned.revision },
    context.signal,
  );
  if (!result.ok) {
    return failed(context, result.failure, {
      ...request,
      revision: { sent: pinned.revision, given: revisionFlag !== undefined, required: false },
      check: getCommand(pinned.sendTo),
    });
  }

  const { node, archiveCauses } = result.value;
  // Archive always ends archived; restore ends either active or still archived by something else.
  const headline = node.archived
    ? verb === 'archive'
      ? 'Archived'
      : 'Still archived'
    : 'Restored';
  // A restore that leaves it archived names the next step: restoring the container it is archived
  // through, which is the nearest cause that is not its own.
  const through = archiveCauses.find((cause) => cause.origin.id !== node.id);
  const notes =
    verb === 'restore' && node.archived && through !== undefined
      ? [
          `hint: Run "raphael restore --id ${through.origin.id}" to restore ${through.origin.type} ${through.origin.id} too.`,
        ]
      : [];
  return succeeded(context, {
    data: { node, archiveCauses },
    lines: () => [
      `${headline} ${qualifiedType(node)} ${node.id}: ${forTerminal(node.title)}`,
      ...fields([
        ['revision', String(node.revision)],
        ['archived', node.archived ? 'yes' : 'no'],
      ]),
      ...causeLines(node.id, archiveCauses, '    '),
    ],
    notes,
  });
};

export const FAVORITE_HELP = `Usage: raphael favorite <path> [options]
       raphael favorite --id <id> [options]

Add an area or a project to your favorites. Already a favorite is fine.

Options:
      --id <id>   Address by identifier instead of by path.
      --json      Print the result as JSON.
  -h, --help      Show this help.`;

export const UNFAVORITE_HELP = `Usage: raphael unfavorite <path> [options]
       raphael unfavorite --id <id> [options]

Remove something from your favorites. Not a favorite is fine.

Options:
      --id <id>   Address by identifier instead of by path.
      --json      Print the result as JSON.
  -h, --help      Show this help.`;

/** Favorite and unfavorite take the same options. */
export const FAVORITE_OPTIONS = {
  id: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runFavorite = (argv: readonly string[], context: CommandContext): Promise<ExitCode> =>
  runFavoriteChange(true, argv, context);

export const runUnfavorite = (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => runFavoriteChange(false, argv, context);

/**
 * Favorite or unfavorite: one command shape with the state wanted.
 *
 * No revision and no convenience read: the request states the result, so sending it again is safe
 * while it still names the same node - always by id, not always by path, which the recovery advice
 * says. The answer is only an id and the resulting state, so the node is named by id.
 */
const runFavoriteChange = async (
  wanted: boolean,
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const verb = wanted ? 'favorite' : 'unfavorite';
  const parsed = parseArgs(argv, FAVORITE_OPTIONS, verb);
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, verb);

  const target = selectorFrom(path, stringOption(parsed, 'id'), verb);
  const send = wanted ? addFavorite : removeFavorite;
  const result = await send(context.transport(), { target }, context.signal);
  if (!result.ok) {
    return failed(context, result.failure, {
      subject: target,
      flags: selectorFlags(target),
      check: getCommand(target),
    });
  }

  const { nodeId, isFavorite } = result.value;
  return succeeded(context, {
    data: { nodeId, isFavorite },
    lines: () => [`Item ${nodeId} is ${isFavorite ? 'a favorite' : 'not a favorite'}.`],
  });
};

export const FAVORITES_HELP = `Usage: raphael favorites [options]

List your favorites by title. Archived ones are left out and stay favorites.
Open one with "raphael get --id <id>".

Options:
      --skip <n>      How many to skip. Default 0.
      --limit <n>     How many to return, ${LIST_LIMIT_MIN} to ${LIST_LIMIT_MAX}.
      --json          Print the result as JSON.
  -h, --help          Show this help.`;

export const FAVORITES_OPTIONS = {
  skip: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runFavorites = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, FAVORITES_OPTIONS, 'favorites');
  if (parsed.positionals.length > 0) {
    throw new UsageError(`Unexpected argument "${parsed.positionals[0]}".`, 'favorites');
  }
  // The bounds `scopePageFrom` uses: it is the same page window.
  const skip = integerOption(parsed, 'skip', 'favorites', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const limit = integerOption(parsed, 'limit', 'favorites', {
    min: LIST_LIMIT_MIN,
    max: LIST_LIMIT_MAX,
  });

  const result = await listFavorites(
    context.transport(),
    {
      ...(skip === undefined ? {} : { skip }),
      ...(limit === undefined ? {} : { limit }),
    },
    context.signal,
  );
  if (!result.ok) return failed(context, result.failure);

  const page = result.value;
  return succeeded(context, {
    data: { items: page.items, page: pageData(page) },
    lines: () =>
      table(
        page.items.map((item) => [
          String(item.id),
          qualifiedType(item),
          stateLabel(item),
          forTerminal(item.title),
        ]),
      ),
    notes: [pageNote(page)],
  });
};

export const GET_HELP = `Usage: raphael get <path> [options]
       raphael get --id <id> [options]

Read one area, project, or note.

Options:
      --id <id>       Address by identifier instead of by path.
      --format <fmt>  Format of the returned body: ${BODY_FORMATS.join(' or ')}. Default markdown.
      --json          Print the result as JSON.
  -h, --help          Show this help.`;

export const GET_OPTIONS = {
  id: { type: 'string' },
  format: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runGet = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, GET_OPTIONS, 'get');
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, 'get');

  const target = selectorFrom(path, stringOption(parsed, 'id'), 'get');
  const format = choiceOption(parsed, 'format', 'get', BODY_FORMATS);

  const result = await get(
    context.transport(),
    { target, ...(format === undefined ? {} : { format }) },
    context.signal,
  );
  if (!result.ok) {
    return failed(context, result.failure, { subject: target, flags: selectorFlags(target) });
  }

  const { entity } = result.value;
  return succeeded(context, {
    data: { entity },
    lines: () => {
      const body =
        entity.body.format === 'markdown'
          ? forTerminalBlock(entity.body.value)
          : JSON.stringify(entity.body.value, undefined, 2);
      // Every field, in one order, whatever the type: a field that does not apply reads `-` rather
      // than being left out, so a reader never infers a value from a missing line. `active` applies
      // only to a project.
      const labelled = fields([
        ['slug', forTerminal(entity.slug)],
        ['parent', parentLabel(entity.parentId)],
        ['revision', String(entity.revision)],
        ['active', entity.type === 'project' ? (entity.active ? 'yes' : 'no') : '-'],
        ['archived', entity.archived ? 'yes' : 'no'],
        // A note is never a favorite, and `no` is the truthful answer for it.
        ['favorite', entity.isFavorite ? 'yes' : 'no'],
        ['tags', entity.tags.map(tagLabel).join(', ')],
        ['description', forTerminal(entity.description)],
        ['metadata', forTerminal(JSON.stringify(entity.metadata))],
      ]);
      // The causes sit under `archived`, the fifth field.
      const lines = [
        `${qualifiedType(entity)} ${entity.id}: ${forTerminal(entity.title)}`,
        ...labelled.slice(0, 5),
        ...causeLines(entity.id, entity.archiveCauses, '    '),
        ...labelled.slice(5),
      ];
      // An empty body prints nothing, not a blank region that reads like a body of blank lines.
      const empty = entity.body.format === 'markdown' && entity.body.value === '';
      return empty ? lines : [...lines, '', body];
    },
  });
};

export const PATH_HELP = `Usage: raphael path <path> [options]
       raphael path --id <id> [options]

Print the current full path of an area, project, or note. Paths change when things are renamed
or moved; identifiers do not.

Options:
      --id <id>   Address by identifier instead of by path.
      --json      Print the result as JSON.
  -h, --help      Show this help.`;

export const PATH_OPTIONS = {
  id: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runPath = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, PATH_OPTIONS, 'path');
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, 'path');

  const target = selectorFrom(path, stringOption(parsed, 'id'), 'path');
  const result = await getPath(context.transport(), { target }, context.signal);
  if (!result.ok) {
    return failed(context, result.failure, { subject: target, flags: selectorFlags(target) });
  }

  return succeeded(context, {
    data: { id: result.value.id, path: result.value.path },
    lines: () => [forTerminal(result.value.path)],
  });
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
      --include-archived  Also show archived things, marked "archived".
      --json          Print the result as JSON.
  -h, --help          Show this help.`;

export const LIST_OPTIONS = {
  ...SCOPE_PAGE_OPTIONS,
  'order-by': { type: 'string', multiple: true },
} as const satisfies OptionConfig;

export const runList = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, LIST_OPTIONS, 'list');

  const scopePage = scopePageFrom(parsed, 'list');
  const orderBy = parseOrderBy(stringListOption(parsed, 'order-by'), 'list');

  const result = await list(
    context.transport(),
    { ...scopePage, ...(orderBy === undefined ? {} : { orderBy }) },
    context.signal,
  );
  if (!result.ok) return failed(context, result.failure, scopeRequest(scopePage.scopes));

  const page = result.value;
  return succeeded(context, {
    data: { items: page.items, page: pageData(page) },
    lines: () =>
      table(
        page.items.map((item) => [
          String(item.id),
          qualifiedType(item),
          stateLabel(item),
          forTerminal(item.slug),
        ]),
      ),
    notes: [pageNote(page)],
  });
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
      --include-archived  Also show archived things, marked "archived".
      --json          Print the result as JSON.
  -h, --help          Show this help.

There is no --order-by. A search answers in relevance order; ask "raphael list" for an
authored one.`;

export const SEARCH_OPTIONS = {
  ...SCOPE_PAGE_OPTIONS,
  query: { type: 'string', multiple: true, short: 'q' },
} as const satisfies OptionConfig;

export const runSearch = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, SEARCH_OPTIONS, 'search');

  const scopePage = scopePageFrom(parsed, 'search');
  const queries = parseQueries(stringListOption(parsed, 'query'), 'search');

  const result = await search(context.transport(), { ...scopePage, queries }, context.signal);
  if (!result.ok) return failed(context, result.failure, scopeRequest(scopePage.scopes));

  const page = result.value;
  return succeeded(context, {
    // A hit stays wrapped as `{ node }`: the wrapper is where a hit will later say what matched.
    data: {
      items: page.items,
      page: { ...pageData(page), archivedLeftOut: page.archivedLeftOut },
    },
    // The title comes after the slug, because a hit's title is usually the thing that matched, and a
    // slug alone does not tell someone which of two similarly addressed notes they found.
    lines: () =>
      table(
        page.items.map(({ node }) => [
          String(node.id),
          qualifiedType(node),
          stateLabel(node),
          forTerminal(node.slug),
          forTerminal(node.title),
        ]),
      ),
    notes: [pageNote(page)],
  });
};

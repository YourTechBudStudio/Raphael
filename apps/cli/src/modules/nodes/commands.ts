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
  decodeCreateRequest,
  decodeUpdateRequest,
  decodeMoveRequest,
  decodeLifecycleRequest,
  decodeFavoriteRequest,
  decodeFavoriteListRequest,
  decodeGetRequest,
  decodeGetPathRequest,
  decodeListRequest,
  decodeSearchRequest,
  BODY_FORMATS,
  DIRECT_ARCHIVE_REASON,
  FILTER_KEYS,
  LIST_LIMIT_DEFAULT,
  LIST_SKIP_DEFAULT,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  NODE_ORDER_FIELDS,
  ORDER_DIRECTIONS,
  SCOPES_MAX_COUNT,
  TITLE_MAX_CODE_POINTS,
  DESCRIPTION_MAX_CODE_POINTS,
  TAGS_MAX_COUNT,
  TAG_MAX_CODE_POINTS,
  SLUG_MAX_CODE_POINTS,
  type ArchiveCause,
  type NodeEntity,
  type NodeFilterInput,
  type NodeSummary,
  type ScopeSelector,
  type RequestField,
} from '@raphael/contracts/nodes';

import {
  UsageError,
  booleanOption,
  choiceOption,
  integerOption,
  parseArgs,
  stringListOption,
  stringOption,
  type ParsedArgs,
} from '../../shared/args.ts';
import {
  optionsFor,
  type CommandContext,
  type CommandDefinition,
  type CommandOption,
} from '../../shared/command.ts';
import type { ExitCode } from '../../shared/exit.ts';
import { reportClientFailure, type RequestContext, type Subject } from '../../shared/failure.ts';
import { HELP_RULES } from '../../shared/help-rules.ts';
import { forTerminal, forTerminalBlock } from '../../shared/output.ts';
import { renderSuccess, type Success } from '../../shared/success.ts';
import {
  CREATE_TARGETS,
  checkRequestSize,
  validateTitle,
  validateSlug,
  validateDescription,
  validateTags,
  validateBodyArguments,
  prevalidateMetadata,
  prevalidateFilter,
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

const textOption = (
  name: string,
  valueName: string,
  description: string,
  extra: Partial<CommandOption> = {},
): CommandOption => ({ name, type: 'string', valueName, description, ...extra });
const flagOption = (
  name: string,
  description: string,
  extra: Partial<CommandOption> = {},
): CommandOption => ({ name, type: 'boolean', description, ...extra });
const commonOptions: readonly CommandOption[] = [
  flagOption('json', 'Print one JSON result.'),
  flagOption('help', 'Show this help.', { short: 'h' }),
];
const idOption = textOption('id', 'id', 'Address by durable id instead of path.');
const revisionOption = textOption(
  'revision',
  'n',
  'Revision read previously. Without a body change, omitted revisions are read immediately before sending.',
);
const returnFormatOption = textOption(
  'return-format',
  'format',
  `Returned body: ${BODY_FORMATS.join(' or ')}. Requires --json.`,
  { default: BODY_FORMATS[0] },
);
const titleOption = textOption(
  'title',
  'text',
  `Name, at most ${TITLE_MAX_CODE_POINTS} characters.`,
  { changes: true },
);
const slugOption = textOption(
  'slug',
  'slug',
  `Address within the parent, at most ${SLUG_MAX_CODE_POINTS} characters. See help addressing.`,
  { changes: true },
);
const descriptionOption = textOption(
  'description',
  'text',
  `Description, at most ${DESCRIPTION_MAX_CODE_POINTS} characters. An empty string clears it.`,
  { changes: true },
);
const tagOption = textOption(
  'tag',
  'tag',
  `Repeat for each tag; at most ${TAGS_MAX_COUNT} tags of ${TAG_MAX_CODE_POINTS} characters. Commas are refused. Updates replace all tags.`,
  { multiple: true, changes: true },
);
const bodyOptions: readonly CommandOption[] = [
  textOption(
    'body',
    'text|@file|@-',
    'Body text, @file, or @- for stdin. An empty string clears it; updates require --revision.',
    { changes: true },
  ),
  textOption(
    'body-literal',
    'text',
    'Literal body text, including text beginning with @. Updates require --revision.',
    { changes: true },
  ),
  textOption('body-format', 'format', `Submitted body: ${BODY_FORMATS.join(' or ')}.`, {
    default: BODY_FORMATS[0],
  }),
];
const pageOptions: readonly CommandOption[] = [
  textOption('id', 'id', 'Include this id alongside positional paths.', {
    multiple: true,
  }),
  textOption(
    'filter',
    'json|@file',
    `JSON object. Keys: ${FILTER_KEYS.join(', ')}. Values may use {"$in":[...]}. See help addressing.`,
  ),
  textOption('skip', 'n', 'Number of results to skip.', { default: String(LIST_SKIP_DEFAULT) }),
  textOption('limit', 'n', `Page size, ${LIST_LIMIT_MIN} to ${LIST_LIMIT_MAX}.`, {
    default: String(LIST_LIMIT_DEFAULT),
  }),
  flagOption('include-archived', 'Include archived items.'),
];
const fieldFlags = {
  type: '<type>',
  kind: '<type>',
  includeArchived: '--include-archived',
  target: '<path> or --id',
  parent: '--parent-id',
  slug: '--slug',
  title: '--title',
  description: '--description',
  tags: '--tag',
  metadata: '--metadata',
  body: '--body',
  format: '--return-format',
  revision: '--revision',
  destination: '<destination>',
  scopes: '<path> or --id',
  queries: '-q',
  filter: '--filter',
  skip: '--skip',
  limit: '--limit',
  orderBy: '--order-by',
  active: '--active',
} satisfies Partial<Record<RequestField, string>>;
const example = (...argv: string[]) => ({ argv });

export const CREATE_DEFINITION: CommandDefinition = {
  name: 'create',
  summary: 'Create an area, project, or note.',
  group: 'Write',
  writes: true,
  usage: [
    'raphael create <type> <path> [options]',
    'raphael create <type> --parent-id <id> --slug <slug> [options]',
  ],
  behavior: [
    `Types: ${CREATE_TARGETS.join(', ')}. A full path supplies both parent and slug. The parent must already exist.`,
    'Areas and projects require --title. Notes may derive their title from the first body line, then the description. Metadata is set once, at create.',
  ],
  constraints: [
    'See help addressing for containment and slug rules. A taken slug, including one reserved by an archived item, is refused.',
    'When supplying a body, give either --body or --body-literal. Give each tag its own --tag.',
  ],
  options: [
    titleOption,
    textOption('parent-id', 'id', 'Parent id instead of a full path. Requires --slug.'),
    slugOption,
    descriptionOption,
    tagOption,
    textOption('metadata', 'json|@file', 'JSON object set once at create. @- is refused.'),
    ...bodyOptions,
    returnFormatOption,
    ...commonOptions,
  ],
  examples: [
    example('create', 'area', '/work', '--title', 'Work'),
    example('create', 'project', '/work/raphael', '--title', 'Raphael'),
    example('create', 'resource.note', '/work/raphael/api-design', '--body', '# API design'),
    example(
      'create',
      'resource.note',
      '--parent-id',
      '42',
      '--slug',
      'review',
      '--title',
      'Review',
      '--tag',
      'reviewed',
    ),
  ],
  prints: 'The created item with its id and revision. JSON carries `entity`.',
  next: 'raphael list / -r',
  seeAlso: ['addressing', 'content', 'update'],
  fieldFlags,
};
export const UPDATE_DEFINITION: CommandDefinition = {
  name: 'update',
  summary: 'Change an item with revision protection.',
  group: 'Write',
  writes: true,
  usage: [
    'raphael update <path> [changes] [options]',
    'raphael update --id <id> [changes] [options]',
  ],
  behavior: [
    'Give at least one change. Tags replace the complete tag list; --no-tags clears it. A renamed title does not change the path.',
    'A body replacement requires the revision you read. Other changes may read and pin the current id and revision for you. Conflicts are never retried automatically.',
  ],
  constraints: [
    'Metadata is set once, at create. --active and --inactive apply only to projects.',
    'On a revision conflict, get the item again and reconcile your intended change before updating with its new revision.',
  ],
  options: [
    idOption,
    titleOption,
    descriptionOption,
    slugOption,
    ...bodyOptions,
    tagOption,
    flagOption('no-tags', 'Clear all tags.', { changes: true }),
    flagOption('active', 'Mark the project active.', { changes: true }),
    flagOption('inactive', 'Mark the project inactive.', { changes: true }),
    revisionOption,
    returnFormatOption,
    ...commonOptions,
  ],
  examples: [
    example('update', '/work/raphael/api-design', '--body', '# Revised design', '--revision', '8'),
    example('update', '/work/raphael', '--tag', 'reviewed', '--tag', 'contracts'),
    example('update', '--id', '42', '--title', 'Contract review', '--description', ''),
  ],
  prints: 'The updated item and revision. JSON carries `entity`.',
  next: 'raphael get --id 42',
  seeAlso: ['revisions', 'content'],
  fieldFlags,
};
export const MOVE_DEFINITION: CommandDefinition = {
  name: 'move',
  summary: 'Move an item while keeping its id.',
  group: 'Write',
  writes: true,
  usage: [
    'raphael move <path> <destination> [options]',
    'raphael move --id <id> <destination> [options]',
  ],
  behavior: [
    'An existing destination area or project receives the item with its current slug. Otherwise the last path segment supplies a new slug and its parent must exist.',
    'Everything inside moves with it. Nothing is overwritten. A directly archived item must be restored first; an item archived only through a parent can move to an active parent.',
  ],
  options: [idOption, revisionOption, ...commonOptions],
  examples: [
    example('move', '/work/raphael', '/engineering'),
    example('move', '/work/raphael', '/engineering/platform'),
    example('move', '--id', '42', '/'),
  ],
  prints: 'The moved item, id and revision. JSON carries `node`.',
  next: 'raphael path --id 42',
  seeAlso: ['addressing', 'revisions'],
  fieldFlags,
};
export const ARCHIVE_DEFINITION: CommandDefinition = {
  name: 'archive',
  summary: 'Hide an item and everything inside it.',
  group: 'Write',
  writes: true,
  usage: ['raphael archive <path> [options]', 'raphael archive --id <id> [options]'],
  behavior: [
    'Archive hides items from ordinary lists and search without deleting them. The slug stays reserved, and favorites and project active state are retained.',
    'Archiving an item already hidden through a parent adds its own archive cause. Restoring the parent then leaves this item archived. There is no delete command.',
  ],
  options: [idOption, revisionOption, ...commonOptions],
  examples: [
    example('archive', '/work/raphael'),
    example('archive', '--id', '42'),
    example('archive', '--id', '42', '--revision', '8', '--json'),
  ],
  prints: 'The item and remaining archive causes. JSON carries `node` and `archiveCauses`.',
  next: 'raphael restore --id 42',
  seeAlso: ['restore', 'revisions'],
  fieldFlags,
};
export const RESTORE_DEFINITION: CommandDefinition = {
  name: 'restore',
  summary: 'Remove an item’s own archive cause.',
  group: 'Write',
  writes: true,
  usage: ['raphael restore <path> [options]', 'raphael restore --id <id> [options]'],
  behavior: [
    'Restore removes only the item’s own archive cause. If a parent remains archived, the item stays archived and the answer names the parent to restore.',
    'An already active item succeeds without a change.',
  ],
  options: [idOption, revisionOption, ...commonOptions],
  examples: [
    example('restore', '/work/raphael'),
    example('restore', '--id', '42'),
    example('restore', '--id', '42', '--revision', '8', '--json'),
  ],
  prints: 'The item and remaining archive causes. JSON carries `node` and `archiveCauses`.',
  next: 'raphael get --id 42',
  seeAlso: ['archive', 'revisions'],
  fieldFlags,
};
export const FAVORITE_DEFINITION: CommandDefinition = {
  name: 'favorite',
  summary: 'Add an area or project to favorites.',
  group: 'Write',
  writes: true,
  usage: ['raphael favorite <path> [options]', 'raphael favorite --id <id> [options]'],
  behavior: [
    'Already a favorite succeeds. Favorites keep their state while archived, but archived items are omitted from the favorites list.',
  ],
  options: [idOption, ...commonOptions],
  examples: [
    example('favorite', '/work'),
    example('favorite', '--id', '42'),
    example('favorite', '/work/raphael', '--json'),
  ],
  prints: 'The id and favorite state. JSON carries `nodeId` and `isFavorite`.',
  next: 'raphael favorites',
  seeAlso: ['unfavorite'],
  fieldFlags,
};
export const UNFAVORITE_DEFINITION: CommandDefinition = {
  name: 'unfavorite',
  summary: 'Remove an area or project from favorites.',
  group: 'Write',
  writes: true,
  usage: ['raphael unfavorite <path> [options]', 'raphael unfavorite --id <id> [options]'],
  behavior: ['An item that is not a favorite succeeds without a change.'],
  options: [idOption, ...commonOptions],
  examples: [
    example('unfavorite', '/work'),
    example('unfavorite', '--id', '42'),
    example('unfavorite', '/work/raphael', '--json'),
  ],
  prints: 'The id and favorite state. JSON carries `nodeId` and `isFavorite`.',
  next: 'raphael favorites',
  seeAlso: ['favorite'],
  fieldFlags,
};
export const FAVORITES_DEFINITION: CommandDefinition = {
  name: 'favorites',
  summary: 'List favorites by title.',
  group: 'Read',
  writes: false,
  usage: ['raphael favorites [options]'],
  behavior: [
    'List favorite areas and projects by title. Archived favorites are left out and stay favorites.',
  ],
  options: [
    ...pageOptions.filter((option) => ['skip', 'limit'].includes(option.name)),
    ...commonOptions,
  ],
  examples: [
    example('favorites'),
    example('favorites', '--limit', '20'),
    example('favorites', '--skip', '20', '--limit', '20', '--json'),
  ],
  prints: 'A page of items. JSON carries `items` and `page`; paging notes go to stderr.',
  next: 'raphael get --id 42',
  seeAlso: ['output'],
  fieldFlags,
};
export const GET_DEFINITION: CommandDefinition = {
  name: 'get',
  summary: 'Read one item and its current revision.',
  group: 'Read',
  writes: false,
  usage: ['raphael get <path> [options]', 'raphael get --id <id> [options]'],
  behavior: [
    'Read one area, project, or note, including its body, tags, metadata and archive causes. Markdown export is best effort; see help content.',
  ],
  options: [idOption, returnFormatOption, ...commonOptions],
  examples: [
    example('get', '/work/raphael/api-design'),
    example('get', '--id', '42'),
    example('get', '--id', '42', '--return-format', 'tiptap', '--json'),
  ],
  prints: 'Fields and body. JSON carries `entity`.',
  next: 'raphael update --id 42 --title "Reviewed design"',
  seeAlso: ['content', 'revisions'],
  fieldFlags,
};
export const PATH_DEFINITION: CommandDefinition = {
  name: 'path',
  summary: 'Print an item’s current full path.',
  group: 'Read',
  writes: false,
  usage: ['raphael path <path> [options]', 'raphael path --id <id> [options]'],
  behavior: ['Paths change when an item or a parent moves or changes slug. Ids remain stable.'],
  options: [idOption, ...commonOptions],
  examples: [
    example('path', '/work/raphael'),
    example('path', '--id', '42'),
    example('path', '--id', '42', '--json'),
  ],
  prints: 'The full path. JSON carries `id` and `path`.',
  next: 'raphael get --id 42',
  seeAlso: ['addressing'],
  fieldFlags,
};
export const LIST_DEFINITION: CommandDefinition = {
  name: 'list',
  summary: 'List children of one or more paths or ids.',
  group: 'Read',
  writes: false,
  usage: ['raphael list <path>... [options]', 'raphael list --id <id> [options]'],
  behavior: [
    `Use / for the root. Mix paths and repeated --id, up to ${SCOPES_MAX_COUNT} distinct places. A note has no children and returns an empty page.`,
    'Direct children are listed by default. -r includes all descendants. Ordering applies before paging.',
  ],
  constraints: [HELP_RULES.paging, HELP_RULES.ordering, HELP_RULES.filter],
  options: [
    ...pageOptions,
    flagOption('recursive', 'Include all descendants.', { short: 'r' }),
    textOption(
      'order-by',
      'field:direction',
      `Repeat in priority order. Fields: ${NODE_ORDER_FIELDS.join(', ')}. Directions: ${ORDER_DIRECTIONS.join(', ')}.`,
      {
        multiple: true,
        default: `${NODE_ORDER_FIELDS[0]}:${ORDER_DIRECTIONS[0]} then ${NODE_ORDER_FIELDS[2]}:${ORDER_DIRECTIONS[0]}`,
      },
    ),
    ...commonOptions,
  ],
  examples: [
    example('list', '/'),
    example(
      'list',
      '/',
      '-r',
      '--filter',
      '{"type":"resource"}',
      '--order-by',
      'updatedAt:desc',
      '--limit',
      '4',
    ),
    example('list', '/work', '/personal', '--filter', '{"tags":{"$in":["urgent"]}}'),
  ],
  prints: 'One row per item. JSON carries `items` and `page`; paging notes go to stderr.',
  next: 'raphael get --id 42',
  seeAlso: ['addressing', 'output'],
  fieldFlags: { ...fieldFlags, recursive: '--recursive' } satisfies Partial<
    Record<RequestField, string>
  >,
};
export const SEARCH_DEFINITION: CommandDefinition = {
  name: 'search',
  summary: 'Search all descendants by text.',
  group: 'Read',
  writes: false,
  usage: [
    'raphael search <path>... -q <query> [options]',
    'raphael search --id <id> -q <query> [options]',
  ],
  behavior: [HELP_RULES.search, 'Results are ordered by relevance; --order-by is not accepted.'],
  constraints: [HELP_RULES.paging, HELP_RULES.filter],
  options: [
    ...pageOptions,
    textOption('query', 'text', 'Text to search. At least one required.', {
      short: 'q',
      multiple: true,
    }),
    flagOption('direct', 'Search direct children only.'),
    ...commonOptions,
  ],
  examples: [
    example('search', '/', '-q', 'auth'),
    example('search', '/work', '-q', '"login flow" AND retry'),
    example('search', '/work', '/personal', '-q', 'auth', '--limit', '20'),
    example(
      'search',
      '/work',
      '--direct',
      '-q',
      'auth',
      '--filter',
      '{"type":"resource","kind":"note"}',
    ),
  ],
  prints: 'One row per match, with closest matches first. JSON carries `items[].node` and `page`.',
  next: 'raphael get --id 42',
  seeAlso: ['addressing', 'output'],
  fieldFlags: { ...fieldFlags, recursive: '--direct' } satisfies Partial<
    Record<RequestField, string>
  >,
};

const parserContext = {
  otherCommands: Object.fromEntries(
    [
      CREATE_DEFINITION,
      UPDATE_DEFINITION,
      MOVE_DEFINITION,
      ARCHIVE_DEFINITION,
      RESTORE_DEFINITION,
      FAVORITE_DEFINITION,
      UNFAVORITE_DEFINITION,
      FAVORITES_DEFINITION,
      GET_DEFINITION,
      PATH_DEFINITION,
      LIST_DEFINITION,
      SEARCH_DEFINITION,
    ].map((definition) => [definition.name, optionsFor(definition)]),
  ),
};
const returnedFormat = (parsed: ParsedArgs, command: string) => {
  const format = choiceOption(parsed, 'return-format', command, BODY_FORMATS);
  if (format !== undefined && !booleanOption(parsed, 'json'))
    throw new UsageError('--return-format requires --json.', command);
  return format;
};

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
  const recursive =
    command === 'search' ? !booleanOption(parsed, 'direct') : booleanOption(parsed, 'recursive');
  prevalidateFilter(stringOption(parsed, 'filter'), command);
  const skip = integerOption(parsed, 'skip', command, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = integerOption(parsed, 'limit', command, {
    min: LIST_LIMIT_MIN,
    max: LIST_LIMIT_MAX,
  });
  const includeArchived = booleanOption(parsed, 'include-archived');
  const filter = resolveFilter(stringOption(parsed, 'filter'), command);

  return {
    scopes,
    recursive,
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

export const runCreate = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(CREATE_DEFINITION), 'create', parserContext);

  const [typeToken, path, ...extra] = parsed.positionals;
  if (typeToken === undefined) {
    throw new UsageError(`Give a type to create: ${CREATE_TARGETS.join(', ')}.`, 'create');
  }
  const target = parseCreateTarget(typeToken, 'create');
  if (extra.length > 0) {
    throw new UsageError(
      'create takes one type and one path, or one type with --parent-id and --slug.',
      'create',
    );
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
    parent = { id: parseId(parentId, 'create', '--parent-id') };
    slug = slugFlag;
  }

  const tags = stringListOption(parsed, 'tag');
  const description = stringOption(parsed, 'description');
  const format = returnedFormat(parsed, 'create');
  const bodyFormat = choiceOption(parsed, 'body-format', 'create', BODY_FORMATS);
  validateBodyArguments(
    stringOption(parsed, 'body'),
    stringOption(parsed, 'body-literal'),
    'create',
  );
  validateSlug(slug, 'create', path === undefined ? '--slug' : '<path>');
  if (titleFlag !== undefined || target.type !== 'resource') validateTitle(titleFlag, 'create');
  if (description !== undefined) validateDescription(description, 'create');
  validateTags(tags, 'create', '--tag');
  prevalidateMetadata(stringOption(parsed, 'metadata'), 'create');
  const body = await resolveBody(
    stringOption(parsed, 'body'),
    stringOption(parsed, 'body-literal'),
    bodyFormat,
    'create',
    context.signal,
  );
  const metadata = resolveMetadata(stringOption(parsed, 'metadata'), 'create');

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

  validateTitle(title, 'create');

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

  checkRequestSize(request, 'create', decodeCreateRequest);
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

/** Every flag that asks for something to change. Presence is the rule; an empty value still changes. */
const CHANGE_FLAGS = UPDATE_DEFINITION.options
  .filter((option) => option.changes)
  .map((option) => option.name);

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

export const runUpdate = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(UPDATE_DEFINITION), 'update', parserContext);

  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError('update takes one path, or --id.', 'update');

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
      `Give at least one change: ${CHANGE_FLAGS.map((flag) => `--${flag}`).join(', ')}.`,
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
  const format = returnedFormat(parsed, 'update');

  validateBodyArguments(
    stringOption(parsed, 'body'),
    stringOption(parsed, 'body-literal'),
    'update',
  );
  if (title !== undefined) validateTitle(title, 'update');
  if (description !== undefined) validateDescription(description, 'update');
  if (slug !== undefined) validateSlug(slug, 'update');
  if (tags !== undefined) validateTags(tags, 'update', '--tag');
  const body = await resolveBody(
    stringOption(parsed, 'body'),
    stringOption(parsed, 'body-literal'),
    choiceOption(parsed, 'body-format', 'update', BODY_FORMATS),
    'update',
    context.signal,
  );
  const changes = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(slug === undefined ? {} : { slug }),
    ...(body === undefined ? {} : { body }),
    ...(tags === undefined ? {} : { tags }),
    ...(active === undefined ? {} : { active }),
    ...(format === undefined ? {} : { format }),
  };
  if (revisionFlag !== undefined)
    checkRequestSize({ target, revision: revisionFlag, ...changes }, 'update', decodeUpdateRequest);
  else checkRequestSize({ target }, 'update', decodeGetRequest);
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

  const writeRequest = { target: pinned.sendTo, revision: pinned.revision, ...changes };
  checkRequestSize(writeRequest, 'update', decodeUpdateRequest);
  const result = await update(transport, writeRequest, context.signal);

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

export const runMove = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(MOVE_DEFINITION), 'move', parserContext);

  // With --id the only positional is the destination; without it, the source path comes first. A
  // positional beyond those is extra, not a second source, so it is reported as what it is.
  const id = stringOption(parsed, 'id');
  const positionals = [...parsed.positionals];
  const source = id === undefined ? positionals.shift() : undefined;
  const [destination, ...extra] = positionals;
  if (extra.length > 0)
    throw new UsageError(
      'move takes one source and one destination, or --id and one destination.',
      'move',
    );

  const target = selectorFrom(source, id, 'move');
  const destinationPath = destinationFrom(destination, 'move');
  const revisionFlag = integerOption(parsed, 'revision', 'move', {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });

  if (revisionFlag !== undefined)
    checkRequestSize(
      { target, revision: revisionFlag, destination: { path: destinationPath } },
      'move',
      decodeMoveRequest,
    );
  else checkRequestSize({ target }, 'move', decodeGetRequest);
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

  const writeRequest = {
    target: pinned.sendTo,
    revision: pinned.revision,
    destination: { path: destinationPath },
  };
  checkRequestSize(writeRequest, 'move', decodeMoveRequest);
  const result = await move(transport, writeRequest, context.signal);

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

/** Archive and restore take the same options. */

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
  const parsed = parseArgs(
    argv,
    optionsFor(verb === 'archive' ? ARCHIVE_DEFINITION : RESTORE_DEFINITION),
    verb,
    parserContext,
  );
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`${verb} takes one path, or --id.`, verb);

  const target = selectorFrom(path, stringOption(parsed, 'id'), verb);
  const revisionFlag = integerOption(parsed, 'revision', verb, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });

  if (revisionFlag !== undefined)
    checkRequestSize({ target, revision: revisionFlag }, verb, decodeLifecycleRequest);
  else checkRequestSize({ target }, verb, decodeGetRequest);
  const transport = context.transport();
  const request: RequestContext = { subject: target, flags: selectorFlags(target) };

  // The convenience read `update` and `move` take, pinning by identifier for the same reason.
  const pinned = await pinRevision(context, transport, target, revisionFlag, request);
  if ('exit' in pinned) return pinned.exit;

  const send = verb === 'archive' ? archive : restore;
  const writeRequest = { target: pinned.sendTo, revision: pinned.revision };
  checkRequestSize(writeRequest, verb, decodeLifecycleRequest);
  const result = await send(transport, writeRequest, context.signal);
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

/** Favorite and unfavorite take the same options. */

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
  const parsed = parseArgs(
    argv,
    optionsFor(wanted ? FAVORITE_DEFINITION : UNFAVORITE_DEFINITION),
    verb,
    parserContext,
  );
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`${verb} takes one path, or --id.`, verb);

  const target = selectorFrom(path, stringOption(parsed, 'id'), verb);
  checkRequestSize({ target }, verb, decodeFavoriteRequest);
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

export const runFavorites = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(FAVORITES_DEFINITION), 'favorites', parserContext);
  if (parsed.positionals.length > 0) {
    throw new UsageError('favorites takes no positional arguments.', 'favorites');
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

  checkRequestSize(
    { ...(skip === undefined ? {} : { skip }), ...(limit === undefined ? {} : { limit }) },
    'favorites',
    decodeFavoriteListRequest,
  );
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

export const runGet = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(GET_DEFINITION), 'get', parserContext);
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError('get takes one path, or --id.', 'get');

  const target = selectorFrom(path, stringOption(parsed, 'id'), 'get');
  const format = returnedFormat(parsed, 'get');

  checkRequestSize(
    { target, ...(format === undefined ? {} : { format }) },
    'get',
    decodeGetRequest,
  );
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

export const runPath = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(PATH_DEFINITION), 'path', parserContext);
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError('path takes one path, or --id.', 'path');

  const target = selectorFrom(path, stringOption(parsed, 'id'), 'path');
  checkRequestSize({ target }, 'path', decodeGetPathRequest);
  const result = await getPath(context.transport(), { target }, context.signal);
  if (!result.ok) {
    return failed(context, result.failure, { subject: target, flags: selectorFlags(target) });
  }

  return succeeded(context, {
    data: { id: result.value.id, path: result.value.path },
    lines: () => [forTerminal(result.value.path)],
  });
};

export const runList = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(LIST_DEFINITION), 'list', parserContext);

  const orderBy = parseOrderBy(stringListOption(parsed, 'order-by'), 'list');
  const scopePage = scopePageFrom(parsed, 'list');
  checkRequestSize(
    { ...scopePage, ...(orderBy === undefined ? {} : { orderBy }) },
    'list',
    decodeListRequest,
  );

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

export const runSearch = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(SEARCH_DEFINITION), 'search', parserContext);

  const queries = parseQueries(stringListOption(parsed, 'query'), 'search');
  const scopePage = scopePageFrom(parsed, 'search');
  checkRequestSize({ ...scopePage, queries }, 'search', decodeSearchRequest);

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

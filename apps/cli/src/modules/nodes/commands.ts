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
  NODE_TYPES,
  RESOURCE_KINDS,
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
  ROOT_PATH,
  asSentence,
  describeTitleRejection,
  type ArchiveCause,
  type NodeEntity,
  type NodeFilterInput,
  type NodeSummary,
  type FilterKey,
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
  HELP_OPTION,
  JSON_OPTION,
  optionsFor,
  type CommandContext,
  type CommandDefinition,
  type CommandOption,
  type FlagOption,
  type ValueOption,
} from '../../shared/command.ts';
import type { ExitCode } from '../../shared/exit.ts';
import { bodyFailureSentence, shellArg } from '../../shared/failure-wording.ts';
import { reportClientFailure, type RequestContext, type Subject } from '../../shared/failure.ts';
import { HELP_RULES, dashValueRule } from '../../shared/help-rules.ts';
import { forTerminal, forTerminalBlock, writeLine } from '../../shared/output.ts';
import { stateLabel } from '../../shared/state-words.ts';
import { renderSuccess, type Success } from '../../shared/success.ts';
import {
  CREATE_TARGETS,
  RESOURCE_TYPE,
  checkRequestSize,
  degradedConstructs,
  degradedWarning,
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
  type BodyReading,
  type Selector,
} from './input.ts';

const textOption = (
  name: string,
  valueName: string,
  description: string,
  extra: Omit<ValueOption, 'name' | 'type' | 'valueName' | 'description'>,
): ValueOption => ({ name, type: 'string', valueName, description, ...extra });
const flagOption = (
  name: string,
  description: string,
  extra: Omit<FlagOption, 'name' | 'type' | 'description'> = {},
): FlagOption => ({ name, type: 'boolean', description, ...extra });
const commonOptions: readonly CommandOption[] = [JSON_OPTION, HELP_OPTION];
/** Ids and revisions are positive whole numbers; a page window starts at zero. */
const POSITIVE = { min: 1, max: Number.MAX_SAFE_INTEGER };
const idOption = textOption('id', 'id', 'Address by stable id instead of path.', {
  whole: POSITIVE,
  example: '42',
});
/** Update's revision: required for a body replacement, read for you otherwise. */
const updateRevisionOption = textOption(
  'revision',
  'n',
  'Revision read previously. Required to replace the body; for other changes, an omitted revision is read just before sending.',
  { whole: POSITIVE, example: '8' },
);
/** Move, archive and restore: no body, so an omitted revision is always read for you. */
const revisionOption = textOption(
  'revision',
  'n',
  'Revision read previously. When omitted, it is read just before sending.',
  { whole: POSITIVE, example: '8' },
);
const returnFormatOption = textOption(
  'return-format',
  'format',
  `Returned body: ${BODY_FORMATS.join(' or ')}. Requires --json.`,
  { default: BODY_FORMATS[0], example: BODY_FORMATS[0], leadingDash: false },
);
const titleOption = textOption(
  'title',
  'text',
  `Name, at most ${TITLE_MAX_CODE_POINTS} characters.`,
  { changes: true, example: 'Contract review' },
);
const slugOption = textOption(
  'slug',
  'slug',
  `Address within the parent, at most ${SLUG_MAX_CODE_POINTS} characters. See \`raphael help addressing\`.`,
  { changes: true, example: 'review', leadingDash: false },
);
/**
 * The field options create and update share. Create sets a field; update changes one, so only its
 * wording says what clearing or replacing does and that a body needs the revision.
 */
type FieldVerb = 'create' | 'update';
const descriptionOption = (verb: FieldVerb): CommandOption =>
  textOption(
    'description',
    'text',
    `Description, at most ${DESCRIPTION_MAX_CODE_POINTS} characters.${verb === 'update' ? ' An empty string clears it.' : ''}`,
    { changes: true, example: 'Notes from the review' },
  );
const tagOption = (verb: FieldVerb): CommandOption =>
  textOption(
    'tag',
    'tag',
    `Repeat for each tag; at most ${TAGS_MAX_COUNT} tags of ${TAG_MAX_CODE_POINTS} characters. Commas are refused.${verb === 'update' ? ' Replaces all tags.' : ''}`,
    { multiple: true, changes: true, example: 'reviewed' },
  );
const bodyOptions = (verb: FieldVerb): readonly CommandOption[] => [
  textOption(
    'body',
    'text|@file|@-',
    `Body text, @file, or @- for stdin.${verb === 'update' ? ' An empty string clears it. Requires --revision.' : ''}`,
    { changes: true, example: '# Design' },
  ),
  textOption(
    'body-literal',
    'text',
    `Literal body text, including text beginning with @.${verb === 'update' ? ' Requires --revision.' : ''}`,
    { changes: true, example: '@mention' },
  ),
  textOption('body-format', 'format', `Submitted body: ${BODY_FORMATS.join(' or ')}.`, {
    default: BODY_FORMATS[0],
    example: BODY_FORMATS[0],
    leadingDash: false,
  }),
  flagOption(
    'strict',
    'Refuse a Markdown body with constructs Raphael cannot store as written. See `raphael help content`.',
  ),
];
const pageOptions: readonly CommandOption[] = [
  textOption('id', 'id', 'Include this id alongside positional paths.', {
    multiple: true,
    whole: POSITIVE,
    example: '42',
  }),
  textOption(
    'filter',
    'json|@file',
    `JSON object. Keys: ${FILTER_KEYS.join(', ')}. Values may use {"$in":[...]}. See \`raphael help addressing\`.`,
    { example: '{"type":"project"}', leadingDash: false },
  ),
  textOption('skip', 'n', 'Number of results to skip.', {
    default: String(LIST_SKIP_DEFAULT),
    whole: { min: 0, max: Number.MAX_SAFE_INTEGER },
    example: String(LIST_LIMIT_DEFAULT),
  }),
  textOption('limit', 'n', `Page size, ${LIST_LIMIT_MIN} to ${LIST_LIMIT_MAX}.`, {
    default: String(LIST_LIMIT_DEFAULT),
    whole: { min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX },
    example: String(LIST_LIMIT_DEFAULT),
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

/** The contract's sentence for a missing title, the one the server sends for the same rule. */
const TITLE_REQUIRED = asSentence(describeTitleRejection({ reason: 'title_required' }));

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
    `Areas and projects require --title. ${HELP_RULES.derivedTitle} Metadata is set once, at create.`,
  ],
  constraints: [
    'See `raphael help addressing` for containment and slug rules. A taken slug, including one reserved by an archived item, is refused.',
    'When supplying a body, give either --body or --body-literal. Give each tag its own --tag.',
    HELP_RULES.dashValues,
  ],
  options: [
    titleOption,
    textOption('parent-id', 'id', 'Parent id instead of a full path. Requires --slug.', {
      whole: POSITIVE,
      example: '42',
    }),
    slugOption,
    descriptionOption('create'),
    tagOption('create'),
    textOption('metadata', 'json|@file', 'JSON object set once at create. @- is refused.', {
      example: '{"source":"cli"}',
      leadingDash: false,
    }),
    ...bodyOptions('create'),
    returnFormatOption,
    ...commonOptions,
  ],
  examples: [
    example('create', 'area', '/work/clients', '--title', 'Clients'),
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
  prints:
    'The created item with its id, path and revision. A warning on stderr names Markdown not stored as written. JSON carries `entity`.',
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
    HELP_RULES.dashValues,
  ],
  options: [
    idOption,
    titleOption,
    descriptionOption('update'),
    slugOption,
    ...bodyOptions('update'),
    tagOption('update'),
    flagOption('no-tags', 'Clear all tags.', { changes: true }),
    flagOption('active', 'Mark the project active.', { changes: true }),
    flagOption('inactive', 'Mark the project inactive.', { changes: true }),
    updateRevisionOption,
    returnFormatOption,
    ...commonOptions,
  ],
  examples: [
    example('update', '/work/raphael/api-design', '--body', '# Revised design', '--revision', '8'),
    example('update', '/work/raphael', '--tag', 'reviewed', '--tag', 'contracts'),
    example('update', '--id', '42', '--title', 'Contract review', '--description', ''),
  ],
  prints:
    'The item with its path and revision, and the path it had when --slug changed it. When every value given matches what is stored it reads Unchanged and the revision is kept. JSON carries `entity`, `changed` and `previousPath`.',
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
  prints:
    'The item with its new path, the path it had, and its revision; Unchanged when it was already there. JSON carries `node`, `changed` and `previousPath`.',
  next: 'raphael get --id 42',
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
    HELP_RULES.archiveCauses,
  ],
  options: [idOption, revisionOption, ...commonOptions],
  examples: [
    example('archive', '/work/raphael'),
    example('archive', '--id', '42'),
    example('archive', '--id', '42', '--revision', '8', '--json'),
  ],
  prints:
    'The item with its path, revision and archive causes; Unchanged when it was already archived. JSON carries `node`, `archiveCauses` and `changed`.',
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
    HELP_RULES.archiveCauses,
  ],
  options: [idOption, revisionOption, ...commonOptions],
  examples: [
    example('restore', '/work/raphael'),
    example('restore', '--id', '42'),
    example('restore', '--id', '42', '--revision', '8', '--json'),
  ],
  prints:
    'The item with its path, revision and remaining archive causes. Still archived, with the restore command for the container, when a container keeps it archived; Unchanged when nothing was removed. JSON carries `node`, `archiveCauses` and `changed`.',
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
    'Already a favorite succeeds without a change. Favorites keep their state while archived; favorites leaves archived items out unless --include-archived is given.',
  ],
  options: [idOption, ...commonOptions],
  examples: [
    example('favorite', '/work'),
    example('favorite', '--id', '42'),
    example('favorite', '/work/raphael', '--json'),
  ],
  prints:
    'The item with its path and favorite state; Unchanged when it already was in that state. JSON carries `nodeId`, `isFavorite`, `changed` and `node`.',
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
  behavior: [
    'An item that is not a favorite succeeds without a change, and so does an id that names nothing.',
  ],
  options: [idOption, ...commonOptions],
  examples: [
    example('unfavorite', '/work'),
    example('unfavorite', '--id', '42'),
    example('unfavorite', '/work/raphael', '--json'),
  ],
  prints:
    'The item with its path and favorite state; Unchanged when it already was in that state, and a plain sentence when the id names nothing. JSON carries `nodeId`, `isFavorite`, `changed` and `node`.',
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
    'List favorite areas and projects by title. Archived favorites stay favorites and are left out unless --include-archived is given; a note under the list says when any were.',
  ],
  options: [
    ...pageOptions.filter((option) => ['skip', 'limit', 'include-archived'].includes(option.name)),
    ...commonOptions,
  ],
  examples: [
    example('favorites'),
    example('favorites', '--limit', '20'),
    example('favorites', '--skip', '20', '--limit', '20', '--json'),
  ],
  prints:
    'One row per item: id, type, state, path, title. JSON carries `items` and `page`; paging notes go to stderr.',
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
    'Read one area, project, or note, including its body, tags, metadata and archive causes. Markdown export is best effort; see `raphael help content`.',
  ],
  options: [idOption, returnFormatOption, ...commonOptions],
  examples: [
    example('get', '/work/raphael/api-design'),
    example('get', '--id', '42'),
    example('get', '--id', '42', '--return-format', 'tiptap', '--json'),
  ],
  prints:
    'Every field, including path, revision and update time, then the body. JSON carries `entity`.',
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
        example: `${NODE_ORDER_FIELDS[1]}:${ORDER_DIRECTIONS[1]}`,
        leadingDash: false,
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
  prints:
    'One row per item: id, type, state, path, title. JSON carries `items` and `page`; paging notes go to stderr.',
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
  constraints: [
    HELP_RULES.paging,
    HELP_RULES.filter,
    dashValueRule('--query', '--query=-draft', 'a query'),
  ],
  options: [
    ...pageOptions,
    textOption('query', 'text', 'Text to search. At least one required.', {
      short: 'q',
      multiple: true,
      example: 'auth',
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
  prints:
    'One row per match, closest first: id, type, state, path, title. JSON carries `items[].node` and `page`.',
  next: 'raphael get --id 42',
  seeAlso: ['addressing', 'output'],
  fieldFlags: { ...fieldFlags, recursive: '--direct' } satisfies Partial<
    Record<RequestField, string>
  >,
};

/** The named options of a definition, as the parser declares them. */
const optionsNamed = (
  definition: CommandDefinition,
  names: readonly string[],
): ReturnType<typeof optionsFor> =>
  Object.fromEntries(
    Object.entries(optionsFor(definition)).filter(([name]) => names.includes(name)),
  );

/**
 * Where an option this command does not take is pointed: only to the command it is the purpose of.
 * `get --body` meant an update; `favorite --revision` did not, so revisions point nowhere.
 */
const POINTED_OPTIONS = {
  update: optionsNamed(
    UPDATE_DEFINITION,
    UPDATE_DEFINITION.options.filter((option) => option.changes).map((option) => option.name),
  ),
  // Metadata is set once, so only create takes it.
  create: optionsNamed(CREATE_DEFINITION, ['metadata']),
  search: optionsNamed(SEARCH_DEFINITION, ['query', 'direct']),
  list: optionsNamed(LIST_DEFINITION, ['order-by', 'recursive']),
};

const parserContext = { otherCommands: POINTED_OPTIONS };

/** One filter, written as it is typed after --filter. */
const filterExample = (filter: Partial<Record<FilterKey, unknown>>): string =>
  `--filter '${JSON.stringify(filter)}'`;

/**
 * List and search filter instead of taking flags per field, and someone filtering by tag meant the
 * filter, not an update, so the change flags are not pointed at from here.
 */
const listingContext = {
  otherCommands: { search: POINTED_OPTIONS.search, list: POINTED_OPTIONS.list },
  alternatives: {
    tag: `To filter by tag, use ${filterExample({ tags: { $in: ['urgent'] } })}.`,
    tags: `To filter by tag, use ${filterExample({ tags: { $in: ['urgent'] } })}.`,
    type: `To filter by type, use ${filterExample({ type: NODE_TYPES[0] })}.`,
    kind: `To filter by kind, use ${filterExample({ type: RESOURCE_TYPE, kind: RESOURCE_KINDS[0] })}.`,
  },
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
  'path' in subject
    ? `raphael get ${shellArg(forTerminal(subject.path))}`
    : `raphael get --id ${subject.id}`;

/** The path an item named `slug` has inside `parent`. */
const childPath = (parent: string, slug: string): string =>
  `${parent === ROOT_PATH ? '' : parent}/${slug}`;

const parentOf = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? ROOT_PATH : path.slice(0, index);
};

const slugOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Where a move sent by path would have put the item, as checks to run after an unknown outcome. The
 * old path names nothing once the move landed, so it is never the check. A destination that already
 * held a container received the item under its own slug; any other is the item's new path.
 */
const moveChecks = (
  sendTo: Subject,
  destination: string,
): Pick<RequestContext, 'check' | 'checkOtherwise'> => {
  if ('id' in sendTo) return { check: getCommand(sendTo) };
  const inside = getCommand({ path: childPath(destination, slugOf(sendTo.path)) });
  if (destination === ROOT_PATH) return { check: inside };
  return {
    check: getCommand({ path: destination }),
    checkOtherwise: {
      when: `${forTerminal(destination)} was already an area or project`,
      check: inside,
    },
  };
};

/**
 * Labelled fields under a headline, labels padded to one width so the values line up.
 *
 * A value is escaped by the caller when it is server text; a missing or empty one prints `-`, so every
 * field is always present and a reader never has to infer a value from an absent line.
 */
const fields = (entries: ReadonlyArray<readonly [string, string]>, indent = '  '): string[] => {
  const width = Math.max(...entries.map(([name]) => name.length)) + 2;
  return entries.map(
    ([name, value]) => `${indent}${`${name}:`.padEnd(width)}${value === '' ? EMPTY_FIELD : value}`,
  );
};

/** What `fields` prints for an empty value. Text that is exactly this is quoted, so the two differ. */
const EMPTY_FIELD = '-';

/**
 * Whether text printed as it is could be read back as something else: the empty placeholder, a value
 * with a character escaped for the terminal, or one whose own backslash or quote would make an escape
 * or a quoted value ambiguous. Such text is printed as a JSON string instead, which reads back exactly.
 */
const needsQuotes = (text: string): boolean =>
  text === EMPTY_FIELD || forTerminal(text) !== text || /["\\]/u.test(text);

/**
 * Free text as a field value: as it is, unless it could be read back as something else. Titles in
 * rows and headlines are printed the same way, so two titles never print alike.
 */
const textField = (text: string): string =>
  needsQuotes(text) ? forTerminal(JSON.stringify(text)) : text;

const parentLabel = (parentId: number | null): string =>
  parentId === null ? 'top level' : String(parentId);

/**
 * A tag as it can be read back: quoted when it would otherwise be ambiguous, so `a, b` and the two
 * tags `a` and `b` never print the same, a tag spelled `-` never reads as no tags, and a tag holding a
 * tab never reads as one spelled with a backslash.
 */
const tagLabel = (tag: string): string =>
  /^[^\s,][^,]*$/u.test(tag) && tag.trim() === tag && !needsQuotes(tag)
    ? tag
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
        : `through ${cause.origin.type} ${cause.origin.id} ${forTerminal(JSON.stringify(cause.origin.title))}`;
    const who =
      cause.reason === DIRECT_ARCHIVE_REASON
        ? forTerminal(cause.owner)
        : `${forTerminal(cause.owner)}, ${forTerminal(cause.reason)}`;
    return `${indent}${where} (${who})`;
  });

/** An item's path as the server computed it. The CLI always asks; `-` only if a server did not say. */
const pathLabel = (item: Pick<NodeSummary, 'path'>): string =>
  item.path === undefined ? '-' : forTerminal(item.path);

/** Where a write moved an item from, as a field after its path: only when the path did change. */
const wasField = (
  changed: boolean,
  previousPath: string | undefined,
  item: Pick<NodeSummary, 'path'>,
): ReadonlyArray<readonly [string, string]> =>
  changed && previousPath !== undefined && previousPath !== item.path
    ? [['was', forTerminal(previousPath)]]
    : [];

/** The header of a page of rows, printed only on a terminal so piped output is one item per line. */
const ROW_HEADER = ['ID', 'TYPE', 'STATE', 'PATH', 'TITLE'] as const;

/**
 * A page of items as rows: id, type, state, path, title. The fixed state word comes before any free
 * text, and the title is last, so nothing a title says can be read as another column.
 */
const itemRows = (items: readonly NodeSummary[], context: CommandContext): string[] =>
  items.length === 0
    ? []
    : table([
        ...(context.terminal.stdout ? [ROW_HEADER] : []),
        ...items.map((item) => [
          String(item.id),
          qualifiedType(item),
          stateLabel(item),
          pathLabel(item),
          textField(item.title),
        ]),
      ]);

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
  readonly archivedLeftOut: boolean;
}

/** The page window as the JSON envelope carries it. */
const pageData = (page: Page): Record<string, unknown> => ({
  skip: page.skip,
  limit: page.limit,
  hasMore: page.hasMore,
  nextSkip: page.hasMore ? page.skip + page.limit : null,
  archivedLeftOut: page.archivedLeftOut,
});

/**
 * One argument as a POSIX shell reads it back: bare when that is safe, otherwise single-quoted. A
 * leading `=` is quoted too, because zsh expands `=name` to a command's path.
 */
const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/u.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;

/** What a footer changes about the command that was run. */
interface Rerun {
  readonly skip?: number;
  readonly add?: string;
  readonly drop?: string;
}

/**
 * The command that was run, changed only as a footer needs: `--skip` replaced, a flag added or left
 * out. Everything else - page size, order, places, filter, queries - is kept as typed, so following a
 * footer literally asks for the same listing. Arguments after `--` stay after it.
 *
 * `undefined` when an argument holds a character terminal output must escape, such as a newline: the
 * escaped form would run a different command, so none is offered as if it were runnable.
 */
const rerun = (command: string, argv: readonly string[], change: Rerun): string | undefined => {
  if (argv.some((word) => forTerminal(word) !== word)) return undefined;
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const kept: string[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const token = options[index] ?? '';
    if (change.skip !== undefined && token === '--skip') {
      index += 1;
      continue;
    }
    if (change.skip !== undefined && token.startsWith('--skip=')) continue;
    if (token === change.drop) continue;
    kept.push(token);
  }
  if (change.add !== undefined && !kept.includes(change.add)) kept.push(change.add);
  if (change.skip !== undefined && change.skip > 0) kept.push('--skip', String(change.skip));
  const rest = separator === -1 ? [] : argv.slice(separator);
  return ['raphael', command, ...kept, ...rest].map(shellWord).join(' ');
};

/** The same change in words, for when the command cannot be printed runnably. */
const rerunInWords = (change: Rerun): string =>
  [
    ...(change.add === undefined ? [] : [`with ${change.add}`]),
    ...(change.drop === undefined ? [] : [`without ${change.drop}`]),
    ...(change.skip === undefined
      ? []
      : [change.skip > 0 ? `with --skip ${change.skip}` : 'without --skip']),
  ].join(' and ');

/** What a page was asked about, for its notes. */
interface PageScene {
  readonly command: 'list' | 'search' | 'favorites';
  readonly argv: readonly string[];
  /** The places as typed, for list and search. */
  readonly scopes?: readonly ScopeSelector[];
  readonly filtered?: boolean;
  /** Search with --direct. */
  readonly direct?: boolean;
  /** A listing without -r. */
  readonly directList?: boolean;
}

const placesLabel = (scopes: readonly ScopeSelector[]): string =>
  scopes
    .map((scope) => ('id' in scope ? `item ${scope.id}` : forTerminal(scope.path)))
    .join(' or in ');

/**
 * The one line for a page with nothing on it, worded for why it is empty. When archived items were
 * left out it says "that is not archived", so it never calls a place empty when it is not.
 */
const emptyLine = (scene: PageScene, archivedLeftOut: boolean): string => {
  if (scene.command === 'favorites') {
    return archivedLeftOut ? 'No favorites that are not archived.' : 'No favorites.';
  }
  const active = archivedLeftOut ? ' that is not archived' : '';
  const where = placesLabel(scene.scopes ?? []);
  const what =
    scene.command === 'search'
      ? scene.filtered === true
        ? ' matches the queries and the filter'
        : ' matches the queries'
      : scene.filtered === true
        ? ' matches the filter'
        : '';
  return `Nothing in ${where}${active}${what}.`;
};

/**
 * The notes under a page, for a person. They go to stderr: they describe the page, they are not its
 * rows, and `raphael list / | wc -l` must count rows.
 *
 * Never implies completeness. A page that ends is not the same as a hierarchy that ends, and the
 * difference is what tells someone whether to ask for more. Every note that suggests something more
 * gives the whole command to run, on a `hint:` line of its own after the note it follows from: what
 * the page is stays information, and only the next step is a hint.
 */
const pageNotes = (page: Page, scene: PageScene): string[] => {
  // One form for every hint: the command to run, quoted, then what it is for.
  const hint = (purpose: string, change: Rerun): string => {
    const command = rerun(scene.command, scene.argv, change);
    return command === undefined
      ? `hint: Run the same command ${rerunInWords(change)} ${purpose}.`
      : `hint: Run "${command}" ${purpose}.`;
  };
  const notes: string[] = [];
  if (page.items.length > 0) {
    const first = page.skip + 1;
    const last = page.skip + page.items.length;
    const range = `Showing ${first === last ? first : `${first}-${last}`}.`;
    notes.push(
      ...(page.hasMore
        ? [range, hint('for the next page', { skip: page.skip + page.limit })]
        : [`${range} No more.`]),
    );
  } else if (page.skip > 0) {
    notes.push(`Nothing at --skip ${page.skip}.`, hint('to start again', { skip: 0 }));
  } else {
    notes.push(emptyLine(scene, page.archivedLeftOut));
    if (scene.direct === true) {
      notes.push(
        'Only direct children were searched.',
        hint('to search everything underneath', { drop: '--direct' }),
      );
    }
    // Notes usually sit inside projects, so a filter over direct children alone often finds nothing.
    if (scene.directList === true && scene.filtered === true) {
      notes.push(
        'Only direct children were listed.',
        hint('to list everything underneath', { add: '-r' }),
      );
    }
  }
  if (page.archivedLeftOut) {
    const which =
      scene.command !== 'search' ? 'were left out' : page.items.length > 0 ? 'also match' : 'match';
    // From the first page: including archived items changes which items each page holds.
    notes.push(
      `Archived items ${which}.`,
      hint('to include them', { add: '--include-archived', skip: 0 }),
    );
  }
  return notes;
};

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
  readonly includePaths: true;
} => {
  // Every positional is a scope. There is no "unexpected argument" case, because a second path is a
  // second place to look rather than a mistake.
  const scopes = scopesFrom(parsed.positionals, stringListOption(parsed, 'id'), command);
  const recursive =
    command === 'search' ? !booleanOption(parsed, 'direct') : booleanOption(parsed, 'recursive');
  prevalidateFilter(stringOption(parsed, 'filter'), command);
  const skip = integerOption(parsed, 'skip', command);
  const limit = integerOption(parsed, 'limit', command);
  const includeArchived = booleanOption(parsed, 'include-archived');
  const filter = resolveFilter(stringOption(parsed, 'filter'), command);

  return {
    scopes,
    recursive,
    ...(filter === undefined ? {} : { filter }),
    ...(skip === undefined ? {} : { skip }),
    ...(limit === undefined ? {} : { limit }),
    ...(includeArchived ? { includeArchived } : {}),
    includePaths: true,
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

/** How create and update read a body: interrupted by a signal, and saying so when stdin is a terminal. */
const bodyReading = (context: CommandContext): BodyReading => ({
  signal: context.signal,
  stdinIsTerminal: context.terminal.stdin,
  notice: (line) => writeLine(context.streams.err, line),
});

/**
 * The sentence for a refusal that a piped body would have avoided. Standard input is never read to
 * find out whether anything is there, and "not a terminal" also covers `/dev/null` and a closed
 * descriptor, so it is worded as a condition rather than as a claim that something was piped.
 */
const pipedStdinNote = (context: CommandContext): string =>
  context.terminal.stdin
    ? ''
    : ' Standard input is not a terminal; to read the body from it, pass --body @-.';

/**
 * `--strict`, refused where it cannot apply: it checks a Markdown body, so it needs one. Decided from
 * flags alone, before any body is read. `--body-format` says what a body is, so with no body it is
 * refused the same way rather than ignored.
 */
const strictOption = (
  parsed: ParsedArgs,
  bodyFormat: string | undefined,
  command: string,
): boolean => {
  if (bodyFormat !== undefined && !wasGiven(parsed, 'body') && !wasGiven(parsed, 'body-literal')) {
    throw new UsageError('--body-format describes a body; give --body or --body-literal.', command);
  }
  const strict = booleanOption(parsed, 'strict');
  if (!strict) return false;
  if (!wasGiven(parsed, 'body') && !wasGiven(parsed, 'body-literal')) {
    throw new UsageError('--strict checks a body; give --body or --body-literal.', command);
  }
  if (bodyFormat === 'tiptap') {
    throw new UsageError(
      '--strict checks a Markdown body; leave it out with --body-format tiptap.',
      command,
    );
  }
  return true;
};

export const runCreate = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(CREATE_DEFINITION), 'create', parserContext);

  const [typeToken, path, ...extra] = parsed.positionals;
  if (typeToken === undefined) {
    throw new UsageError(`Give a type to create: ${CREATE_TARGETS.join(', ')}.`, 'create');
  }
  const target = parseCreateTarget(typeToken, 'create', path);
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
  const strict = strictOption(parsed, bodyFormat, 'create');
  const body = await resolveBody(
    stringOption(parsed, 'body'),
    stringOption(parsed, 'body-literal'),
    bodyFormat,
    'create',
    bodyReading(context),
  );
  const metadata = resolveMetadata(stringOption(parsed, 'metadata'), 'create');
  const degraded = degradedConstructs(body, strict, 'create');

  // Every creation is named by the caller. A container must be named here; a note may be named from
  // what it already says, the same way every client does it.
  let title = titleFlag;
  if (title === undefined) {
    if (target.type !== 'resource') {
      throw new UsageError(`--title: ${TITLE_REQUIRED} Every container has a name.`, 'create');
    }
    const derived = titleFromContent(body, description ?? '');
    if ('failure' in derived) {
      throw new UsageError(
        `--body could not be read as ${body?.format === 'tiptap' ? 'a TipTap document' : 'Markdown'}, so no title can be taken from it. ${bodyFailureSentence(derived.failure)}`,
        'create',
      );
    }
    if (derived.title === undefined) {
      throw new UsageError(
        body === undefined
          ? `--title: ${TITLE_REQUIRED} No body was given to take one from, and no description.${pipedStdinNote(context)}`
          : `--title: ${TITLE_REQUIRED} The body and description have no text to take one from.`,
        'create',
      );
    }
    title = derived.title;
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
    includePaths: true,
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
      // A listing pages, so it may not show the new item; its parent's path and the slug always do.
      ...('path' in parent
        ? { check: getCommand({ path: path ?? childPath(parent.path, slug) }) }
        : {
            check: `raphael path --id ${parent.id}`,
            checkThen: `raphael get <that path>/${slug}`,
          }),
    });
  }

  const { entity } = result.value;
  return succeeded(context, {
    data: { entity },
    lines: () => [
      `Created ${qualifiedType(entity)} ${entity.id}: ${textField(entity.title)}`,
      ...fields([
        ['path', pathLabel(entity)],
        ['revision', String(entity.revision)],
      ]),
    ],
    warnings:
      degraded.length === 0 ? [] : [degradedWarning(degraded, `raphael get --id ${entity.id}`)],
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
  const revisionFlag = integerOption(parsed, 'revision', 'update');

  // Both usage refusals are decided from flag *presence*, and both come before anything is read or
  // sent. Presence is not an approximation of the resolved value: `--description ""` and `--body ""`
  // are changes precisely because presence is the rule. Deciding them here is what stops
  // `--body @-` with no --revision from making someone type a whole document into a terminal before
  // being told the command was wrong.
  if (!CHANGE_FLAGS.some((flag) => wasGiven(parsed, flag))) {
    throw new UsageError(
      `Give at least one change: ${CHANGE_FLAGS.map((flag) => `--${flag}`).join(', ')}.${pipedStdinNote(context)}`,
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
  const bodyFormat = choiceOption(parsed, 'body-format', 'update', BODY_FORMATS);
  const strict = strictOption(parsed, bodyFormat, 'update');
  const body = await resolveBody(
    stringOption(parsed, 'body'),
    stringOption(parsed, 'body-literal'),
    bodyFormat,
    'update',
    bodyReading(context),
  );
  const degraded = degradedConstructs(body, strict, 'update');
  const changes = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(slug === undefined ? {} : { slug }),
    ...(body === undefined ? {} : { body }),
    ...(tags === undefined ? {} : { tags }),
    ...(active === undefined ? {} : { active }),
    ...(format === undefined ? {} : { format }),
    includePaths: true,
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
      // A new slug sent by path renames the item, so the check reads the path it would now have.
      check: getCommand(
        slug !== undefined && 'path' in pinned.sendTo
          ? { path: childPath(parentOf(pinned.sendTo.path), slug) }
          : pinned.sendTo,
      ),
    });
  }

  const { entity, changed, previousPath } = result.value;
  return succeeded(context, {
    data: { entity, changed, ...(previousPath === undefined ? {} : { previousPath }) },
    lines: () => [
      `${changed ? 'Updated' : 'Unchanged'} ${qualifiedType(entity)} ${entity.id}: ${textField(entity.title)}`,
      ...fields([
        ['path', pathLabel(entity)],
        ...wasField(changed, previousPath, entity),
        ['revision', String(entity.revision)],
      ]),
    ],
    notes: changed ? [] : ['Nothing changed: every value given matches what is stored.'],
    // Only a write stores a body; an unchanged one was stored as it is by an earlier write.
    warnings:
      changed && degraded.length > 0
        ? [degradedWarning(degraded, `raphael get --id ${entity.id}`)]
        : [],
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
  const revisionFlag = integerOption(parsed, 'revision', 'move');

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
    includePaths: true,
  };
  checkRequestSize(writeRequest, 'move', decodeMoveRequest);
  const result = await move(transport, writeRequest, context.signal);

  if (!result.ok) {
    return failed(context, result.failure, {
      ...request,
      revision: { sent: pinned.revision, given: revisionFlag !== undefined, required: false },
      // After a move the old path may name nothing, so the check goes by id whenever there is one.
      ...moveChecks(pinned.sendTo, destinationPath),
    });
  }

  // A move to where it already is succeeds without a change, and says so; the revision is kept.
  const { node, changed, previousPath } = result.value;
  return succeeded(context, {
    data: { node, changed, ...(previousPath === undefined ? {} : { previousPath }) },
    lines: () => [
      `${changed ? 'Moved' : 'Unchanged'} ${qualifiedType(node)} ${node.id}: ${textField(node.title)}`,
      ...fields([
        ['path', pathLabel(node)],
        ...wasField(changed, previousPath, node),
        ['revision', String(node.revision)],
      ]),
    ],
    notes: changed ? [] : [`Nothing changed: it is already at ${pathLabel(node)}.`],
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
  const revisionFlag = integerOption(parsed, 'revision', verb);

  if (revisionFlag !== undefined)
    checkRequestSize({ target, revision: revisionFlag }, verb, decodeLifecycleRequest);
  else checkRequestSize({ target }, verb, decodeGetRequest);
  const transport = context.transport();
  const request: RequestContext = { subject: target, flags: selectorFlags(target) };

  // The convenience read `update` and `move` take, pinning by identifier for the same reason.
  const pinned = await pinRevision(context, transport, target, revisionFlag, request);
  if ('exit' in pinned) return pinned.exit;

  const send = verb === 'archive' ? archive : restore;
  const writeRequest = { target: pinned.sendTo, revision: pinned.revision, includePaths: true };
  checkRequestSize(writeRequest, verb, decodeLifecycleRequest);
  const result = await send(transport, writeRequest, context.signal);
  if (!result.ok) {
    return failed(context, result.failure, {
      ...request,
      revision: { sent: pinned.revision, given: revisionFlag !== undefined, required: false },
      check: getCommand(pinned.sendTo),
    });
  }

  const { node, archiveCauses, changed } = result.value;
  // Archive always ends archived; restore ends either active or still archived by something else.
  // Nothing to add or remove reads "Unchanged", except a restore that leaves the item archived,
  // which says "Still archived" whatever it removed, so nobody assumes it is back in their lists.
  const headline =
    verb === 'restore' && node.archived
      ? 'Still archived'
      : !changed
        ? 'Unchanged'
        : verb === 'archive'
          ? 'Archived'
          : 'Restored';
  // A restore that leaves it archived names the next step: restoring the container it is archived
  // through, which is the nearest cause that is not its own.
  const through = archiveCauses.find((cause) => cause.origin.id !== node.id);
  const notes =
    verb === 'restore' && node.archived && through !== undefined
      ? [
          ...(changed ? [] : ['Nothing changed: it was not archived directly.']),
          `It is archived through ${through.origin.type} ${through.origin.id}.`,
          `hint: Run "raphael restore --id ${through.origin.id}" to restore that ${through.origin.type}.`,
        ]
      : changed
        ? []
        : [
            verb === 'archive'
              ? 'Nothing changed: it was already archived.'
              : 'Nothing changed: it was not archived.',
          ];
  return succeeded(context, {
    data: { node, archiveCauses, changed },
    lines: () => [
      `${headline} ${qualifiedType(node)} ${node.id}: ${textField(node.title)}`,
      ...fields([
        ['path', pathLabel(node)],
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
  const request = { target, includePaths: true };
  checkRequestSize(request, verb, decodeFavoriteRequest);
  const send = wanted ? addFavorite : removeFavorite;
  const result = await send(context.transport(), request, context.signal);
  if (!result.ok) {
    return failed(context, result.failure, {
      subject: target,
      flags: selectorFlags(target),
      check: getCommand(target),
    });
  }

  const { nodeId, isFavorite, changed, node } = result.value;
  const data = { nodeId, isFavorite, changed, node };
  // Removing an id that names nothing succeeds, as absence was asked for; it still says so plainly,
  // so a mistyped id is noticed.
  if (node === null) {
    return succeeded(context, {
      data,
      lines: () => [`No item has id ${nodeId}, so nothing changed.`],
      notes: ['hint: Run "raphael favorites" to see your favorites.'],
    });
  }
  const headline = !changed ? 'Unchanged' : wanted ? 'Favorited' : 'Unfavorited';
  const notes = [
    ...(changed
      ? []
      : [
          wanted
            ? 'Nothing changed: it was already a favorite.'
            : 'Nothing changed: it was not a favorite.',
        ]),
    ...(wanted && node.archived
      ? [
          'It is archived, so raphael favorites leaves it out.',
          'hint: Run "raphael favorites --include-archived" to see it.',
        ]
      : []),
  ];
  return succeeded(context, {
    data,
    lines: () => [
      `${headline} ${qualifiedType(node)} ${node.id}: ${textField(node.title)}`,
      ...fields([
        ['path', pathLabel(node)],
        ['favorite', isFavorite ? 'yes' : 'no'],
      ]),
    ],
    notes,
  });
};

export const runFavorites = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(FAVORITES_DEFINITION), 'favorites');
  if (parsed.positionals.length > 0) {
    throw new UsageError('favorites takes no positional arguments.', 'favorites');
  }
  // The bounds `scopePageFrom` uses: it is the same page window.
  const skip = integerOption(parsed, 'skip', 'favorites');
  const limit = integerOption(parsed, 'limit', 'favorites');
  const includeArchived = booleanOption(parsed, 'include-archived');

  const request = {
    ...(skip === undefined ? {} : { skip }),
    ...(limit === undefined ? {} : { limit }),
    ...(includeArchived ? { includeArchived } : {}),
    includePaths: true,
  };
  checkRequestSize(request, 'favorites', decodeFavoriteListRequest);
  const result = await listFavorites(context.transport(), request, context.signal);
  if (!result.ok) return failed(context, result.failure);

  const page = result.value;
  return succeeded(context, {
    data: { items: page.items, page: pageData(page) },
    lines: () => itemRows(page.items, context),
    notes: pageNotes(page, { command: 'favorites', argv }),
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

  const request = { target, ...(format === undefined ? {} : { format }), includePaths: true };
  checkRequestSize(request, 'get', decodeGetRequest);
  const result = await get(context.transport(), request, context.signal);
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
      const entries = [
        ['path', pathLabel(entity)],
        ['slug', forTerminal(entity.slug)],
        ['parent', parentLabel(entity.parentId)],
        ['revision', String(entity.revision)],
        ['updated', entity.updatedAt],
        ['active', entity.type === 'project' ? (entity.active ? 'yes' : 'no') : '-'],
        ['archived', entity.archived ? 'yes' : 'no'],
        // A note is never a favorite, and `no` is the truthful answer for it.
        ['favorite', entity.isFavorite ? 'yes' : 'no'],
        ['tags', entity.tags.map(tagLabel).join(', ')],
        ['description', textField(entity.description)],
        ['metadata', forTerminal(JSON.stringify(entity.metadata))],
      ] as const;
      const labelled = fields(entries);
      // The causes sit directly under `archived`.
      const afterArchived = entries.findIndex(([name]) => name === 'archived') + 1;
      const lines = [
        `${qualifiedType(entity)} ${entity.id}: ${textField(entity.title)}`,
        ...labelled.slice(0, afterArchived),
        ...causeLines(entity.id, entity.archiveCauses, '    '),
        ...labelled.slice(afterArchived),
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
  const parsed = parseArgs(argv, optionsFor(LIST_DEFINITION), 'list', listingContext);

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
    lines: () => itemRows(page.items, context),
    notes: pageNotes(page, {
      command: 'list',
      argv,
      scopes: scopePage.scopes,
      filtered: scopePage.filter !== undefined,
      directList: scopePage.recursive !== true,
    }),
  });
};

export const runSearch = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(SEARCH_DEFINITION), 'search', listingContext);

  const queries = parseQueries(stringListOption(parsed, 'query'), 'search');
  const scopePage = scopePageFrom(parsed, 'search');
  checkRequestSize({ ...scopePage, queries }, 'search', decodeSearchRequest);

  const result = await search(context.transport(), { ...scopePage, queries }, context.signal);
  if (!result.ok) return failed(context, result.failure, scopeRequest(scopePage.scopes));

  const page = result.value;
  return succeeded(context, {
    // A hit stays wrapped as `{ node }`: the wrapper is where a hit will later say what matched.
    data: { items: page.items, page: pageData(page) },
    // The same rows as a listing: a hit's title is usually what matched, and its path is where it is.
    lines: () =>
      itemRows(
        page.items.map(({ node }) => node),
        context,
      ),
    notes: pageNotes(page, {
      command: 'search',
      argv,
      scopes: scopePage.scopes,
      filtered: scopePage.filter !== undefined,
      direct: scopePage.recursive === false,
    }),
  });
};

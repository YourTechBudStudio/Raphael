/**
 * The five hierarchy commands.
 *
 * Each one assembles a request, sends it, and renders the answer. No hierarchy rule is implemented
 * here and none may be: slug derivation, parentage, conflict detection, and content conversion all
 * belong to the server, and a CLI that reimplemented any of them would be a second authority that
 * could disagree with the first.
 */

import { randomUUID } from 'node:crypto';

import type { ClientFailure, Transport } from '@raphael/client';
import { create, get, getPath, list, update } from '@raphael/client/nodes';
import {
  BODY_FORMATS,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  NODE_ORDER_FIELDS,
  NODE_TYPES,
  ORDER_DIRECTIONS,
  type NodeEntity,
  type NodeSummary,
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
  parseCreateTarget,
  parseId,
  parseOrderBy,
  parseTypes,
  resolveBody,
  resolveMetadata,
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
 * Read the current revision for an update that did not name one, and pin the entity it belongs to.
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
      'Give at least one change: --title, --description, --slug, --body, --add-tag or --remove-tag.',
      'update',
    );
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

export const LIST_HELP = `Usage: raphael list <path> [options]
       raphael list --id <id> [options]

List what is inside an area or project. Use "/" for the root. A note holds nothing, so listing
one is an empty page rather than an error.

Ordering applies to everything in scope before the page is cut, so paging through a sorted
listing is paging through one order rather than sorting each page on its own.

Examples:
  raphael list / -r --types resource --order-by updatedAt:desc --limit 4
  raphael list /work -r --types resource --order-by updatedAt:desc --order-by slug:asc

Options:
      --id <id>       Address by identifier instead of by path.
  -r, --recursive     Include everything underneath, not just direct children.
      --types <list>  Comma-separated: ${NODE_TYPES.join(',')}. Omit for every type.
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
    {
      id: { type: 'string' },
      recursive: { type: 'boolean', short: 'r' },
      types: { type: 'string' },
      'order-by': { type: 'string', multiple: true },
      skip: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    'list',
  );
  const [path, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`, 'list');

  const parent = selectorFrom(path, stringOption(parsed, 'id', 'list'), 'list');
  const recursive = booleanOption(parsed, 'recursive');
  const types = parseTypes(stringOption(parsed, 'types', 'list'), 'list');
  const orderBy = parseOrderBy(stringListOption(parsed, 'order-by'), 'list');
  const skip = integerOption(parsed, 'skip', 'list', { min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = integerOption(parsed, 'limit', 'list', {
    min: LIST_LIMIT_MIN,
    max: LIST_LIMIT_MAX,
  });

  const result = await list(context.transport(), {
    parent,
    ...(recursive ? { recursive } : {}),
    ...(types === undefined ? {} : { types }),
    ...(orderBy === undefined ? {} : { orderBy }),
    ...(skip === undefined ? {} : { skip }),
    ...(limit === undefined ? {} : { limit }),
  });
  if (!result.ok) return reportFailure(context.streams, result.failure);

  if (booleanOption(parsed, 'json')) {
    writeJson(context.streams.out, result.value);
    return EXIT_OK;
  }

  const { out } = context.streams;
  const page = result.value;
  for (const item of page.items) {
    writeLine(
      out,
      `${String(item.id).padStart(6)}  ${qualifiedType(item).padEnd(13)}  ${forTerminal(item.slug)}`,
    );
  }
  // Never implies completeness. A page that ends is not the same as a hierarchy that ends, and the
  // difference is what tells someone whether to ask for more.
  writeLine(
    out,
    page.items.length === 0
      ? `Nothing here (skip ${page.skip}, limit ${page.limit}).`
      : `${page.items.length} shown, skip ${page.skip}, limit ${page.limit}${
          page.hasMore ? `. More available: --skip ${page.skip + page.limit}` : '. No more.'
        }`,
  );
  return EXIT_OK;
};

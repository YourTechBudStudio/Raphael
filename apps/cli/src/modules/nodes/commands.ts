/**
 * The four hierarchy commands.
 *
 * Each one assembles a request, sends it, and renders the answer. No hierarchy rule is implemented
 * here and none may be: slug derivation, parentage, conflict detection, and content conversion all
 * belong to the server, and a CLI that reimplemented any of them would be a second authority that
 * could disagree with the first.
 */

import { randomUUID } from 'node:crypto';

import type { Transport } from '@raphael/client';
import { create, get, getPath, list } from '@raphael/client/nodes';
import { BODY_FORMATS, LIST_LIMIT_MAX, LIST_LIMIT_MIN, NODE_TYPES } from '@raphael/contracts/nodes';

import {
  UsageError,
  booleanOption,
  choiceOption,
  integerOption,
  parseArgs,
  stringListOption,
  stringOption,
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
  isNodeType,
  parseId,
  parseTypes,
  resolveBody,
  resolveMetadata,
  selectorFrom,
  splitCreatePath,
} from './input.ts';

export interface CommandContext {
  readonly streams: Streams;
  readonly transport: () => Transport;
}

export const CREATE_HELP = `Usage: raphael create <type> <path> --title <title> [options]
       raphael create <type> --parent-id <id> --slug <slug> --title <title> [options]

Create an area or a project. The path form splits a complete absolute path into the parent it
goes under and the slug it will occupy, so "/work/raphael/backend" creates "backend" under
"/work/raphael". The id form addresses the parent by its durable identifier instead.

Types: ${NODE_TYPES.join(', ')}

Options:
      --title <text>         Required. The human name.
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

  const [type, path, ...extra] = parsed.positionals;
  if (type === undefined) {
    throw new UsageError(`Give a type to create: ${NODE_TYPES.join(' or ')}.`, 'create');
  }
  if (!isNodeType(type)) {
    throw new UsageError(
      `"${type}" is not something Raphael can create. Give ${NODE_TYPES.join(' or ')}.`,
      'create',
    );
  }
  if (extra.length > 0) {
    throw new UsageError(`Unexpected argument "${extra[0]}".`, 'create');
  }

  const title = stringOption(parsed, 'title', 'create');
  if (title === undefined) {
    throw new UsageError('--title is required. Every container has a name.', 'create');
  }

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

  const request = {
    type,
    parent,
    slug,
    title,
    idempotencyKey,
    ...(description === undefined ? {} : { description }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(body === undefined ? {} : { body }),
    ...(format === undefined ? {} : { format }),
  };

  const dispatchedAt = new Date();
  const result = await create(context.transport(), request);

  if (!result.ok) {
    return reportFailure(context.streams, result.failure, {
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
      `Created ${entity.type} ${entity.id}: ${forTerminal(entity.title)}`,
    );
    writeLine(context.streams.out, `  slug: ${forTerminal(entity.slug)}`);
  }
  return EXIT_OK;
};

export const GET_HELP = `Usage: raphael get <path> [options]
       raphael get --id <id> [options]

Read one area or project.

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
  writeLine(out, `${entity.type} ${entity.id}  (revision ${entity.revision})`);
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

Print the current full path of an area or project. Paths change when things are renamed
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

List what is inside an area or project. Use "/" for the root.

Options:
      --id <id>       Address by identifier instead of by path.
  -r, --recursive     Include everything underneath, not just direct children.
      --types <list>  Comma-separated: ${NODE_TYPES.join(',')}. Omit for every type.
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
  const skip = integerOption(parsed, 'skip', 'list', { min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = integerOption(parsed, 'limit', 'list', {
    min: LIST_LIMIT_MIN,
    max: LIST_LIMIT_MAX,
  });

  const result = await list(context.transport(), {
    parent,
    ...(recursive ? { recursive } : {}),
    ...(types === undefined ? {} : { types }),
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
      `${String(item.id).padStart(6)}  ${item.type.padEnd(7)}  ${forTerminal(item.slug)}`,
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

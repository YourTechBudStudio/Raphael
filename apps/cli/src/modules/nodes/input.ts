/** Command-line adaptation and local checks through the shared contracts inspectors. */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEGRADED_CONSTRUCT_DESCRIPTIONS,
  createEmptyDocument,
  type ContentFailure,
  type DegradedConstruct,
} from '@raphael/content';
import { fromMarkdown, importMarkdown } from '@raphael/content/conversion';
import { canonicalizeDocument, deriveTitle } from '@raphael/content/schema';
import { REQUEST_MAX_BYTES, isJsonObject, type Decoder, type JsonObject } from '@raphael/contracts';
import {
  CONTAINER_TYPES,
  DESCRIPTION_MAX_CODE_POINTS,
  DocumentTransportInput,
  SCOPES_MAX_COUNT,
  SEARCH_QUERIES_MAX_COUNT,
  SLUG_MAX_CODE_POINTS,
  SLUG_GRAMMAR_DESCRIPTION,
  inspectTitleInput,
  inspectTagsInput,
  inspectMetadataInput,
  normalizeTag,
  isCanonicalSlug,
  NODE_ORDER_FIELDS,
  NodeOrderBy,
  ORDER_DIRECTIONS,
  RESOURCE_KINDS,
  ROOT_PATH,
  describeFilterRejection,
  describePathRejection,
  describeQueryRejection,
  inspectFilterInput,
  inspectQueryInput,
  parsePath,
  type ContainerType,
  type NodeFilterInput,
  type NodeOrderBy as NodeOrderByType,
  type ResourceKind,
  type ScopeSelector,
  type TipTapDocumentTransport,
} from '@raphael/contracts/nodes';
import { Either, Schema } from 'effect';

import { UsageError } from '../../shared/args.ts';
import { readStandardInput } from '../../shared/stdin.ts';
import type { Warning } from '../../shared/success.ts';

/** What `raphael create <type>` was asked to make. */
export type CreateTarget =
  | { readonly type: ContainerType }
  | { readonly type: 'resource'; readonly kind: ResourceKind };

/** Every token the create command accepts, in the order the help lists them. */
export const CREATE_TARGETS: readonly string[] = [
  ...CONTAINER_TYPES,
  ...RESOURCE_KINDS.map((kind) => `resource.${kind}`),
];

/**
 * Parse the positional type token: `area`, `project`, or `resource.note`.
 *
 * The dotted form is kind selection data in a fixed command, not a plugin namespace. Both halves are
 * checked against the contract's own vocabularies, and no unknown base is accepted on the assumption
 * that a server might know it - a token this build cannot describe is a usage error here rather than a
 * round trip that fails with a less specific message.
 *
 * A second dot is refused rather than split, so `resource.note.extra` is an error instead of a silently
 * accepted prefix that would create something other than what was typed.
 */
export const parseCreateTarget = (token: string, command: string): CreateTarget => {
  const refuse = (): never => {
    throw new UsageError(
      `"${token}" is not something Raphael can create. Give ${CREATE_TARGETS.join(', ')}.${token === 'note' ? ' Did you mean resource.note?' : ''}`,
      command,
    );
  };

  const parts = token.split('.');
  const [base, kind] = parts;

  if (parts.length === 1) {
    if (base === undefined || !(CONTAINER_TYPES as readonly string[]).includes(base))
      return refuse();
    return { type: base as ContainerType };
  }
  if (parts.length !== 2) return refuse();
  if (base !== 'resource') return refuse();
  if (kind === undefined || !(RESOURCE_KINDS as readonly string[]).includes(kind)) return refuse();
  return { type: 'resource', kind: kind as ResourceKind };
};

/**
 * Parse repeatable `--order-by field:direction` into the shared ordering array.
 *
 * Occurrence order is priority order, so repeated flags are preserved in sequence rather than the last
 * one winning. The grammar is deliberately strict: exactly one colon, a case-sensitive field, and an
 * explicit direction. No implicit direction, no comma-separated form, no whitespace tolerance - each
 * would be a second spelling of the same request, and the one thing a sort order must be is
 * unambiguous.
 *
 * The assembled array is then validated with the shared schema rather than by hand, so the duplicate,
 * size, and vocabulary rules cannot drift from the ones the server applies. No raw SQL, and nothing
 * beyond a validated clause list, ever leaves here.
 */
export const parseOrderBy = (
  values: readonly string[],
  command: string,
): NodeOrderByType | undefined => {
  if (values.length === 0) return undefined;

  const clauses = values.map((value) => {
    const parts = value.split(':');
    if (parts.length !== 2) {
      throw new UsageError(
        '--order-by takes field:direction, for example --order-by updatedAt:desc.',
        command,
      );
    }
    const [field, direction] = parts;
    if (field === undefined || !(NODE_ORDER_FIELDS as readonly string[]).includes(field)) {
      throw new UsageError(
        `--order-by must name ${NODE_ORDER_FIELDS.join(', ')}; for example --order-by updatedAt:desc.`,
        command,
      );
    }
    if (direction === undefined || !(ORDER_DIRECTIONS as readonly string[]).includes(direction)) {
      throw new UsageError(
        `--order-by direction must be ${ORDER_DIRECTIONS.join(' or ')}; for example --order-by updatedAt:desc.`,
        command,
      );
    }
    return { field, direction };
  });

  const decoded = Schema.decodeUnknownEither(NodeOrderBy)(clauses);
  if (decoded._tag === 'Left') {
    throw new UsageError(
      `--order-by must name at most ${NODE_ORDER_FIELDS.length} fields and must not repeat one.`,
      command,
    );
  }
  return decoded.right;
};

/** An entity selector: exactly one of an id or a path. */
export type Selector = { readonly id: number } | { readonly path: string };

/**
 * Read a selector from a positional path and an `--id` flag, refusing ambiguity.
 *
 * Both or neither is an error rather than a precedence rule. A command that silently preferred one
 * would act on a different entity than the one the other argument named.
 */
export const selectorFrom = (
  positional: string | undefined,
  id: string | undefined,
  command: string,
): Selector => {
  if (positional !== undefined && id !== undefined) {
    throw new UsageError(
      `Give either a path or --id, not both. Got "${positional}" and --id ${id}.`,
      command,
    );
  }
  if (id !== undefined) return { id: parseId(id, command) };
  if (positional !== undefined) {
    validatePath(positional, command, 'path');
    if (positional === ROOT_PATH)
      throw new UsageError('The root path cannot select an item.', command);
    return { path: positional };
  }
  throw new UsageError(`Give a path, or --id.`, command);
};

/**
 * A move's destination, checked for grammar only and returned exactly as typed.
 *
 * `parsePath` here is the reasoning `scopesFrom` gives: the same verdict the request decoder would
 * reach, early enough to say what was wrong with *this* argument. Nothing else is decided. Whether the
 * destination exists, and whether it names a container or a new address, is the server's to decide
 * against its current state, so the string is neither split nor resolved - `splitCreatePath` is the
 * create command's grammar and deliberately not used.
 */
export const destinationFrom = (raw: string | undefined, command: string): string => {
  if (raw === undefined) {
    throw new UsageError(
      'Give a destination: an existing area or project, or the new full path.',
      command,
    );
  }
  const parsed = parsePath(raw);
  if (Either.isLeft(parsed)) {
    throw new UsageError(`destination "${raw}": ${describePathRejection(parsed.left)}`, command);
  }
  return raw;
};

/**
 * Parse an id strictly.
 *
 * `Number()` would accept `4.0`, `4e0`, ` 4 `, and `0x4`, all of which would then be sent as a
 * different value than the one that was typed, or rejected by the server with a confusing message.
 */
export const parseId = (raw: string, command: string, flag = '--id'): number => {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new UsageError(`${flag} must be a positive whole number.`, command);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new UsageError(`${flag} is too large to be an identifier.`, command);
  }
  return value;
};

export interface SplitPath {
  readonly parent: { readonly path: string };
  readonly slug: string;
}

/**
 * Split a complete absolute path into the parent it goes under and the slug it will occupy.
 *
 * `/work` becomes the root plus `work`; `/work/raphael/backend` becomes `/work/raphael` plus
 * `backend`. Both halves go to the server unexamined beyond this split - the slug is not validated
 * here, because the canonical grammar belongs to the contracts and the conflict rules belong to the
 * server, and a second opinion in the CLI could only ever disagree with them.
 */
export const splitCreatePath = (raw: string, command: string): SplitPath => {
  validatePath(raw, command, 'path');
  if (!raw.startsWith('/')) {
    throw new UsageError(`A path must be absolute, starting with "/". Got "${raw}".`, command);
  }
  if (raw === ROOT_PATH) {
    throw new UsageError('The root is not something that can be created.', command);
  }
  const index = raw.lastIndexOf('/');
  const parentPath = index === 0 ? ROOT_PATH : raw.slice(0, index);
  const slug = raw.slice(index + 1);
  if (slug === '') {
    throw new UsageError(`A path must not end with "/". Got "${raw}".`, command);
  }
  validateSlug(slug, command, 'path slug');
  return { parent: { path: parentPath }, slug };
};

/**
 * Where a body came from.
 *
 * `--body @file` reads a file, `--body @-` reads standard input, `--body text` is the text itself, and
 * `--body-literal text` is text that begins with `@` and must not be read as a path. A local path is
 * never content unless it came through `--body-literal`, so a file that does not exist is an error
 * rather than a body that happens to look like a filename.
 */
export type BodySource =
  | { readonly format: 'markdown'; readonly value: string }
  /**
   * A TipTap body carries the *parsed* document, not the text it was parsed from. The shared contract
   * requires an object here; sending the JSON string would be rejected by the request decoder before
   * the transport was ever reached, which is a body that can never be submitted at all.
   */
  | { readonly format: 'tiptap'; readonly value: TipTapDocumentTransport };

/**
 * Decode bytes as UTF-8, fatally.
 *
 * `Buffer.toString('utf8')` substitutes U+FFFD for invalid bytes, which would take a corrupt file and
 * quietly store altered content under a successful creation. The server applies the same fatal decode
 * to request bodies; doing it here means the mismatch is reported against the file the person named,
 * rather than as a field error about content they did not write.
 */
const decodeUtf8 = (bytes: Uint8Array, label: string, command: string): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError(`${label} is not valid UTF-8.`, command);
  }
};

/**
 * Read a body from standard input, refusing an empty one.
 *
 * Zero bytes is almost never a body someone meant to send. It is what `gen | raphael update ... --body
 * @-` receives when `gen` failed, and what a closed or `/dev/null` standard input supplies, and sending
 * it would replace a note's body with nothing under a successful exit. Clearing a body on purpose has
 * its own explicit spelling, so the empty case can be refused without losing anything.
 */
const readStdin = async (command: string, reading: BodyReading): Promise<string> => {
  const { signal } = reading;
  // A terminal gives no sign that anything is waiting; a pipe needs no instructions.
  if (reading.stdinIsTerminal === true) {
    reading.notice?.(
      'Reading the body from standard input. Finish with Ctrl-D, or Ctrl-C to cancel.',
    );
  }
  const bytes = await readStandardInput({
    limit: REQUEST_MAX_BYTES,
    tooLarge: () =>
      new UsageError(
        `The body on standard input is larger than the ${REQUEST_MAX_BYTES}-byte request limit.`,
        command,
      ),
    signal,
  });
  if (bytes.byteLength === 0) {
    throw new UsageError(
      `--body @- read nothing: standard input was empty. ${
        command === 'update'
          ? "To clear the body on purpose, give --body '' --revision <n>."
          : 'To create it without a body, leave out --body.'
      }`,
      command,
    );
  }
  return decodeUtf8(bytes, 'The body on standard input', command);
};

/**
 * Read a local file under the request budget.
 *
 * The bound is enforced *while reading*, against the descriptor that was opened, rather than by
 * checking `stat().size` and then reading the path again. Those are two different things: a file can
 * grow between the two, a path can be replaced between the two, and a FIFO or character device
 * reports a size of zero while supplying bytes without end. Reading a fixed budget from one open
 * descriptor is bounded whatever the entry turns out to be.
 */
export const readLocalFile = (path: string, label: string, command: string): string => {
  path = resolve(path);
  let fd: number;
  try {
    // `O_NONBLOCK` is what makes the type check below reachable. Opening a FIFO for reading blocks
    // until a writer appears, so without it the command hangs on the open and never gets as far as
    // discovering that the path is not a regular file. It has no effect on an ordinary file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'does not exist'
        : code === 'EACCES' || code === 'EPERM'
          ? 'permission denied'
          : 'cannot be opened';
    throw new UsageError(
      `${label} at "${path}" ${reason}. Use --body-literal for text beginning with @.`,
      command,
    );
  }

  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new UsageError(
        `${label} at "${path}" is not a regular file. Pipe it through standard input with @- instead.`,
        command,
      );
    }

    // One byte past the budget, so exceeding it is observed rather than inferred from a full buffer.
    const buffer = Buffer.allocUnsafe(REQUEST_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total > REQUEST_MAX_BYTES) {
        throw new UsageError(
          `${label} at "${path}" is larger than the ${REQUEST_MAX_BYTES}-byte request limit.`,
          command,
        );
      }
    }
    return decodeUtf8(buffer.subarray(0, total), `${label} at "${path}"`, command);
  } finally {
    closeSync(fd);
  }
};

/** How a body is read: what interrupts the wait, and where a note for the person goes. */
export interface BodyReading {
  readonly signal?: AbortSignal | undefined;
  /** Whether standard input is a terminal, from `isTTY` alone. */
  readonly stdinIsTerminal?: boolean;
  /** A line for the person, on standard error. */
  readonly notice?: (line: string) => void;
}

/**
 * Whether Markdown text is really a TipTap document: a JSON object whose `type` is `doc`.
 *
 * Sent as Markdown it would be stored as a paragraph of JSON, and the command would succeed. The
 * check is the same whichever way the text arrived, because the mistake is the format, not the source.
 */
const looksLikeTipTapDocument = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isJsonObject(value) && value['type'] === 'doc';
  } catch {
    return false;
  }
};

export const resolveBody = async (
  body: string | undefined,
  bodyLiteral: string | undefined,
  format: 'markdown' | 'tiptap' | undefined,
  command: string,
  reading: BodyReading = {},
): Promise<BodySource | undefined> => {
  if (body !== undefined && bodyLiteral !== undefined) {
    throw new UsageError('Give either --body or --body-literal, not both.', command);
  }

  const chosen = format ?? 'markdown';
  let text: string | undefined;

  if (bodyLiteral !== undefined) {
    text = bodyLiteral;
  } else if (body !== undefined) {
    if (body === '@-') text = await readStdin(command, reading);
    else if (body.startsWith('@')) text = readLocalFile(body.slice(1), 'the body file', command);
    else text = body;
  }

  if (text === undefined) return undefined;

  if (chosen === 'markdown') {
    if (looksLikeTipTapDocument(text)) {
      throw new UsageError(
        `${bodyLiteral === undefined ? '--body' : '--body-literal'} looks like a TipTap document, but it would be stored as Markdown text. Add --body-format tiptap to send it as a document. To keep JSON as note text, put it in a fenced code block.`,
        command,
      );
    }
    return { format: 'markdown', value: text };
  }

  // Parsed here, and the *parsed value* is what travels. Verifying the syntax and then sending the
  // original string would produce a request the shared contract can never accept, since a TipTap body
  // is an object. Parsing locally also means a malformed document is a usage error before a round
  // trip rather than a rejection after one.
  const document = parseJson(text, '--body', command);
  if (Either.isLeft(Schema.decodeUnknownEither(DocumentTransportInput)(document))) {
    throw new UsageError(
      '--body must be a TipTap document object with type doc and optional array content.',
      command,
    );
  }
  // A compile-time bridge across a runtime-validated boundary, not a claim about the document. What
  // was parsed is arbitrary JSON; the shared request decoder checks it against the document schema
  // before anything is sent, and reports the offending field if it does not match. Re-implementing
  // that check here would be a second opinion about a contract that already has one.
  return { format: 'tiptap', value: document as TipTapDocumentTransport };
};

/** Parse a metadata argument: inline JSON, or `@file`. Must be a JSON object. */
export const resolveMetadata = (
  raw: string | undefined,
  command: string,
): JsonObject | undefined => {
  if (raw === undefined) return undefined;
  prevalidateMetadata(raw, command);
  const text = raw.startsWith('@')
    ? readLocalFile(raw.slice(1), 'the metadata file', command)
    : raw;
  const parsed = parseJson(text, '--metadata', command);
  const rejection = inspectMetadataInput(parsed);
  if (rejection !== undefined)
    throw new UsageError(`--metadata: ${sentence(rejection.detail)}`, command);
  if (!isJsonObject(parsed)) throw new UsageError('--metadata must be a JSON object.', command);
  return parsed;
};

/**
 * Assemble the scopes a page request searches: every positional path, then every `--id`.
 *
 * `selectorFrom`'s "exactly one of path or id" rule does not apply here and is not a weaker version of
 * it. A scope page takes a *union*, so naming two places is the feature rather than the ambiguity, and
 * the two spellings compose: `raphael search /work --id 9` asks about both. Repetition and the count
 * bound are the contract's, which is where they are defined.
 *
 * The order is what makes a failure reportable. The server reports an unresolvable scope by its index
 * in the list it received, so the list has to be assembled in one stated order rather than in the order
 * the flags happened to appear.
 */
export const scopesFrom = (
  positionals: readonly string[],
  ids: readonly string[],
  command: string,
): readonly ScopeSelector[] => {
  const scopes: ScopeSelector[] = [
    ...positionals.map((path) => {
      // `parsePath` is not a second opinion about addressing: `ScopePath` filters on
      // `isCanonicalPath`, which *is* `Either.isRight(parsePath(value))`. Asking it here reaches the
      // same verdict the request decoder would, early enough to say which scope was wrong and why.
      // Without it the decoder answers for a union of two selector shapes, and someone who forgot the
      // leading slash is told an `id` was expected - true of the union, and useless to them.
      validatePath(path, command, 'path');
      // The original string travels, not a path rebuilt from the segments. `parsePath` refuses a
      // noncanonical path rather than repairing one, so there is nothing to rebuild and rebuilding
      // would be the rewriting it exists to prevent.
      return { path };
    }),
    ...ids.map((id) => ({ id: parseId(id, command) })),
  ];
  if (scopes.length === 0) throw new UsageError('Give at least one path, or --id.', command);
  if (scopes.length > SCOPES_MAX_COUNT)
    throw new UsageError(
      `Paths and --id take at most ${SCOPES_MAX_COUNT} targets in total.`,
      command,
    );
  if (new Set(scopes.map((value) => JSON.stringify(value))).size !== scopes.length)
    throw new UsageError('Paths and --id must not repeat a target.', command);
  return scopes;
};

/**
 * Parse a `--filter` argument: inline JSON, or `@file`. Must be a filter the contract accepts.
 *
 * This follows `resolveMetadata` exactly, and returns the *parsed JSON* rather than a decoded value.
 * The request decoder in the client package is the one that normalizes it; a second normalization here
 * would be a second authority over the same shape.
 *
 * The check is `inspectFilterInput` alone, deliberately, and not a local `Schema.decodeUnknownEither`
 * over `NodeFilter`. Strictness about unrecognized keys lives in the contracts' `requestDecoder`, not
 * in the schema, so a bare decode here would *ignore* an unsupported key and quietly send a filter with
 * it removed - which is a narrower question than the one that was asked, answered without saying so.
 * `inspectFilterInput` owns all three failure classes and routes each known key through the same
 * decoders `NodeFilter` is assembled from, so its verdict and the request decoder's cannot disagree.
 *
 * An empty object passes and means no restriction, exactly as omitting the flag does. There is nothing
 * to refuse about asking for everything.
 */
export const resolveFilter = (
  raw: string | undefined,
  command: string,
): NodeFilterInput | undefined => {
  if (raw === undefined) return undefined;
  prevalidateFilter(raw, command);
  const text = raw.startsWith('@') ? readLocalFile(raw.slice(1), 'the filter file', command) : raw;
  const parsed = parseJson(text, '--filter', command);

  const rejection = inspectFilterInput(parsed);
  if (rejection !== undefined) {
    throw new UsageError(`--filter: ${sentence(describeFilterRejection(rejection))}`, command);
  }
  // A compile-time bridge across a runtime-checked boundary. `inspectFilterInput` has just established
  // that the value carries only the keys this filter owns, each with a value its own decoder accepts.
  return parsed as NodeFilterInput;
};

/**
 * Check each repeated `-q` against the shared grammar, and pass every value through unchanged.
 *
 * The CLI never rewrites a query. It does not add operators, strip punctuation, or normalize spacing:
 * the grammar belongs to the contracts and its translation into an engine match string belongs to the
 * server, and a query altered in between would search for something other than what was typed.
 *
 * The rejection sentence is `describeQueryRejection`'s, which is fixed text per reason. Assembling a
 * message around the submitted query would put caller text into terminal output for no gain - the
 * person can see what they typed.
 */
export const parseQueries = (values: readonly string[], command: string): readonly string[] => {
  if (values.length === 0) throw new UsageError('Give at least one -q query.', command);
  if (values.length > SEARCH_QUERIES_MAX_COUNT)
    throw new UsageError(`-q takes at most ${SEARCH_QUERIES_MAX_COUNT} queries.`, command);
  for (const value of values) {
    const rejection = inspectQueryInput(value);
    if (rejection !== undefined) {
      throw new UsageError(`-q: ${sentence(describeQueryRejection(rejection))}`, command);
    }
  }
  return values;
};

/**
 * A title from what a note already says, derived exactly as every client derives it: the body's
 * first line, then the description's. A body that cannot be converted is reported as that, not as a
 * body with nothing to name the note by: the two need different fixes.
 */
export const titleFromContent = (
  body: BodySource | undefined,
  description: string,
):
  | { readonly title: string }
  | { readonly failure: ContentFailure }
  | { readonly title?: undefined } => {
  const document =
    body === undefined
      ? Either.right(createEmptyDocument())
      : body.format === 'markdown'
        ? fromMarkdown(body.value)
        : canonicalizeDocument(body.value);
  if (Either.isLeft(document)) return { failure: document.left };
  const title = deriveTitle(document.right, description);
  return title === undefined ? {} : { title };
};

/** `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;

/**
 * The Markdown constructs this body would be stored without, as `@raphael/content` converts it - the
 * same conversion the server runs. With `strict` they are a refusal; otherwise they are returned for a
 * warning once the write succeeds. A body that does not convert at all is left to the server, which
 * refuses it with its own reason.
 */
export const degradedConstructs = (
  body: BodySource | undefined,
  strict: boolean,
  command: string,
): readonly DegradedConstruct[] => {
  if (body?.format !== 'markdown') return [];
  const converted = importMarkdown(body.value);
  if (Either.isLeft(converted)) return [];
  const { degraded } = converted.right;
  if (strict && degraded.length > 0) {
    throw new UsageError(
      `--strict: the body has ${listed(degraded.map((construct) => DEGRADED_CONSTRUCT_DESCRIPTIONS[construct].name))}, which Raphael cannot store as written. Change the body, or leave out --strict to store it anyway.`,
      command,
    );
  }
  return degraded;
};

/** The warning for a stored body that lost constructs, naming what each became and where to look. */
export const degradedWarning = (
  degraded: readonly DegradedConstruct[],
  readCommand: string,
): Warning => ({
  code: 'markdown_degraded',
  constructs: degraded,
  message: `The body was stored with changes: ${keptAs(degraded)}. Run "${readCommand}" to see the stored body, or use --strict to refuse such a body.`,
});

/** `a table was kept as …; an image and raw HTML were kept as plain text`, grouped by what was kept. */
const keptAs = (degraded: readonly DegradedConstruct[]): string => {
  const groups = new Map<string, string[]>();
  for (const construct of degraded) {
    const { name, kept } = DEGRADED_CONSTRUCT_DESCRIPTIONS[construct];
    groups.set(kept, [...(groups.get(kept) ?? []), name]);
  }
  return [...groups]
    .map(
      ([kept, names]) => `${listed(names)} ${names.length === 1 ? 'was' : 'were'} kept as ${kept}`,
    )
    .join('; ');
};

const sentence = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/[.]$/, '')}.`;

const validatePath = (raw: string, command: string, flag: string): void => {
  const result = parsePath(raw);
  if (Either.isLeft(result)) {
    const candidate = raw.normalize('NFC').toLowerCase();
    const hint =
      candidate !== raw && Either.isRight(parsePath(candidate)) ? ` Try "${candidate}".` : '';
    throw new UsageError(
      `${flag}: ${sentence(describePathRejection(result.left))}${hint}`,
      command,
    );
  }
};

export const validateSlug = (raw: string | undefined, command: string, flag = '--slug'): void => {
  if (raw === undefined || isCanonicalSlug(raw)) return;
  const candidate = raw.normalize('NFC').toLowerCase();
  throw new UsageError(
    `${flag} must follow this grammar: ${SLUG_GRAMMAR_DESCRIPTION}; at most ${SLUG_MAX_CODE_POINTS} characters.${candidate !== raw && isCanonicalSlug(candidate) ? ` Try "${candidate}".` : ''}`,
    command,
  );
};

export const validateTitle = (raw: string | undefined, command: string): void => {
  if (raw === undefined) throw new UsageError('--title is required.', command);
  const rejection = inspectTitleInput(raw);
  if (rejection !== undefined)
    throw new UsageError(
      rejection.reason === 'title_too_long'
        ? `--title must be at most ${rejection.limit} characters after trimming.`
        : '--title must not be empty.',
      command,
    );
};

export const validateDescription = (raw: string | undefined, command: string): void => {
  if (raw !== undefined && [...raw].length > DESCRIPTION_MAX_CODE_POINTS)
    throw new UsageError(
      `--description must be at most ${DESCRIPTION_MAX_CODE_POINTS} characters.`,
      command,
    );
};

export const validateTags = (values: readonly string[], command: string, flag = '--tag'): void => {
  if (values.some((value) => value.includes(',')))
    throw new UsageError(
      `${flag} does not accept commas inside a tag. Give each tag its own --tag.`,
      command,
    );
  const rejection = inspectTagsInput(values.map(normalizeTag));
  if (rejection !== undefined) {
    const rule =
      rejection.reason === 'tags_too_many'
        ? `takes at most ${rejection.limit} tags`
        : rejection.reason === 'tag_too_long'
          ? `takes tags of at most ${rejection.limit} characters`
          : rejection.reason === 'tags_repeat'
            ? 'must not repeat a tag'
            : 'must not contain an empty tag';
    throw new UsageError(`${flag} ${rule}.`, command);
  }
};

export const validateBodyArguments = (
  body: string | undefined,
  literal: string | undefined,
  command: string,
): void => {
  if (body !== undefined && literal !== undefined)
    throw new UsageError('Give either --body or --body-literal, not both.', command);
};

/** Locate the first syntax failure without depending on engine-specific JSON error prose. */
const jsonSyntaxOffset = (text: string): number => {
  type Expected =
    | 'value'
    | 'array-first'
    | 'array-next'
    | 'object-first'
    | 'object-key'
    | 'object-next'
    | 'colon'
    | 'end';
  const expected: Expected[] = ['end', 'value'];
  let cursor = 0;
  const whitespace = (): void => {
    while (cursor < text.length && /[\x20\t\r\n]/.test(text[cursor] ?? '')) cursor += 1;
  };
  const string = (): number | undefined => {
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === '"') {
        cursor += 1;
        return undefined;
      }
      if (text.charCodeAt(cursor) < 0x20) return cursor;
      if (character === '\\') {
        cursor += 1;
        const escape = text[cursor];
        if (escape === 'u') {
          for (let digit = 0; digit < 4; digit += 1) {
            cursor += 1;
            if (!/[0-9a-f]/i.test(text[cursor] ?? '')) return cursor;
          }
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return cursor;
      }
      cursor += 1;
    }
    return cursor;
  };
  while (expected.length > 0) {
    whitespace();
    const next = expected.pop();
    const character = text[cursor];
    switch (next) {
      case 'end':
        if (cursor !== text.length) return cursor;
        break;
      case 'colon':
        if (character !== ':') return cursor;
        cursor += 1;
        break;
      case 'object-first':
        if (character === '}') {
          cursor += 1;
          break;
        }
        expected.push('object-key');
        break;
      case 'object-key': {
        if (character !== '"') return cursor;
        const failure = string();
        if (failure !== undefined) return failure;
        expected.push('object-next', 'value', 'colon');
        break;
      }
      case 'object-next':
        if (character === '}') {
          cursor += 1;
          break;
        }
        if (character !== ',') return cursor;
        cursor += 1;
        expected.push('object-key');
        break;
      case 'array-first':
        if (character === ']') {
          cursor += 1;
          break;
        }
        expected.push('array-next', 'value');
        break;
      case 'array-next':
        if (character === ']') {
          cursor += 1;
          break;
        }
        if (character !== ',') return cursor;
        cursor += 1;
        expected.push('array-next', 'value');
        break;
      case 'value': {
        if (character === '{' || character === '[') {
          cursor += 1;
          expected.push(character === '{' ? 'object-first' : 'array-first');
        } else if (character === '"') {
          const failure = string();
          if (failure !== undefined) return failure;
        } else if (character === 't' || character === 'f' || character === 'n') {
          const literal = character === 't' ? 'true' : character === 'f' ? 'false' : 'null';
          for (const letter of literal) {
            if (text[cursor] !== letter) return cursor;
            cursor += 1;
          }
        } else {
          if (character === '-') cursor += 1;
          if (text[cursor] === '0') cursor += 1;
          else {
            if (!/[1-9]/.test(text[cursor] ?? '')) return cursor;
            do {
              cursor += 1;
            } while (/\d/.test(text[cursor] ?? ''));
          }
          if (text[cursor] === '.') {
            cursor += 1;
            if (!/\d/.test(text[cursor] ?? '')) return cursor;
            do {
              cursor += 1;
            } while (/\d/.test(text[cursor] ?? ''));
          }
          if (text[cursor] === 'e' || text[cursor] === 'E') {
            cursor += 1;
            if (text[cursor] === '+' || text[cursor] === '-') cursor += 1;
            if (!/\d/.test(text[cursor] ?? '')) return cursor;
            do {
              cursor += 1;
            } while (/\d/.test(text[cursor] ?? ''));
          }
        }
        break;
      }
    }
  }
  return cursor;
};

/** Parse syntax without quoting submitted JSON in diagnostics. */
const parseJson = (text: string, flag: string, command: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    const offset = jsonSyntaxOffset(text);
    const prefix = text.slice(0, offset);
    const line = prefix.split('\n').length;
    const column = offset - prefix.lastIndexOf('\n');
    throw new UsageError(
      `${flag} must be valid JSON: syntax error at line ${line}, column ${column}.`,
      command,
    );
  }
};

export const prevalidateMetadata = (raw: string | undefined, command: string): void => {
  if (raw === undefined) return;
  if (raw === '@-')
    throw new UsageError('--metadata does not accept @-. Give inline JSON or @file.', command);
  if (raw.startsWith('@')) return;
  const rejection = inspectMetadataInput(parseJson(raw, '--metadata', command));
  if (rejection !== undefined)
    throw new UsageError(`--metadata: ${sentence(rejection.detail)}`, command);
};

export const prevalidateFilter = (raw: string | undefined, command: string): void => {
  if (raw === undefined) return;
  if (raw === '@-')
    throw new UsageError('--filter does not accept @-. Give inline JSON or @file.', command);
  if (raw.startsWith('@')) return;
  const rejection = inspectFilterInput(parseJson(raw, '--filter', command));
  if (rejection !== undefined)
    throw new UsageError(`--filter: ${sentence(describeFilterRejection(rejection))}`, command);
};

/** Measure the same contract-decoded representation the HTTP client sends, including defaults. */
export const checkRequestSize = <A>(
  request: unknown,
  command: string,
  decode: Decoder<A>,
): void => {
  const decoded = decode(request);
  if (Either.isLeft(decoded)) throw new UsageError('The request is not valid.', command);
  if (Buffer.byteLength(JSON.stringify(decoded.right), 'utf8') > REQUEST_MAX_BYTES)
    throw new UsageError(
      `The serialized request must be at most ${REQUEST_MAX_BYTES} bytes. Reduce --body, --metadata, or other input.`,
      command,
    );
};

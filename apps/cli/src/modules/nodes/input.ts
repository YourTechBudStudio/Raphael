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
import { inspectDocumentTransport } from '@raphael/content/validation';
import { REQUEST_MAX_BYTES, isJsonObject, type Decoder, type JsonObject } from '@raphael/contracts';
import {
  CONTAINER_TYPES,
  DocumentTransportInput,
  SCOPES_MAX_COUNT,
  SEARCH_QUERIES_MAX_COUNT,
  asSentence,
  describeDescriptionRejection,
  describeSlugRejection,
  describeTagsRejection,
  describeTitleRejection,
  inspectDescriptionInput,
  inspectSlugInput,
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
  type FilterRejection,
  type NodeFilterInput,
  type NodeOrderBy as NodeOrderByType,
  type NodeType,
  type ResourceKind,
  type ScopeSelector,
  type TipTapDocumentTransport,
} from '@raphael/contracts/nodes';
import { Either, Schema } from 'effect';

import { UsageError, wholeNumberRule } from '../../shared/args.ts';
import { CONTENT_HINT, bodyFailureSentence, shellArg } from '../../shared/failure-wording.ts';
import { readStandardInput } from '../../shared/stdin.ts';
import type { Warning } from '../../shared/success.ts';

/** The one node type that is not a container: it is qualified by a kind, as `resource.note`. */
export const RESOURCE_TYPE = 'resource' satisfies NodeType;

/** What `raphael create <type>` was asked to make. */
export type CreateTarget =
  | { readonly type: ContainerType }
  | { readonly type: 'resource'; readonly kind: ResourceKind };

/** Every token the create command accepts, in the order the help lists them. */
export const CREATE_TARGETS: readonly string[] = [
  ...CONTAINER_TYPES,
  ...RESOURCE_KINDS.map((kind) => `${RESOURCE_TYPE}.${kind}`),
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
/** `a`, `a and b`, `a, b and c`, or with "or". */
const listed = (items: readonly string[], conjunction: 'and' | 'or' = 'and'): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1] ?? ''}`;

/** `1st`, `2nd`, `3rd`, `4th`: which of several values a refusal is about. */
const ordinal = (position: number): string => {
  const tens = position % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][position % 10] ?? 'th');
  return `${position}${suffix}`;
};

export const parseCreateTarget = (
  token: string,
  command: string,
  /** The positional after the type, to recognize a type given after the path. */
  next?: string,
): CreateTarget => {
  const qualified = RESOURCE_KINDS.map((kind) => `${RESOURCE_TYPE}.${kind}`);
  // The type it most likely meant: in lowercase (`Area`), with the type a bare kind belongs to
  // (`note`), or with the kind a bare `resource` needs when it has only one.
  const lower = token.toLowerCase();
  const meant = CREATE_TARGETS.includes(lower)
    ? lower
    : (RESOURCE_KINDS as readonly string[]).includes(lower)
      ? `${RESOURCE_TYPE}.${lower}`
      : lower === RESOURCE_TYPE && qualified.length === 1
        ? qualified[0]
        : undefined;
  const suggestion =
    token.startsWith('/') && next !== undefined && CREATE_TARGETS.includes(next)
      ? `Give the type first, as in "raphael create ${next} ${shellArg(token)}".`
      : meant !== undefined
        ? `Did you mean ${meant}?`
        : lower === RESOURCE_TYPE
          ? `A ${RESOURCE_TYPE} needs its kind: did you mean ${listed(qualified, 'or')}?`
          : undefined;
  const refuse = (): never => {
    throw new UsageError(
      `"${token}" is not something Raphael can create. Give ${listed(CREATE_TARGETS, 'or')}.`,
      command,
      suggestion,
      meant === undefined || token.startsWith('/') ? undefined : { typed: token, suggested: meant },
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
  if (base !== RESOURCE_TYPE) return refuse();
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

  const clauses = values.map((value, index) => {
    // With several, the one refused is named by its place, so the caller knows which to fix.
    const flag = values.length === 1 ? '--order-by' : `--order-by (${ordinal(index + 1)})`;
    const parts = value.split(':');
    if (parts.length !== 2) {
      throw new UsageError(
        `${flag} takes field:direction, for example --order-by updatedAt:desc.`,
        command,
      );
    }
    const [field, direction] = parts;
    if (field === undefined || !(NODE_ORDER_FIELDS as readonly string[]).includes(field)) {
      throw new UsageError(
        `${flag} must name ${listed(NODE_ORDER_FIELDS, 'or')}; for example --order-by updatedAt:desc.`,
        command,
      );
    }
    if (direction === undefined || !(ORDER_DIRECTIONS as readonly string[]).includes(direction)) {
      throw new UsageError(
        `${flag} direction must be ${listed(ORDER_DIRECTIONS, 'or')}; for example --order-by updatedAt:desc.`,
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
  // An empty `--id=` is refused for what it is before anything is said about having both.
  if (id === '') parseId(id, command);
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
      throw new UsageError(
        `${ROOT_PATH} is the top level, not an item.`,
        command,
        `Run "raphael list ${ROOT_PATH}" to see the items there.`,
      );
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
  validatePath(raw, command, 'destination');
  return raw;
};

/**
 * Parse an id strictly.
 *
 * `Number()` would accept `4.0`, `4e0`, ` 4 `, and `0x4`, all of which would then be sent as a
 * different value than the one that was typed, or rejected by the server with a confusing message.
 */
export const parseId = (raw: string, command: string, flag = '--id'): number => {
  // Leading zeros are accepted, as by every whole-number option: `007` is 7 wherever it is typed.
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1) {
    throw new UsageError(wholeNumberRule(flag, { min: 1, max: Number.MAX_SAFE_INTEGER }), command);
  }
  if (!Number.isSafeInteger(value)) {
    throw new UsageError(`${flag} is too large. Give a smaller whole number.`, command);
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
      `--body @- read nothing: standard input was empty. ${clearBodyAdvice(command)}`,
      command,
    );
  }
  const text = decodeUtf8(bytes, 'The body on standard input', command);
  if (text.trim() === '') {
    throw new UsageError(
      `--body @- read nothing but whitespace: standard input had no text. ${clearBodyAdvice(command)}`,
      command,
    );
  }
  return text;
};

/** How to send no body on purpose, for the command that refused an empty one. */
const clearBodyAdvice = (command: string): string =>
  command === 'update'
    ? "To clear the body on purpose, give --body '' --revision <n>."
    : 'To create it without a body, leave out --body.';

/**
 * A flag that reads `@file`: how its file is named in a refusal, and what to use instead when the
 * file cannot be used. Only escapes the flag really has are offered: metadata and filters refuse
 * `@-`, and JSON never begins with `@`.
 */
export interface FileFlag {
  readonly flag: string;
  /** `The body file`, `The metadata file`. */
  readonly label: string;
  readonly example: string;
  /** For text that begins with `@` and was not meant as a file. */
  readonly literal?: string;
  /** For something that is not a regular file. */
  readonly instead: string;
}

const BODY_FILE: FileFlag = {
  flag: '--body',
  label: 'The body file',
  example: 'draft.md',
  literal: 'Use --body-literal for text beginning with @.',
  instead: 'Pipe it through standard input with @- instead.',
};
const METADATA_FILE: FileFlag = {
  flag: '--metadata',
  label: 'The metadata file',
  example: 'metadata.json',
  instead: 'Give the JSON inline instead.',
};
const FILTER_FILE: FileFlag = {
  flag: '--filter',
  label: 'The filter file',
  example: 'filter.json',
  instead: 'Give the JSON inline instead.',
};

/** `@` alone names no file; resolved, it would be the current directory. */
const refuseBareAt = (raw: string | undefined, source: FileFlag, command: string): void => {
  if (raw !== '@') return;
  throw new UsageError(
    `${source.flag} @ needs a file name after the @, as in ${source.flag} @${source.example}.${source.literal === undefined ? '' : ` ${source.literal}`}`,
    command,
  );
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
export const readLocalFile = (path: string, source: FileFlag, command: string): string => {
  refuseBareAt(`@${path}`, source, command);
  path = resolve(path);
  const at = `${source.label} at "${path}"`;
  let fd: number;
  try {
    // `O_NONBLOCK` is what makes the type check below reachable. Opening a FIFO for reading blocks
    // until a writer appears, so without it the command hangs on the open and never gets as far as
    // discovering that the path is not a regular file. It has no effect on an ordinary file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UsageError(
      code === 'ENOENT'
        ? `${at} does not exist.`
        : code === 'EACCES' || code === 'EPERM'
          ? `${at} cannot be read: permission denied.`
          : `${at} cannot be opened.`,
      command,
      code === 'ENOENT' ? source.literal : undefined,
    );
  }

  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new UsageError(`${at} is not a regular file.`, command, source.instead);
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
          `${at} is larger than the ${REQUEST_MAX_BYTES}-byte request limit.`,
          command,
        );
      }
    }
    return decodeUtf8(buffer.subarray(0, total), at, command);
  } finally {
    closeSync(fd);
  }
};

/**
 * Read a body file, refusing one with no text, for the reason `readStdin` refuses empty input: a
 * generator that failed into `draft.md` would otherwise clear the note under a successful exit.
 */
const readBodyFile = (path: string, command: string): string => {
  const text = readLocalFile(path, BODY_FILE, command);
  if (text.trim() === '') {
    const at = `the body file at "${resolve(path)}"`;
    throw new UsageError(
      text === ''
        ? `--body @file read nothing: ${at} is empty. ${clearBodyAdvice(command)}`
        : `--body @file read nothing but whitespace: ${at} has no text. ${clearBodyAdvice(command)}`,
      command,
    );
  }
  return text;
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
    else if (body.startsWith('@')) text = readBodyFile(body.slice(1), command);
    else text = body;
  }

  if (text === undefined) return undefined;
  // Named as typed, so a refusal of the text is about the flag that carried it.
  const flag = bodyLiteral === undefined ? '--body' : '--body-literal';

  if (chosen === 'markdown') {
    if (looksLikeTipTapDocument(text)) {
      throw new UsageError(
        `${flag} looks like a TipTap document, but it would be stored as Markdown text. Add --body-format tiptap to send it as a document. To keep JSON as note text, put it in a fenced code block.`,
        command,
      );
    }
    return { format: 'markdown', value: text };
  }

  // Parsed here, and the *parsed value* is what travels. Verifying the syntax and then sending the
  // original string would produce a request the shared contract can never accept, since a TipTap body
  // is an object. Parsing locally also means a malformed document is a usage error before a round
  // trip rather than a rejection after one.
  const document = parseJson(text, flag, command);
  // The transport bounds first, so a document nested too deeply is refused for its depth rather than
  // for a shape it may well have.
  const transport = inspectDocumentTransport(document);
  if (transport !== undefined) {
    throw new UsageError(bodyFailureSentence(transport), command, CONTENT_HINT);
  }
  if (Either.isLeft(Schema.decodeUnknownEither(DocumentTransportInput)(document))) {
    throw new UsageError(
      `${flag} must be a TipTap document object: {"type":"doc","content":[...]}.`,
      command,
      CONTENT_HINT,
    );
  }
  // A document holds at least one block. Said as that, rather than as a document that cannot be
  // read, with the way to store no body at all.
  const { content } = document as { readonly content?: unknown };
  if (content === undefined || (Array.isArray(content) && content.length === 0)) {
    throw new UsageError(
      `${flag} must hold at least one block, such as {"type":"paragraph"}.`,
      command,
      `To store an empty body, give --body '' without --body-format tiptap.`,
    );
  }
  // The content package's own check, the one the server runs on this body: an element, style,
  // attribute or link it would refuse is refused here, before anything is sent. The document travels
  // as typed; storing its canonical form is the server's to do.
  const checked = canonicalizeDocument(document);
  if (Either.isLeft(checked)) {
    throw new UsageError(bodyFailureSentence(checked.left), command, CONTENT_HINT);
  }
  // A compile-time bridge across a boundary the content package has just checked.
  return { format: 'tiptap', value: document as TipTapDocumentTransport };
};

/** Parse a metadata argument: inline JSON, or `@file`. Must be a JSON object. */
export const resolveMetadata = (
  raw: string | undefined,
  command: string,
): JsonObject | undefined => {
  if (raw === undefined) return undefined;
  prevalidateMetadata(raw, command);
  const text = raw.startsWith('@') ? readLocalFile(raw.slice(1), METADATA_FILE, command) : raw;
  const parsed = parseJson(text, '--metadata', command, true);
  const rejection = inspectMetadataInput(parsed);
  if (rejection !== undefined)
    throw new UsageError(`--metadata: ${sentence(rejection.detail)}`, command);
  if (!isJsonObject(parsed)) throw new UsageError('--metadata must be a JSON object.', command);
  refuseInexactInteger(parsed, command);
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
    ...positionals.map((path, index) => {
      // `parsePath` is not a second opinion about addressing: `ScopePath` filters on
      // `isCanonicalPath`, which *is* `Either.isRight(parsePath(value))`. Asking it here reaches the
      // same verdict the request decoder would, early enough to say which scope was wrong and why.
      // Without it the decoder answers for a union of two selector shapes, and someone who forgot the
      // leading slash is told an `id` was expected - true of the union, and useless to them.
      validatePath(path, command, positionals.length === 1 ? 'path' : `path (${ordinal(index + 1)})`);
      // The original string travels, not a path rebuilt from the segments. `parsePath` refuses a
      // noncanonical path rather than repairing one, so there is nothing to rebuild and rebuilding
      // would be the rewriting it exists to prevent.
      return { path };
    }),
    ...ids.map((id, index) => ({
      id: parseId(id, command, ids.length === 1 ? '--id' : `--id (${ordinal(index + 1)})`),
    })),
  ];
  if (scopes.length === 0) throw new UsageError('Give at least one path, or --id.', command);
  if (scopes.length > SCOPES_MAX_COUNT)
    throw new UsageError(
      `Paths and --id take at most ${SCOPES_MAX_COUNT} targets in total.`,
      command,
    );
  const seen = new Set<string>();
  for (const scope of scopes) {
    const key = JSON.stringify(scope);
    if (seen.has(key)) {
      const given = 'path' in scope ? scope.path : `--id ${scope.id}`;
      throw new UsageError(`Paths and --id must not repeat a target: ${given} is given twice.`, command);
    }
    seen.add(key);
  }
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
  const text = raw.startsWith('@') ? readLocalFile(raw.slice(1), FILTER_FILE, command) : raw;
  const parsed = parseJson(text, '--filter', command, true);

  const rejection = inspectFilterInput(parsed);
  if (rejection !== undefined) throw new UsageError(filterRefusal(parsed, rejection), command);
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
  for (const [index, value] of values.entries()) {
    const rejection = inspectQueryInput(value);
    if (rejection !== undefined) {
      const flag = values.length === 1 ? '-q' : `-q (${ordinal(index + 1)})`;
      throw new UsageError(`${flag}: ${sentence(describeQueryRejection(rejection))}`, command);
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
  message: `The body was stored with changes: ${keptAs(degraded)}. Use --strict to refuse such a body.`,
  hint: `Run "${readCommand}" to see the stored body.`,
});

/** `a table was kept as …; an image and raw HTML were kept as plain text`, grouped by outcome. */
const keptAs = (degraded: readonly DegradedConstruct[]): string => {
  const groups = new Map<string, string[]>();
  for (const construct of degraded) {
    const { name, outcome } = DEGRADED_CONSTRUCT_DESCRIPTIONS[construct];
    groups.set(outcome, [...(groups.get(outcome) ?? []), name]);
  }
  return [...groups]
    .map(([outcome, names]) => `${listed(names)} ${names.length === 1 ? 'was' : 'were'} ${outcome}`)
    .join('; ');
};

const sentence = asSentence;

/** The commands whose paths are places to look in, where the root is one of them. */
const SCOPE_COMMANDS: ReadonlySet<string> = new Set(['list', 'search']);

const validatePath = (raw: string, command: string, flag: string): void => {
  const result = parsePath(raw);
  if (Either.isLeft(result)) {
    // The path it most likely meant: in canonical case, with the leading slash it lacks, or without
    // the trailing one. An option given after `--` is not taken for a path that lost its slash.
    // A positive integer is an id typed where a path goes; every command with a path takes --id.
    const message = `${flag}: ${sentence(describePathRejection(result.left))}`;
    if (flag === 'path' && /^[1-9]\d*$/u.test(raw)) {
      throw new UsageError(message, command, `Try "--id ${raw}".`, {
        typed: raw,
        suggested: ['--id', raw],
      });
    }
    const lower = raw.normalize('NFC').toLowerCase();
    // An empty path is not taken for the root, except where the root is something to list or search.
    const rootAllowed = raw !== '' || (flag === 'path' && SCOPE_COMMANDS.has(command));
    const candidate = [
      lower,
      ...(raw.startsWith('-') ? [] : [`/${lower}`]),
      lower.replace(/\/+$/u, ''),
    ].find(
      (repaired) =>
        repaired !== raw &&
        (rootAllowed || repaired !== ROOT_PATH) &&
        Either.isRight(parsePath(repaired)),
    );
    throw new UsageError(
      message,
      command,
      candidate === undefined ? undefined : `Try "${shellArg(candidate)}".`,
      candidate === undefined ? undefined : { typed: raw, suggested: candidate },
    );
  }
};

/** A slug refused in the contract's words, the same sentence the server sends for it. */
export const validateSlug = (raw: string | undefined, command: string, flag = '--slug'): void => {
  if (raw === undefined) return;
  const rejection = inspectSlugInput(raw);
  if (rejection === undefined) return;
  const candidate = raw.normalize('NFC').toLowerCase();
  throw new UsageError(
    `${flag}: ${sentence(describeSlugRejection(rejection))}`,
    command,
    candidate !== raw && isCanonicalSlug(candidate) ? `Try "${candidate}".` : undefined,
    candidate !== raw && isCanonicalSlug(candidate)
      ? { typed: raw, suggested: candidate }
      : undefined,
  );
};

/** A title refused in the contract's words, the same sentence the server sends for it. */
export const validateTitle = (raw: string | undefined, command: string): void => {
  const rejection = inspectTitleInput(raw);
  if (rejection !== undefined)
    throw new UsageError(`--title: ${sentence(describeTitleRejection(rejection))}`, command);
};

/** A description refused in the contract's words, the same sentence the server sends for it. */
export const validateDescription = (raw: string | undefined, command: string): void => {
  const rejection = raw === undefined ? undefined : inspectDescriptionInput(raw);
  if (rejection !== undefined)
    throw new UsageError(
      `--description: ${sentence(describeDescriptionRejection(rejection))}`,
      command,
    );
};

export const validateTags = (values: readonly string[], command: string, flag = '--tag'): void => {
  if (values.some((value) => value.includes(',')))
    throw new UsageError(
      `${flag} does not accept commas inside a tag.`,
      command,
      'Give each tag its own --tag.',
    );
  // A tag refused in the contract's words, the same sentence the server sends for it.
  const rejection = inspectTagsInput(values.map(normalizeTag));
  if (rejection !== undefined)
    throw new UsageError(`${flag}: ${sentence(describeTagsRejection(rejection))}`, command);
};

export const validateBodyArguments = (
  body: string | undefined,
  literal: string | undefined,
  command: string,
): void => {
  if (body !== undefined && literal !== undefined)
    throw new UsageError('Give either --body or --body-literal, not both.', command);
  refuseBareAt(body, BODY_FILE, command);
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

/**
 * The first key an object in valid JSON text repeats, if any. `JSON.parse` keeps the last value of a
 * repeated key, so `{"a":1,"a":2}` would be sent as `{"a":2}` with the first value silently gone.
 */
const repeatedKey = (text: string): string | undefined => {
  // One frame per open object (its keys, and whether a key comes next) or array (`undefined`).
  const frames: ({ keys: Set<string>; key: boolean } | undefined)[] = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    const frame = frames.at(-1);
    if (character === '{') frames.push({ keys: new Set(), key: true });
    else if (character === '[') frames.push(undefined);
    else if (character === '}' || character === ']') frames.pop();
    else if (character === ',' && frame !== undefined) frame.key = true;
    else if (character === '"') {
      const start = cursor;
      for (cursor += 1; text[cursor] !== '"'; cursor += 1) {
        if (text[cursor] === '\\') cursor += 1;
      }
      if (frame?.key === true) {
        const key = JSON.parse(text.slice(start, cursor + 1)) as string;
        if (frame.keys.has(key)) return key;
        frame.keys.add(key);
        frame.key = false;
      }
    }
  }
  return undefined;
};

/** Refuse a repeated key, naming it only when it is a plain word. */
const refuseRepeatedKey = (text: string, flag: string, command: string): void => {
  const key = repeatedKey(text);
  if (key === undefined) return;
  throw new UsageError(
    `${flag} repeats ${/^[\w.-]{1,64}$/.test(key) ? `the key "${key}"` : 'a key'} in one object.`,
    command,
    'Give each key once.',
  );
};

/** Parse syntax without quoting submitted JSON in diagnostics. */
const parseJson = (text: string, flag: string, command: string, unique = false): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    if (unique) refuseRepeatedKey(text, flag, command);
    return value;
  } catch (error) {
    if (error instanceof UsageError) throw error;
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
  refuseBareAt(raw, METADATA_FILE, command);
  if (raw.startsWith('@')) return;
  const parsed = parseJson(raw, '--metadata', command, true);
  const rejection = inspectMetadataInput(parsed);
  if (rejection !== undefined)
    throw new UsageError(`--metadata: ${sentence(rejection.detail)}`, command);
  refuseInexactInteger(parsed, command);
};

/**
 * A whole number past `Number.MAX_SAFE_INTEGER` has already lost digits by the time it is parsed,
 * and metadata is set once, so storing it would keep a different number for good without a word.
 * Refused instead, with the way to keep it exactly.
 */
const refuseInexactInteger = (value: unknown, command: string): void => {
  const pending: { readonly value: unknown; readonly path: readonly string[] }[] = [
    { value, path: [] },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.value === 'number') {
      if (Number.isInteger(next.value) && !Number.isSafeInteger(next.value)) {
        const at = next.path.length === 0 ? 'The value' : `"${next.path.join('.')}"`;
        throw new UsageError(
          `--metadata: ${at} is a whole number too large to store exactly.`,
          command,
          'Give it as a JSON string to keep every digit.',
        );
      }
    } else if (typeof next.value === 'object' && next.value !== null) {
      for (const [key, child] of Object.entries(next.value)) {
        pending.push({ value: child, path: [...next.path, key] });
      }
    }
  }
};

export const prevalidateFilter = (raw: string | undefined, command: string): void => {
  if (raw === undefined) return;
  if (raw === '@-')
    throw new UsageError('--filter does not accept @-. Give inline JSON or @file.', command);
  refuseBareAt(raw, FILTER_FILE, command);
  if (raw.startsWith('@')) return;
  const parsed = parseJson(raw, '--filter', command, true);
  const rejection = inspectFilterInput(parsed);
  if (rejection !== undefined) throw new UsageError(filterRefusal(parsed, rejection), command);
};

/**
 * The contract's sentence for a refused filter, and, for a value written in a shape another tool or
 * the create command teaches, the shape this filter takes. Only the shape is named; nothing typed is
 * repeated.
 */
const filterRefusal = (parsed: unknown, rejection: FilterRejection): string => {
  const refusal = `--filter: ${sentence(describeFilterRejection(rejection))}`;
  if (rejection.reason !== 'invalid_value' || rejection.key === undefined || !isJsonObject(parsed))
    return refusal;
  const value = parsed[rejection.key];
  if (Array.isArray(value)) {
    return `${refusal} A list goes inside $in, as in {"${rejection.key}":{"$in":[...]}}.`;
  }
  if (rejection.key === 'type') {
    const given =
      typeof value === 'string'
        ? [value]
        : isJsonObject(value) && Array.isArray(value['$in'])
          ? value['$in']
          : [];
    const kind = RESOURCE_KINDS.find((candidate) =>
      given.some((entry) => entry === candidate || entry === `${RESOURCE_TYPE}.${candidate}`),
    );
    if (kind !== undefined) {
      return `${refusal} A kind has its own key: for ${kind}s, use ${JSON.stringify({ type: RESOURCE_TYPE, kind })}.`;
    }
  }
  return refusal;
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

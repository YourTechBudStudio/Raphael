/**
 * Turning command-line arguments into request fields.
 *
 * Everything here is adaptation, not authority. Splitting `/work/raphael/backend` into a parent path
 * and a slug is string work; whether `backend` is a usable slug, whether a project may live under that
 * parent, and what the slug becomes are all the server's to decide. The CLI does no preparatory lookup
 * and derives no slug of its own.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

import { REQUEST_MAX_BYTES, isJsonObject, type JsonObject } from '@raphael/contracts';
import {
  CONTAINER_TYPES,
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
      `"${token}" is not something Raphael can create. Give ${CREATE_TARGETS.join(', ')}.`,
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
      throw new UsageError(`--order-by takes "field:direction". Got "${value}".`, command);
    }
    const [field, direction] = parts;
    if (field === undefined || !(NODE_ORDER_FIELDS as readonly string[]).includes(field)) {
      throw new UsageError(
        `--order-by must name ${NODE_ORDER_FIELDS.join(', ')}. Got "${field ?? ''}".`,
        command,
      );
    }
    if (direction === undefined || !(ORDER_DIRECTIONS as readonly string[]).includes(direction)) {
      throw new UsageError(
        `--order-by direction must be ${ORDER_DIRECTIONS.join(' or ')}. Got "${direction ?? ''}".`,
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
  if (positional !== undefined) return { path: positional };
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
export const parseId = (raw: string, command: string): number => {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new UsageError(`--id must be a positive whole number. Got "${raw}".`, command);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new UsageError(`--id is too large to be an identifier. Got "${raw}".`, command);
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

const readStdin = async (command: string): Promise<string> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    // Counted as it arrives. Reading all of standard input and measuring afterwards would be a
    // bound that does not bound anything.
    if (total > REQUEST_MAX_BYTES) {
      throw new UsageError(
        `The body on standard input is larger than the ${REQUEST_MAX_BYTES}-byte request limit.`,
        command,
      );
    }
    chunks.push(buffer);
  }
  return decodeUtf8(Buffer.concat(chunks), 'The body on standard input', command);
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
  let fd: number;
  try {
    // `O_NONBLOCK` is what makes the type check below reachable. Opening a FIFO for reading blocks
    // until a writer appears, so without it the command hangs on the open and never gets as far as
    // discovering that the path is not a regular file. It has no effect on an ordinary file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new UsageError(`Cannot read ${label} at "${path}".`, command);
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

export const resolveBody = async (
  body: string | undefined,
  bodyLiteral: string | undefined,
  format: 'markdown' | 'tiptap' | undefined,
  command: string,
): Promise<BodySource | undefined> => {
  if (body !== undefined && bodyLiteral !== undefined) {
    throw new UsageError('Give either --body or --body-literal, not both.', command);
  }

  const chosen = format ?? 'markdown';
  let text: string | undefined;

  if (bodyLiteral !== undefined) {
    text = bodyLiteral;
  } else if (body !== undefined) {
    if (body === '@-') text = await readStdin(command);
    else if (body.startsWith('@')) text = readLocalFile(body.slice(1), 'the body file', command);
    else text = body;
  }

  if (text === undefined) return undefined;

  if (chosen === 'markdown') return { format: 'markdown', value: text };

  // Parsed here, and the *parsed value* is what travels. Verifying the syntax and then sending the
  // original string would produce a request the shared contract can never accept, since a TipTap body
  // is an object. Parsing locally also means a malformed document is a usage error before a round
  // trip rather than a rejection after one.
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new UsageError(
      'The body is not valid JSON, and --body-format tiptap expects a TipTap document.',
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
  const text = raw.startsWith('@')
    ? readLocalFile(raw.slice(1), 'the metadata file', command)
    : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('--metadata must be valid JSON, or @file containing it.', command);
  }
  // `isJsonObject` is the contracts' own predicate for an arbitrary JSON object, so "an object" means
  // the same thing here as it does where the request is decoded. It narrows the shape; the depth, key,
  // and byte bounds remain the decoder's, which is where they are defined.
  if (!isJsonObject(parsed)) {
    throw new UsageError('--metadata must be a JSON object.', command);
  }
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
      const parsed = parsePath(path);
      if (Either.isLeft(parsed)) {
        throw new UsageError(`scope "${path}": ${describePathRejection(parsed.left)}`, command);
      }
      // The original string travels, not a path rebuilt from the segments. `parsePath` refuses a
      // noncanonical path rather than repairing one, so there is nothing to rebuild and rebuilding
      // would be the rewriting it exists to prevent.
      return { path };
    }),
    ...ids.map((id) => ({ id: parseId(id, command) })),
  ];
  if (scopes.length === 0) throw new UsageError('Give at least one path, or --id.', command);
  // The count bound and the no-repeat rule stay the decoder's. Both already report themselves
  // adequately, and a local copy could only ever come to disagree with the one that decides.
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
  const text = raw.startsWith('@') ? readLocalFile(raw.slice(1), 'the filter file', command) : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('--filter must be valid JSON, or @file containing it.', command);
  }

  const rejection = inspectFilterInput(parsed);
  if (rejection !== undefined) {
    throw new UsageError(`--filter: ${describeFilterRejection(rejection)}`, command);
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
  for (const value of values) {
    const rejection = inspectQueryInput(value);
    if (rejection !== undefined) {
      throw new UsageError(`-q: ${describeQueryRejection(rejection)}`, command);
    }
  }
  return values;
};

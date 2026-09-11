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
  NODE_TYPES,
  ROOT_PATH,
  type NodeType,
  type TipTapDocumentTransport,
} from '@raphael/contracts/nodes';

import { UsageError } from '../../shared/args.ts';

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

const readStdin = async (): Promise<string> => {
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
        'create',
      );
    }
    chunks.push(buffer);
  }
  return decodeUtf8(Buffer.concat(chunks), 'The body on standard input', 'create');
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
    if (body === '@-') text = await readStdin();
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
 * Split `--types area,project`.
 *
 * Empty entries and duplicates are refused rather than dropped: a filter that silently discarded part
 * of what was asked for would return a page that does not answer the question. The values themselves
 * go to the shared request decoder, which owns which types exist.
 */
export const parseTypes = (
  raw: string | undefined,
  command: string,
): readonly NodeType[] | undefined => {
  if (raw === undefined) return undefined;
  const parts = raw.split(',');
  const seen = new Set<string>();
  for (const part of parts) {
    if (part === '') {
      throw new UsageError(`--types must not contain an empty entry. Got "${raw}".`, command);
    }
    if (seen.has(part)) {
      throw new UsageError(`--types must not repeat "${part}".`, command);
    }
    if (!isNodeType(part)) {
      throw new UsageError(`--types must name ${NODE_TYPES.join(' or ')}. Got "${part}".`, command);
    }
    seen.add(part);
  }
  return parts as readonly NodeType[];
};

/**
 * Whether a word names a type this release can address.
 *
 * This is the contract's own published vocabulary, not a hierarchy rule: what may contain what, and
 * what a type means, remain the server's. Checking the name here only turns a round trip into a
 * local message that lists the alternatives.
 */
export const isNodeType = (value: string): value is NodeType =>
  (NODE_TYPES as readonly string[]).includes(value);

import { Schema } from 'effect';

import { JSON_SAFETY_MAX_DEPTH, JSON_SAFETY_MAX_VALUES } from './limits.ts';

/** A value that survives a JSON round trip unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export interface JsonTraversalLimits {
  readonly maxDepth: number;
  readonly maxValues: number;
  /** Applies to object keys at every level. Omitted means key length is not this check's concern. */
  readonly maxKeyCodePoints?: number;
}

export const JSON_SAFETY_LIMITS: JsonTraversalLimits = {
  maxDepth: JSON_SAFETY_MAX_DEPTH,
  maxValues: JSON_SAFETY_MAX_VALUES,
};

export type JsonRejectionReason =
  /** Not representable in JSON: undefined, a function, a symbol, a bigint, or an exotic object. */
  | 'not_json'
  | 'non_finite_number'
  | 'symbol_key'
  | 'cyclic'
  | 'too_deep'
  | 'too_many_values'
  | 'key_too_long';

export interface JsonRejection {
  readonly reason: JsonRejectionReason;
  /** Object keys and array indices from the inspected root to the offending value. */
  readonly path: readonly (string | number)[];
  /**
   * The limit that was exceeded, for the reasons that have one. It travels with the rejection because
   * the limits in force depend on the caller — metadata is bounded far more tightly than the decoder
   * safety ceiling — and a message naming the wrong number sends someone after the wrong correction.
   */
  readonly limit: number | undefined;
}

interface Frame {
  readonly container: object;
  /** Own string keys for objects; `undefined` for arrays, which are walked by index. */
  readonly keys: readonly string[] | undefined;
  index: number;
}

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

/**
 * Checks that `input` is JSON-safe within `limits`, returning the first rejection or `undefined`.
 *
 * The traversal is iterative and depth-first, so pending state stays proportional to depth plus the
 * key list of the object currently being walked, rather than to the total breadth of the input. That
 * matters because callers hand us values that are already materialized in memory: the remaining risk
 * is validation stack depth and validation work, not the allocation of the input itself. Bytes on
 * the wire are bounded separately by the transport.
 *
 * Inputs reach this function both from a JSON parser and from first-party code, so it also rejects
 * values a parser can never produce: non-finite numbers, symbol keys, cycles, and exotic objects.
 * Nothing is normalized, stripped, or truncated — arbitrary data is preserved exactly as given.
 */
export const inspectJsonValue = (
  input: unknown,
  limits: JsonTraversalLimits = JSON_SAFETY_LIMITS,
): JsonRejection | undefined => {
  let values = 0;
  const path: (string | number)[] = [];
  const frames: Frame[] = [];
  const ancestors = new Set<object>();

  const reject = (reason: JsonRejectionReason, limit?: number): JsonRejection => ({
    reason,
    path: [...path],
    limit,
  });

  /** Validates one value, pushing a frame when it is a container worth descending into. */
  const classify = (value: unknown): JsonRejection | undefined => {
    values += 1;
    if (values > limits.maxValues) return reject('too_many_values', limits.maxValues);
    if (value === null) return undefined;

    switch (typeof value) {
      case 'boolean':
      case 'string':
        return undefined;
      case 'number':
        return Number.isFinite(value) ? undefined : reject('non_finite_number');
      case 'object':
        break;
      default:
        return reject('not_json');
    }

    const container = value as object;
    const isArray = Array.isArray(container);
    if (!isArray && !isPlainObject(container)) return reject('not_json');
    if (ancestors.has(container)) return reject('cyclic');
    if (frames.length >= limits.maxDepth) return reject('too_deep', limits.maxDepth);
    if (Object.getOwnPropertySymbols(container).length > 0) return reject('symbol_key');

    ancestors.add(container);
    frames.push({ container, keys: isArray ? undefined : Object.keys(container), index: 0 });
    return undefined;
  };

  const rootRejection = classify(input);
  if (rootRejection !== undefined) return rootRejection;

  for (;;) {
    const frame = frames[frames.length - 1];
    if (frame === undefined) return undefined;

    const { container, keys } = frame;
    const length = keys === undefined ? (container as readonly unknown[]).length : keys.length;
    if (frame.index >= length) {
      frames.pop();
      ancestors.delete(container);
      if (frames.length > 0) path.pop();
      continue;
    }

    const key = keys === undefined ? frame.index : keys[frame.index];
    frame.index += 1;
    if (key === undefined) continue;

    path.push(key);
    if (
      limits.maxKeyCodePoints !== undefined &&
      typeof key === 'string' &&
      codePointLength(key) > limits.maxKeyCodePoints
    ) {
      return reject('key_too_long', limits.maxKeyCodePoints);
    }
    const child = (container as Record<string | number, unknown>)[key];
    const rejection = classify(child);
    if (rejection !== undefined) return rejection;
    if (frames[frames.length - 1]?.container !== child) path.pop();
  }
};

export const isJsonValue = (
  input: unknown,
  limits: JsonTraversalLimits = JSON_SAFETY_LIMITS,
): input is JsonValue => inspectJsonValue(input, limits) === undefined;

export const isJsonObject = (
  input: unknown,
  limits: JsonTraversalLimits = JSON_SAFETY_LIMITS,
): input is JsonObject =>
  typeof input === 'object' &&
  input !== null &&
  !Array.isArray(input) &&
  isPlainObject(input) &&
  isJsonValue(input, limits);

export const describeJsonRejection = (rejection: JsonRejection): string => {
  const at = rejection.path.length === 0 ? 'the value' : `"${rejection.path.join('.')}"`;
  switch (rejection.reason) {
    case 'not_json':
      return `${at} is not representable in JSON`;
    case 'non_finite_number':
      return `${at} is not a finite number`;
    case 'symbol_key':
      return `${at} has symbol keys, which JSON cannot represent`;
    case 'cyclic':
      return `${at} refers back to one of its own ancestors`;
    case 'too_deep':
      return `${at} nests deeper than ${rejection.limit ?? JSON_SAFETY_MAX_DEPTH} levels`;
    case 'too_many_values':
      return `the value contains more than ${rejection.limit ?? JSON_SAFETY_MAX_VALUES} JSON values`;
    case 'key_too_long':
      return rejection.limit === undefined
        ? `${at} is longer than the permitted key length`
        : `${at} is longer than ${rejection.limit} characters`;
  }
};

const explain =
  (identifier: string, limits: JsonTraversalLimits) =>
  (actual: unknown): string => {
    const rejection = inspectJsonValue(actual, limits);
    return rejection === undefined
      ? `Expected ${identifier}`
      : `Expected ${identifier}: ${describeJsonRejection(rejection)}`;
  };

/**
 * A JSON value validated by iterative inspection rather than a recursive schema, so validating a
 * hostile input cannot recurse without bound. The value passes through untouched.
 */
export const makeJsonValueSchema = (identifier: string, limits: JsonTraversalLimits) =>
  Schema.declare((input: unknown): input is JsonValue => isJsonValue(input, limits), {
    identifier,
    message: (issue) => explain(identifier, limits)(issue.actual),
  });

export const makeJsonObjectSchema = (identifier: string, limits: JsonTraversalLimits) =>
  Schema.declare((input: unknown): input is JsonObject => isJsonObject(input, limits), {
    identifier,
    message: (issue) =>
      typeof issue.actual === 'object' && issue.actual !== null && !Array.isArray(issue.actual)
        ? explain(identifier, limits)(issue.actual)
        : `Expected ${identifier}: not a JSON object`,
  });

/** Safety-bounded only: the shape every JSON-bearing response field is decoded against. */
export const JsonValueSafe = makeJsonValueSchema('a JSON value', JSON_SAFETY_LIMITS);
export const JsonObjectSafe = makeJsonObjectSchema('a JSON object', JSON_SAFETY_LIMITS);

/** Counts Unicode code points, not UTF-16 units, so astral characters count once. */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * Serialized size in UTF-8 bytes, which is how every byte budget in the contracts is measured.
 * Computed from code points rather than an encoder so the package needs no platform globals.
 */
export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

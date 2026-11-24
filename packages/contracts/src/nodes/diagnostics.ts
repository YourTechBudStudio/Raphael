import { Either } from 'effect';

import type { DecodeFailure } from '../shared/decode.ts';
import type { InvalidInputReason } from '../shared/errors.ts';
import {
  CONTAINER_TYPES,
  describeDescriptionRejection,
  describeTagsRejection,
  describeTitleRejection,
  inspectDescriptionInput,
  inspectMetadataInput,
  inspectTagsInput,
  inspectTitleInput,
  normalizeTag,
} from './fields.ts';
import { FILTER_KEYS, describeFilterRejection, inspectFilterInput } from './filter.ts';
import { describePathRejection, parsePath } from './path.ts';
import { describeQueryRejection, inspectQueryInput } from './search-query.ts';
import { describeSlugRejection, inspectSlugInput } from './slug.ts';

export const REQUEST_FIELDS = [
  'type',
  'kind',
  'parent',
  'target',
  'revision',
  'destination',
  'title',
  'slug',
  'description',
  'body',
  'tags',
  'active',
  'metadata',
  'format',
  'recursive',
  'scopes',
  'filter',
  'queries',
  'skip',
  'limit',
  'orderBy',
  'includeArchived',
] as const;
export type RequestField = (typeof REQUEST_FIELDS)[number];
export const isRequestField = (value: unknown): value is RequestField =>
  (REQUEST_FIELDS as readonly unknown[]).includes(value);
export interface InvalidRequestIssue {
  readonly field?: RequestField;
  readonly reason: Exclude<
    InvalidInputReason,
    'malformed_json' | 'invalid_utf8' | 'incomplete_body'
  >;
  readonly limit?: number;
  /**
   * The contract's own sentence for the rule that was broken, when the inspection names one: a
   * describer's fixed text, never the submitted value. More precise than the reason, which is a
   * closed list on the wire.
   */
  readonly rule?: string;
}

/** Fields named in the plural, so a sentence about them agrees. */
const PLURAL_FIELDS: ReadonlySet<RequestField> = new Set(['tags', 'scopes', 'queries']);

/**
 * The one generic sentence for an invalid-input issue, as a lowercase clause like every describer's.
 *
 * The server uses it as its message, and a client that words the same refusal itself uses the same
 * describers, so a rule caught before sending and the same rule caught by the server say the same
 * thing from the same constants. Generic on purpose: it names the rule, never what was submitted.
 */
export const describeInvalidInput = (issue: InvalidRequestIssue): string => {
  if (issue.rule !== undefined) return issue.rule;
  const { field, reason, limit } = issue;
  const bound = limit === undefined ? {} : { limit };
  switch (reason) {
    case 'invalid':
      if (field === undefined) return 'the request was not valid';
      return `the ${field} ${PLURAL_FIELDS.has(field) ? 'are' : 'is'} not valid`;
    case 'title_required':
    case 'title_too_long':
      return describeTitleRejection({ reason, ...bound });
    case 'slug_too_long':
      return describeSlugRejection({ reason, ...bound });
    case 'active_requires_project':
      return 'only a project can be marked active';
    case 'favorite_requires_container':
      return `only ${CONTAINER_TYPES.map((type) => `${type}s`).join(' and ')} can be favorites`;
    case 'query_malformed':
      return 'a query must be words or quoted phrases, with AND and OR only between two of them';
    case 'query_too_long':
      return describeQueryRejection({ reason: 'too_long', ...bound });
    case 'query_too_many_terms':
      return describeQueryRejection({ reason: 'too_many_terms', ...bound });
    case 'filter_unsupported':
      return `a filter may only use ${FILTER_KEYS.join(', ')}, each with a value or $in`;
  }
};

/** A describer's clause as a sentence: capitalized, with one closing period. */
export const asSentence = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/[.]$/u, '')}.`;

/**
 * Turning a decode failure into a public one without carrying the payload with it.
 *
 * Decoder messages can quote the submitted value, so none is forwarded. What survives is the field,
 * when it is one we know, and for `title`, `queries` and `filter` a controlled reason from the shared
 * inspection helper. Submitted values are read as own data properties, so a getter on an in-process
 * payload is never invoked while an error is being built.
 */

/** An absent property is information (a missing title); an accessor is unreadable and never called. */
type PropertyReading =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' };

const ownDataProperty = (input: unknown, key: string): PropertyReading => {
  if (typeof input !== 'object' || input === null) return { kind: 'unreadable' };
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined) return { kind: 'absent' };
  if (!('value' in descriptor)) return { kind: 'unreadable' };
  return { kind: 'value', value: descriptor.value };
};

/**
 * The field to report. With a union schema, every member whose discriminant did not match complains
 * about `type`, so `type` is reported only when nothing more specific was named.
 */
const failedField = (failure: DecodeFailure): RequestField | undefined => {
  let discriminant: RequestField | undefined;
  for (const issue of failure.issues) {
    const [field] = issue.path;
    if (!isRequestField(field)) continue;
    if (field === 'type') {
      discriminant ??= field;
      continue;
    }
    return field;
  }
  return discriminant;
};

/** The value a property reading yields for inspection: absent reads as `undefined`. */
const inspectable = (reading: PropertyReading): { readonly value: unknown } | undefined =>
  reading.kind === 'unreadable'
    ? undefined
    : { value: reading.kind === 'absent' ? undefined : reading.value };

/** The first `queries` element the decoder complained about, if it complained about an element. */
const failedQueryIndex = (failure: DecodeFailure): number | undefined => {
  for (const issue of failure.issues) {
    const [head, position] = issue.path;
    if (head === 'queries' && typeof position === 'number') return position;
  }
  return undefined;
};

/** A location we cannot attribute to a known field is reported as the request as a whole. */
export const invalidRequestIssueFrom = (
  failure: DecodeFailure,
  input: unknown,
): InvalidRequestIssue => {
  const field = failedField(failure);
  if (field === undefined) return { reason: 'invalid' };

  if (field === 'title') {
    const reading = inspectable(ownDataProperty(input, 'title'));
    const rejection = reading === undefined ? undefined : inspectTitleInput(reading.value);
    if (rejection !== undefined && rejection.reason !== 'not_string') {
      return {
        field: 'title',
        reason: rejection.reason,
        ...(rejection.limit === undefined ? {} : { limit: rejection.limit }),
      };
    }
  }

  if (field === 'slug') {
    const reading = inspectable(ownDataProperty(input, 'slug'));
    const rejection =
      typeof reading?.value === 'string' ? inspectSlugInput(reading.value) : undefined;
    if (rejection?.reason === 'slug_too_long') {
      return {
        field: 'slug',
        reason: 'slug_too_long',
        ...(rejection.limit === undefined ? {} : { limit: rejection.limit }),
      };
    }
    if (rejection !== undefined) {
      return { field: 'slug', reason: 'invalid', rule: describeSlugRejection(rejection) };
    }
  }

  if (field === 'queries') {
    const position = failedQueryIndex(failure);
    const reading = inspectable(ownDataProperty(input, 'queries'));
    const submitted = reading?.value;
    if (position !== undefined && Array.isArray(submitted)) {
      const element = inspectable(ownDataProperty(submitted, String(position)));
      const rejection = inspectQueryInput(element?.value);
      if (rejection?.reason === 'too_long' || rejection?.reason === 'too_many_terms') {
        return {
          field: 'queries',
          reason: rejection.reason === 'too_long' ? 'query_too_long' : 'query_too_many_terms',
          ...(rejection.limit === undefined ? {} : { limit: rejection.limit }),
        };
      }
      if (rejection !== undefined && rejection.reason !== 'not_string') {
        return {
          field: 'queries',
          reason: 'query_malformed',
          rule: describeQueryRejection(rejection),
        };
      }
    }
  }

  if (field === 'filter') {
    const reading = inspectable(ownDataProperty(input, 'filter'));
    if (reading !== undefined) {
      const rejection = inspectFilterInput(reading.value);
      if (rejection?.reason === 'unsupported_key' || rejection?.reason === 'unsupported_operator') {
        return {
          field: 'filter',
          reason: 'filter_unsupported',
          rule: describeFilterRejection(rejection),
        };
      }
      if (rejection !== undefined) {
        return { field: 'filter', reason: 'invalid', rule: describeFilterRejection(rejection) };
      }
    }
  }

  // Tags, description and metadata have one reason on the wire, `invalid`; the rule says which bound.
  const rule = valueRule(field, inspectable(ownDataProperty(input, field))?.value);
  if (rule !== undefined) return { field, reason: 'invalid', rule };

  const path = selectorPathRule(field, input);
  return path === undefined
    ? { field, reason: 'invalid' }
    : { field, reason: 'invalid', rule: path };
};

/** The contract's sentence for a refused tag list, description or metadata value. */
const valueRule = (field: RequestField, value: unknown): string | undefined => {
  if (field === 'tags' && Array.isArray(value)) {
    const tags = [...value.keys()].map((index) =>
      inspectable(ownDataProperty(value, String(index))),
    );
    if (!tags.every((tag) => typeof tag?.value === 'string')) return undefined;
    const rejection = inspectTagsInput(tags.map((tag) => normalizeTag(tag?.value as string)));
    return rejection === undefined ? undefined : describeTagsRejection(rejection);
  }
  if (field === 'description' && typeof value === 'string') {
    const rejection = inspectDescriptionInput(value);
    return rejection === undefined ? undefined : describeDescriptionRejection(rejection);
  }
  if (field === 'metadata' && value !== undefined) {
    const rejection = inspectMetadataInput(value);
    // A JSON-safety detail can name the key path it concerns, which is caller text; the other
    // reasons are fixed sentences.
    return rejection === undefined || rejection.reason === 'invalid_json'
      ? undefined
      : rejection.detail;
  }
  return undefined;
};

/**
 * The path rule a selector field broke, when it was given as a path that does not parse. A selector
 * that parses but is refused for another reason - the root where an item is needed - gets no rule.
 */
const selectorPathRule = (field: RequestField, input: unknown): string | undefined => {
  const paths: unknown[] = [];
  const value = inspectable(ownDataProperty(input, field))?.value;
  if (field === 'target' || field === 'parent' || field === 'destination') paths.push(value);
  if (field === 'scopes' && Array.isArray(value)) {
    for (const index of value.keys()) {
      paths.push(inspectable(ownDataProperty(value, String(index)))?.value);
    }
  }
  for (const selector of paths) {
    const path = inspectable(ownDataProperty(selector, 'path'))?.value;
    if (typeof path !== 'string') continue;
    const parsed = parsePath(path);
    if (Either.isLeft(parsed)) return describePathRejection(parsed.left);
  }
  return undefined;
};

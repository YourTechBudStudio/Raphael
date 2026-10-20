import type { DecodeFailure } from '../shared/decode.ts';
import type { InvalidInputReason } from '../shared/errors.ts';
import { inspectTitleInput } from './fields.ts';
import { inspectFilterInput } from './filter.ts';
import { inspectQueryInput } from './search-query.ts';

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
}

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
        return { field: 'queries', reason: 'query_malformed' };
      }
    }
  }

  if (field === 'filter') {
    const reading = inspectable(ownDataProperty(input, 'filter'));
    if (reading !== undefined) {
      const rejection = inspectFilterInput(reading.value);
      if (rejection?.reason === 'unsupported_key' || rejection?.reason === 'unsupported_operator') {
        return { field: 'filter', reason: 'filter_unsupported' };
      }
    }
  }

  return { field, reason: 'invalid' };
};

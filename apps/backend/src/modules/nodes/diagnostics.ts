import type { DecodeFailure } from '@raphael/contracts';
import { inspectFilterInput, inspectQueryInput, inspectTitleInput } from '@raphael/contracts/nodes';

import { InvalidInput, type RequestField } from './errors.ts';

/**
 * Turning a decode failure into a public one without carrying the payload with it.
 *
 * The decoder's issues are not publishable. Their messages come from Effect's array formatter and can
 * contain the submitted value, and the JSON-safety messages can contain arbitrary submitted property
 * names. So nothing from `issues[].message` is ever forwarded - not even where a refinement happens to
 * use a static sentence today, because that is a property of the current messages rather than a
 * guarantee. What survives is the *location*, and only when it names a field we already know.
 *
 * There are three exceptions, and they work the same way: `title`, `queries` and `filter` each have a
 * shared inspection helper in contracts, so the *policy* is not restated here. The submitted value is
 * re-inspected through that helper and only its controlled reason and limit are published - never a
 * decoder message, never the query text, never a submitted key name.
 *
 * Each reads the submitted value through `ownDataProperty`, and so does the `queries` element read,
 * which is what stops a getter on a programmatic payload being invoked while an error is being built.
 * The guarantee stops one level further down: `inspectFilterInput` reads each of the three known keys
 * off the submitted filter with an ordinary property access, so an accessor defined there *is*
 * invoked. That is reachable only from an in-process caller - network JSON has plain data properties
 * throughout - and a throwing accessor is caught by the operation's own `Effect.try`, which reports an
 * internal failure rather than leaking anything. It is stated here rather than guarded, because the
 * alternative is a second value-reading discipline inside a contract helper two clients also call.
 */

export const CREATE_FIELDS: ReadonlySet<RequestField> = new Set<RequestField>([
  'type',
  'kind',
  'parent',
  'title',
  'slug',
  'description',
  'body',
  'tags',
  'metadata',
  'idempotencyKey',
  'format',
]);

export const GET_FIELDS: ReadonlySet<RequestField> = new Set<RequestField>(['target', 'format']);
export const LIST_FIELDS: ReadonlySet<RequestField> = new Set<RequestField>([
  'scopes',
  'recursive',
  'filter',
  'orderBy',
  'skip',
  'limit',
]);

/** The same page, with queries in place of an ordering. */
export const SEARCH_FIELDS: ReadonlySet<RequestField> = new Set<RequestField>([
  'scopes',
  'recursive',
  'filter',
  'queries',
  'skip',
  'limit',
]);
export const GET_PATH_FIELDS: ReadonlySet<RequestField> = new Set<RequestField>(['target']);

/**
 * `tags` is deliberately absent: the update envelope has no such field. The 25-tag bound is on the
 * *resulting* set, which only core can compute, so its refusal is raised directly rather than
 * attributed by this allowlist - which only ever names fields a decoder can point at.
 */
export const UPDATE_FIELDS: ReadonlySet<RequestField> = new Set<RequestField>([
  'target',
  'revision',
  'title',
  'slug',
  'description',
  'body',
  'addTags',
  'removeTags',
  'active',
  'format',
]);

/**
 * A malformed slug inside the explicit destination form has issue path `['destination', 'slug']`;
 * `failedField` reads the head, so it is attributed to `destination`, the field the caller edited.
 */
export const MOVE_FIELDS: ReadonlySet<RequestField> = new Set<RequestField>([
  'target',
  'revision',
  'destination',
]);

/**
 * Reads one own data property.
 *
 * The three outcomes are deliberately distinct. An **absent** property is information - a missing title
 * is a missing title - while a property that cannot be read safely tells us nothing at all. A rejected
 * payload can be a programmatic value rather than parsed JSON, and invoking an accessor to improve an
 * error message would run someone else's code during error handling, so an accessor is treated as
 * unreadable rather than called. Network JSON always has ordinary data properties.
 */
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
 * The issue location that names the field this operation should report, out of everything the decoder
 * complained about.
 *
 * Taking the first allowlisted head is not sufficient once a request schema is a union. Every member
 * whose discriminant did not match reports an issue against `type`, so a container that merely forgot
 * its title produces issues at `type` *and* `title` - and reporting `type` would tell someone their node
 * type was wrong when it was the one thing they got right. It would also cost the only specific recovery
 * copy this capability has, since `title_required` is derived below from a `title` attribution.
 *
 * So `type` is reported only when it is the *only* thing named. A genuinely unknown type produces
 * nothing else, because no member got far enough to check anything else; anything more specific means
 * some member accepted the discriminant and is telling us what was actually wrong with the request.
 *
 * This is about attribution, not about tolerance: the request is refused either way, and nothing from a
 * decoder message is ever published.
 */
const failedField = (
  failure: DecodeFailure,
  allowlist: ReadonlySet<RequestField>,
): RequestField | undefined => {
  let discriminant: RequestField | undefined;
  for (const issue of failure.issues) {
    const [head] = issue.path;
    if (typeof head !== 'string' || !allowlist.has(head as RequestField)) continue;
    const field = head as RequestField;
    if (field === 'type') {
      discriminant ??= field;
      continue;
    }
    return field;
  }
  return discriminant;
};

/**
 * Builds the public `invalid_input` failure for a rejected request. A location we cannot attribute to a
 * known field is reported as the request as a whole rather than guessed at.
 */
/** The value a property reading yields for inspection: absent reads as `undefined`. */
const inspectable = (reading: PropertyReading): { readonly value: unknown } | undefined =>
  reading.kind === 'unreadable'
    ? undefined
    : { value: reading.kind === 'absent' ? undefined : reading.value };

/**
 * The position of the first `queries` element the decoder complained about.
 *
 * The decoder can also fail on the list itself - `minItems`, `maxItems`, not an array - and those
 * issues have no numeric second segment. There is nothing to inspect in that case, so the request is
 * reported as an ordinary invalid one.
 */
const failedQueryIndex = (failure: DecodeFailure): number | undefined => {
  for (const issue of failure.issues) {
    const [head, position] = issue.path;
    if (head === 'queries' && typeof position === 'number') return position;
  }
  return undefined;
};

export const invalidInputFrom = (
  failure: DecodeFailure,
  allowlist: ReadonlySet<RequestField>,
  input: unknown,
): InvalidInput => {
  const field = failedField(failure, allowlist);
  if (field === undefined) return new InvalidInput({ reason: 'invalid' });

  if (field === 'title') {
    // An absent property is inspected as `undefined`, which the shared helper reads as a missing title.
    // Only an unreadable one skips inspection entirely.
    const reading = inspectable(ownDataProperty(input, 'title'));
    const rejection = reading === undefined ? undefined : inspectTitleInput(reading.value);
    if (rejection !== undefined && rejection.reason !== 'not_string') {
      return new InvalidInput({
        field: 'title',
        reason: rejection.reason,
        ...(rejection.limit === undefined ? {} : { limit: rejection.limit }),
      });
    }
  }

  if (field === 'queries') {
    const position = failedQueryIndex(failure);
    const reading = inspectable(ownDataProperty(input, 'queries'));
    const submitted = reading?.value;
    if (position !== undefined && Array.isArray(submitted)) {
      // The element is read the same way the property was, so an accessor on the submitted array is
      // not invoked either. An unreadable element inspects as `undefined`, which reads as not a string.
      const element = inspectable(ownDataProperty(submitted, String(position)));
      const rejection = inspectQueryInput(element?.value);
      // A bound publishes the bound it was measured against; every other malformation is one reason,
      // because the distinctions inside it are for the person typing, not for a client to act on.
      if (rejection?.reason === 'too_long' || rejection?.reason === 'too_many_terms') {
        return new InvalidInput({
          field: 'queries',
          reason: rejection.reason === 'too_long' ? 'query_too_long' : 'query_too_many_terms',
          ...(rejection.limit === undefined ? {} : { limit: rejection.limit }),
        });
      }
      if (rejection !== undefined && rejection.reason !== 'not_string') {
        return new InvalidInput({ field: 'queries', reason: 'query_malformed' });
      }
    }
  }

  if (field === 'filter') {
    const reading = inspectable(ownDataProperty(input, 'filter'));
    if (reading !== undefined) {
      const rejection = inspectFilterInput(reading.value);
      // Only a key or an operator we do not support earns the specific reason. Everything else wrong
      // with a filter - a bad value, an empty `$in`, a repeat, a non-object - is an ordinary invalid
      // field, because there is nothing more a caller could do with a finer name for it.
      if (rejection?.reason === 'unsupported_key' || rejection?.reason === 'unsupported_operator') {
        return new InvalidInput({ field: 'filter', reason: 'filter_unsupported' });
      }
    }
  }

  return new InvalidInput({ field, reason: 'invalid' });
};

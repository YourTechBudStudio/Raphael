import type { DecodeFailure } from '@raphael/contracts';
import { inspectTitleInput } from '@raphael/contracts/nodes';

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
 * The one exception is the title, which is the only field mobile submits and the only one whose
 * failure needs specific recovery copy. Its reason is re-derived through the shared inspection helper
 * in contracts, so the policy is not restated here, and only that helper's controlled reason and limit
 * are published.
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
  'parent',
  'recursive',
  'types',
  'orderBy',
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
export const invalidInputFrom = (
  failure: DecodeFailure,
  allowlist: ReadonlySet<RequestField>,
  input: unknown,
): InvalidInput => {
  const field = failedField(failure, allowlist);
  if (field === undefined) return new InvalidInput({ reason: 'invalid' });

  if (field === 'title') {
    const property = ownDataProperty(input, 'title');
    // An absent property is inspected as `undefined`, which the shared helper reads as a missing title.
    // Only an unreadable one skips inspection entirely.
    const rejection =
      property.kind === 'unreadable'
        ? undefined
        : inspectTitleInput(property.kind === 'absent' ? undefined : property.value);
    if (rejection !== undefined && rejection.reason !== 'not_string') {
      return new InvalidInput({
        field: 'title',
        reason: rejection.reason,
        ...(rejection.limit === undefined ? {} : { limit: rejection.limit }),
      });
    }
  }

  return new InvalidInput({ field, reason: 'invalid' });
};

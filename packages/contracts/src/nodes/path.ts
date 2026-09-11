import { Either } from 'effect';

import { isCanonicalSlugShape } from './slug.ts';

/** The virtual root. It is a valid scope for create and list, and never selects an entity. */
export const ROOT_PATH = '/';

export type PathRejectionReason =
  | 'not_absolute'
  | 'trailing_separator'
  | 'empty_segment'
  | 'noncanonical_segment';

export interface PathRejection {
  readonly reason: PathRejectionReason;
  /** Index of the offending segment, where present. */
  readonly segment: number | undefined;
}

/**
 * Parses an absolute path into its segments; the root parses to no segments.
 *
 * Every segment must satisfy the complete canonical slug grammar, which is what rejects `.`, `..`,
 * uppercase, and noncanonical normalization without needing separate rules for them. Segment length is
 * not bounded here: a path names slugs that already exist, so enforcing today's submission bound would
 * refuse to address a node the server is willing to store rather than preventing anything. Nothing is
 * rewritten: a noncanonical path is an error, because quietly repairing an address would resolve a
 * different node than the caller asked for. The value is the decoded JSON string, so no URL decoding
 * is applied to it — JSON's own escaping has already been handled by the parser.
 *
 * Length is bounded only by the shared request budget. An exceptionally deep hierarchy can therefore
 * require ID access; that is a limit on submitted selectors, not on how deep the hierarchy may be.
 */
export const parsePath = (value: string): Either.Either<readonly string[], PathRejection> => {
  if (!value.startsWith('/')) return Either.left({ reason: 'not_absolute', segment: undefined });
  if (value === ROOT_PATH) return Either.right([]);
  if (value.endsWith('/')) {
    return Either.left({ reason: 'trailing_separator', segment: undefined });
  }

  const segments = value.slice(1).split('/');
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) return Either.left({ reason: 'empty_segment', segment: index });
    if (!isCanonicalSlugShape(segment)) {
      return Either.left({ reason: 'noncanonical_segment', segment: index });
    }
  }
  return Either.right(segments);
};

export const isCanonicalPath = (value: string): boolean => Either.isRight(parsePath(value));

/** True for a canonical path that addresses an entity, which the root never does. */
export const isEntityPath = (value: string): boolean =>
  value !== ROOT_PATH && isCanonicalPath(value);

export const formatPath = (segments: readonly string[]): string =>
  segments.length === 0 ? ROOT_PATH : `/${segments.join('/')}`;

export const describePathRejection = (rejection: PathRejection): string => {
  const at = rejection.segment === undefined ? '' : ` at segment ${rejection.segment + 1}`;
  switch (rejection.reason) {
    case 'not_absolute':
      return 'a path must start with "/"';
    case 'trailing_separator':
      return 'a path must not end with "/"';
    case 'empty_segment':
      return `a path must not contain an empty segment${at}`;
    case 'noncanonical_segment':
      return `a path segment must be a canonical slug${at}`;
  }
};

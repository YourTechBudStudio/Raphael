import { InternalFailure, SlugConflict, type NodeError } from './errors.ts';

/**
 * SQLite names columns, not indexes, in a unique violation, so only these exact messages mean a slug
 * clash. A reworded message degrades to an internal failure, which is the safe direction.
 */
const SLUG_CONFLICT_SCOPES = new Map<string, 'root' | 'sibling'>([
  ['UNIQUE constraint failed: nodes.slug', 'root'],
  ['UNIQUE constraint failed: nodes.parent_id, nodes.slug', 'sibling'],
]);

export interface FailureContext {
  readonly operation: string;
  /** Names the failing stage in the operator's log. */
  readonly stage: string;
  /** Supplied only around a statement that writes this slug, so no other unique violation is misread. */
  readonly slug?: string;
}

/** Classifies an unexpected exception. Only a slug clash is the caller's; everything else is ours. */
export const classifyFailure = (context: FailureContext, cause: unknown): NodeError => {
  const { code, message } = (cause ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !code.startsWith('SQLITE_')) {
    return new InternalFailure({
      operation: context.operation,
      detail: `the ${context.stage} stage failed unexpectedly`,
      cause,
    });
  }

  const scope = typeof message === 'string' ? SLUG_CONFLICT_SCOPES.get(message) : undefined;
  if (scope !== undefined && code === 'SQLITE_CONSTRAINT_UNIQUE' && context.slug !== undefined) {
    return new SlugConflict({ field: 'slug', slug: context.slug, scope });
  }

  return new InternalFailure({
    operation: context.operation,
    detail: `storage rejected the ${context.stage} stage with ${code}`,
    cause,
  });
};

/**
 * better-sqlite3 transactions are synchronous, and returning a failure would commit, so a decided
 * failure leaves one as this exception and `unwrapFailure` recovers it after the rollback.
 */
class CarriedFailure extends Error {
  readonly failure: NodeError;
  constructor(failure: NodeError) {
    super(`carried ${failure._tag}`);
    this.name = 'CarriedFailure';
    this.failure = failure;
  }
}

/** Abort synchronous work with a decided domain failure. */
export const raise = (failure: NodeError): never => {
  throw new CarriedFailure(failure);
};

/** Recover a carried failure, or classify a genuine exception. */
export const unwrapFailure = (context: FailureContext, cause: unknown): NodeError =>
  cause instanceof CarriedFailure ? cause.failure : classifyFailure(context, cause);

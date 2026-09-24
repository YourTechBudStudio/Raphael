import { InternalFailure, SlugConflict, StorageBusy, type NodeError } from './errors.ts';

/**
 * Turning a driver exception into a domain failure, and refusing to do so where the evidence does not
 * support it.
 *
 * This module exists because the obvious assumption is wrong. SQLite does not report the names of the
 * indexes it enforces: a unique violation names *columns*, and a foreign-key violation names nothing
 * at all. Measured against `better-sqlite3@13.0.3` and the migrated schema:
 *
 * ```text
 * root slug duplicate      SQLITE_CONSTRAINT_UNIQUE      UNIQUE constraint failed: nodes.slug
 * sibling slug duplicate   SQLITE_CONSTRAINT_UNIQUE      UNIQUE constraint failed: nodes.parent_id, nodes.slug
 * missing parent           SQLITE_CONSTRAINT_FOREIGNKEY  FOREIGN KEY constraint failed
 * mistyped parent          SQLITE_CONSTRAINT_FOREIGNKEY  FOREIGN KEY constraint failed
 * replay key duplicate     SQLITE_CONSTRAINT_PRIMARYKEY  UNIQUE constraint failed: creation_replays.key
 * ```
 *
 * Three consequences are load-bearing. A missing parent and a mistyped parent are indistinguishable,
 * so parentage is validated in core *before* the insert and a foreign-key violation afterwards is a
 * bug of ours rather than a user error. A replay-key collision is `PRIMARYKEY`, not `UNIQUE`, so a
 * classifier keyed on `UNIQUE` alone would have misread it. And only the slug indexes are recognized
 * from an error, by an exact code-and-message pair: if a future SQLite reworded that diagnostic, a
 * slug conflict degrades to an internal failure, which is the safe direction to fail.
 */

/** Only these two messages mean a slug conflict. Nothing looser is matched. */
const SLUG_CONFLICT_SCOPES = new Map<string, 'root' | 'sibling'>([
  ['UNIQUE constraint failed: nodes.slug', 'root'],
  ['UNIQUE constraint failed: nodes.parent_id, nodes.slug', 'sibling'],
]);

/** How far to follow `cause` before giving up. A wrapper chain is short; a cycle is not our problem. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Finds the SQLite result code in a possibly-wrapped exception.
 *
 * Drizzle currently rethrows the driver's own `SqliteError` unwrapped, which was verified rather than
 * assumed, but a future wrapper must not silently disable classification. The walk is bounded and
 * cycle-aware, and it only ever reads a `code` property: a wrapper's *message* can contain SQL text
 * and bound parameters, so no wrapper message is ever parsed.
 */
export const findSqliteError = (
  error: unknown,
): { readonly code: string; readonly message: string } | undefined => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);

    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_')) {
      const message = (current as { message?: unknown }).message;
      return { code, message: typeof message === 'string' ? message : '' };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/**
 * Whether a code belongs to SQLite's busy family.
 *
 * Delimited deliberately, so `SQLITE_BUSYSOMETHING` is not swept in while a documented extended code
 * such as `SQLITE_BUSY_SNAPSHOT` is. This classifies by error family; it is not a claim that every
 * future member of that family supports identical recovery. `SQLITE_LOCKED` is excluded on purpose:
 * it can mean same-connection statement or schema misuse, which is a bug rather than contention.
 */
export const isBusyCode = (code: string): boolean =>
  code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_');

export interface FailureContext {
  readonly operation: string;
  /**
   * Which stage of the operation was running. It names the failing subsystem when the exception is not a
   * storage one, so a parser or projection fault is not diagnosed as a database problem.
   */
  readonly stage: string;
  /**
   * The slug being written, so a recognized unique violation can name the address that clashed. Only
   * supplied around a statement that writes a slug, so an unrelated unique violation is never
   * misreported as an address clash.
   */
  readonly slug?: string;
}

/**
 * Classifies an unexpected exception.
 *
 * The presence of a SQLite result code is what decides whether this is a storage failure, rather than
 * which block the exception came from. That matters in both directions: a stage that never touches the
 * database cannot have a parser fault reported as a rejected query, and a block that does touch it is
 * still classified properly even when the two are wrapped together. With no SQLite code present, the
 * stage is what the diagnostic names.
 */
export const classifyFailure = (context: FailureContext, cause: unknown): NodeError => {
  const sqlite = findSqliteError(cause);
  if (sqlite === undefined) {
    return new InternalFailure({
      operation: context.operation,
      detail: `the ${context.stage} stage failed unexpectedly`,
      cause,
    });
  }

  if (isBusyCode(sqlite.code)) {
    return new StorageBusy({ operation: context.operation });
  }

  const scope = SLUG_CONFLICT_SCOPES.get(sqlite.message);
  if (
    scope !== undefined &&
    sqlite.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    context.slug !== undefined
  ) {
    return new SlugConflict({ field: 'slug', slug: context.slug, scope });
  }

  return new InternalFailure({
    operation: context.operation,
    detail: `storage rejected the ${context.stage} stage with ${sqlite.code}`,
    cause,
  });
};

/**
 * A `NodeError` in flight through synchronous code.
 *
 * better-sqlite3 transactions are synchronous functions, so a failure inside one has to be an
 * exception: returning a failure value would commit the transaction. This wrapper carries the already
 * decided domain failure out through the rollback, where `unwrapFailure` recovers it. Only genuinely
 * unexpected exceptions reach the classifier.
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

import { parsePath } from '@raphael/contracts/nodes';
import { and, eq, isNull } from 'drizzle-orm';
import { Either } from 'effect';

import {
  InternalFailure,
  InvalidInput,
  InvalidParent,
  NodeNotFound,
  type SelectorField,
} from './errors.ts';
import { nodes } from './schema.ts';
import { raise } from './storage-failures.ts';
import type { Orm } from './store.ts';
import {
  isNodeType,
  type NodeType,
  type ResolvedScope,
  type ResolvedScopes,
  type StoredEntity,
  type StoredNode,
  type StoredSummary,
} from './types.ts';

/**
 * One resolution path for both selector forms.
 *
 * An id lookup hits the primary key; a path lookup walks one indexed sibling segment at a time, which
 * is the same index that answers a child listing. Both end in the same validated `StoredNode`, so no
 * caller has to know which form it was given, and neither form can reach a node the other could not.
 *
 * Everything here is synchronous and is called from inside a transaction. The root is returned as its
 * own scope rather than as a fabricated row: it has no identity, revision, or authored fields to
 * invent, and a caller that must treat it differently should be made to say so.
 */

const NODE_COLUMNS = {
  id: nodes.id,
  type: nodes.type,
  parentId: nodes.parentId,
  slug: nodes.slug,
} as const;

/**
 * Validates a stored type. A type outside the schema's own set means the row was written by something
 * that did not respect the schema, which is an integrity failure rather than a caller's problem.
 */
const storedNode = (
  row: { id: number; type: string; parentId: number | null; slug: string },
  operation: string,
): StoredNode => {
  if (!isNodeType(row.type)) {
    return raise(
      new InternalFailure({ operation, detail: 'a stored node carries an unrecognized type' }),
    );
  }
  if (!Number.isSafeInteger(row.id) || row.id <= 0) {
    return raise(
      new InternalFailure({ operation, detail: 'a stored node carries an unusable identity' }),
    );
  }
  return { id: row.id, type: row.type, parentId: row.parentId, slug: row.slug };
};

const byId = (orm: Orm, id: number, operation: string): StoredNode | undefined => {
  const row = orm.select(NODE_COLUMNS).from(nodes).where(eq(nodes.id, id)).get();
  return row === undefined ? undefined : storedNode(row, operation);
};

/**
 * Walks an absolute path, one segment at a time.
 *
 * The two lookups differ only in how they name the parent, because SQLite treats NULLs as distinct and
 * the root siblings therefore have their own partial unique index. Each step is an index hit, and the
 * walk stops at the first segment that does not resolve.
 */
const byPath = (
  orm: Orm,
  segments: readonly string[],
  operation: string,
): StoredNode | undefined => {
  let parentId: number | null = null;
  let found: StoredNode | undefined;
  for (const segment of segments) {
    const row: { id: number; type: string; parentId: number | null; slug: string } | undefined =
      parentId === null
        ? orm
            .select(NODE_COLUMNS)
            .from(nodes)
            .where(and(isNull(nodes.parentId), eq(nodes.slug, segment)))
            .get()
        : orm
            .select(NODE_COLUMNS)
            .from(nodes)
            .where(and(eq(nodes.parentId, parentId), eq(nodes.slug, segment)))
            .get();
    if (row === undefined) return undefined;
    found = storedNode(row, operation);
    parentId = found.id;
  }
  return found;
};

export type Selector = { readonly id: number } | { readonly path: string };

export type { SelectorField };

/**
 * Resolves a selector without deciding what its absence means: `undefined` is "nothing is there".
 * `resolveScope` raises `NodeNotFound` over this; the move operation reads `undefined` as "an address
 * rather than a container".
 *
 * A root path is the root scope. The path grammar was already validated by the request decoder, so
 * re-parsing here is about obtaining segments rather than re-deciding validity - but it is still
 * checked, because an internal caller reaches these operations through the same decode boundary and a
 * malformed path must not become a silent empty walk.
 */
export const lookupScope = (
  orm: Orm,
  selector: Selector,
  field: SelectorField,
  operation: string,
): ResolvedScope | undefined => {
  if ('id' in selector) {
    const node = byId(orm, selector.id, operation);
    return node === undefined ? undefined : { kind: 'node', node };
  }

  // No index on this one, deliberately. `ScopePath` is refined by `isCanonicalPath`, which is
  // `parsePath`, so a path that reaches here through the decode boundary has already been accepted;
  // this branch survives only for the internal caller the comment above describes.
  const segments = parsePath(selector.path);
  if (Either.isLeft(segments)) return raise(new InvalidInput({ field, reason: 'invalid' }));
  if (segments.right.length === 0) return { kind: 'root' };

  const node = byPath(orm, segments.right, operation);
  return node === undefined ? undefined : { kind: 'node', node };
};

/**
 * Resolves a selector to a scope that must exist.
 *
 * `index` is carried in rather than recovered afterwards because `raise` throws: a caller cannot
 * observe *which* selector failed once the failure is in flight, so the position has to be attached
 * where the failure is built. Single-selector callers pass nothing and keep reporting no position.
 */
export const resolveScope = (
  orm: Orm,
  selector: Selector,
  field: SelectorField,
  operation: string,
  index?: number,
): ResolvedScope =>
  lookupScope(orm, selector, field, operation) ??
  raise(new NodeNotFound({ field, ...(index === undefined ? {} : { index }) }));

/**
 * Resolves the scope union both page operations take.
 *
 * A scope that does not resolve refuses the **whole** request. Answering from the scopes that did
 * resolve would need a coverage field the response does not have, and without one `hasMore: false`
 * would quietly come to mean "and one of your scopes was ignored". Partial coverage in ADR 0001 is
 * about a *source* that failed, not about a caller naming something that is not there.
 *
 * Nothing is caught here: the first selector that does not resolve raises from inside `resolveScope`
 * with its position already attached. Ids are deduplicated, so two spellings of one node - an id and
 * its path - contribute it once, which is what the contract relies on when it refuses only literal
 * repeats.
 */
export const resolveScopes = (
  orm: Orm,
  selectors: readonly Selector[],
  operation: string,
): ResolvedScopes => {
  let root = false;
  const nodeIds = new Set<number>();

  for (const [index, selector] of selectors.entries()) {
    const scope = resolveScope(orm, selector, 'scopes', operation, index);
    if (scope.kind === 'root') root = true;
    else nodeIds.add(scope.node.id);
  }

  return { root, nodeIds: [...nodeIds] };
};

/**
 * Resolves a selector that must name an entity rather than the root.
 *
 * There is no longer a second check for a type the operations cannot return: every stored type is one
 * they return, and a string outside that set was already refused as an integrity failure by
 * `storedNode` on the way out of storage. The refusal that used to live here described a gap between
 * what storage held and what the API admitted, and that gap is now closed.
 */
export const resolveEntity = (
  orm: Orm,
  selector: Selector,
  field: SelectorField,
  operation: string,
): StoredNode => {
  const scope = resolveScope(orm, selector, field, operation);
  if (scope.kind === 'root') {
    // Only reachable through an internal caller: the request schemas refuse the root as an entity.
    return raise(new InvalidInput({ field, reason: 'invalid' }));
  }
  return scope.node;
};

/**
 * The columns a summary and an entity response are built from.
 *
 * Exactly the sets `StoredSummary` and `StoredEntity` declare and the projections publish, named once:
 * the entity list is the summary list plus the two stored JSON documents, so the two cannot drift. A
 * column list copied per caller is a list that drifts: adding a field to the contract would mean
 * editing selects that share no symbol, and the one that was missed would fail its own response decode
 * rather than saying what went wrong. (`projection.ts::SUMMARY_COLUMNS` is the raw-SQL aliasing of the
 * same summary set for the page queries; both are held to `StoredSummary`.)
 */
const SUMMARY_COLUMNS_OF_NODES = {
  id: nodes.id,
  type: nodes.type,
  kind: nodes.kind,
  parentId: nodes.parentId,
  slug: nodes.slug,
  revision: nodes.revision,
  title: nodes.title,
  description: nodes.description,
  tags: nodes.tags,
  active: nodes.active,
} as const;

const ENTITY_COLUMNS = {
  ...SUMMARY_COLUMNS_OF_NODES,
  body: nodes.body,
  metadata: nodes.metadata,
} as const;

/**
 * Resolves a selector and loads the whole entity behind it.
 *
 * Takes the query handle rather than the connection, so it composes into either transaction shape: a
 * read for an ordinary projection, and - when lifecycle arrives (ADR 0002) - the write transaction that
 * must check eligibility atomically with the mutation. It opens no transaction of its own, because the
 * caller is the one that knows which guarantee it needs.
 */
export const loadEntity = (
  orm: Orm,
  selector: Selector,
  field: SelectorField,
  operation: string,
): StoredEntity => {
  const node = resolveEntity(orm, selector, field, operation);
  const entity = orm.select(ENTITY_COLUMNS).from(nodes).where(eq(nodes.id, node.id)).get();
  if (entity === undefined) {
    // Resolution just found this row inside the same snapshot, so its disappearance is not a missing
    // node; something is wrong with the read itself.
    return raise(new InternalFailure({ operation, detail: 'a resolved node did not load' }));
  }
  return entity as StoredEntity;
};

/**
 * `loadEntity` without the body and metadata, for a write that must not read a document under the
 * immediate writer's lock and has no use for one. The move is that write.
 */
export const loadSummary = (
  orm: Orm,
  selector: Selector,
  field: SelectorField,
  operation: string,
): StoredSummary => {
  const node = resolveEntity(orm, selector, field, operation);
  const summary = orm
    .select(SUMMARY_COLUMNS_OF_NODES)
    .from(nodes)
    .where(eq(nodes.id, node.id))
    .get();
  if (summary === undefined) {
    return raise(new InternalFailure({ operation, detail: 'a resolved node did not load' }));
  }
  return summary as StoredSummary;
};

/**
 * `start` and every ancestor above it, nearest first, ending at a root-level node.
 *
 * Iterative, with the visited set as the cycle detector. That choice is for legibility rather than
 * necessity - SQL could terminate a recursive walk by deduplicating identities - but it detects a cycle
 * *exactly*, at the row that closes it, without a depth cap. There is no product limit on how deep a
 * hierarchy may be, so a guessed cap would have invented one.
 *
 * Ordinary writes cannot form a cycle - creation cannot, and a move refuses one - and the parent
 * foreign key is `RESTRICT`, so neither a cycle nor a missing ancestor should be reachable. Both are
 * therefore integrity failures in data we wrote, not caller errors, and neither is repaired here. Two
 * callers: `getNodePath` maps the chain to slugs; `moveNode` asks whether the target is in it.
 */
export const ancestorChain = (
  orm: Orm,
  start: StoredNode,
  operation: string,
): readonly StoredNode[] => {
  const chain: StoredNode[] = [start];
  const seen = new Set<number>([start.id]);
  let parentId = start.parentId;
  while (parentId !== null) {
    if (seen.has(parentId)) {
      return raise(new InternalFailure({ operation, detail: 'stored ancestry contains a cycle' }));
    }
    seen.add(parentId);
    const ancestor = byId(orm, parentId, operation);
    if (ancestor === undefined) {
      return raise(
        new InternalFailure({
          operation,
          detail: 'stored ancestry names a node that does not exist',
        }),
      );
    }
    chain.push(ancestor);
    parentId = ancestor.parentId;
  }
  return chain;
};

/**
 * The parentage rules, as a product decision rather than a schema accident.
 *
 * ```text
 * root    -> area only
 * area    -> area, project, resource
 * project -> resource
 * resource -> nothing
 * ```
 *
 * A resource can be named as a parent - it exists - but holds nothing, and saying so is a different
 * answer from pretending the selector found nothing.
 *
 * This is now the full rule rather than the area-only subset it was while resources could not be
 * created. Storage already permitted every pairing below through `nodes_allowed_parentage`; what
 * changed is that the operation stopped refusing things the schema was always willing to accept.
 *
 * This runs before the write, which is not merely tidier: SQLite reports a foreign-key violation
 * without saying which constraint or column failed, so a violation discovered afterwards could not be
 * attributed to the caller's choice of parent even if we wanted to. `field` is the request field that
 * named the parent: `parent` for a creation, `destination` for a move.
 */
export const validateParentage = (
  scope: ResolvedScope,
  childType: NodeType,
  field: 'parent' | 'destination',
): void => {
  const refuse = (parentType: NodeType | 'root'): never =>
    raise(new InvalidParent({ field, reason: 'parentage', parentType, childType }));
  if (scope.kind === 'root') {
    if (childType !== 'area') refuse('root');
    return;
  }
  const parentType = scope.node.type;
  if (parentType === 'area') return;
  if (parentType === 'project' && childType === 'resource') return;
  refuse(parentType);
};

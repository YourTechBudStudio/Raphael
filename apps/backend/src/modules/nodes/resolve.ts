import { parsePath } from '@raphael/contracts/nodes';
import { and, eq, isNull } from 'drizzle-orm';
import { Either } from 'effect';

import { InternalFailure, InvalidInput, InvalidParent, NodeNotFound } from './errors.ts';
import { nodes } from './schema.ts';
import { raise } from './storage-failures.ts';
import type { Orm } from './store.ts';
import {
  isNodeType,
  type NodeType,
  type ResolvedScope,
  type StoredEntity,
  type StoredNode,
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

/**
 * Resolves a selector to a scope. A root path is the root scope; anything else must resolve to a row.
 *
 * The path grammar was already validated by the request decoder, so re-parsing here is about obtaining
 * segments rather than re-deciding validity - but it is still checked, because an internal caller
 * reaches these operations through the same decode boundary and a malformed path must not become a
 * silent empty walk.
 */
export const resolveScope = (
  orm: Orm,
  selector: Selector,
  field: 'target' | 'parent',
  operation: string,
): ResolvedScope => {
  if ('id' in selector) {
    const node = byId(orm, selector.id, operation);
    if (node === undefined) return raise(new NodeNotFound({ field }));
    return { kind: 'node', node };
  }

  const segments = parsePath(selector.path);
  if (Either.isLeft(segments)) return raise(new InvalidInput({ field, reason: 'invalid' }));
  if (segments.right.length === 0) return { kind: 'root' };

  const node = byPath(orm, segments.right, operation);
  if (node === undefined) return raise(new NodeNotFound({ field }));
  return { kind: 'node', node };
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
  field: 'target' | 'parent',
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
 * The columns an entity response is built from.
 *
 * Exactly the set `StoredEntity` declares and `entityProjection` publishes, named once. Two operations
 * load this row and a third will when lifecycle lands, and a column list copied per caller is a list
 * that drifts: adding a field to the entity contract would mean editing selects that share no symbol,
 * and the one that was missed would fail its own response decode rather than saying what went wrong.
 */
const ENTITY_COLUMNS = {
  id: nodes.id,
  type: nodes.type,
  kind: nodes.kind,
  parentId: nodes.parentId,
  slug: nodes.slug,
  revision: nodes.revision,
  title: nodes.title,
  description: nodes.description,
  tags: nodes.tags,
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
  field: 'target' | 'parent',
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
 * This runs before the insert, which is not merely tidier: SQLite reports a foreign-key violation
 * without saying which constraint or column failed, so a violation discovered afterwards could not be
 * attributed to the caller's choice of parent even if we wanted to.
 */
export const validateParentage = (scope: ResolvedScope, childType: NodeType): void => {
  if (scope.kind === 'root') {
    if (childType !== 'area') raise(new InvalidParent({ parentType: 'root', childType }));
    return;
  }
  const parentType = scope.node.type;
  if (parentType === 'area') return;
  if (parentType === 'project' && childType === 'resource') return;
  raise(new InvalidParent({ parentType, childType }));
};

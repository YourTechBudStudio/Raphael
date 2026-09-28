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
import { favoriteExpression } from './projection.ts';
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
 * One resolution path for both selector forms, called from inside a transaction. The root is its own
 * scope, never a fabricated row.
 */

const NODE_COLUMNS = {
  id: nodes.id,
  type: nodes.type,
  parentId: nodes.parentId,
  slug: nodes.slug,
} as const;

/** A stored type outside the schema's set is an integrity failure. */
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

/** One indexed sibling lookup per segment; root siblings have their own partial unique index. */
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
 * Resolves a selector without deciding what its absence means: `undefined` is "nothing is there",
 * which a move reads as "an address rather than a container".
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

  const segments = parsePath(selector.path);
  if (Either.isLeft(segments)) return raise(new InvalidInput({ field, reason: 'invalid' }));
  if (segments.right.length === 0) return { kind: 'root' };

  const node = byPath(orm, segments.right, operation);
  return node === undefined ? undefined : { kind: 'node', node };
};

/** Resolves a scope that must exist. `index` names the offending entry of a list field. */
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
 * Resolves the scope union both page operations take. One missing scope refuses the whole request,
 * because the response has no way to say a scope was ignored.
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

/** Resolves a selector that must name an entity rather than the root. */
export const resolveEntity = (
  orm: Orm,
  selector: Selector,
  field: SelectorField,
  operation: string,
): StoredNode => {
  const scope = resolveScope(orm, selector, field, operation);
  if (scope.kind === 'root') {
    return raise(new InvalidInput({ field, reason: 'invalid' }));
  }
  return scope.node;
};

/** The Drizzle form of `projection.ts::SUMMARY_COLUMNS`; both are held to `StoredSummary`. */
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
  isFavorite: favoriteExpression(nodes.id),
} as const;

const ENTITY_COLUMNS = {
  ...SUMMARY_COLUMNS_OF_NODES,
  body: nodes.body,
  metadata: nodes.metadata,
} as const;

/** Resolves a selector and loads the whole entity, inside the caller's transaction. */
export const loadEntity = (
  orm: Orm,
  selector: Selector,
  field: SelectorField,
  operation: string,
): StoredEntity => {
  const node = resolveEntity(orm, selector, field, operation);
  const entity = orm.select(ENTITY_COLUMNS).from(nodes).where(eq(nodes.id, node.id)).get();
  if (entity === undefined) {
    return raise(new InternalFailure({ operation, detail: 'a resolved node did not load' }));
  }
  return entity as StoredEntity;
};

/** `loadEntity` without the body and metadata. */
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
 * `start` and every ancestor above it, nearest first. A cycle or a missing ancestor cannot come from
 * our writes, so both are integrity failures.
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
 * Checked before the write, because SQLite's foreign-key errors cannot say which parent was wrong.
 *
 * ```text
 * root     -> area only
 * area     -> area, project, resource
 * project  -> resource
 * resource -> nothing
 * ```
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

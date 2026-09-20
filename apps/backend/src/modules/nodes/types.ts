import { NODE_TYPES, type NodeType, type ResourceKind } from '@raphael/contracts/nodes';

export type { NodeType, ResourceKind };

/**
 * The types storage holds, which is exactly the set the operations accept and return.
 *
 * These were two sets while `resource` existed in the schema but not in the API: a known-but-unexposed
 * type had to be recognizable without being returnable. Now that resources are a public capability the
 * distinction has no referent, and keeping it would mean maintaining a difference that is always empty.
 *
 * What survives the collapse is the check itself. A stored string outside this set means the row was
 * written by something that did not respect the schema, which is an integrity failure in data we wrote
 * rather than a caller's problem - so it is still validated on the way out of storage, never assumed.
 */
const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

export const isNodeType = (value: string): value is NodeType => NODE_TYPE_SET.has(value);

/**
 * A resolved node, as every selector path produces it.
 *
 * Deliberately without `kind`. This is what path resolution and parent lookup produce - one row per
 * path segment - and no parentage rule consults a kind, because a resource cannot be a parent. Reading
 * a column on every segment of every walk to answer a question nothing asks is a cost with no payer.
 * `kind` belongs to the projections that actually publish it, which is where it is selected.
 */
export interface StoredNode {
  readonly id: number;
  readonly type: NodeType;
  readonly parentId: number | null;
  readonly slug: string;
}

/** What a list page needs. Bodies and metadata are deliberately not selected for a listing. */
export interface StoredSummary extends StoredNode {
  /** The stored kind, unvalidated. `projectedKind` decides whether it is one we can publish. */
  readonly kind: string | null;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly tags: string;
  /** The raw stored integer, `0` or `1`. `summaryProjection` is the one place it becomes a boolean. */
  readonly active: number;
}

/** What Get needs: the summary columns plus the two stored JSON documents. */
export interface StoredEntity extends StoredSummary {
  readonly body: string;
  readonly metadata: string;
}

/** A scope is either the virtual root or a stored node. The root is never a fabricated entity. */
export type ResolvedScope =
  | { readonly kind: 'root' }
  | { readonly kind: 'node'; readonly node: StoredNode };

/**
 * A resolved scope *union*, as both page operations take one.
 *
 * It lives here rather than in either of the two modules that use it, so that `resolve.ts`, which
 * produces it, and `scope-page.ts`, which consumes it, do not depend on each other. `nodeIds` is
 * deduplicated: two selectors naming one row contribute it once.
 *
 * **At least one of `root` or an entry in `nodeIds` is always present.** `resolveScopes` contributes
 * exactly one of the two per selector and the contract requires at least one selector, so the empty
 * union cannot arise from a request. It is stated because the type cannot carry it and
 * `membershipFragments` relies on it: an empty union would produce a membership condition with no
 * alternatives, which is not a query that says "nothing" - it is not a query at all. Anyone building
 * one of these by hand owes that invariant.
 */
export interface ResolvedScopes {
  readonly root: boolean;
  readonly nodeIds: readonly number[];
}

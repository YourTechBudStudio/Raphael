import { NODE_TYPES, type NodeType, type ResourceKind } from '@raphael/contracts/nodes';

export type { NodeType, ResourceKind };

const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

export const isNodeType = (value: string): value is NodeType => NODE_TYPE_SET.has(value);

/** A resolved node, as path resolution produces it. No `kind`: no parentage rule needs one. */
export interface StoredNode {
  readonly id: number;
  readonly type: NodeType;
  readonly parentId: number | null;
  readonly slug: string;
}

/** What a list page needs. Bodies and metadata are deliberately not selected for a listing. */
export interface StoredSummary extends StoredNode {
  readonly kind: string | null;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly tags: string;
  /** `0` or `1`. */
  readonly active: number;
  /** `0` or `1`, from `projection.ts::favoriteExpression`. */
  readonly isFavorite: number;
}

/** A page row, with the `archived` flag only the page statement can compute. */
export interface StoredPageSummary extends StoredSummary {
  readonly archived: number;
}

/** One archive cause as it applies to a node: its origin (the node or an ancestor), owner and reason. */
export interface EffectiveCause {
  readonly originId: number;
  readonly originType: NodeType;
  readonly originTitle: string;
  readonly owner: string;
  readonly reason: string;
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
 * A resolved scope union, deduplicated. At least one of `root` or a node id is always present;
 * `membershipFragments` relies on it.
 */
export interface ResolvedScopes {
  readonly root: boolean;
  readonly nodeIds: readonly number[];
}

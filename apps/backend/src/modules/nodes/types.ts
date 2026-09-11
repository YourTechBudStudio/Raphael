import { NODE_TYPES, type NodeType } from '@raphael/contracts/nodes';

export type { NodeType };

/**
 * The types storage holds, which is deliberately wider than the types the operations expose.
 *
 * `resource` exists in the schema and will exist in real databases before it is an exposed capability
 * (ADR 0007). The operations here must therefore be able to *recognize* one without being able to
 * return one: a known-but-unexposed type is a deliberate refusal, not a missing node, and an entirely
 * unrecognized type is an integrity failure in data we wrote. Pretending either is absent would make
 * this layer lie about what is stored.
 */
export const STORED_NODE_TYPES = ['area', 'project', 'resource'] as const;
export type StoredNodeType = (typeof STORED_NODE_TYPES)[number];

const STORED_TYPE_SET: ReadonlySet<string> = new Set(STORED_NODE_TYPES);
const EXPOSED_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

export const isStoredNodeType = (value: string): value is StoredNodeType =>
  STORED_TYPE_SET.has(value);

export const isExposedNodeType = (value: string): value is NodeType => EXPOSED_TYPE_SET.has(value);

/** A resolved node, as every selector path produces it. Its type is validated, never assumed. */
export interface StoredNode {
  readonly id: number;
  readonly type: StoredNodeType;
  readonly parentId: number | null;
  readonly slug: string;
}

/** What a list page needs. Bodies and metadata are deliberately not selected for a listing. */
export interface StoredSummary extends StoredNode {
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly tags: string;
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

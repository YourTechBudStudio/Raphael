import { type CanonicalDocument } from '@raphael/content';
import { toMarkdown } from '@raphael/content/conversion';
import type {
  ArchiveCause,
  BodyFormat,
  NodeEntity,
  NodeSummary,
  ResourceKind,
} from '@raphael/contracts/nodes';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

import type { EffectiveCause, StoredEntity, StoredSummary } from './types.ts';

/**
 * Building responses. Public fields are listed one by one, never spread from a row, so internal
 * columns such as `body_text` and `updated_at` never reach the wire.
 */

export const bodyProjection = (
  document: CanonicalDocument,
  format: BodyFormat,
): NodeEntity['body'] =>
  format === 'markdown'
    ? { format: 'markdown', value: toMarkdown(document) }
    : // A canonical document is JSON; its type only says `unknown` for node content.
      ({ format: 'tiptap', value: document } as unknown as NodeEntity['body']);

/** A stored body. Every write stores the canonical form, so it is only parsed here. */
export const storedBody = (json: string): CanonicalDocument =>
  JSON.parse(json) as CanonicalDocument;

/** Whether a favorite row exists for a node, as `0` or `1`. The one spelling of that rule. */
export const favoriteExpression = (nodeId: SQLWrapper): SQL<number> =>
  sql<number>`EXISTS (SELECT 1 FROM favorites favorite WHERE favorite.node_id = ${nodeId})`;

/** The columns a summary is read from, aliased as `StoredSummary` names them. */
export const SUMMARY_COLUMNS: SQL = sql`n.id AS id, n.type AS type, n.kind AS kind,
  n.parent_id AS parentId, n.slug AS slug, n.revision AS revision, n.title AS title,
  n.description AS description, n.tags AS tags, n.active AS active,
  ${favoriteExpression(sql`n.id`)} AS isFavorite`;

/** `archived` has no default, so every caller states it. */
export const summaryProjection = (row: StoredSummary, archived: boolean): NodeSummary => ({
  id: row.id,
  type: row.type,
  // The table's CHECK constraints tie a kind to resources and `active` to projects.
  kind: row.kind as ResourceKind | null,
  parentId: row.parentId,
  slug: row.slug,
  revision: row.revision,
  title: row.title,
  description: row.description,
  tags: JSON.parse(row.tags) as string[],
  active: row.active === 1,
  archived,
  isFavorite: row.isFavorite === 1,
});

/** Archive causes as the wire names them, nearest origin first. */
export const causeProjection = (causes: readonly EffectiveCause[]): ArchiveCause[] =>
  causes.map((cause) => ({
    origin: { id: cause.originId, type: cause.originType, title: cause.originTitle },
    owner: cause.owner,
    reason: cause.reason,
  }));

export const entityProjection = (
  row: StoredEntity,
  body: NodeEntity['body'],
  causes: readonly EffectiveCause[],
): NodeEntity => ({
  ...summaryProjection(row, causes.length > 0),
  body,
  metadata: JSON.parse(row.metadata) as NodeEntity['metadata'],
  archiveCauses: causeProjection(causes),
});

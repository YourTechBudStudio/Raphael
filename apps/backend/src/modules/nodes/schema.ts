import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Above this, a stored integer is rounded on its way into JavaScript and names a different row. */
export const MAX_SAFE_DB_INTEGER = 9007199254740991;

/** A column that must hold a positive, integral, exactly-representable value. */
const positiveSafeInteger = (column: string) =>
  sql.raw(
    `typeof(${column}) = 'integer' AND ${column} > 0 AND ${column} <= ${MAX_SAFE_DB_INTEGER}`,
  );

/** A column that must hold a non-negative, integral, exactly-representable epoch-millisecond value. */
const safeEpochMillis = (column: string) =>
  sql.raw(
    `typeof(${column}) = 'integer' AND ${column} >= 0 AND ${column} <= ${MAX_SAFE_DB_INTEGER}`,
  );

/**
 * The common node table (ADR 0007). `parent_type` duplicates the parent's type so a CHECK can judge the
 * pairing, and the composite foreign key keeps it honest.
 *
 * The identity trigger and `nodes_fts` live only in `drizzle/0001_triggers_and_seed.sql`. A generated
 * rebuild of `nodes` would drop those triggers, so such a change must be hand-authored.
 */
export const nodes = sqliteTable(
  'nodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    /** Required for a resource, null for a container (`nodes_kind_valid`). */
    kind: text('kind'),
    parentId: integer('parent_id'),
    parentType: text('parent_type'),
    slug: text('slug').notNull(),
    revision: integer('revision').notNull().default(1),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    body: text('body').notNull(),
    tags: text('tags').notNull().default('[]'),
    /** `0` or `1`; only a project may hold `1` (`nodes_active_valid`). */
    active: integer('active').notNull().default(0),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** The plain-text projection of `body`, derived at mutation time (ADR 0005). */
    bodyText: text('body_text').notNull(),
  },
  (t) => [
    // SQLite needs the pair indexed before the composite foreign key can reference it.
    unique('nodes_id_type').on(t.id, t.type),
    foreignKey({
      columns: [t.parentId, t.parentType],
      foreignColumns: [t.id, t.type],
      name: 'nodes_parent_fk',
    }).onDelete('restrict'),

    // Slugs share one namespace across sibling types (ADR 0004). NULL parents compare as distinct in
    // SQLite, so root siblings need their own partial index rather than one combined index.
    uniqueIndex('nodes_sibling_slug')
      .on(t.parentId, t.slug)
      .where(sql`parent_id IS NOT NULL`),
    uniqueIndex('nodes_root_slug')
      .on(t.slug)
      .where(sql`parent_id IS NULL`),

    check('nodes_type_supported', sql`type IN ('area', 'project', 'resource')`),

    // A resource has a kind, a container does not, and a present kind is one core admits.
    check(
      'nodes_kind_valid',
      sql`(type = 'resource') = (kind IS NOT NULL) AND (kind IS NULL OR kind IN ('note'))`,
    ),
    // Only a project can be active.
    check('nodes_active_valid', sql`active IN (0, 1) AND (active = 0 OR type = 'project')`),
    check('nodes_title_present', sql`length(title) > 0`),
    check('nodes_slug_present', sql`length(slug) > 0`),
    check('nodes_id_safe', positiveSafeInteger('id')),
    check('nodes_revision_safe', positiveSafeInteger('revision')),
    check('nodes_created_at_safe', safeEpochMillis('created_at')),
    check('nodes_updated_at_safe', safeEpochMillis('updated_at')),

    // Never NULL: SQLite treats a NULL CHECK result as satisfied.
    check('nodes_parent_pair', sql`(parent_id IS NULL) = (parent_type IS NULL)`),
    check('nodes_root_is_area', sql`parent_type IS NOT NULL OR type = 'area'`),
    check(
      'nodes_allowed_parentage',
      sql`parent_type IS NULL
        OR (parent_type = 'area' AND type IN ('area', 'project', 'resource'))
        OR (parent_type = 'project' AND type = 'resource')`,
    ),
    check('nodes_not_self_parent', sql`parent_id IS NULL OR parent_id <> id`),

    check('nodes_body_json', sql`json_valid(body) AND json_type(body) = 'object'`),
    check('nodes_tags_json', sql`json_valid(tags) AND json_type(tags) = 'array'`),
    check('nodes_metadata_json', sql`json_valid(metadata) AND json_type(metadata) = 'object'`),
  ],
);

/**
 * One row per archive cause, stored only at its origin (ADR 0003); `lifecycle.ts` is its only reader
 * and writer. The primary key makes a repeated archive write nothing.
 */
export const archiveCauses = sqliteTable(
  'archive_causes',
  {
    nodeId: integer('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    owner: text('owner').notNull(),
    reason: text('reason').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'archive_causes_pk', columns: [t.nodeId, t.owner, t.reason] }),
    check('archive_causes_owner_present', sql`length(owner) BETWEEN 1 AND 64`),
    check('archive_causes_reason_present', sql`length(reason) BETWEEN 1 AND 64`),
    check('archive_causes_created_at_safe', safeEpochMillis('created_at')),
  ],
);

/**
 * One row per favorited node, identity only. The primary key makes add and remove idempotent, and
 * nothing here touches `nodes`, so a favorite never changes a revision.
 */
export const favorites = sqliteTable('favorites', {
  nodeId: integer('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'restrict' }),
});

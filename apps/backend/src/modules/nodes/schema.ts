import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * The largest integer JavaScript represents exactly. SQLite stores 64-bit integers, so a value above
 * this survives storage but is rounded on the way back into a JavaScript number - silently naming a
 * different row. Validation downstream cannot recover precision already lost in that conversion, so
 * the constraint belongs here, where the value is still exact.
 */
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
 * The common node table (ADR 0007): one identity space for every entity type, carrying hierarchy,
 * addressing, and the common authored fields.
 *
 * Storage deliberately permits `resource` even though this release's public operations expose only
 * areas and projects. Identity is common; which types the API returns is a product rule, and adding
 * a type to a response is a separate, compatibility-breaking protocol change.
 *
 * Parentage is enforced declaratively rather than by triggers. `parent_type` duplicates the parent's
 * type so that a plain CHECK can decide whether the pairing is legal, and the composite foreign key
 * to `(id, type)` is what keeps that duplicate honest: it cannot name a type the parent does not
 * actually have. The two constraints solve different problems and neither replaces the other. Neither
 * detects a multi-node cycle; that belongs to future move validation.
 */
export const nodes = sqliteTable(
  'nodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    parentId: integer('parent_id'),
    parentType: text('parent_type'),
    slug: text('slug').notNull(),
    revision: integer('revision').notNull().default(1),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    body: text('body').notNull(),
    tags: text('tags').notNull().default('[]'),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    // Required as the parent key of the composite foreign key below. `id` is already unique on its
    // own; SQLite needs the pair to be collectively indexed before it will accept the reference.
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
    check('nodes_title_present', sql`length(title) > 0`),
    check('nodes_slug_present', sql`length(slug) > 0`),
    check('nodes_id_safe', positiveSafeInteger('id')),
    check('nodes_revision_safe', positiveSafeInteger('revision')),
    check('nodes_created_at_safe', safeEpochMillis('created_at')),
    check('nodes_updated_at_safe', safeEpochMillis('updated_at')),

    // Written so the expression can never evaluate to NULL: a NULL CHECK result is treated as
    // satisfied by SQLite, which would let a half-populated parent pair through.
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
 * Historical creation results, keyed by idempotency key (ADR 0002). `result_json` is the complete
 * saved response body, so these rows can hold private note content and carry the same filesystem
 * protection obligation as the rest of the database.
 *
 * Lifetime is independent of the node it describes: a replay must return the historical result even
 * if the node has since been relocated, so there is no cascade from `nodes`.
 */
export const creationReplays = sqliteTable(
  'creation_replays',
  {
    key: text('key').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    // Supports expiry lookup and the periodic collection that phase 05 owns.
    index('creation_replays_expires_at').on(t.expiresAt),
    check('creation_replays_created_at_safe', safeEpochMillis('created_at')),
    check('creation_replays_expires_at_safe', safeEpochMillis('expires_at')),
    check('creation_replays_key_present', sql`length(key) > 0`),
    check('creation_replays_result_json', sql`json_valid(result_json)`),
  ],
);

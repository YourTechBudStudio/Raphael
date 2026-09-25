import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
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
 * Every type in this table is a type the public operations accept and return. Identity is common, and
 * `kind` is what distinguishes one leaf from another without giving each its own table or its own
 * identity space.
 *
 * Parentage is enforced declaratively rather than by triggers. `parent_type` duplicates the parent's
 * type so that a plain CHECK can decide whether the pairing is legal, and the composite foreign key
 * to `(id, type)` is what keeps that duplicate honest: it cannot name a type the parent does not
 * actually have. The two constraints solve different problems and neither replaces the other. Neither
 * detects a multi-node cycle; `move.ts` refuses one before writing.
 *
 * This table also backs `nodes_fts`, the lexical search index, which is declared only in
 * `drizzle/0004_search_index.sql` because Drizzle cannot express a virtual table. Three triggers there
 * keep it current, and they are a second reason - after the identity trigger `0001` installs - that a
 * generated table rebuild must never be applied to `nodes`. Read that migration's header before
 * changing anything here.
 */
export const nodes = sqliteTable(
  'nodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    /**
     * What a resource is. Null for a container, and required for a resource - the pairing is a
     * constraint, not a convention. See `nodes_kind_valid` below.
     */
    kind: text('kind'),
    parentId: integer('parent_id'),
    parentType: text('parent_type'),
    slug: text('slug').notNull(),
    revision: integer('revision').notNull().default(1),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    body: text('body').notNull(),
    tags: text('tags').notNull().default('[]'),
    /**
     * Whether this project is currently being worked on. `0` or `1`, and only a project may hold `1`
     * - the second type-conditional column on this table, following `kind`. See `nodes_active_valid`.
     */
    active: integer('active').notNull().default(0),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /**
     * The plain-text projection of `body`, derived at mutation time (ADR 0005).
     *
     * Nullable, and the null means something specific: no projection has been derived for this row.
     * That is a different fact from a body whose text is empty, which is stored as the empty string.
     * Confusing the two would let a maintenance pass declare a row done that it never read.
     */
    bodyText: text('body_text'),
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

    // A resource has a kind, a container does not, and a present kind is one core admits. Declared
    // here for parity with `0002`, where it is a column-level CHECK rather than a table-level one -
    // `ALTER TABLE ... ADD COLUMN` can only attach a constraint to the column it adds. The rule is
    // identical; only its attachment point differs, and `db:generate` is not the authority on either.
    check(
      'nodes_kind_valid',
      sql`(type = 'resource') = (kind IS NOT NULL) AND (kind IS NULL OR kind IN ('note'))`,
    ),
    // Only a project can be active. Declared here at table level and attached to the column itself in
    // `0003`, the same split as `nodes_kind_valid` above and for the same reason.
    //
    // No `typeof(active) = 'integer'` guard, unlike the open-range integer columns below: those admit
    // any integer and must exclude non-integers and unsafe magnitudes, while this is a closed
    // enumeration and `IN (0, 1)` does that work itself. After INTEGER affinity a lossless `'1'` or
    // `1.0` is stored as the integer it is, and anything else fails the `IN`. `NOT NULL` closes the
    // hole the parentage comment below warns about, where a NULL result reads as satisfied.
    check('nodes_active_valid', sql`active IN (0, 1) AND (active = 0 OR type = 'project')`),
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

/**
 * Why a node is archived: one row per cause, stored only at its origin (ADR 0003).
 *
 * - **Origin rows only.** Archiving a container writes one row on that container and nothing on its
 *   descendants. Whether a node is archived is computed from the node and its current ancestors by
 *   `lifecycle.ts`, which is the only module that reads or writes this table. That is what makes a move
 *   out of an archived container need no cleanup, and a restore of an ancestor leave a descendant's own
 *   cause standing.
 * - **The primary key is the no-duplicate rule.** One owner cannot hold the same reason on one node
 *   twice, so archiving something already archived by the user writes nothing.
 * - **`owner` and `reason` are open strings**, bounded only by length. `('user', 'direct')` is the only
 *   pair written today; the columns do not preclude an extension owning its own cause (#13).
 * - **`RESTRICT`**, because no operation deletes a node. Should one arrive, it has to decide what
 *   happens to the node's causes rather than having them vanish silently.
 *
 * Nothing here touches `nodes`: no column, trigger, or index is added there, which is what keeps this
 * migration clear of the table rebuild `0004`'s header warns about.
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

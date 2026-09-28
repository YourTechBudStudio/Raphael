-- Everything on `nodes` that Drizzle cannot express, then the two root areas.
--
-- ** A drizzle-kit table rebuild of `nodes` would drop all four triggers below ** and leave `nodes_fts`
-- silently stale. The generator emits a rebuild (create `__new_nodes`, copy, drop, rename) for changes
-- a plain `ALTER TABLE` cannot express, such as a new CHECK, so such a change must be hand-authored.

-- Identity is immutable once a node exists. A CHECK sees only the candidate row, so a transition rule
-- needs a trigger. `parent_id`/`parent_type` are left out so a move can change the pair atomically.
-- `IS NOT` rather than `<>` so a NULL assignment cannot slip past.
CREATE TRIGGER nodes_identity_immutable
BEFORE UPDATE OF id, type, created_at ON nodes
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.type IS NOT OLD.type
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'nodes identity is immutable');
END;
--> statement-breakpoint
-- The lexical search index: an external-content FTS5 table over the three fields ADR 0005 names. The
-- column order is the `bm25()` weight order, so reordering silently reweights every result.
--
-- ** Nothing but these triggers and `rebuild` may ever write to `nodes_fts`. ** A `'delete'` command
-- must be handed the exact values the index was built from; a hand-issued one that does not match
-- corrupts the table ("database disk image is malformed"), and only `INSERT INTO nodes_fts(nodes_fts)
-- VALUES ('rebuild')` against a stopped server recovers it. `VALUES ('integrity-check')` detects it.
--
-- The update trigger names its columns, so toggling `active` or changing a slug does not re-index
-- text. Every statement that changes these columns names them. The triggers run inside the writing
-- transaction, so a rollback un-indexes as it un-writes.
CREATE VIRTUAL TABLE nodes_fts USING fts5(title, description, body_text, content = 'nodes', content_rowid = 'id');--> statement-breakpoint
CREATE TRIGGER nodes_fts_after_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, title, description, body_text) VALUES (new.id, new.title, new.description, new.body_text);
END;--> statement-breakpoint
CREATE TRIGGER nodes_fts_after_delete AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, description, body_text) VALUES ('delete', old.id, old.title, old.description, old.body_text);
END;--> statement-breakpoint
CREATE TRIGGER nodes_fts_after_update AFTER UPDATE OF title, description, body_text ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, description, body_text) VALUES ('delete', old.id, old.title, old.description, old.body_text);
  INSERT INTO nodes_fts(rowid, title, description, body_text) VALUES (new.id, new.title, new.description, new.body_text);
END;--> statement-breakpoint
-- Two ordinary root areas, indexed by the insert trigger above. They are not protected or recreated,
-- and nothing may depend on their ids. The body is a fixed literal, so applying this later produces
-- exactly what it produces today; a test asserts it equals the canonical empty document. Both rows
-- share one sampled instant. `unixepoch('subsec')` requires SQLite 3.42 or newer.
INSERT INTO nodes (type, parent_id, parent_type, slug, title, body, body_text, created_at, updated_at)
SELECT
  seed.type,
  NULL,
  NULL,
  seed.slug,
  seed.title,
  '{"type":"doc","content":[{"type":"paragraph"}]}',
  '',
  sampled.now,
  sampled.now
FROM (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now) AS sampled
CROSS JOIN (
  SELECT 'area' AS type, 'work' AS slug, 'Work' AS title
  UNION ALL
  SELECT 'area', 'personal', 'Personal'
) AS seed;

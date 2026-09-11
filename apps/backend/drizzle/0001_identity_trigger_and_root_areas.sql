-- Identity is immutable once a node exists. A CHECK constraint sees only the candidate row, so it
-- cannot express a *transition* rule; this trigger is the narrowest thing that can. It deliberately
-- does not cover parent_id or parent_type: a future move must be able to update that pair atomically,
-- and the composite foreign key already prevents the pair from naming a type the parent lacks.
--
-- `IS NOT` is used rather than `<>` so a NULL assignment cannot slip past the comparison. No-op
-- assignments are allowed: writing a column back to the value it already holds changes nothing.
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
-- A fresh instance receives two ordinary root areas. They are not protected, reserved, or recreated
-- if the owner later removes them, and nothing may depend on their numeric IDs.
--
-- Exactly-once initialization comes from migration history, not from an upsert or a collision guard:
-- this statement runs when this migration is applied, and never again.
--
-- The body is embedded as a fixed literal rather than read from a TypeScript helper, so applying this
-- migration years from now produces exactly what it produced today. A test asserts this literal still
-- equals the content package's canonical empty document; when that test eventually fails, the answer
-- is a new forward migration, never an edit to this applied file.
--
-- Both rows must share one sampled instant, so the clock is read once in a subquery and cross-joined
-- rather than evaluated per row. `unixepoch('subsec')` requires SQLite 3.42 or newer.
INSERT INTO nodes (type, parent_id, parent_type, slug, title, body, created_at, updated_at)
SELECT
  seed.type,
  NULL,
  NULL,
  seed.slug,
  seed.title,
  '{"type":"doc","content":[{"type":"paragraph"}]}',
  sampled.now,
  sampled.now
FROM (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now) AS sampled
CROSS JOIN (
  SELECT 'area' AS type, 'work' AS slug, 'Work' AS title
  UNION ALL
  SELECT 'area', 'personal', 'Personal'
) AS seed;

-- Two nullable columns, and the invariant that ties one of them to the node type.
--
-- `kind` says what a resource is. It is nullable because a container has no kind, not because a
-- resource may lack one - that pairing is enforced below. `body_text` is the plain-text projection of
-- the stored body, written at mutation time (ADR 0005). It is nullable because NULL means "no
-- projection has been derived for this row", which is a different fact from "this row's body derives
-- to the empty string"; the derived-text pass distinguishes the two, and the empty string is a real,
-- successfully derived value rather than an absence.
--
-- One column-level CHECK carries the whole rule: a resource must have a kind, a container must not,
-- and a kind that is present must be one core admits. Two properties made this the right mechanism
-- rather than a pair of BEFORE triggers:
--
--   * SQLite permits a CHECK on `ALTER TABLE ... ADD COLUMN` - what it refuses is a PRIMARY KEY or
--     UNIQUE constraint, and a NOT NULL without a non-null default. A column CHECK may reference other
--     columns of the same row, so it can compare `kind` against `type`. This was verified against the
--     installed driver before being relied on, not assumed from the grammar.
--   * A CHECK is evaluated on *every* insert and update. A `BEFORE UPDATE OF type, kind` trigger fires
--     only when one of those columns is named in the statement, so it is the weaker guard.
--
-- Existing rows ARE validated when the column is added: SQLite evaluates the constraint against every
-- current row and refuses the ALTER if any violates it. Verified against the installed driver - adding
-- this constraint over a table already holding an unclassified resource fails with "CHECK constraint
-- failed", while an empty table and a table of containers both succeed.
--
-- That is the behaviour this migration wants. On the committed chain the only pre-existing rows are the
-- two root areas `0001` seeds, and a container with a NULL kind satisfies the constraint, so the ALTER
-- applies cleanly. A database that somehow held an unclassified resource would fail this migration
-- loudly and roll back through the transactional migrator, rather than carrying a row the operations
-- would later have to refuse on every read.
--
-- The equality between two booleans can never evaluate to NULL, so there is no third outcome SQLite
-- would read as satisfied.
ALTER TABLE nodes ADD COLUMN kind text CHECK (
  (type = 'resource') = (kind IS NOT NULL)
  AND (kind IS NULL OR kind IN ('note'))
);--> statement-breakpoint
ALTER TABLE nodes ADD COLUMN body_text text;

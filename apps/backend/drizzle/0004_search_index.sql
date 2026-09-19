-- The lexical search index: one external-content FTS5 table over `nodes`, and the triggers that keep
-- it current. Nothing reads it yet - the search operation joins it in a later change. This migration
-- adds no column, no constraint and no TypeScript contract; it adds derived state that the database
-- maintains for itself.
--
-- Two properties matter most to whoever reads this next, so they come first.
--
-- ** Nothing but these triggers and `rebuild` may ever write to `nodes_fts`. ** An external-content
-- table stores no copy of the indexed text: it holds only the inverted index, and a `'delete'`
-- command must therefore be handed the exact values the index was built from so it can find and
-- remove the right tokens. It trusts the caller completely. A delete for an entry the index no longer
-- holds - or holds under different text - corrupts the virtual table (`SQLITE_CORRUPT_VTAB`,
-- surfacing as "database disk image is malformed"), and from there only a `rebuild` recovers it. The
-- triggers below cannot reach that state on their own, because each one supplies `old.*` from the very
-- row the index was built from. A hand-issued `INSERT INTO nodes_fts(nodes_fts, ...) VALUES('delete',
-- ...)`, or a rebuild that was interrupted partway, is what gets there. Do not add one.
--
-- ** A drizzle-kit table rebuild applied to `nodes` would drop all four of its triggers ** - the
-- identity trigger `0001` installs, plus the three below - and leave `nodes_fts` orphaned: silently
-- stale rather than loudly broken, because an orphaned index still answers queries with whatever it
-- last held. `0003`'s header records this hazard when it was a single trigger; it is now four. The
-- generator emits a full rebuild (create `__new_nodes`, copy, drop, rename) for changes a plain
-- `ALTER TABLE` cannot express, such as a new CHECK. That is why every migration on this table from
-- `0002` onward is hand-authored, and why this one is too.
--
-- The rest, in the order the statements below establish them.
--
-- ** The columns are the three fields ADR 0005 names, in weight order. ** `title`, `description`,
-- `body_text` - and that order is design, not style. `bm25()` addresses column weights by position,
-- so the search operation's weighting is bound to this declaration and reordering these columns
-- silently reweights every result. Tags and metadata are deliberately absent: they are predicates a
-- query filters on, never text a query matches against, and indexing them would make a tag name a
-- free-text hit.
--
-- ** The update trigger fires only for the named columns. ** `AFTER UPDATE OF title, description,
-- body_text` rather than a bare `AFTER UPDATE`, so toggling `active` or changing a slug does not pay
-- to re-index text that did not change. This is safe because a SQLite `UPDATE OF` trigger fires on
-- any statement that *names* one of its columns, and every statement that changes these three names
-- them explicitly: the update path sets `body` and `body_text` together, and the derived-text backfill
-- sets `body_text` alone.
--
-- ** A NULL `body_text` indexes as an empty body column. ** FTS5 tokenizes NULL to nothing, on both
-- the insert and the `'delete'` side, so the two stay symmetric and the index stays sound. A row the
-- derived-text backfill has not reached yet is therefore searchable by its title and description from
-- the moment it commits, and gains body matching later through the ordinary update trigger when the
-- projection lands. No operation ever needs to read the backfill's progress, and there is no readiness
-- gate: incomplete legacy body coverage is accepted, not tracked.
--
-- ** `rebuild` is both the population and the documented repair. ** The final statement is what makes
-- rows that existed before this migration searchable; it discards the index and reconstructs it from
-- `nodes`, which is also the only recovery from the corruption described above. `INSERT INTO
-- nodes_fts(nodes_fts) VALUES('integrity-check')` is the documented way to ask whether recovery is
-- needed; it raises rather than returning a row when the index disagrees with its content table.
-- Neither is exposed as an operation - they are recovery steps an operator runs against a stopped
-- server, and a server holds this database exclusively while it runs.
--
-- ** FTS5 must be compiled into the SQLite build. ** Without it the first statement fails, and because
-- the migrator applies every pending migration inside one transaction and then re-verifies journal
-- state, the database is left exactly as it was. A backend that cannot index therefore fails to start
-- rather than starting and serving a search that silently matches nothing.
--
-- Indexing is part of the writing transaction, not a step after it. The triggers fire inside whatever
-- transaction changed the row, so a rollback un-indexes precisely as it un-writes, and no application
-- code anywhere writes to `nodes_fts`.
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
INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild');

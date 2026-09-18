-- One boolean column, and the invariant that ties it to the node type.
--
-- `active` says whether a project is currently being worked on. It is the second type-conditional
-- column on this table, after `kind`, and it carries its rule the same way `0002` does: one
-- column-level CHECK attached by the `ADD COLUMN` itself, because `ALTER TABLE ... ADD COLUMN` can
-- only attach a constraint to the column it adds. `schema.ts` declares the identical rule at table
-- level, which is where Drizzle can express it; the rule is one rule and only its attachment point
-- differs.
--
-- Not null with a default of `0`, so every existing row lands at "not selected" - which is the truth
-- about every row written before selection existed, not a placeholder for an unknown.
--
-- `IN (0, 1)` carries the domain without a `typeof` guard, unlike the open-range integer columns in
-- `0000`. Those admit any integer and must exclude non-integers and unsafe magnitudes; this is a
-- closed enumeration, and after INTEGER affinity a lossless `'1'` or `1.0` is stored as the integer
-- it is while anything else simply fails the `IN`. The NOT NULL closes the case where a NULL operand
-- would make the whole expression evaluate to NULL, which SQLite reads as satisfied.
--
-- This is hand-authored rather than generated. `db:generate` emits a full table rebuild for a new
-- CHECK - create `__new_nodes`, copy, drop, rename - which would silently take the identity trigger
-- `0001` installs on `nodes` down with the dropped table. The generated snapshot is kept as produced,
-- carrying the rule as a table-level `checkConstraints` entry, exactly as `0002`'s does.
--
-- Existing rows ARE validated when the column is added, as `0002` records: the default `0` satisfies
-- the constraint for every row whatever its type, so the ALTER applies cleanly on any database.
ALTER TABLE nodes ADD COLUMN active integer NOT NULL DEFAULT 0 CHECK (
  active IN (0, 1)
  AND (active = 0 OR type = 'project')
);

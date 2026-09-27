CREATE TABLE `favorites` (
	`node_id` integer PRIMARY KEY NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
-- Saved creation replays gain `isFavorite` (story #14), for the reason `0005` gives for `archived`: a
-- replay is decoded again by the current response decoder, which now requires it.
--
-- `false` is historically true: a creation response describes a node at the moment it was created, its
-- id did not exist before, ids are never reused, and a favorite must reference an existing node. A
-- replay stays a historical snapshot (ADR 0002).
--
-- Rows without an entity object are left alone, as in `0005`.
UPDATE creation_replays
   SET result_json = json_set(result_json, '$.entity.isFavorite', json('false'))
 WHERE json_type(result_json, '$.entity') = 'object';

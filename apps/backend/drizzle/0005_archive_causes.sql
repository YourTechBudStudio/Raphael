CREATE TABLE `archive_causes` (
	`node_id` integer NOT NULL,
	`owner` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `owner`, `reason`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "archive_causes_owner_present" CHECK(length(owner) BETWEEN 1 AND 64),
	CONSTRAINT "archive_causes_reason_present" CHECK(length(reason) BETWEEN 1 AND 64),
	CONSTRAINT "archive_causes_created_at_safe" CHECK(typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991)
);
--> statement-breakpoint
-- Saved creation replays gain the two lifecycle fields every entity now carries (story #8, R11).
--
-- `result_json` is the complete response a creation returned, and a replay hands it back as it was
-- saved (`replay.ts::savedResponse`), through the current response decoder. That decoder now requires
-- `archived` and `archiveCauses`, so a replay saved before this migration would fail its own decode
-- and a retried creation would be refused as an internal failure.
--
-- The values written are historically true, not a projection of current state: nothing could be
-- archived before `archive_causes` existed, so every entity saved here was active, with no causes,
-- when it was created. A replay stays a historical snapshot (ADR 0002).
--
-- The `WHERE` leaves any record without an entity object untouched. Such a record already fails its
-- own decode, and fabricating fields inside it would not make it a valid replay.
UPDATE creation_replays
   SET result_json = json_set(result_json, '$.entity.archived', json('false'),
                                           '$.entity.archiveCauses', json('[]'))
 WHERE json_type(result_json, '$.entity') = 'object';

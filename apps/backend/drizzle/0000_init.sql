CREATE TABLE `creation_replays` (
	`key` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "creation_replays_created_at_safe" CHECK(typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991),
	CONSTRAINT "creation_replays_expires_at_safe" CHECK(typeof(expires_at) = 'integer' AND expires_at >= 0 AND expires_at <= 9007199254740991),
	CONSTRAINT "creation_replays_key_present" CHECK(length(key) > 0),
	CONSTRAINT "creation_replays_result_json" CHECK(json_valid(result_json))
);
--> statement-breakpoint
CREATE INDEX `creation_replays_expires_at` ON `creation_replays` (`expires_at`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`parent_id` integer,
	`parent_type` text,
	`slug` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`,`parent_type`) REFERENCES `nodes`(`id`,`type`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "nodes_type_supported" CHECK(type IN ('area', 'project', 'resource')),
	CONSTRAINT "nodes_title_present" CHECK(length(title) > 0),
	CONSTRAINT "nodes_slug_present" CHECK(length(slug) > 0),
	CONSTRAINT "nodes_id_safe" CHECK(typeof(id) = 'integer' AND id > 0 AND id <= 9007199254740991),
	CONSTRAINT "nodes_revision_safe" CHECK(typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991),
	CONSTRAINT "nodes_created_at_safe" CHECK(typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991),
	CONSTRAINT "nodes_updated_at_safe" CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0 AND updated_at <= 9007199254740991),
	CONSTRAINT "nodes_parent_pair" CHECK((parent_id IS NULL) = (parent_type IS NULL)),
	CONSTRAINT "nodes_root_is_area" CHECK(parent_type IS NOT NULL OR type = 'area'),
	CONSTRAINT "nodes_allowed_parentage" CHECK(parent_type IS NULL
        OR (parent_type = 'area' AND type IN ('area', 'project', 'resource'))
        OR (parent_type = 'project' AND type = 'resource')),
	CONSTRAINT "nodes_not_self_parent" CHECK(parent_id IS NULL OR parent_id <> id),
	CONSTRAINT "nodes_body_json" CHECK(json_valid(body) AND json_type(body) = 'object'),
	CONSTRAINT "nodes_tags_json" CHECK(json_valid(tags) AND json_type(tags) = 'array'),
	CONSTRAINT "nodes_metadata_json" CHECK(json_valid(metadata) AND json_type(metadata) = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_sibling_slug` ON `nodes` (`parent_id`,`slug`) WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_root_slug` ON `nodes` (`slug`) WHERE parent_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_id_type` ON `nodes` (`id`,`type`);
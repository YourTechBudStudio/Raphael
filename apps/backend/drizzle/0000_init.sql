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
CREATE TABLE `favorites` (
	`node_id` integer PRIMARY KEY NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`kind` text,
	`parent_id` integer,
	`parent_type` text,
	`slug` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`body_text` text NOT NULL,
	FOREIGN KEY (`parent_id`,`parent_type`) REFERENCES `nodes`(`id`,`type`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "nodes_type_supported" CHECK(type IN ('area', 'project', 'resource')),
	CONSTRAINT "nodes_kind_valid" CHECK((type = 'resource') = (kind IS NOT NULL) AND (kind IS NULL OR kind IN ('note'))),
	CONSTRAINT "nodes_active_valid" CHECK(active IN (0, 1) AND (active = 0 OR type = 'project')),
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
CREATE TABLE `deleted_item_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`seq` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_count` integer NOT NULL,
	`data` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deleted_item_rows_entry_idx` ON `deleted_item_rows` (`entry_id`,`seq`);--> statement-breakpoint
CREATE TABLE `deleted_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'deleting' NOT NULL,
	`item_id` text,
	`name` text NOT NULL,
	`counts` text NOT NULL,
	`meta` text,
	`deleted_by` text,
	`deleted_by_name` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deleted_items_ws_idx` ON `deleted_items` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `deleted_items_expires_idx` ON `deleted_items` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sequence_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`subsequence_id` text,
	`sequences` text NOT NULL,
	`source` text DEFAULT 'edit' NOT NULL,
	`created_by` text,
	`created_by_name` text,
	`restored_from` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sequence_versions_owner_idx` ON `sequence_versions` (`campaign_id`,`subsequence_id`,`created_at`);
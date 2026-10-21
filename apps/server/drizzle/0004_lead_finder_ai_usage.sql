CREATE TABLE `company_list_members` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`normalized_domain` text NOT NULL,
	`company_name` text,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_list_members_uq` ON `company_list_members` (`list_id`,`normalized_domain`);--> statement-breakpoint
CREATE TABLE `company_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`provider_id` text NOT NULL,
	`company_source_id` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`terminal_reason` text,
	`requested_count` integer NOT NULL,
	`company_count` integer DEFAULT 0 NOT NULL,
	`saved_count` integer DEFAULT 0 NOT NULL,
	`credits_charged` integer DEFAULT 0 NOT NULL,
	`filters` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `company_lists_ws_idx` ON `company_lists` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `enrichment_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`enrichment_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`credits_used` real DEFAULT 0 NOT NULL,
	`error` text,
	`job_id` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `enrichment_runs_resource_idx` ON `enrichment_runs` (`resource_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;
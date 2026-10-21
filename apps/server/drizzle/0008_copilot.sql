CREATE TABLE `copilot_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`seconds_saved` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `copilot_actions_tool_use_uq` ON `copilot_actions` (`thread_id`,`tool_use_id`);--> statement-breakpoint
CREATE INDEX `copilot_actions_user_idx` ON `copilot_actions` (`workspace_id`,`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `copilot_messages` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `copilot_messages` ADD `model` text;--> statement-breakpoint
ALTER TABLE `copilot_messages` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `copilot_messages` ADD `feedback` text;--> statement-breakpoint
ALTER TABLE `copilot_tasks` ADD `last_status` text;--> statement-breakpoint
ALTER TABLE `copilot_tasks` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `copilot_tasks` ADD `run_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `copilot_tasks` ADD `source_thread_id` text;--> statement-breakpoint
ALTER TABLE `copilot_tasks` ADD `locked_until` integer;--> statement-breakpoint
ALTER TABLE `copilot_threads` ADD `system` text;--> statement-breakpoint
ALTER TABLE `copilot_threads` ADD `status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `copilot_threads` ADD `task_id` text;
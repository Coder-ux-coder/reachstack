ALTER TABLE `workflow_runs` ADD `workflow_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `attempt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `retry_of` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `is_test` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `lead_email` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `locked_at` integer;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `updated_at` integer;--> statement-breakpoint
CREATE INDEX `workflow_runs_ws_idx` ON `workflow_runs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_retry_idx` ON `workflow_runs` (`retry_of`);--> statement-breakpoint
ALTER TABLE `workflows` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `webhook_token` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `webhook_samples` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `next_run_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_webhook_token_uq` ON `workflows` (`webhook_token`);--> statement-breakpoint
CREATE INDEX `workflows_next_run_idx` ON `workflows` (`status`,`next_run_at`);
ALTER TABLE `leads` ADD `verify_run_id` text;--> statement-breakpoint
CREATE INDEX `leads_verify_run_idx` ON `leads` (`verify_run_id`) WHERE verify_run_id is not null;
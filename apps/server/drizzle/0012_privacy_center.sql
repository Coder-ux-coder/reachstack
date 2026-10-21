CREATE TABLE `abuse_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text,
	`account_email` text,
	`lead_email` text NOT NULL,
	`subject` text,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_reports_email_uq` ON `abuse_reports` (`email_id`);--> statement-breakpoint
CREATE INDEX `abuse_reports_ws_idx` ON `abuse_reports` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `privacy_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`reason` text NOT NULL,
	`block_sending` integer DEFAULT false NOT NULL,
	`request_id` text,
	`abuse_report_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `privacy_suppressions_uq` ON `privacy_suppressions` (`type`,`value`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `share_expires_at` integer;--> statement-breakpoint
-- Campaigns shared before links expired get the full 7 days from now.
UPDATE `campaigns` SET `share_expires_at` = (CAST(strftime('%s', 'now') AS INTEGER) + 604800) * 1000 WHERE `share_token` IS NOT NULL;

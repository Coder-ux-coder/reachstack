CREATE TABLE `visitor_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`view_id` text NOT NULL,
	`session_id` text NOT NULL,
	`company_domain` text NOT NULL,
	`day` text NOT NULL,
	`results` text,
	`person_id` text,
	`lead_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visitor_alerts_uq` ON `visitor_alerts` (`view_id`,`company_domain`,`day`);--> statement-breakpoint
CREATE INDEX `visitor_alerts_view_idx` ON `visitor_alerts` (`view_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `visitor_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`terms_version` text,
	`terms_accepted_at` integer,
	`terms_accepted_by` text,
	`ipinfo_token_enc` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `visitor_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`site_id` text,
	`name` text NOT NULL,
	`filters` text NOT NULL,
	`destinations` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`matches` integer DEFAULT 0 NOT NULL,
	`last_match_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `visitor_views_ws_idx` ON `visitor_views` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `visitor_sessions` ADD `resolve_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `visitor_sessions` ADD `resolve_note` text;--> statement-breakpoint
ALTER TABLE `visitor_sessions` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `visitor_sessions` ADD `company_id` text;--> statement-breakpoint
CREATE INDEX `visitor_sessions_company_idx` ON `visitor_sessions` (`workspace_id`,`company_domain`);--> statement-breakpoint
CREATE INDEX `visitor_sessions_status_idx` ON `visitor_sessions` (`workspace_id`,`resolve_status`);--> statement-breakpoint
ALTER TABLE `visitor_sites` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `visitor_sites` ADD `conflict_at` integer;
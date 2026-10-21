CREATE TABLE `ai_agent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_agent_events_agent_idx` ON `ai_agent_events` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_lead_research` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`research` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_lead_research_uq` ON `ai_lead_research` (`agent_id`,`lead_id`);--> statement-breakpoint
CREATE TABLE `deliverability_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`cycle_id` text,
	`activity_code` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `deliverability_activities_agent_idx` ON `deliverability_activities` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `deliverability_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total_checks` integer DEFAULT 0 NOT NULL,
	`healthy_count` integer DEFAULT 0 NOT NULL,
	`needs_attention_count` integer DEFAULT 0 NOT NULL,
	`info_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`score` real,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `deliverability_cycles_agent_idx` ON `deliverability_cycles` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `deliverability_feed_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`source_activity_id` text,
	`feed_code` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`subject_name` text,
	`payload` text NOT NULL,
	`result_payload` text,
	`action_code` text,
	`action_status` text,
	`action_payload` text,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`dismissed_at` integer,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `deliverability_feed_agent_idx` ON `deliverability_feed_items` (`agent_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `deliverability_feed_dedupe_idx` ON `deliverability_feed_items` (`agent_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `enrichment_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_agent_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text,
	`thread_id` text,
	`in_reply_to` text,
	`lead` text,
	`account_email` text,
	`subject` text,
	`html` text,
	`requires_hitl` integer DEFAULT false,
	`requires_hitl_reason` text,
	`confidence_score` real,
	`sending_status` integer DEFAULT 2 NOT NULL,
	`action_pending` integer DEFAULT true,
	`feedback_positive` integer,
	`feedback_text` text,
	`is_followup` integer DEFAULT false,
	`error_code` text,
	`usage_metadata` text,
	`estimated_time_saved_seconds` integer,
	`generation_lag_seconds` real,
	`sent_email_id` text,
	`scheduled_send_at` integer,
	`information_requested` text,
	`is_automatic_email` integer DEFAULT false,
	`calendly_tool_used` integer DEFAULT false,
	`job_type` integer,
	`followup_number` integer,
	`lead_id` text,
	`campaign_id` text,
	`account_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_ai_agent_replies`("id", "workspace_id", "agent_id", "thread_id", "in_reply_to", "lead", "account_email", "subject", "html", "requires_hitl", "requires_hitl_reason", "confidence_score", "sending_status", "action_pending", "feedback_positive", "feedback_text", "is_followup", "error_code", "usage_metadata", "estimated_time_saved_seconds", "generation_lag_seconds", "sent_email_id", "scheduled_send_at", "created_at", "updated_at") SELECT "id", "workspace_id", "agent_id", "thread_id", "in_reply_to", "lead", "account_email", "subject", "html", "requires_hitl", "requires_hitl_reason", "confidence_score", "sending_status", "action_pending", "feedback_positive", "feedback_text", "is_followup", "error_code", "usage_metadata", "estimated_time_saved_seconds", "generation_lag_seconds", "sent_email_id", "scheduled_send_at", "created_at", "updated_at" FROM `ai_agent_replies`;--> statement-breakpoint
DROP TABLE `ai_agent_replies`;--> statement-breakpoint
ALTER TABLE `__new_ai_agent_replies` RENAME TO `ai_agent_replies`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_agent_replies_ws_idx` ON `ai_agent_replies` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_agent_replies_agent_idx` ON `ai_agent_replies` (`agent_id`,`sending_status`);--> statement-breakpoint
ALTER TABLE `email_accounts` ADD `campaign_pause_until` integer;
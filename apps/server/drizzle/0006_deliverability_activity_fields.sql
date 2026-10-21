ALTER TABLE `deliverability_activities` ADD `priority` integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE `deliverability_activities` ADD `subject_type` text;--> statement-breakpoint
ALTER TABLE `deliverability_activities` ADD `subject_id` text;--> statement-breakpoint
ALTER TABLE `deliverability_activities` ADD `subject_name` text;--> statement-breakpoint
ALTER TABLE `deliverability_activities` ADD `payload` text;--> statement-breakpoint
ALTER TABLE `deliverability_activities` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `deliverability_activities` ADD `error_message` text;--> statement-breakpoint
ALTER TABLE `deliverability_activities` ADD `updated_at` integer;
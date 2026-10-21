ALTER TABLE `crm_tasks` ADD `campaign_id` text;--> statement-breakpoint
ALTER TABLE `crm_tasks` ADD `subsequence_id` text;--> statement-breakpoint
ALTER TABLE `crm_tasks` ADD `step` integer;--> statement-breakpoint
ALTER TABLE `crm_tasks` ADD `step_kind` text;--> statement-breakpoint
CREATE INDEX `crm_tasks_lead_id_idx` ON `crm_tasks` (`lead_id`,`status`);
ALTER TABLE `emails` ADD `crm_done_at` integer;--> statement-breakpoint
ALTER TABLE `crm_opportunities` ADD `recurrence` text DEFAULT 'one_time' NOT NULL;--> statement-breakpoint
ALTER TABLE `crm_opportunities` ADD `priority` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `crm_opportunities` ADD `won_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `crm_opps_ws_lead_uq` ON `crm_opportunities` (`workspace_id`,`lead_email`) WHERE lead_email is not null;
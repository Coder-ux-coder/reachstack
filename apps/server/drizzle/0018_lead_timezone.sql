ALTER TABLE `leads` ADD `timezone` text;--> statement-breakpoint
CREATE INDEX `leads_mail_queue_idx` ON `leads` (`updated_at`) WHERE esp_code = 0;
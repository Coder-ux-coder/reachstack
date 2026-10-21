ALTER TABLE `emails` ADD `retry_handling` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `emails_message_idx` ON `emails` (`message_id`);
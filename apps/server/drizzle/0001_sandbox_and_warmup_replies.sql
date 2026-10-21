CREATE TABLE `sandbox_messages` (
	`uid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text,
	`mailbox` text NOT NULL,
	`folder` text NOT NULL,
	`message_id` text,
	`in_reply_to` text,
	`from_address` text,
	`subject` text,
	`raw` text NOT NULL,
	`flags` text NOT NULL,
	`internal_date` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sandbox_mailbox_idx` ON `sandbox_messages` (`mailbox`,`folder`,`uid`);--> statement-breakpoint
CREATE INDEX `sandbox_ws_idx` ON `sandbox_messages` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `warmup_messages` ADD `reply_due_at` integer;--> statement-breakpoint
CREATE INDEX `warmup_messages_reply_due_idx` ON `warmup_messages` (`reply_due_at`);
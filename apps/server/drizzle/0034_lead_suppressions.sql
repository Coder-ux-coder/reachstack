CREATE TABLE `lead_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`campaign_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_suppressions_uq` ON `lead_suppressions` (`workspace_id`,`email`,`reason`,`campaign_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `lead_suppressions` (`id`, `workspace_id`, `email`, `reason`, `campaign_id`, `created_at`) SELECT lower(hex(randomblob(16))), `workspace_id`, `email`, 'bounced', '', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM `leads` WHERE `status` = -1 AND `email` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `lead_suppressions` (`id`, `workspace_id`, `email`, `reason`, `campaign_id`, `created_at`) SELECT lower(hex(randomblob(16))), l.`workspace_id`, l.`email`, 'unsubscribed', l.`campaign_id`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM `leads` l WHERE l.`status` = -2 AND l.`email` IS NOT NULL AND l.`campaign_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `unsubscribes` u WHERE u.`workspace_id` = l.`workspace_id` AND u.`email` = l.`email`);

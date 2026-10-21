ALTER TABLE `oauth_identities` ADD `verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `invited_at` integer;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `entered_via` text;--> statement-breakpoint
UPDATE `workspace_members` SET `invited_at` = `updated_at` WHERE `accepted` = 0;
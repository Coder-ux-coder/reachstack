CREATE TABLE `placement_seeds` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`account_id` text,
	`region` text NOT NULL,
	`sub_region` text NOT NULL,
	`type` text NOT NULL,
	`esp` integer NOT NULL,
	`geo` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_seeds_email_uq` ON `placement_seeds` (`email`);
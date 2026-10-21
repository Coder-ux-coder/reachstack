CREATE TABLE `domain_forwarding` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`forwarding_domain` text NOT NULL,
	`forwarding_mode` text DEFAULT 'redirect' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_forwarding_domain_uq` ON `domain_forwarding` (`domain`);--> statement-breakpoint
CREATE TABLE `oauth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`provider` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`email` text,
	`name` text,
	`error` text,
	`error_description` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `dfy_orders` ADD `order_type` text DEFAULT 'dfy' NOT NULL;
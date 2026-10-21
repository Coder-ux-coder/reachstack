CREATE TABLE `domain_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`mx` integer NOT NULL,
	`spf` integer NOT NULL,
	`dkim` integer NOT NULL,
	`dmarc` integer NOT NULL,
	`indeterminate` text NOT NULL,
	`details` text NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_checks_ws_domain_uq` ON `domain_checks` (`workspace_id`,`domain`);
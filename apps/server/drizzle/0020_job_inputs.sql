CREATE TABLE `job_inputs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`input` text,
	`sealed` text,
	`created_at` integer NOT NULL
);

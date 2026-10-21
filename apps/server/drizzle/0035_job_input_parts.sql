CREATE TABLE `job_input_parts` (
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`input` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `seq`)
);

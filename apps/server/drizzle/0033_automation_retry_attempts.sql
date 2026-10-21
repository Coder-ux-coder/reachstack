-- Retries of a run started at the same moment could share an attempt number: number each run's retries 1, 2, 3… in
-- the order they were made (ids are time-ordered), so the unique index below can hold.
UPDATE `workflow_runs` SET `attempt` = (SELECT count(*) FROM `workflow_runs` w2 WHERE w2.`retry_of` = `workflow_runs`.`retry_of` AND w2.`id` <= `workflow_runs`.`id`) WHERE `retry_of` IS NOT NULL;--> statement-breakpoint
DROP INDEX `workflow_runs_retry_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_retry_attempt_uq` ON `workflow_runs` (`retry_of`,`attempt`) WHERE retry_of is not null;

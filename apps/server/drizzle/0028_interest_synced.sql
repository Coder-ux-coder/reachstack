ALTER TABLE `leads` ADD `interest_synced` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Statuses the global status sync copied over: no change of their own, and another lead with the same address was set
-- to that status. Analytics count the conversion once, where it was set.
UPDATE `leads` SET `interest_synced` = 1
WHERE `lt_interest_status` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `email_events` e WHERE e.`lead_id` = `leads`.`id` AND e.`type` = 'interest_change')
  AND EXISTS (
    SELECT 1 FROM `leads` o JOIN `email_events` e ON e.`lead_id` = o.`id`
    WHERE o.`workspace_id` = `leads`.`workspace_id` AND o.`email` = `leads`.`email` AND o.`id` <> `leads`.`id`
      AND e.`type` = 'interest_change' AND e.`value` = `leads`.`lt_interest_status`
  );
--> statement-breakpoint
-- A lead's value counts once in the pipeline: an opportunity recorded again (the lead turned positive again) keeps none.
UPDATE `email_events` SET `value` = 0
WHERE `type` = 'opportunity' AND `lead_id` IS NOT NULL AND `value` <> 0 AND EXISTS (
  SELECT 1 FROM `email_events` f
  WHERE f.`lead_id` = `email_events`.`lead_id` AND f.`type` = 'opportunity'
    AND (f.`created_at` < `email_events`.`created_at` OR (f.`created_at` = `email_events`.`created_at` AND f.`id` < `email_events`.`id`))
);

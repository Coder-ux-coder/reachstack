-- Replies recorded before a reply counted for the campaign email it answers (its step, variant and subsequence) rather
-- than for where the lead happened to be when it came in (new replies are matched in services/activity.ts, answeredEmail),
-- and bounces recorded without the variant of the email that bounced.

-- A reply that names the campaign email it answers counts for that email's subsequence, or for the campaign itself.
UPDATE `email_events` SET `subsequence_id` = (
  SELECT m.`subsequence_id` FROM `emails` r
  JOIN `emails` m ON m.`workspace_id` = r.`workspace_id` AND m.`message_id` = r.`in_reply_to` AND m.`ue_type` = 1
  WHERE r.`id` = `email_events`.`email_id`
  LIMIT 1
)
WHERE `type` IN ('reply', 'auto_reply') AND EXISTS (
  SELECT 1 FROM `emails` r
  JOIN `emails` m ON m.`workspace_id` = r.`workspace_id` AND m.`message_id` = r.`in_reply_to` AND m.`ue_type` = 1
  WHERE r.`id` = `email_events`.`email_id` AND r.`step` IS NOT NULL
);
--> statement-breakpoint
-- One that names none (some mail apps drop the headers, and a reply linked to a lead by hand has none) counts for the
-- newest campaign email the lead got before writing it (and before it arrived).
UPDATE `email_events` SET (`step`, `variant`, `subsequence_id`) = (
  SELECT CAST(m.`step` AS INTEGER), m.`variant`, m.`subsequence_id` FROM `emails` m
  WHERE m.`workspace_id` = `email_events`.`workspace_id` AND m.`lead` = `email_events`.`lead_email` AND m.`ue_type` = 1 AND m.`step` IS NOT NULL
    AND m.`timestamp_email` <= (SELECT MIN(r.`timestamp_email` + 5000, r.`created_at`) FROM `emails` r WHERE r.`id` = `email_events`.`email_id`)
  ORDER BY m.`timestamp_email` DESC
  LIMIT 1
)
WHERE `type` IN ('reply', 'auto_reply')
  AND `email_id` IN (SELECT `id` FROM `emails` WHERE `ue_type` = 2 AND `step` IS NULL)
  AND EXISTS (
    SELECT 1 FROM `emails` m
    WHERE m.`workspace_id` = `email_events`.`workspace_id` AND m.`lead` = `email_events`.`lead_email` AND m.`ue_type` = 1 AND m.`step` IS NOT NULL
      AND m.`timestamp_email` <= (SELECT MIN(r.`timestamp_email` + 5000, r.`created_at`) FROM `emails` r WHERE r.`id` = `email_events`.`email_id`)
  );
--> statement-breakpoint
-- A lead's "replied at step" is its first reply's.
UPDATE `leads` SET (`email_replied_step`, `email_replied_variant`) = (
  SELECT e.`step`, e.`variant` FROM `email_events` e
  WHERE e.`lead_id` = `leads`.`id` AND e.`type` = 'reply' AND e.`is_first` = 1
  ORDER BY e.`created_at` DESC
  LIMIT 1
)
WHERE `email_replied_step` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `email_events` e WHERE e.`lead_id` = `leads`.`id` AND e.`type` = 'reply' AND e.`is_first` = 1 AND e.`step` IS NOT NULL
);
--> statement-breakpoint
-- A bounce counts for the email that bounced.
UPDATE `email_events` SET (`step`, `variant`, `subsequence_id`) = (
  SELECT CAST(m.`step` AS INTEGER), m.`variant`, m.`subsequence_id` FROM `emails` m WHERE m.`id` = `email_events`.`email_id`
)
WHERE `type` = 'bounce' AND `variant` IS NULL AND EXISTS (
  SELECT 1 FROM `emails` m WHERE m.`id` = `email_events`.`email_id` AND m.`ue_type` = 1 AND m.`step` IS NOT NULL AND m.`variant` IS NOT NULL
);

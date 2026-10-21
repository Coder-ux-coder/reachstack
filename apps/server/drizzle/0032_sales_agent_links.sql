-- Campaigns imported from another workspace's share link kept that workspace's Sales Agent: they were hidden from
-- the campaign list, and the agent there couldn't be deleted. A campaign keeps an agent only from its own workspace.
UPDATE `campaigns` SET `ai_sdr_id` = NULL WHERE `ai_sdr_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `ai_sales_agents` `s` WHERE `s`.`id` = `campaigns`.`ai_sdr_id` AND `s`.`workspace_id` = `campaigns`.`workspace_id`);

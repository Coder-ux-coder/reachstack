CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`email` text,
	`type` text NOT NULL,
	`token_hash` text NOT NULL,
	`data` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_hash_uq` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_user_idx` ON `auth_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_hash` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`scopes` text NOT NULL,
	`logo_url` text,
	`website_url` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_uq` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`code_hash` text,
	`code_challenge` text,
	`redirect_uri` text,
	`access_token_hash` text,
	`refresh_token_hash` text,
	`scopes` text NOT NULL,
	`code_expires_at` integer,
	`access_expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_code_idx` ON `oauth_grants` (`code_hash`);--> statement-breakpoint
CREATE INDEX `oauth_grants_access_idx` ON `oauth_grants` (`access_token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_grants_refresh_idx` ON `oauth_grants` (`refresh_token_hash`);--> statement-breakpoint
CREATE TABLE `oauth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_identities_uq` ON `oauth_identities` (`provider`,`subject`);--> statement-breakpoint
CREATE TABLE `privacy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`details` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`token_hash` text,
	`verified_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `privacy_requests_email_idx` ON `privacy_requests` (`email`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`current_workspace_id` text,
	`ip` text,
	`user_agent` text,
	`mfa_pending` integer DEFAULT false NOT NULL,
	`workspace_reauth` text,
	`is_client_portal` integer DEFAULT false NOT NULL,
	`impersonator_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`avatar_url` text,
	`phone` text,
	`timezone` text,
	`language` text DEFAULT 'en',
	`theme` text DEFAULT 'system',
	`email_verified_at` integer,
	`totp_secret_enc` text,
	`totp_pending_secret_enc` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`recovery_codes` text,
	`onboarding` text,
	`onboarding_completed` integer DEFAULT false NOT NULL,
	`is_superadmin` integer DEFAULT false NOT NULL,
	`referral_partner` text,
	`appsumo_code` text,
	`preferences` text,
	`last_login_at` integer,
	`failed_mfa_attempts` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `accelerator_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`item_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accelerator_uq` ON `accelerator_progress` (`workspace_id`,`user_id`,`item_key`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`scopes` text NOT NULL,
	`created_by` text,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_uq` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_ws_idx` ON `api_keys` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`activity_type` integer NOT NULL,
	`user_id` text,
	`user_name` text,
	`ip_address` text DEFAULT '' NOT NULL,
	`user_agent` text,
	`from_api` integer DEFAULT false NOT NULL,
	`api_key_id` text,
	`affected_count` integer,
	`campaign_id` text,
	`webhook_id` text,
	`subsequence_id` text,
	`list_id` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_ws_time_idx` ON `audit_logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `custom_tag_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_type` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_tag_mappings_uq` ON `custom_tag_mappings` (`tag_id`,`resource_id`);--> statement-breakpoint
CREATE INDEX `custom_tag_mappings_resource_idx` ON `custom_tag_mappings` (`resource_id`);--> statement-breakpoint
CREATE TABLE `custom_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_tags_ws_label_uq` ON `custom_tags` (`workspace_id`,`label`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`config_enc` text,
	`public_config` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integrations_ws_type_idx` ON `integrations` (`workspace_id`,`type`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`read_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_ws_user_idx` ON `notifications` (`workspace_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_workspace_id` text NOT NULL,
	`sub_workspace_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invite_token_hash` text,
	`invited_email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wgm_pair_uq` ON `workspace_group_members` (`admin_workspace_id`,`sub_workspace_id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`permissions` text,
	`nickname` text,
	`accepted` integer DEFAULT false NOT NULL,
	`issuer_id` text,
	`invite_token_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_ws_email_uq` ON `workspace_members` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_members_token_idx` ON `workspace_members` (`invite_token_hash`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`logo_url` text,
	`plan_ids` text,
	`self_hosted` integer DEFAULT true NOT NULL,
	`trial_ends_at` integer,
	`trial_extended` integer DEFAULT false NOT NULL,
	`settings` text,
	`add_unsub_to_block` integer DEFAULT true NOT NULL,
	`default_opportunity_value` real,
	`client_domain` text,
	`security` text,
	`stripe_customer_id` text,
	`scheduled_for_removal_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `account_daily_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`warmup_sent` integer DEFAULT 0 NOT NULL,
	`warmup_received` integer DEFAULT 0 NOT NULL,
	`warmup_inbox` integer DEFAULT 0 NOT NULL,
	`warmup_spam` integer DEFAULT 0 NOT NULL,
	`warmup_category` integer DEFAULT 0 NOT NULL,
	`warmup_saved_from_spam` integer DEFAULT 0 NOT NULL,
	`warmup_replied` integer DEFAULT 0 NOT NULL,
	`bounced` integer DEFAULT 0 NOT NULL,
	`replies` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_daily_stats_uq` ON `account_daily_stats` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `account_daily_stats_ws_idx` ON `account_daily_stats` (`workspace_id`,`date`);--> statement-breakpoint
CREATE TABLE `email_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`provider_code` integer DEFAULT 1 NOT NULL,
	`imap` text,
	`imap_password_enc` text,
	`smtp` text,
	`smtp_password_enc` text,
	`oauth_enc` text,
	`status` integer DEFAULT 1 NOT NULL,
	`status_message` text,
	`warmup_status` integer DEFAULT 0 NOT NULL,
	`warmup` text,
	`warmup_score` real,
	`warmup_started_at` integer,
	`daily_limit` integer DEFAULT 30,
	`sending_gap` integer DEFAULT 10 NOT NULL,
	`signature` text,
	`reply_to` text,
	`tracking_domain_name` text,
	`tracking_domain_status` text,
	`enable_slow_ramp` integer DEFAULT false,
	`is_managed` integer DEFAULT false NOT NULL,
	`setup_pending` integer DEFAULT false NOT NULL,
	`is_seed` integer DEFAULT false NOT NULL,
	`inbox_placement_test_limit` integer,
	`folders` text,
	`sync_state` text,
	`last_sync_at` integer,
	`last_sent_at` integer,
	`last_error_at` integer,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`autofix_failed` integer,
	`dfy_order_id` text,
	`added_by` text,
	`modified_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_accounts_ws_email_uq` ON `email_accounts` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `email_accounts_email_idx` ON `email_accounts` (`email`);--> statement-breakpoint
CREATE INDEX `email_accounts_warmup_idx` ON `email_accounts` (`warmup_status`);--> statement-breakpoint
CREATE TABLE `warmup_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_account_id` text NOT NULL,
	`recipient_account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`in_reply_to` text,
	`subject` text NOT NULL,
	`tag` text NOT NULL,
	`is_reply` integer DEFAULT false NOT NULL,
	`sent_at` integer NOT NULL,
	`delivered_at` integer,
	`folder` text,
	`saved_from_spam` integer DEFAULT false NOT NULL,
	`opened` integer DEFAULT false NOT NULL,
	`important` integer DEFAULT false NOT NULL,
	`replied` integer DEFAULT false NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warmup_messages_mid_uq` ON `warmup_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `warmup_messages_recipient_idx` ON `warmup_messages` (`recipient_account_id`,`processed_at`);--> statement-breakpoint
CREATE INDEX `warmup_messages_sender_idx` ON `warmup_messages` (`sender_account_id`,`sent_at`);--> statement-breakpoint
CREATE TABLE `ai_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text,
	`list_id` text,
	`name` text NOT NULL,
	`output_variable` text NOT NULL,
	`prompt` text NOT NULL,
	`model` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`only_empty` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_prompts_campaign_idx` ON `ai_prompts` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`pl_value` real,
	`is_evergreen` integer DEFAULT false,
	`schedule` text NOT NULL,
	`sequences` text NOT NULL,
	`email_gap` integer DEFAULT 10,
	`random_wait_max` integer DEFAULT 10,
	`text_only` integer DEFAULT false,
	`first_email_text_only` integer DEFAULT false,
	`email_list` text NOT NULL,
	`email_tag_list` text NOT NULL,
	`daily_limit` integer DEFAULT 50,
	`stop_on_reply` integer DEFAULT true,
	`link_tracking` integer DEFAULT false,
	`open_tracking` integer DEFAULT false NOT NULL,
	`stop_on_auto_reply` integer DEFAULT false,
	`daily_max_leads` integer,
	`prioritize_new_leads` integer DEFAULT false,
	`auto_variant_select` text,
	`match_lead_esp` integer DEFAULT false,
	`not_sending_status` integer,
	`stop_for_company` integer DEFAULT false,
	`insert_unsubscribe_header` integer DEFAULT false,
	`allow_risky_contacts` integer DEFAULT false,
	`disable_bounce_protect` integer DEFAULT false,
	`limit_emails_per_company_override` text,
	`cc_list` text NOT NULL,
	`bcc_list` text NOT NULL,
	`provider_routing_rules` text,
	`slow_ramp_up` integer DEFAULT false,
	`custom_variables` text,
	`owned_by` text,
	`created_by` text,
	`ai_sdr_id` text,
	`share_token` text,
	`launched_at` integer,
	`completed_at` integer,
	`last_send_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaigns_ws_status_idx` ON `campaigns` (`workspace_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_share_uq` ON `campaigns` (`share_token`);--> statement-breakpoint
CREATE TABLE `custom_prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` integer DEFAULT 1 NOT NULL,
	`properties` text,
	`prompt` text NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`model_version` text,
	`like_count` integer DEFAULT 0 NOT NULL,
	`execution_count` integer DEFAULT 0 NOT NULL,
	`template_type` text DEFAULT 'custom' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`category` text,
	`is_reply_template` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_templates_ws_idx` ON `email_templates` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `sequence_avatars` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subsequences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`parent_campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`conditions` text NOT NULL,
	`schedule` text,
	`sequences` text NOT NULL,
	`auto_variant_select` text,
	`daily_limit_mode` text DEFAULT 'inherit' NOT NULL,
	`daily_limit` integer,
	`ignore_account_daily_limit` integer DEFAULT false NOT NULL,
	`leads_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subsequences_parent_idx` ON `subsequences` (`parent_campaign_id`);--> statement-breakpoint
CREATE TABLE `block_list` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`bl_value` text NOT NULL,
	`is_domain` integer DEFAULT false NOT NULL,
	`source` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `block_list_ws_value_uq` ON `block_list` (`workspace_id`,`bl_value`);--> statement-breakpoint
CREATE TABLE `email_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`catch_all` text,
	`reason` text,
	`result` text,
	`credits_used` integer DEFAULT 0 NOT NULL,
	`job_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_verifications_ws_idx` ON `email_verifications` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_verifications_job_idx` ON `email_verifications` (`job_id`);--> statement-breakpoint
CREATE TABLE `lead_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`interest_status_label` text NOT NULL,
	`interest_status` integer NOT NULL,
	`description` text,
	`use_with_ai` integer DEFAULT false,
	`color` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_labels_ws_status_uq` ON `lead_labels` (`workspace_id`,`interest_status`);--> statement-breakpoint
CREATE TABLE `lead_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`has_enrichment_task` integer DEFAULT false,
	`owned_by` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lead_lists_ws_idx` ON `lead_lists` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `lead_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`lead_id` text,
	`lead_email` text,
	`body` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lead_notes_lead_idx` ON `lead_notes` (`workspace_id`,`lead_email`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text,
	`list_id` text,
	`subsequence_id` text,
	`email` text,
	`first_name` text,
	`last_name` text,
	`company_name` text,
	`company_domain` text DEFAULT '' NOT NULL,
	`website` text,
	`job_title` text,
	`phone` text,
	`linkedin_url` text,
	`location` text,
	`personalization` text,
	`payload` text,
	`status` integer DEFAULT 1 NOT NULL,
	`lt_interest_status` integer,
	`verification_status` integer DEFAULT 0 NOT NULL,
	`esp_code` integer DEFAULT 0 NOT NULL,
	`esg_code` integer DEFAULT 0 NOT NULL,
	`enrichment_status` integer,
	`email_open_count` integer DEFAULT 0 NOT NULL,
	`email_reply_count` integer DEFAULT 0 NOT NULL,
	`email_click_count` integer DEFAULT 0 NOT NULL,
	`last_step_from` text,
	`last_step_id` text,
	`last_step_timestamp_executed` integer,
	`email_opened_step` integer,
	`email_opened_variant` integer,
	`email_replied_step` integer,
	`email_replied_variant` integer,
	`email_clicked_step` integer,
	`email_clicked_variant` integer,
	`pl_value_lead` text,
	`assigned_to` text,
	`uploaded_by_user` text,
	`upload_method` text DEFAULT 'manual' NOT NULL,
	`is_website_visitor` integer DEFAULT false,
	`next_step` integer DEFAULT 0 NOT NULL,
	`next_send_at` integer,
	`sender_account_id` text,
	`thread_message_ids` text,
	`last_subject` text,
	`thread_id` text,
	`subseq_next_step` integer DEFAULT 0 NOT NULL,
	`subseq_next_send_at` integer,
	`subseq_status` integer,
	`timestamp_last_contact` integer,
	`timestamp_last_open` integer,
	`timestamp_last_reply` integer,
	`timestamp_last_click` integer,
	`timestamp_last_interest_change` integer,
	`timestamp_last_touch` integer,
	`timestamp_added_subsequence` integer,
	`completed_at` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_campaign_email_uq` ON `leads` (`campaign_id`,`email`) WHERE campaign_id is not null and email is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `leads_list_email_uq` ON `leads` (`list_id`,`email`) WHERE list_id is not null and email is not null;--> statement-breakpoint
CREATE INDEX `leads_ws_email_idx` ON `leads` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `leads_campaign_status_idx` ON `leads` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `leads_due_idx` ON `leads` (`campaign_id`,`next_send_at`);--> statement-breakpoint
CREATE INDEX `leads_subseq_idx` ON `leads` (`subsequence_id`,`subseq_next_send_at`);--> statement-breakpoint
CREATE INDEX `leads_list_idx` ON `leads` (`list_id`);--> statement-breakpoint
CREATE INDEX `leads_ws_interest_idx` ON `leads` (`workspace_id`,`lt_interest_status`);--> statement-breakpoint
CREATE INDEX `leads_domain_idx` ON `leads` (`workspace_id`,`company_domain`);--> statement-breakpoint
CREATE TABLE `unsubscribes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`campaign_id` text,
	`source` text DEFAULT 'link' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unsubscribes_ws_email_uq` ON `unsubscribes` (`workspace_id`,`email`);--> statement-breakpoint
CREATE TABLE `email_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email_id` text,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`storage_path` text NOT NULL,
	`content_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_attachments_email_idx` ON `email_attachments` (`email_id`);--> statement-breakpoint
CREATE TABLE `email_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`campaign_id` text,
	`subsequence_id` text,
	`lead_id` text,
	`lead_email` text,
	`account_id` text,
	`account_email` text,
	`email_id` text,
	`step` integer,
	`variant` integer,
	`url` text,
	`ip` text,
	`user_agent` text,
	`is_first` integer DEFAULT false NOT NULL,
	`value` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_events_ws_time_idx` ON `email_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_events_campaign_idx` ON `email_events` (`campaign_id`,`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_events_account_idx` ON `email_events` (`account_id`,`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_events_lead_idx` ON `email_events` (`lead_id`);--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`message_id` text NOT NULL,
	`thread_id` text,
	`in_reply_to` text,
	`references_header` text,
	`subject` text DEFAULT '' NOT NULL,
	`from_address_email` text,
	`from_address_json` text,
	`to_address_email_list` text DEFAULT '' NOT NULL,
	`to_address_json` text,
	`cc_address_email_list` text,
	`cc_address_json` text,
	`bcc_address_email_list` text,
	`reply_to` text,
	`body_text` text DEFAULT '' NOT NULL,
	`body_html` text DEFAULT '' NOT NULL,
	`content_preview` text,
	`timestamp_email` integer NOT NULL,
	`campaign_id` text,
	`subsequence_id` text,
	`list_id` text,
	`lead` text,
	`lead_id` text,
	`account_id` text,
	`eaccount` text NOT NULL,
	`ue_type` integer NOT NULL,
	`step` text,
	`variant` integer,
	`is_unread` integer DEFAULT 0 NOT NULL,
	`is_auto_reply` integer DEFAULT 0 NOT NULL,
	`is_bounce` integer DEFAULT false NOT NULL,
	`reminder_ts` integer,
	`ai_interest_value` integer,
	`ai_assisted` integer,
	`is_focused` integer DEFAULT 1 NOT NULL,
	`i_status` integer,
	`attachment_json` text,
	`ai_agent_id` text,
	`scheduled_at` integer,
	`send_error` text,
	`folder` text,
	`imap_uid` integer,
	`archived` integer DEFAULT false NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emails_ws_msgid_acct_uq` ON `emails` (`workspace_id`,`message_id`,`account_id`,`ue_type`);--> statement-breakpoint
CREATE INDEX `emails_ws_time_idx` ON `emails` (`workspace_id`,`timestamp_email`);--> statement-breakpoint
CREATE INDEX `emails_thread_idx` ON `emails` (`workspace_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `emails_lead_idx` ON `emails` (`workspace_id`,`lead`);--> statement-breakpoint
CREATE INDEX `emails_campaign_idx` ON `emails` (`campaign_id`,`ue_type`);--> statement-breakpoint
CREATE INDEX `emails_scheduled_idx` ON `emails` (`ue_type`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `background_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`entity_id` text,
	`entity_type` text,
	`data` text,
	`result` text,
	`progress` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`locked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `background_jobs_status_idx` ON `background_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `background_jobs_ws_idx` ON `background_jobs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`pool` text NOT NULL,
	`delta` real NOT NULL,
	`reason` text NOT NULL,
	`ref_id` text,
	`user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credit_ledger_ws_pool_idx` ON `credit_ledger` (`workspace_id`,`pool`,`created_at`);--> statement-breakpoint
CREATE TABLE `dfy_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`forwarding_domain` text,
	`forwarding_mode` text,
	`is_pre_warmed_up` integer DEFAULT false,
	`mailbox_provider` text DEFAULT 'google' NOT NULL,
	`mailboxes` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`price_per_month` real,
	`notes` text,
	`created_by` text,
	`timestamp_cancelled` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dfy_orders_ws_idx` ON `dfy_orders` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `inbox_placement_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`test_id` text NOT NULL,
	`run_id` text,
	`domain` text NOT NULL,
	`domain_ip` text DEFAULT '' NOT NULL,
	`domain_blacklist_count` integer,
	`domain_ip_blacklist_count` integer,
	`spam_assassin_score` real DEFAULT 0 NOT NULL,
	`spam_assassin_report` text,
	`blacklist_report` text,
	`auth_report` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ipreport_test_idx` ON `inbox_placement_reports` (`test_id`);--> statement-breakpoint
CREATE TABLE `inbox_placement_results` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`test_id` text NOT NULL,
	`run_id` text NOT NULL,
	`record_type` integer NOT NULL,
	`sender_email` text,
	`sender_esp` integer,
	`recipient_email` text,
	`recipient_esp` integer,
	`recipient_geo` integer,
	`recipient_type` integer,
	`message_id` text,
	`is_spam` integer,
	`has_category` integer,
	`folder` text,
	`spf_pass` integer,
	`dkim_pass` integer,
	`dmarc_pass` integer,
	`smtp_ip` text,
	`smtp_ip_blacklist_report` text,
	`authentication_failure_results` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ipr_test_idx` ON `inbox_placement_results` (`test_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ipr_msg_uq` ON `inbox_placement_results` (`test_id`,`message_id`,`record_type`,`recipient_email`);--> statement-breakpoint
CREATE TABLE `inbox_placement_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` integer DEFAULT 1 NOT NULL,
	`sending_method` integer DEFAULT 1 NOT NULL,
	`delivery_mode` integer DEFAULT 1,
	`campaign_id` text,
	`email_subject` text NOT NULL,
	`email_body` text NOT NULL,
	`emails` text NOT NULL,
	`recipients` text NOT NULL,
	`recipients_labels` text,
	`test_code` text,
	`tags` text,
	`text_only` integer DEFAULT false,
	`schedule` text,
	`automations` text,
	`status` integer DEFAULT 1 NOT NULL,
	`not_sending_status` text,
	`timestamp_next_run` integer,
	`last_run_at` integer,
	`run_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ipt_ws_idx` ON `inbox_placement_tests` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `ipt_next_run_idx` ON `inbox_placement_tests` (`status`,`timestamp_next_run`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`number` text NOT NULL,
	`description` text,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`pdf_url` text,
	`stripe_invoice_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invoices_ws_idx` ON `invoices` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`product` text NOT NULL,
	`plan_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`interval` text DEFAULT 'month' NOT NULL,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`stripe_subscription_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscriptions_ws_idx` ON `subscriptions` (`workspace_id`,`product`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`webhook_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`success` integer DEFAULT false NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`will_retry` integer DEFAULT true NOT NULL,
	`webhook_url` text NOT NULL,
	`status_code` integer,
	`error_message` text,
	`timestamp_next_retry` integer,
	`retry_group_id` text,
	`lead_email` text,
	`response_time_ms` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_events_ws_idx` ON `webhook_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_events_pending_idx` ON `webhook_events` (`will_retry`,`timestamp_next_retry`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`campaign_id` text,
	`name` text,
	`target_hook_url` text NOT NULL,
	`event_type` text,
	`custom_interest_value` integer,
	`headers` text,
	`secret` text,
	`status` integer DEFAULT 1 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`timestamp_error` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhooks_ws_idx` ON `webhooks` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `crm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`lead_id` text,
	`lead_email` text,
	`phone_number` text NOT NULL,
	`from_number` text,
	`direction` text DEFAULT 'outbound' NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`outcome` text,
	`duration_sec` integer DEFAULT 0 NOT NULL,
	`recording_url` text,
	`notes` text,
	`twilio_sid` text,
	`created_by` text,
	`archived_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crm_calls_ws_idx` ON `crm_calls` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `crm_calls_lead_idx` ON `crm_calls` (`workspace_id`,`lead_email`);--> statement-breakpoint
CREATE TABLE `crm_meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`lead_id` text,
	`lead_email` text,
	`title` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`location` text,
	`notes` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crm_meetings_ws_idx` ON `crm_meetings` (`workspace_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `crm_opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`lead_id` text,
	`lead_email` text,
	`company_name` text,
	`company_domain` text,
	`name` text NOT NULL,
	`value` real DEFAULT 0 NOT NULL,
	`stage` integer DEFAULT 1 NOT NULL,
	`owner_id` text,
	`expected_close_at` integer,
	`notes` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crm_opps_ws_stage_idx` ON `crm_opportunities` (`workspace_id`,`stage`);--> statement-breakpoint
CREATE TABLE `crm_phone_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`number` text NOT NULL,
	`friendly_name` text,
	`twilio_sid` text,
	`capabilities` text,
	`assigned_to` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crm_sms` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`lead_id` text,
	`lead_email` text,
	`phone_number` text NOT NULL,
	`from_number` text,
	`direction` text DEFAULT 'outbound' NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`twilio_sid` text,
	`created_by` text,
	`archived_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crm_sms_ws_idx` ON `crm_sms` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `crm_sms_lead_idx` ON `crm_sms` (`workspace_id`,`lead_email`);--> statement-breakpoint
CREATE TABLE `crm_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`lead_id` text,
	`lead_email` text,
	`title` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'todo' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`due_at` integer,
	`assigned_to` text,
	`created_by` text,
	`completed_at` integer,
	`archived_at` integer,
	`source` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crm_tasks_ws_due_idx` ON `crm_tasks` (`workspace_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `crm_tasks_lead_idx` ON `crm_tasks` (`workspace_id`,`lead_email`);--> statement-breakpoint
CREATE TABLE `crm_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`entity` text DEFAULT 'leads' NOT NULL,
	`filters` text NOT NULL,
	`sort` text,
	`columns` text,
	`is_shared` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crm_views_ws_idx` ON `crm_views` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `sales_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false,
	`queries` text NOT NULL,
	`list_id` text,
	`campaign_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sales_flows_ws_idx` ON `sales_flows` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `ai_agent_guidance` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`label` text NOT NULL,
	`instruction` text DEFAULT '' NOT NULL,
	`status` integer DEFAULT 1 NOT NULL,
	`category` integer DEFAULT 1 NOT NULL,
	`basic_guidance_options` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_agent_guidance_agent_idx` ON `ai_agent_guidance` (`agent_id`);--> statement-breakpoint
CREATE TABLE `ai_agent_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text,
	`thread_id` text,
	`in_reply_to` text,
	`lead` text,
	`account_email` text,
	`subject` text,
	`html` text,
	`requires_hitl` integer DEFAULT false,
	`requires_hitl_reason` text,
	`confidence_score` real,
	`sending_status` integer DEFAULT 1 NOT NULL,
	`action_pending` integer DEFAULT true,
	`feedback_positive` integer,
	`feedback_text` text,
	`is_followup` integer DEFAULT false,
	`error_code` text,
	`usage_metadata` text,
	`estimated_time_saved_seconds` integer,
	`generation_lag_seconds` real,
	`sent_email_id` text,
	`scheduled_send_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_agent_replies_ws_idx` ON `ai_agent_replies` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_agent_replies_agent_idx` ON `ai_agent_replies` (`agent_id`,`sending_status`);--> statement-breakpoint
CREATE TABLE `ai_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`type` integer NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`configuration_mode` text,
	`payload` text NOT NULL,
	`description` text,
	`is_auto_created` integer DEFAULT false,
	`created_by` text,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_agents_ws_idx` ON `ai_agents` (`workspace_id`,`type`);--> statement-breakpoint
CREATE TABLE `ai_sales_agent_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ai_sdr_id` text NOT NULL,
	`action_type` text NOT NULL,
	`action_status` text DEFAULT 'pending' NOT NULL,
	`action_payload` text,
	`action_output` text,
	`email_id` text,
	`approved_by` text,
	`approved_at` integer,
	`rejected_by` text,
	`rejected_at` integer,
	`rejection_reason` text,
	`ai_reasoning` text,
	`ai_confidence` real,
	`result` text,
	`error_message` text,
	`error_code` text,
	`timestamp_executed` integer,
	`timestamp_completed` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_sdr_activities_idx` ON `ai_sales_agent_activities` (`ai_sdr_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_sales_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'website' NOT NULL,
	`input` text,
	`status` integer DEFAULT 0 NOT NULL,
	`phase` text DEFAULT 'learning' NOT NULL,
	`config` text NOT NULL,
	`agent_type` integer DEFAULT 2 NOT NULL,
	`self_improvement` integer DEFAULT true,
	`master_lead_list_id` text,
	`initial_scrape_ready` integer DEFAULT false NOT NULL,
	`timestamp_last_action` integer,
	`timestamp_last_decision` integer,
	`next_decision_time` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_sales_agents_ws_idx` ON `ai_sales_agents` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_usage_ws_idx` ON `ai_usage` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `copilot_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`data` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `copilot_memory_ws_key_uq` ON `copilot_memory` (`workspace_id`,`key`);--> statement-breakpoint
CREATE TABLE `copilot_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`display` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `copilot_messages_thread_idx` ON `copilot_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `copilot_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`frequency` text DEFAULT 'once' NOT NULL,
	`time_of_day` text DEFAULT '09:00',
	`timezone` text DEFAULT 'UTC',
	`next_run_at` integer,
	`last_run_at` integer,
	`last_result` text,
	`last_thread_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `copilot_tasks_next_idx` ON `copilot_tasks` (`status`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `copilot_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT 'New chat' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `copilot_threads_user_idx` ON `copilot_threads` (`workspace_id`,`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `enrichments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_type` integer NOT NULL,
	`type` text NOT NULL,
	`enrichment_payload` text,
	`limit` integer,
	`auto_update` integer DEFAULT false,
	`skip_rows_without_email` integer DEFAULT false,
	`in_progress` integer DEFAULT false,
	`processed` integer DEFAULT 0 NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `enrichments_resource_idx` ON `enrichments` (`resource_id`);--> statement-breakpoint
CREATE TABLE `evergreen_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`target_id` text NOT NULL,
	`daily_limit` integer DEFAULT 50 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_run_at` integer,
	`total_moved` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evergreen_jobs_status_idx` ON `evergreen_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `lf_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`name` text NOT NULL,
	`domain` text,
	`industry` text,
	`sub_industry` text,
	`employee_count` integer,
	`revenue_range` text,
	`founded_year` integer,
	`country` text,
	`state` text,
	`city` text,
	`description` text,
	`keywords` text,
	`technologies` text,
	`funding` text,
	`linkedin_url` text,
	`logo_url` text,
	`phone` text,
	`news` text,
	`job_postings` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lf_companies_domain_idx` ON `lf_companies` (`domain`);--> statement-breakpoint
CREATE INDEX `lf_companies_industry_idx` ON `lf_companies` (`industry`);--> statement-breakpoint
CREATE TABLE `lf_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`file_path` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lf_people` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`company_id` text,
	`first_name` text,
	`last_name` text,
	`full_name` text,
	`title` text,
	`seniority` text,
	`department` text,
	`email` text,
	`email_status` text,
	`phone` text,
	`linkedin_url` text,
	`country` text,
	`state` text,
	`city` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lf_people_company_idx` ON `lf_people` (`company_id`);--> statement-breakpoint
CREATE INDEX `lf_people_title_idx` ON `lf_people` (`title`);--> statement-breakpoint
CREATE INDEX `lf_people_country_idx` ON `lf_people` (`country`);--> statement-breakpoint
CREATE TABLE `lf_saved_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`filters` text NOT NULL,
	`is_history` integer DEFAULT false NOT NULL,
	`result_count` integer,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lf_saved_searches_ws_idx` ON `lf_saved_searches` (`workspace_id`,`is_history`,`created_at`);--> statement-breakpoint
CREATE TABLE `lf_unlocks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`person_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lf_unlocks_uq` ON `lf_unlocks` (`workspace_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `visitor_pageviews` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`url` text NOT NULL,
	`path` text,
	`title` text,
	`duration_sec` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `visitor_pageviews_session_idx` ON `visitor_pageviews` (`session_id`);--> statement-breakpoint
CREATE TABLE `visitor_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`site_id` text NOT NULL,
	`visitor_key` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`company_name` text,
	`company_domain` text,
	`company_data` text,
	`country` text,
	`region` text,
	`city` text,
	`referrer` text,
	`utm` text,
	`landing_url` text,
	`pageviews` integer DEFAULT 0 NOT NULL,
	`duration_sec` integer DEFAULT 0 NOT NULL,
	`identified` integer DEFAULT false NOT NULL,
	`matches_icp` integer,
	`lead_id` text,
	`hidden` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `visitor_sessions_ws_idx` ON `visitor_sessions` (`workspace_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `visitor_sessions_key_idx` ON `visitor_sessions` (`site_id`,`visitor_key`);--> statement-breakpoint
CREATE TABLE `visitor_sites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`pixel_key` text NOT NULL,
	`settings` text,
	`tos_signed_at` integer,
	`last_event_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visitor_sites_pixel_uq` ON `visitor_sites` (`pixel_key`);--> statement-breakpoint
CREATE INDEX `visitor_sites_ws_idx` ON `visitor_sites` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`trigger_event` text,
	`context` text,
	`current_node_id` text,
	`resume_at` integer,
	`logs` text,
	`error` text,
	`duration_ms` real,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_wf_idx` ON `workflow_runs` (`workflow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_resume_idx` ON `workflow_runs` (`status`,`resume_at`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`trigger_type` text,
	`graph` text NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflows_ws_trigger_idx` ON `workflows` (`workspace_id`,`status`,`trigger_type`);
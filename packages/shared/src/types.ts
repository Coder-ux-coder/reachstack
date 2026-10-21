// API v2 shaped DTOs shared by server serializers and the web client.
import type { DelayUnit } from "./constants";
import type { TaskStepKind } from "./task-steps";
import type { Role, Permission } from "./permissions";

export interface Paginated<T> {
  items: T[];
  next_starting_after?: string | null;
  total?: number;
}

export interface ScheduleWindow {
  name: string;
  timing: { from: string; to: string }; // "HH:mm"
  days: Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", boolean>;
  timezone: string;
}

export interface CampaignSchedule {
  start_date: string | null;
  end_date: string | null;
  schedules: ScheduleWindow[];
  /** Days nothing goes out, on the first window's calendar: public holidays of some countries, and dates of your own. */
  days_off?: { holidays?: string[]; dates?: string[] } | null;
  /**
   * Send in each lead's own timezone: the windows (and days off and dates) apply on the lead's clock when its timezone
   * is known, and on the schedule's own clock for the rest.
   */
  lead_timezone?: boolean;
}

export interface SequenceVariant {
  subject: string;
  body: string;
  v_disabled?: boolean;
}

export interface SequenceStep {
  /** An email, or a task done by hand (see TASK_STEPS), whose one variant holds the task's title and note. */
  type: "email" | "task";
  task?: TaskStepKind;
  delay: number;
  delay_unit?: DelayUnit;
  pre_delay?: number;
  pre_delay_unit?: DelayUnit;
  variants: SequenceVariant[];
}

export interface Sequence {
  steps: SequenceStep[];
}

export interface Campaign {
  id: string;
  name: string;
  status: number;
  pl_value: number | null;
  is_evergreen: boolean | null;
  campaign_schedule: CampaignSchedule;
  sequences: Sequence[];
  timestamp_created: string;
  timestamp_updated: string;
  email_gap: number | null;
  random_wait_max: number | null;
  text_only: boolean | null;
  first_email_text_only: boolean | null;
  email_list: string[];
  daily_limit: number | null;
  stop_on_reply: boolean | null;
  email_tag_list: string[];
  link_tracking: boolean | null;
  open_tracking: boolean;
  stop_on_auto_reply: boolean | null;
  daily_max_leads: number | null;
  prioritize_new_leads: boolean | null;
  auto_variant_select: { trigger: "reply_rate" | "click_rate" | "open_rate" } | null;
  match_lead_esp: boolean | null;
  not_sending_status: number | null;
  stop_for_company: boolean | null;
  insert_unsubscribe_header: boolean | null;
  allow_risky_contacts: boolean | null;
  disable_bounce_protect: boolean | null;
  limit_emails_per_company_override: {
    mode: "custom" | "disabled";
    daily_limit?: number;
    scope?: "per_campaign" | "across_workspace";
  } | null;
  cc_list: string[];
  bcc_list: string[];
  organization: string;
  owned_by: string | null;
  created_by: string | null;
  ai_sdr_id: string | null;
  provider_routing_rules: Array<{
    action: "send" | "do_not_send";
    recipient_esp: Array<"all" | "google" | "outlook" | "other">;
    sender_esp: Array<"all" | "google" | "outlook" | "other">;
  }>;
  slow_ramp_up?: boolean | null;
  tags?: string[];
}

export interface AccountWarmupConfig {
  limit: number;
  increment: string; // "disabled" | "0".."4" ramp increments per day
  reply_rate: number;
  warmup_custom_ftag?: string | null;
  advanced?: {
    warm_ctd?: boolean;
    open_rate?: number;
    important_rate?: number;
    read_emulation?: boolean;
    spam_save_rate?: number;
    weekday_only?: boolean;
  };
}

export interface Account {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  provider_code: number;
  status: number;
  status_message: {
    code?: string;
    command?: string;
    response?: string;
    e_message?: string;
    responseCode?: number;
    /** Which half of the mailbox failed last, and each half's open failure: sending (SMTP) or the inbox (IMAP). */
    side?: "smtp" | "imap";
    sides?: Partial<Record<"smtp" | "imap", { code: string; message: string; at: number; count: number }>>;
  } | null;
  warmup_status: number;
  warmup: AccountWarmupConfig;
  daily_limit: number | null;
  sending_gap: number;
  signature: string | null;
  reply_to: string | null;
  tracking_domain_name: string | null;
  tracking_domain_status: string | null;
  enable_slow_ramp: boolean | null;
  stat_warmup_score: number | null;
  timestamp_warmup_start: string | null;
  timestamp_created: string;
  timestamp_updated: string;
  organization: string;
  setup_pending: boolean;
  is_managed_account: boolean;
  tags?: string[];
  sent_today?: number;
  warmup_sent_today?: number;
}

export interface Lead {
  id: string;
  timestamp_created: string;
  timestamp_updated: string;
  organization: string;
  campaign: string | null;
  list_id: string | null;
  status: number;
  email: string | null;
  personalization: string | null;
  website: string | null;
  last_name: string | null;
  first_name: string | null;
  company_name: string | null;
  job_title: string | null;
  phone: string | null;
  email_open_count: number;
  email_reply_count: number;
  email_click_count: number;
  company_domain: string;
  payload: Record<string, unknown> | null;
  lt_interest_status: number | null;
  verification_status: number;
  esp_code: number;
  /** Security gateway (EsgCode). */
  esg_code: number;
  /** IANA timezone: given, or worked out from the lead's location, custom fields or phone (null when unknown). */
  timezone: string | null;
  enrichment_status: number | null;
  pl_value_lead: string | null;
  subsequence_id: string | null;
  assigned_to: string | null;
  upload_method: string;
  is_website_visitor: boolean | null;
  last_step_id: string | null;
  last_step_from: string | null;
  last_step_timestamp_executed: string | null;
  email_opened_step: number | null;
  email_replied_step: number | null;
  email_clicked_step: number | null;
  timestamp_last_contact: string | null;
  timestamp_last_open: string | null;
  timestamp_last_reply: string | null;
  timestamp_last_click: string | null;
  timestamp_last_interest_change: string | null;
  timestamp_last_touch: string | null;
}

export interface Email {
  id: string;
  timestamp_created: string;
  timestamp_email: string;
  message_id: string;
  subject: string;
  from_address_email: string | null;
  to_address_email_list: string;
  cc_address_email_list: string | null;
  bcc_address_email_list: string | null;
  reply_to: string | null;
  body: { text: string; html: string };
  organization_id: string;
  campaign_id: string | null;
  subsequence_id: string | null;
  list_id: string | null;
  lead: string | null;
  lead_id: string | null;
  eaccount: string;
  ue_type: number;
  step: string | null;
  is_unread: number;
  is_auto_reply: number;
  reminder_ts: string | null;
  ai_interest_value: number | null;
  ai_assisted: number | null;
  is_focused: number;
  i_status: number | null;
  thread_id: string | null;
  content_preview: string | null;
  attachment_json: { files: Array<{ filename: string; size: number; content_type: string; id: string }> } | null;
  from_address_json: Array<{ address: string; name: string }> | null;
  to_address_json: Array<{ address: string; name: string }> | null;
  cc_address_json: Array<{ address: string; name: string }> | null;
  ai_agent_id: string | null;
  scheduled_at?: string | null;
  campaign_name?: string | null;
}

export interface LeadList {
  id: string;
  organization_id: string;
  name: string;
  has_enrichment_task: boolean | null;
  owned_by: string | null;
  timestamp_created: string;
  lead_count?: number;
}

export interface Me {
  user: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    avatar_url: string | null;
    timezone: string | null;
    totp_enabled: boolean;
    email_verified: boolean;
    theme: string | null;
    onboarding_completed: boolean;
    is_superadmin: boolean;
  };
  workspace: {
    id: string;
    name: string;
    owner: string;
    logo_url: string | null;
    plan_ids: Record<string, string | null>;
    self_hosted: boolean;
    trial_ends_at: string | null;
    settings: Record<string, unknown>;
  } | null;
  membership: { role: Role; permissions: Permission[] | null } | null;
  workspaces: Array<{ id: string; name: string; role: Role; logo_url: string | null }>;
  features: Record<string, boolean>;
  /** The product brand, or an agency's white-label brand for its clients. */
  brand: { name: string; color: string | null; logo_url: string | null };
}

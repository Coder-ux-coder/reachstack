import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Campaign, CampaignSchedule, Sequence } from "@reachstack/shared";
import { bool, createdAt, json, pk, ts, updatedAt, workspaceId } from "./_helpers";

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    status: integer("status").notNull().default(0),
    plValue: real("pl_value"),
    isEvergreen: bool("is_evergreen").default(false),
    schedule: json<CampaignSchedule>("schedule").notNull(),
    sequences: json<Sequence[]>("sequences").notNull(),
    emailGap: integer("email_gap").default(10),
    randomWaitMax: integer("random_wait_max").default(10),
    textOnly: bool("text_only").default(false),
    firstEmailTextOnly: bool("first_email_text_only").default(false),
    emailList: json<string[]>("email_list").notNull(),
    emailTagList: json<string[]>("email_tag_list").notNull(),
    dailyLimit: integer("daily_limit").default(50),
    stopOnReply: bool("stop_on_reply").default(true),
    linkTracking: bool("link_tracking").default(false),
    openTracking: bool("open_tracking").notNull().default(false),
    stopOnAutoReply: bool("stop_on_auto_reply").default(false),
    dailyMaxLeads: integer("daily_max_leads"),
    prioritizeNewLeads: bool("prioritize_new_leads").default(false),
    autoVariantSelect: json<Campaign["auto_variant_select"]>("auto_variant_select"),
    matchLeadEsp: bool("match_lead_esp").default(false),
    notSendingStatus: integer("not_sending_status"),
    stopForCompany: bool("stop_for_company").default(false),
    insertUnsubscribeHeader: bool("insert_unsubscribe_header").default(false),
    allowRiskyContacts: bool("allow_risky_contacts").default(false),
    disableBounceProtect: bool("disable_bounce_protect").default(false),
    /** After someone resumes a campaign that bounce protection paused, protection waits until this time. */
    bounceGraceUntil: ts("bounce_grace_until"),
    limitEmailsPerCompanyOverride: json<Campaign["limit_emails_per_company_override"]>("limit_emails_per_company_override"),
    ccList: json<string[]>("cc_list").notNull(),
    bccList: json<string[]>("bcc_list").notNull(),
    providerRoutingRules: json<Campaign["provider_routing_rules"]>("provider_routing_rules"),
    slowRampUp: bool("slow_ramp_up").default(false),
    customVariables: json<string[]>("custom_variables"),
    ownedBy: text("owned_by"),
    createdBy: text("created_by"),
    aiSdrId: text("ai_sdr_id"),
    shareToken: text("share_token"),
    /** Share links work for 7 days after the campaign was last shared. */
    shareExpiresAt: ts("share_expires_at"),
    launchedAt: ts("launched_at"),
    completedAt: ts("completed_at"),
    lastSendAt: ts("last_send_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("campaigns_ws_status_idx").on(t.workspaceId, t.status), uniqueIndex("campaigns_share_uq").on(t.shareToken)],
);

export interface SubsequenceConditions {
  crm_status?: number[];
  lead_activity?: number[];
  reply_contains?: string;
}

export const subsequences = sqliteTable(
  "subsequences",
  {
    id: pk(),
    workspaceId: workspaceId(),
    parentCampaignId: text("parent_campaign_id").notNull(),
    name: text("name").notNull(),
    status: integer("status").notNull().default(0),
    conditions: json<SubsequenceConditions>("conditions").notNull(),
    schedule: json<CampaignSchedule>("schedule"),
    sequences: json<Sequence[]>("sequences").notNull(),
    autoVariantSelect: json<Campaign["auto_variant_select"]>("auto_variant_select"),
    dailyLimitMode: text("daily_limit_mode").notNull().default("inherit"),
    dailyLimit: integer("daily_limit"),
    ignoreAccountDailyLimit: bool("ignore_account_daily_limit").notNull().default(false),
    leadsUpdatedAt: ts("leads_updated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("subsequences_parent_idx").on(t.parentCampaignId)],
);

export const emailTemplates = sqliteTable(
  "email_templates",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    category: text("category"),
    isReplyTemplate: bool("is_reply_template").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("email_templates_ws_idx").on(t.workspaceId)],
);

/** Saved "avatars" for the AI sequence generator. */
export const sequenceAvatars = sqliteTable("sequence_avatars", {
  id: pk(),
  workspaceId: workspaceId(),
  name: text("name").notNull(),
  data: json<Record<string, string>>("data").notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});

/** AI prompt columns that generate a per-lead variable (e.g. personalised first line). */
export const aiPrompts = sqliteTable(
  "ai_prompts",
  {
    id: pk(),
    workspaceId: workspaceId(),
    campaignId: text("campaign_id"),
    listId: text("list_id"),
    name: text("name").notNull(),
    outputVariable: text("output_variable").notNull(),
    prompt: text("prompt").notNull(),
    model: text("model"),
    status: text("status").notNull().default("idle"), // idle | running | done | failed
    processed: integer("processed").notNull().default(0),
    total: integer("total").notNull().default(0),
    onlyEmpty: bool("only_empty").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_prompts_campaign_idx").on(t.campaignId)],
);

export const customPromptTemplates = sqliteTable("custom_prompt_templates", {
  id: pk(),
  workspaceId: workspaceId(),
  createdBy: text("created_by").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  category: integer("category").notNull().default(1),
  properties: json<unknown[]>("properties"),
  prompt: text("prompt").notNull(),
  isPublic: bool("is_public").notNull().default(false),
  modelVersion: text("model_version"),
  likeCount: integer("like_count").notNull().default(0),
  executionCount: integer("execution_count").notNull().default(0),
  templateType: text("template_type").notNull().default("custom"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

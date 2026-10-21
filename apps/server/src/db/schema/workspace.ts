import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Permission, Role } from "@reachstack/shared";
import { bool, createdAt, json, pk, ts, updatedAt, workspaceId } from "./_helpers";

export interface WorkspaceSettings {
  // preferences
  default_timezone?: string;
  /** An admin chose the timezone (or kept it) on purpose: the dashboard no longer asks about it. */
  timezone_confirmed?: boolean;
  unibox_show_auto_replies?: boolean;
  unibox_focused_inbox?: boolean;
  limit_emails_per_company?: { enabled: boolean; daily_limit: number; scope?: "per_campaign" | "across_workspace" };
  auto_label_with_ai?: boolean;
  stop_campaign_on_lead_reply_from_any_campaign?: boolean;
  // advanced deliverability
  esp_matching_default?: boolean;
  bounce_protect_threshold?: number; // percent
  max_bounce_rate_pause?: number;
  global_block_sheet_link?: string | null;
  custom_warmup_copy?: { enabled: boolean; subjects: string[]; bodies: string[] };
  warmup_pool?: "workspace" | "installation";
  // crm
  crm_pipeline_statuses?: number[];
  crm_default_view?: string;
  // ai
  anthropic_api_key_enc?: string | null;
  ai_model?: string | null;
  // agency / white label (the portal domain itself is workspaces.client_domain)
  agency?: {
    enabled?: boolean;
    brand_name?: string | null;
    brand_color?: string | null;
    /** Default access for client members who don't have their own list. */
    client_permissions?: Permission[];
  };
  [key: string]: unknown;
}

export const workspaces = sqliteTable("workspaces", {
  id: pk(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull(),
  logoUrl: text("logo_url"),
  planIds: json<Record<string, string | null>>("plan_ids"),
  selfHosted: bool("self_hosted").notNull().default(true),
  trialEndsAt: ts("trial_ends_at"),
  trialExtended: bool("trial_extended").notNull().default(false),
  settings: json<WorkspaceSettings>("settings"),
  addUnsubToBlock: bool("add_unsub_to_block").notNull().default(true),
  defaultOpportunityValue: real("default_opportunity_value"),
  clientDomain: text("client_domain"),
  security: json<{ require_2fa?: boolean; reauth_hours?: number | null }>("security"),
  stripeCustomerId: text("stripe_customer_id"),
  scheduledForRemovalAt: ts("scheduled_for_removal_at"),
  deletedAt: ts("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: text("user_id"),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull(),
    permissions: json<Permission[]>("permissions"),
    nickname: text("nickname"),
    accepted: bool("accepted").notNull().default(false),
    issuerId: text("issuer_id"),
    inviteTokenHash: text("invite_token_hash"),
    /** When the invitation link was last sent; links work for 7 days. */
    invitedAt: ts("invited_at"),
    /**
     * A seat taken through a right rather than an invitation: "installation" (an installation administrator opened the
     * workspace) or "agency:<workspace id>" (an admin of a managing workspace). It goes when that right goes.
     */
    enteredVia: text("entered_via"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("workspace_members_ws_email_uq").on(t.workspaceId, t.email),
    index("workspace_members_user_idx").on(t.userId),
    index("workspace_members_token_idx").on(t.inviteTokenHash),
  ],
);

/** Agency mode: an admin workspace manages sub-workspaces. */
export const workspaceGroupMembers = sqliteTable(
  "workspace_group_members",
  {
    id: pk(),
    adminWorkspaceId: text("admin_workspace_id").notNull(),
    subWorkspaceId: text("sub_workspace_id").notNull(),
    status: text("status").notNull().default("pending"), // pending | accepted | rejected
    inviteTokenHash: text("invite_token_hash"),
    invitedEmail: text("invited_email"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("wgm_pair_uq").on(t.adminWorkspaceId, t.subWorkspaceId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    scopes: json<string[]>("scopes").notNull(),
    createdBy: text("created_by"),
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_ws_idx").on(t.workspaceId)],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: pk(),
    workspaceId: workspaceId(),
    activityType: integer("activity_type").notNull(),
    userId: text("user_id"),
    userName: text("user_name"),
    ipAddress: text("ip_address").notNull().default(""),
    userAgent: text("user_agent"),
    fromApi: bool("from_api").notNull().default(false),
    apiKeyId: text("api_key_id"),
    affectedCount: integer("affected_count"),
    campaignId: text("campaign_id"),
    webhookId: text("webhook_id"),
    subsequenceId: text("subsequence_id"),
    listId: text("list_id"),
    metadata: json<Record<string, unknown>>("metadata"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_ws_time_idx").on(t.workspaceId, t.createdAt)],
);

export const customTags = sqliteTable(
  "custom_tags",
  {
    id: pk(),
    workspaceId: workspaceId(),
    label: text("label").notNull(),
    description: text("description"),
    color: text("color"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("custom_tags_ws_label_uq").on(t.workspaceId, t.label)],
);

export const customTagMappings = sqliteTable(
  "custom_tag_mappings",
  {
    id: pk(),
    workspaceId: workspaceId(),
    tagId: text("tag_id").notNull(),
    resourceId: text("resource_id").notNull(),
    resourceType: integer("resource_type").notNull(), // 1 account, 2 campaign, 3 workspace
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("custom_tag_mappings_uq").on(t.tagId, t.resourceId),
    index("custom_tag_mappings_resource_idx").on(t.resourceId),
  ],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: text("user_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_ws_user_idx").on(t.workspaceId, t.userId, t.createdAt)],
);

export const integrations = sqliteTable(
  "integrations",
  {
    id: pk(),
    workspaceId: workspaceId(),
    type: text("type").notNull(), // slack | hubspot | salesforce | pipedrive | zapier | calendly | google_sheets | twilio | anthropic | ipinfo | data_provider
    name: text("name"),
    configEnc: text("config_enc"), // encrypted JSON
    publicConfig: json<Record<string, unknown>>("public_config"),
    status: text("status").notNull().default("connected"),
    error: text("error"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("integrations_ws_type_idx").on(t.workspaceId, t.type)],
);

export const accelerator = sqliteTable(
  "accelerator_progress",
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: text("user_id").notNull(),
    itemKey: text("item_key").notNull(),
    completedAt: createdAt(),
  },
  (t) => [uniqueIndex("accelerator_uq").on(t.workspaceId, t.userId, t.itemKey)],
);

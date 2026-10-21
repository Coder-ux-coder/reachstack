import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, createdAt, json, pk, ts, updatedAt, workspaceId } from "./_helpers";

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: pk(),
    workspaceId: workspaceId(),
    campaignId: text("campaign_id"),
    name: text("name"),
    targetHookUrl: text("target_hook_url").notNull(),
    eventType: text("event_type"),
    customInterestValue: integer("custom_interest_value"),
    headers: json<Record<string, string>>("headers"),
    secret: text("secret"),
    status: integer("status").notNull().default(1), // 1 active, -1 error, 0 paused
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    timestampError: ts("timestamp_error"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhooks_ws_idx").on(t.workspaceId)],
);

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: pk(),
    workspaceId: workspaceId(),
    webhookId: text("webhook_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    success: bool("success").notNull().default(false),
    retryCount: integer("retry_count").notNull().default(0),
    willRetry: bool("will_retry").notNull().default(true),
    webhookUrl: text("webhook_url").notNull(),
    statusCode: integer("status_code"),
    errorMessage: text("error_message"),
    nextRetryAt: ts("timestamp_next_retry"),
    retryGroupId: text("retry_group_id"),
    leadEmail: text("lead_email"),
    responseTimeMs: integer("response_time_ms"),
    deliveredAt: ts("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("webhook_events_ws_idx").on(t.workspaceId, t.createdAt),
    index("webhook_events_pending_idx").on(t.willRetry, t.nextRetryAt),
  ],
);

export const backgroundJobs = sqliteTable(
  "background_jobs",
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: text("user_id"),
    type: text("type").notNull(),
    entityId: text("entity_id"),
    entityType: text("entity_type"),
    data: json<Record<string, unknown>>("data"),
    result: json<Record<string, unknown>>("result"),
    progress: real("progress").notNull().default(0),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: ts("locked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("background_jobs_status_idx").on(t.status, t.createdAt), index("background_jobs_ws_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * A job's large input (the rows of an import, a mailbox list with its passwords encrypted), kept out of the job's row so
 * reading a job and writing its progress stay small. Removed once the job has ended.
 */
export const jobInputs = sqliteTable("job_inputs", {
  jobId: text("job_id").primaryKey(),
  input: json<unknown>("input"),
  /** Encrypted (lib/crypto): input that must never be readable from the job. */
  sealed: text("sealed"),
  createdAt: createdAt(),
});

/** The rest of a job's input when it arrives in parts (a big import, a few thousand rows a request): read in turn. */
export const jobInputParts = sqliteTable(
  "job_input_parts",
  {
    jobId: text("job_id").notNull(),
    /** 2, 3…: the first part is the job's own input. */
    seq: integer("seq").notNull(),
    input: json<unknown>("input"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.seq] })],
);

export const inboxPlacementTests = sqliteTable(
  "inbox_placement_tests",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    description: text("description"),
    type: integer("type").notNull().default(1), // 1 one-time, 2 automated
    sendingMethod: integer("sending_method").notNull().default(1), // 1 from app, 2 external
    deliveryMode: integer("delivery_mode").default(1),
    campaignId: text("campaign_id"),
    emailSubject: text("email_subject").notNull(),
    emailBody: text("email_body").notNull(),
    emails: json<string[]>("emails").notNull(), // sending accounts
    recipients: json<string[]>("recipients").notNull(), // seed mailboxes
    recipientsLabels: json<Array<{ region: string; sub_region: string; type: string; esp: string }>>("recipients_labels"),
    testCode: text("test_code"),
    tags: json<string[]>("tags"),
    textOnly: bool("text_only").default(false),
    schedule: json<{ days: Record<string, boolean>; timing: { from: string }; timezone: string }>("schedule"),
    automations: json<unknown[]>("automations"),
    status: integer("status").notNull().default(1),
    notSendingStatus: text("not_sending_status"),
    nextRunAt: ts("timestamp_next_run"),
    lastRunAt: ts("last_run_at"),
    runCount: integer("run_count").notNull().default(0),
    /** The run still sending its emails (its results aren't complete until it's done), and since when. */
    sendingRunId: text("sending_run_id"),
    sendingSince: ts("sending_since"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ipt_ws_idx").on(t.workspaceId), index("ipt_next_run_idx").on(t.status, t.nextRunAt)],
);

export const inboxPlacementResults = sqliteTable(
  "inbox_placement_results",
  {
    id: pk(),
    workspaceId: workspaceId(),
    testId: text("test_id").notNull(),
    runId: text("run_id").notNull(),
    recordType: integer("record_type").notNull(), // 1 sent, 2 received
    senderEmail: text("sender_email"),
    senderEsp: integer("sender_esp"),
    recipientEmail: text("recipient_email"),
    recipientEsp: integer("recipient_esp"),
    recipientGeo: integer("recipient_geo"),
    recipientType: integer("recipient_type"),
    messageId: text("message_id"),
    isSpam: bool("is_spam"),
    hasCategory: bool("has_category"),
    folder: text("folder"),
    spfPass: bool("spf_pass"),
    dkimPass: bool("dkim_pass"),
    dmarcPass: bool("dmarc_pass"),
    smtpIp: text("smtp_ip"),
    smtpIpBlacklistReport: json<Record<string, unknown>>("smtp_ip_blacklist_report"),
    authenticationFailureResults: json<Record<string, unknown>>("authentication_failure_results"),
    createdAt: createdAt(),
  },
  (t) => [index("ipr_test_idx").on(t.testId, t.runId), uniqueIndex("ipr_msg_uq").on(t.testId, t.messageId, t.recordType, t.recipientEmail)],
);

export const inboxPlacementReports = sqliteTable(
  "inbox_placement_reports",
  {
    id: pk(),
    workspaceId: workspaceId(),
    testId: text("test_id").notNull(),
    runId: text("run_id"),
    domain: text("domain").notNull(),
    domainIp: text("domain_ip").notNull().default(""),
    domainBlacklistCount: integer("domain_blacklist_count"),
    domainIpBlacklistCount: integer("domain_ip_blacklist_count"),
    spamAssassinScore: real("spam_assassin_score").notNull().default(0),
    spamAssassinReport: json<Record<string, unknown>>("spam_assassin_report"),
    blacklistReport: json<Record<string, unknown>>("blacklist_report"),
    authReport: json<Record<string, unknown>>("auth_report"),
    createdAt: createdAt(),
  },
  (t) => [index("ipreport_test_idx").on(t.testId)],
);

export interface DfyMailbox {
  id?: string;
  first_name: string;
  last_name: string;
  email: string;
  /** Set by whoever fulfils the order; encrypted at rest. */
  password_enc?: string | null;
  cancelled_at?: string | null;
}

export const dfyOrders = sqliteTable(
  "dfy_orders",
  {
    id: pk(),
    workspaceId: workspaceId(),
    domain: text("domain").notNull(),
    forwardingDomain: text("forwarding_domain"),
    forwardingMode: text("forwarding_mode"), // redirect | stealth
    isPreWarmedUp: bool("is_pre_warmed_up").default(false),
    mailboxProvider: text("mailbox_provider").notNull().default("google"),
    orderType: text("order_type").notNull().default("dfy"), // dfy | pre_warmed_up | extra_accounts
    mailboxes: json<DfyMailbox[]>("mailboxes").notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | active | cancelled | failed
    pricePerMonth: real("price_per_month"),
    notes: text("notes"),
    createdBy: text("created_by"),
    cancelledAt: ts("timestamp_cancelled"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("dfy_orders_ws_idx").on(t.workspaceId)],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: pk(),
    workspaceId: workspaceId(),
    product: text("product").notNull(),
    planId: text("plan_id").notNull(),
    status: text("status").notNull().default("active"), // active | trialing | past_due | cancelled
    interval: text("interval").notNull().default("month"),
    currentPeriodEnd: ts("current_period_end"),
    cancelAtPeriodEnd: bool("cancel_at_period_end").notNull().default(false),
    stripeSubscriptionId: text("stripe_subscription_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("subscriptions_ws_idx").on(t.workspaceId, t.product)],
);

export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: pk(),
    workspaceId: workspaceId(),
    pool: text("pool").notNull(), // credits | verification | visitors
    delta: real("delta").notNull(),
    reason: text("reason").notNull(),
    refId: text("ref_id"),
    userId: text("user_id"),
    createdAt: createdAt(),
  },
  (t) => [index("credit_ledger_ws_pool_idx").on(t.workspaceId, t.pool, t.createdAt)],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: pk(),
    workspaceId: workspaceId(),
    number: text("number").notNull(),
    description: text("description"),
    amount: real("amount").notNull(),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull().default("paid"),
    pdfUrl: text("pdf_url"),
    stripeInvoiceId: text("stripe_invoice_id"),
    createdAt: createdAt(),
  },
  (t) => [index("invoices_ws_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * Seed mailboxes used by inbox placement tests. `accountId` points to a connected mailbox the checker
 * can read; seeds without an account are simulated sandbox mailboxes (demo/test mode only).
 */
export const placementSeeds = sqliteTable(
  "placement_seeds",
  {
    id: pk(),
    email: text("email").notNull(),
    accountId: text("account_id"),
    region: text("region").notNull(),
    subRegion: text("sub_region").notNull(),
    type: text("type").notNull(), // Professional | Personal
    esp: integer("esp").notNull(), // 1 Google, 2 Microsoft, 8 AirMail, 12 Web.de, 13 Libero
    geo: integer("geo").notNull(), // 1 US, 2 Italy, 3 Germany, 4 France
    active: bool("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("placement_seeds_email_uq").on(t.email)],
);

/** OAuth mailbox connections started through the API (POST /api/v2/oauth/{provider}/init), polled by id. */
export const oauthSessions = sqliteTable("oauth_sessions", {
  id: pk(),
  workspaceId: workspaceId(),
  userId: text("user_id"),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("pending"), // pending | success | error
  email: text("email"),
  name: text("name"),
  error: text("error"),
  errorDescription: text("error_description"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

/** Web forwarding for sending domains whose website points at this server: visitors go to the main site. */
export const domainForwarding = sqliteTable(
  "domain_forwarding",
  {
    id: pk(),
    workspaceId: workspaceId(),
    domain: text("domain").notNull(),
    forwardingDomain: text("forwarding_domain").notNull(),
    forwardingMode: text("forwarding_mode").notNull().default("redirect"), // redirect | stealth
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("domain_forwarding_domain_uq").on(t.domain)],
);

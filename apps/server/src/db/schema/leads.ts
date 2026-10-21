import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, createdAt, json, pk, ts, updatedAt, workspaceId } from "./_helpers";

export const leadLists = sqliteTable(
  "lead_lists",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    hasEnrichmentTask: bool("has_enrichment_task").default(false),
    ownedBy: text("owned_by"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("lead_lists_ws_idx").on(t.workspaceId)],
);

export const leads = sqliteTable(
  "leads",
  {
    id: pk(),
    workspaceId: workspaceId(),
    campaignId: text("campaign_id"),
    listId: text("list_id"),
    subsequenceId: text("subsequence_id"),
    email: text("email"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    companyName: text("company_name"),
    companyDomain: text("company_domain").notNull().default(""),
    website: text("website"),
    jobTitle: text("job_title"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    location: text("location"),
    /** IANA timezone for "send in each lead's timezone": given, or worked out from location, custom fields or phone. */
    timezone: text("timezone"),
    personalization: text("personalization"),
    payload: json<Record<string, unknown>>("payload"),
    status: integer("status").notNull().default(1),
    interestStatus: integer("lt_interest_status"),
    /** The status came from the person's lead elsewhere (the status sync, or a copy): no conversion of its own. */
    interestSynced: bool("interest_synced").notNull().default(false),
    verificationStatus: integer("verification_status").notNull().default(0),
    espCode: integer("esp_code").notNull().default(0),
    esgCode: integer("esg_code").notNull().default(0),
    enrichmentStatus: integer("enrichment_status"),
    openCount: integer("email_open_count").notNull().default(0),
    replyCount: integer("email_reply_count").notNull().default(0),
    clickCount: integer("email_click_count").notNull().default(0),
    lastStepFrom: text("last_step_from"),
    lastStepId: text("last_step_id"),
    lastStepAt: ts("last_step_timestamp_executed"),
    openedStep: integer("email_opened_step"),
    openedVariant: integer("email_opened_variant"),
    repliedStep: integer("email_replied_step"),
    repliedVariant: integer("email_replied_variant"),
    clickedStep: integer("email_clicked_step"),
    clickedVariant: integer("email_clicked_variant"),
    plValueLead: text("pl_value_lead"),
    assignedTo: text("assigned_to"),
    uploadedByUser: text("uploaded_by_user"),
    uploadMethod: text("upload_method").notNull().default("manual"),
    isWebsiteVisitor: bool("is_website_visitor").default(false),
    // sending state
    nextStep: integer("next_step").notNull().default(0), // index of the next step to send
    nextSendAt: integer("next_send_at"), // epoch ms when the next step is due (null = not scheduled)
    senderAccountId: text("sender_account_id"), // sticky sender for the thread
    threadMessageIds: json<string[]>("thread_message_ids"), // Message-IDs sent to this lead (for In-Reply-To/References)
    lastSubject: text("last_subject"),
    threadId: text("thread_id"),
    subseqNextStep: integer("subseq_next_step").notNull().default(0),
    subseqNextSendAt: integer("subseq_next_send_at"),
    subseqStatus: integer("subseq_status"),
    // timestamps
    lastContactAt: ts("timestamp_last_contact"),
    lastOpenAt: ts("timestamp_last_open"),
    lastReplyAt: ts("timestamp_last_reply"),
    lastClickAt: ts("timestamp_last_click"),
    lastInterestChangeAt: ts("timestamp_last_interest_change"),
    lastTouchAt: ts("timestamp_last_touch"),
    addedSubsequenceAt: ts("timestamp_added_subsequence"),
    completedAt: ts("completed_at"),
    archivedAt: ts("archived_at"),
    /** The verify-on-import run this lead waits for (its import's own), until that run ends. */
    verifyRunId: text("verify_run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("leads_campaign_email_uq").on(t.campaignId, t.email).where(sql`campaign_id is not null and email is not null`),
    uniqueIndex("leads_list_email_uq").on(t.listId, t.email).where(sql`list_id is not null and email is not null`),
    index("leads_ws_email_idx").on(t.workspaceId, t.email),
    index("leads_campaign_status_idx").on(t.campaignId, t.status),
    index("leads_due_idx").on(t.campaignId, t.nextSendAt),
    index("leads_subseq_idx").on(t.subsequenceId, t.subseqNextSendAt),
    index("leads_list_idx").on(t.listId),
    index("leads_ws_interest_idx").on(t.workspaceId, t.interestStatus),
    index("leads_domain_idx").on(t.workspaceId, t.companyDomain),
    // The provider and gateway lookup queue (services/verification.ts).
    index("leads_mail_queue_idx").on(t.updatedAt).where(sql`esp_code = 0`),
    index("leads_verify_run_idx").on(t.verifyRunId).where(sql`verify_run_id is not null`),
  ],
);

export const blockList = sqliteTable(
  "block_list",
  {
    id: pk(),
    workspaceId: workspaceId(),
    value: text("bl_value").notNull(),
    isDomain: bool("is_domain").notNull().default(false),
    source: text("source"), // manual | unsubscribe | api | sheet
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("block_list_ws_value_uq").on(t.workspaceId, t.value)],
);

export const leadLabels = sqliteTable(
  "lead_labels",
  {
    id: pk(),
    workspaceId: workspaceId(),
    label: text("label").notNull(),
    interestStatusLabel: text("interest_status_label").notNull(), // positive | negative | neutral
    interestStatus: integer("interest_status").notNull(),
    description: text("description"),
    useWithAi: bool("use_with_ai").default(false),
    color: text("color"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("lead_labels_ws_status_uq").on(t.workspaceId, t.interestStatus)],
);

export const leadNotes = sqliteTable(
  "lead_notes",
  {
    id: pk(),
    workspaceId: workspaceId(),
    leadId: text("lead_id"),
    leadEmail: text("lead_email"),
    body: text("body").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("lead_notes_lead_idx").on(t.workspaceId, t.leadEmail)],
);

export const unsubscribes = sqliteTable(
  "unsubscribes",
  {
    id: pk(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    campaignId: text("campaign_id"),
    source: text("source").notNull().default("link"), // link | header | reply | manual | broadcast | abuse
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("unsubscribes_ws_email_uq").on(t.workspaceId, t.email)],
);

/**
 * Addresses a workspace keeps not emailing once their leads are gone (deleted, or with their campaign): one that
 * hard-bounced, by every campaign; one that asked a campaign to stop, by that campaign. Whoever unsubscribed from
 * everything is in `unsubscribes`.
 */
export const leadSuppressions = sqliteTable(
  "lead_suppressions",
  {
    id: pk(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    reason: text("reason").notNull(), // bounced | unsubscribed
    /** The campaign an "unsubscribed" is for; "" for a bounce, which holds everywhere. */
    campaignId: text("campaign_id").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("lead_suppressions_uq").on(t.workspaceId, t.email, t.reason, t.campaignId)],
);

/** Lead verification results (single, bulk and list verification). */
export const emailVerifications = sqliteTable(
  "email_verifications",
  {
    id: pk(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    verificationStatus: text("verification_status").notNull().default("pending"), // pending | verified | invalid | risky | catch_all | unknown
    catchAll: text("catch_all"), // "true" | "false" | "pending"
    reason: text("reason"),
    result: json<Record<string, unknown>>("result"),
    creditsUsed: integer("credits_used").notNull().default(0),
    jobId: text("job_id"),
    createdAt: createdAt(),
  },
  (t) => [index("email_verifications_ws_idx").on(t.workspaceId, t.createdAt), index("email_verifications_job_idx").on(t.jobId)],
);

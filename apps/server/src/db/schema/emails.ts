import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, createdAt, json, pk, ts, workspaceId } from "./_helpers";

export interface AddressJson {
  address: string;
  name: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  content_id?: string | null;
}

/** Every email visible in the Unibox: campaign sends, replies, manual sends and scheduled mails. */
export const emails = sqliteTable(
  "emails",
  {
    id: pk(),
    workspaceId: workspaceId(),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    inReplyTo: text("in_reply_to"),
    references: text("references_header"),
    subject: text("subject").notNull().default(""),
    fromAddress: text("from_address_email"),
    fromJson: json<AddressJson[]>("from_address_json"),
    toList: text("to_address_email_list").notNull().default(""),
    toJson: json<AddressJson[]>("to_address_json"),
    ccList: text("cc_address_email_list"),
    ccJson: json<AddressJson[]>("cc_address_json"),
    bccList: text("bcc_address_email_list"),
    replyTo: text("reply_to"),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    contentPreview: text("content_preview"),
    timestampEmail: ts("timestamp_email").notNull(),
    campaignId: text("campaign_id"),
    subsequenceId: text("subsequence_id"),
    listId: text("list_id"),
    leadEmail: text("lead"),
    leadId: text("lead_id"),
    accountId: text("account_id"),
    eaccount: text("eaccount").notNull(),
    ueType: integer("ue_type").notNull(), // 1 campaign sent, 2 received, 3 sent, 4 scheduled
    step: text("step"),
    variant: integer("variant"),
    isUnread: integer("is_unread").notNull().default(0),
    isAutoReply: integer("is_auto_reply").notNull().default(0),
    isBounce: bool("is_bounce").notNull().default(false),
    reminderAt: ts("reminder_ts"),
    aiInterestValue: integer("ai_interest_value"),
    aiAssisted: integer("ai_assisted"),
    isFocused: integer("is_focused").notNull().default(1),
    interestStatus: integer("i_status"),
    attachments: json<{ files: AttachmentMeta[] }>("attachment_json"),
    aiAgentId: text("ai_agent_id"),
    scheduledAt: ts("scheduled_at"),
    sendError: text("send_error"),
    folder: text("folder"),
    imapUid: integer("imap_uid"),
    archived: bool("archived").notNull().default(false),
    /** When a CRM user marked this reply as handled (CRM inbox → archive). */
    crmDoneAt: ts("crm_done_at"),
    /** A received message whose follow-up (stopping the lead, marking a bounce) failed: done when it's read again. */
    retryHandling: bool("retry_handling").notNull().default(false),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("emails_ws_msgid_acct_uq").on(t.workspaceId, t.messageId, t.accountId, t.ueType),
    index("emails_ws_time_idx").on(t.workspaceId, t.timestampEmail),
    index("emails_thread_idx").on(t.workspaceId, t.threadId),
    index("emails_lead_idx").on(t.workspaceId, t.leadEmail),
    index("emails_campaign_idx").on(t.campaignId, t.ueType),
    index("emails_scheduled_idx").on(t.ueType, t.scheduledAt),
    // Due follow-up reminders (services/reminders.ts).
    index("emails_reminder_idx").on(t.reminderAt),
    // Inbox sync looks every message up by its Message-ID (and the emails it answers), in a workspace or by mailbox.
    index("emails_message_idx").on(t.messageId),
  ],
);

/** Analytics events (sent/open/click/reply/bounce/unsubscribe/opportunity...). */
export const emailEvents = sqliteTable(
  "email_events",
  {
    id: pk(),
    workspaceId: workspaceId(),
    type: text("type").notNull(),
    campaignId: text("campaign_id"),
    subsequenceId: text("subsequence_id"),
    leadId: text("lead_id"),
    leadEmail: text("lead_email"),
    accountId: text("account_id"),
    accountEmail: text("account_email"),
    emailId: text("email_id"),
    step: integer("step"),
    variant: integer("variant"),
    url: text("url"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    isFirst: bool("is_first").notNull().default(false),
    value: integer("value"),
    /** Extra detail, e.g. a bounce's status code and the receiving server's reason. */
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [
    index("email_events_ws_time_idx").on(t.workspaceId, t.createdAt),
    index("email_events_campaign_idx").on(t.campaignId, t.type, t.createdAt),
    index("email_events_account_idx").on(t.accountId, t.type, t.createdAt),
    index("email_events_lead_idx").on(t.leadId),
  ],
);

export const emailAttachments = sqliteTable(
  "email_attachments",
  {
    id: pk(),
    workspaceId: workspaceId(),
    emailId: text("email_id"),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    storagePath: text("storage_path").notNull(),
    contentId: text("content_id"),
    createdAt: createdAt(),
  },
  (t) => [index("email_attachments_email_idx").on(t.emailId)],
);

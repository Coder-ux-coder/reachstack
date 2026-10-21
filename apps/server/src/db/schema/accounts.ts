import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AccountWarmupConfig, DomainRecords } from "@reachstack/shared";
import { bool, createdAt, json, pk, ts, updatedAt, workspaceId } from "./_helpers";

export interface ServerConfig {
  host: string;
  port: number;
  secure: boolean; // implicit TLS
  user: string;
}

export interface MailFolders {
  inbox: string;
  spam: string | null;
  sent: string | null;
  trash: string | null;
  archive: string | null;
  important?: string | null;
  /** Gmail's All Mail (null when the mailbox has none; missing until first looked for). */
  all?: string | null;
  /** When inbox sync last read the folder list (epoch ms). */
  checked_at?: number;
}

export const emailAccounts = sqliteTable(
  "email_accounts",
  {
    id: pk(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    providerCode: integer("provider_code").notNull().default(1),
    imap: json<ServerConfig>("imap"),
    imapPasswordEnc: text("imap_password_enc"),
    smtp: json<ServerConfig>("smtp"),
    smtpPasswordEnc: text("smtp_password_enc"),
    oauthEnc: text("oauth_enc"), // encrypted {access_token, refresh_token, expires_at, scope}
    status: integer("status").notNull().default(1),
    statusMessage: json<Record<string, unknown>>("status_message"),
    warmupStatus: integer("warmup_status").notNull().default(0),
    warmup: json<AccountWarmupConfig>("warmup"),
    warmupScore: real("warmup_score"),
    warmupStartedAt: ts("warmup_started_at"),
    dailyLimit: integer("daily_limit").default(30),
    sendingGap: integer("sending_gap").notNull().default(10), // minutes
    signature: text("signature"),
    replyTo: text("reply_to"),
    trackingDomainName: text("tracking_domain_name"),
    trackingDomainStatus: text("tracking_domain_status"),
    enableSlowRamp: bool("enable_slow_ramp").default(false),
    isManaged: bool("is_managed").notNull().default(false),
    setupPending: bool("setup_pending").notNull().default(false),
    isSeed: bool("is_seed").notNull().default(false),
    inboxPlacementTestLimit: integer("inbox_placement_test_limit"),
    folders: json<MailFolders>("folders"),
    syncState: json<Record<string, { uidValidity: string; lastUid: number }>>("sync_state"),
    lastSyncAt: ts("last_sync_at"),
    /** When inbox sync first saw mail to this address arrive: proof the address is this mailbox's (see addressConfirmed). */
    addressSeenAt: ts("address_seen_at"),
    lastSentAt: ts("last_sent_at"),
    lastErrorAt: ts("last_error_at"),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    /** Campaign sending paused until this time (warmup keeps running), e.g. by the Deliverability Agent. */
    campaignPauseUntil: ts("campaign_pause_until"),
    autofixFailed: bool("autofix_failed"),
    dfyOrderId: text("dfy_order_id"),
    addedBy: text("added_by"),
    modifiedBy: text("modified_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("email_accounts_ws_email_uq").on(t.workspaceId, t.email),
    index("email_accounts_email_idx").on(t.email),
    index("email_accounts_warmup_idx").on(t.warmupStatus),
  ],
);

export const accountDailyStats = sqliteTable(
  "account_daily_stats",
  {
    id: pk(),
    workspaceId: workspaceId(),
    accountId: text("account_id").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD on the workspace clock (rows written before 2026-10-15 used UTC)
    sent: integer("sent").notNull().default(0),
    warmupSent: integer("warmup_sent").notNull().default(0),
    warmupReceived: integer("warmup_received").notNull().default(0),
    warmupInbox: integer("warmup_inbox").notNull().default(0),
    warmupSpam: integer("warmup_spam").notNull().default(0),
    warmupCategory: integer("warmup_category").notNull().default(0),
    warmupSavedFromSpam: integer("warmup_saved_from_spam").notNull().default(0),
    warmupReplied: integer("warmup_replied").notNull().default(0),
    bounced: integer("bounced").notNull().default(0),
    /** Campaign emails the receiving server refused when they were sent: never sent (not in `sent`), yet tried. */
    refused: integer("refused").notNull().default(0),
    replies: integer("replies").notNull().default(0),
    /** Campaign and warmup sends from this mailbox that failed on its side (not recipient bounces). */
    sendErrors: integer("send_errors").notNull().default(0),
  },
  (t) => [uniqueIndex("account_daily_stats_uq").on(t.accountId, t.date), index("account_daily_stats_ws_idx").on(t.workspaceId, t.date)],
);

/** The latest DNS check of a sending domain (services/domain-dns.ts), one row per workspace and domain. */
export const domainChecks = sqliteTable(
  "domain_checks",
  {
    id: pk(),
    workspaceId: workspaceId(),
    domain: text("domain").notNull(),
    mx: bool("mx").notNull(),
    spf: bool("spf").notNull(),
    dkim: bool("dkim").notNull(),
    dmarc: bool("dmarc").notNull(),
    /** Records whose lookup failed: neither found nor missing. */
    indeterminate: json<string[]>("indeterminate").notNull(),
    details: json<DomainRecords>("details").notNull(),
    checkedAt: ts("checked_at").notNull(),
  },
  (t) => [uniqueIndex("domain_checks_ws_domain_uq").on(t.workspaceId, t.domain)],
);

export const warmupMessages = sqliteTable(
  "warmup_messages",
  {
    id: pk(),
    senderAccountId: text("sender_account_id").notNull(),
    recipientAccountId: text("recipient_account_id").notNull(),
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    subject: text("subject").notNull(),
    tag: text("tag").notNull(),
    isReply: bool("is_reply").notNull().default(false),
    sentAt: ts("sent_at").notNull(),
    deliveredAt: ts("delivered_at"),
    folder: text("folder"), // inbox | spam | category | missing
    savedFromSpam: bool("saved_from_spam").notNull().default(false),
    opened: bool("opened").notNull().default(false),
    important: bool("important").notNull().default(false),
    replied: bool("replied").notNull().default(false),
    replyDueAt: ts("reply_due_at"),
    processedAt: ts("processed_at"),
  },
  (t) => [
    uniqueIndex("warmup_messages_mid_uq").on(t.messageId),
    index("warmup_messages_recipient_idx").on(t.recipientAccountId, t.processedAt),
    index("warmup_messages_sender_idx").on(t.senderAccountId, t.sentAt),
    index("warmup_messages_reply_due_idx").on(t.replyDueAt),
  ],
);

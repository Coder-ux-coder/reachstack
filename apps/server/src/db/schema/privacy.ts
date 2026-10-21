// The installation's privacy center. Requests from people in the Lead Finder data live in `privacy_requests`
// (auth.ts); these tables hold the addresses that must stay out of that data (and, after an abuse report, out of
// every campaign) and the abuse reports about sent emails.
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, createdAt, pk, ts } from "./_helpers";

export type SuppressionReason = "opt_out" | "removal" | "abuse";

/** Addresses and profiles that never come back into the Lead Finder data. With block_sending, no campaign emails them either. */
export const privacySuppressions = sqliteTable(
  "privacy_suppressions",
  {
    id: pk(),
    /** "email" or "linkedin". */
    type: text("type").notNull(),
    value: text("value").notNull(),
    reason: text("reason").$type<SuppressionReason>().notNull(),
    blockSending: bool("block_sending").notNull().default(false),
    requestId: text("request_id"),
    abuseReportId: text("abuse_report_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("privacy_suppressions_uq").on(t.type, t.value)],
);

export const abuseReports = sqliteTable(
  "abuse_reports",
  {
    id: pk(),
    emailId: text("email_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    campaignId: text("campaign_id"),
    accountEmail: text("account_email"),
    leadEmail: text("lead_email").notNull(),
    subject: text("subject"),
    status: text("status").$type<"open" | "reviewed">().notNull().default("open"),
    note: text("note"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: ts("reviewed_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("abuse_reports_email_uq").on(t.emailId), index("abuse_reports_ws_idx").on(t.workspaceId, t.createdAt)],
);

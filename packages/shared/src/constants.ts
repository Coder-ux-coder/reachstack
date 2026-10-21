// Numeric codes follow the public v2 API's enums, so existing API clients keep working.

export const CampaignStatus = {
  ACCOUNT_SUSPENDED: -99,
  ACCOUNTS_UNHEALTHY: -1,
  BOUNCE_PROTECT: -2,
  DRAFT: 0,
  ACTIVE: 1,
  PAUSED: 2,
  COMPLETED: 3,
  RUNNING_SUBSEQUENCES: 4,
} as const;
export type CampaignStatusCode = (typeof CampaignStatus)[keyof typeof CampaignStatus];

export const CAMPAIGN_STATUS_LABELS: Record<number, string> = {
  [-99]: "Account suspended",
  [-1]: "Accounts unhealthy",
  [-2]: "Bounce protect",
  0: "Draft",
  1: "Active",
  2: "Paused",
  3: "Completed",
  4: "Running subsequences",
};

export const CampaignNotSendingStatus = {
  OUTSIDE_SCHEDULE: 1,
  WAITING_FOR_LEAD: 2,
  CAMPAIGN_DAILY_LIMIT: 3,
  ACCOUNTS_DAILY_LIMIT: 4,
  PLAN_LIMIT: 5,
  EMPTY_STEP: 6,
  /** No sending accounts are attached to the campaign. */
  NO_ACCOUNTS: 7,
  /** Accounts are attached, but every one has an error, is paused or is resting (campaign sending paused). */
  ACCOUNTS_UNAVAILABLE: 8,
  /** Set by the send watchdog: leads are due and mailboxes are free, yet nothing went out for much longer than usual. */
  STALLED: 9,
  /** Set by the send watchdog: the leads that are due all wait for email verification to finish. */
  VERIFYING: 10,
  ERROR: 99,
} as const;

export const NOT_SENDING_LABELS: Record<number, string> = {
  1: "Outside of the sending schedule",
  2: "Waiting for a lead to become due",
  3: "Campaign daily limit reached",
  4: "All sending accounts reached their daily limit",
  5: "The plan's monthly email limit is reached or the trial has ended",
  6: "A step in the sequence has no email it can send",
  7: "No sending accounts are attached",
  8: "Every sending account has an error, is paused or is resting",
  9: "Nothing has gone out for a while, though leads are due and mailboxes are free",
  10: "Waiting for email verification to finish",
  99: "Not sending because of an error",
};

/** A few words for lists (the full sentence is in NOT_SENDING_LABELS). */
export const NOT_SENDING_SHORT: Record<number, string> = {
  1: "Outside schedule",
  2: "No leads due yet",
  3: "Daily limit reached",
  4: "Mailboxes at daily limit",
  5: "Plan limit reached",
  6: "A step has no email",
  7: "No sending accounts",
  8: "Mailboxes unavailable",
  9: "Stalled",
  10: "Verifying leads",
  99: "Sending error",
};

/** Reasons that need someone to act; the others clear up by themselves (schedule, limits, leads coming due). */
export const NOT_SENDING_NEEDS_ATTENTION: ReadonlySet<number> = new Set([5, 6, 7, 8, 9, 10, 99]);

export const LeadStatus = {
  ACTIVE: 1,
  PAUSED: 2,
  COMPLETED: 3,
  BOUNCED: -1,
  UNSUBSCRIBED: -2,
  SKIPPED: -3,
} as const;

/** The most leads one import takes (a file, a sheet or pasted addresses); a bigger file goes in as more than one. */
export const LEAD_IMPORT_MAX = 200_000;

/** Lead fields that can be set for many leads at once (select leads → Edit), by API name, with their labels. */
export const LEAD_EDIT_FIELDS = [
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "company_name", label: "Company" },
  { value: "job_title", label: "Job title" },
  { value: "website", label: "Website" },
  { value: "phone", label: "Phone" },
  { value: "linkedin_url", label: "LinkedIn" },
  { value: "location", label: "Location" },
  { value: "timezone", label: "Timezone" },
  { value: "personalization", label: "Personalization" },
] as const;
export type LeadEditField = (typeof LEAD_EDIT_FIELDS)[number]["value"];

const FIELD_NAMES = new Set(["email", "company_domain", ...LEAD_EDIT_FIELDS.map((f) => f.value)].map((n) => n.replace(/_/g, "")));

/** Custom variables the app itself reads, which can't be renamed, deleted or edited in bulk, with what they're for. */
export const APP_VARIABLES: Readonly<Record<string, string>> = {
  lf_person_id: "Lead Finder uses it to leave out people you already have.",
};

/**
 * True for a name a custom variable can't take: one of the lead's own fields, as the API writes it (first_name) or as
 * emails do ({{firstName}}), whatever the case. In an email the lead's field would show instead.
 */
export function isLeadFieldName(name: string): boolean {
  return FIELD_NAMES.has(name.trim().toLowerCase().replace(/_/g, ""));
}

export const LEAD_STATUS_LABELS: Record<number, string> = {
  1: "Active",
  2: "Paused",
  3: "Completed",
  [-1]: "Bounced",
  [-2]: "Unsubscribed",
  [-3]: "Skipped",
};

export const InterestStatus = {
  OUT_OF_OFFICE: 0,
  INTERESTED: 1,
  MEETING_BOOKED: 2,
  MEETING_COMPLETED: 3,
  WON: 4,
  NOT_INTERESTED: -1,
  WRONG_PERSON: -2,
  LOST: -3,
  NO_SHOW: -4,
} as const;

export interface InterestStatusMeta {
  code: number;
  label: string;
  sentiment: "positive" | "negative" | "neutral";
  color: string;
}

export const DEFAULT_INTEREST_STATUSES: InterestStatusMeta[] = [
  { code: 1, label: "Interested", sentiment: "positive", color: "#16a34a" },
  { code: 2, label: "Meeting booked", sentiment: "positive", color: "#2563eb" },
  { code: 3, label: "Meeting completed", sentiment: "positive", color: "#7c3aed" },
  { code: 4, label: "Won", sentiment: "positive", color: "#ca8a04" },
  { code: 0, label: "Out of office", sentiment: "neutral", color: "#64748b" },
  { code: -1, label: "Not interested", sentiment: "negative", color: "#dc2626" },
  { code: -2, label: "Wrong person", sentiment: "negative", color: "#ea580c" },
  { code: -3, label: "Lost", sentiment: "negative", color: "#9f1239" },
  { code: -4, label: "No show", sentiment: "negative", color: "#b45309" },
];

export const INTEREST_STATUS_LABELS: Record<number, string> = Object.fromEntries(
  DEFAULT_INTEREST_STATUSES.map((s) => [s.code, s.label]),
);

/** Custom lead labels get interest codes starting here (positive/negative/neutral ranges). */
export const CUSTOM_INTEREST_BASE = { positive: 1000, neutral: 50000, negative: -1000 } as const;

export function interestSentiment(code: number | null | undefined): "positive" | "negative" | "neutral" | null {
  if (code === null || code === undefined) return null;
  if (code === 0) return "neutral";
  if (code >= CUSTOM_INTEREST_BASE.neutral) return "neutral";
  if (code > 0) return "positive";
  return "negative";
}

export const VerificationStatus = {
  NOT_VERIFIED: 0,
  VERIFIED: 1,
  PENDING: 11,
  PENDING_JOB: 12,
  INVALID: -1,
  RISKY: -2,
  CATCH_ALL: -3,
  JOB_CHANGE: -4,
} as const;

export const VERIFICATION_STATUS_LABELS: Record<number, string> = {
  0: "Not verified",
  1: "Valid",
  11: "Pending",
  12: "Pending verification job",
  [-1]: "Invalid",
  [-2]: "Risky",
  [-3]: "Catch-all",
  [-4]: "Job change",
};

export const EspCode = {
  IN_QUEUE: 0,
  GOOGLE: 1,
  MICROSOFT: 2,
  ZOHO: 3,
  AIRMAIL: 8,
  YAHOO: 9,
  YANDEX: 10,
  WEBDE: 12,
  LIBERO: 13,
  OTHER: 999,
  NOT_FOUND: 1000,
} as const;

export const ESP_LABELS: Record<number, string> = {
  0: "In queue",
  1: "Google",
  2: "Microsoft",
  3: "Zoho",
  8: "AirMail",
  9: "Yahoo",
  10: "Yandex",
  12: "Web.de",
  13: "Libero.it",
  999: "Other",
  1000: "Not found",
};

/**
 * Email security gateway in front of a lead's mailbox, read from its domain's MX records. 1–4 are the original API's
 * codes; the rest start at 101 so a code added upstream can't mean something else here. NONE: checked, none found.
 */
export const EsgCode = {
  IN_QUEUE: 0,
  BARRACUDA: 1,
  MIMECAST: 2,
  PROOFPOINT: 3,
  CISCO: 4,
  SOPHOS: 101,
  TREND_MICRO: 102,
  BROADCOM: 103,
  FORCEPOINT: 104,
  HORNETSECURITY: 105,
  CLOUDFLARE: 106,
  NONE: 999,
} as const;

export const ESG_LABELS: Record<number, string> = {
  0: "In queue",
  1: "Barracuda",
  2: "Mimecast",
  3: "Proofpoint",
  4: "Cisco",
  101: "Sophos",
  102: "Trend Micro",
  103: "Broadcom (Symantec)",
  104: "Forcepoint",
  105: "Hornetsecurity",
  106: "Cloudflare",
  999: "None",
};

export const EnrichmentStatus = { ENRICHED: 1, PENDING: 11, NOT_AVAILABLE: -1, ERROR: -2 } as const;

export const AccountStatus = {
  ACTIVE: 1,
  PAUSED: 2,
  MAINTENANCE: 3,
  CONNECTION_ERROR: -1,
  SOFT_BOUNCE_ERROR: -2,
  SENDING_ERROR: -3,
} as const;

export const ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1: "Active",
  2: "Paused",
  3: "Maintenance",
  [-1]: "Connection error",
  [-2]: "Soft bounce error",
  [-3]: "Sending error",
};

export const WarmupStatus = {
  PAUSED: 0,
  ACTIVE: 1,
  BANNED: -1,
  SPAM_FOLDER_UNKNOWN: -2,
  PERMANENT_SUSPENSION: -3,
} as const;

export const WARMUP_STATUS_LABELS: Record<number, string> = {
  0: "Paused",
  1: "Active",
  [-1]: "Banned",
  [-2]: "Spam folder unknown",
  [-3]: "Permanently suspended",
};

export const ProviderCode = {
  CUSTOM: 1,
  GOOGLE: 2,
  MICROSOFT: 3,
  AWS: 4,
  AIRMAIL: 8,
  AIRMAIL_INSTANT: 11,
  /** Local test mailbox: mail stays inside this installation (demo/testing, not part of the public API enum). */
  SANDBOX: 99,
} as const;

export const PROVIDER_LABELS: Record<number, string> = {
  1: "IMAP / SMTP",
  2: "Google",
  3: "Microsoft",
  4: "Amazon SES",
  8: "Managed",
  11: "Managed (instant)",
  99: "Sandbox (test mailbox)",
};

/** Email.ue_type */
export const EmailType = {
  CAMPAIGN_SENT: 1,
  RECEIVED: 2,
  SENT: 3,
  SCHEDULED: 4,
} as const;

export const AIAgentType = {
  INBOX_MANAGER: 1,
  SALES_AGENT: 2,
  DELIVERABILITY: 3,
  AFFILIATE: 4,
  LEAD_FINDER: 6,
  RECRUITING: 7,
  INVESTMENT: 8,
  USER_RESEARCH: 9,
  PARTNERSHIP: 10,
  VOICE: 11,
} as const;

export const AI_AGENT_TYPE_LABELS: Record<number, string> = {
  1: "Reply agent",
  2: "Sales agent",
  3: "Deliverability agent",
  4: "Affiliate agent",
  6: "Lead finder agent",
  7: "Recruiting agent",
  8: "Investment agent",
  9: "User research agent",
  10: "Partnership agent",
  11: "Voice agent",
};

export const AIAgentStatus = { ERROR: -1, PAUSED: 0, ACTIVE: 1 } as const;

/** Subsequence trigger: lead activity codes. */
export const SubsequenceActivity = {
  EMAIL_OPENED: 2,
  LINK_CLICKED: 4,
  COMPLETED_WITHOUT_REPLY: 91,
} as const;

export const AUDIT_ACTIVITY_LABELS: Record<number, string> = {
  1: "User login",
  2: "Lead deletion",
  3: "Campaign deletion",
  4: "Campaign launch",
  5: "Campaign pause",
  6: "Account addition",
  7: "Account deletion",
  8: "Lead moved",
  9: "Lead added",
  10: "Lead merged",
  11: "Campaign update",
  12: "Subsequence update",
  18: "Webhook created",
  19: "Webhook updated",
  20: "Webhook marked as error",
  21: "Webhook resumed",
  22: "TOTP enrollment started",
  23: "TOTP enabled",
  24: "TOTP replacement started",
  25: "TOTP replaced",
  26: "TOTP disabled",
  27: "MFA recovery codes generated",
  28: "MFA recovery code used",
  29: "MFA login challenge failed",
  30: "MFA login challenge failed too many times",
  31: "MFA login succeeded",
  32: "Subscriber import started",
  33: "Subscriber import cancelled",
  34: "Lead exported",
  35: "Lead finder enrichment created",
  36: "Account update",
  37: "API key created",
  38: "API key deleted",
  40: "Domain forwarding updated",
  41: "Voice agent phone number added",
  42: "Voice agent phone number updated",
  43: "Voice agent phone number deleted",
  44: "Number added to do-not-call list",
  45: "Number removed from do-not-call list",
  46: "Email preference updated",
  // Codes from 100 up are this product's own additions.
  100: "Subscription cancellation requested",
  101: "Conversations exported",
  102: "Leads edited",
  103: "Custom variable renamed",
  104: "Custom variable deleted",
};

export const AuditActivity = {
  USER_LOGIN: 1,
  LEAD_DELETION: 2,
  CAMPAIGN_DELETION: 3,
  CAMPAIGN_LAUNCH: 4,
  CAMPAIGN_PAUSE: 5,
  ACCOUNT_ADDITION: 6,
  ACCOUNT_DELETION: 7,
  LEAD_MOVED: 8,
  LEAD_ADDED: 9,
  LEAD_MERGED: 10,
  CAMPAIGN_UPDATE: 11,
  SUBSEQUENCE_UPDATE: 12,
  WEBHOOK_CREATED: 18,
  WEBHOOK_UPDATED: 19,
  WEBHOOK_ERROR: 20,
  WEBHOOK_RESUMED: 21,
  TOTP_ENROLL_STARTED: 22,
  TOTP_ENABLED: 23,
  TOTP_DISABLED: 26,
  MFA_RECOVERY_GENERATED: 27,
  MFA_RECOVERY_USED: 28,
  MFA_CHALLENGE_FAILED: 29,
  MFA_LOGIN_SUCCEEDED: 31,
  LEAD_EXPORTED: 34,
  ENRICHMENT_CREATED: 35,
  ACCOUNT_UPDATE: 36,
  API_KEY_CREATED: 37,
  API_KEY_DELETED: 38,
  DOMAIN_FORWARDING_UPDATED: 40,
  SUBSCRIPTION_CANCEL_REQUESTED: 100,
  /** Unibox conversations downloaded as CSV or .mbox. */
  UNIBOX_EXPORTED: 101,
  /** One field set or cleared for many leads at once. */
  LEAD_EDITED: 102,
  /** A custom variable renamed (or merged into another) on every lead, and in the emails that use it. */
  VARIABLE_RENAMED: 103,
  /** A custom variable removed from every lead. */
  VARIABLE_DELETED: 104,
} as const;

export const BACKGROUND_JOB_TYPES = [
  "move-leads",
  "import-leads",
  "export-leads",
  "update-warmup-accounts",
  "rename-variable",
  "delete-variable",
  "verify-leads",
  "enrich-leads",
  "delete-leads",
  "edit-leads",
  "lead-finder-import",
] as const;
export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number];

export const BACKGROUND_JOB_STATUSES = [
  "pending",
  "in-progress",
  "success",
  "failed",
  "draining",
  "paused",
  "cancelled",
] as const;
export type BackgroundJobStatus = (typeof BACKGROUND_JOB_STATUSES)[number];

/** Analytics event kinds recorded per lead/email. */
export const EVENT_TYPES = [
  "sent",
  "open",
  "click",
  "reply",
  "auto_reply",
  "bounce",
  "unsubscribe",
  "opportunity",
  "interest_change",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const CRM_TASK_TYPES = ["todo", "call", "email", "linkedin", "sms", "meeting"] as const;
export type CrmTaskType = (typeof CRM_TASK_TYPES)[number];

export const CUSTOM_TAG_RESOURCE = { ACCOUNT: 1, CAMPAIGN: 2, WORKSPACE: 3 } as const;

export const ENRICHMENT_TYPES = [
  "work_email_enrichment",
  "fully_enriched_profile",
  "email_verification",
  "joblisting",
  "technologies",
  "news",
  "funding",
  "engagement_score",
  "ai_enrichment",
  "custom_flow",
] as const;
export type EnrichmentType = (typeof ENRICHMENT_TYPES)[number];

export const INBOX_PLACEMENT = {
  TYPE_ONE_TIME: 1,
  TYPE_AUTOMATED: 2,
  SENDING_FROM_APP: 1,
  SENDING_EXTERNAL: 2,
  STATUS_ACTIVE: 1,
  STATUS_PAUSED: 2,
  STATUS_COMPLETED: 3,
  DELIVERY_ONE_BY_ONE: 1,
  DELIVERY_ALL_TOGETHER: 2,
} as const;

export const MS_PER = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

export type DelayUnit = "minutes" | "hours" | "days";

export function delayToMs(value: number | null | undefined, unit: DelayUnit | null | undefined): number {
  const v = Number(value ?? 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  switch (unit ?? "days") {
    case "minutes":
      return v * MS_PER.minute;
    case "hours":
      return v * MS_PER.hour;
    default:
      return v * MS_PER.day;
  }
}

/** Common free-mail domains — used for ESP guessing, "company" grouping and lead scoring. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "web.de",
  "yandex.com",
  "yandex.ru",
  "mail.com",
  "zoho.com",
  "libero.it",
]);

export function domainOf(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

/** Reserved top-level domains (RFC 2606/6761) that never have real mail servers. */
export function isReservedDomain(domain: string): boolean {
  return /\.(test|example|invalid|localhost)$/i.test(domain);
}

/** A workspace's timezone until one is chosen in Settings → Preferences. */
export const DEFAULT_WORKSPACE_TIMEZONE = "America/New_York";

export function isValidEmailSyntax(email: string): boolean {
  if (!email || email.length > 254) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
    email.trim(),
  );
}

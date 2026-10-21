export const WEBHOOK_EVENT_TYPES = [
  "all_events",
  "email_sent",
  "email_opened",
  "email_link_clicked",
  "reply_received",
  "auto_reply_received",
  "email_bounced",
  "lead_unsubscribed",
  "campaign_completed",
  "account_error",
  "lead_neutral",
  "lead_interested",
  "lead_not_interested",
  "lead_meeting_booked",
  "lead_meeting_completed",
  "lead_closed",
  "lead_out_of_office",
  "lead_wrong_person",
  "lead_no_show",
  "supersearch_enrichment_completed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  all_events: "All events",
  email_sent: "Email sent",
  email_opened: "Email opened",
  email_link_clicked: "Link clicked",
  reply_received: "Reply received",
  auto_reply_received: "Auto-reply received",
  email_bounced: "Email bounced",
  lead_unsubscribed: "Lead unsubscribed",
  campaign_completed: "Campaign completed",
  account_error: "Account error",
  lead_neutral: "Lead marked neutral",
  lead_interested: "Lead interested",
  lead_not_interested: "Lead not interested",
  lead_meeting_booked: "Meeting booked",
  lead_meeting_completed: "Meeting completed",
  lead_closed: "Lead closed (won)",
  lead_out_of_office: "Lead out of office",
  lead_wrong_person: "Wrong person",
  lead_no_show: "No show",
  supersearch_enrichment_completed: "Lead finder enrichment completed",
};

/** Interest status code → webhook event for built-in statuses. */
export const INTEREST_WEBHOOK_EVENT: Record<number, WebhookEventType> = {
  1: "lead_interested",
  2: "lead_meeting_booked",
  3: "lead_meeting_completed",
  4: "lead_closed",
  0: "lead_out_of_office",
  [-1]: "lead_not_interested",
  [-2]: "lead_wrong_person",
  [-4]: "lead_no_show",
};

export interface WebhookPayload {
  timestamp: string;
  event_type: WebhookEventType | string;
  workspace: string;
  campaign_id?: string | null;
  campaign_name?: string | null;
  lead_email?: string | null;
  email_account?: string | null;
  unibox_url?: string | null;
  step?: number | null;
  variant?: number | null;
  is_first?: boolean;
  email_id?: string | null;
  email_subject?: string | null;
  email_text?: string | null;
  email_html?: string | null;
  reply_text_snippet?: string | null;
  reply_subject?: string | null;
  reply_text?: string | null;
  reply_html?: string | null;
  link?: string | null;
  [key: string]: unknown;
}

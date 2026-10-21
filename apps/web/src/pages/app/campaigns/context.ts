import { useOutletContext } from "react-router";
import type { Campaign } from "@/lib/types";
import type { SaveEdits } from "@/lib/unsaved";

export type CampaignDetail = Campaign & {
  tags?: string[];
  timestamp_last_send?: string | null;
  custom_variables?: Record<string, unknown> | null;
  /** Only while bounce protection has paused the campaign: its emails and hard bounces in the week up to when it stopped. */
  bounce_stats?: { sent: number; bounced: number; rate: number };
  /** After a resume from a bounce pause, protection waits until this time. */
  bounce_grace_until?: string | null;
};

/** Unsaved edits in the open tab, and how to save them. */
export interface PendingEdits {
  /** What they're edits to, for the Launch button: "sequence", "schedule" or "options". */
  what: string;
  save: SaveEdits;
}

export interface CampaignContext {
  campaign: CampaignDetail;
  /** PATCHes the campaign and refreshes the cached copy. */
  save: (patch: Record<string, unknown>) => Promise<CampaignDetail>;
  /** True when the member can't edit campaigns. */
  readOnly: boolean;
  /** The open tab reports its unsaved edits here (null once there are none), so Launch saves them first. */
  setPending: (pending: PendingEdits | null) => void;
}

export const useCampaign = () => useOutletContext<CampaignContext>();

export interface SendingStatus {
  diagnostics: {
    status: number;
    not_sending_status: number | null;
    not_sending_reason: string | null;
    schedule_open: boolean;
    next_schedule_opening: string | null;
    timezone: string;
    /** The windows are on each lead's own clock (the timezone is for leads it can't place). */
    lead_timezone?: boolean;
    daily_limit: number | null;
    sent_today: number;
    accounts: { total: number; healthy: number; with_capacity: number; items: Array<{ email: string; status: number; daily_limit: number; sent_today: number }> };
    leads: { active: number; due_now: number; waiting_for_tasks?: number; completed: number; next_due_at: string | null };
    last_send_at: string | null;
  };
  /** waiting_for_tasks: not sending only because the leads left wait for task steps done by hand (on Today). */
  summary: { is_sending: boolean; waiting_for_tasks?: boolean; title: string; reasons: string[] };
}

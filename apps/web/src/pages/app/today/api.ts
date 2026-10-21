// The Today report (GET /api/app/today, services/today.ts on the server) and its query, shared by the Today page
// and the summary on Home.
import { get } from "@/lib/api";

export type HoldReason =
  | "not_running"
  | "plan"
  | "schedule"
  | "no_mailboxes"
  | "mailboxes_unavailable"
  | "new_lead_limit"
  | "campaign_limit"
  | "ramp_up"
  | "mailbox_limits"
  | "sending_gap";

export interface Flow {
  id: string;
  kind: "campaign" | "subsequence";
  campaign_id: string;
  name: string;
  campaign_name: string;
  status: number;
  running: boolean;
  sent_today: number;
  due_today: number;
  due_now: number;
  more_today: number;
  daily_limit: number | null;
  next_due_at: string | null;
  window: { open_now: boolean; minutes_left: number; next_open_at: string | null };
  mailboxes: { attached: number; usable: number };
  held: Array<{ reason: HoldReason; emails: number; text: string }>;
  problem: string | null;
}

export interface Mailbox {
  id: string;
  email: string;
  status: number;
  usable: boolean;
  note: string | null;
  sent_today: number;
  limit_today: number;
  more_today: number;
  warmup: { on: boolean; sent: number; target: number };
  last_sent_at: string | null;
  resting_until: string | null;
  campaigns: number;
}

export interface TodayReport {
  now: string;
  day: string;
  timezone: string;
  resets_at: string;
  sent: number;
  more: number;
  due: number;
  wont_fit: number;
  waiting_in_stopped: number;
  next_due_at: string | null;
  capacity: { mailboxes: number; usable: number; limit: number; sent: number; left: number };
  bottleneck: { reason: HoldReason | "idle" | "no_leads" | "on_track"; title: string; detail: string; link: { label: string; to: string } | null };
  flows: Flow[];
  mailboxes: Mailbox[] | null;
  forecast: Array<{ date: string; due: number; sends: number; capacity: number }>;
}

export const todayQuery = { queryKey: ["today"], queryFn: () => get<TodayReport>("/api/app/today"), refetchInterval: 60_000 };

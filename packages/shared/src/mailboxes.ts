// Mailbox rules the server enforces and the app explains: the warmup and campaign ramps, warmup hours, resting, and the
// health score built from what a mailbox's emails actually did.
import type { AccountWarmupConfig } from "./types";

// ---------- Warmup ramp ----------

/** Warmup emails on the first day of a ramp (or the limit, when that's lower). */
export const WARMUP_START = 2;
/** The "Recommended" increase reaches the limit in about this many days, adding 1 to 4 emails a day. */
export const WARMUP_RECOMMENDED_DAYS = 14;
/** Real mailboxes spread each day's warmup over these hours on the workspace clock. */
export const WARMUP_HOURS = { from: 6, to: 22 } as const;

type RampSettings = Pick<AccountWarmupConfig, "limit" | "increment">;

const warmupLimit = (w: Pick<AccountWarmupConfig, "limit">) => Math.max(0, Math.round(w.limit ?? 10));

/** Warmup emails added per day, or null when the ramp is off (the full limit from the first day). */
export function warmupIncrease(w: RampSettings): number | null {
  if (!w.increment || w.increment === "disabled") return null;
  if (w.increment === "0") return Math.min(4, Math.max(1, Math.ceil((warmupLimit(w) - WARMUP_START) / WARMUP_RECOMMENDED_DAYS)));
  return Math.min(4, Math.max(1, Math.round(Number(w.increment)) || 1));
}

/** Today's warmup target after `daysWarmed` earlier days of warmup: WARMUP_START plus the daily increase, up to the limit. */
export function warmupTarget(w: RampSettings, daysWarmed: number): number {
  const limit = warmupLimit(w);
  const inc = warmupIncrease(w);
  if (inc === null) return limit;
  return Math.min(limit, WARMUP_START + inc * Math.max(0, Math.floor(daysWarmed)));
}

/** Days of warmup before the daily target reaches the limit (0 when it starts there). */
export function warmupRampDays(w: RampSettings): number {
  const inc = warmupIncrease(w);
  const limit = warmupLimit(w);
  if (inc === null || limit <= WARMUP_START) return 0;
  return Math.ceil((limit - WARMUP_START) / inc);
}

// ---------- Campaign slow ramp ----------

/** Mailbox slow ramp: campaign emails on the first sending day, and how many more each day after that. */
export const SLOW_RAMP = { start: 10, step: 10 } as const;

/** Today's campaign limit with slow ramp on, `rampDay` days after the mailbox's first campaign email. */
export function slowRampLimit(limit: number, rampDay: number): number {
  return Math.min(limit, SLOW_RAMP.start + SLOW_RAMP.step * Math.max(0, Math.floor(rampDay)));
}

// ---------- Resting ----------

/** How long "Rest this mailbox" can keep campaigns away (warmup keeps running meanwhile). */
export const REST_DAYS = [3, 7, 14, 30] as const;

// ---------- Health ----------

/** Health looks at this many days, ending today on the workspace clock. */
export const HEALTH_WINDOW_DAYS = 14;
/** Below these volumes a signal is too thin to judge. */
export const HEALTH_MIN = { bounce: 20, reply: 50, sends: 20, placement: 5 } as const;

/** What a mailbox did over a period (campaign and warmup counters). */
export interface HealthCounts {
  sent: number;
  bounced: number;
  /** Campaign emails the receiving server refused when they were sent: not in `sent`, yet tried (and bounced). */
  refused: number;
  replies: number;
  sendErrors: number;
  warmupSent: number;
  warmupInbox: number;
  warmupSpam: number;
}

export type HealthStatus = "healthy" | "fair" | "at_risk" | "unknown";

export const HEALTH_STATUS_LABELS: Record<HealthStatus, string> = { healthy: "Healthy", fair: "Fair", at_risk: "At risk", unknown: "Not enough data" };

/** What a sending domain publishes in DNS (lib/dns.ts checkDomainAuth). */
export interface DomainRecords {
  mx: string[];
  spf: string | null;
  dmarc: string | null;
  dkim_selector: string | null;
  /** Where the DMARC record is, when it isn't at the domain itself: its organization's domain, which covers it. */
  dmarc_domain?: string;
  /** Why a record that's there doesn't count (two SPF records, a revoked DKIM key), by record. */
  notes?: Partial<Record<"mx" | "spf" | "dkim" | "dmarc", string>>;
}

/** The latest DNS check of a mailbox's domain. Each record is true (found), false (missing) or null (the lookup
 *  failed, so nobody knows). */
export interface DomainDns {
  domain: string;
  mx: boolean | null;
  spf: boolean | null;
  dkim: boolean | null;
  dmarc: boolean | null;
  details: DomainRecords;
  checked_at: string;
}

export interface MailboxHealth {
  /** 0–100, or null when there's too little activity to judge. */
  score: number | null;
  status: HealthStatus;
  window_days: number;
  /** Campaign emails sent and hard-bounced. */
  sent: number;
  /** Campaign emails tried: sent, or refused by the receiving server at once. Bounce rates are out of these. */
  tried: number;
  bounced: number;
  /** Percent with one decimal; null below the minimum volume. */
  bounce_rate: number | null;
  replies: number;
  reply_rate: number | null;
  /** Campaign and warmup sends that failed on the mailbox's side. */
  send_errors: number;
  send_error_rate: number | null;
  /** Warmup emails whose landing is known (inbox or spam). */
  warmup_landed: number;
  warmup_inbox_rate: number | null;
  /** What pulls the score down, worst first, in plain words. */
  issues: string[];
}

export function healthStatus(score: number | null): HealthStatus {
  if (score === null) return "unknown";
  return score >= 90 ? "healthy" : score >= 70 ? "fair" : "at_risk";
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const oneDecimal = (n: number) => Math.round(n * 10) / 10;
const count = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/**
 * Mailbox health from what actually happened: campaign hard bounces, replies, failed sends and, where it's known, where
 * warmup emails landed. It starts at 100 and each problem takes points off in proportion to how bad it is, so the worst
 * problem dominates. Signals below their minimum volume are left out; with none left there's no score.
 */
export function scoreHealth(c: HealthCounts, windowDays: number = HEALTH_WINDOW_DAYS): MailboxHealth {
  const issues: Array<{ points: number; text: string }> = [];
  let points = 0;
  let judged = false;

  // Out of the emails tried: one the receiving server refused at once was never sent, yet it bounced.
  const tried = c.sent + c.refused;
  const bounceRate = tried >= HEALTH_MIN.bounce ? (c.bounced / Math.max(tried, c.bounced)) * 100 : null;
  if (bounceRate !== null) {
    judged = true;
    const p = clamp((bounceRate - 0.5) * 10, 0, 70);
    points += p;
    if (bounceRate >= 2) issues.push({ points: p, text: `${oneDecimal(bounceRate)}% of campaign emails hard-bounced. Check the leads this mailbox sends to.` });
  }

  // A one-off failure among a handful of sends is noise; three or more failures count even at low volume.
  const attempts = tried + c.warmupSent + c.sendErrors;
  const errorRate = attempts >= HEALTH_MIN.sends || c.sendErrors >= 3 ? (c.sendErrors / attempts) * 100 : null;
  if (errorRate !== null) {
    judged = true;
    if (c.sendErrors > 0) {
      const p = clamp(5 + errorRate * 1.5, 0, 50);
      points += p;
      issues.push({ points: p, text: `${c.sendErrors.toLocaleString("en-US")} of ${count(attempts, "send")} failed.` });
    }
  }

  const landed = c.warmupInbox + c.warmupSpam;
  const inboxRate = landed >= HEALTH_MIN.placement ? (c.warmupInbox / landed) * 100 : null;
  if (inboxRate !== null) {
    judged = true;
    const p = clamp((95 - inboxRate) * 1.5, 0, 60);
    points += p;
    if (inboxRate < 90) issues.push({ points: p, text: `${oneDecimal(100 - inboxRate)}% of warmup emails landed in spam.` });
  }

  const replyRate = c.sent >= HEALTH_MIN.reply ? (c.replies / c.sent) * 100 : null;
  if (replyRate !== null) {
    judged = true;
    const p = c.replies === 0 ? 10 : replyRate < 0.5 ? 5 : 0;
    points += p;
    if (p) issues.push({ points: p, text: c.replies === 0 ? `No replies to ${count(c.sent, "campaign email")}.` : `Few replies: ${oneDecimal(replyRate)}% of ${count(c.sent, "campaign email")}.` });
  }

  const score = judged ? Math.round(clamp(100 - points, 0, 100)) : null;
  return {
    score,
    status: healthStatus(score),
    window_days: windowDays,
    sent: c.sent,
    tried,
    bounced: c.bounced,
    bounce_rate: bounceRate === null ? null : oneDecimal(bounceRate),
    replies: c.replies,
    reply_rate: replyRate === null ? null : oneDecimal(replyRate),
    send_errors: c.sendErrors,
    send_error_rate: errorRate === null ? null : oneDecimal(errorRate),
    warmup_landed: landed,
    warmup_inbox_rate: inboxRate === null ? null : oneDecimal(inboxRate),
    issues: issues.sort((a, b) => b.points - a.points).map((i) => i.text),
  };
}

// ---------- Mailboxes from a spreadsheet ----------

/** The most each numeric column of a mailbox import takes; more is taken as the most. */
export const SHEET_MAXIMUMS = { imap_port: 65_535, smtp_port: 65_535, daily_limit: 10_000, warmup_limit: 200, reply_rate: 100 } as const;

/** A number as spreadsheets write it ("50", "50/day", "1,000"), or undefined when there's none. */
export function readSheetNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  // "1,000" and "1 000" are a thousand, not one.
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(String(v ?? "").replace(/(?<=\d)[, ](?=\d{3}(?:\D|$))/g, ""));
  return m ? Number(m[1]) : undefined;
}

/**
 * The warmup increase as the Settings tab names it, or as people type it: "Disabled"/"off", "Recommended", "+2", "3 per
 * day" (1 to 4 a day). Undefined when it's none of those.
 */
export function readWarmupIncrease(v: unknown): AccountWarmupConfig["increment"] | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (/^(disabled?|off|none|no|false|0 ?(per|a|\/) ?day)$/.test(s)) return "disabled";
  if (/^(recommended|auto|default|0)$/.test(s)) return "0";
  const n = /^\+?\s*(\d+)/.exec(s)?.[1];
  return n ? (String(Math.min(4, Math.max(1, Number(n)))) as AccountWarmupConfig["increment"]) : undefined;
}

// Mailbox health from real signals (scoreHealth in @reachstack/shared) with a daily trend, plus the re-test that puts a
// mailbox taken out of sending by a failed send back once sending works again.
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { HEALTH_WINDOW_DAYS, scoreHealth, type HealthCounts, type MailboxHealth } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { driverFor, type AccountRow } from "../mail/driver";
import { MAILBOX_FAILURES, clearAccountError, errorState, recordAccountError, refreshAccountError, type SideFailure } from "./accounts";
import { inUse } from "./live-workspaces";
import { dayOn, daysBefore, workspaceZone, workspaceZones } from "./workspace-clock";

const A = schema.emailAccounts;
const S = schema.accountDailyStats;

type StatsRow = Pick<typeof S.$inferSelect, "sent" | "bounced" | "refused" | "replies" | "sendErrors" | "warmupSent" | "warmupInbox" | "warmupSpam">;

const counts = (r?: Partial<StatsRow> | null): HealthCounts => ({
  sent: Number(r?.sent ?? 0),
  bounced: Number(r?.bounced ?? 0),
  refused: Number(r?.refused ?? 0),
  replies: Number(r?.replies ?? 0),
  sendErrors: Number(r?.sendErrors ?? 0),
  warmupSent: Number(r?.warmupSent ?? 0),
  warmupInbox: Number(r?.warmupInbox ?? 0),
  warmupSpam: Number(r?.warmupSpam ?? 0),
});

/** Each mailbox's health over the last HEALTH_WINDOW_DAYS days, today included, on its workspace's clock. */
export async function mailboxHealth(accounts: Array<Pick<AccountRow, "id" | "workspaceId">>): Promise<Map<string, MailboxHealth>> {
  const out = new Map<string, MailboxHealth>();
  if (!accounts.length) return out;
  const zones = await workspaceZones(accounts.map((a) => a.workspaceId));
  const bySince = new Map<string, Set<string>>();
  for (const a of accounts) {
    const since = daysBefore(dayOn(zones.get(a.workspaceId)!), HEALTH_WINDOW_DAYS - 1);
    bySince.set(since, (bySince.get(since) ?? new Set()).add(a.id));
  }
  for (const [since, ids] of bySince) {
    const rows = await db
      .select({
        accountId: S.accountId,
        sent: sql<number>`sum(${S.sent})`,
        bounced: sql<number>`sum(${S.bounced})`,
        refused: sql<number>`sum(${S.refused})`,
        replies: sql<number>`sum(${S.replies})`,
        sendErrors: sql<number>`sum(${S.sendErrors})`,
        warmupSent: sql<number>`sum(${S.warmupSent})`,
        warmupInbox: sql<number>`sum(${S.warmupInbox})`,
        warmupSpam: sql<number>`sum(${S.warmupSpam})`,
      })
      .from(S)
      .where(and(inArray(S.accountId, [...ids]), gte(S.date, since)))
      .groupBy(S.accountId);
    const byId = new Map(rows.map((r) => [r.accountId, r]));
    for (const id of ids) out.set(id, scoreHealth(counts(byId.get(id))));
  }
  return out;
}

export interface HealthDay {
  date: string;
  /** The score of the HEALTH_WINDOW_DAYS days ending that day (null: too little activity to judge). */
  score: number | null;
  sent: number;
  bounced: number;
  refused: number;
  replies: number;
  send_errors: number;
  warmup_inbox: number;
  warmup_spam: number;
}

/** One mailbox's health, day by day, over the last `days` days: each day's own counts and the score as of that day. */
export async function healthTrend(account: Pick<AccountRow, "id" | "workspaceId">, days = 30): Promise<HealthDay[]> {
  const today = dayOn(await workspaceZone(account.workspaceId));
  const since = daysBefore(today, days + HEALTH_WINDOW_DAYS - 2);
  const rows = await db
    .select()
    .from(S)
    .where(and(eq(S.accountId, account.id), gte(S.date, since)));
  const byDay = new Map(rows.map((r) => [r.date, r]));
  const trend: HealthDay[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const date = daysBefore(today, back);
    const window = counts();
    for (let i = 0; i < HEALTH_WINDOW_DAYS; i++) {
      const c = counts(byDay.get(daysBefore(date, i)));
      for (const k of Object.keys(window) as Array<keyof HealthCounts>) window[k] += c[k];
    }
    const own = counts(byDay.get(date));
    trend.push({
      date,
      score: scoreHealth(window).score,
      sent: own.sent,
      bounced: own.bounced,
      refused: own.refused,
      replies: own.replies,
      send_errors: own.sendErrors,
      warmup_inbox: own.warmupInbox,
      warmup_spam: own.warmupSpam,
    });
  }
  return trend;
}

/** How long a mailbox taken out of sending waits before its sending side is tested again, by failure. */
export const RETEST_AFTER_MS: Record<string, number> = { auth: 15 * 60_000, connection: 15 * 60_000, quota: 6 * 3_600_000, rejected: 6 * 3_600_000 };
const RETEST_MAX_MS = 24 * 3_600_000;

/**
 * The wait before the next re-test: twice as long after each one that failed, up to a day. A password that was changed
 * isn't tried every 15 minutes for ever (providers lock accounts that fail to sign in again and again).
 */
export const retestWait = (f: Pick<SideFailure, "code" | "retests">) => Math.min(RETEST_MAX_MS, (RETEST_AFTER_MS[f.code] ?? 15 * 60_000) * 2 ** Math.min(f.retests ?? 0, 10));

/**
 * A mailbox taken out of sending by a failed send stays out until sending works again; its inbox syncing fine doesn't
 * count. This re-tests the SMTP connection and login of those mailboxes on a schedule (soon for login and connection
 * problems; after a few hours for provider limits and refusals, which a login test can't see) and puts them back when
 * it passes. If the next real send fails the same way, they're taken out again.
 */
export async function recheckSendingFailures(now = Date.now()): Promise<number> {
  // Mailboxes of deleted workspaces and turned-off accounts aren't tried.
  const rows = await db
    .select()
    .from(A)
    .where(and(lt(A.status, 0), await inUse(A.workspaceId)));
  let restored = 0;
  for (const a of rows) {
    const failure = errorState(a.statusMessage)?.sides?.smtp;
    if (!failure || !MAILBOX_FAILURES.has(failure.code)) continue;
    if (now - failure.at < retestWait(failure)) continue;
    let check: { ok: boolean; error?: string; code?: string };
    try {
      check = await driverFor(a).verifySmtp();
    } catch (err) {
      check = { ok: false, error: (err as Error).message };
    }
    if (check.ok) {
      await clearAccountError(a, "smtp");
      restored++;
    } else if (check.code && check.code !== failure.code && MAILBOX_FAILURES.has(check.code)) {
      // It fails differently now (say, the login stopped working): a new problem.
      await recordAccountError(a, check.code, check.error ?? "Sending failed", {}, "smtp");
    } else {
      await refreshAccountError(a, "smtp", check.error ?? failure.message);
    }
  }
  return restored;
}

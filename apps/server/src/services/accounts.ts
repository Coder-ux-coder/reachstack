// Email account helpers: defaults, serialization, daily counters (on the workspace clock), sending capacity, and the
// error state that keeps a mailbox out of sending until the side that failed (SMTP or IMAP) works again.
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { AccountStatus, ProviderCode, slowRampLimit, warmupTarget, type Account, type AccountWarmupConfig, type DomainDns, type MailboxHealth } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { shortCode } from "../lib/ids";
import { iso } from "../lib/time";
import type { AccountRow } from "../mail/driver";
import type { MailError } from "../mail/types";
import { emit } from "./bus";
import { mailboxDns } from "./domain-dns";
import { tagsFor } from "./tags";
import { enqueueWebhooks } from "./webhooks";
import { dayOn, daysBetween, workspaceZone, workspaceZones } from "./workspace-clock";

const A = schema.emailAccounts;
const S = schema.accountDailyStats;

export function defaultWarmup(): AccountWarmupConfig {
  return {
    limit: 10,
    increment: "1",
    reply_rate: 30,
    warmup_custom_ftag: `${shortCode(5)}-${shortCode(5)}`,
    advanced: { warm_ctd: false, open_rate: 100, important_rate: 100, read_emulation: false, spam_save_rate: 100, weekday_only: false },
  };
}

export function mergeWarmup(current: AccountWarmupConfig | null | undefined, patch: Partial<AccountWarmupConfig> | null | undefined): AccountWarmupConfig {
  const base = current ?? defaultWarmup();
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    advanced: { ...(base.advanced ?? {}), ...(patch.advanced ?? {}) },
    warmup_custom_ftag: patch.warmup_custom_ftag ?? base.warmup_custom_ftag ?? `${shortCode(5)}-${shortCode(5)}`,
  };
}

export type DailyCounter =
  | "sent"
  | "warmupSent"
  | "warmupReceived"
  | "warmupInbox"
  | "warmupSpam"
  | "warmupCategory"
  | "warmupSavedFromSpam"
  | "warmupReplied"
  | "bounced"
  | "refused"
  | "replies"
  | "sendErrors";

const counterColumn = {
  sent: S.sent,
  warmupSent: S.warmupSent,
  warmupReceived: S.warmupReceived,
  warmupInbox: S.warmupInbox,
  warmupSpam: S.warmupSpam,
  warmupCategory: S.warmupCategory,
  warmupSavedFromSpam: S.warmupSavedFromSpam,
  warmupReplied: S.warmupReplied,
  bounced: S.bounced,
  refused: S.refused,
  replies: S.replies,
  sendErrors: S.sendErrors,
} as const;

/** Atomically increments one of an account's counters for today (today on its workspace's clock, unless `date` is given). */
export async function bumpAccountStat(workspaceId: string, accountId: string, counter: DailyCounter, by = 1, date?: string) {
  const day = date ?? dayOn(await workspaceZone(workspaceId));
  const col = counterColumn[counter];
  await db
    .insert(S)
    .values({ workspaceId, accountId, date: day, [counter]: by })
    .onConflictDoUpdate({
      target: [S.accountId, S.date],
      set: { [counter]: sql`${col} + ${by}` },
    });
}

/** A mailbox's day so far, on its workspace's clock. */
export interface DayStats {
  /** Today's date (YYYY-MM-DD). */
  day: string;
  sent: number;
  warmupSent: number;
  /** Days since the mailbox's first campaign email (0 on that day, and until it sends one). */
  rampDay: number;
  /** Earlier days on which it sent warmup emails. */
  warmupDays: number;
}

type AccountRef = string | Pick<AccountRow, "id" | "workspaceId">;

/** Today's counters, slow-ramp day and days of warmup so far, by account id. Accepts ids or account rows. */
export async function todayStats(accounts: AccountRef[], at: number = Date.now()): Promise<Map<string, DayStats>> {
  const out = new Map<string, DayStats>();
  if (!accounts.length) return out;
  const refs = accounts.filter((a): a is Pick<AccountRow, "id" | "workspaceId"> => typeof a !== "string");
  const bare = accounts.filter((a): a is string => typeof a === "string");
  if (bare.length) refs.push(...(await db.select({ id: A.id, workspaceId: A.workspaceId }).from(A).where(inArray(A.id, bare))));
  const zones = await workspaceZones(refs.map((r) => r.workspaceId));
  // Workspaces in different timezones can be on different dates.
  const byDay = new Map<string, Set<string>>();
  for (const r of refs) {
    const day = dayOn(zones.get(r.workspaceId)!, at);
    byDay.set(day, (byDay.get(day) ?? new Set()).add(r.id));
  }
  for (const [day, ids] of byDay) {
    const rows = await db
      .select({
        accountId: S.accountId,
        sent: sql<number>`coalesce(sum(case when ${S.date} = ${day} then ${S.sent} end), 0)`,
        warmupSent: sql<number>`coalesce(sum(case when ${S.date} = ${day} then ${S.warmupSent} end), 0)`,
        firstSend: sql<string | null>`min(case when ${S.sent} > 0 then ${S.date} end)`,
        warmupDays: sql<number>`coalesce(sum(case when ${S.date} < ${day} and ${S.warmupSent} > 0 then 1 else 0 end), 0)`,
      })
      .from(S)
      .where(inArray(S.accountId, [...ids]))
      .groupBy(S.accountId);
    const found = new Map(rows.map((r) => [r.accountId, r]));
    for (const id of ids) {
      const r = found.get(id);
      out.set(id, {
        day,
        sent: Number(r?.sent ?? 0),
        warmupSent: Number(r?.warmupSent ?? 0),
        rampDay: r?.firstSend ? Math.max(0, daysBetween(r.firstSend, day)) : 0,
        warmupDays: Number(r?.warmupDays ?? 0),
      });
    }
  }
  return out;
}

/**
 * Campaign sending limit for today. With slow ramp it starts at SLOW_RAMP.start on the mailbox's first campaign day
 * and grows by SLOW_RAMP.step a day (days on the workspace clock), up to the daily limit.
 */
/**
 * What other connections of the same addresses (the mailbox added in another workspace as well) sent today, by
 * address. A daily limit is the address's: its emails from anywhere count toward it.
 */
export async function sentByTwinsToday(accounts: Array<Pick<AccountRow, "id" | "email" | "providerCode">>, at: number = Date.now()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const real = accounts.filter((a) => a.providerCode !== ProviderCode.SANDBOX);
  if (!real.length) return out;
  const twins = await db
    .select({ id: A.id, workspaceId: A.workspaceId, email: A.email })
    .from(A)
    .where(and(inArray(A.email, [...new Set(real.map((a) => a.email))]), notInArray(A.id, accounts.map((a) => a.id))));
  if (!twins.length) return out;
  const stats = await todayStats(twins, at);
  for (const t of twins) out.set(t.email, (out.get(t.email) ?? 0) + (stats.get(t.id)?.sent ?? 0));
  return out;
}

export function effectiveDailyLimit(account: Pick<AccountRow, "dailyLimit" | "enableSlowRamp">, today?: Pick<DayStats, "rampDay"> | null): number {
  const limit = account.dailyLimit ?? 30;
  if (!account.enableSlowRamp) return limit;
  return slowRampLimit(limit, today?.rampDay ?? 0);
}

export function serializeAccount(a: AccountRow, extra: { tags?: unknown[]; today?: DayStats; health?: MailboxHealth | null; dns?: DomainDns | null } = {}): Account & Record<string, unknown> {
  return {
    id: a.id,
    email: a.email,
    first_name: a.firstName,
    last_name: a.lastName,
    organization: a.workspaceId,
    provider_code: a.providerCode,
    status: a.status,
    status_message: a.statusMessage as Account["status_message"],
    warmup_status: a.warmupStatus,
    warmup: a.warmup ?? defaultWarmup(),
    daily_limit: a.dailyLimit,
    daily_limit_max: null,
    warmup_limit_max: null,
    sending_gap: a.sendingGap,
    signature: a.signature,
    reply_to: a.replyTo,
    tracking_domain_name: a.trackingDomainName,
    tracking_domain_status: a.trackingDomainStatus,
    enable_slow_ramp: a.enableSlowRamp,
    inbox_placement_test_limit: a.inboxPlacementTestLimit,
    stat_warmup_score: a.warmupScore === null ? null : Math.round(a.warmupScore),
    timestamp_warmup_start: iso(a.warmupStartedAt),
    timestamp_created: iso(a.createdAt)!,
    timestamp_updated: iso(a.updatedAt)!,
    timestamp_last_used: iso(a.lastSentAt),
    added_by: a.addedBy,
    modified_by: a.modifiedBy,
    setup_pending: a.setupPending,
    is_managed_account: a.isManaged,
    autofix_failed: a.autofixFailed,
    imap_host: a.imap?.host ?? null,
    imap_port: a.imap?.port ?? null,
    imap_username: a.imap?.user ?? null,
    smtp_host: a.smtp?.host ?? null,
    smtp_port: a.smtp?.port ?? null,
    smtp_username: a.smtp?.user ?? null,
    connection: a.oauthEnc ? "oauth" : a.providerCode === ProviderCode.SANDBOX ? "sandbox" : "password",
    // Campaign sending paused (warmup continues): "Rest this mailbox", or a Deliverability Agent recommendation.
    campaign_pause_until: a.campaignPauseUntil && a.campaignPauseUntil.getTime() > Date.now() ? iso(a.campaignPauseUntil) : null,
    ...(extra.tags ? { tags: extra.tags as string[] } : {}),
    ...(extra.today
      ? {
          sent_today: extra.today.sent,
          warmup_sent_today: extra.today.warmupSent,
          // What the engine allows today: the slow ramp's step, and the warmup ramp's target.
          daily_limit_today: effectiveDailyLimit(a, extra.today),
          warmup_target_today: warmupTarget(a.warmup ?? defaultWarmup(), extra.today.warmupDays),
          warmup_days: extra.today.warmupDays,
        }
      : {}),
    ...(extra.health !== undefined ? { health: extra.health } : {}),
    // The latest DNS check of the mailbox's domain (services/domain-dns.ts): null until checked, and for sandboxes.
    ...(extra.dns !== undefined ? { dns: extra.dns } : {}),
  };
}

/** Serializes several accounts with tags, today's counters, their domain's DNS check and (when given) their health. */
export async function serializeAccounts(workspaceId: string, rows: AccountRow[], opts: { includeTags?: boolean; health?: Map<string, MailboxHealth> } = {}) {
  const ids = rows.map((r) => r.id);
  const [tags, stats, dns] = await Promise.all([opts.includeTags ? tagsFor(workspaceId, ids) : Promise.resolve(null), todayStats(rows), mailboxDns(workspaceId, rows)]);
  return rows.map((r) =>
    serializeAccount(r, {
      tags: tags ? (tags.get(r.id) ?? []) : undefined,
      today: stats.get(r.id),
      health: opts.health ? (opts.health.get(r.id) ?? null) : undefined,
      dns: dns.get(r.id) ?? null,
    }),
  );
}

// ---------- Mailbox errors ----------

/** The two halves of a mailbox: sending (SMTP) and the inbox (IMAP). */
export type MailSide = "smtp" | "imap";

/** One side's open failure: what went wrong, when, and how many times in a row. */
export interface SideFailure {
  code: string;
  message: string;
  at: number;
  count: number;
  /** How many re-tests (mailbox-health.ts) have failed since: each waits longer than the last. */
  retests?: number;
}

/** What status_message holds for a failing mailbox: the latest failure (shown in the app) and each side's open one. */
export interface AccountErrorState {
  code?: string;
  e_message?: string;
  command?: string;
  responseCode?: number;
  response?: string;
  side?: MailSide;
  sides?: Partial<Record<MailSide, SideFailure>>;
  /** The status to go back to once both sides work (a paused mailbox stays paused). */
  resume_status?: number;
  /** When account_error last went out for this mailbox. */
  announced_at?: number;
}

const ERROR_KEYS = new Set(["code", "e_message", "command", "responseCode", "response", "side", "sides", "resume_status", "announced_at"]);

/** Failures that are the mailbox's own, not a recipient's: they take it out of sending (connection drops after three in a row). */
export const MAILBOX_FAILURES = new Set(["auth", "connection", "quota", "rejected"]);

/** One account_error event (and webhook) per mailbox every six hours at most, so a mailbox that keeps failing doesn't flood anyone. */
export const ANNOUNCE_EVERY_MS = 6 * 3_600_000;
const announcedAt = new Map<string, number>();

/**
 * How many failures in a row take a side of a mailbox out of action, by what failed: a login, a provider limit or a
 * refusal at once, connection drops after three. An inbox that keeps failing in a way nobody could sort (an odd answer
 * from its server) can't be read either, so after ten syncs in a row it's out too: its replies aren't being filed, and
 * campaigns would follow up people who answered. Other sending failures are only counted (Infinity).
 */
export function failuresBeforeOut(code: string, side: MailSide): number {
  if (code === "auth" || code === "quota" || code === "rejected") return 1;
  if (code === "connection") return 3;
  return side === "imap" ? 10 : Infinity;
}

/** The status a failure puts the mailbox in, or null while it's only being counted. */
function failureStatus(f: SideFailure, side: MailSide): number | null {
  if (f.count < failuresBeforeOut(f.code, side)) return null;
  return f.code === "quota" || f.code === "rejected" ? AccountStatus.SENDING_ERROR : AccountStatus.CONNECTION_ERROR;
}

/** The status the open failures add up to (the most recent one that takes the mailbox out of sending), or null. */
function statusOf(sides: Partial<Record<MailSide, SideFailure>>): number | null {
  const flagged = (Object.entries(sides) as Array<[MailSide, SideFailure | undefined]>)
    .flatMap(([side, f]) => {
      const status = f ? failureStatus(f, side) : null;
      return f && status !== null ? [{ at: f.at, status }] : [];
    })
    .sort((a, b) => b.at - a.at);
  return flagged[0]?.status ?? null;
}

/** The error part of status_message, or null when there is none (it can also carry other notes, like an inbox placement pause). */
export function errorState(message: unknown): AccountErrorState | null {
  const m = message as AccountErrorState | null;
  return m && typeof m === "object" && (m.sides || m.code) ? m : null;
}

/** status_message without its error part (null when nothing else is left). */
function otherNotes(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object") return null;
  const rest = Object.fromEntries(Object.entries(message).filter(([k]) => !ERROR_KEYS.has(k)));
  return Object.keys(rest).length ? rest : null;
}

/** Whether one side of the mailbox has an open failure, so a good send or sync has something to clear. */
export function hasOpenFailure(account: Pick<AccountRow, "statusMessage" | "status" | "consecutiveErrors">, side: MailSide): boolean {
  const state = errorState(account.statusMessage);
  if (!state) return account.status < 0 || account.consecutiveErrors > 0;
  // Failures recorded before each side was tracked can't be told apart: any good check counts.
  return state.sides ? !!state.sides[side] : true;
}

async function freshState(accountId: string) {
  const [row] = await db.select({ status: A.status, statusMessage: A.statusMessage, consecutiveErrors: A.consecutiveErrors }).from(A).where(eq(A.id, accountId)).limit(1);
  return row ?? null;
}

async function announceAccountError(account: Pick<AccountRow, "id" | "workspaceId" | "email">, e: { error: string; kind: MailSide; code: string; status: number }) {
  emit("account_error", account.workspaceId, { account_id: account.id, email: account.email, error: e.error, kind: e.kind, code: e.code, status: e.status });
  await enqueueWebhooks(account.workspaceId, "account_error", { email_account: account.email, account_id: account.id, error: e.error, kind: e.kind, code: e.code, status: e.status });
}

/**
 * Records a failure on one side of a mailbox (SMTP for sends, IMAP for inbox syncs). Login problems, provider limits
 * and refusals take the mailbox out of sending at once, connection drops after three in a row, and it stays out until
 * that same side works again: a good inbox sync doesn't clear a sending failure. Going into the error state (or failing
 * in a new way while in it) raises `account_error` and its webhook, at most once per mailbox every six hours.
 * Returns the mailbox's new status.
 */
export async function recordAccountError(
  account: AccountRow,
  kind: string,
  message: string,
  extra: { command?: string; responseCode?: number; response?: string } = {},
  side: MailSide = "smtp",
): Promise<number> {
  const cur = (await freshState(account.id)) ?? account;
  const prev = errorState(cur.statusMessage);
  const now = Date.now();
  const text = message.slice(0, 500);
  const sides = { ...(prev?.sides ?? {}) };
  const failure: SideFailure = { code: kind, message: text, at: now, count: (sides[side]?.count ?? 0) + 1 };
  sides[side] = failure;
  const inError = cur.status < 0;
  const status = statusOf(sides) ?? cur.status;
  // What it goes back to once it works: its status now, or, when it's already out with an error, what it had before.
  // (A note left by an earlier blip mustn't win: a mailbox paused since then stays paused.)
  const resume = inError ? (prev?.resume_status ?? AccountStatus.ACTIVE) : cur.status;
  const lastAnnounced = Math.max(prev?.announced_at ?? 0, announcedAt.get(account.id) ?? 0);
  const announce = failureStatus(failure, side) !== null && (!inError || prev?.side !== side || prev?.code !== kind) && now - lastAnnounced >= ANNOUNCE_EVERY_MS;
  const state: AccountErrorState = {
    code: kind,
    e_message: text,
    command: extra.command,
    responseCode: extra.responseCode,
    response: extra.response?.slice(0, 500),
    side,
    sides,
    resume_status: resume,
    ...(announce ? { announced_at: now } : prev?.announced_at ? { announced_at: prev.announced_at } : {}),
  };
  await db
    .update(A)
    .set({ consecutiveErrors: failure.count, lastErrorAt: new Date(now), status, statusMessage: { ...otherNotes(cur.statusMessage), ...state } })
    .where(eq(A.id, account.id));
  if (announce) {
    announcedAt.set(account.id, now);
    await announceAccountError(account, { error: text, kind: side, code: kind, status });
  }
  return status;
}

/**
 * A side of the mailbox works again (a send went out, the inbox synced, a connection test passed): its open failure is
 * cleared, and once neither side is failing the mailbox goes back to the status it had (a paused one stays paused).
 * "all" clears both sides, for a connection test that checked both and for "Mark as fixed".
 */
export async function clearAccountError(account: AccountRow, side: MailSide | "all"): Promise<void> {
  if (side !== "all" && !hasOpenFailure(account, side)) return;
  const cur = await freshState(account.id);
  if (!cur) return;
  const prev = errorState(cur.statusMessage);
  if (!prev) {
    // Nothing recorded beyond a counter, or an error status set elsewhere.
    if (!cur.consecutiveErrors && cur.status >= 0) return;
    await db.update(A).set({ consecutiveErrors: 0, ...(cur.status < 0 ? { status: AccountStatus.ACTIVE } : {}) }).where(eq(A.id, account.id));
    return;
  }
  if (side !== "all" && prev.sides && !prev.sides[side]) return;
  const sides: Partial<Record<MailSide, SideFailure>> = side !== "all" && prev.sides ? { ...prev.sides } : {};
  if (side !== "all") delete sides[side];
  const latest = (Object.entries(sides) as Array<[MailSide, SideFailure]>).sort((a, b) => b[1].at - a[1].at)[0];
  const resume = prev.resume_status ?? AccountStatus.ACTIVE;
  const status = cur.status < 0 ? (statusOf(sides) ?? resume) : cur.status;
  const notes = otherNotes(cur.statusMessage);
  const statusMessage = latest
    ? { ...notes, code: latest[1].code, e_message: latest[1].message, side: latest[0], sides, resume_status: resume, ...(prev.announced_at ? { announced_at: prev.announced_at } : {}) }
    : notes;
  await db
    .update(A)
    .set({ consecutiveErrors: latest?.[1].count ?? 0, status, statusMessage })
    .where(eq(A.id, account.id));
}

/**
 * New inbox credentials (another password or server): the inbox's failures so far were with the old ones, so inbox
 * sync tries the new ones within a minute instead of waiting out its retry delay. The mailbox stays out until it works.
 */
export async function retryInboxSoon(accountId: string): Promise<void> {
  const cur = await freshState(accountId);
  const prev = errorState(cur?.statusMessage);
  const failure = prev?.sides?.imap;
  if (!cur || !prev || !failure) return;
  const sides = { ...prev.sides, imap: { ...failure, count: 0, at: 0 } };
  await db
    .update(A)
    .set({ statusMessage: { ...(cur.statusMessage as Record<string, unknown>), sides } })
    .where(eq(A.id, accountId));
}

/** A re-test of a failing side failed the same way: the failure (and the status) stay, with the new time and message. */
export async function refreshAccountError(account: AccountRow, side: MailSide, message: string): Promise<void> {
  const cur = await freshState(account.id);
  const prev = errorState(cur?.statusMessage);
  const failure = prev?.sides?.[side];
  if (!cur || !prev || !failure) return;
  const text = message.slice(0, 500);
  const sides = { ...prev.sides, [side]: { ...failure, message: text, at: Date.now(), retests: (failure.retests ?? 0) + 1 } };
  await db
    .update(A)
    .set({ lastErrorAt: new Date(), statusMessage: { ...(cur.statusMessage as Record<string, unknown>), sides, ...(prev.side === side ? { e_message: text } : {}) } })
    .where(eq(A.id, account.id));
}

/**
 * After a send from this mailbox failed (campaign or warmup): when the failure is the mailbox's own (login, connection,
 * provider limit, refusal) it counts against the mailbox's health and is recorded on the sending side. A refused
 * recipient address is a bounce, and a temporary or unclear failure is simply retried, so neither counts against the
 * mailbox. Returns whether the mailbox itself failed.
 */
export async function noteSendFailure(account: AccountRow, e: MailError): Promise<boolean> {
  if (!MAILBOX_FAILURES.has(e.kind)) return false;
  await bumpAccountStat(account.workspaceId, account.id, "sendErrors");
  await recordAccountError(account, e.kind, e.message, { command: e.command, responseCode: e.responseCode, response: e.response }, "smtp");
  return true;
}

/** After a good send: ends a run of sending failures (an inbox problem stays until the inbox syncs again). */
export async function noteSendSuccess(account: AccountRow): Promise<void> {
  if (hasOpenFailure(account, "smtp")) await clearAccountError(account, "smtp");
}

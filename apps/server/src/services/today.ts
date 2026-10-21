// Today: what goes out today and why not more. It estimates the rest of the day, and the week ahead, the way the
// sender works (engine/sender.ts): sending windows; campaign daily limits, slow ramp-up and the limit on new leads a
// day; mailbox daily limits with their slow ramp; and the gap plus random wait between one mailbox's emails. Daily
// limits reset at midnight on the workspace clock. Replies, bounces, unsubscribes and new leads change the real
// numbers, so these are estimates, and the bottleneck is whatever holds back the most emails that are due.
import { and, asc, count, eq, gt, gte, inArray, isNotNull, or, sql, type SQLWrapper } from "drizzle-orm";
import {
  ACCOUNT_STATUS_LABELS,
  AccountStatus,
  CampaignNotSendingStatus,
  CampaignStatus,
  LeadStatus,
  NOT_SENDING_LABELS,
  WarmupStatus,
  dayOffReason,
  delayToMs,
  isTaskStep,
  warmupTarget,
  type CampaignSchedule,
  type SequenceStep,
} from "@reachstack/shared";
import { db, schema } from "../db/client";
import { DEFAULT_SCHEDULE, anyOpen, iso, isValidZone, nextOpening, openSpans } from "../lib/time";
import type { AccountRow } from "../mail/driver";
import { defaultWarmup, effectiveDailyLimit, todayStats } from "./accounts";
import { monthlyEmailsSent, workspaceLimits } from "./billing-limits";
import { activeSteps, campaignSenders, type CampaignRow, type SubsequenceRow } from "./campaigns";
import { leadSchedules } from "./lead-zones";
import { dayOn, daysBetween, startOfDayOn, startOfNextDayOn, workspaceZone } from "./workspace-clock";

const C = schema.campaigns;
const L = schema.leads;
const E = schema.emailEvents;
const DAY_MS = 86_400_000;

/** Days in the forecast, today included. */
export const FORECAST_DAYS = 7;
/** Campaigns the sender works on. */
const RUNNING: number[] = [CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES];
/** Stopped campaigns, listed when leads wait in them. */
const STOPPED: number[] = [CampaignStatus.PAUSED, CampaignStatus.ACCOUNTS_UNHEALTHY, CampaignStatus.BOUNCE_PROTECT, CampaignStatus.ACCOUNT_SUSPENDED];
/** What the sender or the send watchdog flagged that someone has to fix. */
const PROBLEMS = new Set<number>([CampaignNotSendingStatus.EMPTY_STEP, CampaignNotSendingStatus.STALLED, CampaignNotSendingStatus.VERIFYING, CampaignNotSendingStatus.ERROR]);
/** The campaign slow ramp-up: 20 emails on launch day, 20 more each day after (as in the sender). */
const CAMPAIGN_RAMP = 20;

/** What keeps due emails from going out today, in the order the sender applies them. */
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

export interface TodayFlow {
  /** The campaign's id, or the subsequence's. */
  id: string;
  kind: "campaign" | "subsequence";
  campaign_id: string;
  name: string;
  /** For a subsequence, its campaign's name. */
  campaign_name: string;
  status: number;
  running: boolean;
  sent_today: number;
  /** Emails still due today: leads due now, and those coming due before the day resets. */
  due_today: number;
  due_now: number;
  /** About how many more go out today. */
  more_today: number;
  /** Today's daily limit, after slow ramp-up (null: none). */
  daily_limit: number | null;
  next_due_at: string | null;
  window: { open_now: boolean; minutes_left: number; next_open_at: string | null };
  mailboxes: { attached: number; usable: number };
  /** Why the rest of today's due emails won't go out today, the biggest first. */
  held: Array<{ reason: HoldReason; emails: number; text: string }>;
  /** Something the sender or the send watchdog flagged that someone has to fix. */
  problem: string | null;
}

export interface TodayMailbox {
  id: string;
  email: string;
  status: number;
  /** Can send campaign emails today: active, not resting, and in a running campaign. */
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
  /** Campaign and subsequence emails sent today. */
  sent: number;
  more: number;
  due: number;
  wont_fit: number;
  /** Emails due today in stopped campaigns (not part of `due`). */
  waiting_in_stopped: number;
  next_due_at: string | null;
  capacity: { mailboxes: number; usable: number; limit: number; sent: number; left: number };
  bottleneck: { reason: HoldReason | "idle" | "no_leads" | "on_track"; title: string; detail: string; link: { label: string; to: string } | null };
  flows: TodayFlow[];
  /** Null without permission to see mailboxes. */
  mailboxes: TodayMailbox[] | null;
  forecast: Array<{ date: string; due: number; sends: number; capacity: number }>;
}

interface Flow {
  id: string;
  kind: "campaign" | "subsequence";
  campaign: CampaignRow;
  sub: SubsequenceRow | null;
  status: number;
  running: boolean;
  steps: SequenceStep[];
  schedule: CampaignSchedule;
  /** The schedule on each of its leads' clocks when sending in each lead's timezone, else just the schedule. */
  schedules: CampaignSchedule[];
  /** Daily limit before slow ramp-up. */
  limit: number | null;
  /** Slow ramp-up: whole days since launch, today (null when off). */
  rampDay: number | null;
  /** Max new leads a day (campaigns only). */
  newCap: number | null;
  prioritizeNew: boolean;
  ignoreAccountLimit: boolean;
  senders: Box[];
  sentToday: number;
  newToday: number;
  /** Leads waiting, by day of the forecast and step. Today's include the ones already due. */
  due: number[][];
  dueNow: number;
  dueToday: number;
  nextDueAt: number | null;
  /** Today's estimate and what held the rest back. */
  more: number;
  openNow: boolean;
  minutesLeft: number;
  held: TodayFlow["held"];
}

interface Box {
  a: AccountRow;
  /** Free to send campaign emails from this moment (Infinity: not while it has an error or is paused). */
  usableFrom: number;
  rampDay: number;
  sentToday: number;
  warmupSent: number;
  warmupDays: number;
  flows: Flow[];
  /** Left on the day being worked out: by its daily limit, and by the time between its emails. */
  limitLeft: number;
  paceLeft: number;
  moreToday: number;
  /** The flows that use some of its room today. */
  takers: Set<Flow>;
  /** Today's room before any campaign takes from it, and what's still unused after. */
  roomToday: number;
  spareToday: number;
}

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, word: string, many = `${word}s`) => `${n(v)} ${v === 1 ? word : many}`;
const listNames = (names: string[]) => {
  const quoted = names.slice(0, 3).map((x) => `"${x}"`);
  const more = names.length - quoted.length;
  if (more > 0) return `${quoted.join(", ")} and ${plural(more, "other")}`;
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}` : (quoted[0] ?? "");
};

/** Minutes one mailbox waits between this campaign's emails, on average: the gap plus half the random wait. */
const gapMinutes = (c: CampaignRow, a: AccountRow) => Math.max(c.emailGap ?? 10, a.sendingGap ?? 0, 1 / 12) + (c.randomWaitMax ?? 0) / 2;
/** Emails one mailbox fits into this many open minutes. */
const paceFor = (minutes: number, gap: number) => (minutes > 0 ? Math.ceil(minutes / gap) : 0);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function flowLimit(f: Flow, day: number): number | null {
  if (f.rampDay === null) return f.limit;
  const ramp = CAMPAIGN_RAMP * (f.rampDay + day + 1);
  return f.limit === null ? ramp : Math.min(f.limit, ramp);
}

/** Where each lead stands: -1 due now, 0 later today, 1–6 a later day, 7 after the forecast, 99 not scheduled. */
function dayBucket(at: SQLWrapper, bounds: number[], now: number, nullBucket: SQLWrapper) {
  const later = bounds.slice(1).map((b, i) => sql`when ${at} < ${b} then ${i}`);
  return sql<number>`case when ${at} is null then ${nullBucket} when ${at} <= ${now} then -1 ${sql.join(later, sql` `)} else ${FORECAST_DAYS} end`;
}

export async function todayReport(workspaceId: string, opts: { mailboxes: boolean }, now: number = Date.now()): Promise<TodayReport> {
  const zone = await workspaceZone(workspaceId);
  // Midnights on the workspace clock: today's start, then the start of each later day (and the end of the last).
  const bounds = [startOfDayOn(zone, now)];
  for (let i = 0; i < FORECAST_DAYS; i++) bounds.push(startOfNextDayOn(zone, bounds[i]!));
  const dayStart = (d: number) => (d === 0 ? now : bounds[d]!);

  // Sent today, per campaign and subsequence.
  const sentRows = await db
    .select({ campaignId: E.campaignId, subsequenceId: E.subsequenceId, n: count(), first: sql<number>`sum(case when ${E.isFirst} then 1 else 0 end)` })
    .from(E)
    .where(and(eq(E.workspaceId, workspaceId), eq(E.type, "sent"), isNotNull(E.campaignId), gte(E.createdAt, new Date(bounds[0]!))))
    .groupBy(E.campaignId, E.subsequenceId);
  const sentBy = new Map(sentRows.map((r) => [r.subsequenceId ?? r.campaignId!, { n: Number(r.n), first: Number(r.first ?? 0) }]));
  const sentCampaigns = [...new Set(sentRows.map((r) => r.campaignId!))];

  const campaigns = await db
    .select()
    .from(C)
    .where(and(eq(C.workspaceId, workspaceId), or(inArray(C.status, [...RUNNING, ...STOPPED]), sentCampaigns.length ? inArray(C.id, sentCampaigns) : undefined)))
    .orderBy(asc(C.createdAt), asc(C.id));
  const subs = campaigns.length
    ? await db
        .select()
        .from(schema.subsequences)
        .where(and(inArray(schema.subsequences.parentCampaignId, campaigns.map((c) => c.id)), eq(schema.subsequences.status, CampaignStatus.ACTIVE)))
        .orderBy(asc(schema.subsequences.createdAt), asc(schema.subsequences.id))
    : [];

  // Mailboxes, with today's counters.
  const accounts = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, workspaceId)).orderBy(asc(schema.emailAccounts.email));
  const stats = await todayStats(accounts, now);
  const boxes = new Map<string, Box>(
    accounts.map((a) => {
      const s = stats.get(a.id);
      const resting = a.campaignPauseUntil && a.campaignPauseUntil.getTime() > now ? a.campaignPauseUntil.getTime() : 0;
      return [
        a.id,
        { a, usableFrom: a.status === AccountStatus.ACTIVE ? resting : Infinity, rampDay: s?.rampDay ?? 0, sentToday: s?.sent ?? 0, warmupSent: s?.warmupSent ?? 0, warmupDays: s?.warmupDays ?? 0, flows: [], limitLeft: 0, paceLeft: 0, moreToday: 0, takers: new Set(), roomToday: 0, spareToday: 0 },
      ];
    }),
  );

  // Hosted plans stop sending when the month's emails run out or the trial ends (self-hosted: no limit).
  const limits = await workspaceLimits(workspaceId);
  let planLeft = limits.self_hosted ? Infinity : limits.trial_expired ? 0 : limits.monthly_emails === null ? Infinity : Math.max(0, limits.monthly_emails - (await monthlyEmailsSent(workspaceId)));
  const planBlocked = planLeft <= 0;

  // The flows, in the order the sender takes them: each campaign, then its subsequences.
  const flows: Flow[] = [];
  const base = (f: Omit<Flow, "due" | "dueNow" | "dueToday" | "nextDueAt" | "more" | "openNow" | "minutesLeft" | "held" | "senders" | "sentToday" | "newToday"> & { senders: Box[] }): Flow => {
    const sent = sentBy.get(f.id);
    return {
      ...f,
      sentToday: sent?.n ?? 0,
      newToday: f.kind === "campaign" ? (sent?.first ?? 0) : 0,
      due: Array.from({ length: FORECAST_DAYS }, () => f.steps.map(() => 0)),
      dueNow: 0,
      dueToday: 0,
      nextDueAt: null,
      more: 0,
      openNow: false,
      minutesLeft: 0,
      held: [],
    };
  };
  for (const c of campaigns) {
    const senders = (await campaignSenders(c)).map((a) => boxes.get(a.id)).filter((b): b is Box => !!b);
    const parentRunning = RUNNING.includes(c.status);
    flows.push(
      base({
        id: c.id,
        kind: "campaign",
        campaign: c,
        sub: null,
        status: c.status,
        running: c.status === CampaignStatus.ACTIVE,
        steps: activeSteps(c),
        schedule: c.schedule ?? DEFAULT_SCHEDULE,
        schedules: await leadSchedules(c.schedule ?? DEFAULT_SCHEDULE, { kind: "campaign", id: c.id }, now),
        limit: c.dailyLimit ?? null,
        rampDay: c.slowRampUp && c.launchedAt ? Math.max(0, daysBetween(dayOn(zone, c.launchedAt), dayOn(zone, now))) : null,
        newCap: c.dailyMaxLeads || null,
        prioritizeNew: !!c.prioritizeNewLeads,
        ignoreAccountLimit: false,
        senders,
      }),
    );
    for (const sub of subs.filter((s) => s.parentCampaignId === c.id)) {
      flows.push(
        base({
          id: sub.id,
          kind: "subsequence",
          campaign: c,
          sub,
          status: sub.status,
          running: parentRunning,
          steps: sub.sequences?.[0]?.steps ?? [],
          schedule: sub.schedule ?? c.schedule ?? DEFAULT_SCHEDULE,
          schedules: await leadSchedules(sub.schedule ?? c.schedule ?? DEFAULT_SCHEDULE, { kind: "subsequence", id: sub.id }, now),
          limit: sub.dailyLimitMode === "unlimited" ? null : sub.dailyLimitMode === "custom" ? (sub.dailyLimit ?? null) : (c.dailyLimit ?? null),
          rampDay: null,
          newCap: null,
          prioritizeNew: false,
          ignoreAccountLimit: sub.ignoreAccountDailyLimit,
          senders,
        }),
      );
    }
  }

  // Leads waiting, by day and step. A campaign lead with no time set is due when it hasn't started; a subsequence
  // lead with no time set isn't scheduled. Task steps send nothing (the lead waits for its task).
  const byId = new Map(flows.map((f) => [f.id, f]));
  const place = (f: Flow | undefined, step: number, day: number, count: number) => {
    if (!f || step >= f.steps.length || day > FORECAST_DAYS - 1 || isTaskStep(f.steps[step])) return;
    if (day < 0) f.dueNow += count;
    f.due[Math.max(0, day)]![step]! += count;
  };
  const campaignIds = flows.filter((f) => f.kind === "campaign").map((f) => f.id);
  const subIds = flows.filter((f) => f.kind === "subsequence").map((f) => f.id);
  if (campaignIds.length) {
    const day = dayBucket(L.nextSendAt, bounds, now, sql`case when ${L.nextStep} = 0 then -1 else 99 end`);
    const rows = await db
      .select({ id: L.campaignId, step: L.nextStep, day, n: count() })
      .from(L)
      .where(and(eq(L.workspaceId, workspaceId), inArray(L.campaignId, campaignIds), eq(L.status, LeadStatus.ACTIVE)))
      .groupBy(sql`1`, sql`2`, sql`3`);
    for (const r of rows) place(byId.get(r.id!), r.step, Number(r.day), Number(r.n));
    const next = await db
      .select({ id: L.campaignId, at: sql<number>`min(${L.nextSendAt})` })
      .from(L)
      .where(and(eq(L.workspaceId, workspaceId), inArray(L.campaignId, campaignIds), eq(L.status, LeadStatus.ACTIVE), gt(L.nextSendAt, now)))
      .groupBy(L.campaignId);
    for (const r of next) if (byId.get(r.id!)) byId.get(r.id!)!.nextDueAt = Number(r.at);
  }
  if (subIds.length) {
    const day = dayBucket(L.subseqNextSendAt, bounds, now, sql`99`);
    const rows = await db
      .select({ id: L.subsequenceId, step: L.subseqNextStep, day, n: count() })
      .from(L)
      .where(and(eq(L.workspaceId, workspaceId), inArray(L.subsequenceId, subIds), eq(L.subseqStatus, LeadStatus.ACTIVE)))
      .groupBy(sql`1`, sql`2`, sql`3`);
    for (const r of rows) place(byId.get(r.id!), r.step, Number(r.day), Number(r.n));
    const next = await db
      .select({ id: L.subsequenceId, at: sql<number>`min(${L.subseqNextSendAt})` })
      .from(L)
      .where(and(eq(L.workspaceId, workspaceId), inArray(L.subsequenceId, subIds), eq(L.subseqStatus, LeadStatus.ACTIVE), gt(L.subseqNextSendAt, now)))
      .groupBy(L.subsequenceId);
    for (const r of next) if (byId.get(r.id!)) byId.get(r.id!)!.nextDueAt = Number(r.at);
  }
  for (const f of flows) f.dueToday = sum(f.due[0]!);

  const running = flows.filter((f) => f.running && f.status === CampaignStatus.ACTIVE && f.steps.length);
  for (const f of running) for (const b of f.senders) b.flows.push(f);
  const inUse = [...boxes.values()].filter((b) => b.flows.length);

  // Day by day: what each mailbox has left, then each flow in turn takes what it can, as the sender would.
  const forecast: TodayReport["forecast"] = [];
  let capacityToday = 0;
  for (let d = 0; d < FORECAST_DAYS; d++) {
    const start = dayStart(d);
    const end = bounds[d + 1]!;
    const open = new Map(running.map((f) => [f, sum(openSpans(f.schedules, start, end).map(([a, b]) => b - a)) / 60_000]));
    let capacity = 0;
    for (const b of inUse) {
      const usable = b.usableFrom <= start;
      b.limitLeft = usable ? Math.max(0, effectiveDailyLimit(b.a, { rampDay: b.rampDay + d }) - (d === 0 ? b.sentToday : 0)) : 0;
      b.paceLeft = usable ? Math.max(...b.flows.map((f) => paceFor(open.get(f)!, gapMinutes(f.campaign, b.a)))) : 0;
      capacity += Math.min(b.limitLeft, b.paceLeft);
      if (d === 0) b.roomToday = Math.min(b.limitLeft, b.paceLeft);
    }
    if (d === 0) capacityToday = capacity;
    let due = 0;
    let sends = 0;
    for (const f of running) {
      const waiting = f.due[d]!;
      const fresh = waiting[0] ?? 0;
      const followUps = sum(waiting) - fresh;
      due += fresh + followUps;
      const minutes = open.get(f)!;
      const newLeft = f.newCap === null ? Infinity : Math.max(0, f.newCap - (d === 0 ? f.newToday : 0));
      const lim = flowLimit(f, d);
      const limitLeft = lim === null ? Infinity : Math.max(0, lim - (d === 0 ? f.sentToday : 0));
      const usable = f.senders.filter((b) => b.usableFrom <= start);
      const freshOk = Math.min(fresh, newLeft);
      const allowed = Math.min(followUps + freshOk, limitLeft);
      const want = planBlocked || minutes <= 0 || !usable.length ? 0 : Math.min(allowed, planLeft);
      // What its mailboxes could give it: by their limits alone, and by the time between emails alone.
      const perBox = (b: Box) => Math.min(f.ignoreAccountLimit ? Infinity : b.limitLeft, b.paceLeft, paceFor(minutes, gapMinutes(f.campaign, b.a)));
      const byLimits = sum(usable.map((b) => (f.ignoreAccountLimit ? Infinity : b.limitLeft)));
      const byPace = sum(usable.map((b) => Math.min(b.paceLeft, paceFor(minutes, gapMinutes(f.campaign, b.a)))));
      let take = 0;
      for (const b of [...usable].sort((x, y) => perBox(y) - perBox(x))) {
        if (take >= want) break;
        const t = Math.min(want - take, perBox(b));
        if (t <= 0) continue;
        b.paceLeft -= t;
        if (!f.ignoreAccountLimit) b.limitLeft -= t;
        if (d === 0) {
          b.moreToday += t;
          b.takers.add(f);
        }
        take += t;
      }
      planLeft -= take;
      sends += take;

      if (d === 0) {
        f.more = take;
        f.openNow = anyOpen(f.schedules, now);
        f.minutesLeft = Math.round(minutes);
        const held: Array<[HoldReason, number, string]> = [];
        if (planBlocked) held.push(["plan", fresh + followUps, "Your plan's emails for this month are used up, or the trial has ended."]);
        else if (minutes <= 0) held.push(["schedule", fresh + followUps, closedToday(f.schedules, now)]);
        else if (!usable.length) {
          held.push(f.senders.length ? ["mailboxes_unavailable", fresh + followUps, unavailable(f.senders, now)] : ["no_mailboxes", fresh + followUps, "No mailboxes are attached."]);
        } else {
          // Each limit in the order the sender applies them; the last one that cuts anything decides today's number.
          if (fresh > freshOk) held.push(["new_lead_limit", fresh - freshOk, newLeft ? `Its limit of ${plural(f.newCap!, "new lead")} a day leaves room for ${n(newLeft)} more.` : `Its limit of ${plural(f.newCap!, "new lead")} a day is reached.`]);
          if (followUps + freshOk > allowed) {
            const ramping = f.rampDay !== null && (f.limit === null || lim! < f.limit);
            held.push(
              ramping
                ? ["ramp_up", followUps + freshOk - allowed, `Slow ramp-up allows ${plural(lim!, "email")} today, ${CAMPAIGN_RAMP} more each day.`]
                : ["campaign_limit", followUps + freshOk - allowed, limitLeft ? `Its daily limit of ${n(lim!)} leaves room for ${n(limitLeft)} more.` : `Its daily limit of ${n(lim!)} is reached.`],
            );
          }
          if (allowed > want) held.push(["plan", allowed - want, "Your plan has emails left for this month for only some of them."]);
          if (want > take) {
            const gap = Math.round(Math.min(...usable.map((b) => gapMinutes(f.campaign, b.a))));
            const one = usable.length === 1;
            // Campaigns that went first and used the room in the same mailboxes.
            const others = [...new Set(usable.flatMap((b) => [...b.takers]))].filter((x) => x !== f);
            const names = listNames([...new Set(others.map((x) => x.sub?.name ?? x.campaign.name))]);
            held.push(
              byPace < byLimits
                ? ["sending_gap", want - take, `Each mailbox waits about ${plural(gap, "minute")} between emails, so ${n(take)} more fit in today's window.`]
                : [
                    "mailbox_limits",
                    want - take,
                    others.length && !take
                      ? `Its ${one ? "mailbox is" : "mailboxes are"} shared with ${names}, which ${others.length === 1 ? "uses" : "use"} up today's room first.`
                      : others.length
                        ? `Its ${one ? "mailbox has" : "mailboxes have"} room for ${n(take)} more today; ${names} ${others.length === 1 ? "uses" : "use"} the rest.`
                        : take
                          ? `Its ${one ? "mailbox has" : "mailboxes have"} room for ${n(take)} more today.`
                          : `Its ${one ? "mailbox has" : "mailboxes have"} reached today's limit.`,
                  ],
            );
          }
        }
        // The first reason is the one holding emails back now (all of them); the rest would hold some back once it's
        // out of the way.
        const cut = held.filter(([, emails]) => emails > 0);
        const binding = cut.pop();
        f.held = binding ? [{ reason: binding[0], emails: fresh + followUps - take, text: binding[2] }, ...cut.reverse().map(([reason, emails, text]) => ({ reason, emails, text }))] : [];
      }

      // Sent leads move on to their next step; the rest wait for tomorrow.
      let left = take;
      const steps = [...f.steps.keys()];
      const order = f.prioritizeNew ? steps : [...steps.slice(1), 0];
      for (const k of order) {
        const s = Math.min(left, k === 0 ? freshOk : waiting[k]!);
        if (s <= 0) continue;
        left -= s;
        waiting[k]! -= s;
        const delay = Math.max(1, Math.round(delayToMs(f.steps[k]!.delay, f.steps[k]!.delay_unit) / DAY_MS));
        if (k + 1 < f.steps.length && d + delay < FORECAST_DAYS) f.due[d + delay]![k + 1]! += s;
      }
      if (d + 1 < FORECAST_DAYS) waiting.forEach((v, k) => (f.due[d + 1]![k]! += v));
    }
    if (d === 0) for (const b of inUse) b.spareToday = Math.min(b.limitLeft, b.paceLeft);
    forecast.push({ date: dayOn(zone, bounds[d]!), due, sends, capacity });
  }

  // Mailboxes in no running campaign could take their whole limit.
  for (const b of boxes.values()) if (!b.flows.length && b.usableFrom <= now) b.spareToday = Math.max(0, effectiveDailyLimit(b.a, { rampDay: b.rampDay }) - b.sentToday);

  // Stopped campaigns (and the subsequences of one) hold back what's due in them.
  for (const f of flows) {
    if (running.includes(f)) continue;
    f.openNow = anyOpen(f.schedules, now);
    const why =
      f.kind === "subsequence"
        ? "Its campaign isn't running."
        : f.status === CampaignStatus.PAUSED
          ? "The campaign is paused."
          : f.status === CampaignStatus.ACCOUNTS_UNHEALTHY
            ? "Stopped: every mailbox has an error. It starts again when one works."
            : f.status === CampaignStatus.BOUNCE_PROTECT
              ? "Stopped by bounce protection."
              : f.status === CampaignStatus.ACCOUNT_SUSPENDED
                ? "Stopped: the account is suspended."
                : f.status === CampaignStatus.RUNNING_SUBSEQUENCES
                  ? "Finished its own steps; its subsequences keep sending."
                  : "Not running.";
    f.held = f.dueToday ? [{ reason: "not_running", emails: f.dueToday, text: why }] : [];
  }

  const shown = flows.filter((f) => running.includes(f) || f.sentToday > 0 || f.dueToday > 0);
  const sent = sum([...sentBy.values()].map((s) => s.n));
  const more = forecast[0]!.sends;
  const due = forecast[0]!.due;
  const waitingInStopped = sum(flows.filter((f) => !running.includes(f)).map((f) => f.dueToday));
  const nextDue = running.map((f) => f.nextDueAt).filter((t): t is number => t !== null);

  const report: TodayReport = {
    now: iso(now)!,
    day: dayOn(zone, now),
    timezone: zone,
    resets_at: iso(bounds[1]!)!,
    sent,
    more,
    due,
    wont_fit: Math.max(0, due - more),
    waiting_in_stopped: waitingInStopped,
    next_due_at: nextDue.length ? iso(Math.min(...nextDue)) : null,
    capacity: {
      mailboxes: inUse.length,
      usable: inUse.filter((b) => b.usableFrom <= now).length,
      limit: sum(inUse.filter((b) => b.usableFrom <= now).map((b) => effectiveDailyLimit(b.a, { rampDay: b.rampDay }))),
      sent: sum(inUse.map((b) => b.sentToday)),
      left: capacityToday,
    },
    bottleneck: bottleneck(running, [...boxes.values()], now, { due, more, capacityToday, planBlocked, waitingInStopped }),
    flows: shown.map((f) => ({
      id: f.id,
      kind: f.kind,
      campaign_id: f.campaign.id,
      name: f.sub?.name ?? f.campaign.name,
      campaign_name: f.campaign.name,
      status: f.status,
      running: running.includes(f),
      sent_today: f.sentToday,
      due_today: f.dueToday,
      due_now: f.dueNow,
      more_today: f.more,
      daily_limit: flowLimit(f, 0),
      next_due_at: iso(f.nextDueAt),
      window: { open_now: f.openNow, minutes_left: f.minutesLeft, next_open_at: f.openNow ? null : iso(nextOpening(f.schedules, now)) },
      mailboxes: { attached: f.senders.length, usable: f.senders.filter((b) => b.usableFrom <= now).length },
      held: f.held,
      problem: f.kind === "campaign" && f.campaign.notSendingStatus !== null && PROBLEMS.has(f.campaign.notSendingStatus) ? `${NOT_SENDING_LABELS[f.campaign.notSendingStatus]}.` : null,
    })),
    mailboxes: opts.mailboxes ? [...boxes.values()].map((b) => mailboxRow(b, now)).sort((x, y) => Number(y.usable) - Number(x.usable) || y.sent_today - x.sent_today) : null,
    forecast,
  };
  return report;
}

function mailboxRow(b: Box, now: number): TodayMailbox {
  const a = b.a;
  const limit = effectiveDailyLimit(a, { rampDay: b.rampDay });
  const resting = a.campaignPauseUntil && a.campaignPauseUntil.getTime() > now ? a.campaignPauseUntil : null;
  const warmupOn = a.warmupStatus === WarmupStatus.ACTIVE;
  const usable = a.status === AccountStatus.ACTIVE && !resting && b.flows.length > 0;
  const note =
    a.status !== AccountStatus.ACTIVE
      ? (ACCOUNT_STATUS_LABELS[a.status] ?? "Not active")
      : resting
        ? "Resting"
        : !b.flows.length
          ? "Not in a running campaign"
          : b.sentToday >= limit
            ? "Reached today's limit"
            : a.enableSlowRamp && limit < (a.dailyLimit ?? 30)
              ? `Slow ramp: ${n(limit)} of ${n(a.dailyLimit ?? 30)} today`
              : null;
  return {
    id: a.id,
    email: a.email,
    status: a.status,
    usable,
    note,
    sent_today: b.sentToday,
    limit_today: limit,
    more_today: b.moreToday,
    warmup: { on: warmupOn, sent: b.warmupSent, target: warmupOn ? warmupTarget(a.warmup ?? defaultWarmup(), b.warmupDays) : 0 },
    last_sent_at: iso(a.lastSentAt),
    resting_until: iso(resting),
    campaigns: new Set(b.flows.map((f) => f.campaign.id)).size,
  };
}

/** Why a schedule sends nothing more today: a day off (on the schedule's calendar), or its window has closed. */
function closedToday(schedules: CampaignSchedule[], now: number): string {
  if (schedules.length > 1) return "Its sending window is closed for the rest of today on every lead's clock.";
  const schedule = schedules[0] ?? DEFAULT_SCHEDULE;
  const zone = schedule.schedules?.[0]?.timezone;
  const off = dayOffReason(schedule.days_off, dayOn(zone && isValidZone(zone) ? zone : "UTC", now));
  return off ? `Today is a day off: ${off === "Day off" ? "one of its own dates" : off}.` : "Its sending window is closed for the rest of today.";
}

/** Why none of a campaign's mailboxes can send: all resting, all with errors, all paused, or a mix. */
function unavailable(senders: Box[], now: number): string {
  const one = senders.length === 1;
  const all = (test: (a: AccountRow) => boolean) => senders.every((b) => test(b.a));
  if (all((a) => a.status === AccountStatus.ACTIVE && !!a.campaignPauseUntil && a.campaignPauseUntil.getTime() > now)) return one ? "Its mailbox is resting." : "Its mailboxes are resting.";
  if (all((a) => a.status < 0)) return one ? "Its mailbox has an error." : "Its mailboxes have errors.";
  if (all((a) => a.status === AccountStatus.PAUSED)) return one ? "Its mailbox is paused." : "Its mailboxes are paused.";
  return "Its mailboxes have errors, are paused or are resting.";
}

const optionsLink = (f: Flow) => ({
  label: "Open options",
  to: f.sub ? `/app/campaign/${f.campaign.id}/subsequences/${f.sub.id}/options` : `/app/campaign/${f.campaign.id}/options`,
});
const scheduleLink = (f: Flow) => ({
  label: "Open schedule",
  to: f.sub ? `/app/campaign/${f.campaign.id}/subsequences/${f.sub.id}/schedule` : `/app/campaign/${f.campaign.id}/schedule`,
});

/** The workspace's bottleneck today: the reason that holds back the most due emails, in words. */
function bottleneck(
  running: Flow[],
  boxes: Box[],
  now: number,
  t: { due: number; more: number; capacityToday: number; planBlocked: boolean; waitingInStopped: number },
): TodayReport["bottleneck"] {
  const campaignsLink = { label: "Campaigns", to: "/app/campaigns" };
  if (!running.length) {
    return {
      reason: "idle",
      title: "No campaign is sending",
      detail: t.waitingInStopped ? `${plural(t.waitingInStopped, "email")} due today wait in stopped campaigns.` : "Launch a campaign and what it sends today shows up here.",
      link: campaignsLink,
    };
  }
  if (t.planBlocked) {
    return { reason: "plan", title: "Your plan has stopped sending", detail: "This month's emails are used up or the trial has ended, so nothing more goes out.", link: { label: "Billing", to: "/app/settings/billing" } };
  }
  if (!t.due) {
    return {
      reason: "no_leads",
      title: "Nothing more is due today",
      detail: t.capacityToday ? `Your mailboxes have room for about ${plural(t.capacityToday, "more email")} today, but no leads are waiting.` : "No leads are waiting.",
      link: campaignsLink,
    };
  }
  const totals = new Map<HoldReason, { emails: number; flows: Flow[] }>();
  for (const f of running) {
    const h = f.held[0];
    if (!h) continue;
    const e = totals.get(h.reason) ?? { emails: 0, flows: [] };
    e.emails += h.emails;
    e.flows.push(f);
    totals.set(h.reason, e);
  }
  const top = [...totals.entries()].sort((a, b) => b[1].emails - a[1].emails)[0];
  if (!top) {
    return {
      reason: "on_track",
      title: "Everything due today fits",
      detail: `About ${plural(t.more, "more email")} go${t.more === 1 ? "es" : ""} out before the day resets.`,
      link: null,
    };
  }
  const [reason, { emails, flows }] = top;
  const names = listNames([...new Set(flows.map((f) => f.sub?.name ?? f.campaign.name))]);
  const one = flows.length === 1 ? flows[0]! : null;
  const held = plural(emails, "due email");
  // The mailboxes these campaigns send from, their room today, and the room left in all the others.
  const own = new Set(flows.flatMap((f) => f.senders.filter((b) => b.usableFrom <= now)));
  const room = sum([...own].map((b) => b.roomToday));
  const spare = sum(boxes.filter((b) => !own.has(b)).map((b) => b.spareToday));
  const theirs = own.size === 1 ? "the mailbox they send from has" : `the ${n(own.size)} mailboxes they send from have`;
  const said = describe();
  // Emails held back for other reasons (in other campaigns) are on their rows; say how many there are.
  const rest = sum([...totals.values()].map((x) => x.emails)) - emails;
  return rest > 0 ? { ...said, detail: `${said.detail} ${plural(rest, "more due email")} ${rest === 1 ? "waits" : "wait"} for other reasons, shown by campaign below.` } : said;

  function describe(): TodayReport["bottleneck"] {
    switch (reason) {
      case "schedule":
        return {
          reason,
          title: running.every((f) => f.minutesLeft <= 0) ? "Sending windows are closed for today" : "Some sending windows are closed for today",
          detail: `${held} in ${names} wait for the next sending window.`,
          link: one ? scheduleLink(one) : campaignsLink,
        };
      case "no_mailboxes":
        return { reason, title: "No mailboxes to send from", detail: `${held} in ${names} have no mailbox attached. Add mailboxes in the campaign's options.`, link: one ? optionsLink(one) : campaignsLink };
      case "mailboxes_unavailable":
        return { reason, title: "Mailboxes can't send", detail: `${held} wait because the mailboxes of ${names} have errors, are paused or are resting.`, link: { label: "Email accounts", to: "/app/accounts" } };
      case "new_lead_limit":
        return { reason, title: "The new-lead limit is the bottleneck", detail: `${plural(emails, "lead")} in ${names} wait for a first email because of the limit on new leads a day.`, link: one ? optionsLink(one) : campaignsLink };
      case "campaign_limit":
        return { reason, title: "Campaign daily limits are the bottleneck", detail: `${held} in ${names} are over the daily limit. Raise it in the campaign's options.`, link: one ? optionsLink(one) : campaignsLink };
      case "ramp_up":
        return { reason, title: "Slow ramp-up is the bottleneck", detail: `${names} ${flows.length === 1 ? "is" : "are"} ramping up, ${CAMPAIGN_RAMP} more emails each day, so ${held} wait.`, link: one ? optionsLink(one) : campaignsLink };
      case "sending_gap":
        return {
          reason,
          title: "The time between emails is the bottleneck",
          detail: `${held} won't fit today: each mailbox waits between emails, so ${theirs} room for about ${plural(room, "more email")} in today's sending windows. Shorten the gap or random wait, widen the window, or add mailboxes.`,
          link: one ? optionsLink(one) : campaignsLink,
        };
      case "mailbox_limits":
        return {
          reason,
          title: "Mailbox daily limits are the bottleneck",
          detail:
            `${held} won't fit today: ${theirs} room for about ${plural(room, "more email")}.` +
            (spare
              ? ` Your other mailboxes have room for about ${plural(spare, "more email")}: add them to ${names}, or connect more mailboxes.`
              : " Connect more mailboxes or raise their daily limits."),
          link: spare && one ? { label: "Choose mailboxes", to: optionsLink(one).to } : { label: "Email accounts", to: "/app/accounts" },
        };
      case "plan":
        return { reason, title: "Your plan is the bottleneck", detail: `${held} won't fit in the emails your plan has left this month.`, link: { label: "Billing", to: "/app/settings/billing" } };
      default:
        return { reason, title: "Some due emails wait", detail: `${held} in ${names} wait.`, link: campaignsLink };
    }
  }
}

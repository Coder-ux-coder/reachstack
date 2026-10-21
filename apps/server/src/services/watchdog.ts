// Send watchdog: notices running campaigns that should be sending but aren't. A campaign is stalled when, for longer
// than usual (three times its gap plus random wait, kept between 1 and 4 hours), its schedule was open, leads were due
// and nothing went out. The cause goes on the campaign as its not-sending reason (the campaign list and page show it),
// and the people who can see campaigns get one notification per stall: no more until the campaign sends again.
// Expected pauses (outside the schedule, a daily limit reached after sending, no lead due yet) aren't stalls.
import { and, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { CampaignNotSendingStatus as NS, CampaignStatus, LeadStatus, VerificationStatus, isTaskStep } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { engineStatus } from "../engine";
import { DEFAULT_SCHEDULE, isScheduleOpen } from "../lib/time";
import { on } from "./bus";
import { stoppedWorkspaces } from "./live-workspaces";
import { activeSteps, type CampaignRow } from "./campaigns";
import { campaignLink, notifiedSince, notify } from "./notifications";
import { startOfDayOn, workspaceZone } from "./workspace-clock";

const C = schema.campaigns;
const L = schema.leads;
const E = schema.emailEvents;
const MIN = 60_000;
const RUNNING = [CampaignStatus.ACTIVE, CampaignStatus.ACCOUNTS_UNHEALTHY];

/** Not-sending reasons the watchdog sets. The sender keeps them until the campaign sends again or another reason applies. */
export const WATCHDOG_REASONS: ReadonlySet<number> = new Set([NS.STALLED, NS.VERIFYING, NS.ERROR]);

/** How long a campaign may stay quiet while it could send. */
export function stallAfterMs(c: Pick<CampaignRow, "emailGap" | "randomWaitMax">): number {
  const usual = 3 * ((c.emailGap ?? 10) + (c.randomWaitMax ?? 10));
  return Math.min(240, Math.max(60, usual)) * MIN;
}

/** The last error the sender hit on each campaign (engine/sender.ts reports them; same process as the watchdog). */
const senderErrors = new Map<string, { at: number; message: string }>();

export function noteSenderError(campaignId: string, err: unknown) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300) || "Unknown error";
  senderErrors.set(campaignId, { at: Date.now(), message });
}

export function lastSenderError(campaignId: string): { at: number; message: string } | null {
  return senderErrors.get(campaignId) ?? null;
}

/** When the watchdog first saw each campaign running, so a launch, a resume or a restart gets a fair start. */
const runningSince = new Map<string, number>();
/** The campaign's last send when its stall was notified: one notification per stall. */
const notifiedFor = new Map<string, number>();

on("campaign_status_changed", (ev) => {
  runningSince.delete(String(ev.data.campaign_id));
});

/** Engine loop. */
export async function runWatchdog(now = Date.now()) {
  const rows = await db.select().from(C).where(inArray(C.status, RUNNING));
  const running = new Set(rows.map((c) => c.id));
  for (const id of [...runningSince.keys()]) {
    if (running.has(id)) continue;
    runningSince.delete(id);
    notifiedFor.delete(id);
  }
  const stopped = await stoppedWorkspaces();
  for (const c of rows) {
    if (stopped.has(c.workspaceId)) continue;
    try {
      await checkCampaign(c, now);
    } catch (err) {
      console.error(`[watchdog] campaign ${c.id}`, err);
    }
  }
}

/** Open at every five-minute mark from `from` to `to`. */
function openThroughout(schedule: CampaignRow["schedule"], from: number, to: number): boolean {
  for (let t = to; t > from; t -= 5 * MIN) if (!isScheduleOpen(schedule, t)) return false;
  return isScheduleOpen(schedule, from);
}

/** When the campaign itself (not its subsequences) last sent, in ms. */
async function lastSentAt(campaignId: string): Promise<number | null> {
  const [row] = await db
    .select({ at: sql<number | null>`max(${E.createdAt})` })
    .from(E)
    .where(and(eq(E.campaignId, campaignId), eq(E.type, "sent"), isNull(E.subsequenceId)));
  return row?.at ? Number(row.at) : null;
}

/** Active leads whose next email is due, the way the sender picks them (a lead at a task step waits for its task). */
function dueNow(c: CampaignRow, now: number) {
  const tasks = activeSteps(c).flatMap((s, i) => (isTaskStep(s) ? [i] : []));
  return and(eq(L.campaignId, c.id), eq(L.status, LeadStatus.ACTIVE), or(lte(L.nextSendAt, now), and(eq(L.nextStep, 0), isNull(L.nextSendAt))), tasks.length ? notInArray(L.nextStep, tasks) : undefined)!;
}

async function count(where: ReturnType<typeof and>) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(L).where(where);
  return Number(row?.n ?? 0);
}

/** Sent today on the workspace clock, the day the sender's daily limits count. */
async function sentToday(c: CampaignRow, now: number): Promise<number> {
  const since = startOfDayOn(await workspaceZone(c.workspaceId), now);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(E)
    .where(and(eq(E.campaignId, c.id), eq(E.type, "sent"), isNull(E.subsequenceId), gte(E.createdAt, new Date(since))));
  return Number(row?.n ?? 0);
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** "over an hour", "5 hours", "3 days". */
function quietFor(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 2) return "over an hour";
  if (h < 48) return `${Math.floor(h)} hours`;
  return `${Math.floor(h / 24)} days`;
}

export interface StallCause {
  /** The not-sending reason to set, or null when the sender already shows it (or the campaign status does). */
  code: number | null;
  text: string;
}

/** Why a campaign that could send didn't, or null when the quiet is expected. */
async function findCause(c: CampaignRow, now: number, lastSend: number | null): Promise<StallCause | null> {
  const sender = engineStatus().loops.find((l) => l.name === "sender");
  if (sender?.running && sender.last_started_at && now - Date.parse(sender.last_started_at) > 10 * MIN) {
    return { code: NS.STALLED, text: "The sending engine has been stuck on one pass for over 10 minutes. Restart the server to get it going again." };
  }
  if (c.status === CampaignStatus.ACCOUNTS_UNHEALTHY) {
    return { code: null, text: "Every sending account it uses has an error. Fix them on the Email accounts page and it carries on by itself." };
  }
  switch (c.notSendingStatus) {
    case NS.OUTSIDE_SCHEDULE:
    case NS.CAMPAIGN_DAILY_LIMIT:
    case NS.WAITING_FOR_LEAD:
      return null;
    case NS.ACCOUNTS_DAILY_LIMIT:
      // Full after a day's sending is normal. Full before it sent anything means other campaigns use up its mailboxes.
      if ((await sentToday(c, now)) > 0) return null;
      return { code: null, text: "Its sending accounts reached their daily limits before it sent anything today, probably used up by other campaigns. Add mailboxes or raise their limits." };
    case NS.NO_ACCOUNTS:
      return { code: null, text: "It has no sending accounts. Add some in the campaign's options." };
    case NS.ACCOUNTS_UNAVAILABLE:
      return { code: null, text: "Every sending account it uses has an error, is paused or is resting. Check them on the Email accounts page." };
    case NS.PLAN_LIMIT:
      return { code: null, text: "The workspace reached its plan's email limit." };
    case NS.EMPTY_STEP:
      return { code: null, text: "A step in its sequence has no email it can send: it's empty, or a {{variable}} isn't closed. Fix it on the Sequences tab." };
  }
  const err = senderErrors.get(c.id);
  if (err && now - err.at < stallAfterMs(c)) return { code: NS.ERROR, text: `Sending it fails with an error: ${sentence(err.message)}` };
  // The sender holds a lead's first email until its verification finishes.
  const pending = [VerificationStatus.PENDING, VerificationStatus.PENDING_JOB];
  const ready = await count(and(dueNow(c, now), or(sql`${L.nextStep} > 0`, notInArray(L.verificationStatus, pending))));
  if (!ready) return { code: NS.VERIFYING, text: "The leads that are due are all waiting for their email verification to finish." };
  const quiet = lastSend === null ? "It hasn't sent anything yet" : `Nothing has gone out for ${quietFor(now - lastSend)}`;
  // Provider rules that match no free mailbox leave leads waiting without a word; otherwise the server log says more.
  const hint = c.providerRoutingRules?.length ? "Its provider rules on the Options tab may leave the due leads without a mailbox." : "The server log may say more; restarting the server can help.";
  return { code: NS.STALLED, text: `${quiet}, though leads are due and its mailboxes are free. ${hint}` };
}

async function checkCampaign(c: CampaignRow, now: number) {
  if (!runningSince.has(c.id)) runningSince.set(c.id, now);
  const window = stallAfterMs(c);
  // Judge only a campaign that had a fair chance: running, with its schedule open, for the whole time.
  if (now - runningSince.get(c.id)! < window) return;
  if (!openThroughout(c.schedule ?? DEFAULT_SCHEDULE, now - window, now)) return;
  const lastSend = await lastSentAt(c.id);
  if (lastSend !== null && now - lastSend < window) return;
  if (!(await count(dueNow(c, now)))) return;
  const cause = await findCause(c, now, lastSend);
  if (!cause) return;
  if (cause.code !== null && c.notSendingStatus !== cause.code) {
    await db
      .update(C)
      .set({ notSendingStatus: cause.code })
      .where(and(eq(C.id, c.id), inArray(C.status, RUNNING)));
  }
  const marker = lastSend ?? 0;
  if (notifiedFor.get(c.id) === marker) return;
  const link = campaignLink(c.id);
  // Across restarts too: nothing new while a stall notification since the last send exists.
  if (!(await notifiedSince(c.workspaceId, "campaign_stalled", link, marker))) {
    await notify({ workspaceId: c.workspaceId, type: "campaign_stalled", title: `“${c.name}” stopped sending`, body: cause.text, link, perm: "view_campaigns", staffOnly: true });
  }
  notifiedFor.set(c.id, marker);
}

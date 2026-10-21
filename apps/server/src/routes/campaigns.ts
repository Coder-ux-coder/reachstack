// Campaigns (API v2 + app endpoints): CRUD, launch/pause, analytics, sharing, duplication, sending status,
// previews and test emails.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  AccountStatus,
  AuditActivity,
  CAMPAIGN_STATUS_LABELS,
  CampaignNotSendingStatus,
  CampaignStatus,
  LeadStatus,
  NOT_SENDING_LABELS,
  htmlToText,
  renderTemplate,
  textToHtml,
  type Sequence,
} from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound, badRequest, notFound } from "../http/errors";
import { body, query, zBool, zInt, zList } from "../http/util";
import { DEFAULT_SCHEDULE, anyOpen, iso, leadClock, nextOpening } from "../lib/time";
import { effectiveDailyLimit, sentByTwinsToday, todayStats } from "../services/accounts";
import { describeTemplateWarning, launchWarnings, personalizationCheck } from "../services/launch-check";
import { campaignBounceReport } from "../services/bounce-report";
import { actorOf, audit, type Actor } from "../services/audit";
import { emit } from "../services/bus";
import { leadSchedules } from "../services/lead-zones";
import { assertMembers } from "../services/members";
import { trashCampaign } from "../services/recently-deleted";
import { recordSequenceVersion } from "../services/sequence-versions";
import { lastSenderError, WATCHDOG_REASONS } from "../services/watchdog";
import {
  activeSteps,
  aggregateMetrics,
  campaignColumns,
  campaignSenders,
  campaignsForContact,
  createCampaignSchema,
  dailyMetrics,
  funnelCounts,
  insertCampaign,
  interestChangeTotals,
  interestTotals,
  launchProblems,
  leadCounts,
  metricsByCampaign,
  patchCampaignSchema,
  pausedBounceStats,
  rampedDailyLimit,
  serializeCampaign,
  serializeCampaigns,
  setCampaignStatus,
  stepMetrics,
  type CampaignRow,
  type SubsequenceRow,
} from "../services/campaigns";
import { moveLeads } from "../services/leads";
import { resourcesWithTags } from "../services/tags";
import { startOfDayOn, workspaceRange, workspaceZone } from "../services/workspace-clock";
import { getWorkspaceSetting } from "../services/workspaces";
import { blankEmail, sendTestEmail, sendsTextOnly, templateVars } from "../engine/sender";

const C = schema.campaigns;
const L = schema.leads;

/** Share links work for this many days after the campaign was last shared. */
const SHARE_DAYS = 7;
const sharedNow = () => and(isNotNull(C.shareToken), gt(C.shareExpiresAt, new Date()));

export async function findCampaign(wsId: string, id: string): Promise<CampaignRow> {
  const [row] = await db.select().from(C).where(and(eq(C.id, id), eq(C.workspaceId, wsId))).limit(1);
  return assertFound(row, "Campaign");
}

async function campaignIdsWithStatus(wsId: string, status?: number): Promise<string[] | null> {
  if (status === undefined) return null;
  const rows = await db.select({ id: C.id }).from(C).where(and(eq(C.workspaceId, wsId), eq(C.status, status)));
  return rows.map((r) => r.id);
}

/**
 * Copyable settings of a campaign (no status, timestamps, share token or ownership). From another workspace (a shared
 * campaign), what belongs to that workspace stays there: its mailboxes and tags, its Sales Agent, and the addresses
 * its emails are copied to.
 */
function copyableColumns(src: CampaignRow, sameWorkspace: boolean): Partial<typeof C.$inferInsert> {
  const {
    id: _id,
    workspaceId: _ws,
    status: _st,
    createdAt: _ca,
    updatedAt: _ua,
    launchedAt: _la,
    completedAt: _co,
    lastSendAt: _ls,
    shareToken: _sh,
    shareExpiresAt: _se,
    notSendingStatus: _ns,
    bounceGraceUntil: _bg,
    createdBy: _cb,
    ownedBy: _ob,
    ...rest
  } = src;
  return sameWorkspace ? rest : { ...rest, emailList: [], emailTagList: [], aiSdrId: null, ccList: [], bccList: [] };
}

/**
 * Moves campaigns, with their leads, subsequences, analytics events, tags and sequence versions, into Recently deleted:
 * one entry per campaign, restorable for 30 days. Their emails stay in the Unibox. Returns the entries' ids.
 */
async function deleteCampaigns(rows: CampaignRow[], actor: Actor): Promise<string[]> {
  const entries: string[] = [];
  for (const row of rows) {
    entries.push(await trashCampaign(row, actor));
    emit("campaign_status_changed", row.workspaceId, { campaign_id: row.id, status: "deleted" });
  }
  return entries;
}

// ---------- Sending status ----------

/** Why a campaign (or subsequence) that isn't running isn't, as the end of a sentence. */
const NOT_RUNNING: Record<number, string> = {
  [CampaignStatus.DRAFT]: "hasn't been launched yet",
  [CampaignStatus.PAUSED]: "is paused",
  [CampaignStatus.COMPLETED]: "has finished",
  [CampaignStatus.BOUNCE_PROTECT]: "was paused by bounce protection",
  [CampaignStatus.ACCOUNTS_UNHEALTHY]: "is waiting for its sending accounts to be fixed",
  [CampaignStatus.ACCOUNT_SUSPENDED]: "is stopped because the account is suspended",
};

export async function sendingStatus(c: CampaignRow, sub: SubsequenceRow | null = null) {
  const schedule = (sub?.schedule ?? c.schedule ?? DEFAULT_SCHEDULE)!;
  const tz = schedule.schedules?.[0]?.timezone ?? "UTC";
  // Sending in each lead's timezone: the schedule on each of its leads' clocks.
  const schedules = await leadSchedules(schedule, sub ? { kind: "subsequence", id: sub.id } : { kind: "campaign", id: c.id });
  const open = anyOpen(schedules);
  const nextOpen = open ? null : nextOpening(schedules);
  const senders = await campaignSenders(c);
  const stats = await todayStats(senders);
  // A daily limit is the address's: what it sent from another workspace today counts too.
  const twins = await sentByTwinsToday(senders);
  const accounts = senders.map((a) => ({
    email: a.email,
    status: a.status,
    daily_limit: effectiveDailyLimit(a, stats.get(a.id)),
    sent_today: (stats.get(a.id)?.sent ?? 0) + (twins.get(a.email) ?? 0),
    resting_until: a.campaignPauseUntil && a.campaignPauseUntil.getTime() > Date.now() ? iso(a.campaignPauseUntil) : null,
  }));
  const healthy = accounts.filter((a) => a.status === AccountStatus.ACTIVE && !a.resting_until);
  const withCapacity = healthy.filter((a) => a.sent_today < a.daily_limit);
  const now = Date.now();
  const scope = sub ? eq(L.subsequenceId, sub.id) : eq(L.campaignId, c.id);
  const statusCol = sub ? L.subseqStatus : L.status;
  const nextCol = sub ? L.subseqNextSendAt : L.nextSendAt;
  const [counts] = await db
    .select({
      active: sql<number>`sum(case when ${statusCol} = ${LeadStatus.ACTIVE} then 1 else 0 end)`,
      due: sql<number>`sum(case when ${statusCol} = ${LeadStatus.ACTIVE} and (${nextCol} <= ${now} ${sub ? sql`` : sql`or (${L.nextStep} = 0 and ${L.nextSendAt} is null)`}) then 1 else 0 end)`,
      completed: sql<number>`sum(case when ${statusCol} = ${LeadStatus.COMPLETED} then 1 else 0 end)`,
      next_due: sql<number | null>`min(case when ${statusCol} = ${LeadStatus.ACTIVE} and ${nextCol} > ${now} then ${nextCol} end)`,
      // Held at a task step (services/sequence-tasks.ts): no send time until the task is done or skipped.
      on_tasks: sql<number>`sum(case when ${statusCol} = ${LeadStatus.ACTIVE} and ${nextCol} is null ${sub ? sql`` : sql`and ${L.nextStep} > 0`} then 1 else 0 end)`,
    })
    .from(L)
    .where(scope);
  // Daily limits reset at midnight on the workspace clock, as in the sender.
  const zone = await workspaceZone(c.workspaceId);
  const startOfDay = new Date(startOfDayOn(zone));
  const [sent] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.emailEvents)
    .where(
      and(
        eq(schema.emailEvents.type, "sent"),
        sub ? eq(schema.emailEvents.subsequenceId, sub.id) : and(eq(schema.emailEvents.campaignId, c.id), isNull(schema.emailEvents.subsequenceId)),
        gte(schema.emailEvents.createdAt, startOfDay),
      ),
    );
  const ownLimit = (sub ? (sub.dailyLimitMode === "unlimited" ? null : sub.dailyLimitMode === "custom" ? sub.dailyLimit : c.dailyLimit) : c.dailyLimit) ?? null;
  // The slow ramp-up holds a new campaign below its own limit, as the sender does.
  const dailyLimit = sub ? ownLimit : rampedDailyLimit(c, ownLimit, zone);
  const sentToday = Number(sent?.n ?? 0);
  const status = sub ? sub.status : c.status;
  const due = Number(counts?.due ?? 0);
  const reasons: string[] = [];
  if (status !== CampaignStatus.ACTIVE && !(status === CampaignStatus.RUNNING_SUBSEQUENCES && !sub)) {
    reasons.push(`The ${sub ? "subsequence" : "campaign"} ${NOT_RUNNING[status] ?? `is ${(CAMPAIGN_STATUS_LABELS[status] ?? "inactive").toLowerCase()}`}.`);
  }
  if (sub && c.status !== CampaignStatus.ACTIVE && c.status !== CampaignStatus.RUNNING_SUBSEQUENCES) reasons.push("The parent campaign is not running.");
  if (!open) {
    const where = schedule.lead_timezone ? " on every lead's clock" : "";
    reasons.push(nextOpen ? `Outside the sending schedule${where}. The next window opens at ${new Date(nextOpen).toISOString()}.` : "The schedule has no upcoming sending window.");
  }
  if (!accounts.length) reasons.push("No sending accounts are attached.");
  else if (!healthy.length) reasons.push("Every sending account has an error, is paused or is resting.");
  else if (!withCapacity.length && !sub?.ignoreAccountDailyLimit) reasons.push("Every sending account has reached its daily limit.");
  if (dailyLimit !== null && sentToday >= dailyLimit) {
    reasons.push(dailyLimit !== ownLimit ? `The slow ramp-up allows ${dailyLimit} emails today, 20 more each day, and they've gone out.` : `The daily limit of ${dailyLimit} emails has been reached.`);
  }
  const onTasks = Number(counts?.on_tasks ?? 0);
  if (!Number(counts?.active ?? 0)) reasons.push("There are no active leads.");
  else if (!due) {
    const next = counts?.next_due ? ` The next one is due at ${new Date(Number(counts.next_due)).toISOString()}.` : "";
    reasons.push(onTasks ? `${onTasks === 1 ? "1 lead waits for a task you do by hand: find it" : `${onTasks} leads wait for tasks you do by hand: find them`} on Today. No other leads are due yet.${next}` : `No leads are due yet.${next}`);
  }
  // What the send watchdog found (services/watchdog.ts): it stays until the campaign sends again.
  const stalled = !sub && c.notSendingStatus !== null && WATCHDOG_REASONS.has(c.notSendingStatus) ? c.notSendingStatus : null;
  if (stalled !== null) {
    const err = stalled === CampaignNotSendingStatus.ERROR ? lastSenderError(c.id) : null;
    reasons.push(err ? `Sending fails with an error: ${err.message}` : `${NOT_SENDING_LABELS[stalled]}.`);
  }
  const sending = reasons.length === 0;
  // Nothing wrong: what's left waits for tasks done by hand.
  const waitingForTasks = !sending && onTasks > 0 && !due && reasons.length === 1;
  return {
    diagnostics: {
      status,
      not_sending_status: sub ? null : c.notSendingStatus,
      not_sending_reason: sub || !c.notSendingStatus ? null : (NOT_SENDING_LABELS[c.notSendingStatus] ?? null),
      schedule_open: open,
      next_schedule_opening: nextOpen ? new Date(nextOpen).toISOString() : null,
      timezone: tz,
      lead_timezone: !!schedule.lead_timezone,
      daily_limit: dailyLimit ?? null,
      sent_today: sentToday,
      accounts: { total: accounts.length, healthy: healthy.length, with_capacity: withCapacity.length, items: accounts },
      leads: {
        active: Number(counts?.active ?? 0),
        due_now: due,
        waiting_for_tasks: onTasks,
        completed: Number(counts?.completed ?? 0),
        next_due_at: counts?.next_due ? new Date(Number(counts.next_due)).toISOString() : null,
      },
      last_send_at: iso(c.lastSendAt),
    },
    summary: {
      is_sending: sending,
      waiting_for_tasks: waitingForTasks,
      title: sending
        ? `Sending: ${due} lead${due === 1 ? "" : "s"} due across ${withCapacity.length} account${withCapacity.length === 1 ? "" : "s"}.`
        : stalled !== null
          ? "Stopped sending"
          : waitingForTasks
            ? "Waiting for your tasks"
            : "Not sending right now",
      reasons,
    },
  };
}

// ---------- Routes ----------

export default async function campaignRoutes(app: FastifyInstance) {
  const read = { scope: ["campaigns", "read"] as ["campaigns", "read"], perm: "view_campaigns" as const };
  const create = { scope: ["campaigns", "create"] as ["campaigns", "create"], perm: "edit_campaigns" as const, write: true };
  const update = { scope: ["campaigns", "update"] as ["campaigns", "update"], perm: "edit_campaigns" as const, write: true };
  const del = { scope: ["campaigns", "delete"] as ["campaigns", "delete"], perm: "edit_campaigns" as const, write: true };
  const analytics = { scope: ["campaigns", "read"] as ["campaigns", "read"], perm: "analytics" as const };

  app.post("/api/v2/campaigns", { config: create }, async (req) => {
    const c = ctx(req);
    const b = body(req, createCampaignSchema);
    await assertMembers(c.wsId, [b.owned_by], "owned_by");
    const row = await insertCampaign(c.wsId, c.userId, { ...campaignColumns(b), name: b.name });
    await recordSequenceVersion({ workspaceId: c.wsId, campaignId: row.id, before: null, after: row.sequences, actor: actorOf(req), source: "create" });
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.CAMPAIGN_UPDATE, req, campaignId: row.id, metadata: { action: "create", name: row.name } });
    return serializeCampaign(row);
  });

  app.get("/api/v2/campaigns", { config: read }, async (req) => {
    const q = query(
      req,
      z.object({
        limit: zInt(1, 100).optional(),
        starting_after: z.string().optional(),
        search: z.string().optional(),
        tag_ids: zList,
        ai_sales_agent_id: z.string().optional(),
        status: zInt().optional(),
        exclude_status: zInt().optional(),
        include_ai_sales_agent_campaigns: zBool,
      }),
    );
    const c = ctx(req);
    const limit = q.limit ?? 10;
    const conds: SQL[] = [eq(C.workspaceId, c.wsId)];
    if (q.search) conds.push(contains(C.name, q.search));
    if (q.status !== undefined) conds.push(eq(C.status, q.status));
    if (q.exclude_status !== undefined) conds.push(ne(C.status, q.exclude_status));
    if (q.ai_sales_agent_id) conds.push(eq(C.aiSdrId, q.ai_sales_agent_id));
    else if (!q.include_ai_sales_agent_campaigns) conds.push(isNull(C.aiSdrId));
    if (q.tag_ids?.length) conds.push(inArray(C.id, [...(await resourcesWithTags(c.wsId, q.tag_ids, "any")), "__none__"]));
    if (q.starting_after) conds.push(lt(C.id, q.starting_after));
    const rows = await db.select().from(C).where(and(...conds)).orderBy(desc(C.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: await serializeCampaigns(c.wsId, page), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  // Static paths are registered before "/:id" so they never match as ids.
  app.get("/api/v2/campaigns/count-launched", { config: read }, async (req) => {
    const [row] = await db.select({ n: sql<number>`count(*)` }).from(C).where(and(eq(C.workspaceId, ctx(req).wsId), isNotNull(C.launchedAt)));
    return { count: Number(row?.n ?? 0) };
  });

  app.get("/api/v2/campaigns/search-by-contact", { config: read }, async (req) => {
    const q = query(req, z.object({ search: z.string().min(3), sort_column: z.string().optional(), sort_order: z.enum(["asc", "desc"]).optional() }));
    const c = ctx(req);
    let rows = await campaignsForContact(c.wsId, q.search.trim());
    if (q.sort_column) {
      const key = q.sort_column === "name" ? "name" : "createdAt";
      rows = [...rows].sort((a, b) => (a[key]! > b[key]! ? 1 : -1) * (q.sort_order === "desc" ? -1 : 1));
    }
    return { items: await serializeCampaigns(c.wsId, rows) };
  });

  app.get("/api/v2/campaigns/analytics", { config: analytics }, async (req) => {
    const q = query(req, z.object({ id: z.string().optional(), ids: zList, start_date: z.string().optional(), end_date: z.string().optional(), exclude_total_leads_count: zBool }));
    const c = ctx(req);
    const ids = q.id ? [q.id] : (q.ids ?? []);
    const rows = await db
      .select()
      .from(C)
      .where(and(eq(C.workspaceId, c.wsId), ids.length ? inArray(C.id, ids) : undefined))
      .orderBy(desc(C.createdAt));
    const range = await workspaceRange(c.wsId, q.start_date, q.end_date);
    const metrics = await metricsByCampaign(c.wsId, rows.map((r) => r.id), range);
    const counts = await leadCounts(c.wsId, rows.map((r) => r.id));
    return rows.map((r) => {
      const m = metrics.get(r.id);
      const lc = counts.get(r.id);
      return {
        campaign_name: r.name,
        campaign_id: r.id,
        campaign_status: r.status,
        campaign_is_evergreen: !!r.isEvergreen,
        ...(q.exclude_total_leads_count ? {} : { leads_count: lc?.total ?? 0 }),
        contacted_count: m?.contacted_count ?? 0,
        emails_sent_count: m?.emails_sent_count ?? 0,
        emails_refused_count: m?.emails_refused_count ?? 0,
        new_leads_contacted_count: m?.new_leads_contacted_count ?? 0,
        open_count: m?.open_count_unique ?? 0,
        open_count_unique: m?.open_count_unique ?? 0,
        open_count_unique_by_step: m?.open_count_unique_by_step ?? 0,
        reply_count: m?.reply_count ?? 0,
        reply_count_unique: m?.reply_count_unique ?? 0,
        reply_count_unique_by_step: m?.reply_count_unique_by_step ?? 0,
        reply_count_automatic: m?.reply_count_automatic ?? 0,
        reply_count_automatic_unique: m?.reply_count_automatic_unique ?? 0,
        reply_count_automatic_unique_by_step: m?.reply_count_automatic_unique_by_step ?? 0,
        link_click_count: m?.link_click_count ?? 0,
        link_click_count_unique: m?.link_click_count_unique ?? 0,
        link_click_count_unique_by_step: m?.link_click_count_unique_by_step ?? 0,
        bounced_count: m?.bounced_count ?? 0,
        unsubscribed_count: m?.unsubscribed_count ?? 0,
        completed_count: lc?.completed ?? 0,
        total_opportunities: m?.total_opportunities ?? 0,
        total_opportunity_value: m?.total_opportunity_value ?? 0,
      };
    });
  });

  app.get("/api/v2/campaigns/analytics/overview", { config: analytics }, async (req) => {
    const q = query(
      req,
      z.object({ id: z.string().optional(), ids: zList, start_date: z.string().optional(), end_date: z.string().optional(), campaign_status: zInt().optional(), expand_crm_events: zBool }),
    );
    const c = ctx(req);
    let ids: string[] | null = q.id ? [q.id] : q.ids?.length ? q.ids : null;
    const byStatus = await campaignIdsWithStatus(c.wsId, q.campaign_status);
    if (byStatus) ids = ids ? ids.filter((i) => byStatus.includes(i)) : byStatus;
    const range = await workspaceRange(c.wsId, q.start_date, q.end_date);
    const m = await aggregateMetrics(c.wsId, ids, range);
    // Each lead once by where it is now, or (expand_crm_events) every change of status in the period.
    const interest = q.expand_crm_events ? await interestChangeTotals(c.wsId, ids, range) : { ...(await interestTotals(c.wsId, ids, range)), total_opportunities: m.total_opportunities };
    // Campaign ids from the request count only when they're the workspace's own.
    const allIds = ids && !ids.length ? [] : (await db.select({ id: C.id }).from(C).where(and(eq(C.workspaceId, c.wsId), ids ? inArray(C.id, ids) : undefined))).map((r) => r.id);
    const counts = await leadCounts(c.wsId, allIds);
    let completed = 0;
    for (const v of counts.values()) completed += v.completed;
    return {
      open_count: m.open_count,
      open_count_unique: m.open_count_unique,
      open_count_unique_by_step: m.open_count_unique_by_step,
      link_click_count: m.link_click_count,
      link_click_count_unique: m.link_click_count_unique,
      link_click_count_unique_by_step: m.link_click_count_unique_by_step,
      reply_count: m.reply_count,
      reply_count_unique: m.reply_count_unique,
      reply_count_unique_by_step: m.reply_count_unique_by_step,
      reply_count_automatic: m.reply_count_automatic,
      reply_count_automatic_unique: m.reply_count_automatic_unique,
      reply_count_automatic_unique_by_step: m.reply_count_automatic_unique_by_step,
      bounced_count: m.bounced_count,
      unsubscribed_count: m.unsubscribed_count,
      completed_count: completed,
      emails_sent_count: m.emails_sent_count,
      emails_refused_count: m.emails_refused_count,
      contacted_count: m.contacted_count,
      new_leads_contacted_count: m.new_leads_contacted_count,
      total_opportunities: interest.total_opportunities,
      total_opportunity_value: m.total_opportunity_value,
      total_interested: interest.total_interested,
      total_meeting_booked: interest.total_meeting_booked,
      total_meeting_completed: interest.total_meeting_completed,
      total_closed: interest.total_closed,
    };
  });

  /** The analytics page's funnel: leads that reached each stage in the period (see funnelCounts). */
  app.get("/api/app/analytics/funnel", { config: { perm: "analytics" } }, async (req) => {
    const q = query(req, z.object({ id: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional(), campaign_status: zInt().optional() }));
    const c = ctx(req);
    let ids: string[] | null = q.id ? [q.id] : null;
    const byStatus = await campaignIdsWithStatus(c.wsId, q.campaign_status);
    if (byStatus) ids = ids ? ids.filter((i) => byStatus.includes(i)) : byStatus;
    return funnelCounts(c.wsId, ids, await workspaceRange(c.wsId, q.start_date, q.end_date));
  });

  app.get("/api/v2/campaigns/analytics/daily", { config: analytics }, async (req) => {
    const q = query(req, z.object({ campaign_id: z.string().optional(), ids: zList, start_date: z.string().optional(), end_date: z.string().optional(), campaign_status: zInt().optional() }));
    const c = ctx(req);
    // One campaign, several (`ids`), or all of them.
    let ids: string[] | null = q.campaign_id ? [q.campaign_id] : q.ids?.length ? q.ids : null;
    const byStatus = await campaignIdsWithStatus(c.wsId, q.campaign_status);
    if (byStatus) ids = ids ? ids.filter((i) => byStatus.includes(i)) : byStatus;
    return dailyMetrics(c.wsId, ids, await workspaceRange(c.wsId, q.start_date, q.end_date));
  });

  app.get("/api/v2/campaigns/analytics/steps", { config: analytics }, async (req) => {
    const q = query(req, z.object({ campaign_id: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional(), include_opportunities_count: zBool }));
    const c = ctx(req);
    return stepMetrics(c.wsId, q.campaign_id ? [q.campaign_id] : null, await workspaceRange(c.wsId, q.start_date, q.end_date), !!q.include_opportunities_count);
  });

  app.get("/api/v2/campaigns/:id", { config: read }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const out = (await serializeCampaigns(c.wsId, [row]))[0]!;
    // A bounce pause shows the numbers behind it.
    return row.status === CampaignStatus.BOUNCE_PROTECT ? { ...out, bounce_stats: await pausedBounceStats(row.id) } : out;
  });

  app.patch("/api/v2/campaigns/:id", { config: update }, async (req) => {
    const c = ctx(req);
    const current = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const b = body(req, patchCampaignSchema);
    await assertMembers(c.wsId, [b.owned_by], "owned_by");
    const patch = campaignColumns(b);
    if (!Object.keys(patch).length) return serializeCampaign(current);
    const [row] = await db.update(C).set(patch).where(eq(C.id, current.id)).returning();
    // A changed sequence is kept as a version (Sequences tab → Versions).
    if (patch.sequences) await recordSequenceVersion({ workspaceId: c.wsId, campaignId: current.id, before: current.sequences, after: row!.sequences, beforeAt: current.updatedAt, actor: actorOf(req) });
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.CAMPAIGN_UPDATE, req, campaignId: current.id, metadata: { fields: Object.keys(b) } });
    return serializeCampaign(row!);
  });

  // The campaign waits in Recently deleted for 30 days (the answer carries the entry, for an undo).
  app.delete("/api/v2/campaigns/:id", { config: del }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const [entryId] = await deleteCampaigns([row], actorOf(req));
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.CAMPAIGN_DELETION, req, campaignId: row.id, metadata: { name: row.name } });
    return { ...serializeCampaign(row), recently_deleted_id: entryId };
  });

  app.post("/api/v2/campaigns/:id/activate", { config: update }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    if (row.status === CampaignStatus.ACTIVE) return serializeCampaign(row);
    if (row.status === CampaignStatus.ACCOUNT_SUSPENDED) throw badRequest("This campaign is suspended and cannot be activated.");
    const problems = await launchProblems(row);
    if (problems.length) throw badRequest(problems[0]!, { problems });
    const updated = await setCampaignStatus(row, CampaignStatus.ACTIVE);
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.CAMPAIGN_LAUNCH, req, campaignId: row.id, metadata: { name: row.name } });
    return serializeCampaign(updated);
  });

  app.post("/api/v2/campaigns/:id/pause", { config: update }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    if (row.status === CampaignStatus.PAUSED) return serializeCampaign(row);
    const updated = await setCampaignStatus(row, CampaignStatus.PAUSED);
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.CAMPAIGN_PAUSE, req, campaignId: row.id, metadata: { name: row.name } });
    return serializeCampaign(updated);
  });

  app.post("/api/v2/campaigns/:id/share", { config: update }, async (req, reply) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    // Each share opens the link for another 7 days.
    await db
      .update(C)
      .set({ shareToken: row.shareToken ?? randomBytes(12).toString("base64url"), shareExpiresAt: new Date(Date.now() + SHARE_DAYS * 86_400_000) })
      .where(eq(C.id, row.id));
    return reply.code(204).send();
  });

  // Imports a campaign another workspace shared (its id comes from the share link).
  app.post("/api/v2/campaigns/:id/from-export", { config: create }, async (req) => {
    const c = ctx(req);
    const [src] = await db
      .select()
      .from(C)
      .where(and(eq(C.id, (req.params as { id: string }).id), sharedNow()))
      .limit(1);
    if (!src) throw notFound("Shared campaign");
    const row = await insertCampaign(c.wsId, c.userId, { ...copyableColumns(src, src.workspaceId === c.wsId), name: src.name });
    await recordSequenceVersion({ workspaceId: c.wsId, campaignId: row.id, before: null, after: row.sequences, actor: actorOf(req), source: "create" });
    return serializeCampaign(row);
  });

  app.post("/api/v2/campaigns/:id/export", { config: read }, async (req) => {
    const c = ctx(req);
    return serializeCampaign(await findCampaign(c.wsId, (req.params as { id: string }).id));
  });

  app.post("/api/v2/campaigns/:id/duplicate", { config: create }, async (req) => {
    const c = ctx(req);
    const src = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(250).optional(), copy_leads: z.boolean().optional(), copy_subsequences: z.boolean().optional() }));
    const row = await insertCampaign(c.wsId, c.userId, { ...copyableColumns(src, true), name: b.name ?? `${src.name} (copy)` });
    await recordSequenceVersion({ workspaceId: c.wsId, campaignId: row.id, before: null, after: row.sequences, actor: actorOf(req), source: "create" });
    if (b.copy_subsequences !== false) {
      const subs = await db.select().from(schema.subsequences).where(eq(schema.subsequences.parentCampaignId, src.id));
      for (const s of subs) {
        const { id: _id, createdAt: _c, updatedAt: _u, leadsUpdatedAt: _l, parentCampaignId: _p, ...rest } = s;
        const [copy] = await db
          .insert(schema.subsequences)
          .values({ ...rest, parentCampaignId: row.id })
          .returning();
        await recordSequenceVersion({ workspaceId: c.wsId, campaignId: row.id, subsequenceId: copy!.id, before: null, after: copy!.sequences, actor: actorOf(req), source: "create" });
      }
    }
    if (b.copy_leads) {
      // A page at a time, so a big campaign never sits in memory whole. The copies start from the first step with none
      // of the old campaign's activity or labels; whoever bounced or unsubscribed stays that way.
      for (let after = ""; ; ) {
        const ids = (await db.select({ id: L.id }).from(L).where(and(eq(L.campaignId, src.id), eq(L.workspaceId, c.wsId), gt(L.id, after))).orderBy(asc(L.id)).limit(1000)).map((r) => r.id);
        if (!ids.length) break;
        await moveLeads({ workspaceId: c.wsId, leadIds: ids, toCampaignId: row.id, copy: true, resetInterestStatus: true });
        after = ids[ids.length - 1]!;
      }
    }
    return serializeCampaign(row);
  });

  app.post("/api/v2/campaigns/:id/variables", { config: update }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object({ variables: z.array(z.string().trim().min(1).max(100)).min(1) }));
    const merged = [...new Set([...(row.customVariables ?? []), ...b.variables])];
    const [updated] = await db.update(C).set({ customVariables: merged }).where(eq(C.id, row.id)).returning();
    return serializeCampaign(updated!);
  });

  app.get("/api/v2/campaigns/:id/sending-status", { config: read }, async (req) => {
    const c = ctx(req);
    return sendingStatus(await findCampaign(c.wsId, (req.params as { id: string }).id));
  });

  // ---------- App endpoints ----------

  /** Campaign table: campaigns plus progress and headline metrics, sortable. */
  /** Every campaign's name, newest first, for the pickers (moving leads, filters): all of them, not a first page. */
  app.get("/api/app/campaigns/names", { config: { perm: "view_campaigns" } }, async (req) => {
    const rows = await db.select({ id: C.id, name: C.name, status: C.status }).from(C).where(eq(C.workspaceId, ctx(req).wsId)).orderBy(desc(C.createdAt), desc(C.id));
    return { items: rows };
  });

  app.get("/api/app/campaigns", { config: { perm: "view_campaigns" } }, async (req) => {
    const q = query(
      req,
      z.object({
        search: z.string().optional(),
        status: z.string().optional(), // "all" | "active" | "draft" | "paused" | "error" | "completed" | "subsequences" | "evergreen"
        tag_ids: zList,
        sort: z.enum(["newest", "oldest", "name_asc", "name_desc"]).optional(),
        limit: zInt(1, 200).optional(),
        page: zInt(1).optional(),
      }),
    );
    const c = ctx(req);
    const conds: SQL[] = [eq(C.workspaceId, c.wsId)];
    if (q.search) conds.push(contains(C.name, q.search));
    const statusMap: Record<string, SQL | undefined> = {
      active: eq(C.status, CampaignStatus.ACTIVE),
      draft: eq(C.status, CampaignStatus.DRAFT),
      paused: eq(C.status, CampaignStatus.PAUSED),
      completed: eq(C.status, CampaignStatus.COMPLETED),
      subsequences: eq(C.status, CampaignStatus.RUNNING_SUBSEQUENCES),
      error: inArray(C.status, [CampaignStatus.ACCOUNTS_UNHEALTHY, CampaignStatus.BOUNCE_PROTECT, CampaignStatus.ACCOUNT_SUSPENDED]),
      evergreen: eq(C.isEvergreen, true),
    };
    if (q.status && statusMap[q.status]) conds.push(statusMap[q.status]!);
    if (q.tag_ids?.length) conds.push(inArray(C.id, [...(await resourcesWithTags(c.wsId, q.tag_ids, "any")), "__none__"]));
    const order = { newest: [desc(C.createdAt)], oldest: [asc(C.createdAt)], name_asc: [asc(C.name)], name_desc: [desc(C.name)] }[q.sort ?? "newest"];
    const limit = q.limit ?? 50;
    const offset = ((q.page ?? 1) - 1) * limit;
    const [total] = await db.select({ n: sql<number>`count(*)` }).from(C).where(and(...conds));
    const rows = await db.select().from(C).where(and(...conds)).orderBy(...order).limit(limit).offset(offset);
    const ids = rows.map((r) => r.id);
    const [metrics, counts, items] = await Promise.all([metricsByCampaign(c.wsId, ids, {}), leadCounts(c.wsId, ids), serializeCampaigns(c.wsId, rows)]);
    return {
      total: Number(total?.n ?? 0),
      page: q.page ?? 1,
      items: items.map((it) => {
        const m = metrics.get(it.id);
        const lc = counts.get(it.id);
        const progress = lc?.total ? Math.floor((lc.done / lc.total) * 100) : 0;
        return {
          ...it,
          stats: {
            leads: lc?.total ?? 0,
            completed: lc?.completed ?? 0,
            // Leads still to be emailed: on a finished campaign, ones added after it finished (resuming sends to them).
            waiting: lc?.active ?? 0,
            progress,
            sent: m?.emails_sent_count ?? 0,
            contacted: m?.contacted_count ?? 0,
            opened: m?.open_count_unique ?? 0,
            clicked: m?.link_click_count_unique ?? 0,
            replied: m?.reply_count_unique ?? 0,
            bounced: m?.bounced_count ?? 0,
            opportunities: m?.total_opportunities ?? 0,
            opportunity_value: m?.total_opportunity_value ?? 0,
          },
        };
      }),
    };
  });

  app.post("/api/app/campaigns", { config: { perm: "edit_campaigns", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(250) }));
    const row = await insertCampaign(c.wsId, c.userId, { name: b.name });
    return serializeCampaign(row);
  });

  app.post("/api/app/campaigns/bulk", { config: { perm: "edit_campaigns", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ ids: z.array(z.string()).min(1).max(500), action: z.enum(["activate", "pause", "delete"]) }));
    const rows = await db.select().from(C).where(and(eq(C.workspaceId, c.wsId), inArray(C.id, b.ids)));
    const failed: { id: string; name: string; reason: string }[] = [];
    if (b.action === "delete") {
      const entries = await deleteCampaigns(rows, actorOf(req));
      for (const r of rows) await audit({ workspaceId: c.wsId, activityType: AuditActivity.CAMPAIGN_DELETION, req, campaignId: r.id, metadata: { name: r.name } });
      return { updated: rows.length, failed, recently_deleted_ids: entries };
    } else {
      for (const r of rows) {
        if (b.action === "activate") {
          const problems = await launchProblems(r);
          if (problems.length) {
            failed.push({ id: r.id, name: r.name, reason: problems[0]! });
            continue;
          }
          if (r.status !== CampaignStatus.ACTIVE) await setCampaignStatus(r, CampaignStatus.ACTIVE);
          await audit({ workspaceId: c.wsId, activityType: AuditActivity.CAMPAIGN_LAUNCH, req, campaignId: r.id });
        } else if (r.status !== CampaignStatus.PAUSED) {
          await setCampaignStatus(r, CampaignStatus.PAUSED);
          await audit({ workspaceId: c.wsId, activityType: AuditActivity.CAMPAIGN_PAUSE, req, campaignId: r.id });
        }
      }
    }
    return { updated: rows.length - failed.length, failed };
  });

  // Also for API keys: AI assistants check a campaign before they launch it (routes/mcp.ts).
  app.get("/api/app/campaigns/:id/launch-check", { config: { perm: "view_campaigns", scope: ["campaigns", "read"] } }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const problems = await launchProblems(row);
    const [leads] = await db.select({ n: sql<number>`count(*)` }).from(L).where(eq(L.campaignId, row.id));
    const warnings: string[] = [];
    if (!Number(leads?.n ?? 0)) warnings.push("The campaign has no leads yet. It will start sending as soon as leads are added.");
    warnings.push(...(await launchWarnings(row)));
    if (row.openTracking) warnings.push("Open tracking adds a tracking pixel, which can slightly lower inbox placement.");
    // Leads who'd get a gap where a {{variable}} goes, with the worst of those emails to look at.
    return { ready: !problems.length, problems, warnings, personalization: await personalizationCheck(row) };
  });

  /** Everything the campaign analytics tab needs in one call. */
  app.get("/api/app/campaigns/:id/overview", { config: { perm: "analytics" } }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const q = query(req, z.object({ start_date: z.string().optional(), end_date: z.string().optional() }));
    const range = await workspaceRange(c.wsId, q.start_date, q.end_date);
    const [metrics, interest, counts, daily, steps] = await Promise.all([
      aggregateMetrics(c.wsId, [row.id], range),
      interestTotals(c.wsId, [row.id], range),
      leadCounts(c.wsId, [row.id]),
      dailyMetrics(c.wsId, [row.id], range),
      stepMetrics(c.wsId, [row.id], range, true),
    ]);
    const lc = counts.get(row.id) ?? { total: 0, completed: 0, active: 0, paused: 0, bounced: 0, unsubscribed: 0, contacted: 0, done: 0 };
    return {
      campaign: serializeCampaign(row),
      metrics,
      interest,
      leads: { ...lc, progress: lc.total ? Math.floor((lc.done / lc.total) * 100) : 0 },
      daily,
      steps,
    };
  });

  /** Why the campaign's emails bounced: by reason, mailbox and step, plus the newest bounces (CSV in the app). */
  app.get("/api/app/campaigns/:id/bounces", { config: { perm: "analytics" } }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const q = query(req, z.object({ start_date: z.string().optional(), end_date: z.string().optional(), limit: zInt(1, 5000).optional() }));
    return campaignBounceReport(row.id, await workspaceRange(c.wsId, q.start_date, q.end_date), q.limit ?? 500);
  });

  app.get("/api/app/campaigns/:id/accounts", { config: { perm: "view_campaigns" } }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const senders = await campaignSenders(row);
    const stats = await todayStats(senders);
    const twins = await sentByTwinsToday(senders);
    return senders.map((a) => ({
      email: a.email,
      status: a.status,
      provider_code: a.providerCode,
      daily_limit: effectiveDailyLimit(a, stats.get(a.id)),
      sent_today: (stats.get(a.id)?.sent ?? 0) + (twins.get(a.email) ?? 0),
      warmup_score: a.warmupScore,
    }));
  });

  const pickVariant = (row: CampaignRow, step: number, variant: number) => {
    const s = activeSteps(row)[step];
    if (!s) throw badRequest(`Step ${step + 1} does not exist`);
    if (s.type === "task") throw badRequest(`Step ${step + 1} is a task, not an email`);
    const v = s.variants[variant];
    if (!v) throw badRequest(`Variant ${variant + 1} does not exist`);
    return v;
  };

  /** Whether a step goes out as plain text, as the sender decides it (`subsequence`: the step is one of a subsequence's). */
  const textOnlyFor = async (row: CampaignRow, step: number, subsequence: boolean | undefined) =>
    sendsTextOnly(row, subsequence ? "subsequence" : "campaign", step, { first_email_text_only: await getWorkspaceSetting(row.workspaceId, "first_email_text_only", false) });

  /** Renders a step for a lead (or sample values) without sending, as the lead would get it. */
  app.post("/api/app/campaigns/:id/preview", { config: { perm: "view_campaigns", scope: ["campaigns", "read"] } }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const b = body(
      req,
      z.object({
        step: z.number().int().min(0).default(0),
        variant: z.number().int().min(0).default(0),
        subsequence: z.boolean().optional(),
        lead_id: z.string().optional(),
        account_email: z.string().optional(),
        // Unsaved editor content; falls back to the saved step/variant.
        subject: z.string().max(2000).optional(),
        body: z.string().max(200_000).optional(),
      }),
    );
    const v = b.body !== undefined ? { subject: b.subject ?? "", body: b.body } : pickVariant(row, b.step, b.variant);
    const [lead] = b.lead_id
      ? await db.select().from(L).where(and(eq(L.id, b.lead_id), eq(L.workspaceId, c.wsId))).limit(1)
      : await db.select().from(L).where(eq(L.campaignId, row.id)).orderBy(asc(L.createdAt)).limit(1);
    const senders = await campaignSenders(row);
    const account = senders.find((a) => a.email === b.account_email?.toLowerCase()) ?? senders[0] ?? null;
    const vars = templateVars(lead ?? null, account, leadClock(row.schedule, lead?.timezone), "#unsubscribe");
    const subject = renderTemplate(v.subject ?? "", vars, { random: () => 0 });
    const html = renderTemplate(v.body ?? "", vars, { escapeHtml: true, random: () => 0 });
    const textOnly = await textOnlyFor(row, b.step, b.subsequence);
    const warnings = [...new Set([...subject.warnings, ...html.warnings].map(describeTemplateWarning))];
    if (blankEmail(html.output, textOnly)) warnings.unshift("This email comes out blank for this lead, so it isn't sent to them: the lead is paused until its details are filled in.");
    return {
      subject: subject.output,
      // As it goes out: plain text when the step is sent as text only.
      body: textOnly ? textToHtml(htmlToText(html.output)) : html.output,
      text_only: textOnly,
      lead: lead ? { id: lead.id, email: lead.email, first_name: lead.firstName, last_name: lead.lastName } : null,
      account_email: account?.email ?? null,
      warnings,
    };
  });

  app.post("/api/app/campaigns/:id/test-email", { config: { perm: "edit_campaigns", write: true, scope: ["campaigns", "update"] } }, async (req) => {
    const c = ctx(req);
    const row = await findCampaign(c.wsId, (req.params as { id: string }).id);
    const b = body(
      req,
      z.object({
        step: z.number().int().min(0).default(0),
        variant: z.number().int().min(0).default(0),
        subsequence: z.boolean().optional(),
        to: z.string().email(),
        account_email: z.string().optional(),
        lead_id: z.string().optional(),
        // Unsaved editor content (also used for subsequence steps); falls back to the saved step/variant.
        subject: z.string().max(2000).optional(),
        body: z.string().max(200_000).optional(),
      }),
    );
    const v = b.body !== undefined ? { subject: b.subject ?? "", body: b.body } : pickVariant(row, b.step, b.variant);
    let account = (await campaignSenders(row, { activeOnly: true })).find((a) => !b.account_email || a.email === b.account_email.toLowerCase());
    if (!account && b.account_email) {
      const [any] = await db
        .select()
        .from(schema.emailAccounts)
        .where(and(eq(schema.emailAccounts.workspaceId, c.wsId), eq(schema.emailAccounts.email, b.account_email.toLowerCase())))
        .limit(1);
      account = any;
    }
    if (!account) throw badRequest("Choose an account to send the test from");
    const [lead] = b.lead_id ? await db.select().from(L).where(and(eq(L.id, b.lead_id), eq(L.workspaceId, c.wsId))).limit(1) : [];
    const vars = templateVars(lead ?? null, account, leadClock(row.schedule, lead?.timezone), "#unsubscribe");
    const sent = await sendTestEmail({ account, to: b.to, subject: v.subject || "(no subject)", body: v.body, vars, textOnly: await textOnlyFor(row, b.step, b.subsequence) });
    return { ok: true, ...sent, from: account.email };
  });

  // ---------- Public share page data ----------

  app.get("/api/public/share/campaign/:id", { config: { auth: "public" } }, async (req) => {
    const [row] = await db
      .select()
      .from(C)
      .where(and(eq(C.id, (req.params as { id: string }).id), sharedNow()))
      .limit(1);
    if (!row) throw notFound("Shared campaign");
    const seq = (row.sequences ?? []) as Sequence[];
    return {
      id: row.id,
      name: row.name,
      expires_at: row.shareExpiresAt?.toISOString() ?? null,
      steps: (seq[0]?.steps ?? []).map((s, i) => ({
        step: i + 1,
        type: s.type ?? "email",
        ...(s.type === "task" ? { task: s.task ?? "todo" } : {}),
        delay: s.delay,
        delay_unit: s.delay_unit ?? "days",
        variants: s.variants.map((v) => ({ subject: v.subject, body: v.body })),
      })),
    };
  });
}


// AI Sales Agent (API v2 /ai-agents/sales): agents that run outbound end to end, their activity feed with
// approvals, guidance rules, analytics and per-lead research.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { contains, db, schema } from "../db/client";
import { ctx } from "../http/context";
import { badRequest, conflict, notFound } from "../http/errors";
import { body, query, zBool, zInt } from "../http/util";
import { aiAvailable } from "../services/ai";
import { cleanReplyHtml, serializeAgentSummary } from "../services/agents/common";
import {
  ACTION_STATUSES,
  ACTION_TYPES,
  SIGNAL_CATEGORIES,
  agentTurnedOff,
  agentTurnedOn,
  approveActivity,
  cfgOf,
  decide,
  defaultConfig,
  encodeRule,
  guidanceRules,
  holdQueuedReplies,
  launchReadyCampaigns,
  mergeConfig,
  rejectActivity,
  serializeSalesActivity,
  serializeSalesAgent,
  withIcpIds,
  type SalesAgentRow,
  type SalesConfig,
} from "../services/agents/sales-agent";
import type { SalesMemory } from "../services/agents/sales-ai";
import { deleteSalesAgent } from "../services/agents/delete";
import { aggregateMetrics, dailyMetrics, interestTotals, metricsByCampaign, scheduleSchema, storedSchedule } from "../services/campaigns";
import { getIntegration } from "../services/integrations";
import { daySql, workspaceRange, type DateRange } from "../services/workspace-clock";

const S = schema.aiSalesAgents;
const ACT = schema.aiSalesAgentActivities;
const L = schema.leads;
const E = schema.emailEvents;
type Act = "create" | "read" | "update" | "delete";
const cfg = (act: Act) => ({ scope: ["ai_sdr", act] as [string, Act], perm: act === "read" ? ("view_campaigns" as const) : ("edit_campaigns" as const), write: act !== "read" });
const listCfg = { ...cfg("read"), scopeAlso: [["ai_agents", "read"]] as Array<[string, "read"]> };

const AGENT_TYPES = [2, 4, 7, 8, 9, 10] as const;
const MAX_RULES = 10;
const AI_NEEDED = "The AI Sales Agent writes and researches with AI. Add an Anthropic API key in Settings → Integrations & API → AI, then turn the agent on.";

const strList = z.array(z.string().trim().min(1).max(500)).max(50);
const icpSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    problems_solved: strList.optional(),
    benefits: strList.optional(),
    usp: z.string().max(5_000).optional(),
    customer_goals: strList.optional(),
    success_stories: z.string().max(10_000).optional(),
    keywords: z.object({ include: z.string().max(2_000).nullable().optional(), exclude: z.string().max(2_000).nullable().optional() }).optional(),
    company_size: z.array(z.string()).max(20).optional(),
    industry: z.array(z.string()).max(100).optional(),
    job_title: z.object({ include: strList.optional(), exclude: strList.optional() }).optional(),
  })
  .passthrough();
const memorySchema = z
  .object({
    company: z.string().max(500),
    business_description: z.string().max(20_000),
    icps: z.array(icpSchema).max(10),
    active_icps_indexes: z.array(z.number().int().min(0)).max(10),
    business_offers: z.array(z.string().trim().min(1).max(2_000)).max(20),
    active_business_offers_indexes: z.array(z.number().int().min(0)).max(20),
    custom_fields: z.array(z.string().max(5_000)).max(MAX_RULES),
  })
  .partial()
  .passthrough();
const configSchema = z
  .object({
    memory: memorySchema,
    position_details: z.string().max(20_000),
    investment_details: z.string().max(20_000),
    research_details: z.string().max(20_000),
    partnership_details: z.string().max(20_000),
    enrichment_settings: z
      .object({
        enrichment_limit_per_run: z.number().int().min(1).max(200),
        signal_targeting_enabled: z.boolean(),
        signal_targeting_categories: z.array(z.enum(SIGNAL_CATEGORIES)).max(26),
      })
      .partial(),
    outreach_settings: z
      .object({
        // The same rules as a campaign's schedule (real timezones, real days): it becomes the campaigns' schedule.
        campaign_schedule: scheduleSchema.transform(storedSchedule),
        email_list: z.array(z.string().email()).max(1_000),
        email_tag_list: z.array(z.string()).max(100),
        daily_limit: z.number().int().min(1).max(100_000),
        stop_on_reply: z.boolean(),
        open_tracking: z.boolean(),
        first_email_text_only: z.boolean(),
        prioritize_new_leads: z.boolean(),
        match_lead_esp: z.boolean(),
        opt_out_settings: z.object({ text_opt_out_enabled: z.boolean() }).partial(),
      })
      .partial(),
    autonomy_settings: z.object({ autopilot_mode: z.boolean(), auto_reply_to_responses: z.boolean(), manual_leads_mode: z.boolean() }).partial(),
    slack_connection_id: z.string().min(1).nullable(),
  })
  .partial();

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).nullable().optional(),
  type: z.enum(["website", "pitch_deck"]).optional(),
  input: z.string().max(100_000).nullable().optional(),
  config: configSchema.optional(),
  agent_type: z.number().int().refine((n) => (AGENT_TYPES as readonly number[]).includes(n), "agent_type must be 2, 4, 7, 8, 9 or 10").optional(),
  self_improvement: z.boolean().nullable().optional(),
  status: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  memory_from_workspace: z.boolean().optional(),
  master_lead_list_id: z.string().min(1).optional(),
  initial_scrape_ready: z.boolean().optional(),
  is_duplicate: z.boolean().optional(),
  source_ai_sdr_id: z.string().min(1).optional(),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2_000).nullable().optional(),
  config: configSchema.optional(),
  self_improvement: z.boolean().nullable().optional(),
  status: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
});
const listQuery = z.object({
  limit: zInt(1, 100).optional(),
  starting_after: z.string().optional(),
  status: z.coerce.number().int().refine((n) => [-1, 0, 1].includes(n), "status must be -1, 0 or 1").optional(),
  search: z.string().max(200).optional(),
  agent_type: z.coerce.number().int().refine((n) => (AGENT_TYPES as readonly number[]).includes(n), "Unknown agent_type").optional(),
});
const rangeQuery = z.object({ start_date: z.string().optional(), end_date: z.string().optional() });
const ids = z.array(z.string().min(1)).min(1).max(100);
const reason = z.string().trim().min(1).max(2_000);
const ruleBody = z.object({ title: z.string().trim().max(200).optional(), content: z.string().trim().min(1).max(5_000) });
const rulePatch = z.object({ title: z.string().trim().max(200).optional(), content: z.string().trim().min(1).max(5_000).optional() });

/** Query arrays arrive as `k=a&k=b`, `k[]=a`, or `k=a,b`. */
function listParam(req: FastifyRequest, key: string): string[] {
  const q = req.query as Record<string, unknown>;
  const raw = q[key] ?? q[`${key}[]`];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
}

async function findSalesAgent(wsId: string, id: string) {
  const [a] = await db.select().from(S).where(and(eq(S.id, id), eq(S.workspaceId, wsId))).limit(1);
  if (!a) throw notFound("AI Sales Agent");
  return a;
}

/** Checks references inside a config: sending accounts, account tags, Slack connection and ICP indexes. */
async function validateConfig(wsId: string, c: SalesConfig) {
  const o = c.outreach_settings;
  if (o.email_list.length) {
    const rows = await db.select({ email: schema.emailAccounts.email }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, wsId), inArray(schema.emailAccounts.email, o.email_list)));
    const known = new Set(rows.map((r) => r.email.toLowerCase()));
    const missing = o.email_list.filter((e) => !known.has(e.toLowerCase()));
    if (missing.length) throw badRequest(`config.outreach_settings.email_list: no sending account ${missing.slice(0, 3).join(", ")}`);
  }
  if (o.email_tag_list.length) {
    const rows = await db.select({ id: schema.customTags.id }).from(schema.customTags).where(and(eq(schema.customTags.workspaceId, wsId), inArray(schema.customTags.id, o.email_tag_list)));
    if (rows.length !== new Set(o.email_tag_list).size) throw badRequest("config.outreach_settings.email_tag_list: unknown tag id");
  }
  if (c.slack_connection_id && !(await getIntegration(wsId, c.slack_connection_id, "slack"))) throw badRequest("config.slack_connection_id: no Slack connection with this id");
  const m = c.memory;
  const icps = m.icps ?? [];
  if ((m.active_icps_indexes ?? []).some((i) => i >= icps.length)) throw badRequest("config.memory.active_icps_indexes: index out of range");
  if ((m.active_business_offers_indexes ?? []).some((i) => i >= (m.business_offers ?? []).length)) throw badRequest("config.memory.active_business_offers_indexes: index out of range");
  if ((m.custom_fields ?? []).length > MAX_RULES) throw badRequest(`config.memory.custom_fields: at most ${MAX_RULES} guidance rules`);
}

/** Campaign columns kept in step with the agent's outreach settings. */
function outreachColumns(o: Partial<SalesConfig["outreach_settings"]>): Partial<typeof schema.campaigns.$inferInsert> {
  const set: Partial<typeof schema.campaigns.$inferInsert> = {};
  if (o.campaign_schedule) set.schedule = o.campaign_schedule;
  if (o.email_list) set.emailList = o.email_list;
  if (o.email_tag_list) set.emailTagList = o.email_tag_list;
  if (o.daily_limit !== undefined) set.dailyLimit = o.daily_limit;
  if (o.stop_on_reply !== undefined) set.stopOnReply = o.stop_on_reply;
  if (o.open_tracking !== undefined) set.openTracking = o.open_tracking;
  if (o.first_email_text_only !== undefined) set.firstEmailTextOnly = o.first_email_text_only;
  if (o.prioritize_new_leads !== undefined) set.prioritizeNewLeads = o.prioritize_new_leads;
  if (o.match_lead_esp !== undefined) set.matchLeadEsp = o.match_lead_esp;
  return set;
}

/** The workspace's business details (Copilot memory) in the agent's memory format. */
async function workspaceMemory(wsId: string): Promise<SalesMemory | null> {
  const [row] = await db
    .select({ data: schema.copilotMemory.data })
    .from(schema.copilotMemory)
    .where(and(eq(schema.copilotMemory.workspaceId, wsId), eq(schema.copilotMemory.key, "business_details")))
    .limit(1);
  const d = (row?.data ?? null) as Record<string, unknown> | null;
  if (!d || (!d.company && !d.business_description)) return null;
  const parsed = memorySchema.safeParse(d);
  if (!parsed.success) return null;
  const m = parsed.data as SalesMemory;
  return {
    company: m.company ?? "",
    business_description: m.business_description ?? "",
    icps: m.icps ?? [],
    active_icps_indexes: m.active_icps_indexes ?? (m.icps ?? []).map((_, i) => i),
    business_offers: m.business_offers ?? [],
    active_business_offers_indexes: m.active_business_offers_indexes ?? [],
    custom_fields: [],
  };
}

const normalizeUrl = (raw: string) => {
  const v = raw.trim();
  const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(url);
    if (!u.hostname.includes(".")) throw new Error();
    return u.toString();
  } catch {
    throw badRequest("input: enter a website address such as https://example.com");
  }
};


async function agentCampaignIds(a: SalesAgentRow) {
  return (await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, a.workspaceId), eq(schema.campaigns.aiSdrId, a.id)))).map((r) => r.id);
}

function eventConds(a: SalesAgentRow, campaignIds: string[], r: DateRange): SQL[] {
  const conds: SQL[] = [eq(E.workspaceId, a.workspaceId), inArray(E.campaignId, campaignIds.length ? campaignIds : ["__none__"])];
  if (r.start !== undefined) conds.push(sql`${E.createdAt} >= ${r.start}`);
  if (r.end !== undefined) conds.push(sql`${E.createdAt} <= ${r.end}`);
  return conds;
}

const POSITIVE = [1, 2, 3, 4];

export default async function salesAgentRoutes(app: FastifyInstance) {
  const base = "/api/v2/ai-agents/sales";

  app.post(base, { config: cfg("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, createBody);
    let source: SalesAgentRow | null = null;
    if (b.is_duplicate) {
      if (!b.source_ai_sdr_id) throw badRequest("source_ai_sdr_id is required when is_duplicate is true");
      source = await findSalesAgent(c.wsId, b.source_ai_sdr_id);
    } else if (b.source_ai_sdr_id) throw badRequest("source_ai_sdr_id is only used together with is_duplicate");

    let config = source ? (({ _state: _ignored, ...rest }) => rest)(cfgOf(source)) : defaultConfig();
    let memoryFromWorkspace: SalesMemory | null = null;
    if (b.memory_from_workspace && !source) {
      memoryFromWorkspace = await workspaceMemory(c.wsId);
      if (!memoryFromWorkspace) throw badRequest("memory_from_workspace: the workspace has no business details yet. Add them in Copilot → Memory, or create the agent from a website or pitch.");
      config = { ...config, memory: { ...config.memory, ...memoryFromWorkspace } };
    }
    if (b.config) config = mergeConfig(config, b.config as Partial<SalesConfig>);
    config = { ...config, memory: { ...config.memory, icps: withIcpIds(config.memory.icps) } };
    await validateConfig(c.wsId, config);

    let type = source?.type ?? b.type ?? null;
    let input = source?.input ?? b.input ?? null;
    if (!source && !memoryFromWorkspace) {
      if (!b.type) throw badRequest("type is required (website or pitch_deck) unless memory_from_workspace or is_duplicate is set");
      if (!b.input?.trim()) throw badRequest(b.type === "website" ? "input: the website URL is required" : "input: the pitch text is required");
      type = b.type;
      input = b.type === "website" ? normalizeUrl(b.input) : b.input.trim();
      if (b.type === "pitch_deck" && input.length < 80) throw badRequest("input: paste at least a paragraph about the business");
    } else if (memoryFromWorkspace) {
      type = b.type ?? "website";
      input = b.input ?? null;
    }
    const status = b.status ?? 0;
    if (status === 1 && !(await aiAvailable(c.wsId))) throw badRequest(AI_NEEDED);

    let listId = b.master_lead_list_id ?? null;
    if (listId) {
      const [list] = await db.select({ id: schema.leadLists.id }).from(schema.leadLists).where(and(eq(schema.leadLists.id, listId), eq(schema.leadLists.workspaceId, c.wsId))).limit(1);
      if (!list) throw badRequest("master_lead_list_id: lead list not found");
    } else {
      const [list] = await db.insert(schema.leadLists).values({ workspaceId: c.wsId, name: `${b.name} · prospects`, createdBy: c.userId, ownedBy: c.userId }).returning();
      listId = list!.id;
    }
    const scrapeReady = source ? source.initialScrapeReady : memoryFromWorkspace ? true : (b.initial_scrape_ready ?? false);
    const [row] = await db
      .insert(S)
      .values({
        workspaceId: c.wsId,
        name: b.name,
        description: b.description ?? source?.description ?? null,
        type: type ?? "website",
        input,
        status,
        config: config as unknown as Record<string, unknown>,
        agentType: source?.agentType ?? b.agent_type ?? 2,
        selfImprovement: b.self_improvement !== undefined ? b.self_improvement : (source?.selfImprovement ?? true),
        masterLeadListId: listId,
        initialScrapeReady: scrapeReady,
        nextDecisionAt: status === 1 ? new Date() : null,
        createdBy: c.userId,
      })
      .returning();
    const a = row!;
    if (!scrapeReady) {
      // Learning the business starts right away so the profile is ready to review before launch.
      await db.insert(ACT).values({ workspaceId: c.wsId, aiSdrId: a.id, actionType: "initial_setup_scrape", actionStatus: "approved", approvedAt: new Date(), actionPayload: { type: a.type, input: a.type === "website" ? a.input : "(pitch text)" } });
    } else if (memoryFromWorkspace) {
      await db.insert(ACT).values({ workspaceId: c.wsId, aiSdrId: a.id, actionType: "initial_setup_campaigns", actionStatus: "approved", approvedAt: new Date(), aiReasoning: "Business details copied from the workspace; campaigns are drafted when the agent starts." });
    }
    return serializeSalesAgent(a);
  });

  app.get(base, { config: listCfg }, async (req) => {
    const c = ctx(req);
    const q = query(req, listQuery);
    const limit = q.limit ?? 10;
    const conds: SQL[] = [eq(S.workspaceId, c.wsId)];
    if (q.status !== undefined) conds.push(eq(S.status, q.status));
    if (q.agent_type !== undefined) conds.push(eq(S.agentType, q.agent_type));
    if (q.search) conds.push(contains(sql`lower(${S.name})`, q.search.toLowerCase()));
    if (q.starting_after) conds.push(lt(S.id, q.starting_after));
    const rows = await db.select().from(S).where(and(...conds)).orderBy(desc(S.id)).limit(limit + 1);
    const items = rows.slice(0, limit).map(serializeSalesAgent);
    return { items, ...(rows.length > limit ? { next_starting_after: items[items.length - 1]!.id } : {}) };
  });

  app.get(`${base}/:id`, { config: cfg("read") }, async (req) => serializeSalesAgent(await findSalesAgent(ctx(req).wsId, (req.params as { id: string }).id)));

  app.patch(`${base}/:id`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const b = body(req, patchBody);
    const current = cfgOf(a);
    const next = b.config ? mergeConfig(current, b.config as Partial<SalesConfig>) : current;
    if (b.config) await validateConfig(c.wsId, next);
    if (b.status === 1 && a.status !== 1 && !(await aiAvailable(c.wsId))) throw badRequest(AI_NEEDED);
    const set: Partial<typeof S.$inferInsert> = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.description !== undefined) set.description = b.description;
    if (b.self_improvement !== undefined) set.selfImprovement = b.self_improvement;
    if (b.config) {
      // Merged onto the agent as it is now: a planning round may have linked new campaigns meanwhile.
      const [fresh] = await db.select().from(S).where(eq(S.id, a.id)).limit(1);
      set.config = mergeConfig(cfgOf(fresh ?? a), b.config as Partial<SalesConfig>) as unknown as Record<string, unknown>;
    }
    if (b.status !== undefined) {
      set.status = b.status;
      if (b.status === 1 && a.status !== 1) set.nextDecisionAt = new Date();
    }
    const [row] = Object.keys(set).length ? await db.update(S).set(set).where(eq(S.id, a.id)).returning() : [a];
    const campaigns = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, c.wsId), eq(schema.campaigns.aiSdrId, a.id)));
    // Outreach settings apply to every campaign the agent runs.
    const cols = b.config?.outreach_settings ? outreachColumns(b.config.outreach_settings as Partial<SalesConfig["outreach_settings"]>) : {};
    if (Object.keys(cols).length && campaigns.length) await db.update(schema.campaigns).set(cols).where(inArray(schema.campaigns.id, campaigns.map((x) => x.id)));
    // Turning the agent off pauses its campaigns; turning it on resumes those and starts the ones that never could.
    if (b.status !== undefined && b.status !== a.status) {
      if (b.status !== 1) await agentTurnedOff(row!);
      else await agentTurnedOn(row!);
    } else if (row!.status === 1 && b.config?.outreach_settings) await launchReadyCampaigns(row!);
    // Autopilot (or answering replies) switched off: replies it queued to send by itself wait for approval instead.
    const was = current.autonomy_settings;
    const is = cfgOf(row!).autonomy_settings;
    if ((was.autopilot_mode && !is.autopilot_mode) || (was.auto_reply_to_responses && !is.auto_reply_to_responses)) await holdQueuedReplies(a.id);
    return serializeSalesAgent(row!);
  });

  app.delete(`${base}/:id`, { config: cfg("delete") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    await deleteSalesAgent(a);
    return serializeAgentSummary({ id: a.id, type: a.agentType, name: a.name, status: a.status, createdAt: a.createdAt, updatedAt: a.updatedAt, configurationMode: cfgOf(a).autonomy_settings.autopilot_mode ? "fully_automatic" : "copilot" });
  });

  // ---------- Analytics ----------

  app.get(`${base}/:id/analytics`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const q = query(req, rangeQuery);
    const r = await workspaceRange(c.wsId, q.start_date, q.end_date);
    const campaignIds = await agentCampaignIds(a);
    const daily = (await dailyMetrics(c.wsId, campaignIds, r)) as Array<{ date: string } & Record<string, number>>;
    const totals = await aggregateMetrics(c.wsId, campaignIds, r);
    // Leads found: everything that entered the agent's master list or campaigns.
    const leadConds: SQL[] = [eq(L.workspaceId, c.wsId), sql`(${L.campaignId} in (${sql.join((campaignIds.length ? campaignIds : ["__none__"]).map((x) => sql`${x}`), sql`, `)}) or ${L.listId} = ${a.masterLeadListId ?? "__none__"})`];
    if (r.start !== undefined) leadConds.push(sql`${L.createdAt} >= ${r.start}`);
    if (r.end !== undefined) leadConds.push(sql`${L.createdAt} <= ${r.end}`);
    const leadDay = daySql(L.createdAt, r);
    const found = await db.select({ date: leadDay, n: sql<number>`count(*)` }).from(L).where(and(...leadConds)).groupBy(leadDay).orderBy(leadDay);
    const activity = (d: (typeof daily)[number]) => Number(d.sent ?? 0) + Number(d.opened ?? 0) + Number(d.replies ?? 0) + Number(d.clicks ?? 0);
    return {
      total_email_activity_per_day: daily.map((d) => ({ x: d.date, y: activity(d) })),
      replies_per_day: daily.map((d) => ({ x: d.date, y: Number(d.replies ?? 0) })),
      leads_found_per_day: found.map((f) => ({ x: f.date, y: Number(f.n) })),
      opportunities_per_day: daily.map((d) => ({ x: d.date, y: Number(d.unique_opportunities ?? 0) })),
      totals: {
        total_sent: totals.emails_sent_count,
        replies: totals.reply_count,
        opportunities: totals.total_opportunities,
        opportunities_amount: totals.total_opportunity_value,
        total_email_activity: daily.reduce((s, d) => s + activity(d), 0),
        leads_found: found.reduce((s, f) => s + Number(f.n), 0),
      },
    };
  });

  app.get(`${base}/:id/opportunities/summary`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const q = query(req, rangeQuery);
    const r = await workspaceRange(c.wsId, q.start_date, q.end_date);
    const campaignIds = await agentCampaignIds(a);
    const [statuses, totals, perCampaign] = await Promise.all([interestTotals(c.wsId, campaignIds, r), aggregateMetrics(c.wsId, campaignIds, r), metricsByCampaign(c.wsId, campaignIds, r)]);
    const breakdown = { interested: statuses.total_interested, meeting_booked: statuses.total_meeting_booked, meeting_completed: statuses.total_meeting_completed, closed: statuses.total_closed };
    return {
      summary: { total_opportunities: breakdown.interested + breakdown.meeting_booked + breakdown.meeting_completed + breakdown.closed, total_value: totals.total_opportunity_value, breakdown },
      campaigns: campaignIds.map((id) => ({ campaign_id: id, total_opportunities: perCampaign.get(id)?.total_opportunities ?? 0, total_opportunity_value: perCampaign.get(id)?.total_opportunity_value ?? 0 })),
    };
  });

  app.get(`${base}/:id/leads/:lead_id/research`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const p = req.params as { id: string; lead_id: string };
    const a = await findSalesAgent(c.wsId, p.id);
    const [row] = await db.select({ research: schema.aiLeadResearch.research }).from(schema.aiLeadResearch).where(and(eq(schema.aiLeadResearch.agentId, a.id), eq(schema.aiLeadResearch.leadId, p.lead_id))).limit(1);
    return { research: row?.research ?? null };
  });

  /** Per-lead counters across the agent's campaigns, grouped by email. */
  const perLead = (a: SalesAgentRow, campaignIds: string[], r: DateRange) => {
    const count = (type: string, alias: string) => sql<number>`sum(case when ${E.type} = ${type} then 1 else 0 end)`.as(alias);
    const email = sql<string>`lower(coalesce(${L.email}, ${E.leadEmail}))`;
    return db
      .select({
        email: sql<string>`lower(coalesce(${L.email}, ${E.leadEmail}))`.as("email"),
        emails_sent: count("sent", "emails_sent"),
        open_count: count("open", "open_count"),
        reply_count: count("reply", "reply_count"),
        click_count: count("click", "click_count"),
        bounced: sql<number>`max(case when ${E.type} = 'bounce' then 1 else 0 end)`.as("bounced"),
        interest: sql<number | null>`max(${L.interestStatus})`.as("interest"),
        has_opportunity: sql<number>`max(case when ${L.interestStatus} in (${sql.join(POSITIVE.map((n) => sql`${n}`), sql`, `)}) or ${E.type} = 'opportunity' then 1 else 0 end)`.as("has_opportunity"),
      })
      .from(E)
      .leftJoin(L, eq(L.id, E.leadId))
      .where(and(...eventConds(a, campaignIds, r)))
      .groupBy(email)
      .as("per_lead");
  };

  app.get(`${base}/:id/leads/activity/summary`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const q = query(req, rangeQuery);
    const t = perLead(a, await agentCampaignIds(a), await workspaceRange(c.wsId, q.start_date, q.end_date));
    const [row] = await db
      .select({ total: sql<number>`count(*)`, replied: sql<number>`coalesce(sum(case when ${t.reply_count} > 0 then 1 else 0 end), 0)`, has_opportunity: sql<number>`coalesce(sum(${t.has_opportunity}), 0)` })
      .from(t);
    const total = Number(row?.total ?? 0);
    const replied = Number(row?.replied ?? 0);
    const opp = Number(row?.has_opportunity ?? 0);
    return { total, replied, has_opportunity: opp, reply_rate: total ? replied / total : 0, opportunity_rate: total ? opp / total : 0 };
  });

  app.get(`${base}/:id/leads/activity`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const q = query(req, rangeQuery.extend({ filter: z.enum(["replied", "has_opportunity"]).optional(), limit: zInt(1, 1000).optional(), starting_after: z.string().optional() }));
    const limit = q.limit ?? 100;
    const t = perLead(a, await agentCampaignIds(a), await workspaceRange(c.wsId, q.start_date, q.end_date));
    const conds: SQL[] = [sql`${t.email} is not null`];
    if (q.filter === "replied") conds.push(sql`${t.reply_count} > 0`);
    if (q.filter === "has_opportunity") conds.push(sql`${t.has_opportunity} = 1`);
    const [{ n: total }] = (await db.select({ n: sql<number>`count(*)` }).from(t).where(and(...conds))) as [{ n: number }];
    if (q.starting_after) conds.push(sql`${t.email} > ${q.starting_after.toLowerCase()}`);
    const rows = await db.select().from(t).where(and(...conds)).orderBy(sql`${t.email}`).limit(limit + 1);
    const items = rows.slice(0, limit).map((x) => ({
      email: x.email,
      emails_sent: Number(x.emails_sent),
      open_count: Number(x.open_count),
      replied: Number(x.reply_count) > 0,
      reply_count: Number(x.reply_count),
      click_count: Number(x.click_count),
      bounced: Number(x.bounced) === 1,
      has_opportunity: Number(x.has_opportunity) === 1,
      lt_interest_status: x.interest === null ? null : Number(x.interest),
    }));
    return { items, total: Number(total), ...(rows.length > limit ? { next_starting_after: items[items.length - 1]!.email } : {}) };
  });

  // ---------- Activities ----------

  app.get(`${base}/:id/activities`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), exclude_live_feed_hidden: zBool, lead_email: z.string().min(1).optional() }).passthrough());
    const statuses = listParam(req, "action_status");
    const types = listParam(req, "action_type");
    const badStatus = statuses.find((s) => !(ACTION_STATUSES as readonly string[]).includes(s));
    if (badStatus) throw badRequest(`action_status: unknown value ${badStatus}`);
    const badType = types.find((t) => !(ACTION_TYPES as readonly string[]).includes(t));
    if (badType) throw badRequest(`action_type: unknown value ${badType}`);
    const limit = q.limit ?? 20;
    const conds: SQL[] = [eq(ACT.aiSdrId, a.id)];
    if (statuses.length) conds.push(inArray(ACT.actionStatus, statuses));
    if (types.length) conds.push(inArray(ACT.actionType, types));
    if (q.exclude_live_feed_hidden) {
      conds.push(sql`not (${ACT.actionType} = 'recommend_lead' and coalesce(json_extract(${ACT.actionOutput}, '$.delivery_outcome'), '') = 'delivered')`);
    }
    if (q.lead_email) conds.push(sql`lower(json_extract(${ACT.actionOutput}, '$.lead_email')) = ${q.lead_email.trim().toLowerCase()}`);
    if (q.starting_after) conds.push(lt(ACT.id, q.starting_after));
    const rows = await db.select().from(ACT).where(and(...conds)).orderBy(desc(ACT.id)).limit(limit + 1);
    const items = rows.slice(0, limit).map(serializeSalesActivity);
    return { items, ...(rows.length > limit ? { next_starting_after: items[items.length - 1]!.id } : {}) };
  });

  const pendingActivity = async (agentId: string, activityId: string) => {
    const [row] = await db.select().from(ACT).where(and(eq(ACT.id, activityId), eq(ACT.aiSdrId, agentId), eq(ACT.actionStatus, "pending"))).limit(1);
    if (!row) throw notFound("Pending activity");
    return row;
  };

  app.post(`${base}/:id/activities/:activity_id/approve`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const p = req.params as { id: string; activity_id: string };
    const a = await findSalesAgent(c.wsId, p.id);
    const row = await pendingActivity(a.id, p.activity_id);
    return serializeSalesActivity(await approveActivity(a, row, c.userId));
  });

  app.post(`${base}/:id/activities/:activity_id/reject`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const p = req.params as { id: string; activity_id: string };
    const a = await findSalesAgent(c.wsId, p.id);
    const b = body(req, z.object({ rejection_reason: reason }));
    const row = await pendingActivity(a.id, p.activity_id);
    return serializeSalesActivity(await rejectActivity(row, c.userId, b.rejection_reason));
  });

  // Bulk approvals are queued; the agent carries them out within a few seconds.
  app.post(`${base}/:id/activities/approve`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object({ activity_ids: ids }));
    const rows = await db
      .update(ACT)
      .set({ actionStatus: "approved", approvedBy: c.userId, approvedAt: new Date() })
      .where(and(eq(ACT.aiSdrId, a.id), inArray(ACT.id, b.activity_ids), eq(ACT.actionStatus, "pending")))
      .returning({ id: ACT.id });
    if (!rows.length) throw notFound("Pending activities");
    return { approved: rows.length };
  });

  app.post(`${base}/:id/activities/reject`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object({ activity_ids: ids, rejection_reason: reason }));
    const rows = await db
      .update(ACT)
      .set({ actionStatus: "rejected", rejectedBy: c.userId, rejectedAt: new Date(), rejectionReason: b.rejection_reason })
      .where(and(eq(ACT.aiSdrId, a.id), inArray(ACT.id, b.activity_ids), eq(ACT.actionStatus, "pending")))
      .returning({ id: ACT.id });
    if (!rows.length) throw notFound("Pending activities");
    return { rejected: rows.length };
  });

  // ---------- Guidance rules (positional ids, stored in memory.custom_fields) ----------

  const saveRules = async (a: SalesAgentRow, fields: string[]) => {
    const current = cfgOf(a);
    await db.update(S).set({ config: { ...current, memory: { ...current.memory, custom_fields: fields } } as unknown as Record<string, unknown> }).where(eq(S.id, a.id));
  };
  const ruleIndex = (fields: string[], ruleId: string) => {
    const m = /^rule-(\d+)$/.exec(ruleId);
    const i = m ? Number(m[1]) : -1;
    if (i < 0 || i >= fields.length) throw notFound("Guidance rule");
    return i;
  };

  app.get(`${base}/:id/guidance-rules`, { config: cfg("read") }, async (req) => {
    const a = await findSalesAgent(ctx(req).wsId, (req.params as { id: string }).id);
    return { items: guidanceRules(cfgOf(a)) };
  });

  app.post(`${base}/:id/guidance-rules`, { config: cfg("update") }, async (req) => {
    const a = await findSalesAgent(ctx(req).wsId, (req.params as { id: string }).id);
    const b = body(req, ruleBody);
    const fields = [...(cfgOf(a).memory.custom_fields ?? [])];
    if (fields.length >= MAX_RULES) throw badRequest(`An agent can have at most ${MAX_RULES} guidance rules`);
    fields.push(encodeRule({ title: b.title ?? "", content: b.content }));
    await saveRules(a, fields);
    const [fresh] = await db.select().from(S).where(eq(S.id, a.id)).limit(1);
    return guidanceRules(cfgOf(fresh!))[fields.length - 1];
  });

  app.patch(`${base}/:id/guidance-rules/:rule_id`, { config: cfg("update") }, async (req) => {
    const p = req.params as { id: string; rule_id: string };
    const a = await findSalesAgent(ctx(req).wsId, p.id);
    const b = body(req, rulePatch);
    if (b.title === undefined && b.content === undefined) throw badRequest("Send a title or content to update");
    const fields = [...(cfgOf(a).memory.custom_fields ?? [])];
    const i = ruleIndex(fields, p.rule_id);
    const rule = guidanceRules(cfgOf(a))[i]!;
    const storedTitle = (() => {
      try {
        return (JSON.parse(fields[i]!) as { title?: string }).title ?? "";
      } catch {
        return "";
      }
    })();
    fields[i] = encodeRule({ title: b.title ?? storedTitle, content: b.content ?? rule.content });
    await saveRules(a, fields);
    const [fresh] = await db.select().from(S).where(eq(S.id, a.id)).limit(1);
    return guidanceRules(cfgOf(fresh!))[i];
  });

  app.delete(`${base}/:id/guidance-rules/:rule_id`, { config: cfg("update") }, async (req) => {
    const p = req.params as { id: string; rule_id: string };
    const a = await findSalesAgent(ctx(req).wsId, p.id);
    const fields = [...(cfgOf(a).memory.custom_fields ?? [])];
    const i = ruleIndex(fields, p.rule_id);
    fields.splice(i, 1);
    await saveRules(a, fields);
    return { id: p.rule_id, deleted: true };
  });

  // ---------- App ----------

  // Learns the business again, from the stored source or a new website / pitch. Replaces the profile; rules stay.
  app.post("/api/app/ai-agents/sales/:id/learn", { config: { perm: "edit_campaigns" as const, write: true } }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object({ type: z.enum(["website", "pitch_deck"]).optional(), input: z.string().max(100_000).optional() }));
    if (!(await aiAvailable(c.wsId))) throw badRequest(AI_NEEDED);
    const type = b.type ?? (a.type as "website" | "pitch_deck");
    const raw = b.input ?? a.input;
    if (!raw?.trim()) throw badRequest(type === "website" ? "input: the website URL is required" : "input: the pitch text is required");
    const input = type === "website" ? normalizeUrl(raw) : raw.trim();
    if (type === "pitch_deck" && input.length < 80) throw badRequest("input: paste at least a paragraph about the business");
    const [busy] = await db.select({ id: ACT.id }).from(ACT).where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "initial_setup_scrape"), inArray(ACT.actionStatus, ["approved", "in_progress"]))).limit(1);
    if (busy) throw conflict("The agent is already learning about the business");
    const [row] = await db.update(S).set({ type, input }).where(eq(S.id, a.id)).returning();
    await db.insert(ACT).values({
      workspaceId: c.wsId,
      aiSdrId: a.id,
      actionType: "initial_setup_scrape",
      actionStatus: "approved",
      approvedBy: c.userId,
      approvedAt: new Date(),
      actionPayload: { type, input: type === "website" ? input : "(pitch text)", replace: a.initialScrapeReady },
    });
    return serializeSalesAgent(row!);
  });

  // Edits a drafted reply before it is approved.
  app.patch("/api/app/ai-agents/sales/:id/activities/:activity_id", { config: { perm: "unibox" as const, write: true } }, async (req) => {
    const c = ctx(req);
    const p = req.params as { id: string; activity_id: string };
    const a = await findSalesAgent(c.wsId, p.id);
    const b = body(req, z.object({ html: z.string().trim().min(1).max(200_000) }));
    const row = await pendingActivity(a.id, p.activity_id);
    if (row.actionType !== "email_sent") throw badRequest("Only drafted replies can be edited");
    const text = b.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const [updated] = await db
      .update(ACT)
      .set({ actionPayload: { ...(row.actionPayload ?? {}), html: cleanReplyHtml(b.html) }, actionOutput: { ...(row.actionOutput ?? {}), reply_preview: text.slice(0, 280), edited: true } })
      .where(eq(ACT.id, row.id))
      .returning();
    return serializeSalesActivity(updated!);
  });

  // Runs a decision round now instead of waiting for the hourly schedule.
  app.post("/api/app/ai-agents/sales/:id/run", { config: { perm: "edit_campaigns" as const, write: true } }, async (req) => {
    const c = ctx(req);
    const a = await findSalesAgent(c.wsId, (req.params as { id: string }).id);
    if (a.status !== 1) throw badRequest("Turn the agent on first");
    if (!(await aiAvailable(c.wsId))) throw badRequest(AI_NEEDED);
    if (!(await decide(a.id, { force: true }))) throw conflict("The agent is already planning. Its new proposals show up in the live feed when it's done.");
    const [fresh] = await db.select().from(S).where(eq(S.id, a.id)).limit(1);
    return serializeSalesAgent(fresh!);
  });
}

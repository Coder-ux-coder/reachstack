// AI Lead Finder Agent (API v2 /ai-agents/lead-finder): agents that keep a campaign stocked with fresh leads,
// their activity and stats, audience suggestions and saved AI enrichment workflows.
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client";
import { ctx } from "../http/context";
import { may } from "../http/auth";
import { assertFound, badRequest, conflict, forbidden } from "../http/errors";
import { body, query, zInt } from "../http/util";
import { iso } from "../lib/time";
import { toHttpError } from "../services/ai";
import { AgentStatus, AgentType, findAgent, logAgentEvent } from "../services/agents/common";
import { deleteAgent } from "../services/agents/delete";
import { suggestAudience } from "../services/agents/audience";
import {
  checkLeadFinderAgent,
  leadFinderAgentActivities,
  leadFinderAgentStats,
  lfaPayload,
  serializeLeadFinderAgent,
  validateAgentFilters,
  validateAiEnrichment,
  type LeadFinderAgentPayload,
} from "../services/agents/lead-finder-agent";

const A = schema.aiAgents;
const W = schema.enrichmentWorkflows;
type Act = "create" | "read" | "update" | "delete";
const cfg = (act: Act) => ({ scope: ["ai_agents", act] as [string, Act], perm: "lead_finder" as const, write: act !== "read" });
const LEADS_NEEDED = "The agent adds leads to a campaign, so setting one up needs access to leads.";

const SOURCES = ["agents_page", "campaign_banner", "supersearch", "announcement", "campaign_setup"] as const;

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  campaign_id: z.string().min(1),
  search_filters: z.record(z.unknown()),
  min_active_leads: z.number().int().min(1).max(100_000),
  on_exhaustion: z.enum(["pause", "fallback", "broaden"]),
  fallback_search_filters: z.record(z.unknown()).nullable().optional(),
  show_one_lead_per_company: z.boolean().optional(),
  source: z.enum(SOURCES).optional(),
  ai_enrichment: z.unknown().optional(),
  ai_enrichment_workflow: z.string().max(200).optional(),
  description: z.string().max(2_000).optional(),
});

const serializeWorkflow = (w: typeof W.$inferSelect) => ({ id: w.id, organization_id: w.workspaceId, name: w.name, payload: w.payload, timestamp_created: iso(w.createdAt), timestamp_updated: iso(w.updatedAt) });

/** A campaign is kept stocked by at most one agent that is running or paused. */
async function assertCampaignFree(wsId: string, campaignId: string, exceptAgentId?: string) {
  const [campaign] = await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.workspaceId, wsId))).limit(1);
  if (!campaign) throw badRequest("campaign_id: campaign not found");
  const others = await db
    .select({ id: A.id })
    .from(A)
    .where(and(eq(A.workspaceId, wsId), eq(A.type, AgentType.LEAD_FINDER), inArray(A.status, [AgentStatus.ACTIVE, AgentStatus.PAUSED]), sql`json_extract(${A.payload}, '$.campaign_id') = ${campaignId}`));
  if (others.some((o) => o.id !== exceptAgentId)) throw conflict("This campaign already has a Lead Finder Agent");
  return campaign;
}

export default async function leadFinderAgentRoutes(app: FastifyInstance) {
  const base = "/api/v2/ai-agents/lead-finder";
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ---------- Enrichment workflows (registered before /:id) ----------

  app.get(`${base}/enrichment-workflows`, { config: cfg("read") }, async (req) => {
    const rows = await db.select().from(W).where(eq(W.workspaceId, ctx(req).wsId)).orderBy(desc(W.createdAt)).limit(200);
    return { items: rows.map(serializeWorkflow) };
  });

  app.post(`${base}/enrichment-workflows`, { config: cfg("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(200), ai_enrichment: z.unknown() }));
    const steps = validateAiEnrichment(b.ai_enrichment);
    if (!steps || !Object.keys(steps).length) throw badRequest("ai_enrichment: add at least one column");
    const [row] = await db.insert(W).values({ workspaceId: c.wsId, name: b.name, payload: { ai_enrichment: steps } }).returning();
    return { workflow: serializeWorkflow(row!) };
  });

  app.delete(`${base}/enrichment-workflows/:id`, { config: cfg("delete") }, async (req) => {
    const c = ctx(req);
    const row = assertFound((await db.select().from(W).where(and(eq(W.id, idOf(req)), eq(W.workspaceId, c.wsId))).limit(1))[0], "Enrichment workflow");
    await db.delete(W).where(eq(W.id, row.id));
    return { success: true };
  });

  app.post(`${base}/suggest-audience`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ campaign_id: z.string().min(1), count: z.number().int().min(1).max(5).optional() }));
    const [campaign] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.id, b.campaign_id), eq(schema.campaigns.workspaceId, c.wsId))).limit(1);
    if (!campaign) throw badRequest("campaign_id: campaign not found");
    try {
      return await suggestAudience(c.wsId, campaign.id, b.count ?? 3);
    } catch (err) {
      throw toHttpError(err);
    }
  });

  // ---------- Agents ----------

  app.get(base, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), campaign_id: z.string().optional() }));
    if (q.campaign_id) {
      const rows = await db
        .select()
        .from(A)
        .where(and(eq(A.workspaceId, c.wsId), eq(A.type, AgentType.LEAD_FINDER), inArray(A.status, [AgentStatus.ACTIVE, AgentStatus.PAUSED]), sql`json_extract(${A.payload}, '$.campaign_id') = ${q.campaign_id}`))
        .limit(1);
      return { items: rows.map(serializeLeadFinderAgent) };
    }
    const limit = q.limit ?? 20;
    const conds = [eq(A.workspaceId, c.wsId), eq(A.type, AgentType.LEAD_FINDER)];
    if (q.starting_after) conds.push(lt(A.id, q.starting_after));
    const rows = await db.select().from(A).where(and(...conds)).orderBy(desc(A.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(serializeLeadFinderAgent), ...(rows.length > limit ? { next_starting_after: page[page.length - 1]!.id } : {}) };
  });

  app.post(base, { config: cfg("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, createBody);
    if (!may(req, "leads")) throw forbidden(LEADS_NEEDED);
    const campaign = await assertCampaignFree(c.wsId, b.campaign_id);
    const search = await validateAgentFilters(c.wsId, b.search_filters, "search_filters");
    const fallback = b.fallback_search_filters ? await validateAgentFilters(c.wsId, b.fallback_search_filters, "fallback_search_filters") : null;
    if (b.on_exhaustion === "fallback" && !fallback) throw badRequest("fallback_search_filters is required when on_exhaustion is fallback");
    const payload: LeadFinderAgentPayload = {
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      search_filters: search,
      min_active_leads: b.min_active_leads,
      on_exhaustion: b.on_exhaustion,
      fallback_search_filters: fallback,
      show_one_lead_per_company: b.show_one_lead_per_company ?? true,
      ai_enrichment: validateAiEnrichment(b.ai_enrichment),
      ai_enrichment_workflow: b.ai_enrichment_workflow ?? null,
      source: b.source,
      audience: "primary",
    };
    const [row] = await db
      .insert(A)
      .values({ workspaceId: c.wsId, name: b.name, description: b.description ?? null, type: AgentType.LEAD_FINDER, status: AgentStatus.ACTIVE, payload: payload as unknown as Record<string, unknown>, createdBy: c.userId })
      .returning();
    // The first check runs right away, in the background.
    void checkLeadFinderAgent(row!.id);
    return serializeLeadFinderAgent(row!);
  });

  app.get(`${base}/:id`, { config: cfg("read") }, async (req) => {
    const wsId = ctx(req).wsId;
    const out = serializeLeadFinderAgent(await findAgent(wsId, idOf(req), AgentType.LEAD_FINDER));
    // Its campaign can be deleted later (the agent stops then); the page says so instead of linking to it.
    const [campaign] = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(and(eq(schema.campaigns.id, out.payload.campaign_id), eq(schema.campaigns.workspaceId, wsId)))
      .limit(1);
    return { ...out, payload: { ...out.payload, campaign_deleted: !campaign } };
  });

  app.patch(`${base}/:id`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idOf(req), AgentType.LEAD_FINDER);
    const b = body(req, createBody.partial().extend({ ai_enrichment: z.unknown().optional(), fallback_search_filters: z.record(z.unknown()).nullable().optional() }));
    const p = { ...lfaPayload(a) };
    if (b.campaign_id && b.campaign_id !== p.campaign_id) {
      if (!may(req, "leads")) throw forbidden(LEADS_NEEDED);
      const campaign = await assertCampaignFree(c.wsId, b.campaign_id, a.id);
      p.campaign_id = campaign.id;
      p.campaign_name = campaign.name;
    }
    // A new audience starts over from the primary filters.
    if (b.search_filters) Object.assign(p, { search_filters: await validateAgentFilters(c.wsId, b.search_filters, "search_filters"), audience: "primary", broadened_filters: null, broadened_removed: [] });
    if (b.fallback_search_filters !== undefined) p.fallback_search_filters = b.fallback_search_filters ? await validateAgentFilters(c.wsId, b.fallback_search_filters, "fallback_search_filters") : null;
    if (b.min_active_leads !== undefined) p.min_active_leads = b.min_active_leads;
    if (b.on_exhaustion) p.on_exhaustion = b.on_exhaustion;
    if (p.on_exhaustion === "fallback" && !p.fallback_search_filters) throw badRequest("fallback_search_filters is required when on_exhaustion is fallback");
    if (b.show_one_lead_per_company !== undefined) p.show_one_lead_per_company = b.show_one_lead_per_company;
    if (b.ai_enrichment !== undefined) p.ai_enrichment = validateAiEnrichment(b.ai_enrichment);
    if (b.ai_enrichment_workflow !== undefined) p.ai_enrichment_workflow = b.ai_enrichment_workflow;
    p.next_check_at = undefined; // re-check with the new settings
    const [row] = await db
      .update(A)
      .set({ ...(b.name ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}), payload: p as unknown as Record<string, unknown> })
      .where(eq(A.id, a.id))
      .returning();
    return serializeLeadFinderAgent(row!);
  });

  app.delete(`${base}/:id`, { config: cfg("delete") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idOf(req), AgentType.LEAD_FINDER);
    await deleteAgent(a);
    return { success: true };
  });

  app.post(`${base}/:id/pause`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idOf(req), AgentType.LEAD_FINDER);
    if (a.status === AgentStatus.PAUSED) return serializeLeadFinderAgent(a);
    const [row] = await db.update(A).set({ status: AgentStatus.PAUSED }).where(eq(A.id, a.id)).returning();
    await logAgentEvent(c.wsId, a.id, "agent_paused", { reason: "Paused by a user" });
    return serializeLeadFinderAgent(row!);
  });

  app.post(`${base}/:id/resume`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idOf(req), AgentType.LEAD_FINDER);
    if (a.status === AgentStatus.ACTIVE) return serializeLeadFinderAgent(a);
    const p = lfaPayload(a);
    await assertCampaignFree(c.wsId, p.campaign_id, a.id);
    // Resuming after the audience ran dry starts again from the primary filters (which may have been widened).
    const payload = { ...p, audience: "primary", broadened_filters: null, broadened_removed: [], next_check_at: undefined } as unknown as Record<string, unknown>;
    const [row] = await db.update(A).set({ status: AgentStatus.ACTIVE, payload }).where(eq(A.id, a.id)).returning();
    await logAgentEvent(c.wsId, a.id, "agent_resumed", { reason: "Resumed by a user" });
    void checkLeadFinderAgent(a.id, { retryHeld: true });
    return serializeLeadFinderAgent(row!);
  });

  app.get(`${base}/:id/stats`, { config: cfg("read") }, async (req) => {
    const a = await findAgent(ctx(req).wsId, idOf(req), AgentType.LEAD_FINDER);
    return leadFinderAgentStats(a.id);
  });

  app.get(`${base}/:id/activities`, { config: cfg("read") }, async (req) => {
    const a = await findAgent(ctx(req).wsId, idOf(req), AgentType.LEAD_FINDER);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional() }));
    return leadFinderAgentActivities(a.id, q.limit ?? 20, q.starting_after);
  });

  // App: "Check now" runs a top-up check immediately (even above the threshold when forced).
  app.post("/api/app/ai-agents/lead-finder/:id/check", { config: { perm: "lead_finder" as const, write: true } }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, idOf(req), AgentType.LEAD_FINDER);
    if (a.status !== AgentStatus.ACTIVE) throw badRequest("Resume the agent first");
    const b = body(req, z.object({ force: z.boolean().optional() }));
    await checkLeadFinderAgent(a.id, { force: !!b.force });
    return { stats: await leadFinderAgentStats(a.id), activities: (await leadFinderAgentActivities(a.id, 10)).items, agent: serializeLeadFinderAgent((await findAgent(c.wsId, a.id, AgentType.LEAD_FINDER))) };
  });
}

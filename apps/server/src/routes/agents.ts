// App endpoints shared by every agent kind: the combined Agents list, a kind lookup for routing, and pausing the
// workspace's Deliverability Agent (deploying it again resumes it).
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { ctx } from "../http/context";
import { notFound } from "../http/errors";
import { iso } from "../lib/time";
import { aiAvailable } from "../services/ai";
import { AgentStatus, AgentType } from "../services/agents/common";
import { defaultAgent, serializeDeliverabilityAgent } from "../services/agents/deliverability-agent";
import { SendingStatus } from "../services/agents/inbox-manager";
import { lfaPayload } from "../services/agents/lead-finder-agent";
import { cfgOf } from "../services/agents/sales-agent";

const A = schema.aiAgents;
const S = schema.aiSalesAgents;

export type AgentKind = "reply" | "lead_finder" | "deliverability" | "sales";

const KIND_BY_TYPE: Record<number, AgentKind> = { [AgentType.INBOX_MANAGER]: "reply", [AgentType.LEAD_FINDER]: "lead_finder", [AgentType.DELIVERABILITY]: "deliverability" };

export default async function agentRoutes(app: FastifyInstance) {
  /** Every agent in the workspace, newest first, with the one or two numbers its card shows. */
  app.get("/api/app/ai-agents", { config: { perm: "view_campaigns" as const } }, async (req) => {
    const c = ctx(req);
    const [agents, sales] = await Promise.all([
      db.select().from(A).where(eq(A.workspaceId, c.wsId)).orderBy(desc(A.createdAt)),
      db.select().from(S).where(eq(S.workspaceId, c.wsId)).orderBy(desc(S.createdAt)),
    ]);
    const ids = agents.map((a) => a.id);
    const salesIds = sales.map((s) => s.id);
    const R = schema.aiAgentReplies;
    const E = schema.aiAgentEvents;
    const FI = schema.deliverabilityFeedItems;
    const ACT = schema.aiSalesAgentActivities;
    const none = ["__none__"];
    const [replyCounts, leadCounts, openIssues, scores, pendingSales, salesCampaigns] = await Promise.all([
      db
        .select({
          agentId: R.agentId,
          pending: sql<number>`sum(case when ${R.actionPending} = 1 and ${R.sendingStatus} <> ${SendingStatus.SENT} then 1 else 0 end)`,
          sent: sql<number>`sum(case when ${R.sendingStatus} = ${SendingStatus.SENT} then 1 else 0 end)`,
        })
        .from(R)
        .where(inArray(R.agentId, ids.length ? ids : none))
        .groupBy(R.agentId),
      db
        .select({ agentId: E.agentId, added: sql<number>`coalesce(sum(json_extract(${E.payload}, '$.leads_added')), 0)` })
        .from(E)
        .where(and(inArray(E.agentId, ids.length ? ids : none), eq(E.eventType, "top_up_completed")))
        .groupBy(E.agentId),
      db
        .select({ agentId: FI.agentId, n: sql<number>`count(*)` })
        .from(FI)
        .where(and(inArray(FI.agentId, ids.length ? ids : none), eq(FI.status, "todo")))
        .groupBy(FI.agentId),
      db
        .select({ agentId: schema.deliverabilityCycles.agentId, score: schema.deliverabilityCycles.score, completedAt: schema.deliverabilityCycles.completedAt })
        .from(schema.deliverabilityCycles)
        .where(and(inArray(schema.deliverabilityCycles.agentId, ids.length ? ids : none), eq(schema.deliverabilityCycles.status, "completed")))
        .orderBy(desc(schema.deliverabilityCycles.completedAt)),
      db
        .select({ agentId: ACT.aiSdrId, n: sql<number>`count(*)` })
        .from(ACT)
        .where(and(inArray(ACT.aiSdrId, salesIds.length ? salesIds : none), eq(ACT.actionStatus, "pending")))
        .groupBy(ACT.aiSdrId),
      db
        .select({ agentId: schema.campaigns.aiSdrId, n: sql<number>`count(*)` })
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.workspaceId, c.wsId), inArray(schema.campaigns.aiSdrId, salesIds.length ? salesIds : none)))
        .groupBy(schema.campaigns.aiSdrId),
    ]);
    const byId = <T extends { agentId: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.agentId, r]));
    const replies = byId(replyCounts);
    const leads = byId(leadCounts);
    const issues = byId(openIssues);
    const pending = byId(pendingSales);
    const campaigns = byId(salesCampaigns);
    const latestScore = new Map<string, number | null>();
    for (const s of scores) if (!latestScore.has(s.agentId)) latestScore.set(s.agentId, s.score);

    const items = [
      ...agents
        .filter((a) => KIND_BY_TYPE[a.type])
        .map((a) => {
          const kind = KIND_BY_TYPE[a.type]!;
          const base = { id: a.id, kind, name: a.name, description: a.description, status: a.status, created_at: iso(a.createdAt), last_run_at: iso(a.lastRunAt) };
          if (kind === "reply") {
            const p = (a.payload ?? {}) as { configuration_type?: number; no_show?: { enabled?: boolean } };
            const r = replies.get(a.id);
            return { ...base, mode: p.configuration_type === 2 ? "autopilot" : "review", no_show: !!p.no_show?.enabled, stats: { awaiting_review: Number(r?.pending ?? 0), sent: Number(r?.sent ?? 0) } };
          }
          if (kind === "lead_finder") {
            const p = lfaPayload(a);
            return { ...base, mode: null, campaign: { id: p.campaign_id, name: p.campaign_name ?? null }, stats: { leads_added: Number(leads.get(a.id)?.added ?? 0), min_active_leads: p.min_active_leads } };
          }
          return { ...base, mode: null, stats: { open_issues: Number(issues.get(a.id)?.n ?? 0), score: latestScore.get(a.id) ?? null } };
        }),
      ...sales.map((s) => ({
        id: s.id,
        kind: "sales" as const,
        name: s.name,
        description: s.description,
        status: s.status,
        created_at: iso(s.createdAt),
        last_run_at: iso(s.lastDecisionAt),
        mode: cfgOf(s).autonomy_settings.autopilot_mode ? "autopilot" : "review",
        agent_type: s.agentType,
        learning: !s.initialScrapeReady,
        stats: { awaiting_review: Number(pending.get(s.id)?.n ?? 0), campaigns: Number(campaigns.get(s.id)?.n ?? 0) },
      })),
    ].sort((x, y) => (y.created_at ?? "").localeCompare(x.created_at ?? ""));
    return { items, ai_available: await aiAvailable(c.wsId) };
  });

  /** Which kind of agent an id belongs to, so one URL can open any agent. */
  app.get("/api/app/ai-agents/:id", { config: { perm: "view_campaigns" as const } }, async (req) => {
    const c = ctx(req);
    const id = (req.params as { id: string }).id;
    const [a] = await db.select({ id: A.id, type: A.type, name: A.name }).from(A).where(and(eq(A.id, id), eq(A.workspaceId, c.wsId))).limit(1);
    if (a && KIND_BY_TYPE[a.type]) return { id: a.id, kind: KIND_BY_TYPE[a.type], name: a.name };
    const [s] = await db.select({ id: S.id, name: S.name }).from(S).where(and(eq(S.id, id), eq(S.workspaceId, c.wsId))).limit(1);
    if (s) return { id: s.id, kind: "sales" as const, name: s.name };
    throw notFound("Agent");
  });

  /** Stops the daily checks; queued checks are cancelled. Deploying again resumes the agent. */
  app.post("/api/app/ai-agents/deliverability/pause", { config: { perm: "accounts" as const, write: true } }, async (req) => {
    const c = ctx(req);
    const a = await defaultAgent(c.wsId);
    if (!a) throw notFound("Deliverability Agent");
    const [row] = await db.update(A).set({ status: AgentStatus.PAUSED }).where(eq(A.id, a.id)).returning();
    return { agent: serializeDeliverabilityAgent(row!) };
  });
}

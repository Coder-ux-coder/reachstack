// AI Deliverability Agent (API v2 /ai-agents/deliverability): the workspace's default agent, its live state,
// feed and the one-click actions on its recommendations.
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound, badRequest, conflict, notFound } from "../http/errors";
import { body, query, zInt } from "../http/util";
import { AgentStatus, AgentType, findAgent, serializeAgentSummary } from "../services/agents/common";
import { deleteAgent } from "../services/agents/delete";
import {
  agentState,
  completeItem,
  daPayload,
  defaultAgent,
  deployAgent,
  feedPage,
  pauseAffectedAccounts,
  pauseCampaignSending,
  serializeDeliverabilityAgent,
  serializeFeedItem,
  slackSettings,
  startCycle,
} from "../services/agents/deliverability-agent";

const A = schema.aiAgents;
const FI = schema.deliverabilityFeedItems;
type Act = "create" | "read" | "update" | "delete";
const cfg = (act: Act) => ({ scope: ["ai_agents", act] as [string, Act], perm: "accounts" as const, write: act !== "read" });
const withAccounts = { ...cfg("update"), scopeExtra: [["accounts", "update"]] as Array<[string, Act]> };

const slackBody = z.object({ slack: z.object({ connection_id: z.string().min(1), enabled: z.boolean() }).nullable() });
const stateQuery = z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), feed_filter: z.enum(["all", "todo", "done"]).optional() });

async function updateSlack(agentId: string, workspaceId: string, slack: z.infer<typeof slackBody>["slack"]) {
  const settings = await slackSettings(workspaceId, slack);
  if (settings === undefined) throw badRequest("slack.connection_id: no Slack connection with this id");
  const [a] = await db.select().from(A).where(eq(A.id, agentId)).limit(1);
  const p = daPayload(a!);
  const [row] = await db
    .update(A)
    .set({ payload: { ...p, integrations: { ...(p.integrations ?? {}), slack: settings } } as Record<string, unknown> })
    .where(eq(A.id, agentId))
    .returning();
  return row!;
}

export default async function deliverabilityAgentRoutes(app: FastifyInstance) {
  const base = "/api/v2/ai-agents/deliverability";
  const requireDefault = async (wsId: string) => {
    const a = await defaultAgent(wsId);
    if (!a) throw notFound("Deliverability Agent (deploy it first)");
    return a;
  };
  const findItem = async (wsId: string, id: string) => {
    const agent = await requireDefault(wsId);
    const item = assertFound((await db.select().from(FI).where(and(eq(FI.id, id), eq(FI.agentId, agent.id))).limit(1))[0], "Feed item");
    return { agent, item };
  };

  app.get(base, { config: cfg("read") }, async (req) => {
    const a = await defaultAgent(ctx(req).wsId);
    return { agent: a ? serializeDeliverabilityAgent(a) : null };
  });

  app.patch(`${base}/settings`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await requireDefault(c.wsId);
    const b = body(req, slackBody);
    return { agent: serializeDeliverabilityAgent(await updateSlack(a.id, c.wsId, b.slack)) };
  });

  app.get(`${base}/state`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const q = query(req, stateQuery);
    return agentState(await defaultAgent(c.wsId), { limit: q.limit ?? 20, startingAfter: q.starting_after, feedFilter: q.feed_filter ?? "all" });
  });

  app.post(`${base}/deploy`, { config: cfg("create") }, async (req) => {
    const c = ctx(req);
    const r = await deployAgent(c.wsId, c.userId);
    return { agent: serializeDeliverabilityAgent(r.agent), already_deployed: r.already, initial_cycle_enqueued: !!r.cycle?.enqueued, promo_credits_granted: null };
  });

  app.post(`${base}/run-now`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await requireDefault(c.wsId);
    if (a.status !== AgentStatus.ACTIVE) throw badRequest("The Deliverability Agent is paused; deploy it again to run checks");
    const r = await startCycle(a);
    const [fresh] = await db.select().from(A).where(eq(A.id, a.id)).limit(1);
    return { agent: serializeDeliverabilityAgent(fresh!), cycle_id: r.cycle.id, run_cycle_enqueued: r.enqueued };
  });

  app.post(`${base}/feed-items/:id/pause-affected-accounts`, { config: withAccounts }, async (req) => {
    const c = ctx(req);
    const { item } = await findItem(c.wsId, (req.params as { id: string }).id);
    if (!["dns_health_recommendation", "blocklist_recommendation"].includes(item.feedCode)) throw badRequest("This action applies to DNS health and blocklist recommendations");
    const r = await pauseAffectedAccounts(item);
    return { ...r, item: serializeFeedItem(r.item) };
  });

  app.post(`${base}/feed-items/:id/pause-campaign-sending`, { config: withAccounts }, async (req) => {
    const c = ctx(req);
    const { item } = await findItem(c.wsId, (req.params as { id: string }).id);
    if (!["bounce_health_recommendation", "warmup_score_recommendation"].includes(item.feedCode)) throw badRequest("This action applies to bounce health and warmup score recommendations");
    const r = await pauseCampaignSending(item);
    return { ...r, item: serializeFeedItem(r.item) };
  });

  app.post(`${base}/feed-items/:id/complete`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const { item } = await findItem(c.wsId, (req.params as { id: string }).id);
    const r = await completeItem(item);
    if ("error" in r) throw conflict(r.error);
    return { item: serializeFeedItem(r.item) };
  });

  // App: hide a feed item (it reopens after 7 days if the issue is still there).
  app.post("/api/app/ai-agents/deliverability/feed-items/:id/dismiss", { config: { perm: "accounts" as const, write: true } }, async (req) => {
    const c = ctx(req);
    const { item } = await findItem(c.wsId, (req.params as { id: string }).id);
    if (item.status !== "todo") return { item: serializeFeedItem(item) };
    const [row] = await db.update(FI).set({ status: "dismissed", dismissedAt: new Date() }).where(eq(FI.id, item.id)).returning();
    return { item: serializeFeedItem(row!) };
  });

  // ---------- By agent id ----------

  app.get(`${base}/:id`, { config: cfg("read") }, async (req) => serializeDeliverabilityAgent(await findAgent(ctx(req).wsId, (req.params as { id: string }).id, AgentType.DELIVERABILITY)));

  app.patch(`${base}/:id`, { config: cfg("update") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, (req.params as { id: string }).id, AgentType.DELIVERABILITY);
    const b = body(req, slackBody);
    return serializeDeliverabilityAgent(await updateSlack(a.id, c.wsId, b.slack));
  });

  app.delete(`${base}/:id`, { config: cfg("delete") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, (req.params as { id: string }).id, AgentType.DELIVERABILITY);
    await deleteAgent(a);
    return serializeAgentSummary(a);
  });

  app.get(`${base}/:id/state`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, (req.params as { id: string }).id, AgentType.DELIVERABILITY);
    const q = query(req, stateQuery);
    const { agent: _agent, ...state } = await agentState(a, { limit: q.limit ?? 20, startingAfter: q.starting_after, feedFilter: q.feed_filter ?? "all" });
    return state;
  });

  app.get(`${base}/:id/feed-items`, { config: cfg("read") }, async (req) => {
    const c = ctx(req);
    const a = await findAgent(c.wsId, (req.params as { id: string }).id, AgentType.DELIVERABILITY);
    const q = query(req, stateQuery);
    const page = await feedPage(a.id, q.feed_filter ?? "all", q.limit ?? 20, q.starting_after);
    return { items: page.items, ...(page.next_starting_after ? { next_starting_after: page.next_starting_after } : {}) };
  });
}

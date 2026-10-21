// Automations: the list, the editor's reads and writes, test runs, run History, "Ask AI", and the public URL
// that starts "Catch a webhook" automations.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  AUTOMATION_STATUSES,
  CONDITION_OPERATORS,
  DEFAULT_INTEREST_STATUSES,
  MAX_AUTOMATION_NODES,
  RUN_STATUSES,
  automationWarnings,
  emptyGraph,
  graphApps,
  graphSignature,
  triggerDef,
  type AutomationGraph,
  type ConditionOperator,
} from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { config } from "../env";
import { ctx } from "../http/context";
import { assertFound, badRequest, notFound, tooMany } from "../http/errors";
import { body, clientIp, params, query, zBool, zInt } from "../http/util";
import { iso } from "../lib/time";
import { aiAvailable } from "../services/ai";
import { buildAutomation, type BuildOptions } from "../services/automations/ai-build";
import { runAutomations, testStep } from "../services/automations/engine";
import { cancelRun, createRun, retryRun, runDetail, serializeRun, type WorkflowRow } from "../services/automations/runs";
import { scheduleFor } from "../services/automations/schedule";
import { manualOutput, receiveWebhook, triggerNode, triggerSamples } from "../services/automations/triggers";
import { listIntegrations } from "../services/integrations";

const W = schema.workflows;
const R = schema.workflowRuns;
const MAX_GRAPH_CHARS = 1_000_000;

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, - and _ in ids");
const dataSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  key: z.string().max(64).nullable().optional(),
  config: z.record(z.unknown()).optional(),
  sample: z.record(z.unknown()).nullable().optional(),
  tested: z.boolean().optional(),
  groups: z
    .array(
      z.object({
        rules: z
          .array(z.object({ field: z.string().max(500), operator: z.enum(CONDITION_OPERATORS.map((o) => o.value) as [ConditionOperator, ...ConditionOperator[]]), value: z.string().max(5_000).optional() }))
          .max(20),
      }),
    )
    .max(10)
    .optional(),
  amount: z.number().nullable().optional(),
  unit: z.enum(["minutes", "hours", "days"]).nullable().optional(),
  paths: z
    .array(z.object({ id, name: z.string().max(80) }))
    .max(10)
    .optional(),
});
const graphSchema = z
  .object({
    nodes: z.array(z.object({ id, type: z.enum(["trigger", "action", "condition", "delay", "paths", "merge"]), position: z.object({ x: z.number().finite(), y: z.number().finite() }), data: dataSchema })).max(MAX_AUTOMATION_NODES, `An automation can have at most ${MAX_AUTOMATION_NODES} steps.`),
    edges: z.array(z.object({ id, source: id, target: id, sourceHandle: z.string().max(64).nullable().optional() })).max(MAX_AUTOMATION_NODES * 4),
  })
  .superRefine((g, issue) => {
    const ids = new Set(g.nodes.map((n) => n.id));
    if (ids.size !== g.nodes.length) issue.addIssue({ code: z.ZodIssueCode.custom, message: "Two steps have the same id." });
    if (new Set(g.edges.map((e) => e.id)).size !== g.edges.length) issue.addIssue({ code: z.ZodIssueCode.custom, message: "Two connections have the same id." });
    if (g.edges.some((e) => !ids.has(e.source) || !ids.has(e.target))) issue.addIssue({ code: z.ZodIssueCode.custom, message: "A connection points to a step that doesn't exist." });
    if (g.edges.some((e) => e.source === e.target)) issue.addIssue({ code: z.ZodIssueCode.custom, message: "A step can't connect to itself." });
  });

function checkGraph(graph: unknown): AutomationGraph {
  if (JSON.stringify(graph).length > MAX_GRAPH_CHARS) throw badRequest("This automation is too large to save. Remove test data or steps.");
  return graph as AutomationGraph;
}

const newToken = () => randomBytes(24).toString("base64url");
const webhookUrl = (token: string | null) => (token ? `${config.appUrl}/api/hooks/automations/${token}` : null);
const triggerKey = (graph: AutomationGraph) => triggerNode(graph)?.data.key ?? null;

function serializeSummary(w: WorkflowRow) {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    status: w.status,
    trigger_type: w.triggerType,
    apps: graphApps(w.graph),
    steps: w.graph.nodes.length,
    run_count: w.runCount,
    last_run_at: iso(w.lastRunAt),
    next_run_at: iso(w.nextRunAt),
    problems: automationWarnings(w.graph).blocking,
    timestamp_created: iso(w.createdAt),
    timestamp_updated: iso(w.updatedAt),
  };
}

function serializeFull(w: WorkflowRow) {
  return {
    ...serializeSummary(w),
    graph: w.graph,
    version: w.version,
    webhook_url: triggerKey(w.graph) === "webhook" ? webhookUrl(w.webhookToken) : null,
    webhook_samples: (w.webhookSamples ?? []).length,
    warnings: automationWarnings(w.graph),
  };
}

async function findWorkflow(wsId: string, workflowId: string) {
  const [row] = await db
    .select()
    .from(W)
    .where(and(eq(W.id, workflowId), eq(W.workspaceId, wsId)))
    .limit(1);
  return assertFound(row, "Automation");
}

async function findRun(wsId: string, runId: string) {
  const [row] = await db
    .select()
    .from(R)
    .where(and(eq(R.id, runId), eq(R.workspaceId, wsId)))
    .limit(1);
  return assertFound(row, "Run");
}

/** Starts the engine right away when it runs in this process (otherwise its loop picks the run up). */
const kick = () => {
  if (config.runWorkerInProcess) void runAutomations().catch((err) => console.error("[automations]", err));
};

/** Campaigns, lists, labels, people and connections the editor's pickers (and Ask AI) choose from. */
async function workspaceOptions(wsId: string): Promise<BuildOptions> {
  const C = schema.campaigns;
  const M = schema.workspaceMembers;
  const S = schema.subsequences;
  const [campaigns, lists, custom, members, integrations, subs, sites] = await Promise.all([
    db.select({ id: C.id, name: C.name, status: C.status }).from(C).where(eq(C.workspaceId, wsId)).orderBy(asc(C.name)),
    db.select({ id: schema.leadLists.id, name: schema.leadLists.name }).from(schema.leadLists).where(eq(schema.leadLists.workspaceId, wsId)).orderBy(asc(schema.leadLists.name)),
    db
      .select({ code: schema.leadLabels.interestStatus, label: schema.leadLabels.label })
      .from(schema.leadLabels)
      .where(eq(schema.leadLabels.workspaceId, wsId))
      .orderBy(asc(schema.leadLabels.label)),
    db
      .select({ id: M.userId, email: M.email, firstName: schema.users.firstName, lastName: schema.users.lastName })
      .from(M)
      .innerJoin(schema.users, eq(schema.users.id, M.userId))
      .where(and(eq(M.workspaceId, wsId), eq(M.accepted, true))),
    listIntegrations(wsId),
    db.select({ id: S.id, name: S.name, campaignId: S.parentCampaignId }).from(S).where(eq(S.workspaceId, wsId)).orderBy(asc(S.name)),
    db.select({ id: schema.visitorSites.id, domain: schema.visitorSites.domain }).from(schema.visitorSites).where(eq(schema.visitorSites.workspaceId, wsId)),
  ]);
  const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));
  return {
    campaigns,
    lists,
    labels: [...DEFAULT_INTEREST_STATUSES.map((s) => ({ code: s.code, label: s.label })), ...custom],
    members: members.filter((m) => m.id).map((m) => ({ id: m.id!, email: m.email, name: `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || m.email })),
    slack: integrations.filter((i) => i.type === "slack").map((i) => ({ id: i.id, name: i.name ?? "Slack" })),
    subsequences: subs.map((s) => ({ id: s.id, name: s.name, campaign_id: s.campaignId, campaign_name: campaignNames.get(s.campaignId) ?? null })),
    sites,
  };
}

// Public webhook URL: requests per token per minute.
const hits = new Map<string, { start: number; n: number }>();
function allow(key: string, max: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > 60_000) {
    if (hits.size > 10_000) hits.clear();
    hits.set(key, { start: now, n: 1 });
    return true;
  }
  return ++h.n <= max;
}

export default async function automationRoutes(app: FastifyInstance) {
  const base = "/api/app/automations";
  const read = { perm: "edit_campaigns" as const };
  const write = { perm: "edit_campaigns" as const, write: true };

  // ---------- Automations ----------

  app.get(base, { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ search: z.string().optional(), status: z.enum(AUTOMATION_STATUSES).optional() }));
    const conds: SQL[] = [eq(W.workspaceId, c.wsId)];
    if (q.status) conds.push(eq(W.status, q.status));
    if (q.search?.trim()) conds.push(contains(sql`lower(${W.name})`, q.search.trim().toLowerCase()));
    const rows = await db
      .select()
      .from(W)
      .where(and(...conds))
      .orderBy(desc(W.updatedAt))
      .limit(500);
    return { items: rows.map(serializeSummary) };
  });

  app.post(base, { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().max(120).optional(), description: z.string().max(2_000).nullable().optional(), graph: graphSchema.optional() }));
    const graph = b.graph ? checkGraph(b.graph) : emptyGraph();
    const [row] = await db
      .insert(W)
      .values({
        workspaceId: c.wsId,
        name: b.name || "Untitled automation",
        description: b.description ?? null,
        status: "draft",
        graph,
        triggerType: triggerKey(graph),
        webhookToken: triggerKey(graph) === "webhook" ? newToken() : null,
        createdBy: c.userId,
      })
      .returning();
    return serializeFull(row!);
  });

  app.get(`${base}/options`, { config: read }, async (req) => {
    const c = ctx(req);
    return { ...(await workspaceOptions(c.wsId)), ai: await aiAvailable(c.wsId), webhook_base: `${config.appUrl}/api/hooks/automations/` };
  });

  app.post(`${base}/ai-build`, { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ prompt: z.string().trim().min(3, "Describe the automation you want").max(4_000), graph: graphSchema.optional() }));
    if (!(await aiAvailable(c.wsId))) throw badRequest("Ask AI needs an Anthropic API key. Add one in Settings → Integrations & API → AI.");
    return buildAutomation(c.wsId, b.prompt, b.graph ? checkGraph(b.graph) : emptyGraph(), await workspaceOptions(c.wsId));
  });

  app.get(`${base}/:id`, { config: read }, async (req) => {
    const p = params(req, z.object({ id: z.string() }));
    return serializeFull(await findWorkflow(ctx(req).wsId, p.id));
  });

  app.patch(`${base}/:id`, { config: write }, async (req) => {
    const c = ctx(req);
    const p = params(req, z.object({ id: z.string() }));
    const wf = await findWorkflow(c.wsId, p.id);
    const b = body(req, z.object({ name: z.string().trim().max(120).optional(), description: z.string().max(2_000).nullable().optional(), graph: graphSchema.optional() }));
    const set: Partial<typeof W.$inferInsert> = {};
    let turnedOff = false;
    if (b.name !== undefined) set.name = b.name || "Untitled automation";
    if (b.description !== undefined) set.description = b.description;
    if (b.graph) {
      const graph = checkGraph(b.graph);
      set.graph = graph;
      set.triggerType = triggerKey(graph);
      if (set.triggerType === "webhook" && !wf.webhookToken) set.webhookToken = newToken();
      if (graphSignature(graph) !== graphSignature(wf.graph)) {
        set.version = wf.version + 1;
        if (wf.status === "active") {
          // An active automation that now has problems is turned off rather than left to fail on every run.
          if (automationWarnings(graph).blocking) {
            set.status = "paused";
            set.nextRunAt = null;
            turnedOff = true;
          } else {
            const before = triggerNode(wf.graph);
            const after = triggerNode(graph);
            const scheduleChanged = JSON.stringify([before?.data.key, before?.data.config]) !== JSON.stringify([after?.data.key, after?.data.config]);
            if (scheduleChanged || !wf.nextRunAt) set.nextRunAt = scheduleFor({ status: "active", graph });
          }
        }
      }
    }
    if (!Object.keys(set).length) return { ...serializeFull(wf), turned_off: false };
    // Moving steps around or saving test data isn't "modified": keep updated_at unless the automation changed.
    if (!set.version && b.name === undefined && b.description === undefined) set.updatedAt = wf.updatedAt;
    const [row] = await db.update(W).set(set).where(eq(W.id, wf.id)).returning();
    return { ...serializeFull(row!), turned_off: turnedOff };
  });

  app.get(`${base}/:id/save-impact`, { config: read }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    const [counts] = await db
      .select({ waiting: sql<number>`sum(case when ${R.status} = 'waiting' then 1 else 0 end)`, running: sql<number>`sum(case when ${R.status} = 'running' then 1 else 0 end)` })
      .from(R)
      .where(eq(R.workflowId, wf.id));
    return { waiting: Number(counts?.waiting ?? 0), running: Number(counts?.running ?? 0) };
  });

  app.post(`${base}/:id/duplicate`, { config: write }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    const [row] = await db
      .insert(W)
      .values({
        workspaceId: c.wsId,
        name: `${wf.name} (copy)`.slice(0, 120),
        description: wf.description,
        status: "draft",
        graph: wf.graph,
        triggerType: wf.triggerType,
        webhookToken: wf.triggerType === "webhook" ? newToken() : null,
        createdBy: c.userId,
      })
      .returning();
    return serializeFull(row!);
  });

  app.delete(`${base}/:id`, { config: write }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    await db.delete(R).where(eq(R.workflowId, wf.id));
    await db.delete(W).where(eq(W.id, wf.id));
    return { ok: true };
  });

  app.post(`${base}/:id/status`, { config: write }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    const b = body(req, z.object({ status: z.enum(["active", "paused"]) }));
    if (b.status === "active") {
      const warnings = automationWarnings(wf.graph);
      if (warnings.blocking) throw badRequest(`Fix ${warnings.blocking === 1 ? "the problem" : `the ${warnings.blocking} problems`} marked in the editor before turning this automation on.`, { warnings });
    }
    if (wf.status === b.status) return serializeFull(wf);
    const [row] = await db
      .update(W)
      .set({ status: b.status, nextRunAt: scheduleFor({ status: b.status, graph: wf.graph }) })
      .where(eq(W.id, wf.id))
      .returning();
    return serializeFull(row!);
  });

  app.post(`${base}/:id/webhook/regenerate`, { config: write }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    const [row] = await db.update(W).set({ webhookToken: newToken(), updatedAt: wf.updatedAt }).where(eq(W.id, wf.id)).returning();
    return serializeFull(row!);
  });

  app.post(`${base}/:id/trigger-samples`, { config: read }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    const b = body(req, z.object({ key: z.string(), config: z.record(z.unknown()).default({}) }));
    const def = triggerDef(b.key);
    if (!def) throw badRequest("Choose a trigger first.");
    const u = c.auth.user;
    const items = await triggerSamples(wf, def.key, b.config, u ? { name: `${u.firstName} ${u.lastName}`.trim() || u.email, email: u.email } : null);
    return { items, example: def.example };
  });

  app.post(`${base}/:id/test-step`, { config: write }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    const b = body(req, z.object({ graph: graphSchema, node_id: z.string() }));
    return testStep(wf, checkGraph(b.graph), b.node_id);
  });

  app.post(`${base}/:id/run-test`, { config: write }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    const b = body(req, z.object({ trigger: z.record(z.unknown()).optional() }));
    const node = triggerNode(wf.graph);
    const def = triggerDef(node?.data.key);
    if (!node || !def) throw badRequest("Choose a trigger before running a test.");
    const run = await createRun(wf, b.trigger ?? node.data.sample ?? def.example, { isTest: true });
    kick();
    return serializeRun(run, wf);
  });

  app.post(`${base}/:id/run`, { config: write }, async (req) => {
    const c = ctx(req);
    const wf = await findWorkflow(c.wsId, params(req, z.object({ id: z.string() })).id);
    if (triggerKey(wf.graph) !== "manual") throw badRequest("Only automations that start manually can be run from here.");
    if (wf.status !== "active") throw badRequest("Turn the automation on to run it.");
    const u = c.auth.user;
    const run = await createRun(wf, manualOutput(u ? { name: `${u.firstName} ${u.lastName}`.trim() || u.email, email: u.email } : null));
    kick();
    return serializeRun(run, wf);
  });

  // ---------- History ----------

  app.get(`${base}/executions`, { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(
      req,
      z.object({
        workflow_id: z.string().optional(),
        status: z.enum(RUN_STATUSES).optional(),
        search: z.string().optional(),
        tests: zBool,
        limit: zInt(1, 100).optional(),
        page: zInt(1).optional(),
      }),
    );
    const limit = q.limit ?? 25;
    const page = q.page ?? 1;
    const conds: SQL[] = [eq(R.workspaceId, c.wsId)];
    if (q.workflow_id) conds.push(eq(R.workflowId, q.workflow_id));
    if (q.status) conds.push(eq(R.status, q.status));
    if (q.tests === false) conds.push(eq(R.isTest, false));
    if (q.search?.trim()) conds.push(contains(sql`lower(coalesce(${R.leadEmail}, ''))`, q.search.trim().toLowerCase()));
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(R)
        .where(and(...conds))
        .orderBy(desc(R.startedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({ n: sql<number>`count(*)` })
        .from(R)
        .where(and(...conds)),
    ]);
    const ids = [...new Set(rows.map((r) => r.workflowId))];
    const flows = ids.length ? await db.select().from(W).where(inArray(W.id, ids)) : [];
    const byId = new Map(flows.map((f) => [f.id, f]));
    return { items: rows.map((r) => serializeRun(r, byId.get(r.workflowId))), total: Number(total?.n ?? 0), page, limit };
  });

  app.get(`${base}/executions/:runId`, { config: read }, async (req) => {
    const c = ctx(req);
    return runDetail(await findRun(c.wsId, params(req, z.object({ runId: z.string() })).runId));
  });

  app.post(`${base}/executions/:runId/retry`, { config: write }, async (req) => {
    const c = ctx(req);
    const run = await retryRun(await findRun(c.wsId, params(req, z.object({ runId: z.string() })).runId));
    kick();
    return serializeRun(run);
  });

  app.post(`${base}/executions/:runId/cancel`, { config: write }, async (req) => {
    const c = ctx(req);
    return serializeRun(await cancelRun(await findRun(c.wsId, params(req, z.object({ runId: z.string() })).runId)));
  });

  // ---------- The public webhook URL ----------

  await app.register(async (hook) => {
    hook.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, raw, done) => done(null, Object.fromEntries(new URLSearchParams(String(raw)))));
    // Anything else (XML, CSV…) arrives as text.
    hook.addContentTypeParser("*", { parseAs: "string" }, (_req, raw, done) => done(null, raw));
    hook.route({
      method: ["GET", "POST", "PUT", "PATCH"],
      url: "/api/hooks/automations/:token",
      config: { auth: "public" },
      bodyLimit: 256 * 1024,
      handler: async (req) => {
        const { token } = params(req, z.object({ token: z.string().min(16).max(64) }));
        if (!allow(`${token}`, 120) || !allow(`ip:${clientIp(req)}`, 600)) throw tooMany("Too many requests to this webhook. Slow down and try again in a minute.");
        const result = await receiveWebhook(token, { method: req.method, body: req.body ?? null, query: req.query ?? {}, headers: req.headers as Record<string, unknown>, contentType: (req.headers["content-type"] as string | undefined) ?? null });
        if (!result) throw notFound("Webhook");
        if (result.started) kick();
        return result.started ? { status: "accepted", run_id: result.run_id } : { status: "received", message: "Saved as test data. Turn the automation on to start runs." };
      },
    });
  });
}

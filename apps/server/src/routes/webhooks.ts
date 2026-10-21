// Webhooks and webhook delivery events (API v2).
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity, WEBHOOK_EVENT_TYPES } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound, badRequest } from "../http/errors";
import { body, query, zBool, zInt } from "../http/util";
import { assertPublicHttpUrl } from "../lib/net";
import { audit } from "../services/audit";
import { serializeWebhook, serializeWebhookEvent, testWebhook, webhookEventTypes } from "../services/webhooks";
import { daySql, workspaceRange } from "../services/workspace-clock";

const W = schema.webhooks;
const EV = schema.webhookEvents;

const eventType = z.enum(WEBHOOK_EVENT_TYPES as unknown as [string, ...string[]]);

/** Set for every delivery, or by the connection itself: a webhook's own headers can't replace them. */
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect", "proxy-authorization", "proxy-connection", "x-webhook-signature"]);
/** Extra headers a delivery can carry: names and values an HTTP request can hold, checked when they're saved. */
const headersSchema = z
  .record(z.string().max(2000))
  .superRefine((headers, issue) => {
    const names = Object.keys(headers);
    if (names.length > 20) issue.addIssue({ code: "custom", message: "Add up to 20 headers." });
    for (const name of names) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name)) issue.addIssue({ code: "custom", message: `"${name.slice(0, 100)}" isn't a header name: use letters, digits and dashes.` });
      else if (RESERVED_HEADERS.has(name.toLowerCase())) issue.addIssue({ code: "custom", message: `${name} is set for each delivery and can't be changed.` });
      else if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(headers[name]!)) issue.addIssue({ code: "custom", message: `The value of ${name} can't contain line breaks or characters outside Latin-1.` });
    }
  })
  .nullable()
  .optional();
const fields = z.object({
  campaign: z.string().nullable().optional(),
  name: z.string().trim().max(200).nullable().optional(),
  target_hook_url: z.string().url().max(2000),
  event_type: eventType.nullable().optional(),
  custom_interest_value: z.number().int().nullable().optional(),
  headers: headersSchema,
});

/** A webhook limited to one campaign: one of this workspace's. */
async function assertCampaign(wsId: string, campaignId: string | null | undefined) {
  if (!campaignId) return;
  const [row] = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.workspaceId, wsId)))
    .limit(1);
  if (!row) throw badRequest("campaign: no campaign with that id in this workspace");
}

function columns(b: Partial<z.infer<typeof fields>>): Partial<typeof W.$inferInsert> {
  const out: Partial<typeof W.$inferInsert> = {};
  if (b.campaign !== undefined) out.campaignId = b.campaign;
  if (b.name !== undefined) out.name = b.name;
  if (b.target_hook_url !== undefined) out.targetHookUrl = b.target_hook_url;
  if (b.event_type !== undefined) out.eventType = b.event_type;
  if (b.custom_interest_value !== undefined) out.customInterestValue = b.custom_interest_value;
  if (b.headers !== undefined) out.headers = b.headers;
  return out;
}

async function findHook(wsId: string, id: string) {
  const [row] = await db.select().from(W).where(and(eq(W.id, id), eq(W.workspaceId, wsId))).limit(1);
  return assertFound(row, "Webhook");
}

/** Deliveries in the days asked for (whole days on the workspace's clock, or exact times). */
async function dayRange(wsId: string, from?: string, to?: string): Promise<SQL[]> {
  const r = await workspaceRange(wsId, from, to);
  const conds: SQL[] = [];
  if (r.start !== undefined) conds.push(gte(EV.createdAt, new Date(r.start)));
  if (r.end !== undefined) conds.push(lte(EV.createdAt, new Date(r.end)));
  return conds;
}

export default async function webhookRoutes(app: FastifyInstance) {
  const read = { scope: ["webhooks", "read"] as ["webhooks", "read"], perm: "settings" as const };
  const write = (a: "create" | "update" | "delete") => ({ scope: ["webhooks", a] as ["webhooks", typeof a], perm: "settings" as const, write: true });
  const evRead = { scope: ["webhook_events", "read"] as ["webhook_events", "read"], perm: "settings" as const };

  app.get("/api/v2/webhooks/event-types", { config: read }, async () => ({ event_types: webhookEventTypes() }));

  app.get("/api/v2/webhooks", { config: read }, async (req) => {
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), campaign: z.string().optional(), event_type: z.string().optional() }));
    const c = ctx(req);
    const limit = q.limit ?? 10;
    const conds: SQL[] = [eq(W.workspaceId, c.wsId)];
    if (q.campaign) conds.push(eq(W.campaignId, q.campaign));
    if (q.event_type) conds.push(eq(W.eventType, q.event_type));
    if (q.starting_after) conds.push(lt(W.id, q.starting_after));
    const rows = await db.select().from(W).where(and(...conds)).orderBy(desc(W.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(serializeWebhook), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  app.post("/api/v2/webhooks", { config: write("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, fields.extend({ signing_secret: z.boolean().optional() }));
    await assertPublicHttpUrl(b.target_hook_url);
    await assertCampaign(c.wsId, b.campaign);
    const [row] = await db
      .insert(W)
      .values({
        workspaceId: c.wsId,
        targetHookUrl: b.target_hook_url,
        ...columns(b),
        eventType: b.custom_interest_value != null ? null : (b.event_type ?? "all_events"),
        secret: b.signing_secret ? randomBytes(24).toString("base64url") : null,
        createdBy: c.userId,
      })
      .returning();
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.WEBHOOK_CREATED, req, webhookId: row!.id });
    return { ...serializeWebhook(row!), ...(row!.secret ? { signing_secret: row!.secret } : {}) };
  });

  app.get("/api/v2/webhooks/:id", { config: read }, async (req) => serializeWebhook(await findHook(ctx(req).wsId, (req.params as { id: string }).id)));

  app.patch("/api/v2/webhooks/:id", { config: write("update") }, async (req) => {
    const c = ctx(req);
    const hook = await findHook(c.wsId, (req.params as { id: string }).id);
    const b = body(req, fields.partial());
    if (b.target_hook_url) await assertPublicHttpUrl(b.target_hook_url);
    await assertCampaign(c.wsId, b.campaign);
    const patch = columns(b);
    if (!Object.keys(patch).length) return serializeWebhook(hook);
    const [row] = await db.update(W).set(patch).where(eq(W.id, hook.id)).returning();
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.WEBHOOK_UPDATED, req, webhookId: hook.id });
    return serializeWebhook(row!);
  });

  app.delete("/api/v2/webhooks/:id", { config: write("delete") }, async (req) => {
    const c = ctx(req);
    const hook = await findHook(c.wsId, (req.params as { id: string }).id);
    await db.delete(W).where(eq(W.id, hook.id));
    await db.update(EV).set({ willRetry: false }).where(and(eq(EV.webhookId, hook.id), eq(EV.willRetry, true)));
    return serializeWebhook(hook);
  });

  app.post("/api/v2/webhooks/:id/test", { config: write("update") }, async (req) => {
    const hook = await findHook(ctx(req).wsId, (req.params as { id: string }).id);
    return testWebhook(hook);
  });

  app.post("/api/v2/webhooks/:id/resume", { config: write("update") }, async (req) => {
    const c = ctx(req);
    const hook = await findHook(c.wsId, (req.params as { id: string }).id);
    const [row] = await db.update(W).set({ status: 1, consecutiveFailures: 0, timestampError: null }).where(eq(W.id, hook.id)).returning();
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.WEBHOOK_RESUMED, req, webhookId: hook.id });
    return serializeWebhook(row!);
  });

  // ---------- Delivery log ----------

  app.get("/api/v2/webhook-events/summary", { config: evRead }, async (req) => {
    const q = query(req, z.object({ from: z.string().optional(), to: z.string().optional() }));
    const [r] = await db
      .select({ total: sql<number>`count(*)`, ok: sql<number>`sum(case when ${EV.success} = 1 then 1 else 0 end)` })
      .from(EV)
      .where(and(eq(EV.workspaceId, ctx(req).wsId), ...(await dayRange(ctx(req).wsId, q.from, q.to))));
    const total = Number(r?.total ?? 0);
    const ok = Number(r?.ok ?? 0);
    const pct = (n: number) => (total ? Math.round((n / total) * 10000) / 100 : 0);
    return { total_events: total, successful_events: ok, failed_events: total - ok, success_rate: pct(ok), failure_rate: pct(total - ok) };
  });

  app.get("/api/v2/webhook-events/summary-by-date", { config: evRead }, async (req) => {
    const q = query(req, z.object({ from: z.string().optional(), to: z.string().optional() }));
    const wsId = ctx(req).wsId;
    const day = daySql(EV.createdAt, await workspaceRange(wsId, q.from, q.to));
    const rows = await db
      .select({ date: day, total: sql<number>`count(*)`, ok: sql<number>`sum(case when ${EV.success} = 1 then 1 else 0 end)` })
      .from(EV)
      .where(and(eq(EV.workspaceId, wsId), ...(await dayRange(wsId, q.from, q.to))))
      .groupBy(day)
      .orderBy(day);
    return {
      items: rows.map((r) => {
        const total = Number(r.total);
        const ok = Number(r.ok);
        return { date: r.date, total_events: total, successful_events: ok, failed_events: total - ok, success_rate: total ? Math.round((ok / total) * 10000) / 100 : 0 };
      }),
    };
  });

  app.get("/api/v2/webhook-events", { config: evRead }, async (req) => {
    const q = query(
      req,
      z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), success: zBool, from: z.string().optional(), to: z.string().optional(), search: z.string().optional() }),
    );
    const c = ctx(req);
    const limit = q.limit ?? 10;
    const conds: SQL[] = [eq(EV.workspaceId, c.wsId), ...(await dayRange(c.wsId, q.from, q.to))];
    if (q.success !== undefined) conds.push(eq(EV.success, q.success));
    if (q.search) conds.push(or(eq(EV.webhookUrl, q.search), eq(EV.leadEmail, q.search.toLowerCase()))!);
    if (q.starting_after) conds.push(lt(EV.id, q.starting_after));
    const rows = await db.select().from(EV).where(and(...conds)).orderBy(desc(EV.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(serializeWebhookEvent), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  app.get("/api/v2/webhook-events/:id", { config: evRead }, async (req) => {
    const [row] = await db
      .select()
      .from(EV)
      .where(and(eq(EV.id, (req.params as { id: string }).id), eq(EV.workspaceId, ctx(req).wsId)))
      .limit(1);
    return serializeWebhookEvent(assertFound(row, "Webhook event"));
  });

  /** Re-queues a failed delivery immediately. */
  app.post("/api/app/webhook-events/:id/retry", { config: { perm: "settings", write: true } }, async (req) => {
    const [row] = await db
      .update(EV)
      .set({ willRetry: true, nextRetryAt: new Date() })
      .where(and(eq(EV.id, (req.params as { id: string }).id), eq(EV.workspaceId, ctx(req).wsId), eq(EV.success, false)))
      .returning();
    return serializeWebhookEvent(assertFound(row, "Webhook event"));
  });
}

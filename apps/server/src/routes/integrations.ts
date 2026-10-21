// App connections (Settings → Integrations & API): Slack incoming webhooks and Calendly booking links that agents
// and automations reference by id.
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound } from "../http/errors";
import { body } from "../http/util";
import { safeFetch } from "../lib/net";
import { createIntegration, integrationSecret, listIntegrations, postToSlack, serializeIntegration, SUPPORTED_INTEGRATIONS, type CalendlyConfig } from "../services/integrations";
import { config } from "../env";

export default async function integrationRoutes(app: FastifyInstance) {
  const I = schema.integrations;
  const find = async (wsId: string, id: string) => assertFound((await db.select().from(I).where(and(eq(I.id, id), eq(I.workspaceId, wsId))).limit(1))[0], "Connection");

  app.get("/api/app/integrations", { config: { perm: "settings" } }, async (req) => ({ items: await listIntegrations(ctx(req).wsId), available: SUPPORTED_INTEGRATIONS }));

  app.post("/api/app/integrations", { config: { perm: "settings", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ type: z.enum(SUPPORTED_INTEGRATIONS), name: z.string().trim().max(100).optional(), config: z.record(z.unknown()) }));
    return serializeIntegration(await createIntegration(c.wsId, c.userId, b.type, b.name ?? null, b.config));
  });

  app.delete("/api/app/integrations/:id", { config: { perm: "settings", write: true } }, async (req) => {
    const c = ctx(req);
    const row = await find(c.wsId, (req.params as { id: string }).id);
    await db.delete(I).where(eq(I.id, row.id));
    return { success: true };
  });

  /** Sends a test message (Slack) or checks the booking page answers (Calendly). */
  app.post("/api/app/integrations/:id/test", { config: { perm: "settings", write: true } }, async (req) => {
    const c = ctx(req);
    const row = await find(c.wsId, (req.params as { id: string }).id);
    let ok = false;
    let error: string | null = null;
    if (row.type === "slack") {
      ok = await postToSlack(c.wsId, row.id, `${config.brandName}: this channel is connected and will receive agent notifications.`);
      if (!ok) error = (await find(c.wsId, row.id)).error ?? "Slack did not accept the message";
    } else if (row.type === "calendly") {
      const url = integrationSecret<CalendlyConfig>(row)?.scheduling_url;
      try {
        const res = url ? await safeFetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) }) : null;
        ok = !!res?.ok;
        if (!ok) error = res ? `The booking page answered HTTP ${res.status}` : "No booking link saved";
        await res?.body?.cancel().catch(() => {});
      } catch (err) {
        error = (err as Error).message;
      }
      await db.update(I).set({ status: ok ? "connected" : "error", error }).where(eq(I.id, row.id));
    }
    return { ok, error, connection: serializeIntegration(await find(c.wsId, row.id)) };
  });
}

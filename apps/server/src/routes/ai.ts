// AI endpoints shared across features: reply-label prediction (API v2), workspace AI settings and usage.
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client";
import { config } from "../env";
import { ctx } from "../http/context";
import { body, query, zInt } from "../http/util";
import { encrypt } from "../lib/crypto";
import { aiAvailable, aiConfigured, complete, invalidateWorkspaceAi, toHttpError } from "../services/ai";
import { classifyReply } from "../services/reply-labels";
import { patchWorkspaceSettings } from "../services/workspaces";

export default async function aiRoutes(app: FastifyInstance) {
  app.post("/api/v2/lead-labels/ai-reply-label", { config: { scope: ["lead-labels", "read"], perm: "leads" } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ reply_text: z.string().min(1).max(50_000) }));
    try {
      const r = await classifyReply(c.wsId, b.reply_text);
      return { result: r.label, custom_labels_considered: r.considered, interest_status: r.code, confidence: r.confidence, reason: r.reason, method: r.method };
    } catch (err) {
      throw toHttpError(err);
    }
  });

  // ---------- Workspace AI settings ----------

  app.get("/api/app/ai/settings", { config: { perm: "settings" } }, async (req) => {
    const ws = ctx(req).workspace;
    const s = ws.settings ?? {};
    return {
      server_key_configured: aiConfigured(),
      workspace_key_set: !!s.anthropic_api_key_enc,
      model: s.ai_model ?? null,
      default_model: config.anthropic.model,
      available: await aiAvailable(ws.id),
      auto_label_with_ai: !!s.auto_label_with_ai,
    };
  });

  app.put("/api/app/ai/settings", { config: { perm: "settings", admin: true } }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        anthropic_api_key: z.string().trim().max(400).nullable().optional(),
        model: z
          .string()
          .trim()
          .regex(/^claude-[a-z0-9.-]+$/, "Use a Claude model id such as claude-opus-5-5")
          .nullable()
          .optional(),
        auto_label_with_ai: z.boolean().optional(),
      }),
    );
    const patch: Record<string, unknown> = {};
    if (b.anthropic_api_key !== undefined) patch.anthropic_api_key_enc = b.anthropic_api_key ? encrypt(b.anthropic_api_key) : null;
    if (b.model !== undefined) patch.ai_model = b.model || null;
    if (b.auto_label_with_ai !== undefined) patch.auto_label_with_ai = b.auto_label_with_ai;
    await patchWorkspaceSettings(c.wsId, patch);
    invalidateWorkspaceAi(c.wsId);
    return { ok: true, available: await aiAvailable(c.wsId) };
  });

  /** Sends a tiny request with the current settings so users can confirm their key and model work. */
  app.post("/api/app/ai/test", { config: { perm: "settings" } }, async (req) => {
    const c = ctx(req);
    try {
      const r = await complete({ workspaceId: c.wsId, feature: "settings_test", effort: "low", maxTokens: 200, messages: [{ role: "user", content: "Reply with the single word OK." }] });
      return { ok: true, model: r.message.model, reply: r.text.slice(0, 50) };
    } catch (err) {
      throw toHttpError(err);
    }
  });

  app.get("/api/app/ai/usage", { config: { perm: "settings" } }, async (req) => {
    const q = query(req, z.object({ days: zInt(1, 365).optional() }));
    const since = new Date(Date.now() - (q.days ?? 30) * 86_400_000);
    const U = schema.aiUsage;
    const rows = await db
      .select({
        feature: U.feature,
        model: U.model,
        requests: sql<number>`count(*)`,
        input: sql<number>`sum(${U.inputTokens})`,
        output: sql<number>`sum(${U.outputTokens})`,
        cache_read: sql<number>`sum(${U.cacheReadTokens})`,
        cache_write: sql<number>`sum(${U.cacheWriteTokens})`,
      })
      .from(U)
      .where(and(eq(U.workspaceId, ctx(req).wsId), gte(U.createdAt, since)))
      .groupBy(U.feature, U.model)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ ...r, requests: Number(r.requests), input: Number(r.input ?? 0), output: Number(r.output ?? 0), cache_read: Number(r.cache_read ?? 0), cache_write: Number(r.cache_write ?? 0) }));
  });
}

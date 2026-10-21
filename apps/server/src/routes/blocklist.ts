// Settings → Blocklist extras: the Google Sheet link and the automatic triggers. Entries themselves live
// under /api/v2/block-lists-entries.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client";
import { ctx } from "../http/context";
import { body } from "../http/util";
import { syncBlockSheet, type BlockTriggers } from "../services/blocklist";
import { patchWorkspaceSettings } from "../services/workspaces";

export default async function blocklistRoutes(app: FastifyInstance) {
  const read = { perm: "blocklist" as const };
  const write = { perm: "blocklist" as const, write: true };

  app.get("/api/app/blocklist/settings", { config: read }, async (req) => {
    const ws = ctx(req).workspace;
    const s = (ws.settings ?? {}) as { global_block_sheet_link?: string | null; global_block_sheet_synced_at?: string | null; global_block_sheet_error?: string | null; blocklist_triggers?: BlockTriggers };
    return {
      add_unsub_to_block: ws.addUnsubToBlock,
      sheet_link: s.global_block_sheet_link ?? null,
      sheet_synced_at: s.global_block_sheet_synced_at ?? null,
      sheet_error: s.global_block_sheet_error ?? null,
      triggers: { statuses: s.blocklist_triggers?.statuses ?? [], phrases: s.blocklist_triggers?.phrases ?? [] },
    };
  });

  app.put("/api/app/blocklist/settings", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        add_unsub_to_block: z.boolean().optional(),
        triggers: z.object({ statuses: z.array(z.number().int()).max(50), phrases: z.array(z.string().trim().min(1).max(200)).max(100) }).optional(),
      }),
    );
    if (b.add_unsub_to_block !== undefined) await db.update(schema.workspaces).set({ addUnsubToBlock: b.add_unsub_to_block }).where(eq(schema.workspaces.id, c.wsId));
    if (b.triggers) await patchWorkspaceSettings(c.wsId, { blocklist_triggers: b.triggers });
    return { ok: true };
  });

  /** Links a public Google Sheet (one column of emails/domains), imports it now and re-reads it daily. */
  app.post("/api/app/blocklist/sheet", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ url: z.string().url().max(2000) }));
    return syncBlockSheet(c.wsId, b.url);
  });

  app.delete("/api/app/blocklist/sheet", { config: write }, async (req) => {
    await patchWorkspaceSettings(ctx(req).wsId, { global_block_sheet_link: null, global_block_sheet_synced_at: null, global_block_sheet_error: null });
    return { ok: true };
  });
}

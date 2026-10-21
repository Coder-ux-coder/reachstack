// Recently deleted (Settings → Recently deleted): what was deleted in this workspace in the last 30 days, with Restore
// and Delete forever. Browser sessions only. Restoring, or deleting for good, needs the permission that deleting that
// kind of item needs, so each entry is checked on its own.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuditActivity } from "@reachstack/shared";
import { ctx } from "../http/context";
import { forbidden } from "../http/errors";
import { params, query, zInt } from "../http/util";
import { actorOf, audit } from "../services/audit";
import {
  DELETED_KINDS,
  RETENTION_DAYS,
  canManageDeleted,
  deleteForever,
  findDeleted,
  listDeleted,
  restoreDeleted,
  serializeDeleted,
  type DeletedEntry,
} from "../services/recently-deleted";

/** The entry, when this member may restore it or delete it for good. */
async function manageable(req: FastifyRequest): Promise<DeletedEntry> {
  const c = ctx(req);
  const p = params(req, z.object({ id: z.string().min(1).max(64) }));
  const entry = await findDeleted(c.wsId, p.id);
  if (!canManageDeleted(req.auth, entry)) throw forbidden();
  return entry;
}

/** Restores and deletes for good show in the audit log like the delete they follow. */
async function auditEntry(req: FastifyRequest, e: DeletedEntry, action: "restore" | "delete_forever", leads: number) {
  const meta = (e.meta ?? {}) as { campaign_id?: string };
  const base = { workspaceId: e.workspaceId, req, metadata: { action, name: e.name } };
  if (e.kind === "campaign") {
    await audit({ ...base, activityType: action === "restore" ? AuditActivity.CAMPAIGN_UPDATE : AuditActivity.CAMPAIGN_DELETION, campaignId: e.itemId });
  } else if (e.kind === "subsequence") {
    await audit({ ...base, activityType: AuditActivity.SUBSEQUENCE_UPDATE, campaignId: meta.campaign_id ?? null, subsequenceId: e.itemId });
  } else if (e.kind === "leads" || e.kind === "lead_list") {
    await audit({ ...base, activityType: action === "restore" ? AuditActivity.LEAD_ADDED : AuditActivity.LEAD_DELETION, affectedCount: leads, listId: e.kind === "lead_list" ? e.itemId : null });
  }
}

export default async function recentlyDeletedRoutes(app: FastifyInstance) {
  app.get("/api/app/recently-deleted", async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ kind: z.enum(DELETED_KINDS).optional(), limit: zInt(1, 100).optional(), starting_after: z.string().max(64).optional() }));
    const page = await listDeleted(req.auth, c.wsId, { kind: q.kind, limit: q.limit ?? 50, startingAfter: q.starting_after });
    return { items: page.items.map((e) => serializeDeleted(e, req.auth)), next_starting_after: page.next, retention_days: RETENTION_DAYS };
  });

  app.post("/api/app/recently-deleted/:id/restore", async (req) => {
    const entry = await manageable(req);
    const result = await restoreDeleted(entry, actorOf(req));
    await auditEntry(req, entry, "restore", result.counts.leads ?? 0);
    return result;
  });

  app.delete("/api/app/recently-deleted/:id", async (req) => {
    const entry = await manageable(req);
    await deleteForever(entry);
    await auditEntry(req, entry, "delete_forever", Number(entry.counts.leads ?? 0));
    return { ok: true };
  });
}

// Campaign subsequences (API v2): CRUD, pause/resume, duplicate, analytics and sending status.
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, lt, ne, notInArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity, CampaignStatus, LeadStatus } from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound, badRequest } from "../http/errors";
import { body, query, zInt } from "../http/util";
import { actorOf, audit } from "../services/audit";
import { DEFAULT_SEQUENCES, activeSteps, aggregateMetrics, dailyMetrics, reopenForSubsequences, sequenceProblems, stepMetrics, type SubsequenceRow } from "../services/campaigns";
import { trashSubsequence } from "../services/recently-deleted";
import { recordSequenceVersion } from "../services/sequence-versions";
import { createSubsequenceSchema, patchSubsequenceSchema, serializeSubsequence, subsequenceColumns } from "../services/subsequences";
import { workspaceRange } from "../services/workspace-clock";
import { findCampaign, sendingStatus } from "./campaigns";

const S = schema.subsequences;
const E = schema.emailEvents;

async function findSub(wsId: string, id: string): Promise<SubsequenceRow> {
  const [row] = await db.select().from(S).where(and(eq(S.id, id), eq(S.workspaceId, wsId))).limit(1);
  return assertFound(row, "Subsequence");
}

export default async function subsequenceRoutes(app: FastifyInstance) {
  const read = { scope: ["subsequences", "read"] as ["subsequences", "read"], perm: "view_campaigns" as const };
  const write = (action: "create" | "update" | "delete") => ({ scope: ["subsequences", action] as ["subsequences", typeof action], perm: "edit_campaigns" as const, write: true });

  app.post("/api/v2/subsequences", { config: write("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, createSubsequenceSchema);
    const parent = await findCampaign(c.wsId, b.parent_campaign);
    const cond = b.conditions;
    if (!cond.crm_status?.length && !cond.lead_activity?.length && !cond.reply_contains?.trim()) throw badRequest("Add at least one condition that triggers the subsequence");
    const [row] = await db
      .insert(S)
      .values({
        workspaceId: c.wsId,
        parentCampaignId: parent.id,
        name: b.name,
        conditions: cond,
        schedule: null,
        sequences: DEFAULT_SEQUENCES,
        // A new subsequence has no emails yet; it starts once they're written (POST …/resume).
        status: CampaignStatus.DRAFT,
        ...subsequenceColumns(b),
      })
      .returning();
    await recordSequenceVersion({ workspaceId: c.wsId, campaignId: parent.id, subsequenceId: row!.id, before: null, after: row!.sequences, actor: actorOf(req), source: "create" });
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.SUBSEQUENCE_UPDATE, req, campaignId: parent.id, subsequenceId: row!.id, metadata: { action: "create" } });
    return serializeSubsequence(row!);
  });

  app.get("/api/v2/subsequences", { config: read }, async (req) => {
    const q = query(
      req,
      z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), parent_campaign: z.string().optional(), parent_campaign_not: z.string().optional(), search: z.string().optional() }),
    );
    const c = ctx(req);
    if (!q.parent_campaign && !q.parent_campaign_not) throw badRequest("parent_campaign is required");
    const limit = q.limit ?? 10;
    const conds: SQL[] = [eq(S.workspaceId, c.wsId)];
    if (q.parent_campaign) conds.push(eq(S.parentCampaignId, q.parent_campaign));
    if (q.parent_campaign_not) conds.push(ne(S.parentCampaignId, q.parent_campaign_not));
    if (q.search) conds.push(contains(S.name, q.search));
    if (q.starting_after) conds.push(lt(S.id, q.starting_after));
    const rows = await db.select().from(S).where(and(...conds)).orderBy(desc(S.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(serializeSubsequence), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  app.get("/api/v2/subsequences/analytics", { config: { ...read, perm: "analytics" as const } }, async (req) => {
    const q = query(req, z.object({ campaign_id: z.string() }));
    const c = ctx(req);
    const subs = await db.select({ id: S.id }).from(S).where(and(eq(S.workspaceId, c.wsId), eq(S.parentCampaignId, q.campaign_id)));
    if (!subs.length) return [];
    const rows = await db
      .select({
        id: E.subsequenceId,
        sent: sql<number>`sum(case when ${E.type} = 'sent' then 1 else 0 end)`,
        opens: sql<number>`count(distinct case when ${E.type} = 'open' then ${E.leadId} end)`,
        replies: sql<number>`count(distinct case when ${E.type} = 'reply' then ${E.leadId} end)`,
      })
      .from(E)
      .where(inArray(E.subsequenceId, subs.map((s) => s.id)))
      .groupBy(E.subsequenceId);
    const by = new Map(rows.map((r) => [r.id, r]));
    return subs.map((s) => ({
      subsequence_id: s.id,
      emails_sent: Number(by.get(s.id)?.sent ?? 0),
      unique_opens: Number(by.get(s.id)?.opens ?? 0),
      unique_replies: Number(by.get(s.id)?.replies ?? 0),
    }));
  });

  app.get("/api/v2/subsequences/:id", { config: read }, async (req) => serializeSubsequence(await findSub(ctx(req).wsId, (req.params as { id: string }).id)));

  app.patch("/api/v2/subsequences/:id", { config: write("update") }, async (req) => {
    const c = ctx(req);
    const sub = await findSub(c.wsId, (req.params as { id: string }).id);
    const patch = subsequenceColumns(body(req, patchSubsequenceSchema));
    if (!Object.keys(patch).length) return serializeSubsequence(sub);
    const [row] = await db.update(S).set(patch).where(eq(S.id, sub.id)).returning();
    // A changed sequence is kept as a version, like a campaign's.
    if (patch.sequences) {
      await recordSequenceVersion({ workspaceId: c.wsId, campaignId: sub.parentCampaignId, subsequenceId: sub.id, before: sub.sequences, after: row!.sequences, beforeAt: sub.updatedAt, actor: actorOf(req) });
    }
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.SUBSEQUENCE_UPDATE, req, campaignId: sub.parentCampaignId, subsequenceId: sub.id, metadata: { fields: Object.keys(patch) } });
    return serializeSubsequence(row!);
  });

  // Its leads leave it (they stay in the campaign); the subsequence waits in Recently deleted for 30 days.
  app.delete("/api/v2/subsequences/:id", { config: write("delete") }, async (req) => {
    const c = ctx(req);
    const sub = await findSub(c.wsId, (req.params as { id: string }).id);
    const entryId = await trashSubsequence(sub, actorOf(req));
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.SUBSEQUENCE_UPDATE, req, campaignId: sub.parentCampaignId, subsequenceId: sub.id, metadata: { action: "delete" } });
    return { ...serializeSubsequence(sub), recently_deleted_id: entryId };
  });

  app.post("/api/v2/subsequences/:id/duplicate", { config: write("create") }, async (req) => {
    const c = ctx(req);
    const sub = await findSub(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object({ parent_campaign: z.string(), name: z.string().trim().min(1).max(250).optional() }));
    const parent = await findCampaign(c.wsId, b.parent_campaign);
    const { id: _id, createdAt: _c, updatedAt: _u, leadsUpdatedAt: _l, parentCampaignId: _p, ...rest } = sub;
    const [row] = await db
      .insert(S)
      .values({ ...rest, parentCampaignId: parent.id, name: b.name ?? sub.name })
      .returning();
    await recordSequenceVersion({ workspaceId: c.wsId, campaignId: parent.id, subsequenceId: row!.id, before: null, after: row!.sequences, actor: actorOf(req), source: "create" });
    return serializeSubsequence(row!);
  });

  for (const [action, status] of [
    ["pause", CampaignStatus.PAUSED],
    ["resume", CampaignStatus.ACTIVE],
  ] as const) {
    app.post(`/api/v2/subsequences/:id/${action}`, { config: write("update") }, async (req) => {
      const c = ctx(req);
      const sub = await findSub(c.wsId, (req.params as { id: string }).id);
      if (status === CampaignStatus.ACTIVE) {
        const problems = sequenceProblems(activeSteps(sub), { firstNeedsSubject: false });
        if (problems.length) throw badRequest(problems[0]!, { problems });
      }
      const [row] = await db.update(S).set({ status }).where(eq(S.id, sub.id)).returning();
      if (status === CampaignStatus.ACTIVE) {
        // Leads waiting in this subsequence resume; a completed parent campaign starts running subsequences again.
        const [waiting] = await db
          .select({ n: sql<number>`count(*)` })
          .from(schema.leads)
          .where(
            and(
              eq(schema.leads.subsequenceId, sub.id),
              inArray(schema.leads.subseqStatus, [LeadStatus.ACTIVE, LeadStatus.PAUSED]),
              notInArray(schema.leads.status, [LeadStatus.BOUNCED, LeadStatus.UNSUBSCRIBED]),
            ),
          );
        if (Number(waiting?.n ?? 0)) await reopenForSubsequences(c.wsId, sub.parentCampaignId);
      }
      await audit({ workspaceId: c.wsId, activityType: AuditActivity.SUBSEQUENCE_UPDATE, req, campaignId: sub.parentCampaignId, subsequenceId: sub.id, metadata: { action } });
      return serializeSubsequence(row!);
    });
  }

  app.get("/api/v2/subsequences/:id/analytics/steps", { config: { ...read, perm: "analytics" as const } }, async (req) => {
    const c = ctx(req);
    const sub = await findSub(c.wsId, (req.params as { id: string }).id);
    const q = query(req, z.object({ start_date: z.string().optional(), end_date: z.string().optional() }));
    return stepMetrics(c.wsId, [sub.parentCampaignId], await workspaceRange(c.wsId, q.start_date, q.end_date), false, sub.id);
  });

  /** A subsequence's analytics page: totals, where its leads are, figures per day and per step, for a period. */
  app.get("/api/app/subsequences/:id/overview", { config: { ...read, perm: "analytics" as const } }, async (req) => {
    const c = ctx(req);
    const sub = await findSub(c.wsId, (req.params as { id: string }).id);
    const q = query(req, z.object({ start_date: z.string().optional(), end_date: z.string().optional() }));
    const range = await workspaceRange(c.wsId, q.start_date, q.end_date);
    const L = schema.leads;
    const [metrics, daily, steps, [leads]] = await Promise.all([
      aggregateMetrics(c.wsId, [sub.parentCampaignId], range, sub.id),
      dailyMetrics(c.wsId, [sub.parentCampaignId], range, sub.id),
      stepMetrics(c.wsId, [sub.parentCampaignId], range, false, sub.id),
      db
        .select({
          total: sql<number>`count(*)`,
          // Still in it: running or paused.
          active: sql<number>`sum(case when ${L.subseqStatus} in (${LeadStatus.ACTIVE}, ${LeadStatus.PAUSED}) then 1 else 0 end)`,
          paused: sql<number>`sum(case when ${L.subseqStatus} = ${LeadStatus.PAUSED} then 1 else 0 end)`,
          completed: sql<number>`sum(case when ${L.subseqStatus} = ${LeadStatus.COMPLETED} then 1 else 0 end)`,
          skipped: sql<number>`sum(case when ${L.subseqStatus} = ${LeadStatus.SKIPPED} then 1 else 0 end)`,
          stopped: sql<number>`sum(case when ${L.subseqStatus} in (${LeadStatus.BOUNCED}, ${LeadStatus.UNSUBSCRIBED}) then 1 else 0 end)`,
        })
        .from(L)
        .where(and(eq(L.workspaceId, c.wsId), eq(L.subsequenceId, sub.id))),
    ]);
    const total = Number(leads?.total ?? 0);
    const active = Number(leads?.active ?? 0);
    return {
      metrics,
      leads: {
        total,
        active,
        paused: Number(leads?.paused ?? 0),
        completed: Number(leads?.completed ?? 0),
        skipped: Number(leads?.skipped ?? 0),
        stopped: Number(leads?.stopped ?? 0),
        progress: total ? Math.floor(((total - active) / total) * 100) : 0,
      },
      daily,
      steps,
    };
  });

  app.get("/api/v2/subsequences/:id/sending-status", { config: read }, async (req) => {
    const c = ctx(req);
    const sub = await findSub(c.wsId, (req.params as { id: string }).id);
    return sendingStatus(await findCampaign(c.wsId, sub.parentCampaignId), sub);
  });
}

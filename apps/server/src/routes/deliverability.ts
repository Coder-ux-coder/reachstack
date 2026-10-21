// Deliverability (API v2 + app): inbox placement tests, analytics and reports, email verification,
// seed mailboxes, spam/content checks, domain health checks and the sandbox mailbox viewer.
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import Papa from "papaparse";
import { z } from "zod";
import { INBOX_PLACEMENT, VerificationStatus, domainOf, unescapeCsvFormula } from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound, badRequest } from "../http/errors";
import { body, query, zBool, zInt, zList } from "../http/util";
import { checkDomainAuth, checkDomainBlocklists, checkIpBlocklists, resolveA } from "../lib/dns";
import { spamScore } from "../lib/spam-score";
import { iso } from "../lib/time";
import { buildRaw, newMessageId } from "../mail/compose";
import { sandboxMailboxes, sandboxMessagesFor } from "../mail/sandbox";
import { parseInbound } from "../mail/parse";
import { campaignName } from "../services/activity";
import { chargeCredits, refundCredits } from "../services/billing-limits";
import { isInstanceAdmin, requireInstanceAdmin } from "../services/instance";
import { createJob, registerJobCleanup, registerJobHandler, serializeJob, type JobRow } from "../services/jobs";
import {
  ESP_NAMES,
  GEO_NAMES,
  assertTestCodeFree,
  ensureSandboxSeeds,
  espOptions,
  newTestCode,
  nextRunAt,
  placementSummary,
  runTest,
  serializeReport,
  serializeResult,
  serializeSeed,
  serializeTest,
  testColumns,
  testFieldsSchema,
  testRecipients,
} from "../services/placement";
import { leadConditions, leadFilterSchema, releaseVerifyRun, type LeadFilter } from "../services/leads";
import { apiVerificationStatus, serializeVerification, verifyAndStore } from "../services/verification";
import { daySql, workspaceRange, workspaceZone } from "../services/workspace-clock";
import { toCsv } from "../lib/csv";

const T = schema.inboxPlacementTests;
const R = schema.inboxPlacementResults;
const REP = schema.inboxPlacementReports;
const V = schema.emailVerifications;

async function findTest(wsId: string, id: string) {
  const [row] = await db.select().from(T).where(and(eq(T.id, id), eq(T.workspaceId, wsId))).limit(1);
  return assertFound(row, "Inbox placement test");
}

const nums = (v?: string | number[]) => (Array.isArray(v) ? v : (v ?? "").split(",").filter(Boolean).map(Number)).filter((n) => !Number.isNaN(n));

/** Results matching the filters; dates are whole days on the workspace's clock (or exact times). */
async function resultFilters(wsId: string, q: { test_id?: string; test_ids?: string[]; date_from?: string; date_to?: string; recipient_geo?: number[]; recipient_type?: number[]; recipient_esp?: number[]; sender_email?: string }) {
  const conds: SQL[] = [eq(R.workspaceId, wsId)];
  if (q.test_id) conds.push(eq(R.testId, q.test_id));
  if (q.test_ids?.length) conds.push(inArray(R.testId, q.test_ids));
  const range = await workspaceRange(wsId, q.date_from, q.date_to);
  if (range.start !== undefined) conds.push(gte(R.createdAt, new Date(range.start)));
  if (range.end !== undefined) conds.push(lte(R.createdAt, new Date(range.end)));
  if (q.recipient_geo?.length) conds.push(inArray(R.recipientGeo, q.recipient_geo));
  if (q.recipient_type?.length) conds.push(inArray(R.recipientType, q.recipient_type));
  if (q.recipient_esp?.length) conds.push(inArray(R.recipientEsp, q.recipient_esp));
  if (q.sender_email) conds.push(eq(R.senderEmail, q.sender_email.toLowerCase()));
  return conds;
}

const CL = schema.creditLedger;

/**
 * Gives back what a verification run was charged for and didn't use: addresses it never got to (stopped, failed,
 * given up), checks it reused and checks with no verdict. Safe to call again: what came back already counts.
 */
async function settleVerificationRun(job: Pick<JobRow, "id" | "workspaceId" | "data">): Promise<number> {
  const charged = Number((job.data as { charged?: number } | null)?.charged ?? 0);
  if (charged <= 0) return 0;
  const [used] = await db.select({ n: sql<number>`coalesce(sum(${V.creditsUsed}), 0)` }).from(V).where(eq(V.jobId, job.id));
  const [back] = await db
    .select({ n: sql<number>`coalesce(sum(${CL.delta}), 0)` })
    .from(CL)
    .where(and(eq(CL.workspaceId, job.workspaceId), eq(CL.pool, "verification"), eq(CL.reason, "verification_refund"), eq(CL.refId, job.id)));
  const owed = charged - Number(used?.n ?? 0) - Number(back?.n ?? 0);
  return owed > 0 ? refundCredits(job.workspaceId, owed, "verification_refund", { pool: "verification", refId: job.id }) : 0;
}

/** Verifies addresses five at a time. Credits were taken up front; what the run didn't use comes back when it ends, however it ends. */
async function runVerification(job: JobRow, emails: string[], progress: (p: number, r: Record<string, unknown>) => Promise<void>, cancelled: () => Promise<boolean>) {
  const counts = { verified: 0, invalid: 0, risky: 0, catch_all: 0, unknown: 0 };
  let processed = 0;
  let cached = 0;
  let refunded = 0;
  try {
    for (let i = 0; i < emails.length; i += 5) {
      if (await cancelled()) break;
      const batch = await Promise.all(emails.slice(i, i + 5).map((e) => verifyAndStore(job.workspaceId, e, { jobId: job.id })));
      for (const r of batch) {
        counts[r.status]++;
        if (r.cached) cached++;
      }
      processed += batch.length;
      await progress(Math.round((processed / Math.max(1, emails.length)) * 100), { total: emails.length, processed, ...counts });
    }
  } finally {
    refunded = await settleVerificationRun(job);
  }
  return { total: emails.length, processed, ...counts, cached, credits_refunded: refunded };
}

registerJobHandler("verify-emails", async ({ job, input, progress, cancelled }) => {
  // The addresses are the job's input (runs queued before that kept them in its data).
  const list = input<{ emails: string[] }>()?.emails ?? (job.data as { emails?: string[] }).emails ?? [];
  const emails = [...new Set(list.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  return runVerification(job, emails, progress, cancelled);
});
registerJobCleanup("verify-emails", async (job) => {
  await settleVerificationRun(job);
});

type VerifyLeadsData = {
  campaign_id?: string;
  list_id?: string;
  ids?: string[];
  only_unverified?: boolean;
  pending_import?: boolean;
  /** A verify-on-import run that takes the leads tagged with its id (runs queued before 2026-10-17 took a campaign's or list's). */
  own_leads?: boolean;
  filter?: LeadFilter;
};

/** The leads a verify-leads run is about. Runs started from a leads table carry its filter, verify-on-import runs tag their leads, and older jobs name a campaign or list. */
async function verifyLeadsScope(job: JobRow): Promise<SQL[]> {
  const d = job.data as VerifyLeadsData;
  const L = schema.leads;
  // Wherever its leads have moved since.
  if (d.own_leads) return [eq(L.workspaceId, job.workspaceId), eq(L.verifyRunId, job.id)];
  const conds: SQL[] = d.filter ? await leadConditions(job.workspaceId, d.filter) : [eq(L.workspaceId, job.workspaceId)];
  if (d.campaign_id) conds.push(eq(L.campaignId, d.campaign_id));
  if (d.list_id) conds.push(eq(L.listId, d.list_id));
  if (d.ids?.length) conds.push(inArray(L.id, d.ids));
  // Leads waiting for their import's run are that run's to check.
  conds.push(isNull(L.verifyRunId));
  return conds;
}

registerJobHandler("verify-leads", async ({ job, progress, cancelled }) => {
  const d = job.data as VerifyLeadsData;
  const L = schema.leads;
  const conds = await verifyLeadsScope(job);
  // A verify-on-import run takes the leads waiting for it; a manual run takes the unverified ones. Picked up again
  // after a restart, it also takes the ones its first attempt had marked pending.
  const states = d.pending_import ? [VerificationStatus.PENDING_JOB] : d.only_unverified !== false ? [VerificationStatus.NOT_VERIFIED] : null;
  if (states) conds.push(inArray(L.verificationStatus, job.attempts > 0 ? [...states, VerificationStatus.PENDING] : states));
  const rows = await db.select({ id: L.id, email: L.email }).from(L).where(and(...conds));
  const emails = [...new Set(rows.map((r) => r.email?.toLowerCase()).filter((e): e is string => !!e))];
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 800) await db.update(L).set({ verificationStatus: VerificationStatus.PENDING }).where(inArray(L.id, ids.slice(i, i + 800)));
  try {
    return await runVerification(job, emails, progress, cancelled);
  } finally {
    // Leads a stopped or failed run didn't get to go back to "not verified" instead of staying pending forever.
    if (d.own_leads) await releaseVerifyRun(job.id);
    else {
      for (let i = 0; i < ids.length; i += 800) {
        await db
          .update(L)
          .set({ verificationStatus: VerificationStatus.NOT_VERIFIED })
          .where(and(inArray(L.id, ids.slice(i, i + 800)), eq(L.verificationStatus, VerificationStatus.PENDING)));
      }
    }
  }
});
registerJobCleanup("verify-leads", async (job, { handlerRan }) => {
  await settleVerificationRun(job);
  // Its own leads stop waiting for it however it ended, stopped before it started included.
  if ((job.data as VerifyLeadsData).own_leads) return releaseVerifyRun(job.id);
  if (handlerRan) return;
  // No lead waits for a run that ended without running (stopped before it started, or given up after restarts): one
  // that was waiting goes out unverified, as if verification were off. Unless another run of the workspace's may take it.
  const L = schema.leads;
  const J = schema.backgroundJobs;
  const otherRun = sql`exists (select 1 from ${J} where ${J.workspaceId} = ${job.workspaceId} and ${J.type} = 'verify-leads' and ${J.status} in ('pending', 'in-progress') and ${J.id} <> ${job.id})`;
  const waiting = [VerificationStatus.PENDING, ...((job.data as VerifyLeadsData).pending_import ? [VerificationStatus.PENDING_JOB] : [])];
  await db
    .update(L)
    .set({ verificationStatus: VerificationStatus.NOT_VERIFIED })
    .where(and(...(await verifyLeadsScope(job)), inArray(L.verificationStatus, waiting), sql`not ${otherRun}`));
});

export default async function deliverabilityRoutes(app: FastifyInstance) {
  const ipRead = { scope: ["inbox_placement_tests", "read"] as ["inbox_placement_tests", "read"], perm: "accounts" as const };
  const ipWrite = (a: "create" | "update" | "delete") => ({ scope: ["inbox_placement_tests", a] as ["inbox_placement_tests", typeof a], perm: "accounts" as const, write: true });
  const anRead = { scope: ["inbox_placement_analytics", "read"] as ["inbox_placement_analytics", "read"], perm: "accounts" as const };
  const repRead = { scope: ["inbox_placement_reports", "read"] as ["inbox_placement_reports", "read"], perm: "accounts" as const };

  // ---------- Tests ----------

  app.get("/api/v2/inbox-placement-tests/email-service-provider-options", { config: ipRead }, async () => espOptions());

  app.post("/api/v2/inbox-placement-tests", { config: ipWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, testFieldsSchema);
    if (b.type === INBOX_PLACEMENT.TYPE_AUTOMATED && !b.schedule) throw badRequest("Automated tests need a schedule");
    if (b.sending_method === INBOX_PLACEMENT.SENDING_FROM_APP && !b.emails.length && !b.tags?.length) throw badRequest("Select at least one sending account");
    const seeds = (await testRecipients(b.recipients_labels ?? null, b.sending_method)).map((s) => s.email);
    if (b.test_code) await assertTestCodeFree(b.test_code);
    const testCode = b.sending_method === INBOX_PLACEMENT.SENDING_EXTERNAL ? (b.test_code ?? newTestCode()) : (b.test_code ?? null);
    const [row] = await db
      .insert(T)
      .values({
        workspaceId: c.wsId,
        recipients: seeds,
        createdBy: c.userId,
        ...testColumns(b),
        name: b.name,
        type: b.type,
        sendingMethod: b.sending_method,
        emailSubject: b.email_subject,
        emailBody: b.email_body,
        emails: [...new Set(b.emails.map((e) => e.trim().toLowerCase()))],
        testCode,
        status: INBOX_PLACEMENT.STATUS_ACTIVE,
        nextRunAt: b.type === INBOX_PLACEMENT.TYPE_AUTOMATED ? nextRunAt(b.schedule ?? null) : null,
      })
      .returning();
    // One-time tests sent from the app start right away; automated ones also run now when asked.
    if (b.sending_method === INBOX_PLACEMENT.SENDING_FROM_APP && (b.type === INBOX_PLACEMENT.TYPE_ONE_TIME || b.run_immediately)) {
      runTest(row!.id).catch((err) => req.log.error(err));
    }
    const [fresh] = await db.select().from(T).where(eq(T.id, row!.id));
    return serializeTest(fresh!);
  });

  app.get("/api/v2/inbox-placement-tests", { config: ipRead }, async (req) => {
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), search: z.string().optional(), status: zInt().optional(), sort_order: z.enum(["asc", "desc"]).optional() }));
    const c = ctx(req);
    const limit = q.limit ?? 10;
    const asc_ = q.sort_order === "asc";
    const conds: SQL[] = [eq(T.workspaceId, c.wsId)];
    if (q.search) conds.push(contains(T.name, q.search));
    if (q.status !== undefined) conds.push(eq(T.status, q.status));
    if (q.starting_after) conds.push(asc_ ? gt(T.id, q.starting_after) : lt(T.id, q.starting_after));
    const rows = await db.select().from(T).where(and(...conds)).orderBy(asc_ ? asc(T.id) : desc(T.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map((t) => serializeTest(t)), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  app.get("/api/v2/inbox-placement-tests/:id", { config: ipRead }, async (req) => {
    const c = ctx(req);
    const t = await findTest(c.wsId, (req.params as { id: string }).id);
    const q = query(req, z.object({ with_metadata: zBool }));
    if (!q.with_metadata) return serializeTest(t);
    const tags = t.tags?.length ? await db.select().from(schema.customTags).where(inArray(schema.customTags.id, t.tags)) : [];
    return serializeTest(t, {
      campaign: t.campaignId ? { id: t.campaignId, name: await campaignName(t.campaignId) } : null,
      tags: Object.fromEntries(tags.map((g) => [g.id, g.label])),
    });
  });

  app.patch("/api/v2/inbox-placement-tests/:id", { config: ipWrite("update") }, async (req) => {
    const c = ctx(req);
    const t = await findTest(c.wsId, (req.params as { id: string }).id);
    const b = body(req, testFieldsSchema.partial());
    const patch = testColumns(b);
    const method = b.sending_method ?? t.sendingMethod;
    if (b.recipients_labels !== undefined || b.sending_method !== undefined) {
      // The seed list shown to the user (and used by external tests) follows the chosen groups.
      patch.recipients = (await testRecipients(b.recipients_labels !== undefined ? b.recipients_labels : t.recipientsLabels, method)).map((s) => s.email);
    }
    if (b.test_code) await assertTestCodeFree(b.test_code, t.id);
    // A test sent from another tool is found by its code: one switched to that (or left without a code) gets one.
    if (method === INBOX_PLACEMENT.SENDING_EXTERNAL && !(b.test_code !== undefined ? b.test_code : t.testCode)) patch.testCode = newTestCode();
    const type = b.type ?? t.type;
    if (type === INBOX_PLACEMENT.TYPE_AUTOMATED) {
      if (!(b.schedule ?? t.schedule)) throw badRequest("Automated tests need a schedule");
      // A finished one-time test turned into a scheduled one starts running on its schedule.
      if (t.status === INBOX_PLACEMENT.STATUS_COMPLETED && b.status == null) patch.status = INBOX_PLACEMENT.STATUS_ACTIVE;
      if (b.schedule !== undefined || b.type !== undefined || patch.status === INBOX_PLACEMENT.STATUS_ACTIVE) patch.nextRunAt = nextRunAt(b.schedule ?? t.schedule);
    } else if (b.type !== undefined) {
      patch.nextRunAt = null;
    }
    if (!Object.keys(patch).length) return serializeTest(t);
    const [row] = await db.update(T).set(patch).where(eq(T.id, t.id)).returning();
    return serializeTest(row!);
  });

  app.delete("/api/v2/inbox-placement-tests/:id", { config: ipWrite("delete") }, async (req) => {
    const c = ctx(req);
    const t = await findTest(c.wsId, (req.params as { id: string }).id);
    await db.delete(R).where(eq(R.testId, t.id));
    await db.delete(REP).where(eq(REP.testId, t.id));
    await db.delete(T).where(eq(T.id, t.id));
    return serializeTest(t);
  });

  // ---------- Analytics ----------

  app.get("/api/v2/inbox-placement-analytics", { config: anRead }, async (req) => {
    const q = query(
      req,
      z.object({
        limit: zInt(1, 100).optional(),
        starting_after: z.string().optional(),
        test_id: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        recipient_geo: z.string().optional(),
        recipient_type: z.string().optional(),
        recipient_esp: z.string().optional(),
        sender_email: z.string().optional(),
      }),
    );
    const c = ctx(req);
    const limit = q.limit ?? 10;
    const conds = await resultFilters(c.wsId, { ...q, recipient_geo: nums(q.recipient_geo), recipient_type: nums(q.recipient_type), recipient_esp: nums(q.recipient_esp) });
    if (q.starting_after) conds.push(lt(R.id, q.starting_after));
    const rows = await db.select().from(R).where(and(...conds)).orderBy(desc(R.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const zone = await workspaceZone(c.wsId);
    return { items: page.map((r) => serializeResult(r, zone)), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  app.get("/api/v2/inbox-placement-analytics/:id", { config: anRead }, async (req) => {
    const [row] = await db
      .select()
      .from(R)
      .where(and(eq(R.id, (req.params as { id: string }).id), eq(R.workspaceId, ctx(req).wsId)))
      .limit(1);
    return serializeResult(assertFound(row, "Inbox placement analytics"), await workspaceZone(ctx(req).wsId));
  });

  const statsBody = z.object({
    test_ids: z.array(z.string()).optional(),
    test_id: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    recipient_geo: z.array(z.number()).optional(),
    recipient_type: z.array(z.number()).optional(),
    recipient_esp: z.array(z.number()).optional(),
    sender_email: z.string().optional(),
  });

  app.post("/api/v2/inbox-placement-analytics/stats-by-test-id", { config: anRead }, async (req) => {
    const c = ctx(req);
    const b = body(req, statsBody.extend({ latest_run_only: z.boolean().optional() }));
    if (!b.test_ids?.length) throw badRequest("test_ids is required");
    const rows = await db
      .select({ testId: R.testId, runId: R.runId, isSpam: R.isSpam, hasCategory: R.hasCategory, createdAt: R.createdAt })
      .from(R)
      .where(and(...(await resultFilters(c.wsId, b)), eq(R.recordType, 2)));
    return b.test_ids.map((id) => {
      let own = rows.filter((r) => r.testId === id);
      // "Latest placement": the newest run with results, not every run added together.
      if (b.latest_run_only && own.length) {
        const newest = own.reduce((a, r) => (r.createdAt > a.createdAt ? r : a));
        own = own.filter((r) => r.runId === newest.runId);
      }
      return { test_id: id, ...placementSummary(own) };
    });
  });

  app.post("/api/v2/inbox-placement-analytics/deliverability-insights", { config: anRead }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        test_id: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        previous_date_from: z.string().optional(),
        previous_date_to: z.string().optional(),
        show_previous: z.boolean().optional(),
        recipient_geo: z.array(z.number()).optional(),
        recipient_type: z.array(z.number()).optional(),
        recipient_esp: z.array(z.number()).optional(),
        sender_email: z.string().optional(),
      }),
    );
    const window = async (from?: string, to?: string) => {
      const rows = await db
        .select({ senderEsp: R.senderEsp, recipientEsp: R.recipientEsp, isSpam: R.isSpam, hasCategory: R.hasCategory })
        .from(R)
        .where(and(...(await resultFilters(c.wsId, { ...b, date_from: from, date_to: to })), eq(R.recordType, 2)));
      const groups = new Map<string, typeof rows>();
      for (const r of rows) {
        const k = `${r.senderEsp ?? 0}:${r.recipientEsp ?? 0}`;
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      return groups;
    };
    const now = await window(b.date_from, b.date_to);
    const prev = b.show_previous ? await window(b.previous_date_from, b.previous_date_to) : new Map();
    return [...now.entries()].map(([k, rows]) => {
      const [senderEsp, recipientEsp] = k.split(":").map(Number);
      const s = placementSummary(rows);
      const p = prev.get(k) ? placementSummary(prev.get(k)!) : null;
      return {
        test_id: b.test_id ?? null,
        from: b.date_from ?? null,
        to: b.date_to ?? null,
        previous_from: b.previous_date_from ?? null,
        previous_to: b.previous_date_to ?? null,
        sender_esp: senderEsp || null,
        recipient_esp: recipientEsp || null,
        spam_percentage: s.spam_percent,
        inbox_percentage: s.inbox_percent,
        category_percentage: s.category_percent,
        prev_spam_percentage: p?.spam_percent ?? null,
        prev_inbox_percentage: p?.inbox_percent ?? null,
        prev_category_percentage: p?.category_percent ?? null,
      };
    });
  });

  app.post("/api/v2/inbox-placement-analytics/stats-by-date", { config: anRead }, async (req) => {
    const c = ctx(req);
    const b = body(req, statsBody);
    const day = daySql(R.createdAt, await workspaceRange(c.wsId, b.date_from, b.date_to));
    const rows = await db
      .select({
        date: day,
        sent: sql<number>`sum(case when ${R.recordType} = 1 then 1 else 0 end)`,
        received: sql<number>`sum(case when ${R.recordType} = 2 and ${R.folder} != 'missing' then 1 else 0 end)`,
      })
      .from(R)
      .where(and(...(await resultFilters(c.wsId, b))))
      .groupBy(day)
      .orderBy(day);
    return rows.map((r) => ({ timestamp_created_date: r.date, sent_count: Number(r.sent), received_count: Number(r.received) }));
  });

  // ---------- Reports ----------

  app.get("/api/v2/inbox-placement-reports", { config: repRead }, async (req) => {
    const q = query(
      req,
      z.object({
        limit: zInt(1, 100).optional(),
        starting_after: z.string().optional(),
        test_id: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        skip_spam_assassin_report: zBool,
        skip_blacklist_report: zBool,
      }),
    );
    const c = ctx(req);
    const limit = q.limit ?? 10;
    const conds: SQL[] = [eq(REP.workspaceId, c.wsId)];
    if (q.test_id) conds.push(eq(REP.testId, q.test_id));
    const range = await workspaceRange(c.wsId, q.date_from?.slice(0, 10), q.date_to?.slice(0, 10));
    if (range.start !== undefined) conds.push(gte(REP.createdAt, new Date(range.start)));
    if (range.end !== undefined) conds.push(lte(REP.createdAt, new Date(range.end)));
    if (q.starting_after) conds.push(lt(REP.id, q.starting_after));
    const rows = await db.select().from(REP).where(and(...conds)).orderBy(desc(REP.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const zone = await workspaceZone(c.wsId);
    return {
      items: page.map((r) => serializeReport(r, { skipSpam: q.skip_spam_assassin_report, skipBlacklist: q.skip_blacklist_report, zone })),
      next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  });

  app.get("/api/v2/inbox-placement-reports/:id", { config: repRead }, async (req) => {
    const [row] = await db
      .select()
      .from(REP)
      .where(and(eq(REP.id, (req.params as { id: string }).id), eq(REP.workspaceId, ctx(req).wsId)))
      .limit(1);
    return serializeReport(assertFound(row, "Inbox placement report"), { zone: await workspaceZone(ctx(req).wsId) });
  });

  // ---------- App: placement ----------

  app.post("/api/app/inbox-placement-tests/:id/run", { config: { perm: "accounts", write: true } }, async (req) => {
    const t = await findTest(ctx(req).wsId, (req.params as { id: string }).id);
    if (t.status === INBOX_PLACEMENT.STATUS_COMPLETED && t.type === INBOX_PLACEMENT.TYPE_ONE_TIME) {
      await db.update(T).set({ status: INBOX_PLACEMENT.STATUS_ACTIVE }).where(eq(T.id, t.id));
    }
    // The emails go out in the background: a run can take minutes.
    const { finished: _sending, ...started } = await runTest(t.id);
    return started;
  });

  /** Results page: totals, per-run history, breakdowns by provider, region, type and sender, plus reports. */
  app.get("/api/app/inbox-placement-tests/:id/overview", { config: { perm: "accounts" } }, async (req) => {
    const c = ctx(req);
    const t = await findTest(c.wsId, (req.params as { id: string }).id);
    const q = query(req, z.object({ run_id: z.string().optional() }));
    const all = await db.select().from(R).where(eq(R.testId, t.id)).orderBy(asc(R.createdAt));
    const runs = [...new Set(all.filter((r) => r.recordType === 1 || r.runId === "external").map((r) => r.runId))];
    const runId = q.run_id ?? runs[runs.length - 1] ?? null;
    const scoped = runId ? all.filter((r) => r.runId === runId) : [];
    const received = scoped.filter((r) => r.recordType === 2);
    const sentCount = scoped.filter((r) => r.recordType === 1).length;
    const breakdown = (key: (r: (typeof received)[number]) => string) => {
      const m = new Map<string, typeof received>();
      for (const r of received) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
      return [...m.entries()].map(([k, rows]) => ({ key: k, ...placementSummary(rows) }));
    };
    const reports = runId ? await db.select().from(REP).where(and(eq(REP.testId, t.id), eq(REP.runId, runId))) : [];
    const zone = await workspaceZone(c.wsId);
    return {
      test: serializeTest(t),
      run_id: runId,
      runs: runs.map((id) => {
        const rows = all.filter((r) => r.runId === id && r.recordType === 2);
        return { run_id: id, timestamp: iso(all.find((r) => r.runId === id)?.createdAt), ...placementSummary(rows) };
      }),
      pending: Math.max(0, sentCount - received.length),
      summary: placementSummary(received),
      by_esp: breakdown((r) => ESP_NAMES[r.recipientEsp ?? 0] ?? "Other"),
      by_geo: breakdown((r) => GEO_NAMES[r.recipientGeo ?? 0] ?? "Other"),
      by_type: breakdown((r) => (r.recipientType === 1 ? "Professional" : "Personal")),
      by_sender: breakdown((r) => r.senderEmail ?? "unknown"),
      results: scoped.filter((r) => r.recordType === 2).map((r) => serializeResult(r, zone)),
      reports: reports.map((r) => serializeReport(r, { zone })),
    };
  });

  app.get("/api/app/placement/seeds", { config: { perm: "accounts" } }, async (req) => {
    await ensureSandboxSeeds();
    const seeds = (await db.select().from(schema.placementSeeds).orderBy(asc(schema.placementSeeds.region), asc(schema.placementSeeds.esp))).map(serializeSeed);
    return { items: seeds, can_manage: await isInstanceAdmin(ctx(req).user) };
  });

  /** Adds one of this workspace's connected mailboxes as a seed. Seeds serve every workspace, so only the installation admin manages them. */
  app.post("/api/app/placement/seeds", { config: { perm: "accounts", admin: true } }, async (req) => {
    const c = ctx(req);
    await requireInstanceAdmin(c.user);
    const b = body(
      req,
      z.object({
        account_email: z.string(),
        region: z.string().min(1),
        sub_region: z.string().min(1),
        type: z.enum(["Professional", "Personal"]),
        esp: z.number().int().refine((v) => v in ESP_NAMES, "Unknown ESP"),
        geo: z.number().int().refine((v) => v in GEO_NAMES, "Unknown region"),
      }),
    );
    const [acc] = await db
      .select()
      .from(schema.emailAccounts)
      .where(and(eq(schema.emailAccounts.workspaceId, c.wsId), eq(schema.emailAccounts.email, b.account_email.toLowerCase())));
    if (!acc) throw badRequest("Connect the seed mailbox as an email account first");
    await db.update(schema.emailAccounts).set({ isSeed: true }).where(eq(schema.emailAccounts.id, acc.id));
    const [row] = await db
      .insert(schema.placementSeeds)
      .values({ email: acc.email, accountId: acc.id, region: b.region, subRegion: b.sub_region, type: b.type, esp: b.esp, geo: b.geo })
      .onConflictDoUpdate({ target: schema.placementSeeds.email, set: { accountId: acc.id, region: b.region, subRegion: b.sub_region, type: b.type, esp: b.esp, geo: b.geo, active: true } })
      .returning();
    return serializeSeed(row!);
  });

  app.patch("/api/app/placement/seeds/:id", { config: { perm: "accounts", admin: true } }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const b = body(req, z.object({ active: z.boolean() }));
    const [row] = await db
      .update(schema.placementSeeds)
      .set({ active: b.active })
      .where(eq(schema.placementSeeds.id, (req.params as { id: string }).id))
      .returning();
    return serializeSeed(assertFound(row, "Seed"));
  });

  // ---------- App: content & domain checks ----------

  /** Spam/content check for a subject and body (sequence editor "check spam" and placement previews). */
  app.post("/api/app/deliverability/spam-check", { config: { perm: "view_campaigns" } }, async (req) => {
    const b = body(req, z.object({ subject: z.string().max(998).default(""), body: z.string().max(200_000).default("") }));
    const raw = await buildRaw({ from: { address: "check@example.com" }, to: [{ address: "seed@example.com" }], subject: b.subject, html: b.body, messageId: newMessageId("check@example.com") });
    return spamScore({ subject: b.subject, html: b.body, raw });
  });

  /** SPF/DKIM/DMARC/MX plus domain and IP blocklist status for a sending domain. */
  app.get("/api/app/deliverability/domain", { config: { perm: "accounts" } }, async (req) => {
    const q = query(req, z.object({ domain: z.string().min(3), dkim_selector: z.string().optional() }));
    const domain = q.domain.toLowerCase().replace(/^.*@/, "").trim();
    if (domain.endsWith(".test")) return { domain, simulated: true, note: "Sandbox domains are not published in DNS." };
    const fresh = { fresh: true };
    const [auth, domainHits, ip] = await Promise.all([checkDomainAuth(domain, q.dkim_selector, fresh), checkDomainBlocklists(domain, fresh), resolveA(domain).then((a) => a[0] ?? null)]);
    const ipHits = ip ? await checkIpBlocklists(ip, fresh) : [];
    return {
      domain,
      auth,
      ip,
      blocklists: {
        domain: domainHits.map((h) => ({ list: h.list, listed: h.listed, error: !!h.error })),
        ip: ipHits.map((h) => ({ list: h.list, listed: h.listed, error: !!h.error })),
        listed_count: [...domainHits, ...ipHits].filter((h) => h.listed).length,
      },
    };
  });

  // ---------- Email verification ----------

  app.post("/api/v2/email-verification", { config: { scope: ["email_verifications", "create"] as ["email_verifications", "create"], perm: "leads" as const } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ email: z.string().min(3).max(254), webhook_url: z.string().url().optional() }));
    if (!(await chargeCredits(c.wsId, 1, "email_verification", { pool: "verification", userId: c.userId }))) throw badRequest("Not enough verification credits");
    // A recent check is reused for free, and one that reached no verdict (or failed) costs nothing: also when the
    // check ends after this answer said "pending".
    const giveBack = () => refundCredits(c.wsId, 1, "verification_refund", { pool: "verification" });
    const check = verifyAndStore(c.wsId, b.email).then(
      async (r) => {
        if (r.cached || r.status === "unknown") await giveBack();
        return r;
      },
      async (err) => {
        await giveBack();
        throw err;
      },
    );
    check.catch(() => undefined); // a failure after the answer below was already given back
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([check, new Promise<null>((r) => (timer = setTimeout(() => r(null), 10_000)))]).finally(() => clearTimeout(timer));
    if (!result) return { status: "success", email: b.email.toLowerCase(), verification_status: "pending", catch_all: "pending", credits: null, credits_used: 1 };
    const used = result.cached || result.status === "unknown" ? 0 : 1;
    return { status: "success", email: result.email, verification_status: apiVerificationStatus(result.status), catch_all: result.catch_all, credits: null, credits_used: used, result: result.status, reason: result.reason, method: result.method, checks: result.checks };
  });

  app.get("/api/v2/email-verification/:email", { config: { scope: ["email_verifications", "read"] as ["email_verifications", "read"], perm: "leads" as const } }, async (req) => {
    // The address arrives decoded already (decoding again breaks on a "%" in it).
    const email = (req.params as { email: string }).email.trim().toLowerCase();
    const [row] = await db
      .select()
      .from(V)
      .where(and(eq(V.workspaceId, ctx(req).wsId), eq(V.email, email)))
      .orderBy(desc(V.createdAt))
      .limit(1);
    const r = assertFound(row, "Email verification");
    return { status: "success", email: r.email, verification_status: apiVerificationStatus(r.verificationStatus as never), catch_all: r.catchAll === "true" ? true : r.catchAll === "false" ? false : "pending", credits: null, credits_used: r.creditsUsed };
  });

  app.post("/api/app/verification/bulk", { config: { perm: "leads", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ emails: z.array(z.string()).optional(), csv: z.string().max(20_000_000).optional(), column: z.string().optional(), name: z.string().trim().max(200).optional() }));
    let emails = b.emails ?? [];
    if (b.csv) {
      const parsed = Papa.parse<Record<string, string>>(b.csv.trim(), { header: true, skipEmptyLines: true, transform: unescapeCsvFormula });
      const col = b.column ?? parsed.meta.fields?.find((f) => /e-?mail/i.test(f)) ?? parsed.meta.fields?.[0];
      emails = [...emails, ...parsed.data.map((r) => (col ? r[col] : "") ?? "")];
    }
    emails = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
    if (!emails.length) throw badRequest("No email addresses found");
    if (emails.length > 100_000) throw badRequest("Verify at most 100,000 addresses at a time");
    if (!(await chargeCredits(c.wsId, emails.length, "bulk_verification", { pool: "verification", userId: c.userId }))) throw badRequest("Not enough verification credits");
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: "verify-emails", data: { name: b.name || "Pasted addresses", charged: emails.length, total: emails.length }, input: { emails } });
    return serializeJob(job);
  });

  app.post("/api/app/verification/leads", { config: { perm: "leads", write: true } }, async (req) => {
    const c = ctx(req);
    // The leads table's own filters (search, quick filter, rules), so "select all" verifies exactly the leads it shows.
    const b = body(req, leadFilterSchema.extend({ campaign_id: z.string().optional(), only_unverified: z.boolean().optional() }));
    const { campaign_id, only_unverified, ...rest } = b;
    const filter: LeadFilter = { ...rest, campaign: rest.campaign ?? campaign_id };
    const L = schema.leads;
    const conds: SQL[] = [...(await leadConditions(c.wsId, filter)), sql`${L.email} is not null`];
    if (only_unverified !== false) conds.push(eq(L.verificationStatus, VerificationStatus.NOT_VERIFIED));
    const [row] = await db.select({ n: sql<number>`count(distinct lower(${L.email}))` }).from(L).where(and(...conds));
    const count = Number(row?.n ?? 0);
    if (!count) throw badRequest(only_unverified !== false ? "Every lead there is already verified" : "There are no leads with an email address there");
    if (!(await chargeCredits(c.wsId, count, "lead_verification", { pool: "verification", userId: c.userId }))) {
      throw badRequest(`Not enough verification credits (${count.toLocaleString("en-US")} needed)`);
    }
    let name = filter.ids?.length ? "Selected leads" : "All leads";
    if (filter.campaign) name = `Campaign: ${(await campaignName(filter.campaign)) ?? "campaign"}`;
    else if (filter.list_id) {
      const [list] = await db.select({ name: schema.leadLists.name }).from(schema.leadLists).where(eq(schema.leadLists.id, filter.list_id)).limit(1);
      name = `List: ${list?.name ?? "list"}`;
    }
    if (!filter.ids?.length && (filter.search || filter.filter || filter.rules?.length || filter.interest_status !== undefined || filter.smart_view_id)) name += " (filtered)";
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: "verify-leads", entityId: filter.campaign ?? filter.list_id ?? null, data: { filter, only_unverified, name, charged: count } });
    return serializeJob(job);
  });

  /** Recent bulk and lead verification runs, without their address lists. */
  app.get("/api/app/verification/jobs", { config: { perm: "leads" } }, async (req) => {
    const c = ctx(req);
    const J = schema.backgroundJobs;
    const rows = await db
      .select()
      .from(J)
      .where(and(eq(J.workspaceId, c.wsId), inArray(J.type, ["verify-emails", "verify-leads"])))
      .orderBy(desc(J.createdAt))
      .limit(50);
    return rows.map((j) => {
      const d = (j.data ?? {}) as { name?: string; charged?: number; emails?: string[]; total?: number; processed?: number };
      return {
        id: j.id,
        type: j.type,
        name: d.name ?? (j.type === "verify-leads" ? "Leads" : "Addresses"),
        status: j.status,
        progress: Math.round(j.progress),
        // While it runs: the addresses it has checked so far, of how many.
        processed: d.processed ?? null,
        total: d.total ?? d.emails?.length ?? d.charged ?? null,
        result: j.result,
        error: j.error,
        created_at: iso(j.createdAt),
      };
    });
  });

  app.get("/api/app/verification/results", { config: { perm: "leads" } }, async (req, reply) => {
    const q = query(
      req,
      z.object({
        job_id: z.string().optional(),
        single: zBool,
        search: z.string().trim().max(200).optional(),
        status: zList,
        limit: zInt(1, 1000).optional(),
        page: zInt(1).optional(),
        format: z.enum(["json", "csv"]).optional(),
      }),
    );
    const c = ctx(req);
    const conds: SQL[] = [eq(V.workspaceId, c.wsId)];
    if (q.job_id) conds.push(eq(V.jobId, q.job_id));
    if (q.single) conds.push(sql`${V.jobId} is null`);
    if (q.search) conds.push(contains(V.email, q.search.toLowerCase()));
    if (q.status?.length) conds.push(inArray(V.verificationStatus, q.status));
    const limit = q.limit ?? 100;
    const rows = await db
      .select()
      .from(V)
      .where(and(...conds))
      .orderBy(desc(V.createdAt))
      .limit(q.format === "csv" ? 100_000 : limit)
      .offset(q.format === "csv" ? 0 : ((q.page ?? 1) - 1) * limit);
    if (q.format === "csv") {
      reply.header("content-disposition", `attachment; filename="verification-results.csv"`).type("text/csv; charset=utf-8");
      return toCsv(rows.map((r) => ({ email: r.email, status: r.verificationStatus, catch_all: r.catchAll, reason: r.reason, verified_at: iso(r.createdAt) })));
    }
    const [stats] = await db
      .select({
        total: sql<number>`count(*)`,
        verified: sql<number>`sum(case when ${V.verificationStatus} = 'verified' then 1 else 0 end)`,
        invalid: sql<number>`sum(case when ${V.verificationStatus} = 'invalid' then 1 else 0 end)`,
        risky: sql<number>`sum(case when ${V.verificationStatus} = 'risky' then 1 else 0 end)`,
        catch_all: sql<number>`sum(case when ${V.verificationStatus} = 'catch_all' then 1 else 0 end)`,
        unknown: sql<number>`sum(case when ${V.verificationStatus} in ('unknown','pending') then 1 else 0 end)`,
      })
      .from(V)
      .where(and(...conds));
    return {
      items: rows.map(serializeVerification),
      stats: Object.fromEntries(Object.entries(stats ?? {}).map(([k, v]) => [k, Number(v ?? 0)])),
    };
  });

  // ---------- Sandbox viewer (test mailboxes) ----------

  app.get("/api/app/sandbox/mailboxes", { config: { perm: "accounts" } }, async (req) => {
    const rows = await sandboxMailboxes(ctx(req).wsId);
    return rows.map((r) => ({ mailbox: r.mailbox, messages: Number(r.count), last_at: iso(Number(r.last)) }));
  });

  app.get("/api/app/sandbox/messages", { config: { perm: "accounts" } }, async (req) => {
    const q = query(req, z.object({ mailbox: z.string(), folder: zList }));
    const rows = await sandboxMessagesFor(ctx(req).wsId, q.mailbox, q.folder);
    return Promise.all(
      rows.map(async (r) => {
        const p = await parseInbound(Buffer.from(r.raw, "utf8"));
        return { uid: r.uid, folder: r.folder, flags: r.flags, subject: p.subject, from: p.from, to: p.to, date: iso(p.date), preview: p.preview, html: p.html, text: p.text, message_id: r.messageId, sender_domain: domainOf(p.from?.address ?? "") };
      }),
    );
  });
}

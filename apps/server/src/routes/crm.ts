// CRM app endpoints: the team inbox, tasks, calls, texts, meetings, deals, sales flows, phone numbers, reports
// and the activity comparison. Twilio webhooks for incoming texts and calls live here too.
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { FREE_MAIL_DOMAINS } from "@reachstack/shared";
import { z } from "zod";
import { contains, db, schema } from "../db/client";
import { config } from "../env";
import { may } from "../http/auth";
import { ctx } from "../http/context";
import { assertFound, badRequest, conflict, forbidden, notFound } from "../http/errors";
import { body, query, zBool, zInt } from "../http/util";
import { encrypt, signPayload, verifyPayload } from "../lib/crypto";
import { iso } from "../lib/time";
import { setInterestStatus } from "../services/activity";
import { emit } from "../services/bus";
import {
  FEED_TYPES,
  FINAL_CALL_STATUSES,
  REPORT_METRICS,
  clearCashCache,
  createTask,
  defaultDealValue,
  e164,
  ensureDeals,
  feed,
  feedCounts,
  flowConditions,
  isKnownStatus,
  leadForPhone,
  leadsByEmail,
  placeCall,
  refreshCalls,
  reportMetrics,
  sendSms,
  serializeTasks,
  setDone,
  stripeLink,
  userNames,
  validTwilioSignature,
  verifyStripeKey,
  webhookUrls,
  workspaceForNumber,
  type FeedType,
  type FlowQuery,
  type StripeLink,
} from "../services/crm";
import { getOwnerId, isInstanceAdmin } from "../services/instance";
import { assertMembers } from "../services/members";
import { finishSequenceTask } from "../services/sequence-tasks";
import { twilioConfigured, twilioRequest } from "../services/twilio";
import { startOfDayOn, startOfNextDayOn, workspaceRange, workspaceZone } from "../services/workspace-clock";
import { getWorkspaceSetting, patchWorkspaceSettings } from "../services/workspaces";

const L = schema.leads;
const T = schema.crmTasks;
const CA = schema.crmCalls;
const SM = schema.crmSms;
const MT = schema.crmMeetings;
const OP = schema.crmOpportunities;
const SF = schema.salesFlows;
const PN = schema.crmPhoneNumbers;
const N = schema.leadNotes;

const read = { perm: "crm" as const };
const write = { perm: "crm" as const, write: true };

const email = z.string().trim().toLowerCase().email();
const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be a date");
const itemRef = z.object({ type: z.enum(["email", "call", "sms", "task", "meeting"]), id: z.string().min(1) });
const taskBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).nullable().optional(),
  type: z.enum(["todo", "call", "email", "linkedin", "sms", "meeting"]).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  due_at: isoDate.nullable().optional(),
  lead_email: email.nullable().optional().or(z.literal("")),
  assigned_to: z.string().nullable().optional(),
});
const flowQuery: z.ZodType<FlowQuery, z.ZodTypeDef, unknown> = z.object({
  actionType: z.enum(["reply", "email-open", "last-contacted", "link-click", "lead-status", "lead-status-change"]),
  values: z
    .object({
      "occurrence-days": z.number().int().min(1).max(3650).optional(),
      "occurrence-count": z.object({ condition: z.enum(["more", "less", "equal"]), count: z.number().int().min(0).max(10_000) }).optional(),
      "lead-status": z.object({ status: z.number().int(), condition: z.enum(["is", "is-not"]) }).optional(),
    })
    .default({}),
});
const flowBody = z.object({
  name: z.string().trim().min(1).max(200),
  queries: z.array(flowQuery).min(1).max(10),
  list_id: z.string().nullable().optional(),
  campaign_id: z.string().nullable().optional(),
  is_default: z.boolean().nullable().optional(),
});

function serializeCall(r: typeof CA.$inferSelect, names: Map<string, string>) {
  return {
    id: r.id,
    lead_email: r.leadEmail,
    lead_id: r.leadId,
    phone_number: r.phoneNumber,
    from_number: r.fromNumber,
    direction: r.direction,
    status: r.status,
    outcome: r.outcome,
    duration_sec: r.durationSec,
    recording_url: r.recordingUrl,
    notes: r.notes,
    created_by: r.createdBy,
    created_by_name: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
    archived_at: iso(r.archivedAt),
    timestamp_created: iso(r.createdAt),
  };
}

function serializeSms(r: typeof SM.$inferSelect, names: Map<string, string>) {
  return {
    id: r.id,
    lead_email: r.leadEmail,
    lead_id: r.leadId,
    phone_number: r.phoneNumber,
    from_number: r.fromNumber,
    direction: r.direction,
    body: r.body,
    status: r.status,
    created_by: r.createdBy,
    created_by_name: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
    archived_at: iso(r.archivedAt),
    timestamp_created: iso(r.createdAt),
  };
}

function serializeMeeting(r: typeof MT.$inferSelect) {
  return { id: r.id, lead_email: r.leadEmail, lead_id: r.leadId, title: r.title, start_at: iso(r.startAt), end_at: iso(r.endAt), location: r.location, notes: r.notes, status: r.status, created_by: r.createdBy, timestamp_created: iso(r.createdAt) };
}

function serializeFlow(r: typeof SF.$inferSelect, names: Map<string, string>) {
  return {
    id: r.id,
    name: r.name,
    is_default: r.isDefault ?? false,
    queries: r.queries,
    list_id: r.listId,
    campaign_id: r.campaignId,
    list_name: r.listId ? (names.get(r.listId) ?? null) : null,
    campaign_name: r.campaignId ? (names.get(r.campaignId) ?? null) : null,
    created_by: r.createdBy,
    timestamp_created: iso(r.createdAt),
  };
}

/** Hand-logged calls keep whatever was typed when it isn't a dialable number (an extension, a local format). */
const phoneOrRaw = (raw: string) => {
  try {
    return e164(raw);
  } catch {
    return raw.trim();
  }
};

/** The period asked for, in whole days on the workspace's clock; open ends run from the beginning, or to now. */
const rangeOf = async (wsId: string, q: { start_date?: string; end_date?: string }) => {
  const r = await workspaceRange(wsId, q.start_date, q.end_date);
  return { start: new Date(r.start ?? 0), end: new Date(r.end ?? Date.now()) };
};

/**
 * Phone numbers are bought on the installation's Twilio account, and imported from it: its owner pays for them. Its
 * administrators and the people in the owner's workspaces may; anyone else's workspace asks the owner.
 */
async function assertMaySpendTwilio(c: ReturnType<typeof ctx>) {
  if (c.user && (await isInstanceAdmin(c.user))) return;
  if (c.workspace.ownerId === (await getOwnerId())) return;
  throw forbidden("Phone numbers come from this installation's Twilio account, which its owner pays for. Ask the owner to add one for you.");
}

export default async function crmRoutes(app: FastifyInstance) {
  // ---------- Inbox feed ----------

  app.get("/api/app/crm/feed", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(
      req,
      z.object({
        view: z.enum(["inbox", "upcoming", "archive"]).default("inbox"),
        type: z.string().optional(),
        lead_email: email.optional(),
        owner: z.string().optional(),
        limit: zInt(1, 500).optional(),
      }),
    );
    // Replies are emails: someone who can't open the Unibox doesn't get them here either.
    const types = (q.type && q.type !== "all" ? q.type.split(",") : FEED_TYPES).filter((t): t is FeedType => (FEED_TYPES as string[]).includes(t) && (t !== "email" || may(req, "unibox")));
    const owner = q.owner === "me" ? (c.userId ?? undefined) : q.owner || undefined;
    return feed(c.wsId, { view: q.view, types, leadEmail: q.lead_email, owner, limit: q.limit ?? 50 });
  });

  app.get("/api/app/crm/counts", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ owner: z.string().optional() }));
    return feedCounts(c.wsId, q.owner === "me" ? (c.userId ?? undefined) : q.owner || undefined, { emails: may(req, "unibox") });
  });

  app.post("/api/app/crm/feed/done", { config: write }, async (req) => {
    const b = body(req, z.object({ items: z.array(itemRef).min(1).max(500) }));
    const wsId = ctx(req).wsId;
    // A sequence's task, done, moves its lead on to the next step.
    const taskIds = b.items.filter((i) => i.type === "task").map((i) => i.id);
    const fromSequences = taskIds.length
      ? new Set((await db.select({ id: T.id }).from(T).where(and(eq(T.workspaceId, wsId), inArray(T.id, taskIds), eq(T.source, "sequence"), eq(T.status, "open")))).map((r) => r.id))
      : new Set<string>();
    let updated = 0;
    for (const id of fromSequences) {
      try {
        await finishSequenceTask(wsId, id, "done");
        updated++;
      } catch {
        // Finished or put away meanwhile.
      }
    }
    const rest = b.items.filter((i) => !(i.type === "task" && fromSequences.has(i.id)));
    return { updated: updated + (rest.length ? await setDone(wsId, rest, true) : 0) };
  });

  app.post("/api/app/crm/feed/inbox", { config: write }, async (req) => {
    const b = body(req, z.object({ items: z.array(itemRef).min(1).max(500) }));
    return { updated: await setDone(ctx(req).wsId, b.items, false) };
  });

  // ---------- Tasks ----------

  app.get("/api/app/crm/tasks", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(
      req,
      z.object({
        status: z.enum(["open", "done", "skipped", "all"]).default("open"),
        assigned_to: z.string().optional(),
        lead_email: email.optional(),
        search: z.string().max(200).optional(),
        due: z.enum(["overdue", "today", "upcoming", "none"]).optional(),
        limit: zInt(1, 500).optional(),
      }),
    );
    const conds: SQL[] = [eq(T.workspaceId, c.wsId), isNull(T.archivedAt)];
    if (q.status !== "all") conds.push(eq(T.status, q.status));
    if (q.assigned_to) conds.push(eq(T.assignedTo, q.assigned_to === "me" ? (c.userId ?? "") : q.assigned_to));
    if (q.lead_email) conds.push(eq(sql`lower(${T.leadEmail})`, q.lead_email));
    if (q.search) conds.push(contains(sql`lower(${T.title} || ' ' || coalesce(${T.description}, '') || ' ' || coalesce(${T.leadEmail}, ''))`, q.search.toLowerCase()));
    // Days on the workspace's clock, like the inbox's "due today".
    const zone = await workspaceZone(c.wsId);
    const sod = startOfDayOn(zone);
    const eod = startOfNextDayOn(zone) - 1;
    if (q.due === "overdue") conds.push(sql`${T.dueAt} < ${sod}`);
    if (q.due === "today") conds.push(sql`${T.dueAt} >= ${sod} and ${T.dueAt} <= ${eod}`);
    if (q.due === "upcoming") conds.push(sql`${T.dueAt} > ${eod}`);
    if (q.due === "none") conds.push(isNull(T.dueAt));
    const rows = await db
      .select()
      .from(T)
      .where(and(...conds))
      .orderBy(q.status === "done" ? desc(T.completedAt) : asc(sql`coalesce(${T.dueAt}, 9e15)`), desc(T.createdAt))
      .limit(q.limit ?? 200);
    return { items: await serializeTasks(c.wsId, rows) };
  });

  app.post("/api/app/crm/tasks", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, taskBody);
    await assertMembers(c.wsId, [b.assigned_to], "assigned_to");
    const row = await createTask(c.wsId, c.userId, { ...b, lead_email: b.lead_email || null });
    return (await serializeTasks(c.wsId, [row]))[0];
  });

  app.get("/api/app/crm/tasks/:id", { config: read }, async (req) => {
    const c = ctx(req);
    const [row] = await db.select().from(T).where(and(eq(T.id, (req.params as { id: string }).id), eq(T.workspaceId, c.wsId))).limit(1);
    return (await serializeTasks(c.wsId, [assertFound(row, "Task")]))[0];
  });

  app.patch("/api/app/crm/tasks/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const id = (req.params as { id: string }).id;
    const b = body(req, taskBody.partial().extend({ status: z.enum(["open", "done", "skipped"]).optional() }));
    const [current] = await db.select().from(T).where(and(eq(T.id, id), eq(T.workspaceId, c.wsId))).limit(1);
    assertFound(current, "Task");
    // A task can stay with someone who has since left (saving its other details); giving it to someone needs a member.
    if (b.assigned_to !== undefined && b.assigned_to !== current!.assignedTo) await assertMembers(c.wsId, [b.assigned_to], "assigned_to");
    // A sequence's task finishes the sequence way: done or skipped, its lead moves on, and it can't be undone.
    const fromSequence = current!.source === "sequence";
    if (b.status === "skipped" && !fromSequence) throw badRequest("Only a task from a sequence can be skipped.");
    if (fromSequence && b.lead_email !== undefined && (b.lead_email || null) !== current!.leadEmail) throw badRequest("A task from a sequence stays with its lead.");
    if (fromSequence && b.status === "open" && current!.status !== "open") throw conflict("A task from a sequence can't be reopened: its lead has moved on to the next step.");
    if (fromSequence && b.status !== undefined && current!.status !== "open" && b.status !== current!.status) {
      throw conflict(`This task from a sequence was already ${current!.status === "done" ? "done" : "skipped"}, and its lead has moved on.`);
    }
    if (fromSequence && b.status !== undefined && b.status !== "open" && current!.status === "open") {
      await finishSequenceTask(c.wsId, id, b.status);
      b.status = undefined;
    }
    const set: Partial<typeof T.$inferInsert> = {};
    if (b.title !== undefined) set.title = b.title;
    if (b.description !== undefined) set.description = b.description;
    if (b.type !== undefined) set.type = b.type;
    if (b.priority !== undefined) set.priority = b.priority;
    if (b.due_at !== undefined) set.dueAt = b.due_at ? new Date(b.due_at) : null;
    if (b.assigned_to !== undefined) set.assignedTo = b.assigned_to;
    if (b.lead_email !== undefined) {
      const e = b.lead_email || null;
      set.leadEmail = e;
      set.leadId = e ? ((await leadsByEmail(c.wsId, [e])).get(e)?.id ?? null) : null;
    }
    if (b.status !== undefined) {
      set.status = b.status;
      set.completedAt = b.status === "done" ? new Date() : null;
    }
    const [row] = Object.keys(set).length
      ? await db.update(T).set(set).where(and(eq(T.id, id), eq(T.workspaceId, c.wsId))).returning()
      : await db.select().from(T).where(and(eq(T.id, id), eq(T.workspaceId, c.wsId))).limit(1);
    return (await serializeTasks(c.wsId, [assertFound(row, "Task")]))[0];
  });

  app.delete("/api/app/crm/tasks/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const id = (req.params as { id: string }).id;
    const [current] = await db.select().from(T).where(and(eq(T.id, id), eq(T.workspaceId, c.wsId))).limit(1);
    assertFound(current, "Task");
    // A lead waiting for this task would wait forever: deleting it skips it.
    if (current!.source === "sequence" && current!.status === "open" && !current!.archivedAt) await finishSequenceTask(c.wsId, id, "skipped");
    await db.delete(T).where(and(eq(T.id, id), eq(T.workspaceId, c.wsId)));
    return { deleted: true };
  });

  // ---------- Calls ----------

  app.get("/api/app/crm/calls", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ direction: z.enum(["inbound", "outbound"]).optional(), lead_email: email.optional(), limit: zInt(1, 500).optional() }));
    const conds: SQL[] = [eq(CA.workspaceId, c.wsId)];
    if (q.direction) conds.push(eq(CA.direction, q.direction));
    if (q.lead_email) conds.push(eq(sql`lower(${CA.leadEmail})`, q.lead_email));
    const rows = await refreshCalls(
      await db
        .select()
        .from(CA)
        .where(and(...conds))
        .orderBy(desc(CA.createdAt))
        .limit(q.limit ?? 200),
    );
    const names = await userNames(rows.map((r) => r.createdBy));
    return { items: rows.map((r) => serializeCall(r, names)), twilio: twilioConfigured() };
  });

  app.post("/api/app/crm/calls", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        mode: z.enum(["dial", "log"]).default("dial"),
        to: z.string().trim().min(5).max(40),
        lead_email: email.nullable().optional(),
        from_number_id: z.string().nullable().optional(),
        direction: z.enum(["inbound", "outbound"]).optional(),
        outcome: z.enum(["connected", "voicemail", "no_answer", "wrong_number", "meeting_booked"]).nullable().optional(),
        duration_sec: z.number().int().min(0).max(86_400).optional(),
        notes: z.string().max(20_000).nullable().optional(),
      }),
    );
    if (b.mode === "dial") {
      const row = await placeCall({ workspaceId: c.wsId, userId: c.userId!, userPhone: c.user?.phone ?? null, to: b.to, fromNumberId: b.from_number_id, leadEmail: b.lead_email });
      return serializeCall(row, await userNames([row.createdBy]));
    }
    const leadEmail = b.lead_email || (await leadForPhone(c.wsId, b.to))?.email?.toLowerCase() || null;
    const lead = leadEmail ? (await leadsByEmail(c.wsId, [leadEmail])).get(leadEmail) : undefined;
    const [row] = await db
      .insert(CA)
      .values({
        workspaceId: c.wsId,
        leadEmail,
        leadId: lead?.id ?? null,
        phoneNumber: phoneOrRaw(b.to),
        direction: b.direction ?? "outbound",
        status: b.outcome === "no_answer" ? "no-answer" : "completed",
        outcome: b.outcome ?? null,
        durationSec: b.duration_sec ?? 0,
        notes: b.notes ?? null,
        createdBy: c.userId,
        archivedAt: new Date(),
      })
      .returning();
    emit("call_completed", c.wsId, { call_id: row!.id, status: row!.status, lead_email: leadEmail, direction: row!.direction, duration_sec: row!.durationSec, outcome: row!.outcome });
    return serializeCall(row!, await userNames([row!.createdBy]));
  });

  app.get("/api/app/crm/calls/:id", { config: read }, async (req) => {
    const c = ctx(req);
    const [found] = await db.select().from(CA).where(and(eq(CA.id, (req.params as { id: string }).id), eq(CA.workspaceId, c.wsId))).limit(1);
    const [row] = await refreshCalls([assertFound(found, "Call")]);
    return serializeCall(row!, await userNames([row!.createdBy]));
  });

  app.patch("/api/app/crm/calls/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ notes: z.string().max(20_000).nullable().optional(), outcome: z.enum(["connected", "voicemail", "no_answer", "wrong_number", "meeting_booked"]).nullable().optional() }));
    const [row] = await db.update(CA).set(b).where(and(eq(CA.id, (req.params as { id: string }).id), eq(CA.workspaceId, c.wsId))).returning();
    return serializeCall(assertFound(row, "Call"), await userNames([row!.createdBy]));
  });

  app.delete("/api/app/crm/calls/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const [row] = await db.delete(CA).where(and(eq(CA.id, (req.params as { id: string }).id), eq(CA.workspaceId, c.wsId))).returning();
    assertFound(row, "Call");
    return { deleted: true };
  });

  // ---------- Texts ----------

  app.get("/api/app/crm/sms", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ direction: z.enum(["inbound", "outbound"]).optional(), lead_email: email.optional(), phone: z.string().optional(), limit: zInt(1, 500).optional() }));
    const conds: SQL[] = [eq(SM.workspaceId, c.wsId)];
    if (q.direction) conds.push(eq(SM.direction, q.direction));
    if (q.lead_email) conds.push(eq(sql`lower(${SM.leadEmail})`, q.lead_email));
    if (q.phone) conds.push(eq(SM.phoneNumber, e164(q.phone)));
    const rows = await db
      .select()
      .from(SM)
      .where(and(...conds))
      .orderBy(desc(SM.createdAt))
      .limit(q.limit ?? 200);
    const names = await userNames(rows.map((r) => r.createdBy));
    return { items: rows.map((r) => serializeSms(r, names)), twilio: twilioConfigured() };
  });

  app.post("/api/app/crm/sms", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ to: z.string().trim().min(5).max(40), body: z.string().trim().min(1).max(1_600), lead_email: email.nullable().optional(), from_number_id: z.string().nullable().optional() }));
    const row = await sendSms({ workspaceId: c.wsId, userId: c.userId, to: b.to, body: b.body, fromNumberId: b.from_number_id, leadEmail: b.lead_email });
    return serializeSms(row, await userNames([row.createdBy]));
  });

  // ---------- Meetings ----------

  const meetingBody = z.object({
    title: z.string().trim().min(1).max(300),
    lead_email: email.nullable().optional(),
    start_at: isoDate,
    end_at: isoDate.nullable().optional(),
    location: z.string().max(1_000).nullable().optional(),
    notes: z.string().max(20_000).nullable().optional(),
    status: z.enum(["scheduled", "completed", "no_show", "cancelled"]).optional(),
    set_lead_status: z.boolean().optional(),
  });

  app.get("/api/app/crm/meetings", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ lead_email: email.optional(), from: isoDate.optional(), to: isoDate.optional(), limit: zInt(1, 500).optional() }));
    const conds: SQL[] = [eq(MT.workspaceId, c.wsId)];
    if (q.lead_email) conds.push(eq(sql`lower(${MT.leadEmail})`, q.lead_email));
    if (q.from) conds.push(sql`${MT.startAt} >= ${Date.parse(q.from)}`);
    if (q.to) conds.push(sql`${MT.startAt} <= ${Date.parse(q.to)}`);
    const rows = await db
      .select()
      .from(MT)
      .where(and(...conds))
      .orderBy(desc(MT.startAt))
      .limit(q.limit ?? 200);
    return { items: rows.map(serializeMeeting) };
  });

  /**
   * Booking a meeting moves the lead to "Meeting booked", completing one to "Meeting completed" and a no-show to "No
   * show", forward only: a won deal stays won, and a lead whose meeting took place isn't taken back to booked or no-show
   * by another one (an onboarding call, a follow-up).
   */
  const syncLeadStatus = async (wsId: string, userId: string | null, leadEmail: string | null, status: string) => {
    if (!leadEmail) return;
    const target = status === "completed" ? 3 : status === "no_show" ? -4 : status === "scheduled" ? 2 : null;
    if (target === null) return;
    const rows = await db.select({ id: L.id, status: L.interestStatus }).from(L).where(and(eq(L.workspaceId, wsId), eq(sql`lower(${L.email})`, leadEmail)));
    const ids = rows.filter((r) => r.status !== 4 && r.status !== target && !(r.status === 3 && target !== 3)).map((r) => r.id);
    if (ids.length) await setInterestStatus({ workspaceId: wsId, leadIds: ids, value: target, userId, source: "user" });
  };

  app.post("/api/app/crm/meetings", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, meetingBody);
    const leadEmail = b.lead_email || null;
    const lead = leadEmail ? (await leadsByEmail(c.wsId, [leadEmail])).get(leadEmail) : undefined;
    const [row] = await db
      .insert(MT)
      .values({
        workspaceId: c.wsId,
        leadEmail,
        leadId: lead?.id ?? null,
        title: b.title,
        startAt: new Date(b.start_at),
        endAt: b.end_at ? new Date(b.end_at) : null,
        location: b.location ?? null,
        notes: b.notes ?? null,
        status: b.status ?? "scheduled",
        createdBy: c.userId,
      })
      .returning();
    if (b.set_lead_status !== false) await syncLeadStatus(c.wsId, c.userId, leadEmail, row!.status);
    return serializeMeeting(row!);
  });

  app.get("/api/app/crm/meetings/:id", { config: read }, async (req) => {
    const c = ctx(req);
    const [row] = await db.select().from(MT).where(and(eq(MT.id, (req.params as { id: string }).id), eq(MT.workspaceId, c.wsId))).limit(1);
    return serializeMeeting(assertFound(row, "Meeting"));
  });

  app.patch("/api/app/crm/meetings/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const id = (req.params as { id: string }).id;
    const b = body(req, meetingBody.partial());
    const before = assertFound((await db.select().from(MT).where(and(eq(MT.id, id), eq(MT.workspaceId, c.wsId))).limit(1))[0], "Meeting");
    const set: Partial<typeof MT.$inferInsert> = {};
    if (b.title !== undefined) set.title = b.title;
    if (b.start_at !== undefined) set.startAt = new Date(b.start_at);
    if (b.end_at !== undefined) set.endAt = b.end_at ? new Date(b.end_at) : null;
    if (b.location !== undefined) set.location = b.location;
    if (b.notes !== undefined) set.notes = b.notes;
    if (b.status !== undefined) set.status = b.status;
    if (b.lead_email !== undefined) {
      // Who the meeting is with, and their lead here when there is one.
      const leadEmail = b.lead_email || null;
      set.leadEmail = leadEmail;
      set.leadId = leadEmail ? ((await leadsByEmail(c.wsId, [leadEmail])).get(leadEmail)?.id ?? null) : null;
    }
    if (!Object.keys(set).length) return serializeMeeting(before);
    const [row] = await db.update(MT).set(set).where(and(eq(MT.id, id), eq(MT.workspaceId, c.wsId))).returning();
    assertFound(row, "Meeting");
    // The lead's status follows a new meeting status or a new contact, not every save: editing the notes of a meeting
    // whose lead has since been won mustn't take the deal back to "Meeting booked".
    const moved = row!.status !== before.status || (row!.leadEmail ?? null) !== (before.leadEmail ?? null);
    if (moved && b.set_lead_status !== false) await syncLeadStatus(c.wsId, c.userId, row!.leadEmail, row!.status);
    return serializeMeeting(row!);
  });

  app.delete("/api/app/crm/meetings/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const [row] = await db.delete(MT).where(and(eq(MT.id, (req.params as { id: string }).id), eq(MT.workspaceId, c.wsId))).returning();
    assertFound(row, "Meeting");
    return { deleted: true };
  });

  // ---------- Deals (opportunities) ----------

  /** Leads whose status is positive (or Lost when asked), one per address, with their deal details. */
  app.get("/api/app/crm/opportunities", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(
      req,
      z.object({
        campaign_id: z.string().optional(),
        list_id: z.string().optional(),
        owner: z.string().optional(),
        search: z.string().max(200).optional(),
        include_closed: zBool,
        limit: zInt(1, 2000).optional(),
      }),
    );
    await ensureDeals(c.wsId);
    const conds: SQL[] = [eq(L.workspaceId, c.wsId), isNotNull(L.email), isNotNull(L.interestStatus)];
    conds.push(q.include_closed ? sql`(${L.interestStatus} > 0 and ${L.interestStatus} < 50000 or ${L.interestStatus} = -3)` : sql`${L.interestStatus} > 0 and ${L.interestStatus} < 50000`);
    if (q.campaign_id) conds.push(eq(L.campaignId, q.campaign_id));
    if (q.list_id) conds.push(eq(L.listId, q.list_id));
    if (q.search) {
      conds.push(contains(sql`lower(coalesce(${L.email}, '') || ' ' || coalesce(${L.firstName}, '') || ' ' || coalesce(${L.lastName}, '') || ' ' || coalesce(${L.companyName}, ''))`, q.search.toLowerCase()));
    }
    const owner = q.owner === "me" ? c.userId : q.owner;
    // One deal per address (its lead with the latest status change) and, when asked, only one person's deals: both
    // before the limit, so a big pipeline or a teammate's older deals don't fall off the board.
    const latestPerAddress = sql`${L.id} in (select id from (select ${L.id} as id, row_number() over (partition by lower(${L.email}) order by ${L.lastInterestChangeAt} desc, ${L.updatedAt} desc) as rn from ${L} where ${and(...conds)}) where rn = 1)`;
    const ownedBy = owner
      ? sql`coalesce((select ${OP.ownerId} from ${OP} where ${OP.workspaceId} = ${L.workspaceId} and ${OP.leadEmail} = lower(${L.email})), ${L.assignedTo}) = ${owner}`
      : undefined;
    const [{ n: total }] = (await db
      .select({ n: sql<number>`count(*)` })
      .from(L)
      .where(and(...conds, latestPerAddress, ownedBy))) as [{ n: number }];
    const leads = await db
      .select()
      .from(L)
      .where(and(...conds, latestPerAddress, ownedBy))
      .orderBy(desc(L.lastInterestChangeAt), desc(L.updatedAt))
      .limit(q.limit ?? 1000);
    const emails = leads.map((l) => l.email!.toLowerCase());
    const opps = new Map<string, typeof OP.$inferSelect>();
    for (let i = 0; i < emails.length; i += 500) {
      for (const o of await db
        .select()
        .from(OP)
        .where(and(eq(OP.workspaceId, c.wsId), inArray(OP.leadEmail, emails.slice(i, i + 500)))))
        if (o.leadEmail) opps.set(o.leadEmail, o);
    }
    const campaignIds = [...new Set(leads.map((l) => l.campaignId).filter((x): x is string => !!x))];
    const campaigns = campaignIds.length ? await db.select({ id: schema.campaigns.id, name: schema.campaigns.name, plValue: schema.campaigns.plValue }).from(schema.campaigns).where(inArray(schema.campaigns.id, campaignIds)) : [];
    const campById = new Map(campaigns.map((x) => [x.id, x]));
    const [ws] = await db.select({ v: schema.workspaces.defaultOpportunityValue }).from(schema.workspaces).where(eq(schema.workspaces.id, c.wsId)).limit(1);
    const names = await userNames([...opps.values()].map((o) => o.ownerId).concat(leads.map((l) => l.assignedTo)));
    const items = leads
      .map((l) => {
        const key = l.email!.toLowerCase();
        const o = opps.get(key);
        const own = Number(l.plValueLead);
        const value = o ? o.value : Number.isFinite(own) && own > 0 ? own : (campById.get(l.campaignId ?? "")?.plValue ?? ws?.v ?? 0);
        const ownerId = o?.ownerId ?? l.assignedTo ?? null;
        return {
          lead_id: l.id,
          lead_email: l.email,
          name: `${l.firstName ?? ""} ${l.lastName ?? ""}`.trim() || null,
          company_name: l.companyName,
          company_domain: l.companyDomain || null,
          job_title: l.jobTitle,
          phone: l.phone,
          status: l.interestStatus,
          value,
          recurrence: o?.recurrence ?? "one_time",
          priority: o?.priority ?? "normal",
          owner_id: ownerId,
          owner_name: ownerId ? (names.get(ownerId) ?? null) : null,
          expected_close_at: iso(o?.expectedCloseAt),
          notes: o?.notes ?? null,
          won_at: iso(o?.wonAt),
          campaign: l.campaignId ? { id: l.campaignId, name: campById.get(l.campaignId)?.name ?? null } : null,
          status_changed_at: iso(l.lastInterestChangeAt),
          last_activity_at: iso(l.lastTouchAt ?? l.lastReplyAt ?? l.updatedAt),
          timestamp_created: iso(o?.createdAt ?? l.lastInterestChangeAt ?? l.createdAt),
        };
      });
    return { items, total: Number(total) };
  });

  /** One deal: details, the other people at the company and a merged timeline. */
  app.get("/api/app/crm/opportunities/:email", { config: read }, async (req) => {
    const c = ctx(req);
    const leadEmail = email.parse(decodeURIComponent((req.params as { email: string }).email));
    const [lead] = await db
      .select()
      .from(L)
      .where(and(eq(L.workspaceId, c.wsId), eq(sql`lower(${L.email})`, leadEmail)))
      .orderBy(desc(L.updatedAt))
      .limit(1);
    if (!lead) throw notFound("Lead");
    const [o] = await db.select().from(OP).where(and(eq(OP.workspaceId, c.wsId), eq(OP.leadEmail, leadEmail))).limit(1);
    const domain = (lead.companyDomain || leadEmail.split("@")[1] || "").toLowerCase();
    // The other people at the company: none for an address at a free mail provider (everyone on gmail.com isn't one).
    const colleagues =
      domain && !FREE_MAIL_DOMAINS.has(domain)
      ? await db
          .select({ id: L.id, email: L.email, firstName: L.firstName, lastName: L.lastName, jobTitle: L.jobTitle, phone: L.phone, interestStatus: L.interestStatus })
          .from(L)
          .where(and(eq(L.workspaceId, c.wsId), isNotNull(L.email), sql`(${L.companyDomain} = ${domain} or lower(${L.email}) like ${`%@${domain}`})`, sql`lower(${L.email}) <> ${leadEmail}`))
          .orderBy(desc(L.updatedAt))
          .limit(200)
      : [];
    const seen = new Set<string>();
    const contacts = colleagues
      .filter((x) => {
        const k = x.email!.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 50)
      .map((x) => ({ lead_id: x.id, email: x.email, name: `${x.firstName ?? ""} ${x.lastName ?? ""}`.trim() || null, job_title: x.jobTitle, phone: x.phone, status: x.interestStatus }));
    const names = await userNames([o?.ownerId ?? lead.assignedTo]);
    const ownerId = o?.ownerId ?? lead.assignedTo ?? null;
    return {
      lead_id: lead.id,
      lead_email: lead.email,
      name: `${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim() || null,
      company_name: lead.companyName,
      company_domain: lead.companyDomain || null,
      website: lead.website,
      job_title: lead.jobTitle,
      phone: lead.phone,
      linkedin_url: lead.linkedinUrl,
      location: lead.location,
      status: lead.interestStatus,
      value: o ? o.value : await defaultDealValue(c.wsId, lead),
      recurrence: o?.recurrence ?? "one_time",
      priority: o?.priority ?? "normal",
      owner_id: ownerId,
      owner_name: ownerId ? (names.get(ownerId) ?? null) : null,
      expected_close_at: iso(o?.expectedCloseAt),
      notes: o?.notes ?? null,
      won_at: iso(o?.wonAt),
      campaign_id: lead.campaignId,
      contacts,
    };
  });

  app.patch("/api/app/crm/opportunities/:email", { config: write }, async (req) => {
    const c = ctx(req);
    const leadEmail = email.parse(decodeURIComponent((req.params as { email: string }).email));
    const b = body(
      req,
      z.object({
        status: z.number().int().nullable().optional(),
        value: z.number().min(0).max(1e12).optional(),
        recurrence: z.enum(["one_time", "monthly", "annual"]).optional(),
        priority: z.enum(["normal", "high"]).optional(),
        owner_id: z.string().nullable().optional(),
        expected_close_at: isoDate.nullable().optional(),
        notes: z.string().max(20_000).nullable().optional(),
      }),
    );
    await assertMembers(c.wsId, [b.owner_id], "owner_id");
    const leads = await db
      .select()
      .from(L)
      .where(and(eq(L.workspaceId, c.wsId), eq(sql`lower(${L.email})`, leadEmail)))
      .orderBy(desc(L.updatedAt));
    const lead = leads[0];
    if (!lead) throw notFound("Lead");
    if (b.status !== undefined) {
      if (b.status !== null && !(await isKnownStatus(c.wsId, b.status))) throw badRequest("status: unknown lead status");
      await setInterestStatus({ workspaceId: c.wsId, leadIds: [lead.id], value: b.status, userId: c.userId, source: "user" });
    }
    const set: Partial<typeof OP.$inferInsert> = {};
    if (b.value !== undefined) set.value = b.value;
    if (b.recurrence !== undefined) set.recurrence = b.recurrence;
    if (b.priority !== undefined) set.priority = b.priority;
    if (b.owner_id !== undefined) set.ownerId = b.owner_id;
    if (b.expected_close_at !== undefined) set.expectedCloseAt = b.expected_close_at ? new Date(b.expected_close_at) : null;
    if (b.notes !== undefined) set.notes = b.notes;
    if (Object.keys(set).length) {
      // The status change above can make the deal row at the same moment (its listener runs alongside): make it only if
      // it's still missing, then write the changes either way.
      const [existing] = await db.select({ id: OP.id }).from(OP).where(and(eq(OP.workspaceId, c.wsId), eq(OP.leadEmail, leadEmail))).limit(1);
      if (!existing)
        await db
          .insert(OP)
          .values({
            workspaceId: c.wsId,
            leadEmail,
            leadId: lead.id,
            name: lead.companyName || leadEmail,
            companyName: lead.companyName,
            companyDomain: lead.companyDomain || null,
            stage: b.status !== undefined ? (b.status ?? 0) : (lead.interestStatus ?? 1),
            value: await defaultDealValue(c.wsId, lead),
            ownerId: lead.assignedTo,
            wonAt: (b.status !== undefined ? b.status : lead.interestStatus) === 4 ? new Date() : null,
          })
          .onConflictDoNothing();
      await db.update(OP).set(set).where(and(eq(OP.workspaceId, c.wsId), eq(OP.leadEmail, leadEmail)));
      if (b.value !== undefined) await db.update(L).set({ plValueLead: String(b.value) }).where(inArray(L.id, leads.map((l) => l.id)));
      if (b.owner_id !== undefined) await db.update(L).set({ assignedTo: b.owner_id }).where(inArray(L.id, leads.map((l) => l.id)));
    }
    return { ok: true };
  });

  // ---------- Lead timeline (CRM items for one address) ----------

  app.get("/api/app/crm/timeline", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ lead_email: email }));
    const withEmails = may(req, "unibox");
    const [calls, texts, tasks, meetings, notes, emails] = await Promise.all([
      db.select().from(CA).where(and(eq(CA.workspaceId, c.wsId), eq(sql`lower(${CA.leadEmail})`, q.lead_email))).orderBy(desc(CA.createdAt)).limit(100),
      db.select().from(SM).where(and(eq(SM.workspaceId, c.wsId), eq(sql`lower(${SM.leadEmail})`, q.lead_email))).orderBy(desc(SM.createdAt)).limit(200),
      // A task put away while open (its lead stopped waiting for it) never happened.
      db
        .select()
        .from(T)
        .where(and(eq(T.workspaceId, c.wsId), eq(sql`lower(${T.leadEmail})`, q.lead_email), or(isNull(T.archivedAt), ne(T.status, "open"))))
        .orderBy(desc(T.createdAt))
        .limit(100),
      db.select().from(MT).where(and(eq(MT.workspaceId, c.wsId), eq(sql`lower(${MT.leadEmail})`, q.lead_email))).orderBy(desc(MT.startAt)).limit(100),
      db.select().from(N).where(and(eq(N.workspaceId, c.wsId), eq(N.leadEmail, q.lead_email))).orderBy(desc(N.createdAt)).limit(100),
      withEmails
        ? db
            .select({ id: schema.emails.id, subject: schema.emails.subject, preview: schema.emails.contentPreview, ueType: schema.emails.ueType, at: schema.emails.timestampEmail, thread: schema.emails.threadId, from: schema.emails.fromAddress })
            .from(schema.emails)
            .where(and(eq(schema.emails.workspaceId, c.wsId), eq(sql`lower(${schema.emails.leadEmail})`, q.lead_email), isNull(schema.emails.deletedAt), sql`${schema.emails.ueType} <> 4`))
            .orderBy(desc(schema.emails.timestampEmail))
            .limit(100)
        : [],
    ]);
    const names = await userNames([...calls.map((x) => x.createdBy), ...texts.map((x) => x.createdBy), ...notes.map((x) => x.createdBy), ...tasks.map((x) => x.assignedTo)]);
    const items = [
      ...emails.map((e) => ({ type: "email", id: e.id, at: iso(e.at), title: e.subject || "(no subject)", preview: e.preview, direction: e.ueType === 2 ? "inbound" : "outbound", thread_id: e.thread })),
      ...calls.map((x) => ({ type: "call", id: x.id, at: iso(x.createdAt), title: x.direction === "inbound" ? "Incoming call" : "Outgoing call", preview: x.notes, direction: x.direction, status: x.status, duration_sec: x.durationSec, outcome: x.outcome, by: x.createdBy ? names.get(x.createdBy) : null })),
      ...texts.map((x) => ({ type: "sms", id: x.id, at: iso(x.createdAt), title: x.direction === "inbound" ? "Text received" : "Text sent", preview: x.body, direction: x.direction, status: x.status, by: x.createdBy ? names.get(x.createdBy) : null })),
      ...tasks.map((x) => ({ type: "task", id: x.id, at: iso(x.completedAt ?? x.createdAt), title: x.title, preview: x.description, status: x.status, due_at: iso(x.dueAt), by: x.assignedTo ? names.get(x.assignedTo) : null })),
      ...meetings.map((x) => ({ type: "meeting", id: x.id, at: iso(x.startAt), title: x.title, preview: x.notes, status: x.status, end_at: iso(x.endAt), location: x.location })),
      ...notes.map((x) => ({ type: "note", id: x.id, at: iso(x.createdAt), title: "Note", preview: x.body, by: x.createdBy ? names.get(x.createdBy) : null })),
    ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
    return { items };
  });

  // ---------- Sales flows (smart views) ----------

  const flowNames = async (rows: Array<typeof SF.$inferSelect>) => {
    const lists = rows.map((r) => r.listId).filter((x): x is string => !!x && x !== "all-lists");
    const camps = rows.map((r) => r.campaignId).filter((x): x is string => !!x);
    const [l, cmp] = await Promise.all([
      lists.length ? db.select({ id: schema.leadLists.id, name: schema.leadLists.name }).from(schema.leadLists).where(inArray(schema.leadLists.id, lists)) : [],
      camps.length ? db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(inArray(schema.campaigns.id, camps)) : [],
    ]);
    return new Map([...l, ...cmp].map((x) => [x.id, x.name]));
  };

  app.get("/api/app/crm/sales-flows", { config: read }, async (req) => {
    const c = ctx(req);
    const rows = await db.select().from(SF).where(eq(SF.workspaceId, c.wsId)).orderBy(asc(SF.createdAt));
    const names = await flowNames(rows);
    return { items: rows.map((r) => serializeFlow(r, names)) };
  });

  const checkScope = async (wsId: string, b: { list_id?: string | null; campaign_id?: string | null }) => {
    if (b.list_id && b.list_id !== "all-lists") {
      const [l] = await db.select({ id: schema.leadLists.id }).from(schema.leadLists).where(and(eq(schema.leadLists.id, b.list_id), eq(schema.leadLists.workspaceId, wsId))).limit(1);
      if (!l) throw badRequest("list_id: list not found");
    }
    if (b.campaign_id) {
      const [cmp] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.id, b.campaign_id), eq(schema.campaigns.workspaceId, wsId))).limit(1);
      if (!cmp) throw badRequest("campaign_id: campaign not found");
    }
  };

  app.post("/api/app/crm/sales-flows", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, flowBody);
    await checkScope(c.wsId, b);
    if (b.is_default) await db.update(SF).set({ isDefault: false }).where(eq(SF.workspaceId, c.wsId));
    const [row] = await db
      .insert(SF)
      .values({ workspaceId: c.wsId, name: b.name, queries: b.queries, listId: b.list_id ?? null, campaignId: b.campaign_id ?? null, isDefault: b.is_default ?? false, createdBy: c.userId ?? "api" })
      .returning();
    return serializeFlow(row!, await flowNames([row!]));
  });

  app.patch("/api/app/crm/sales-flows/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, flowBody.partial());
    await checkScope(c.wsId, b);
    if (b.is_default) await db.update(SF).set({ isDefault: false }).where(eq(SF.workspaceId, c.wsId));
    const set: Partial<typeof SF.$inferInsert> = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.queries !== undefined) set.queries = b.queries;
    if (b.list_id !== undefined) set.listId = b.list_id;
    if (b.campaign_id !== undefined) set.campaignId = b.campaign_id;
    if (b.is_default !== undefined) set.isDefault = b.is_default;
    const [row] = await db.update(SF).set(set).where(and(eq(SF.id, (req.params as { id: string }).id), eq(SF.workspaceId, c.wsId))).returning();
    return serializeFlow(assertFound(row, "Sales flow"), await flowNames([row!]));
  });

  app.delete("/api/app/crm/sales-flows/:id", { config: write }, async (req) => {
    const c = ctx(req);
    const [row] = await db.delete(SF).where(and(eq(SF.id, (req.params as { id: string }).id), eq(SF.workspaceId, c.wsId))).returning();
    assertFound(row, "Sales flow");
    return { deleted: true };
  });

  /** The leads a sales flow matches right now, most recently active first. */
  app.get("/api/app/crm/sales-flows/:id/leads", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ limit: zInt(1, 500).optional(), offset: zInt(0).optional(), after: z.string().max(200).optional() }));
    const [flow] = await db.select().from(SF).where(and(eq(SF.id, (req.params as { id: string }).id), eq(SF.workspaceId, c.wsId))).limit(1);
    if (!flow) throw notFound("Sales flow");
    const conds: SQL[] = [eq(L.workspaceId, c.wsId), isNotNull(L.email), ...flowConditions(c.wsId, flow.queries as FlowQuery[])];
    if (flow.campaignId) conds.push(eq(L.campaignId, flow.campaignId));
    if (flow.listId === "all-lists") conds.push(isNotNull(L.listId));
    else if (flow.listId) conds.push(eq(L.listId, flow.listId));
    const [{ n }] = (await db.select({ n: sql<number>`count(*)` }).from(L).where(and(...conds))) as [{ n: number }];
    // Most recently active first, a page after the last one shown ("<activity ms>:<lead id>"): a lead that becomes
    // active while someone scrolls moves to the top instead of pushing others into the next page twice.
    const activity = sql`coalesce(${L.lastTouchAt}, ${L.lastReplyAt}, ${L.lastOpenAt}, ${L.updatedAt})`;
    const cursor = /^(\d+):(.+)$/.exec(q.after ?? "");
    const limit = q.limit ?? 100;
    const rows = await db
      .select()
      .from(L)
      .where(and(...conds, cursor ? sql`(${activity} < ${Number(cursor[1])} or (${activity} = ${Number(cursor[1])} and ${L.id} < ${cursor[2]}))` : undefined))
      .orderBy(desc(activity), desc(L.id))
      .limit(limit)
      .offset(cursor ? 0 : (q.offset ?? 0));
    const last = rows.length === limit ? rows[rows.length - 1] : undefined;
    const lastActive = last ? (last.lastTouchAt ?? last.lastReplyAt ?? last.lastOpenAt ?? last.updatedAt) : null;
    return {
      total: Number(n),
      next_after: last && lastActive ? `${lastActive.getTime()}:${last.id}` : null,
      items: rows.map((l) => ({
        id: l.id,
        email: l.email,
        name: `${l.firstName ?? ""} ${l.lastName ?? ""}`.trim() || null,
        company_name: l.companyName,
        job_title: l.jobTitle,
        phone: l.phone,
        status: l.interestStatus,
        open_count: l.openCount,
        reply_count: l.replyCount,
        click_count: l.clickCount,
        last_contact_at: iso(l.lastContactAt),
        last_reply_at: iso(l.lastReplyAt),
        last_open_at: iso(l.lastOpenAt),
        campaign_id: l.campaignId,
        list_id: l.listId,
        is_website_visitor: !!l.isWebsiteVisitor,
      })),
    };
  });

  // ---------- Phone numbers and calling settings ----------

  app.get("/api/app/crm/phone-settings", { config: read }, async (req) => {
    const c = ctx(req);
    const numbers = await db.select().from(PN).where(eq(PN.workspaceId, c.wsId)).orderBy(asc(PN.createdAt));
    const names = await userNames(numbers.map((n) => n.assignedTo));
    return {
      twilio_configured: twilioConfigured(),
      webhooks: webhookUrls(),
      my_phone: c.user?.phone ?? null,
      numbers: numbers.map((n) => ({ id: n.id, number: n.number, friendly_name: n.friendlyName, capabilities: n.capabilities ?? null, assigned_to: n.assignedTo, assigned_to_name: n.assignedTo ? (names.get(n.assignedTo) ?? null) : null, twilio_sid: n.twilioSid, timestamp_created: iso(n.createdAt) })),
    };
  });

  app.patch("/api/app/crm/phone-settings", { config: { perm: "crm" as const } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ my_phone: z.string().trim().max(40).nullable() }));
    if (!c.userId) throw badRequest("Only signed-in users have a personal phone");
    const phone = b.my_phone ? e164(b.my_phone) : null;
    await db.update(schema.users).set({ phone }).where(eq(schema.users.id, c.userId));
    return { my_phone: phone };
  });

  app.get("/api/app/crm/phone-numbers/available", { config: { perm: "crm" as const, admin: true } }, async (req) => {
    const q = query(req, z.object({ country: z.string().length(2).default("US"), area_code: z.string().regex(/^\d{2,5}$/).optional(), contains: z.string().max(10).optional(), type: z.enum(["Local", "Mobile", "TollFree"]).default("Local") }));
    const r = await twilioRequest<{ available_phone_numbers?: Array<{ phone_number: string; friendly_name: string; locality: string | null; region: string | null; capabilities: { voice?: boolean; SMS?: boolean; sms?: boolean } }> }>(
      "GET",
      `/AvailablePhoneNumbers/${q.country.toUpperCase()}/${q.type}.json?${new URLSearchParams({ PageSize: "20", ...(q.area_code ? { AreaCode: q.area_code } : {}), ...(q.contains ? { Contains: q.contains } : {}) })}`,
    );
    return { items: (r.available_phone_numbers ?? []).map((n) => ({ number: n.phone_number, friendly_name: n.friendly_name, locality: n.locality, region: n.region, voice: !!n.capabilities.voice, sms: !!(n.capabilities.SMS ?? n.capabilities.sms) })) };
  });

  app.post("/api/app/crm/phone-numbers", { config: { perm: "crm" as const, admin: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ number: z.string(), assigned_to: z.string().nullable().optional() }));
    await assertMaySpendTwilio(c);
    const number = e164(b.number);
    // Checked before the number is bought, not after.
    await assertMembers(c.wsId, [b.assigned_to], "assigned_to");
    const hooks = webhookUrls();
    const r = await twilioRequest<{ sid: string; phone_number: string; friendly_name: string; capabilities: { voice?: boolean; sms?: boolean; SMS?: boolean } }>("POST", "/IncomingPhoneNumbers.json", {
      PhoneNumber: number,
      // How each call to the number ends comes back here too, so incoming calls don't stay "ringing".
      ...(hooks.reachable ? { SmsUrl: hooks.sms, VoiceUrl: hooks.voice, StatusCallback: hooks.status } : {}),
    });
    const [row] = await db
      .insert(PN)
      .values({ workspaceId: c.wsId, number: r.phone_number, friendlyName: r.friendly_name, twilioSid: r.sid, capabilities: { voice: !!r.capabilities?.voice, sms: !!(r.capabilities?.sms ?? r.capabilities?.SMS) }, assignedTo: b.assigned_to ?? c.userId })
      .returning();
    return { id: row!.id, number: row!.number };
  });

  /** Brings in numbers that already exist in the server's Twilio account. */
  app.post("/api/app/crm/phone-numbers/import", { config: { perm: "crm" as const, admin: true } }, async (req) => {
    const c = ctx(req);
    await assertMaySpendTwilio(c);
    const r = await twilioRequest<{ incoming_phone_numbers?: Array<{ sid: string; phone_number: string; friendly_name: string; capabilities: { voice?: boolean; sms?: boolean } }> }>("GET", "/IncomingPhoneNumbers.json?PageSize=100");
    const taken = new Set((await db.select({ n: PN.number }).from(PN)).map((x) => x.n));
    let added = 0;
    for (const n of r.incoming_phone_numbers ?? []) {
      if (taken.has(n.phone_number)) continue;
      await db.insert(PN).values({ workspaceId: c.wsId, number: n.phone_number, friendlyName: n.friendly_name, twilioSid: n.sid, capabilities: { voice: !!n.capabilities?.voice, sms: !!n.capabilities?.sms } });
      added++;
    }
    return { added, skipped: (r.incoming_phone_numbers?.length ?? 0) - added };
  });

  app.patch("/api/app/crm/phone-numbers/:id", { config: { perm: "crm" as const, admin: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ assigned_to: z.string().nullable().optional(), friendly_name: z.string().max(100).nullable().optional() }));
    await assertMembers(c.wsId, [b.assigned_to], "assigned_to");
    const set: Partial<typeof PN.$inferInsert> = {};
    if (b.assigned_to !== undefined) set.assignedTo = b.assigned_to;
    if (b.friendly_name !== undefined) set.friendlyName = b.friendly_name;
    const mine = and(eq(PN.id, (req.params as { id: string }).id), eq(PN.workspaceId, c.wsId));
    // Nothing to change is fine (the number must still be this workspace's).
    const [row] = Object.keys(set).length ? await db.update(PN).set(set).where(mine).returning() : await db.select().from(PN).where(mine).limit(1);
    assertFound(row, "Phone number");
    return { ok: true };
  });

  // ---------- Reports ----------

  app.get("/api/app/crm/reports", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ start_date: z.string().optional(), end_date: z.string().optional(), owner: z.string().optional() }));
    const { start, end } = await rangeOf(c.wsId, q);
    const owner = q.owner === "me" ? (c.userId ?? undefined) : q.owner || undefined;
    const span = end.getTime() - start.getTime();
    await ensureDeals(c.wsId);
    const [current, previous, goals, stripe] = await Promise.all([
      reportMetrics(c.wsId, start, end, owner),
      q.start_date ? reportMetrics(c.wsId, new Date(start.getTime() - span - 1), new Date(start.getTime() - 1), owner) : null,
      getWorkspaceSetting<Record<string, number | null>>(c.wsId, "crm_goals", {}),
      stripeLink(c.wsId),
    ]);
    // The pipeline is a snapshot of open deals today, so it has no earlier period to compare against.
    if (previous) previous.pipeline_value = null;
    return { metrics: current, previous, goals, stripe: stripe ? { mode: stripe.mode, account_name: stripe.account_name, connected_at: stripe.connected_at } : null, stripe_oauth_available: !!(config.stripe.secretKey && process.env.STRIPE_CONNECT_CLIENT_ID) };
  });

  app.put("/api/app/crm/reports/goals", { config: write }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ goals: z.record(z.enum(REPORT_METRICS), z.number().min(0).max(1e12).nullable()) }));
    const current = await getWorkspaceSetting<Record<string, number | null>>(c.wsId, "crm_goals", {});
    const next: Record<string, number | null> = { ...current, ...b.goals };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    await patchWorkspaceSettings(c.wsId, { crm_goals: next });
    return { goals: next };
  });

  app.post("/api/app/crm/stripe", { config: { perm: "crm" as const, admin: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ api_key: z.string().trim().regex(/^(rk|sk)_(live|test)_[A-Za-z0-9]{10,}$/, "Paste a Stripe restricted key (rk_live_… or rk_test_…)") }));
    const name = await verifyStripeKey(b.api_key);
    const link: StripeLink = { mode: "key", secret: encrypt(b.api_key), account_name: name, connected_at: new Date().toISOString() };
    await patchWorkspaceSettings(c.wsId, { crm_stripe: link });
    clearCashCache(c.wsId);
    return { mode: link.mode, account_name: name, connected_at: link.connected_at };
  });

  /** Stripe Connect (only when the operator configured a Connect platform): exchange the OAuth code. */
  app.post("/api/app/crm/stripe/oauth", { config: { perm: "crm" as const, admin: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ code: z.string().min(1).max(500), state: z.string().max(2000).optional() }));
    if (!config.stripe.secretKey || !process.env.STRIPE_CONNECT_CLIENT_ID) throw badRequest("Stripe Connect isn't set up on this server. Connect with a restricted API key instead.");
    // The state was signed for this workspace and person when the sign-in started, so nobody else's code lands here.
    const st = verifyPayload<{ ws: string; u: string | null; exp: number }>(b.state);
    if (!st || st.exp < Date.now() || st.ws !== c.wsId || st.u !== (c.userId ?? null)) throw badRequest("This Stripe sign-in didn't start from this workspace. Start it again from the reports page.");
    const res = await fetch("https://connect.stripe.com/oauth/token", {
      method: "POST",
      headers: { authorization: `Bearer ${config.stripe.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: b.code }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as { stripe_user_id?: string; error_description?: string };
    if (!res.ok || !data.stripe_user_id) throw badRequest(`Stripe: ${data.error_description ?? "the connection failed"}`);
    const link: StripeLink = { mode: "oauth", secret: data.stripe_user_id, account_name: null, connected_at: new Date().toISOString() };
    await patchWorkspaceSettings(c.wsId, { crm_stripe: link });
    clearCashCache(c.wsId);
    return { mode: link.mode, connected_at: link.connected_at };
  });

  app.get("/api/app/crm/stripe/oauth-url", { config: { perm: "crm" as const, admin: true } }, async (req) => {
    const c = ctx(req);
    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) throw badRequest("Stripe Connect isn't set up on this server");
    const params = new URLSearchParams({ response_type: "code", client_id: clientId, scope: "read_only", redirect_uri: `${config.webUrl}/app/oauth/callback/stripe`, state: signPayload({ ws: c.wsId, u: c.userId ?? null, exp: Date.now() + 15 * 60_000 }) });
    return { url: `https://connect.stripe.com/oauth/authorize?${params}` };
  });

  app.delete("/api/app/crm/stripe", { config: { perm: "crm" as const, admin: true } }, async (req) => {
    const c = ctx(req);
    await patchWorkspaceSettings(c.wsId, { crm_stripe: null });
    clearCashCache(c.wsId);
    return { ok: true };
  });

  // ---------- Activity comparison (per teammate) ----------

  app.get("/api/app/crm/activity-comparison", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ start_date: z.string().optional(), end_date: z.string().optional() }));
    const { start, end } = await rangeOf(c.wsId, q);
    await ensureDeals(c.wsId);
    const members = await db
      .select({ userId: schema.workspaceMembers.userId, email: schema.workspaceMembers.email })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, c.wsId), eq(schema.workspaceMembers.accepted, true), isNotNull(schema.workspaceMembers.userId)));
    const ids = members.map((m) => m.userId!);
    const names = await userNames(ids);
    const between = (col: unknown) => sql`${col} >= ${start.getTime()} and ${col} <= ${end.getTime()}`;
    const grouped = async (table: typeof CA | typeof SM | typeof MT | typeof N, userCol: SQL, timeCol: unknown, extra: SQL = sql`1 = 1`) =>
      new Map(
        (
          (await db.all(sql`select ${userCol} as u, count(*) as n from ${table} where workspace_id = ${c.wsId} and ${between(timeCol)} and ${extra} group by ${userCol}`)) as Array<{ u: string | null; n: number }>
        ).map((r) => [r.u ?? "", Number(r.n)]),
      );
    const [callsOut, sms, meetings, notes, tasksDone, won, owned] = await Promise.all([
      grouped(CA, sql`created_by`, CA.createdAt, sql`direction = 'outbound'`),
      grouped(SM, sql`created_by`, SM.createdAt, sql`direction = 'outbound'`),
      grouped(MT, sql`created_by`, MT.createdAt),
      grouped(N, sql`created_by`, N.createdAt),
      (async () =>
        new Map(
          ((await db.all(sql`select assigned_to as u, count(*) as n from crm_tasks where workspace_id = ${c.wsId} and status = 'done' and ${between(T.completedAt)} group by assigned_to`)) as Array<{ u: string | null; n: number }>).map((r) => [r.u ?? "", Number(r.n)]),
        ))(),
      (async () =>
        new Map(
          (
            (await db.all(sql`select owner_id as u, count(*) as n, coalesce(sum(value), 0) as v from crm_opportunities where workspace_id = ${c.wsId} and won_at is not null and ${between(OP.wonAt)} group by owner_id`)) as Array<{
              u: string | null;
              n: number;
              v: number;
            }>
          ).map((r) => [r.u ?? "", { n: Number(r.n), v: Number(r.v) }]),
        ))(),
      (async () =>
        new Map(
          ((await db.all(sql`select owner_id as u, count(*) as n from crm_opportunities o where o.workspace_id = ${c.wsId} and o.archived_at is null and o.stage > 0 and o.stage <> 4 and o.stage < 50000 and exists (select 1 from leads l where l.workspace_id = o.workspace_id and l.email = o.lead_email) group by owner_id`)) as Array<{ u: string | null; n: number }>).map((r) => [r.u ?? "", Number(r.n)]),
        ))(),
    ]);
    return {
      items: ids.map((id) => ({
        user_id: id,
        name: names.get(id) ?? members.find((m) => m.userId === id)?.email ?? id,
        calls: callsOut.get(id) ?? 0,
        sms: sms.get(id) ?? 0,
        meetings_booked: meetings.get(id) ?? 0,
        notes: notes.get(id) ?? 0,
        tasks_completed: tasksDone.get(id) ?? 0,
        deals_won: won.get(id)?.n ?? 0,
        value_won: won.get(id)?.v ?? 0,
        open_deals: owned.get(id) ?? 0,
      })),
    };
  });

  // ---------- Twilio webhooks (incoming texts and calls) ----------

  await app.register(async (hook) => {
    hook.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, raw, done) => done(null, raw));
    const params = (raw: unknown) => Object.fromEntries(new URLSearchParams(String(raw ?? "")));
    const verify = (path: string, p: Record<string, string>, sig: string | undefined) => {
      if (!validTwilioSignature(`${config.appUrl}${path}`, p, sig)) throw badRequest("Invalid Twilio signature");
    };
    const twiml = (inner = "") => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

    hook.post("/api/webhooks/twilio/sms", { config: { auth: "public" } }, async (req, reply) => {
      const p = params(req.body);
      verify("/api/webhooks/twilio/sms", p, req.headers["x-twilio-signature"] as string | undefined);
      const number = await workspaceForNumber(p.To ?? "");
      if (number) {
        const from = p.From ?? "";
        const lead = await leadForPhone(number.workspaceId, from);
        const [row] = await db
          .insert(SM)
          .values({ workspaceId: number.workspaceId, leadEmail: lead?.email?.toLowerCase() ?? null, leadId: lead?.id ?? null, phoneNumber: from, fromNumber: p.To ?? null, direction: "inbound", body: p.Body ?? "", status: "received", twilioSid: p.MessageSid ?? null })
          .returning();
        emit("sms_received", number.workspaceId, { sms_id: row!.id, from, body: row!.body, lead_email: row!.leadEmail });
      }
      return reply.type("text/xml").send(twiml());
    });

    hook.post("/api/webhooks/twilio/voice", { config: { auth: "public" } }, async (req, reply) => {
      const p = params(req.body);
      verify("/api/webhooks/twilio/voice", p, req.headers["x-twilio-signature"] as string | undefined);
      const number = await workspaceForNumber(p.To ?? "");
      if (!number) return reply.type("text/xml").send(twiml("<Say>This number is not in service.</Say>"));
      const from = p.From ?? "";
      const lead = await leadForPhone(number.workspaceId, from);
      await db.insert(CA).values({ workspaceId: number.workspaceId, leadEmail: lead?.email?.toLowerCase() ?? null, leadId: lead?.id ?? null, phoneNumber: from, fromNumber: p.To ?? null, direction: "inbound", status: "ringing", twilioSid: p.CallSid ?? null });
      // Only someone still in the workspace (and able to sign in) is rung: never the personal phone of someone who left.
      const [owner] = number.assignedTo
        ? await db
            .select({ phone: schema.users.phone })
            .from(schema.users)
            .innerJoin(schema.workspaceMembers, and(eq(schema.workspaceMembers.userId, schema.users.id), eq(schema.workspaceMembers.workspaceId, number.workspaceId), eq(schema.workspaceMembers.accepted, true)))
            .where(and(eq(schema.users.id, number.assignedTo), isNull(schema.users.deletedAt), isNull(schema.users.disabledAt)))
            .limit(1)
        : [];
      const forward = owner?.phone ? `<Dial>${owner.phone.replace(/[^+\d]/g, "")}</Dial>` : "<Say>Sorry, no one can take your call right now. Please try again later.</Say>";
      return reply.type("text/xml").send(twiml(forward));
    });

    hook.post("/api/webhooks/twilio/call-status", { config: { auth: "public" } }, async (req, reply) => {
      const p = params(req.body);
      verify("/api/webhooks/twilio/call-status", p, req.headers["x-twilio-signature"] as string | undefined);
      if (p.CallSid) {
        // A call that already ended keeps its outcome, and "call ended" goes out once (a refresh may have got there first).
        const [row] = await db
          .update(CA)
          .set({ status: p.CallStatus ?? "completed", durationSec: Number(p.CallDuration ?? 0) || 0, ...(p.RecordingUrl ? { recordingUrl: p.RecordingUrl } : {}) })
          .where(and(eq(CA.twilioSid, p.CallSid), notInArray(CA.status, FINAL_CALL_STATUSES)))
          .returning();
        if (row && FINAL_CALL_STATUSES.includes(row.status)) emit("call_completed", row.workspaceId, { call_id: row.id, status: row.status, lead_email: row.leadEmail, direction: row.direction, duration_sec: row.durationSec });
        // A recording that comes after the call was already marked ended is still kept.
        else if (!row && p.RecordingUrl) await db.update(CA).set({ recordingUrl: p.RecordingUrl }).where(and(eq(CA.twilioSid, p.CallSid), isNull(CA.recordingUrl)));
      }
      return reply.type("text/xml").send(twiml());
    });
  });
}

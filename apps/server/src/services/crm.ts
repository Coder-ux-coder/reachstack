// CRM: the team inbox (replies, calls, texts and due tasks), deal details layered on lead statuses, calls and
// texts through Twilio, sales flows (smart lead queues) and the numbers behind the CRM reports.
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { CUSTOM_INTEREST_BASE, DEFAULT_INTEREST_STATUSES, interestSentiment } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { badRequest } from "../http/errors";
import { chunk } from "../http/util";
import { iso } from "../lib/time";
import { emit, on } from "./bus";
import { twilioConfigured, twilioRequest } from "./twilio";
import { startOfNextDayOn, workspaceZone } from "./workspace-clock";

const L = schema.leads;
const E = schema.emails;
const EV = schema.emailEvents;
const T = schema.crmTasks;
const CA = schema.crmCalls;
const SM = schema.crmSms;
const MT = schema.crmMeetings;
const OP = schema.crmOpportunities;
const PN = schema.crmPhoneNumbers;

export type FeedType = "email" | "call" | "sms" | "task" | "meeting";
export type FeedView = "inbox" | "upcoming" | "archive";
export const FEED_TYPES: FeedType[] = ["email", "call", "sms", "task", "meeting"];

export interface FeedItem {
  key: string;
  type: FeedType;
  id: string;
  at: string;
  lead_email: string | null;
  lead_id: string | null;
  lead_name: string | null;
  company_name: string | null;
  title: string;
  preview: string | null;
  direction: "inbound" | "outbound" | null;
  status: string | null;
  due_at: string | null;
  done_at: string | null;
  assigned_to: string | null;
  thread_id: string | null;
  meta: Record<string, unknown>;
}

/** The last moment of today on the workspace's clock: tasks due by then are in the inbox, later ones are upcoming. */
const endOfToday = async (workspaceId: string) => new Date(startOfNextDayOn(await workspaceZone(workspaceId)) - 1);

/** A sequence's task is due when its lead gets to the step; it's overdue once it has waited a day. */
const SEQUENCE_TASK_OVERDUE_MS = 86_400_000;

/** An open task past its due time (a sequence's task: a day past it). */
export function isOverdue(t: { dueAt: Date | null; status: string; source: string | null }, now = Date.now()): boolean {
  return !!t.dueAt && t.status === "open" && t.dueAt.getTime() < now - (t.source === "sequence" ? SEQUENCE_TASK_OVERDUE_MS : 0);
}

const ms = (d: Date | number | null | undefined) => (d == null ? 0 : typeof d === "number" ? d : d.getTime());

/** Display names for workspace users. */
export async function userNames(ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db.select({ id: schema.users.id, firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, unique));
  return new Map(rows.map((u) => [u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email]));
}

export interface LeadBrief {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  job_title: string | null;
}

/** The most recently updated lead row for each address. */
export async function leadsByEmail(workspaceId: string, emails: Array<string | null | undefined>) {
  const unique = [...new Set(emails.filter((x): x is string => !!x).map((e) => e.toLowerCase()))];
  const out = new Map<string, LeadBrief>();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await db
      .select({ id: L.id, email: L.email, firstName: L.firstName, lastName: L.lastName, companyName: L.companyName, phone: L.phone, jobTitle: L.jobTitle })
      .from(L)
      .where(and(eq(L.workspaceId, workspaceId), inArray(sql`lower(${L.email})`, chunk)))
      .orderBy(desc(L.updatedAt));
    for (const r of rows) {
      const key = (r.email ?? "").toLowerCase();
      if (!key || out.has(key)) continue;
      out.set(key, { id: r.id, email: r.email!, name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || null, company: r.companyName, phone: r.phone, job_title: r.jobTitle });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Inbox feed

interface FeedQuery {
  view: FeedView;
  types: FeedType[];
  leadEmail?: string;
  owner?: string;
  limit: number;
}

/** An address belongs to one of `owner`'s leads. */
const ownersLead = (ws: string, owner: string, column: AnyColumn) => sql`lower(${column}) in (select lower(email) from leads where workspace_id = ${ws} and assigned_to = ${owner})`;

/**
 * "Mine", for calls and texts: the ones someone logged or made, and the ones nobody did (they came in) about their
 * leads. For meetings: the ones they booked, and any with their leads.
 */
const mineCall = (ws: string, owner: string) => or(eq(CA.createdBy, owner), and(isNull(CA.createdBy), ownersLead(ws, owner, CA.leadEmail)))!;
const mineText = (ws: string, owner: string) => or(eq(SM.createdBy, owner), and(isNull(SM.createdBy), ownersLead(ws, owner, SM.leadEmail)))!;
const mineMeeting = (ws: string, owner: string) => or(eq(MT.createdBy, owner), ownersLead(ws, owner, MT.leadEmail))!;
/** Meetings stay upcoming until an hour after they start. */
const upcomingFrom = () => new Date(Date.now() - 3_600_000);

function base(type: FeedType, id: string, at: Date | number | null, extra: Partial<FeedItem>): FeedItem {
  return {
    key: `${type}:${id}`,
    type,
    id,
    at: iso(at ?? Date.now())!,
    lead_email: null,
    lead_id: null,
    lead_name: null,
    company_name: null,
    title: "",
    preview: null,
    direction: null,
    status: null,
    due_at: null,
    done_at: null,
    assigned_to: null,
    thread_id: null,
    meta: {},
    ...extra,
  };
}

async function emailItems(ws: string, q: FeedQuery): Promise<FeedItem[]> {
  if (q.view === "upcoming") return [];
  const conds: SQL[] = [eq(E.workspaceId, ws), eq(E.ueType, 2), isNull(E.deletedAt), eq(E.isAutoReply, 0), eq(E.isBounce, false), isNotNull(E.leadEmail)];
  conds.push(q.view === "inbox" ? isNull(E.crmDoneAt) : isNotNull(E.crmDoneAt));
  if (q.leadEmail) conds.push(eq(sql`lower(${E.leadEmail})`, q.leadEmail));
  if (q.owner) conds.push(sql`lower(${E.leadEmail}) in (select lower(email) from leads where workspace_id = ${ws} and assigned_to = ${q.owner})`);
  const rows = await db
    .select({ id: E.id, subject: E.subject, preview: E.contentPreview, text: E.bodyText, at: E.timestampEmail, done: E.crmDoneAt, lead: E.leadEmail, leadId: E.leadId, thread: E.threadId, from: E.fromAddress, account: E.eaccount, unread: E.isUnread })
    .from(E)
    .where(and(...conds))
    .orderBy(desc(q.view === "inbox" ? E.timestampEmail : E.crmDoneAt))
    .limit(q.limit);
  return rows.map((r) =>
    base("email", r.id, q.view === "inbox" ? r.at : r.done, {
      lead_email: r.lead,
      lead_id: r.leadId,
      title: r.subject || "(no subject)",
      preview: (r.preview ?? r.text ?? "").replace(/\s+/g, " ").trim().slice(0, 280) || null,
      direction: "inbound",
      done_at: iso(r.done),
      thread_id: r.thread,
      meta: { received_at: iso(r.at), account: r.account, unread: !!r.unread },
    }),
  );
}

async function callItems(ws: string, q: FeedQuery): Promise<FeedItem[]> {
  if (q.view === "upcoming") return [];
  const conds: SQL[] = [eq(CA.workspaceId, ws), q.view === "inbox" ? isNull(CA.archivedAt) : isNotNull(CA.archivedAt)];
  if (q.leadEmail) conds.push(eq(sql`lower(${CA.leadEmail})`, q.leadEmail));
  if (q.owner) conds.push(mineCall(ws, q.owner));
  const rows = await db.select().from(CA).where(and(...conds)).orderBy(desc(q.view === "inbox" ? CA.createdAt : CA.archivedAt)).limit(q.limit);
  return rows.map((r) =>
    base("call", r.id, q.view === "inbox" ? r.createdAt : r.archivedAt, {
      lead_email: r.leadEmail,
      lead_id: r.leadId,
      title: r.direction === "inbound" ? `Call from ${r.phoneNumber}` : `Call to ${r.phoneNumber}`,
      preview: r.notes,
      direction: r.direction === "inbound" ? "inbound" : "outbound",
      status: r.status,
      done_at: iso(r.archivedAt),
      meta: { phone_number: r.phoneNumber, from_number: r.fromNumber, duration_sec: r.durationSec, outcome: r.outcome, recording_url: r.recordingUrl, created_at: iso(r.createdAt), created_by: r.createdBy },
    }),
  );
}

async function smsItems(ws: string, q: FeedQuery): Promise<FeedItem[]> {
  if (q.view === "upcoming") return [];
  const conds: SQL[] = [eq(SM.workspaceId, ws), q.view === "inbox" ? isNull(SM.archivedAt) : isNotNull(SM.archivedAt)];
  if (q.leadEmail) conds.push(eq(sql`lower(${SM.leadEmail})`, q.leadEmail));
  if (q.owner) conds.push(mineText(ws, q.owner));
  const rows = await db.select().from(SM).where(and(...conds)).orderBy(desc(q.view === "inbox" ? SM.createdAt : SM.archivedAt)).limit(q.limit);
  return rows.map((r) =>
    base("sms", r.id, q.view === "inbox" ? r.createdAt : r.archivedAt, {
      lead_email: r.leadEmail,
      lead_id: r.leadId,
      title: r.direction === "inbound" ? `Text from ${r.phoneNumber}` : `Text to ${r.phoneNumber}`,
      preview: r.body,
      direction: r.direction === "inbound" ? "inbound" : "outbound",
      status: r.status,
      done_at: iso(r.archivedAt),
      meta: { phone_number: r.phoneNumber, from_number: r.fromNumber, created_at: iso(r.createdAt), created_by: r.createdBy },
    }),
  );
}

async function taskItems(ws: string, q: FeedQuery): Promise<FeedItem[]> {
  const conds: SQL[] = [eq(T.workspaceId, ws), isNull(T.archivedAt)];
  const eod = await endOfToday(ws);
  if (q.view === "inbox") conds.push(eq(T.status, "open"), or(isNull(T.dueAt), lte(T.dueAt, eod))!);
  else if (q.view === "upcoming") conds.push(eq(T.status, "open"), gt(T.dueAt, eod));
  // Finished: done, or (a sequence's task) skipped.
  else conds.push(inArray(T.status, ["done", "skipped"]));
  if (q.leadEmail) conds.push(eq(sql`lower(${T.leadEmail})`, q.leadEmail));
  if (q.owner) conds.push(eq(T.assignedTo, q.owner));
  const order = q.view === "archive" ? desc(T.completedAt) : q.view === "upcoming" ? asc(T.dueAt) : desc(sql`coalesce(${T.dueAt}, ${T.createdAt})`);
  const rows = await db.select().from(T).where(and(...conds)).orderBy(order).limit(q.limit);
  return rows.map((r) =>
    base("task", r.id, q.view === "archive" ? r.completedAt : (r.dueAt ?? r.createdAt), {
      lead_email: r.leadEmail,
      lead_id: r.leadId,
      title: r.title,
      preview: r.description,
      status: r.status,
      due_at: iso(r.dueAt),
      done_at: iso(r.completedAt),
      assigned_to: r.assignedTo,
      meta: { task_type: r.type, priority: r.priority, overdue: isOverdue(r), source: r.source },
    }),
  );
}

async function meetingItems(ws: string, q: FeedQuery): Promise<FeedItem[]> {
  if (q.view !== "upcoming") return [];
  const conds: SQL[] = [eq(MT.workspaceId, ws), eq(MT.status, "scheduled"), gte(MT.startAt, upcomingFrom())];
  if (q.leadEmail) conds.push(eq(sql`lower(${MT.leadEmail})`, q.leadEmail));
  if (q.owner) conds.push(mineMeeting(ws, q.owner));
  const rows = await db.select().from(MT).where(and(...conds)).orderBy(asc(MT.startAt)).limit(q.limit);
  return rows.map((r) =>
    base("meeting", r.id, r.startAt, {
      lead_email: r.leadEmail,
      lead_id: r.leadId,
      title: r.title,
      preview: r.notes,
      status: r.status,
      due_at: iso(r.startAt),
      meta: { start_at: iso(r.startAt), end_at: iso(r.endAt), location: r.location },
    }),
  );
}

const SOURCES: Record<FeedType, (ws: string, q: FeedQuery) => Promise<FeedItem[]>> = { email: emailItems, call: callItems, sms: smsItems, task: taskItems, meeting: meetingItems };

export async function feed(workspaceId: string, q: FeedQuery) {
  const lists = await Promise.all(q.types.map((t) => SOURCES[t](workspaceId, { ...q, limit: q.limit + 1 })));
  const all = lists.flat();
  all.sort((a, b) => (q.view === "upcoming" ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)));
  const items = all.slice(0, q.limit);
  const leads = await leadsByEmail(workspaceId, items.map((i) => i.lead_email));
  for (const i of items) {
    const l = i.lead_email ? leads.get(i.lead_email.toLowerCase()) : undefined;
    if (!l) continue;
    i.lead_id ??= l.id;
    i.lead_name = l.name;
    i.company_name = l.company;
  }
  return { items, has_more: all.length > q.limit };
}

/** The inbox's counts, the way its lists count (`emails` false: replies aren't shown to this member). */
export async function feedCounts(workspaceId: string, owner?: string, opts: { emails?: boolean } = {}) {
  const eod = await endOfToday(workspaceId);
  const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
  const ownerEmail = owner ? sql`and lower(${E.leadEmail}) in (select lower(email) from leads where workspace_id = ${workspaceId} and assigned_to = ${owner})` : sql``;
  const [emails, calls, sms, tasks, upcomingTasks, meetings] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(E)
      .where(sql`${E.workspaceId} = ${workspaceId} and ${E.ueType} = 2 and ${E.deletedAt} is null and ${E.isAutoReply} = 0 and ${E.isBounce} = 0 and ${E.leadEmail} is not null and ${E.crmDoneAt} is null ${ownerEmail}`),
    db.select({ n: sql<number>`count(*)` }).from(CA).where(and(eq(CA.workspaceId, workspaceId), isNull(CA.archivedAt), owner ? mineCall(workspaceId, owner) : undefined)),
    db.select({ n: sql<number>`count(*)` }).from(SM).where(and(eq(SM.workspaceId, workspaceId), isNull(SM.archivedAt), owner ? mineText(workspaceId, owner) : undefined)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(T)
      .where(and(eq(T.workspaceId, workspaceId), isNull(T.archivedAt), eq(T.status, "open"), or(isNull(T.dueAt), lte(T.dueAt, eod)), owner ? eq(T.assignedTo, owner) : undefined)),
    db.select({ n: sql<number>`count(*)` }).from(T).where(and(eq(T.workspaceId, workspaceId), isNull(T.archivedAt), eq(T.status, "open"), gt(T.dueAt, eod), owner ? eq(T.assignedTo, owner) : undefined)),
    db.select({ n: sql<number>`count(*)` }).from(MT).where(and(eq(MT.workspaceId, workspaceId), eq(MT.status, "scheduled"), gte(MT.startAt, upcomingFrom()), owner ? mineMeeting(workspaceId, owner) : undefined)),
  ]);
  const inbox = { email: opts.emails === false ? 0 : n(emails), call: n(calls), sms: n(sms), task: n(tasks) };
  return { inbox: { ...inbox, all: inbox.email + inbox.call + inbox.sms + inbox.task }, upcoming: n(upcomingTasks) + n(meetings) };
}

/** Marks inbox items handled (done) or puts them back in the inbox. */
export async function setDone(workspaceId: string, items: Array<{ type: FeedType; id: string }>, done: boolean) {
  const now = new Date();
  const ids = (t: FeedType) => items.filter((i) => i.type === t).map((i) => i.id);
  let changed = 0;
  const count = (rows: unknown[]) => (changed += rows.length);
  if (ids("email").length) count(await db.update(E).set({ crmDoneAt: done ? now : null }).where(and(eq(E.workspaceId, workspaceId), inArray(E.id, ids("email")))).returning({ id: E.id }));
  if (ids("call").length) count(await db.update(CA).set({ archivedAt: done ? now : null }).where(and(eq(CA.workspaceId, workspaceId), inArray(CA.id, ids("call")))).returning({ id: CA.id }));
  if (ids("sms").length) count(await db.update(SM).set({ archivedAt: done ? now : null }).where(and(eq(SM.workspaceId, workspaceId), inArray(SM.id, ids("sms")))).returning({ id: SM.id }));
  if (ids("task").length)
    count(
      await db
        .update(T)
        .set(done ? { status: "done", completedAt: now } : { status: "open", completedAt: null })
        // A sequence's task, once finished, stays finished: its lead has moved on (routes/crm.ts finishes open ones).
        .where(and(eq(T.workspaceId, workspaceId), inArray(T.id, ids("task")), or(isNull(T.source), ne(T.source, "sequence"))))
        .returning({ id: T.id }),
    );
  if (ids("meeting").length)
    count(
      await db
        .update(MT)
        .set({ status: done ? "completed" : "scheduled" })
        .where(and(eq(MT.workspaceId, workspaceId), inArray(MT.id, ids("meeting"))))
        .returning({ id: MT.id }),
    );
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks

export type TaskRow = typeof T.$inferSelect;

const distinct = (ids: Array<string | null>) => [...new Set(ids.filter((x): x is string => !!x))];

export async function serializeTasks(workspaceId: string, rows: TaskRow[]) {
  const leadIds = distinct(rows.map((r) => r.leadId));
  const campaignIds = distinct(rows.map((r) => r.campaignId));
  const subsequenceIds = distinct(rows.map((r) => r.subsequenceId));
  const C = schema.campaigns;
  const S = schema.subsequences;
  const [names, byEmail, byId, campaigns, subsequences] = await Promise.all([
    userNames(rows.flatMap((r) => [r.assignedTo, r.createdBy])),
    leadsByEmail(workspaceId, rows.map((r) => r.leadEmail)),
    // The task's own lead (an email can be in several campaigns), with what calling or finding them takes.
    leadIds.length
      ? db
          .select({ id: L.id, firstName: L.firstName, lastName: L.lastName, companyName: L.companyName, phone: L.phone, linkedinUrl: L.linkedinUrl, timezone: L.timezone, location: L.location })
          .from(L)
          .where(and(eq(L.workspaceId, workspaceId), inArray(L.id, leadIds)))
      : [],
    campaignIds.length ? db.select({ id: C.id, name: C.name }).from(C).where(and(eq(C.workspaceId, workspaceId), inArray(C.id, campaignIds))) : [],
    subsequenceIds.length ? db.select({ id: S.id, name: S.name }).from(S).where(and(eq(S.workspaceId, workspaceId), inArray(S.id, subsequenceIds))) : [],
  ]);
  const leadsById = new Map(byId.map((l) => [l.id, l]));
  const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));
  const subsequenceNames = new Map(subsequences.map((c) => [c.id, c.name]));
  return rows.map((r) => {
    const own = r.leadId ? leadsById.get(r.leadId) : undefined;
    const l = r.leadEmail ? byEmail.get(r.leadEmail.toLowerCase()) : undefined;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      type: r.type,
      status: r.status,
      priority: r.priority,
      due_at: iso(r.dueAt),
      lead_email: r.leadEmail,
      lead_id: r.leadId ?? l?.id ?? null,
      lead_name: own ? [own.firstName, own.lastName].filter(Boolean).join(" ").trim() || null : (l?.name ?? null),
      company_name: own ? own.companyName : (l?.company ?? null),
      lead_phone: own ? own.phone : (l?.phone ?? null),
      lead_linkedin_url: own?.linkedinUrl ?? null,
      lead_timezone: own?.timezone ?? null,
      lead_location: own?.location ?? null,
      assigned_to: r.assignedTo,
      assigned_to_name: r.assignedTo ? (names.get(r.assignedTo) ?? null) : null,
      created_by: r.createdBy,
      created_by_name: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
      source: r.source,
      /** A sequence's task: the campaign or subsequence, the step (from 1) and its kind. */
      campaign_id: r.campaignId,
      campaign_name: r.campaignId ? (campaignNames.get(r.campaignId) ?? null) : null,
      subsequence_id: r.subsequenceId,
      subsequence_name: r.subsequenceId ? (subsequenceNames.get(r.subsequenceId) ?? null) : null,
      step: r.step === null ? null : r.step + 1,
      step_kind: r.stepKind,
      completed_at: iso(r.completedAt),
      timestamp_created: iso(r.createdAt),
      overdue: isOverdue(r),
    };
  });
}

export async function createTask(workspaceId: string, userId: string | null, t: { title: string; description?: string | null; type?: string; priority?: string; due_at?: string | null; lead_email?: string | null; assigned_to?: string | null; source?: string }) {
  const leadEmail = t.lead_email?.trim().toLowerCase() || null;
  const lead = leadEmail ? (await leadsByEmail(workspaceId, [leadEmail])).get(leadEmail) : undefined;
  const [row] = await db
    .insert(T)
    .values({
      workspaceId,
      title: t.title,
      description: t.description ?? null,
      type: t.type ?? "todo",
      priority: t.priority ?? "normal",
      dueAt: t.due_at ? new Date(t.due_at) : null,
      leadEmail,
      leadId: lead?.id ?? null,
      // Left out: the person making it. Unassigned (null) stays unassigned.
      assignedTo: t.assigned_to === undefined ? userId : t.assigned_to,
      createdBy: userId,
      source: t.source ?? "manual",
    })
    .returning();
  emit("crm_task_created", workspaceId, { task_id: row!.id, title: row!.title, lead_email: leadEmail, assigned_to: row!.assignedTo, due_at: iso(row!.dueAt) });
  return row!;
}

// ---------------------------------------------------------------------------------------------------------------
// Calls and texts (Twilio)

/** How a call can end (Twilio's statuses). */
export const FINAL_CALL_STATUSES = ["completed", "busy", "failed", "no-answer", "canceled"];
const FINAL_CALL = new Set(FINAL_CALL_STATUSES);
const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
export const e164 = (raw: string) => {
  const v = raw.trim().replace(/[\s().-]/g, "");
  if (!/^\+?[1-9]\d{6,14}$/.test(v)) throw badRequest(`"${raw}" isn't a phone number in international format, such as +14155550123`);
  return v.startsWith("+") ? v : `+${v}`;
};

/** Twilio status callbacks only make sense when Twilio can reach this server. */
const publicBase = () => (/^https:\/\//.test(config.appUrl) && !/localhost|127\.0\.0\.1/.test(config.appUrl) ? config.appUrl : null);

export function webhookUrls() {
  const b = publicBase() ?? config.appUrl;
  return { sms: `${b}/api/webhooks/twilio/sms`, voice: `${b}/api/webhooks/twilio/voice`, status: `${b}/api/webhooks/twilio/call-status`, reachable: !!publicBase() };
}

/** The number a user sends from: theirs if one is assigned, otherwise the workspace's first number. */
export async function senderNumber(workspaceId: string, userId: string | null, wanted?: string | null, capability: "voice" | "sms" = "voice") {
  const rows = await db.select().from(PN).where(eq(PN.workspaceId, workspaceId)).orderBy(asc(PN.createdAt));
  const able = rows.filter((r) => r.capabilities?.[capability] !== false);
  const pick = (wanted && able.find((r) => r.id === wanted || r.number === wanted)) || able.find((r) => r.assignedTo === userId) || able[0];
  if (!pick) throw badRequest(`Add a phone number that can ${capability === "sms" ? "send texts" : "make calls"} in CRM → Calls & SMS first.`);
  return pick;
}

/** Calls the user's own phone first, then connects them to the lead (no browser softphone needed). */
export async function placeCall(input: { workspaceId: string; userId: string; userPhone: string | null; to: string; fromNumberId?: string | null; leadEmail?: string | null }) {
  if (!twilioConfigured()) throw badRequest("Calling needs Twilio. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server, or log the call by hand.");
  if (!input.userPhone) throw badRequest("Add your own phone number in CRM → Calls & SMS. Twilio rings it first, then connects you to the lead.");
  const to = e164(input.to);
  const from = await senderNumber(input.workspaceId, input.userId, input.fromNumberId, "voice");
  const status = publicBase() ? `${publicBase()}/api/webhooks/twilio/call-status` : undefined;
  const call = await twilioRequest<{ sid: string; status: string }>("POST", "/Calls.json", {
    To: e164(input.userPhone),
    From: from.number,
    Twiml: `<Response><Say>Connecting your call.</Say><Dial callerId="${xml(from.number)}">${xml(to)}</Dial></Response>`,
    ...(status ? { StatusCallback: status, StatusCallbackEvent: "completed" } : {}),
  });
  const leadEmail = input.leadEmail?.trim().toLowerCase() || null;
  const lead = leadEmail ? (await leadsByEmail(input.workspaceId, [leadEmail])).get(leadEmail) : undefined;
  const [row] = await db
    .insert(CA)
    .values({ workspaceId: input.workspaceId, leadEmail, leadId: lead?.id ?? null, phoneNumber: to, fromNumber: from.number, direction: "outbound", status: call.status || "queued", twilioSid: call.sid, createdBy: input.userId, archivedAt: new Date() })
    .returning();
  return row!;
}

/** Refreshes calls still in progress from Twilio (calls placed in the last day). */
export async function refreshCalls(rows: Array<typeof CA.$inferSelect>) {
  if (!twilioConfigured()) return rows;
  const live = rows.filter((r) => r.twilioSid && !FINAL_CALL.has(r.status) && Date.now() - ms(r.createdAt) < 86_400_000).slice(0, 10);
  for (const r of live) {
    try {
      const c = await twilioRequest<{ status: string; duration: string | null }>("GET", `/Calls/${encodeURIComponent(r.twilioSid!)}.json`);
      const patch = { status: c.status, durationSec: Number(c.duration ?? 0) || 0 };
      // Only while the call hasn't ended here yet (Twilio's status callback may have recorded it meanwhile).
      const [changed] = await db
        .update(CA)
        .set(patch)
        .where(and(eq(CA.id, r.id), notInArray(CA.status, FINAL_CALL_STATUSES)))
        .returning({ id: CA.id });
      if (!changed) {
        // Ended meanwhile: show what was recorded then.
        const [stored] = await db.select().from(CA).where(eq(CA.id, r.id)).limit(1);
        if (stored) Object.assign(r, stored);
        continue;
      }
      Object.assign(r, patch);
      if (FINAL_CALL.has(c.status)) emit("call_completed", r.workspaceId, { call_id: r.id, status: c.status, lead_email: r.leadEmail, direction: r.direction, duration_sec: patch.durationSec });
    } catch {
      // keep the stored status; Twilio may be briefly unreachable
    }
  }
  return rows;
}

export async function sendSms(input: { workspaceId: string; userId: string | null; to: string; body: string; fromNumberId?: string | null; leadEmail?: string | null }) {
  if (!twilioConfigured()) throw badRequest("Texting needs Twilio. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server.");
  const to = e164(input.to);
  const from = await senderNumber(input.workspaceId, input.userId, input.fromNumberId, "sms");
  const msg = await twilioRequest<{ sid: string; status: string }>("POST", "/Messages.json", { To: to, From: from.number, Body: input.body });
  const leadEmail = input.leadEmail?.trim().toLowerCase() || (await leadForPhone(input.workspaceId, to))?.email || null;
  const lead = leadEmail ? (await leadsByEmail(input.workspaceId, [leadEmail])).get(leadEmail) : undefined;
  const [row] = await db
    .insert(SM)
    .values({ workspaceId: input.workspaceId, leadEmail, leadId: lead?.id ?? null, phoneNumber: to, fromNumber: from.number, direction: "outbound", body: input.body, status: msg.status || "queued", twilioSid: msg.sid, createdBy: input.userId, archivedAt: new Date() })
    .returning();
  return row!;
}

/** Finds the lead whose phone matches a number (digits compared, last 10 when longer). */
export async function leadForPhone(workspaceId: string, phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  const tail = digits.slice(-10);
  const [row] = await db
    .select({ id: L.id, email: L.email })
    .from(L)
    .where(and(eq(L.workspaceId, workspaceId), isNotNull(L.phone), sql`replace(replace(replace(replace(replace(${L.phone}, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') like ${`%${tail}`}`))
    .orderBy(desc(L.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Checks X-Twilio-Signature: HMAC-SHA1 of the URL plus the sorted POST parameters. */
export function validTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined) {
  if (!signature || !config.twilio.authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", config.twilio.authToken).update(data, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function workspaceForNumber(number: string) {
  const [row] = await db.select().from(PN).where(eq(PN.number, number)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Deals (opportunities)

export type OppRow = typeof OP.$inferSelect;

/** Keeps the deal row in step when a lead's status changes anywhere (Unibox, agents, API, CRM). */
on("lead_interest_changed", async (ev) => {
  const email = String(ev.data.lead_email ?? "").toLowerCase();
  if (!email) return;
  const value = ev.data.value as number | null;
  const [row] = await db.select().from(OP).where(and(eq(OP.workspaceId, ev.workspaceId), eq(OP.leadEmail, email))).limit(1);
  if (!row && interestSentiment(value) !== "positive") return;
  // Won only while it's Won: a deal taken back to a meeting, or lost, no longer counts as closed.
  const set = { stage: value ?? 0, wonAt: value === 4 ? (row?.wonAt ?? new Date()) : null };
  if (row) await db.update(OP).set(set).where(eq(OP.id, row.id));
  else {
    const [lead] = await db.select().from(L).where(eq(L.id, String(ev.data.lead_id ?? ""))).limit(1);
    await db
      .insert(OP)
      .values({ workspaceId: ev.workspaceId, leadEmail: email, leadId: lead?.id ?? null, name: lead?.companyName || email, companyName: lead?.companyName ?? null, companyDomain: lead?.companyDomain || null, value: await defaultDealValue(ev.workspaceId, lead ?? null), ownerId: lead?.assignedTo ?? null, ...set })
      .onConflictDoNothing();
  }
});

/** A deal is its lead's owner's: leads given to someone take their deals with them. */
export async function dealsFollowOwner(workspaceId: string, leadIds: string[], ownerId: string | null) {
  for (const part of chunk(leadIds, 500)) {
    await db
      .update(OP)
      .set({ ownerId })
      .where(
        and(
          eq(OP.workspaceId, workspaceId),
          inArray(
            OP.leadEmail,
            db
              .select({ email: sql<string>`lower(${L.email})` })
              .from(L)
              .where(and(eq(L.workspaceId, workspaceId), inArray(L.id, part), isNotNull(L.email))),
          ),
        ),
      );
  }
}

export async function defaultDealValue(workspaceId: string, lead: { campaignId: string | null; plValueLead: string | null } | null) {
  const own = Number(lead?.plValueLead);
  if (Number.isFinite(own) && own > 0) return own;
  if (lead?.campaignId) {
    const [c] = await db.select({ v: schema.campaigns.plValue }).from(schema.campaigns).where(eq(schema.campaigns.id, lead.campaignId)).limit(1);
    if (c?.v) return c.v;
  }
  const [ws] = await db.select({ v: schema.workspaces.defaultOpportunityValue }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  return ws?.v ?? 0;
}

/** True for a built-in lead status or one of the workspace's custom labels. */
export async function isKnownStatus(workspaceId: string, code: number) {
  if (DEFAULT_INTEREST_STATUSES.some((s) => s.code === code)) return true;
  const [label] = await db
    .select({ id: schema.leadLabels.id })
    .from(schema.leadLabels)
    .where(and(eq(schema.leadLabels.workspaceId, workspaceId), eq(schema.leadLabels.interestStatus, code)))
    .limit(1);
  return !!label;
}

/**
 * Leads that became opportunities before the CRM tracked deals (or through an import) get their deal row here,
 * so the pipeline, reports and teammate comparison all count the same deals the board shows.
 */
export async function ensureDeals(workspaceId: string) {
  const missing = await db
    .select()
    .from(L)
    .where(
      and(
        eq(L.workspaceId, workspaceId),
        isNotNull(L.email),
        sql`${L.interestStatus} > 0 and ${L.interestStatus} < ${CUSTOM_INTEREST_BASE.neutral}`,
        sql`lower(${L.email}) not in (select lead_email from crm_opportunities where workspace_id = ${workspaceId} and lead_email is not null)`,
      ),
    )
    .orderBy(desc(L.lastInterestChangeAt))
    .limit(2000);
  if (!missing.length) return 0;
  const camps = [...new Set(missing.map((l) => l.campaignId).filter((x): x is string => !!x))];
  const campValue = new Map(
    camps.length ? (await db.select({ id: schema.campaigns.id, v: schema.campaigns.plValue }).from(schema.campaigns).where(inArray(schema.campaigns.id, camps))).map((c) => [c.id, c.v]) : [],
  );
  const [ws] = await db.select({ v: schema.workspaces.defaultOpportunityValue }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const seen = new Set<string>();
  const rows: Array<typeof OP.$inferInsert> = [];
  for (const l of missing) {
    const email = l.email!.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const own = Number(l.plValueLead);
    rows.push({
      workspaceId,
      leadEmail: email,
      leadId: l.id,
      name: l.companyName || email,
      companyName: l.companyName,
      companyDomain: l.companyDomain || null,
      stage: l.interestStatus ?? 1,
      value: Number.isFinite(own) && own > 0 ? own : (campValue.get(l.campaignId ?? "") ?? ws?.v ?? 0),
      ownerId: l.assignedTo,
      wonAt: l.interestStatus === 4 ? (l.lastInterestChangeAt ?? new Date()) : null,
      createdAt: l.lastInterestChangeAt ?? undefined,
    });
  }
  for (let i = 0; i < rows.length; i += 200) await db.insert(OP).values(rows.slice(i, i + 200)).onConflictDoNothing();
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Sales flows: smart queues of leads matched by recent activity

export interface FlowQuery {
  actionType: "reply" | "email-open" | "last-contacted" | "link-click" | "lead-status" | "lead-status-change";
  values: { "occurrence-days"?: number; "occurrence-count"?: { condition: "more" | "less" | "equal"; count: number }; "lead-status"?: { status: number; condition: "is" | "is-not" } };
}

const cmp = (expr: SQL, c: { condition: "more" | "less" | "equal"; count: number }) => (c.condition === "more" ? sql`${expr} > ${c.count}` : c.condition === "less" ? sql`${expr} < ${c.count}` : sql`${expr} = ${c.count}`);

/** SQL conditions on `leads` for a sales flow's queries (all must match). */
export function flowConditions(workspaceId: string, queries: FlowQuery[]): SQL[] {
  const out: SQL[] = [];
  for (const q of queries) {
    const days = Math.max(1, Math.min(3650, Number(q.values["occurrence-days"] ?? 7)));
    const since = Date.now() - days * 86_400_000;
    const count = q.values["occurrence-count"];
    const events = (type: string) => sql`(select count(*) from email_events ev where ev.workspace_id = ${workspaceId} and ev.lead_id = ${L.id} and ev.type = ${type} and ev.created_at >= ${since})`;
    switch (q.actionType) {
      case "reply":
        out.push(count ? cmp(events("reply"), count) : sql`${L.lastReplyAt} >= ${since}`);
        break;
      case "email-open":
        out.push(count ? cmp(events("open"), count) : sql`${L.lastOpenAt} >= ${since}`);
        break;
      case "link-click":
        out.push(count ? cmp(events("click"), count) : sql`${L.lastClickAt} >= ${since}`);
        break;
      case "last-contacted":
        // Contacted, but not within the last N days: due for a follow-up.
        out.push(sql`${L.lastContactAt} is not null and ${L.lastContactAt} < ${since}`);
        break;
      case "lead-status": {
        const s = q.values["lead-status"];
        if (s) out.push(s.condition === "is" ? eq(L.interestStatus, s.status) : sql`(${L.interestStatus} is null or ${L.interestStatus} <> ${s.status})`);
        break;
      }
      case "lead-status-change":
        out.push(sql`${L.lastInterestChangeAt} >= ${since}`);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reports

export const REPORT_METRICS = [
  "opportunities_created",
  "opportunities_won",
  "pipeline_value",
  "cash_collected",
  "closing_rate",
  "meeting_booking_rate",
  "average_deal_size",
  "sales_cycle_days",
  "annualized_value_closed",
  "monthly_value_closed",
  "annual_value_closed",
  "one_time_value_closed",
  "meetings_booked",
  "meetings_completed",
  "sent_emails",
  "received_emails",
  "emails_open",
  "email_open_rate",
  "email_reply_rate",
  "outbound_calls",
  "inbound_calls",
  "sent_sms",
  "received_sms",
] as const;
export type ReportMetric = (typeof REPORT_METRICS)[number];

export async function reportMetrics(workspaceId: string, start: Date, end: Date, ownerId?: string): Promise<Record<ReportMetric, number | null> & { cash_source: "stripe" | null }> {
  const inRange = (col: SQL | AnyColumn) => sql`${col} >= ${start.getTime()} and ${col} <= ${end.getTime()}`;
  const ownerLeads = ownerId ? sql`and lower(lead_email) in (select lower(email) from leads where workspace_id = ${workspaceId} and assigned_to = ${ownerId})` : sql``;
  /** With a teammate picked: only what's about the leads they own. */
  const ownedLead = (col: AnyColumn) => (ownerId ? sql`lower(${col}) in (select lower(email) from leads where workspace_id = ${workspaceId} and assigned_to = ${ownerId})` : undefined);
  const one = async (q: Promise<Array<{ n: number | null }>>) => Number((await q)[0]?.n ?? 0);
  const evCount = (type: string, extra: SQL = sql``) =>
    one(db.all(sql`select count(distinct coalesce(lower(lead_email), lead_id)) as n from email_events where workspace_id = ${workspaceId} and type = ${type} and created_at >= ${start.getTime()} and created_at <= ${end.getTime()} ${extra} ${ownerLeads}`) as Promise<Array<{ n: number }>>);
  const [opps, booked, completed, wonEvents, sent, received, opens, uniqueReplies, callsOut, callsIn, smsOut, smsIn, meetingsAdded, meetingsDone] = await Promise.all([
    evCount("opportunity"),
    evCount("interest_change", sql`and value = 2`),
    evCount("interest_change", sql`and value = 3`),
    evCount("interest_change", sql`and value = 4`),
    one(db.select({ n: sql<number>`count(*)` }).from(E).where(and(eq(E.workspaceId, workspaceId), inArray(E.ueType, [1, 3]), isNull(E.deletedAt), inRange(E.timestampEmail), ownedLead(E.leadEmail)))),
    one(db.select({ n: sql<number>`count(*)` }).from(E).where(and(eq(E.workspaceId, workspaceId), eq(E.ueType, 2), eq(E.isAutoReply, 0), eq(E.isBounce, false), isNull(E.deletedAt), inRange(E.timestampEmail), ownedLead(E.leadEmail)))),
    one(db.select({ n: sql<number>`count(distinct ${EV.emailId})` }).from(EV).where(and(eq(EV.workspaceId, workspaceId), eq(EV.type, "open"), inRange(EV.createdAt), ownedLead(EV.leadEmail)))),
    one(db.select({ n: sql<number>`count(distinct lower(${E.leadEmail}))` }).from(E).where(and(eq(E.workspaceId, workspaceId), eq(E.ueType, 2), eq(E.isAutoReply, 0), eq(E.isBounce, false), isNull(E.deletedAt), inRange(E.timestampEmail), ownedLead(E.leadEmail)))),
    one(db.select({ n: sql<number>`count(*)` }).from(CA).where(and(eq(CA.workspaceId, workspaceId), eq(CA.direction, "outbound"), inRange(CA.createdAt), ownerId ? eq(CA.createdBy, ownerId) : undefined))),
    one(db.select({ n: sql<number>`count(*)` }).from(CA).where(and(eq(CA.workspaceId, workspaceId), eq(CA.direction, "inbound"), inRange(CA.createdAt), ownedLead(CA.leadEmail)))),
    one(db.select({ n: sql<number>`count(*)` }).from(SM).where(and(eq(SM.workspaceId, workspaceId), eq(SM.direction, "outbound"), inRange(SM.createdAt), ownerId ? eq(SM.createdBy, ownerId) : undefined))),
    one(db.select({ n: sql<number>`count(*)` }).from(SM).where(and(eq(SM.workspaceId, workspaceId), eq(SM.direction, "inbound"), inRange(SM.createdAt), ownedLead(SM.leadEmail)))),
    one(db.select({ n: sql<number>`count(*)` }).from(MT).where(and(eq(MT.workspaceId, workspaceId), inRange(MT.createdAt), ownerId ? eq(MT.createdBy, ownerId) : undefined))),
    one(db.select({ n: sql<number>`count(*)` }).from(MT).where(and(eq(MT.workspaceId, workspaceId), eq(MT.status, "completed"), inRange(MT.startAt), ownerId ? eq(MT.createdBy, ownerId) : undefined))),
  ]);

  // Deals won in the period, with their value, recurrence and age.
  const wonRows = await db
    .select({ value: OP.value, recurrence: OP.recurrence, wonAt: OP.wonAt, createdAt: OP.createdAt, email: OP.leadEmail })
    .from(OP)
    .where(and(eq(OP.workspaceId, workspaceId), isNotNull(OP.wonAt), inRange(OP.wonAt), ownerId ? eq(OP.ownerId, ownerId) : undefined));
  // When each won deal first became an opportunity, a few hundred addresses at a time (any number of deals).
  const firstOpp = new Map<string, number>();
  for (const part of chunk([...new Set(wonRows.map((w) => (w.email ?? "").toLowerCase()).filter(Boolean))], 500)) {
    const rows = (await db.all(
      sql`select lower(lead_email) as email, min(created_at) as at from email_events where workspace_id = ${workspaceId} and type = 'opportunity' and lower(lead_email) in (${sql.join(
        part.map((e) => sql`${e}`),
        sql`, `,
      )}) group by lower(lead_email)`,
    )) as Array<{ email: string; at: number }>;
    for (const r of rows) firstOpp.set(r.email, Number(r.at));
  }
  const sum = (rec?: string) => wonRows.filter((w) => !rec || w.recurrence === rec).reduce((s, w) => s + (w.value ?? 0), 0);
  const oneTime = sum("one_time");
  const monthly = sum("monthly");
  const annual = sum("annual");
  const won = Math.max(wonEvents, wonRows.length);
  const cycles = wonRows.map((w) => (ms(w.wonAt) - (firstOpp.get((w.email ?? "").toLowerCase()) ?? ms(w.createdAt))) / 86_400_000).filter((d) => d >= 0);

  // Pipeline: open deals right now (positive, not won).
  const [pipeline] = (await db.all(
    // Deals whose leads were deleted aren't in the pipeline (the board doesn't show them either).
    sql`select coalesce(sum(coalesce(o.value, 0)), 0) as v from crm_opportunities o where o.workspace_id = ${workspaceId} and o.archived_at is null and o.stage > 0 and o.stage <> 4 and o.stage < 50000 and exists (select 1 from leads l where l.workspace_id = o.workspace_id and l.email = o.lead_email) ${ownerId ? sql`and o.owner_id = ${ownerId}` : sql``}`,
  )) as Array<{ v: number }>;

  const cash = await stripeCash(workspaceId, start, end).catch(() => null);
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    opportunities_created: opps,
    opportunities_won: won,
    pipeline_value: Number(pipeline?.v ?? 0),
    cash_collected: cash,
    cash_source: cash === null ? null : "stripe",
    closing_rate: rate(won, opps),
    meeting_booking_rate: rate(Math.max(booked, meetingsAdded), opps),
    average_deal_size: wonRows.length ? Math.round(sum() / wonRows.length) : null,
    sales_cycle_days: cycles.length ? Math.round((cycles.reduce((s, d) => s + d, 0) / cycles.length) * 10) / 10 : null,
    annualized_value_closed: oneTime + monthly * 12 + annual,
    monthly_value_closed: monthly,
    annual_value_closed: annual,
    one_time_value_closed: oneTime,
    meetings_booked: Math.max(booked, meetingsAdded),
    meetings_completed: Math.max(completed, meetingsDone),
    sent_emails: sent,
    received_emails: received,
    emails_open: opens,
    email_open_rate: rate(opens, sent),
    email_reply_rate: rate(uniqueReplies, sent),
    outbound_calls: callsOut,
    inbound_calls: callsIn,
    sent_sms: smsOut,
    received_sms: smsIn,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Stripe: cash collected from customers who are leads in this workspace

export interface StripeLink {
  mode: "key" | "oauth";
  secret: string; // encrypted restricted key, or the connected account id for OAuth
  account_name: string | null;
  connected_at: string;
}

const cashCache = new Map<string, { at: number; value: number }>();
const CASH_TTL_MS = 600_000;
/** Charges read per period at most (100 a page): beyond that the sum covers the newest ones. */
const CASH_PAGES = 50;

async function stripeGet(link: StripeLink, path: string, params: Record<string, string>) {
  const { decrypt } = await import("../lib/crypto");
  const key = link.mode === "key" ? decrypt(link.secret) : config.stripe.secretKey;
  if (!key) throw new Error("Stripe isn't available");
  const res = await fetch(`https://api.stripe.com/v1${path}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${key}`, ...(link.mode === "oauth" ? { "stripe-account": link.secret } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json()) as { data?: unknown[]; has_more?: boolean; error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message ?? `Stripe HTTP ${res.status}`);
  return data;
}

export async function stripeLink(workspaceId: string): Promise<StripeLink | null> {
  const { getWorkspaceSetting } = await import("./workspaces");
  return getWorkspaceSetting<StripeLink | null>(workspaceId, "crm_stripe", null);
}

/** Sum of paid charges in the period whose customer email belongs to a lead here (cached for 10 minutes). */
export async function stripeCash(workspaceId: string, start: Date, end: Date): Promise<number | null> {
  const link = await stripeLink(workspaceId);
  if (!link) return null;
  // An open-ended period ends "now", which changes every call: its end is rounded to the cache's lifetime so it's reused.
  const cacheKey = `${workspaceId}:${start.getTime()}:${Math.floor(end.getTime() / CASH_TTL_MS)}`;
  const hit = cashCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CASH_TTL_MS) return hit.value;
  for (const [k, v] of cashCache) if (Date.now() - v.at >= CASH_TTL_MS) cashCache.delete(k);
  type Charge = { id: string; amount: number; amount_refunded: number; paid: boolean; status: string; currency: string; billing_details?: { email?: string | null }; receipt_email?: string | null };
  const charges: Charge[] = [];
  let after: string | undefined;
  for (let page = 0; page < CASH_PAGES; page++) {
    const r = (await stripeGet(link, "/charges", {
      limit: "100",
      "created[gte]": String(Math.floor(start.getTime() / 1000)),
      "created[lte]": String(Math.floor(end.getTime() / 1000)),
      ...(after ? { starting_after: after } : {}),
    })) as { data: Charge[]; has_more: boolean };
    charges.push(...r.data);
    if (!r.has_more || !r.data.length) break;
    after = r.data[r.data.length - 1]!.id;
  }
  const paid = charges.filter((c) => c.paid && c.status === "succeeded");
  const emails = paid.map((c) => (c.billing_details?.email ?? c.receipt_email ?? "").toLowerCase()).filter(Boolean);
  const known = await leadsByEmail(workspaceId, emails);
  const value = paid.filter((c) => known.has((c.billing_details?.email ?? c.receipt_email ?? "").toLowerCase())).reduce((s, c) => s + (c.amount - c.amount_refunded) / 100, 0);
  cashCache.set(cacheKey, { at: Date.now(), value: Math.round(value * 100) / 100 });
  return Math.round(value * 100) / 100;
}

export async function verifyStripeKey(key: string) {
  const res = await fetch("https://api.stripe.com/v1/charges?limit=1", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw badRequest(`Stripe rejected the key: ${data.error?.message ?? `HTTP ${res.status}`}. Use a restricted key with read access to charges.`);
  const acct = await fetch("https://api.stripe.com/v1/account", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  const a = (await acct.json().catch(() => ({}))) as { settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string } };
  return acct.ok ? (a.settings?.dashboard?.display_name ?? a.business_profile?.name ?? null) : null;
}

export const clearCashCache = (workspaceId: string) => {
  for (const k of cashCache.keys()) if (k.startsWith(`${workspaceId}:`)) cashCache.delete(k);
};


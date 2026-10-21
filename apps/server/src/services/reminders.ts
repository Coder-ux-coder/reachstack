// Reminders that come due: Unibox follow-up reminders (emails.reminder_ts, set from a conversation or when replying)
// and CRM tasks (crm_tasks.due_at). A due Unibox reminder brings its conversation back to the inbox, unread, and
// notifies; the reminder stays on the conversation (the Reminders folder shows it as due) until someone removes it or
// the lead writes back. A due task notifies the person it's assigned to; the CRM inbox already lists tasks due today.
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lte, ne, or, type AnyColumn } from "drizzle-orm";
import { EmailType } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { inUse } from "./live-workspaces";
import { on } from "./bus";
import { moduleEnabled } from "./installation";
import { notifiedSince, notify, pruneNotifications } from "./notifications";

const M = schema.emails;
const T = schema.crmTasks;

/** Reminders that came due while the server was off still fire, up to this late. */
const CATCH_UP_MS = 3 * 86_400_000;
/** Reminders and tasks already handled in this process (`id:due time`), so each pass checks only new ones. */
const fired = new Set<string>();
/** Where the next pass starts looking, per kind: a due time, and the last row read at it (many can share one). */
type Cursor = { at: number; id: string };
const next: { reminders: Cursor; tasks: Cursor } = { reminders: { at: 0, id: "" }, tasks: { at: 0, id: "" } };
const OVERLAP_MS = 5 * 60_000;
const BATCH = 500;
let lastPrune = 0;

/**
 * Where to look from next time: after a full batch, just past its last row (the next ones may share its due time, so
 * the due time alone would read the same batch again forever); otherwise from a little before now, for late writes.
 */
const advance = (rows: Array<{ id: string; due: Date | null }>, now: number): Cursor => {
  const last = rows[rows.length - 1];
  return rows.length === BATCH && last?.due ? { at: last.due.getTime(), id: last.id } : { at: now - OVERLAP_MS, id: "" };
};

/** Rows due from the cursor on, and no earlier than `floor` (read in due time, then id, order). */
const dueFrom = (due: AnyColumn, id: AnyColumn, c: Cursor, floor: number) =>
  c.id && c.at >= floor ? or(gt(due, new Date(c.at)), and(eq(due, new Date(c.at)), gt(id, c.id)))! : gte(due, new Date(Math.max(floor, c.at)));

/** Engine loop. */
export async function runReminders(now = Date.now()) {
  if (fired.size > 20_000) fired.clear();
  await dueUniboxReminders(now);
  if (await moduleEnabled("crm")) await dueTasks(now);
  if (now - lastPrune > 3_600_000) {
    lastPrune = now;
    await pruneNotifications(now);
  }
}

/** The conversation comes back to the inbox with its newest reply unread, as if the lead had just written. */
export async function resurfaceThread(workspaceId: string, threadId: string) {
  const received = and(eq(M.workspaceId, workspaceId), eq(M.threadId, threadId), eq(M.ueType, EmailType.RECEIVED), isNull(M.deletedAt));
  await db
    .update(M)
    .set({ archived: false })
    .where(and(received, eq(M.archived, true)));
  const [latest] = await db.select({ id: M.id }).from(M).where(received).orderBy(desc(M.timestampEmail)).limit(1);
  if (latest) await db.update(M).set({ isUnread: 1 }).where(eq(M.id, latest.id));
}

async function leadFor(workspaceId: string, leadId: string | null, email: string | null) {
  const L = schema.leads;
  const where = leadId ? eq(L.id, leadId) : email ? and(eq(L.workspaceId, workspaceId), eq(L.email, email.toLowerCase())) : null;
  if (!where) return null;
  const [lead] = await db.select({ firstName: L.firstName, lastName: L.lastName, email: L.email, assignedTo: L.assignedTo }).from(L).where(where).limit(1);
  return lead ?? null;
}

const who = (lead: { firstName: string | null; lastName: string | null; email: string | null } | null, fallback: string | null) =>
  [lead?.firstName, lead?.lastName].filter(Boolean).join(" ").trim() || lead?.email || fallback || null;

async function dueUniboxReminders(now: number) {
  const rows = await db
    .select({ id: M.id, workspaceId: M.workspaceId, threadId: M.threadId, due: M.reminderAt, subject: M.subject, leadId: M.leadId, leadEmail: M.leadEmail })
    .from(M)
    .where(
      and(isNotNull(M.reminderAt), dueFrom(M.reminderAt, M.id, next.reminders, now - CATCH_UP_MS), lte(M.reminderAt, new Date(now)), isNull(M.deletedAt), ne(M.ueType, EmailType.SCHEDULED), await inUse(M.workspaceId)),
    )
    .orderBy(asc(M.reminderAt), asc(M.id))
    .limit(BATCH);
  for (const r of rows) {
    const at = r.due!.getTime();
    const key = `${r.id}:${at}`;
    if (fired.has(key)) continue;
    const thread = r.threadId ?? r.id;
    const link = `/app/unibox?folder=reminders&thread=${encodeURIComponent(thread)}`;
    // Once per conversation and due time, across restarts too (two reminders due together make one notification).
    if (!(await notifiedSince(r.workspaceId, "reminder_due", link, at))) {
      if (r.threadId) await resurfaceThread(r.workspaceId, r.threadId);
      const lead = await leadFor(r.workspaceId, r.leadId, r.leadEmail);
      const name = who(lead, r.leadEmail);
      await notify({
        workspaceId: r.workspaceId,
        type: "reminder_due",
        title: name ? `Follow up with ${name}` : "A follow-up reminder is due",
        body: `Your reminder on “${r.subject.trim() || "(no subject)"}” is due.`,
        link,
        perm: "unibox",
        staffOnly: true,
        userIds: [lead?.assignedTo],
      });
    }
    fired.add(key);
  }
  next.reminders = advance(rows, now);
}

async function dueTasks(now: number) {
  const rows = await db
    .select()
    .from(T)
    // A sequence's tasks show on Today with a count instead of a notification each.
    .where(
      and(
        eq(T.status, "open"),
        isNull(T.archivedAt),
        isNotNull(T.dueAt),
        dueFrom(T.dueAt, T.id, next.tasks, now - CATCH_UP_MS),
        lte(T.dueAt, new Date(now)),
        or(isNull(T.source), ne(T.source, "sequence")),
        await inUse(T.workspaceId),
      ),
    )
    .orderBy(asc(T.dueAt), asc(T.id))
    .limit(BATCH);
  for (const t of rows) {
    const at = t.dueAt!.getTime();
    const key = `task:${t.id}:${at}`;
    if (fired.has(key)) continue;
    const link = `/app/crm/tasks?item=${encodeURIComponent(`task:${t.id}`)}`;
    // A task moved to a later time notifies again at that time.
    if (!(await notifiedSince(t.workspaceId, "task_due", link, at))) {
      const lead = t.leadEmail ? await leadFor(t.workspaceId, t.leadId, t.leadEmail) : null;
      const name = who(lead, t.leadEmail);
      await notify({
        workspaceId: t.workspaceId,
        type: "task_due",
        title: `Task due: ${t.title}`,
        body: name ? `For ${name}.` : (t.description?.trim() || null),
        link,
        perm: "crm",
        staffOnly: true,
        userIds: [t.assignedTo ?? t.createdBy],
      });
    }
    fired.add(key);
  }
  next.tasks = advance(
    rows.map((t) => ({ id: t.id, due: t.dueAt })),
    now,
  );
}

// A lead who writes back needs no follow-up reminder: clear the ones on their conversations (the reply itself puts the
// conversation back in the inbox). Out-of-office replies don't count.
on("reply_received", async (ev) => {
  const threadId = typeof ev.data.thread_id === "string" ? ev.data.thread_id : null;
  const email = typeof ev.data.lead_email === "string" ? ev.data.lead_email.toLowerCase() : null;
  const scope = [threadId ? eq(M.threadId, threadId) : undefined, email ? eq(M.leadEmail, email) : undefined].filter((c) => !!c);
  if (!scope.length) return;
  await db
    .update(M)
    .set({ reminderAt: null })
    .where(and(eq(M.workspaceId, ev.workspaceId), isNotNull(M.reminderAt), or(...scope)));
});

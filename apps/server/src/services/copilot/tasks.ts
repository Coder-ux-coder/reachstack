// Recurring copilot tasks: a saved prompt the copilot answers on a schedule. Each run opens a new chat,
// then the result goes to the in-app notifications and, when set, to Slack.
import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema } from "../../db/client";
import { inUse } from "../live-workspaces";
import { config } from "../../env";
import { iso } from "../../lib/time";
import { aiAvailable } from "../ai";
import { postToSlack } from "../integrations";
import { invokerFor, withInternalSession } from "./invoke";
import { buildSystem, sendUserMessage } from "./runner";
import { getCopilotSettings } from "./settings";

const TK = schema.copilotTasks;
const T = schema.copilotThreads;
const MSG = schema.copilotMessages;

export type Frequency = "daily" | "weekly" | "monthly";
export type TaskRow = typeof TK.$inferSelect;

const step = { daily: { days: 1 }, weekly: { weeks: 1 }, monthly: { months: 1 } } as const;

function zone(tz: string | null | undefined) {
  return tz && DateTime.now().setZone(tz).isValid ? tz : "UTC";
}

function atTime(dt: DateTime, timeOfDay: string) {
  const [h, m] = timeOfDay.split(":").map(Number) as [number, number];
  return dt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

/**
 * When a task runs first. `ranNow` means the chat that created it already answered the prompt, so the
 * first scheduled run is one interval later; otherwise it is the next time the clock reaches time_of_day.
 */
export function firstRun(frequency: Frequency, timeOfDay: string, timezone: string, ranNow = false): Date {
  const now = DateTime.now().setZone(zone(timezone));
  const today = atTime(now, timeOfDay);
  if (ranNow) return today.plus(step[frequency]).toJSDate();
  return (today > now ? today : today.plus({ days: 1 })).toJSDate();
}

/**
 * A task's first run, and the day of the month a monthly one keeps: the day it was set up on when that day's answer
 * came with it, otherwise its first run's.
 */
export function firstSchedule(frequency: Frequency, timeOfDay: string, timezone: string, ranNow = false): { nextRunAt: Date; dayOfMonth: number | null } {
  const nextRunAt = firstRun(frequency, timeOfDay, timezone, ranNow);
  if (frequency !== "monthly") return { nextRunAt, dayOfMonth: null };
  return { nextRunAt, dayOfMonth: (ranNow ? DateTime.now() : DateTime.fromJSDate(nextRunAt)).setZone(zone(timezone)).day };
}

/**
 * The run after `prev`, skipping any that were missed while the server was down. A monthly task keeps its day of the
 * month: one on the 31st runs on the last day of shorter months and on the 31st again after.
 */
export function nextRun(prev: Date, frequency: Frequency, timeOfDay: string, timezone: string, dayOfMonth?: number | null): Date {
  const now = DateTime.now();
  const after = (t: DateTime) => {
    const next = atTime(t.plus(step[frequency]), timeOfDay);
    return frequency === "monthly" && dayOfMonth ? next.set({ day: Math.min(dayOfMonth, next.daysInMonth ?? 28) }) : next;
  };
  let next = after(DateTime.fromJSDate(prev).setZone(zone(timezone)));
  for (let i = 0; next <= now && i < 400; i++) next = after(next);
  return next.toJSDate();
}

export function serializeTask(t: TaskRow) {
  return {
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    frequency: t.frequency,
    time_of_day: t.timeOfDay,
    timezone: t.timezone,
    status: t.status,
    next_run_at: t.status === "active" ? iso(t.nextRunAt) : null,
    last_run_at: iso(t.lastRunAt),
    last_status: t.lastStatus,
    last_error: t.lastError,
    last_thread_id: t.lastThreadId,
    last_result: t.lastResult,
    run_count: t.runCount,
    running: !!t.lockedUntil && t.lockedUntil.getTime() > Date.now(),
    source_thread_id: t.sourceThreadId,
    created_at: iso(t.createdAt),
  };
}

/** Runs one task now: new chat, the copilot's answer, notifications. */
export async function runTask(task: TaskRow): Promise<TaskRow> {
  const [member] = await db
    .select({ ws: schema.workspaces, user: schema.users })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(and(eq(schema.workspaceMembers.workspaceId, task.workspaceId), eq(schema.workspaceMembers.userId, task.userId), eq(schema.workspaceMembers.accepted, true)))
    .limit(1);
  const finish = async (set: Partial<typeof TK.$inferInsert>) => {
    // A run started by hand ("Run now") keeps the schedule; a scheduled run moves it on.
    const upcoming = task.nextRunAt && task.nextRunAt.getTime() > Date.now() ? task.nextRunAt : null;
    const next = upcoming ?? nextRun(task.nextRunAt ?? new Date(), task.frequency as Frequency, task.timeOfDay ?? "09:00", task.timezone ?? "UTC", task.dayOfMonth);
    const [row] = await db
      .update(TK)
      .set({ lastRunAt: new Date(), runCount: task.runCount + 1, lockedUntil: null, nextRunAt: next, ...set })
      .where(eq(TK.id, task.id))
      .returning();
    return row!;
  };
  if (!member || member.ws.deletedAt || member.user.deletedAt) return finish({ lastStatus: "failed", lastError: "The task's owner is no longer in this workspace.", status: "paused" });
  // Turned off: the task waits, and carries on when the account is turned back on.
  if (member.user.disabledAt) return finish({ lastStatus: "failed", lastError: "The task's owner is turned off." });
  if (!(await aiAvailable(task.workspaceId))) return finish({ lastStatus: "failed", lastError: "AI isn't set up for this workspace: add an Anthropic API key in Settings → Integrations & API → AI, or the owner can set up an AI in Settings → Installation → Services." });

  const when = DateTime.now().setZone(zone(task.timezone)).toFormat("LLL d");
  const system = await buildSystem({ wsId: task.workspaceId, workspaceName: member.ws.name, userName: [member.user.firstName, member.user.lastName].filter(Boolean).join(" ") });
  const [thread] = await db
    .insert(T)
    .values({ workspaceId: task.workspaceId, userId: task.userId, title: `${task.title} · ${when}`.slice(0, 120), system, taskId: task.id })
    .returning();
  const settings = await getCopilotSettings(task.userId, task.workspaceId);
  let error: string | null = null;
  const status = await withInternalSession(task.userId, task.workspaceId, (token) =>
    sendUserMessage(
      {
        thread: thread!,
        wsId: task.workspaceId,
        userId: task.userId,
        timezone: zone(task.timezone ?? member.user.timezone),
        settings,
        invoke: invokerFor(token, task.workspaceId),
        emit: (event, data) => {
          if (event === "error") error = (data as { message: string }).message;
        },
      },
      task.prompt,
    ),
  );
  const [answer] = await db
    .select({ content: MSG.content })
    .from(MSG)
    .where(and(eq(MSG.threadId, thread!.id), eq(MSG.role, "assistant")))
    .orderBy(desc(MSG.createdAt))
    .limit(1);
  const text = ((answer?.content ?? []) as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  const outcome = error ? "failed" : status === "waiting" ? "waiting" : "success";
  const link = `/app/copilot/${thread!.id}`;
  await db.insert(schema.notifications).values({
    workspaceId: task.workspaceId,
    userId: task.userId,
    type: "copilot_task",
    title: outcome === "failed" ? `Task "${task.title}" failed` : outcome === "waiting" ? `Task "${task.title}" needs your approval` : `Task "${task.title}" finished`,
    body: (error ?? text).slice(0, 300) || null,
    link,
  });
  if (settings.slack_integration_id && outcome !== "failed") {
    const summary = text.length > 2_500 ? `${text.slice(0, 2_500)}…` : text;
    await postToSlack(task.workspaceId, settings.slack_integration_id, `*${task.title}* (${config.brandName} AI)\n${summary}\n<${config.appUrl}${link}|Open the chat>`).catch(() => false);
  }
  return finish({ lastStatus: outcome, lastError: error, lastThreadId: thread!.id, lastResult: text.slice(0, 4_000) || null });
}

/** Engine loop: runs tasks that are due (one worker per task thanks to the lock). */
export async function runDueTasks() {
  const now = new Date();
  const due = await db
    .select()
    .from(TK)
    .where(
      and(
        eq(TK.status, "active"),
        lte(TK.nextRunAt, now),
        or(isNull(TK.lockedUntil), lte(TK.lockedUntil, now)),
        await inUse(TK.workspaceId),
        // A turned-off member's tasks wait until the account is back on.
        sql`${TK.userId} not in (select id from users where disabled_at is not null)`,
      ),
    )
    .orderBy(asc(TK.nextRunAt))
    .limit(5);
  for (const t of due) {
    const [locked] = await db
      .update(TK)
      .set({ lockedUntil: new Date(Date.now() + 15 * 60_000) })
      .where(and(eq(TK.id, t.id), or(isNull(TK.lockedUntil), lte(TK.lockedUntil, now))))
      .returning();
    if (!locked) continue;
    try {
      await runTask(locked);
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 500) ?? "Task failed";
      const freq = locked.frequency as Frequency;
      await db
        .update(TK)
        .set({ lockedUntil: null, lastRunAt: new Date(), lastStatus: "failed", lastError: msg, nextRunAt: nextRun(locked.nextRunAt ?? new Date(), freq, locked.timeOfDay ?? "09:00", locked.timezone ?? "UTC", locked.dayOfMonth) })
        .where(eq(TK.id, locked.id));
    }
  }
}

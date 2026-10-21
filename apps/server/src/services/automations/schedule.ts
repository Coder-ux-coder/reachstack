// "Run on a schedule" triggers: when an automation's next run is due, and the loop that starts due runs.
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema } from "../../db/client";
import { inUse } from "../live-workspaces";
import { isValidZone } from "../../lib/time";
import { createRun, type WorkflowRow } from "./runs";
import { scheduleOutput, triggerNode } from "./triggers";

const W = schema.workflows;

/** Schedules repeat at most this often. */
export const MIN_SCHEDULE_MINUTES = 15;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A weekday as 0 (Sunday) … 6 (Saturday), from its number or its name ("Monday", "mon"); Monday when it's neither. */
export function weekdayOf(value: unknown): number {
  const text = String(value ?? "").trim().toLowerCase();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n === 7 ? 0 : n <= 6 ? n : 1;
  }
  const i = text.length >= 2 ? WEEKDAYS.findIndex((d) => d.startsWith(text.slice(0, 3))) : -1;
  return i >= 0 ? i : 1;
}

/** "HH:MM" as hours and minutes; 9:00 when it isn't a time of day. */
export function timeOfDay(value: unknown): { hour: number; minute: number } {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(String(value ?? ""));
  const hour = m ? Number(m[1]) : NaN;
  const minute = m?.[2] ? Number(m[2]) : 0;
  return hour <= 23 && minute <= 59 ? { hour, minute } : { hour: 9, minute: 0 };
}

/** The first run time after `after` for a schedule trigger's settings. */
export function nextScheduledRun(config: Record<string, unknown>, after: Date = new Date()): Date {
  const frequency = String(config.frequency ?? "daily");
  const every = Math.max(1, Math.floor(Number(config.every ?? 1)) || 1);
  if (frequency === "minutes" || frequency === "hours") {
    const minutes = Math.max(MIN_SCHEDULE_MINUTES, frequency === "minutes" ? every : every * 60);
    return new Date(after.getTime() + minutes * 60_000);
  }
  const zone = isValidZone(String(config.timezone ?? "")) ? String(config.timezone) : "UTC";
  const now = DateTime.fromJSDate(after).setZone(zone);
  let next = now.set({ ...timeOfDay(config.time ?? "09:00"), second: 0, millisecond: 0 });
  if (frequency === "weekly") {
    const weekday = weekdayOf(config.weekday ?? 1); // 0 = Sunday … 6 = Saturday; luxon counts Monday = 1 … Sunday = 7
    next = next.plus({ days: ((weekday === 0 ? 7 : weekday) - next.weekday + 7) % 7 });
    if (next <= now) next = next.plus({ weeks: 1 });
  } else if (next <= now) next = next.plus({ days: 1 });
  return next.toJSDate();
}

/** When an automation's next scheduled run is (null unless it's on and starts on a schedule). */
export function scheduleFor(wf: Pick<WorkflowRow, "status" | "graph">, after: Date = new Date()): Date | null {
  const node = triggerNode(wf.graph);
  if (wf.status !== "active" || node?.data.key !== "schedule") return null;
  return nextScheduledRun(node.data.config ?? {}, after);
}

/** Starts the runs that are due. A missed slot (the server was down) runs once, then the schedule continues from now. */
export async function runDueSchedules() {
  const now = new Date();
  const due = await db
    .select()
    .from(W)
    .where(and(eq(W.status, "active"), eq(W.triggerType, "schedule"), isNotNull(W.nextRunAt), lte(W.nextRunAt, now), await inUse(W.workspaceId)))
    .limit(50);
  for (const wf of due) {
    const slot = wf.nextRunAt!;
    // Moving next_run_at claims the slot; a second engine that read the same row updates nothing.
    const [claimed] = await db
      .update(W)
      .set({ nextRunAt: scheduleFor(wf, now), updatedAt: sql`${W.updatedAt}` })
      .where(and(eq(W.id, wf.id), eq(W.nextRunAt, slot)))
      .returning();
    if (claimed) await createRun(claimed, scheduleOutput(slot, claimed.runCount + 1));
  }
}

// The workspace clock. Daily limits (mailboxes and campaigns) reset at midnight, warmup keeps its daytime hours and
// weekdays, and ramps count days in the workspace's timezone (Settings → Preferences → Workspace timezone), so "today"
// means the same thing everywhere. Campaign schedules still open and close in their own timezones.
import { inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema } from "../db/client";
import { badRequest } from "../http/errors";
import { isValidZone } from "../lib/time";
import { DEFAULT_WORKSPACE_SETTINGS } from "./workspaces";

/** For workspaces without a valid timezone saved: the same default Preferences shows. */
export const FALLBACK_ZONE = DEFAULT_WORKSPACE_SETTINGS.default_timezone;

const DAY_MS = 86_400_000;
/** A changed timezone applies within this long (each process caches it briefly). */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; zone: string }>();

function zoneFrom(settings: unknown): string {
  const zone = (settings as { default_timezone?: unknown } | null)?.default_timezone;
  return typeof zone === "string" && isValidZone(zone) ? zone : FALLBACK_ZONE;
}

/** Timezones of several workspaces, by workspace id. */
export async function workspaceZones(workspaceIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missing: string[] = [];
  const now = Date.now();
  for (const id of new Set(workspaceIds)) {
    const hit = cache.get(id);
    if (hit && now - hit.at < CACHE_MS) out.set(id, hit.zone);
    else missing.push(id);
  }
  if (missing.length) {
    const rows = await db.select({ id: schema.workspaces.id, settings: schema.workspaces.settings }).from(schema.workspaces).where(inArray(schema.workspaces.id, missing));
    const byId = new Map(rows.map((r) => [r.id, r.settings]));
    for (const id of missing) {
      const zone = zoneFrom(byId.get(id));
      cache.set(id, { at: now, zone });
      out.set(id, zone);
    }
  }
  return out;
}

export async function workspaceZone(workspaceId: string): Promise<string> {
  return (await workspaceZones([workspaceId])).get(workspaceId)!;
}

/** Today's date (YYYY-MM-DD) on a workspace's clock. */
export async function workspaceToday(workspaceId: string): Promise<string> {
  return dayOn(await workspaceZone(workspaceId));
}

/** Forgets cached timezones (one workspace, or all), so the next read sees a change at once. */
export function forgetWorkspaceZones(workspaceId?: string) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

const at = (t: number | Date) => (typeof t === "number" ? t : t.getTime());

/** The calendar date (YYYY-MM-DD) at a moment on a clock. */
export function dayOn(zone: string, t: number | Date = Date.now()): string {
  return DateTime.fromMillis(at(t), { zone }).toISODate()!;
}

/** Midnight that started the day, on a clock (epoch ms). */
export function startOfDayOn(zone: string, t: number | Date = Date.now()): number {
  return DateTime.fromMillis(at(t), { zone }).startOf("day").toMillis();
}

/** Midnight that started the first of the last `days` days (today included), on a clock (epoch ms). */
export function startOfLastDaysOn(zone: string, days: number, t: number | Date = Date.now()): number {
  return DateTime.fromMillis(at(t), { zone })
    .startOf("day")
    .minus({ days: Math.max(0, days - 1) })
    .toMillis();
}

/** The next midnight, on a clock (epoch ms). */
export function startOfNextDayOn(zone: string, t: number | Date = Date.now()): number {
  return DateTime.fromMillis(at(t), { zone }).plus({ days: 1 }).startOf("day").toMillis();
}

/** Midnight that started the month, on a clock (epoch ms): monthly allowances start counting again then. */
export function startOfMonthOn(zone: string, t: number | Date = Date.now()): number {
  return DateTime.fromMillis(at(t), { zone }).startOf("month").toMillis();
}

/** Whole calendar days from one date to another (YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The day (YYYY-MM-DD) a date, or a date and time, falls on, on a clock. Anything else is a 400. */
export function dayOf(value: string, zone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!DateTime.fromISO(value).isValid) throw badRequest(`Invalid date ${value}`);
    return value;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw badRequest(`Invalid date ${value}`);
  return dayOn(zone, t);
}

/** The date `days` before a YYYY-MM-DD date (after it, when negative). */
export function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** The local time of day (hours, with minutes as a fraction) and whether it's Saturday or Sunday, on a clock. */
export function clockAt(zone: string, t: number | Date = Date.now()): { hour: number; weekend: boolean } {
  const local = DateTime.fromMillis(at(t), { zone });
  return { hour: local.hour + local.minute / 60, weekend: local.weekday >= 6 };
}

const offsetAt = (zone: string, t: number) => DateTime.fromMillis(t, { zone }).offset * 60_000;

/**
 * A clock's offset from UTC (ms) from each moment it changes between `from` and `to`: the first entry holds from the
 * start, each later one from its `at`. Daylight-saving changes are weeks apart, so a weekly look finds every one, and a
 * search narrows each down to the millisecond.
 */
export function offsetChanges(zone: string, from: number, to: number): Array<{ at: number; offset: number }> {
  const out = [{ at: -Infinity, offset: offsetAt(zone, from) }];
  let before = from;
  for (let t = from; t < to; ) {
    const next = Math.min(t + 7 * DAY_MS, to);
    const offset = offsetAt(zone, next);
    if (offset !== out.at(-1)!.offset) {
      let lo = before;
      let hi = next;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(zone, mid) === out.at(-1)!.offset) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, offset });
    }
    before = next;
    t = next;
  }
  return out;
}

/**
 * SQL for the calendar date (YYYY-MM-DD) of a millisecond timestamp column on a clock, right across daylight-saving
 * changes between `from` and `to` (moments outside that take the nearest offset), to count things by day.
 */
export function localDateSql(column: SQLWrapper, zone: string, from: number, to: number): SQL<string> {
  // Changes are looked for within a few decades at most: a period of centuries would make thousands of them.
  const now = Date.now();
  const lo = Math.max(from, now - 40 * 365 * DAY_MS);
  const hi = Math.min(Math.max(to, lo), now + 2 * 365 * DAY_MS);
  const changes = offsetChanges(zone, lo, hi);
  if (changes.length === 1) return sql<string>`date((${column} + ${changes[0]!.offset}) / 1000, 'unixepoch')`;
  const cases = changes.slice(1).map((c, i) => sql`when ${column} < ${c.at} then ${changes[i]!.offset}`);
  return sql<string>`date((${column} + case ${sql.join(cases, sql` `)} else ${changes.at(-1)!.offset} end) / 1000, 'unixepoch')`;
}

// ---------- Periods for analytics ----------

export interface DateRange {
  start?: number;
  end?: number;
  /** The clock whole days are read on: a date's bounds, and the days daily figures are counted by. */
  zone?: string;
}

/** Periods are kept between 1970 and a year from now: nothing the app keeps is older or later, and a date centuries away would make daily figures crawl. */
const EARLIEST = 0;
const LATEST_AHEAD_MS = 366 * DAY_MS;

/** A period from dates (YYYY-MM-DD: whole days on the clock given) or exact times. */
export function parseRange(start?: string, end?: string, zone = "UTC"): DateRange {
  const parse = (v: string | undefined, endOfDay: boolean) => {
    if (!v) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const day = DateTime.fromISO(v, { zone });
      if (!day.isValid) throw badRequest(`Invalid date ${v}`);
      return (endOfDay ? day.endOf("day") : day.startOf("day")).toMillis();
    }
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw badRequest(`Invalid date ${v}`);
    return t;
  };
  const latest = Date.now() + LATEST_AHEAD_MS;
  const keep = (t: number | undefined) => (t === undefined ? undefined : Math.min(Math.max(t, EARLIEST), latest));
  return { start: keep(parse(start, false)), end: keep(parse(end, true)), zone };
}

/** A period in a workspace's analytics: its dates are whole days on the workspace's clock. */
export async function workspaceRange(workspaceId: string, start?: string, end?: string): Promise<DateRange> {
  return parseRange(start, end, await workspaceZone(workspaceId));
}

/** SQL for the day (YYYY-MM-DD) a timestamp column falls on, on the period's clock. */
export function daySql(column: SQLWrapper, r: DateRange): SQL<string> {
  const now = Date.now();
  return localDateSql(column, r.zone ?? "UTC", r.start ?? now - 10 * 365 * 86_400_000, r.end ?? now + 86_400_000);
}

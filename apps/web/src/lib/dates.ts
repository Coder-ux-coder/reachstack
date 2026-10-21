import { format, parseISO, startOfMonth, startOfYear, subDays, subMonths, endOfMonth } from "date-fns";

export type RangeKey = "today" | "yesterday" | "7d" | "14d" | "30d" | "90d" | "this_month" | "last_month" | "this_year" | "all" | "custom";

export interface DateRange {
  key: RangeKey;
  start_date?: string;
  end_date?: string;
}

const ymd = (d: Date) => format(d, "yyyy-MM-dd");

/** This browser's time zone ("Europe/London"), or undefined when it can't say. */
export function browserZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a time zone is one this browser knows (any IANA name, not only those in the pickers' lists). */
export function knownToBrowser(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Whether two time zones keep the same time all year ("Europe/Isle_of_Man" and "Europe/London"). */
export function sameClock(a: string, b: string): boolean {
  if (a === b) return true;
  const now = Date.now();
  return [0, 91, 182, 273].every((days) => {
    const at = now + days * 86_400_000;
    const x = wallClock(at, a);
    const y = wallClock(at, b);
    return x.date === y.date && x.time === y.time;
  });
}

/**
 * Today's date (YYYY-MM-DD) on a timezone's calendar. Reports count days on the workspace's clock, so ranges and charts
 * start from its today, not the browser's; without a zone (or with one the browser doesn't know), the browser's today.
 */
export function todayIn(zone?: string): string {
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      const part = (type: string) => parts.find((p) => p.type === type)?.value;
      return `${part("year")}-${part("month")}-${part("day")}`;
    } catch {
      // An unknown timezone: the browser's calendar below.
    }
  }
  return ymd(new Date());
}

/** What the wall clock in `zone` reads at an instant: "yyyy-MM-dd" and "HH:mm" (the browser's clock if it doesn't know the zone). */
export function wallClock(at: string | number | Date, zone: string): { date: string; time: string } {
  const d = new Date(at);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
  } catch {
    return { date: format(d, "yyyy-MM-dd"), time: format(d, "HH:mm") };
  }
}

/** The moment the wall clock in `zone` reads `date` ("2026-10-14") at `time` ("09:30"), as an ISO timestamp. */
export function fromWallClock(date: string, time: string, zone: string): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = (time || "09:00").split(":").map(Number) as [number, number];
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // Start from that wall time read as UTC and move by however far the zone's clock is off from it (twice, for the hour a
  // clock change skips or repeats).
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(t, zone);
    const [wy, wmo, wd] = w.date.split("-").map(Number) as [number, number, number];
    const [wh, wmi] = w.time.split(":").map(Number) as [number, number];
    t += wanted - Date.UTC(wy, wmo - 1, wd, wh, wmi);
  }
  return new Date(t).toISOString();
}

/** The day `n` days before a YYYY-MM-DD day. */
export const daysBefore = (day: string, n: number) => ymd(subDays(parseISO(day), n));

export const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_year", label: "This year" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
];

/** A range's days, counted back from today on the workspace's calendar (see todayIn). */
export function resolveRange(key: RangeKey, custom?: { start_date?: string; end_date?: string }, zone?: string): DateRange {
  const now = parseISO(todayIn(zone));
  switch (key) {
    case "today":
      return { key, start_date: ymd(now), end_date: ymd(now) };
    case "yesterday":
      return { key, start_date: ymd(subDays(now, 1)), end_date: ymd(subDays(now, 1)) };
    case "7d":
      return { key, start_date: ymd(subDays(now, 6)), end_date: ymd(now) };
    case "14d":
      return { key, start_date: ymd(subDays(now, 13)), end_date: ymd(now) };
    case "30d":
      return { key, start_date: ymd(subDays(now, 29)), end_date: ymd(now) };
    case "90d":
      return { key, start_date: ymd(subDays(now, 89)), end_date: ymd(now) };
    case "this_month":
      return { key, start_date: ymd(startOfMonth(now)), end_date: ymd(now) };
    case "last_month": {
      const m = subMonths(now, 1);
      return { key, start_date: ymd(startOfMonth(m)), end_date: ymd(endOfMonth(m)) };
    }
    case "this_year":
      return { key, start_date: ymd(startOfYear(now)), end_date: ymd(now) };
    case "custom":
      return { key, start_date: custom?.start_date, end_date: custom?.end_date };
    default:
      return { key: "all" };
  }
}

/** The most days a chart draws: ten years. A longer range shows its latest days. */
const MAX_CHART_DAYS = 3700;

/** Fill missing days with zeros so charts have a continuous x-axis. */
export function fillDays<T extends { date: string }>(rows: T[], start: string | undefined, end: string | undefined, zero: Omit<T, "date">): T[] {
  if (!start || !end) return rows;
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: T[] = [];
  const last = new Date(`${end}T00:00:00`);
  const earliest = new Date(last);
  earliest.setDate(earliest.getDate() - (MAX_CHART_DAYS - 1));
  const d = new Date(`${start}T00:00:00`);
  if (d < earliest) d.setTime(earliest.getTime());
  for (; d <= last; d.setDate(d.getDate() + 1)) {
    const key = ymd(d);
    out.push(byDate.get(key) ?? ({ ...zero, date: key } as T));
  }
  return out;
}

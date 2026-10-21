import { DateTime } from "luxon";
import { dayOffReason, type CampaignSchedule, type ScheduleWindow } from "@reachstack/shared";

export function iso(d: Date | number | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isValidZone(zone: string | null | undefined): boolean {
  if (!zone) return false;
  return DateTime.now().setZone(zone).isValid;
}

function parseHm(value: string): number {
  const [h, m] = value.split(":").map((x) => Number(x));
  return (h ?? 0) * 60 + (m ?? 0);
}

export const DEFAULT_SCHEDULE: CampaignSchedule = {
  start_date: null,
  end_date: null,
  schedules: [
    {
      name: "New schedule",
      timing: { from: "09:00", to: "17:00" },
      days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
      timezone: "America/New_York",
    },
  ],
};

function windowOpenAt(w: ScheduleWindow, at: DateTime): boolean {
  const zone = isValidZone(w.timezone) ? w.timezone : "UTC";
  const local = at.setZone(zone);
  const dayKey = String(local.weekday % 7) as keyof ScheduleWindow["days"]; // luxon: 1=Mon..7=Sun → 0=Sun
  if (!w.days?.[dayKey]) return false;
  const minutes = local.hour * 60 + local.minute;
  const from = parseHm(w.timing?.from ?? "09:00");
  const to = parseHm(w.timing?.to ?? "17:00");
  if (from === to) return true;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** Is the schedule (any window) open at `at`, respecting start/end dates? */
export function isScheduleOpen(schedule: CampaignSchedule | null | undefined, at: Date | number = Date.now()): boolean {
  const s = schedule ?? DEFAULT_SCHEDULE;
  const now = DateTime.fromMillis(typeof at === "number" ? at : at.getTime());
  const windows = s.schedules?.length ? s.schedules : DEFAULT_SCHEDULE.schedules;
  const zone = isValidZone(windows[0]?.timezone) ? windows[0]!.timezone : "UTC";
  const localDate = now.setZone(zone).toISODate();
  // Days compare as YYYY-MM-DD (a date saved with a time, from before dates were checked, counts as its day).
  if (s.start_date && localDate && localDate < s.start_date.slice(0, 10)) return false;
  if (s.end_date && localDate && localDate > s.end_date.slice(0, 10)) return false;
  if (localDate && dayOffReason(s.days_off, localDate)) return false;
  return windows.some((w) => windowOpenAt(w, now));
}

/** Next time (epoch ms) the schedule opens at or after `from`, scanning up to 14 days in 5-minute steps. */
export function nextScheduleOpening(schedule: CampaignSchedule | null | undefined, from: number = Date.now()): number | null {
  if (isScheduleOpen(schedule, from)) return from;
  const step = 5 * 60_000;
  let t = Math.ceil(from / step) * step;
  const limit = from + 14 * 86_400_000;
  while (t <= limit) {
    if (isScheduleOpen(schedule, t)) return t;
    t += step;
  }
  return null;
}

/**
 * When a schedule is open between two moments: sorted, non-overlapping [start, end) pairs (epoch ms). Agrees with
 * isScheduleOpen (the same windows, weekdays, timezones and start and end dates), without testing minute by minute.
 */
export function openIntervals(schedule: CampaignSchedule | null | undefined, from: number, to: number): Array<[number, number]> {
  const s = schedule ?? DEFAULT_SCHEDULE;
  const windows = s.schedules?.length ? s.schedules : DEFAULT_SCHEDULE.schedules;
  // Start and end dates are read on the first window's clock, as in isScheduleOpen.
  const zone0 = isValidZone(windows[0]?.timezone) ? windows[0]!.timezone : "UTC";
  let lo = from;
  let hi = to;
  const first = s.start_date ? DateTime.fromISO(s.start_date.slice(0, 10), { zone: zone0 }).startOf("day").toMillis() : NaN;
  const last = s.end_date ? DateTime.fromISO(s.end_date.slice(0, 10), { zone: zone0 }).plus({ days: 1 }).startOf("day").toMillis() : NaN;
  if (Number.isFinite(first)) lo = Math.max(lo, first);
  if (Number.isFinite(last)) hi = Math.min(hi, last);
  if (hi <= lo) return [];
  const spans: Array<[number, number]> = [];
  for (const w of windows) {
    const zone = isValidZone(w.timezone) ? w.timezone : "UTC";
    const open = parseHm(w.timing?.from ?? "09:00");
    const close = parseHm(w.timing?.to ?? "17:00");
    const at = (day: DateTime, minutes: number) =>
      (minutes >= 24 * 60 ? day.plus({ days: 1 }).startOf("day") : day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60 })).toMillis();
    for (let day = DateTime.fromMillis(lo, { zone }).startOf("day"); day.toMillis() < hi; day = day.plus({ days: 1 }).startOf("day")) {
      if (!w.days?.[String(day.weekday % 7) as keyof ScheduleWindow["days"]]) continue;
      const end = day.plus({ days: 1 }).startOf("day").toMillis();
      // Like windowOpenAt: the same from and to means all day; a window that ends before it starts is open from
      // midnight to its end and from its start to midnight, both on the days it's on.
      const parts: Array<[number, number]> =
        open === close ? [[day.toMillis(), end]] : open < close ? [[at(day, open), at(day, close)]] : [[day.toMillis(), at(day, close)], [at(day, open), end]];
      for (const [a, b] of parts) {
        const x = Math.max(a, lo);
        const y = Math.min(b, hi);
        if (y > x) spans.push([x, y]);
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const prev = merged[merged.length - 1];
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else merged.push([a, b]);
  }
  if (!s.days_off) return merged;
  // Days off (on the first window's calendar) come out whole.
  const off: Array<[number, number]> = [];
  for (let day = DateTime.fromMillis(lo, { zone: zone0 }).startOf("day"); day.toMillis() < hi; day = day.plus({ days: 1 }).startOf("day")) {
    if (dayOffReason(s.days_off, day.toISODate()!)) off.push([day.toMillis(), day.plus({ days: 1 }).startOf("day").toMillis()]);
  }
  const out: Array<[number, number]> = [];
  for (const [a, b] of merged) {
    let start = a;
    for (const [x, y] of off) {
      if (y <= start || x >= b) continue;
      if (x > start) out.push([start, x]);
      start = Math.max(start, y);
    }
    if (start < b) out.push([start, b]);
  }
  return out;
}

// ---------- Each lead's timezone (CampaignSchedule.lead_timezone) ----------

/** The schedule as it reads for a lead in `zone`: every window, and the days off and dates, on that clock. */
export function inZone(schedule: CampaignSchedule | null | undefined, zone: string): CampaignSchedule {
  const s = schedule ?? DEFAULT_SCHEDULE;
  const windows = s.schedules?.length ? s.schedules : DEFAULT_SCHEDULE.schedules;
  return { ...s, schedules: windows.map((w) => ({ ...w, timezone: zone })) };
}

/** The clock a lead's emails go by (time variables, out-of-office dates): the lead's own when known, else the schedule's. */
export function leadClock(schedule: CampaignSchedule | null | undefined, leadZone?: string | null): string {
  if (schedule?.lead_timezone && leadZone && isValidZone(leadZone)) return leadZone;
  const tz = schedule?.schedules?.[0]?.timezone;
  return tz && isValidZone(tz) ? tz : "UTC";
}

/** The schedules a flow's leads go by: the schedule itself for leads without a timezone (null), one per timezone else. */
export function zoneSchedules(schedule: CampaignSchedule | null | undefined, zones: Array<string | null>): CampaignSchedule[] {
  const s = schedule ?? DEFAULT_SCHEDULE;
  if (!s.lead_timezone || !zones.length) return [s];
  return zones.map((z) => (z ? inZone(s, z) : s));
}

/** Open for some of them at `at`. */
export const anyOpen = (schedules: CampaignSchedule[], at: number = Date.now()) => schedules.some((s) => isScheduleOpen(s, at));

/** When the first of them opens, at or after `from` (null when none does within 14 days). */
export function nextOpening(schedules: CampaignSchedule[], from: number = Date.now()): number | null {
  const times = schedules.map((s) => nextScheduleOpening(s, from)).filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
}

/** When any of them is open between two moments: their open intervals merged. */
export function openSpans(schedules: CampaignSchedule[], from: number, to: number): Array<[number, number]> {
  const spans = schedules.flatMap((s) => openIntervals(s, from, to)).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const prev = merged[merged.length - 1];
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Minutes remaining in the currently open window (used to spread sends). */
export function minutesLeftInWindow(schedule: CampaignSchedule | null | undefined, at: number = Date.now()): number {
  const s = schedule ?? DEFAULT_SCHEDULE;
  const now = DateTime.fromMillis(at);
  let best = 0;
  for (const w of s.schedules ?? []) {
    if (!windowOpenAt(w, now)) continue;
    const zone = isValidZone(w.timezone) ? w.timezone : "UTC";
    const local = now.setZone(zone);
    const minutes = local.hour * 60 + local.minute;
    const to = parseHm(w.timing.to);
    const left = to > minutes ? to - minutes : 24 * 60 - minutes + to;
    best = Math.max(best, left);
  }
  return best;
}

export function startOfUtcDay(d: number = Date.now()): number {
  const date = new Date(d);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function daysAgo(n: number, from: number = Date.now()): number {
  return from - n * 86_400_000;
}

/** Inclusive list of YYYY-MM-DD dates between two dates. */
export function dateRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  while (t <= end && out.length < 3660) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

export function allTimezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
  }
}

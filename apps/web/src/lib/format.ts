import { format, formatDistanceToNowStrict, isToday, isYesterday, parseISO } from "date-fns";

const nf = new Intl.NumberFormat();

export const num = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "–" : nf.format(n));

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** A share as a percent, never over 100%: a period can hold replies or bounces to emails sent before it. */
export function pct(part: number | null | undefined, whole: number | null | undefined, digits = 1): string {
  if (!whole || part === null || part === undefined) return "0%";
  return `${Math.min(100, (part / whole) * 100).toFixed(digits).replace(/\.0$/, "")}%`;
}

export function money(n: number | null | undefined, currency = "USD"): string {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
}

const toDate = (d: string | number | Date) => (typeof d === "string" ? parseISO(d) : new Date(d));

export function dateTime(d: string | number | Date | null | undefined): string {
  if (!d) return "–";
  return format(toDate(d), "MMM d, yyyy h:mm a");
}

/** A date and time on a timezone's clock ("Mar 1, 2026, 3:00 PM"), naming the timezone when it isn't this browser's. */
export function dateTimeIn(d: Date, zone: string): string {
  const text = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  return Intl.DateTimeFormat().resolvedOptions().timeZone === zone ? text : `${text} (${zone.replace(/_/g, " ")})`;
}

export function dateOnly(d: string | number | Date | null | undefined): string {
  if (!d) return "–";
  return format(toDate(d), "MMM d, yyyy");
}

/** A calendar day (a date, or one stored as midnight UTC): "Mar 4" this year, else "Mar 4, 2025", the same day everywhere. */
export function calendarDay(d: string | null | undefined): string {
  if (!d) return "";
  const day = parseISO(d.slice(0, 10));
  return format(day, day.getFullYear() === new Date().getFullYear() ? "MMM d" : "MMM d, yyyy");
}

/** "3:42 PM" today, "Yesterday", "Mar 4" this year, else "Mar 4, 2025". */
export function shortWhen(d: string | number | Date | null | undefined): string {
  if (!d) return "";
  const date = toDate(d);
  if (isToday(date)) return format(date, "h:mm a");
  if (isYesterday(date)) return "Yesterday";
  if (date.getFullYear() === new Date().getFullYear()) return format(date, "MMM d");
  return format(date, "MMM d, yyyy");
}

export function ago(d: string | number | Date | null | undefined): string {
  if (!d) return "never";
  const date = toDate(d);
  if (Math.abs(Date.now() - date.getTime()) < 45_000) return "just now";
  return `${formatDistanceToNowStrict(date)} ago`;
}

export function initials(name: string | null | undefined, email?: string | null): string {
  const src = (name ?? "").trim() || (email ?? "").split("@")[0] || "?";
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || src[0]!.toUpperCase();
}

export const fullName = (p: { first_name?: string | null; last_name?: string | null } | null | undefined) =>
  [p?.first_name, p?.last_name].filter(Boolean).join(" ");

export function plural(n: number, one: string, many = `${one}s`) {
  return `${num(n)} ${n === 1 ? one : many}`;
}

export function downloadBlob(filename: string, content: string | Blob, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Rewrites ISO timestamps inside server messages ("…due at 2026-10-15T16:17:59.037Z") as local dates. */
/** ISO times in a message as people read them: on `zone`'s clock (named when it isn't this browser's), else this browser's. */
export const humanizeTimestamps = (text: string, zone?: string) =>
  text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => (zone ? dateTimeIn(new Date(iso), zone) : dateTime(iso)));

/** 1536 → "1.5 KB". */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 3725 → "1 h 2 min". */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "–";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${Math.round(seconds)} s`;
}

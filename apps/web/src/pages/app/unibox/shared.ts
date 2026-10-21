import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, addMonths, addWeeks, nextMonday, setHours, setMinutes, startOfHour } from "date-fns";
import { useSearchParams } from "react-router";
import { ACCOUNT_STATUS_LABELS, AccountStatus, EmailType } from "@reachstack/shared";
import { ApiError, get, qs, type Query } from "@/lib/api";
import type { Email as BaseEmail, Lead } from "@/lib/types";

export type Email = BaseEmail & {
  send_error?: string | null;
  is_bounce?: boolean | null;
  marked_as_done?: boolean | null;
  variant?: string | null;
};

export type Folder = "inbox" | "sent" | "scheduled" | "reminders" | "done";
const FOLDERS: Folder[] = ["inbox", "sent", "scheduled", "reminders", "done"];

/** Where a search looks: everywhere, or one folder or inbox tab. */
export type Scope = "all" | "primary" | "others" | Exclude<Folder, "inbox">;
export const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: "all", label: "All" },
  { value: "primary", label: "Primary" },
  { value: "others", label: "Others" },
  { value: "sent", label: "Sent" },
  { value: "scheduled", label: "Scheduled" },
  { value: "reminders", label: "Reminders" },
  { value: "done", label: "Done" },
];

export type SearchCounts = Record<Scope, number>;

/** How often the list and the counters check for new mail while the tab is visible. */
export const LIVE_REFRESH_MS = 20_000;

export interface ThreadRow {
  thread_id: string;
  last_activity_at: string;
  message_count: number;
  unread: boolean;
  reminder_ts: string | null;
  scheduled_at: string | null;
  latest: Email;
  lead: { id: string; email: string | null; first_name: string | null; last_name: string | null; company_name: string | null; lt_interest_status: number | null; status: number } | null;
}

export interface ThreadPage {
  items: ThreadRow[];
  page: number;
  has_more: boolean;
}

export interface ThreadDetail {
  thread_id: string;
  emails: Email[];
  lead: (Lead & { linkedin_url?: string | null; location?: string | null }) | null;
  campaign: { id: string; name: string | null } | null;
  subsequences: Array<{ id: string; name: string; status: number; steps: number }>;
  continuation: { subsequence_id: string; name: string | null; step: number; scheduled_for: string | null } | null;
  suggested_account: string | null;
  reply_target_id: string;
}

export interface Summary {
  /** Unread conversations per tab, and in the whole inbox (a conversation in both tabs counts once). */
  unread: { primary: number; others: number; inbox: number };
  reminders: number;
  scheduled: number;
  labels: Array<{ i_status: number; threads: number }>;
  campaigns: Array<{ id: string; name: string }>;
  inboxes: Array<{ email: string; status: number }>;
}

export const SUMMARY_KEY = ["unibox", "summary"] as const;

export function useUniboxSummary() {
  return useQuery({ queryKey: SUMMARY_KEY, queryFn: () => get<Summary>("/api/app/unibox/summary"), refetchInterval: LIVE_REFRESH_MS, refetchOnWindowFocus: true });
}

/** Everything the Unibox shows is driven by the URL so views can be linked and survive reloads. */
export function useUniboxParams() {
  const [params, setParams] = useSearchParams();
  const folder = params.get("folder") as Folder | null;
  const search = params.get("search") ?? "";
  const scope = params.get("scope") as Scope | null;
  const state = {
    folder: folder && FOLDERS.includes(folder) ? folder : "inbox",
    tab: params.get("tab") === "others" ? ("others" as const) : ("primary" as const),
    status: params.get("status"),
    campaign: params.get("campaign"),
    inbox: params.get("inbox"),
    unread: params.get("unread") === "1",
    search,
    /** While searching, results come from every folder unless the user picked one. */
    scope: search ? (scope && SCOPES.some((x) => x.value === scope) ? scope : "all") : null,
    thread: params.get("thread"),
  };
  const update = (patch: Partial<Record<"folder" | "tab" | "status" | "campaign" | "inbox" | "unread" | "search" | "scope" | "thread", string | null>>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === undefined || v === "" || (k === "folder" && v === "inbox") || (k === "tab" && v === "primary") || (k === "scope" && v === "all")) next.delete(k);
          else next.set(k, v);
        }
        // A scope only means something during a search.
        if (!next.get("search")) next.delete("scope");
        return next;
      },
      { replace: true },
    );
  return [state, update] as const;
}

export type UniboxState = ReturnType<typeof useUniboxParams>[0];

/** The filters that apply in every folder (and to searches). */
export function filterQuery(s: UniboxState) {
  return {
    i_status: s.status ?? undefined,
    campaign_id: s.campaign ?? undefined,
    eaccount: s.inbox ?? undefined,
    is_unread: s.unread ? "true" : undefined,
    search: s.search || undefined,
  };
}

/** Query string for the thread list endpoint (and the CSV export of the same list). */
export function threadQuery(s: UniboxState) {
  if (s.search) {
    const scope = s.scope ?? "all";
    const tab = scope === "primary" || scope === "others";
    return { ...filterQuery(s), folder: tab ? "inbox" : scope, mode: tab ? (scope === "others" ? "emode_others" : "emode_focused") : undefined, limit: 25 };
  }
  return {
    ...filterQuery(s),
    folder: s.folder,
    mode: s.folder === "inbox" ? (s.tab === "others" ? "emode_others" : "emode_focused") : undefined,
    limit: 25,
  };
}

/** Matches per folder and tab for the current search, so the user can jump to them. */
export function useSearchCounts(s: UniboxState) {
  const query = filterQuery(s);
  return useQuery({
    queryKey: ["unibox", "search-counts", query],
    queryFn: () => get<SearchCounts>("/api/app/unibox/search-counts", query),
    enabled: !!s.search,
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_REFRESH_MS,
    refetchOnWindowFocus: true,
  });
}

/**
 * Downloads a file from the API without leaving the page, using the name the server gives it. Errors come back as
 * the server's message instead of a page of JSON.
 */
export async function downloadFile(path: string, query?: Query): Promise<{ truncatedAt: number | null }> {
  let res: Response;
  try {
    res = await fetch(path + qs(query), { credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, data?.message || res.statusText || "Download failed");
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const name = utf8 ? decodeURIComponent(utf8) : (/filename="([^"]+)"/i.exec(disposition)?.[1] ?? "download");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  const truncated = Number(res.headers.get("x-export-truncated"));
  return { truncatedAt: truncated > 0 ? truncated : null };
}

/** Someone pressed a single-key shortcut that the Unibox should act on (not typing, no menu or dialog open). */
export function isShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return false;
  // Dialogs, sheets, popovers, menus and open selects own the keyboard while they're open.
  return !document.querySelector("[role=dialog],[role=alertdialog],[role=menu],[role=listbox]");
}

/** After anything changes a thread: refresh the list, the open thread and the sidebar counters. */
export function useRefreshUnibox() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["unibox"] });
    qc.invalidateQueries({ queryKey: ["lead"] });
    qc.invalidateQueries({ queryKey: ["leads"] });
  };
}

export const isReceived = (e: Pick<Email, "ue_type">) => e.ue_type === EmailType.RECEIVED;
export const isScheduled = (e: Pick<Email, "ue_type">) => e.ue_type === EmailType.SCHEDULED;

/** The note beside a mailbox in a From picker: paused (it can't send), or the problem it had lately (it's still tried). */
export function senderHint(status: number): string | undefined {
  if (status === AccountStatus.ACTIVE || status === 0) return undefined;
  if (status === AccountStatus.PAUSED) return "Paused";
  return ACCOUNT_STATUS_LABELS[status] ?? "Had a problem";
}

/** Display name + address of the first sender. */
export function sender(e: Email): { name: string; address: string } {
  const j = e.from_address_json?.[0];
  return { name: j?.name?.trim() || "", address: j?.address || e.from_address_email || "" };
}

export const splitAddresses = (list: string | null | undefined) =>
  (list ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** List previews of older replies can include the quoted history ("On … wrote: …"); show only the new part. */
export const cleanPreview = (text: string | null | undefined) => (text ?? "").replace(/\s*(?:On\s.{5,200}?\swrote:|-{2,}\s*Original Message|-{5,}\s*Forwarded message)[\s\S]*$/i, "").trim();

export const replySubject = (subject: string) => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);
export const forwardSubject = (subject: string) => (/^fwd?:/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject.trim()}`);

/** Plain-text bodies (and HTML that is really text) as safe paragraphs. */
export function bodyHtml(e: Pick<Email, "body">): string {
  if (e.body.html?.trim()) return e.body.html;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(e.body.text ?? "")
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const at8 = (d: Date) => setMinutes(setHours(d, 8), 0);

/** Follow-up reminder presets. */
export const REMINDER_PRESETS: Array<{ key: string; label: string; at: () => Date }> = [
  { key: "1d", label: "In 1 day", at: () => at8(addDays(new Date(), 1)) },
  { key: "monday", label: "Next Monday", at: () => at8(nextMonday(new Date())) },
  { key: "1w", label: "In 1 week", at: () => at8(addWeeks(new Date(), 1)) },
  { key: "2w", label: "In 2 weeks", at: () => at8(addWeeks(new Date(), 2)) },
  { key: "1m", label: "In 1 month", at: () => at8(addMonths(new Date(), 1)) },
];

/** "Send later" presets. */
export const SEND_LATER_PRESETS: Array<{ key: string; label: string; at: () => Date }> = [
  { key: "1h", label: "In 1 hour", at: () => startOfHour(new Date(Date.now() + 2 * 3600_000)) },
  { key: "tomorrow", label: "Tomorrow morning", at: () => at8(addDays(new Date(), 1)) },
  { key: "monday", label: "Monday morning", at: () => at8(nextMonday(new Date())) },
];

/** `<input type="datetime-local">` value for a date (local time). */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Recent searches are a per-browser convenience. */
const RECENT_KEY = "unibox.recent-searches";
export function recentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}
export function rememberSearch(q: string) {
  const t = q.trim();
  if (!t) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([t, ...recentSearches().filter((x) => x !== t)].slice(0, 6)));
  } catch {
    // storage unavailable
  }
}
export function forgetSearch(q: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches().filter((x) => x !== q)));
  } catch {
    // storage unavailable
  }
}

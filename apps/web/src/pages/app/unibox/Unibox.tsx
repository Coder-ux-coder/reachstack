import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlarmClock,
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  Inbox,
  Keyboard,
  ListFilter,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  SquarePen,
  Tag,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { errorMessage, get, post } from "@/lib/api";
import { daysBefore, todayIn } from "@/lib/dates";
import { fullName, num, plural, shortWhen } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { useLeadStatuses } from "@/lib/statuses";
import { cn } from "@/lib/cn";
import { InterestBadge } from "@/components/status";
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Textarea,
  Tooltip,
  useConfirm,
} from "@/components/ui";
import { NewEmailDialog } from "@/components/NewEmailDialog";
import { ShortcutsDialog } from "./Shortcuts";
import { ThreadView } from "./ThreadView";
import {
  LIVE_REFRESH_MS,
  SCOPES,
  cleanPreview,
  downloadFile,
  forgetSearch,
  isScheduled,
  isShortcut,
  recentSearches,
  rememberSearch,
  sender,
  threadQuery,
  useRefreshUnibox,
  useSearchCounts,
  useUniboxParams,
  useUniboxSummary,
  type SearchCounts,
  type ThreadPage,
  type ThreadRow,
  type UniboxState,
} from "./shared";

// ---------- Sidebar ----------

function NavRow({ active, onClick, icon, label, count, tone }: { active?: boolean; onClick: () => void; icon?: ReactNode; label: ReactNode; count?: number; tone?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors", active ? "bg-brand-soft font-medium text-brand-text" : "text-muted hover:bg-panel-2 hover:text-text")}
    >
      {icon}
      {tone && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!count && <span className="text-xs tabular-nums text-muted">{num(count)}</span>}
    </button>
  );
}

const COLORS = ["#16a34a", "#2563eb", "#7c3aed", "#ca8a04", "#0891b2", "#db2777", "#ea580c", "#64748b"];

function CreateLabelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [sentiment, setSentiment] = useState<"positive" | "neutral" | "negative">("positive");
  const [description, setDescription] = useState("");
  const [useWithAi, setUseWithAi] = useState(false);
  const [color, setColor] = useState(COLORS[0]!);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setLabel("");
      setDescription("");
      setUseWithAi(false);
      setSentiment("positive");
      setColor(COLORS[0]!);
    }
  }, [open]);
  const save = async () => {
    setBusy(true);
    try {
      await post("/api/v2/lead-labels", { label: label.trim(), interest_status_label: sentiment, description: description.trim() || null, use_with_ai: useWithAi, color });
      await qc.invalidateQueries({ queryKey: ["lead-statuses"] });
      toast.success("Label created");
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Create a lead label"
      description="Labels sort replies by what the lead said. Whether a label counts as positive, neutral or negative can't be changed later."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!label.trim() || (useWithAi && !description.trim())} onClick={save}>
            Create label
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Label">{(id) => <Input id={id} autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Asked for pricing" maxLength={80} />}</Field>
        <Field label="Counts as">
          <Segmented
            value={sentiment}
            onChange={setSentiment}
            options={[
              { value: "positive", label: "Positive" },
              { value: "neutral", label: "Neutral" },
              { value: "negative", label: "Negative" },
            ]}
          />
        </Field>
        <Field label="Colour">
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                onClick={() => setColor(c)}
                className={cn("h-6 w-6 rounded-full ring-offset-2 ring-offset-panel", color === c && "ring-2 ring-brand")}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>
        <Field label="Description" optional={!useWithAi} hint={useWithAi ? "The AI reads this to decide when a reply gets this label." : undefined}>
          {(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When should a reply get this label?" />}
        </Field>
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span>
            Use with AI
            <span className="block text-xs text-muted">Let the AI apply this label to matching replies automatically.</span>
          </span>
          <Switch checked={useWithAi} onChange={setUseWithAi} aria-label="Use with AI" />
        </label>
      </div>
    </Dialog>
  );
}

function Sidebar({ s, set }: { s: UniboxState; set: ReturnType<typeof useUniboxParams>[1] }) {
  const summary = useUniboxSummary();
  const statuses = useLeadStatuses();
  const can = useCan();
  const [creating, setCreating] = useState(false);
  const counts = new Map((summary.data?.labels ?? []).map((l) => [l.i_status, l.threads]));
  // Filters narrow what's shown (searches included); folders and labels are places, so going to one ends a search.
  const go = (patch: Parameters<typeof set>[0]) => set({ thread: null, ...patch });
  const open = (patch: Parameters<typeof set>[0]) => set({ thread: null, search: null, scope: null, ...patch });
  const browsing = !s.search;
  const inInbox = browsing && s.folder === "inbox";
  return (
    <div className="space-y-5">
      <div className="space-y-0.5">
        <NavRow
          active={inInbox && !s.status}
          onClick={() => open({ folder: "inbox", status: null })}
          icon={<Inbox size={15} />}
          label="Inbox"
          count={summary.data?.unread.inbox}
        />
        <NavRow active={browsing && s.folder === "sent"} onClick={() => open({ folder: "sent", status: null })} icon={<Send size={15} />} label="Sent" />
        <NavRow active={browsing && s.folder === "scheduled"} onClick={() => open({ folder: "scheduled", status: null })} icon={<CalendarClock size={15} />} label="Scheduled" count={summary.data?.scheduled} />
        <NavRow active={browsing && s.folder === "reminders"} onClick={() => open({ folder: "reminders", status: null })} icon={<AlarmClock size={15} />} label="Reminders" count={summary.data?.reminders} />
        <NavRow active={browsing && s.folder === "done"} onClick={() => open({ folder: "done", status: null })} icon={<CheckCircle2 size={15} />} label="Done" />
      </div>

      <div>
        <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Status</p>
        <div className="space-y-0.5">
          {statuses.all.map((st) => (
            <NavRow
              key={st.code}
              active={inInbox && s.status === String(st.code)}
              onClick={() => open({ folder: "inbox", status: String(st.code) })}
              tone={st.color}
              label={st.label}
              count={counts.get(st.code)}
            />
          ))}
          {can.perm("leads") && can.write && (
            <button type="button" onClick={() => setCreating(true)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted hover:bg-panel-2 hover:text-text">
              <Plus size={14} /> Create new label
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <p className="px-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Filters</p>
        <Select
          size="sm"
          value={s.campaign ?? ""}
          onChange={(v) => go({ campaign: v || null })}
          options={[{ value: "", label: "All campaigns" }, ...(summary.data?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name }))]}
          aria-label="Campaign"
        />
        <Select
          size="sm"
          value={s.inbox ?? ""}
          onChange={(v) => go({ inbox: v || null })}
          options={[{ value: "", label: "All inboxes" }, ...(summary.data?.inboxes ?? []).map((i) => ({ value: i.email, label: i.email }))]}
          aria-label="Inbox"
        />
        <label className="flex items-center justify-between px-2.5 py-1 text-[13px] text-muted">
          Unread only
          <Switch size="sm" checked={s.unread} onChange={(v) => go({ unread: v ? "1" : null })} aria-label="Unread only" />
        </label>
      </div>
      <CreateLabelDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

// ---------- Search ----------

const OPERATORS: Array<[string, string]> = [
  ["from:", "Emails from a sender"],
  ["to:", "Emails sent to an address"],
  ["lead:", "Emails for a lead"],
  ["subject:", "Words in the subject"],
  ["has:attachment", "Emails with files"],
  ["is:unread", "Unread emails"],
  ["is:done", "Conversations marked done"],
  ["in:sent", "Emails your workspace sent"],
  ["before:", "Before a date (2026-01-31)"],
  ["after:", "After a date"],
  ["campaign:", "Emails in a campaign"],
];

function SearchBox({ value, onApply, inputRef }: { value: string; onApply: (v: string) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const input = inputRef;
  const zone = useWorkspaceZone();
  useEffect(() => setText((t) => (t.trim() === value ? t : value)), [value]);
  // Apply as you type, after a short pause.
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onApply(text.trim()), 450);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const insert = (op: string) => {
    const next = `${text.trim() ? `${text.trim()} ` : ""}${op}`;
    setText(next);
    if (!op.endsWith(":")) onApply(next.trim());
    requestAnimationFrame(() => input.current?.focus());
  };
  const week = `after:${daysBefore(todayIn(zone), 7)}`;
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        ref={input}
        inputSize="sm"
        leading={<Search size={14} />}
        trailing={
          text ? (
            <button
              type="button"
              aria-label="Clear search"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText("");
                onApply("");
              }}
              className="text-faint hover:text-text"
            >
              <X size={13} />
            </button>
          ) : undefined
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          setRecent(recentSearches());
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onApply(text.trim());
            rememberSearch(text);
            setOpen(false);
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
        placeholder="Search all mail"
        aria-label="Search all mail"
        name="search"
        autoComplete="off"
      />
      {open && (
        <div className="animate-in absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-line bg-panel p-2 shadow-lg" onMouseDown={(e) => e.preventDefault()}>
          <p className="px-1.5 pb-2 text-xs text-muted">Searches every folder. Pick one in the results to narrow it down.</p>
          <p className="px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Quick filters</p>
          <div className="flex flex-wrap gap-1.5 px-1.5 pb-2">
            {[
              ["has:attachment", "Has attachment"],
              ["is:unread", "Unread"],
              ["in:sent", "Sent"],
              ["in:received", "Received"],
              [week, "Last 7 days"],
            ].map(([op, label]) => (
              <button key={op} type="button" onClick={() => insert(op!)} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:border-line-strong hover:text-text">
                {label}
              </button>
            ))}
          </div>
          {recent.length > 0 && (
            <>
              <p className="px-1.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Recent searches</p>
              {recent.map((r) => (
                <div key={r} className="group flex items-center rounded-md hover:bg-panel-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[13px]"
                    onClick={() => {
                      setText(r);
                      onApply(r);
                      setOpen(false);
                    }}
                  >
                    <Clock size={12} className="shrink-0 text-faint" />
                    <span className="truncate">{r}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Remove recent search"
                    className="px-2 text-faint opacity-0 hover:text-text group-hover:opacity-100"
                    onClick={() => {
                      forgetSearch(r);
                      setRecent(recentSearches());
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </>
          )}
          <p className="px-1.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Search operators</p>
          <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
            {OPERATORS.map(([op, help]) => (
              <button key={op} type="button" onClick={() => insert(op)} className="flex items-baseline gap-2 rounded-md px-1.5 py-1 text-left hover:bg-panel-2">
                <code className="shrink-0 text-xs font-medium text-brand-text">{op}</code>
                <span className="truncate text-xs text-muted">{help}</span>
              </button>
            ))}
          </div>
          <p className="px-1.5 pt-2 text-[11px] text-faint">Combine them: from:anna subject:pricing after:2026-01-01</p>
        </div>
      )}
    </div>
  );
}

// ---------- Thread list ----------

function ThreadItem({
  t,
  active,
  selected,
  selecting,
  onOpen,
  onSelect,
  statuses,
}: {
  t: ThreadRow;
  active: boolean;
  selected: boolean;
  selecting: boolean;
  onOpen: () => void;
  onSelect: (v: boolean) => void;
  statuses: ReturnType<typeof useLeadStatuses>["all"];
}) {
  const e = t.latest;
  const leadName = t.lead ? fullName(t.lead) : "";
  const who = leadName || t.lead?.email || (e.lead ?? sender(e).address);
  const interest = t.lead?.lt_interest_status ?? e.i_status;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") onOpen();
      }}
      data-thread={t.thread_id}
      className={cn(
        "group relative flex cursor-pointer gap-3 border-b border-line px-3 py-3 outline-none transition-colors focus-visible:bg-panel-2",
        active ? "bg-brand-soft/60" : "hover:bg-panel-2",
        selected && "bg-brand-soft/40",
      )}
    >
      {t.unread && <span className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-brand" aria-label="Unread" />}
      <div className="relative mt-0.5 h-8 w-8 shrink-0">
        <div className={cn("transition-opacity", (selecting || selected) && "opacity-0", "group-hover:opacity-0")}>
          <Avatar name={leadName} email={t.lead?.email ?? e.lead} size={32} />
        </div>
        <div className={cn("absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100", (selecting || selected) && "opacity-100")} onClick={(ev) => ev.stopPropagation()}>
          <Checkbox checked={selected} onChange={onSelect} aria-label={`Select conversation with ${who}`} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className={cn("min-w-0 flex-1 truncate text-[13px]", t.unread ? "font-semibold text-text" : "font-medium text-text")}>
            {who}
            {t.message_count > 1 && <span className="ml-1 text-xs font-normal text-faint">{t.message_count}</span>}
          </p>
          <span className={cn("shrink-0 text-[11px]", t.unread ? "font-semibold text-brand-text" : "text-faint")}>{shortWhen(t.scheduled_at ?? t.last_activity_at)}</span>
        </div>
        <p className={cn("truncate text-[13px]", t.unread ? "text-text" : "text-muted")}>{e.subject || "(no subject)"}</p>
        <p className="truncate text-xs text-faint">{cleanPreview(e.content_preview || e.body.text)}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 empty:hidden">
          <InterestBadge code={interest} labels={statuses} />
          {t.reminder_ts && (
            <span className="inline-flex items-center gap-1 text-[11px] text-warn">
              <AlarmClock size={11} /> {shortWhen(t.reminder_ts)}
            </span>
          )}
          {isScheduled(e) && !t.scheduled_at && e.send_error ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-warn">
              <CalendarClock size={11} /> Not sent
            </span>
          ) : (
            (t.scheduled_at || isScheduled(e)) && (
              <span className="inline-flex items-center gap-1 text-[11px] text-info">
                <CalendarClock size={11} /> Scheduled
              </span>
            )
          )}
          {!!e.attachment_json?.files?.length && <Paperclip size={11} className="text-faint" aria-label="Has attachments" />}
          {(e.ai_agent_id || e.ai_assisted) && (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-brand-text">
              <Sparkles size={10} /> AI
            </span>
          )}
          {e.campaign_name && <span className="max-w-[10rem] truncate text-[11px] text-faint">{e.campaign_name}</span>}
        </div>
      </div>
    </div>
  );
}

function emptyCopy(s: UniboxState, counts: SearchCounts | undefined): { title: string; description: string } {
  if (s.search) {
    if (s.scope !== "all" && counts?.all) return { title: `Nothing in ${SCOPES.find((x) => x.value === s.scope)?.label ?? "this folder"}`, description: "Other folders have matches. Pick one above." };
    return { title: "No conversations match", description: "Try other words, or remove an operator or filter from your search." };
  }
  if (s.status || s.campaign || s.inbox || s.unread) return { title: "Nothing here", description: "No conversations match these filters." };
  switch (s.folder) {
    case "sent":
      return { title: "Nothing sent yet", description: "Replies and forwards you send from the Unibox show up here." };
    case "scheduled":
      return { title: "Nothing scheduled", description: "Use “Send later” when replying to schedule an email." };
    case "reminders":
      return { title: "No reminders", description: "Set a reminder on a conversation to follow up at the right time." };
    case "done":
      return { title: "Nothing marked done", description: "Press e on a conversation to mark it done. It leaves the inbox and comes back when the lead replies." };
    default:
      return s.tab === "others"
        ? { title: "Others is empty", description: "Auto-replies, out-of-office notes and conversations you move out of Primary land here." }
        : { title: "No replies yet", description: "When leads answer your campaigns, their replies land here, from every connected inbox." };
  }
}

/** Search results per folder and tab ("All 13 · Primary 4 · Sent 7"); picking one narrows the results to it. */
function SearchScopes({ s, set, counts }: { s: UniboxState; set: ReturnType<typeof useUniboxParams>[1]; counts: SearchCounts | undefined }) {
  const active = s.scope ?? "all";
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" role="group" aria-label="Search results by folder">
      {SCOPES.filter((x) => x.value === "all" || x.value === active || (counts && counts[x.value] > 0)).map((x) => (
        <button
          key={x.value}
          type="button"
          aria-pressed={active === x.value}
          onClick={() => set({ scope: x.value, thread: null })}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
            active === x.value ? "border-transparent bg-brand-soft font-medium text-brand-text" : "border-line text-muted hover:border-line-strong hover:text-text",
          )}
        >
          {x.label}
          <span className={cn("tabular-nums", active === x.value ? "text-brand-text" : "text-faint")}>{counts ? num(counts[x.value]) : "…"}</span>
        </button>
      ))}
    </div>
  );
}

const dedupe = (rows: ThreadRow[]) => {
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.thread_id) && !!seen.add(r.thread_id));
};

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The rows on screen. At the top of the list they follow the server. Scrolled down, rows keep their place while the
 * list refreshes: new conversations wait behind the "N new" pill instead of pushing rows away under the pointer, and
 * rows from "Load more" join at the bottom. Rows that are gone (deleted, done, moved) disappear at once.
 */
function useSteadyRows(live: ThreadRow[], viewKey: string, follow: boolean) {
  const liveIds = useMemo(() => live.map((r) => r.thread_id), [live]);
  const [order, setOrder] = useState({ key: viewKey, ids: liveIds });
  let ids: string[];
  if (order.key !== viewKey || follow) ids = liveIds;
  else {
    const present = new Set(liveIds);
    const kept = order.ids.filter((id) => present.has(id));
    const keptSet = new Set(kept);
    const last = kept.length ? liveIds.indexOf(kept[kept.length - 1]!) : -1;
    ids = [...kept, ...liveIds.filter((id, i) => i > last && !keptSet.has(id))];
  }
  // Remembered for the next refresh (React re-renders straight away with it; it settles once nothing changes).
  if (order.key !== viewKey || !sameIds(order.ids, ids)) setOrder({ key: viewKey, ids });
  const byId = useMemo(() => new Map(live.map((r) => [r.thread_id, r])), [live]);
  const rows = useMemo(() => ids.map((id) => byId.get(id)).filter((r): r is ThreadRow => !!r), [ids.join(","), byId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, waiting: live.length - rows.length };
}

export default function Unibox() {
  usePageTitle("Unibox");
  const [s, set] = useUniboxParams();
  const summary = useUniboxSummary();
  const statuses = useLeadStatuses();
  const can = useCan();
  const confirm = useConfirm();
  const refresh = useRefreshUnibox();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(false);
  const [composing, setComposing] = useState(false);
  const canSend = can.perm("unibox") && can.write;
  const [atTop, setAtTop] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const query = threadQuery(s);
  const viewKey = JSON.stringify(query);
  // New replies show up without a reload: the list checks again every 20 seconds while the tab is visible, and on focus.
  const threads = useInfiniteQuery({
    queryKey: ["unibox", "threads", query],
    queryFn: ({ pageParam }) => get<ThreadPage>("/api/app/unibox/threads", { ...query, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.has_more ? last.page + 1 : undefined),
    refetchInterval: LIVE_REFRESH_MS,
    refetchOnWindowFocus: true,
  });
  const counts = useSearchCounts(s);
  // Pages fetched at different moments can overlap when mail arrives in between.
  const live = useMemo(() => dedupe(threads.data?.pages.flatMap((p) => p.items) ?? []), [threads.data]);
  const { rows, waiting } = useSteadyRows(live, viewKey, atTop);

  // A new view starts at the top with nothing selected.
  useEffect(() => {
    setSelected(new Set());
    list.current?.scrollTo({ top: 0 });
    setAtTop(true);
  }, [viewKey]);
  const showWaiting = () => {
    if (list.current) list.current.scrollTop = 0;
    setAtTop(true);
  };

  // A new message in the open conversation reloads it.
  const openRow = live.find((r) => r.thread_id === s.thread);
  const openSig = openRow ? `${openRow.thread_id}|${openRow.message_count}|${openRow.last_activity_at}` : "";
  const lastSig = useRef(openSig);
  useEffect(() => {
    const prev = lastSig.current;
    lastSig.current = openSig;
    if (prev && openSig && prev !== openSig && prev.split("|")[0] === openSig.split("|")[0]) qc.invalidateQueries({ queryKey: ["unibox", "thread", openSig.split("|")[0]] });
  }, [openSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const openThread = (id: string) => {
    set({ thread: id });
    requestAnimationFrame(() => list.current?.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  /** n: the next unread conversation below the open one, then new arrivals, then from the top, then further pages. */
  const nextUnread = async () => {
    const i = rows.findIndex((r) => r.thread_id === s.thread);
    const isNext = (r: ThreadRow) => r.unread && r.thread_id !== s.thread;
    let found = rows.slice(i + 1).find(isNext);
    if (!found && waiting) {
      found = live.find((r) => isNext(r) && !rows.includes(r));
      if (found) showWaiting();
    }
    found ??= rows.slice(0, Math.max(i, 0)).find(isNext);
    let more = threads.hasNextPage;
    for (let n = 0; !found && more && n < 4; n++) {
      const res = await threads.fetchNextPage();
      found = dedupe(res.data?.pages.flatMap((p) => p.items) ?? []).find(isNext);
      more = !!res.hasNextPage;
    }
    if (found) return openThread(found.thread_id);
    const others = !s.search && s.folder === "inbox" && s.tab === "primary" ? (summary.data?.unread.others ?? 0) : 0;
    if (others) toast("No unread conversations left in Primary.", { action: { label: `${others} in Others`, onClick: () => set({ tab: "others", thread: null }) } });
    else toast("No unread conversations left here.");
  };

  // List keys. The open conversation's own keys (r, a, f, e, 1–9) are in ThreadView.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e)) return;
      if (e.key === "?") setHelp(true);
      else if (e.key === "/") searchInput.current?.focus();
      else if (e.key === "Escape" && s.thread) set({ thread: null });
      else if (e.key === "n") void nextUnread();
      else if (e.key === "c" && canSend) setComposing(true);
      else if (e.key === "j" || e.key === "k") {
        const i = rows.findIndex((r) => r.thread_id === s.thread);
        const next = rows[e.key === "j" ? i + 1 : Math.max(0, i - 1)];
        if (next) openThread(next.thread_id);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ids = [...selected];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.thread_id));
  const bulk = async (action: string, done: string) => {
    try {
      await post("/api/app/unibox/bulk", { thread_ids: ids, action });
      toast.success(done);
      setSelected(new Set());
      // Deleted, or marked unread: the open conversation closes, and isn't loaded again on its way out (loading it marks
      // it read).
      const leaving = (action === "delete" || action === "mark_unread") && s.thread && ids.includes(s.thread) ? s.thread : null;
      if (leaving) {
        set({ thread: null });
        qc.invalidateQueries({ queryKey: ["unibox"], predicate: (q) => !(q.queryKey[1] === "thread" && q.queryKey[2] === leaving) });
        qc.invalidateQueries({ queryKey: ["lead"] });
        qc.invalidateQueries({ queryKey: ["leads"] });
      } else refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const bulkStatus = async (code: string) => {
    // The conversations' own leads (the workspace's sync setting carries the status to each person's other leads).
    const leadIds = [...new Set(rows.filter((r) => selected.has(r.thread_id)).map((r) => r.lead?.id).filter((x): x is string => !!x))];
    if (!leadIds.length) return toast.error("None of the selected conversations belong to a lead.");
    const label = statuses.all.find((x) => String(x.code) === code)?.label ?? "Lead";
    const id = toast.loading(`Updating ${plural(leadIds.length, "lead")}…`);
    try {
      await post("/api/app/leads/status", { ids: leadIds, action: "interest", interest_value: code === "" ? null : Number(code) });
      toast.success(`Marked ${plural(leadIds.length, "lead")} as ${label}`, { id });
      setSelected(new Set());
    } catch (e) {
      toast.error(errorMessage(e), { id });
    }
    refresh();
  };
  const download = async (path: string, params: Record<string, string | number | undefined>, what: string) => {
    const id = toast.loading(`Preparing ${what}…`);
    try {
      const r = await downloadFile(path, params);
      toast.success(r.truncatedAt ? `Downloaded the newest ${num(r.truncatedAt)} conversations` : "Downloaded", { id });
    } catch (e) {
      toast.error(errorMessage(e), { id });
    }
  };
  const { limit: _limit, ...listParams } = query;
  const selectWhere = (pred: (r: ThreadRow) => boolean) => setSelected(new Set(rows.filter(pred).map((r) => r.thread_id)));
  const empty = emptyCopy(s, counts.data);
  const inInbox = s.folder === "inbox";
  const inDone = !s.search && s.folder === "done";
  const unread = summary.data?.unread;
  const openIndex = rows.findIndex((r) => r.thread_id === s.thread);
  const removed = () => {
    const next = rows[openIndex + 1] ?? rows[openIndex - 1];
    set({ thread: next && next.thread_id !== s.thread ? next.thread_id : null });
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="scroll-thin hidden w-56 shrink-0 overflow-y-auto border-r border-line bg-panel px-2.5 py-4 xl:block">
        <Sidebar s={s} set={set} />
      </aside>

      <section className={cn("flex min-h-0 w-full flex-col border-r border-line bg-panel md:w-[300px] md:shrink-0 xl:w-[340px] 2xl:w-[380px]", s.thread && "hidden md:flex")}>
        <div className="space-y-2 border-b border-line px-3 pb-2 pt-3">
          <div className="flex items-center gap-1.5">
            <Popover
              align="start"
              className="scroll-thin max-h-[70vh] w-64 overflow-y-auto"
              trigger={
                <Button size="icon-sm" variant="ghost" aria-label="Folders and filters" className="xl:hidden">
                  <ListFilter size={15} />
                </Button>
              }
            >
              <Sidebar s={s} set={set} />
            </Popover>
            <SearchBox value={s.search} inputRef={searchInput} onApply={(v) => set(v ? { search: v, thread: null } : { search: null, scope: null, thread: null })} />
            <Tooltip content="Refresh">
              <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => qc.invalidateQueries({ queryKey: ["unibox"] })}>
                <RefreshCw size={14} className={cn(threads.isFetching && "animate-spin")} />
              </Button>
            </Tooltip>
            {canSend && (
              <Tooltip content="New email (c)">
                <Button size="icon-sm" variant="ghost" aria-label="New email" onClick={() => setComposing(true)}>
                  <SquarePen size={14} />
                </Button>
              </Tooltip>
            )}
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="More list actions">
                  <MoreHorizontal size={15} />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Download size={14} />} onSelect={() => download("/api/app/unibox/export/csv", listParams, "the CSV")}>
                  {s.search ? "Export these results as CSV" : "Export this list as CSV"}
                </MenuItem>
                <MenuItem icon={<Keyboard size={14} />} shortcut="?" onSelect={() => setHelp(true)}>
                  Keyboard shortcuts
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox checked={allOnPage ? true : selected.size ? "indeterminate" : false} onChange={(v) => (v ? selectWhere(() => true) : setSelected(new Set()))} aria-label="Select all on page" className="ml-1" />
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="-ml-1.5 rounded-md p-1.5 text-faint hover:bg-panel-2 hover:text-text" aria-label="Select conversations">
                  <ChevronDown size={12} />
                </button>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuItem onSelect={() => selectWhere(() => true)}>All on page</MenuItem>
                <MenuItem onSelect={() => setSelected(new Set())}>None</MenuItem>
                <MenuItem onSelect={() => selectWhere((r) => !r.unread)}>Read</MenuItem>
                <MenuItem onSelect={() => selectWhere((r) => r.unread)}>Unread</MenuItem>
              </MenuContent>
            </Menu>
            {selected.size > 0 ? (
              <div className="flex min-w-0 flex-1 items-center gap-0.5">
                <span className="mr-1 whitespace-nowrap text-xs font-medium">{selected.size} selected</span>
                {can.write && (
                  <>
                    <Tooltip content="Mark as read">
                      <Button size="icon-sm" variant="ghost" aria-label="Mark as read" onClick={() => bulk("mark_read", "Marked as read")}>
                        <Mail size={14} />
                      </Button>
                    </Tooltip>
                    <Tooltip content="Mark as unread">
                      <Button size="icon-sm" variant="ghost" aria-label="Mark as unread" onClick={() => bulk("mark_unread", "Marked as unread")}>
                        <MailOpen size={14} />
                      </Button>
                    </Tooltip>
                    {inDone ? (
                      <Tooltip content="Move back to the inbox">
                        <Button size="icon-sm" variant="ghost" aria-label="Move back to the inbox" onClick={() => bulk("mark_not_done", "Moved back to the inbox")}>
                          <Undo2 size={14} />
                        </Button>
                      </Tooltip>
                    ) : (
                      <Tooltip content="Mark as done">
                        <Button size="icon-sm" variant="ghost" aria-label="Mark as done" onClick={() => bulk("mark_done", "Marked as done")}>
                          <CheckCircle2 size={14} />
                        </Button>
                      </Tooltip>
                    )}
                    <Menu>
                      <MenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="Set lead status">
                          <Tag size={14} />
                        </Button>
                      </MenuTrigger>
                      <MenuContent align="start" className="scroll-thin max-h-80 overflow-y-auto">
                        {statuses.all.map((st) => (
                          <MenuItem key={st.code} onSelect={() => bulkStatus(String(st.code))} icon={<span className="h-2 w-2 rounded-full" style={{ background: st.color }} />}>
                            {st.label}
                          </MenuItem>
                        ))}
                        <MenuSeparator />
                        <MenuItem onSelect={() => bulkStatus("")}>Clear status</MenuItem>
                      </MenuContent>
                    </Menu>
                  </>
                )}
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label="More actions for the selection">
                      <MoreHorizontal size={14} />
                    </Button>
                  </MenuTrigger>
                  <MenuContent align="start">
                    {can.write && (
                      <>
                        <MenuItem onSelect={() => bulk("move_primary", "Moved to Primary")}>Move to Primary</MenuItem>
                        <MenuItem onSelect={() => bulk("move_others", "Moved to Others")}>Move to Others</MenuItem>
                        <MenuItem onSelect={() => bulk("clear_reminder", "Reminders removed")}>Remove reminders</MenuItem>
                        <MenuSeparator />
                      </>
                    )}
                    <MenuItem icon={<Download size={14} />} onSelect={() => download("/api/app/unibox/export/mbox", { thread_ids: ids.join(",") }, "the .mbox file")}>
                      Download as .mbox
                    </MenuItem>
                  </MenuContent>
                </Menu>
                {can.write && (
                  <Tooltip content="Delete">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete conversations"
                      className="hover:text-bad"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete ${selected.size} ${selected.size === 1 ? "conversation" : "conversations"}?`,
                            description: "They disappear from the Unibox for everyone in the workspace, and emails scheduled in them aren't sent. The copies in the mailboxes themselves are not touched.",
                            confirmLabel: "Delete",
                            danger: true,
                          })
                        )
                          bulk("delete", "Deleted");
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </Tooltip>
                )}
              </div>
            ) : s.search ? (
              <SearchScopes s={s} set={set} counts={counts.data} />
            ) : inInbox ? (
              <Segmented
                size="sm"
                value={s.tab}
                onChange={(v) => set({ tab: v, thread: null })}
                options={[
                  { value: "primary", label: <span>Primary{unread?.primary ? <span className="ml-1 text-brand-text">{unread.primary}</span> : null}</span> },
                  { value: "others", label: <span>Others{unread?.others ? <span className="ml-1 text-muted">{unread.others}</span> : null}</span> },
                ]}
              />
            ) : (
              <p className="text-[13px] font-medium capitalize">{s.folder}</p>
            )}
          </div>
          {(s.status || s.campaign || s.inbox || s.unread) && (
            <div className="flex flex-wrap gap-1.5">
              {s.status && (
                <FilterChip onClear={() => set({ status: null })}>{statuses.all.find((x) => String(x.code) === s.status)?.label ?? "Status"}</FilterChip>
              )}
              {s.campaign && <FilterChip onClear={() => set({ campaign: null })}>{summary.data?.campaigns.find((c) => c.id === s.campaign)?.name ?? "Campaign"}</FilterChip>}
              {s.inbox && <FilterChip onClear={() => set({ inbox: null })}>{s.inbox}</FilterChip>}
              {s.unread && <FilterChip onClear={() => set({ unread: null })}>Unread only</FilterChip>}
            </div>
          )}
        </div>

        <div
          ref={list}
          className="scroll-thin min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop < 8;
            if (top !== atTop) setAtTop(top);
          }}
        >
          {waiting > 0 && (
            <div className="pointer-events-none sticky top-2 z-10 flex h-0 items-start justify-center">
              <button
                type="button"
                onClick={showWaiting}
                aria-live="polite"
                className="pointer-events-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-brand px-3 py-1 text-xs font-medium text-on-brand shadow-lg hover:opacity-90"
              >
                <ArrowUp size={12} /> {num(waiting)} new
              </button>
            </div>
          )}
          {threads.isLoading ? (
            <div className="space-y-px">
              {Array.from({ length: 7 }, (_, i) => (
                <div key={i} className="flex gap-3 border-b border-line px-3 py-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-3 w-4/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : threads.isError ? (
            <div className="p-6">
              <EmptyState title="Couldn't load conversations" description={errorMessage(threads.error)} action={<Button onClick={() => threads.refetch()}>Try again</Button>} />
            </div>
          ) : rows.length ? (
            <>
              {rows.map((t) => (
                <ThreadItem
                  key={t.thread_id}
                  t={t}
                  active={t.thread_id === s.thread}
                  selected={selected.has(t.thread_id)}
                  selecting={selected.size > 0}
                  statuses={statuses.all}
                  onOpen={() => set({ thread: t.thread_id })}
                  onSelect={(v) =>
                    setSelected((cur) => {
                      const n = new Set(cur);
                      if (v) n.add(t.thread_id);
                      else n.delete(t.thread_id);
                      return n;
                    })
                  }
                />
              ))}
              {threads.hasNextPage && (
                <div className="p-3 text-center">
                  <Button size="sm" variant="ghost" loading={threads.isFetchingNextPage} onClick={() => threads.fetchNextPage()}>
                    Load more
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="p-6">
              <EmptyState icon={s.search ? <Search size={22} /> : <Inbox size={22} />} title={empty.title} description={empty.description} />
            </div>
          )}
        </div>
      </section>

      <section className={cn("min-w-0 flex-1 bg-bg", !s.thread && "hidden md:block")}>
        {s.thread ? (
          <ThreadView key={s.thread} threadId={s.thread} onClose={() => set({ thread: null })} onRemoved={removed} />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={<Mail size={22} />}
              title="Select a conversation"
              description={
                <>
                  Pick a conversation to read and reply. Press <Kbd>n</Kbd> for the next unread one, or <Kbd>?</Kbd> for all keyboard shortcuts.
                </>
              }
            />
          </div>
        )}
      </section>
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
      <NewEmailDialog open={composing} onOpenChange={setComposing} />
    </div>
  );
}

function FilterChip({ children, onClear }: { children: ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-panel-2 py-0.5 pl-2.5 pr-1 text-xs">
      <span className="truncate">{children}</span>
      <button type="button" aria-label="Remove filter" onClick={onClear} className="rounded-full p-0.5 text-faint hover:text-text">
        <X size={11} />
      </button>
    </span>
  );
}

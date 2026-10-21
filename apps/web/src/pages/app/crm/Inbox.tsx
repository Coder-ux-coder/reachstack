// /app/crm (plus /emails, /calls, /sms, /tasks, /upcoming and /archive[/type]) — the team inbox: lead replies,
// calls, texts and due tasks in one list, each opened beside it and cleared with "Done".
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, isToday } from "date-fns";
import { ArrowLeft, Check, CheckCheck, Inbox as InboxIcon, MessageSquare, Pencil, Phone, RefreshCw, SkipForward, Trash2, Undo2, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ApiError, del, errorMessage, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { todayIn, wallClock } from "@/lib/dates";
import { dateTime, plural, shortWhen } from "@/lib/format";
import { useLocalState, usePageTitle } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { Badge, Button, Callout, Checkbox, CopyButton, EmptyState, ErrorState, KeyValue, NativeSelect, SkeletonRows, Spinner, Textarea, Tooltip, useConfirm } from "@/components/ui";
import { LeadSheet } from "@/components/leads/LeadSheet";
import { TaskLinks } from "@/components/sequence/task-steps";
import { ThreadView } from "@/pages/app/unibox/ThreadView";
import {
  CallDialog,
  LeadTimeline,
  MEETING_STATUSES,
  MeetingDialog,
  OUTCOMES,
  SmsDialog,
  TaskDialog,
  TASK_TYPES,
  TYPE_META,
  TypeIcon,
  callStatusLabel,
  duration,
  outcomeLabel,
  smsSegments,
  taskDue,
  useCrmCounts,
  useCrmRefresh,
  usePhoneSettings,
  type CallOutcome,
  type CrmCall,
  type CrmMeeting,
  type CrmSms,
  type CrmTask,
  type FeedItem,
  type FeedType,
} from "./shared";

type View = "inbox" | "upcoming" | "archive";
const SEGMENT_TYPE: Record<string, FeedType> = { emails: "email", calls: "call", sms: "sms", tasks: "task" };
const TYPE_SEGMENT: Partial<Record<FeedType, string>> = { email: "emails", call: "calls", sms: "sms", task: "tasks" };
const TYPE_TABS: Array<{ type: FeedType | null; label: string }> = [
  { type: null, label: "Everything" },
  { type: "email", label: "Emails" },
  { type: "call", label: "Calls" },
  { type: "sms", label: "SMS" },
  { type: "task", label: "Tasks" },
];

function useRouteView() {
  const { pathname } = useLocation();
  const [, , , first, second] = pathname.replace(/\/+$/, "").split("/");
  const view: View = first === "upcoming" ? "upcoming" : first === "archive" ? "archive" : "inbox";
  const segment = view === "archive" ? second : view === "inbox" ? first : undefined;
  return { view, type: (segment && SEGMENT_TYPE[segment]) || null };
}

const pathFor = (view: View, type: FeedType | null) =>
  view === "upcoming" ? "/app/crm/upcoming" : `/app/crm${view === "archive" ? "/archive" : ""}${type && TYPE_SEGMENT[type] ? `/${TYPE_SEGMENT[type]}` : ""}`;

const who = (i: FeedItem) =>
  i.lead_name || i.lead_email || (i.meta.phone_number as string | undefined) || (i.type === "task" || i.type === "meeting" ? TYPE_META[i.type].label : "Unknown contact");

/** "3:00 PM" today, otherwise "Oct 14, 3:00 PM": for things booked at a time. */
const atTime = (iso: string) => (isToday(new Date(iso)) ? format(new Date(iso), "h:mm a") : format(new Date(iso), "MMM d, h:mm a"));

/** The same for a task's due time, on the workspace's clock (the one "due today" goes by). */
function dueAt(iso: string, zone: string) {
  try {
    const today = wallClock(iso, zone).date === todayIn(zone);
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...(today ? {} : { month: "short", day: "numeric" }), hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return atTime(iso);
  }
}

/** A pane's item that's gone (deleted, or not this workspace's) rather than one that couldn't be loaded. */
const gone = (e: unknown) => e instanceof ApiError && e.status === 404;

/** A sequence's task, done or skipped: its lead has moved on, so it can't go back to the inbox. */
const finishedSequenceTask = (i: FeedItem) => i.type === "task" && i.meta.source === "sequence" && i.status !== "open";

function whenLabel(i: FeedItem, view: View, zone: string) {
  if (i.type === "task" && i.due_at && i.status === "open") return `Due ${dueAt(i.due_at, zone)}`;
  if (i.type === "meeting") return atTime(i.at);
  return shortWhen(view === "archive" ? (i.done_at ?? i.at) : i.at);
}

function Chips({ item }: { item: FeedItem }) {
  const chips: Array<{ label: string; tone: "bad" | "warn" | "neutral" | "ok" | "info" }> = [];
  if (item.type === "task") {
    if (item.status === "skipped") chips.push({ label: "Skipped", tone: "neutral" });
    if (item.meta.overdue) chips.push({ label: "Overdue", tone: "bad" });
    if (item.meta.priority === "high") chips.push({ label: "High priority", tone: "warn" });
    const t = TASK_TYPES.find((x) => x.value === item.meta.task_type);
    if (t && t.value !== "todo") chips.push({ label: t.label, tone: "neutral" });
  }
  if (item.type === "call") {
    const label = callStatusLabel(item.status, item.direction);
    chips.push({ label: item.direction === "inbound" ? `Incoming · ${label}` : label, tone: label === "Missed" ? "bad" : "neutral" });
    if (item.meta.duration_sec) chips.push({ label: duration(item.meta.duration_sec as number), tone: "neutral" });
  }
  if (item.type === "meeting") chips.push({ label: MEETING_STATUSES.find((m) => m.value === item.status)?.label ?? "Meeting", tone: "info" });
  if (!chips.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {chips.map((c) => (
        <Badge key={c.label} tone={c.tone}>
          {c.label}
        </Badge>
      ))}
    </div>
  );
}

function FeedCard({
  item,
  view,
  active,
  checked,
  canWrite,
  onCheck,
  onOpen,
  onDone,
}: {
  item: FeedItem;
  view: View;
  active: boolean;
  checked: boolean;
  canWrite: boolean;
  onCheck: (v: boolean) => void;
  onOpen: () => void;
  onDone: () => void;
}) {
  const unread = item.type === "email" && !!item.meta.unread;
  const zone = useWorkspaceZone();
  return (
    <div
      role="button"
      tabIndex={0}
      data-key={item.key}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn("group flex cursor-pointer gap-2.5 border-b border-line px-3 py-3 outline-none hover:bg-panel-2 focus-visible:bg-panel-2", active && "bg-brand-soft hover:bg-brand-soft")}
    >
      {canWrite && (
        <div className="pt-1.5" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={checked} onChange={onCheck} aria-label={`Select ${item.title}`} />
        </div>
      )}
      <TypeIcon type={item.type} size={14} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className={cn("truncate text-[13px]", unread ? "font-semibold" : "font-medium")}>
            {unread && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand align-middle" aria-label="Unread" />}
            {who(item)}
            {item.company_name && <span className="font-normal text-muted"> · {item.company_name}</span>}
          </p>
          <span className={cn("shrink-0 text-xs", item.meta.overdue ? "text-bad" : "text-faint")}>{whenLabel(item, view, zone)}</span>
        </div>
        <p className="truncate text-[13px]">{item.title}</p>
        {item.preview && <p className="line-clamp-2 text-xs text-muted">{item.preview}</p>}
        <Chips item={item} />
      </div>
      {canWrite && view !== "upcoming" && !finishedSequenceTask(item) && (
        <Tooltip content={view === "archive" ? "Move to inbox" : "Mark as done"}>
          <Button
            size="icon-sm"
            variant="ghost"
            className="-mr-1 self-center md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
            aria-label={view === "archive" ? "Move to inbox" : "Mark as done"}
            onClick={(e) => {
              e.stopPropagation();
              onDone();
            }}
          >
            {view === "archive" ? <Undo2 size={14} /> : <Check size={15} />}
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

export default function CrmInbox() {
  usePageTitle("CRM");
  const { view, type } = useRouteView();
  const can = useCan();
  const qc = useQueryClient();
  const refresh = useCrmRefresh();
  const [params, setParams] = useSearchParams();
  const [owner, setOwner] = useLocalState<"all" | "me">("crm-inbox-owner", "all");
  // The counts on the tabs count what the list shows: everyone's, or only "Mine".
  const counts = useCrmCounts(owner === "me" ? "me" : undefined);
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<FeedItem | null>(null);
  const [leadSheet, setLeadSheet] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openKey = params.get("item");
  const canWrite = can.write;

  const feedQ = useQuery({
    queryKey: ["crm", "feed", view, type, owner, limit],
    queryFn: () => get<{ items: FeedItem[]; has_more: boolean }>("/api/app/crm/feed", { view, type: type ?? undefined, owner: owner === "me" ? "me" : undefined, limit }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => feedQ.data?.items ?? [], [feedQ.data]);

  useEffect(() => {
    setSelected(new Set());
    setLimit(50);
  }, [view, type, owner]);

  // Keep the open item in sync with the URL (deep links, back and forward).
  useEffect(() => {
    if (!openKey) return setCurrent(null);
    if (current?.key === openKey) return;
    const found = rows.find((r) => r.key === openKey);
    if (found) setCurrent(found);
  }, [openKey, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (item: FeedItem | null) => {
    setCurrent(item);
    setParams((p) => {
      if (item) p.set("item", item.key);
      else p.delete("item");
      return p;
    });
  };

  const setDone = async (chosen: FeedItem[], done: boolean) => {
    // Done tasks from sequences stay done: their leads have moved on.
    const stay = done ? 0 : chosen.filter(finishedSequenceTask).length;
    const items = done ? chosen : chosen.filter((i) => !finishedSequenceTask(i));
    if (!items.length) {
      if (stay) toast.error("A task from a sequence can't go back to the inbox: its lead has moved on to the next step.");
      return;
    }
    const movesLeads = done && items.some((i) => i.type === "task" && i.meta.source === "sequence");
    try {
      await post(`/api/app/crm/feed/${done ? "done" : "inbox"}`, { items: items.map((i) => ({ type: i.type, id: i.id })) });
      toast.success(done ? (items.length > 1 ? `${plural(items.length, "item")} marked as done` : "Marked as done") : items.length > 1 ? `${plural(items.length, "item")} moved to the inbox` : "Moved to the inbox", {
        description: movesLeads
          ? "Leads waiting for a task from a sequence go on to the next step."
          : stay
            ? `${plural(stay, "task")} from sequences stay done: their leads have moved on.`
            : undefined,
      });
      setSelected(new Set());
      if (current && items.some((i) => i.key === current.key)) {
        const idx = rows.findIndex((r) => r.key === current.key);
        const next = rows.slice(idx + 1).find((r) => !items.some((i) => i.key === r.key)) ?? rows.slice(0, idx).reverse().find((r) => !items.some((i) => i.key === r.key));
        open(next ?? null);
      }
      refresh();
      qc.invalidateQueries({ queryKey: ["unibox"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.key));
  const picked = rows.filter((r) => selected.has(r.key));
  const c = counts.data;
  const viewTabs: Array<{ view: View; label: string; n?: number }> = [
    { view: "inbox", label: "Inbox", n: c?.inbox.all },
    { view: "upcoming", label: "Upcoming", n: c?.upcoming },
    { view: "archive", label: "Archive" },
  ];
  const typeCount = (t: FeedType | null) => (view !== "inbox" || !c ? undefined : t ? c.inbox[t as keyof typeof c.inbox] : c.inbox.all);
  const empty =
    view === "archive"
      ? { title: "You have no done items", description: "Mark items as done to see them here." }
      : view === "upcoming"
        ? { title: "Nothing coming up", description: "Tasks due after today and scheduled meetings show here." }
        : { title: "All done for now!", description: "Enjoy your empty inbox. Lead replies, calls, texts and tasks due today land here." };

  return (
    <div className="flex h-full min-h-0">
      <section className={cn("flex min-h-0 w-full flex-col border-r border-line bg-panel md:w-[340px] md:shrink-0 xl:w-[400px]", current && "hidden md:flex")}>
        <div className="space-y-2 border-b border-line px-3 pb-2 pt-3">
          <div className="flex gap-1 rounded-lg bg-panel-2 p-0.5" role="tablist" aria-label="Inbox views">
            {viewTabs.map((t) => (
              <NavLink
                key={t.view}
                to={pathFor(t.view, t.view === "upcoming" ? null : type)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors",
                  view === t.view ? "bg-panel text-text shadow-sm" : "text-muted hover:text-text",
                )}
              >
                {t.label}
                {!!t.n && <span className="text-xs tabular-nums text-faint">{t.n > 999 ? "999+" : t.n}</span>}
              </NavLink>
            ))}
          </div>
          {view !== "upcoming" && (
            <nav className="flex flex-wrap gap-1" aria-label="Item types">
              {TYPE_TABS.map((t) => {
                const n = typeCount(t.type);
                return (
                  <NavLink
                    key={t.label}
                    to={pathFor(view, t.type)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                      type === t.type ? "border-brand bg-brand-soft text-brand-text" : "border-line text-muted hover:text-text",
                    )}
                  >
                    {t.label}
                    {!!n && <span className="tabular-nums opacity-70">{n}</span>}
                  </NavLink>
                );
              })}
            </nav>
          )}
          <div className="flex items-center gap-2">
            {canWrite && <Checkbox checked={allChecked ? true : selected.size ? "indeterminate" : false} onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.key)) : new Set())} aria-label="Select this page" className="ml-1" />}
            {selected.size > 0 && canWrite ? (
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <span className="mr-1 text-xs font-medium">{selected.size} selected</span>
                {view === "archive" ? (
                  <Button size="xs" icon={<Undo2 size={13} />} onClick={() => setDone(picked, false)}>
                    Move to inbox
                  </Button>
                ) : (
                  <Button size="xs" icon={<CheckCheck size={13} />} onClick={() => setDone(picked, true)}>
                    Done
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
                <NativeSelect
                  size="sm"
                  className="w-auto"
                  value={owner}
                  onChange={(v) => setOwner(v as "all" | "me")}
                  aria-label="Whose items"
                  options={[
                    { value: "all", label: "All users" },
                    { value: "me", label: "Mine" },
                  ]}
                />
                <Tooltip content="Refresh">
                  <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => refresh()}>
                    <RefreshCw size={14} className={cn(feedQ.isFetching && "animate-spin")} />
                  </Button>
                </Tooltip>
              </div>
            )}
          </div>
        </div>
        <div ref={listRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {feedQ.isLoading ? (
            <div className="p-3">
              <SkeletonRows rows={8} />
            </div>
          ) : feedQ.isError && !rows.length ? (
            <ErrorState title="The inbox couldn't be loaded" error={feedQ.error} onRetry={() => feedQ.refetch()} />
          ) : !rows.length ? (
            <EmptyState icon={<InboxIcon size={22} />} title={empty.title} description={empty.description} />
          ) : (
            <>
              {rows.map((item) => (
                <FeedCard
                  key={item.key}
                  item={item}
                  view={view}
                  active={current?.key === item.key}
                  checked={selected.has(item.key)}
                  canWrite={canWrite}
                  onCheck={(v) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (v) n.add(item.key);
                      else n.delete(item.key);
                      return n;
                    })
                  }
                  onOpen={() => open(item)}
                  onDone={() => setDone([item], view !== "archive")}
                />
              ))}
              {feedQ.data?.has_more && (
                <div className="p-3 text-center">
                  <Button size="sm" variant="ghost" loading={feedQ.isFetching} onClick={() => setLimit((l) => Math.min(500, l + 50))} disabled={limit >= 500}>
                    {limit >= 500 ? "Showing the newest 500" : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className={cn("min-h-0 min-w-0 flex-1 flex-col bg-bg", current ? "flex" : "hidden md:flex")}>
        {current ? (
          <ItemPane key={current.key} item={current} view={view} onClose={() => open(null)} onDone={(done) => setDone([current], done)} onOpenLead={(id) => setLeadSheet(id)} />
        ) : openKey && feedQ.isFetching ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <EmptyState className="m-auto" icon={<InboxIcon size={22} />} title="Pick an item" description="Open a reply, call, text or task from the list to see it here with the lead's history." />
        )}
      </section>
      <LeadSheet leadId={leadSheet} onClose={() => setLeadSheet(null)} onChanged={refresh} />
    </div>
  );
}

function PaneBar({ item, view, onClose, onDone, onOpenLead }: { item: FeedItem; view: View; onClose: () => void; onDone: (done: boolean) => void; onOpenLead: (id: string) => void }) {
  const can = useCan();
  return (
    <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2.5 sm:px-4">
      <Button size="icon-sm" variant="ghost" aria-label="Back to the list" className="md:hidden" onClick={onClose}>
        <ArrowLeft size={16} />
      </Button>
      <TypeIcon type={item.type} size={14} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold">{who(item)}</p>
        <p className="truncate text-xs text-muted">{item.lead_email && item.lead_name ? item.lead_email : item.company_name || " "}</p>
      </div>
      {item.lead_id && (
        <Tooltip content="Lead details">
          <Button size="icon-sm" variant="ghost" aria-label="Lead details" onClick={() => onOpenLead(item.lead_id!)}>
            <UserRound size={15} />
          </Button>
        </Tooltip>
      )}
      {can.write && view !== "upcoming" && item.type !== "task" && (
        <Button size="sm" variant={view === "archive" ? "secondary" : "primary"} icon={view === "archive" ? <Undo2 size={14} /> : <Check size={14} />} onClick={() => onDone(view !== "archive")}>
          {view === "archive" ? "Move to inbox" : "Done"}
        </Button>
      )}
    </div>
  );
}

function ItemPane({ item, view, onClose, onDone, onOpenLead }: { item: FeedItem; view: View; onClose: () => void; onDone: (done: boolean) => void; onOpenLead: (id: string) => void }) {
  if (item.type === "email" && item.thread_id)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PaneBar item={item} view={view} onClose={onClose} onDone={onDone} onOpenLead={onOpenLead} />
        <div className="min-h-0 flex-1 bg-panel">
          <ThreadView threadId={item.thread_id} onClose={onClose} onRemoved={onClose} />
        </div>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneBar item={item} view={view} onClose={onClose} onDone={onDone} onOpenLead={onOpenLead} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
          {item.type === "call" && <CallPane id={item.id} onDeleted={onClose} />}
          {item.type === "sms" && <SmsPane item={item} />}
          {item.type === "task" && <TaskPane id={item.id} onDeleted={onClose} />}
          {item.type === "meeting" && <MeetingPane id={item.id} />}
          {item.lead_email && (
            <section>
              <h3 className="mb-3 text-[13px] font-semibold text-muted">Activity with {item.lead_name || item.lead_email}</h3>
              <LeadTimeline leadEmail={item.lead_email} leadId={item.lead_id} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function PaneCard({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-line bg-panel p-4 shadow-card sm:p-5">{children}</div>;
}

function CallPane({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const can = useCan();
  const confirm = useConfirm();
  const refresh = useCrmRefresh();
  const q = useQuery({ queryKey: ["crm", "call", id], queryFn: () => get<CrmCall>(`/api/app/crm/calls/${id}`) });
  const [notes, setNotes] = useState("");
  const [outcome, setOutcome] = useState("");
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<"call" | "sms" | null>(null);
  const call = q.data;
  useEffect(() => {
    if (!call) return;
    setNotes(call.notes ?? "");
    setOutcome(call.outcome ?? "");
  }, [call?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <SkeletonRows rows={4} />;
  if (q.isError && !gone(q.error)) return <ErrorState title="This call couldn't be loaded" error={q.error} onRetry={() => q.refetch()} />;
  if (!call) return <Callout tone="bad">This call isn't available anymore.</Callout>;
  const dirty = notes !== (call.notes ?? "") || outcome !== (call.outcome ?? "");
  const save = async () => {
    setSaving(true);
    try {
      await patch(`/api/app/crm/calls/${call.id}`, { notes: notes.trim() || null, outcome: (outcome || null) as CallOutcome | null });
      toast.success("Call updated");
      q.refetch();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: "Delete this call?", description: "The call and its notes are removed from the CRM.", confirmLabel: "Delete call", danger: true }))) return;
    try {
      await del(`/api/app/crm/calls/${call.id}`);
      toast.success("Call deleted");
      refresh();
      onDeleted();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const status = callStatusLabel(call.status, call.direction);
  return (
    <PaneCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{call.direction === "inbound" ? "Incoming call" : "Outgoing call"}</h2>
          <p className="text-xs text-muted">{dateTime(call.timestamp_created)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Phone size={14} />} onClick={() => setDialog("call")}>
            Call back
          </Button>
          <Button size="sm" icon={<MessageSquare size={14} />} onClick={() => setDialog("sms")}>
            Text
          </Button>
          {can.write && (
            <Button size="icon-sm" variant="ghost" aria-label="Delete call" onClick={remove}>
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      </div>
      <KeyValue
        className="mt-4"
        items={[
          ["Status", <Badge tone={status === "Missed" ? "bad" : status === "Completed" ? "ok" : "neutral"}>{status}</Badge>],
          [call.direction === "inbound" ? "From" : "To", call.phone_number],
          ...(call.from_number ? [[call.direction === "inbound" ? "To" : "From", call.from_number] as [string, string]] : []),
          ["Length", duration(call.duration_sec)],
          ["Outcome", outcomeLabel(call.outcome) ?? "–"],
          ["Logged by", call.created_by_name ?? "–"],
        ]}
      />
      {can.write && (
        <div className="mt-5 space-y-3 border-t border-line pt-4">
          <NativeSelect value={outcome} onChange={setOutcome} aria-label="Outcome" options={[{ value: "", label: "No outcome" }, ...OUTCOMES]} className="sm:w-60" />
          <Textarea rows={4} value={notes} maxLength={20_000} onChange={(e) => setNotes(e.target.value)} placeholder="Call notes" aria-label="Call notes" />
          {dirty && (
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNotes(call.notes ?? "");
                  setOutcome(call.outcome ?? "");
                }}
              >
                Discard
              </Button>
              <Button size="sm" variant="primary" loading={saving} onClick={save}>
                Save
              </Button>
            </div>
          )}
        </div>
      )}
      <CallDialog open={dialog === "call"} onOpenChange={(v) => !v && setDialog(null)} leadEmail={call.lead_email} phone={call.phone_number} />
      <SmsDialog open={dialog === "sms"} onOpenChange={(v) => !v && setDialog(null)} leadEmail={call.lead_email} phone={call.phone_number} />
    </PaneCard>
  );
}

/** The whole text conversation with one number, with a reply box. */
function SmsPane({ item }: { item: FeedItem }) {
  const can = useCan();
  const refresh = useCrmRefresh();
  const phone = String(item.meta.phone_number ?? "");
  const settings = usePhoneSettings();
  const q = useQuery({
    queryKey: ["crm", "sms-thread", phone],
    queryFn: () => get<{ items: CrmSms[]; twilio: boolean }>("/api/app/crm/sms", { phone, limit: 200 }),
    refetchInterval: 15_000,
    enabled: !!phone,
  });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => [...(q.data?.items ?? [])].reverse(), [q.data]);
  useEffect(() => bottom.current?.scrollIntoView({ block: "nearest" }), [messages.length]);
  const ready = !!settings.data?.twilio_configured && (settings.data?.numbers.length ?? 0) > 0;

  const send = async () => {
    // Ctrl+Enter skips the button: the same check stops a second text while the first is going out.
    if (sending || !text.trim()) return;
    setSending(true);
    try {
      await post("/api/app/crm/sms", { to: phone, body: text.trim(), lead_email: item.lead_email });
      setText("");
      q.refetch();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <PaneCard>
      <h2 className="text-[15px] font-semibold">Text messages with {phone}</h2>
      <div className="mt-4 space-y-2">
        {q.isLoading ? (
          <SkeletonRows rows={3} />
        ) : (
          messages.map((m) => (
            <div key={m.id} className={cn("flex", m.direction === "outbound" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px]", m.direction === "outbound" ? "rounded-br-sm bg-brand text-on-brand" : "rounded-bl-sm bg-panel-2")}>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className={cn("mt-1 text-[11px]", m.direction === "outbound" ? "text-white/75" : "text-faint")}>
                  {shortWhen(m.timestamp_created)}
                  {m.direction === "outbound" && m.created_by_name ? ` · ${m.created_by_name}` : ""}
                  {m.status === "failed" || m.status === "undelivered" ? " · Not delivered" : ""}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>
      {can.write && (
        <div className="mt-4 border-t border-line pt-4">
          {settings.data && !ready ? (
            <Callout tone="warn">Replying needs Twilio and a phone number that can send texts. Set them up in Calls & SMS settings.</Callout>
          ) : (
            <>
              <Textarea
                rows={3}
                value={text}
                maxLength={1600}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
                }}
                placeholder="Type your message here…"
                aria-label="Reply"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-faint">{text ? `${text.length} / 1600 · ${plural(smsSegments(text), "text")}` : ""}</span>
                <Button size="sm" variant="primary" icon={<MessageSquare size={14} />} loading={sending} disabled={!text.trim()} onClick={send}>
                  Send
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </PaneCard>
  );
}

function TaskPane({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const can = useCan();
  const confirm = useConfirm();
  const refresh = useCrmRefresh();
  const q = useQuery({ queryKey: ["crm", "task", id], queryFn: () => get<CrmTask>(`/api/app/crm/tasks/${id}`) });
  const zone = useWorkspaceZone();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const task = q.data;
  if (q.isLoading) return <SkeletonRows rows={4} />;
  if (q.isError && !gone(q.error)) return <ErrorState title="This task couldn't be loaded" error={q.error} onRetry={() => q.refetch()} />;
  if (!task) return <Callout tone="bad">This task isn't available anymore.</Callout>;
  // A sequence's task: done or skipped, its lead goes on to the next step, and that can't be undone.
  const fromSequence = task.source === "sequence";
  const finished = task.status !== "open";

  const setStatus = async (status: "open" | "done" | "skipped") => {
    setBusy(true);
    try {
      await patch(`/api/app/crm/tasks/${task.id}`, { status });
      toast.success(status === "open" ? "Task reopened" : status === "skipped" ? "Task skipped" : "Task completed", {
        description: fromSequence && status !== "open" ? "Its lead moves on in the sequence." : undefined,
      });
      q.refetch();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => setStatus(finished ? "open" : "done");
  const remove = async () => {
    const waiting = fromSequence && !finished;
    if (!(await confirm({ title: "Delete this task?", description: waiting ? "Its lead is waiting for it: deleting it skips it, and the lead goes on to the next step." : undefined, confirmLabel: "Delete task", danger: true }))) return;
    try {
      await del(`/api/app/crm/tasks/${task.id}`);
      toast.success("Task deleted");
      refresh();
      onDeleted();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <PaneCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={cn("text-[15px] font-semibold", finished && "text-muted line-through")}>{task.title}</h2>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {task.status === "done" ? <Badge tone="ok">Done</Badge> : task.status === "skipped" ? <Badge>Skipped</Badge> : task.overdue ? <Badge tone="bad">Overdue</Badge> : <Badge>Open</Badge>}
            {task.priority === "high" && <Badge tone="warn">High priority</Badge>}
            <Badge>{TASK_TYPES.find((t) => t.value === task.type)?.label ?? task.type}</Badge>
          </div>
        </div>
        {can.write && (
          <div className="flex flex-wrap gap-1.5">
            {!(fromSequence && finished) && (
              <Button size="sm" variant={finished ? "secondary" : "primary"} icon={finished ? <Undo2 size={14} /> : <Check size={14} />} loading={busy} onClick={toggle}>
                {finished ? "Mark as active" : "Mark as done"}
              </Button>
            )}
            {fromSequence && !finished && (
              <Button size="sm" icon={<SkipForward size={14} />} disabled={busy} onClick={() => setStatus("skipped")} title="Move the lead on without doing it">
                Skip
              </Button>
            )}
            <Button size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Delete task" onClick={remove}>
              <Trash2 size={14} />
            </Button>
          </div>
        )}
      </div>
      {task.description &&
        (fromSequence ? (
          // A sequence's note: the invitation or message to send, or what to say on the call.
          <div className="mt-4 flex items-start justify-between gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
            <p className="min-w-0 whitespace-pre-wrap break-words text-[13px]">{task.description}</p>
            <CopyButton value={task.description} label="Copy" className="shrink-0" />
          </div>
        ) : (
          <p className="mt-4 whitespace-pre-wrap text-[13px]">{task.description}</p>
        ))}
      {!finished && (
        <TaskLinks
          className="mt-3"
          kind={task.step_kind ?? (task.type === "call" ? "call" : null)}
          lead={{
            name: task.lead_name,
            email: task.lead_email,
            company_name: task.company_name,
            linkedin_url: task.lead_linkedin_url,
            phone: task.lead_phone,
            location: task.lead_location,
            timezone: task.lead_timezone,
          }}
        />
      )}
      <KeyValue
        className="mt-4"
        items={[
          ["Due", task.due_at ? taskDue(task.due_at, zone) : "No due date"],
          ["Assigned to", task.assigned_to_name ?? "Unassigned"],
          ["Contact", task.lead_email ?? "–"],
          ...(fromSequence && task.campaign_id
            ? [
                [
                  "From",
                  <Link key="from" className="text-brand-text hover:underline" to={task.subsequence_id ? `/app/campaign/${task.campaign_id}/subsequences/${task.subsequence_id}/sequences` : `/app/campaign/${task.campaign_id}/sequences`}>
                    {(task.subsequence_id ? task.subsequence_name : task.campaign_name) ?? (task.subsequence_id ? "Subsequence" : "Campaign")}, step {task.step}
                  </Link>,
                ] as [string, ReactNode],
              ]
            : []),
          ["Created", `${dateTime(task.timestamp_created)}${task.created_by_name ? ` by ${task.created_by_name}` : task.source !== "manual" ? " automatically" : ""}`],
          ...(task.completed_at ? [[task.status === "skipped" ? "Skipped" : "Completed", dateTime(task.completed_at)] as [string, string]] : []),
        ]}
      />
      <TaskDialog
        open={editing}
        onOpenChange={setEditing}
        task={task}
        onSaved={() => {
          q.refetch();
        }}
      />
    </PaneCard>
  );
}

function MeetingPane({ id }: { id: string }) {
  const can = useCan();
  const refresh = useCrmRefresh();
  const q = useQuery({ queryKey: ["crm", "meeting", id], queryFn: () => get<CrmMeeting>(`/api/app/crm/meetings/${id}`) });
  const [editing, setEditing] = useState(false);
  const m = q.data;
  if (q.isLoading) return <SkeletonRows rows={4} />;
  if (q.isError && !gone(q.error)) return <ErrorState title="This meeting couldn't be loaded" error={q.error} onRetry={() => q.refetch()} />;
  if (!m) return <Callout tone="bad">This meeting isn't available anymore.</Callout>;
  const setStatus = async (status: "completed" | "no_show") => {
    try {
      await patch(`/api/app/crm/meetings/${m.id}`, { status, set_lead_status: true });
      toast.success(status === "completed" ? "Meeting marked as completed" : "Marked as a no show");
      q.refetch();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <PaneCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{m.title}</h2>
          <p className="text-xs text-muted">
            {dateTime(m.start_at)}
            {m.end_at ? ` – ${new Date(m.end_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
          </p>
        </div>
        {can.write && (
          <div className="flex flex-wrap gap-1.5">
            {m.status === "scheduled" && (
              <>
                <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => setStatus("completed")}>
                  Completed
                </Button>
                <Button size="sm" onClick={() => setStatus("no_show")}>
                  No show
                </Button>
              </>
            )}
            <Button size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        )}
      </div>
      <KeyValue
        className="mt-4"
        items={[
          ["Status", MEETING_STATUSES.find((s) => s.value === m.status)?.label ?? m.status],
          ["Where", m.location || "–"],
          ["Contact", m.lead_email ?? "–"],
        ]}
      />
      {m.notes && <p className="mt-4 whitespace-pre-wrap text-[13px]">{m.notes}</p>}
      <MeetingDialog
        open={editing}
        onOpenChange={(v) => {
          setEditing(v);
          if (!v) q.refetch();
        }}
        meeting={m}
      />
    </PaneCard>
  );
}

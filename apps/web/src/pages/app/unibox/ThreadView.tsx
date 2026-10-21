import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays } from "date-fns";
import { toast } from "sonner";
import {
  AlarmClock,
  ArrowLeft,
  BellOff,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Clock,
  Download,
  Forward,
  Inbox,
  Link2,
  MailOpen,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Sparkles,
  Tag,
  Trash2,
  Undo2,
  XCircle,
} from "lucide-react";
import { ApiError, del, errorMessage, get, patch, post } from "@/lib/api";
import { dateTime, humanizeTimestamps, plural, shortWhen } from "@/lib/format";
import { useMediaQuery } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useLeadStatuses, type StatusMeta } from "@/lib/statuses";
import { cn } from "@/lib/cn";
import { EmailFrame } from "@/components/EmailFrame";
import { InterestBadge } from "@/components/status";
import { Avatar, Badge, Button, Callout, EmptyState, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Popover, Sheet, Skeleton, Tooltip, useConfirm } from "@/components/ui";
import { Composer, type ComposeMode } from "./Composer";
import { LeadPanel } from "./LeadPanel";
import {
  REMINDER_PRESETS,
  SUMMARY_KEY,
  bodyHtml,
  cleanPreview,
  downloadFile,
  fileSize,
  isReceived,
  isScheduled,
  isShortcut,
  sender,
  splitAddresses,
  toLocalInput,
  useRefreshUnibox,
  useUniboxSummary,
  type Email,
  type ThreadDetail,
} from "./shared";

/** Downloads with a progress toast; errors show the server's message. */
async function download(path: string, query?: Record<string, string>) {
  const id = toast.loading("Preparing the download…");
  try {
    await downloadFile(path, query);
    toast.success("Downloaded", { id });
  } catch (e) {
    toast.error(errorMessage(e), { id });
  }
}

function Attachments({ email }: { email: Email }) {
  const files = email.attachment_json?.files ?? [];
  if (!files.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {files.map((f) => {
        const image = /^image\/(png|jpe?g|gif|webp)$/i.test(f.content_type);
        return (
          <a
            key={f.id}
            href={`/api/app/attachments/${f.id}${image ? "?inline=1" : ""}`}
            target="_blank"
            rel="noreferrer noopener"
            className="group inline-flex max-w-[16rem] items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-xs hover:border-line-strong"
          >
            {image ? <img src={`/api/app/attachments/${f.id}?inline=1`} alt="" className="h-8 w-8 rounded object-cover" /> : <Paperclip size={13} className="shrink-0 text-faint" />}
            <span className="min-w-0">
              <span className="block truncate font-medium">{f.filename}</span>
              <span className="text-faint">{fileSize(f.size)}</span>
            </span>
            <Download size={12} className="ml-1 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
          </a>
        );
      })}
    </div>
  );
}

function ScheduledBar({ email, onChanged }: { email: Email; onChanged: () => void }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Still scheduled but with no time: it was tried and didn't go out (why shows above). It waits here for a decision.
  const unsent = !email.scheduled_at;
  const [at, setAt] = useState(() => toLocalInput(new Date(email.scheduled_at ?? Date.now() + 3600_000)));
  const when = new Date(at);
  const cancel = async () => {
    // The scheduled email is deleted with what was written in it, and there's no undo.
    const ok = await confirm(
      unsent
        ? { title: "Discard this email?", description: "What you wrote is deleted, and nothing is sent.", confirmLabel: "Discard", cancelLabel: "Keep it", danger: true }
        : {
            title: "Cancel this scheduled email?",
            description: "It won't be sent, and what you wrote is deleted. To send it at another time, reschedule it instead.",
            confirmLabel: "Cancel send",
            cancelLabel: "Keep it",
            danger: true,
          },
    );
    if (!ok) return;
    try {
      await post(`/api/app/emails/${email.id}/cancel-scheduled`);
      toast.success(unsent ? "Email discarded" : "Scheduled email cancelled");
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const move = async (body: { scheduled_at: string } | { now: true }, done: string) => {
    setBusy(true);
    try {
      await post(`/api/app/emails/${email.id}/reschedule`, body);
      toast.success(done);
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("mt-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px]", unsent ? "bg-warn-soft text-warn" : "bg-info-soft text-info")}>
      <CalendarClock size={14} />
      <span className="flex-1">{unsent ? "This email wasn't sent." : `Scheduled to send ${dateTime(email.scheduled_at)}`}</span>
      <Button size="xs" variant={unsent ? "primary" : "ghost"} loading={busy} onClick={() => move({ now: true }, "It goes out in a few seconds")}>
        Send now
      </Button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="w-64"
        trigger={
          <Button size="xs" variant="ghost">
            {unsent ? "Pick a time" : "Reschedule"}
          </Button>
        }
      >
        <Input inputSize="sm" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="New send time" />
        <Button
          size="sm"
          variant="primary"
          className="mt-2 w-full"
          loading={busy}
          disabled={Number.isNaN(when.getTime()) || when.getTime() <= Date.now()}
          onClick={() => move({ scheduled_at: when.toISOString() }, `Scheduled for ${dateTime(when)}`)}
        >
          Save time
        </Button>
      </Popover>
      <Button size="xs" variant="ghost" className="text-bad" onClick={cancel}>
        {unsent ? "Discard" : "Cancel send"}
      </Button>
    </div>
  );
}

function MessageCard({
  email,
  expanded,
  onToggle,
  onCompose,
  onChanged,
  canWrite,
}: {
  email: Email;
  expanded: boolean;
  onToggle: () => void;
  onCompose: (mode: ComposeMode, target: Email) => void;
  onChanged: () => void;
  canWrite: boolean;
}) {
  const confirm = useConfirm();
  const from = sender(email);
  const received = isReceived(email);
  const to = splitAddresses(email.to_address_email_list);
  const cc = splitAddresses(email.cc_address_email_list);
  const step = email.step !== null && email.step !== undefined && email.step !== "" ? Number(email.step) + 1 : null;
  const removeReminder = async () => {
    try {
      await patch(`/api/v2/emails/${email.id}`, { reminder_ts: null });
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (!expanded) {
    return (
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel px-4 py-2.5 text-left hover:bg-panel-2">
        <Avatar name={from.name} email={from.address} size={24} />
        <span className="w-40 shrink-0 truncate text-[13px] font-medium">{from.name || from.address}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{cleanPreview(email.content_preview || email.body.text)}</span>
        <span className="shrink-0 text-xs text-faint">{shortWhen(email.timestamp_email)}</span>
      </button>
    );
  }

  return (
    <article className={cn("rounded-xl border bg-panel", received ? "border-line" : "border-line", isScheduled(email) && "border-dashed border-info")}>
      <header className="flex items-start gap-3 px-4 pt-3.5">
        <Avatar name={from.name} email={from.address} size={32} />
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left" aria-label="Collapse message">
          <p className="truncate text-[13px]">
            <span className="font-semibold">{from.name || from.address}</span>
            {from.name && <span className="ml-1.5 text-muted">&lt;{from.address}&gt;</span>}
          </p>
          <p className="truncate text-xs text-muted">
            to {to.join(", ") || "—"}
            {cc.length > 0 && ` · cc ${cc.join(", ")}`}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {!received && email.campaign_id && step !== null && <Badge>{email.subsequence_id ? "Subsequence" : "Campaign"} · Step {step}</Badge>}
          {email.is_auto_reply ? <Badge tone="neutral">Auto-reply</Badge> : null}
          {email.is_bounce ? <Badge tone="bad">Bounce</Badge> : null}
          {email.ai_agent_id || email.ai_assisted ? (
            <Badge tone="brand">
              <Sparkles size={11} className="mr-0.5" />
              AI
            </Badge>
          ) : null}
          <Tooltip content={dateTime(email.timestamp_email)}>
            <span className="ml-1 text-xs text-faint">{shortWhen(email.timestamp_email)}</span>
          </Tooltip>
          {canWrite && !isScheduled(email) && (
            <Menu>
              <MenuTrigger asChild>
                <button type="button" aria-label="Message actions" className="rounded-md p-1 text-faint hover:bg-panel-2 hover:text-text">
                  <MoreHorizontal size={15} />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Reply size={14} />} onSelect={() => onCompose("reply", email)}>
                  Reply
                </MenuItem>
                <MenuItem icon={<ReplyAll size={14} />} onSelect={() => onCompose("reply_all", email)}>
                  Reply all
                </MenuItem>
                <MenuItem icon={<Forward size={14} />} onSelect={() => onCompose("forward", email)}>
                  Forward
                </MenuItem>
                <MenuItem icon={<Download size={14} />} onSelect={() => download(`/api/app/unibox/emails/${email.id}/eml`)}>
                  Download as .eml
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 size={14} />}
                  onSelect={async () => {
                    if (!(await confirm({ title: "Delete this email?", description: "It is removed from the Unibox. The copy in the mailbox itself is not touched.", confirmLabel: "Delete", danger: true }))) return;
                    try {
                      await del(`/api/v2/emails/${email.id}`);
                      onChanged();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Delete email
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </header>
      <div className="px-4 pb-4 pl-[60px] pt-2">
        {email.send_error && (
          <Callout tone="bad" className="mb-3" title="Not sent">
            {humanizeTimestamps(email.send_error)}
          </Callout>
        )}
        <EmailFrame html={bodyHtml(email)} minHeight={40} />
        <Attachments email={email} />
        {email.reminder_ts && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            <AlarmClock size={14} />
            <span className="flex-1">Reminder {dateTime(email.reminder_ts)}</span>
            {canWrite && (
              <button type="button" className="text-xs font-medium hover:underline" onClick={removeReminder}>
                Remove reminder
              </button>
            )}
          </div>
        )}
        {isScheduled(email) && canWrite && <ScheduledBar email={email} onChanged={onChanged} />}
      </div>
    </article>
  );
}

function ReminderMenu({ thread, onChanged }: { thread: ThreadDetail; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(() => toLocalInput(REMINDER_PRESETS[0]!.at()));
  const current = thread.emails.map((e) => e.reminder_ts).filter((x): x is string => !!x).sort()[0];
  const setReminder = async (at: Date) => {
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) return toast.error("Choose a future date.");
    try {
      await patch(`/api/v2/emails/${thread.reply_target_id}`, { reminder_ts: at.toISOString() });
      toast.success(`Reminder set for ${dateTime(at)}`);
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const clear = async () => {
    try {
      await post("/api/app/unibox/bulk", { thread_ids: [thread.thread_id], action: "clear_reminder" });
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-64 p-1.5"
      trigger={
        <Button size="icon-sm" variant="ghost" aria-label="Set reminder" className={cn(current && "text-warn")}>
          <AlarmClock size={15} />
        </Button>
      }
    >
      <p className="px-2 pb-1 pt-1 text-xs font-medium text-faint">{current ? `Reminder ${dateTime(current)}` : "Remind me about this conversation"}</p>
      {REMINDER_PRESETS.map((p) => (
        <button key={p.key} type="button" onClick={() => setReminder(p.at())} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-panel-2">
          {p.label}
          <span className="text-xs text-faint">{shortWhen(p.at())}</span>
        </button>
      ))}
      <div className="mt-1 border-t border-line p-1.5">
        <Input inputSize="sm" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Reminder date" />
        <Button size="xs" className="mt-1.5 w-full" onClick={() => setReminder(new Date(custom))}>
          Set reminder
        </Button>
      </div>
      {current && (
        <button type="button" onClick={clear} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-bad hover:bg-panel-2">
          <BellOff size={14} /> Remove reminder
        </button>
      )}
    </Popover>
  );
}

/** The label menu. Its first nine labels are numbered: pressing 1–9 applies the same label. */
/** The conversation's label: the lead's interest status, or the one its emails carry. */
const labelOf = (t: ThreadDetail) => t.lead?.lt_interest_status ?? t.emails.find((e) => e.i_status !== null)?.i_status ?? null;

function LabelMenu({ labels, current, onApply }: { labels: StatusMeta[]; current: number | null; onApply: (code: number | null) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Label (1 to 9)" title="Label (1–9)">
          <Tag size={15} />
        </Button>
      </MenuTrigger>
      <MenuContent className="scroll-thin max-h-80 overflow-y-auto">
        {labels.map((st, i) => (
          <MenuItem key={st.code} onSelect={() => onApply(st.code)} shortcut={i < 9 ? String(i + 1) : undefined} icon={<span className="h-2 w-2 rounded-full" style={{ background: st.color }} />}>
            <span className="flex items-center gap-1.5">
              {st.label}
              {st.code === current && <Check size={13} className="text-brand" aria-label="Current label" />}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => onApply(null)} disabled={current === null}>
          Clear label
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** The newest email that went out or came in: replies and forwards answer that, never one still scheduled. */
const lastSent = (emails: Email[]) => [...emails].reverse().find((e) => !isScheduled(e));

export function ThreadView({ threadId, onClose, onRemoved }: { threadId: string; onClose: () => void; onRemoved: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const statuses = useLeadStatuses();
  const summary = useUniboxSummary();
  const refreshAll = useRefreshUnibox();
  const canWrite = can.write;
  const [compose, setCompose] = useState<{ mode: ComposeMode; targetId: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [panel, setPanel] = useState(true);
  const [leadSheet, setLeadSheet] = useState(false);
  // The lead panel sits beside the conversation on wide screens and opens as a drawer otherwise.
  const wide = useMediaQuery("(min-width: 1536px)");
  // Narrow screens keep fewer buttons in the header; the rest move into "More actions".
  const roomy = useMediaQuery("(min-width: 640px)");
  const labelable = can.perm("leads") && canWrite;

  // Reading a thread marks it read, except right after "mark as unread" (the refetch must not undo it).
  const markRead = useRef(true);
  const q = useQuery({
    queryKey: ["unibox", "thread", threadId],
    queryFn: () => get<ThreadDetail>(`/api/app/unibox/threads/${threadId}`, { mark_read: markRead.current ? 1 : undefined }),
    retry: false,
  });
  const t = q.data;

  // Opening a thread marks it read, and so does a new message arriving while it's open: refresh the list and counters.
  useEffect(() => {
    if (!t) return;
    qc.invalidateQueries({ queryKey: ["unibox", "threads"] });
    qc.invalidateQueries({ queryKey: SUMMARY_KEY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.thread_id, t?.emails.length]);

  // New thread: latest message, unread replies and scheduled sends start expanded; the composer closes.
  useEffect(() => {
    setCompose(null);
    setShowAll(false);
  }, [threadId]);
  useEffect(() => {
    if (!t) return;
    const last = t.emails[t.emails.length - 1];
    setExpanded(new Set([...(last ? [last.id] : []), ...t.emails.filter((e) => (isReceived(e) && e.is_unread) || isScheduled(e) || e.send_error).map((e) => e.id)]));
  }, [t?.thread_id, t?.emails.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const sentEmails = (t?.emails ?? []).filter((e) => !isScheduled(e));
  // Done: every email in the thread was marked done (a new reply arrives not done, so the thread is back in the inbox).
  const isDone = sentEmails.length > 0 && sentEmails.every((e) => e.marked_as_done);

  /** e: mark as done and open the next conversation (with undo), or move a done conversation back to the inbox. */
  const toggleDone = async () => {
    if (isDone) return bulk("mark_not_done", "Moved back to the inbox");
    try {
      await post("/api/app/unibox/bulk", { thread_ids: [threadId], action: "mark_done" });
    } catch (e) {
      return toast.error(errorMessage(e));
    }
    markRead.current = false;
    onRemoved();
    qc.invalidateQueries({ queryKey: ["unibox", "threads"] });
    qc.invalidateQueries({ queryKey: SUMMARY_KEY });
    toast.success("Marked as done", {
      action: {
        label: "Undo",
        onClick: () =>
          post("/api/app/unibox/bulk", { thread_ids: [threadId], action: "mark_not_done" })
            .then(() => qc.invalidateQueries({ queryKey: ["unibox"] }))
            .catch((e) => toast.error(errorMessage(e))),
      },
    });
  };

  /** 1–9 and the label menu: sets the lead's label (its interest status), like the lead panel does. */
  const applyLabel = async (code: number | null) => {
    if (!t) return;
    if (!labelable) return toast.error("Your role can't change lead labels.");
    const email = t.lead?.email ?? t.emails.find((e) => e.lead)?.lead;
    if (!email) return toast.error("This conversation has no lead to label.");
    const label = statuses.all.find((x) => x.code === code)?.label;
    // Same label again: nothing to change, and nothing to set off (automations run on label changes).
    if (code === labelOf(t)) return toast(label ? `Already marked as ${label}` : "This conversation has no label.");
    try {
      // The conversation's lead (the workspace's sync setting carries it to the person's other leads); without one, by address.
      await (t.lead?.id
        ? post("/api/app/leads/status", { ids: [t.lead.id], action: "interest", interest_value: code })
        : post("/api/v2/leads/update-interest-status", { lead_email: email, interest_value: code }));
      toast.success(label ? `Marked as ${label}` : "Label removed");
      refreshAll();
    } catch (e) {
      toast.error(e instanceof ApiError && e.status === 404 ? "This sender isn't a lead in this workspace yet, so the conversation can't be labelled." : errorMessage(e));
    }
  };

  // Keyboard: r reply, a reply all, f forward, e done, 1–9 label. The list's keys (j, k, n, /, ?, Esc) are in Unibox.tsx.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!t || !isShortcut(e)) return;
      const sent = lastSent(t.emails);
      if (canWrite && sent && e.key === "r") setCompose({ mode: "reply", targetId: t.reply_target_id });
      else if (canWrite && sent && e.key === "a") setCompose({ mode: "reply_all", targetId: t.reply_target_id });
      else if (canWrite && sent && e.key === "f") setCompose({ mode: "forward", targetId: sent.id });
      else if (canWrite && e.key === "e") void toggleDone();
      else if (/^[1-9]$/.test(e.key) && statuses.all[Number(e.key) - 1]) void applyLabel(statuses.all[Number(e.key) - 1]!.code);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const visible = useMemo(() => {
    const emails = t?.emails ?? [];
    if (showAll || emails.length <= 4) return emails.map((e) => ({ email: e }));
    return [{ email: emails[0]! }, { more: emails.length - 3 }, ...emails.slice(-2).map((e) => ({ email: e }))];
  }, [t, showAll]);

  /** Runs a thread action; `leave` closes the thread first (delete, mark unread) so it isn't reloaded. */
  const bulk = async (action: string, done?: string, leave?: () => void) => {
    try {
      await post("/api/app/unibox/bulk", { thread_ids: [threadId], action });
      if (done) toast.success(done);
      if (leave) {
        markRead.current = false;
        leave();
        qc.invalidateQueries({ queryKey: ["unibox", "threads"] });
        qc.invalidateQueries({ queryKey: SUMMARY_KEY });
      } else refreshAll();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Gone (deleted, or not this workspace's): say so. A refresh that failed for another reason keeps what's shown.
  if (q.isError && (!t || (q.error instanceof ApiError && q.error.status === 404))) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState icon={<Inbox size={22} />} title="This conversation isn't available" description="It may have been deleted. Pick another conversation from the list." action={<Button onClick={onClose}>Back to the list</Button>} />
      </div>
    );
  }
  if (!t) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  const first = t.emails[0]!;
  const last = t.emails[t.emails.length - 1]!;
  const focused = (t.emails.find(isReceived) ?? first).is_focused !== 0;
  const lastReal = lastSent(t.emails);
  const target = compose ? (t.emails.find((e) => e.id === compose.targetId) ?? lastReal ?? last) : null;
  const interest = labelOf(t);
  const days = lastReal ? differenceInCalendarDays(new Date(), new Date(lastReal.timestamp_email)) : 0;
  const nudge = !compose && lastReal && canWrite && days >= 2 ? (isReceived(lastReal) ? `Received ${days} days ago. Reply?` : `Sent ${days} days ago. Follow up?`) : null;
  const onChanged = () => refreshAll();
  const deleteThread = async () => {
    if (
      !(await confirm({
        title: "Delete this conversation?",
        description: t.emails.some(isScheduled)
          ? "All its emails disappear from the Unibox, and its scheduled email isn't sent. The copies in the mailboxes themselves are not touched."
          : "All its emails disappear from the Unibox. The copies in the mailboxes themselves are not touched.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    await bulk("delete", "Conversation deleted", onRemoved);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* On a narrow pane the buttons wrap under the subject instead of squeezing it. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-4 py-2.5">
          <Button size="icon-sm" variant="ghost" aria-label="Back to the list" onClick={onClose} className="lg:hidden">
            <ArrowLeft size={16} />
          </Button>
          <div className="min-w-0 flex-1 basis-56">
            <h2 className="truncate text-[15px] font-semibold">{first.subject || "(no subject)"}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
              <InterestBadge code={interest} labels={statuses.all} />
              {t.campaign && (
                <Link to={`/app/campaign/${t.campaign.id}/analytics`} className="inline-flex items-center gap-1 hover:text-text">
                  <Send size={11} /> {t.campaign.name}
                </Link>
              )}
              <span>{plural(t.emails.length, "message")}</span>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {canWrite && (
              <>
                {lastReal && (
                  <Tooltip content="Reply (r)">
                    <Button size="icon-sm" variant="ghost" aria-label="Reply" onClick={() => setCompose({ mode: "reply", targetId: t.reply_target_id })}>
                      <Reply size={15} />
                    </Button>
                  </Tooltip>
                )}
                {roomy && lastReal && (
                  <Tooltip content="Forward (f)">
                    <Button size="icon-sm" variant="ghost" aria-label="Forward" onClick={() => setCompose({ mode: "forward", targetId: lastReal.id })}>
                      <Forward size={15} />
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content={isDone ? "Move back to the inbox (e)" : "Mark as done (e)"}>
                  <Button size="icon-sm" variant="ghost" aria-label={isDone ? "Move back to the inbox" : "Mark as done"} onClick={toggleDone}>
                    {isDone ? <Undo2 size={15} /> : <CheckCircle2 size={15} />}
                  </Button>
                </Tooltip>
              </>
            )}
            {labelable && <LabelMenu labels={statuses.all} current={interest} onApply={applyLabel} />}
            {canWrite && <ReminderMenu thread={t} onChanged={onChanged} />}
            {canWrite && roomy && (
              <>
                <Tooltip content="Mark as unread">
                  <Button size="icon-sm" variant="ghost" aria-label="Mark as unread" onClick={() => bulk("mark_unread", "Marked as unread", onClose)}>
                    <MailOpen size={15} />
                  </Button>
                </Tooltip>
                <Tooltip content="Delete conversation">
                  <Button size="icon-sm" variant="ghost" aria-label="Delete conversation" onClick={deleteThread}>
                    <Trash2 size={15} />
                  </Button>
                </Tooltip>
              </>
            )}
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="More actions">
                  <MoreHorizontal size={15} />
                </Button>
              </MenuTrigger>
              <MenuContent>
                {canWrite && (
                  <>
                    {lastReal && (
                      <MenuItem icon={<ReplyAll size={14} />} shortcut="a" onSelect={() => setCompose({ mode: "reply_all", targetId: t.reply_target_id })}>
                        Reply all
                      </MenuItem>
                    )}
                    {!roomy && lastReal && (
                      <MenuItem icon={<Forward size={14} />} shortcut="f" onSelect={() => setCompose({ mode: "forward", targetId: lastReal.id })}>
                        Forward
                      </MenuItem>
                    )}
                    <MenuItem icon={<Inbox size={14} />} onSelect={() => bulk(focused ? "move_others" : "move_primary", focused ? "Moved to Others" : "Moved to Primary")}>
                      Move to {focused ? "Others" : "Primary"}
                    </MenuItem>
                    {!roomy && (
                      <MenuItem icon={<MailOpen size={14} />} onSelect={() => bulk("mark_unread", "Marked as unread", onClose)}>
                        Mark as unread
                      </MenuItem>
                    )}
                  </>
                )}
                <MenuItem
                  icon={<Link2 size={14} />}
                  onSelect={() => {
                    navigator.clipboard.writeText(`${location.origin}/app/unibox?thread=${t.thread_id}`).then(() => toast.success("Link copied"));
                  }}
                >
                  Copy link to conversation
                </MenuItem>
                <MenuItem
                  icon={<Download size={14} />}
                  onSelect={() => (sentEmails.length === 1 ? download(`/api/app/unibox/emails/${sentEmails[0]!.id}/eml`) : download("/api/app/unibox/export/mbox", { thread_ids: t.thread_id }))}
                >
                  {sentEmails.length === 1 ? "Download as .eml" : "Download conversation (.mbox)"}
                </MenuItem>
                {canWrite && !roomy && (
                  <>
                    <MenuSeparator />
                    <MenuItem danger icon={<Trash2 size={14} />} onSelect={deleteThread}>
                      Delete conversation
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
            <Tooltip content={wide && panel ? "Hide lead details" : "Show lead details"}>
              <Button size="icon-sm" variant="ghost" aria-label={wide && panel ? "Hide lead details" : "Show lead details"} onClick={() => (wide ? setPanel(!panel) : setLeadSheet(true))} className="ml-1.5">
                {wide && panel ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
              </Button>
            </Tooltip>
          </div>
        </div>

        {q.isError && (
          <div className="flex items-center gap-2 border-b border-line bg-warn-soft px-4 py-1.5 text-xs text-warn">
            <XCircle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">This conversation couldn't be refreshed. What's shown may be out of date.</span>
            <button type="button" className="shrink-0 font-medium hover:underline" onClick={() => void q.refetch()}>
              Try again
            </button>
          </div>
        )}
        <div className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto bg-bg px-4 py-4">
          {visible.map((v) =>
            "more" in v ? (
              <button key="more" type="button" onClick={() => setShowAll(true)} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong py-2 text-[13px] text-muted hover:bg-panel-2 hover:text-text">
                <ChevronsUpDown size={14} /> {v.more} more {v.more === 1 ? "message" : "messages"}
              </button>
            ) : (
              <MessageCard
                key={v.email!.id}
                email={v.email!}
                expanded={expanded.has(v.email!.id)}
                onToggle={() =>
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (n.has(v.email!.id)) n.delete(v.email!.id);
                    else n.add(v.email!.id);
                    return n;
                  })
                }
                onCompose={(mode, e) => setCompose({ mode, targetId: e.id })}
                onChanged={onChanged}
                canWrite={canWrite}
              />
            ),
          )}

          {compose && target && summary.data ? (
            <Composer
              key={`${compose.mode}:${target.id}`}
              thread={t}
              target={target}
              mode={compose.mode}
              inboxes={summary.data.inboxes}
              onClose={() => setCompose(null)}
              onSent={() => {
                setCompose(null);
                refreshAll();
              }}
            />
          ) : (
            canWrite &&
            lastReal && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {nudge && (
                  <span className="mr-1 inline-flex items-center gap-1.5 text-[13px] text-muted">
                    <Clock size={13} /> {nudge}
                  </span>
                )}
                <Button size="sm" icon={<Reply size={14} />} onClick={() => setCompose({ mode: "reply", targetId: nudge && lastReal && !isReceived(lastReal) ? lastReal.id : t.reply_target_id })}>
                  {nudge && lastReal && !isReceived(lastReal) ? "Follow up" : "Reply"}
                </Button>
                <Button size="sm" icon={<ReplyAll size={14} />} onClick={() => setCompose({ mode: "reply_all", targetId: t.reply_target_id })}>
                  Reply all
                </Button>
                <Button size="sm" icon={<Forward size={14} />} onClick={() => setCompose({ mode: "forward", targetId: lastReal.id })}>
                  Forward
                </Button>
              </div>
            )
          )}
          {/* A scheduled email that didn't go out has its own bar with what to do next. */}
          {last.send_error && !compose && !isScheduled(last) && (
            <p className="flex items-center gap-1.5 text-xs text-bad">
              <XCircle size={13} /> The last message wasn't sent. Check the sending account, then reply again.
            </p>
          )}
        </div>
      </div>
      {wide && panel ? (
        <aside className="scroll-thin w-[300px] shrink-0 overflow-y-auto border-l border-line bg-panel">
          <LeadPanel thread={t} />
        </aside>
      ) : (
        <Sheet open={leadSheet} onOpenChange={setLeadSheet} title="Lead" width="max-w-sm">
          <LeadPanel thread={t} />
        </Sheet>
      )}
    </div>
  );
}

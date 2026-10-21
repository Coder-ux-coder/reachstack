// CRM building blocks shared by the inbox, the deal board and the leads view: types, data hooks, the dialogs for
// tasks, calls, texts and meetings, and one lead's merged timeline.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CalendarDays, CheckSquare, Mail, MessageSquare, NotebookPen, Phone, Trash2, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { del, errorMessage, get, patch, post, type Page } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fromWallClock, todayIn, wallClock } from "@/lib/dates";
import { dateTime, dateTimeIn, plural } from "@/lib/format";
import { useCan, useSession, useWorkspaceZone } from "@/lib/session";
import { Button, Callout, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, NativeSelect, NumberInput, Segmented, SkeletonRows, Textarea, useConfirm } from "@/components/ui";

export type FeedType = "email" | "call" | "sms" | "task" | "meeting";

export interface FeedItem {
  key: string;
  type: FeedType;
  id: string;
  at: string;
  lead_email: string | null;
  lead_id: string | null;
  lead_name: string | null;
  company_name: string | null;
  title: string;
  preview: string | null;
  direction: "inbound" | "outbound" | null;
  status: string | null;
  due_at: string | null;
  done_at: string | null;
  assigned_to: string | null;
  thread_id: string | null;
  meta: Record<string, unknown>;
}

export interface CrmCounts {
  inbox: { email: number; call: number; sms: number; task: number; all: number };
  upcoming: number;
}

export type TaskType = "todo" | "call" | "email" | "linkedin" | "sms" | "meeting";
export type Priority = "low" | "normal" | "high";

export interface CrmTask {
  id: string;
  title: string;
  description: string | null;
  type: TaskType;
  /** "skipped": a sequence's task its lead went on without. */
  status: "open" | "done" | "skipped";
  priority: Priority;
  due_at: string | null;
  lead_email: string | null;
  lead_id: string | null;
  lead_name: string | null;
  company_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  source: string;
  /** The lead's phone, LinkedIn profile and where they are (calling or finding them). */
  lead_phone: string | null;
  lead_linkedin_url: string | null;
  lead_timezone: string | null;
  lead_location: string | null;
  /** A sequence's task (source "sequence"): where it came from, the step (from 1) and its kind. */
  campaign_id: string | null;
  campaign_name: string | null;
  subsequence_id: string | null;
  subsequence_name: string | null;
  step: number | null;
  step_kind: string | null;
  completed_at: string | null;
  timestamp_created: string;
  overdue: boolean;
}

export type CallOutcome = "connected" | "voicemail" | "no_answer" | "wrong_number" | "meeting_booked";

export interface CrmCall {
  id: string;
  lead_email: string | null;
  lead_id: string | null;
  phone_number: string;
  from_number: string | null;
  direction: "inbound" | "outbound";
  status: string;
  outcome: CallOutcome | null;
  duration_sec: number;
  recording_url: string | null;
  notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  archived_at: string | null;
  timestamp_created: string;
}

export interface CrmSms {
  id: string;
  lead_email: string | null;
  lead_id: string | null;
  phone_number: string;
  from_number: string | null;
  direction: "inbound" | "outbound";
  body: string;
  status: string;
  created_by: string | null;
  created_by_name: string | null;
  archived_at: string | null;
  timestamp_created: string;
}

export type MeetingStatus = "scheduled" | "completed" | "no_show" | "cancelled";

export interface CrmMeeting {
  id: string;
  lead_email: string | null;
  lead_id: string | null;
  title: string;
  start_at: string;
  end_at: string | null;
  location: string | null;
  notes: string | null;
  status: MeetingStatus;
  created_by: string | null;
  timestamp_created: string;
}

export interface PhoneNumber {
  id: string;
  number: string;
  friendly_name: string | null;
  capabilities: { voice?: boolean; sms?: boolean } | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  twilio_sid: string | null;
  timestamp_created: string;
}

export interface PhoneSettings {
  twilio_configured: boolean;
  webhooks: { sms: string; voice: string; status: string; reachable: boolean };
  my_phone: string | null;
  numbers: PhoneNumber[];
}

export interface Member {
  user_id: string;
  name: string;
  email: string;
}

export const TYPE_META: Record<FeedType | "note", { label: string; icon: LucideIcon; tone: string }> = {
  email: { label: "Email", icon: Mail, tone: "bg-info-soft text-info" },
  call: { label: "Call", icon: Phone, tone: "bg-ok-soft text-ok" },
  sms: { label: "SMS", icon: MessageSquare, tone: "bg-brand-soft text-brand-text" },
  task: { label: "Task", icon: CheckSquare, tone: "bg-warn-soft text-warn" },
  meeting: { label: "Meeting", icon: CalendarDays, tone: "bg-brand-soft text-brand-text" },
  note: { label: "Note", icon: NotebookPen, tone: "bg-panel-2 text-muted" },
};

export function TypeIcon({ type, size = 15, className }: { type: FeedType | "note"; size?: number; className?: string }) {
  const m = TYPE_META[type];
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-lg p-1.5", m.tone, className)} aria-hidden>
      <m.icon size={size} />
    </span>
  );
}

export const TASK_TYPES: Array<{ value: TaskType; label: string }> = [
  { value: "todo", label: "To-do" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "sms", label: "SMS" },
  { value: "meeting", label: "Meeting" },
];

export const OUTCOMES: Array<{ value: CallOutcome; label: string }> = [
  { value: "connected", label: "Connected" },
  { value: "voicemail", label: "Left a voicemail" },
  { value: "no_answer", label: "No answer" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "meeting_booked", label: "Meeting booked" },
];

export const MEETING_STATUSES: Array<{ value: MeetingStatus; label: string }> = [
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Completed" },
  { value: "no_show", label: "No show" },
  { value: "cancelled", label: "Cancelled" },
];

export const outcomeLabel = (o: string | null | undefined) => OUTCOMES.find((x) => x.value === o)?.label ?? null;

/** Twilio's call states in words: an unanswered incoming call is "Missed". */
export function callStatusLabel(status: string | null | undefined, direction: string | null | undefined) {
  if (!status || status === "completed") return "Completed";
  if (["no-answer", "busy", "failed", "canceled"].includes(status)) return direction === "inbound" ? "Missed" : status === "busy" ? "Busy" : status === "failed" ? "Failed" : "No answer";
  return "In progress";
}

export function duration(sec: number | null | undefined) {
  if (!sec) return "0s";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s ? `${s}s` : ""}`.trim() : `${s}s`;
}

/** "2026-10-14" + "09:30" in the viewer's time zone, as an ISO timestamp. */
export const localIso = (date: string, time: string) => new Date(`${date}T${time || "09:00"}`).toISOString();
const ymd = (iso: string | null | undefined) => (iso ? format(new Date(iso), "yyyy-MM-dd") : "");
const hm = (iso: string | null | undefined, fallback = "09:00") => (iso ? format(new Date(iso), "HH:mm") : fallback);

export const CRM_KEY = ["crm"] as const;

export function useCrmRefresh() {
  const qc = useQueryClient();
  return () => {
    // Tasks from sequences also show on Today (and its menu badge).
    void qc.invalidateQueries({ queryKey: ["sequence-tasks"] });
    return qc.invalidateQueries({ queryKey: CRM_KEY });
  };
}

/** The inbox's counts; `owner` "me": only what's mine, like the list showing "Mine". */
export function useCrmCounts(owner?: "me") {
  return useQuery({ queryKey: ["crm", "counts", owner ?? "all"], queryFn: () => get<CrmCounts>("/api/app/crm/counts", { owner }), refetchInterval: 60_000 });
}

/** A task's due time on the workspace's clock, naming the timezone when it isn't this browser's. */
export const taskDue = (iso: string, zone: string) => dateTimeIn(new Date(iso), zone);

// Clients and view-only members get teammates' names without their emails.
type MemberRow = { user_id: string | null; email: string | null; name: { first: string; last: string } | null; accepted: boolean };

/** Accepted teammates (people who can own deals and tasks). */
export function useMembers(enabled = true): Member[] {
  const q = useQuery({ queryKey: ["workspace-members"], queryFn: () => get<Page<MemberRow>>("/api/v2/workspace-members", { limit: 100 }), enabled, staleTime: 60_000 });
  return (q.data?.items ?? [])
    .filter((m) => m.accepted && m.user_id)
    .map((m) => ({ user_id: m.user_id!, email: m.email ?? "", name: `${m.name?.first ?? ""} ${m.name?.last ?? ""}`.trim() || m.email || "Teammate" }));
}

export function usePhoneSettings(enabled = true) {
  return useQuery({ queryKey: ["crm", "phone-settings"], queryFn: () => get<PhoneSettings>("/api/app/crm/phone-settings"), enabled, staleTime: 30_000 });
}

function useMemberOptions(enabled: boolean, empty: string) {
  const me = useSession();
  const members = useMembers(enabled);
  return [{ value: "", label: empty }, ...members.map((m) => ({ value: m.user_id, label: m.user_id === me.user.id ? `${m.name} (me)` : m.name }))];
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks

export function TaskDialog({
  open,
  onOpenChange,
  task,
  leadEmail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  task?: CrmTask | null;
  leadEmail?: string | null;
  onSaved?: (t: CrmTask) => void;
}) {
  const me = useSession();
  const refresh = useCrmRefresh();
  const members = useMemberOptions(open, "Unassigned");
  // Someone who has since left keeps the tasks they had: shown as they are, not as "Unassigned".
  const gone = task?.assigned_to && !members.some((m) => m.value === task.assigned_to) ? task : null;
  const assignees = gone ? [...members, { value: gone.assigned_to!, label: `${gone.assigned_to_name ?? "A former teammate"} (no longer here)` }] : members;
  // Tasks are due on the workspace's clock, the one "due today" goes by.
  const zone = useWorkspaceZone();
  const otherClock = zone !== Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<TaskType>("todo");
  const [priority, setPriority] = useState<Priority>("normal");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [contact, setContact] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setType(task?.type ?? "todo");
    setPriority(task?.priority ?? "normal");
    setDate(task ? (task.due_at ? wallClock(task.due_at, zone).date : "") : todayIn(zone));
    setTime(task?.due_at ? wallClock(task.due_at, zone).time : "09:00");
    setContact(task?.lead_email ?? leadEmail ?? "");
    setAssignee(task ? (task.assigned_to ?? "") : me.user.id);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!title.trim()) return toast.error("Describe the task first");
    setBusy(true);
    try {
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        type,
        priority,
        due_at: date ? fromWallClock(date, time, zone) : null,
        lead_email: contact.trim() || null,
        assigned_to: assignee || null,
      };
      const saved = task ? await patch<CrmTask>(`/api/app/crm/tasks/${task.id}`, body) : await post<CrmTask>("/api/app/crm/tasks", body);
      toast.success(task ? "Task updated" : "Task created");
      refresh();
      onSaved?.(saved);
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
      title={task ? "Edit the task" : "Add a new task"}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {task ? "Save task" : "Add task"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Task">{(id) => <Input id={id} autoFocus value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} placeholder="Send the proposal" />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due date" optional>
            {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label="Time" hint={otherClock ? `On the workspace's clock (${zone.replace(/_/g, " ")})` : undefined}>
            {(id) => <Input id={id} type="time" value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">{(id) => <NativeSelect id={id} value={type} onChange={(v) => setType(v as TaskType)} options={TASK_TYPES} />}</Field>
          <Field label="Priority">
            {(id) => (
              <NativeSelect
                id={id}
                value={priority}
                onChange={(v) => setPriority(v as Priority)}
                options={[
                  { value: "low", label: "Low" },
                  { value: "normal", label: "Normal" },
                  { value: "high", label: "High" },
                ]}
              />
            )}
          </Field>
        </div>
        <Field label="Contact" optional hint={task?.source === "sequence" ? "A task from a sequence stays with its lead." : "The lead's email address. The task also shows on their timeline."}>
          {(id) => <Input id={id} type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="name@company.com" disabled={task?.source === "sequence"} />}
        </Field>
        <Field label="Assign to">{(id) => <NativeSelect id={id} value={assignee} onChange={setAssignee} options={assignees} />}</Field>
        <Field label="Details" optional>
          {(id) => <Textarea id={id} rows={3} value={description} maxLength={10_000} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Calls

/** Places a call through Twilio (your phone rings first) or logs one made elsewhere. */
export function CallDialog({ open, onOpenChange, leadEmail, phone }: { open: boolean; onOpenChange: (v: boolean) => void; leadEmail?: string | null; phone?: string | null }) {
  const settings = usePhoneSettings(open);
  const refresh = useCrmRefresh();
  const s = settings.data;
  const voiceNumbers = (s?.numbers ?? []).filter((n) => n.capabilities?.voice !== false);
  const dialReady = !!s?.twilio_configured && voiceNumbers.length > 0 && !!s.my_phone;
  const [mode, setMode] = useState<"dial" | "log">("log");
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [direction, setDirection] = useState<"outbound" | "inbound">("outbound");
  const [outcome, setOutcome] = useState<CallOutcome>("connected");
  const [minutes, setMinutes] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTo(phone ?? "");
    setFrom("");
    setDirection("outbound");
    setOutcome("connected");
    setMinutes(null);
    setNotes("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && s) setMode(dialReady ? "dial" : "log");
  }, [open, !!s]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (to.trim().length < 5) return toast.error("Enter the phone number");
    setBusy(true);
    try {
      if (mode === "dial") {
        await post("/api/app/crm/calls", { mode: "dial", to, lead_email: leadEmail || null, from_number_id: from || null });
        toast.success(`Calling your phone (${s?.my_phone}). Pick up and we'll connect you.`);
      } else {
        await post("/api/app/crm/calls", { mode: "log", to, lead_email: leadEmail || null, direction, outcome, duration_sec: Math.round((minutes ?? 0) * 60), notes: notes.trim() || null });
        toast.success("Call logged");
      }
      refresh();
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
      title={mode === "dial" ? "Call" : "Log a call"}
      description={leadEmail ?? undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} icon={<Phone size={14} />}>
            {mode === "dial" ? "Call now" : "Log call"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "dial", label: "Call now" },
            { value: "log", label: "Log a call" },
          ]}
        />
        {mode === "dial" && !dialReady && s && (
          <Callout tone="warn" title="Calling isn't ready yet">
            {!s.twilio_configured
              ? "Calls go through Twilio. The server needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN."
              : !voiceNumbers.length
                ? "Add a phone number that can make calls first."
                : "Add your own phone number first. We ring it, then connect you to the lead."}{" "}
            <Link to="/app/crm/calls-and-sms" className="font-medium underline">
              Calls & SMS settings
            </Link>
          </Callout>
        )}
        <Field label="To">{(id) => <Input id={id} type="tel" autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="+14155550123" />}</Field>
        {mode === "dial" ? (
          <>
            {voiceNumbers.length > 1 && (
              <Field label="From">
                {(id) => (
                  <NativeSelect id={id} value={from} onChange={setFrom} options={[{ value: "", label: "My number" }, ...voiceNumbers.map((n) => ({ value: n.id, label: n.friendly_name ? `${n.friendly_name} (${n.number})` : n.number }))]} />
                )}
              </Field>
            )}
            {dialReady && <p className="text-[13px] text-muted">Your phone ({s?.my_phone}) rings first. When you pick up, we dial the lead from your business number.</p>}
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Direction">
                {(id) => (
                  <NativeSelect
                    id={id}
                    value={direction}
                    onChange={(v) => setDirection(v as "outbound" | "inbound")}
                    options={[
                      { value: "outbound", label: "I called them" },
                      { value: "inbound", label: "They called me" },
                    ]}
                  />
                )}
              </Field>
              <Field label="Outcome">{(id) => <NativeSelect id={id} value={outcome} onChange={(v) => setOutcome(v as CallOutcome)} options={OUTCOMES} />}</Field>
            </div>
            <Field label="Length" optional>
              {(id) => <NumberInput id={id} value={minutes} onChange={setMinutes} min={0} max={1440} step={1} suffix="min" />}
            </Field>
            <Field label="Notes" optional>
              {(id) => <Textarea id={id} rows={4} value={notes} maxLength={20_000} onChange={(e) => setNotes(e.target.value)} placeholder="What did you talk about?" />}
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Texts

export const smsSegments = (text: string) => {
  // GSM-7 fits 160 characters (153 per part when split); anything else is UCS-2 at 70 (67 per part).
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return text.length <= single ? (text ? 1 : 0) : Math.ceil(text.length / multi);
};

export function SmsDialog({ open, onOpenChange, leadEmail, phone }: { open: boolean; onOpenChange: (v: boolean) => void; leadEmail?: string | null; phone?: string | null }) {
  const settings = usePhoneSettings(open);
  const refresh = useCrmRefresh();
  const s = settings.data;
  const smsNumbers = (s?.numbers ?? []).filter((n) => n.capabilities?.sms !== false);
  const ready = !!s?.twilio_configured && smsNumbers.length > 0;
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTo(phone ?? "");
    setFrom("");
    setText("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (to.trim().length < 5) return toast.error("Enter the phone number");
    if (!text.trim()) return toast.error("Write a message first");
    setBusy(true);
    try {
      await post("/api/app/crm/sms", { to, body: text.trim(), lead_email: leadEmail || null, from_number_id: from || null });
      toast.success("Text sent");
      refresh();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const parts = smsSegments(text);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Send SMS"
      description={leadEmail ?? undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={send} icon={<MessageSquare size={14} />}>
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {s && !ready && (
          <Callout tone="warn" title="Texting isn't ready yet">
            {!s.twilio_configured ? "Texts go through Twilio. The server needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." : "Add a phone number that can send texts first."}{" "}
            <Link to="/app/crm/calls-and-sms" className="font-medium underline">
              Calls & SMS settings
            </Link>
          </Callout>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="To">{(id) => <Input id={id} type="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="+14155550123" />}</Field>
          {smsNumbers.length > 1 && (
            <Field label="From">
              {(id) => <NativeSelect id={id} value={from} onChange={setFrom} options={[{ value: "", label: "My number" }, ...smsNumbers.map((n) => ({ value: n.id, label: n.friendly_name ? `${n.friendly_name} (${n.number})` : n.number }))]} />}
            </Field>
          )}
        </div>
        <Field label="Message" hint={text ? `${text.length} / 1600 characters · ${plural(parts, "text")}` : undefined}>
          {(id) => <Textarea id={id} autoFocus rows={5} value={text} maxLength={1600} onChange={(e) => setText(e.target.value)} placeholder="Type your message here…" />}
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Meetings

export function MeetingDialog({
  open,
  onOpenChange,
  meeting,
  leadEmail,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  meeting?: CrmMeeting | null;
  leadEmail?: string | null;
}) {
  const refresh = useCrmRefresh();
  const confirm = useConfirm();
  const [title, setTitle] = useState("");
  const [contact, setContact] = useState("");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("10:30");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<MeetingStatus>("scheduled");
  const [syncStatus, setSyncStatus] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(meeting?.title ?? "");
    setContact(meeting?.lead_email ?? leadEmail ?? "");
    setDate(meeting ? ymd(meeting.start_at) : format(new Date(Date.now() + 86_400_000), "yyyy-MM-dd"));
    setStart(hm(meeting?.start_at, "10:00"));
    setEnd(hm(meeting?.end_at, "10:30"));
    setLocation(meeting?.location ?? "");
    setNotes(meeting?.notes ?? "");
    setStatus(meeting?.status ?? "scheduled");
    setSyncStatus(true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!title.trim()) return toast.error("Give the meeting a name");
    if (!date || !start) return toast.error("Pick the meeting date and start time");
    const startIso = localIso(date, start);
    const endIso = end ? localIso(date, end) : null;
    if (endIso && endIso <= startIso) return toast.error("The meeting has to end after it starts");
    setBusy(true);
    try {
      const body = { title: title.trim(), lead_email: contact.trim() || null, start_at: startIso, end_at: endIso, location: location.trim() || null, notes: notes.trim() || null, status, set_lead_status: syncStatus };
      if (meeting) await patch(`/api/app/crm/meetings/${meeting.id}`, body);
      else await post("/api/app/crm/meetings", body);
      toast.success(meeting ? "Meeting updated" : "Meeting added");
      refresh();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!meeting || !(await confirm({ title: "Delete this meeting?", description: "It's removed from the CRM. The lead's status stays as it is.", confirmLabel: "Delete meeting", danger: true }))) return;
    try {
      await del(`/api/app/crm/meetings/${meeting.id}`);
      toast.success("Meeting deleted");
      refresh();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const syncLabel = status === "completed" ? "Mark the lead as Meeting completed" : status === "no_show" ? "Mark the lead as No show" : status === "scheduled" ? "Mark the lead as Meeting booked" : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={meeting ? "Update meeting" : "Add a meeting"}
      footer={
        <>
          {meeting && (
            <Button variant="ghost" className="mr-auto text-bad" icon={<Trash2 size={14} />} onClick={remove}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {meeting ? "Save meeting" : "Add meeting"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Meeting name">{(id) => <Input id={id} autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="Intro call" />}</Field>
        <Field label="Contact" optional>
          {(id) => <Input id={id} type="email" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="name@company.com" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Starts">{(id) => <Input id={id} type="time" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label="Ends">{(id) => <Input id={id} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
        </div>
        <Field label="Where" optional>
          {(id) => <Input id={id} value={location} maxLength={1000} onChange={(e) => setLocation(e.target.value)} placeholder="Video link, phone or address" />}
        </Field>
        {meeting && <Field label="Status">{(id) => <NativeSelect id={id} value={status} onChange={(v) => setStatus(v as MeetingStatus)} options={MEETING_STATUSES} />}</Field>}
        <Field label="Meeting notes" optional>
          {(id) => <Textarea id={id} rows={3} value={notes} maxLength={20_000} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        {contact.trim() && syncLabel && (!meeting || status !== meeting.status || contact.trim().toLowerCase() !== (meeting.lead_email ?? "").toLowerCase()) && (
          <Checkbox checked={syncStatus} onChange={setSyncStatus} label={syncLabel} />
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Timeline

interface TimelineItem {
  type: FeedType | "note";
  id: string;
  at: string | null;
  title: string;
  preview: string | null;
  direction?: "inbound" | "outbound";
  status?: string;
  duration_sec?: number;
  outcome?: string | null;
  due_at?: string | null;
  end_at?: string | null;
  location?: string | null;
  thread_id?: string | null;
  by?: string | null;
}

/** Everything that happened with one address: emails, calls, texts, tasks, meetings and notes, newest first. */
export function LeadTimeline({ leadEmail, leadId }: { leadEmail: string; leadId?: string | null }) {
  const can = useCan();
  const qc = useQueryClient();
  const refresh = useCrmRefresh();
  const confirm = useConfirm();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const zone = useWorkspaceZone();
  const q = useQuery({ queryKey: ["crm", "timeline", leadEmail], queryFn: () => get<{ items: TimelineItem[] }>("/api/app/crm/timeline", { lead_email: leadEmail }) });
  const canNote = can.write && can.perm("leads");

  const addNote = async () => {
    if (!note.trim()) return;
    setSaving(true);
    try {
      await post("/api/app/lead-notes", { lead_email: leadEmail, lead_id: leadId ?? undefined, body: note.trim() });
      setNote("");
      refresh();
      qc.invalidateQueries({ queryKey: ["lead-notes"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const removeNote = async (id: string) => {
    if (!(await confirm({ title: "Delete this note?", confirmLabel: "Delete note", danger: true }))) return;
    try {
      await del(`/api/app/lead-notes/${id}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const detail = (i: TimelineItem) =>
    [
      i.type === "call" ? `${callStatusLabel(i.status, i.direction)}${i.duration_sec ? ` · ${duration(i.duration_sec)}` : ""}${i.outcome ? ` · ${outcomeLabel(i.outcome)}` : ""}` : null,
      i.type === "task" ? (i.status === "done" ? "Done" : i.status === "skipped" ? "Skipped" : i.due_at ? `Due ${taskDue(i.due_at, zone)}` : "Open") : null,
      i.type === "meeting" ? MEETING_STATUSES.find((m) => m.value === i.status)?.label : null,
      i.type === "meeting" && i.location ? i.location : null,
      i.by ? `by ${i.by}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div>
      {canNote && (
        <div className="mb-4">
          <Textarea rows={2} value={note} maxLength={20_000} onChange={(e) => setNote(e.target.value)} placeholder="Type your note here…" aria-label="New note" />
          {note.trim() && (
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="primary" loading={saving} onClick={addNote}>
                Add note
              </Button>
            </div>
          )}
        </div>
      )}
      {q.isLoading ? (
        <SkeletonRows rows={4} />
      ) : q.isError ? (
        <ErrorState className="py-8" title="The activity couldn't be loaded" error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState className="py-8" title="No activity yet" description="Emails, calls, texts, tasks, meetings and notes with this lead show up here." />
      ) : (
        <ol className="relative space-y-4 border-l border-line pl-5">
          {q.data.items.map((i) => (
            <li key={`${i.type}:${i.id}`} className="relative">
              <TypeIcon type={i.type} size={12} className="absolute -left-[31px] top-0 p-1 ring-4 ring-panel" />
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {i.type === "email" ? (i.direction === "inbound" ? "Reply: " : "Sent: ") : ""}
                    {i.title}
                  </p>
                  <p className="text-xs text-faint">
                    {i.at ? dateTime(i.at) : "–"}
                    {detail(i) ? ` · ${detail(i)}` : ""}
                  </p>
                </div>
                {i.type === "note" && canNote && (
                  <Button size="icon-sm" variant="ghost" aria-label="Delete note" onClick={() => removeNote(i.id)}>
                    <Trash2 size={13} />
                  </Button>
                )}
              </div>
              {i.preview && <p className={cn("mt-1 whitespace-pre-wrap break-words text-[13px] text-muted", i.type !== "note" && "line-clamp-3")}>{i.preview}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertOctagon, AlertTriangle, Eye, Inbox, ListChecks, MailX, MessageSquareReply, MousePointerClick, Pause, Pencil, Play, Plus, Send, SkipForward, Sparkles, SquarePen, Trash2 } from "lucide-react";
import { CAMPAIGN_TIMEZONES, ESG_LABELS, ESP_LABELS, EsgCode, EspCode } from "@reachstack/shared";
import { del, errorMessage, get, isNotFound, patch, post } from "@/lib/api";
import type { Lead } from "@/lib/types";
import { useCan } from "@/lib/session";
import { useLeadStatuses } from "@/lib/statuses";
import { ago, dateTime, fullName } from "@/lib/format";
import { deletedToast, RECENTLY_DELETED_PATH, restorable } from "@/lib/recently-deleted";
import { useDraft } from "@/lib/unsaved";
import { InterestBadge, LeadStatusBadge, VerificationBadge } from "@/components/status";
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, Input, KeyValue, Select, Sheet, Skeleton, TabPanel, Tabs, Textarea, useConfirm } from "@/components/ui";
import { NewEmailDialog } from "@/components/NewEmailDialog";
import { cn } from "@/lib/cn";

type FullLead = Lead & { linkedin_url?: string | null; location?: string | null };

interface Activity {
  lead: FullLead;
  events: Array<{ id: string; type: string; campaign_id: string | null; step: number | null; url: string | null; value: number | null; detail?: string | null; timestamp: string }>;
  emails: Array<{ id: string; subject: string; ue_type: number; step: string | null; timestamp: string }>;
}

interface Note {
  id: string;
  body: string;
  created_by_name: string | null;
  timestamp_created: string;
}

const EVENT_ICON: Record<string, { icon: typeof Eye; tone: string; label: string }> = {
  sent: { icon: Send, tone: "text-brand-text bg-brand-soft", label: "Email sent" },
  open: { icon: Eye, tone: "text-info bg-info-soft", label: "Opened" },
  click: { icon: MousePointerClick, tone: "text-info bg-info-soft", label: "Clicked a link" },
  reply: { icon: MessageSquareReply, tone: "text-ok bg-ok-soft", label: "Replied" },
  auto_reply: { icon: MessageSquareReply, tone: "text-muted bg-panel-2", label: "Automatic reply" },
  bounce: { icon: AlertOctagon, tone: "text-bad bg-bad-soft", label: "Bounced" },
  unsubscribe: { icon: MailX, tone: "text-warn bg-warn-soft", label: "Unsubscribed" },
  opportunity: { icon: Sparkles, tone: "text-ok bg-ok-soft", label: "Became an opportunity" },
  interest_change: { icon: Sparkles, tone: "text-ok bg-ok-soft", label: "Status changed" },
  task_done: { icon: ListChecks, tone: "text-ok bg-ok-soft", label: "Task done" },
  task_skipped: { icon: SkipForward, tone: "text-muted bg-panel-2", label: "Task skipped" },
  not_sent: { icon: AlertTriangle, tone: "text-warn bg-warn-soft", label: "Not sent" },
};

const FIELDS: Array<[keyof FullLead, string]> = [
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["email", "Email"],
  ["company_name", "Company"],
  ["job_title", "Job title"],
  ["website", "Website"],
  ["phone", "Phone"],
  ["linkedin_url", "LinkedIn"],
  ["location", "Location"],
  ["personalization", "Personalization"],
];

/** "America/Chicago · 3:42 PM there". */
function zoneNow(zone: string): string {
  try {
    const time = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date());
    return `${zone.replace(/_/g, " ")} · ${time} there`;
  } catch {
    return zone;
  }
}

/** A lead's editable values, as the edit form holds them. */
const toForm = (lead: FullLead) => ({
  fields: { ...Object.fromEntries(FIELDS.map(([k]) => [k, String(lead[k] ?? "")])), timezone: lead.timezone ?? "" } as Record<string, string>,
  vars: Object.entries(lead.payload ?? {}).map(([k, v]): [string, string] => [k, v === null || v === undefined ? "" : String(v)]),
});

function Details({ lead, onSaved }: { lead: FullLead; onSaved: () => void }) {
  const can = useCan();
  const [editing, setEditing] = useState(false);
  // Follows the saved lead, so the reload after a status change or a pause keeps what's being typed.
  const [draft, setDraft] = useDraft(toForm(lead), lead.id);
  const { fields: form, vars } = draft;
  const setForm = (fields: Record<string, string>) => setDraft((d) => ({ ...d, fields }));
  const setVars = (next: Array<[string, string]>) => setDraft((d) => ({ ...d, vars: next }));
  const [busy, setBusy] = useState(false);
  useEffect(() => setEditing(false), [lead.id]);
  const edit = () => {
    setDraft(toForm(lead));
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      const { timezone = "", ...fields } = form;
      await patch(`/api/v2/leads/${lead.id}`, {
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim() || null])),
        // Sent only when changed, so a new location can still work out a new timezone.
        ...(timezone.trim() !== (lead.timezone ?? "") ? { timezone: timezone.trim() || null } : {}),
        email: form.email?.trim() || undefined,
        // A variable removed (or renamed) here is removed from the lead: the ones it had go as null unless still there.
        custom_variables: {
          ...Object.fromEntries(Object.keys(lead.payload ?? {}).map((k) => [k, null])),
          ...Object.fromEntries(vars.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
        },
      });
      toast.success("Lead updated");
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!editing)
    return (
      <div className="space-y-5 p-5">
        <div className="flex justify-end">
          {can.perm("leads") && can.write && (
            <Button size="sm" icon={<Pencil size={13} />} onClick={edit}>
              Edit
            </Button>
          )}
        </div>
        <KeyValue
          items={FIELDS.flatMap(([k, label]): Array<[string, string | null]> => {
            const row: [string, string | null] = [label, lead[k] ? String(lead[k]) : null];
            return k === "location" ? [row, ["Timezone", lead.timezone ? zoneNow(lead.timezone) : null]] : [row];
          })}
        />
        {lead.email && (
          <div>
            <h4 className="mb-2 text-[13px] font-semibold">Where their email goes</h4>
            <KeyValue
              items={[
                ["Email provider", lead.esp_code === EspCode.IN_QUEUE ? "Checking…" : (ESP_LABELS[lead.esp_code] ?? "Other")],
                ["Security gateway", lead.esg_code === EsgCode.IN_QUEUE ? "Checking…" : lead.esg_code === EsgCode.NONE ? "None found" : (ESG_LABELS[lead.esg_code] ?? "Other")],
              ]}
            />
          </div>
        )}
        {!!Object.keys(lead.payload ?? {}).length && (
          <div>
            <h4 className="mb-2 text-[13px] font-semibold">Custom variables</h4>
            <KeyValue items={Object.entries(lead.payload ?? {}).map(([k, v]) => [<span className="font-mono text-xs" key={k}>{k}</span>, v === null ? null : String(v)])} />
          </div>
        )}
      </div>
    );
  return (
    <div className="space-y-4 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map(([k, label]) => (
          <Fragment key={k}>
            <Field label={label} className={k === "personalization" ? "sm:col-span-2" : undefined}>
              {(id) =>
                k === "personalization" ? (
                  <Textarea id={id} rows={3} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                ) : (
                  <Input id={id} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                )
              }
            </Field>
            {k === "location" && (
              <Field label="Timezone" hint="Left empty, it's worked out from the location or phone.">
                {(id) => (
                  <Input id={id} list="lead-time-zones" value={form.timezone ?? ""} placeholder="America/New_York, EST or UTC+2" onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
                )}
              </Field>
            )}
          </Fragment>
        ))}
        <datalist id="lead-time-zones">
          {CAMPAIGN_TIMEZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </div>
      <div>
        <h4 className="mb-2 text-[13px] font-semibold">Custom variables</h4>
        <div className="space-y-2">
          {vars.map(([k, v], i) => (
            <div key={i} className="flex gap-2">
              <Input inputSize="sm" className="w-40 font-mono" value={k} onChange={(e) => setVars(vars.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} placeholder="name" />
              <Input inputSize="sm" value={v} onChange={(e) => setVars(vars.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} placeholder="value" />
              <Button size="icon-sm" variant="ghost" aria-label="Remove variable" onClick={() => setVars(vars.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
          <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => setVars([...vars, ["", ""]])}>
            Add variable
          </Button>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={() => setEditing(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Timeline({ data }: { data: Activity }) {
  const items = [
    ...data.events.filter((e) => e.type !== "sent").map((e) => ({ key: `e${e.id}`, at: e.timestamp, type: e.type, text: e.detail ?? e.url ?? (e.step !== null ? `Step ${e.step + 1}` : "") })),
    ...data.emails.map((m) => ({ key: `m${m.id}`, at: m.timestamp, type: m.ue_type === 2 ? "reply" : "sent", text: m.subject })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  // A reply shows up as both an event and a received email; keep the email (it has the subject).
  const seen = new Set<string>();
  const deduped = items.filter((i) => {
    const sig = `${i.type}:${i.at.slice(0, 16)}`;
    if (i.key.startsWith("e") && i.type === "reply" && seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  if (!deduped.length) return <EmptyState title="No activity yet" description="Emails, opens, clicks and replies for this lead appear here." />;
  return (
    <ol className="relative space-y-4 p-5 before:absolute before:bottom-5 before:left-[33px] before:top-5 before:w-px before:bg-line">
      {deduped.map((i) => {
        const m = EVENT_ICON[i.type] ?? EVENT_ICON.sent!;
        const Icon = m.icon;
        return (
          <li key={i.key} className="relative flex gap-3">
            <span className={cn("z-10 rounded-full p-1.5", m.tone)}>
              <Icon size={13} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-[13px] font-medium">{m.label}</p>
              {i.text && (
                <p className="truncate text-xs text-muted" title={i.text}>
                  {i.text}
                </p>
              )}
            </div>
            <span className="shrink-0 pt-0.5 text-xs text-faint" title={dateTime(i.at)}>
              {ago(i.at)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Notes({ lead }: { lead: FullLead }) {
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // A person's notes go by their address (their other leads show them too); a lead without one has its own.
  const key = ["lead-notes", lead.email ?? lead.id];
  const notes = useQuery({ queryKey: key, queryFn: () => get<{ items: Note[] }>("/api/app/lead-notes", { lead_email: lead.email ?? undefined, lead_id: lead.id }) });
  const add = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await post("/api/app/lead-notes", { lead_email: lead.email, lead_id: lead.id, body: text });
      setText("");
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (!(await confirm({ title: "Delete this note?", confirmLabel: "Delete note", danger: true }))) return;
    await del(`/api/app/lead-notes/${id}`).catch((e) => toast.error(errorMessage(e)));
    qc.invalidateQueries({ queryKey: key });
  };
  return (
    <div className="space-y-4 p-5">
      {can.perm("leads") && can.write && (
        <div className="space-y-2">
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note for your team…" />
          <div className="flex justify-end">
            <Button size="sm" variant="primary" disabled={!text.trim()} loading={busy} onClick={add}>
              Add note
            </Button>
          </div>
        </div>
      )}
      {notes.data?.items.length ? (
        <ul className="space-y-3">
          {notes.data.items.map((n) => (
            <li key={n.id}>
              <Card className="p-3.5">
                <p className="whitespace-pre-wrap text-[13px]">{n.body}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-faint">
                  <span>
                    {n.created_by_name ?? "Someone"} · {ago(n.timestamp_created)}
                  </span>
                  {can.write && (
                    <button type="button" className="hover:text-bad" onClick={() => remove(n.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        !notes.isLoading && <p className="text-center text-[13px] text-muted">No notes yet.</p>
      )}
    </div>
  );
}

/** Lead details drawer used by campaign leads, lists and the CRM. */
export function LeadSheet({ leadId, onClose, onChanged }: { leadId: string | null; onClose: () => void; onChanged?: () => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const statuses = useLeadStatuses();
  const [tab, setTab] = useState<"activity" | "details" | "notes">("activity");
  const [composing, setComposing] = useState(false);
  const key = ["lead", leadId];
  const q = useQuery({ queryKey: key, queryFn: () => get<Activity>(`/api/app/leads/${leadId}/activity`), enabled: !!leadId });
  const lead = q.data?.lead;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["leads"] });
    onChanged?.();
  };
  const setInterest = async (v: string) => {
    if (!leadId) return;
    try {
      // This lead's status; the workspace's "sync lead status" setting carries it to the person's other leads.
      await post("/api/app/leads/status", { ids: [leadId], action: "interest", interest_value: v === "" ? null : Number(v) });
      toast.success("Status updated");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const action = async (a: "pause" | "resume" | "mark_completed") => {
    try {
      await post("/api/app/leads/status", { ids: [leadId], action: a });
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const name = lead ? fullName(lead) : "";
  return (
    <Sheet
      open={!!leadId}
      onOpenChange={(v) => !v && onClose()}
      title={lead ? name || lead.email || "Lead" : "Lead"}
      description={lead ? [lead.job_title, lead.company_name].filter(Boolean).join(" at ") || lead.email : undefined}
    >
      {!lead ? (
        q.isError ? (
          isNotFound(q.error) ? (
            <EmptyState
              title="Lead not found"
              description={
                <>
                  It was deleted, or it belongs to another workspace. A lead deleted in the last 30 days can be restored from{" "}
                  <Link to={RECENTLY_DELETED_PATH} className="text-brand-text hover:underline">
                    Recently deleted
                  </Link>
                  .
                </>
              }
              action={<Button onClick={onClose}>Close</Button>}
            />
          ) : (
            <ErrorState title="Couldn't load this lead" error={q.error} onRetry={() => q.refetch()} />
          )
        ) : (
          <div className="space-y-3 p-5">
            <Skeleton className="h-14" />
            <Skeleton className="h-40" />
          </div>
        )
      ) : (
        <>
          <div className="space-y-3 border-b border-line px-5 py-4">
            <div className="flex items-center gap-3">
              <Avatar name={name} email={lead.email} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{lead.email ?? "No email"}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {/* Sending status means something only in a campaign; list leads aren't being emailed. */}
                  {lead.campaign && <LeadStatusBadge status={lead.status} />}
                  <VerificationBadge status={lead.verification_status} />
                  <InterestBadge code={lead.lt_interest_status} labels={statuses.all} />
                  {lead.is_website_visitor && (
                    <Link to={`/app/website-visitors${lead.company_domain ? `?company=${encodeURIComponent(lead.company_domain)}` : ""}`} title="Added from a visit to your website: see the visit" className="rounded-full">
                      <Badge tone="info">Visited your website</Badge>
                    </Link>
                  )}
                </div>
              </div>
              {lead.email && can.perm("unibox") && can.write && (
                <>
                  <button type="button" onClick={() => setComposing(true)} className="rounded-md p-2 text-muted hover:bg-panel-2 hover:text-text" title="New email" aria-label="New email">
                    <SquarePen size={16} />
                  </button>
                  <NewEmailDialog open={composing} onOpenChange={setComposing} to={[lead.email]} lead={lead} />
                </>
              )}
              {lead.email && (
                <Link to={`/app/unibox?search=${encodeURIComponent(lead.email)}`} className="rounded-md p-2 text-muted hover:bg-panel-2 hover:text-text" title="Open conversation">
                  <Inbox size={16} />
                </Link>
              )}
            </div>
            {can.perm("leads") && can.write && (
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  size="sm"
                  className="w-48"
                  value={lead.lt_interest_status === null || lead.lt_interest_status === undefined ? "" : String(lead.lt_interest_status)}
                  onChange={setInterest}
                  options={[{ value: "", label: "No status" }, ...statuses.all.map((s) => ({ value: String(s.code), label: s.label }))]}
                  aria-label="Lead status"
                />
                {lead.campaign && lead.status === 1 && (
                  <Button size="sm" icon={<Pause size={13} />} onClick={() => action("pause")}>
                    Pause
                  </Button>
                )}
                {lead.campaign && lead.status === 2 && (
                  <Button size="sm" icon={<Play size={13} />} onClick={() => action("resume")}>
                    Resume
                  </Button>
                )}
                {lead.campaign && (lead.status === 1 || lead.status === 2) && (
                  <Button size="sm" onClick={() => action("mark_completed")}>
                    Mark completed
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-bad"
                  icon={<Trash2 size={13} />}
                  onClick={async () => {
                    if (!(await confirm({ title: "Delete this lead?", description: `Emails already exchanged stay in the inbox. ${restorable()}`, confirmLabel: "Delete", danger: true }))) return;
                    try {
                      const r = await del<{ recently_deleted_id?: string | null }>(`/api/v2/leads/${lead.id}`);
                      deletedToast("Lead deleted", r.recently_deleted_id);
                      refresh();
                      onClose();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            )}
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                ["Opens", lead.email_open_count],
                ["Clicks", lead.email_click_count],
                ["Replies", lead.email_reply_count],
                ["Last contact", lead.timestamp_last_contact ? ago(lead.timestamp_last_contact) : "–"],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-lg bg-panel-2 px-2 py-2">
                  <p className="text-[11px] text-muted">{k}</p>
                  <p className="text-sm font-semibold tabular-nums">{v}</p>
                </div>
              ))}
            </div>
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            className="px-5"
            tabs={[
              { value: "activity", label: "Activity" },
              { value: "details", label: "Details" },
              { value: "notes", label: "Notes" },
            ]}
          >
            <TabPanel value="activity">
              <Timeline data={q.data!} />
            </TabPanel>
            <TabPanel value="details">
              <Details lead={lead} onSaved={refresh} />
            </TabPanel>
            <TabPanel value="notes">
              <Notes lead={lead} />
            </TabPanel>
          </Tabs>
        </>
      )}
    </Sheet>
  );
}

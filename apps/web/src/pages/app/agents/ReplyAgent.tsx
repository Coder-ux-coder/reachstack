import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, FlaskConical, MessageSquare, Pause, Play, Plus, RefreshCw, Send, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { ApiError, del, errorMessage, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { resolveRange, fillDays, type DateRange } from "@/lib/dates";
import { ago, dateTime, num, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { useLeadStatuses } from "@/lib/statuses";
import { useUnsavedChanges } from "@/lib/unsaved";
import { RichEditor } from "@/components/RichEditor";
import { EmailFrame } from "@/components/EmailFrame";
import { RangeSelect } from "@/components/RangeSelect";
import { TrendChart } from "@/components/charts";
import { AccountsPicker } from "@/components/sequence/AccountsPicker";
import { TagPicker, useTags } from "@/components/TagPicker";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  LinkTabs,
  NativeSelect,
  NumberInput,
  Page,
  Section,
  Segmented,
  SkeletonRows,
  StatCard,
  Switch,
  SwitchRow,
  Textarea,
  useConfirm,
} from "@/components/ui";
import { AGENTS_KEY, AgentStatusBadge, AiMissingCallout, ModeBadge, duration, useIntegrations } from "./shared";

// ---------------------------------------------------------------------------------------------------------------
// Types

type Tone = "friendly" | "neutral" | "matter_of_fact" | "professional" | "humorous";
type Length = "concise" | "standard" | "thorough";

interface ReplyPayload {
  configuration_type: 1 | 2;
  tags?: string[];
  handle_followup?: boolean;
  respond_to_automatic_emails?: boolean;
  handle_objections?: boolean;
  integrations?: { slack?: { connection_id: string; enabled?: boolean } | null; calendly?: { connection_id: string } | null };
  no_show?: { enabled?: boolean; max_followups?: number; fallback_sending_accounts?: { accounts?: string[]; tag_ids?: string[] } };
  trigger_on_labels_enabled?: boolean;
  trigger_on_labels?: number[];
  trigger_on_labels_mode?: "include" | "exclude";
  monthly_credit_budget?: number | null;
  followup_business_days_only?: boolean;
}

interface ReplyAgent {
  id: string;
  name: string;
  description: string | null;
  status: number;
  payload: ReplyPayload;
  timestamp_created: string;
}

interface Guidance {
  id: string;
  label: string;
  instruction: string;
  status: 0 | 1;
  category: number;
  basic_guidance_options?: { tone: Tone; length: Length };
}

interface Reply {
  id: string;
  thread_id: string | null;
  lead: string | null;
  html: string | null;
  subject: string | null;
  account_email: string | null;
  requires_hitl: boolean;
  requires_hitl_reason: string | null;
  information_requested: string | null;
  confidence_score: number | null;
  action_pending: boolean;
  sending_status: number | null;
  error_code?: string;
  job_type: number | null;
  followup_number: number | null;
  is_followup: boolean;
  feedback_positive: boolean | null;
  scheduled_send_at: string | null;
  timestamp_created: string;
  classification?: Reading | null;
  discarded_reason?: string | null;
}

/** How the agent read the lead's message before answering. */
interface Reading {
  category: string;
  confidence: number;
  reason: string;
}

interface Overview {
  agent: ReplyAgent;
  ai_available: boolean;
  last_run_at: string | null;
  counts: { pending: number; scheduled: number; sent: number; failed: number; no_show: number };
  recent_events: Array<{ id: string; type: string; payload: Record<string, unknown>; timestamp_created: string }>;
}

const TONES: Array<{ value: Tone; label: string }> = [
  { value: "friendly", label: "Friendly" },
  { value: "neutral", label: "Neutral" },
  { value: "matter_of_fact", label: "Matter-of-fact" },
  { value: "professional", label: "Professional" },
  { value: "humorous", label: "Light and humorous" },
];
const LENGTHS: Array<{ value: Length; label: string }> = [
  { value: "concise", label: "Short" },
  { value: "standard", label: "Standard" },
  { value: "thorough", label: "Detailed" },
];
const CATEGORIES: Array<{ value: number; label: string; hint: string }> = [
  { value: 1, label: "General", hint: "How to talk about you, what to avoid, sign-offs." },
  { value: 2, label: "Objections", hint: "What to say when a lead pushes back, and when to let go." },
  { value: 3, label: "Scheduling", hint: "How to suggest meetings and which times or links to offer." },
  { value: 4, label: "Knowledge", hint: "Facts the agent can use: pricing, features, case studies." },
];
const SKIP_REASONS: Record<string, string> = {
  automatic_email: "left an automatic email alone",
  out_of_office: "left an out-of-office message alone",
  unsubscribe_request: "left an unsubscribe request alone",
  lead_unsubscribed: "left a lead who unsubscribed alone",
  objection_handling_off: "left a decline alone (objection handling is off)",
  answered_by_person: "left a conversation you already answered",
  superseded_by_newer_message: "skipped an older message: the lead wrote again",
  handled_by_sales_agent: "left a reply to an outbound agent's campaign",
  label_not_targeted: "skipped a lead status it isn't set to answer",
  lead_blocked: "skipped a lead on your blocklist",
  recipient_blocked: "left a conversation with an address on your blocklist alone",
  recipient_unsubscribed: "left a conversation with an address that unsubscribed alone",
  recipient_bounced: "didn't follow up with an address that bounced before",
  lead_missing: "skipped a message whose lead was deleted",
  agent_chose_not_to_reply: "decided no answer was needed",
  model_declined: "the AI declined to write this one",
};
const DISCARD_REASONS: Record<string, string> = {
  lead_replied_again: "the lead wrote again",
  answered_by_person: "you answered by hand",
  lead_unsubscribed: "the lead unsubscribed",
};
const READINGS: Record<string, string> = {
  interested: "Interested",
  meeting: "Wants a meeting",
  question: "Question",
  not_interested: "Not interested",
  wrong_person: "Wrong person",
  out_of_office: "Out of office",
  unsubscribe: "Unsubscribe",
  automatic: "Automatic email",
  other: "Other",
};

const agentKey = (id: string) => ["reply-agent", id];

function jobLabel(r: Pick<Reply, "job_type" | "followup_number" | "is_followup">) {
  if (r.job_type === 3) return `No-show follow-up${r.followup_number ? ` #${r.followup_number}` : ""}`;
  if (r.is_followup || r.job_type === 2) return `Follow-up${r.followup_number ? ` #${r.followup_number}` : ""}`;
  return "Reply";
}

// ---------------------------------------------------------------------------------------------------------------
// Settings form (create and edit)

interface FormState {
  name: string;
  payload: ReplyPayload;
  tone: Tone;
  length: Length;
}

const defaultPayload = (noShow: boolean): ReplyPayload => ({
  configuration_type: 1,
  tags: ["default"],
  handle_followup: !noShow,
  respond_to_automatic_emails: false,
  handle_objections: false,
  followup_business_days_only: true,
  trigger_on_labels_enabled: false,
  trigger_on_labels: [],
  trigger_on_labels_mode: "include",
  monthly_credit_budget: null,
  no_show: { enabled: noShow, max_followups: 3, fallback_sending_accounts: { accounts: [], tag_ids: [] } },
  integrations: {},
});

function ReplySettingsFields({ form, set }: { form: FormState; set: (f: Partial<FormState>) => void }) {
  const p = form.payload;
  const setP = (patchP: Partial<ReplyPayload>) => set({ payload: { ...p, ...patchP } });
  const tags = useTags();
  const statuses = useLeadStatuses();
  const integrations = useIntegrations();
  const slack = (integrations.data?.items ?? []).filter((i) => i.type === "slack");
  const calendly = (integrations.data?.items ?? []).filter((i) => i.type === "calendly");
  const allMailboxes = !p.tags?.length || p.tags.includes("default");
  const ns = p.no_show ?? {};
  const fallback = ns.fallback_sending_accounts ?? {};
  const tagNames = (tags.data ?? []).filter((t) => p.tags?.includes(t.id)).map((t) => t.label);
  return (
    <>
      <Section title="Mode" description="You can switch at any time.">
        <div className="space-y-3">
          <Segmented
            value={String(p.configuration_type) as "1" | "2"}
            onChange={(v) => setP({ configuration_type: Number(v) as 1 | 2 })}
            options={[
              { value: "1", label: "Review first" },
              { value: "2", label: "Autopilot" },
            ]}
          />
          <p className="text-[13px] text-muted">
            {p.configuration_type === 2
              ? "Replies the agent is confident about go out a few minutes after the lead writes. Anything unclear, a request for information it doesn't have, or a reply that's more than two days old still waits for you."
              : "Every draft waits in the review queue. Send it as is, edit it, or discard it."}
          </p>
        </div>
      </Section>

      <Section title="Campaigns and mailboxes" description="Which conversations the agent works on.">
        <div className="space-y-3">
          <Segmented
            value={allMailboxes ? "all" : "tags"}
            onChange={(v) => setP({ tags: v === "all" ? ["default"] : [] })}
            options={[
              { value: "all", label: "Everything" },
              { value: "tags", label: "Only tagged ones" },
            ]}
          />
          {!allMailboxes && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <TagPicker value={p.tags ?? []} onChange={(ids) => setP({ tags: ids })} title="Choose tags" />
                <span className="text-[13px] text-muted">{tagNames.length ? tagNames.join(", ") : "No tags chosen yet: the agent answers nothing."}</span>
              </div>
              <p className="text-[13px] text-muted">Tag campaigns, mailboxes or both. With both, a reply needs a tagged campaign and a tagged mailbox.</p>
            </div>
          )}
        </div>
      </Section>

      <Section title="Voice" description="Applies to every reply and follow-up.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tone">{(id) => <NativeSelect id={id} value={form.tone} onChange={(v) => set({ tone: v as Tone })} options={TONES} />}</Field>
          <Field label="Length">{(id) => <NativeSelect id={id} value={form.length} onChange={(v) => set({ length: v as Length })} options={LENGTHS} />}</Field>
        </div>
      </Section>

      <Section title="Behaviour">
        <div className="divide-y divide-line">
          <SwitchRow label="Follow up when a lead goes quiet" description="Up to two follow-ups after 2 and 4 days without an answer." checked={!!p.handle_followup} onChange={(v) => setP({ handle_followup: v })}>
            <Checkbox label="Only on business days" checked={!!p.followup_business_days_only} onChange={(v) => setP({ followup_business_days_only: v })} />
          </SwitchRow>
          <SwitchRow
            label="Answer automatic emails"
            description="Such as ticket confirmations. Out-of-office messages and unsubscribe requests are never answered."
            checked={!!p.respond_to_automatic_emails}
            onChange={(v) => setP({ respond_to_automatic_emails: v })}
          />
          <SwitchRow
            label="Address a decline once"
            description="When a lead says no, answer the objection briefly instead of leaving it. Unsubscribe requests and upset leads always go to you."
            checked={!!p.handle_objections}
            onChange={(v) => setP({ handle_objections: v })}
          />
        </div>
      </Section>

      <Section title="Which replies" description="Limit the agent to leads with certain statuses.">
        <SwitchRow label="Only some lead statuses" checked={!!p.trigger_on_labels_enabled} onChange={(v) => setP({ trigger_on_labels_enabled: v })}>
          <div className="space-y-3">
            <Segmented
              size="sm"
              value={p.trigger_on_labels_mode ?? "include"}
              onChange={(v) => setP({ trigger_on_labels_mode: v })}
              options={[
                { value: "include", label: "Answer these" },
                { value: "exclude", label: "Skip these" },
              ]}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              {statuses.all.map((s) => (
                <Checkbox
                  key={s.code}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                      {s.label}
                    </span>
                  }
                  checked={!!p.trigger_on_labels?.includes(s.code)}
                  onChange={(on) => setP({ trigger_on_labels: on ? [...(p.trigger_on_labels ?? []), s.code] : (p.trigger_on_labels ?? []).filter((c) => c !== s.code) })}
                />
              ))}
            </div>
          </div>
        </SwitchRow>
      </Section>

      <Section title="No-show recovery" description="When you mark a lead as no-show, the agent follows up to find a new time.">
        <SwitchRow label="Recover no-shows" checked={!!ns.enabled} onChange={(v) => setP({ no_show: { ...ns, enabled: v } })}>
          <div className="space-y-3">
            <Field label="Follow-ups to send">
              {(id) => <NumberInput id={id} className="w-28" value={ns.max_followups ?? 3} min={1} max={5} onChange={(v) => setP({ no_show: { ...ns, max_followups: Math.min(5, Math.max(1, v ?? 1)) } })} />}
            </Field>
            <div>
              <p className="text-sm font-medium">Fallback mailboxes</p>
              <p className="mb-2 mt-0.5 text-[13px] text-muted">Used only when there is no earlier conversation with the lead. Otherwise the agent writes from the mailbox the lead already knows.</p>
              <AccountsPicker
                emails={fallback.accounts ?? []}
                tagIds={fallback.tag_ids ?? []}
                onChange={(v) => setP({ no_show: { ...ns, fallback_sending_accounts: { accounts: v.emails, tag_ids: v.tagIds } } })}
              />
            </div>
          </div>
        </SwitchRow>
      </Section>

      <Section title="Integrations" description="Connect apps in Settings → Integrations & API → Apps.">
        <div className="space-y-4">
          <Field label="Booking link (Calendly)" optional>
            {(id) => (
              <NativeSelect
                id={id}
                value={p.integrations?.calendly?.connection_id ?? ""}
                onChange={(v) => setP({ integrations: { ...p.integrations, calendly: v ? { connection_id: v } : null } })}
                options={[{ value: "", label: calendly.length ? "Don't offer a booking link" : "No Calendly connection yet" }, ...calendly.map((c) => ({ value: c.id, label: c.name }))]}
              />
            )}
          </Field>
          <Field label="Slack alerts" optional>
            {(id) => (
              <NativeSelect
                id={id}
                value={p.integrations?.slack?.connection_id ?? ""}
                onChange={(v) => setP({ integrations: { ...p.integrations, slack: v ? { connection_id: v, enabled: true } : null } })}
                options={[{ value: "", label: slack.length ? "No alerts" : "No Slack connection yet" }, ...slack.map((c) => ({ value: c.id, label: c.name }))]}
              />
            )}
          </Field>
          {!slack.length && !calendly.length && (
            <Link to="/app/settings/integrations" className="text-[13px] font-medium text-brand-text hover:underline">
              Connect Slack or Calendly
            </Link>
          )}
        </div>
      </Section>

      <Section title="Monthly limit" description="Stop drafting after this many replies in a calendar month.">
        <div className="flex items-center gap-3">
          <Switch checked={p.monthly_credit_budget != null} onChange={(on) => setP({ monthly_credit_budget: on ? 500 : null })} aria-label="Limit drafts per month" />
          {p.monthly_credit_budget != null ? (
            <NumberInput className="w-36" value={p.monthly_credit_budget} min={1} max={1_000_000} suffix="drafts" onChange={(v) => setP({ monthly_credit_budget: Math.max(1, v ?? 1) })} aria-label="Drafts per month" />
          ) : (
            <span className="text-[13px] text-muted">No limit</span>
          )}
        </div>
      </Section>
    </>
  );
}

/** Create form at /app/ai-agents/create?type=reply|no_show. */
export function ReplyAgentForm({ preset }: { preset?: "no_show" }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const ai = useQuery({ queryKey: ["ai-settings"], queryFn: () => get<{ available: boolean }>("/api/app/ai/settings"), retry: false });
  const [form, setForm] = useState<FormState>({ name: preset === "no_show" ? "No-show recovery" : "Reply agent", payload: defaultPayload(preset === "no_show"), tone: "professional", length: "concise" });
  const [busy, setBusy] = useState(false);
  const set = (f: Partial<FormState>) => setForm((x) => ({ ...x, ...f }));
  const create = async () => {
    setBusy(true);
    try {
      const a = await post<ReplyAgent>("/api/v2/ai-agents/inbox-manager", {
        name: form.name.trim(),
        payload: form.payload,
        guidances: [{ label: "Tone and length", category: 0, basic_guidance_options: { tone: form.tone, length: form.length } }],
      });
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success("Agent created. Add guidance so it answers the way you would.");
      nav(`/app/ai-agents/${a.id}/configuration`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {ai.data && !ai.data.available && (
        <div className="mb-4">
          <AiMissingCallout what="The reply agent" />
        </div>
      )}
      <Section title="Name">
        <Input value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} aria-label="Agent name" />
      </Section>
      <ReplySettingsFields form={form} set={set} />
      <div className="flex justify-end gap-2 pt-4">
        <Button onClick={() => nav("/app/ai-agents/create")}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={create}>
          Create agent
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Shell: header + tabs

function useReplyAgent(id: string) {
  return useQuery({ queryKey: agentKey(id), queryFn: () => get<Overview>(`/api/app/ai-agents/inbox-manager/${id}/overview`), refetchInterval: 30_000 });
}

export function ReplyShell({ id }: { id: string }) {
  const q = useReplyAgent(id);
  const can = useCan();
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  usePageTitle(q.data?.agent.name ?? "Reply agent");
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (!q.data) return <EmptyState title="Agent not found" />;
  const a = q.data.agent;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: agentKey(id) });
    qc.invalidateQueries({ queryKey: AGENTS_KEY });
  };
  const toggle = async () => {
    try {
      await patch(`/api/v2/ai-agents/inbox-manager/${id}`, { status: a.status === 1 ? 0 : 1 });
      toast.success(a.status === 1 ? "Agent paused. Scheduled replies are held for review." : "Agent is on. It answers replies that arrive from now on.");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const setMode = async (autopilot: boolean) => {
    try {
      await patch(`/api/v2/ai-agents/inbox-manager/${id}`, { payload: { configuration_type: autopilot ? 2 : 1 } });
      toast.success(autopilot ? "Autopilot on" : "Every draft now waits for review");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const run = async () => {
    setRunning(true);
    try {
      const r = await post<{ drafted: number }>(`/api/app/ai-agents/inbox-manager/${id}/run`);
      toast.success(r.drafted ? `Drafted ${plural(r.drafted, "reply", "replies")}` : "Nothing new to answer");
      refresh();
      qc.invalidateQueries({ queryKey: ["reply-agent-replies", id] });
    } catch (e) {
      // 409: a check is already running (another server's); its drafts arrive by themselves.
      if (e instanceof ApiError && e.status === 409) toast.info(e.message);
      else toast.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };
  const base = `/app/ai-agents/${id}`;
  return (
    <Page>
      <Link to="/app/ai-agents" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> Agents
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{a.name}</h1>
        <AgentStatusBadge status={a.status} />
        <ModeBadge mode={a.payload.configuration_type === 2 ? "autopilot" : "review"} />
        {can.write && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            <label className="mr-1 inline-flex items-center gap-2 text-[13px] text-muted">
              Autopilot
              <Switch checked={a.payload.configuration_type === 2} onChange={setMode} aria-label="Autopilot" />
            </label>
            {a.status === 1 && (
              <Button icon={<RefreshCw size={14} />} loading={running} onClick={run} disabled={!q.data.ai_available}>
                Check now
              </Button>
            )}
            <Button variant={a.status === 1 ? "secondary" : "primary"} icon={a.status === 1 ? <Pause size={14} /> : <Play size={14} />} onClick={toggle}>
              {a.status === 1 ? "Pause" : "Turn on"}
            </Button>
          </div>
        )}
      </div>
      <p className="mt-1 text-[13px] text-muted">{q.data.last_run_at ? `Last checked the inbox ${ago(q.data.last_run_at)}` : "Hasn't checked the inbox yet"}</p>
      {!q.data.ai_available && (
        <div className="mt-4">
          <AiMissingCallout what="The reply agent" />
        </div>
      )}
      <LinkTabs
        className="mt-5"
        tabs={[
          { to: base, label: "Overview" },
          { to: `${base}/configuration`, label: "Configuration" },
          { to: `${base}/details`, label: "Results" },
        ]}
      />
      <div className="pt-6">
        <Outlet context={{ id, kind: "reply" }} />
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Overview: review queue, playground, recent events

function ReviewCard({ agentId, r, onDone }: { agentId: string; r: Reply; onDone: () => void }) {
  const can = useCan();
  const [html, setHtml] = useState(r.html ?? "");
  const [busy, setBusy] = useState<"send" | "save" | "discard" | null>(null);
  const [feedback, setFeedback] = useState<boolean | null>(r.feedback_positive);
  const edited = html !== (r.html ?? "");
  const act = async (kind: "send" | "save" | "discard") => {
    setBusy(kind);
    try {
      if (kind === "send") {
        await post(`/api/app/ai-agents/inbox-manager/${agentId}/replies/${r.id}/approve`, edited || !r.html ? { html } : {});
        toast.success("Reply sent");
      } else if (kind === "save") {
        await patch(`/api/app/ai-agents/inbox-manager/${agentId}/replies/${r.id}`, { html });
        toast.success("Draft saved");
      } else {
        await post(`/api/app/ai-agents/inbox-manager/${agentId}/replies/${r.id}/discard`);
        toast.success("Draft discarded");
      }
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const rate = async (positive: boolean) => {
    const next = feedback === positive ? null : positive;
    setFeedback(next);
    try {
      await patch(`/api/v2/ai-agents/inbox-manager/${agentId}/replies/${r.id}`, next === null ? {} : { feedback_positive: next });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const reason = r.information_requested ? `Needs information: ${r.information_requested}` : r.requires_hitl_reason;
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{r.lead ?? "Unknown lead"}</p>
          <p className="truncate text-xs text-muted">
            {r.subject ?? "(no subject)"}
            {r.account_email && ` · from ${r.account_email}`}
          </p>
        </div>
        <Badge>{jobLabel(r)}</Badge>
        {r.classification && (
          <span title={r.classification.reason}>
            <Badge tone="info">{READINGS[r.classification.category] ?? r.classification.category}</Badge>
          </span>
        )}
        {r.confidence_score !== null && <Badge tone={r.confidence_score >= 70 ? "ok" : "warn"}>{r.confidence_score}% sure</Badge>}
        <span className="text-xs text-faint">{ago(r.timestamp_created)}</span>
      </div>
      {reason && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <span className="font-medium">Why it's waiting: </span>
          {reason}
        </p>
      )}
      {can.write ? (
        <RichEditor value={html} onChange={setHtml} minHeight={120} placeholder="Write the reply…" />
      ) : (
        <div className="rounded-lg border border-line px-3 py-2.5">
          <EmailFrame html={r.html ?? ""} minHeight={80} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {can.write && (
          <>
            <Button variant="primary" size="sm" icon={<Send size={14} />} loading={busy === "send"} disabled={!html.trim() || !!busy} onClick={() => act("send")}>
              Send
            </Button>
            {edited && (
              <Button size="sm" loading={busy === "save"} disabled={!!busy || !html.trim()} onClick={() => act("save")}>
                Save draft
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<X size={14} />} loading={busy === "discard"} disabled={!!busy} onClick={() => act("discard")}>
              Discard
            </Button>
          </>
        )}
        {r.thread_id && (
          <Link to={`/app/unibox?thread=${r.thread_id}`} className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
            <MessageSquare size={14} /> Conversation
          </Link>
        )}
        <span className="ml-auto inline-flex items-center gap-1">
          <span className="mr-1 text-xs text-faint">Good draft?</span>
          <Button size="icon-sm" variant="ghost" aria-label="Good draft" aria-pressed={feedback === true} className={cn(feedback === true && "text-ok")} onClick={() => rate(true)}>
            <ThumbsUp size={14} />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Poor draft" aria-pressed={feedback === false} className={cn(feedback === false && "text-bad")} onClick={() => rate(false)}>
            <ThumbsDown size={14} />
          </Button>
        </span>
      </div>
    </Card>
  );
}

function Playground({ agentId, disabled }: { agentId: string; disabled: boolean }) {
  const [message, setMessage] = useState("Thanks for reaching out. What does it cost, and do you work with teams our size?");
  const [lead, setLead] = useState({ first_name: "Sam", company_name: "Acme" });
  const [mode, setMode] = useState<"reply" | "followup" | "no_show">("reply");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    decision: string;
    html: string;
    confidence_score: number;
    requires_hitl: boolean;
    requires_hitl_reason: string | null;
    information_requested: string | null;
    calendly_tool_used: boolean;
    would_send_automatically: boolean;
    classification?: Reading | null;
  } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setResult(await post(`/api/app/ai-agents/inbox-manager/${agentId}/playground`, { message, lead, mode }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Try the agent" description="Write a message as a lead would. Nothing is saved or sent." />
      <div className="space-y-3">
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "reply", label: "Lead replied" },
            { value: "followup", label: "Lead went quiet" },
            { value: "no_show", label: "Lead missed a meeting" },
          ]}
        />
        <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Message from the lead" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input inputSize="sm" value={lead.first_name} onChange={(e) => setLead({ ...lead, first_name: e.target.value })} placeholder="First name" aria-label="Lead first name" />
          <Input inputSize="sm" value={lead.company_name} onChange={(e) => setLead({ ...lead, company_name: e.target.value })} placeholder="Company" aria-label="Lead company" />
        </div>
        <Button icon={<FlaskConical size={14} />} loading={busy} disabled={disabled || !message.trim()} onClick={run}>
          Draft a reply
        </Button>
        {result && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={result.decision === "reply" ? "ok" : "warn"}>{result.decision === "reply" ? "Would reply" : result.decision === "request_info" ? "Needs information" : "Wouldn't answer"}</Badge>
              {result.classification && (
                <span title={result.classification.reason}>
                  <Badge tone="info">Reads as: {READINGS[result.classification.category] ?? result.classification.category}</Badge>
                </span>
              )}
              <Badge>{result.confidence_score}% sure</Badge>
              <Badge tone={result.would_send_automatically ? "brand" : "neutral"}>{result.would_send_automatically ? "Sends on autopilot" : "Waits for review"}</Badge>
              {result.calendly_tool_used && <Badge tone="info">Offers booking link</Badge>}
            </div>
            {(result.information_requested || result.requires_hitl_reason) && <p className="text-[13px] text-muted">{result.information_requested ? `Missing: ${result.information_requested}` : result.requires_hitl_reason}</p>}
            {result.html && (
              <div className="rounded-lg border border-line px-3 py-2.5">
                <EmailFrame html={result.html} minHeight={60} />
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function eventText(e: Overview["recent_events"][number]) {
  const p = e.payload;
  switch (e.type) {
    case "reply_skipped":
      return `Skipped a message: ${SKIP_REASONS[String(p.reason)] ?? String(p.reason ?? "no reason given").replace(/_/g, " ")}`;
    case "draft_discarded":
      return `Discarded a draft for ${String(p.lead_email ?? "a lead")}: ${DISCARD_REASONS[String(p.reason)] ?? String(p.reason ?? "it went out of date").replace(/_/g, " ")}`;
    case "run_failed":
      return `A check failed: ${String(p.error ?? "unknown error")}`;
    case "no_show_detected":
      return `No-show noticed for ${String(p.lead_email ?? "a lead")}`;
    case "recovery":
      return `Recovered ${String(p.lead_email ?? "a lead")}${p.recovery_method ? ` (${String(p.recovery_method).replace(/_/g, " ")})` : ""}`;
    default:
      return e.type.replace(/_/g, " ");
  }
}

export function ReplyOverview({ id }: { id: string }) {
  const q = useReplyAgent(id);
  const qc = useQueryClient();
  const queue = useQuery({
    queryKey: ["reply-agent-replies", id, "pending"],
    queryFn: () => get<{ items: Reply[] }>(`/api/v2/ai-agents/inbox-manager/${id}/replies`, { action_pending: true, limit: 50 }),
    refetchInterval: 30_000,
  });
  const recent = useQuery({ queryKey: ["reply-agent-replies", id, "recent"], queryFn: () => get<{ items: Reply[] }>(`/api/v2/ai-agents/inbox-manager/${id}/replies`, { action_pending: false, limit: 30 }) });
  const scheduled = (recent.data?.items ?? []).filter((r) => r.sending_status === 2);
  const pending = (queue.data?.items ?? []).filter((r) => r.sending_status !== 1);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["reply-agent-replies", id] });
    qc.invalidateQueries({ queryKey: agentKey(id) });
  };
  if (!q.data) return <SkeletonRows rows={4} />;
  const c = q.data.counts;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Waiting for you" value={num(c.pending)} tone={c.pending ? "warn" : undefined} />
          <StatCard label="Sending soon" value={num(c.scheduled)} />
          <StatCard label="Sent" value={num(c.sent)} />
          <StatCard label="Failed" value={num(c.failed)} tone={c.failed ? "bad" : undefined} />
        </div>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Review queue</h2>
          {pending.length > 0 && <span className="text-xs text-muted">{plural(pending.length, "draft")}</span>}
        </div>
        {queue.isLoading ? (
          <SkeletonRows rows={3} />
        ) : pending.length ? (
          pending.map((r) => <ReviewCard key={r.id} agentId={id} r={r} onDone={refresh} />)
        ) : (
          <Card>
            <p className="text-center text-[13px] text-muted">Nothing waiting. New drafts appear here when a lead replies{q.data.agent.payload.configuration_type === 2 ? " and the agent isn't sure enough to send on its own" : ""}.</p>
          </Card>
        )}
        {scheduled.length > 0 && (
          <Card>
            <CardHeader title="Sending soon" description="Autopilot replies go out a few minutes after the lead writes, so it doesn't feel automated." />
            <ul className="divide-y divide-line text-[13px]">
              {scheduled.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate">{r.lead}</span>
                  <span className="text-xs text-muted">{r.scheduled_send_at ? dateTime(r.scheduled_send_at) : ""}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await post(`/api/app/ai-agents/inbox-manager/${id}/replies/${r.id}/discard`);
                        refresh();
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                  >
                    Cancel
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <div className="space-y-4">
        <Playground agentId={id} disabled={!q.data.ai_available} />
        <Card>
          <CardHeader title="Recent events" />
          {q.data.recent_events.length ? (
            <ul className="space-y-2.5 text-[13px]">
              {q.data.recent_events.map((e) => (
                <li key={e.id}>
                  <p>{eventText(e)}</p>
                  <p className="text-xs text-faint">{ago(e.timestamp_created)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">Nothing yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration: settings + guidance

function GuidanceDialog({ agentId, value, onClose }: { agentId: string; value: Guidance | "new" | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ label: "", category: 1, instruction: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (value === "new") setForm({ label: "", category: 1, instruction: "" });
    else if (value) setForm({ label: value.label, category: value.category, instruction: value.instruction });
  }, [value]);
  const save = async () => {
    setBusy(true);
    try {
      if (value === "new") await post(`/api/v2/ai-agents/inbox-manager/${agentId}/guidances`, { ...form, label: form.label.trim() });
      else if (value) await patch(`/api/v2/ai-agents/inbox-manager/${agentId}/guidances/${value.id}`, { ...form, label: form.label.trim() });
      await qc.invalidateQueries({ queryKey: ["reply-agent-guidance", agentId] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const hint = CATEGORIES.find((c) => c.value === form.category)?.hint;
  return (
    <Dialog
      open={!!value}
      onOpenChange={(v) => !v && onClose()}
      title={value === "new" ? "Add guidance" : "Edit guidance"}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.label.trim() || !form.instruction.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Field label="Title">{(id) => <Input id={id} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={200} placeholder="Pricing questions" autoFocus />}</Field>
          <Field label="Kind">{(id) => <NativeSelect id={id} value={String(form.category)} onChange={(v) => setForm({ ...form, category: Number(v) })} options={CATEGORIES.map((c) => ({ value: String(c.value), label: c.label }))} />}</Field>
        </div>
        <Field label="Instruction" hint={hint}>
          {(id) => (
            <Textarea
              id={id}
              rows={7}
              value={form.instruction}
              onChange={(e) => setForm({ ...form, instruction: e.target.value })}
              maxLength={10_000}
              placeholder="When someone asks about price, share that plans start at $99/month and offer a short call to find the right one."
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function GuidanceList({ agentId }: { agentId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Guidance | "new" | null>(null);
  const q = useQuery({ queryKey: ["reply-agent-guidance", agentId], queryFn: () => get<{ items: Guidance[] }>(`/api/v2/ai-agents/inbox-manager/${agentId}/guidances`, { limit: 100 }) });
  const items = (q.data?.items ?? []).filter((g) => g.category !== 0);
  const toggle = async (g: Guidance, on: boolean) => {
    try {
      await patch(`/api/v2/ai-agents/inbox-manager/${agentId}/guidances/${g.id}`, { status: on ? 1 : 0 });
      qc.invalidateQueries({ queryKey: ["reply-agent-guidance", agentId] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async (g: Guidance) => {
    if (!(await confirm({ title: `Delete "${g.label}"?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await del(`/api/v2/ai-agents/inbox-manager/${agentId}/guidances/${g.id}`);
      qc.invalidateQueries({ queryKey: ["reply-agent-guidance", agentId] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Section
      title="Guidance"
      description="Teach the agent what you know: how to answer common questions, handle objections and book meetings. Turn a rule off to keep it without using it."
      actions={
        can.write && (
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
            Add guidance
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <SkeletonRows rows={2} />
      ) : items.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {items.map((g) => (
            <li key={g.id} className="flex items-start gap-3 px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="-my-1 py-1 font-medium hover:underline" onClick={() => can.write && setEditing(g)}>
                    {g.label}
                  </button>
                  <Badge>{CATEGORIES.find((c) => c.value === g.category)?.label ?? "General"}</Badge>
                </div>
                <p className={cn("mt-1 line-clamp-2 whitespace-pre-line text-[13px]", g.status ? "text-muted" : "text-faint")}>{g.instruction}</p>
              </div>
              {can.write && (
                <>
                  <Switch checked={g.status === 1} onChange={(v) => toggle(g, v)} aria-label={`Use "${g.label}"`} />
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete "${g.label}"`} onClick={() => remove(g)}>
                    <Trash2 size={14} />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No guidance yet. The agent uses your business details and the conversation so far.</p>
      )}
      <GuidanceDialog agentId={agentId} value={editing} onClose={() => setEditing(null)} />
    </Section>
  );
}

export function ReplyConfiguration({ id }: { id: string }) {
  const q = useReplyAgent(id);
  const qc = useQueryClient();
  const can = useCan();
  const nav = useNavigate();
  const confirm = useConfirm();
  const guidance = useQuery({ queryKey: ["reply-agent-guidance", id], queryFn: () => get<{ items: Guidance[] }>(`/api/v2/ai-agents/inbox-manager/${id}/guidances`, { limit: 100 }) });
  const basics = guidance.data?.items.find((g) => g.category === 0);
  const baseline = useMemo<FormState | null>(
    () =>
      q.data && guidance.data
        ? {
            name: q.data.agent.name,
            payload: { ...defaultPayload(false), ...q.data.agent.payload },
            tone: basics?.basic_guidance_options?.tone ?? "professional",
            length: basics?.basic_guidance_options?.length ?? "concise",
          }
        : null,
    [q.data, guidance.data, basics],
  );
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (baseline && !form) setForm(baseline);
  }, [baseline, form]);
  const dirty = !!form && !!baseline && JSON.stringify(form) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty && !busy);
  if (!form || !baseline) return <SkeletonRows rows={6} />;
  const set = (f: Partial<FormState>) => setForm((x) => (x ? { ...x, ...f } : x));
  const save = async () => {
    setBusy(true);
    try {
      await patch(`/api/v2/ai-agents/inbox-manager/${id}`, { name: form.name.trim(), payload: form.payload });
      if (form.tone !== baseline.tone || form.length !== baseline.length) {
        const options = { tone: form.tone, length: form.length };
        if (basics) await patch(`/api/v2/ai-agents/inbox-manager/${id}/guidances/${basics.id}`, { basic_guidance_options: options });
        else await post(`/api/v2/ai-agents/inbox-manager/${id}/guidances`, { label: "Tone and length", category: 0, basic_guidance_options: options });
      }
      await Promise.all([qc.invalidateQueries({ queryKey: agentKey(id) }), qc.invalidateQueries({ queryKey: ["reply-agent-guidance", id] }), qc.invalidateQueries({ queryKey: AGENTS_KEY })]);
      setForm(null);
      toast.success("Settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete "${q.data!.agent.name}"?`, description: "Drafts waiting for review are discarded. Replies already sent stay in the Unibox.", confirmLabel: "Delete agent", danger: true }))) return;
    try {
      await del(`/api/v2/ai-agents/inbox-manager/${id}`);
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success("Agent deleted");
      nav("/app/ai-agents");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div>
      <GuidanceList agentId={id} />
      <Section title="Name">
        <Input value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} aria-label="Agent name" disabled={!can.write} />
      </Section>
      <ReplySettingsFields form={form} set={set} />
      {can.write && (
        <>
          <div className="sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-2 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
            {dirty && <span className="mr-auto text-[13px] text-muted">Unsaved changes</span>}
            <Button disabled={!dirty || busy} onClick={() => setForm(baseline)}>
              Reset
            </Button>
            <Button variant="primary" loading={busy} disabled={!dirty || !form.name.trim()} onClick={save}>
              Save settings
            </Button>
          </div>
          <Section title="Delete agent" description="Stops it for good. Its history goes too.">
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={remove}>
              Delete agent
            </Button>
          </Section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Results

interface Summary {
  total_actions: number;
  replies_count: number;
  follow_ups_count: number;
  human_intervention: number;
  info_requested: number;
  unique_conversations: number;
  time_saved: number;
  average_confidence_score: number;
  involvement_rate: number;
  resolution_rate: number;
  no_show_follow_ups_generated: number;
  no_show_total_leads_recovered: number;
  no_show_total_revenue_recovered: number;
  no_show_recovery_rate: number;
}

interface ActivityRow {
  id: string;
  timestamp_created: string;
  activity_type: "reply" | "followup" | "recovery";
  job_type: number | null;
  lead_email: string;
  thread_id: string | null;
  requires_hitl: boolean | null;
  action_pending: boolean | null;
  sending_status: number | null;
  error_code: string | null;
  followup_number: number | null;
  information_requested: string | null;
  recovery_method: string | null;
  revenue_recovered: number | null;
  classification?: string | null;
  discarded_reason?: string | null;
}

function activityStatus(r: ActivityRow) {
  if (r.activity_type === "recovery") return <Badge tone="ok">Recovered</Badge>;
  if (r.sending_status === 1) return <Badge tone="ok">Sent</Badge>;
  if (r.action_pending) return <Badge tone="warn">Waiting for you</Badge>;
  if (r.sending_status === 2) return <Badge tone="info">Scheduled</Badge>;
  if (r.error_code) return <Badge tone="bad">{r.error_code === "MONTHLY_BUDGET_EXCEEDED" ? "Monthly limit reached" : r.error_code.replace(/_/g, " ").toLowerCase()}</Badge>;
  const why = r.discarded_reason ? DISCARD_REASONS[r.discarded_reason] : undefined;
  return <Badge>{why ? `Discarded: ${why}` : "Discarded"}</Badge>;
}

export function ReplyDetails({ id }: { id: string }) {
  const zone = useWorkspaceZone();
  const [range, setRange] = useState<DateRange>(() => resolveRange("30d", undefined, zone));
  const [type, setType] = useState<"all" | "reply" | "followup" | "recovery">("all");
  const agent = useReplyAgent(id);
  const params = { from: range.start_date, to: range.end_date };
  const summary = useQuery({ queryKey: ["reply-agent-summary", id, params], queryFn: () => get<Summary>(`/api/v2/ai-agents/inbox-manager/${id}/analytics/summary`, params) });
  const byDate = useQuery({
    queryKey: ["reply-agent-by-date", id, params],
    queryFn: () => get<Array<{ date: string; replies_count: number; follow_ups_count: number; human_intervention: number; no_show_follow_ups_generated: number }>>(`/api/v2/ai-agents/inbox-manager/${id}/analytics/summary-by-date`, params),
  });
  const activity = useInfiniteQuery({
    queryKey: ["reply-agent-activity", id, type],
    queryFn: ({ pageParam }) =>
      get<{ items: ActivityRow[]; next_starting_after?: string }>(`/api/v2/ai-agents/inbox-manager/${id}/analytics/activity`, { limit: 25, starting_after: pageParam, activity_type: type === "all" ? undefined : type }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_starting_after,
  });
  const s = summary.data;
  const noShow = !!agent.data?.agent.payload.no_show?.enabled;
  const rows = activity.data?.pages.flatMap((p) => p.items) ?? [];
  const chart = byDate.data ? fillDays(byDate.data, range.start_date, range.end_date, { replies_count: 0, follow_ups_count: 0, human_intervention: 0, no_show_follow_ups_generated: 0 }) : [];
  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <RangeSelect value={range} onChange={setRange} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Replies drafted" value={num(s?.replies_count)} sub={`${num(s?.follow_ups_count)} follow-ups`} />
        <StatCard label="Conversations" value={num(s?.unique_conversations)} sub={s ? `Took part in ${s.involvement_rate}% of replies` : undefined} />
        <StatCard label="Handled by the agent" value={s ? `${s.resolution_rate}%` : "–"} sub={s ? `${num(s.human_intervention)} needed you` : undefined} />
        <StatCard label="Time saved" value={s ? duration(s.time_saved) : "–"} sub={s ? `Average confidence ${s.average_confidence_score}%` : undefined} />
      </div>
      {noShow && s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="No-show follow-ups" value={num(s.no_show_follow_ups_generated)} />
          <StatCard label="Meetings recovered" value={num(s.no_show_total_leads_recovered)} />
          <StatCard label="Recovery rate" value={`${s.no_show_recovery_rate}%`} />
          <StatCard label="Value recovered" value={num(s.no_show_total_revenue_recovered)} />
        </div>
      )}
      <Card>
        <CardHeader title="Activity by day" />
        <TrendChart
          data={chart}
          series={[
            { key: "replies_count", label: "Replies" },
            { key: "follow_ups_count", label: "Follow-ups" },
            { key: "human_intervention", label: "Needed you" },
            ...(noShow ? [{ key: "no_show_follow_ups_generated", label: "No-show follow-ups" }] : []),
          ]}
          height={220}
        />
      </Card>
      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Everything the agent did</h2>
          <Segmented
            size="sm"
            value={type}
            onChange={setType}
            options={[
              { value: "all", label: "All" },
              { value: "reply", label: "Replies" },
              { value: "followup", label: "Follow-ups" },
              { value: "recovery", label: "Recoveries" },
            ]}
          />
        </div>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          loading={activity.isLoading}
          hasMore={activity.hasNextPage}
          loadingMore={activity.isFetchingNextPage}
          onLoadMore={() => activity.fetchNextPage()}
          empty={<p className="py-10 text-center text-[13px] text-muted">No activity in this view yet.</p>}
          columns={[
            { key: "lead", header: "Lead", cell: (r) => (r.thread_id ? <Link to={`/app/unibox?thread=${r.thread_id}`} className="hover:underline">{r.lead_email || "—"}</Link> : r.lead_email || "—") },
            { key: "what", header: "What", cell: (r) => (r.activity_type === "recovery" ? "Meeting rebooked" : jobLabel({ job_type: r.job_type, followup_number: r.followup_number, is_followup: r.activity_type === "followup" })) },
            { key: "status", header: "Result", cell: activityStatus },
            { key: "when", header: "When", cell: (r) => <span className="text-muted">{dateTime(r.timestamp_created)}</span>, hideBelow: "sm" },
          ]}
        />
      </Card>
    </div>
  );
}

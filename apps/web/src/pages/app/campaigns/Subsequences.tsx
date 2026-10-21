import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useNavigate, useOutletContext, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertOctagon, ArrowLeft, Copy, Eye, GitBranch, MessageSquareReply, MousePointerClick, Pause, Pencil, Play, Plus, Save, Send, Trash2 } from "lucide-react";
import { CampaignStatus, SubsequenceActivity, type CampaignSchedule, type SequenceStep } from "@reachstack/shared";
import { del, errorMessage, get, patch, post, type Page } from "@/lib/api";
import { useLeadStatuses } from "@/lib/statuses";
import { daysBefore, fillDays, resolveRange, todayIn, type DateRange } from "@/lib/dates";
import { num, pct, plural } from "@/lib/format";
import { deletedToast, restorable } from "@/lib/recently-deleted";
import { useUnsavedChanges } from "@/lib/unsaved";
import { useWorkspaceZone } from "@/lib/session";
import { RangeSelect } from "@/components/RangeSelect";
import { SERIES_COLORS, TrendChart } from "@/components/charts";
import { CampaignStatusBadge } from "@/components/status";
import { SequenceEditor } from "@/components/sequence/SequenceEditor";
import { ScheduleEditor } from "@/components/sequence/ScheduleEditor";
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FullPageSpinner,
  Input,
  LinkTabs,
  NativeSelect,
  NumberInput,
  Progress,
  RowMenu,
  MenuItem,
  MenuSeparator,
  Segmented,
  Select,
  Skeleton,
  StatCard,
  useConfirm,
} from "@/components/ui";
import { RecordMissing } from "@/pages/errors";
import { useCampaign, type CampaignDetail } from "./context";
import { StepTable, type StepRow } from "./StepTable";

export interface Conditions {
  crm_status?: number[];
  lead_activity?: number[];
  reply_contains?: string;
}

export interface Subsequence {
  id: string;
  name: string;
  status: number;
  parent_campaign: string;
  conditions: Conditions;
  subsequence_schedule: CampaignSchedule | null;
  sequences: Array<{ steps: SequenceStep[] }>;
  auto_variant_select: { trigger: "reply_rate" | "click_rate" | "open_rate" } | null;
  daily_limit_mode: "inherit" | "custom" | "unlimited";
  daily_limit: number | null;
  ignore_account_daily_limit: boolean;
  timestamp_created: string;
}

const ACTIVITIES = [
  { code: SubsequenceActivity.EMAIL_OPENED, label: "Opened an email" },
  { code: SubsequenceActivity.LINK_CLICKED, label: "Clicked a link" },
  { code: SubsequenceActivity.COMPLETED_WITHOUT_REPLY, label: "Finished the sequence without replying" },
];

function useConditionSummary() {
  const statuses = useLeadStatuses();
  return (c: Conditions) => {
    const parts: string[] = [];
    if (c.crm_status?.length) parts.push(`status is ${c.crm_status.map((s) => statuses.all.find((x) => x.code === s)?.label ?? s).join(" or ")}`);
    if (c.lead_activity?.length) parts.push(c.lead_activity.map((a) => ACTIVITIES.find((x) => x.code === a)?.label.toLowerCase() ?? a).join(" or "));
    if (c.reply_contains?.trim()) parts.push(`reply contains “${c.reply_contains.trim()}”`);
    return parts.length ? `When a lead ${parts.join(", or ")}` : "No trigger set";
  };
}

/** Trigger editor shared by the create flow and the options tab. */
function ConditionsEditor({ value, onChange, disabled }: { value: Conditions; onChange: (c: Conditions) => void; disabled?: boolean }) {
  const statuses = useLeadStatuses();
  const toggle = (key: "crm_status" | "lead_activity", code: number, on: boolean) => {
    const cur = value[key] ?? [];
    onChange({ ...value, [key]: on ? [...cur, code] : cur.filter((x) => x !== code) });
  };
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-[13px] font-medium">Lead status changes to</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {statuses.all.map((s) => (
            <Checkbox
              key={s.code}
              disabled={disabled}
              checked={!!value.crm_status?.includes(s.code)}
              onChange={(v) => toggle("crm_status", s.code, v)}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </span>
              }
            />
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 text-[13px] font-medium">Lead activity</p>
        <div className="space-y-2">
          {ACTIVITIES.map((a) => (
            <Checkbox key={a.code} disabled={disabled} checked={!!value.lead_activity?.includes(a.code)} onChange={(v) => toggle("lead_activity", a.code, v)} label={a.label} />
          ))}
        </div>
      </div>
      <Field label="Reply contains" optional hint="Looks at what the lead wrote, not your quoted email. Case-insensitive. Example: “next quarter”.">
        {(id) => <Input id={id} disabled={disabled} value={value.reply_contains ?? ""} onChange={(e) => onChange({ ...value, reply_contains: e.target.value })} />}
      </Field>
    </div>
  );
}

const hasTrigger = (c: Conditions) => !!(c.crm_status?.length || c.lead_activity?.length || c.reply_contains?.trim());

function DuplicateFromDialog({ open, onOpenChange, campaignId }: { open: boolean; onOpenChange: (v: boolean) => void; campaignId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [pick, setPick] = useState("");
  const others = useQuery({
    queryKey: ["subsequences", "others", campaignId],
    queryFn: () => get<Page<Subsequence>>("/api/v2/subsequences", { parent_campaign_not: campaignId, limit: 100 }),
    enabled: open,
  });
  const run = async () => {
    try {
      const s = await post<Subsequence>(`/api/v2/subsequences/${pick}/duplicate`, { parent_campaign: campaignId });
      await qc.invalidateQueries({ queryKey: ["subsequences", campaignId] });
      onOpenChange(false);
      navigate(`/app/campaign/${campaignId}/subsequences/${s.id}/sequences`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Duplicate an existing subsequence"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!pick} onClick={run}>
            Duplicate here
          </Button>
        </>
      }
    >
      {others.isLoading ? (
        <Skeleton className="h-9" />
      ) : others.data?.items.length ? (
        <Select value={pick} onChange={setPick} placeholder="Choose a subsequence" options={others.data.items.map((s) => ({ value: s.id, label: s.name }))} />
      ) : (
        <p className="text-[13px] text-muted">Other campaigns don't have subsequences yet.</p>
      )}
    </Dialog>
  );
}

/** /app/campaign/:id/subsequences */
export default function SubsequencesTab() {
  const { campaign, readOnly } = useCampaign();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const summary = useConditionSummary();
  const [dupOpen, setDupOpen] = useState(false);
  const list = useQuery({ queryKey: ["subsequences", campaign.id], queryFn: () => get<Page<Subsequence>>("/api/v2/subsequences", { parent_campaign: campaign.id, limit: 100 }) });
  const stats = useQuery({
    queryKey: ["subsequences", campaign.id, "analytics"],
    queryFn: () => get<Array<{ subsequence_id: string; emails_sent: number; unique_opens: number; unique_replies: number }>>("/api/v2/subsequences/analytics", { campaign_id: campaign.id }),
  });
  const byId = new Map((stats.data ?? []).map((s) => [s.subsequence_id, s]));
  // Resuming one can set its finished campaign running again, so the campaign's status is fetched again too.
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["subsequences", campaign.id] }), qc.invalidateQueries({ queryKey: ["campaign", campaign.id] }), qc.invalidateQueries({ queryKey: ["campaigns"] })]);

  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      await refresh();
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const items = list.data?.items ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted">Subsequences follow up automatically when a lead meets a condition, such as being marked Interested or opening without replying. Leads leave the main sequence when they enter one.</p>
        {!readOnly && (
          <div className="flex gap-2">
            <Button size="sm" icon={<Copy size={14} />} onClick={() => setDupOpen(true)}>
              Duplicate existing
            </Button>
            <ButtonLink size="sm" variant="primary" to={`/app/campaign/${campaign.id}/subsequences/create`} icon={<Plus size={14} />}>
              Add subsequence
            </ButtonLink>
          </div>
        )}
      </div>
      {list.isLoading ? (
        <Skeleton className="h-24" />
      ) : items.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((s) => {
            const st = byId.get(s.id);
            const running = s.status === CampaignStatus.ACTIVE;
            return (
              <Card key={s.id} className="flex flex-col gap-3">
                <div className="flex items-start gap-2">
                  <span className="rounded-lg bg-brand-soft p-2 text-brand-text">
                    <GitBranch size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link to={`/app/campaign/${campaign.id}/subsequences/${s.id}/sequences`} className="font-medium hover:text-brand-text">
                      {s.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted">{summary(s.conditions)}</p>
                  </div>
                  <CampaignStatusBadge status={s.status} />
                  {!readOnly && (
                    <RowMenu>
                      <MenuItem icon={<Pencil size={14} />} onSelect={() => navigate(`/app/campaign/${campaign.id}/subsequences/${s.id}/sequences`)}>
                        Edit
                      </MenuItem>
                      <MenuItem
                        icon={running ? <Pause size={14} /> : <Play size={14} />}
                        onSelect={() =>
                          act(
                            () => post(`/api/v2/subsequences/${s.id}/${running ? "pause" : "resume"}`),
                            running ? "Subsequence paused" : s.status === CampaignStatus.DRAFT ? "Subsequence started" : "Subsequence resumed",
                          )
                        }
                      >
                        {running ? "Pause" : s.status === CampaignStatus.DRAFT ? "Start" : "Resume"}
                      </MenuItem>
                      <MenuItem icon={<Copy size={14} />} onSelect={() => act(() => post(`/api/v2/subsequences/${s.id}/duplicate`, { parent_campaign: campaign.id, name: `${s.name} (copy)` }), "Subsequence duplicated")}>
                        Duplicate
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        danger
                        icon={<Trash2 size={14} />}
                        onSelect={async () => {
                          if (await confirm({ title: `Delete “${s.name}”?`, description: `Leads currently in it stop receiving its emails. ${restorable()}`, confirmLabel: "Delete", danger: true }))
                            act(async () => deletedToast("Subsequence deleted", (await del<{ recently_deleted_id?: string }>(`/api/v2/subsequences/${s.id}`)).recently_deleted_id));
                        }}
                      >
                        Delete
                      </MenuItem>
                    </RowMenu>
                  )}
                </div>
                <div className="flex gap-4 border-t border-line pt-3 text-xs text-muted">
                  <span>{s.sequences[0]?.steps.length ?? 0} steps</span>
                  <span>{num(st?.emails_sent ?? 0)} sent</span>
                  <span>{num(st?.unique_opens ?? 0)} opened</span>
                  <span>{num(st?.unique_replies ?? 0)} replied</span>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<GitBranch size={22} />}
          title="No subsequences yet"
          description="Create one to follow up with interested leads, people who opened but didn't reply, or anyone who finished the sequence."
          action={
            !readOnly ? (
              <ButtonLink variant="primary" to={`/app/campaign/${campaign.id}/subsequences/create`} icon={<Plus size={14} />}>
                Add subsequence
              </ButtonLink>
            ) : undefined
          }
        />
      )}
      <DuplicateFromDialog open={dupOpen} onOpenChange={setDupOpen} campaignId={campaign.id} />
    </div>
  );
}

/** /app/campaign/:id/subsequences/create */
export function SubsequenceCreate() {
  const { campaign } = useCampaign();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Empty to start with (the default shows as the placeholder), so typing a name never adds to the default.
  const [name, setName] = useState("");
  const [conditions, setConditions] = useState<Conditions>({ crm_status: [1] });
  const [busy, setBusy] = useState(false);
  const final = name.trim() || "My Subsequence";
  const valid = final.length > 3 && hasTrigger(conditions);
  const create = async () => {
    setBusy(true);
    try {
      const s = await post<Subsequence>("/api/v2/subsequences", { parent_campaign: campaign.id, name: final, conditions: { ...conditions, reply_contains: conditions.reply_contains?.trim() || undefined } });
      await qc.invalidateQueries({ queryKey: ["subsequences", campaign.id] });
      navigate(`/app/campaign/${campaign.id}/subsequences/${s.id}/sequences`, { replace: true });
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-2xl">
      <Link to={`/app/campaign/${campaign.id}/subsequences`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> Subsequences
      </Link>
      <Card className="space-y-5 p-6">
        <div>
          <h2 className="text-lg font-semibold">Let's create a new subsequence</h2>
          <p className="mt-1 text-[13px] text-muted">Pick what moves a lead into it. You'll write its emails next.</p>
        </div>
        <Field label="Subsequence name" error={name.trim() && name.trim().length <= 3 ? "Use more than 3 characters." : null}>
          {(id) => <Input id={id} autoFocus value={name} placeholder="My Subsequence" onChange={(e) => setName(e.target.value)} />}
        </Field>
        <ConditionsEditor value={conditions} onChange={setConditions} />
        {!hasTrigger(conditions) && <p className="text-xs text-bad">Choose at least one condition.</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(`/app/campaign/${campaign.id}/subsequences`)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={create}>
            Continue
          </Button>
        </div>
      </Card>
    </div>
  );
}

interface SubContext {
  sub: Subsequence;
  /** The parent campaign. Pages under this layout can't use useCampaign(): the nearest outlet context is this one. */
  campaign: CampaignDetail;
  save: (patch: Record<string, unknown>) => Promise<Subsequence>;
  readOnly: boolean;
  campaignId: string;
  customVariables: string[];
  textOnly: boolean;
}

/** /app/campaign/:id/subsequences/:subId — header and tabs around the subsequence editors. */
export function SubsequenceLayout() {
  const { campaign, readOnly } = useCampaign();
  const { subId = "" } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["subsequence", subId], queryFn: () => get<Subsequence>(`/api/v2/subsequences/${subId}`) });
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <FullPageSpinner />;
  const sub = q.data;
  if (!sub || sub.parent_campaign !== campaign.id)
    return (
      <RecordMissing
        error={sub ? null : q.error}
        retry={() => q.refetch()}
        notFound={{ title: "Subsequence not found", description: "It was deleted, or it belongs to another campaign.", back: { to: `/app/campaign/${campaign.id}/subsequences`, label: "This campaign's subsequences" } }}
      />
    );
  const save: SubContext["save"] = async (body) => {
    const updated = await patch<Subsequence>(`/api/v2/subsequences/${subId}`, body);
    qc.setQueryData(["subsequence", subId], updated);
    qc.invalidateQueries({ queryKey: ["subsequences", campaign.id] });
    return updated;
  };
  const running = sub.status === CampaignStatus.ACTIVE;
  const draft = sub.status === CampaignStatus.DRAFT;
  const toggle = async () => {
    setBusy(true);
    try {
      const updated = await post<Subsequence>(`/api/v2/subsequences/${subId}/${running ? "pause" : "resume"}`);
      qc.setQueryData(["subsequence", subId], updated);
      qc.invalidateQueries({ queryKey: ["subsequences", campaign.id] });
      // A resume can set the finished campaign running again.
      qc.invalidateQueries({ queryKey: ["campaign", campaign.id] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const base = `/app/campaign/${campaign.id}/subsequences/${subId}`;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to={`/app/campaign/${campaign.id}/subsequences`} className="-my-1 inline-flex items-center gap-1.5 py-1 text-[13px] text-muted hover:text-text">
          <ArrowLeft size={14} /> Subsequences
        </Link>
        <span className="text-faint">/</span>
        <h2 className="font-semibold">{sub.name}</h2>
        <CampaignStatusBadge status={sub.status} />
        {!readOnly && (
          <Button size="sm" className="ml-auto" variant={draft ? "primary" : "secondary"} icon={running ? <Pause size={14} /> : <Play size={14} />} loading={busy} onClick={toggle}>
            {running ? "Pause subsequence" : draft ? "Start subsequence" : "Resume subsequence"}
          </Button>
        )}
      </div>
      {draft && (
        <Callout className="mb-4" title="This subsequence is a draft">
          Write its emails, then start it. Leads only move into it while it's running.
        </Callout>
      )}
      <LinkTabs
        className="mb-5"
        tabs={[
          { to: `${base}/sequences`, label: "Sequences" },
          { to: `${base}/schedule`, label: "Schedule" },
          { to: `${base}/options`, label: "Options" },
          { to: `${base}/analytics`, label: "Analytics" },
        ]}
      />
      <Outlet
        context={
          {
            sub,
            campaign,
            save,
            readOnly,
            campaignId: campaign.id,
            customVariables: Object.keys(campaign.custom_variables ?? {}),
            textOnly: !!campaign.text_only,
          } satisfies SubContext
        }
      />
    </div>
  );
}

const useSub = () => useOutletContext<SubContext>();

export function SubsequenceSequences() {
  const { sub, save, readOnly, campaignId, customVariables, textOnly } = useSub();
  const qc = useQueryClient();
  return (
    <SequenceEditor
      steps={sub.sequences[0]?.steps ?? []}
      onSave={(steps) => save({ sequences: [{ steps }] })}
      campaignId={campaignId}
      customVariables={customVariables}
      readOnly={readOnly}
      subsequence
      textOnly={textOnly}
      versions={{ path: `/api/app/subsequences/${sub.id}`, onRestored: () => qc.invalidateQueries({ queryKey: ["subsequence", sub.id] }) }}
      scope={sub.id}
    />
  );
}

export function SubsequenceSchedule() {
  const { sub, campaign, save, readOnly } = useSub();
  return (
    <div className="space-y-3">
      {!sub.subsequence_schedule && <Callout tone="info">This subsequence uses the campaign's schedule until you save one here.</Callout>}
      <ScheduleEditor schedule={sub.subsequence_schedule ?? campaign.campaign_schedule} onSave={(s) => save({ subsequence_schedule: s })} readOnly={readOnly} title="Subsequence" scope={sub.id} />
    </div>
  );
}

export function SubsequenceOptions() {
  const { sub, campaign, save, readOnly } = useSub();
  const baseline = useMemo(
    () => ({
      name: sub.name,
      conditions: sub.conditions ?? {},
      daily_limit_mode: sub.daily_limit_mode ?? "inherit",
      daily_limit: sub.daily_limit,
      ignore_account_daily_limit: !!sub.ignore_account_daily_limit,
      auto_variant_select: sub.auto_variant_select,
    }),
    [sub],
  );
  const [d, setD] = useState(baseline);
  const [saving, setSaving] = useState(false);
  useEffect(() => setD(baseline), [baseline]);
  const dirty = JSON.stringify(d) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty && !readOnly);
  const persist = async () => {
    if (!hasTrigger(d.conditions)) return toast.error("Choose at least one condition");
    setSaving(true);
    try {
      await save({ ...d, conditions: { ...d.conditions, reply_contains: d.conditions.reply_contains?.trim() || undefined } });
      toast.success("Options saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} disabled={readOnly} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
      </Card>
      <Card>
        <p className="mb-3 text-sm font-medium">Conditions</p>
        <ConditionsEditor value={d.conditions} onChange={(c) => setD({ ...d, conditions: c })} disabled={readOnly} />
      </Card>
      <Card className="space-y-4">
        <div>
          <p className="text-sm font-medium">Daily limit</p>
          <p className="mt-0.5 text-[13px] text-muted">Max number of emails this subsequence sends per day.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            size="sm"
            value={d.daily_limit_mode}
            onChange={(v) => setD({ ...d, daily_limit_mode: v })}
            options={[
              { value: "inherit", label: `Inherit from campaign${campaign.daily_limit ? ` (${campaign.daily_limit}/day)` : ""}` },
              { value: "custom", label: "Custom limit" },
              { value: "unlimited", label: "No limit" },
            ]}
          />
          {d.daily_limit_mode === "custom" && <NumberInput value={d.daily_limit} onChange={(v) => setD({ ...d, daily_limit: v })} min={0} suffix="per day" disabled={readOnly} aria-label="Daily limit" />}
        </div>
        <div className="space-y-2 border-t border-line pt-4">
          <Checkbox label="Ignore account daily limits" checked={d.ignore_account_daily_limit} disabled={readOnly} onChange={(v) => setD({ ...d, ignore_account_daily_limit: v })} />
          {d.ignore_account_daily_limit && (
            <Callout tone="warn">Sending accounts may go over their configured daily limit. Only turn this on if same-day sending really matters; it can hurt deliverability, especially for accounts still warming up.</Callout>
          )}
        </div>
        <div className="space-y-2 border-t border-line pt-4">
          <Checkbox label="Auto-optimize A/B testing" checked={!!d.auto_variant_select} disabled={readOnly} onChange={(v) => setD({ ...d, auto_variant_select: v ? { trigger: "reply_rate" } : null })} />
          {d.auto_variant_select && (
            <div className="ml-6 flex items-center gap-2 text-[13px]">
              Winning metric
              <NativeSelect
                size="sm"
                className="w-40"
                value={d.auto_variant_select.trigger}
                onChange={(v) => setD({ ...d, auto_variant_select: { trigger: v as "reply_rate" } })}
                options={[
                  { value: "reply_rate", label: "Reply rate" },
                  { value: "click_rate", label: "Click rate" },
                  { value: "open_rate", label: "Open rate" },
                ]}
              />
            </div>
          )}
        </div>
      </Card>
      {!readOnly && (
        <div className="flex justify-end">
          <Button variant="primary" icon={<Save size={15} />} loading={saving} disabled={!dirty} onClick={persist}>
            {dirty ? "Save options" : "Saved"}
          </Button>
        </div>
      )}
    </div>
  );
}

interface SubOverview {
  metrics: {
    emails_sent_count: number;
    contacted_count: number;
    open_count_unique: number;
    link_click_count_unique: number;
    reply_count_unique: number;
    reply_count_automatic_unique: number;
    bounced_count: number;
    unsubscribed_count: number;
  };
  leads: { total: number; active: number; paused?: number; completed: number; skipped: number; stopped?: number; progress: number };
  daily: Array<{ date: string; sent: number; unique_opened: number; unique_replies: number; unique_clicks: number }>;
  steps: StepRow[];
}

const SUB_SERIES = [
  { key: "sent", label: "Sent" },
  { key: "unique_opened", label: "Opened" },
  { key: "unique_replies", label: "Replied" },
  { key: "unique_clicks", label: "Clicked" },
];

/** /app/campaign/:id/subsequences/:subId/analytics */
export function SubsequenceAnalytics() {
  const { sub, campaign } = useSub();
  const zone = useWorkspaceZone();
  const [range, setRange] = useState<DateRange>(() => resolveRange("all"));
  const q = useQuery({
    queryKey: ["subsequence", sub.id, "overview", range.start_date, range.end_date],
    queryFn: () => get<SubOverview>(`/api/app/subsequences/${sub.id}/overview`, { start_date: range.start_date, end_date: range.end_date }),
    refetchInterval: 60_000,
  });
  const o = q.data;
  const m = o?.metrics;
  const tracking = !!campaign.open_tracking;
  const contacted = m?.contacted_count ?? 0;
  const daily = useMemo(() => {
    if (!o) return [];
    const today = todayIn(zone);
    const twoWeeks = daysBefore(today, 13);
    const first = o.daily[0]?.date;
    return fillDays(o.daily, range.start_date ?? (first && first < twoWeeks ? first : twoWeeks), range.end_date ?? today, { sent: 0, unique_opened: 0, unique_replies: 0, unique_clicks: 0 });
  }, [o, range.start_date, range.end_date, zone]);

  if (q.error) return <ErrorState title="The analytics didn't load" error={q.error} onRetry={() => q.refetch()} />;
  if (o && !o.leads.total && !m?.emails_sent_count)
    return (
      <EmptyState
        icon={<Send size={22} />}
        title="No leads in this subsequence yet"
        description={
          sub.status === CampaignStatus.DRAFT
            ? "Write its emails and start it. Leads that meet its conditions then move in, and what they do shows up here."
            : "Leads move in when they meet its conditions (see Options). What they do shows up here."
        }
      />
    );
  const loading = <Skeleton className="h-7 w-16" />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[14rem] flex-1">
          <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted">
            <span>
              Done {o ? `${o.leads.progress}%` : "–"} · {o ? num(o.leads.total - o.leads.active) : "–"} of {o ? plural(o.leads.total, "lead") : "–"}
            </span>
            <span>
              {o ? num(o.leads.active) : "–"} still in it{o?.leads.paused ? ` (${num(o.leads.paused)} paused)` : ""} · {o ? num(o.leads.completed) : "–"} finished
              {o?.leads.skipped ? ` · ${num(o.leads.skipped)} skipped` : ""}
              {o?.leads.stopped ? ` · ${num(o.leads.stopped)} bounced or unsubscribed` : ""}
            </span>
          </div>
          <Progress value={o?.leads.progress ?? 0} tone={(o?.leads.progress ?? 0) >= 100 ? "ok" : "brand"} />
        </div>
        <RangeSelect value={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Leads emailed" icon={<Send size={15} />} tone="brand" value={m ? num(contacted) : loading} sub={m ? plural(m.emails_sent_count, "email") : undefined} />
        <StatCard
          label="Open rate"
          icon={<Eye size={15} />}
          tone="info"
          value={!tracking ? <span className="text-base text-muted">Tracking off</span> : m ? pct(m.open_count_unique, contacted) : loading}
          sub={tracking && m ? `${plural(m.open_count_unique, "lead")} opened` : "Open tracking is set in the campaign's Options"}
        />
        <StatCard
          label="Click rate"
          icon={<MousePointerClick size={15} />}
          tone="info"
          value={campaign.link_tracking === false ? <span className="text-base text-muted">Tracking off</span> : m ? pct(m.link_click_count_unique, contacted) : loading}
          sub={m ? `${plural(m.link_click_count_unique, "lead")} clicked` : undefined}
        />
        <StatCard
          label="Reply rate"
          icon={<MessageSquareReply size={15} />}
          tone="ok"
          value={m ? pct(m.reply_count_unique, contacted) : loading}
          sub={m ? `${num(m.reply_count_unique)} replied · ${plural(m.reply_count_automatic_unique, "auto-reply", "auto-replies")}` : undefined}
        />
        <StatCard label="Bounced" icon={<AlertOctagon size={15} />} tone="bad" value={m ? num(m.bounced_count) : loading} sub={m ? `${plural(m.unsubscribed_count, "unsubscribe")}` : undefined} />
      </div>

      <Card>
        <CardHeader title="Daily activity" />
        {q.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : daily.length ? (
          <TrendChart data={daily} series={SUB_SERIES.filter((s) => tracking || s.key !== "unique_opened").map((s, i) => ({ ...s, color: SERIES_COLORS[i] }))} />
        ) : (
          <p className="py-16 text-center text-[13px] text-muted">No activity in this period.</p>
        )}
      </Card>

      <Card padded={false}>
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">Step analytics</h3>
        </div>
        <StepTable rows={o?.steps ?? []} steps={sub.sequences[0]?.steps ?? []} tracking={tracking} opportunities={false} loading={q.isLoading} subsequence />
      </Card>
    </div>
  );
}

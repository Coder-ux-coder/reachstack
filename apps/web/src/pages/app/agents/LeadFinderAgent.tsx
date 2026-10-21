import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Pause, Play, Plus, RefreshCw, Sparkles, Trash2, Wand2 } from "lucide-react";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, dateTime, num, plural } from "@/lib/format";
import { useDebounced, usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useUnsavedChanges } from "@/lib/unsaved";
import { useCampaignNames } from "@/lib/pickers";
import { FilterPanel, activeCount, compact, type Filters } from "@/pages/app/lead-finder/filters";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
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
  Textarea,
  useConfirm,
} from "@/components/ui";
import { AGENTS_KEY, AgentStatusBadge, useAgents } from "./shared";

// ---------------------------------------------------------------------------------------------------------------
// Types

interface AiStep {
  model_version: string;
  prompt: string;
  fallback?: string;
  order?: number;
  skip_if_input_empty?: boolean;
}

interface LeadFinderAgent {
  id: string;
  name: string;
  description: string | null;
  status: number;
  timestamp_created: string;
  payload: {
    campaign_id: string;
    campaign_name: string | null;
    /** Only on the single-agent answer: the campaign no longer exists. */
    campaign_deleted?: boolean;
    search_filters: Filters;
    min_active_leads: number;
    on_exhaustion: "pause" | "fallback" | "broaden";
    fallback_search_filters: Filters | null;
    show_one_lead_per_company: boolean;
    ai_enrichment: Record<string, AiStep> | null;
    ai_enrichment_workflow: string | null;
    active_audience: "primary" | "fallback" | "broadened";
    broadened_removed: string[];
  };
}

interface AgentEvent {
  id: string;
  timestamp_created: string;
  event_type: string;
  payload: { leads_added?: number; campaign_active_leads_after?: number; campaign_active_leads_before?: number; target?: number; reason?: string; leads_held?: number };
}

interface Suggestion {
  label: string;
  query: string;
  rationale: string;
  filters: Filters & { locations?: Filters["locations"] | Array<{ label: string }> };
  estimated_leads?: number | null;
}

const agentKey = (id: string) => ["lead-finder-agent", id];

const EXHAUSTION: Array<{ value: "pause" | "broaden" | "fallback"; label: string; text: string }> = [
  { value: "broaden", label: "Widen the search", text: "Drop the narrowest filters one at a time until people turn up again." },
  { value: "fallback", label: "Switch audiences", text: "Move on to a second audience you define below." },
  { value: "pause", label: "Pause", text: "Stop and let you know, so you can change the filters yourself." },
];

const EVENT_LABELS: Record<string, string> = {
  top_up_started: "Started adding leads",
  top_up_completed: "Added leads",
  top_up_failed: "Couldn't add leads",
  search_exhausted: "No new people left",
  fallback_activated: "Changed audience",
  fallback_exhausted: "Second audience ran out",
  paused_exhausted: "Paused: audience ran out",
  paused_insufficient_credits: "Paused: out of credits",
  paused_ai_failed: "Paused: AI columns failed",
  campaign_not_found: "Campaign deleted",
  campaign_restored: "Campaign restored",
  agent_paused: "Paused",
  agent_resumed: "Resumed",
};

function eventLine(e: AgentEvent) {
  const p = e.payload;
  if (e.event_type === "top_up_completed") return `Added ${plural(p.leads_added ?? 0, "lead")}${p.campaign_active_leads_after !== undefined ? `, ${num(p.campaign_active_leads_after)} now waiting` : ""}${p.leads_held ? ` (${p.leads_held} held back by AI columns)` : ""}`;
  if (e.event_type === "top_up_started") return `${plural(p.campaign_active_leads_before ?? 0, "lead")} left, topping up to ${num(p.target ?? 0)}`;
  return p.reason ?? "";
}

/** Older suggestions may list locations as a plain array; the filter panel expects include/exclude. */
function normalizeFilters(f: Suggestion["filters"]): Filters {
  const { locations, ...rest } = f;
  return { ...rest, ...(locations ? { locations: Array.isArray(locations) ? { include: locations } : locations } : {}) };
}

function useMatchCount(filters: Filters) {
  const f = useDebounced(compact(filters), 500);
  return useQuery({
    queryKey: ["lead-finder-count", f],
    queryFn: () => post<{ total: number }>("/api/app/lead-finder/search", { filters: f, page_size: 1, record_history: false }),
    enabled: activeCount(f) > 0,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Form (create and edit)

interface FormState {
  name: string;
  campaign_id: string;
  search_filters: Filters;
  min_active_leads: number;
  on_exhaustion: "pause" | "fallback" | "broaden";
  fallback_search_filters: Filters;
  columns: Array<{ key: string; prompt: string; fallback: string; skip_if_input_empty: boolean }>;
  workflow: string;
}

function toForm(a?: LeadFinderAgent): FormState {
  return {
    name: a?.name ?? "",
    // A deleted campaign leaves the picker empty, so saving asks for a new one.
    campaign_id: a?.payload.campaign_deleted ? "" : (a?.payload.campaign_id ?? ""),
    // The agent keeps "one lead per company" as its own setting; the filter panel shows it with the other filters.
    search_filters: { ...(a?.payload.search_filters ?? {}), show_one_lead_per_company: a?.payload.show_one_lead_per_company ?? true },
    min_active_leads: a?.payload.min_active_leads ?? 100,
    on_exhaustion: a?.payload.on_exhaustion ?? "broaden",
    fallback_search_filters: a?.payload.fallback_search_filters ?? {},
    columns: Object.entries(a?.payload.ai_enrichment ?? {})
      .sort(([, x], [, y]) => (x.order ?? 0) - (y.order ?? 0))
      .map(([key, s]) => ({ key, prompt: s.prompt, fallback: s.fallback ?? "", skip_if_input_empty: !!s.skip_if_input_empty })),
    workflow: a?.payload.ai_enrichment_workflow ?? "",
  };
}

function enrichmentOf(columns: FormState["columns"]) {
  if (!columns.length) return null;
  return Object.fromEntries(
    columns.map((c, i) => [c.key.trim(), { model_version: "default", prompt: c.prompt, ...(c.fallback.trim() ? { fallback: c.fallback } : {}), skip_if_input_empty: c.skip_if_input_empty, order: i }]),
  );
}

function AudienceSuggestions({ campaignId, onPick }: { campaignId: string; onPick: (f: Filters, label: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ profile_summary: string; analyzed_lead_count: number; suggestions: Suggestion[] } | null>(null);
  useEffect(() => setResult(null), [campaignId]);
  const suggest = async () => {
    setBusy(true);
    try {
      setResult(await post("/api/v2/ai-agents/lead-finder/suggest-audience", { campaign_id: campaignId, count: 3 }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <Button size="sm" icon={<Wand2 size={14} />} loading={busy} disabled={!campaignId} onClick={suggest}>
        Suggest audiences from this campaign's leads
      </Button>
      {result && (
        <div className="space-y-2">
          <p className="text-[13px] text-muted">
            {result.profile_summary} ({plural(result.analyzed_lead_count, "lead")} looked at)
          </p>
          <div className="grid gap-2 md:grid-cols-3">
            {result.suggestions.map((s) => (
              <button key={s.label} type="button" onClick={() => onPick(normalizeFilters(s.filters), s.label)} className="rounded-lg border border-line p-3 text-left transition-colors hover:border-brand">
                <p className="text-[13px] font-medium">{s.label}</p>
                <p className="mt-1 line-clamp-3 text-xs text-muted">{s.rationale}</p>
                {s.estimated_leads != null && (
                  <p className={cn("mt-2 text-xs", s.estimated_leads ? "text-brand-text" : "text-muted")}>{s.estimated_leads ? `About ${plural(s.estimated_leads, "person", "people")}` : "No one in the database matches yet"}</p>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FiltersBox({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const count = useMatchCount(value);
  const n = activeCount(value);
  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs text-muted">
        <span>{n ? plural(n, "filter") : "No filters yet"}</span>
        <span>{n ? (count.isFetching ? "Counting…" : count.data ? `About ${plural(count.data.total, "person", "people")} ${count.data.total === 1 ? "matches" : "match"}` : "") : "Add at least one filter"}</span>
      </div>
      <div className="scroll-thin max-h-[28rem] overflow-y-auto px-3">
        <FilterPanel value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function AiColumns({ value, onChange, workflow, onWorkflow }: { value: FormState["columns"]; onChange: (c: FormState["columns"]) => void; workflow: string; onWorkflow: (name: string) => void }) {
  const qc = useQueryClient();
  const saved = useQuery({ queryKey: ["enrichment-workflows"], queryFn: () => get<{ items: Array<{ id: string; name: string; payload: { ai_enrichment: Record<string, AiStep> } }> }>("/api/v2/ai-agents/lead-finder/enrichment-workflows") });
  const set = (i: number, patchCol: Partial<FormState["columns"][number]>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patchCol } : c)));
  const load = (id: string) => {
    const w = saved.data?.items.find((x) => x.id === id);
    if (!w) return;
    onChange(toForm({ payload: { ai_enrichment: w.payload.ai_enrichment } } as LeadFinderAgent).columns);
    onWorkflow(w.name);
  };
  const saveAs = async () => {
    const name = window.prompt("Name this set of AI columns", workflow || "My AI columns");
    if (!name?.trim()) return;
    try {
      await post("/api/v2/ai-agents/lead-finder/enrichment-workflows", { name: name.trim(), ai_enrichment: enrichmentOf(value) });
      await qc.invalidateQueries({ queryKey: ["enrichment-workflows"] });
      onWorkflow(name.trim());
      toast.success("Saved for reuse");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="space-y-3">
      {value.map((c, i) => (
        <Card key={i} className="space-y-3">
          <div className="flex items-end gap-2">
            <Field label="Column" className="flex-1" hint="Letters, digits and underscores. Use it in emails as a variable.">
              {(id) => <Input id={id} value={c.key} onChange={(e) => set(i, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} placeholder="iceBreaker" maxLength={64} />}
            </Field>
            <Button size="icon-sm" variant="ghost" aria-label="Remove column" className="mb-6" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </Button>
          </div>
          <Field label="Prompt" hint="Refer to lead fields with {{firstName}}, {{companyName}}, {{jobTitle}}, {{website}} and so on.">
            {(id) => <Textarea id={id} rows={3} value={c.prompt} onChange={(e) => set(i, { prompt: e.target.value })} placeholder="Write one friendly sentence about {{companyName}}'s recent work, for an opening line." />}
          </Field>
          <Field label="If the AI has no answer" optional hint="Leave empty to hold the lead back instead of adding it without this column.">
            {(id) => <Input id={id} value={c.fallback} onChange={(e) => set(i, { fallback: e.target.value })} placeholder="Use this text instead" />}
          </Field>
          <Checkbox label="Skip the AI when the fields it needs are empty" checked={c.skip_if_input_empty} onChange={(v) => set(i, { skip_if_input_empty: v })} />
        </Card>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Plus size={14} />} disabled={value.length >= 10} onClick={() => onChange([...value, { key: "", prompt: "", fallback: "", skip_if_input_empty: true }])}>
          Add AI column
        </Button>
        {!!saved.data?.items.length && (
          <NativeSelect size="sm" className="w-56" value="" onChange={load} options={[{ value: "", label: "Load saved columns…" }, ...saved.data.items.map((w) => ({ value: w.id, label: w.name }))]} aria-label="Load saved columns" />
        )}
        {value.length > 0 && (
          <Button size="sm" variant="ghost" onClick={saveAs}>
            Save for reuse
          </Button>
        )}
      </div>
    </div>
  );
}

/** Create (no agent) or edit (agent given). */
export function LeadFinderAgentForm({ agent }: { agent?: LeadFinderAgent }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const agents = useAgents();
  const campaigns = useCampaignNames();
  const baseline = useMemo(() => toForm(agent), [agent]);
  const [form, setForm] = useState<FormState>(baseline);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(baseline), [baseline]);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty && !busy && !!agent);
  const set = (f: Partial<FormState>) => setForm((x) => ({ ...x, ...f }));
  const taken = new Set((agents.data?.items ?? []).filter((a) => a.kind === "lead_finder" && a.id !== agent?.id && a.status !== -1).map((a) => a.campaign?.id));
  const campaignOptions = (campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: taken.has(c.id) ? `${c.name} (has an agent)` : c.name }));

  const problems: string[] = [];
  if (!form.name.trim()) problems.push("Name the agent");
  if (!form.campaign_id) problems.push("Pick a campaign");
  if (!activeCount(form.search_filters)) problems.push("Add at least one filter");
  if (form.on_exhaustion === "fallback" && !activeCount(form.fallback_search_filters)) problems.push("Add filters for the second audience");
  if (form.columns.some((c) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(c.key) || !c.prompt.trim())) problems.push("Every AI column needs a name and a prompt");

  const save = async () => {
    setBusy(true);
    const { show_one_lead_per_company: onePerCompany, ...filters } = compact(form.search_filters);
    const body = {
      name: form.name.trim(),
      campaign_id: form.campaign_id,
      search_filters: filters,
      min_active_leads: form.min_active_leads,
      on_exhaustion: form.on_exhaustion,
      fallback_search_filters: form.on_exhaustion === "fallback" ? compact(form.fallback_search_filters) : null,
      show_one_lead_per_company: !!onePerCompany,
      ai_enrichment: enrichmentOf(form.columns),
      ai_enrichment_workflow: form.columns.length ? form.workflow || undefined : undefined,
    };
    try {
      if (agent) {
        await patch(`/api/v2/ai-agents/lead-finder/${agent.id}`, body);
        await qc.invalidateQueries({ queryKey: agentKey(agent.id) });
        toast.success("Saved. The agent checks again with the new settings.");
      } else {
        const a = await post<LeadFinderAgent>("/api/v2/ai-agents/lead-finder", { ...body, source: "agents_page" });
        toast.success("Agent is on. It checks the campaign every few minutes.");
        nav(`/app/ai-agents/${a.id}`);
      }
      qc.invalidateQueries({ queryKey: AGENTS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Section title="Name">
        <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Keep 'Q4 founders' stocked" maxLength={200} aria-label="Agent name" disabled={!can.write} />
      </Section>
      <Section title="Campaign" description="New leads go straight into this campaign's sequence.">
        <div className="space-y-3">
          <NativeSelect value={form.campaign_id} onChange={(v) => set({ campaign_id: v })} options={[{ value: "", label: "Choose a campaign" }, ...campaignOptions]} aria-label="Campaign" disabled={!can.write} />
          <Field label="Keep at least this many leads waiting" hint="When fewer leads are left to contact, the agent adds more (up to 1,000 at a time).">
            {(id) => <NumberInput id={id} className="w-40" value={form.min_active_leads} min={1} max={100_000} suffix="leads" onChange={(v) => set({ min_active_leads: Math.max(1, v ?? 1) })} />}
          </Field>
        </div>
      </Section>
      <Section title="Who to look for" description="People from the Lead Finder database who match these filters. Anyone already in the campaign is skipped.">
        <div className="space-y-3">
          <AudienceSuggestions
            campaignId={form.campaign_id}
            onPick={(f, label) => {
              set({ search_filters: f });
              toast.success(`Filters set to "${label}"`);
            }}
          />
          <FiltersBox value={form.search_filters} onChange={(f) => set({ search_filters: f })} />
        </div>
      </Section>
      <Section title="When people run out">
        <div className="space-y-3">
          <Segmented value={form.on_exhaustion} onChange={(v) => set({ on_exhaustion: v })} options={EXHAUSTION.map((o) => ({ value: o.value, label: o.label }))} />
          <p className="text-[13px] text-muted">{EXHAUSTION.find((o) => o.value === form.on_exhaustion)?.text}</p>
          {form.on_exhaustion === "fallback" && <FiltersBox value={form.fallback_search_filters} onChange={(f) => set({ fallback_search_filters: f })} />}
        </div>
      </Section>
      <Section title="AI columns" description="Optional. Fill extra fields for each new lead before it's added, such as a personal first line.">
        <AiColumns value={form.columns} onChange={(columns) => set({ columns })} workflow={form.workflow} onWorkflow={(workflow) => set({ workflow })} />
      </Section>
      {can.write && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          {problems.length > 0 && <span className="mr-auto text-[13px] text-muted">{problems[0]}</span>}
          {agent && (
            <Button disabled={!dirty || busy} onClick={() => setForm(baseline)}>
              Reset
            </Button>
          )}
          <Button variant="primary" loading={busy} disabled={problems.length > 0 || (!!agent && !dirty)} onClick={save}>
            {agent ? "Save changes" : "Turn on agent"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Shell and tabs

function useLeadFinderAgent(id: string) {
  return useQuery({ queryKey: agentKey(id), queryFn: () => get<LeadFinderAgent>(`/api/v2/ai-agents/lead-finder/${id}`) });
}

export function LeadFinderShell({ id }: { id: string }) {
  const q = useLeadFinderAgent(id);
  const can = useCan();
  const qc = useQueryClient();
  usePageTitle(q.data?.name ?? "Lead finder agent");
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (!q.data) return <EmptyState title="Agent not found" />;
  const a = q.data;
  const toggle = async () => {
    try {
      await post(`/api/v2/ai-agents/lead-finder/${id}/${a.status === 1 ? "pause" : "resume"}`);
      toast.success(a.status === 1 ? "Agent paused" : "Agent resumed. It starts again from your main audience.");
      qc.invalidateQueries({ queryKey: agentKey(id) });
      qc.invalidateQueries({ queryKey: ["lead-finder-agent-events", id] });
      qc.invalidateQueries({ queryKey: AGENTS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
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
        {can.write &&
          (a.payload.campaign_deleted ? (
            <ButtonLink to={`${base}/configuration`} variant="primary" className="sm:ml-auto">
              Choose a campaign
            </ButtonLink>
          ) : (
            <Button className="sm:ml-auto" variant={a.status === 1 ? "secondary" : "primary"} icon={a.status === 1 ? <Pause size={14} /> : <Play size={14} />} onClick={toggle}>
              {a.status === 1 ? "Pause" : "Resume"}
            </Button>
          ))}
      </div>
      {a.payload.campaign_deleted ? (
        <p className="mt-1 text-[13px] text-muted">
          Its campaign{a.payload.campaign_name ? `, ${a.payload.campaign_name},` : ""} was deleted, so the agent stopped. Pick another campaign in{" "}
          <Link to={`${base}/configuration`} className="font-medium text-text hover:underline">
            Configuration
          </Link>{" "}
          to use it again.
        </p>
      ) : (
        <p className="mt-1 text-[13px] text-muted">
          Keeps{" "}
          <Link to={`/app/campaign/${a.payload.campaign_id}/leads`} className="font-medium text-text hover:underline">
            {a.payload.campaign_name ?? "its campaign"}
          </Link>{" "}
          stocked with at least {plural(a.payload.min_active_leads, "lead")}.
        </p>
      )}
      <LinkTabs
        className="mt-5"
        tabs={[
          { to: base, label: "Overview" },
          { to: `${base}/configuration`, label: "Configuration" },
          { to: `${base}/details`, label: "Activity" },
        ]}
      />
      <div className="pt-6">
        <Outlet context={{ id, kind: "lead_finder" }} />
      </div>
    </Page>
  );
}

export function LeadFinderOverview({ id }: { id: string }) {
  const q = useLeadFinderAgent(id);
  const qc = useQueryClient();
  const can = useCan();
  const stats = useQuery({ queryKey: ["lead-finder-agent-stats", id], queryFn: () => get<{ leads_added_total: number; top_ups_completed: number; top_ups_failed: number }>(`/api/v2/ai-agents/lead-finder/${id}/stats`) });
  const events = useQuery({ queryKey: ["lead-finder-agent-events", id, "recent"], queryFn: () => get<{ items: AgentEvent[] }>(`/api/v2/ai-agents/lead-finder/${id}/activities`, { limit: 8 }) });
  const [checking, setChecking] = useState(false);
  if (!q.data) return <SkeletonRows rows={4} />;
  const a = q.data;
  const check = async () => {
    setChecking(true);
    try {
      const r = await post<{ activities: AgentEvent[] }>(`/api/app/ai-agents/lead-finder/${id}/check`, { force: true });
      const done = r.activities[0];
      toast.success(done ? `${EVENT_LABELS[done.event_type] ?? "Checked"}${eventLine(done) ? `: ${eventLine(done)}` : ""}` : "Checked");
      await Promise.all([qc.invalidateQueries({ queryKey: agentKey(id) }), qc.invalidateQueries({ queryKey: ["lead-finder-agent-stats", id] }), qc.invalidateQueries({ queryKey: ["lead-finder-agent-events", id] })]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  const audience = a.payload.active_audience;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Leads added" value={num(stats.data?.leads_added_total)} />
          <StatCard label="Top-ups" value={num(stats.data?.top_ups_completed)} />
          <StatCard label="Failed" value={num(stats.data?.top_ups_failed)} tone={stats.data?.top_ups_failed ? "bad" : undefined} />
        </div>
        <Card>
          <CardHeader
            title="Recent activity"
            actions={
              can.write &&
              a.status === 1 && (
                <Button size="sm" icon={<RefreshCw size={14} />} loading={checking} onClick={check}>
                  Top up now
                </Button>
              )
            }
          />
          {events.data?.items.length ? (
            <ul className="space-y-3 text-[13px]">
              {events.data.items.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className="w-28 shrink-0 text-xs text-faint">{ago(e.timestamp_created)}</span>
                  <span>
                    <span className="font-medium">{EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                    {eventLine(e) && <span className="text-muted"> · {eventLine(e)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">Nothing yet. The agent checks the campaign every few minutes.</p>
          )}
        </Card>
      </div>
      <Card className="space-y-3 text-[13px]">
        <div>
          <p className="text-xs text-muted">Audience in use</p>
          <p className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone={audience === "primary" ? "ok" : "warn"}>{audience === "primary" ? "Main filters" : audience === "fallback" ? "Second audience" : "Widened filters"}</Badge>
          </p>
          {audience === "broadened" && a.payload.broadened_removed.length > 0 && <p className="mt-1 text-xs text-muted">Dropped: {a.payload.broadened_removed.join(", ")}</p>}
        </div>
        <div>
          <p className="text-xs text-muted">When people run out</p>
          <p className="mt-1">{EXHAUSTION.find((o) => o.value === a.payload.on_exhaustion)?.label}</p>
        </div>
        <div>
          <p className="text-xs text-muted">AI columns</p>
          <p className="mt-1">{a.payload.ai_enrichment ? Object.keys(a.payload.ai_enrichment).join(", ") : "None"}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Created</p>
          <p className="mt-1">{dateTime(a.timestamp_created)}</p>
        </div>
        <Link to={`/app/lead-finder`} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline">
          <Sparkles size={14} /> Browse the people database
        </Link>
      </Card>
    </div>
  );
}

export function LeadFinderConfiguration({ id }: { id: string }) {
  const q = useLeadFinderAgent(id);
  const qc = useQueryClient();
  const nav = useNavigate();
  const can = useCan();
  const confirm = useConfirm();
  if (!q.data) return <SkeletonRows rows={6} />;
  const remove = async () => {
    if (!(await confirm({ title: `Delete "${q.data!.name}"?`, description: "Leads it already added stay in the campaign.", confirmLabel: "Delete agent", danger: true }))) return;
    try {
      await del(`/api/v2/ai-agents/lead-finder/${id}`);
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success("Agent deleted");
      nav("/app/ai-agents");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div>
      <LeadFinderAgentForm agent={q.data} />
      {can.write && (
        <Section title="Delete agent" description="Leads it already added stay in the campaign.">
          <Button variant="danger" icon={<Trash2 size={14} />} onClick={remove}>
            Delete agent
          </Button>
        </Section>
      )}
    </div>
  );
}

export function LeadFinderDetails({ id }: { id: string }) {
  const events = useInfiniteQuery({
    queryKey: ["lead-finder-agent-events", id, "all"],
    queryFn: ({ pageParam }) => get<{ items: AgentEvent[]; next_starting_after?: string }>(`/api/v2/ai-agents/lead-finder/${id}/activities`, { limit: 50, starting_after: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_starting_after,
  });
  const rows = events.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card padded={false}>
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        loading={events.isLoading}
        hasMore={events.hasNextPage}
        loadingMore={events.isFetchingNextPage}
        onLoadMore={() => events.fetchNextPage()}
        empty={<p className="py-10 text-center text-[13px] text-muted">No activity yet.</p>}
        columns={[
          { key: "when", header: "When", cell: (r) => <span className="whitespace-nowrap text-muted">{dateTime(r.timestamp_created)}</span> },
          {
            key: "what",
            header: "What happened",
            cell: (r) => (
              <span>
                <span className="font-medium">{EVENT_LABELS[r.event_type] ?? r.event_type}</span>
                {eventLine(r) && <span className="text-muted"> · {eventLine(r)}</span>}
              </span>
            ),
          },
        ]}
      />
    </Card>
  );
}

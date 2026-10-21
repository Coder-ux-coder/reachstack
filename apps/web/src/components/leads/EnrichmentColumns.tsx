// Enrichment columns on a list's or campaign's leads table: add one (work email, email check, full profile,
// technologies, news, job openings, funding, clean-up or an AI prompt), run it on chosen rows, watch it fill in,
// edit, re-run, stop or delete it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { AtSign, Briefcase, Cpu, Eraser, Gauge, Landmark, MoreHorizontal, Newspaper, Pencil, Play, ShieldCheck, Sparkles, Square, Trash2, UserRound } from "lucide-react";
import {
  CREDIT_COSTS,
  ENRICHMENT_COLUMN_KINDS,
  NORMALIZE_TARGETS,
  aiColumnNameError,
  cleanCompanyName,
  cleanDomain,
  cleanPersonName,
  type EnrichmentColumnType,
  type NormalizeTarget,
} from "@reachstack/shared";
import { errorMessage, get, patch, post } from "@/lib/api";
import { fullName, num, plural } from "@/lib/format";
import { useInterval } from "@/lib/hooks";
import type { Lead } from "@/lib/types";
import { VerificationBadge } from "@/components/status";
import { Button, Checkbox, Dialog, Field, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, NumberInput, Progress, Textarea, type Column, type Selection } from "@/components/ui";

interface ColumnInfo {
  key: string;
  type: string;
  name: string | null;
  variables: string[];
  prompt: string | null;
  skip_leads_without_email: boolean;
  paused: boolean;
  targets: string[] | null;
  auto_update: boolean;
  filled: number;
  running: { job_id: string; status: string; progress: number; processed: number; total: number | null } | null;
  last_run: { status: string; processed: number; succeeded: number; failed: number; credits_used: number; error: string | null; finished_at: string | null } | null;
}

interface ColumnsInfo {
  resource_id: string;
  resource_type: 1 | 2;
  ai_available: boolean;
  self_hosted: boolean;
  credits: number | null;
  total_leads: number;
  columns: ColumnInfo[];
}

const KINDS = new Map(ENRICHMENT_COLUMN_KINDS.map((k) => [k.type as string, k]));
const ICONS: Record<EnrichmentColumnType, ReactNode> = {
  work_email_enrichment: <AtSign size={16} />,
  email_verification: <ShieldCheck size={16} />,
  fully_enriched_profile: <UserRound size={16} />,
  technologies: <Cpu size={16} />,
  news: <Newspaper size={16} />,
  joblisting: <Briefcase size={16} />,
  funding: <Landmark size={16} />,
  engagement_score: <Gauge size={16} />,
  normalize: <Eraser size={16} />,
  ai_enrichment: <Sparkles size={16} />,
};
// Credits per lead filled in (only shown when the workspace pays for credits).
const COST: Record<string, number> = { ...CREDIT_COSTS, engagement_score: 0, normalize: 0, custom_flow: CREDIT_COSTS.work_email_enrichment, integration: 1 };

const columnLabel = (c: Pick<ColumnInfo, "type" | "name">) =>
  c.type === "ai_enrichment" ? (c.name ?? "AI column") : c.type === "custom_flow" ? "Work email" : c.type === "integration" ? "Integrations" : (KINDS.get(c.type)?.label ?? c.type);

const NORMALIZE_LABELS: Record<NormalizeTarget, string> = { name: "First and last names", company: "Company names", domain: "Company domains" };

const STARTERS = [
  {
    label: "Opening line",
    name: "opening_line",
    prompt: "Write one friendly opening sentence for a cold email to {{first_name}}, {{job_title}} at {{company_name}}. Mention something specific about their company. No greeting, under 25 words.",
  },
  { label: "What they do", name: "what_they_do", prompt: "In one short sentence, say what {{company_name}} does. Use the text from their website:\n\n{{website_content}}" },
  { label: "Industry", name: "industry", prompt: "Which industry is {{company_name}} ({{company_domain}}) in? Answer in two or three words." },
  {
    label: "Good fit?",
    name: "good_fit",
    prompt: "We sell [describe what you sell]. Is {{first_name}}, {{job_title}} at {{company_name}}, likely to need it? Answer Yes or No, then the reason in under 12 words.",
  },
];
const LEAD_VARIABLES = ["first_name", "last_name", "job_title", "company_name", "company_domain", "website", "location", "website_content"];

const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "number" ? v.toLocaleString() : String(v));

function cellText(c: ColumnInfo, l: Lead): string {
  const p = l.payload ?? {};
  switch (c.type) {
    case "fully_enriched_profile":
      return [text(p.seniority), text(p.company_industry), p.company_size ? `${text(p.company_size)} people` : ""].filter(Boolean).join(" · ");
    case "news":
      return text(p.latest_news);
    case "joblisting":
      return p.open_roles ? [`${text(p.open_roles)} open`, text(p.job_titles)].filter(Boolean).join(" · ") : "";
    case "funding":
      return [text(p.funding_stage), text(p.funding_total)].filter(Boolean).join(" · ");
    case "normalize":
      return [[text(p.clean_first_name), text(p.clean_last_name)].filter(Boolean).join(" "), text(p.clean_company_name), text(p.clean_company_domain)].filter(Boolean).join(" · ");
    default:
      return c.variables.map((k) => text(p[k])).filter(Boolean).join(" · ");
  }
}

function EnrichmentCell({ col, lead }: { col: ColumnInfo; lead: Lead }) {
  if (col.type === "email_verification") return lead.verification_status ? <VerificationBadge status={lead.verification_status} /> : <span className="text-faint">—</span>;
  if (col.type === "work_email_enrichment" || col.type === "custom_flow") {
    if (lead.email) return <div className="max-w-[16rem] truncate">{lead.email}</div>;
    return <span className="text-faint">{lead.payload?.email_finder_status ? "Not found" : "—"}</span>;
  }
  const value = cellText(col, lead);
  return value ? (
    <div className="max-w-[16rem] truncate" title={value}>
      {value}
    </div>
  ) : (
    <span className="text-faint">—</span>
  );
}

function ColumnHeader({ col, total, writable, act }: { col: ColumnInfo; total: number; writable: boolean; act: (what: "run" | "edit" | "stop" | "resume" | "delete") => void }) {
  const label = columnLabel(col);
  const run = col.running;
  const pct = run ? (run.total ? Math.round((run.processed / run.total) * 100) : run.progress) : 0;
  const outOfCredits = !run && col.last_run?.error === "OUT_OF_CREDITS";
  return (
    <div className="min-w-[8rem] max-w-[16rem]">
      <div className="flex items-center gap-1">
        <span className="truncate" title={col.type === "ai_enrichment" ? `{{${col.name}}}` : undefined}>
          {label}
        </span>
        {writable && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={`${label} column actions`} className="shrink-0 rounded p-0.5 text-faint hover:bg-panel-2 hover:text-text">
                <MoreHorizontal size={14} />
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              {run ? (
                <MenuItem icon={<Square size={13} />} onSelect={() => act("stop")}>
                  Stop
                </MenuItem>
              ) : col.paused ? (
                <MenuItem icon={<Play size={14} />} onSelect={() => act("resume")}>
                  Resume
                </MenuItem>
              ) : (
                <MenuItem icon={<Play size={14} />} onSelect={() => act("run")}>
                  Run…
                </MenuItem>
              )}
              <MenuItem icon={<Pencil size={14} />} onSelect={() => act("edit")}>
                Edit…
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => act("delete")}>
                Delete column…
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      {run ? (
        <div className="mt-1 flex items-center gap-1.5 font-normal" aria-live="polite">
          <Progress value={pct} className="h-1 w-16" />
          <span className="text-[11px] tabular-nums text-faint">{run.status === "pending" ? "Queued" : `${pct}%`}</span>
        </div>
      ) : (
        <p className={outOfCredits ? "mt-0.5 text-[11px] font-normal text-warn" : "mt-0.5 text-[11px] font-normal text-faint"}>
          {outOfCredits ? "Stopped: out of credits" : col.paused ? "Paused" : `${num(col.filled)} of ${num(total)} filled`}
        </p>
      )}
    </div>
  );
}

// ---------- Which rows ----------

type Scope = "first" | "selected" | "all" | "none";

interface RowsContext {
  filters: Record<string, unknown>;
  selection: Selection;
  selectedCount: number;
  total: number;
}

function rowsBody(scope: Exclude<Scope, "none">, count: number, ctx: RowsContext) {
  if (scope === "first") return { mode: "first", count, filter: ctx.filters };
  if (scope === "selected") return ctx.selection.all ? { mode: "filter", filter: ctx.filters } : { mode: "ids", ids: [...ctx.selection.ids] };
  return { mode: "all" };
}

const rowsCount = (scope: Scope, count: number, ctx: RowsContext) => (scope === "first" ? Math.min(count, ctx.total) : scope === "selected" ? ctx.selectedCount : scope === "all" ? ctx.total : 0);

function RowsPicker({ scope, setScope, count, setCount, ctx, allowNone }: { scope: Scope; setScope: (s: Scope) => void; count: number; setCount: (n: number) => void; ctx: RowsContext; allowNone?: boolean }) {
  const option = (value: Scope, children: ReactNode) => (
    <label className="flex min-h-8 flex-wrap items-center gap-2 text-[13px]">
      <input type="radio" name="enrich-rows" className="accent-brand" checked={scope === value} onChange={() => setScope(value)} />
      {children}
    </label>
  );
  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] font-medium">Run it on</legend>
      {option(
        "first",
        <>
          The first
          <span onFocusCapture={() => setScope("first")}>
            <NumberInput aria-label="Number of rows" className="w-24" min={1} max={10000} value={count} onChange={(v) => setCount(Math.max(1, Math.min(10000, v ?? 1)))} />
          </span>
          rows of the table
        </>,
      )}
      {ctx.selectedCount > 0 && option("selected", ctx.selection.all ? `All ${num(ctx.selectedCount)} matching rows` : `The ${plural(ctx.selectedCount, "selected row")}`)}
      {option("all", `All ${plural(ctx.total, "row")}`)}
      {allowNone && option("none", "Don't run it yet")}
    </fieldset>
  );
}

function CostLine({ type, rows, info }: { type: string; rows: number; info: ColumnsInfo }) {
  const each = COST[type] ?? 0;
  if (info.self_hosted || !each || !rows) return null;
  return (
    <p className="text-xs text-muted">
      Up to {plural(Math.ceil(rows * each * 100) / 100, "credit")}
      {info.credits !== null && ` · ${num(info.credits)} left`}
      {type === "ai_enrichment" && " · free with your own AI key"}
    </p>
  );
}

// ---------- Add / edit ----------

function NormalizePreview({ targets, rows }: { targets: string[]; rows: Lead[] }) {
  const samples = rows.filter((l) => l.first_name || l.last_name || l.company_name || l.website || l.company_domain).slice(0, 3);
  const after = (l: Lead) =>
    [
      targets.includes("name") ? [cleanPersonName(l.first_name), cleanPersonName(l.last_name)].filter(Boolean).join(" ") : "",
      targets.includes("company") ? cleanCompanyName(l.company_name) : "",
      targets.includes("domain") ? cleanDomain(l.website) || cleanDomain(l.company_domain) || cleanDomain(l.email) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const before = (l: Lead) => [targets.includes("name") ? fullName(l) : "", targets.includes("company") ? l.company_name : "", targets.includes("domain") ? l.website || l.company_domain : ""].filter(Boolean).join(" · ");
  const list = samples.length ? samples.map((l) => [before(l), after(l)] as const) : ([["mary-jane O'NEIL · ACME WIDGETS LTD · https://www.Acme.com/about", "Mary-Jane O'Neil · Acme Widgets · acme.com"]] as const);
  return (
    <div className="rounded-lg border border-line text-xs">
      <p className="border-b border-line px-3 py-1.5 font-medium text-muted">{samples.length ? "Preview" : "Example"}</p>
      {list.map(([b, a], i) => (
        <div key={i} className="grid gap-0.5 border-b border-line px-3 py-1.5 last:border-0">
          <span className="truncate text-muted">{b || "—"}</span>
          <span className="truncate">→ {a || "nothing to tidy"}</span>
        </div>
      ))}
    </div>
  );
}

function PromptEditor({ value, onChange, variables }: { value: string; onChange: (v: string) => void; variables: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    const el = ref.current;
    const token = `{{${name}}}`;
    if (!el) return onChange(value + token);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="space-y-2">
      <Textarea ref={ref} rows={6} value={value} maxLength={20000} onChange={(e) => onChange(e.target.value)} placeholder="Ask for anything about each lead, e.g. Write a one-line opener for {{first_name}} at {{company_name}}." />
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-xs text-muted">Insert:</span>
        {variables.map((v) => (
          <button key={v} type="button" onClick={() => insert(v)} className="rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-text">
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

const slug = (s: string) =>
  s
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 60);

function ColumnDialog({
  mode,
  info,
  ctx,
  rows,
  resourceId,
  campaignId,
  listId,
  onClose,
}: {
  mode: { kind: "add" } | { kind: "edit"; col: ColumnInfo };
  info: ColumnsInfo;
  ctx: RowsContext;
  rows: Lead[];
  resourceId: string;
  campaignId?: string;
  listId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const editing = mode.kind === "edit" ? mode.col : null;
  const [type, setType] = useState<string | null>(editing?.type ?? null);
  const [name, setName] = useState(editing?.name ?? "");
  const [prompt, setPrompt] = useState(editing?.prompt ?? "");
  const [skip, setSkip] = useState(editing?.skip_leads_without_email ?? false);
  const [targets, setTargets] = useState<string[]>(editing?.targets ?? ["name", "company", "domain"]);
  const [auto, setAuto] = useState(editing?.auto_update ?? false);
  const [scope, setScope] = useState<Scope>(ctx.selectedCount > 0 ? "selected" : "first");
  const [count, setCount] = useState(10);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const isAi = type === "ai_enrichment";
  const vars = useQuery({
    queryKey: ["lead-variables", campaignId ?? null, listId ?? null],
    queryFn: () => get<{ keys: string[] }>("/api/app/leads/variables", { campaign_id: campaignId, list_id: listId }),
    enabled: isAi,
    staleTime: 60_000,
  });
  const taken = new Set(info.columns.map((c) => (c.type === "ai_enrichment" ? `ai:${(c.name ?? "").toLowerCase()}` : c.type)));
  const nameError = isAi && !editing ? (aiColumnNameError(name) ?? (taken.has(`ai:${name.toLowerCase()}`) ? "There's already a column with that name" : null)) : null;
  const kinds = ENRICHMENT_COLUMN_KINDS.filter((k) => (info.resource_type === 1 ? !k.listsOnly : !k.campaignsOnly));

  const save = async () => {
    setTouched(true);
    if (!type || nameError || (isAi && !prompt.trim()) || (type === "normalize" && !targets.length)) return;
    setBusy(true);
    try {
      const settings = { ...(isAi ? { prompt, skip_leads_without_email: skip } : {}), ...(type === "normalize" ? { targets } : {}), auto_update: auto };
      if (editing) {
        await patch("/api/app/enrichment-columns", { resource_id: resourceId, key: editing.key, ...settings });
        toast.success("Column saved");
      } else {
        const r = await post<{ key: string; job_id: string | null }>("/api/app/enrichment-columns", {
          resource_id: resourceId,
          type,
          ...(isAi ? { name } : {}),
          ...settings,
          ...(scope !== "none" ? { run: { rows: rowsBody(scope, count, ctx) } } : {}),
        });
        toast.success(r.job_id ? `Column added. Filling in ${plural(rowsCount(scope, count, ctx), "row")}…` : "Column added");
      }
      await qc.invalidateQueries({ queryKey: ["enrichment-columns", resourceId] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const kind = type ? KINDS.get(type) : null;
  const title = editing ? `Edit ${columnLabel(editing)}` : kind ? kind.label : "Add a column";
  const variableChips = [...LEAD_VARIABLES, ...(vars.data?.keys ?? []).filter((k) => !LEAD_VARIABLES.includes(k) && k !== name)];

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      size={type ? "md" : "lg"}
      title={title}
      description={!type ? "Each column fills in a value for every lead you run it on." : kind?.description}
      footer={
        type ? (
          <>
            {!editing && (
              <Button variant="ghost" className="mr-auto" onClick={() => setType(null)}>
                Back
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={save}>
              {editing ? "Save" : scope === "none" ? "Add column" : "Add and run"}
            </Button>
          </>
        ) : undefined
      }
    >
      {!type ? (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {kinds.map((k) => {
              const exists = k.type !== "ai_enrichment" && taken.has(k.type);
              const noAi = k.type === "ai_enrichment" && !info.ai_available;
              const each = COST[k.type] ?? 0;
              return (
                <button
                  key={k.type}
                  type="button"
                  disabled={exists || noAi}
                  onClick={() => setType(k.type)}
                  className="flex items-start gap-3 rounded-lg border border-line p-3 text-left transition-colors hover:border-brand/50 hover:bg-panel-2/60 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-line disabled:hover:bg-transparent"
                >
                  <span className="mt-0.5 shrink-0 text-brand">{ICONS[k.type]}</span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{k.label}</span>
                    <span className="block text-xs text-muted">{exists ? "Already a column here" : noAi ? "Needs an AI key first" : k.description}</span>
                    {!info.self_hosted && each > 0 && !exists && <span className="mt-0.5 block text-[11px] text-faint">{plural(each, "credit")} per lead</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {!info.ai_available && (
            <p className="text-xs text-muted">
              AI columns need an Anthropic API key.{" "}
              <Link to="/app/settings/integrations?tab=ai" className="text-brand-text underline underline-offset-2">
                Add one in Settings
              </Link>
              .
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {isAi && (
            <>
              <Field
                label="Column name"
                error={touched || name ? nameError : null}
                hint={editing ? `Saved on each lead as {{${name}}}. The name can't change, so emails that use it keep working.` : `Saved on each lead as {{${name || "column_name"}}}, so you can use it in emails.`}
              >
                {(id) => (
                  <Input
                    id={id}
                    value={name}
                    disabled={!!editing}
                    maxLength={60}
                    placeholder="e.g. opening_line"
                    onChange={(e) => setName(slug(e.target.value))}
                    // Only with a mouse: on a phone the keyboard would cover the dialog.
                    autoFocus={!editing && window.matchMedia?.("(pointer: fine)").matches}
                  />
                )}
              </Field>
              <div>
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium">Prompt</span>
                  {!editing && (
                    <span className="ml-auto flex flex-wrap gap-1">
                      {STARTERS.map((s) => (
                        <Button
                          key={s.label}
                          size="xs"
                          variant="soft"
                          onClick={() => {
                            setPrompt(s.prompt);
                            if (!name) setName(s.name);
                          }}
                        >
                          {s.label}
                        </Button>
                      ))}
                    </span>
                  )}
                </div>
                <PromptEditor value={prompt} onChange={setPrompt} variables={variableChips} />
                {touched && !prompt.trim() && <p className="mt-1.5 text-xs text-bad">Write what the column should answer</p>}
              </div>
              <Checkbox label="Skip leads without an email address" checked={skip} onChange={setSkip} />
            </>
          )}
          {type === "normalize" && (
            <>
              <div className="space-y-2">
                <p className="text-[13px] font-medium">Tidy up</p>
                {(Object.keys(NORMALIZE_TARGETS) as NormalizeTarget[]).map((t) => (
                  <Checkbox key={t} label={NORMALIZE_LABELS[t]} checked={targets.includes(t)} onChange={(on) => setTargets(on ? [...targets, t] : targets.filter((x) => x !== t))} />
                ))}
                {touched && !targets.length && <p className="text-xs text-bad">Pick at least one</p>}
              </div>
              <NormalizePreview targets={targets} rows={rows} />
              <p className="text-xs text-muted">
                The originals stay as they are. Tidy copies are saved as {(Object.keys(NORMALIZE_TARGETS) as NormalizeTarget[]).filter((t) => targets.includes(t)).flatMap((t) => NORMALIZE_TARGETS[t].map((v) => `{{${v}}}`)).join(", ") || "variables"}.
              </p>
            </>
          )}
          <Checkbox label="Fill in new leads automatically" checked={auto} onChange={setAuto} />
          {!editing && (
            <>
              <RowsPicker scope={scope} setScope={setScope} count={count} setCount={setCount} ctx={ctx} allowNone />
              <CostLine type={type} rows={rowsCount(scope, count, ctx)} info={info} />
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---------- Run / delete ----------

function RunDialog({ col, info, ctx, resourceId, onClose }: { col: ColumnInfo; info: ColumnsInfo; ctx: RowsContext; resourceId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>(ctx.selectedCount > 0 ? "selected" : "first");
  const [count, setCount] = useState(10);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const findsEmail = col.type === "work_email_enrichment" || col.type === "custom_flow";
  const run = async () => {
    if (scope === "none") return;
    setBusy(true);
    try {
      await post("/api/app/enrichment-columns/run", { resource_id: resourceId, key: col.key, rows: rowsBody(scope, count, ctx), overwrite });
      await qc.invalidateQueries({ queryKey: ["enrichment-columns", resourceId] });
      toast.success(`Filling in ${columnLabel(col)}…`);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Run ${columnLabel(col)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Play size={14} />} loading={busy} onClick={run}>
            Run
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RowsPicker scope={scope} setScope={setScope} count={count} setCount={setCount} ctx={ctx} />
        {findsEmail ? (
          <p className="text-xs text-muted">Leads that already have an address are skipped. A found address never replaces one you have.</p>
        ) : (
          <Checkbox
            label={col.type === "email_verification" ? "Check addresses that were checked before too" : "Redo rows that already have a value"}
            checked={overwrite}
            onChange={setOverwrite}
          />
        )}
        <CostLine type={col.type} rows={rowsCount(scope, count, ctx)} info={info} />
      </div>
    </Dialog>
  );
}

function DeleteDialog({ col, resourceId, onClose }: { col: ColumnInfo; resourceId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [clear, setClear] = useState(col.variables.length > 0);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await post("/api/app/enrichment-columns/remove", { resource_id: resourceId, key: col.key, clear_values: clear });
      await Promise.all([qc.invalidateQueries({ queryKey: ["enrichment-columns", resourceId] }), qc.invalidateQueries({ queryKey: ["leads"] })]);
      toast.success("Column deleted");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      size="sm"
      title={`Delete the ${columnLabel(col)} column?`}
      description="It stops filling in, here and for new leads."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={remove}>
            Delete column
          </Button>
        </>
      }
    >
      {col.variables.length ? (
        <div className="space-y-1.5">
          <Checkbox label="Also remove the values it filled in" checked={clear} onChange={setClear} />
          <p className="line-clamp-2 pl-6 text-xs text-muted">{col.variables.map((v) => `{{${v}}}`).join(", ")}</p>
          {!clear && <p className="pl-6 text-xs text-muted">They stay on the leads as variables, so emails that use them keep working.</p>}
        </div>
      ) : (
        <p className="text-[13px] text-muted">{col.type === "email_verification" ? "Check results stay on the leads." : "Addresses it found stay on the leads."}</p>
      )}
    </Dialog>
  );
}

// ---------- The hook the table uses ----------

/**
 * Enrichment columns for the leads table of a list or campaign: the table columns, the "Enrich" button and the
 * dialogs. Nothing on the all-leads view, which has no list or campaign to attach them to.
 */
export function useEnrichmentColumns({
  campaignId,
  listId,
  rows,
  filters,
  selection,
  selectedCount,
  total,
  writable,
}: {
  campaignId?: string;
  listId?: string;
  rows: Lead[];
  filters: Record<string, unknown>;
  selection: Selection;
  selectedCount: number;
  total: number | undefined;
  writable: boolean;
}) {
  const qc = useQueryClient();
  const resourceId = listId ?? campaignId ?? null;
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "edit" | "run" | "delete"; col: ColumnInfo } | null>(null);
  const info = useQuery({
    queryKey: ["enrichment-columns", resourceId],
    queryFn: () => get<ColumnsInfo>(`/api/app/enrichment-columns/${resourceId}`),
    enabled: !!resourceId,
    refetchInterval: (q) => ((q.state.data as ColumnsInfo | undefined)?.columns.some((c) => c.running) ? 2000 : false),
  });
  const data = info.data;
  const running = (data?.columns ?? []).filter((c) => c.running).map((c) => c.key);
  const runningKey = running.join("|");

  // Values land while a column runs: refresh the rows now and then, and once more when it's done.
  useInterval(() => void qc.invalidateQueries({ queryKey: ["leads", "table"] }), running.length ? 4000 : null);
  const wasRunning = useRef<string[]>([]);
  useEffect(() => {
    const finished = wasRunning.current.filter((k) => !running.includes(k));
    wasRunning.current = running;
    if (!finished.length) return;
    void qc.invalidateQueries({ queryKey: ["leads"] });
    for (const key of finished) {
      const col = data?.columns.find((c) => c.key === key);
      const r = col?.last_run;
      if (!col || !r) continue;
      if (r.error === "OUT_OF_CREDITS") toast.warning(`${columnLabel(col)} stopped: out of credits`);
      else if (r.status === "completed") toast.success(`${columnLabel(col)} is done · ${plural(r.succeeded, "lead")} filled in`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey]);

  const act = (col: ColumnInfo) => async (what: "run" | "edit" | "stop" | "resume" | "delete") => {
    if (what === "run" || what === "edit" || what === "delete") return setDialog({ kind: what, col });
    try {
      if (what === "stop") await post("/api/app/enrichment-columns/stop", { resource_id: resourceId, key: col.key });
      else await patch("/api/app/enrichment-columns", { resource_id: resourceId, key: col.key, paused: false });
      await qc.invalidateQueries({ queryKey: ["enrichment-columns", resourceId] });
      toast.success(what === "stop" ? `Stopped ${columnLabel(col)}` : `${columnLabel(col)} can run again`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const leadsTotal = total ?? data?.total_leads ?? 0;
  const ctx: RowsContext = { filters, selection, selectedCount, total: leadsTotal };
  const columns: Column<Lead>[] = (data?.columns ?? []).map((col) => ({
    key: `enrich:${col.key}`,
    header: <ColumnHeader col={col} total={data?.total_leads ?? 0} writable={writable} act={act(col)} />,
    headerClassName: "align-top",
    cell: (l: Lead) => <EnrichmentCell col={col} lead={l} />,
  }));

  const button =
    resourceId && writable && data ? (
      <Button size="sm" icon={<Sparkles size={14} />} onClick={() => setDialog({ kind: "add" })}>
        Enrich
      </Button>
    ) : null;

  const dialogs =
    resourceId && data && dialog ? (
      dialog.kind === "add" || dialog.kind === "edit" ? (
        <ColumnDialog
          mode={dialog.kind === "add" ? { kind: "add" } : { kind: "edit", col: dialog.col }}
          info={data}
          ctx={ctx}
          rows={rows}
          resourceId={resourceId}
          campaignId={campaignId}
          listId={listId}
          onClose={() => setDialog(null)}
        />
      ) : dialog.kind === "run" ? (
        <RunDialog col={dialog.col} info={data} ctx={ctx} resourceId={resourceId} onClose={() => setDialog(null)} />
      ) : (
        <DeleteDialog col={dialog.col} resourceId={resourceId} onClose={() => setDialog(null)} />
      )
    ) : null;

  return { columns, button, dialogs };
}

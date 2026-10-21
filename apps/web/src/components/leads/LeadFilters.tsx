// The filter and sort builder above the leads tables: filter rules as chips, sorting and saved views. Everything
// lives in the URL (q, filter, where, sort, view), so a filtered table can be bookmarked or shared.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { ArrowDownUp, Bookmark, Check, ChevronDown, ChevronLeft, ListFilter, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import {
  ESG_LABELS,
  ESP_LABELS,
  LEAD_FILTER_FIELDS,
  LEAD_OP_LABELS,
  LEAD_SORTS,
  LEAD_SORT_KEYS,
  LEAD_STATUS_LABELS,
  MAX_LEAD_RULES,
  VERIFICATION_STATUS_LABELS,
  leadFieldOps,
  leadOpNeedsValue,
  type LeadFieldDef,
  type LeadRule,
  type LeadSortKey,
} from "@reachstack/shared";
import { del, errorMessage, get, patch, post, type Page } from "@/lib/api";
import { dateOnly } from "@/lib/format";
import { useLeadStatuses } from "@/lib/statuses";
import { Button, Checkbox, Dialog, Field, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, NativeSelect, NumberInput, Popover, useConfirm } from "@/components/ui";

type FieldKey = LeadFieldDef["field"];
export type LeadSort = { by: LeadSortKey; order: "asc" | "desc" };

export interface SavedView {
  id: string;
  name: string;
  rules: LeadRule[];
  sort_by: LeadSortKey | null;
  sort_order: "asc" | "desc" | null;
}

const FIELDS = new Map(LEAD_FILTER_FIELDS.map((f) => [f.field, f]));
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRule(r: unknown): r is LeadRule {
  if (!r || typeof r !== "object") return false;
  const { field, op, value, key } = r as Record<string, unknown>;
  const def = FIELDS.get(field as FieldKey);
  if (!def || typeof op !== "string" || !leadFieldOps(def.field).includes(op)) return false;
  switch (def.kind) {
    case "set":
      return Array.isArray(value) && value.length > 0;
    case "bool":
      return true;
    case "number":
      return typeof value === "number";
    case "date":
      if (op === "before" || op === "after") return typeof value === "string" && DATE_ONLY.test(value);
      return op === "within_days" || op === "over_days" ? typeof value === "number" : true;
    case "custom":
      return typeof key === "string" && !!key && (!leadOpNeedsValue(op) || typeof value === "string");
    default:
      return !leadOpNeedsValue(op) || (typeof value === "string" && !!value);
  }
}

/** Rules from the URL; anything malformed is dropped so a hand-edited link can't break the table. */
export function parseRules(raw: string | null): LeadRule[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter(isRule).slice(0, MAX_LEAD_RULES) : [];
  } catch {
    return [];
  }
}

export function parseSort(raw: string | null): LeadSort | null {
  const [by, order] = (raw ?? "").split(".");
  return LEAD_SORT_KEYS.includes(by as LeadSortKey) && (order === "asc" || order === "desc") ? { by: by as LeadSortKey, order } : null;
}

/** Rules as the API takes them: a picked date means midnight where the viewer is. */
export const apiRules = (rules: LeadRule[]): LeadRule[] =>
  rules.map((r) =>
    (r.field === "created" || r.field === "last_contacted") && (r.op === "before" || r.op === "after") && typeof r.value === "string" && DATE_ONLY.test(r.value)
      ? { ...r, value: new Date(`${r.value}T00:00`).toISOString() }
      : r,
  );

/** The table's filters and sort, read from and written to the URL. */
export function useLeadQuery() {
  const [params, setParams] = useSearchParams();
  const where = params.get("where");
  const rules = useMemo(() => parseRules(where), [where]);
  const set = (changes: Record<string, string | null>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  return {
    search: params.get("q") ?? "",
    preset: params.get("filter") ?? "",
    rules,
    sort: parseSort(params.get("sort")),
    viewId: params.get("view") ?? "",
    /** Identity of the filters (not the sort), for resetting a selection when they change. */
    filterKey: `${params.get("q") ?? ""}|${params.get("filter") ?? ""}|${where ?? ""}`,
    set,
    setRules: (next: LeadRule[]) => set({ where: next.length ? JSON.stringify(next) : null }),
    setSort: (s: LeadSort | null) => set({ sort: s ? `${s.by}.${s.order}` : null }),
  };
}
export type LeadQuery = ReturnType<typeof useLeadQuery>;

// ---------- Values and labels ----------

type Option = { value: string; label: string };

function useOwnerOptions(enabled: boolean): Option[] {
  const q = useQuery({
    queryKey: ["workspace-members"],
    queryFn: () => get<Page<{ user_id: string | null; email: string | null; name: { first: string; last: string } | null; accepted: boolean }>>("/api/v2/workspace-members", { limit: 100 }),
    enabled,
    staleTime: 60_000,
  });
  return (q.data?.items ?? []).filter((m) => m.accepted && m.user_id).map((m) => ({ value: m.user_id!, label: `${m.name?.first ?? ""} ${m.name?.last ?? ""}`.trim() || m.email || "Teammate" }));
}

const entries = (labels: Record<number, string>, skip: string[] = []) => Object.entries(labels).filter(([v]) => !skip.includes(v)).map(([value, label]) => ({ value, label }));

/** Choices for the fields that pick from a list. "none" stands for "no value". */
function useSetOptions(needOwners: boolean): (field: FieldKey) => Option[] {
  const statuses = useLeadStatuses();
  const owners = useOwnerOptions(needOwners);
  return (field) => {
    switch (field) {
      case "status":
        return entries(LEAD_STATUS_LABELS);
      case "verification":
        return entries(VERIFICATION_STATUS_LABELS, ["12"]);
      case "provider":
        return entries(ESP_LABELS);
      case "gateway":
        return entries(ESG_LABELS);
      case "interest":
        return [{ value: "none", label: "No lead status" }, ...statuses.all.map((s) => ({ value: String(s.code), label: s.label }))];
      case "owner":
        return [{ value: "none", label: "Nobody" }, ...owners];
      default:
        return [];
    }
  };
}

const daysLabel = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

function opLabel(field: FieldKey, op: string): string {
  const kind = FIELDS.get(field)?.kind;
  if (kind === "bool") return op === "yes" ? "Yes" : "No";
  if (kind === "date") return { empty: "never", not_empty: "at any time" }[op as "empty" | "not_empty"] ?? LEAD_OP_LABELS[op] ?? op;
  return LEAD_OP_LABELS[op] ?? op;
}

/** "Lead status is Interested, Meeting booked", "Company contains “acme”", "Date added in the last 30 days". */
export function describeRule(r: LeadRule, optionsFor: (field: FieldKey) => Option[]): string {
  const v = (r as { value?: unknown }).value;
  if (r.field === "preset" || r.field === "search") return r.value;
  const def = FIELDS.get(r.field)!;
  const name = r.field === "custom" ? r.key : def.label;
  const op = LEAD_OP_LABELS[r.op] ?? r.op;
  switch (def.kind) {
    case "set": {
      const opts = optionsFor(r.field);
      const values = (Array.isArray(v) ? v : []).map((x) => opts.find((o) => o.value === (x === null ? "none" : String(x)))?.label ?? String(x));
      return `${name} ${op} ${values.join(", ")}`;
    }
    case "bool":
      return `${name}: ${r.op === "yes" ? "yes" : "no"}`;
    case "date":
      if (r.op === "within_days") return `${name} in the last ${daysLabel(Number(v))}`;
      if (r.op === "over_days") return `${name} more than ${daysLabel(Number(v))} ago`;
      if (r.op === "empty") return `${name}: never`;
      if (r.op === "not_empty") return `${name}: at any time`;
      return `${name} ${op} ${typeof v === "string" ? dateOnly(`${v}T00:00`) : ""}`;
    default:
      return leadOpNeedsValue(r.op) ? `${name} ${op} “${String(v ?? "")}”` : `${name} ${op}`;
  }
}

// ---------- Rule editor ----------

interface Draft {
  field: FieldKey;
  op: string;
  values: string[];
  text: string;
  key: string;
}

function newDraft(field: FieldKey): Draft {
  const kind = FIELDS.get(field)?.kind;
  const op = kind === "date" ? "within_days" : kind === "number" ? "gte" : leadFieldOps(field)[0]!;
  return { field, op, values: [], text: kind === "date" ? "30" : "", key: "" };
}

function draftOf(r: LeadRule): Draft {
  const d: Draft = { field: r.field as FieldKey, op: r.op, values: [], text: "", key: "" };
  if (r.field === "custom") return { ...d, key: r.key, text: r.value ?? "" };
  if ("value" in r && Array.isArray(r.value)) return { ...d, values: r.value.map((v) => (v === null ? "none" : String(v))) };
  if ("value" in r && r.value !== undefined) return { ...d, text: String(r.value) };
  return d;
}

/** The rule a draft makes, or why it can't make one yet. */
function ruleOf(d: Draft): LeadRule | string {
  const kind = FIELDS.get(d.field)!.kind;
  const text = d.text.trim();
  const needsValue = leadOpNeedsValue(d.op);
  switch (kind) {
    case "set": {
      if (!d.values.length) return "Pick at least one";
      const op = d.op as "is" | "is_not";
      if (d.field === "interest") return { field: "interest", op, value: d.values.map((v) => (v === "none" ? null : Number(v))) };
      if (d.field === "owner") return { field: "owner", op, value: d.values.map((v) => (v === "none" ? null : v)) };
      return { field: d.field as "status" | "verification" | "provider" | "gateway", op, value: d.values.map(Number) };
    }
    case "bool":
      return { field: d.field as "opened" | "replied" | "clicked", op: d.op as "yes" | "no" };
    case "number": {
      const n = Number(text);
      if (!text || !Number.isInteger(n) || n < 0) return "Enter a whole number";
      return { field: "step", op: d.op as "is" | "is_not" | "gte" | "lte", value: n };
    }
    case "date": {
      const field = d.field as "created" | "last_contacted";
      if (d.op === "before" || d.op === "after") return DATE_ONLY.test(text) ? { field, op: d.op, value: text } : "Pick a date";
      if (d.op === "within_days" || d.op === "over_days") {
        const n = Number(text);
        return Number.isInteger(n) && n >= 1 && n <= 3650 ? { field, op: d.op, value: n } : "Enter a number of days, 1 to 3650";
      }
      return { field, op: d.op as "empty" | "not_empty" };
    }
    case "custom": {
      const key = d.key.trim();
      if (!key) return "Enter a variable name";
      if (needsValue && !text) return "Enter a value";
      return { field: "custom", key, op: d.op as "contains", ...(needsValue ? { value: text } : {}) };
    }
    default:
      if (needsValue && !text) return "Enter a value";
      return { field: d.field as "company_name", op: d.op as "contains", ...(needsValue ? { value: text } : {}) };
  }
}

function FieldPicker({ fields, onPick }: { fields: LeadFieldDef[]; onPick: (f: FieldKey) => void }) {
  return (
    <div className="w-[min(15rem,calc(100vw-3rem))]">
      <p className="px-1 pb-1.5 text-xs font-medium text-faint">Filter by</p>
      <div className="scroll-thin max-h-72 space-y-0.5 overflow-y-auto">
        {fields.map((f) => (
          <button key={f.field} type="button" onClick={() => onPick(f.field)} className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-panel-2 focus:bg-panel-2 focus:outline-none">
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RuleEditor({
  initial,
  fields,
  variables,
  optionsFor,
  onApply,
  onClose,
}: {
  initial: LeadRule | null;
  fields: LeadFieldDef[];
  variables: string[];
  optionsFor: (field: FieldKey) => Option[];
  onApply: (r: LeadRule) => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<Draft | null>(initial ? draftOf(initial) : null);
  const [error, setError] = useState<string | null>(null);
  if (!d) return <FieldPicker fields={fields} onPick={(f) => setD(newDraft(f))} />;
  const def = FIELDS.get(d.field)!;
  const update = (p: Partial<Draft>) => {
    setD({ ...d, ...p });
    setError(null);
  };
  const apply = () => {
    const r = ruleOf(d);
    if (typeof r === "string") setError(r);
    else onApply(r);
  };
  const needsValue = leadOpNeedsValue(d.op);
  let value: ReactNode = null;
  if (def.kind === "set") {
    const opts = optionsFor(d.field);
    value = (
      <div className="scroll-thin max-h-52 space-y-2 overflow-y-auto rounded-lg border border-line p-2.5">
        {opts.map((o) => (
          <Checkbox
            key={o.value}
            label={o.label}
            checked={d.values.includes(o.value)}
            onChange={(on) => update({ values: on ? [...d.values, o.value] : d.values.filter((v) => v !== o.value) })}
          />
        ))}
        {!opts.length && <p className="text-xs text-muted">Nothing to pick from.</p>}
      </div>
    );
  } else if (def.kind === "number" || (def.kind === "date" && (d.op === "within_days" || d.op === "over_days"))) {
    value = (
      <NumberInput
        aria-label="Value"
        className="w-full"
        min={def.kind === "date" ? 1 : 0}
        max={def.kind === "date" ? 3650 : undefined}
        value={d.text === "" ? null : Number(d.text)}
        onChange={(v) => update({ text: v === null ? "" : String(v) })}
        suffix={def.kind === "date" ? (d.op === "over_days" ? "days ago" : "days") : undefined}
      />
    );
  } else if (def.kind === "date" && needsValue) {
    value = <Input type="date" inputSize="sm" aria-label="Date" className="dark:[color-scheme:dark]" value={d.text} onChange={(e) => update({ text: e.target.value })} />;
  } else if ((def.kind === "text" || def.kind === "custom") && needsValue) {
    value = <Input inputSize="sm" aria-label="Value" placeholder="Value" value={d.text} onChange={(e) => update({ text: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply()} autoFocus={def.kind === "text"} />;
  }
  return (
    <div className="w-[min(20rem,calc(100vw-3rem))] space-y-2.5">
      <div className="flex items-center gap-1">
        {!initial && (
          <button type="button" aria-label="Choose another field" onClick={() => setD(null)} className="-ml-1 rounded p-1 text-faint hover:bg-panel-2 hover:text-text">
            <ChevronLeft size={15} />
          </button>
        )}
        <p className="text-[13px] font-medium">{def.label}</p>
      </div>
      {def.kind === "custom" && (
        <>
          <Input inputSize="sm" aria-label="Variable name" placeholder="Variable name, e.g. industry" list="lead-filter-variables" value={d.key} onChange={(e) => update({ key: e.target.value })} autoFocus />
          <datalist id="lead-filter-variables">
            {variables.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </>
      )}
      <NativeSelect size="sm" aria-label="Condition" value={d.op} onChange={(op) => update({ op })} options={leadFieldOps(d.field).map((o) => ({ value: o, label: opLabel(d.field, o) }))} />
      {value}
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="flex justify-end gap-2 pt-0.5">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={apply}>
          {initial ? "Update" : "Add filter"}
        </Button>
      </div>
    </div>
  );
}

// ---------- Sort ----------

const DIRECTIONS: Record<"date" | "text" | "count", Record<"asc" | "desc", string>> = {
  date: { desc: "Newest first", asc: "Oldest first" },
  text: { asc: "A to Z", desc: "Z to A" },
  count: { desc: "Most first", asc: "Fewest first" },
};
const sortKind = (by: LeadSortKey) => (by.startsWith("timestamp") ? "date" : by === "name" || by === "company_name" ? "text" : "count");
const DEFAULT_SORT: LeadSort = { by: "timestamp_created", order: "desc" };

function SortMenu({ sort, onChange, campaignFields }: { sort: LeadSort | null; onChange: (s: LeadSort | null) => void; campaignFields: boolean }) {
  const current = sort ?? DEFAULT_SORT;
  const options = LEAD_SORTS.filter((s) => campaignFields || !s.campaignOnly);
  const label = LEAD_SORTS.find((s) => s.key === current.by)?.label ?? "Date added";
  // The default order needs no URL parameter.
  const pick = (s: LeadSort) => onChange(s.by === DEFAULT_SORT.by && s.order === DEFAULT_SORT.order ? null : s);
  const tick = (on: boolean) => (on ? <Check size={14} className="text-brand" /> : <span />);
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" icon={<ArrowDownUp size={14} />} aria-label={`Sort: ${label}, ${DIRECTIONS[sortKind(current.by)][current.order].toLowerCase()}`}>
          <span className="max-w-[8rem] truncate">{label}</span>
        </Button>
      </MenuTrigger>
      <MenuContent align="start">
        <MenuLabel>Sort by</MenuLabel>
        {options.map((s) => (
          <MenuItem key={s.key} icon={tick(s.key === current.by)} onSelect={() => pick({ by: s.key, order: s.key === current.by ? current.order : s.order })}>
            {s.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        {(["desc", "asc"] as const).map((order) => (
          <MenuItem key={order} icon={tick(current.order === order)} onSelect={() => pick({ by: current.by, order })}>
            {DIRECTIONS[sortKind(current.by)][order]}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

// ---------- Saved views ----------

function ViewNameDialog({ open, onOpenChange, initial, onSave }: { open: boolean; onOpenChange: (v: boolean) => void; initial: string; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave(name.trim());
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
      title={initial ? "Rename view" : "Save view"}
      description={initial ? undefined : "Saves these filters and the sort under a name everyone in the workspace can pick."}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        {(id) => <Input id={id} value={name} maxLength={80} placeholder="e.g. Replied this month" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />}
      </Field>
    </Dialog>
  );
}

function ViewsMenu({ query, writable, onApply }: { query: LeadQuery; writable: boolean; onApply: (v: SavedView) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [naming, setNaming] = useState<"new" | "rename" | null>(null);
  const views = useQuery({ queryKey: ["lead-views"], queryFn: () => get<{ items: SavedView[] }>("/api/app/lead-views"), staleTime: 30_000 });
  const items = views.data?.items ?? [];
  const active = items.find((v) => v.id === query.viewId) ?? null;
  // A view keeps the search and quick filter too, as rules of their own.
  const current = () => ({
    rules: [...query.rules, ...(query.preset ? [{ field: "preset", op: "is", value: query.preset } as const] : []), ...(query.search ? [{ field: "search", op: "contains", value: query.search } as const] : [])],
    sort_by: query.sort?.by ?? null,
    sort_order: query.sort?.order ?? null,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["lead-views"] });
  const create = async (name: string) => {
    const v = await post<SavedView>("/api/app/lead-views", { name, ...current() });
    await refresh();
    query.set({ view: v.id });
    toast.success(`Saved “${v.name}”`);
  };
  const rename = async (name: string) => {
    await patch(`/api/app/lead-views/${active!.id}`, { name });
    await refresh();
  };
  const update = async () => {
    try {
      await patch(`/api/app/lead-views/${active!.id}`, current());
      await refresh();
      toast.success(`Updated “${active!.name}”`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async () => {
    if (!active || !(await confirm({ title: `Delete the view “${active.name}”?`, description: "It's removed for everyone in the workspace. Leads aren't touched.", confirmLabel: "Delete view", danger: true }))) return;
    try {
      await del(`/api/app/lead-views/${active.id}`);
      query.set({ view: null });
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" icon={<Bookmark size={14} />} className={active ? "border-brand/40 text-brand-text" : undefined}>
            <span className="max-w-[9rem] truncate">{active?.name ?? "Views"}</span>
            <ChevronDown size={13} className="text-faint" />
          </Button>
        </MenuTrigger>
        <MenuContent align="start" className="max-w-[min(18rem,calc(100vw-2rem))]">
          {items.length ? <MenuLabel>Saved views</MenuLabel> : <p className="px-2.5 py-1.5 text-xs text-muted">No saved views yet.</p>}
          <div className="scroll-thin max-h-64 overflow-y-auto">
            {items.map((v) => (
              <MenuItem key={v.id} icon={v.id === active?.id ? <Check size={14} className="text-brand" /> : <span />} onSelect={() => onApply(v)}>
                <span className="break-words">{v.name}</span>
              </MenuItem>
            ))}
          </div>
          {writable && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Plus size={14} />} onSelect={() => setNaming("new")}>
                Save as new view…
              </MenuItem>
              {active && (
                <>
                  <MenuItem icon={<Save size={14} />} onSelect={update}>
                    Update “{active.name}”
                  </MenuItem>
                  <MenuItem icon={<Pencil size={14} />} onSelect={() => setNaming("rename")}>
                    Rename…
                  </MenuItem>
                  <MenuItem icon={<Trash2 size={14} />} danger onSelect={remove}>
                    Delete view
                  </MenuItem>
                </>
              )}
            </>
          )}
        </MenuContent>
      </Menu>
      {naming && (
        <ViewNameDialog
          open
          onOpenChange={(v) => !v && setNaming(null)}
          initial={naming === "rename" ? (active?.name ?? "") : ""}
          onSave={naming === "rename" ? rename : create}
        />
      )}
    </>
  );
}

// ---------- The bar ----------

/**
 * "Add filter", sort and saved views for a leads table, plus the active rules as chips (rendered by
 * FilterChips). Campaign-only fields are left out on lists.
 */
export function useFilterBuilder({ query, campaignId, listId, onSearchText }: { query: LeadQuery; campaignId?: string; listId?: string; onSearchText: (s: string) => void }) {
  const campaignFields = !listId;
  const fields = LEAD_FILTER_FIELDS.filter((f) => campaignFields || !f.campaignOnly);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const optionsFor = useSetOptions(adding || editing !== null || query.rules.some((r) => r.field === "owner"));
  const variables = useQuery({
    queryKey: ["lead-variables", campaignId ?? null, listId ?? null],
    queryFn: () => get<{ keys: string[] }>("/api/app/leads/variables", { campaign_id: campaignId, list_id: listId }),
    enabled: adding || editing !== null,
    staleTime: 60_000,
  });
  const keys = variables.data?.keys ?? [];
  const setRules = (rules: LeadRule[]) => query.setRules(rules);

  const applyView = (v: SavedView) => {
    const preset = v.rules.find((r): r is Extract<LeadRule, { field: "preset" }> => r.field === "preset");
    const search = v.rules.find((r): r is Extract<LeadRule, { field: "search" }> => r.field === "search");
    const rules = v.rules.filter((r) => r.field !== "preset" && r.field !== "search");
    query.set({
      view: v.id,
      where: rules.length ? JSON.stringify(rules) : null,
      filter: preset?.value ?? null,
      q: search?.value ?? null,
      sort: v.sort_by ? `${v.sort_by}.${v.sort_order ?? LEAD_SORTS.find((s) => s.key === v.sort_by)?.order ?? "desc"}` : null,
    });
    onSearchText(search?.value ?? "");
  };

  const clear = () => {
    query.set({ where: null, filter: null, q: null, view: null });
    onSearchText("");
  };

  const full = query.rules.length >= MAX_LEAD_RULES;
  const addButton = (
    <Popover
      open={adding}
      onOpenChange={setAdding}
      collisionPadding={12}
      trigger={
        <Button size="sm" icon={<ListFilter size={14} />} disabled={full} title={full ? `Up to ${MAX_LEAD_RULES} filters` : undefined}>
          Filter
        </Button>
      }
    >
      <RuleEditor
        initial={null}
        fields={fields}
        variables={keys}
        optionsFor={optionsFor}
        onClose={() => setAdding(false)}
        onApply={(r) => {
          setRules([...query.rules, r]);
          setAdding(false);
        }}
      />
    </Popover>
  );

  const chips =
    query.rules.length > 0 ? (
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {query.rules.map((r, i) => (
          <span key={i} className="inline-flex max-w-full items-center rounded-full border border-line-strong bg-panel text-xs shadow-card">
            <Popover
              open={editing === i}
              onOpenChange={(v) => setEditing(v ? i : null)}
              collisionPadding={12}
              trigger={
                <button type="button" className="min-w-0 truncate rounded-l-full py-1 pl-2.5 pr-1.5 text-left hover:text-brand-text" title="Edit this filter">
                  {describeRule(r, optionsFor)}
                </button>
              }
            >
              <RuleEditor
                initial={r}
                fields={fields}
                variables={keys}
                optionsFor={optionsFor}
                onClose={() => setEditing(null)}
                onApply={(next) => {
                  setRules(query.rules.map((x, j) => (j === i ? next : x)));
                  setEditing(null);
                }}
              />
            </Popover>
            <button
              type="button"
              aria-label={`Remove filter: ${describeRule(r, optionsFor)}`}
              className="shrink-0 rounded-r-full py-1 pl-0.5 pr-2 text-faint hover:text-text"
              onClick={() => setRules(query.rules.filter((_, j) => j !== i))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <button type="button" className="px-1 text-xs text-muted hover:text-text" onClick={clear}>
          Clear all
        </button>
      </div>
    ) : null;

  return {
    addButton,
    sortMenu: <SortMenu sort={query.sort} onChange={query.setSort} campaignFields={campaignFields} />,
    viewsMenu: (writable: boolean) => <ViewsMenu query={query} writable={writable} onApply={applyView} />,
    chips,
    clear,
  };
}

// A step's settings: one input per catalog field kind. Text can hold data from earlier steps; campaigns, lists,
// labels, people, Slack connections and the like are picked from the workspace.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Link } from "react-router";
import { Check, ChevronDown, Plus, Search, Trash2 } from "lucide-react";
import { CAMPAIGN_STATUS_LABELS, defaultConfig, fieldVisible, missingFields, parseDateExpression, resolveDate, type FieldSpec, type OutputField } from "@reachstack/shared";
import { cn } from "@/lib/cn";
import { dateTimeIn } from "@/lib/format";
import { useWorkspaceZone } from "@/lib/session";
import { Button, Checkbox, Field, Input, NativeSelect, NumberInput, Popover, Select, TagInput, Textarea } from "@/components/ui";
import type { Options } from "../api";
import { TemplateInput, type DataSource } from "./data";

export interface FieldEnv {
  options: Options | undefined;
  sources: DataSource[];
  readOnly: boolean;
  /** Mark required fields that are empty (after a test was tried). */
  showErrors: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Pickers

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
  group?: string;
}

const triggerClass =
  "inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-panel px-3 text-left text-sm " +
  "focus:border-brand focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-bad";

function useListKeys<T>(items: T[], onEnter: (item: T) => void) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && items[active]) {
      e.preventDefault();
      onEnter(items[active]!);
    }
  };
  return { active, setActive, listRef, onKeyDown };
}

function filterOptions(options: ComboOption[], search: string) {
  const needle = search.trim().toLowerCase();
  return needle ? options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(needle)) : options;
}

function OptionList({ items, active, setActive, listRef, selected, onPick, empty }: { items: ComboOption[]; active: number; setActive: (i: number) => void; listRef: RefObject<HTMLUListElement | null>; selected: (v: string) => boolean; onPick: (o: ComboOption) => void; empty: string }) {
  return (
    <ul ref={listRef} role="listbox" className="scroll-thin max-h-64 overflow-y-auto">
      {items.length === 0 && <li className="px-2.5 py-3 text-center text-[13px] text-muted">{empty}</li>}
      {items.map((o, i) => (
        <li key={o.value || "__any"} role="presentation">
          {o.group && o.group !== items[i - 1]?.group && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{o.group}</div>}
          <button
            type="button"
            role="option"
            aria-selected={selected(o.value)}
            data-index={i}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(o)}
            className={cn("relative flex w-full items-start rounded-md py-1.5 pl-7 pr-2.5 text-left text-sm", i === active && "bg-panel-2")}
          >
            {selected(o.value) && <Check size={14} className="absolute left-2 top-2 text-brand" />}
            <span className="min-w-0">
              <span className="block truncate">{o.label}</span>
              {o.hint && <span className="block truncate text-xs text-muted">{o.hint}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SearchBox({ value, onChange, onKeyDown }: { value: string; onChange: (v: string) => void; onKeyDown: (e: KeyboardEvent) => void }) {
  return <Input inputSize="sm" autoFocus value={value} placeholder="Search" leading={<Search size={14} />} className="mb-1.5" onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />;
}

/** A searchable single choice (long workspace lists: campaigns, people, labels…). */
export function Combo({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  missing = "Not available any more. Choose again.",
  empty = "Nothing matches.",
  id,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder?: string;
  /** Shown when the saved value isn't among the options (deleted since). */
  missing?: string;
  empty?: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const shown = useMemo(() => filterOptions(options, search), [options, search]);
  const pick = (o: ComboOption) => {
    onChange(o.value);
    setOpen(false);
  };
  const keys = useListKeys(shown, pick);
  const current = options.find((o) => o.value === value);
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setSearch("");
          keys.setActive(Math.max(0, options.findIndex((o) => o.value === value)));
        }
      }}
      className="w-[max(var(--radix-popover-trigger-width),16rem)] p-1.5"
      trigger={
        <button type="button" id={id} disabled={disabled} aria-invalid={invalid || undefined} aria-haspopup="listbox" aria-expanded={open} className={triggerClass}>
          <span className={cn("truncate", !current && "text-faint", !current && value && "text-warn")}>{current ? current.label : value ? missing : placeholder}</span>
          <ChevronDown size={14} className="shrink-0 text-faint" />
        </button>
      }
    >
      <SearchBox
        value={search}
        onChange={(v) => {
          setSearch(v);
          keys.setActive(0);
        }}
        onKeyDown={keys.onKeyDown}
      />
      <OptionList items={shown} active={keys.active} setActive={keys.setActive} listRef={keys.listRef} selected={(v) => v === value} onPick={pick} empty={empty} />
    </Popover>
  );
}

/** Several choices from a list (people to email). */
function MultiCombo({ value, onChange, options, placeholder = "Choose…", id, disabled, invalid }: { value: string[]; onChange: (v: string[]) => void; options: ComboOption[]; placeholder?: string; id?: string; disabled?: boolean; invalid?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const shown = useMemo(() => filterOptions(options, search), [options, search]);
  const toggle = (o: ComboOption) => onChange(value.includes(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value]);
  const keys = useListKeys(shown, toggle);
  const names = value.map((v) => options.find((o) => o.value === v)?.label ?? "Removed member");
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setSearch("");
      }}
      className="w-[max(var(--radix-popover-trigger-width),16rem)] p-1.5"
      trigger={
        <button type="button" id={id} disabled={disabled} aria-invalid={invalid || undefined} aria-haspopup="listbox" aria-expanded={open} className={triggerClass}>
          <span className={cn("truncate", !names.length && "text-faint")}>{names.length ? names.join(", ") : placeholder}</span>
          <ChevronDown size={14} className="shrink-0 text-faint" />
        </button>
      }
    >
      <SearchBox
        value={search}
        onChange={(v) => {
          setSearch(v);
          keys.setActive(0);
        }}
        onKeyDown={keys.onKeyDown}
      />
      <OptionList items={shown} active={keys.active} setActive={keys.setActive} listRef={keys.listRef} selected={(v) => value.includes(v)} onPick={toggle} empty="Nothing matches." />
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Option lists

function campaignOptions(f: FieldSpec, o: Options | undefined): ComboOption[] {
  return [
    ...(f.any ? [{ value: "", label: "Any campaign" }] : []),
    ...(f.fromTrigger ? [{ value: "{{trigger.campaign.id}}", label: "The trigger's campaign", hint: "The campaign of the lead or event that started the run" }] : []),
    ...(o?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name, hint: CAMPAIGN_STATUS_LABELS[c.status], group: "Campaigns" })),
  ];
}

function destinationOptions(f: FieldSpec, o: Options | undefined): ComboOption[] {
  return [
    ...(f.any ? [{ value: "", label: "Any campaign or list" }] : []),
    ...(o?.campaigns ?? []).map((c) => ({ value: `campaign:${c.id}`, label: c.name, group: "Campaigns" })),
    ...(o?.lists ?? []).map((l) => ({ value: `list:${l.id}`, label: l.name, group: "Lists" })),
  ];
}

function labelOptions(f: FieldSpec, o: Options | undefined): ComboOption[] {
  return [...(f.any ? [{ value: "", label: "Any label" }] : []), { value: "none", label: "No label" }, ...(o?.labels ?? []).map((l) => ({ value: String(l.code), label: l.label, group: "Labels" }))];
}

const memberOptions = (o: Options | undefined): ComboOption[] => (o?.members ?? []).map((m) => ({ value: m.id, label: m.name, hint: m.name !== m.email ? m.email : undefined }));

let zoneCache: Array<{ group: string; options: Array<{ value: string; label: string }> }> | null = null;
function timeZones(current: string) {
  if (!zoneCache) {
    let all: string[] = [];
    try {
      all = Intl.supportedValuesOf("timeZone");
    } catch {
      all = [];
    }
    const groups = new Map<string, Array<{ value: string; label: string }>>();
    for (const z of all) {
      const region = z.includes("/") ? z.slice(0, z.indexOf("/")) : "Other";
      groups.set(region, [...(groups.get(region) ?? []), { value: z, label: z.slice(z.indexOf("/") + 1).replace(/_/g, " ").replace(/\//g, " / ") }]);
    }
    zoneCache = [{ group: "Universal", options: [{ value: "UTC", label: "UTC" }] }, ...[...groups].filter(([g]) => g !== "Etc").map(([group, options]) => ({ group, options }))];
  }
  const known = zoneCache.some((g) => g.options.some((o) => o.value === current));
  return known || !current ? zoneCache : [{ group: "Saved", options: [{ value: current, label: current }] }, ...zoneCache];
}

// ---------------------------------------------------------------------------------------------------------------
// Composite inputs

const QUICK_DATES = [
  { label: "In 1 hour", value: "$now + 1h" },
  { label: "Tomorrow", value: "$now + 1d" },
  { label: "In 3 days", value: "$now + 3d" },
  { label: "In a week", value: "$now + 1w" },
];

function DateInput({ id, value, onChange, sources, disabled, invalid }: { id: string; value: string; onChange: (v: string) => void; sources: DataSource[]; disabled: boolean; invalid?: boolean }) {
  // Read and shown on the workspace's clock, as the step will when it runs.
  const zone = useWorkspaceZone();
  let preview: string | null = null;
  if (value.includes("{{")) preview = "Filled in from the data when the step runs.";
  else if (value.trim()) {
    const d = resolveDate(value, new Date(), zone);
    preview = d ? `${parseDateExpression(value) ? "If it ran now: " : ""}${dateTimeIn(d, zone)}` : "Use a date such as 2026-03-01 15:00, or $now + 2d.";
  }
  return (
    <div>
      <TemplateInput id={id} value={value} onChange={onChange} sources={sources} placeholder="$now + 1d" disabled={disabled} invalid={invalid} />
      {!disabled && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {QUICK_DATES.map((q) => (
            <button key={q.value} type="button" onClick={() => onChange(q.value)} className={cn("rounded-full border px-2 py-0.5 text-xs", value === q.value ? "border-brand bg-brand-soft text-brand-text" : "border-line text-muted hover:bg-panel-2")}>
              {q.label}
            </button>
          ))}
        </div>
      )}
      {preview && <p className="mt-1 text-xs text-muted">{preview}</p>}
    </div>
  );
}

interface KeyValueRow {
  key: string;
  value: string;
}

function KeyValueEditor({ field, value, onChange, sources, disabled }: { field: FieldSpec; value: unknown; onChange: (v: KeyValueRow[]) => void; sources: DataSource[]; disabled: boolean }) {
  const listId = useId();
  const rows: KeyValueRow[] = Array.isArray(value) ? value.map((r) => ({ key: String(r?.key ?? ""), value: r?.value === undefined || r?.value === null ? "" : String(r.value) })) : [];
  const set = (i: number, patch: Partial<KeyValueRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const noun = field.key === "headers" ? "header" : field.key === "custom" ? "variable" : "field";
  return (
    <div className="space-y-2">
      {field.keys && (
        <datalist id={listId}>
          {field.keys.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </datalist>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <Input
            aria-label={`Name of ${noun} ${i + 1}`}
            value={r.key}
            list={field.keys ? listId : undefined}
            placeholder={field.key === "headers" ? "Header" : "Name"}
            className="w-[38%] shrink-0 font-mono text-xs"
            disabled={disabled}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <div className="min-w-0 flex-1">
            <TemplateInput value={r.value} onChange={(v) => set(i, { value: v })} sources={sources} placeholder="Value" disabled={disabled} />
          </div>
          {!disabled && (
            <Button variant="ghost" size="icon" aria-label={`Remove ${noun} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      ))}
      {!disabled && rows.length < 50 && (
        <Button variant="ghost" size="xs" icon={<Plus size={13} />} onClick={() => onChange([...rows, { key: "", value: "" }])}>
          Add a {noun}
        </Button>
      )}
    </div>
  );
}

const OUTPUT_TYPES: Array<{ value: OutputField["type"]; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes or no" },
  { value: "enum", label: "One of a list" },
  { value: "array", label: "List of text" },
];
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_OUTPUT_FIELDS = 20;

function OutputFieldsEditor({ value, onChange, disabled }: { value: unknown; onChange: (v: OutputField[]) => void; disabled: boolean }) {
  const rows: OutputField[] = Array.isArray(value) ? (value as OutputField[]) : [];
  const set = (i: number, patch: Partial<OutputField>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const names = rows.map((r) => r.name.trim());
  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const nameError = r.name && !FIELD_NAME.test(r.name) ? "Use letters, numbers and _, starting with a letter." : r.name && names.indexOf(r.name.trim()) !== i ? "Another field has this name." : null;
        return (
          <div key={i} className="space-y-2 rounded-lg border border-line p-2.5">
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <Input inputSize="sm" aria-label={`Field ${i + 1} name`} value={r.name} placeholder="field_name" className="font-mono text-xs" invalid={!!nameError} disabled={disabled} onChange={(e) => set(i, { name: e.target.value })} />
              </div>
              <Select size="sm" className="w-36" aria-label={`Field ${i + 1} type`} value={r.type} disabled={disabled} onChange={(type) => set(i, { type })} options={OUTPUT_TYPES} />
              {!disabled && (
                <Button variant="ghost" size="icon-sm" className="mt-0.5" aria-label={`Remove field ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
            {nameError && <p className="text-xs text-bad">{nameError}</p>}
            <Input inputSize="sm" aria-label={`Field ${i + 1} description`} value={r.description ?? ""} placeholder="What it should contain (helps the AI)" disabled={disabled} onChange={(e) => set(i, { description: e.target.value })} />
            {r.type === "enum" && <TagInput value={r.values ?? []} onChange={(values) => set(i, { values })} placeholder="Allowed values, then Enter" disabled={disabled} />}
            {r.type === "number" && (
              <div className="flex flex-wrap items-center gap-2">
                <NumberInput aria-label={`Field ${i + 1} minimum`} value={r.min ?? null} onChange={(min) => set(i, { min })} className="w-24" suffix="min" disabled={disabled} />
                <NumberInput aria-label={`Field ${i + 1} maximum`} value={r.max ?? null} onChange={(max) => set(i, { max })} className="w-24" suffix="max" disabled={disabled} />
                <Checkbox label="Whole number" checked={!!r.integer} onChange={(integer) => set(i, { integer })} disabled={disabled} />
              </div>
            )}
          </div>
        );
      })}
      {!disabled && rows.length < MAX_OUTPUT_FIELDS && (
        <Button variant="ghost" size="xs" icon={<Plus size={13} />} onClick={() => onChange([...rows, { name: "", type: "text", description: "" }])}>
          Add a field
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One field, and the form

const str = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));

function Control({ id, field: f, value, onChange, env, invalid }: { id: string; field: FieldSpec; value: unknown; onChange: (v: unknown) => void; env: FieldEnv; invalid: boolean }) {
  const o = env.options;
  const disabled = env.readOnly;
  switch (f.kind) {
    case "text":
    case "textarea":
    case "lead":
      if (f.templated || f.kind === "lead") return <TemplateInput id={id} value={str(value)} onChange={onChange} sources={env.sources} multiline={f.kind === "textarea"} rows={4} placeholder={f.placeholder ?? (f.kind === "lead" ? "Lead ID or email" : undefined)} disabled={disabled} invalid={invalid} />;
      return f.kind === "textarea" ? (
        <Textarea id={id} rows={4} value={str(value)} placeholder={f.placeholder} disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={str(value)} placeholder={f.placeholder} disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value)} />
      );
    case "number":
      return <NumberInput id={id} value={typeof value === "number" ? value : value === "" || value === null || value === undefined ? null : Number(value)} min={f.min} max={f.max} disabled={disabled} className="w-40" onChange={onChange} />;
    case "select": {
      const options = [...(f.any && !f.options?.some((x) => x.value === "") ? [{ value: "", label: "Any" }] : []), ...(f.options ?? [])];
      return <Select id={id} value={str(value)} onChange={onChange} options={options} disabled={disabled} />;
    }
    case "campaign":
      return <Combo id={id} value={str(value)} onChange={onChange} options={campaignOptions(f, o)} placeholder="Choose a campaign" empty="No campaigns match." disabled={disabled} invalid={invalid} />;
    case "destination":
      return <Combo id={id} value={str(value)} onChange={onChange} options={destinationOptions(f, o)} placeholder="Choose a campaign or list" empty="No campaigns or lists match." disabled={disabled} invalid={invalid} />;
    case "label":
      return <Combo id={id} value={str(value)} onChange={onChange} options={labelOptions(f, o)} placeholder="Choose a label" disabled={disabled} invalid={invalid} />;
    case "member":
      return <Combo id={id} value={str(value)} onChange={onChange} options={[...(f.required ? [] : [{ value: "", label: "No one" }]), ...memberOptions(o)]} placeholder="Choose a person" disabled={disabled} invalid={invalid} />;
    case "members":
      return <MultiCombo id={id} value={Array.isArray(value) ? value.map(str) : []} onChange={onChange} options={memberOptions(o)} placeholder="Choose people" disabled={disabled} invalid={invalid} />;
    case "slack":
      if (o && !o.slack.length)
        return (
          <p className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-[13px] text-muted">
            No Slack connection yet.{" "}
            <Link to="/app/settings/integrations" className="font-medium text-brand-text hover:underline">
              Connect Slack
            </Link>{" "}
            in Settings, then come back.
          </p>
        );
      return <Combo id={id} value={str(value)} onChange={onChange} options={(o?.slack ?? []).map((s) => ({ value: s.id, label: s.name }))} placeholder="Choose a connection" disabled={disabled} invalid={invalid} />;
    case "subsequence":
      return (
        <Combo
          id={id}
          value={str(value)}
          onChange={onChange}
          options={(o?.subsequences ?? []).map((s) => ({ value: s.id, label: s.name, group: s.campaign_name ?? "Campaign" }))}
          placeholder="Choose a subsequence"
          empty="No subsequences yet. Add one from a campaign's Subsequences tab."
          disabled={disabled}
          invalid={invalid}
        />
      );
    case "site":
      return <Combo id={id} value={str(value)} onChange={onChange} options={[...(f.any ? [{ value: "", label: "Any website" }] : []), ...(o?.sites ?? []).map((s) => ({ value: s.id, label: s.domain }))]} placeholder="Choose a website" disabled={disabled} invalid={invalid} />;
    case "keyvalue":
      return <KeyValueEditor field={f} value={value} onChange={onChange} sources={env.sources} disabled={disabled} />;
    case "datetime":
      return <DateInput id={id} value={str(value)} onChange={onChange} sources={env.sources} disabled={disabled} invalid={invalid} />;
    case "time":
      return <Input id={id} type="time" value={str(value)} className="w-36" disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value)} />;
    case "timezone":
      return <NativeSelect id={id} value={str(value) || "UTC"} onChange={onChange} options={timeZones(str(value))} disabled={disabled} />;
    case "output_fields":
      return <OutputFieldsEditor value={value} onChange={onChange} disabled={disabled} />;
    default:
      return null;
  }
}

/** The fields of a trigger or action; `onChange` gets the whole new config. */
export function ConfigForm({ fields, config, onChange, env }: { fields: FieldSpec[]; config: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; env: FieldEnv }) {
  const merged = { ...defaultConfig(fields), ...config };
  const missing = new Set(missingFields(fields, config));
  const visible = fields.filter((f) => fieldVisible(f, merged));
  const set = (key: string, v: unknown) => onChange({ ...config, [key]: v });
  if (!visible.length) return <p className="text-[13px] text-muted">Nothing to set up here.</p>;
  return (
    <div className="space-y-4">
      {visible.map((f) => {
        const error = env.showErrors && missing.has(f.label) ? `Fill in ${f.label.toLowerCase()}.` : null;
        if (f.kind === "boolean") {
          return (
            <div key={f.key}>
              <Checkbox label={f.label} checked={merged[f.key] === true} disabled={env.readOnly} onChange={(v) => set(f.key, v)} />
              {f.hint && <p className="ml-6 mt-1 text-xs text-muted">{f.hint}</p>}
            </div>
          );
        }
        const optional = !f.required && !f.any && f.default === undefined && f.kind !== "select";
        return (
          <Field key={f.key} label={f.label} hint={f.hint} error={error} optional={optional}>
            {(id) => <Control id={id} field={f} value={merged[f.key]} onChange={(v) => set(f.key, v)} env={env} invalid={!!error} />}
          </Field>
        );
      })}
    </div>
  );
}

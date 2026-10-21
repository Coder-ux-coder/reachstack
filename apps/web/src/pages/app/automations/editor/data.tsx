// Inserting data from the trigger and earlier steps: the picker tree, and text fields that hold {{ }} references.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Braces, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge, Input, Popover, SearchInput, Textarea, Tooltip } from "@/components/ui";

export interface DataSource {
  /** "trigger", or a step id. */
  id: string;
  title: string;
  icon: ReactNode;
  data: unknown;
  /** Example data rather than a tested record. */
  example: boolean;
  /** Path prefix: "trigger" or "steps.<id>". */
  prefix: string;
}

interface Row {
  path: string;
  key: string;
  depth: number;
  preview: string;
}

const preview = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "empty";
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? "item" : "items"}`;
  if (typeof v === "object") return "";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
};

function rowsOf(value: unknown, prefix: string, depth = 0, out: Row[] = []): Row[] {
  if (depth > 4 || out.length > 500 || !value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (k === "example" && depth === 0) continue;
    const path = `${prefix}.${k}`;
    out.push({ path, key: k, depth, preview: preview(v) });
    if (Array.isArray(v)) {
      if (v.length && v[0] && typeof v[0] === "object") {
        out.push({ path: `${path}[0]`, key: "first item", depth: depth + 1, preview: "" });
        rowsOf(v[0], `${path}[0]`, depth + 2, out);
      }
    } else if (v && typeof v === "object") rowsOf(v, path, depth + 1, out);
  }
  return out;
}

const SYSTEM: Row[] = [
  { path: "now", key: "Current date and time", depth: 0, preview: "when the step runs" },
  { path: "workflow.name", key: "Automation name", depth: 0, preview: "" },
  { path: "run.id", key: "Run ID", depth: 0, preview: "" },
];

/** The tree of data a field can use; `onPick` gets a path such as "trigger.lead.email". */
export function DataPicker({ sources, onPick, system = true }: { sources: DataSource[]; onPick: (path: string) => void; system?: boolean }) {
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = [
      ...sources.map((s) => ({ id: s.id, title: s.title, icon: s.icon, example: s.example, rows: rowsOf(s.data, s.prefix) })),
      ...(system ? [{ id: "system", title: "Other", icon: null, example: false, rows: SYSTEM }] : []),
    ];
    return all.map((g) => ({ ...g, rows: needle ? g.rows.filter((r) => `${r.path} ${r.key} ${r.preview}`.toLowerCase().includes(needle)) : g.rows })).filter((g) => g.rows.length || !needle);
  }, [sources, system, search]);
  return (
    <div className="w-[min(24rem,calc(100vw-2rem))]">
      <SearchInput value={search} onChange={setSearch} placeholder="Search data" className="mb-2 w-full" autoFocus />
      <div className="scroll-thin max-h-80 space-y-2 overflow-y-auto pr-1">
        {groups.map((g) => {
          const open = !!search || !closed.has(g.id);
          return (
            <div key={g.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] font-semibold hover:bg-panel-2"
                onClick={() => setClosed((c) => (c.has(g.id) ? new Set([...c].filter((x) => x !== g.id)) : new Set([...c, g.id])))}
              >
                <ChevronRight size={13} className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")} />
                {g.icon}
                <span className="min-w-0 flex-1 truncate">{g.title}</span>
                {g.example && (
                  <Tooltip content="Test this step to see real data here.">
                    <span>
                      <Badge tone="warn">Example</Badge>
                    </span>
                  </Tooltip>
                )}
              </button>
              {open && (
                <ul className="mt-0.5">
                  {g.rows.length === 0 && <li className="px-7 py-1 text-xs text-faint">No data yet. Test this step first.</li>}
                  {g.rows.map((r) => (
                    <li key={r.path}>
                      <button
                        type="button"
                        onClick={() => onPick(r.path)}
                        style={{ paddingLeft: `${1.75 + r.depth * 0.85}rem` }}
                        className="flex w-full items-baseline gap-2 rounded-md py-1 pr-2 text-left hover:bg-brand-soft"
                        title={r.path}
                      >
                        <span className={cn("shrink-0 text-[12.5px]", g.id === "system" ? "" : "font-mono")}>{r.key}</span>
                        <span className="min-w-0 truncate text-xs text-muted">{r.preview}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PickerButton({ sources, onPick, label = "Insert data" }: { sources: DataSource[]; onPick: (path: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={
        <button type="button" aria-label={label} title={label} className="rounded-md p-1 text-faint hover:bg-panel-2 hover:text-brand">
          <Braces size={14} />
        </button>
      }
    >
      <DataPicker
        sources={sources}
        onPick={(p) => {
          onPick(p);
          setOpen(false);
        }}
      />
    </Popover>
  );
}

/** A text field that can hold {{ }} references; the braces button inserts one at the cursor. */
export function TemplateInput({
  value,
  onChange,
  sources,
  multiline,
  rows = 3,
  placeholder,
  id,
  invalid,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  sources: DataSource[];
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  id?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const caret = useRef<[number, number] | null>(null);
  const remember = () => {
    const el = ref.current;
    if (el) caret.current = [el.selectionStart ?? value.length, el.selectionEnd ?? value.length];
  };
  const insert = (path: string) => {
    const token = `{{${path}}}`;
    const [a, b] = caret.current ?? [value.length, value.length];
    onChange(value.slice(0, a) + token + value.slice(b));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };
  const common = { id, value, placeholder, disabled, invalid, onChange: (e: { target: { value: string } }) => onChange(e.target.value), onSelect: remember, onKeyUp: remember, onClick: remember, onBlur: remember };
  return (
    <div className="relative">
      {multiline ? <Textarea ref={ref} rows={rows} className="pr-9" {...common} /> : <Input ref={ref} className="pr-9" {...common} />}
      {!disabled && (
        <span className={cn("absolute right-1.5", multiline ? "top-1.5" : "top-1/2 -translate-y-1/2")}>
          <PickerButton sources={sources} onPick={insert} />
        </span>
      )}
    </div>
  );
}

/** A path into the run data (condition fields): typed, or picked from the tree. */
export function PathInput({ value, onChange, sources, id, invalid, disabled }: { value: string; onChange: (v: string) => void; sources: DataSource[]; id?: string; invalid?: boolean; disabled?: boolean }) {
  return (
    <div className="relative">
      <Input id={id} value={value} invalid={invalid} disabled={disabled} placeholder="Choose data" className="pr-9 font-mono text-xs" onChange={(e) => onChange(e.target.value.replace(/^\{\{\s*|\s*\}\}$/g, ""))} />
      {!disabled && (
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2">
          <PickerButton sources={sources} onPick={onChange} label="Choose data" />
        </span>
      )}
    </div>
  );
}

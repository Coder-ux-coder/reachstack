import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, MapPin, Search, X } from "lucide-react";
import { get } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { moduleOn, useSession } from "@/lib/session";
import { cn } from "@/lib/cn";
import { Input, Segmented, Switch, TagInput, Tooltip } from "@/components/ui";

// ---------- Filter shape (the public SuperSearch filter object) ----------

export interface Location {
  label: string;
  place_id?: string;
}

export interface Filters {
  title?: { include?: string[]; exclude?: string[]; includeMode?: "EXACT" | "CONTAINS"; excludeMode?: "EXACT" | "CONTAINS" };
  name?: string[];
  locations?: { include?: Location[]; exclude?: Location[] };
  location_mode?: "contact" | "company";
  level?: string[];
  department?: string[];
  company_name?: { include?: string[]; exclude?: string[] };
  domains?: string[];
  look_alike?: string;
  employeeCount?: string[];
  revenue?: string[];
  industry?: { include?: string[]; exclude?: string[] };
  subIndustry?: { include?: string[]; exclude?: string[] };
  technologies?: string[];
  funding_type?: string[];
  news?: string[];
  jobListing?: string[];
  keyword_filter?: { include?: string; exclude?: string; include_mode?: "ANY" | "ALL" };
  signals?: Array<string | { key: string; period_days?: number }>;
  /** Only companies your website visitor tracking identified. */
  website_visitors?: boolean;
  skip_owned_leads?: boolean;
  show_one_lead_per_company?: boolean;
}

export interface FilterOptions {
  departments: string[];
  levels: string[];
  employee_bands: string[];
  revenue_bands: string[];
  news_types: string[];
  funding_types: string[];
  industries: Record<string, string[]>;
  signals: Array<{ key: string; available: boolean }>;
  technologies: string[];
  countries: string[];
}

export function useFilterOptions() {
  return useQuery({ queryKey: ["lead-finder", "filters"], queryFn: () => get<FilterOptions>("/api/app/lead-finder/filters"), staleTime: 10 * 60_000 });
}

/** Drops empty values so the request (and the "N filters" count) only carries what the user set. */
export function compact(f: Filters): Filters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v;
      continue;
    }
    if (typeof v === "object") {
      const inner = Object.fromEntries(Object.entries(v).filter(([, x]) => (Array.isArray(x) ? x.length : x !== undefined && x !== "")));
      const meaningful = Object.entries(inner).some(([ik, x]) => !/mode$/i.test(ik) && (Array.isArray(x) ? x.length : !!x));
      if (meaningful) out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  return out as Filters;
}

export function activeCount(f: Filters): number {
  return Object.keys(compact(f)).filter((k) => k !== "location_mode" && k !== "skip_owned_leads" && k !== "show_one_lead_per_company").length;
}

export const humanize = (s: string) => s.replace(/_/g, " ").replace(/\b\w/, (m) => m.toUpperCase());

// ---------- Building blocks ----------

function Section({ title, count, children, defaultOpen = false }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen || !!count);
  return (
    <div className="border-b border-line">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-medium hover:bg-panel-2" aria-expanded={open}>
        <span className="flex-1">{title}</span>
        {!!count && <span className="rounded-full bg-brand-soft px-1.5 text-[11px] font-semibold text-brand-text">{count}</span>}
        <ChevronDown size={14} className={cn("text-faint transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="space-y-2.5 px-4 pb-3.5">{children}</div>}
    </div>
  );
}

/** Searchable list of checkable options (levels, industries, technologies…). */
function CheckList({ options, value, onChange, searchable, max = 8, label }: { options: string[]; value: string[]; onChange: (v: string[]) => void; searchable?: boolean; max?: number; label?: (s: string) => string }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const shown = options.filter((o) => (label ? label(o) : o).toLowerCase().includes(q.trim().toLowerCase()));
  const visible = all || q ? shown : shown.slice(0, max);
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <div>
      {searchable && <Input inputSize="sm" className="mb-1.5" leading={<Search size={13} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search options" />}
      <div className={cn("space-y-0.5", (all || q) && "scroll-thin max-h-56 overflow-y-auto")}>
        {visible.map((o) => {
          const on = value.includes(o);
          return (
            <button key={o} type="button" onClick={() => toggle(o)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-panel-2" aria-pressed={on}>
              <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-brand bg-brand text-on-brand" : "border-line-strong")}>{on && <Check size={11} strokeWidth={3} />}</span>
              <span className="truncate">{label ? label(o) : o}</span>
            </button>
          );
        })}
        {!visible.length && <p className="px-1.5 py-1 text-xs text-muted">Nothing matches.</p>}
      </div>
      {!q && shown.length > max && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 px-1.5 text-xs font-medium text-brand-text hover:underline">
          {all ? "Show less" : `Show all ${shown.length}`}
        </button>
      )}
    </div>
  );
}

function IncludeExclude({ include, exclude, onChange, placeholder }: { include: string[]; exclude: string[]; onChange: (v: { include: string[]; exclude: string[] }) => void; placeholder: string }) {
  return (
    <>
      <TagInput value={include} onChange={(v) => onChange({ include: v, exclude })} placeholder={placeholder} />
      <div>
        <p className="mb-1 text-xs text-muted">Exclude</p>
        <TagInput value={exclude} onChange={(v) => onChange({ include, exclude: v })} placeholder="Type and press Enter" />
      </div>
    </>
  );
}

function LocationPicker({ value, onChange, placeholder }: { value: Location[]; onChange: (v: Location[]) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q.trim(), 200);
  const results = useQuery({
    queryKey: ["lead-finder", "locations", dq],
    queryFn: () => get<Array<{ label: string; place_id: string; type: string; count: number }>>("/api/app/lead-finder/locations", { q: dq }),
    enabled: dq.length >= 1,
    staleTime: 60_000,
  });
  const add = (l: Location) => {
    if (!value.some((v) => v.label.toLowerCase() === l.label.toLowerCase())) onChange([...value, l]);
    setQ("");
  };
  return (
    <div className="relative">
      {!!value.length && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {value.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1 rounded-md bg-panel-2 px-2 py-0.5 text-xs">
              {l.label}
              <button type="button" aria-label={`Remove ${l.label}`} onClick={() => onChange(value.filter((x) => x !== l))} className="hit-24 text-faint hover:text-text">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        inputSize="sm"
        leading={<MapPin size={13} />}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && q.trim()) {
            e.preventDefault();
            add({ label: q.trim() });
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {open && dq && (results.data?.length ?? 0) > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-lg">
          {results.data!.map((r) => (
            <button key={r.place_id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add({ label: r.label, place_id: r.place_id })} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-panel-2">
              <span className="truncate">{r.label}</span>
              <span className="ml-2 shrink-0 text-[11px] text-faint">{r.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IndustryPicker({ tree, include, sub, onChange }: { tree: Record<string, string[]>; include: string[]; sub: string[]; onChange: (v: { include: string[]; sub: string[] }) => void }) {
  const [q, setQ] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const groups = Object.entries(tree).filter(([g, subs]) => !needle || g.toLowerCase().includes(needle) || subs.some((s) => s.toLowerCase().includes(needle)));
  return (
    <div>
      <Input inputSize="sm" className="mb-1.5" leading={<Search size={13} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search industries" aria-label="Search industries" />
      <div className="scroll-thin max-h-64 space-y-0.5 overflow-y-auto">
        {groups.map(([g, subs]) => {
          const on = include.includes(g);
          const expanded = openGroup === g || !!needle;
          const subsShown = needle && !g.toLowerCase().includes(needle) ? subs.filter((s) => s.toLowerCase().includes(needle)) : subs;
          return (
            <div key={g}>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => onChange({ include: on ? include.filter((x) => x !== g) : [...include, g], sub })} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-panel-2" aria-pressed={on}>
                  <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-brand bg-brand text-on-brand" : "border-line-strong")}>{on && <Check size={11} strokeWidth={3} />}</span>
                  <span className="truncate">{g}</span>
                </button>
                <button type="button" aria-label={`${expanded ? "Hide" : "Show"} sub-industries of ${g}`} onClick={() => setOpenGroup(openGroup === g ? null : g)} className="rounded p-1 text-faint hover:text-text">
                  <ChevronDown size={13} className={cn("transition-transform", expanded && "rotate-180")} />
                </button>
              </div>
              {expanded && !on && (
                <div className="ml-6 space-y-0.5">
                  {subsShown.map((s) => {
                    const sOn = sub.includes(s);
                    return (
                      <button key={s} type="button" onClick={() => onChange({ include, sub: sOn ? sub.filter((x) => x !== s) : [...sub, s] })} className="flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-xs hover:bg-panel-2" aria-pressed={sOn}>
                        <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border", sOn ? "border-brand bg-brand text-on-brand" : "border-line-strong")}>{sOn && <Check size={10} strokeWidth={3} />}</span>
                        <span className="truncate">{s}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Panel ----------

export function FilterPanel({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const opts = useFilterOptions();
  const visitorsOn = moduleOn(useSession(), "website_visitors");
  const o = opts.data;
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
  const [lookAlike, setLookAlike] = useState(value.look_alike ?? "");
  useEffect(() => setLookAlike(value.look_alike ?? ""), [value.look_alike]);
  const signals = useMemo(() => (o?.signals ?? []).filter((s) => s.available).map((s) => s.key), [o]);
  const unavailableSignals = (o?.signals ?? []).filter((s) => !s.available).length;
  const signalKeys = (value.signals ?? []).map((s) => (typeof s === "string" ? s : s.key));
  const t = value.title ?? {};

  return (
    <div className="text-[13px]">
      <Section title="Job titles" count={(t.include?.length ?? 0) + (t.exclude?.length ?? 0)} defaultOpen>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">Match</span>
          <Segmented
            size="sm"
            value={t.includeMode ?? "CONTAINS"}
            onChange={(m) => set({ title: { ...t, includeMode: m, excludeMode: m } })}
            options={[
              { value: "CONTAINS", label: "Contains" },
              { value: "EXACT", label: "Exact" },
            ]}
          />
        </div>
        <IncludeExclude include={t.include ?? []} exclude={t.exclude ?? []} onChange={(v) => set({ title: { ...t, ...v } })} placeholder="e.g. Head of Sales" />
      </Section>

      <Section title="Location" count={(value.locations?.include?.length ?? 0) + (value.locations?.exclude?.length ?? 0)} defaultOpen>
        <Segmented
          size="sm"
          value={value.location_mode ?? "contact"}
          onChange={(m) => set({ location_mode: m })}
          options={[
            { value: "contact", label: "Contact" },
            { value: "company", label: "Company HQ" },
          ]}
        />
        <LocationPicker value={value.locations?.include ?? []} onChange={(v) => set({ locations: { ...value.locations, include: v } })} placeholder="City, state or country" />
        <div>
          <p className="mb-1 text-xs text-muted">Exclude</p>
          <LocationPicker value={value.locations?.exclude ?? []} onChange={(v) => set({ locations: { ...value.locations, exclude: v } })} placeholder="Exclude a location" />
        </div>
      </Section>

      <Section title="Management level" count={value.level?.length}>
        <CheckList options={o?.levels ?? []} value={value.level ?? []} onChange={(v) => set({ level: v })} max={8} />
      </Section>

      <Section title="Department" count={value.department?.length}>
        <CheckList options={o?.departments ?? []} value={value.department ?? []} onChange={(v) => set({ department: v })} max={10} />
      </Section>

      <Section title="Company" count={(value.company_name?.include?.length ?? 0) + (value.company_name?.exclude?.length ?? 0) + (value.domains?.length ?? 0) + (value.look_alike ? 1 : 0)}>
        <IncludeExclude
          include={value.company_name?.include ?? []}
          exclude={value.company_name?.exclude ?? []}
          onChange={(v) => set({ company_name: v })}
          placeholder="Company names"
        />
        <div>
          <p className="mb-1 text-xs text-muted">Domains</p>
          <TagInput value={value.domains ?? []} onChange={(v) => set({ domains: v.map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")) })} placeholder="acme.com, paste a list" />
        </div>
        <div>
          <p className="mb-1 text-xs text-muted">Lookalike: companies similar to</p>
          <Input
            inputSize="sm"
            value={lookAlike}
            onChange={(e) => setLookAlike(e.target.value)}
            onBlur={() => set({ look_alike: lookAlike.trim() || undefined })}
            onKeyDown={(e) => e.key === "Enter" && set({ look_alike: lookAlike.trim() || undefined })}
            placeholder="company.com"
            aria-label="Lookalike domain"
          />
        </div>
      </Section>

      <Section title="Employees" count={value.employeeCount?.length}>
        <CheckList options={o?.employee_bands ?? []} value={value.employeeCount ?? []} onChange={(v) => set({ employeeCount: v })} max={10} />
      </Section>

      <Section title="Revenue" count={value.revenue?.length}>
        <CheckList options={o?.revenue_bands ?? []} value={value.revenue ?? []} onChange={(v) => set({ revenue: v })} max={10} />
      </Section>

      <Section title="Industry" count={(value.industry?.include?.length ?? 0) + (value.subIndustry?.include?.length ?? 0)}>
        <IndustryPicker
          tree={o?.industries ?? {}}
          include={value.industry?.include ?? []}
          sub={value.subIndustry?.include ?? []}
          onChange={(v) => set({ industry: { ...value.industry, include: v.include }, subIndustry: { ...value.subIndustry, include: v.sub } })}
        />
      </Section>

      <Section title="Keywords" count={(value.keyword_filter?.include ? 1 : 0) + (value.keyword_filter?.exclude ? 1 : 0)}>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">Company matches</span>
          <Segmented
            size="sm"
            value={value.keyword_filter?.include_mode ?? "ANY"}
            onChange={(m) => set({ keyword_filter: { ...value.keyword_filter, include_mode: m } })}
            options={[
              { value: "ANY", label: "Any" },
              { value: "ALL", label: "All" },
            ]}
          />
        </div>
        <TagInput
          value={(value.keyword_filter?.include ?? "").split(",").map((x) => x.trim()).filter(Boolean)}
          onChange={(v) => set({ keyword_filter: { ...value.keyword_filter, include: v.join(", ") } })}
          placeholder="What the company does"
        />
        <div>
          <p className="mb-1 text-xs text-muted">Exclude</p>
          <TagInput
            value={(value.keyword_filter?.exclude ?? "").split(",").map((x) => x.trim()).filter(Boolean)}
            onChange={(v) => set({ keyword_filter: { ...value.keyword_filter, exclude: v.join(", ") } })}
            placeholder="Words to avoid"
          />
        </div>
      </Section>

      <Section title="Technologies" count={value.technologies?.length}>
        <CheckList options={o?.technologies ?? []} value={value.technologies ?? []} onChange={(v) => set({ technologies: v })} searchable max={8} />
      </Section>

      <Section title="Funding" count={value.funding_type?.length}>
        <CheckList options={o?.funding_types ?? []} value={value.funding_type ?? []} onChange={(v) => set({ funding_type: v })} label={humanize} max={8} />
      </Section>

      <Section title="News" count={value.news?.length}>
        <CheckList options={o?.news_types ?? []} value={value.news ?? []} onChange={(v) => set({ news: v })} label={humanize} searchable max={8} />
      </Section>

      <Section title="Job listings" count={value.jobListing?.length}>
        <TagInput value={value.jobListing ?? []} onChange={(v) => set({ jobListing: v })} placeholder="Companies hiring for… e.g. SDR" />
      </Section>

      <Section title="Signals" count={signalKeys.length}>
        {signals.length ? (
          <CheckList options={signals} value={signalKeys} onChange={(v) => set({ signals: v })} label={(k) => humanize(k.replace(/^website_/, "website: "))} max={10} />
        ) : (
          <p className="text-xs text-muted">No signal data on this server yet.</p>
        )}
        {unavailableSignals > 0 && (
          <Tooltip content="Social, review-site, traffic and job-change signals need data sources this server doesn't have.">
            <p className="text-xs text-faint">{unavailableSignals} more signal types aren't available here.</p>
          </Tooltip>
        )}
      </Section>

      <Section title="Name" count={value.name?.length}>
        <TagInput value={value.name ?? []} onChange={(v) => set({ name: v })} placeholder="Person's name" />
      </Section>

      <div className="space-y-3 px-4 py-3.5">
        {visitorsOn && (
          <label className="flex items-center justify-between gap-3">
            <span>
              Visited your website
              <span className="block text-xs text-muted">Companies Website visitors identified</span>
            </span>
            <Switch size="sm" checked={!!value.website_visitors} onChange={(v) => set({ website_visitors: v })} aria-label="Only companies that visited your website" />
          </label>
        )}
        <label className="flex items-center justify-between gap-3">
          <span>Skip leads you already have</span>
          <Switch size="sm" checked={!!value.skip_owned_leads} onChange={(v) => set({ skip_owned_leads: v })} aria-label="Skip leads you already have" />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>One lead per company</span>
          <Switch size="sm" checked={!!value.show_one_lead_per_company} onChange={(v) => set({ show_one_lead_per_company: v })} aria-label="One lead per company" />
        </label>
      </div>
    </div>
  );
}

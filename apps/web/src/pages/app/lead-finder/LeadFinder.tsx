import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bookmark,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coins,
  Database,
  Download,
  Eye,
  History,
  Linkedin,
  ListPlus,
  Phone,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserSearch,
  X,
} from "lucide-react";
import { del, errorMessage, get, post } from "@/lib/api";
import { ago, num, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/cn";
import { Avatar, Badge, Button, Checkbox, EmptyState, LinkTabs, NativeSelect, Popover, Segmented, Sheet, Skeleton, Textarea, Tooltip, useConfirm } from "@/components/ui";
import { AddLeadsDialog, CompanySheet, DataSourceDialog, ExportDialog, SaveSearchDialog } from "./dialogs";
import { FilterPanel, activeCount, compact, type Filters, type Location } from "./filters";
import { LEAD_FINDER_TABS, useLeadFinderCredits } from "./shared";
import { ScrollX } from "@/components/ui/scroll-x";

interface Person {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  location: string;
  linkedin_url: string | null;
  email: string | null;
  email_masked: string | null;
  email_status: string | null;
  has_email: boolean;
  phone: string | null;
  has_phone: boolean;
  revealed: boolean;
  owned: boolean;
  company: { id: string; name: string | null; domain: string | null; industry: string | null; employee_count: number | null; location: string } | null;
}

interface SearchResult {
  total: number;
  page: number;
  page_size: number;
  items: Person[];
}

interface SavedSearch {
  id: string;
  name: string;
  search_filters: Filters;
  timestamp_created: string;
  result_count?: number;
}

const QUICK_STARTS: Array<{ label: string; filters: Filters }> = [
  { label: "Founders and CEOs", filters: { title: { include: ["Founder", "CEO", "Chief Executive"], includeMode: "CONTAINS" }, level: ["C-Level", "Owner"] } },
  { label: "Sales leaders", filters: { department: ["Sales"], level: ["VP-Level", "Director-Level"] } },
  { label: "Marketing leaders", filters: { department: ["Marketing"], level: ["VP-Level", "Director-Level"] } },
  { label: "Engineering managers", filters: { department: ["Engineering"], level: ["Manager-Level", "Director-Level"] } },
  { label: "HR at mid-sized companies", filters: { department: ["Human Resources"], employeeCount: ["100 - 250", "250 - 1000"] } },
];

const EMAIL_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { verified: "ok", valid: "ok", risky: "warn", catch_all: "warn", invalid: "bad" };

/** Filters passed in the link (Copilot's lead list card); locations may arrive as plain names. */
function linkedFilters(raw: string): Filters | null {
  try {
    const f = JSON.parse(raw) as Omit<Filters, "locations"> & { locations?: { include?: Array<string | Location>; exclude?: Array<string | Location> } };
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    const loc = (xs?: Array<string | Location>) => xs?.map((x) => (typeof x === "string" ? { label: x } : x));
    const { locations, ...rest } = f;
    return locations ? { ...rest, locations: { include: loc(locations.include), exclude: loc(locations.exclude) } } : rest;
  } catch {
    return null;
  }
}

function initialFilters(params: URLSearchParams): Filters {
  const linked = params.get("filters");
  if (linked) {
    const f = linkedFilters(linked);
    if (f) return f;
  }
  const raw = params.get("lookAlike");
  if (raw) {
    try {
      const v = JSON.parse(raw) as { value?: string };
      if (v.value) return { look_alike: v.value };
    } catch {
      return { look_alike: raw };
    }
  }
  const company = params.get("company");
  if (company) return { company_name: { include: [company] } };
  return {};
}

function AiSearch({ onFilters }: { onFilters: (f: Filters, explanation: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (prompt.trim().length < 3) return;
    setBusy(true);
    try {
      const r = await post<{ filters: Filters; explanation: string }>("/api/app/lead-finder/ai-filters", { prompt });
      if (!activeCount(r.filters)) toast.warning("The AI couldn't turn that into filters. Try naming titles, locations or company sizes.");
      else onFilters(r.filters, r.explanation);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-line bg-panel p-3 shadow-card">
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="mt-2 shrink-0 text-brand-text" />
        <Textarea
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void run();
            }
          }}
          placeholder="Describe who you're looking for, e.g. “Heads of sales at US software companies with 50 to 250 employees”"
          className="min-h-0 resize-none border-0 bg-transparent px-1 focus:ring-0"
          aria-label="Describe who you're looking for"
        />
        <Button size="sm" variant="primary" loading={busy} disabled={prompt.trim().length < 3} onClick={run}>
          Search
        </Button>
      </div>
    </div>
  );
}

function SearchesMenu({ onLoad, currentSaved }: { onLoad: (s: SavedSearch, saved: boolean) => void; currentSaved: string | null }) {
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"saved" | "recent">("saved");
  const saved = useQuery({ queryKey: ["lead-finder", "saved"], queryFn: () => get<{ items: SavedSearch[] }>("/api/v2/supersearch-enrichment/saved-searches", { limit: 100 }), enabled: open });
  const recent = useQuery({ queryKey: ["lead-finder", "history"], queryFn: () => get<SavedSearch[]>("/api/app/lead-finder/history"), enabled: open && tab === "recent" });
  const items = tab === "saved" ? (saved.data?.items ?? []) : (recent.data ?? []);
  const loading = tab === "saved" ? saved.isLoading : recent.isLoading;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-80 p-0"
      trigger={
        <Button size="sm" icon={<Bookmark size={14} />}>
          Searches
        </Button>
      }
    >
      <div className="border-b border-line p-2">
        <Segmented
          size="sm"
          className="w-full"
          value={tab}
          onChange={setTab}
          options={[
            { value: "saved", label: "Saved" },
            { value: "recent", label: "Recent" },
          ]}
        />
      </div>
      <div className="scroll-thin max-h-80 overflow-y-auto p-1">
        {loading && <Skeleton className="m-2 h-10" />}
        {items.map((s) => (
          <div key={s.id} className={cn("group flex items-center rounded-lg hover:bg-panel-2", currentSaved === s.id && "bg-brand-soft/50")}>
            <button
              type="button"
              className="min-w-0 flex-1 px-2.5 py-2 text-left"
              onClick={() => {
                onLoad(s, tab === "saved");
                setOpen(false);
              }}
            >
              <span className="block truncate text-[13px] font-medium">{s.name}</span>
              <span className="text-xs text-muted">
                {tab === "recent" && s.result_count !== undefined ? `${plural(s.result_count, "result")} · ` : ""}
                {ago(s.timestamp_created)}
              </span>
            </button>
            {tab === "saved" && can.write && (
              <button
                type="button"
                aria-label={`Delete ${s.name}`}
                className="mr-1 rounded p-1.5 text-faint opacity-0 hover:text-bad group-hover:opacity-100"
                onClick={async () => {
                  if (!(await confirm({ title: "Delete this saved search?", confirmLabel: "Delete", danger: true }))) return;
                  try {
                    await del(`/api/v2/supersearch-enrichment/saved-searches/${s.id}`);
                    qc.invalidateQueries({ queryKey: ["lead-finder", "saved"] });
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
        {!loading && !items.length && <p className="px-3 py-6 text-center text-xs text-muted">{tab === "saved" ? "No saved searches yet." : "Searches you run appear here."}</p>}
      </div>
      {tab === "recent" && !!items.length && can.write && (
        <div className="border-t border-line p-1.5">
          <Button
            size="xs"
            variant="ghost"
            className="w-full"
            icon={<History size={12} />}
            onClick={async () => {
              await del("/api/app/lead-finder/history").catch((e) => toast.error(errorMessage(e)));
              qc.invalidateQueries({ queryKey: ["lead-finder", "history"] });
            }}
          >
            Clear recent searches
          </Button>
        </div>
      )}
    </Popover>
  );
}

export default function LeadFinder() {
  usePageTitle("Lead Finder");
  const qc = useQueryClient();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => initialFilters(params));
  const [applied, setApplied] = useState<Filters>(() => compact(initialFilters(params)));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "export" | "save" | "data" | null>(null);
  const [savedSearch, setSavedSearch] = useState<{ id: string; name: string } | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<Set<string>>(new Set());
  const [mobileFilters, setMobileFilters] = useState(false);

  // Searching follows the filters after a short pause, from page 1.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = compact(filters);
      setApplied((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    }, 450);
    return () => clearTimeout(t);
  }, [filters]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [applied]);

  const hasFilters = activeCount(applied) > 0;
  const key = ["lead-finder", "search", applied, page, pageSize];
  const search = useQuery({
    queryKey: key,
    queryFn: () => post<SearchResult>("/api/app/lead-finder/search", { filters: applied, page, page_size: pageSize }),
    enabled: hasFilters,
    placeholderData: keepPreviousData,
  });
  const credits = useLeadFinderCredits();
  const unlimited = !!credits.data?.unlimited;

  const rows = search.data?.items ?? [];
  const total = search.data?.total ?? 0;
  const wantsAdd = useRef(params.get("add") === "1");
  useEffect(() => {
    if (!wantsAdd.current || !search.data) return;
    wantsAdd.current = false;
    setParams(
      (p) => {
        p.delete("add");
        return p;
      },
      { replace: true },
    );
    if (search.data.total > 0 && can.write) setDialog("add");
  }, [search.data, setParams, can.write]);
  const pages = Math.max(1, Math.min(400, Math.ceil(total / pageSize)));
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const load = (f: Filters, saved: { id: string; name: string } | null = null) => {
    setFilters(f);
    setSavedSearch(saved);
  };
  const reset = () => {
    load({});
    setExplanation(null);
  };

  const reveal = async (ids: string[]) => {
    const todo = ids.filter((id) => !rows.find((r) => r.id === id)?.revealed);
    if (!todo.length) return;
    setRevealing(new Set(todo));
    try {
      const r = await post<{ revealed: Person[]; credits_used: number; out_of_credits: boolean }>("/api/app/lead-finder/reveal", { person_ids: todo });
      const byId = new Map(r.revealed.map((p) => [p.id, p]));
      qc.setQueryData<SearchResult>(key, (d) => (d ? { ...d, items: d.items.map((p) => byId.get(p.id) ?? p) } : d));
      if (r.out_of_credits) toast.warning("You're out of credits. Some people weren't revealed.");
      else if (r.credits_used) toast.success(`Revealed ${plural(r.revealed.length, "person", "people")} · ${plural(r.credits_used, "credit")}`);
      qc.invalidateQueries({ queryKey: ["lead-finder", "credits"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRevealing(new Set());
    }
  };

  const filterCount = activeCount(filters);
  const panel = (
    <>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <SlidersHorizontal size={15} /> Filters
          {filterCount > 0 && <span className="rounded-full bg-brand-soft px-1.5 text-[11px] text-brand-text">{filterCount}</span>}
        </p>
        {filterCount > 0 && (
          <Button size="xs" variant="ghost" icon={<RotateCcw size={12} />} onClick={reset}>
            Clear all
          </Button>
        )}
      </div>
      <FilterPanel value={filters} onChange={(f) => setFilters(f)} />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line bg-panel px-4 pt-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Lead Finder</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-panel-2 px-2.5 py-0.5 text-xs text-muted">
            <Coins size={12} /> {credits.data ? (credits.data.unlimited ? "Unlimited credits" : plural(credits.data.credits ?? 0, "credit")) : "…"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" icon={<Database size={14} />} onClick={() => setDialog("data")}>
              Data source
            </Button>
            <SearchesMenu
              currentSaved={savedSearch?.id ?? null}
              onLoad={(s, isSaved) => {
                load(s.search_filters ?? {}, isSaved ? { id: s.id, name: s.name } : null);
                setExplanation(null);
              }}
            />
          </div>
        </div>
        <LinkTabs tabs={LEAD_FINDER_TABS} className="mt-2 border-b-0" />
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="scroll-thin hidden w-80 shrink-0 overflow-y-auto border-r border-line bg-panel lg:block">{panel}</aside>
        <Sheet open={mobileFilters} onOpenChange={setMobileFilters} title="Filters" width="max-w-sm">
          {panel}
        </Sheet>

        <section className="scroll-thin min-w-0 flex-1 overflow-y-auto">
          <div className="space-y-4 p-4 sm:p-6">
            <div className="flex items-center gap-2 lg:hidden">
              <Button size="sm" icon={<SlidersHorizontal size={14} />} onClick={() => setMobileFilters(true)}>
                Filters{filterCount ? ` (${filterCount})` : ""}
              </Button>
            </div>
            {can.write && (
              <AiSearch
                onFilters={(f, why) => {
                  load(f);
                  setExplanation(why);
                }}
              />
            )}
            {explanation && hasFilters && (
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Sparkles size={13} className="text-brand-text" /> {explanation} Adjust the filters on the left to refine.
                <button type="button" aria-label="Dismiss" onClick={() => setExplanation(null)} className="text-faint hover:text-text">
                  <X size={13} />
                </button>
              </p>
            )}

            {!hasFilters ? (
              <div className="rounded-xl border border-dashed border-line-strong bg-panel px-6 py-10 text-center">
                <UserSearch size={26} className="mx-auto text-faint" />
                <h2 className="mt-3 text-base font-semibold">Find the right people</h2>
                <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">Pick filters, describe your audience above, or start from one of these.</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {QUICK_STARTS.map((q) => (
                    <button key={q.label} type="button" onClick={() => load(q.filters)} className="rounded-full border border-line px-3 py-1 text-[13px] hover:border-brand hover:text-brand-text">
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-line bg-panel shadow-card">
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
                  <Checkbox
                    checked={allOnPage ? true : selected.size ? "indeterminate" : false}
                    onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())}
                    aria-label="Select this page"
                  />
                  <p className="text-[13px]">
                    {search.isLoading ? (
                      "Searching…"
                    ) : (
                      <>
                        <span className="font-semibold">{num(total)}</span> {total === 1 ? "result" : "results"}
                        {selected.size > 0 && <span className="text-muted"> · {selected.size} selected</span>}
                      </>
                    )}
                  </p>
                  {search.isFetching && !search.isLoading && <span className="text-xs text-faint">Updating…</span>}
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {selected.size > 0 && can.write && !unlimited && (
                      <Button size="sm" icon={<Eye size={14} />} loading={revealing.size > 0} onClick={() => reveal([...selected])}>
                        Reveal emails
                      </Button>
                    )}
                    {can.write && (
                      <Button size="sm" icon={<BookmarkPlus size={14} />} onClick={() => setDialog("save")}>
                        {savedSearch ? "Update search" : "Save search"}
                      </Button>
                    )}
                    {can.write && (
                      <Button size="sm" icon={<Download size={14} />} onClick={() => setDialog("export")} disabled={!total}>
                        Export
                      </Button>
                    )}
                    {can.write && (
                      <Button size="sm" variant="primary" icon={<ListPlus size={14} />} onClick={() => setDialog("add")} disabled={!total}>
                        Add to list or campaign
                      </Button>
                    )}
                  </div>
                </div>

                <ScrollX>
                  <table className="w-full min-w-[860px] text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-left text-xs text-muted">
                        <th className="w-10 px-4 py-2" />
                        <th className="px-2 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Company</th>
                        <th className="px-3 py-2 font-medium">Location</th>
                        <th className="px-3 py-2 font-medium">Employees</th>
                        <th className="px-3 py-2 font-medium">Email</th>
                      </tr>
                    </thead>
                    <tbody>
                      {search.isLoading
                        ? Array.from({ length: 8 }, (_, i) => (
                            <tr key={i} className="border-b border-line">
                              <td colSpan={6} className="px-4 py-3">
                                <Skeleton className="h-6" />
                              </td>
                            </tr>
                          ))
                        : rows.map((p) => (
                            <tr key={p.id} className={cn("border-b border-line last:border-0 hover:bg-panel-2/60", selected.has(p.id) && "bg-brand-soft/40")}>
                              <td className="px-4 py-2.5">
                                <Checkbox
                                  checked={selected.has(p.id)}
                                  onChange={(v) =>
                                    setSelected((s) => {
                                      const n = new Set(s);
                                      if (v) n.add(p.id);
                                      else n.delete(p.id);
                                      return n;
                                    })
                                  }
                                  aria-label={`Select ${p.full_name}`}
                                />
                              </td>
                              <td className="max-w-[16rem] px-2 py-2.5">
                                <div className="flex items-center gap-2.5">
                                  <Avatar name={p.full_name} size={30} />
                                  <div className="min-w-0">
                                    <p className="flex items-center gap-1.5 truncate font-medium">
                                      {p.full_name}
                                      {p.linkedin_url && (
                                        <a href={p.linkedin_url} target="_blank" rel="noreferrer noopener" aria-label="LinkedIn profile" className="text-faint hover:text-brand-text">
                                          <Linkedin size={12} />
                                        </a>
                                      )}
                                      {p.owned && <Badge className="ml-0.5">In your leads</Badge>}
                                    </p>
                                    <p className="truncate text-xs text-muted">{p.title ?? "—"}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="max-w-[14rem] px-3 py-2.5">
                                {p.company ? (
                                  <button type="button" onClick={() => setCompanyId(p.company!.id)} className="block min-w-0 max-w-full text-left">
                                    <span className="block truncate font-medium hover:text-brand-text">{p.company.name}</span>
                                    <span className="block truncate text-xs text-muted">{[p.company.domain, p.company.industry].filter(Boolean).join(" · ")}</span>
                                  </button>
                                ) : (
                                  <span className="text-faint">—</span>
                                )}
                              </td>
                              <td className="max-w-[12rem] px-3 py-2.5">
                                <span className="line-clamp-2 text-muted">{p.location || "—"}</span>
                              </td>
                              <td className="px-3 py-2.5 tabular-nums text-muted">{p.company?.employee_count ? num(p.company.employee_count) : "—"}</td>
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-2">
                                  {p.revealed ? (
                                    <span className="truncate font-medium">{p.email ?? <span className="text-faint">No email</span>}</span>
                                  ) : p.has_email ? (
                                    <>
                                      <span className="truncate font-mono text-xs text-muted">{p.email_masked}</span>
                                      {can.write && (
                                        <Button size="xs" variant="soft" loading={revealing.has(p.id)} onClick={() => reveal([p.id])}>
                                          Reveal
                                        </Button>
                                      )}
                                    </>
                                  ) : (
                                    <span className="text-faint">No email</span>
                                  )}
                                  {p.email_status && <Badge tone={EMAIL_TONE[p.email_status] ?? "neutral"}>{p.email_status.replace("_", "-")}</Badge>}
                                  {p.has_phone && (
                                    <Tooltip content={p.phone ?? "Phone available"}>
                                      <Phone size={12} className="shrink-0 text-faint" />
                                    </Tooltip>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                      {!search.isLoading && !rows.length && (
                        <tr>
                          <td colSpan={6} className="px-4 py-10">
                            <EmptyState icon={<Search size={22} />} title="No people match" description="Loosen a filter or two. Exact title matching and narrow locations remove the most results." />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </ScrollX>

                {total > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[13px]">
                    <div className="flex items-center gap-2 text-muted">
                      Rows per page
                      <NativeSelect
                        size="sm"
                        className="w-20"
                        value={String(pageSize)}
                        onChange={(v) => {
                          setPageSize(Number(v));
                          setPage(1);
                        }}
                        options={["25", "50", "100"].map((v) => ({ value: v, label: v }))}
                        aria-label="Rows per page"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted">
                        Page {page} of {num(pages)}
                      </span>
                      <Button size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                        <ChevronLeft size={14} />
                      </Button>
                      <Button size="icon-sm" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                        <ChevronRight size={14} />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {hasFilters && credits.data && !unlimited && (
              <p className="flex items-center gap-1.5 text-xs text-faint">
                <Clock size={12} /> Revealing an email or adding a person uses credits once; people you've revealed stay revealed.
              </p>
            )}
          </div>
        </section>
      </div>

      <AddLeadsDialog open={dialog === "add"} onOpenChange={(v) => setDialog(v ? "add" : null)} filters={applied} total={total} />
      <ExportDialog open={dialog === "export"} onOpenChange={(v) => setDialog(v ? "export" : null)} filters={applied} total={total} personIds={selected.size ? [...selected] : undefined} />
      <SaveSearchDialog open={dialog === "save"} onOpenChange={(v) => setDialog(v ? "save" : null)} filters={filters} existing={savedSearch} />
      <DataSourceDialog open={dialog === "data"} onOpenChange={(v) => setDialog(v ? "data" : null)} />
      <CompanySheet
        companyId={companyId}
        onClose={() => setCompanyId(null)}
        onFindPeople={(name, domain) => {
          setCompanyId(null);
          load(domain ? { domains: [domain] } : { company_name: { include: [name] } });
        }}
        onLookalike={(domain) => {
          setCompanyId(null);
          load({ look_alike: domain });
        }}
      />
    </div>
  );
}


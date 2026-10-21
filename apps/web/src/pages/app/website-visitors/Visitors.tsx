// Website visitors: companies identified from your site's traffic, tracking filters ("views") that alert and
// add the best contact to a campaign or list, and the company detail panel.
import { useMemo, useState } from "react";
import { Link, Outlet, useNavigate, useSearchParams } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Download, ExternalLink, Eye, EyeOff, History, Linkedin, ListPlus, Pause, Pencil, Play, Plus, Search, Send, Star, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { daysBefore, todayIn } from "@/lib/dates";
import { ago, dateTime, downloadBlob, num, plural } from "@/lib/format";
import { useDebounced, usePageTitle } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { TrendChart } from "@/components/charts";
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  EmptyState,
  emptySelection,
  LinkTabs,
  MenuItem,
  MenuSeparator,
  Page,
  PageHeader,
  RowMenu,
  SearchInput,
  Select,
  SelectionBar,
  Sheet,
  SkeletonRows,
  StatCard,
  Tooltip,
  useConfirm,
  type Column,
  type Selection,
} from "@/components/ui";
import { contactName, duration, invalidateVisitors, leadFinderLink, useViews, VW_KEY, type CompanyDetail, type CompanyRow, type Contact, type Overview, type VisitorView } from "./api";
import { AddLeadsDialog, AlertsSheet, ViewDialog, type AddRequest } from "./dialogs";

export function VisitorsLayout() {
  return (
    <Page wide>
      <PageHeader title="Website visitors" description="Companies browsing your website, identified from their network, with the best person to contact at each." />
      <LinkTabs
        className="mb-5"
        tabs={[
          { to: "/app/website-visitors", label: "Visitors" },
          { to: "/app/website-visitors/setup", label: "Setup" },
          { to: "/app/website-visitors/billing", label: "Credits & plan" },
        ]}
      />
      <Outlet />
    </Page>
  );
}

const RANGES = [
  { value: "1", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];
const SORTS = [
  { value: "last_seen", label: "Most recent" },
  { value: "visits", label: "Most visits" },
  { value: "pageviews", label: "Most pages viewed" },
  { value: "duration", label: "Most time on site" },
];

interface CompaniesPage {
  total: number;
  page: number;
  page_size: number;
  items: CompanyRow[];
}

/** Every day of the range up to `today`, so quiet days show as zero. */
function fillDays(rows: Overview["daily"], days: number, today: string) {
  const byDay = new Map(rows.map((r) => [r.date, r]));
  const out: Overview["daily"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysBefore(today, i);
    out.push(byDay.get(d) ?? { date: d, visits: 0, companies: 0 });
  }
  return out;
}

function CompanyLogo({ name, src }: { name: string; src: string | null }) {
  return <Avatar name={name} src={src} size={30} className="rounded-lg" />;
}

function ContactCell({ c, company }: { c: Contact | null; company: string }) {
  if (!c) return <span className="text-muted">Someone at {company}</span>;
  return (
    <Tooltip content={`${company} visited your site. This person didn't visit themselves: they're the most senior match at ${company} in your lead data.`}>
      <span className="block min-w-0">
        <span className="block truncate font-medium">{contactName(c)}</span>
        <span className="block truncate text-xs text-muted">{c.title ?? c.seniority ?? "Best contact"}</span>
      </span>
    </Tooltip>
  );
}

export function VisitorsPage() {
  usePageTitle("Website visitors");
  const can = useCan();
  const zone = useWorkspaceZone();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const viewId = params.get("view") ?? "";
  const siteId = params.get("site") ?? "";
  const days = Number(params.get("days")) || 30;
  const openDomain = params.get("company");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [fit, setFit] = useState(false);
  const [sort, setSort] = useState("last_seen");
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [editing, setEditing] = useState<VisitorView | "new" | null>(null);
  const [alertsFor, setAlertsFor] = useState<VisitorView | null>(null);
  const [adding, setAdding] = useState<AddRequest | null>(null);
  const [identifying, setIdentifying] = useState(false);

  const overview = useQuery({
    queryKey: [...VW_KEY, "overview", siteId, days],
    queryFn: () => get<Overview>("/api/app/website-visitors/overview", { site_id: siteId || undefined, days }),
    refetchInterval: 60_000,
  });
  const views = useViews();
  const view = views.data?.find((v) => v.id === viewId) ?? null;
  const listQuery = { site_id: siteId || undefined, view_id: viewId || undefined, days, search: q || undefined, fit: fit || undefined, sort };
  const companies = useInfiniteQuery({
    queryKey: [...VW_KEY, "companies", listQuery],
    queryFn: ({ pageParam }) => get<CompaniesPage>("/api/app/website-visitors/companies", { ...listQuery, page: pageParam, page_size: 25 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.page_size < last.total ? last.page + 1 : undefined),
    refetchInterval: 60_000,
  });
  const rows = useMemo(() => companies.data?.pages.flatMap((p) => p.items) ?? [], [companies.data]);
  const total = companies.data?.pages[0]?.total ?? 0;
  const o = overview.data;
  const sites = o?.sites ?? [];
  const selfHosted = o?.usage.self_hosted ?? true;
  const selectedDomains = [...selection.ids];

  const clearSelection = () => setSelection(emptySelection());
  const addFor = (target: "campaign" | "list") =>
    setAdding(
      selection.all
        ? { label: plural(total, "company", "companies"), all: listQuery, target }
        : { label: plural(selectedDomains.length, "company", "companies"), domains: selectedDomains, target },
    );

  const hide = async (domains: string[], hidden = true) => {
    try {
      await post("/api/app/website-visitors/companies/hide", { domains, hidden });
      await invalidateVisitors(qc);
      clearSelection();
      toast.success(hidden ? `Hidden ${plural(domains.length, "company", "companies")}` : "Shown again");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const identify = async () => {
    setIdentifying(true);
    try {
      const r = await post<{ identified: number; unresolved: number; waiting: number }>("/api/app/website-visitors/identify", { limit: 200 });
      toast.success(`Identified ${plural(r.identified, "visit")}${r.unresolved ? `, ${num(r.unresolved)} without a company` : ""}${r.waiting ? `, ${num(r.waiting)} still waiting` : ""}`);
      await invalidateVisitors(qc);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setIdentifying(false);
    }
  };

  const exportCsv = async () => {
    const t = toast.loading("Downloading CSV…");
    try {
      const csv = await get<string>("/api/app/website-visitors/export", listQuery);
      downloadBlob(`website-visitors-${todayIn(zone)}.csv`, typeof csv === "string" ? csv : "");
      toast.success("CSV downloaded", { id: t });
    } catch (e) {
      toast.error(errorMessage(e), { id: t });
    }
  };

  const toggleView = async (v: VisitorView) => {
    try {
      await patch(`/api/app/website-visitors/views/${v.id}`, { enabled: !v.enabled });
      await invalidateVisitors(qc);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const deleteView = async (v: VisitorView) => {
    if (!(await confirm({ title: `Delete "${v.name}"?`, description: "Its alerts stop and its delivery history is deleted. Leads it already added stay where they are.", confirmLabel: "Delete view", danger: true }))) return;
    try {
      await del(`/api/app/website-visitors/views/${v.id}`);
      if (viewId === v.id) setParam("view", null);
      await invalidateVisitors(qc);
      toast.success("View deleted");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<CompanyRow>[] = [
    {
      key: "company",
      header: "Company",
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <CompanyLogo name={r.name} src={r.logo_url} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-medium">
              <span className="truncate">{r.name}</span>
              {r.fits_icp && (
                <Tooltip content="Fits the ideal customer profile set on the Setup page">
                  <Star size={13} className="shrink-0 fill-warn text-warn" aria-label="Fits your ideal customer profile" />
                </Tooltip>
              )}
            </p>
            <p className="truncate text-xs text-muted">
              {r.domain}
              {r.industry ? ` · ${r.industry}` : ""}
            </p>
          </div>
        </div>
      ),
      className: "max-w-[18rem]",
    },
    {
      key: "size",
      header: "Employees",
      hideBelow: "lg",
      cell: (r) => <span className="tabular-nums text-muted">{r.employee_count ? num(r.employee_count) : "–"}</span>,
    },
    {
      key: "activity",
      header: "Activity",
      cell: (r) => (
        <div>
          <p className="tabular-nums">
            {plural(r.visits, "visit")} · {plural(r.pageviews, "page")}
          </p>
          <p className="text-xs text-muted">{duration(r.duration_sec)} on site</p>
        </div>
      ),
    },
    {
      key: "pages",
      header: "Top pages",
      hideBelow: "xl",
      cell: (r) => (
        <div className="max-w-[14rem] truncate text-xs text-muted" title={r.top_pages.map((p) => p.path).join(", ")}>
          {r.top_pages
            .slice(0, 3)
            .map((p) => p.path)
            .join(", ") || "–"}
        </div>
      ),
    },
    { key: "source", header: "Source", hideBelow: "xl", cell: (r) => <span className="text-muted">{r.source ?? "Direct"}</span> },
    { key: "contact", header: "Best contact", hideBelow: "md", cell: (r) => <ContactCell c={r.best_contact} company={r.name} />, className: "max-w-[14rem]" },
    {
      key: "last",
      header: "Last seen",
      cell: (r) => (
        <span className="whitespace-nowrap text-muted" title={dateTime(r.last_seen_at)}>
          {ago(r.last_seen_at)}
        </span>
      ),
    },
    {
      key: "menu",
      header: "",
      className: "w-10 text-right",
      cell: (r) => (
        <RowMenu>
          <MenuItem icon={<Building2 size={14} />} onSelect={() => setParam("company", r.domain)}>
            View details
          </MenuItem>
          {can.write && (
            <>
              <MenuItem icon={<Send size={14} />} onSelect={() => setAdding({ label: r.name, domains: [r.domain], target: "campaign" })}>
                Add best contact to campaign
              </MenuItem>
              <MenuItem icon={<ListPlus size={14} />} onSelect={() => setAdding({ label: r.name, domains: [r.domain], target: "list" })}>
                Add best contact to list
              </MenuItem>
            </>
          )}
          <MenuItem icon={<Search size={14} />} onSelect={() => navigate(leadFinderLink(r.domain))}>
            Find people in Lead Finder
          </MenuItem>
          {can.write && (
            <>
              <MenuSeparator />
              <MenuItem icon={<EyeOff size={14} />} onSelect={() => void hide([r.domain])}>
                Hide company
              </MenuItem>
            </>
          )}
        </RowMenu>
      ),
    },
  ];

  if (overview.isLoading) return <SkeletonRows rows={8} />;
  if (overview.isError) return <Callout tone="bad">{errorMessage(overview.error)}</Callout>;

  if (!sites.length) {
    return (
      <Card>
        <EmptyState
          icon={<Building2 size={22} />}
          title="Your website visitors will show up here"
          description="Add your domain and paste one snippet into your site. Each visit is matched to the company behind it, with the best person to contact there from your lead data."
          action={<ButtonLink to="/app/website-visitors/setup" variant="primary">Complete setup</ButtonLink>}
        />
      </Card>
    );
  }

  const t = o!.totals;
  const unverified = sites.filter((s) => s.test_status !== "successful");
  const conflicts = sites.filter((s) => s.conflict);
  const viewOptions = [{ value: "", label: "All visitors" }, ...(views.data ?? []).map((v) => ({ value: v.id, label: v.name }))];

  return (
    <div className="grid gap-5 lg:grid-cols-[15rem_1fr]">
      <aside className="hidden lg:block">
        <div className="sticky top-4 space-y-1">
          <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-faint">Views</p>
          <button
            type="button"
            onClick={() => setParam("view", null)}
            className={cn("flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13px] font-medium", !viewId ? "bg-brand-soft text-brand-text" : "hover:bg-panel-2")}
          >
            All visitors
          </button>
          {(views.data ?? []).map((v) => (
            <div key={v.id} className={cn("group flex items-center rounded-lg", viewId === v.id ? "bg-brand-soft text-brand-text" : "hover:bg-panel-2")}>
              <button type="button" onClick={() => setParam("view", v.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-[13px]">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", v.enabled ? "bg-ok" : "bg-faint")} aria-label={v.enabled ? "Active" : "Paused"} />
                <span className="truncate font-medium">{v.name}</span>
                <span className="ml-auto text-xs tabular-nums text-muted" title={`${plural(v.matches, "match", "matches")} delivered`}>
                  {num(v.matches)}
                </span>
              </button>
              <RowMenu label={`${v.name} actions`}>
                {can.write && (
                  <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(v)}>
                    Edit view
                  </MenuItem>
                )}
                <MenuItem icon={<History size={14} />} onSelect={() => setAlertsFor(v)}>
                  Delivery history
                </MenuItem>
                {can.write && (
                  <>
                    <MenuItem icon={v.enabled ? <Pause size={14} /> : <Play size={14} />} onSelect={() => void toggleView(v)}>
                      {v.enabled ? "Pause" : "Resume"}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => void deleteView(v)}>
                      Delete view
                    </MenuItem>
                  </>
                )}
              </RowMenu>
            </div>
          ))}
          {can.write && (
            <Button size="sm" variant="ghost" className="mt-1 w-full justify-start" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
              New view
            </Button>
          )}
          {!views.data?.length && <p className="px-2.5 pt-1 text-xs text-muted">Views send matching visitors to Slack, a webhook, or a campaign or list.</p>}
        </div>
      </aside>

      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex w-full gap-2 lg:hidden">
            <Select className="flex-1" size="sm" aria-label="View" value={viewId} onChange={(v) => setParam("view", v || null)} options={viewOptions} />
            {can.write && (
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
                New view
              </Button>
            )}
            {view && (
              <RowMenu label={`${view.name} actions`}>
                {can.write && (
                  <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(view)}>
                    Edit view
                  </MenuItem>
                )}
                <MenuItem icon={<History size={14} />} onSelect={() => setAlertsFor(view)}>
                  Delivery history
                </MenuItem>
              </RowMenu>
            )}
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search companies" className="w-full sm:w-56" />
          {sites.length > 1 && (
            <Select size="sm" className="w-44" aria-label="Domain" value={siteId} onChange={(v) => setParam("site", v || null)} options={[{ value: "", label: "All domains" }, ...sites.map((s) => ({ value: s.id, label: s.domain }))]} />
          )}
          <Select size="sm" className="w-36" aria-label="Date range" value={String(days)} onChange={(v) => setParam("days", v === "30" ? null : v)} options={RANGES} />
          <Select size="sm" className="w-44" aria-label="Sort" value={sort} onChange={setSort} options={SORTS} />
          <Checkbox checked={fit} onChange={setFit} label="Fits my profile" className="text-[13px]" />
          <Button size="sm" className="ml-auto" icon={<Download size={14} />} onClick={() => void exportCsv()}>
            Download CSV
          </Button>
        </div>

        {view && (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <Badge tone={view.enabled ? "ok" : "neutral"} dot>
              {view.enabled ? "Active" : "Paused"}
            </Badge>
            <span>
              {[
                view.destinations.slack_connection_id && "Slack",
                view.destinations.webhook_url && "webhook",
                view.destinations.campaign_id && "adds to a campaign",
                view.destinations.list_id && "adds to a list",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {view.last_match_at && <span>· last match {ago(view.last_match_at)}</span>}
          </div>
        )}

        {!o!.lookup && (
          <Callout tone="warn" title="Companies can't be identified yet" action={<ButtonLink size="sm" to="/app/website-visitors/setup">Set up lookup</ButtonLink>}>
            Visits are recorded, but matching them to companies needs an IP lookup token. Waiting visits are identified as soon as one is added.
          </Callout>
        )}
        {o!.lookup && o!.waiting.pending > 0 && (
          <Callout
            tone="info"
            title={`${plural(o!.waiting.pending, "visit")} waiting to be identified`}
            action={
              can.write && (
                <Button size="sm" loading={identifying} onClick={() => void identify()}>
                  Identify now
                </Button>
              )
            }
          >
            They're retried automatically every minute.
          </Callout>
        )}
        {o!.waiting.limited > 0 && (
          <Callout tone="warn" title={`You have ${plural(o!.waiting.limited, "unresolved website visitor")}`} action={<ButtonLink size="sm" to="/app/website-visitors/billing">Unlock visitors</ButtonLink>}>
            They arrived after this month's identification limit was reached.
          </Callout>
        )}
        {conflicts.map((s) => (
          <Callout key={s.id} tone="warn" title={`Snippet conflict on ${s.domain}`}>
            Another visitor snippet with a different key is on the same pages. Remove one: only the first snippet on a page reports visits.
          </Callout>
        ))}
        {unverified.length > 0 && t.visits === 0 && (
          <Callout tone="info" title={`Waiting for the first visit to ${unverified.map((s) => s.domain).join(", ")}`} action={<ButtonLink size="sm" to="/app/website-visitors/setup">Test installation</ButtonLink>}>
            Visits appear here within a minute of someone opening a page with the snippet.
          </Callout>
        )}

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard label="Companies identified" value={num(t.companies)} sub={t.fits ? `${num(t.fits)} fit your profile` : undefined} />
          <StatCard label="Visits" value={num(t.visits)} sub={t.unresolved ? `${num(t.unresolved)} without a company` : undefined} />
          <StatCard label="Pages viewed" value={num(t.pageviews)} sub={t.visits ? `${(t.pageviews / t.visits).toFixed(1)} per visit` : undefined} />
          <StatCard label="Time on site" value={duration(t.duration_sec)} sub={t.visits ? `${duration(t.duration_sec / t.visits)} per visit` : undefined} />
        </div>

        {t.visits > 0 && (
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Traffic" description={`Visits and identified companies, ${RANGES.find((r) => r.value === String(days))?.label.toLowerCase() ?? `last ${days} days`}`} />
              <TrendChart
                data={fillDays(o!.daily, Math.min(days, 90), todayIn(zone))}
                height={200}
                series={[
                  { key: "visits", label: "Visits" },
                  { key: "companies", label: "Companies" },
                ]}
              />
            </Card>
            <Card>
              <CardHeader title="Top pages" />
              <ul className="space-y-1.5 text-[13px]">
                {o!.top_pages.slice(0, 5).map((p) => (
                  <li key={p.path} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={p.path}>
                      {p.path}
                    </span>
                    <span className="tabular-nums text-muted">{num(p.views)}</span>
                  </li>
                ))}
              </ul>
              <p className="mb-2 mt-4 text-[13px] font-semibold">Top sources</p>
              <ul className="space-y-1.5 text-[13px]">
                {o!.top_sources.slice(0, 5).map((s) => (
                  <li key={s.name} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="tabular-nums text-muted">{num(s.visits)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        )}

        <div>
          <SelectionBar count={selection.ids.size} total={total} allSelected={selection.all} onSelectAll={() => setSelection({ ids: new Set(), all: true })} onClear={clearSelection}>
            {can.write && (
              <>
                <Button size="sm" icon={<Send size={14} />} onClick={() => addFor("campaign")}>
                  Add to campaign
                </Button>
                <Button size="sm" icon={<ListPlus size={14} />} onClick={() => addFor("list")}>
                  Add to list
                </Button>
                {!selection.all && (
                  <Button size="sm" variant="ghost" icon={<EyeOff size={14} />} onClick={() => void hide(selectedDomains)}>
                    Hide
                  </Button>
                )}
              </>
            )}
          </SelectionBar>
          <p className="mb-2 text-[13px] text-muted">{companies.isLoading ? "Loading…" : plural(total, "company", "companies")}</p>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.domain}
            loading={companies.isLoading}
            error={companies.error}
            onRetry={() => companies.refetch()}
            onRowClick={(r) => setParam("company", r.domain)}
            selection={can.write ? selection : undefined}
            onSelectionChange={can.write ? setSelection : undefined}
            hasMore={companies.hasNextPage}
            onLoadMore={() => void companies.fetchNextPage()}
            loadingMore={companies.isFetchingNextPage}
            empty={
              <EmptyState
                icon={<Building2 size={20} />}
                title={q || fit || view ? "No companies match" : "No companies identified yet"}
                description={
                  q || fit || view
                    ? "Try another search, view or date range."
                    : o!.lookup
                      ? "Visits from businesses show up here. Home, mobile and cloud networks can't be matched to a company."
                      : "Add an IP lookup token on the Setup page to start identifying companies."
                }
              />
            }
          />
        </div>
      </div>

      <CompanySheet domain={openDomain} siteId={siteId} onClose={() => setParam("company", null)} onAdd={setAdding} onHide={hide} />
      <ViewDialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)} view={editing === "new" ? null : editing} sites={sites} />
      <AlertsSheet view={alertsFor} onClose={() => setAlertsFor(null)} />
      <AddLeadsDialog request={adding} onClose={() => setAdding(null)} selfHosted={selfHosted} />
    </div>
  );
}

function CompanySheet({
  domain,
  siteId,
  onClose,
  onAdd,
  onHide,
}: {
  domain: string | null;
  siteId: string;
  onClose: () => void;
  onAdd: (r: AddRequest) => void;
  onHide: (domains: string[], hidden?: boolean) => Promise<void>;
}) {
  const can = useCan();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [revealing, setRevealing] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...VW_KEY, "company", domain, siteId],
    queryFn: () => get<CompanyDetail>(`/api/app/website-visitors/companies/${encodeURIComponent(domain!)}`, { site_id: siteId || undefined }),
    enabled: !!domain,
  });
  const d = q.data;
  const reveal = async (id: string) => {
    setRevealing(id);
    try {
      const r = await post<{ contacts: Contact[]; credits_used: number; out_of_credits: boolean }>("/api/app/website-visitors/reveal", { person_ids: [id] });
      if (r.out_of_credits && !r.contacts.length) toast.error("You're out of credits. Top up to reveal more contacts.");
      await qc.invalidateQueries({ queryKey: [...VW_KEY, "company", domain] });
      qc.invalidateQueries({ queryKey: [...VW_KEY, "companies"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRevealing(null);
    }
  };
  const close = () => {
    setPicked(new Set());
    onClose();
  };
  const c = d?.company;
  const pickedPeople = d?.contacts.filter((p) => picked.has(p.id)) ?? [];
  const facts: Array<[string, string | null]> = c
    ? [
        ["Industry", c.industry],
        ["Employees", c.employee_count ? num(c.employee_count) : null],
        ["Revenue", c.revenue_range],
        ["Headquarters", [c.city, c.country].filter(Boolean).join(", ") || null],
      ]
    : [];
  return (
    <Sheet
      open={!!domain}
      onOpenChange={(v) => !v && close()}
      width="max-w-2xl"
      title={c?.name ?? domain ?? ""}
      description={c ? c.domain : undefined}
      actions={
        c &&
        can.write && (
          <Button size="sm" variant="ghost" icon={d!.hidden ? <Eye size={14} /> : <EyeOff size={14} />} onClick={() => void onHide([c.domain], !d!.hidden).then(() => q.refetch())}>
            {d!.hidden ? "Show" : "Hide"}
          </Button>
        )
      }
      footer={
        pickedPeople.length > 0 && can.write ? (
          <>
            <span className="mr-auto text-[13px] text-muted">{plural(pickedPeople.length, "person", "people")} selected</span>
            <Button size="sm" icon={<ListPlus size={14} />} onClick={() => onAdd({ label: plural(pickedPeople.length, "person", "people"), person_ids: pickedPeople.map((p) => p.id), target: "list" })}>
              Add to list
            </Button>
            <Button size="sm" variant="primary" icon={<Send size={14} />} onClick={() => onAdd({ label: plural(pickedPeople.length, "person", "people"), person_ids: pickedPeople.map((p) => p.id), target: "campaign" })}>
              Add to campaign
            </Button>
          </>
        ) : undefined
      }
    >
      {q.isLoading || !d || !c ? (
        q.isError ? <Callout tone="bad" className="m-5">{errorMessage(q.error)}</Callout> : <SkeletonRows rows={6} />
      ) : (
        <div className="space-y-6 px-5 py-4">
          <div className="flex items-start gap-3">
            <Avatar name={c.name} src={c.logo_url} size={44} className="rounded-xl" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {d.fits_icp && (
                  <Badge tone="warn">
                    <Star size={12} className="fill-current" /> Fits your profile
                  </Badge>
                )}
                {d.hidden && <Badge>Hidden</Badge>}
                {d.leads_in_workspace > 0 && <Badge tone="brand">{plural(d.leads_in_workspace, "lead")} in this workspace</Badge>}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-3 text-[13px]">
                <a href={`https://${c.domain}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                  <ExternalLink size={13} /> {c.domain}
                </a>
                {c.linkedin_url && (
                  <a href={c.linkedin_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                    <Linkedin size={13} /> LinkedIn
                  </a>
                )}
                <Link to={leadFinderLink(c.domain)} className="inline-flex items-center gap-1 text-brand-text hover:underline">
                  <Search size={13} /> Find people in Lead Finder
                </Link>
              </div>
              {c.source === "network_name" && (
                <p className="mt-1.5 text-xs text-muted">Matched because the visit came from a network registered to {c.network ?? "this company"}.</p>
              )}
            </div>
          </div>

          {c.company_id ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
              {facts.map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="truncate">{v ?? "–"}</dd>
                </div>
              ))}
              {c.description && <p className="col-span-full text-[13px] text-muted">{c.description}</p>}
            </dl>
          ) : (
            <Callout tone="info">This company isn't in your lead data, so there's no profile or contacts to suggest.</Callout>
          )}

          {d.contacts.length > 0 && (
            <section>
              <h3 className="mb-1 text-[13px] font-semibold">People to contact</h3>
              <p className="mb-2 text-xs text-muted">From your lead data, most senior first. These people didn't necessarily visit: identification is company-level.</p>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {d.contacts.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                    {can.write && (
                      <Checkbox
                        aria-label={`Select ${contactName(p)}`}
                        checked={picked.has(p.id)}
                        onChange={(v) => {
                          const next = new Set(picked);
                          if (v) next.add(p.id);
                          else next.delete(p.id);
                          setPicked(next);
                        }}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                        {contactName(p)}
                        {p.linkedin_url && (
                          <a href={p.linkedin_url} target="_blank" rel="noreferrer noopener" aria-label="LinkedIn profile" className="text-faint hover:text-text">
                            <Linkedin size={12} />
                          </a>
                        )}
                        {p.in_workspace && <Badge tone="brand">Lead</Badge>}
                      </p>
                      <p className="truncate text-xs text-muted">{[p.title, p.seniority, p.location].filter(Boolean).join(" · ")}</p>
                    </div>
                    {p.revealed ? (
                      <span className="max-w-[45%] truncate text-xs text-muted" title={p.email ?? undefined}>
                        {p.email ?? "No email"}
                      </span>
                    ) : p.has_email && can.write ? (
                      <Button size="xs" variant="soft" loading={revealing === p.id} onClick={() => void reveal(p.id)}>
                        Reveal email
                      </Button>
                    ) : (
                      <span className="text-xs text-faint">{p.has_email ? "Email hidden" : "No email"}</span>
                    )}
                    {can.write && (
                      <RowMenu label={`Actions for ${contactName(p)}`}>
                        <MenuItem icon={<Send size={14} />} onSelect={() => onAdd({ label: contactName(p), person_ids: [p.id], target: "campaign" })}>
                          Add to campaign
                        </MenuItem>
                        <MenuItem icon={<UserPlus size={14} />} onSelect={() => onAdd({ label: contactName(p), person_ids: [p.id], target: "list" })}>
                          Add to list
                        </MenuItem>
                      </RowMenu>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[13px] font-semibold">{plural(d.visits.length, "visit")}</h3>
            <ol className="space-y-3">
              {d.visits.map((v) => (
                <li key={v.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                    <span className="font-medium">{dateTime(v.first_seen_at)}</span>
                    <span className="text-xs text-muted">
                      {plural(v.pageviews, "page")} · {duration(v.duration_sec)}
                      {v.source ? ` · from ${v.source}` : " · direct"}
                    </span>
                  </div>
                  {(v.visitor_location || v.utm.utm_campaign) && (
                    <p className="mt-0.5 text-xs text-muted">{[v.visitor_location, v.utm.utm_campaign && `campaign ${v.utm.utm_campaign}`].filter(Boolean).join(" · ")}</p>
                  )}
                  <ul className="mt-2 space-y-1">
                    {v.pages.map((pg, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate" title={pg.url}>
                          {pg.path ?? pg.url}
                          {pg.title && <span className="text-muted"> · {pg.title}</span>}
                        </span>
                        <span className="shrink-0 tabular-nums text-faint">{pg.duration_sec ? duration(pg.duration_sec) : ""}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Sheet>
  );
}

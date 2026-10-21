import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, CircleDollarSign, Download, Eye, MessageSquareReply, MousePointerClick, Send, Trophy } from "lucide-react";
import { CAMPAIGN_STATUS_LABELS, CSV_FORMULA } from "@reachstack/shared";
import { errorMessage, get, type Page } from "@/lib/api";
import { fillDays, resolveRange, type DateRange } from "@/lib/dates";
import { downloadBlob, money, num, pct, plural } from "@/lib/format";
import { usePageTitle, useQueryState } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import type { Account } from "@/lib/types";
import { ActivityFeed } from "@/components/ActivityFeed";
import { RangeSelect } from "@/components/RangeSelect";
import { SERIES_COLORS, TrendChart } from "@/components/charts";
import { CampaignStatusBadge } from "@/components/status";
import { Button, Callout, Card, CardHeader, Checkbox, DataTable, EmptyState, ErrorState, Page as PageShell, PageHeader, Select, Skeleton, StatCard, TabPanel, Tabs, type Column } from "@/components/ui";

interface Overview {
  emails_sent_count: number;
  contacted_count: number;
  new_leads_contacted_count: number;
  open_count: number;
  open_count_unique: number;
  link_click_count: number;
  link_click_count_unique: number;
  reply_count: number;
  reply_count_unique: number;
  reply_count_automatic_unique: number;
  bounced_count: number;
  unsubscribed_count: number;
  total_opportunities: number;
  total_opportunity_value: number;
  total_interested: number;
  total_meeting_booked: number;
  total_meeting_completed: number;
  total_closed: number;
}

interface DailyRow {
  date: string;
  sent: number;
  unique_opened: number;
  unique_replies: number;
  unique_clicks: number;
  unique_opportunities: number;
  contacted?: number;
  new_leads_contacted?: number;
  unique_replies_automatic?: number;
  bounced?: number;
}

interface Funnel {
  contacted: number;
  opened: number;
  clicked: number;
  replied: number;
  replied_with_auto: number;
  interested: number;
  meeting_booked: number;
  meeting_completed: number;
  won: number;
}

interface CampaignRow {
  campaign_id: string;
  campaign_name: string;
  campaign_status: number;
  leads_count: number;
  contacted_count: number;
  emails_sent_count: number;
  /** Tries the receiving server refused at once: not sent, yet tried (and bounced). */
  emails_refused_count?: number;
  open_count_unique: number;
  reply_count_unique: number;
  link_click_count_unique: number;
  bounced_count: number;
  total_opportunities: number;
  total_opportunity_value: number;
}

/** A mailbox's figures for the period: people contacted, and of them how many opened and replied. */
interface AccountRow {
  email: string;
  sent: number;
  /** Tries the receiving server refused at once; its bounce rate is out of sent + refused. */
  refused: number;
  contacted: number;
  opened: number;
  replied: number;
  bounced: number;
}

const SERIES = [
  { key: "sent", label: "Sent" },
  { key: "unique_opened", label: "Opened" },
  { key: "unique_replies", label: "Replied" },
  { key: "unique_clicks", label: "Clicked" },
  { key: "unique_opportunities", label: "Opportunities" },
] as const;
type SeriesKey = (typeof SERIES)[number]["key"];

/** A quoted CSV cell; text a spreadsheet would run as a formula gets an apostrophe in front (see CSV_FORMULA). */
const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return `"${(CSV_FORMULA.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** Leads that reached each stage in the period, as a share of the leads contacted. */
function FunnelCard({ f, error, onRetry, withAuto, onWithAuto }: { f: Funnel | undefined; error?: unknown; onRetry: () => unknown; withAuto: boolean; onWithAuto: (v: boolean) => void }) {
  const stages = f
    ? [
        { label: "Contacted", n: f.contacted },
        // Opens only exist with open tracking; a campaign without it would show a false drop to zero.
        ...(f.opened ? [{ label: "Opened", n: f.opened }] : []),
        { label: "Replied", n: withAuto ? f.replied_with_auto : f.replied },
        { label: "Interested", n: f.interested },
        { label: "Meeting booked", n: f.meeting_booked },
        { label: "Meeting completed", n: f.meeting_completed },
        { label: "Won", n: f.won },
      ]
    : [];
  const top = Math.max(1, stages[0]?.n ?? 0);
  return (
    <Card className="mt-3">
      <CardHeader
        title="Funnel"
        description="Leads that reached each stage in this period, and their share of the leads contacted. A lead marked won also counts as a meeting."
        actions={<Checkbox label="Count auto-replies" checked={withAuto} onChange={onWithAuto} />}
        className="flex-wrap"
      />
      {!f ? (
        error ? <ErrorState className="py-8" title="Couldn't load the funnel" error={error} onRetry={onRetry} /> : <Skeleton className="h-40 w-full" />
      ) : (
        <ol className="space-y-1.5">
          {stages.map((s, i) => (
            <li key={s.label} className="grid grid-cols-[7.75rem_1fr_5.25rem] items-center gap-2.5 text-[13px] sm:grid-cols-[9rem_1fr_8rem] sm:gap-3">
              <span className="truncate text-muted">{s.label}</span>
              <div className="h-5 overflow-hidden rounded bg-panel-2">
                <div className="h-full rounded bg-brand/75" style={{ width: `${s.n ? Math.max(1.5, (s.n / top) * 100) : 0}%` }} />
              </div>
              <span className="text-right tabular-nums">
                {num(s.n)} {i > 0 && <span className="text-faint">{pct(s.n, stages[0]!.n)}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export default function Analytics() {
  usePageTitle("Analytics");
  const zone = useWorkspaceZone();
  const [range, setRange] = useState<DateRange>(() => resolveRange("30d", undefined, zone));
  const [campaign, setCampaign] = useQueryState("campaign");
  const [status, setStatus] = useQueryState("status");
  const [tab, setTab] = useQueryState("tab", "campaigns");
  // The mailboxes' figures are for members who see the mailboxes.
  const canAccounts = useCan().perm("accounts");
  const shownTab = canAccounts ? tab : "campaigns";
  const [shown, setShown] = useState<Set<SeriesKey>>(new Set(["sent", "unique_opened", "unique_replies", "unique_opportunities"]));
  const [withAuto, setWithAuto] = useState(false);
  const dates = { start_date: range.start_date, end_date: range.end_date };
  const funnel = useQuery({
    queryKey: ["analytics", "funnel", campaign, status, range.start_date, range.end_date],
    queryFn: () => get<Funnel>("/api/app/analytics/funnel", { id: campaign || undefined, campaign_status: status || undefined, ...dates }),
  });

  const overview = useQuery({
    queryKey: ["analytics", "overview", campaign, status, dates],
    queryFn: () => get<Overview>("/api/v2/campaigns/analytics/overview", { id: campaign || undefined, campaign_status: status || undefined, ...dates }),
  });
  const daily = useQuery({
    queryKey: ["analytics", "daily", campaign, status, dates],
    queryFn: () => get<DailyRow[]>("/api/v2/campaigns/analytics/daily", { campaign_id: campaign || undefined, campaign_status: status || undefined, ...dates }),
  });
  const campaigns = useQuery({
    queryKey: ["analytics", "campaigns", dates],
    queryFn: () => get<CampaignRow[]>("/api/v2/campaigns/analytics", dates),
  });
  const accounts = useQuery({
    queryKey: ["accounts", "picker"],
    queryFn: () => get<Page<Account>>("/api/v2/accounts", { limit: 1000, include_tags: true }),
    select: (d) => d.items,
    enabled: shownTab === "accounts",
  });
  const accountTotals = useQuery({
    queryKey: ["analytics", "accounts", dates],
    queryFn: () => get<AccountRow[]>("/api/app/accounts/analytics/totals", dates),
    enabled: shownTab === "accounts",
  });

  const o = overview.data;
  const contacted = o?.contacted_count ?? 0;
  // A failed load shows a dash and says so above the cards, instead of loading for ever.
  const loading = overview.isError ? "–" : <Skeleton className="h-7 w-16" />;
  const chart = useMemo(() => {
    const rows = daily.data ?? [];
    const start = range.start_date ?? rows[0]?.date;
    const end = range.end_date ?? rows[rows.length - 1]?.date;
    return fillDays(rows, start, end, { sent: 0, unique_opened: 0, unique_replies: 0, unique_clicks: 0, unique_opportunities: 0 });
  }, [daily.data, range.start_date, range.end_date]);

  const campaignRows = useMemo(() => {
    let rows = campaigns.data ?? [];
    if (campaign) rows = rows.filter((r) => r.campaign_id === campaign);
    if (status) rows = rows.filter((r) => String(r.campaign_status) === status);
    return [...rows].sort((a, b) => b.emails_sent_count - a.emails_sent_count || a.campaign_name.localeCompare(b.campaign_name));
  }, [campaigns.data, campaign, status]);

  const accountRows = useMemo(() => {
    const totals = new Map((accountTotals.data ?? []).map((r) => [r.email, r]));
    return (accounts.data ?? [])
      .map((a) => totals.get(a.email) ?? { email: a.email, sent: 0, refused: 0, contacted: 0, opened: 0, replied: 0, bounced: 0 })
      .sort((a, b) => b.sent - a.sent || a.email.localeCompare(b.email));
  }, [accountTotals.data, accounts.data]);

  const toggle = (k: SeriesKey) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(k) && n.size > 1) n.delete(k);
      else n.add(k);
      return n;
    });

  const exportDaily = () => {
    const head = ["Date", "Emails sent", "Leads contacted", "First emails", "Opened", "Replied", "Auto-replies", "Clicked", "Bounced", "Opportunities"];
    const byDate = new Map((daily.data ?? []).map((d) => [d.date, d]));
    const lines = chart.map((c) => {
      const d = byDate.get(c.date);
      return [c.date, d?.sent ?? 0, d?.contacted ?? 0, d?.new_leads_contacted ?? 0, d?.unique_opened ?? 0, d?.unique_replies ?? 0, d?.unique_replies_automatic ?? 0, d?.unique_clicks ?? 0, d?.bounced ?? 0, d?.unique_opportunities ?? 0]
        .map(csvCell)
        .join(",");
    });
    const name = campaign ? (campaigns.data?.find((c) => c.campaign_id === campaign)?.campaign_name ?? "campaign") : "all-campaigns";
    const stem = name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "campaign";
    downloadBlob(`${stem}-daily-${range.start_date ?? "all"}-${range.end_date ?? "time"}.csv`, [head.map(csvCell).join(","), ...lines].join("\n"));
  };

  const exportCampaigns = () => {
    const head = ["Campaign", "Status", "Leads", "Sequence started", "Emails sent", "Opened", "Replied", "Clicked", "Bounced", "Opportunities", "Opportunity value"];
    const lines = campaignRows.map((r) =>
      [r.campaign_name, CAMPAIGN_STATUS_LABELS[r.campaign_status] ?? r.campaign_status, r.leads_count, r.contacted_count, r.emails_sent_count, r.open_count_unique, r.reply_count_unique, r.link_click_count_unique, r.bounced_count, r.total_opportunities, r.total_opportunity_value]
        .map(csvCell)
        .join(","),
    );
    downloadBlob(`campaign-analytics-${range.start_date ?? "all"}-${range.end_date ?? "time"}.csv`, [head.map(csvCell).join(","), ...lines].join("\n"));
  };

  const campaignColumns: Column<CampaignRow>[] = [
    {
      key: "name",
      header: "Campaign",
      cell: (r) => (
        <div className="min-w-0">
          <Link to={`/app/campaign/${r.campaign_id}/analytics`} className="-my-1 block truncate py-1 font-medium hover:text-brand-text">
            {r.campaign_name}
          </Link>
          <CampaignStatusBadge status={r.campaign_status} />
        </div>
      ),
      className: "max-w-[18rem]",
    },
    { key: "started", header: "Sequence started", cell: (r) => <span className="tabular-nums">{num(r.contacted_count)} <span className="text-faint">/ {num(r.leads_count)}</span></span> },
    { key: "opened", header: "Opened", cell: (r) => <span className="tabular-nums">{num(r.open_count_unique)} <span className="text-faint">{pct(r.open_count_unique, r.contacted_count)}</span></span>, hideBelow: "md" },
    { key: "replied", header: "Replied", cell: (r) => <span className="tabular-nums">{num(r.reply_count_unique)} <span className="text-faint">{pct(r.reply_count_unique, r.contacted_count)}</span></span> },
    { key: "clicked", header: "Clicked", cell: (r) => <span className="tabular-nums">{num(r.link_click_count_unique)}</span>, hideBelow: "lg" },
    {
      key: "bounced",
      header: "Bounced",
      cell: (r) => (
        <span className="tabular-nums">
          {num(r.bounced_count)} <span className="text-faint">{pct(r.bounced_count, r.emails_sent_count + (r.emails_refused_count ?? 0))}</span>
        </span>
      ),
      hideBelow: "lg",
    },
    {
      key: "opps",
      header: "Opportunities",
      cell: (r) => (
        <span className="tabular-nums">
          {num(r.total_opportunities)} {r.total_opportunity_value > 0 && <span className="text-faint">{money(r.total_opportunity_value)}</span>}
        </span>
      ),
    },
  ];

  const accountColumns: Column<AccountRow>[] = [
    { key: "email", header: "Sending account", cell: (r) => <span className="font-medium">{r.email}</span> },
    { key: "sent", header: "Sent", cell: (r) => <span className="tabular-nums">{num(r.sent)}</span> },
    { key: "contacted", header: "Contacted", cell: (r) => <span className="tabular-nums">{num(r.contacted)}</span>, hideBelow: "md" },
    { key: "opened", header: "Opened", cell: (r) => <span className="tabular-nums">{num(r.opened)} <span className="text-faint">{pct(r.opened, r.contacted)}</span></span>, hideBelow: "md" },
    { key: "replied", header: "Replied", cell: (r) => <span className="tabular-nums">{num(r.replied)} <span className="text-faint">{pct(r.replied, r.contacted)}</span></span> },
    {
      key: "bounced",
      header: "Bounced",
      cell: (r) => (
        <span className="tabular-nums" title={r.refused ? `Out of ${num(r.sent + r.refused)} tried: ${num(r.sent)} sent, ${num(r.refused)} refused by the receiving server` : undefined}>
          {num(r.bounced)} <span className="text-faint">{pct(r.bounced, r.sent + r.refused)}</span>
        </span>
      ),
    },
  ];

  const nothing = o && !o.emails_sent_count && !daily.data?.length;

  return (
    <PageShell wide>
      <PageHeader
        title="Analytics"
        description="How your campaigns perform across every inbox."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              size="sm"
              className="w-56"
              value={campaign}
              onChange={setCampaign}
              options={[{ value: "", label: "All campaigns" }, ...(campaigns.data ?? []).map((c) => ({ value: c.campaign_id, label: c.campaign_name }))]}
              aria-label="Campaign"
            />
            <Select
              size="sm"
              className="w-40"
              value={status}
              onChange={setStatus}
              options={[{ value: "", label: "Any status" }, ...[1, 2, 3, 4, 0].map((s) => ({ value: String(s), label: CAMPAIGN_STATUS_LABELS[s]! }))]}
              aria-label="Campaign status"
            />
            <RangeSelect value={range} onChange={setRange} />
          </div>
        }
      />

      {overview.isError && (
        <Callout
          tone="bad"
          className="mb-3"
          title="Couldn't load the totals"
          action={
            <Button size="xs" onClick={() => overview.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(overview.error)}
        </Callout>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total sent"
          icon={<Send size={15} />}
          tone="brand"
          value={o ? num(o.emails_sent_count) : loading}
          sub={o ? `${plural(o.new_leads_contacted_count, "first touch", "first touches")} · ${plural(Math.max(0, o.emails_sent_count - o.new_leads_contacted_count), "follow-up")}` : undefined}
          onClick={() => toggle("sent")}
          active={shown.has("sent")}
        />
        <StatCard
          label="Open rate"
          icon={<Eye size={15} />}
          tone="info"
          value={o ? pct(o.open_count_unique, contacted) : loading}
          sub={o ? `${plural(o.open_count_unique, "lead")} opened · ${plural(o.open_count, "open")}` : undefined}
          onClick={() => toggle("unique_opened")}
          active={shown.has("unique_opened")}
        />
        <StatCard
          label="Click rate"
          icon={<MousePointerClick size={15} />}
          tone="info"
          value={o ? pct(o.link_click_count_unique, contacted) : loading}
          sub={o ? `${plural(o.link_click_count_unique, "lead")} clicked` : undefined}
          onClick={() => toggle("unique_clicks")}
          active={shown.has("unique_clicks")}
        />
        <StatCard
          label="Reply rate"
          icon={<MessageSquareReply size={15} />}
          tone="ok"
          value={o ? pct(withAuto && funnel.data ? funnel.data.replied_with_auto : o.reply_count_unique, contacted) : loading}
          sub={o ? `${plural(withAuto && funnel.data ? funnel.data.replied_with_auto : o.reply_count_unique, "lead")} replied${withAuto ? " (with auto-replies)" : ` · ${num(o.reply_count_automatic_unique)} auto`}` : undefined}
          onClick={() => toggle("unique_replies")}
          active={shown.has("unique_replies")}
        />
        <StatCard
          label="Opportunities"
          icon={<CircleDollarSign size={15} />}
          tone="warn"
          value={o ? num(o.total_opportunities) : loading}
          sub={o ? money(o.total_opportunity_value) : undefined}
          onClick={() => toggle("unique_opportunities")}
          active={shown.has("unique_opportunities")}
        />
        <StatCard label="Conversions" icon={<Trophy size={15} />} tone="ok" value={o ? num(o.total_closed) : loading} sub={o ? `${pct(o.total_closed, contacted, 2)} of contacted leads` : undefined} />
      </div>

      <FunnelCard f={funnel.data} error={funnel.isError ? funnel.error : undefined} onRetry={() => funnel.refetch()} withAuto={withAuto} onWithAuto={setWithAuto} />

      <Card className="mt-5">
        <CardHeader
          title="Daily activity"
          description="Click a card above to show or hide its line."
          actions={
            <Button size="xs" variant="ghost" icon={<Download size={13} />} onClick={exportDaily} disabled={!daily.data?.length}>
              CSV by day
            </Button>
          }
        />
        {daily.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : daily.isError ? (
          <ErrorState className="py-10" title="Couldn't load the daily numbers" error={daily.error} onRetry={() => daily.refetch()} />
        ) : nothing ? (
          <EmptyState icon={<BarChart3 size={22} />} title="No sending in this period" description="Pick a longer date range, or launch a campaign to start collecting numbers." />
        ) : (
          <TrendChart data={chart} series={SERIES.filter((s) => shown.has(s.key)).map((s) => ({ ...s, color: SERIES_COLORS[SERIES.findIndex((x) => x.key === s.key)] }))} />
        )}
      </Card>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card padded={false}>
          <Tabs
            value={shownTab as "campaigns" | "accounts"}
            onChange={setTab}
            className="px-4"
            tabs={[{ value: "campaigns", label: "Campaign analytics" }, ...(canAccounts ? [{ value: "accounts" as const, label: "Account analytics" }] : [])]}
          >
            <TabPanel value="campaigns">
              <div className="flex justify-end px-4 pt-3">
                <Button size="xs" variant="ghost" icon={<Download size={13} />} onClick={exportCampaigns} disabled={!campaignRows.length}>
                  Export CSV
                </Button>
              </div>
              <DataTable
                rows={campaignRows}
                columns={campaignColumns}
                rowKey={(r) => r.campaign_id}
                loading={campaigns.isLoading}
                error={campaigns.error}
                onRetry={() => campaigns.refetch()}
                empty={<EmptyState title="No campaigns yet" description="Published campaigns appear here with their results." />}
                dense
              />
            </TabPanel>
            <TabPanel value="accounts">
              <DataTable
                rows={accountRows}
                columns={accountColumns}
                rowKey={(r) => r.email}
                loading={accounts.isLoading || accountTotals.isLoading}
                error={accounts.error ?? accountTotals.error}
                onRetry={() => (accounts.isError ? accounts.refetch() : accountTotals.refetch())}
                empty={<EmptyState title="No data to display" description="Connect email accounts and send a campaign to compare their performance." />}
                dense
              />
              {(accounts.data?.length ?? 0) >= 1000 && <p className="px-4 py-2 text-xs text-muted">Showing the first 1,000 accounts.</p>}
            </TabPanel>
          </Tabs>
        </Card>
        <Card>
          <CardHeader title="Activity feed" />
          <ActivityFeed campaignId={campaign || undefined} limit={12} compact />
        </Card>
      </div>
    </PageShell>
  );
}

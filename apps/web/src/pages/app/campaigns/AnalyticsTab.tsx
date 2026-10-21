import { useMemo, useState } from "react";
import { Link, Navigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign, Eye, MessageSquareReply, MousePointerClick, Send, Trophy } from "lucide-react";
import { get } from "@/lib/api";
import { daysBefore, fillDays, resolveRange, todayIn, type DateRange } from "@/lib/dates";
import { money, num, pct, plural } from "@/lib/format";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { ActivityFeed } from "@/components/ActivityFeed";
import { RangeSelect } from "@/components/RangeSelect";
import { SERIES_COLORS, TrendChart } from "@/components/charts";
import { Card, CardHeader, EmptyState, ErrorState, Progress, Segmented, Skeleton, StatCard } from "@/components/ui";
import { BouncesPanel } from "./BouncesPanel";
import { useCampaign } from "./context";
import { StepTable, type StepRow } from "./StepTable";

interface Metrics {
  emails_sent_count: number;
  contacted_count: number;
  new_leads_contacted_count: number;
  open_count_unique: number;
  link_click_count_unique: number;
  reply_count_unique: number;
  reply_count_automatic_unique: number;
  bounced_count: number;
  unsubscribed_count: number;
  total_opportunities: number;
  total_opportunity_value: number;
}

interface DailyRow {
  date: string;
  sent: number;
  unique_opened: number;
  unique_replies: number;
  unique_clicks: number;
  unique_opportunities: number;
}

interface Overview {
  metrics: Metrics;
  interest: { total_interested: number; total_meeting_booked: number; total_meeting_completed: number; total_closed: number; total_positive: number };
  leads: { total: number; completed: number; active: number; paused: number; bounced: number; unsubscribed: number; contacted: number; done: number; progress: number };
  daily: DailyRow[];
  steps: StepRow[];
}

const SERIES = [
  { key: "sent", label: "Sent" },
  { key: "unique_opened", label: "Opened" },
  { key: "unique_replies", label: "Replied" },
  { key: "unique_clicks", label: "Clicked" },
  { key: "unique_opportunities", label: "Opportunities" },
];

export default function AnalyticsTab() {
  const can = useCan();
  // A member whose role doesn't include analytics opens the campaign on its sequence.
  return can.perm("analytics") ? <CampaignAnalytics /> : <Navigate to="../sequences" replace />;
}

function CampaignAnalytics() {
  const { campaign } = useCampaign();
  const zone = useWorkspaceZone();
  const [range, setRange] = useState<DateRange>(() => resolveRange("all"));
  const [view, setView] = useState<"steps" | "bounces" | "activity">("steps");
  const q = useQuery({
    queryKey: ["campaign", campaign.id, "overview", range.start_date, range.end_date],
    queryFn: () => get<Overview>(`/api/app/campaigns/${campaign.id}/overview`, { start_date: range.start_date, end_date: range.end_date }),
    refetchInterval: 60_000,
  });
  const o = q.data;
  const m = o?.metrics;
  const tracking = campaign.open_tracking;

  const { daily, sinceStart } = useMemo(() => {
    if (!o) return { daily: [], sinceStart: false };
    // "All time" spans the data, but at least two weeks so a young campaign still draws a trend.
    const today = todayIn(zone);
    const twoWeeks = daysBefore(today, 13);
    const first = o.daily[0]?.date;
    const sinceStart = !!first && first < twoWeeks;
    const start = range.start_date ?? (sinceStart ? first : twoWeeks);
    const end = range.end_date ?? today;
    return { daily: fillDays(o.daily, start, end, { sent: 0, unique_opened: 0, unique_replies: 0, unique_clicks: 0, unique_opportunities: 0 }), sinceStart };
  }, [o, range.start_date, range.end_date, zone]);

  const steps = campaign.sequences[0]?.steps ?? [];

  const loading = <Skeleton className="h-7 w-16" />;
  const contacted = m?.contacted_count ?? 0;

  if (q.isError && !o) return <ErrorState title="Couldn't load this campaign's analytics" error={q.error} onRetry={() => q.refetch()} />;

  if (campaign.status === 0 && o && !m?.emails_sent_count) {
    return (
      <EmptyState
        icon={<Send size={22} />}
        title="No analytics yet"
        description="Launch the campaign to start sending. Opens, replies and opportunities appear here as they happen."
        action={
          <Link to={`/app/campaign/${campaign.id}/sequences`} className="text-[13px] font-medium text-brand-text hover:underline">
            Review the sequence
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[14rem] flex-1">
          <div className="mb-1 flex justify-between text-xs text-muted">
            {/* Done: nothing left to send them (finished, replied, bounced, unsubscribed or skipped). */}
            <span>
              Done {o ? `${o.leads.progress}%` : "–"} · {o ? num(o.leads.done) : "–"} of {o ? num(o.leads.total) : "–"} leads
            </span>
            <span>
              {o ? num(o.leads.active) : "–"} active{o?.leads.paused ? ` · ${num(o.leads.paused)} paused` : ""} · {o ? num(o.leads.bounced) : "–"} bounced ·{" "}
              {o ? num(o.leads.unsubscribed) : "–"} unsubscribed
            </span>
          </div>
          <Progress value={o?.leads.progress ?? 0} tone={(o?.leads.progress ?? 0) >= 100 ? "ok" : "brand"} />
        </div>
        <RangeSelect value={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Sequence started" icon={<Send size={15} />} tone="brand" value={m ? num(contacted) : loading} sub={o ? `of ${plural(o.leads.total, "lead")} · ${plural(m?.emails_sent_count ?? 0, "email")}` : undefined} />
        <StatCard
          label="Open rate"
          icon={<Eye size={15} />}
          tone="info"
          value={!tracking ? <span className="text-base text-muted">Tracking off</span> : m ? pct(m.open_count_unique, contacted) : loading}
          sub={tracking && m ? `${plural(m.open_count_unique, "lead")} opened` : "Turn on open tracking in Options"}
        />
        <StatCard
          label="Click rate"
          icon={<MousePointerClick size={15} />}
          tone="info"
          value={campaign.link_tracking === false ? <span className="text-base text-muted">Tracking off</span> : m ? pct(m.link_click_count_unique, contacted) : loading}
          sub={m ? `${plural(m.link_click_count_unique, "lead")} clicked` : undefined}
        />
        <StatCard label="Reply rate" icon={<MessageSquareReply size={15} />} tone="ok" value={m ? pct(m.reply_count_unique, contacted) : loading} sub={m ? `${num(m.reply_count_unique)} replied · ${plural(m.reply_count_automatic_unique, "auto-reply", "auto-replies")}` : undefined} />
        <StatCard
          label="Opportunities"
          icon={<CircleDollarSign size={15} />}
          tone="warn"
          value={m ? num(m.total_opportunities) : loading}
          sub={m ? `${money(m.total_opportunity_value)} · ${pct(o?.interest.total_positive ?? 0, m.reply_count_unique)} positive replies` : undefined}
        />
        <StatCard label="Conversions" icon={<Trophy size={15} />} tone="ok" value={o ? num(o.interest.total_closed) : loading} sub={o ? `${plural(o.interest.total_meeting_booked, "meeting")} booked` : undefined} />
      </div>

      <Card>
        <CardHeader title="Daily activity" description={range.key === "all" ? (sinceStart ? "Since the campaign started" : "The last 14 days") : undefined} />
        {q.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : daily.length ? (
          <TrendChart data={daily} series={SERIES.filter((s) => tracking || s.key !== "unique_opened").map((s, i) => ({ ...s, color: SERIES_COLORS[i] }))} />
        ) : (
          <p className="py-16 text-center text-[13px] text-muted">No activity in this period.</p>
        )}
      </Card>

      <Card padded={false}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "steps", label: "Step analytics" },
              { value: "bounces", label: "Bounces" },
              { value: "activity", label: "Activity" },
            ]}
          />
          {m && m.bounced_count > 0 && view !== "bounces" && (
            <Link to={`/app/campaign/${campaign.id}/leads?filter=FILTER_VAL_BOUNCED`} className="text-xs text-brand-text hover:underline">
              {num(m.bounced_count)} bounced leads →
            </Link>
          )}
        </div>
        {view === "steps" ? (
          <StepTable rows={o?.steps ?? []} steps={steps} tracking={tracking} opportunities loading={q.isLoading} />
        ) : view === "bounces" ? (
          <BouncesPanel campaignId={campaign.id} campaignName={campaign.name} range={range} />
        ) : (
          <div className="p-3">
            <ActivityFeed campaignId={campaign.id} limit={25} />
          </div>
        )}
      </Card>
    </div>
  );
}

import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, CalendarClock, CheckCircle2, Circle, Clock, Inbox, Mail, MailPlus, Plus, Rocket, Send, Sparkles, TrendingUp } from "lucide-react";
import { errorMessage, get, patch } from "@/lib/api";
import { ME_KEY, resendConfirmation, useCan, useSession, useWorkspaceZone } from "@/lib/session";
import { num, pct, plural } from "@/lib/format";
import { browserZone, fillDays, resolveRange, sameClock } from "@/lib/dates";
import { usePageTitle } from "@/lib/hooks";
import { ActivityFeed } from "@/components/ActivityFeed";
import { TrendChart } from "@/components/charts";
import { CampaignStatusBadge, Score } from "@/components/status";
import { Button, ButtonLink, Card, CardHeader, EmptyState, ErrorState, Page, Progress, Skeleton, StatCard } from "@/components/ui";
import { todayQuery } from "@/pages/app/today/api";
import { ScrollX } from "@/components/ui/scroll-x";

interface Setup {
  steps: Array<{ key: string; done: boolean }>;
  completed: number;
  total: number;
}

interface Overview {
  emails_sent_count: number;
  contacted_count: number;
  reply_count_unique: number;
  open_count_unique: number;
  total_opportunities: number;
  total_opportunity_value: number;
  total_meeting_booked: number;
  bounced_count: number;
}

interface DailyRow {
  date: string;
  sent: number;
  unique_replies: number;
  unique_opportunities: number;
}

interface CampaignRow {
  campaign_id: string;
  campaign_name: string;
  campaign_status: number;
  emails_sent_count: number;
  contacted_count: number;
  reply_count_unique: number;
  total_opportunities: number;
  leads_count: number;
}

const STEP_COPY: Record<string, { title: string; to?: string; cta: string }> = {
  verify_email: { title: "Confirm your email address", cta: "Resend email" },
  connect_account: { title: "Connect a sending account", to: "/app/account/connect", cta: "Connect" },
  enable_warmup: { title: "Turn on warmup", to: "/app/accounts", cta: "Open accounts" },
  create_campaign: { title: "Create your first campaign", to: "/app/campaign/create", cta: "Create" },
  add_leads: { title: "Add leads", to: "/app/lead-finder", cta: "Find leads" },
  launch_campaign: { title: "Launch a campaign", to: "/app/campaigns", cta: "Open campaigns" },
  first_reply: { title: "Get your first reply", to: "/app/unibox", cta: "Open inbox" },
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function SetupChecklist() {
  // "I'm done with this" on the Getting started page hides it for good.
  const me = useSession();
  const hidden = me.user.onboarding_completed;
  const setup = useQuery({ queryKey: ["dashboard", "setup"], queryFn: () => get<Setup>("/api/app/dashboard/setup"), enabled: !hidden });
  if (hidden || !setup.data || setup.data.completed === setup.data.total) return null;
  const s = setup.data;
  const next = s.steps.find((x) => !x.done);
  return (
    <Card className="mb-6">
      <CardHeader
        title="Get set up"
        description={`${s.completed} of ${s.total} done. Finish these and your first campaign is ready to send.`}
        actions={
          <Link to="/app/onboarding" className="text-[13px] font-medium text-brand-text hover:underline">
            Full checklist
          </Link>
        }
      />
      <Progress value={s.completed} max={s.total} className="mb-4" />
      <ul className="grid gap-1 sm:grid-cols-2">
        {s.steps.map((step) => {
          const copy = STEP_COPY[step.key] ?? { title: step.key, cta: "Open" };
          const isNext = step.key === next?.key;
          return (
            <li key={step.key} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${isNext ? "bg-brand-soft" : ""}`}>
              {step.done ? <CheckCircle2 size={18} className="shrink-0 text-ok" /> : <Circle size={18} className="shrink-0 text-faint" />}
              <span className={`flex-1 text-[13px] ${step.done ? "text-muted line-through" : "font-medium"}`}>{copy.title}</span>
              {!step.done &&
                (step.key === "verify_email" ? (
                  <Button
                    size="xs"
                    variant={isNext ? "primary" : "ghost"}
                    onClick={() => void resendConfirmation(!!me.features.owner)}
                  >
                    {copy.cta}
                  </Button>
                ) : (
                  <ButtonLink to={copy.to!} size="xs" variant={isNext ? "primary" : "ghost"}>
                    {copy.cta}
                  </ButtonLink>
                ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const zoneName = (zone: string) => zone.split("/").pop()!.replace(/_/g, " ");
const clockIn = (zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date());

/**
 * A workspace whose clock isn't the one on this admin's computer, asked about once: most likely it kept the timezone it
 * started with. Sending schedules, daily limits and "today" all follow the workspace's clock.
 */
function ZoneCheck() {
  const me = useSession();
  const can = useCan();
  const qc = useQueryClient();
  const zone = useWorkspaceZone();
  const [busy, setBusy] = useState<string | null>(null);
  const local = browserZone();
  if (!can.admin || !local || me.workspace?.settings.timezone_confirmed === true || sameClock(zone, local)) return null;
  const choose = async (picked: string) => {
    setBusy(picked);
    try {
      await patch("/api/app/workspaces/current/settings", { default_timezone: picked, timezone_confirmed: true });
      await qc.invalidateQueries({ queryKey: ME_KEY });
      await qc.invalidateQueries({ queryKey: ["workspace-settings"] });
      toast.success(picked === zone ? `Keeping ${zoneName(zone)} time` : `This workspace runs on ${zoneName(picked)} time now`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-text">
          <Clock size={17} />
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-medium">Which clock should this workspace run on?</p>
          <p className="mt-0.5 text-[13px] text-muted">
            It's on {zoneName(zone)} time ({clockIn(zone)} there), and your computer is on {zoneName(local)} time ({clockIn(local)}). New campaigns send in its
            hours, daily limits reset at its midnight, and "today" is its today. You can change it later in Settings → Preferences.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy === local} disabled={!!busy} onClick={() => void choose(local)}>
            Use {zoneName(local)} time
          </Button>
          <Button size="sm" loading={busy === zone} disabled={!!busy} onClick={() => void choose(zone)}>
            Keep {zoneName(zone)}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** "30 sent today · about 120 more", leaving out whichever part is nothing. */
function todayLine(sent: number, more: number): string {
  if (!sent) return more ? `About ${num(more)} to send today` : "Nothing to send today";
  return more ? `${num(sent)} sent today · about ${num(more)} more` : `${num(sent)} sent today`;
}

/** Today's sending at a glance, linking to the Today page. */
function TodayLink() {
  const today = useQuery(todayQuery).data;
  return (
    <Link to="/app/today" className="flex items-center gap-4 rounded-xl border border-line bg-panel p-4 shadow-card hover:border-line-strong">
      <span className="rounded-xl bg-brand-soft p-2.5 text-brand-text">
        <CalendarClock size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{today ? todayLine(today.sent, today.more) : "Today"}</span>
        <span className="block truncate text-[13px] text-muted">{today ? today.bottleneck.title : "What goes out today, and what holds the rest back"}</span>
      </span>
      <ArrowRight size={16} className="text-faint" />
    </Link>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <span className="text-bad">
      Couldn't load.{" "}
      <button type="button" className="font-medium underline underline-offset-2 hover:text-text" onClick={onRetry}>
        Retry
      </button>
    </span>
  );
}

/** A stat card's number and line under it: a placeholder while loading, a dash and a retry link if the request failed. */
function stat<T>(q: UseQueryResult<T>, value: (d: T) => ReactNode, sub?: (d: T) => ReactNode): { value: ReactNode; sub?: ReactNode } {
  if (q.data !== undefined) return { value: value(q.data), sub: sub?.(q.data) };
  if (q.isError) return { value: "–", sub: <LoadFailed onRetry={() => void q.refetch()} /> };
  return { value: <Skeleton className="h-7 w-16" /> };
}

export default function Dashboard() {
  const me = useSession();
  const can = useCan();
  usePageTitle("Home");
  const zone = useWorkspaceZone();
  const range = useMemo(() => resolveRange("14d", undefined, zone), [zone]);
  const week = useMemo(() => resolveRange("7d", undefined, zone), [zone]);
  const showAnalytics = can.perm("analytics");
  const overview = useQuery({
    queryKey: ["analytics", "overview", week],
    queryFn: () => get<Overview>("/api/v2/campaigns/analytics/overview", { start_date: week.start_date, end_date: week.end_date }),
    enabled: showAnalytics,
  });
  const daily = useQuery({
    queryKey: ["analytics", "daily", range],
    queryFn: () => get<DailyRow[]>("/api/v2/campaigns/analytics/daily", { start_date: range.start_date, end_date: range.end_date }),
    enabled: showAnalytics,
  });
  const campaigns = useQuery({
    queryKey: ["analytics", "campaigns", week],
    queryFn: () => get<CampaignRow[]>("/api/v2/campaigns/analytics", { start_date: week.start_date, end_date: week.end_date }),
    enabled: showAnalytics,
  });
  const accounts = useQuery({
    queryKey: ["accounts", "summary"],
    queryFn: () => get<{ total: number; active: number; errors: number; health_score: number | null; daily_capacity: number }>("/api/app/accounts/summary"),
    enabled: can.perm("accounts"),
  });
  const unibox = useQuery({
    queryKey: ["unibox", "summary"],
    queryFn: () => get<{ unread: { primary: number } }>("/api/app/unibox/summary"),
    enabled: can.perm("unibox"),
  });

  const chart = useMemo(
    () => fillDays(daily.data ?? [], range.start_date, range.end_date, { sent: 0, unique_replies: 0, unique_opportunities: 0 } as Omit<DailyRow, "date">),
    [daily.data, range],
  );
  const topCampaigns = (campaigns.data ?? [])
    .filter((c) => c.campaign_status !== 0 || c.emails_sent_count > 0)
    .sort((a, b) => b.emails_sent_count - a.emails_sent_count)
    .slice(0, 6);

  return (
    <Page wide>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[13px] text-muted">{me.workspace?.name}</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting()}
            {me.user.first_name ? `, ${me.user.first_name}` : ""}
          </h1>
        </div>
        <div className="flex gap-2">
          {can.perm("accounts") && can.write && (
            <ButtonLink to="/app/account/connect" icon={<MailPlus size={15} />}>
              Connect account
            </ButtonLink>
          )}
          {can.perm("edit_campaigns") && (
            <ButtonLink to="/app/campaign/create" variant="primary" icon={<Plus size={15} />}>
              New campaign
            </ButtonLink>
          )}
        </div>
      </div>

      <ZoneCheck />
      <SetupChecklist />

      {showAnalytics && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Emails sent · 7 days" icon={<Send size={15} />} tone="brand" {...stat(overview, (d) => num(d.emails_sent_count), (d) => `${plural(d.contacted_count, "lead")} contacted`)} />
          <StatCard label="Reply rate" icon={<TrendingUp size={15} />} tone="ok" {...stat(overview, (d) => pct(d.reply_count_unique, d.contacted_count), (d) => `${plural(d.reply_count_unique, "lead")} replied`)} />
          <StatCard label="Opportunities" icon={<Sparkles size={15} />} tone="warn" {...stat(overview, (d) => num(d.total_opportunities), (d) => `${plural(d.total_meeting_booked, "meeting")} booked`)} />
          {can.perm("accounts") ? (
            <StatCard
              label="Sending health"
              icon={<Mail size={15} />}
              tone="info"
              {...stat(
                accounts,
                (d) => <Score value={d.health_score} />,
                (d) => `${num(d.active)} of ${plural(d.total, "account")} active${d.errors ? ` · ${d.errors} with errors` : ""}`,
              )}
            />
          ) : (
            <StatCard label="Bounced" {...stat(overview, (d) => num(d.bounced_count))} />
          )}
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          {showAnalytics && (
            <Card>
              <CardHeader
                title="Last 14 days"
                actions={
                  <Link to="/app/analytics/overview" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] font-medium text-brand-text hover:underline">
                    Analytics <ArrowRight size={14} />
                  </Link>
                }
              />
              {daily.isLoading ? (
                <Skeleton className="h-[260px]" />
              ) : daily.isError && !daily.data ? (
                <ErrorState className="py-10" title="Couldn't load the last 14 days" error={daily.error} onRetry={() => daily.refetch()} />
              ) : (
                <TrendChart
                  data={chart}
                  series={[
                    { key: "sent", label: "Sent" },
                    { key: "unique_replies", label: "Replies", color: "#10b981" },
                    { key: "unique_opportunities", label: "Opportunities", color: "#f59e0b" },
                  ]}
                />
              )}
            </Card>
          )}

          {showAnalytics && (
            <Card padded={false}>
              <div className="flex items-center justify-between px-5 pt-5">
                <h3 className="text-[15px] font-semibold">Campaigns this week</h3>
                <Link to="/app/campaigns" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] font-medium text-brand-text hover:underline">
                  All campaigns <ArrowRight size={14} />
                </Link>
              </div>
              {campaigns.isLoading ? (
                <div className="space-y-2 p-5">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              ) : campaigns.isError && !campaigns.data ? (
                <ErrorState className="py-10" title="Couldn't load this week's campaigns" error={campaigns.error} onRetry={() => campaigns.refetch()} />
              ) : topCampaigns.length ? (
                <ScrollX>
                  <table className="mt-3 w-full text-[13px]">
                    <thead>
                      <tr className="border-y border-line text-left text-xs text-muted">
                        <th className="px-5 py-2 font-medium">Campaign</th>
                        <th className="px-3 py-2 text-right font-medium">Sent</th>
                        <th className="px-3 py-2 text-right font-medium">Replies</th>
                        <th className="px-5 py-2 text-right font-medium">Opportunities</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topCampaigns.map((c) => (
                        <tr key={c.campaign_id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                          <td className="px-5 py-2.5">
                            <Link to={`/app/campaign/${c.campaign_id}/analytics`} className="font-medium hover:text-brand-text">
                              {c.campaign_name}
                            </Link>
                            <div className="mt-1">
                              <CampaignStatusBadge status={c.campaign_status} />
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{num(c.emails_sent_count)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {num(c.reply_count_unique)} <span className="text-xs text-faint">{pct(c.reply_count_unique, c.contacted_count)}</span>
                          </td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{num(c.total_opportunities)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollX>
              ) : (
                <EmptyState
                  icon={<Rocket size={22} />}
                  title="No campaigns sending yet"
                  description="Launch a campaign and its numbers show up here."
                  action={
                    can.perm("edit_campaigns") ? (
                      <ButtonLink to="/app/campaign/create" variant="primary" icon={<Plus size={15} />}>
                        Create campaign
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {can.perm("view_campaigns") && <TodayLink />}
          {can.perm("unibox") && (
            <Link to="/app/unibox" className="flex items-center gap-4 rounded-xl border border-line bg-panel p-4 shadow-card hover:border-line-strong">
              <span className="rounded-xl bg-brand-soft p-2.5 text-brand-text">
                <Inbox size={20} />
              </span>
              <span className="flex-1">
                <span className="block text-sm font-semibold">{unibox.data ? (unibox.data.unread.primary ? `${num(unibox.data.unread.primary)} unread replies` : "Inbox zero") : "Unibox"}</span>
                <span className="block text-[13px] text-muted">Every reply from every account, in one place</span>
              </span>
              <ArrowRight size={16} className="text-faint" />
            </Link>
          )}
          {can.perm("dashboard") && (
            <Card>
              <CardHeader title="Activity" />
              <ActivityFeed limit={12} compact />
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}

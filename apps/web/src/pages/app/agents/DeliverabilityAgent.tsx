import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Check, CircleAlert, Gauge, Info, MessageSquare, Pause, Play, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { ago, dateTime, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { TrendChart } from "@/components/charts";
import { Badge, Button, Card, CardHeader, EmptyState, NativeSelect, Page, Progress, Segmented, SkeletonRows, StatCard, Switch, useConfirm } from "@/components/ui";
import { AGENTS_KEY, AgentStatusBadge, useIntegrations } from "./shared";

interface DAgent {
  id: string;
  name: string;
  status: number;
  timestamp_created: string;
  payload: { integrations: { slack: { connection_id: string; enabled: boolean; connection_name?: string } | null } };
}

interface CheckRow {
  activity_id: string;
  activity_code: string;
  status: string;
  outcome: string;
  summary: string | null;
  completed_at: string | null;
}

interface FeedItem {
  id: string;
  feed_code: string;
  kind: "insight" | "recommendation";
  status: "todo" | "done" | "dismissed" | "failed";
  severity: "info" | "success" | "warning" | "critical";
  subject_type: string | null;
  subject_id: string | null;
  subject_name: string | null;
  payload: { title?: string; detail?: string; accounts?: Array<string | { email: string }>; email?: string; campaigns?: Array<{ id: string; name: string }>; lists?: string[]; missing?: string[]; sample?: string[] } & Record<string, unknown>;
  result_payload: { resolved?: "action" | "manual" | "revalidated" | "fixed" } | null;
  action_code: string | null;
  action_status: string | null;
  action_payload: { paused_account_count?: number; duration_days?: number; already_paused_account_count?: number } | null;
  timestamp_created: string;
  completed_at: string | null;
  dismissed_at: string | null;
}

interface State {
  agent: DAgent | null;
  current_activity: { active: { activity_code: string } | null; queued: unknown[]; completed_summary: { count: number; last_completed_at: string | null } };
  schedule: { next_run_at: string | null };
  run_summary: {
    latest: {
      cycle_id: string | null;
      status: string;
      started_at: string | null;
      completed_at: string | null;
      total_checks: number;
      completed_checks: number;
      healthy_count: number;
      needs_attention_count: number;
      info_count: number;
      failed_count: number;
      score?: number | null;
      checks: CheckRow[];
    };
    trend: Array<{ completed_at: string; score: number | null }>;
  };
}

const STATE_KEY = ["deliverability-agent"];
const FEED_KEY = ["deliverability-feed"];

const CHECK_LABELS: Record<string, { label: string; text: string }> = {
  check_workspace_settings: { label: "Campaign settings", text: "Unsubscribe headers, stopping on reply and tracking domains" },
  check_dns_health: { label: "DNS records", text: "SPF, DKIM, DMARC and MX on every sending domain" },
  check_blocklists: { label: "Blocklists", text: "Sending domains and their mail servers on public blocklists" },
  check_bounce_health: { label: "Bounce rates", text: "Mailboxes bouncing 3% or more over the last 7 days" },
  check_warmup_coverage: { label: "Warmup", text: "Sending mailboxes with warmup off or a low score" },
  check_account_connections: { label: "Mailbox connections", text: "Mailboxes that lost their connection and can't send" },
  check_campaign_copy: { label: "Campaign copy", text: "Spam-prone words and too many links in active sequences" },
  check_duplicates_in_campaigns: { label: "Overlapping campaigns", text: "The same lead in more than one active campaign" },
};

const OUTCOME: Record<string, { label: string; tone: "ok" | "warn" | "info" | "bad" | "neutral" }> = {
  healthy: { label: "Healthy", tone: "ok" },
  needs_attention: { label: "Needs attention", tone: "warn" },
  info: { label: "For your information", tone: "info" },
  failed: { label: "Couldn't check", tone: "bad" },
  skipped: { label: "Nothing to check", tone: "neutral" },
  running: { label: "Checking…", tone: "info" },
  queued: { label: "Waiting", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const SEVERITY: Record<FeedItem["severity"], { color: string; icon: typeof Info }> = {
  critical: { color: "text-bad", icon: CircleAlert },
  warning: { color: "text-warn", icon: CircleAlert },
  info: { color: "text-info", icon: Info },
  success: { color: "text-ok", icon: Check },
};

function useDeliverability() {
  return useQuery({
    queryKey: STATE_KEY,
    queryFn: () => get<State>("/api/v2/ai-agents/deliverability/state", { limit: 1 }),
    refetchInterval: (q) => (q.state.data?.run_summary.latest.status === "running" ? 2500 : false),
  });
}

function scoreTone(score: number | null | undefined) {
  if (score == null) return undefined;
  return score >= 85 ? "ok" : score >= 60 ? "warn" : "bad";
}

function accountsOf(item: FeedItem) {
  const list = item.payload.accounts ?? (item.payload.email ? [item.payload.email] : []);
  return list.map((a) => (typeof a === "string" ? a : a.email));
}

function resultText(item: FeedItem) {
  if (item.status === "dismissed") return `Dismissed ${ago(item.dismissed_at)}. It comes back if the issue is still there in 7 days.`;
  if (item.status === "failed") return "The fix couldn't be applied.";
  const a = item.action_payload;
  // An item offers an action from the start; only one that was carried out says so.
  const acted = item.action_status === "completed";
  if (acted && item.action_code === "pause_affected_accounts") return `Paused ${plural(a?.paused_account_count ?? 0, "mailbox", "mailboxes")}.`;
  if (acted && item.action_code === "pause_campaign_sending")
    return `Campaign sending paused on ${plural(a?.paused_account_count ?? 0, "mailbox", "mailboxes")} for ${a?.duration_days ?? 14} days${a?.already_paused_account_count ? ` (${a.already_paused_account_count} already paused)` : ""}. Warmup keeps running.`;
  if (item.result_payload?.resolved === "manual") return "Marked as fixed after checking again.";
  if (item.result_payload?.resolved === "revalidated") return "Checked again: the issue is gone.";
  return `Resolved ${ago(item.completed_at)}.`;
}

function FeedCard({ item, onChanged }: { item: FeedItem; onChanged: () => void }) {
  const can = useCan();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const sev = SEVERITY[item.severity] ?? SEVERITY.info;
  const Icon = sev.icon;
  const accounts = accountsOf(item);
  const run = async <T,>(key: string, fn: () => Promise<T>, done: string | ((r: T) => string)) => {
    setBusy(key);
    try {
      const r = await fn();
      toast.success(typeof done === "function" ? done(r) : done);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const pauseAccounts = async () => {
    if (!(await confirm({ title: `Pause ${plural(accounts.length, "mailbox", "mailboxes")}?`, description: "They stop sending campaigns and warmup until you resume them on the Email accounts page. The agent checks the issue again first.", confirmLabel: "Pause mailboxes", danger: true }))) return;
    run(
      "pause",
      () => post<{ item: FeedItem; paused_account_count: number }>(`/api/v2/ai-agents/deliverability/feed-items/${item.id}/pause-affected-accounts`),
      (r) => (r.item.result_payload?.resolved === "revalidated" ? "Checked again: the issue is gone, so nothing was paused." : `Paused ${plural(r.paused_account_count, "mailbox", "mailboxes")}.`),
    );
  };
  const pauseCampaigns = async () => {
    if (!(await confirm({ title: "Rest these mailboxes for 14 days?", description: "They stop sending campaign emails for 14 days while warmup keeps running. Ready-made and managed mailboxes are left alone.", confirmLabel: "Pause campaign sending" }))) return;
    run("rest", () => post(`/api/v2/ai-agents/deliverability/feed-items/${item.id}/pause-campaign-sending`), "Campaign sending paused");
  };
  const open = item.status === "todo";
  return (
    <li className="flex gap-3 border-b border-line px-4 py-4 last:border-b-0 sm:px-5">
      <span className={`mt-0.5 shrink-0 ${sev.color}`}>
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] font-medium">{item.payload.title ?? item.feed_code}</p>
          {item.kind === "insight" && <Badge tone="neutral">Insight</Badge>}
          {!open && (
            <Badge tone={item.status === "done" ? "ok" : "neutral"}>{item.status === "done" ? "Resolved" : item.status === "dismissed" ? "Dismissed" : "Failed"}</Badge>
          )}
        </div>
        {item.payload.detail && <p className="mt-1 text-[13px] text-muted">{item.payload.detail}</p>}
        {item.payload.lists && item.payload.lists.length > 0 && <p className="mt-1 text-xs text-muted">Listed on: {item.payload.lists.join(", ")}</p>}
        {accounts.length > 0 && (
          <p className="mt-1 truncate text-xs text-faint" title={accounts.join(", ")}>
            {accounts.slice(0, 4).join(", ")}
            {accounts.length > 4 && ` and ${accounts.length - 4} more`}
          </p>
        )}
        {item.payload.campaigns && item.payload.campaigns.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {item.payload.campaigns.slice(0, 5).map((c) => (
              <Link key={c.id} to={`/app/campaign/${c.id}/options`} className="text-brand-text hover:underline">
                {c.name}
              </Link>
            ))}
          </p>
        )}
        {!open && <p className="mt-2 text-xs text-muted">{resultText(item)}</p>}
        {open && can.write && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {["dns_health_recommendation", "blocklist_recommendation"].includes(item.feed_code) && accounts.length > 0 && (
              <Button size="sm" variant="danger" icon={<Pause size={14} />} loading={busy === "pause"} onClick={pauseAccounts}>
                Pause affected mailboxes
              </Button>
            )}
            {["bounce_health_recommendation", "warmup_score_recommendation"].includes(item.feed_code) && (
              <Button size="sm" icon={<Pause size={14} />} loading={busy === "rest"} onClick={pauseCampaigns}>
                Rest for 14 days
              </Button>
            )}
            {item.feed_code === "account_connection_recommendation" && (
              <Link to={`/app/accounts?q=${encodeURIComponent(item.payload.email ?? item.subject_name ?? "")}`} className="inline-flex h-8 items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-on-brand hover:opacity-90">
                Reconnect
              </Link>
            )}
            {item.feed_code === "campaign_copy_insight" && item.subject_id && (
              <Link to={`/app/campaign/${item.subject_id}/sequences`} className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-panel-2">
                Edit sequence
              </Link>
            )}
            {item.feed_code === "dns_health_recommendation" && (
              <Link to="/app/accounts" className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-panel-2">
                Check DNS setup
              </Link>
            )}
            {item.feed_code === "workspace_settings_recommendation" && (
              <Button size="sm" icon={<Check size={14} />} loading={busy === "complete"} onClick={() => run("complete", () => post(`/api/v2/ai-agents/deliverability/feed-items/${item.id}/complete`), "Checked again: fixed")}>
                I've fixed it
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<X size={14} />} loading={busy === "dismiss"} onClick={() => run("dismiss", () => post(`/api/app/ai-agents/deliverability/feed-items/${item.id}/dismiss`), "Dismissed")}>
              Dismiss
            </Button>
          </div>
        )}
      </div>
      <span className="hidden shrink-0 text-xs text-faint sm:block">{ago(item.timestamp_created)}</span>
    </li>
  );
}

function Feed({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"todo" | "done" | "all">("todo");
  const feed = useInfiniteQuery({
    queryKey: [...FEED_KEY, filter],
    queryFn: ({ pageParam }) => get<{ items: FeedItem[]; next_starting_after?: string }>(`/api/v2/ai-agents/deliverability/${agentId}/feed-items`, { feed_filter: filter, limit: 20, starting_after: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_starting_after,
  });
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: FEED_KEY });
    qc.invalidateQueries({ queryKey: STATE_KEY });
    qc.invalidateQueries({ queryKey: AGENTS_KEY });
  };
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold">Recommendations</h2>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "todo", label: "To do" },
            { value: "done", label: "Done" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      {feed.isLoading ? (
        <div className="p-5">
          <SkeletonRows rows={3} />
        </div>
      ) : items.length ? (
        <ul>
          {items.map((i) => (
            <FeedCard key={i.id} item={i} onChanged={refresh} />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-10 text-center text-[13px] text-muted">{filter === "todo" ? "Nothing to fix right now." : "Nothing here yet."}</p>
      )}
      {feed.hasNextPage && (
        <div className="border-t border-line p-3 text-center">
          <Button size="sm" variant="ghost" loading={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
            Show more
          </Button>
        </div>
      )}
    </Card>
  );
}

function SlackSetting({ agent }: { agent: DAgent }) {
  const qc = useQueryClient();
  const can = useCan();
  const integrations = useIntegrations();
  const slackConns = (integrations.data?.items ?? []).filter((i) => i.type === "slack");
  const current = agent.payload.integrations.slack;
  const save = async (slack: { connection_id: string; enabled: boolean } | null) => {
    try {
      await patch("/api/v2/ai-agents/deliverability/settings", { slack });
      qc.invalidateQueries({ queryKey: STATE_KEY });
      toast.success(slack?.enabled ? "Slack alerts on" : "Slack alerts off");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  if (!slackConns.length)
    return (
      <p className="text-[13px] text-muted">
        <Link to="/app/settings/integrations" className="font-medium text-brand-text hover:underline">
          Connect Slack
        </Link>{" "}
        to get new recommendations in a channel.
      </p>
    );
  return (
    <div className="space-y-2">
      <NativeSelect
        size="sm"
        value={current?.connection_id ?? ""}
        disabled={!can.write}
        onChange={(v) => save(v ? { connection_id: v, enabled: true } : null)}
        options={[{ value: "", label: "No Slack alerts" }, ...slackConns.map((s) => ({ value: s.id, label: s.name }))]}
        aria-label="Slack connection"
      />
      {current && (
        <label className="flex items-center justify-between gap-3 text-[13px]">
          Send alerts
          <Switch checked={current.enabled} disabled={!can.write} onChange={(v) => save({ connection_id: current.connection_id, enabled: v })} aria-label="Send Slack alerts" />
        </label>
      )}
    </div>
  );
}

function Intro() {
  const qc = useQueryClient();
  const can = useCan();
  const [busy, setBusy] = useState(false);
  const deploy = async () => {
    setBusy(true);
    try {
      await post("/api/v2/ai-agents/deliverability/deploy");
      toast.success("Deliverability agent is on. The first checks are running.");
      await Promise.all([qc.invalidateQueries({ queryKey: STATE_KEY }), qc.invalidateQueries({ queryKey: AGENTS_KEY })]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mx-auto max-w-2xl">
      <div className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand-text">
        <ShieldCheck size={22} />
      </div>
      <h2 className="mt-4 text-lg font-semibold">Catch sending problems before replies drop</h2>
      <p className="mt-1 text-[13px] text-muted">Once a day the agent looks over every mailbox and active campaign in this workspace and tells you what to fix, most urgent first. It never changes anything until you click.</p>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        {Object.values(CHECK_LABELS).map((c) => (
          <li key={c.label} className="flex gap-2 text-[13px]">
            <Check size={16} className="mt-0.5 shrink-0 text-ok" />
            <span>
              <span className="font-medium">{c.label}</span>
              <span className="block text-xs text-muted">{c.text}</span>
            </span>
          </li>
        ))}
      </ul>
      {can.write && (
        <Button className="mt-6" variant="primary" icon={<Play size={14} />} loading={busy} onClick={deploy}>
          Turn on deliverability agent
        </Button>
      )}
    </Card>
  );
}

export default function DeliverabilityAgentPage() {
  usePageTitle("Deliverability agent");
  const q = useDeliverability();
  const qc = useQueryClient();
  const nav = useNavigate();
  const can = useCan();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const s = q.data;
  const agent = s?.agent;
  const latest = s?.run_summary.latest;
  const running = latest?.status === "running";
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: STATE_KEY }), qc.invalidateQueries({ queryKey: FEED_KEY }), qc.invalidateQueries({ queryKey: AGENTS_KEY })]);
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!agent) return;
    if (!(await confirm({ title: "Remove the deliverability agent?", description: "Its checks and recommendations are deleted. You can turn it on again later.", confirmLabel: "Remove", danger: true }))) return;
    await act("delete", () => del(`/api/v2/ai-agents/deliverability/${agent.id}`), "Deliverability agent removed");
    nav("/app/ai-agents");
  };

  const trend = (s?.run_summary.trend ?? []).filter((t) => t.score != null).map((t) => ({ date: dateTime(t.completed_at), score: t.score }));
  // While a run is in progress the latest cycle has no score yet; keep showing the previous one.
  const score = latest?.score ?? (running ? (trend[trend.length - 1]?.score ?? null) : null);

  return (
    <Page>
      <Link to="/app/ai-agents" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> Agents
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-brand-soft text-brand-text">
          <Gauge size={18} />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">Deliverability agent</h1>
        {agent && <AgentStatusBadge status={agent.status} />}
        {agent && can.write && (
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {agent.status === 1 ? (
              <>
                <Button icon={<RefreshCw size={14} />} loading={busy === "run"} disabled={running} onClick={() => act("run", () => post("/api/v2/ai-agents/deliverability/run-now"), "Checks started")}>
                  {running ? "Checking…" : "Check now"}
                </Button>
                <Button icon={<Pause size={14} />} loading={busy === "pause"} onClick={() => act("pause", () => post("/api/app/ai-agents/deliverability/pause"), "Agent paused")}>
                  Pause
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={<Play size={14} />} loading={busy === "deploy"} onClick={() => act("deploy", () => post("/api/v2/ai-agents/deliverability/deploy"), "Agent is on again")}>
                Turn on
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="pt-6">
        {q.isLoading ? (
          <SkeletonRows rows={6} />
        ) : q.isError ? (
          <EmptyState title="Couldn't load the agent" description={errorMessage(q.error)} />
        ) : !agent ? (
          <Intro />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
            <div className="min-w-0 space-y-6">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Health score" value={score != null ? `${score}` : "–"} sub={running ? "Checking again…" : score != null ? "out of 100" : "No run yet"} tone={scoreTone(score)} />
                <StatCard label="Healthy" value={latest?.healthy_count ?? 0} tone="ok" />
                <StatCard label="Needs attention" value={latest?.needs_attention_count ?? 0} tone={latest?.needs_attention_count ? "warn" : undefined} />
                <StatCard label="Couldn't check" value={latest?.failed_count ?? 0} tone={latest?.failed_count ? "bad" : undefined} />
              </div>
              <Feed agentId={agent.id} />
              {trend.length > 1 && (
                <Card>
                  <CardHeader title="Score over time" description="One point per daily run" />
                  <TrendChart data={trend} series={[{ key: "score", label: "Score" }]} height={200} />
                </Card>
              )}
            </div>
            <div className="space-y-4">
              <Card>
                <CardHeader title="Latest run" description={running ? `Started ${ago(latest?.started_at)}` : latest?.completed_at ? `Finished ${ago(latest.completed_at)}` : undefined} />
                {running && <Progress className="mb-4" value={latest!.total_checks ? (latest!.completed_checks / latest!.total_checks) * 100 : 0} />}
                <ul className="space-y-3">
                  {(latest?.checks ?? []).map((c) => {
                    const o = OUTCOME[c.outcome] ?? { label: c.outcome, tone: "neutral" as const };
                    return (
                      <li key={c.activity_id} className="text-[13px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{CHECK_LABELS[c.activity_code]?.label ?? c.activity_code}</span>
                          <Badge tone={o.tone}>{o.label}</Badge>
                        </div>
                        {c.summary && <p className="mt-0.5 text-xs text-muted">{c.summary}</p>}
                      </li>
                    );
                  })}
                </ul>
                {!latest?.checks.length && <p className="text-[13px] text-muted">The first run starts shortly.</p>}
                <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
                  {agent.status === 1 ? (s?.schedule.next_run_at ? `Next run ${dateTime(s.schedule.next_run_at)}` : "Runs once a day") : "Paused. No checks run until you turn it on."}
                </p>
              </Card>
              <Card>
                <CardHeader title="Slack" description="Post new recommendations to a channel" />
                <SlackSetting agent={agent} />
              </Card>
              {can.write && (
                <Card>
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    <MessageSquare size={14} className="text-muted" /> Remove agent
                  </div>
                  <p className="mt-1 text-xs text-muted">Deletes its checks and recommendations. Mailboxes and campaigns aren't touched.</p>
                  <Button className="mt-3" size="sm" variant="danger" icon={<Trash2 size={14} />} loading={busy === "delete"} onClick={remove}>
                    Remove
                  </Button>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

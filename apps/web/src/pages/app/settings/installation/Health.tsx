// /app/settings/installation/health — is the installation keeping up? Whether the background engine's loops run on
// time, how far behind inbox sync is, the job queue, campaigns that stopped sending, and disk space. For the owner and
// administrators; the Overview tab shows the short version (HealthSummary).
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ShieldOff } from "lucide-react";
import { ACCOUNT_STATUS_LABELS, CAMPAIGN_STATUS_LABELS, CampaignStatus, NOT_SENDING_SHORT } from "@reachstack/shared";
import { errorMessage, get } from "@/lib/api";
import { ago, bytes, duration, num, plural } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Badge, ButtonLink, Callout, Card, CardHeader, CopyButton, Dot, EmptyState, KeyValue, Progress, Skeleton, Tooltip } from "@/components/ui";
import { RestartButton } from "./RestartButton";

// ---------- Types ----------

type Tone = "ok" | "warn" | "bad";
type LoopState = "ok" | "starting" | "late" | "stuck" | "failing";

interface Health {
  checked_at: string;
  status: Tone;
  /** Whether you can restart the server from here (the owner, on a server that restarts itself). */
  can_restart: boolean;
  engine: {
    tone: Tone;
    reporting: boolean;
    reported_at: string | null;
    started_at: string | null;
    in_process: boolean;
    loops: Array<{
      name: string;
      interval_ms: number;
      running: boolean;
      runs: number;
      failures: number;
      last_run_at: string | null;
      last_duration_ms: number | null;
      last_error: { at: string; message: string } | null;
      state: LoopState;
      late_after_ms: number;
    }>;
  };
  inbox_sync: {
    tone: Tone;
    mailboxes: number;
    late: number;
    errors: number;
    oldest_sync_at: string | null;
    oldest_lag_s: number;
    items: Array<{ email: string; workspace_id: string; workspace: string; status: number; last_sync_at: string | null; lag_s: number; late: boolean }>;
  };
  jobs: {
    tone: Tone;
    pending: number;
    running: number;
    failed_24h: number;
    stuck: number;
    oldest_pending_at: string | null;
  };
  campaigns: {
    tone: Tone;
    running: number;
    needs_attention: number;
    items: Array<{ id: string; name: string; workspace_id: string; workspace: string; status: number; not_sending_status: number | null }>;
  };
  storage: {
    tone: Tone;
    data_dir: string;
    database_bytes: number;
    data_dir_bytes: number;
    data_dir_files: number;
    data_dir_partial: boolean;
    data_dir_measured_at: string | null;
    disk_free_bytes: number | null;
    disk_total_bytes: number | null;
  };
}

export const HEALTH_KEY = ["installation", "health"];

const useHealth = (refetchInterval = 30_000) => useQuery({ queryKey: HEALTH_KEY, queryFn: () => get<Health>("/api/app/admin/health"), refetchInterval });

/** The loops sending and replies depend on (services/health.ts KEY_LOOPS). The Overview tab lists every loop. */
const KEY_LOOPS: Record<string, string> = {
  sender: "Sending",
  "inbox-sync": "Inbox sync",
  warmup: "Warmup",
  jobs: "Background jobs",
};

const STATE: Record<LoopState, { tone: "ok" | "warn" | "bad" | "neutral"; label: string }> = {
  ok: { tone: "ok", label: "On time" },
  starting: { tone: "neutral", label: "Starting" },
  late: { tone: "warn", label: "Late" },
  stuck: { tone: "bad", label: "Stuck" },
  failing: { tone: "bad", label: "Failing" },
};

const STATUS: Record<Tone, { badge: string; title: string }> = {
  ok: { badge: "All good", title: "Everything is running normally" },
  warn: { badge: "Needs a look", title: "Something needs a look" },
  bad: { badge: "Needs attention", title: "Something needs attention now" },
};

const behindLoop = (l: Health["engine"]["loops"][number]) => l.state === "late" || l.state === "stuck" || l.state === "failing";
const every = (ms: number) => (ms < 60_000 ? `every ${Math.round(ms / 1000)} s` : `every ${duration(ms / 1000)}`);
/** How long ago, from a number of seconds. */
const behind = (s: number) => (s < 60 ? "under a minute" : duration(s));

// ---------- Plain-language lines (shared by the summary and the full page) ----------

function engineLine(h: Health): string {
  if (!h.engine.reporting) return h.engine.reported_at ? `Stopped reporting ${ago(h.engine.reported_at)}` : "Hasn't reported yet";
  const key = h.engine.loops.filter((l) => l.name in KEY_LOOPS && behindLoop(l));
  if (key.length) return key.map((l) => `${KEY_LOOPS[l.name]} is ${STATE[l.state].label.toLowerCase()}`).join(", ");
  const others = h.engine.loops.filter(behindLoop).length;
  return others ? `Sending and sync on time; ${plural(others, "other task")} behind` : "Every task on time";
}

function syncLine(h: Health): string {
  const s = h.inbox_sync;
  if (!s.mailboxes) return "No mailboxes yet";
  if (s.late) return `${num(s.late)} of ${plural(s.mailboxes, "mailbox", "mailboxes")} behind, the furthest by ${behind(s.oldest_lag_s)}`;
  return `${plural(s.mailboxes, "mailbox", "mailboxes")} up to date`;
}

function jobsLine(h: Health): string {
  const j = h.jobs;
  const parts = [`${num(j.pending)} waiting`, `${num(j.running)} running`];
  if (j.stuck) parts.push(`${num(j.stuck)} stuck`);
  if (j.failed_24h) parts.push(`${num(j.failed_24h)} failed in the last day`);
  return parts.join(" · ");
}

function campaignsLine(h: Health): string {
  const c = h.campaigns;
  if (c.needs_attention) return `${plural(c.needs_attention, "campaign")} not sending`;
  return c.running ? `${plural(c.running, "running campaign")}, none stuck` : "No campaigns running";
}

function diskLine(h: Health): string {
  const s = h.storage;
  if (s.disk_free_bytes !== null && s.disk_total_bytes) return `${bytes(s.disk_free_bytes)} free of ${bytes(s.disk_total_bytes)}`;
  return `Database ${bytes(s.database_bytes)}`;
}

// ---------- Overview card ----------

/** The short version for the Overview tab. */
export function HealthSummary() {
  const q = useHealth(60_000);
  const h = q.data;
  const rows: Array<{ label: string; tone: Tone; text: string }> = h
    ? [
        { label: "Background engine", tone: h.engine.tone, text: engineLine(h) },
        { label: "Inbox sync", tone: h.inbox_sync.tone, text: syncLine(h) },
        { label: "Background jobs", tone: h.jobs.tone, text: jobsLine(h) },
        { label: "Campaigns", tone: h.campaigns.tone, text: campaignsLine(h) },
        { label: "Disk", tone: h.storage.tone, text: diskLine(h) },
      ]
    : [];
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            System health
            {h && (
              <Badge tone={h.status} dot>
                {STATUS[h.status].badge}
              </Badge>
            )}
          </span>
        }
        description="Whether sending, inbox sync and the job queue keep up."
        actions={
          <ButtonLink to="/app/settings/installation/health" size="sm">
            Details
          </ButtonLink>
        }
      />
      {q.isError ? (
        <p className="text-[13px] text-bad">{errorMessage(q.error)}</p>
      ) : !h ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : (
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-5">
          {rows.map((r) => (
            <div key={r.label} className="min-w-0">
              <p className="flex items-center gap-2 text-xs font-medium text-muted">
                <Dot tone={r.tone} />
                {r.label}
              </p>
              <p className="mt-0.5 break-words text-[13px]">{r.text}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------- Full page ----------

export function InstallationHealth() {
  const me = useSession();
  const q = useHealth();
  const h = q.data;
  if (!me.features.instance_admin) return <EmptyState icon={<ShieldOff size={24} />} title="Only the owner of this installation can open this page" />;
  if (q.isError) return <Callout tone="bad">{errorMessage(q.error)}</Callout>;
  if (!h)
    return (
      <div className="space-y-5">
        <Skeleton className="h-14" />
        <Skeleton className="h-64" />
      </div>
    );
  const here = me.workspace?.id;
  const others = h.engine.loops.filter((l) => !(l.name in KEY_LOOPS));
  const otherLate = others.filter(behindLoop).length;
  const usedShare = h.storage.disk_free_bytes !== null && h.storage.disk_total_bytes ? 1 - h.storage.disk_free_bytes / h.storage.disk_total_bytes : null;
  return (
    <div className="space-y-5">
      <Callout tone={h.status} title={STATUS[h.status].title}>
        Checked {ago(h.checked_at)}. This page refreshes every 30 seconds.
      </Callout>

      <Card>
        <CardHeader
          title="Background engine"
          description="Each task runs on a timer. Late: no finished turn for three turns and at least two minutes. Stuck: one turn running for over ten minutes."
          actions={h.engine.reported_at ? <span className="text-xs text-muted">Reported {ago(h.engine.reported_at)}</span> : undefined}
        />
        {!h.engine.reporting && (
          <Callout tone="bad" className="mb-4">
            {h.engine.reported_at ? `The engine stopped reporting ${ago(h.engine.reported_at)}.` : "The engine hasn't reported yet."} Emails aren't sent and inboxes aren't checked while it's down. Restart the server
            {h.engine.in_process ? "" : " or the worker"}.
            {h.can_restart && h.engine.in_process && (
              <div className="mt-2">
                <RestartButton />
              </div>
            )}
          </Callout>
        )}
        {!h.engine.loops.length ? (
          <p className="text-[13px] text-muted">Nothing to show until the engine reports.</p>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {Object.entries(KEY_LOOPS).map(([name, label]) => {
                const l = h.engine.loops.find((x) => x.name === name);
                const s = l ? STATE[l.state] : null;
                return (
                  <li key={name} className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 py-2 text-[13px]">
                    <Dot tone={s?.tone ?? "neutral"} />
                    <span className="font-medium">{label}</span>
                    {l && <span className="text-xs text-faint">{every(l.interval_ms)}</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums">
                      {l?.last_error && (
                        <Tooltip content={`${l.last_error.message} (${ago(l.last_error.at)})`}>
                          <span className="cursor-help text-bad">{plural(l.failures, "failure")}</span>
                        </Tooltip>
                      )}
                      {!l || !s ? (
                        <span className="text-muted">Not running</span>
                      ) : (
                        <>
                          {l.state !== "ok" && <span className={s.tone === "warn" ? "text-warn" : s.tone === "bad" ? "text-bad" : "text-muted"}>{s.label}</span>}
                          <span className="text-muted">{l.running ? "running now" : l.last_run_at ? `last ran ${ago(l.last_run_at)}` : "not yet"}</span>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-muted">
              {otherLate ? `${num(otherLate)} of the ${num(others.length)} other tasks ${otherLate === 1 ? "is" : "are"} behind.` : "Every other task is on time."}{" "}
              <Link to="/app/settings/installation" className="text-brand-text hover:underline">
                See every task on the Overview tab
              </Link>
            </p>
          </>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Inbox sync" description="How long since each mailbox was last checked for replies. Behind means five checks were missed." />
          <KeyValue
            items={[
              ["Mailboxes", num(h.inbox_sync.mailboxes)],
              ["Behind", <span key="b" className={h.inbox_sync.late ? "text-warn" : undefined}>{num(h.inbox_sync.late)}</span>],
              ["With an error", <span key="e" className={h.inbox_sync.errors ? "text-bad" : undefined}>{num(h.inbox_sync.errors)}</span>],
              ["Longest wait", h.inbox_sync.mailboxes ? behind(h.inbox_sync.oldest_lag_s) : null],
            ]}
          />
          {h.inbox_sync.items.some((i) => i.late || i.status < 0) && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-xs font-medium text-muted">Behind or failing</p>
              <ul className="mt-1.5 space-y-1.5">
                {h.inbox_sync.items
                  .filter((i) => i.late || i.status < 0)
                  .slice(0, 10)
                  .map((i) => (
                    <li key={`${i.workspace_id}-${i.email}`} className="flex min-w-0 items-center gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">
                        {i.workspace_id === here ? (
                          <Link to={`/app/accounts?account=${encodeURIComponent(i.email)}`} className="hover:underline">
                            {i.email}
                          </Link>
                        ) : (
                          i.email
                        )}
                        <span className="text-faint"> · {i.workspace}</span>
                      </span>
                      {i.status < 0 && <Badge tone="bad">{ACCOUNT_STATUS_LABELS[i.status] ?? "Error"}</Badge>}
                      <span className="shrink-0 text-xs tabular-nums text-muted">{i.last_sync_at ? ago(i.last_sync_at) : "never"}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Background jobs" description="Imports, exports, verification and other long tasks." />
          <KeyValue
            items={[
              ["Waiting", h.jobs.oldest_pending_at ? `${num(h.jobs.pending)} (oldest ${ago(h.jobs.oldest_pending_at)})` : num(h.jobs.pending)],
              ["Running", num(h.jobs.running)],
              ["Stuck", <span key="s" className={h.jobs.stuck ? "text-bad" : undefined}>{num(h.jobs.stuck)}</span>],
              ["Failed in the last day", <span key="f" className={h.jobs.failed_24h ? "text-bad" : undefined}>{num(h.jobs.failed_24h)}</span>],
            ]}
          />
          {h.jobs.stuck > 0 && <p className="mt-3 text-xs text-muted">A stuck job stopped reporting progress for half an hour, usually because the server restarted while it ran.</p>}
          {h.jobs.failed_24h > 0 && (
            <p className="mt-3 text-xs text-muted">
              <Link to="/app/settings/installation" className="text-brand-text hover:underline">
                See the latest failures on the Overview tab
              </Link>
            </p>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Campaigns that stopped sending" description={`Running campaigns that can't send until someone steps in. ${plural(h.campaigns.running, "campaign")} running in all.`} />
          {!h.campaigns.items.length ? (
            <p className="text-[13px] text-muted">None. Campaigns that are quiet right now are outside their schedule, at a daily limit or waiting for leads to come due.</p>
          ) : (
            <ul className="divide-y divide-line">
              {h.campaigns.items.map((c) => (
                <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">
                    {c.workspace_id === here ? (
                      <Link to={`/app/campaign/${c.id}/analytics`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{c.name}</span>
                    )}
                    <span className="text-faint"> · {c.workspace}</span>
                  </span>
                  <Badge tone={c.status === CampaignStatus.ACCOUNTS_UNHEALTHY ? "bad" : "warn"}>
                    {c.status === CampaignStatus.ACCOUNTS_UNHEALTHY ? (CAMPAIGN_STATUS_LABELS[c.status] ?? "Accounts need attention") : (NOT_SENDING_SHORT[c.not_sending_status ?? -1] ?? "Not sending")}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Storage" description="The database and everything else in the data folder: attachments, uploads, exports and backups." />
          <KeyValue
            items={[
              ["Database", bytes(h.storage.database_bytes)],
              [
                "Data folder",
                <span key="d">
                  {bytes(h.storage.data_dir_bytes)} in {plural(h.storage.data_dir_files, "file")}
                  {h.storage.data_dir_partial ? " (or more)" : ""}
                  {h.storage.data_dir_measured_at && <span className="text-faint"> · measured {ago(h.storage.data_dir_measured_at)}</span>}
                </span>,
              ],
              [
                "Free disk space",
                h.storage.disk_free_bytes !== null && h.storage.disk_total_bytes ? (
                  <span key="f" className={h.storage.tone === "bad" ? "text-bad" : h.storage.tone === "warn" ? "text-warn" : undefined}>
                    {bytes(h.storage.disk_free_bytes)} of {bytes(h.storage.disk_total_bytes)}
                  </span>
                ) : (
                  <span key="f" className="text-faint">
                    Not available on this system
                  </span>
                ),
              ],
              [
                "Location",
                <span key="l" className="flex min-w-0 items-center gap-1.5">
                  <code className="truncate text-xs">{h.storage.data_dir}</code>
                  <CopyButton value={h.storage.data_dir} />
                </span>,
              ],
            ]}
          />
          {usedShare !== null && <Progress className="mt-4" value={usedShare * 100} tone={h.storage.tone === "ok" ? "brand" : h.storage.tone} />}
          {h.storage.tone !== "ok" && <p className="mt-2 text-xs text-muted">The disk is nearly full. Free up space or move the data folder before the database can't grow.</p>}
        </Card>
      </div>
    </div>
  );
}


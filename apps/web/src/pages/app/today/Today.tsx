// Today: what goes out today, what holds the rest back, and the week ahead (GET /api/app/today, services/today.ts).
import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict, parseISO } from "date-fns";
import { AlertTriangle, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/cn";
import { ago, compact, num, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { CampaignStatusBadge } from "@/components/status";
import { Badge, Button, ButtonLink, Callout, Card, CardHeader, EmptyState, Page, PageHeader, Progress, Skeleton } from "@/components/ui";
import { todayQuery, type Flow, type Mailbox, type TodayReport } from "./api";
import { SequenceTasks } from "./Tasks";

/** The workspace's clock, which the whole page goes by: its timezone and today's date on it (YYYY-MM-DD). */
const WorkspaceClock = createContext<{ zone: string; today: string }>({ zone: "UTC", today: "" });

/** "today at 3:00 PM", "tomorrow at 9:00 AM", "Friday at 9:00 AM", "Jan 12 at 9:00 AM", on the workspace's clock. */
function useWhen() {
  const { zone, today } = useContext(WorkspaceClock);
  return (at: string): string => {
    const d = parseISO(at);
    const on = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: zone, ...o }).format(d);
    try {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      const days = Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000);
      const time = on({ hour: "numeric", minute: "2-digit" });
      if (days === 0) return `today at ${time}`;
      if (days === 1) return `tomorrow at ${time}`;
      if (days > 1 && days < 7) return `${on({ weekday: "long" })} at ${time}`;
      return `${on({ month: "short", day: "numeric" })} at ${time}`;
    } catch {
      return format(d, "MMM d 'at' h:mm a");
    }
  };
}

export default function Today() {
  usePageTitle("Today");
  const can = useCan();
  const allowed = can.perm("view_campaigns");
  const q = useQuery({ ...todayQuery, enabled: allowed });
  const r = q.data;
  if (!allowed) {
    return (
      <Page>
        <EmptyState title="Not available" description="Seeing today's sending needs permission to view campaigns. Ask a workspace admin." />
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader
        title="Today"
        description={r ? <Clock r={r} /> : "What goes out today, and what holds the rest back."}
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} className={cn(q.isFetching && "animate-spin")} />} onClick={() => void q.refetch()} title="Refresh">
            {q.dataUpdatedAt ? `Updated ${ago(q.dataUpdatedAt)}` : "Refresh"}
          </Button>
        }
      />
      {q.isError ? (
        <Callout tone="bad" title="Couldn't work out today's sending">
          {(q.error as Error).message}
        </Callout>
      ) : !r ? (
        <div className="space-y-6">
          <Skeleton className="h-52" />
          <Skeleton className="h-40" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <WorkspaceClock.Provider value={{ zone: r.timezone, today: r.day }}>
          <div className="space-y-6">
            <SequenceTasks />
            <Capacity r={r} />
            <Campaigns r={r} />
            {r.mailboxes && <Mailboxes boxes={r.mailboxes} />}
            <Forecast r={r} />
          </div>
        </WorkspaceClock.Provider>
      )}
    </Page>
  );
}

function Clock({ r }: { r: TodayReport }) {
  return (
    <>
      {format(parseISO(`${r.day}T12:00:00`), "EEEE, MMMM d")}. Daily limits reset at midnight ({r.timezone.replace(/_/g, " ")}), in {formatDistanceToNowStrict(parseISO(r.resets_at))}.{" "}
      <Link to="/app/settings/preferences" className="whitespace-nowrap text-brand-text hover:underline">
        Change timezone
      </Link>
    </>
  );
}

function Figure({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted sm:text-[13px]">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums tracking-tight sm:text-2xl", tone === "warn" && "text-warn")}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-faint">{sub}</p>}
    </div>
  );
}

const BOTTLENECK_TONE: Record<TodayReport["bottleneck"]["reason"], "ok" | "info" | "warn" | "bad"> = {
  on_track: "ok",
  no_leads: "info",
  idle: "info",
  plan: "bad",
  not_running: "info",
  schedule: "warn",
  no_mailboxes: "warn",
  mailboxes_unavailable: "warn",
  new_lead_limit: "warn",
  campaign_limit: "warn",
  ramp_up: "warn",
  mailbox_limits: "warn",
  sending_gap: "warn",
};

function Capacity({ r }: { r: TodayReport }) {
  const when = useWhen();
  const total = r.sent + r.more + r.wont_fit;
  const width = (v: number) => `${total ? (v / total) * 100 : 0}%`;
  const b = r.bottleneck;
  return (
    <Card>
      <div className="grid grid-cols-3 gap-3">
        <Figure label="Sent today" value={num(r.sent)} sub="campaign emails" />
        <Figure label="More today" value={r.more ? `~${num(r.more)}` : "0"} sub="estimate" />
        <Figure label="Won't fit today" value={num(r.wont_fit)} sub={`of ${plural(r.due, "due email")}`} tone={r.wont_fit ? "warn" : undefined} />
      </div>
      {total > 0 && (
        <>
          <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-panel-2" role="img" aria-label={`${r.sent} sent, about ${r.more} more, ${r.wont_fit} won't fit today`}>
            <div className="bg-brand" style={{ width: width(r.sent) }} />
            <div className="bg-brand/35" style={{ width: width(r.more) }} />
            <div className="bg-warn/45" style={{ width: width(r.wont_fit) }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <Key className="bg-brand">Sent</Key>
            <Key className="bg-brand/35">Goes out later today</Key>
            <Key className="bg-warn/45">Due, but won't fit today</Key>
          </div>
        </>
      )}
      <Callout tone={BOTTLENECK_TONE[b.reason]} title={b.title} className="mt-4">
        <p>
          {b.detail}
          {b.reason === "no_leads" && r.next_due_at && ` The next lead is due ${when(r.next_due_at)}.`}
          {r.waiting_in_stopped > 0 && b.reason !== "idle" && ` Also, ${plural(r.waiting_in_stopped, "email")} due today wait in stopped campaigns.`}
        </p>
        {b.link && (
          <ButtonLink to={b.link.to} size="sm" className="mt-2.5">
            {b.link.label}
          </ButtonLink>
        )}
      </Callout>
      {r.capacity.mailboxes > 0 && (
        <p className="mt-3 text-xs text-faint">
          {r.capacity.usable === r.capacity.mailboxes
            ? `${plural(r.capacity.mailboxes, "mailbox", "mailboxes")} in running campaigns`
            : `${num(r.capacity.usable)} of ${plural(r.capacity.mailboxes, "mailbox", "mailboxes")} in running campaigns can send`}{" "}
          · {num(r.capacity.sent)} of {num(r.capacity.limit)} sent against today's limits. Estimates follow each campaign's schedule, limits and the time between emails.
        </p>
      )}
    </Card>
  );
}

function Key({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", className)} />
      {children}
    </span>
  );
}

function flowLink(f: Flow) {
  return f.kind === "subsequence" ? `/app/campaign/${f.campaign_id}/subsequences/${f.id}` : `/app/campaign/${f.campaign_id}/analytics`;
}

function FlowName({ f }: { f: Flow }) {
  return (
    <div className="min-w-0">
      <Link to={flowLink(f)} className="break-words font-medium hover:text-brand-text">
        {f.name}
      </Link>
      {f.kind === "subsequence" && <p className="break-words text-xs text-muted">Subsequence of {f.campaign_name}</p>}
      <div className="mt-1 flex flex-wrap gap-1.5">
        <CampaignStatusBadge status={f.status} />
        {f.running && !f.window.open_now && <Badge>Window closed</Badge>}
      </div>
    </div>
  );
}

function Why({ f }: { f: Flow }) {
  const when = useWhen();
  return (
    <div className="space-y-1 text-[13px]">
      {f.problem && (
        <p className="flex gap-1.5 text-bad">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {f.problem}
        </p>
      )}
      {f.held.map((h) => (
        <p key={h.reason}>
          {h.text} <span className="whitespace-nowrap text-faint">{num(h.emails)} held back</span>
        </p>
      ))}
      {!f.held.length && (
        <p className="text-muted">
          {f.due_today ? "Everything due fits today." : f.next_due_at ? `Nothing due today. The next lead is due ${when(f.next_due_at)}.` : f.running ? "No leads waiting." : "Nothing due."}
        </p>
      )}
      {f.running && !f.window.open_now && f.window.next_open_at && <p className="text-xs text-faint">The sending window opens {when(f.window.next_open_at)}.</p>}
    </div>
  );
}

function Campaigns({ r }: { r: TodayReport }) {
  if (!r.flows.length) {
    return (
      <Card>
        <CardHeader title="Campaigns" className="mb-0" />
        <EmptyState
          icon={<Send size={20} />}
          title="No campaign is sending today"
          description="Running campaigns, and any that sent today, show up here."
          action={
            <ButtonLink to="/app/campaigns" size="sm">
              Open campaigns
            </ButtonLink>
          }
          className="py-8"
        />
      </Card>
    );
  }
  const limit = (f: Flow) => (f.daily_limit === null ? "None" : num(f.daily_limit));
  const more = (f: Flow) => (!f.running ? "–" : f.more_today ? `~${num(f.more_today)}` : "0");
  return (
    <Card padded={false}>
      <div className="px-4 pt-5 sm:px-5">
        <CardHeader title="Campaigns" description="What each campaign sends today, and what holds the rest back." className="mb-3" />
      </div>
      <div className="hidden md:block">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-y border-line text-left text-xs text-muted">
              <th className="px-5 py-2 font-medium">Campaign</th>
              <th className="px-3 py-2 text-right font-medium">Sent</th>
              <th className="px-3 py-2 text-right font-medium">More today</th>
              <th className="px-3 py-2 text-right font-medium">Due today</th>
              <th className="px-3 py-2 text-right font-medium">Daily limit</th>
              <th className="w-[38%] px-5 py-2 font-medium">Why not more</th>
            </tr>
          </thead>
          <tbody>
            {r.flows.map((f) => (
              <tr key={f.id} className="border-b border-line align-top last:border-0">
                <td className="px-5 py-3">
                  <FlowName f={f} />
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{num(f.sent_today)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{more(f)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{num(f.due_today)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{limit(f)}</td>
                <td className="px-5 py-3">
                  <Why f={f} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line border-t border-line md:hidden">
        {r.flows.map((f) => (
          <li key={f.id} className="space-y-2.5 px-4 py-3">
            <FlowName f={f} />
            <dl className="grid grid-cols-4 gap-2 text-xs">
              {[
                ["Sent", num(f.sent_today)],
                ["More", more(f)],
                ["Due", num(f.due_today)],
                ["Limit", limit(f)],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-medium tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <Why f={f} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Mailboxes({ boxes }: { boxes: Mailbox[] }) {
  const when = useWhen();
  const [all, setAll] = useState(false);
  const busy = boxes.filter((m) => m.campaigns > 0 || m.sent_today > 0);
  const quiet = boxes.length - busy.length;
  const shown = all || !busy.length ? boxes : busy;
  const note = (m: Mailbox) =>
    [m.note === "Resting" && m.resting_until ? `Resting until ${when(m.resting_until)}` : m.note, m.campaigns > 1 ? `${m.campaigns} running campaigns` : null].filter(Boolean).join(" · ");
  return (
    <Card padded={false}>
      <div className="px-4 pt-5 sm:px-5">
        <CardHeader
          title="Mailboxes"
          description="Campaign emails each mailbox sent today, against today's limit."
          className="mb-3"
          actions={
            <ButtonLink to="/app/accounts" size="sm" variant="ghost">
              Email accounts
            </ButtonLink>
          }
        />
      </div>
      {!boxes.length ? (
        <EmptyState
          title="No mailboxes yet"
          description="Connect a mailbox to send from."
          action={
            <ButtonLink to="/app/account/connect" size="sm">
              Connect a mailbox
            </ButtonLink>
          }
          className="border-t border-line py-8"
        />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {shown.map((m) => (
            <li key={m.id} className="grid gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_220px_170px] sm:items-center sm:px-5">
              <div className="min-w-0">
                <Link to={`/app/accounts?account=${encodeURIComponent(m.email)}`} className="-my-1 block truncate py-1 text-[13px] font-medium hover:text-brand-text">
                  {m.email}
                </Link>
                {note(m) && <p className={cn("truncate text-xs", m.status === 1 ? "text-muted" : "text-bad")}>{note(m)}</p>}
              </div>
              <div className="min-w-0">
                <div className="flex justify-between gap-2 text-xs text-muted">
                  <span className="tabular-nums">
                    {num(m.sent_today)} of {num(m.limit_today)} sent
                  </span>
                  {m.more_today > 0 && <span className="tabular-nums">~{num(m.more_today)} more</span>}
                </div>
                <Progress value={m.sent_today} max={m.limit_today} tone={m.sent_today >= m.limit_today ? "warn" : "brand"} className="mt-1" />
              </div>
              <div className="flex gap-3 text-xs text-muted sm:block sm:text-right">
                <p className="tabular-nums">{m.warmup.on ? `${plural(m.warmup.sent, "warmup email")} today` : "Warmup off"}</p>
                <p>{m.last_sent_at ? `Last sent ${ago(m.last_sent_at)}` : "No campaign email yet"}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {quiet > 0 && busy.length > 0 && (
        <div className="border-t border-line px-4 py-2 sm:px-5">
          <Button variant="link" size="sm" onClick={() => setAll(!all)}>
            {all ? "Show only mailboxes sending today" : `Show ${plural(quiet, "more mailbox", "more mailboxes")} not in a running campaign`}
          </Button>
        </div>
      )}
    </Card>
  );
}

function Forecast({ r }: { r: TodayReport }) {
  // Today's column includes what already went out.
  const days = r.forecast.map((d, i) => (i === 0 ? { ...d, sends: d.sends + r.sent, due: d.due + r.sent, capacity: d.capacity + r.capacity.sent } : d));
  const top = Math.max(1, ...days.map((d) => Math.max(d.due, d.sends, d.capacity)));
  const height = (v: number) => `${Math.round((v / top) * 100)}%`;
  const last = r.forecast[r.forecast.length - 1];
  const left = last ? last.due - last.sends : 0;
  return (
    <Card>
      <CardHeader title="Next 7 days" description="About how many emails go out each day, with today's leads and settings. New leads, replies and bounces change it." />
      <div className="grid grid-cols-7 gap-1.5 sm:gap-4">
        {days.map((d, i) => {
          const label = i === 0 ? "Today" : format(parseISO(`${d.date}T12:00:00`), "EEE");
          return (
            <div key={d.date} className="flex min-w-0 flex-col items-center" aria-label={`${label}: about ${d.sends} emails of ${d.due} due`} role="group">
              <div className="relative flex h-32 w-full max-w-14 items-end" aria-hidden>
                <div className="absolute inset-x-0 bottom-0 rounded-t-md bg-panel-2" style={{ height: height(d.due) }} />
                <div className="relative w-full rounded-t-md bg-brand" style={{ height: height(d.sends) }} />
                {d.capacity > 0 && <div className="absolute inset-x-0 border-t-2 border-dashed border-faint/70" style={{ bottom: height(d.capacity) }} />}
              </div>
              <p className="mt-2 text-xs font-medium">{label}</p>
              <p className="text-xs tabular-nums text-muted">{compact(d.sends)}</p>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <Key className="bg-brand">Emails going out</Key>
        <Key className="bg-panel-2 ring-1 ring-line-strong">Due</Key>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 border-t-2 border-dashed border-faint/70" />
          Room in your mailboxes
        </span>
      </div>
      {left > 0 && <p className="mt-3 text-[13px] text-muted">After these seven days, about {plural(left, "email")} would still be waiting.</p>}
    </Card>
  );
}

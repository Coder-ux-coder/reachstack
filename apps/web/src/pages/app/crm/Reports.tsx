// /app/crm/reports — sales numbers for a period (deals, revenue closed, meetings, email, calls and texts) against the
// previous period and the team's goals, plus /app/crm/activity-comparison — the same work split by teammate.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, CreditCard, Target, Unplug } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { del, errorMessage, get, post, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { resolveRange, type DateRange } from "@/lib/dates";
import { money, num, plural } from "@/lib/format";
import { useLocalState, usePageTitle } from "@/lib/hooks";
import { useCan, useSession, useWorkspaceZone } from "@/lib/session";
import { Button, Callout, Card, CardHeader, DataTable, Dialog, EmptyState, ErrorState, Field, Input, NativeSelect, NumberInput, Page, PageHeader, Progress, SkeletonRows, Spinner, type Column } from "@/components/ui";
import { BarsChart } from "@/components/charts";
import { RangeSelect } from "@/components/RangeSelect";
import { useMembers } from "./shared";

type Metric =
  | "opportunities_created"
  | "opportunities_won"
  | "pipeline_value"
  | "cash_collected"
  | "closing_rate"
  | "meeting_booking_rate"
  | "average_deal_size"
  | "sales_cycle_days"
  | "annualized_value_closed"
  | "monthly_value_closed"
  | "annual_value_closed"
  | "one_time_value_closed"
  | "meetings_booked"
  | "meetings_completed"
  | "sent_emails"
  | "received_emails"
  | "emails_open"
  | "email_open_rate"
  | "email_reply_rate"
  | "outbound_calls"
  | "inbound_calls"
  | "sent_sms"
  | "received_sms";

type Fmt = "count" | "money" | "pct" | "days";

interface MetricDef {
  key: Metric;
  label: string;
  fmt: Fmt;
  hint?: string;
  goal?: boolean;
  /** Lower is better (shorter sales cycle). */
  invert?: boolean;
}

const GROUPS: Array<{ title: string; metrics: MetricDef[] }> = [
  {
    title: "Deals",
    metrics: [
      { key: "opportunities_created", label: "Opportunities created", fmt: "count", goal: true },
      { key: "opportunities_won", label: "Opportunities won", fmt: "count", goal: true },
      { key: "pipeline_value", label: "Pipeline value", fmt: "money", goal: true, hint: "Open deals right now" },
      { key: "cash_collected", label: "Cash collected", fmt: "money", goal: true },
      { key: "closing_rate", label: "Closing rate", fmt: "pct", goal: true, hint: "Won ÷ opportunities created" },
      { key: "average_deal_size", label: "Average deal size", fmt: "money", goal: true },
      { key: "sales_cycle_days", label: "Sales cycle", fmt: "days", invert: true, hint: "Days from opportunity to won" },
    ],
  },
  {
    title: "Revenue closed",
    metrics: [
      { key: "annualized_value_closed", label: "Annualized value closed", fmt: "money", goal: true, hint: "One-time + monthly × 12 + annual" },
      { key: "monthly_value_closed", label: "Monthly value closed", fmt: "money", goal: true },
      { key: "annual_value_closed", label: "Annual value closed", fmt: "money", goal: true },
      { key: "one_time_value_closed", label: "One-time value closed", fmt: "money", goal: true },
    ],
  },
  {
    title: "Meetings",
    metrics: [
      { key: "meetings_booked", label: "Meetings booked", fmt: "count", goal: true },
      { key: "meetings_completed", label: "Meetings completed", fmt: "count", goal: true },
      { key: "meeting_booking_rate", label: "Meeting booking rate", fmt: "pct", goal: true, hint: "Meetings booked ÷ opportunities" },
    ],
  },
  {
    title: "Email",
    metrics: [
      { key: "sent_emails", label: "Sent emails", fmt: "count", goal: true },
      { key: "received_emails", label: "Received emails", fmt: "count" },
      { key: "emails_open", label: "Emails opened", fmt: "count" },
      { key: "email_open_rate", label: "Email open rate", fmt: "pct", hint: "Opened ÷ sent" },
      { key: "email_reply_rate", label: "Email reply rate", fmt: "pct", hint: "People who replied ÷ emails sent" },
    ],
  },
  {
    title: "Calls & SMS",
    metrics: [
      { key: "outbound_calls", label: "Outbound calls", fmt: "count", goal: true },
      { key: "inbound_calls", label: "Inbound calls", fmt: "count" },
      { key: "sent_sms", label: "Sent SMS", fmt: "count", goal: true },
      { key: "received_sms", label: "Received SMS", fmt: "count" },
    ],
  },
];

interface ReportResponse {
  metrics: Record<Metric, number | null> & { cash_source: "stripe" | null };
  previous: (Record<Metric, number | null> & { cash_source: "stripe" | null }) | null;
  goals: Partial<Record<Metric, number>>;
  stripe: { mode: "key" | "oauth"; account_name: string | null; connected_at: string } | null;
  stripe_oauth_available: boolean;
}

const fmt = (v: number | null | undefined, f: Fmt) => (v === null || v === undefined ? "–" : f === "money" ? money(v) : f === "pct" ? `${v}%` : f === "days" ? plural(v, "day") : num(v));

function Delta({ cur, prev, def }: { cur: number | null; prev: number | null | undefined; def: MetricDef }) {
  if (cur === null || prev === null || prev === undefined) return null;
  const diff = cur - prev;
  if (!diff) return <span className="text-xs text-faint">Same as the previous period</span>;
  const good = def.invert ? diff < 0 : diff > 0;
  const text = def.fmt === "pct" ? `${Math.abs(Math.round(diff * 10) / 10)} pts` : prev ? `${Math.abs(Math.round((diff / prev) * 100))}%` : fmt(Math.abs(diff), def.fmt);
  const Icon = diff > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", good ? "text-ok" : "text-bad")}>
      <Icon size={13} />
      {text}
      <span className="font-normal text-faint">&nbsp;vs previous period</span>
    </span>
  );
}

function GoalDialog({ def, current, onClose }: { def: MetricDef | null; current: number | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<number | null>(current ?? null);
  const [busy, setBusy] = useState(false);
  const save = async (goal: number | null) => {
    if (!def) return;
    setBusy(true);
    try {
      await put("/api/app/crm/reports/goals", { goals: { [def.key]: goal } });
      toast.success(goal === null ? "Goal removed" : "Goal saved");
      qc.invalidateQueries({ queryKey: ["crm", "reports"] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!def}
      onOpenChange={(v) => !v && onClose()}
      size="sm"
      title={def ? `Goal for ${def.label.toLowerCase()}` : "Goal"}
      description="The target for the period you're looking at. Progress shows on the report card."
      footer={
        <>
          {current !== undefined && (
            <Button variant="ghost" className="mr-auto" onClick={() => save(null)} disabled={busy}>
              Remove goal
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={value === null} onClick={() => save(value)}>
            Set
          </Button>
        </>
      }
    >
      <Field label="Goal">
        {(id) => <NumberInput id={id} value={value} onChange={setValue} min={0} step={def?.fmt === "money" ? 1000 : 1} suffix={def?.fmt === "money" ? "USD" : def?.fmt === "pct" ? "%" : def?.fmt === "days" ? "days" : undefined} className="w-full" />}
      </Field>
    </Dialog>
  );
}

function StripeDialog({ open, onOpenChange, oauth }: { open: boolean; onOpenChange: (v: boolean) => void; oauth: boolean }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const r = await post<{ account_name: string | null }>("/api/app/crm/stripe", { api_key: key.trim() });
      toast.success(`Stripe connected${r.account_name ? `: ${r.account_name}` : ""}`);
      setKey("");
      qc.invalidateQueries({ queryKey: ["crm", "reports"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const viaOAuth = async () => {
    try {
      const r = await get<{ url: string }>("/api/app/crm/stripe/oauth-url");
      window.location.assign(r.url);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect Stripe"
      description="Cash collected counts successful Stripe payments from customers whose email address is one of your leads."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!key.trim()} onClick={connect}>
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {oauth && (
          <>
            <Button className="w-full" icon={<CreditCard size={14} />} onClick={viaOAuth}>
              Sign in with Stripe
            </Button>
            <p className="text-center text-xs text-faint">or paste a restricted key</p>
          </>
        )}
        <Field label="Restricted API key" hint="In Stripe, go to Developers → API keys → Create restricted key, and give it read access to Charges and Customers. The key is stored encrypted.">
          {(id) => <Input id={id} value={key} onChange={(e) => setKey(e.target.value)} placeholder="rk_live_…" autoComplete="off" spellCheck={false} />}
        </Field>
      </div>
    </Dialog>
  );
}

function MetricCard({
  def,
  data,
  canGoal,
  onGoal,
  extra,
}: {
  def: MetricDef;
  data: ReportResponse;
  canGoal: boolean;
  onGoal: () => void;
  extra?: ReactNode;
}) {
  const cur = data.metrics[def.key];
  const goal = data.goals[def.key];
  const progress = goal && cur !== null ? Math.round((cur / goal) * 100) : null;
  return (
    <div className="group flex flex-col rounded-xl border border-line bg-panel p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] text-muted">{def.label}</p>
        {canGoal && def.goal && (
          <button type="button" onClick={onGoal} className="-m-1.5 rounded p-1.5 text-faint hover:bg-panel-2 hover:text-text md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100" aria-label={goal ? `Edit goal for ${def.label}` : `Set goal for ${def.label}`}>
            <Target size={14} />
          </button>
        )}
      </div>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{fmt(cur, def.fmt)}</p>
      {def.hint && <p className="text-xs text-faint">{def.hint}</p>}
      {extra}
      <div className="mt-auto space-y-2 pt-3">
        {def.key !== "pipeline_value" && <Delta cur={cur} prev={data.previous?.[def.key]} def={def} />}
        {goal !== undefined && (
          <div>
            <div className="mb-1 flex justify-between text-xs">
              <span className="font-medium text-muted">{progress ?? 0}% of goal</span>
              <span className="text-faint">Goal {fmt(goal, def.fmt)}</span>
            </div>
            <Progress value={Math.min(100, progress ?? 0)} tone={(progress ?? 0) >= 100 ? "ok" : "brand"} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function Reports() {
  usePageTitle("CRM reports");
  const can = useCan();
  const me = useSession();
  const qc = useQueryClient();
  const members = useMembers();
  const zone = useWorkspaceZone();
  const [range, setRange] = useState<DateRange>(() => resolveRange("30d", undefined, zone));
  const [owner, setOwner] = useLocalState("crm-reports-owner", "");
  const [goalFor, setGoalFor] = useState<MetricDef | null>(null);
  const [stripeOpen, setStripeOpen] = useState(false);
  const q = useQuery({
    queryKey: ["crm", "reports", range.start_date, range.end_date, owner],
    queryFn: () => get<ReportResponse>("/api/app/crm/reports", { start_date: range.start_date, end_date: range.end_date, owner: owner || undefined }),
  });
  const d = q.data;

  const disconnect = async () => {
    try {
      await del("/api/app/crm/stripe");
      toast.success("Stripe disconnected");
      qc.invalidateQueries({ queryKey: ["crm", "reports"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const funnel = d
    ? [
        { label: "Opportunities created", n: d.metrics.opportunities_created ?? 0 },
        { label: "Meetings booked", n: d.metrics.meetings_booked ?? 0 },
        { label: "Meetings completed", n: d.metrics.meetings_completed ?? 0 },
        { label: "Won", n: d.metrics.opportunities_won ?? 0 },
      ]
    : [];
  const top = Math.max(1, ...funnel.map((f) => f.n));

  return (
    <Page wide>
      <PageHeader
        title="Reports"
        description="How the pipeline is moving: opportunities, revenue closed, meetings and the outreach behind them."
        actions={
          <>
            <NativeSelect
              size="sm"
              className="w-auto"
              value={owner}
              onChange={setOwner}
              aria-label="Teammate"
              options={[{ value: "", label: "All users" }, { value: "me", label: "Me" }, ...members.filter((m) => m.user_id !== me.user.id).map((m) => ({ value: m.user_id, label: m.name }))]}
            />
            <RangeSelect value={range} onChange={setRange} />
          </>
        }
      />
      {q.isError && !d ? (
        <Card>
          <ErrorState title="The report couldn't be loaded" error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : q.isLoading || !d ? (
        <SkeletonRows rows={8} />
      ) : (
        <div className="space-y-8">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">{g.title}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {g.metrics.map((def) => (
                  <MetricCard
                    key={def.key}
                    def={def}
                    data={d}
                    canGoal={can.write}
                    onGoal={() => setGoalFor(def)}
                    extra={
                      def.key === "cash_collected" ? (
                        d.stripe ? (
                          <p className="mt-1 flex items-center gap-1 text-xs text-faint">
                            From Stripe{d.stripe.account_name ? ` · ${d.stripe.account_name}` : ""}
                            {can.admin && (
                              <button type="button" className="ml-1 inline-flex items-center gap-0.5 rounded px-1 text-faint hover:bg-panel-2 hover:text-text" onClick={disconnect}>
                                <Unplug size={11} /> Disconnect
                              </button>
                            )}
                          </p>
                        ) : can.admin ? (
                          <Button size="xs" className="mt-2 self-start" icon={<CreditCard size={13} />} onClick={() => setStripeOpen(true)}>
                            Connect Stripe
                          </Button>
                        ) : (
                          <p className="mt-1 text-xs text-faint">An admin can connect Stripe to track payments.</p>
                        )
                      ) : undefined
                    }
                  />
                ))}
              </div>
            </section>
          ))}

          <Card>
            <CardHeader title="Conversion" description="How opportunities in this period moved through your funnel." />
            {!d.metrics.opportunities_won ? <Callout tone="info" className="mb-4">Mark opportunities as "Won" to see the full conversion rate.</Callout> : null}
            <div className="space-y-3">
              {funnel.map((f, i) => (
                <div key={f.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[13px] sm:grid-cols-[12rem_1fr_6rem]">
                  <span className="truncate text-muted">{f.label}</span>
                  <div className="h-6 overflow-hidden rounded-md bg-panel-2">
                    <div className="h-full rounded-md bg-brand" style={{ width: `${Math.max(f.n ? 2 : 0, (f.n / top) * 100)}%`, opacity: 1 - i * 0.18 }} />
                  </div>
                  <span className="text-right tabular-nums">
                    {num(f.n)}
                    {i > 0 && funnel[0]!.n ? <span className="ml-1 text-xs text-faint">{Math.round((f.n / funnel[0]!.n) * 100)}%</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
      <GoalDialog key={goalFor?.key ?? "none"} def={goalFor} current={goalFor ? d?.goals[goalFor.key] : undefined} onClose={() => setGoalFor(null)} />
      <StripeDialog open={stripeOpen} onOpenChange={setStripeOpen} oauth={!!d?.stripe_oauth_available} />
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// /app/crm/activity-comparison

interface MemberActivity {
  user_id: string;
  name: string;
  calls: number;
  sms: number;
  meetings_booked: number;
  notes: number;
  tasks_completed: number;
  deals_won: number;
  value_won: number;
  open_deals: number;
}

type ActivityKey = Exclude<keyof MemberActivity, "user_id" | "name">;

const ACTIVITY: Array<{ key: ActivityKey; label: string; money?: boolean }> = [
  { key: "calls", label: "Calls" },
  { key: "sms", label: "SMS sent" },
  { key: "meetings_booked", label: "Meetings booked" },
  { key: "tasks_completed", label: "Tasks completed" },
  { key: "notes", label: "Notes" },
  { key: "deals_won", label: "Deals won" },
  { key: "value_won", label: "Value won", money: true },
  { key: "open_deals", label: "Open deals" },
];

export function ActivityComparison() {
  usePageTitle("Activity comparison");
  const zone = useWorkspaceZone();
  const [range, setRange] = useState<DateRange>(() => resolveRange("30d", undefined, zone));
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "deals_won", dir: "desc" });
  const [chart, setChart] = useLocalState<ActivityKey>("crm-activity-chart", "calls");
  const q = useQuery({
    queryKey: ["crm", "activity-comparison", range.start_date, range.end_date],
    queryFn: () => get<{ items: MemberActivity[] }>("/api/app/crm/activity-comparison", { start_date: range.start_date, end_date: range.end_date }),
  });
  const rows = useMemo(() => {
    const items = [...(q.data?.items ?? [])];
    const k = sort.key as keyof MemberActivity;
    items.sort((a, b) => {
      const x = a[k];
      const y = b[k];
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.dir === "asc" ? c : -c;
    });
    return items;
  }, [q.data, sort]);

  const columns: Column<MemberActivity>[] = [
    { key: "name", header: "Teammate", sortable: true, cell: (r) => <span className="font-medium">{r.name}</span> },
    ...ACTIVITY.map((a, i) => ({
      key: a.key,
      header: a.label,
      sortable: true,
      className: "text-right tabular-nums",
      headerClassName: "text-right",
      hideBelow: (i < 2 ? undefined : i < 5 ? "md" : "lg") as Column<MemberActivity>["hideBelow"],
      cell: (r: MemberActivity) => (a.money ? money(r[a.key]) : num(r[a.key])),
    })),
  ];
  const meta = ACTIVITY.find((a) => a.key === chart) ?? ACTIVITY[0]!;

  return (
    <Page wide>
      <PageHeader title="Activity comparison" description="Calls, texts, meetings, tasks and deals for each teammate over the same period." actions={<RangeSelect value={range} onChange={setRange} />} />
      {q.isLoading ? (
        <SkeletonRows rows={5} />
      ) : q.isError && !rows.length ? (
        <Card>
          <ErrorState title="The comparison couldn't be loaded" error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !rows.length ? (
        <Card>
          <EmptyState title="No teammates yet" description="Invite your team from Workspace & members to compare their activity." />
        </Card>
      ) : (
        <div className="space-y-6">
          <Card padded={false}>
            <DataTable rows={rows} columns={columns} rowKey={(r) => r.user_id} sort={sort} onSortChange={setSort} />
          </Card>
          <Card>
            <CardHeader
              title="Compare"
              actions={<NativeSelect size="sm" className="w-auto" value={chart} onChange={(v) => setChart(v as ActivityKey)} aria-label="Metric" options={ACTIVITY.map((a) => ({ value: a.key, label: a.label }))} />}
            />
            <BarsChart horizontal xKey="name" height={Math.max(160, rows.length * 44)} data={rows.map((r) => ({ name: r.name, [chart]: r[chart] }))} series={[{ key: chart, label: meta.label }]} />
          </Card>
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// /app/oauth/callback/stripe — Stripe sends admins back here after "Sign in with Stripe".

export function StripeCallback() {
  usePageTitle("Connecting Stripe");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(params.get("error_description") ?? params.get("error"));
  const code = params.get("code");
  const started = useRef(false);
  useEffect(() => {
    if (!code || error || started.current) return;
    started.current = true;
    post("/api/app/crm/stripe/oauth", { code, state: params.get("state") ?? undefined })
      .then(() => {
        toast.success("Stripe connected");
        navigate("/app/crm/reports", { replace: true });
      })
      .catch((e) => setError(errorMessage(e)));
  }, [code, error, navigate, params]);
  return (
    <Page>
      <Card className="mx-auto max-w-md">
        {error || !code ? (
          <EmptyState
            title="Stripe wasn't connected"
            description={error ?? "The sign-in didn't finish. Try again from the reports page."}
            action={<Button onClick={() => navigate("/app/crm/reports", { replace: true })}>Back to reports</Button>}
          />
        ) : (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
            <Spinner /> Connecting Stripe…
          </div>
        )}
      </Card>
    </Page>
  );
}

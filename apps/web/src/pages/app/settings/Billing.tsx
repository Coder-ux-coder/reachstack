import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PlanDef, ProductKey } from "@reachstack/shared";
import { Check, CreditCard, ExternalLink, FileText, Sparkles } from "lucide-react";
import { errorMessage, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dateOnly, money, num } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan, useSession } from "@/lib/session";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, Field, Progress, Segmented, Select, Textarea } from "@/components/ui";
import { SettingsHeader } from "./parts";

interface Meter {
  used?: number;
  limit?: number | null;
  balance?: number | null;
  monthly?: number | null;
}

interface Overview {
  stripe_enabled: boolean;
  self_hosted: boolean;
  on_trial: boolean;
  trial_expired: boolean;
  trial_ends_at: string | null;
  plan_ids: Record<string, string | null>;
  subscriptions: Array<{ id: string; product: string; plan_id: string; plan_name: string; interval: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean }>;
  usage: Record<"uploaded_contacts" | "monthly_emails" | "email_accounts" | "credits" | "verification_credits" | "visitor_credits", Meter>;
  invoices: Array<{ id: string; number: string; description: string | null; amount: number; currency: string; status: string; pdf_url: string | null; created_at: string }>;
  plans: PlanDef[];
  verification_packs: Array<{ id: string; credits: number; price: number }>;
}

export const BILLING_KEY = ["billing-overview"];

const PRODUCTS: Array<{ key: ProductKey; title: string; blurb: string }> = [
  { key: "outreach", title: "Outreach", blurb: "Sending, warmup, Unibox and analytics." },
  { key: "credits", title: "Lead Finder credits", blurb: "Search, reveal and enrich leads." },
  { key: "bundle", title: "Outreach + credits bundle", blurb: "Both at a lower combined price." },
  { key: "crm", title: "CRM", blurb: "Pipeline, tasks, calls and SMS." },
  { key: "website_visitors", title: "Website visitors", blurb: "Identify companies visiting your site." },
  { key: "inbox_placement", title: "Inbox placement", blurb: "Automated seed-list testing." },
];

function UsageMeter({ label, used, limit, hint }: { label: string; used: number | null | undefined; limit: number | null | undefined; hint?: string }) {
  const unlimited = limit === null || limit === undefined;
  const pct = !unlimited && limit ? Math.min(100, ((used ?? 0) / limit) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">
          {used === null || used === undefined ? "—" : num(used)}
          {unlimited ? " · unlimited" : ` / ${num(limit)}`}
        </span>
      </div>
      {!unlimited && <Progress className="mt-1.5" value={pct} tone={pct >= 90 ? "bad" : pct >= 75 ? "warn" : "brand"} />}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Credits are a balance, not a limit: "1,000 left", or "Unlimited" where nothing is charged. */
function BalanceMeter({ label, balance, free, hint }: { label: string; balance: number | null | undefined; free: boolean; hint?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">{free ? "Unlimited" : balance === null || balance === undefined ? "—" : `${num(balance)} left`}</span>
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function PlanCard({ plan, interval, current, onChoose, busy, disabled }: { plan: PlanDef; interval: "month" | "year"; current: boolean; onChoose: () => void; busy: boolean; disabled: boolean }) {
  const price = interval === "year" ? plan.yearly_price : plan.monthly_price;
  return (
    <div className={cn("flex flex-col rounded-xl border p-4", plan.popular ? "border-brand shadow-card" : "border-line", current && "bg-brand-soft/30")}>
      <div className="flex items-center gap-2">
        <p className="font-semibold">{plan.name}</p>
        {plan.popular && <Badge tone="brand">Popular</Badge>}
        {current && <Badge tone="ok">Current</Badge>}
      </div>
      <p className="mt-1 text-[13px] text-muted">{plan.description}</p>
      <p className="mt-3">
        <span className="text-2xl font-semibold tabular-nums">{money(price)}</span>
        <span className="text-[13px] text-muted"> /month{interval === "year" ? ", billed yearly" : ""}</span>
      </p>
      <ul className="mt-3 flex-1 space-y-1 text-[13px]">
        {plan.features.map((f) => (
          <li key={f} className="flex gap-2">
            <Check size={14} className="mt-0.5 shrink-0 text-ok" /> {f}
          </li>
        ))}
      </ul>
      <Button className="mt-4" variant={plan.popular ? "primary" : "secondary"} disabled={current || disabled} loading={busy} onClick={onChoose}>
        {current ? "Your plan" : "Choose"}
      </Button>
    </div>
  );
}

/** /app/settings/billing */
export default function Billing() {
  usePageTitle("Billing & usage");
  const qc = useQueryClient();
  const can = useCan();
  const me = useSession();
  const [params, setParams] = useSearchParams();
  const [interval, setInterval] = useState<"month" | "year">("year");
  const [product, setProduct] = useState<ProductKey>("outreach");
  const [busy, setBusy] = useState<string | null>(null);
  const data = useQuery({ queryKey: BILLING_KEY, queryFn: () => get<Overview>("/api/app/billing/overview") });

  useEffect(() => {
    const result = params.get("checkout");
    if (!result) return;
    if (result === "success") {
      toast.success("Payment received. Your plan updates in a few seconds.");
      // The webhook may land a moment after the redirect.
      const t = setTimeout(() => qc.invalidateQueries({ queryKey: BILLING_KEY }), 4_000);
      setParams({}, { replace: true });
      return () => clearTimeout(t);
    }
    setParams({}, { replace: true });
  }, [params, qc, setParams]);

  const go = async (key: string, path: string, payload: Record<string, unknown> = {}) => {
    setBusy(key);
    try {
      const r = await post<{ url: string }>(path, payload);
      window.location.assign(r.url);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  if (!data.data) return <SettingsHeader title="Billing & usage" />;
  const d = data.data;
  const manage = can.admin && d.stripe_enabled && !d.self_hosted;
  const owner = !!me.features.owner;
  const planNames = Object.values(d.plan_ids)
    .filter(Boolean)
    .map((id) => d.plans.find((p) => p.id === id)?.name ?? id);

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Billing & usage"
        description="Plans, limits and what this workspace has used."
        actions={
          manage &&
          d.subscriptions.length > 0 && (
            <Button icon={<CreditCard size={14} />} loading={busy === "portal"} onClick={() => go("portal", "/api/app/billing/portal")}>
              Payment methods & invoices
            </Button>
          )
        }
      />

      {d.self_hosted ? (
        <Callout tone="ok" title="Unlimited">
          {owner ? (
            <>
              Nothing here is limited or charged. You set other workspaces&rsquo; limits in{" "}
              <Link to="/app/settings/installation/workspaces" className="font-medium text-brand-text hover:underline">
                Installation → Workspaces
              </Link>
              .
            </>
          ) : (
            "The owner of this installation doesn't limit this workspace, so nothing here is charged."
          )}
        </Callout>
      ) : !d.stripe_enabled ? (
        <Callout tone={d.trial_expired ? "bad" : "info"} title={planNames.length ? `Plan: ${planNames.join(", ")}` : d.trial_expired ? "Your trial has ended" : d.on_trial ? `Trial ends ${dateOnly(d.trial_ends_at)}` : "No plan yet"}>
          {d.trial_expired && !planNames.length ? "Campaigns are paused. " : ""}
          This installation doesn&rsquo;t take payments:{" "}
          {owner ? (
            <>
              set this workspace&rsquo;s limits in{" "}
              <Link to="/app/settings/installation/workspaces" className="font-medium text-brand-text hover:underline">
                Installation → Workspaces
              </Link>
              .
            </>
          ) : (
            "its owner sets this workspace's plan and limits. Ask them if you need more."
          )}
        </Callout>
      ) : d.trial_expired ? (
        <Callout tone="bad" title="Your trial has ended">
          Campaigns are paused until you choose a plan below.
        </Callout>
      ) : d.on_trial ? (
        <Callout tone="info" title={`Trial ends ${dateOnly(d.trial_ends_at)}`}>
          Choose a plan any time; trial limits apply until then.
        </Callout>
      ) : null}

      <Card>
        <CardHeader title="Usage" description="Emails reset on the 1st of each month (UTC)." />
        <div className="grid gap-5 sm:grid-cols-2">
          <UsageMeter label="Uploaded contacts" used={d.usage.uploaded_contacts.used} limit={d.usage.uploaded_contacts.limit} />
          <UsageMeter label="Emails this month" used={d.usage.monthly_emails.used} limit={d.usage.monthly_emails.limit} />
          <UsageMeter label="Email accounts" used={d.usage.email_accounts.used} limit={d.usage.email_accounts.limit} />
          <BalanceMeter label="Lead Finder credits" balance={d.usage.credits.balance} free={d.self_hosted} hint={!d.self_hosted && d.usage.credits.monthly ? `${num(d.usage.credits.monthly)} added each paid month` : undefined} />
          <BalanceMeter label="Verification credits" balance={d.usage.verification_credits.balance} free={d.self_hosted} />
          {d.self_hosted ? (
            <BalanceMeter label="Website visitor credits" balance={null} free />
          ) : (
            <UsageMeter label="Website visitor credits" used={d.usage.visitor_credits.balance} limit={d.usage.visitor_credits.limit} />
          )}
        </div>
      </Card>

      {d.subscriptions.length > 0 && (
        <Card>
          <CardHeader title="Subscriptions" />
          <div className="divide-y divide-line">
            {d.subscriptions.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">
                    {s.plan_name} <span className="font-normal text-muted">· billed {s.interval === "year" ? "yearly" : "monthly"}</span>
                  </p>
                  <p className="text-xs text-muted">
                    {s.cancel_at_period_end ? `Ends ${dateOnly(s.current_period_end)}` : s.current_period_end ? `Renews ${dateOnly(s.current_period_end)}` : ""}
                    {s.status !== "active" && <Badge tone="warn" className="ml-2">{s.status.replace("_", " ")}</Badge>}
                  </p>
                </div>
                {can.owner &&
                  (s.cancel_at_period_end ? (
                    <Button size="sm" onClick={() => post(`/api/app/billing/subscriptions/${s.id}/cancel`, { resume: true }).then(() => qc.invalidateQueries({ queryKey: BILLING_KEY }), (e) => toast.error(errorMessage(e)))}>
                      Keep plan
                    </Button>
                  ) : (
                    <Link to={`/app/settings/cancel?subscription=${s.id}`} className="text-[13px] text-muted hover:text-bad">
                      Cancel
                    </Link>
                  ))}
              </div>
            ))}
          </div>
        </Card>
      )}

      {!d.self_hosted && d.stripe_enabled && (
        <Card>
          <CardHeader
            title="Plans"
            description={PRODUCTS.find((p) => p.key === product)?.blurb}
            actions={
              <Segmented
                size="sm"
                value={interval}
                onChange={setInterval}
                options={[
                  { value: "month", label: "Monthly" },
                  { value: "year", label: "Yearly · save ~20%" },
                ]}
              />
            }
          />
          <div className="mb-4 flex flex-wrap gap-1.5">
            {PRODUCTS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setProduct(p.key)}
                className={cn("rounded-full border px-3 py-1 text-[13px]", product === p.key ? "border-brand bg-brand-soft text-brand-text" : "border-line text-muted hover:border-line-strong")}
              >
                {p.title}
              </button>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {d.plans
              .filter((p) => p.product === product)
              .map((p) => (
                <PlanCard
                  key={p.id}
                  plan={p}
                  interval={interval}
                  current={d.plan_ids[p.product] === p.id}
                  busy={busy === p.id}
                  disabled={!manage}
                  onChoose={() => go(p.id, "/api/app/billing/checkout", { plan_id: p.id, interval })}
                />
              ))}
          </div>
          {!can.admin && <p className="mt-3 text-xs text-muted">Only workspace admins can change plans.</p>}
        </Card>
      )}

      {!d.self_hosted && d.stripe_enabled && (
        <Card>
          <CardHeader title="Verification credits" description="One-time packs for checking email addresses. They don't expire." />
          <div className="grid gap-3 sm:grid-cols-3">
            {d.verification_packs.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
                <div>
                  <p className="text-[13px] font-medium">{num(p.credits)} credits</p>
                  <p className="text-xs text-muted">{money(p.price)}</p>
                </div>
                <Button size="sm" disabled={!manage} loading={busy === p.id} onClick={() => go(p.id, "/api/app/billing/credit-packs", { pack_id: p.id })}>
                  Buy
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {(d.stripe_enabled || d.invoices.length > 0) && (
        <Card>
          <CardHeader title="Invoices" />
          {d.invoices.length ? (
            <div className="divide-y divide-line">
              {d.invoices.map((i) => (
                <div key={i.id} className="flex items-center gap-3 py-2 text-[13px]">
                  <FileText size={15} className="text-faint" />
                  <span className="w-28 text-muted">{dateOnly(i.created_at)}</span>
                  <span className="min-w-0 flex-1 truncate">{i.description ?? i.number}</span>
                  <span className="tabular-nums">{money(i.amount, i.currency.toUpperCase())}</span>
                  {i.pdf_url && (
                    <a href={i.pdf_url} target="_blank" rel="noreferrer noopener" className="text-brand-text hover:underline" aria-label={`Open invoice ${i.number}`}>
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState className="py-6" icon={<FileText size={20} />} title="No invoices" />
          )}
        </Card>
      )}
    </div>
  );
}

const REASONS = [
  { value: "too_expensive", label: "It costs too much" },
  { value: "not_using", label: "I'm not using it enough" },
  { value: "missing_feature", label: "A feature I need is missing" },
  { value: "deliverability", label: "Deliverability wasn't good enough" },
  { value: "switching", label: "Moving to another tool" },
  { value: "temporary", label: "Pausing outreach for now" },
  { value: "other", label: "Something else" },
];

/** /app/settings/cancel — a short exit survey, then cancellation at the end of the paid period. */
export function CancelPlan() {
  usePageTitle("Cancel plan");
  const qc = useQueryClient();
  const nav = useNavigate();
  const can = useCan();
  const [params] = useSearchParams();
  const data = useQuery({ queryKey: BILLING_KEY, queryFn: () => get<Overview>("/api/app/billing/overview") });
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const subs = (data.data?.subscriptions ?? []).filter((s) => !s.cancel_at_period_end);
  const chosen = subs.filter((s) => !params.get("subscription") || s.id === params.get("subscription"));

  const cancel = async () => {
    setBusy(true);
    try {
      for (const s of chosen) await post(`/api/app/billing/subscriptions/${s.id}/cancel`, { reason, feedback: feedback.trim() || undefined });
      await qc.invalidateQueries({ queryKey: BILLING_KEY });
      toast.success("Cancelled. You keep access until the end of the paid period.");
      nav("/app/settings/billing");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl space-y-5">
      <SettingsHeader title="Cancel plan" description="You keep everything until the end of the period you've paid for." />
      {!can.owner ? (
        <Callout tone="warn">Only the workspace owner can cancel a plan.</Callout>
      ) : !chosen.length ? (
        <Callout tone="info">
          There's nothing to cancel. <Link to="/app/settings/billing" className="font-medium text-brand-text hover:underline">Back to billing</Link>
        </Callout>
      ) : (
        <Card className="space-y-4">
          <p className="text-[13px]">
            Cancelling: <span className="font-medium">{chosen.map((s) => s.plan_name).join(", ")}</span>
            {chosen[0]?.current_period_end && <span className="text-muted"> · access until {dateOnly(chosen[0].current_period_end)}</span>}
          </p>
          <Field label="Why are you leaving?">{(id) => <Select id={id} value={reason} onChange={setReason} placeholder="Choose a reason" options={REASONS} />}</Field>
          <Field label="Anything we could have done better?" optional>
            {(id) => <Textarea id={id} rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />}
          </Field>
          {reason === "temporary" && (
            <Callout tone="info" title="Pausing instead?">
              Pausing campaigns stops all sending without cancelling; warmup keeps your mailboxes ready.
            </Callout>
          )}
          <div className="flex gap-2">
            <Button onClick={() => nav("/app/settings/billing")}>Keep my plan</Button>
            <Button variant="danger" loading={busy} disabled={!reason} onClick={cancel}>
              Cancel plan
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

/** /app/settings/expired — shown when the trial ended without a plan. */
export function TrialExpired() {
  usePageTitle("Trial ended");
  const data = useQuery({ queryKey: BILLING_KEY, queryFn: () => get<Overview>("/api/app/billing/overview") });
  if (!data.data) return null;
  // Only a workspace whose trial really ended belongs here.
  if (!data.data.trial_expired) return <Navigate to="/app/settings/billing" replace />;
  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <Sparkles size={28} className="mx-auto text-brand-text" />
      <h1 className="mt-4 text-xl font-semibold">Your trial has ended</h1>
      <p className="mt-2 text-[13px] text-muted">Your accounts, leads and campaigns are safe. Choose a plan to start sending again.</p>
      <Link to="/app/settings/billing" className="mt-6 inline-flex rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-brand hover:bg-brand/90">
        See plans
      </Link>
    </div>
  );
}

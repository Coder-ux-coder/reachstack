// Website visitors → Credits & plan: this month's identifications against the plan limit, credits for unlocking
// visits over the limit and revealing contacts, and recent credit use.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Unlock } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, get, post } from "@/lib/api";
import { dateTime, num, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { Button, ButtonLink, Callout, Card, CardHeader, DataTable, NumberInput, Progress, SkeletonRows, StatCard } from "@/components/ui";
import { invalidateVisitors, VW_KEY, type VisitorBilling as Billing } from "./api";

const REASONS: Record<string, string> = {
  "website_visitors:unlock": "Unlocked a visit over the monthly limit",
  "website_visitors:unlock_refund": "Refund: no company behind an unlocked visit",
  "website_visitors:reveal": "Revealed a contact",
  "website_visitors:add": "Revealed contacts added as leads",
  "website_visitors:view": "Revealed a contact for a view",
};

export function VisitorBilling() {
  usePageTitle("Website visitor credits");
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...VW_KEY, "billing"], queryFn: () => get<Billing>("/api/app/website-visitors/billing") });
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <SkeletonRows rows={5} />;
  if (q.isError || !q.data) return <Callout tone="bad">{errorMessage(q.error)}</Callout>;
  const b = q.data;
  const waiting = b.waiting_over_limit;
  const n = Math.max(1, Math.min(count ?? Math.min(waiting, b.credits_available ?? waiting), waiting, 500));

  const unlock = async () => {
    setBusy(true);
    try {
      const r = await post<{ identified: number; unresolved: number; waiting: number }>("/api/app/website-visitors/identify", { limit: n });
      if (r.identified) toast.success(`${plural(r.identified, "website visitor")} unlocked${r.unresolved ? ` (${num(r.unresolved)} had no company and were refunded)` : ""}`);
      else if (r.unresolved) toast.info(`No companies found for ${plural(r.unresolved, "visit")}; the credits were refunded`);
      else toast.error("Error unlocking, please try again. Check that you have credits left.");
      await invalidateVisitors(qc);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (b.self_hosted) {
    return (
      <div className="space-y-5">
        <Callout tone="ok" title="Unlimited on this server">
          Billing isn't set up on this installation, so identifying companies and revealing contacts aren't metered. Lookups still count against your IP lookup plan's own limits.
        </Callout>
        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard label="Companies identified this month" value={num(b.identified_this_month)} />
          <StatCard label="IP lookup" value={b.lookup ? "Connected" : "Not set up"} sub={b.lookup === "server" ? "Server token" : b.lookup === "workspace" ? "Workspace token" : "Add a token on the Setup page"} />
        </div>
      </div>
    );
  }

  const limit = b.monthly_limit;
  const left = limit === null ? null : Math.max(0, limit - b.identified_this_month);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <p className="text-[13px] text-muted">Plan</p>
          <p className="mt-2 text-xl font-semibold">{b.plan?.name ?? (b.on_trial ? "Trial" : "No visitor plan")}</p>
          <p className="mt-1 text-xs text-muted">{b.plan ? `$${b.plan.monthly_price}/month` : "Upgrade to identify more companies each month."}</p>
          {can.perm("billing") && (
            <ButtonLink size="sm" className="mt-3" to="/app/settings/billing">
              {b.plan ? "Change plan" : "Upgrade plan"}
            </ButtonLink>
          )}
        </Card>
        <Card>
          <p className="text-[13px] text-muted">Companies identified this month</p>
          <p className="mt-2 text-xl font-semibold tabular-nums">
            {num(b.identified_this_month)}
            {limit !== null && <span className="text-sm font-normal text-muted"> / {num(limit)}</span>}
          </p>
          {limit !== null && <Progress className="mt-3" value={b.identified_this_month} max={Math.max(1, limit)} tone={left === 0 ? "bad" : "brand"} />}
          <p className="mt-2 text-xs text-muted">{limit === null ? "Unlimited" : left ? `${num(left)} left this month` : "Limit reached. New visits wait until you unlock them or the month ends."}</p>
        </Card>
        <StatCard
          label="Available credits"
          value={num(b.credits_available ?? 0)}
          sub="1 credit unlocks a visit over the limit (refunded when no company is found) or reveals a contact."
        />
      </div>

      {waiting > 0 && (
        <Card>
          <CardHeader title={`You have ${plural(waiting, "unresolved website visitor")}`} description="They arrived after this month's limit was reached. Unlock them with credits: you're only charged for visits that turn out to be a company." />
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[13px]">
              <span className="mb-1.5 block font-medium">Amount</span>
              <NumberInput value={count ?? n} onChange={setCount} min={1} max={Math.min(500, waiting)} aria-label="Visits to unlock" />
            </label>
            <Button variant="primary" icon={<Unlock size={14} />} loading={busy} disabled={!can.write || !b.lookup} onClick={() => void unlock()}>
              Unlock visitors
            </Button>
            {!b.lookup && <span className="text-xs text-warn">Set up the IP lookup first.</span>}
          </div>
        </Card>
      )}

      <Card padded={false}>
        <div className="p-5 pb-3">
          <CardHeader className="mb-0" title="Credit use" description="Website visitor charges and refunds." />
        </div>
        <DataTable
          className="rounded-none border-x-0 border-b-0 shadow-none"
          rows={b.ledger}
          rowKey={(l) => l.id}
          columns={[
            { key: "when", header: "Date", cell: (l) => <span className="text-muted">{dateTime(l.created_at)}</span> },
            { key: "what", header: "Activity", cell: (l) => REASONS[l.reason] ?? l.reason },
            { key: "delta", header: "Credits", className: "text-right tabular-nums", cell: (l) => <span className={l.delta < 0 ? "" : "text-ok"}>{l.delta > 0 ? `+${num(l.delta)}` : num(l.delta)}</span> },
          ]}
          empty={<p className="px-4 py-10 text-center text-[13px] text-muted">No website visitor credits used yet.</p>}
        />
      </Card>
    </div>
  );
}

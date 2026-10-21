// Cards the copilot shows for its tool calls: results (analytics, lead filters, sequences...), approvals for
// actions that change things, and multiple-choice questions.
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Brain,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Globe,
  Inbox,
  Mail,
  MessageSquare,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { Badge, Button, ButtonLink, Dialog, Field, Input, NativeSelect, Segmented, Spinner, useConfirm } from "@/components/ui";
import { TrendChart } from "@/components/charts";
import { errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dateTime, money, num, pct as pctOf, plural } from "@/lib/format";
import { queryClient } from "@/lib/query";
import { useCan } from "@/lib/session";
import { useCampaignNames } from "@/lib/pickers";
import { startStream, threadKey, type ChatAction, type ThreadData } from "./api";
import { ScrollX } from "@/components/ui/scroll-x";

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const n = (v: unknown) => Number(v ?? 0);

function updateAction(threadId: string, action: ChatAction) {
  queryClient.setQueryData<ThreadData>(threadKey(threadId), (d) => (d ? { ...d, actions: d.actions.map((a) => (a.id === action.id ? action : a)) } : d));
}

function Shell({ icon, title, meta, children, tone, className, actions }: { icon: ReactNode; title: ReactNode; meta?: ReactNode; children?: ReactNode; tone?: "warn" | "bad" | "ok"; className?: string; actions?: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-panel", tone === "warn" ? "border-warn/40" : tone === "bad" ? "border-bad/40" : "border-line", className)}>
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", tone === "warn" ? "bg-warn-soft text-warn" : tone === "bad" ? "bg-bad-soft text-bad" : tone === "ok" ? "bg-ok-soft text-ok" : "bg-brand-soft text-brand-text")}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">{title}</p>
          {meta && <p className="truncate text-xs text-muted">{meta}</p>}
        </div>
        {actions}
      </div>
      {children && <div className="px-3.5 py-3">{children}</div>}
    </div>
  );
}

export function Working({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[13px] text-muted">
      <Spinner size={14} />
      <span className="shimmer-text">{label}…</span>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-panel-2 px-3 py-2">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** `text`: every column holds words (left-aligned); otherwise columns after the first are numbers. */
function MiniTable({ head, rows, empty = "Nothing to show", text }: { head: string[]; rows: ReactNode[][]; empty?: string; text?: boolean }) {
  if (!rows.length) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <ScrollX className="-mx-3.5">
      <table className="w-full text-left text-[13px]">
        <thead className="text-xs text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={cn("whitespace-nowrap pb-1.5 font-medium", i > 0 ? cn("px-2.5 last:pr-3.5", !text && "text-right") : "pl-3.5 pr-2.5")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((c, j) => (
                <td key={j} className={cn("py-1.5", j === 0 ? "max-w-[16rem] truncate pl-3.5 pr-2.5" : text ? "max-w-[12rem] truncate px-2.5 last:pr-3.5" : "whitespace-nowrap px-2.5 text-right tabular-nums last:pr-3.5")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollX>
  );
}

// ---------- Results ----------

function OverviewCard({ c }: { c: Row }) {
  const acc = (c.accounts ?? {}) as Row;
  const camp = (c.campaigns ?? {}) as Row;
  const last = c.last_30_days as Row | null;
  return (
    <Shell icon={<ShieldCheck size={15} />} title="Workspace overview" meta="Accounts, campaigns and the last 30 days">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Email accounts" value={`${num(n(acc.active))} / ${num(n(acc.total))} active`} />
        <Tile label="Warmup on" value={num(n(acc.warmup_on))} />
        <Tile label="Accounts with errors" value={<span className={n(acc.errors) ? "text-bad" : ""}>{num(n(acc.errors))}</span>} />
        <Tile label="Active campaigns" value={`${num(n(camp.active))} / ${num(n(camp.total))}`} />
        {last && (
          <>
            <Tile label="Sent (30 days)" value={num(n(last.sent))} />
            <Tile label="Replies" value={num(n(last.replies))} />
            <Tile label="Opportunities" value={num(n(last.opportunities))} />
            <Tile label="Pipeline value" value={money(n(last.value))} />
          </>
        )}
      </div>
    </Shell>
  );
}

function CampaignsCard({ c }: { c: Row }) {
  const items = (c.items ?? []) as Row[];
  return (
    <Shell icon={<Rocket size={15} />} title="Campaigns" meta={`${num(n(c.total))} found`}>
      <ul className="divide-y divide-line">
        {items.map((x) => (
          <li key={s(x.id)} className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
            <Link to={`/app/campaign/${s(x.id)}/analytics`} className="truncate font-medium hover:underline">
              {s(x.name)}
            </Link>
            <Badge tone={x.status === "Active" ? "ok" : x.status === "Paused" ? "warn" : "neutral"}>{s(x.status)}</Badge>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function AnalyticsCard({ c }: { c: Row }) {
  const [all, setAll] = useState(false);
  const t = (c.totals ?? {}) as Row;
  const range = (c.range ?? {}) as Row;
  const rows = ((c.rows ?? []) as Row[]).slice().sort((a, b) => n(b.emails_sent) - n(a.emails_sent));
  const shown = all ? rows : rows.slice(0, 6);
  const daily = c.daily as Row[] | undefined;
  return (
    <Shell icon={<Sparkles size={15} />} title="Campaign analytics" meta={`${s(range.start)} to ${s(range.end)}`}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Emails sent" value={num(n(t.emails_sent))} />
        <Tile label="Open rate" value={pctOf(n(t.unique_opens), n(t.contacted))} />
        <Tile label="Reply rate" value={pctOf(n(t.unique_replies), n(t.contacted))} />
        <Tile label="Opportunities" value={`${num(n(t.opportunities))}${n(t.opportunity_value) ? ` · ${money(n(t.opportunity_value))}` : ""}`} />
      </div>
      {daily && daily.length > 1 && (
        <div className="mt-3">
          <TrendChart
            height={170}
            data={daily}
            series={[
              { key: "sent", label: "Sent" },
              { key: "unique_replies", label: "Replies" },
            ]}
          />
        </div>
      )}
      <div className="mt-3">
        <MiniTable
          head={["Campaign", "Sent", "Replies", "Opps"]}
          rows={shown.map((r) => [
            <Link key="l" to={`/app/campaign/${s(r.id)}/analytics`} className="font-medium hover:underline">
              {s(r.name)}
            </Link>,
            num(n(r.emails_sent)),
            <span key="r" title={`Reply rate ${n(r.reply_rate_pct)}% · open rate ${n(r.open_rate_pct)}%`}>
              {num(n(r.unique_replies))}
              {n(r.unique_replies) > 0 && <span className="ml-1 text-xs text-muted">{n(r.reply_rate_pct)}%</span>}
            </span>,
            num(n(r.opportunities)),
          ])}
          empty="No campaigns in this range"
        />
        {rows.length > 6 && (
          <button type="button" onClick={() => setAll(!all)} className="mt-2 text-xs font-medium text-brand-text hover:underline">
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </Shell>
  );
}

function AccountsCard({ c }: { c: Row }) {
  const items = (c.items ?? []) as Row[];
  return (
    <Shell icon={<Mail size={15} />} title="Email accounts" meta={plural(n(c.total), "account")}>
      <MiniTable
        head={["Account", "Status", "Warmup", "Score", "Daily limit"]}
        rows={items.map((a) => [
          <span key="e" className={cn(a.error ? "text-bad" : "")}>{s(a.email)}</span>,
          s(a.status),
          s(a.warmup),
          a.warmup_score === null || a.warmup_score === undefined ? "–" : s(a.warmup_score),
          a.daily_limit === null || a.daily_limit === undefined ? "–" : num(n(a.daily_limit)),
        ])}
        empty="No accounts match"
      />
    </Shell>
  );
}

function RepliesCard({ c }: { c: Row }) {
  const items = (c.items ?? []) as Row[];
  return (
    <Shell icon={<Inbox size={15} />} title="Recent replies" meta={`${items.length} shown`}>
      {!items.length && <p className="text-[13px] text-muted">No replies yet.</p>}
      <ul className="divide-y divide-line">
        {items.map((r) => (
          <li key={s(r.thread_id) + s(r.at)} className="py-2">
            <Link to={`/app/unibox?thread=${s(r.thread_id)}`} className="block hover:underline">
              <span className="text-[13px] font-medium">{s(r.from)}</span>
              <span className="ml-2 text-xs text-faint">{dateTime(s(r.at))}</span>
            </Link>
            <p className="line-clamp-2 text-[13px] text-muted">{s(r.snippet)}</p>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

const AGENT_URL: Record<string, (id: string) => string> = {
  sales: (id) => `/app/ai-sales-agent/${id}`,
  reply: (id) => `/app/ai-agents/${id}`,
  lead_finder: (id) => `/app/ai-agents/${id}`,
  deliverability: () => "/app/ai-agents/deliverability",
};

function AgentsCard({ c }: { c: Row }) {
  const items = (c.items ?? []) as Row[];
  return (
    <Shell icon={<Bot size={15} />} title="AI agents" meta={`${items.length} in this workspace`}>
      {!items.length && <p className="text-[13px] text-muted">No agents yet.</p>}
      <ul className="divide-y divide-line">
        {items.map((a) => (
          <li key={s(a.id)} className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
            <Link to={(AGENT_URL[s(a.kind)] ?? AGENT_URL.reply!)(s(a.id))} className="truncate font-medium hover:underline">
              {s(a.name)}
            </Link>
            <Badge tone={a.status === "active" ? "ok" : a.status === "paused" ? "neutral" : "bad"}>{s(a.status)}</Badge>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

const FILTER_LABELS: Record<string, string> = {
  job_titles: "Titles",
  exclude_job_titles: "Excluded titles",
  levels: "Level",
  departments: "Department",
  locations: "Locations",
  exclude_locations: "Excluded locations",
  employee_counts: "Employee count",
  revenue: "Revenue",
  industries: "Industry",
  exclude_industries: "Excluded industries",
  technologies: "Technologies",
  keywords: "Keywords",
  company_names: "Company names",
  domains: "Domains",
  news: "News",
  funding_types: "Funding type",
};

export function FilterChips({ filters }: { filters: Row }) {
  const entries = Object.entries(filters).filter(([, v]) => (Array.isArray(v) ? v.length : s(v).trim()));
  return (
    <dl className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex flex-wrap items-baseline gap-1.5">
          <dt className="w-32 shrink-0 text-xs text-muted">{FILTER_LABELS[k] ?? k}</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap gap-1">
            {(Array.isArray(v) ? v : [v]).map((x) => (
              <span key={s(x)} className={cn("rounded-md px-1.5 py-0.5 text-xs", k.startsWith("exclude") ? "bg-bad-soft text-bad" : "bg-panel-2")}>
                {s(x).replace(/_/g, " ")}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LeadFiltersCard({ c }: { c: Row }) {
  const can = useCan();
  const preview = (c.preview ?? []) as Row[];
  const href = `/app/lead-finder?filters=${encodeURIComponent(JSON.stringify(c.search_filters ?? {}))}`;
  return (
    <Shell
      icon={<Search size={15} />}
      title="Lead list filters"
      meta={s(c.explanation)}
      actions={
        <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand-text tabular-nums">
          {num(n(c.total))} {n(c.total) === 1 ? "lead" : "leads"} found
        </span>
      }
    >
      <FilterChips filters={(c.filters ?? {}) as Row} />
      {preview.length > 0 && (
        <div className="mt-3">
          <MiniTable text head={["Name", "Title", "Company", "Location"]} rows={preview.map((p) => [s(p.name), s(p.title), s(p.company), s(p.location)])} />
        </div>
      )}
      {!n(c.total) && <p className="mt-2 text-[13px] text-muted">No leads match these filters. Ask Copilot to broaden them.</p>}
      {can.perm("lead_finder") && (
        <div className="mt-3 flex flex-wrap gap-2">
          <ButtonLink to={href} size="sm" icon={<ArrowUpRight size={14} />}>
            Open in Lead Finder
          </ButtonLink>
          {n(c.total) > 0 && can.write && (
            <ButtonLink to={`${href}&add=1`} size="sm" variant="primary" icon={<Users size={14} />}>
              Find emails & add leads
            </ButtonLink>
          )}
        </div>
      )}
    </Shell>
  );
}

// ---------- Sequences ----------

interface Step {
  delay_days: number;
  variants: Array<{ subject: string; body: string }>;
}

export function SequenceSteps({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const [variant, setVariant] = useState<Record<number, string>>({});
  return (
    <ol className="space-y-2">
      {steps.map((st, i) => {
        const vi = Number(variant[i] ?? 0);
        const v = st.variants[vi] ?? st.variants[0]!;
        return (
          <li key={i} className="rounded-lg border border-line">
            <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
              {open === i ? <ChevronDown size={14} className="text-faint" /> : <ChevronRight size={14} className="text-faint" />}
              <span className="text-[13px] font-medium">{i === 0 ? "Initial email" : `Follow-up ${i}`}</span>
              <span className="text-xs text-muted">{i === 0 ? "Day 1" : `Wait ${st.delay_days} day${st.delay_days === 1 ? "" : "s"}`}</span>
              {st.variants.length > 1 && <span className="ml-auto text-xs text-muted">{st.variants.length} variants</span>}
            </button>
            {open === i && (
              <div className="border-t border-line px-3 py-2.5">
                {st.variants.length > 1 && (
                  <Segmented
                    size="sm"
                    className="mb-2"
                    value={String(vi)}
                    onChange={(x) => setVariant({ ...variant, [i]: x })}
                    options={st.variants.map((_, j) => ({ value: String(j), label: `Variant ${String.fromCharCode(65 + j)}` }))}
                  />
                )}
                <p className="text-xs text-muted">
                  Subject: <span className="text-text">{v.subject || (i > 0 ? "(same thread as the previous email)" : "(none)")}</span>
                </p>
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed">{v.body}</p>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function UseSequenceDialog({ action, threadId, open, onOpenChange }: { action: ChatAction; threadId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [campaignId, setCampaignId] = useState("");
  const [name, setName] = useState(s(action.card?.campaign_name));
  const [busy, setBusy] = useState(false);
  const campaigns = useCampaignNames(open);
  const creating = campaignId === "__new";
  const submit = async () => {
    setBusy(true);
    try {
      const updated = await post<ChatAction>(`/api/app/copilot/actions/${action.id}/use-sequence`, creating ? { new_campaign_name: name.trim() } : { campaign_id: campaignId });
      updateAction(threadId, updated);
      toast.success("Email sequence added to the campaign");
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Select campaign"
      description="Replace an existing campaign's sequence, or create a new draft campaign with it."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!campaignId || (creating && !name.trim())} onClick={submit}>
            Confirm
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Campaign">
          {(id) => (
            <NativeSelect
              id={id}
              value={campaignId}
              onChange={setCampaignId}
              options={[{ value: "", label: campaigns.isLoading ? "Loading…" : "Choose a campaign" }, { value: "__new", label: "+ Create campaign" }, ...(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))]}
            />
          )}
        </Field>
        {creating && <Field label="Campaign name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>}
        {!creating && campaignId && <p className="text-xs text-warn">The campaign's current sequence will be replaced.</p>}
      </div>
    </Dialog>
  );
}

function SequenceCard({ action, threadId, readOnly }: { action: ChatAction; threadId: string; readOnly: boolean }) {
  const c = action.card!;
  const can = useCan();
  const [show, setShow] = useState(false);
  const [use, setUse] = useState(false);
  const steps = (c.steps ?? []) as Step[];
  const days = steps.reduce((t, x, i) => t + (i ? x.delay_days : 0), 0) + 1;
  const used = c.used_in as Row | undefined;
  return (
    <Shell
      icon={<Mail size={15} />}
      title={s(c.campaign_name) || "Multi-step campaign sequence"}
      meta={`${steps.length} email${steps.length === 1 ? "" : "s"} over ${days} day${days === 1 ? "" : "s"}`}
    >
      {c.notes ? <p className="mb-2 text-[13px] text-muted">{s(c.notes)}</p> : null}
      {show && <SequenceSteps steps={steps} />}
      <div className={cn("flex flex-wrap items-center gap-2", show && "mt-3")}>
        {used ? (
          <Link to={`/app/campaign/${s(used.id)}/sequences`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ok hover:underline">
            <CheckCircle2 size={14} /> {used.created ? "Created" : "Added to"} “{s(used.name)}”
          </Link>
        ) : (
          !readOnly &&
          can.perm("edit_campaigns") &&
          can.write && (
            <Button size="sm" variant="primary" icon={<Rocket size={14} />} onClick={() => setUse(true)}>
              Use in a campaign
            </Button>
          )
        )}
        <Button size="sm" aria-expanded={show} onClick={() => setShow(!show)}>
          {show ? "Hide sequence" : "View sequence"}
        </Button>
      </div>
      {use && <UseSequenceDialog action={action} threadId={threadId} open={use} onOpenChange={setUse} />}
    </Shell>
  );
}

// ---------- Created things ----------

/** Memory fields as people say them (add_rules → "rules"). */
const MEMORY_FIELDS: Record<string, string> = {
  company: "company name",
  website: "website",
  business_description: "business description",
  add_offers: "offers",
  outreach_goal: "outreach goal",
  add_icp: "customer profile",
  add_rules: "rules",
};
const fieldLabel = (k: string) => MEMORY_FIELDS[k] ?? k.replace(/_/g, " ");
const capitalize = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

function CreatedCard({ icon, title, meta, to, cta }: { icon: ReactNode; title: string; meta?: string; to?: string; cta?: string }) {
  return (
    <Shell
      icon={icon}
      title={title}
      meta={meta}
      tone="ok"
      actions={
        to ? (
          <ButtonLink to={to} size="sm" icon={<ArrowUpRight size={14} />}>
            {cta ?? "Open"}
          </ButtonLink>
        ) : undefined
      }
    />
  );
}

const AGENT_TITLES: Record<string, string> = { sales: "AI Sales Agent", lead_finder: "AI Lead Finder Agent", reply: "AI Reply Agent", deliverability: "AI Deliverability Agent" };

function AgentCreatedCard({ c }: { c: Row }) {
  const kind = s(c.agent);
  const steps = kind === "sales" ? ["Analyze business", "Find leads", "Prepare campaigns"] : null;
  return (
    <Shell
      icon={<Bot size={15} />}
      tone="ok"
      title={`${AGENT_TITLES[kind] ?? "AI agent"} ready`}
      meta={c.already ? "It was already active" : s(c.name)}
      actions={
        <ButtonLink to={s(c.url)} size="sm" variant="primary" icon={<ArrowUpRight size={14} />}>
          {kind === "reply" ? "Configure" : "Open agent"}
        </ButtonLink>
      }
    >
      {steps && (
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {steps.map((x, i) => (
            <li key={x} className="flex items-center gap-1.5">
              {i === 0 ? <CheckCircle2 size={14} className="text-ok" /> : <span className="h-3.5 w-3.5 rounded-full border border-line-strong" />}
              <span className={i === 0 ? "" : "text-muted"}>{x}</span>
            </li>
          ))}
        </ol>
      )}
      {steps && <p className="mt-2 text-xs text-muted">The agent starts paused. Review its plan, then turn it on.</p>}
    </Shell>
  );
}

// ---------- DFY quote ----------

function DfyQuoteCard({ action, threadId, readOnly }: { action: ChatAction; threadId: string; readOnly: boolean }) {
  const c = action.card!;
  const confirm = useConfirm();
  const can = useCan();
  const [busy, setBusy] = useState<"place" | "decline" | null>(null);
  const quote = (c.quote ?? {}) as Row;
  const order = (c.order ?? {}) as { order_type?: string; items?: Array<{ domain: string; accounts: Array<{ email_address_prefix: string; first_name: string; last_name: string }> }> };
  const status = s(c.status);
  const problems = Object.entries((quote.problems ?? {}) as Record<string, unknown[]>);
  const act = async (kind: "place" | "decline") => {
    if (kind === "place" && !(await confirm({ title: "Place this order?", description: `${money(n(quote.due_now))} for ${order.items?.length ?? 0} domain(s). The email addresses can't be renamed after ordering.`, confirmLabel: "Place order" }))) return;
    setBusy(kind);
    try {
      const r = await post<{ action: ChatAction; changed?: boolean }>(`/api/app/copilot/actions/${action.id}/${kind === "place" ? "place-order" : "decline-order"}`);
      updateAction(threadId, r.action);
      if (r.changed) toast.warning("The price changed since this quote. Review the new total and confirm again.");
      else if (kind === "place") toast.success("Order placed");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Shell icon={<Globe size={15} />} title="Done-for-you email account order" meta={order.order_type === "pre_warmed_up" ? "Pre-warmed domains" : "New domains with mailboxes"} tone={status === "invalid" ? "warn" : undefined}>
      <ul className="space-y-1.5 text-[13px]">
        {(order.items ?? []).map((it) => (
          <li key={it.domain}>
            <span className="font-medium">{it.domain}</span>
            {it.accounts.length > 0 && <span className="text-muted"> · {it.accounts.map((a) => `${a.email_address_prefix}@${it.domain}`).join(", ")}</span>}
          </li>
        ))}
      </ul>
      {status !== "invalid" ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Tile label="Due now" value={money(n(quote.due_now))} />
          <Tile label="Monthly (mailboxes)" value={money(n(quote.monthly))} />
          <Tile label="Yearly (domains)" value={money(n(quote.yearly_domains))} />
        </div>
      ) : (
        <div className="mt-3 space-y-1 text-[13px] text-warn">
          <p>This order can't be placed as it is. Ask in the chat to adjust it.</p>
          {!!quote.error && <p className="text-xs">{s(quote.error)}</p>}
          {problems.map(([k, v]) => (
            <p key={k} className="text-xs">
              {k.replace(/_/g, " ")}: {v.map((x) => (typeof x === "string" ? x : s((x as Row).email ?? JSON.stringify(x)))).join(", ")}
            </p>
          ))}
        </div>
      )}
      {status === "quoted" && <p className="mt-2 text-xs text-muted">This is a purchase. The email addresses are permanent and can't be renamed after ordering. Mailboxes are set up by this installation's administrator.</p>}
      {status === "placed" && (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] font-medium text-ok">
          <CheckCircle2 size={14} /> Order placed. You'll find the mailboxes under{" "}
          <Link to="/app/accounts?tab=dfy" className="underline">
            Email accounts
          </Link>{" "}
          once they're ready.
        </p>
      )}
      {status === "dismissed" && <p className="mt-3 text-[13px] text-muted">Quote dismissed. Nothing was ordered.</p>}
      {status === "quoted" && !readOnly && can.perm("billing") && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy === "place"} disabled={!!busy} onClick={() => act("place")}>
            Place order for {money(n(quote.due_now))}
          </Button>
          <Button size="sm" loading={busy === "decline"} disabled={!!busy} onClick={() => act("decline")}>
            No thanks
          </Button>
        </div>
      )}
    </Shell>
  );
}

// ---------- Approval ----------

function ApprovalCard({ action, threadId, readOnly, busy }: { action: ChatAction; threadId: string; readOnly: boolean; busy: boolean }) {
  const input = action.input as Row;
  const decide = (decision: "approve" | "deny") => void startStream({ key: threadId, url: `/api/app/copilot/threads/${threadId}/actions/${action.id}`, body: { decision } });
  return (
    <Shell icon={<AlertTriangle size={15} />} tone="warn" title="Action required" meta={action.summary ?? action.tool.replace(/_/g, " ")}>
      {Array.isArray(input.steps) && <SequenceSteps steps={input.steps as Step[]} />}
      {!!input.filters && <FilterChips filters={input.filters as Row} />}
      {action.tool === "save_business_details" && (
        <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-muted">
          {Object.entries(input).map(([k, v]) => (
            <li key={k}>
              {capitalize(fieldLabel(k))}: {typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : s((x as Row)?.name ?? JSON.stringify(x)))).join("; ") : s((v as Row)?.name ?? JSON.stringify(v))}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className={cn("flex gap-2", (Array.isArray(input.steps) || !!input.filters || action.tool === "save_business_details") && "mt-3")}>
          <Button size="sm" variant="primary" icon={<Check size={14} />} disabled={busy} onClick={() => decide("approve")}>
            Approve
          </Button>
          <Button size="sm" icon={<CircleSlash size={14} />} disabled={busy} onClick={() => decide("deny")}>
            Deny
          </Button>
        </div>
      )}
      {readOnly && <p className="text-xs text-muted">Waiting for approval.</p>}
    </Shell>
  );
}

// ---------- Questions ----------

interface Question {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multi_select?: boolean;
}

function QuestionsCard({ action, threadId, readOnly, busy }: { action: ChatAction; threadId: string; readOnly: boolean; busy: boolean }) {
  const questions = ((action.card?.questions ?? []) as Question[]).filter(Boolean);
  const [tab, setTab] = useState(0);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const answerOf = (i: number) => [...(picked[i] ?? []).filter((x) => x !== "__other"), ...((picked[i] ?? []).includes("__other") && other[i]?.trim() ? [other[i]!.trim()] : [])];
  const answered = questions.filter((_, i) => answerOf(i).length).length;
  const send = (decision: "answer" | "skip") =>
    void startStream({
      key: threadId,
      url: `/api/app/copilot/threads/${threadId}/actions/${action.id}`,
      body: decision === "skip" ? { decision } : { decision, answers: questions.map((q, i) => ({ question: q.question, answer: answerOf(i) })) },
    });

  if (action.status !== "awaiting_answer") {
    return (
      <Shell icon={<MessageSquare size={15} />} title={action.status === "answered" ? "Answered" : "Skipped: answering in the chat"} meta={questions.map((q) => q.header).join(" · ")}>
        {action.status === "answered" && (
          <dl className="space-y-1 text-[13px]">
            {(action.answers ?? []).map((a) => (
              <div key={a.question}>
                <dt className="text-xs text-muted">{a.question}</dt>
                <dd className="font-medium">{a.answer.join(", ") || "–"}</dd>
              </div>
            ))}
          </dl>
        )}
      </Shell>
    );
  }
  const q = questions[tab];
  if (!q) return null;
  const toggle = (label: string) => {
    const cur = picked[tab] ?? [];
    const next = q.multi_select ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setPicked({ ...picked, [tab]: next });
    if (!q.multi_select && label !== "__other" && tab < questions.length - 1) setTimeout(() => setTab(tab + 1), 150);
  };
  return (
    <Shell icon={<Sparkles size={15} />} title="Copilot needs your input" meta={questions.length > 1 ? `${answered} of ${questions.length} answered` : q.multi_select ? "Select all that apply" : undefined}>
      {questions.length > 1 && (
        <div role="tablist" aria-label="Questions" className="mb-3 flex flex-wrap gap-1">
          {questions.map((x, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={tab === i}
              onClick={() => setTab(i)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === i ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-panel-2")}
            >
              {answerOf(i).length ? <Check size={12} className="mr-1 inline" /> : null}
              {x.header}
            </button>
          ))}
        </div>
      )}
      <p className="text-[13px] font-medium">{q.question}</p>
      {q.multi_select && questions.length > 1 && <p className="text-xs text-muted">Select all that apply</p>}
      <div className="mt-2 space-y-1.5" role={q.multi_select ? "group" : "radiogroup"} aria-label={q.question}>
        {[...q.options, { label: "__other", description: undefined }].map((o) => {
          const on = (picked[tab] ?? []).includes(o.label);
          return (
            <div key={o.label}>
              <button
                type="button"
                role={q.multi_select ? "checkbox" : "radio"}
                aria-checked={on}
                disabled={readOnly || busy}
                onClick={() => toggle(o.label)}
                className={cn("flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left", on ? "border-brand bg-brand-soft" : "border-line hover:bg-panel-2")}
              >
                <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border", q.multi_select ? "rounded" : "rounded-full", on ? "border-brand bg-brand text-on-brand" : "border-line-strong")}>{on && <Check size={11} />}</span>
                <span>
                  <span className="block text-[13px] font-medium">{o.label === "__other" ? "Other" : o.label}</span>
                  {o.description && <span className="block text-xs text-muted">{o.description}</span>}
                </span>
              </button>
              {o.label === "__other" && on && <Input className="mt-1.5" autoFocus aria-label="Your answer" placeholder="Type your answer…" value={other[tab] ?? ""} onChange={(e) => setOther({ ...other, [tab]: e.target.value })} />}
            </div>
          );
        })}
      </div>
      {!readOnly && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy || answered < questions.length} onClick={() => send("answer")}>
            Submit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => send("skip")}>
            Answer in chat instead
          </Button>
        </div>
      )}
    </Shell>
  );
}

// ---------- Dispatcher ----------

export function ToolCard({ action, threadId, readOnly, busy }: { action: ChatAction; threadId: string; readOnly: boolean; busy: boolean }) {
  const c = action.card;
  const body = useMemo(() => {
    switch (action.status) {
      case "running":
        return <Working label={action.working} />;
      case "error": {
        const malformed = action.error?.startsWith('{"INVALID_JSON"');
        return (
          <div className="flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{malformed ? "Copilot sent an incomplete request and will try again." : action.error || "This step failed."}</span>
          </div>
        );
      }
      case "denied":
        return (
          <p className="flex items-center gap-1.5 text-[13px] text-muted">
            <CircleSlash size={14} /> Denied{action.summary ? `: ${action.summary}` : ""}
          </p>
        );
      case "awaiting_approval":
        return <ApprovalCard action={action} threadId={threadId} readOnly={readOnly} busy={busy} />;
      case "awaiting_answer":
      case "answered":
      case "skipped":
        return action.tool === "ask_user_question" ? <QuestionsCard action={action} threadId={threadId} readOnly={readOnly} busy={busy} /> : null;
    }
    if (!c) return null;
    switch (c.type) {
      case "overview":
        return <OverviewCard c={c} />;
      case "campaigns":
        return <CampaignsCard c={c} />;
      case "analytics":
        return <AnalyticsCard c={c} />;
      case "accounts":
        return <AccountsCard c={c} />;
      case "replies":
        return <RepliesCard c={c} />;
      case "agents":
        return <AgentsCard c={c} />;
      case "lead_filters":
        return <LeadFiltersCard c={c} />;
      case "sequence":
        return <SequenceCard action={action} threadId={threadId} readOnly={readOnly} />;
      case "campaign_created":
        return <CreatedCard icon={<Rocket size={15} />} title={`Campaign “${s(c.name)}” created`} meta={`Draft with ${s(c.emails)} email(s). Add leads and accounts, then launch.`} to={`/app/campaign/${s(c.id)}/sequences`} cta="Open campaign" />;
      case "campaign_status":
        return <CreatedCard icon={<Rocket size={15} />} title={`“${s(c.name)}” is now ${s(c.status).toLowerCase()}`} to={`/app/campaign/${s(c.id)}/analytics`} cta="Open campaign" />;
      case "leads_import":
        return (
          <CreatedCard
            icon={<Users size={15} />}
            title={`Adding up to ${plural(n(c.limit), "lead")}`}
            meta={`To ${c.destination === "campaign" ? "the campaign" : `the list “${s(c.name)}”`}. Emails are found in the background.`}
            to={c.destination === "campaign" ? `/app/campaign/${s(c.id)}/leads` : `/app/crm/leads?listId=${s(c.id)}`}
            cta="View leads"
          />
        );
      case "agent_created":
        return <AgentCreatedCard c={c} />;
      case "memory_saved":
        return <CreatedCard icon={<Brain size={15} />} title="Saved to memory" meta={capitalize(((c.fields ?? []) as string[]).map(fieldLabel).join(", "))} to="/app/copilot/memory/business-details" cta="View memory" />;
      case "task_created":
        return <CreatedCard icon={<CalendarClock size={15} />} title={`Recurring task “${s(c.title)}” scheduled`} meta={`${s(c.frequency)} · next run ${dateTime(s(c.next_run_at))}`} to="/app/copilot/tasks" cta="View tasks" />;
      case "dfy_quote":
        return <DfyQuoteCard action={action} threadId={threadId} readOnly={readOnly} />;
      default:
        return null;
    }
  }, [action, c, threadId, readOnly, busy]);
  return body;
}

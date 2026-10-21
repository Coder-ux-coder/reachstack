import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Building2,
  Check,
  Copy,
  Globe,
  Mail,
  MailOpen,
  Megaphone,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  Trash2,
  Trophy,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CampaignSchedule } from "@reachstack/shared";
import { del, errorMessage, get, patch, post, type Page as ApiPage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fillDays, resolveRange, type DateRange } from "@/lib/dates";
import { ago, dateTime, money, num, pct, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { useUnsavedChanges } from "@/lib/unsaved";
import { EmailFrame } from "@/components/EmailFrame";
import { RichEditor } from "@/components/RichEditor";
import { RangeSelect } from "@/components/RangeSelect";
import { TrendChart } from "@/components/charts";
import { AccountsPicker } from "@/components/sequence/AccountsPicker";
import { ScheduleEditor } from "@/components/sequence/ScheduleEditor";
import { useFilterOptions } from "@/pages/app/lead-finder/filters";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  LinkTabs,
  NativeSelect,
  NumberInput,
  Page,
  Section,
  Segmented,
  SkeletonRows,
  StatCard,
  SwitchRow,
  Textarea,
  useConfirm,
} from "@/components/ui";
import { ChipToggle, IcpDialog, type Icp } from "./icp";
import { AGENTS_KEY, AgentStatusBadge, AiMissingCallout, ModeBadge, OUTBOUND_PURPOSES, purposeLabel, useAgents, useIntegrations } from "./shared";

// ---------------------------------------------------------------------------------------------------------------
// Types

interface Memory {
  company: string;
  business_description: string;
  icps: Icp[];
  active_icps_indexes: number[];
  business_offers: string[];
  active_business_offers_indexes: number[];
  custom_fields: string[];
}

type DetailKey = "position_details" | "investment_details" | "research_details" | "partnership_details";

interface SalesConfig extends Partial<Record<DetailKey, string>> {
  memory: Memory;
  enrichment_settings: { enrichment_limit_per_run: number; signal_targeting_enabled: boolean; signal_targeting_categories: string[] };
  outreach_settings: {
    campaign_schedule?: CampaignSchedule;
    email_list: string[];
    email_tag_list: string[];
    daily_limit: number;
    stop_on_reply: boolean;
    open_tracking: boolean;
    first_email_text_only: boolean;
    prioritize_new_leads: boolean;
    match_lead_esp: boolean;
    opt_out_settings: { text_opt_out_enabled: boolean };
  };
  autonomy_settings: { autopilot_mode: boolean; auto_reply_to_responses: boolean; manual_leads_mode: boolean };
  slack_connection_id?: string | null;
}

interface SalesAgent {
  id: string;
  name: string;
  description: string | null;
  type: "website" | "pitch_deck";
  input: string | null;
  status: number;
  config: SalesConfig;
  master_lead_list_id: string | null;
  initial_scrape_ready: boolean;
  agent_type: number;
  self_improvement: boolean | null;
  timestamp_created: string;
  timestamp_last_decision: string | null;
  next_decision_time: string | null;
}

interface Activity {
  id: string;
  action_type: string;
  action_status: "pending" | "approved" | "rejected" | "in_progress" | "completed" | "failed";
  action_payload: Record<string, unknown>;
  action_output: Record<string, unknown>;
  ai_reasoning: string | null;
  ai_confidence: number | null;
  error_message: string | null;
  rejection_reason: string | null;
  timestamp_created: string;
  timestamp_completed: string | null;
}

interface Rule {
  id: string;
  title: string;
  content: string;
}

interface Outlet {
  agent: SalesAgent;
  aiAvailable: boolean;
}

const agentKey = (id: string) => ["sales-agent", id];
const feedKey = (id: string) => ["sales-agent-feed", id];

const PURPOSE_DETAILS: Record<number, { key: DetailKey; label: string; placeholder: string }> = {
  4: { key: "partnership_details", label: "The affiliate offer", placeholder: "Commission, cookie length, payout terms and who makes a good affiliate" },
  7: { key: "position_details", label: "The role", placeholder: "Title, team, location or remote, salary range and why it's a great job" },
  8: { key: "investment_details", label: "The raise", placeholder: "Stage, amount, traction so far and what the money is for" },
  9: { key: "research_details", label: "What you want to learn", placeholder: "Who you want to talk to, about what, how long the call takes and any thank-you gift" },
  10: { key: "partnership_details", label: "The partnership", placeholder: "What you offer partners and what kind of partner you're looking for" },
};

const SIGNAL_LABELS: Record<string, string> = {
  website_funding: "Raised funding",
  website_executive_change: "New leadership",
  website_pricing_change: "Changed pricing",
  website_product_launch: "Launched a product",
  website_expansion: "Expanding",
  website_partnership: "New partnership",
  website_compliance: "Compliance news",
  website_technology_adoption: "Adopted new technology",
  reddit_buying_intent: "Looking to buy (Reddit)",
  reddit_pain_point: "Describing a pain point (Reddit)",
  reddit_churn_risk: "Unhappy with a vendor (Reddit)",
  reddit_competitor_mention: "Mentioned a competitor (Reddit)",
  linkedin_post_company: "Company posted on LinkedIn",
  linkedin_post_contact: "Contact posted on LinkedIn",
  linkedin_comment: "Contact commented on LinkedIn",
  twitter_post_company: "Company posted on X",
  twitter_post_contact: "Contact posted on X",
  youtube_company: "Company video on YouTube",
  youtube_contact: "Contact video on YouTube",
  glassdoor_negative: "Negative employee reviews",
  glassdoor_positive: "Positive employee reviews",
  job_change: "Changed jobs",
  promotion: "Got promoted",
  work_anniversary: "Work anniversary",
  traffic_surge: "Website traffic surge",
  traffic_decline: "Website traffic decline",
};

const REJECT_REASONS = ["Not a good fit", "Wrong company size", "Already a customer", "Wrong person at the company", "Bad timing"];

// ---------------------------------------------------------------------------------------------------------------
// Activity wording

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/** Event activities only record what happened; they never need a decision. */
const EVENT_TYPES = new Set(["warning", "email_opened", "reply_received", "lead_meeting_booked", "lead_closed", "opportunity_received", "campaign_completed", "imported_leads"]);

function describe(a: Activity): { icon: LucideIcon; title: string; detail?: string; tone?: "bad" | "ok" } {
  const o = a.action_output;
  const camp = s(o.campaign_name);
  switch (a.action_type) {
    case "create_campaign":
      return { icon: Megaphone, title: `New campaign: ${camp || "untitled"}`, detail: [o.icp_name && `For "${s(o.icp_name)}"`, o.steps && plural(n(o.steps), "email"), o.first_subject && `First subject "${s(o.first_subject)}"`].filter(Boolean).join(" · ") };
    case "edit_campaign":
      return { icon: Pencil, title: `Change to ${camp}`, detail: [s(o.change), o.subject && `"${s(o.subject)}"`].filter(Boolean).join(": ") };
    case "pause_campaign":
      return { icon: Pause, title: `Pause ${camp}`, detail: o.bounce_rate != null ? `${s(o.bounce_rate)}% of emails bounced in the last two weeks` : undefined };
    case "stop_campaign":
      return { icon: Pause, title: `Stop ${camp}` };
    case "enrich_leads":
      if (o.leads_added !== undefined) return { icon: UserPlus, title: `Added ${plural(n(o.leads_added), "lead")} to ${camp}`, detail: o.with_signals ? `${n(o.with_signals)} with a recent buying signal` : undefined };
      if (o.recommended !== undefined) return { icon: Search, title: `Found ${plural(n(o.recommended), "prospect")} for ${camp}`, detail: "Each one waits for your review below." };
      return { icon: Search, title: `Look for ${o.icp_name ? `"${s(o.icp_name)}" ` : ""}prospects for ${camp}` };
    case "recommend_lead": {
      const who = [s(o.lead_name) || "A prospect", o.job_title && s(o.job_title), o.company_name && `at ${s(o.company_name)}`].filter(Boolean).join(", ").replace(", at", " at");
      const outcome = o.delivery_outcome === "delivered" ? "Added to the campaign" : o.delivery_outcome ? s(o.reason) || "Not added" : undefined;
      return { icon: UserPlus, title: who, detail: [camp && `For ${camp}`, o.location && s(o.location), outcome].filter(Boolean).join(" · ") };
    }
    case "push_lead":
      return { icon: UserPlus, title: `Add ${s(o.lead_name) || s(o.lead_email)} to ${camp}`, detail: [s(o.job_title), o.company_name && `at ${s(o.company_name)}`].filter(Boolean).join(" ") || undefined };
    case "email_sent":
      return { icon: Mail, title: `Reply to ${s(o.lead_email)}`, detail: camp ? `In ${camp}` : undefined };
    case "reply_received":
      return { icon: MessageSquare, title: `${s(o.lead_email)} replied`, detail: s(o.snippet) || undefined };
    case "opportunity_received":
      return { icon: Trophy, title: `New opportunity: ${s(o.lead_email)}`, detail: camp ? `From ${camp}` : undefined, tone: "ok" };
    case "lead_meeting_booked":
      return { icon: Trophy, title: `Meeting booked with ${s(o.lead_email)}`, tone: "ok" };
    case "lead_closed":
      return { icon: Trophy, title: `Deal closed with ${s(o.lead_email)}`, tone: "ok" };
    case "email_opened":
      return { icon: MailOpen, title: `${s(o.lead_email) || "A lead"} opened an email`, detail: camp ? `In ${camp}` : undefined };
    case "campaign_completed":
      return { icon: Check, title: `${camp} finished`, detail: "Every lead has been through the sequence." };
    case "imported_leads":
      return { icon: UserPlus, title: `${plural(n(o.count), "lead")} added to ${camp}` };
    case "warning":
      return { icon: AlertTriangle, title: s(o.message) || "Warning", tone: "bad" };
    case "initial_setup_scrape":
      return {
        icon: BookOpen,
        title: o.company ? `Learned about ${s(o.company)}` : "Learning about the business",
        detail: o.company ? `${plural((o.icps as unknown[] | undefined)?.length ?? 0, "customer profile")}, ${plural((o.offers as unknown[] | undefined)?.length ?? 0, "offer")}` : s(a.action_payload.input) || undefined,
      };
    case "initial_setup_campaigns":
      return { icon: Rocket, title: "Setting up campaigns", detail: o.proposed !== undefined ? `Drafted ${plural(n(o.proposed), "campaign")}` : undefined };
    case "initial_setup_enrich":
      return { icon: Search, title: "Finding the first prospects" };
    default:
      return { icon: Sparkles, title: a.action_type.replace(/_/g, " ") };
  }
}

function StatusBadge({ a }: { a: Activity }) {
  if (EVENT_TYPES.has(a.action_type)) return null;
  switch (a.action_status) {
    case "pending":
      return <Badge tone="warn">Needs review</Badge>;
    case "approved":
      return <Badge tone="info">Approved</Badge>;
    case "in_progress":
      return <Badge tone="info">Working…</Badge>;
    case "rejected":
      return <Badge tone="neutral">{a.action_output.not_sent ? "Not sent" : "Rejected"}</Badge>;
    case "failed":
      return <Badge tone="bad">Failed</Badge>;
    default:
      return <Badge tone="ok">Done</Badge>;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Create

export function SalesAgentCreate() {
  usePageTitle("New outbound agent");
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const agents = useAgents();
  const initialType = Number(params.get("agent_type")) || 2;
  const [agentType, setAgentType] = useState(OUTBOUND_PURPOSES.some((p) => p.value === initialType) ? initialType : 2);
  const [name, setName] = useState("");
  const [source, setSource] = useState<"website" | "pitch_deck" | "memory">("website");
  const [website, setWebsite] = useState("");
  const [pitch, setPitch] = useState("");
  const [details, setDetails] = useState("");
  const [accounts, setAccounts] = useState<{ emails: string[]; tagIds: string[] }>({ emails: [], tagIds: [] });
  const [autopilot, setAutopilot] = useState(false);
  const [busy, setBusy] = useState(false);
  const purpose = PURPOSE_DETAILS[agentType];
  const noun = OUTBOUND_PURPOSES.find((p) => p.value === agentType)?.noun ?? "customers";

  const problems: string[] = [];
  if (!name.trim()) problems.push("Name the agent");
  if (source === "website" && !website.trim()) problems.push("Enter your website");
  if (source === "pitch_deck" && pitch.trim().length < 80) problems.push("Paste at least a paragraph about the business");

  const create = async () => {
    setBusy(true);
    try {
      const config: Partial<SalesConfig> = {
        outreach_settings: { email_list: accounts.emails, email_tag_list: accounts.tagIds } as SalesConfig["outreach_settings"],
        autonomy_settings: { autopilot_mode: autopilot } as SalesConfig["autonomy_settings"],
        ...(purpose && details.trim() ? { [purpose.key]: details.trim() } : {}),
      };
      const a = await post<SalesAgent>("/api/v2/ai-agents/sales", {
        name: name.trim(),
        agent_type: agentType,
        ...(source === "memory" ? { memory_from_workspace: true } : { type: source, input: source === "website" ? website.trim() : pitch.trim() }),
        config,
        status: 0,
      });
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success(source === "memory" ? "Agent created. Review its profile, then turn it on." : "Agent created. It's reading about your business now.");
      nav(`/app/ai-sales-agent/${a.id}/memory`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <Link to="/app/ai-agents/create" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> Choose another agent
      </Link>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">New outbound agent</h1>
      <p className="mt-1 max-w-2xl text-[13px] text-muted">
        It learns what you offer, writes a campaign for each kind of {noun.replace(/s$/, "")} you want, finds matching people in the Lead Finder database and keeps the campaigns stocked. In review mode nothing goes out until you approve it.
      </p>
      {agents.data && !agents.data.ai_available && (
        <div className="mt-4">
          <AiMissingCallout what="The outbound agent" />
        </div>
      )}
      <div className="mt-6">
        <Section title="Purpose" description="Who the agent reaches out to.">
          <div className="space-y-3">
            <NativeSelect value={String(agentType)} onChange={(v) => setAgentType(Number(v))} options={OUTBOUND_PURPOSES.map((p) => ({ value: String(p.value), label: `${p.label} — find ${p.noun}` }))} aria-label="Purpose" />
            {purpose && (
              <Field label={purpose.label} optional>
                {(id) => <Textarea id={id} rows={3} value={details} onChange={(e) => setDetails(e.target.value)} placeholder={purpose.placeholder} maxLength={20_000} />}
              </Field>
            )}
          </div>
        </Section>
        <Section title="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Outbound to US agencies" maxLength={200} aria-label="Agent name" />
        </Section>
        <Section title="Learn about the business" description="The agent turns this into a company profile, offers and ideal customer profiles you can edit before it starts.">
          <div className="space-y-3">
            <Segmented
              value={source}
              onChange={setSource}
              options={[
                { value: "website", label: "Website" },
                { value: "pitch_deck", label: "Paste a pitch" },
                { value: "memory", label: "Workspace details" },
              ]}
            />
            {source === "website" && <Input leading={<Globe size={14} />} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://yourcompany.com" aria-label="Website" />}
            {source === "pitch_deck" && (
              <Textarea rows={8} value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="What the company does, who it helps, the problems it solves, proof points and pricing…" aria-label="Pitch" maxLength={100_000} />
            )}
            {source === "memory" && <p className="text-[13px] text-muted">Copies the business details saved for this workspace in Copilot. If there aren't any yet, use your website or a pitch instead.</p>}
          </div>
        </Section>
        <Section title="Sending mailboxes" description="The agent's campaigns send from these. You can change them later.">
          <AccountsPicker emails={accounts.emails} tagIds={accounts.tagIds} onChange={setAccounts} />
        </Section>
        <Section title="How much to decide alone">
          <div className="space-y-3">
            <Segmented
              value={autopilot ? "auto" : "review"}
              onChange={(v) => setAutopilot(v === "auto")}
              options={[
                { value: "review", label: "Review first" },
                { value: "auto", label: "Autopilot" },
              ]}
            />
            <p className="text-[13px] text-muted">
              {autopilot ? "Campaigns, new leads and replies go ahead without asking. You can still see everything in the live feed." : "New campaigns, each prospect and every reply wait in the live feed for you to approve."}
            </p>
          </div>
        </Section>
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          {problems.length > 0 && <span className="mr-auto text-[13px] text-muted">{problems[0]}</span>}
          <Button variant="primary" icon={<Sparkles size={14} />} loading={busy} disabled={problems.length > 0} onClick={create}>
            Create agent
          </Button>
        </div>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Shell

function useSalesAgent(id: string) {
  return useQuery({
    queryKey: agentKey(id),
    queryFn: () => get<SalesAgent>(`/api/v2/ai-agents/sales/${id}`),
    refetchInterval: (q) => (q.state.data && !q.state.data.initial_scrape_ready ? 3000 : false),
  });
}

function useSales() {
  return useOutletContext<Outlet>();
}

export function SalesAgentLayout() {
  const { id = "" } = useParams();
  const q = useSalesAgent(id);
  const agents = useAgents();
  const can = useCan();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useQuery({
    queryKey: [...feedKey(id), "pending-count"],
    queryFn: () => get<{ items: Activity[]; next_starting_after?: string }>(`/api/v2/ai-agents/sales/${id}/activities`, { action_status: "pending", limit: 100 }),
    enabled: !!q.data,
  });
  const warning = useQuery({
    queryKey: [...feedKey(id), "warning"],
    queryFn: () => get<{ items: Activity[] }>(`/api/v2/ai-agents/sales/${id}/activities`, { action_type: "warning", limit: 1 }),
    enabled: !!q.data,
  });
  usePageTitle(q.data?.name ?? "Outbound agent");
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (!q.data) return <EmptyState title="Agent not found" action={<Link to="/app/ai-agents">Back to agents</Link>} />;
  const a = q.data;
  const aiAvailable = agents.data?.ai_available ?? true;
  const learning = !a.initial_scrape_ready;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: agentKey(id) }), qc.invalidateQueries({ queryKey: feedKey(id) }), qc.invalidateQueries({ queryKey: AGENTS_KEY })]);
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
  const duplicate = async () => {
    setBusy("copy");
    try {
      const copy = await post<SalesAgent>("/api/v2/ai-agents/sales", { name: `${a.name} (copy)`, is_duplicate: true, source_ai_sdr_id: a.id, status: 0 });
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success("Copy created, paused");
      nav(`/app/ai-sales-agent/${copy.id}/settings`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const pendingCount = pending.data?.items.length ? `${pending.data.items.length}${pending.data.next_starting_after ? "+" : ""}` : null;
  const base = `/app/ai-sales-agent/${id}`;
  const noMailboxes = !a.config.outreach_settings.email_list.length && !a.config.outreach_settings.email_tag_list.length;
  // What held the agent back lately (no profiles, an error, a campaign that can't start), so it doesn't go quiet.
  const lastWarning = warning.data?.items[0];
  const recentWarning = lastWarning && Date.now() - Date.parse(lastWarning.timestamp_created) < 86_400_000 ? lastWarning : null;
  return (
    <Page>
      <Link to="/app/ai-agents" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> Agents
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{a.name}</h1>
        <AgentStatusBadge status={a.status} learning={learning} />
        <ModeBadge mode={a.config.autonomy_settings.autopilot_mode ? "autopilot" : "review"} />
        <Badge tone="neutral">{purposeLabel(a.agent_type)}</Badge>
        {can.write && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            <Button variant="ghost" icon={<Copy size={14} />} loading={busy === "copy"} onClick={duplicate}>
              Duplicate
            </Button>
            {a.status === 1 && (
              <Button icon={<RefreshCw size={14} />} loading={busy === "run"} disabled={!aiAvailable || learning} onClick={() => act("run", () => post(`/api/app/ai-agents/sales/${id}/run`), "Done. New proposals are in the live feed.")}>
                Run now
              </Button>
            )}
            <Button
              variant={a.status === 1 ? "secondary" : "primary"}
              icon={a.status === 1 ? <Pause size={14} /> : <Play size={14} />}
              loading={busy === "toggle"}
              disabled={a.status !== 1 && (!aiAvailable || learning)}
              onClick={() =>
                act("toggle", () => patch(`/api/v2/ai-agents/sales/${id}`, { status: a.status === 1 ? 0 : 1 }), a.status === 1 ? "Agent paused. Its campaigns are paused too." : "Agent is on. It plans its first steps now.")
              }
            >
              {a.status === 1 ? "Pause" : "Turn on"}
            </Button>
          </div>
        )}
      </div>
      <p className="mt-1 text-[13px] text-muted">
        {learning
          ? "Reading about your business. This takes a minute or two."
          : a.status === 1
            ? a.timestamp_last_decision
              ? `Last planned ${ago(a.timestamp_last_decision)}${a.next_decision_time ? ` · next ${dateTime(a.next_decision_time)}` : ""}`
              : "Planning its first steps"
            : "Paused. Review the memory and settings, then turn it on."}
      </p>
      <div className="mt-4 space-y-3 empty:hidden">
        {!aiAvailable && <AiMissingCallout what="The outbound agent" />}
        {recentWarning && (
          <Callout tone="warn">
            {s(recentWarning.action_output.message) || "The agent ran into a problem."} <span className="text-xs opacity-80">{ago(recentWarning.timestamp_created)}</span>
          </Callout>
        )}
        {!learning && noMailboxes && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            No sending mailboxes yet. Its campaigns can't start until you{" "}
            <Link to={`${base}/settings`} className="font-medium underline">
              pick some in Settings
            </Link>
            .
          </p>
        )}
      </div>
      <LinkTabs
        className="mt-5"
        tabs={[
          { to: `${base}/live-feed`, label: "Live feed", badge: pendingCount ? <Badge tone="warn">{pendingCount}</Badge> : undefined },
          { to: `${base}/memory`, label: "Memory" },
          { to: `${base}/leads`, label: "Leads & results" },
          { to: `${base}/settings`, label: "Settings" },
        ]}
      />
      <div className="pt-6">
        <Outlet context={{ agent: a, aiAvailable } satisfies Outlet} />
      </div>
    </Page>
  );
}

export function SalesAgentIndex() {
  return <Navigate to="live-feed" replace />;
}

// ---------------------------------------------------------------------------------------------------------------
// Live feed

function RejectDialog({ open, count, onClose, onReject }: { open: boolean; count: number; onClose: () => void; onReject: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const submit = async () => {
    setBusy(true);
    try {
      await onReject(reason.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={count > 1 ? `Reject ${count} proposals` : "Reject this proposal"}
      description="The agent won't suggest the same thing again for a while. Your reason is kept with the proposal."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={submit}>
            Reject
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {REJECT_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className={cn("rounded-full border px-2.5 py-1 text-xs", reason === r ? "border-brand bg-brand-soft text-brand-text" : "border-line text-muted hover:text-text")}>
              {r}
            </button>
          ))}
        </div>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why isn't this right?" aria-label="Reason" maxLength={2_000} />
      </div>
    </Dialog>
  );
}

function FeedItem({ agentId, a, selected, onSelect, onReject, onChanged }: { agentId: string; a: Activity; selected: boolean; onSelect?: (v: boolean) => void; onReject: () => void; onChanged: () => void }) {
  const can = useCan();
  const d = describe(a);
  const Icon = d.icon;
  const pending = a.action_status === "pending";
  const isDraft = a.action_type === "email_sent";
  const original = s(a.action_payload.html);
  const [html, setHtml] = useState(original);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const edited = isDraft && html !== original;
  const steps = (a.action_payload.steps as Array<{ subject: string; body: string; delay?: number }> | undefined) ?? [];
  const approve = async () => {
    setBusy(true);
    try {
      if (edited) await patch(`/api/app/ai-agents/sales/${agentId}/activities/${a.id}`, { html });
      await post(`/api/v2/ai-agents/sales/${agentId}/activities/${a.id}/approve`);
      toast.success(isDraft ? "Reply approved. It goes out in a few minutes." : "Approved");
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const o = a.action_output;
  return (
    <li className={cn("flex gap-3 border-b border-line px-4 py-4 last:border-b-0 sm:px-5", selected && "bg-brand-soft/40")}>
      {onSelect ? (
        <span className="pt-0.5">
          <Checkbox checked={selected} onChange={onSelect} aria-label="Select" />
        </span>
      ) : null}
      <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted", d.tone === "bad" && "bg-bad-soft text-bad", d.tone === "ok" && "bg-ok-soft text-ok")}>
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 text-[13px] font-medium">{d.title}</p>
          <StatusBadge a={a} />
          {o.has_signal === true && <Badge tone="brand">Buying signal</Badge>}
          {a.ai_confidence != null && pending && <span className="text-xs text-faint">{Math.round(a.ai_confidence * 100)}% sure</span>}
        </div>
        {d.detail && <p className="mt-0.5 text-[13px] text-muted">{d.detail}</p>}
        {a.ai_reasoning && !EVENT_TYPES.has(a.action_type) && <p className="mt-1 text-xs text-faint">{a.ai_reasoning}</p>}
        {a.action_type === "recommend_lead" && (o.linkedin_url || o.company_domain) ? (
          <p className="mt-1 flex flex-wrap gap-3 text-xs">
            {typeof o.company_domain === "string" && (
              <a href={`https://${o.company_domain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                <Building2 size={12} /> {o.company_domain}
              </a>
            )}
            {typeof o.linkedin_url === "string" && (
              <a href={o.linkedin_url} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
                LinkedIn
              </a>
            )}
          </p>
        ) : null}
        {a.error_message && <p className="mt-1 text-xs text-bad">{a.error_message}</p>}
        {a.action_status === "rejected" && a.rejection_reason && <p className="mt-1 text-xs text-muted">{o.not_sent ? a.rejection_reason : `Rejected: ${a.rejection_reason}`}</p>}
        {steps.length > 0 && (
          <div className="mt-2">
            <button type="button" className="text-xs font-medium text-brand-text hover:underline" onClick={() => setOpen((v) => !v)}>
              {open ? "Hide emails" : `Show ${plural(steps.length, "email")}`}
            </button>
            {open && (
              <ol className="mt-2 space-y-2">
                {steps.map((st, i) => (
                  <li key={i} className="rounded-lg border border-line px-3 py-2.5 text-[13px]">
                    <p className="text-xs text-faint">
                      Email {i + 1}
                      {i > 0 && st.delay ? ` · ${plural(st.delay, "day")} later` : ""}
                    </p>
                    <p className="mt-1 font-medium">{st.subject || "(same thread)"}</p>
                    <div className="mt-1">
                      <EmailFrame html={st.body} minHeight={40} />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {isDraft && pending && can.write && (
          <div className="mt-2">
            <RichEditor value={html} onChange={setHtml} minHeight={100} />
          </div>
        )}
        {isDraft && !pending && s(o.reply_preview) && <p className="mt-1 line-clamp-2 text-xs text-muted">{s(o.reply_preview)}</p>}
        {pending && can.write && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" icon={<Check size={14} />} loading={busy} onClick={approve} disabled={isDraft && !html.trim()}>
              {isDraft ? (edited ? "Save and send" : "Send") : "Approve"}
            </Button>
            <Button size="sm" variant="ghost" icon={<X size={14} />} disabled={busy} onClick={onReject}>
              Reject
            </Button>
          </div>
        )}
        {(a.action_type === "reply_received" || a.action_type === "email_sent") && typeof o.lead_email === "string" && (
          <Link to={`/app/unibox?search=${encodeURIComponent(o.lead_email)}`} className="-mb-1 mt-1 inline-flex items-center gap-1 py-1 text-xs text-muted hover:text-text">
            <MessageSquare size={12} /> Open in Unibox
          </Link>
        )}
      </div>
      <span className="hidden shrink-0 text-xs text-faint sm:block" title={dateTime(a.timestamp_created)}>
        {ago(a.timestamp_created)}
      </span>
    </li>
  );
}

export function SalesLiveFeed() {
  const { agent } = useSales();
  const qc = useQueryClient();
  const can = useCan();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<string[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const feed = useInfiniteQuery({
    queryKey: [...feedKey(agent.id), filter],
    queryFn: ({ pageParam }) =>
      get<{ items: Activity[]; next_starting_after?: string }>(`/api/v2/ai-agents/sales/${agent.id}/activities`, {
        limit: 25,
        starting_after: pageParam,
        ...(filter === "pending" ? { action_status: "pending" } : { exclude_live_feed_hidden: true }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_starting_after,
    refetchInterval: (q) => {
      const items = q.state.data?.pages.flatMap((p) => p.items) ?? [];
      return !agent.initial_scrape_ready || items.some((i) => i.action_status === "approved" || i.action_status === "in_progress") ? 3000 : false;
    },
  });
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  useEffect(() => setSelected(new Set()), [filter]);
  const refresh = () => {
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: feedKey(agent.id) });
    qc.invalidateQueries({ queryKey: AGENTS_KEY });
  };
  const toggle = (id: string, v: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });
  const pendingIds = items.filter((i) => i.action_status === "pending").map((i) => i.id);
  const approveSelected = async () => {
    setBulkBusy(true);
    try {
      const r = await post<{ approved: number }>(`/api/v2/ai-agents/sales/${agent.id}/activities/approve`, { activity_ids: [...selected].slice(0, 100) });
      toast.success(`Approved ${r.approved}. The agent carries them out in a few seconds.`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBulkBusy(false);
    }
  };
  const reject = async (ids: string[], reason: string) => {
    try {
      if (ids.length === 1) await post(`/api/v2/ai-agents/sales/${agent.id}/activities/${ids[0]}/reject`, { rejection_reason: reason });
      else await post(`/api/v2/ai-agents/sales/${agent.id}/activities/reject`, { activity_ids: ids.slice(0, 100), rejection_reason: reason });
      toast.success(ids.length > 1 ? `Rejected ${ids.length}` : "Rejected");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  };
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "pending", label: "Needs review" },
            { value: "all", label: "Everything" },
          ]}
        />
        {filter === "pending" && can.write && pendingIds.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <Checkbox checked={selected.size === pendingIds.length} onChange={(v) => setSelected(v ? new Set(pendingIds) : new Set())} label={selected.size ? `${selected.size} selected` : "Select all"} />
            {selected.size > 0 && (
              <>
                <Button size="sm" variant="primary" icon={<Check size={14} />} loading={bulkBusy} onClick={approveSelected}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => setRejecting([...selected])}>
                  Reject
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {feed.isLoading ? (
        <div className="p-5">
          <SkeletonRows rows={4} />
        </div>
      ) : items.length ? (
        <ul>
          {items.map((a) => (
            <FeedItem
              key={a.id}
              agentId={agent.id}
              a={a}
              selected={selected.has(a.id)}
              onSelect={filter === "pending" && can.write && pendingIds.length > 1 ? (v) => toggle(a.id, v) : undefined}
              onReject={() => setRejecting([a.id])}
              onChanged={refresh}
            />
          ))}
        </ul>
      ) : (
        <div className="px-5 py-12 text-center">
          <p className="text-[13px] font-medium">{filter === "pending" ? "Nothing waiting for you" : "No activity yet"}</p>
          <p className="mt-1 text-[13px] text-muted">
            {!agent.initial_scrape_ready
              ? "The agent is still reading about your business."
              : agent.status === 1
                ? agent.config.autonomy_settings.autopilot_mode
                  ? "On autopilot the agent goes ahead without asking. Switch to Everything to see what it did."
                  : "New proposals show up here when the agent plans its next steps."
                : "Turn the agent on and its proposals show up here."}
          </p>
        </div>
      )}
      {feed.hasNextPage && (
        <div className="border-t border-line p-3 text-center">
          <Button size="sm" variant="ghost" loading={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
            Show more
          </Button>
        </div>
      )}
      <RejectDialog open={!!rejecting} count={rejecting?.length ?? 0} onClose={() => setRejecting(null)} onReject={(reason) => reject(rejecting ?? [], reason)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Memory

function LearnDialog({ agent, open, onClose }: { agent: SalesAgent; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState(agent.type);
  const [input, setInput] = useState(agent.type === "website" ? (agent.input ?? "") : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setType(agent.type);
      setInput(agent.type === "website" ? (agent.input ?? "") : "");
    }
  }, [open, agent]);
  const learn = async () => {
    setBusy(true);
    try {
      await post(`/api/app/ai-agents/sales/${agent.id}/learn`, { type, ...(input.trim() ? { input: input.trim() } : {}) });
      await Promise.all([qc.invalidateQueries({ queryKey: agentKey(agent.id) }), qc.invalidateQueries({ queryKey: feedKey(agent.id) })]);
      toast.success("Reading about the business again");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const keepsPitch = type === "pitch_deck" && agent.type === "pitch_deck" && !input.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Learn about the business again"
      description="Replaces the company profile, offers and customer profiles below. Guidance rules stay."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!input.trim() && !keepsPitch} onClick={learn}>
            Start learning
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: "website", label: "Website" },
            { value: "pitch_deck", label: "Pitch" },
          ]}
        />
        {type === "website" ? (
          <Input leading={<Globe size={14} />} value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://yourcompany.com" aria-label="Website" />
        ) : (
          <Textarea rows={8} value={input} onChange={(e) => setInput(e.target.value)} placeholder={agent.type === "pitch_deck" ? "Leave empty to reuse the pitch you pasted before" : "What the company does, who it helps and why it's better"} aria-label="Pitch" />
        )}
      </div>
    </Dialog>
  );
}

function RulesCard({ agent }: { agent: SalesAgent }) {
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const key = ["sales-agent-rules", agent.id];
  const rules = useQuery({ queryKey: key, queryFn: () => get<{ items: Rule[] }>(`/api/v2/ai-agents/sales/${agent.id}/guidance-rules`) });
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (editing === "new") {
      setTitle("");
      setContent("");
    } else if (editing) {
      setTitle(editing.title);
      setContent(editing.content);
    }
  }, [editing]);
  const save = async () => {
    setBusy(true);
    try {
      if (editing === "new") await post(`/api/v2/ai-agents/sales/${agent.id}/guidance-rules`, { title: title.trim(), content: content.trim() });
      else if (editing) await patch(`/api/v2/ai-agents/sales/${agent.id}/guidance-rules/${editing.id}`, { title: title.trim(), content: content.trim() });
      await qc.invalidateQueries({ queryKey: key });
      setEditing(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: Rule) => {
    if (!(await confirm({ title: `Delete "${r.title}"?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await del(`/api/v2/ai-agents/sales/${agent.id}/guidance-rules/${r.id}`);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const items = rules.data?.items ?? [];
  return (
    <Card>
      <CardHeader
        title="Guidance rules"
        description="Instructions the agent follows when it writes and picks prospects. Up to 10."
        actions={
          can.write && (
            <Button size="sm" icon={<Plus size={14} />} disabled={items.length >= 10} onClick={() => setEditing("new")}>
              Add rule
            </Button>
          )
        }
      />
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((r) => (
            <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{r.title}</p>
                <p className="mt-0.5 whitespace-pre-line text-[13px] text-muted">{r.content}</p>
              </div>
              {can.write && (
                <div className="flex shrink-0 gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${r.title}`} onClick={() => setEditing(r)}>
                    <Pencil size={14} />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${r.title}`} onClick={() => remove(r)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No rules yet. For example: "Never mention pricing in the first email" or "Skip companies under 10 people".</p>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "New guidance rule" : "Edit guidance rule"}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!content.trim()} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Title" optional>
            {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tone" maxLength={200} />}
          </Field>
          <Field label="Rule">{(id) => <Textarea id={id} rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Keep first emails under 80 words and end with a question." maxLength={5_000} />}</Field>
        </div>
      </Dialog>
    </Card>
  );
}

interface MemoryForm {
  company: string;
  business_description: string;
  icps: Icp[];
  active_icps_indexes: number[];
  business_offers: string[];
  active_business_offers_indexes: number[];
  details: string;
}

function memoryForm(a: SalesAgent): MemoryForm {
  const m = a.config.memory;
  const detailKey = PURPOSE_DETAILS[a.agent_type]?.key;
  return {
    company: m.company ?? "",
    business_description: m.business_description ?? "",
    icps: m.icps ?? [],
    active_icps_indexes: m.active_icps_indexes ?? [],
    business_offers: m.business_offers ?? [],
    active_business_offers_indexes: m.active_business_offers_indexes ?? [],
    details: (detailKey && a.config[detailKey]) || "",
  };
}

/** Removing an item shifts the indexes after it. */
const dropIndex = (indexes: number[], i: number) => indexes.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));

export function SalesMemory() {
  const { agent } = useSales();
  const qc = useQueryClient();
  const can = useCan();
  const baseline = useMemo(() => memoryForm(agent), [agent]);
  const [form, setForm] = useState(baseline);
  const [icpEdit, setIcpEdit] = useState<{ icp: Icp; index: number | null } | null>(null);
  const [newOffer, setNewOffer] = useState<number | null>(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const learning = !agent.initial_scrape_ready;
  const reading = useQuery({
    queryKey: [...feedKey(agent.id), "reading"],
    queryFn: () => get<{ items: Activity[] }>(`/api/v2/ai-agents/sales/${agent.id}/activities`, { action_type: "initial_setup_scrape", limit: 1 }),
    enabled: !learning,
  });
  const failedReading = reading.data?.items[0]?.action_status === "failed" ? reading.data.items[0] : null;
  useEffect(() => setForm(baseline), [baseline]);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty && !busy);
  const set = (p: Partial<MemoryForm>) => setForm((f) => ({ ...f, ...p }));
  const purpose = PURPOSE_DETAILS[agent.agent_type];

  const save = async () => {
    setBusy(true);
    try {
      const { details, ...memory } = form;
      // Blank offers are dropped; the ticked ones keep pointing at the same text.
      const kept = memory.business_offers.map((o, i) => ({ o: o.trim(), i })).filter((x) => x.o);
      const offers = { business_offers: kept.map((x) => x.o), active_business_offers_indexes: kept.flatMap((x, j) => (memory.active_business_offers_indexes.includes(x.i) ? [j] : [])) };
      await patch(`/api/v2/ai-agents/sales/${agent.id}`, { config: { memory: { ...memory, ...offers }, ...(purpose ? { [purpose.key]: details } : {}) } });
      await qc.invalidateQueries({ queryKey: agentKey(agent.id) });
      toast.success("Memory saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (learning)
    return (
      <Card className="flex items-start gap-3">
        <Sparkles size={18} className="mt-0.5 shrink-0 animate-pulse text-brand-text" />
        <div>
          <p className="text-[13px] font-medium">Reading about your business…</p>
          <p className="mt-1 text-[13px] text-muted">
            {agent.type === "website" ? `Going through ${agent.input ?? "your website"}` : "Going through your pitch"}. The company profile, offers and customer profiles show up here when it's done.
          </p>
        </div>
      </Card>
    );

  return (
    <div>
      {failedReading && (
        <Callout tone="warn" className="mb-4">
          It couldn't learn about the business: {failedReading.error_message ?? "the page couldn't be read"}. Learn again from another page or a pitch, or fill in the details below.
        </Callout>
      )}
      <Section
        title="Where it learned"
        description="The agent built this memory from your website or pitch. Edit anything below, or learn again."
        actions={
          can.write && (
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => setLearnOpen(true)}>
              Learn again
            </Button>
          )
        }
      >
        <p className="text-[13px]">
          {agent.type === "website" && agent.input ? (
            <a href={agent.input} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
              <Globe size={14} /> {agent.input}
            </a>
          ) : agent.type === "pitch_deck" ? (
            "A pitch you pasted"
          ) : (
            "Workspace details"
          )}
        </p>
      </Section>
      <Section title="Company">
        <div className="space-y-3">
          <Field label="Name">{(id) => <Input id={id} value={form.company} onChange={(e) => set({ company: e.target.value })} disabled={!can.write} maxLength={500} />}</Field>
          <Field label="What the business does">
            {(id) => <Textarea id={id} rows={5} value={form.business_description} onChange={(e) => set({ business_description: e.target.value })} disabled={!can.write} maxLength={20_000} />}
          </Field>
        </div>
      </Section>
      {purpose && (
        <Section title={purpose.label}>
          <Textarea rows={4} value={form.details} onChange={(e) => set({ details: e.target.value })} placeholder={purpose.placeholder} disabled={!can.write} aria-label={purpose.label} maxLength={20_000} />
        </Section>
      )}
      <Section title="Offers" description="Ticked offers can be mentioned in emails.">
        <div className="space-y-2">
          {form.business_offers.map((o, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="pt-2.5">
                <Checkbox
                  checked={form.active_business_offers_indexes.includes(i)}
                  disabled={!can.write}
                  onChange={(v) => set({ active_business_offers_indexes: v ? [...form.active_business_offers_indexes, i].sort((x, y) => x - y) : form.active_business_offers_indexes.filter((x) => x !== i) })}
                  aria-label="Use this offer"
                />
              </span>
              <Textarea
                rows={2}
                value={o}
                autoFocus={i === newOffer}
                disabled={!can.write}
                onChange={(e) => set({ business_offers: form.business_offers.map((x, j) => (j === i ? e.target.value : x)) })}
                aria-label={`Offer ${i + 1}`}
                placeholder="What you offer, such as a free audit or a pilot"
                maxLength={2_000}
              />
              {can.write && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="mt-1.5"
                  aria-label="Remove offer"
                  onClick={() => set({ business_offers: form.business_offers.filter((_, j) => j !== i), active_business_offers_indexes: dropIndex(form.active_business_offers_indexes, i) })}
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          ))}
          {can.write && (
            <Button
              size="sm"
              icon={<Plus size={14} />}
              disabled={form.business_offers.length >= 20}
              onClick={() => {
                setNewOffer(form.business_offers.length);
                set({ business_offers: [...form.business_offers, ""], active_business_offers_indexes: [...form.active_business_offers_indexes, form.business_offers.length] });
              }}
            >
              Add offer
            </Button>
          )}
        </div>
      </Section>
      <Section title="Ideal customer profiles" description="One campaign per active profile. Untick a profile to stop prospecting for it.">
        <div className="space-y-2">
          {form.icps.map((icp, i) => {
            const active = form.active_icps_indexes.includes(i);
            const bits = [icp.job_title?.include?.slice(0, 3).join(", "), icp.industry?.slice(0, 2).join(", "), icp.company_size?.length ? `${icp.company_size.join(", ")} employees` : null].filter(Boolean);
            return (
              <Card key={i} className={cn("flex items-start gap-3", !active && "opacity-70")}>
                <span className="pt-0.5">
                  <Checkbox
                    checked={active}
                    disabled={!can.write}
                    onChange={(v) => set({ active_icps_indexes: v ? [...form.active_icps_indexes, i].sort((x, y) => x - y) : form.active_icps_indexes.filter((x) => x !== i) })}
                    aria-label={`Use ${icp.name}`}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{icp.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">{bits.join(" · ") || "Any job title, industry and size"}</p>
                  {icp.problems_solved?.length ? <p className="mt-1 line-clamp-2 text-xs text-faint">Solves: {icp.problems_solved.join("; ")}</p> : null}
                </div>
                {can.write && (
                  <div className="flex shrink-0 gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${icp.name}`} onClick={() => setIcpEdit({ icp, index: i })}>
                      <Pencil size={14} />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove ${icp.name}`} onClick={() => set({ icps: form.icps.filter((_, j) => j !== i), active_icps_indexes: dropIndex(form.active_icps_indexes, i) })}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
          {!form.icps.length && <p className="text-[13px] text-muted">No profiles yet. Add one so the agent knows who to look for.</p>}
          {can.write && (
            <Button size="sm" icon={<Plus size={14} />} disabled={form.icps.length >= 10} onClick={() => setIcpEdit({ icp: { name: "" }, index: null })}>
              Add profile
            </Button>
          )}
        </div>
      </Section>
      <div className="py-6">
        <RulesCard agent={agent} />
      </div>
      {can.write && dirty && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <span className="mr-auto text-[13px] text-muted">Unsaved changes</span>
          <Button disabled={busy} onClick={() => setForm(baseline)}>
            Discard
          </Button>
          <Button variant="primary" loading={busy} disabled={!form.company.trim() && !form.business_description.trim()} onClick={save}>
            Save memory
          </Button>
        </div>
      )}
      <IcpDialog
        value={icpEdit}
        onClose={() => setIcpEdit(null)}
        onSave={(icp, index) =>
          index === null ? set({ icps: [...form.icps, icp], active_icps_indexes: [...form.active_icps_indexes, form.icps.length] }) : set({ icps: form.icps.map((x, j) => (j === index ? icp : x)) })
        }
      />
      <LearnDialog agent={agent} open={learnOpen} onClose={() => setLearnOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Leads & results

interface Analytics {
  total_email_activity_per_day: Array<{ x: string; y: number }>;
  replies_per_day: Array<{ x: string; y: number }>;
  leads_found_per_day: Array<{ x: string; y: number }>;
  opportunities_per_day: Array<{ x: string; y: number }>;
  totals: { total_sent: number; replies: number; opportunities: number; opportunities_amount: number; total_email_activity: number; leads_found: number };
}

interface LeadRow {
  email: string;
  emails_sent: number;
  open_count: number;
  replied: boolean;
  reply_count: number;
  click_count: number;
  bounced: boolean;
  has_opportunity: boolean;
}

export function SalesLeads() {
  const { agent } = useSales();
  const zone = useWorkspaceZone();
  const [range, setRange] = useState<DateRange>(() => resolveRange("30d", undefined, zone));
  const q = { start_date: range.start_date, end_date: range.end_date };
  const [filter, setFilter] = useState<"all" | "replied" | "has_opportunity">("all");
  const analytics = useQuery({ queryKey: ["sales-agent-analytics", agent.id, q], queryFn: () => get<Analytics>(`/api/v2/ai-agents/sales/${agent.id}/analytics`, q) });
  const summary = useQuery({
    queryKey: ["sales-agent-lead-summary", agent.id, q],
    queryFn: () => get<{ total: number; replied: number; has_opportunity: number; reply_rate: number; opportunity_rate: number }>(`/api/v2/ai-agents/sales/${agent.id}/leads/activity/summary`, q),
  });
  const campaigns = useQuery({
    queryKey: ["campaigns", "sales-agent", agent.id],
    queryFn: () => get<ApiPage<{ id: string; name: string; status: number }>>("/api/v2/campaigns", { ai_sales_agent_id: agent.id, limit: 100 }),
  });
  const leads = useInfiniteQuery({
    queryKey: ["sales-agent-leads", agent.id, q, filter],
    queryFn: ({ pageParam }) =>
      get<{ items: LeadRow[]; total: number; next_starting_after?: string }>(`/api/v2/ai-agents/sales/${agent.id}/leads/activity`, { ...q, limit: 50, starting_after: pageParam, ...(filter === "all" ? {} : { filter }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_starting_after,
  });
  const chart = useMemo(() => {
    const d = analytics.data;
    if (!d) return [];
    const byDay = new Map<string, { date: string; activity: number; replies: number; leads: number }>();
    const row = (date: string) => byDay.get(date) ?? byDay.set(date, { date, activity: 0, replies: 0, leads: 0 }).get(date)!;
    for (const p of d.total_email_activity_per_day) row(p.x).activity = p.y;
    for (const p of d.replies_per_day) row(p.x).replies = p.y;
    for (const p of d.leads_found_per_day) row(p.x).leads = p.y;
    return fillDays([...byDay.values()].sort((x, y) => x.date.localeCompare(y.date)), range.start_date, range.end_date, { activity: 0, replies: 0, leads: 0 });
  }, [analytics.data, range.start_date, range.end_date]);
  const t = analytics.data?.totals;
  const rows = leads.data?.pages.flatMap((p) => p.items) ?? [];
  const STATUS_LABEL: Record<number, string> = { 1: "Interested", 2: "Meeting booked", 3: "Meeting completed", 4: "Won" };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Results</h2>
        <RangeSelect value={range} onChange={setRange} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Leads found" value={num(t?.leads_found)} />
        <StatCard label="Emails sent" value={num(t?.total_sent)} />
        <StatCard label="Replies" value={num(t?.replies)} sub={summary.data ? `${pct(summary.data.replied, summary.data.total)} of leads` : undefined} />
        <StatCard label="Opportunities" value={num(t?.opportunities)} sub={summary.data ? `${pct(summary.data.has_opportunity, summary.data.total)} of leads` : undefined} tone={t?.opportunities ? "ok" : undefined} />
        <StatCard label="Pipeline value" value={money(t?.opportunities_amount ?? 0)} />
      </div>
      <Card>
        <CardHeader title="Activity" />
        {chart.length ? (
          <TrendChart
            data={chart}
            height={220}
            series={[
              { key: "activity", label: "Email activity" },
              { key: "replies", label: "Replies" },
              { key: "leads", label: "Leads found" },
            ]}
          />
        ) : (
          <p className="text-[13px] text-muted">{analytics.isLoading ? "Loading…" : "No activity in this period."}</p>
        )}
      </Card>
      <Card>
        <CardHeader title="Campaigns" description="Campaigns the agent created and runs." />
        {campaigns.data?.items.length ? (
          <ul className="divide-y divide-line">
            {campaigns.data.items.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <Link to={`/app/campaign/${c.id}/analytics`} className="-my-1 truncate py-1 text-[13px] font-medium hover:underline">
                  {c.name}
                </Link>
                <Badge tone={c.status === 1 ? "ok" : c.status === 3 ? "info" : "neutral"}>{c.status === 1 ? "Active" : c.status === 2 ? "Paused" : c.status === 3 ? "Completed" : "Draft"}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">{campaigns.isLoading ? "Loading…" : "No campaigns yet. The agent drafts one per active customer profile once it's on."}</p>
        )}
      </Card>
      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-5">
          <h3 className="text-sm font-semibold">Leads{leads.data ? ` (${num(leads.data.pages[0]?.total ?? 0)})` : ""}</h3>
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "replied", label: "Replied" },
              { value: "has_opportunity", label: "Opportunities" },
            ]}
          />
        </div>
        <div className="mt-3">
          <DataTable
            rows={rows}
            rowKey={(x) => x.email}
            loading={leads.isLoading}
            hasMore={leads.hasNextPage}
            loadingMore={leads.isFetchingNextPage}
            onLoadMore={() => leads.fetchNextPage()}
            empty={<p className="py-10 text-center text-[13px] text-muted">No emails sent to leads in this period.</p>}
            columns={[
              {
                key: "email",
                header: "Lead",
                cell: (x) => (
                  <Link to={`/app/unibox?search=${encodeURIComponent(x.email)}`} className="font-medium hover:underline">
                    {x.email}
                  </Link>
                ),
              },
              { key: "sent", header: "Sent", cell: (x) => num(x.emails_sent) },
              { key: "opens", header: "Opens", cell: (x) => num(x.open_count), hideBelow: "sm" },
              { key: "clicks", header: "Clicks", cell: (x) => num(x.click_count), hideBelow: "md" },
              {
                key: "state",
                header: "Status",
                cell: (x) =>
                  x.bounced ? (
                    <Badge tone="bad">Bounced</Badge>
                  ) : x.has_opportunity ? (
                    <Badge tone="ok">{STATUS_LABEL[(x as LeadRow & { lt_interest_status?: number }).lt_interest_status ?? 1] ?? "Opportunity"}</Badge>
                  ) : x.replied ? (
                    <Badge tone="info">Replied</Badge>
                  ) : (
                    <span className="text-muted">Contacted</span>
                  ),
              },
            ]}
          />
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Settings

interface SettingsForm {
  name: string;
  description: string;
  self_improvement: boolean;
  autonomy: SalesConfig["autonomy_settings"];
  enrichment: SalesConfig["enrichment_settings"];
  outreach: Omit<SalesConfig["outreach_settings"], "campaign_schedule">;
  slack: string;
}

function settingsForm(a: SalesAgent): SettingsForm {
  const { campaign_schedule: _schedule, ...outreach } = a.config.outreach_settings;
  return {
    name: a.name,
    description: a.description ?? "",
    self_improvement: a.self_improvement !== false,
    autonomy: a.config.autonomy_settings,
    enrichment: a.config.enrichment_settings,
    outreach,
    slack: a.config.slack_connection_id ?? "",
  };
}

/** Weekdays 9 to 5 on the workspace's clock, as new campaigns get. */
const defaultSchedule = (timezone: string): CampaignSchedule =>
  ({ schedules: [{ name: "Weekdays", timing: { from: "09:00", to: "17:00" }, days: { "1": true, "2": true, "3": true, "4": true, "5": true }, timezone }] }) as CampaignSchedule;

export function SalesSettings() {
  const { agent } = useSales();
  const zone = useWorkspaceZone();
  const qc = useQueryClient();
  const nav = useNavigate();
  const can = useCan();
  const confirm = useConfirm();
  const integrations = useIntegrations();
  const filterOptions = useFilterOptions();
  const baseline = useMemo(() => settingsForm(agent), [agent]);
  const [form, setForm] = useState(baseline);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(baseline), [baseline]);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty && !busy);
  const set = (p: Partial<SettingsForm>) => setForm((f) => ({ ...f, ...p }));
  const setAuto = (p: Partial<SettingsForm["autonomy"]>) => set({ autonomy: { ...form.autonomy, ...p } });
  const setEnrich = (p: Partial<SettingsForm["enrichment"]>) => set({ enrichment: { ...form.enrichment, ...p } });
  const setOut = (p: Partial<SettingsForm["outreach"]>) => set({ outreach: { ...form.outreach, ...p } });
  const available = new Set((filterOptions.data?.signals ?? []).filter((x) => x.available).map((x) => x.key));
  const slackConns = (integrations.data?.items ?? []).filter((i) => i.type === "slack");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: agentKey(agent.id) }), qc.invalidateQueries({ queryKey: AGENTS_KEY })]);

  const save = async () => {
    setBusy(true);
    try {
      await patch(`/api/v2/ai-agents/sales/${agent.id}`, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        self_improvement: form.self_improvement,
        config: { autonomy_settings: form.autonomy, enrichment_settings: form.enrichment, outreach_settings: form.outreach, slack_connection_id: form.slack || null },
      });
      await refresh();
      toast.success("Settings saved. They apply to the agent's campaigns too.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete "${agent.name}"?`, description: "Its live feed and research are deleted. Campaigns it created must be deleted first.", confirmLabel: "Delete agent", danger: true, typeToConfirm: agent.name }))) return;
    try {
      await del(`/api/v2/ai-agents/sales/${agent.id}`);
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success("Agent deleted");
      nav("/app/ai-agents");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const signals = Object.keys(SIGNAL_LABELS);
  return (
    <div>
      <Section title="Name">
        <div className="space-y-3">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} disabled={!can.write} maxLength={200} aria-label="Agent name" />
          <Textarea rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} disabled={!can.write} placeholder="What this agent is for (optional)" aria-label="Description" maxLength={2_000} />
        </div>
      </Section>
      <Section title="Autonomy" description="What the agent may do without asking.">
        <div className="space-y-1">
          <SwitchRow label="Autopilot" description="Launch campaigns, add prospects and make changes without waiting for approval." checked={form.autonomy.autopilot_mode} onChange={(v) => setAuto({ autopilot_mode: v })} />
          <SwitchRow
            label="Answer replies"
            description="Draft an answer to each reply. On autopilot, the ones it's sure about go out after a few minutes; the rest wait for you in the live feed. When off, replies are left to you."
            checked={form.autonomy.auto_reply_to_responses}
            onChange={(v) => setAuto({ auto_reply_to_responses: v })}
          />
          <SwitchRow label="Test new angles" description="When a campaign gets few replies, propose a new first email to test against the current one." checked={form.self_improvement} onChange={(v) => set({ self_improvement: v })} />
          <SwitchRow
            label="Only use leads I add"
            description="Don't prospect. Instead, put the leads you add to the agent's list into the campaign that fits them best."
            checked={form.autonomy.manual_leads_mode}
            onChange={(v) => setAuto({ manual_leads_mode: v })}
          />
          {form.autonomy.manual_leads_mode && agent.master_lead_list_id && (
            <p className="pl-1 text-xs text-muted">
              Add leads to{" "}
              <Link to={`/app/lead-finder/leads?list=${agent.master_lead_list_id}`} className="font-medium text-brand-text hover:underline">
                the agent's lead list
              </Link>
              .
            </p>
          )}
        </div>
      </Section>
      {!form.autonomy.manual_leads_mode && (
        <Section title="Prospecting" description="How the agent finds people in the Lead Finder database.">
          <div className="space-y-4">
            <Field label="People to look up per round" hint="Each round runs about once an hour while a campaign needs more leads.">
              {(id) => <NumberInput id={id} className="w-40" min={1} max={200} value={form.enrichment.enrichment_limit_per_run} onChange={(v) => setEnrich({ enrichment_limit_per_run: Math.min(200, Math.max(1, v ?? 1)) })} suffix="people" />}
            </Field>
            <SwitchRow
              label="Prefer companies showing a buying signal"
              description="Put people at companies with recent news first."
              checked={form.enrichment.signal_targeting_enabled}
              onChange={(v) => setEnrich({ signal_targeting_enabled: v })}
            >
              <div className="mt-3">
                <ChipToggle
                  options={signals.filter((k) => available.has(k) || form.enrichment.signal_targeting_categories.includes(k)).map((k) => SIGNAL_LABELS[k]!)}
                  value={form.enrichment.signal_targeting_categories.map((k) => SIGNAL_LABELS[k] ?? k)}
                  onChange={(labels) => setEnrich({ signal_targeting_categories: signals.filter((k) => labels.includes(SIGNAL_LABELS[k]!)).slice(0, 26) })}
                  disabled={!can.write}
                />
                <p className="mt-2 text-xs text-muted">
                  {available.size
                    ? "Only signals this server has data for are listed. Social, review-site, traffic and job-change signals need data sources it doesn't have."
                    : "This server has no signal data yet, so this setting has no effect."}
                </p>
              </div>
            </SwitchRow>
          </div>
        </Section>
      )}
      <Section title="Sending" description="Applies to every campaign the agent runs.">
        <div className="space-y-4">
          <AccountsPicker emails={form.outreach.email_list} tagIds={form.outreach.email_tag_list} onChange={({ emails, tagIds }) => setOut({ email_list: emails, email_tag_list: tagIds })} disabled={!can.write} />
          <Field label="Daily limit per campaign">
            {(id) => <NumberInput id={id} className="w-40" min={1} max={100_000} value={form.outreach.daily_limit} onChange={(v) => setOut({ daily_limit: Math.max(1, v ?? 1) })} suffix="emails" />}
          </Field>
          <div className="space-y-1">
            <SwitchRow label="Stop emailing a lead after they reply" checked={form.outreach.stop_on_reply} onChange={(v) => setOut({ stop_on_reply: v })} />
            <SwitchRow label="Send the first email as plain text" description="Plain text first emails land in the inbox more often." checked={form.outreach.first_email_text_only} onChange={(v) => setOut({ first_email_text_only: v })} />
            <SwitchRow label="Track opens" description="Adds a tracking pixel. Leave off for better deliverability." checked={form.outreach.open_tracking} onChange={(v) => setOut({ open_tracking: v })} />
            <SwitchRow label="New leads first" description="Start new leads before following up with earlier ones." checked={form.outreach.prioritize_new_leads} onChange={(v) => setOut({ prioritize_new_leads: v })} />
            <SwitchRow label="Match the lead's email provider" description="Send from Google mailboxes to Google users and Microsoft to Microsoft when possible." checked={form.outreach.match_lead_esp} onChange={(v) => setOut({ match_lead_esp: v })} />
            <SwitchRow
              label="Add an opt-out line"
              description="A short line inviting the lead to say if it isn't relevant."
              checked={form.outreach.opt_out_settings.text_opt_out_enabled}
              onChange={(v) => setOut({ opt_out_settings: { text_opt_out_enabled: v } })}
            />
          </div>
        </div>
      </Section>
      <Section title="Slack" description="A daily summary and alerts when something needs you.">
        {slackConns.length ? (
          <NativeSelect value={form.slack} onChange={(v) => set({ slack: v })} disabled={!can.write} options={[{ value: "", label: "No Slack updates" }, ...slackConns.map((c) => ({ value: c.id, label: c.name }))]} aria-label="Slack connection" />
        ) : (
          <p className="text-[13px] text-muted">
            <Link to="/app/settings/integrations" className="font-medium text-brand-text hover:underline">
              Connect Slack
            </Link>{" "}
            to get updates in a channel.
          </p>
        )}
      </Section>
      {can.write && dirty && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <span className="mr-auto text-[13px] text-muted">Unsaved changes</span>
          <Button disabled={busy} onClick={() => setForm(baseline)}>
            Discard
          </Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={save}>
            Save settings
          </Button>
        </div>
      )}
      <div className="py-6">
        <ScheduleEditor
          title="Sending schedule"
          readOnly={!can.write}
          schedule={agent.config.outreach_settings.campaign_schedule ?? defaultSchedule(zone)}
          onSave={async (schedule) => {
            await patch(`/api/v2/ai-agents/sales/${agent.id}`, { config: { outreach_settings: { campaign_schedule: schedule } } });
            await refresh();
          }}
          scope={agent.id}
        />
      </div>
      {can.write && (
        <Section title="Delete agent" description="Delete or move its campaigns first.">
          <Button variant="danger" icon={<Trash2 size={14} />} onClick={remove}>
            Delete agent
          </Button>
        </Section>
      )}
    </div>
  );
}

export function SalesRedirect(): ReactNode {
  return <Navigate to="/app/ai-agents" replace />;
}

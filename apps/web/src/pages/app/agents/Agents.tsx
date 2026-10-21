import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Bot, CalendarX2, Check, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { errorMessage, get, post } from "@/lib/api";
import { ago, num, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, MenuItem, Page, PageHeader, RowMenu, SearchInput, Segmented, SkeletonRows, useConfirm } from "@/components/ui";
import {
  AGENTS_KEY,
  AiMissingCallout,
  AgentStatusBadge,
  KIND_META,
  ModeBadge,
  OUTBOUND_PURPOSES,
  agentPath,
  deleteAgent,
  purposeLabel,
  renameAgent,
  setAgentActive,
  useAgents,
  type AgentKind,
  type AgentListItem,
} from "./shared";
import { ReplyAgentForm, ReplyConfiguration, ReplyDetails, ReplyOverview, ReplyShell } from "./ReplyAgent";
import { LeadFinderAgentForm, LeadFinderConfiguration, LeadFinderDetails, LeadFinderOverview, LeadFinderShell } from "./LeadFinderAgent";

// ---------------------------------------------------------------------------------------------------------------
// List

function statLine(a: AgentListItem) {
  const s = a.stats;
  switch (a.kind) {
    case "reply":
      return `${num(s.awaiting_review)} waiting for review · ${num(s.sent)} sent`;
    case "lead_finder":
      return `${plural(s.leads_added ?? 0, "lead")} added to ${a.campaign?.name ?? "a deleted campaign"}`;
    case "deliverability":
      return `${s.score === null || s.score === undefined ? "No score yet" : `Health ${s.score}/100`} · ${plural(Number(s.open_issues ?? 0), "open issue")}`;
    case "sales":
      return `${plural(Number(s.campaigns ?? 0), "campaign")} · ${num(s.awaiting_review)} waiting for approval`;
  }
}

function RenameDialog({ agent, onClose }: { agent: AgentListItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(agent?.name ?? ""), [agent]);
  const save = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      await renameAgent(agent, name.trim());
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success("Agent renamed");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!agent}
      onOpenChange={(v) => !v && onClose()}
      title="Rename agent"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} onKeyDown={(e) => e.key === "Enter" && name.trim() && save()} />}</Field>
    </Dialog>
  );
}

function AgentCard({ a, onRename }: { a: AgentListItem; onRename: (a: AgentListItem) => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const nav = useNavigate();
  const confirm = useConfirm();
  const meta = KIND_META[a.kind];
  const Icon = meta.icon;
  const toggle = async () => {
    try {
      await setAgentActive(a, a.status !== 1);
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success(a.status === 1 ? "Agent paused" : "Agent turned on");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: `Delete "${a.name}"?`,
      description:
        a.kind === "sales"
          ? "Its activity history goes too. Campaigns it created must be deleted or moved out of the agent first."
          : a.kind === "reply"
            ? "Drafts waiting for review are discarded. Replies already sent stay in the Unibox."
            : "Its activity history is deleted too.",
      confirmLabel: "Delete agent",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteAgent(a);
      await qc.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success("Agent deleted");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const subtitle = a.kind === "sales" ? `${meta.label} · ${purposeLabel(a.agent_type)}` : a.kind === "reply" && a.no_show ? `${meta.label} · no-show recovery` : meta.label;
  return (
    <Card className="flex flex-col gap-3 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-3">
        <span className="rounded-lg bg-brand-soft p-2 text-brand-text">
          <Icon size={18} />
        </span>
        <Link to={agentPath(a)} className="min-w-0 flex-1">
          <p className="truncate font-semibold hover:underline">{a.name}</p>
          <p className="truncate text-xs text-muted">{subtitle}</p>
        </Link>
        {can.write && (
          <RowMenu>
            <MenuItem icon={a.status === 1 ? <Pause size={14} /> : <Play size={14} />} onSelect={toggle}>
              {a.status === 1 ? "Pause" : a.kind === "deliverability" ? "Deploy again" : "Turn on"}
            </MenuItem>
            {a.kind !== "deliverability" && (
              <MenuItem icon={<Pencil size={14} />} onSelect={() => onRename(a)}>
                Rename
              </MenuItem>
            )}
            <MenuItem icon={<Trash2 size={14} />} danger onSelect={remove}>
              Delete
            </MenuItem>
          </RowMenu>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <AgentStatusBadge status={a.status} learning={a.learning} />
        <ModeBadge mode={a.mode} />
      </div>
      {a.description && <p className="line-clamp-2 text-[13px] text-muted">{a.description}</p>}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
        <span className="truncate">{statLine(a)}</span>
        <button type="button" className="-my-1 shrink-0 py-1 font-medium text-brand-text hover:underline" onClick={() => nav(agentPath(a))}>
          Open
        </button>
      </div>
      {a.last_run_at && <p className="-mt-2 text-[11px] text-faint">Last worked {ago(a.last_run_at)}</p>}
    </Card>
  );
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "reply", label: "Reply" },
  { value: "sales", label: "Outbound" },
  { value: "lead_finder", label: "Lead finder" },
  { value: "deliverability", label: "Deliverability" },
] as const;

/** /app/ai-agents */
export default function AgentsList() {
  usePageTitle("Agents");
  const can = useCan();
  const nav = useNavigate();
  const agents = useAgents();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<AgentListItem | null>(null);
  const items = agents.data?.items ?? [];
  const shown = items.filter((a) => (filter === "all" || a.kind === filter) && (!search.trim() || a.name.toLowerCase().includes(search.trim().toLowerCase())));
  const needsAi = items.some((a) => (a.kind === "reply" || a.kind === "sales") && a.status === 1);
  return (
    <Page>
      <PageHeader
        title="Agents"
        description="Agents work next to your team: they answer replies, run outbound, keep campaigns stocked with leads and watch your deliverability."
        actions={
          can.write && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => nav("/app/ai-agents/create")}>
              New agent
            </Button>
          )
        }
      />
      {agents.data && !agents.data.ai_available && needsAi && (
        <div className="mb-5">
          <AiMissingCallout what="Reply and outbound agents" />
        </div>
      )}
      {agents.isLoading ? (
        <SkeletonRows rows={5} />
      ) : !items.length ? (
        <Card padded={false}>
          <EmptyState
            icon={<Bot size={22} />}
            title="No agents yet"
            description="Start with a reply agent to answer leads faster, or a lead finder agent to keep a campaign from running dry."
            action={
              can.write && (
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => nav("/app/ai-agents/create")}>
                  Choose an agent
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Segmented
              className="max-w-full overflow-x-auto"
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((f) => ({ value: f.value, label: f.value === "all" ? `All (${items.length})` : f.label }))}
            />
            <SearchInput value={search} onChange={setSearch} placeholder="Search agents" className="w-full sm:ml-auto sm:w-64" />
          </div>
          {shown.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((a) => (
                <AgentCard key={a.id} a={a} onRename={setRenaming} />
              ))}
            </div>
          ) : (
            <p className="py-10 text-center text-[13px] text-muted">No agents match.</p>
          )}
        </>
      )}
      <RenameDialog agent={renaming} onClose={() => setRenaming(null)} />
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Create

interface Choice {
  key: string;
  kind: AgentKind;
  title: string;
  icon: typeof Bot;
  points: string[];
  cta: string;
}

const CHOICES: Choice[] = [
  {
    key: "reply",
    kind: "reply",
    title: "Reply agent",
    icon: KIND_META.reply.icon,
    points: ["Drafts or sends answers to lead replies within minutes", "Follows up when a conversation goes quiet", "Handles questions and objections with your guidance", "Sets lead statuses and hands tricky threads to you"],
    cta: "Set up a reply agent",
  },
  {
    key: "no_show",
    kind: "reply",
    title: "No-show recovery",
    icon: CalendarX2,
    points: ["Follows up with leads marked as no-show", "Offers a new time with your booking link", "Stops as soon as the lead books or replies", "Shows how many meetings were recovered"],
    cta: "Set up no-show recovery",
  },
  {
    key: "sales",
    kind: "sales",
    title: "Outbound agent",
    icon: KIND_META.sales.icon,
    points: ["Learns your business from a website or description", "Finds people who match your ideal customers", "Writes and launches campaigns for each profile", "Asks before acting until you switch on autopilot"],
    cta: "Set up an outbound agent",
  },
  {
    key: "lead_finder",
    kind: "lead_finder",
    title: "Lead finder agent",
    icon: KIND_META.lead_finder.icon,
    points: ["Watches how many leads a campaign has left", "Adds new people who match your filters", "Suggests audiences from the leads you already have", "Widens the search or pauses when people run out"],
    cta: "Set up a lead finder agent",
  },
  {
    key: "deliverability",
    kind: "deliverability",
    title: "Deliverability agent",
    icon: KIND_META.deliverability.icon,
    points: ["Checks DNS, blocklists, bounces and warmup daily", "Flags risky campaign settings and copy", "One click to pause the mailboxes at risk", "Works across the whole workspace"],
    cta: "Deploy",
  },
];

function ChooseAgent() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const agents = useAgents();
  const [deploying, setDeploying] = useState(false);
  const [purpose, setPurpose] = useState(2);
  const deployed = (agents.data?.items ?? []).find((a) => a.kind === "deliverability");
  const pick = async (c: Choice) => {
    if (c.kind === "sales") return nav(`/app/ai-sales-agent/create?agent_type=${purpose}`);
    if (c.kind === "deliverability") {
      if (deployed?.status === 1) return nav("/app/ai-agents/deliverability");
      setDeploying(true);
      try {
        await post("/api/v2/ai-agents/deliverability/deploy");
        await qc.invalidateQueries({ queryKey: AGENTS_KEY });
        toast.success("Deliverability agent deployed. The first checks are running.");
        nav("/app/ai-agents/deliverability");
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setDeploying(false);
      }
      return;
    }
    nav(`/app/ai-agents/create?type=${c.key}`);
  };
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {CHOICES.map((c) => (
        <Card key={c.key} className="flex flex-col">
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-brand-soft p-2 text-brand-text">
              <c.icon size={18} />
            </span>
            <h2 className="font-semibold">{c.title}</h2>
            {c.kind === "deliverability" && <Badge className="ml-auto">Workspace-wide</Badge>}
          </div>
          <ul className="mt-4 flex-1 space-y-2 text-[13px] text-muted">
            {c.points.map((p) => (
              <li key={p} className="flex gap-2">
                <Check size={15} className="mt-0.5 shrink-0 text-ok" />
                {p}
              </li>
            ))}
          </ul>
          {c.kind === "sales" && (
            <label className="mt-4 block text-xs text-muted">
              Reach out to
              <select
                className="mt-1 block h-8 w-full rounded-lg border border-line-strong bg-panel px-2 text-[13px] text-text"
                value={purpose}
                onChange={(e) => setPurpose(Number(e.target.value))}
              >
                {OUTBOUND_PURPOSES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label === "Sales" ? "Potential customers" : p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button className="mt-4 w-full" variant={c.key === "reply" ? "primary" : "secondary"} loading={c.kind === "deliverability" && deploying} onClick={() => pick(c)}>
            {c.kind === "deliverability" && deployed?.status === 1 ? "Open" : c.kind === "deliverability" && deployed ? "Deploy again" : c.cta}
          </Button>
        </Card>
      ))}
    </div>
  );
}

/** /app/ai-agents/create (and ?type=reply|no_show|lead_finder) */
export function CreateAgent() {
  const [params] = useSearchParams();
  const type = params.get("type");
  usePageTitle("New agent");
  const back = (
    <Link to={type ? "/app/ai-agents/create" : "/app/ai-agents"} className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
      <ArrowLeft size={14} /> {type ? "Choose another agent" : "Agents"}
    </Link>
  );
  if (type === "reply" || type === "no_show") {
    return (
      <Page className="max-w-4xl">
        <PageHeader back={back} title={type === "no_show" ? "Set up no-show recovery" : "Set up a reply agent"} description="You can change every setting later." />
        <ReplyAgentForm preset={type === "no_show" ? "no_show" : undefined} />
      </Page>
    );
  }
  if (type === "lead_finder") {
    return (
      <Page className="max-w-4xl">
        <PageHeader back={back} title="Set up a lead finder agent" description="Pick the campaign to keep stocked and who to look for." />
        <LeadFinderAgentForm />
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader back={back} title="Choose an agent" description="Each agent does one job well. Add as many as you need." />
      <ChooseAgent />
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One agent: /app/ai-agents/:agent_id (+ configuration, details)

export interface AgentOutlet {
  id: string;
  kind: "reply" | "lead_finder";
}

/** Looks up the agent's kind, then shows the page for that kind. */
export function AgentLayout() {
  const { agent_id } = useParams();
  const q = useQuery({ queryKey: ["ai-agent-kind", agent_id], queryFn: () => get<{ id: string; kind: AgentKind; name: string }>(`/api/app/ai-agents/${agent_id}`), retry: false });
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (!q.data)
    return (
      <Page>
        <EmptyState title="Agent not found" description="It may have been deleted." action={<Link to="/app/ai-agents">Back to agents</Link>} />
      </Page>
    );
  if (q.data.kind === "sales") return <Navigate to={`/app/ai-sales-agent/${q.data.id}`} replace />;
  if (q.data.kind === "deliverability") return <Navigate to="/app/ai-agents/deliverability" replace />;
  return <AgentShell id={q.data.id} kind={q.data.kind} />;
}

function AgentShell({ id, kind }: AgentOutlet) {
  if (kind === "reply") return <ReplyShell id={id} />;
  return <LeadFinderShell id={id} />;
}

export function AgentOverview() {
  const o = useOutletContext<AgentOutlet>();
  return o.kind === "reply" ? <ReplyOverview id={o.id} /> : <LeadFinderOverview id={o.id} />;
}

export function AgentConfiguration() {
  const o = useOutletContext<AgentOutlet>();
  return o.kind === "reply" ? <ReplyConfiguration id={o.id} /> : <LeadFinderConfiguration id={o.id} />;
}

export function AgentDetails() {
  const o = useOutletContext<AgentOutlet>();
  return o.kind === "reply" ? <ReplyDetails id={o.id} /> : <LeadFinderDetails id={o.id} />;
}

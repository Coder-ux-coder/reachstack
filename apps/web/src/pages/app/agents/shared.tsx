import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Bot, Gauge, MessageSquareReply, Search, type LucideIcon } from "lucide-react";
import { del, get, patch, post } from "@/lib/api";
import { Badge, Callout } from "@/components/ui";

export type AgentKind = "reply" | "lead_finder" | "deliverability" | "sales";

export interface AgentListItem {
  id: string;
  kind: AgentKind;
  name: string;
  description: string | null;
  status: number;
  created_at: string;
  last_run_at: string | null;
  mode: "review" | "autopilot" | null;
  no_show?: boolean;
  agent_type?: number;
  learning?: boolean;
  campaign?: { id: string; name: string | null };
  stats: Record<string, number | null>;
}

export const AGENTS_KEY = ["ai-agents"] as const;

export function useAgents() {
  return useQuery({ queryKey: AGENTS_KEY, queryFn: () => get<{ items: AgentListItem[]; ai_available: boolean }>("/api/app/ai-agents") });
}

export interface Integration {
  id: string;
  type: "slack" | "calendly" | string;
  name: string;
  status: string;
  error: string | null;
}

/** Slack and Calendly connections from Settings → Integrations & API. */
export function useIntegrations() {
  return useQuery({ queryKey: ["integrations"], queryFn: () => get<{ items: Integration[] }>("/api/app/integrations"), staleTime: 60_000 });
}

export const KIND_META: Record<AgentKind, { label: string; icon: LucideIcon; blurb: string }> = {
  reply: { label: "Reply agent", icon: MessageSquareReply, blurb: "Answers replies and follows up in the Unibox" },
  sales: { label: "Outbound agent", icon: Bot, blurb: "Finds prospects, writes campaigns and runs outreach" },
  lead_finder: { label: "Lead finder agent", icon: Search, blurb: "Keeps a campaign stocked with matching leads" },
  deliverability: { label: "Deliverability agent", icon: Gauge, blurb: "Watches mailboxes and campaigns for risks" },
};

/** Purposes an outbound agent can be set up for (agent_type on the API). */
export const OUTBOUND_PURPOSES: Array<{ value: number; label: string; noun: string }> = [
  { value: 2, label: "Sales", noun: "customers" },
  { value: 4, label: "Affiliate partners", noun: "affiliates" },
  { value: 7, label: "Recruiting", noun: "candidates" },
  { value: 8, label: "Investors", noun: "investors" },
  { value: 9, label: "User research", noun: "research participants" },
  { value: 10, label: "Partnerships", noun: "partners" },
];

export const purposeLabel = (t: number | undefined) => OUTBOUND_PURPOSES.find((p) => p.value === t)?.label ?? "Sales";

export function AgentStatusBadge({ status, learning }: { status: number; learning?: boolean }) {
  if (status === -1) return <Badge tone="bad">Needs attention</Badge>;
  if (status !== 1) return <Badge tone="neutral">Paused</Badge>;
  if (learning) return <Badge tone="info">Learning</Badge>;
  return (
    <Badge tone="ok" dot>
      Active
    </Badge>
  );
}

export function ModeBadge({ mode }: { mode: "review" | "autopilot" | null | undefined }) {
  if (!mode) return null;
  return mode === "autopilot" ? <Badge tone="brand">Autopilot</Badge> : <Badge tone="neutral">Review first</Badge>;
}

/** Where an agent opens. */
export function agentPath(a: { id: string; kind: AgentKind }) {
  if (a.kind === "sales") return `/app/ai-sales-agent/${a.id}`;
  if (a.kind === "deliverability") return "/app/ai-agents/deliverability";
  return `/app/ai-agents/${a.id}`;
}

/** Turns an agent on or off with the endpoint its kind uses. */
export async function setAgentActive(a: { id: string; kind: AgentKind }, active: boolean) {
  switch (a.kind) {
    case "reply":
      return patch(`/api/v2/ai-agents/inbox-manager/${a.id}`, { status: active ? 1 : 0 });
    case "lead_finder":
      return post(`/api/v2/ai-agents/lead-finder/${a.id}/${active ? "resume" : "pause"}`);
    case "deliverability":
      return active ? post("/api/v2/ai-agents/deliverability/deploy") : post("/api/app/ai-agents/deliverability/pause");
    case "sales":
      return patch(`/api/v2/ai-agents/sales/${a.id}`, { status: active ? 1 : 0 });
  }
}

export async function renameAgent(a: { id: string; kind: AgentKind }, name: string) {
  const base = { reply: "inbox-manager", lead_finder: "lead-finder", sales: "sales", deliverability: null }[a.kind];
  if (!base) throw new Error("This agent can't be renamed");
  return patch(`/api/v2/ai-agents/${base}/${a.id}`, { name });
}

export async function deleteAgent(a: { id: string; kind: AgentKind }) {
  const base = { reply: "inbox-manager", lead_finder: "lead-finder", sales: "sales", deliverability: "deliverability" }[a.kind];
  return del(`/api/v2/ai-agents/${base}/${a.id}`);
}

/** Shown wherever an agent needs AI and the workspace has no key. */
export function AiMissingCallout({ what = "This agent" }: { what?: string }) {
  return (
    <Callout
      tone="warn"
      title="AI isn't set up yet"
      action={
        <Link to="/app/settings/integrations#ai" className="text-[13px] font-medium text-brand-text hover:underline">
          Add a key
        </Link>
      }
    >
      {what} writes with AI. Add an Anthropic API key in Settings → Integrations & API → AI, or ask the person who runs this server to set one for everyone.
    </Callout>
  );
}

export const pctOf = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

/** Seconds saved, as "3h 20m" / "12m". */
export function duration(seconds: number | null | undefined) {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h) return `${h}h${m ? ` ${m}m` : ""}`;
  return `${m}m`;
}

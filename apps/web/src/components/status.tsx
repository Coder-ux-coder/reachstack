import {
  ACCOUNT_STATUS_LABELS,
  CAMPAIGN_STATUS_LABELS,
  DEFAULT_INTEREST_STATUSES,
  HEALTH_STATUS_LABELS,
  LEAD_STATUS_LABELS,
  VERIFICATION_STATUS_LABELS,
  WARMUP_STATUS_LABELS,
  type HealthStatus,
  type MailboxHealth,
} from "@reachstack/shared";
import { Globe } from "lucide-react";
import { Badge, type Tone } from "@/components/ui";

const campaignTone: Record<number, Tone> = { [-99]: "bad", [-1]: "bad", [-2]: "warn", 0: "neutral", 1: "ok", 2: "warn", 3: "brand", 4: "info" };

export function CampaignStatusBadge({ status }: { status: number }) {
  return (
    <Badge tone={campaignTone[status] ?? "neutral"} dot>
      {CAMPAIGN_STATUS_LABELS[status] ?? `Status ${status}`}
    </Badge>
  );
}

const leadTone: Record<number, Tone> = { 1: "info", 2: "warn", 3: "ok", [-1]: "bad", [-2]: "neutral", [-3]: "neutral" };

/** A lead that came from a visit to your website (Website visitors): a small globe, the words on hover. */
export function VisitedMark() {
  return (
    <span title="Visited your website" className="inline-flex shrink-0 text-brand-text">
      <Globe size={12} aria-hidden />
      <span className="sr-only">Visited your website</span>
    </span>
  );
}

export function LeadStatusBadge({ status }: { status: number }) {
  return <Badge tone={leadTone[status] ?? "neutral"}>{LEAD_STATUS_LABELS[status] ?? "—"}</Badge>;
}

const accountTone: Record<number, Tone> = { 1: "ok", 2: "warn", 3: "info", [-1]: "bad", [-2]: "bad", [-3]: "bad" };

export function AccountStatusBadge({ status }: { status: number }) {
  return (
    <Badge tone={accountTone[status] ?? "neutral"} dot>
      {ACCOUNT_STATUS_LABELS[status] ?? `Status ${status}`}
    </Badge>
  );
}

/** The mailbox's warmup, named as such: it sits next to the mailbox's own status. */
export function WarmupBadge({ status }: { status: number }) {
  const tone: Tone = status === 1 ? "ok" : status === 0 ? "neutral" : "bad";
  const label = status === 1 ? "Warmup on" : status === 0 ? "Warmup paused" : `Warmup: ${(WARMUP_STATUS_LABELS[status] ?? "unknown").toLowerCase()}`;
  return <Badge tone={tone}>{label}</Badge>;
}

const healthTone: Record<HealthStatus, Tone> = { healthy: "ok", fair: "warn", at_risk: "bad", unknown: "neutral" };

/** Mailbox health (bounces, replies, failed sends, warmup placement) as a pill: what it means and the score. */
export function HealthBadge({ health }: { health: MailboxHealth | null | undefined }) {
  if (!health) return null;
  return (
    <Badge tone={healthTone[health.status]}>
      {HEALTH_STATUS_LABELS[health.status]}
      {health.score !== null && <span className="tabular-nums"> · {health.score}</span>}
    </Badge>
  );
}

const verifyTone: Record<number, Tone> = { 0: "neutral", 1: "ok", 11: "info", 12: "info", [-1]: "bad", [-2]: "warn", [-3]: "warn", [-4]: "warn" };

export function VerificationBadge({ status }: { status: number | null | undefined }) {
  if (status === null || status === undefined) return null;
  return <Badge tone={verifyTone[status] ?? "neutral"}>{VERIFICATION_STATUS_LABELS[status] ?? "—"}</Badge>;
}

export interface LabelMeta {
  code: number;
  label: string;
  color: string;
}

/** Interest status pill; custom workspace labels are passed in so their names and colours show. */
export function InterestBadge({ code, labels }: { code: number | null | undefined; labels?: LabelMeta[] }) {
  if (code === null || code === undefined) return null;
  const meta = labels?.find((l) => l.code === code) ?? DEFAULT_INTEREST_STATUSES.find((s) => s.code === code);
  if (!meta) return <Badge>Label {code}</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${meta.color}1f`, color: `color-mix(in srgb, ${meta.color} 55%, var(--text))` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

/** Warmup / health score 0–100 as a coloured number. */
export function Score({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-faint">–</span>;
  const tone = value >= 90 ? "text-ok" : value >= 70 ? "text-warn" : "text-bad";
  return <span className={`font-semibold tabular-nums ${tone}`}>{Math.round(value)}</span>;
}

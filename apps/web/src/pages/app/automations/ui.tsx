// Small pieces shared by the automation pages: app icons, status badges, JSON view.
import { CalendarClock, GitBranch, Hash, Hourglass, Merge, MousePointerClick, ScrollText, Sparkles, Split, Webhook, Zap, type LucideIcon } from "lucide-react";
import { RUN_STATUS_LABELS, appDef, type AppKey, type AutomationStatus, type NodeKind, type RunStatus } from "@reachstack/shared";
import { cn } from "@/lib/cn";
import { useBrandInfo } from "@/lib/session";
import { Badge, CopyButton, Spinner, type Tone } from "@/components/ui";

const APP_ICONS: Record<Exclude<AppKey, "core">, { icon: LucideIcon; tone: string }> = {
  slack: { icon: Hash, tone: "bg-[#4a154b] text-white" },
  webhooks: { icon: Webhook, tone: "bg-info-soft text-info" },
  schedule: { icon: CalendarClock, tone: "bg-warn-soft text-warn" },
  manual: { icon: MousePointerClick, tone: "bg-panel-2 text-muted" },
  ai: { icon: Sparkles, tone: "bg-brand-soft text-brand-text" },
  tools: { icon: ScrollText, tone: "bg-panel-2 text-muted" },
};

const FLOW_ICONS: Partial<Record<NodeKind, { icon: LucideIcon; tone: string }>> = {
  condition: { icon: GitBranch, tone: "bg-ok-soft text-ok" },
  delay: { icon: Hourglass, tone: "bg-warn-soft text-warn" },
  paths: { icon: Split, tone: "bg-info-soft text-info" },
  merge: { icon: Merge, tone: "bg-info-soft text-info" },
};

/** The app's display name; the core app carries the product's (or agency's) brand. */
export function useAppLabel() {
  const brand = useBrandInfo();
  return (key: AppKey | string | null | undefined) => (key === "core" ? brand.name : (appDef(key)?.label ?? "App"));
}

export function AppIcon({ app, size = 28, className }: { app: AppKey | string | null | undefined; size?: number; className?: string }) {
  const brand = useBrandInfo();
  const box = { width: size, height: size };
  if (app === "core") {
    return (
      <span
        aria-hidden
        style={{ ...box, background: brand.color ?? "var(--brand)", fontSize: Math.round(size * 0.45) }}
        className={cn("inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-on-brand", className)}
      >
        {brand.name.trim()[0]?.toUpperCase() ?? "R"}
      </span>
    );
  }
  const def = APP_ICONS[app as Exclude<AppKey, "core">];
  const Icon = def?.icon ?? Zap;
  return (
    <span aria-hidden style={box} className={cn("inline-flex shrink-0 items-center justify-center rounded-md", def?.tone ?? "bg-panel-2 text-faint", className)}>
      <Icon size={Math.round(size * 0.55)} />
    </span>
  );
}

export function FlowIcon({ kind, size = 28, className }: { kind: NodeKind; size?: number; className?: string }) {
  const def = FLOW_ICONS[kind];
  const Icon = def?.icon ?? Zap;
  return (
    <span aria-hidden style={{ width: size, height: size }} className={cn("inline-flex shrink-0 items-center justify-center rounded-md", def?.tone ?? "bg-panel-2 text-faint", className)}>
      <Icon size={Math.round(size * 0.55)} />
    </span>
  );
}

const STATUS: Record<AutomationStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  paused: { label: "Off", tone: "neutral" },
  draft: { label: "Draft", tone: "neutral" },
};

export function AutomationStatusBadge({ status }: { status: AutomationStatus }) {
  return (
    <Badge tone={STATUS[status].tone} dot={status === "active"}>
      {STATUS[status].label}
    </Badge>
  );
}

const RUN_TONES: Record<RunStatus, Tone> = { queued: "neutral", running: "info", waiting: "warn", success: "ok", error: "bad", cancelled: "neutral" };

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <Badge tone={RUN_TONES[status]} className={className}>
      {status === "running" && <Spinner size={11} className="text-current" />}
      {RUN_STATUS_LABELS[status]}
    </Badge>
  );
}

export function JsonView({ value, className, maxHeight = "max-h-80" }: { value: unknown; className?: string; maxHeight?: string }) {
  const text = value === undefined ? "" : JSON.stringify(value, null, 2);
  if (value === null || value === undefined || text === "{}" || text === "[]") return <p className={cn("text-[13px] text-faint", className)}>No data.</p>;
  return (
    <div className={cn("relative", className)}>
      <CopyButton value={text} className="absolute right-1.5 top-1.5 bg-panel" />
      <pre className={cn("scroll-thin overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-panel-2 p-3 pr-10 font-mono text-xs leading-relaxed", maxHeight)}>{text}</pre>
    </div>
  );
}

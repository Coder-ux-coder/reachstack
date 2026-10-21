import { AlertTriangle, Check, CheckCircle2, Copy, Info, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";
import { Button } from "./button";

export type Tone = "neutral" | "brand" | "ok" | "warn" | "bad" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-panel-2 text-muted",
  brand: "bg-brand-soft text-brand-text",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
};

export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cn("rounded-xl border border-line bg-panel shadow-card", padded && "p-5", className)}>{children}</div>;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    // The actions move below the text when both don't fit side by side (phones).
    <div className={cn("mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}>
      <div className="min-w-0 flex-1 basis-56">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, sub, icon, tone, className, onClick, active }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: Tone; className?: string; onClick?: () => void; active?: boolean }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "rounded-xl border bg-panel p-4 text-left shadow-card transition-colors",
        active ? "border-brand ring-2 ring-[var(--ring)]" : "border-line",
        onClick && "hover:border-line-strong",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[13px] text-muted">
        <span className="truncate">{label}</span>
        {icon && <span className={cn("rounded-md p-1", tone ? tones[tone] : "text-faint")}>{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </Comp>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      {icon && <div className="mb-4 rounded-2xl bg-brand-soft p-3.5 text-brand-text">{icon}</div>}
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/** A request that failed: what went wrong and a way to try again (instead of an empty state that isn't true). */
export function ErrorState({ title, error, onRetry, className }: { title: ReactNode; error: unknown; onRetry?: () => unknown; className?: string }) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry?.();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      <div className="mb-4 rounded-2xl bg-bad-soft p-3.5 text-bad">
        <AlertTriangle size={22} />
      </div>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-md text-[13px] text-muted">{errorMessage(error)}</p>
      {onRetry && (
        <Button className="mt-5" loading={retrying} onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function PageHeader({ title, description, actions, back, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-5 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {back && <div className="mb-1">{back}</div>}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn("mx-auto w-full px-4 py-6 sm:px-6", wide ? "max-w-[1600px]" : "max-w-6xl", className)}>{children}</div>;
}

// Deep enough for white initials (at least 4.5:1).
const avatarColors = ["#4f46e5", "#0369a1", "#047857", "#b45309", "#dc2626", "#7c3aed", "#be185d", "#0f766e"];

export function Avatar({ name, email, src, size = 28, className }: { name?: string | null; email?: string | null; src?: string | null; size?: number; className?: string }) {
  const key = (email || name || "?").toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) };
  if (src) return <img src={src} alt="" style={style} className={cn("shrink-0 rounded-full object-cover", className)} />;
  return (
    <span aria-hidden style={{ ...style, background: avatarColors[Math.abs(h) % avatarColors.length] }} className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)}>
      {initials(name, email)}
    </span>
  );
}

export function Callout({ tone = "info", title, children, action, className }: { tone?: "info" | "warn" | "bad" | "ok"; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const Icon = { info: Info, warn: AlertTriangle, bad: XCircle, ok: CheckCircle2 }[tone];
  return (
    <div className={cn("flex gap-3 rounded-lg border px-3.5 py-3 text-[13px]", tones[tone], "border-current/15", className)}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 text-text">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn("text-muted", title && "mt-0.5")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Progress({ value, max = 100, tone = "brand", className }: { value: number; max?: number; tone?: "brand" | "ok" | "warn" | "bad"; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = { brand: "bg-brand", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-panel-2", className)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width]", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      className={cn("inline-flex min-h-6 min-w-6 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-panel-2 hover:text-text", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // The browser keeps the clipboard to secure pages (https or localhost).
          toast.error("Couldn't copy here. Select the text and copy it yourself.");
        }
      }}
    >
      {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
      {label !== "Copy" && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-panel-2 px-1.5 py-px font-mono text-[11px] text-muted">{children}</kbd>;
}

export function KeyValue({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-[13px]", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? <span className="text-faint">–</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, description, children, actions, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-4 border-b border-line py-6 last:border-0 md:grid-cols-[16rem_1fr]", className)}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
        {actions && <div className="mt-3">{actions}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function Dot({ tone = "neutral" }: { tone?: Tone }) {
  const c = { neutral: "bg-faint", brand: "bg-brand", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info" }[tone];
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", c)} />;
}

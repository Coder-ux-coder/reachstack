// Shells for the public pages people reach from outside the app: the privacy center, the small card pages that
// email recipients land on (unsubscribe, report abuse), and pages opened from a shared link.
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { ApiError } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks";
import { useBrand, usePublicConfig } from "@/lib/session";
import { BrandMark } from "@/components/shell/AppShell";
import { cn } from "@/lib/cn";

const PRIVACY_LINKS = [
  ["/privacy/info", "Privacy center"],
  ["/privacy/opt-out", "Remove my profile"],
  ["/privacy/data-request", "Get my data"],
  ["/privacy/manager", "Privacy request"],
  ["/privacy/report-abuse", "Report an email"],
] as const;

export function PrivacyLayout({ title, children }: { title: string; children: ReactNode }) {
  usePageTitle(title);
  const brand = useBrand();
  const privacy = usePublicConfig().data?.privacy;
  return (
    <div className="flex min-h-full flex-col bg-bg">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2.5 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2">
            <BrandMark size={26} />
            <span className="text-[15px] font-semibold tracking-tight">{brand}</span>
          </Link>
          <span className="text-faint" aria-hidden>
            /
          </span>
          <Link to="/privacy/info" className="py-1 text-sm font-medium text-muted hover:text-text">
            Privacy center
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">{children}</main>
      <footer className="border-t border-line bg-panel">
        {/* Links tall enough to tap on a phone. */}
        <nav aria-label="Privacy center" className="mx-auto flex max-w-3xl flex-wrap justify-center gap-x-5 gap-y-1 px-4 py-5 text-xs sm:px-6">
          {PRIVACY_LINKS.map(([to, label]) => (
            <NavLink key={to} to={to} end className={({ isActive }) => cn("py-1 hover:text-text", isActive ? "font-medium text-text" : "text-muted")}>
              {label}
            </NavLink>
          ))}
          {privacy?.policy_url && (
            <a href={privacy.policy_url} target="_blank" rel="noreferrer noopener" className="py-1 text-muted hover:text-text">
              Privacy policy
            </a>
          )}
          {privacy?.terms_url && (
            <a href={privacy.terms_url} target="_blank" rel="noreferrer noopener" className="py-1 text-muted hover:text-text">
              Terms
            </a>
          )}
        </nav>
      </footer>
    </div>
  );
}

/** Page heading inside the privacy center. */
export function PrivacyHeading({ eyebrow, title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-8">
      {eyebrow && <p className="text-[13px] font-semibold uppercase tracking-wider text-brand-text">{eyebrow}</p>}
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
      {children && <div className="mt-3 max-w-2xl space-y-2 text-[15px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

/** The brand on top and the page underneath, for things people open from a link someone sent them. */
export function PublicShell({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  usePageTitle(title);
  const brand = useBrand();
  return (
    <div className="flex min-h-full flex-col bg-bg">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-2.5 px-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <BrandMark size={26} />
            <span className="truncate text-[15px] font-semibold tracking-tight">{brand}</span>
          </Link>
          {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}

/** A centered card for one-question pages, with the platform credited underneath. */
export function CardPage({ title, children }: { title: string; children: ReactNode }) {
  usePageTitle(title);
  const brand = useBrand();
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-7 text-center shadow-card sm:p-8">{children}</div>
      <p className="mt-6 text-xs text-faint">Powered by {brand}</p>
    </div>
  );
}

/** First error per form field from a 400 response (zod issues in `details`). */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const issue of err.details as Array<{ path?: unknown[]; message?: string }>) {
    const key = String(issue.path?.[0] ?? "");
    if (key && issue.message && !out[key]) out[key] = issue.message;
  }
  return out;
}

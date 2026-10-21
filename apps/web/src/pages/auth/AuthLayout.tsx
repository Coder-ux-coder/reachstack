import type { ReactNode } from "react";
import { Link } from "react-router";
import { CheckCircle2 } from "lucide-react";
import { BrandMark } from "@/components/shell/AppShell";
import { browserZone } from "@/lib/dates";
import { useBrand, usePublicConfig } from "@/lib/session";

const POINTS = [
  ["Send from unlimited mailboxes", "Rotate across every connected account with per-mailbox limits and warmup built in."],
  ["One inbox for every reply", "Replies from all accounts land in a single view, labelled by interest."],
  ["Find and enrich prospects", "Search your lead data, verify emails and push the right people into campaigns."],
] as const;

export function AuthLayout({ title, subtitle, children, footer, aside = true }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; aside?: boolean }) {
  const brand = useBrand();
  // An agency's portal shows its own name only, without our product pitch or legal pages.
  const cfg = usePublicConfig().data;
  const portal = !!cfg?.portal;
  const terms = cfg?.privacy.terms_url;
  return (
    <div className="flex min-h-full">
      <div className="flex flex-1 flex-col px-5 py-8 sm:px-10">
        <Link to="/" className="flex items-center gap-2">
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-tight">{brand}</span>
        </Link>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
            <div className="mt-7">{children}</div>
            {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
          </div>
        </div>
        <p className={portal ? "hidden" : "text-center text-xs text-faint"}>
          <Link to="/privacy/info" className="hover:text-muted">
            Privacy
          </Link>
          {terms && (
            <>
              <span className="mx-2">·</span>
              <a href={terms} target="_blank" rel="noreferrer" className="hover:text-muted">
                Terms
              </a>
            </>
          )}
        </p>
      </div>
      {aside && !portal && (
        <div className="relative hidden w-[44%] max-w-2xl overflow-hidden bg-[#141236] lg:flex lg:flex-col lg:justify-center lg:px-14">
          <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[#4f46e5] opacity-40 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-[#0ea5e9] opacity-25 blur-3xl" />
          <div className="relative">
            <p className="text-sm font-medium text-[#a5b4fc]">Cold outreach, end to end</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-white">Reach more inboxes. Book more meetings.</h2>
            <ul className="mt-10 space-y-6">
              {POINTS.map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-[#818cf8]" />
                  <div>
                    <p className="font-medium text-white">{t}</p>
                    <p className="mt-1 text-sm leading-relaxed text-[#c7c9e8]">{d}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export function OAuthButtons({ google, microsoft, returnTo, label = "Continue" }: { google: boolean; microsoft: boolean; returnTo?: string; label?: string }) {
  if (!google && !microsoft) return null;
  // The browser's time zone goes along: a new account's workspace starts on its clock.
  const zone = browserZone();
  const params = new URLSearchParams({ ...(returnTo ? { return_to: returnTo } : {}), ...(zone ? { tz: zone } : {}) }).toString();
  const q = params ? `?${params}` : "";
  const btn = "flex h-10 w-full items-center justify-center gap-2.5 rounded-lg border border-line-strong bg-panel text-sm font-medium hover:bg-panel-2";
  return (
    <div className="space-y-2.5">
      {google && (
        <a className={btn} href={`/api/app/auth/oauth/google/start${q}`}>
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          {label} with Google
        </a>
      )}
      {microsoft && (
        <a className={btn} href={`/api/app/auth/oauth/microsoft/start${q}`}>
          <svg width="15" height="15" viewBox="0 0 23 23" aria-hidden>
            <path fill="#f35325" d="M1 1h10v10H1z" />
            <path fill="#81bc06" d="M12 1h10v10H12z" />
            <path fill="#05a6f0" d="M1 12h10v10H1z" />
            <path fill="#ffba08" d="M12 12h10v10H12z" />
          </svg>
          {label} with Microsoft
        </a>
      )}
      <div className="flex items-center gap-3 py-2 text-xs text-faint">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, NavLink, useLocation } from "react-router";
import { ChevronDown, Menu, X } from "lucide-react";
import { useMe, usePublicConfig } from "@/lib/session";
import { usePageTitle } from "@/lib/hooks";
import { BrandMark } from "@/components/shell/AppShell";
import { useBrand } from "@/lib/session";
import { buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";

const NAV = [
  { to: "/#features", label: "Features" },
  { to: "/#how-it-works", label: "How it works" },
  { to: "/developers", label: "Developers" },
  { to: "/mobile-app", label: "Mobile" },
];

/** Whether strangers can create an account here (the owner can limit it to invited people, or close it). Before anyone
 * has an account, the first one can always be made. */
export function useSignupOpen(): boolean {
  const cfg = usePublicConfig().data;
  return (cfg?.signup_mode ?? "open") === "open" || !!cfg?.first_run;
}

/** The header and closing buttons: the app for people who are signed in, otherwise log in (and sign up while it's open). */
function AuthButtons({ size = "md", stretch, onNavigate }: { size?: "md" | "lg"; stretch?: boolean; onNavigate?: () => void }) {
  const me = useMe();
  const signupOpen = useSignupOpen();
  const cls = stretch ? "flex-1" : undefined;
  if (me.data)
    return (
      <Link to="/app/dashboard" className={buttonClass("primary", size, cls)} onClick={onNavigate}>
        Open app
      </Link>
    );
  return (
    <>
      <Link to="/auth/login" className={buttonClass(signupOpen ? (stretch ? "secondary" : "ghost") : "primary", size, cls)} onClick={onNavigate}>
        Log in
      </Link>
      {signupOpen && (
        <Link to="/auth/signup" className={buttonClass("primary", size, cls)} onClick={onNavigate}>
          Start free
        </Link>
      )}
    </>
  );
}

function Header() {
  const brand = useBrand();
  const [open, setOpen] = useState(false);
  // Hash links (/#features) never count as the current page.
  const link = ({ isActive }: { isActive: boolean }) => cn("rounded-md px-3 py-2 text-sm font-medium", isActive ? "text-text" : "text-muted hover:text-text");
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2">
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-tight">{brand}</span>
        </Link>
        <nav className="hidden items-center md:flex">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end className={n.to.includes("#") ? link({ isActive: false }) : link}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 md:flex">
          <AuthButtons />
        </div>
        <button type="button" className="ml-auto rounded-md p-2 md:hidden" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}>
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      {open && (
        <div className="border-t border-line bg-panel px-4 py-3 md:hidden">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className="block rounded-md px-2 py-2 text-sm" onClick={() => setOpen(false)}>
              {n.label}
            </Link>
          ))}
          <div className="mt-3 flex gap-2">
            <AuthButtons stretch onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </header>
  );
}

function Footer() {
  const brand = useBrand();
  const terms = usePublicConfig().data?.privacy.terms_url;
  const cols: Array<[string, Array<[string, string]>]> = [
    ["Product", [["/#features", "Features"], ["/#how-it-works", "How it works"], ["/mobile-app", "Mobile app"]]],
    ["Developers", [["/developers", "API reference"], ["/developers#webhooks", "Webhooks"], ["/developers#scopes", "API scopes"]]],
    [
      "Legal",
      [
        ["/privacy/info", "Privacy"],
        ...(terms ? [[terms, "Terms"] as [string, string]] : []),
        ["/privacy/opt-out", "Opt out"],
        ["/privacy/data-request", "Data request"],
        ["/privacy/report-abuse", "Report abuse"],
      ],
    ],
  ];
  return (
    <footer className="border-t border-line bg-panel">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div>
          <Link to="/" className="flex items-center gap-2">
            <BrandMark />
            <span className="font-semibold">{brand}</span>
          </Link>
          <p className="mt-3 text-[13px] text-muted">Self-hosted cold outreach: sending, warmup, inbox, CRM and prospecting in one place.</p>
        </div>
        {cols.map(([title, links]) => (
          <div key={title}>
            <p className="text-[13px] font-semibold">{title}</p>
            <ul className="mt-3 space-y-2">
              {links.map(([to, label]) => (
                <li key={to + label}>
                  {/^https?:/.test(to) ? (
                    <a href={to} target="_blank" rel="noreferrer" className="text-[13px] text-muted hover:text-text">
                      {label}
                    </a>
                  ) : (
                    <Link to={to} className="text-[13px] text-muted hover:text-text">
                      {label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line py-5 text-center text-xs text-faint">
        © {new Date().getFullYear()} {brand}
      </div>
    </footer>
  );
}

/** A new page starts at the top; a link with #section scrolls to that section (also when it renders a moment later). */
function useScrollOnNavigate() {
  const { pathname, hash, key } = useLocation();
  useEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    let tries = 0;
    let timer = 0;
    const find = () => {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el) el.scrollIntoView({ block: "start" });
      else if (tries++ < 30) timer = window.setTimeout(find, 100);
    };
    find();
    return () => window.clearTimeout(timer);
  }, [pathname, hash, key]);
}

export function MarketingLayout({ title, children }: { title?: string; children: ReactNode }) {
  usePageTitle(title);
  useScrollOnNavigate();
  // An agency's portal domain has no marketing site: visitors go straight to the client login.
  if (usePublicConfig().data?.portal) return <Navigate to="/client/login" replace />;
  return (
    <div className="flex min-h-full flex-col bg-bg">
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}

export function Hero({ eyebrow, title, body, children }: { eyebrow?: string; title: ReactNode; body: ReactNode; children?: ReactNode }) {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[30rem] w-[60rem] -translate-x-1/2 rounded-full bg-brand opacity-[0.12] blur-3xl" />
      <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-20 text-center sm:px-6 sm:pt-24">
        {eyebrow && <p className="mb-4 inline-block rounded-full border border-line bg-panel px-3 py-1 text-xs font-medium text-brand-text">{eyebrow}</p>}
        <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">{title}</h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">{body}</p>
        {children && <div className="mt-8 flex flex-wrap justify-center gap-3">{children}</div>}
      </div>
    </section>
  );
}

export function SectionTitle({ eyebrow, title, body, center = true }: { eyebrow?: string; title: ReactNode; body?: ReactNode; center?: boolean }) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center")}>
      {eyebrow && <p className="text-[13px] font-semibold uppercase tracking-wider text-brand-text">{eyebrow}</p>}
      <h2 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h2>
      {body && <p className="mt-3 text-[15px] leading-relaxed text-muted">{body}</p>}
    </div>
  );
}

export function FeatureGrid({ items, cols = 3 }: { items: Array<{ icon: ReactNode; title: string; body: string }>; cols?: 2 | 3 | 4 }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2", cols === 3 && "lg:grid-cols-3", cols === 4 && "lg:grid-cols-4")}>
      {items.map((f) => (
        <div key={f.title} className="rounded-xl border border-line bg-panel p-5 shadow-card">
          <div className="mb-3 w-fit rounded-lg bg-brand-soft p-2 text-brand-text">{f.icon}</div>
          <h3 className="font-semibold">{f.title}</h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{f.body}</p>
        </div>
      ))}
    </div>
  );
}

export function Faq({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line bg-panel">
      {items.map(([q, a]) => (
        <details key={q} className="group px-5 py-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
            {q}
            <ChevronDown size={16} className="shrink-0 text-faint transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-2 text-[14px] leading-relaxed text-muted">{a}</p>
        </details>
      ))}
    </div>
  );
}

export function CtaBand({ title = "Start sending this week", body = "Connect a mailbox, turn on warmup and build your first sequence in an afternoon." }: { title?: string; body?: string }) {
  const me = useMe();
  const signupOpen = useSignupOpen();
  const onDark = "border-white/20 bg-white/10 text-white hover:bg-white/20";
  return (
    <section className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-4xl rounded-2xl bg-[#141236] px-6 py-14 text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-white">{title}</h2>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-[#c7c9e8]">{body}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {me.data ? (
            <Link to="/app/dashboard" className={buttonClass("primary", "lg")}>
              Open app
            </Link>
          ) : (
            <>
              {signupOpen && (
                <Link to="/auth/signup" className={buttonClass("primary", "lg")}>
                  Start free
                </Link>
              )}
              <Link to="/auth/login" className={buttonClass(signupOpen ? "secondary" : "primary", "lg", signupOpen ? onDark : undefined)}>
                Log in
              </Link>
            </>
          )}
          <Link to="/developers" className={buttonClass("secondary", "lg", onDark)}>
            API reference
          </Link>
        </div>
      </div>
    </section>
  );
}

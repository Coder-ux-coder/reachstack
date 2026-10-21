import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudOff } from "lucide-react";
import { DEFAULT_WORKSPACE_TIMEZONE, roleAllows, canWrite, type Me as SharedMe, type ModuleKey, type ModuleSwitches, type Permission } from "@reachstack/shared";
import { toast } from "sonner";
import { ApiError, errorMessage, get, onWorkspaceGate, post } from "./api";
import { applyBrandColor, applyTheme } from "./theme";
import { Button } from "@/components/ui/button";
import { FullPageSpinner } from "@/components/ui/spinner";

export type Me = SharedMe & {
  user: SharedMe["user"] & {
    language?: string;
    onboarding?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
    phone?: string | null;
    timestamp_created?: string;
    has_password?: boolean;
  };
  session: {
    client_portal: boolean;
    mfa_pending: boolean;
    /** The current workspace first asks for two-step authentication, or a fresh code from the authenticator. */
    workspace_gate?: "totp_required" | "workspace_reauth_required" | null;
  };
  /** Product areas the installation owner switched on for everyone (missing means all on). */
  modules?: ModuleSwitches;
};

/** False when the installation owner switched this product area off for everyone. */
export function moduleOn(me: Pick<Me, "modules"> | null | undefined, key: ModuleKey | undefined): boolean {
  return !key || me?.modules?.[key] !== false;
}

export interface Brand {
  name: string;
  color: string | null;
  logo_url: string | null;
}

export interface PublicConfig {
  brand: Brand;
  /** Served on an agency's white-label portal domain. */
  portal: boolean;
  sign_in: { google: boolean; microsoft: boolean };
  billing: { stripe: boolean };
  email_delivery: boolean;
  /** Who runs this installation, for the privacy center (each one optional). */
  privacy: { email: string | null; phone: string | null; policy_url: string | null; terms_url: string | null };
  /** Who may create an account. */
  signup_mode?: "open" | "invite" | "closed";
  /** Nobody has an account yet: the first one can always be made, and it becomes the owner. */
  first_run?: boolean;
}

export const ME_KEY = ["me"] as const;

/** Only these answers mean there is no session. Anything else (a restart, a 5xx, no network) says nothing about it. */
function isSignedOut(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => get<Me>("/api/app/auth/me", undefined, signal),
    // Retried until the server answers, so a restart or a brief outage never looks like a sign-out. Retries pause
    // while the tab is hidden or the browser is offline.
    retry: (_count, err) => !isSignedOut(err),
    retryDelay: (count) => Math.min(1000 * 2 ** count, 10_000),
    staleTime: 60_000,
    // Guards and pages share this query. A refetch without data resets it to "pending", which unmounts the page and
    // remounts it on the next 401 — so a new observer must never refetch an errored or cached session.
    refetchOnMount: false,
    retryOnMount: false,
  });
}

export function usePublicConfig() {
  return useQuery({ queryKey: ["public-config"], queryFn: () => get<PublicConfig>("/api/public/config"), staleTime: Infinity });
}

const SessionContext = createContext<Me | null>(null);

/** The signed-in session; only valid under <RequireAuth>. */
export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error("useSession used outside RequireAuth");
  return me;
}

/** The workspace's timezone (Settings → Preferences): the clock its reports, limits and dates go by. */
export function useWorkspaceZone(): string {
  const zone = useContext(SessionContext)?.workspace?.settings.default_timezone;
  return typeof zone === "string" && zone ? zone : DEFAULT_WORKSPACE_TIMEZONE;
}

/** The product brand, or an agency's white-label brand for its clients and on its portal domain. */
export function useBrandInfo(): Brand {
  const me = useContext(SessionContext);
  const cfg = usePublicConfig();
  const brand = me?.brand ?? cfg.data?.brand ?? { name: "Reachstack", color: null, logo_url: null };
  useEffect(() => applyBrandColor(brand.color), [brand.color]);
  return brand;
}

export function useBrand(): string {
  return useBrandInfo().name;
}

/**
 * Sends the email-confirmation link again and says where it went. An installation that can't send email keeps the link
 * in the owner's System emails list instead.
 */
export async function resendConfirmation(owner: boolean): Promise<boolean> {
  try {
    const r = await post<{ already_verified?: boolean; emailed?: boolean }>("/api/app/auth/resend-verification");
    if (r.already_verified) toast.success("Your email address is already confirmed");
    else if (r.emailed === false)
      toast.info(owner ? "This installation can't send email yet, so the link is in Settings → Installation, under System emails." : "This installation can't send email yet. Ask whoever runs it for your confirmation link.");
    else toast.success("Confirmation email sent. Check your inbox.");
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
}

export function useCan() {
  const me = useSession();
  const role = me.membership?.role ?? "view";
  return {
    role,
    perm: (p: Permission) => roleAllows(role, p, me.membership?.permissions),
    write: canWrite(role),
    admin: role === "owner" || role === "admin",
    owner: role === "owner",
  };
}

/** Shown while the session check gets no answer. Nobody is signed out: the check keeps retrying on its own. */
function SessionUnreachable({ reason, retrying, onRetry }: { reason: unknown; retrying: boolean; onRetry: () => void }) {
  const brand = useBrand();
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <div role="status" className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 rounded-2xl bg-warn-soft p-3.5 text-warn">
        <CloudOff size={28} />
      </div>
      <h1 className="text-xl font-semibold">{offline ? "You're offline" : `Can't reach ${brand} right now`}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">
        You haven't been signed out. This page picks up again by itself {offline ? "when your connection is back" : "as soon as the server answers"}.
      </p>
      {!offline && reason != null && <p className="mt-2 max-w-md text-xs text-faint">Last answer: {errorMessage(reason)}</p>}
      <Button className="mt-6" loading={retrying} onClick={onRetry}>
        Try again now
      </Button>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const qc = useQueryClient();
  const loc = useLocation();
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    if (me.data?.user.theme) applyTheme(me.data.user.theme as "light" | "dark" | "system");
  }, [me.data?.user.theme]);
  // A workspace can start asking mid-session (a code goes stale, the owner turns two-step on): look again then.
  useEffect(() => {
    onWorkspaceGate(() => void qc.invalidateQueries({ queryKey: ME_KEY }));
    return () => onWorkspaceGate(null);
  }, [qc]);
  const next = encodeURIComponent(loc.pathname + loc.search);
  // Only a definite "no session" sends people to the sign-in page, even when an earlier answer is still on screen.
  if (isSignedOut(me.error)) return <Navigate to={`/auth/login?${me.error.code === "mfa_required" ? "mfa=1&" : ""}next=${next}`} replace />;
  if (!me.data) {
    // The first check failed more than once (or can't run): say so instead of spinning, until an answer arrives.
    const stuck = me.isError || me.failureCount >= 2 || me.fetchStatus === "paused" || retried;
    if (!stuck) return <FullPageSpinner />;
    return (
      <SessionUnreachable
        reason={me.error ?? me.failureReason}
        retrying={me.fetchStatus === "fetching" && me.failureCount === 0}
        onRetry={() => {
          setRetried(true);
          // A plain refetch would wait out the current retry delay (up to 10s), so drop that attempt and start over.
          void qc.cancelQueries({ queryKey: ME_KEY }).then(() => me.refetch());
        }}
      />
    );
  }
  // A failed refetch keeps the last good answer, so the page stays put while the check retries.
  const data = me.data;
  if (data.session.mfa_pending) return <Navigate to={`/auth/login?mfa=1&next=${encodeURIComponent(loc.pathname)}`} replace />;
  const gate = data.session.workspace_gate;
  if (gate === "workspace_reauth_required" && data.workspace && !loc.pathname.startsWith("/app/security/")) {
    return <Navigate to={`/app/security/workspace?workspace_id=${data.workspace.id}&next=${next}`} replace />;
  }
  if (gate === "totp_required" && !loc.pathname.startsWith("/app/security/") && !loc.pathname.startsWith("/app/organization/create")) {
    return <Navigate to={`/app/security/two-step?next=${next}`} replace />;
  }
  if (!data.workspace && !loc.pathname.startsWith("/app/organization/create")) return <Navigate to="/app/organization/create" replace />;
  return <SessionContext.Provider value={data}>{children}</SessionContext.Provider>;
}

/** Signed-in users skip the sign-in pages. */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const me = useMe();
  const loc = useLocation();
  // Wait for the first answer only. If the server doesn't answer, show the page; a later answer still redirects.
  if (me.isPending && me.fetchStatus === "fetching" && me.failureCount === 0) return <FullPageSpinner />;
  // A sign-out answer keeps the last session in the cache; sending people back with it would loop with RequireAuth.
  if (me.data && !me.data.session.mfa_pending && !isSignedOut(me.error)) {
    const next = new URLSearchParams(loc.search).get("next");
    return <Navigate to={next && next.startsWith("/") ? next : "/app/dashboard"} replace />;
  }
  return <>{children}</>;
}

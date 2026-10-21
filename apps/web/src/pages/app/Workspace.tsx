import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { ApiError, errorMessage, post } from "@/lib/api";
import { browserZone } from "@/lib/dates";
import { ME_KEY, useMe } from "@/lib/session";
import { usePageTitle } from "@/lib/hooks";
import { BrandMark } from "@/components/shell/AppShell";
import { RecoveryCodes, TwoStepSetup } from "@/components/TwoStep";
import { Button, Callout, Card, Field, FullPageSpinner, Input } from "@/components/ui";

/** Where to go once a workspace lets you in: back where you were, inside the app. */
const nextPath = (params: URLSearchParams) => {
  const next = params.get("next");
  return next && next.startsWith("/app/") && !next.startsWith("/app/security/") ? next : "/app/dashboard";
};

/** /app/organization/create — new workspace (also the landing for users without one). */
export function CreateWorkspace() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePageTitle("New workspace");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/app/workspaces", { name, timezone: browserZone() });
      qc.clear();
      nav("/app/dashboard", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const hasAny = !!me.data?.workspaces.length;
  return (
    <div className="flex min-h-full items-center justify-center px-5 py-10">
      <Card className="w-full max-w-md p-8">
        <BrandMark size={36} />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">{hasAny ? "Create a workspace" : "Name your workspace"}</h1>
        <p className="mt-1.5 text-sm text-muted">Workspaces keep accounts, campaigns, leads and billing separate — one per company or client.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          {error && <Callout tone="bad">{error}</Callout>}
          <Field label="Workspace name">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." required maxLength={120} />}</Field>
          <div className="flex gap-2">
            {hasAny && (
              <Button className="flex-1" onClick={() => nav(-1)}>
                Cancel
              </Button>
            )}
            <Button type="submit" variant="primary" className="flex-1" loading={busy} disabled={!name.trim()}>
              Create workspace
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/** /app/w/:workspace_id — deep link that switches workspace, then lands on the dashboard (or ?next=). */
export function WorkspaceJump() {
  const { workspace_id = "" } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const next = params.get("next");
    post(`/api/app/workspaces/${workspace_id}/switch`)
      .then(() => {
        qc.clear();
        nav(next && next.startsWith("/app/") ? next : "/app/dashboard", { replace: true });
      })
      .catch((e) => {
        if (e instanceof ApiError && e.code === "workspace_reauth_required") nav(`/app/security/workspace?workspace_id=${workspace_id}`, { replace: true });
        else setError(errorMessage(e));
      });
  }, [workspace_id, params, nav, qc]);
  if (error)
    return (
      <div className="mx-auto max-w-md p-8">
        <Callout tone="bad" title="Couldn't open that workspace">
          {error}
        </Callout>
      </div>
    );
  return <FullPageSpinner label="Opening workspace…" />;
}

/** /app/redirect?to=… — internal links from emails; only same-app paths are followed. */
export function AppRedirect() {
  const [params] = useSearchParams();
  const to = params.get("to") ?? params.get("next");
  return <Navigate to={to && to.startsWith("/app/") ? to : "/app/dashboard"} replace />;
}

/** /app/security/workspace — fresh authenticator code required to open a protected workspace. */
export function WorkspaceSecurity() {
  const [params] = useSearchParams();
  const wsId = params.get("workspace_id") ?? "";
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePageTitle("Verify it's you");
  const name = me.data?.workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/app/auth/workspace-reauth", { workspace_id: wsId, code });
      await post(`/api/app/workspaces/${wsId}/switch`);
      qc.clear();
      nav(nextPath(params), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-5">
      <Card className="w-full max-w-sm p-8 text-center">
        <div className="mx-auto mb-4 w-fit rounded-2xl bg-brand-soft p-3 text-brand-text">
          <ShieldCheck size={26} />
        </div>
        <h1 className="text-lg font-semibold">Verify it's you</h1>
        <p className="mt-1.5 text-sm text-muted">{name} asks for a fresh code from your authenticator app.</p>
        <form onSubmit={submit} className="mt-6 space-y-3 text-left">
          {error && <Callout tone="bad">{error}</Callout>}
          <Input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="123456" className="text-center tracking-[0.4em]" />
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.length !== 6}>
            Continue
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** /app/security/two-step — the workspace requires two-step authentication, which this account hasn't turned on yet. */
export function TwoStepRequired() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [codes, setCodes] = useState<string[] | null>(null);
  // Opening another workspace starts on its dashboard: the page you were on belongs to this one.
  const [opened, setOpened] = useState(false);
  usePageTitle("Turn on two-step authentication");
  const data = me.data;
  if (!data) return <FullPageSpinner />;
  // Already sorted (another tab, or the owner changed the rule): carry on. Recovery codes stay up until saved.
  if (data.session.workspace_gate !== "totp_required" && !codes) return <Navigate to={opened ? "/app/dashboard" : nextPath(params)} replace />;
  const others = data.workspaces.filter((w) => w.id !== data.workspace?.id);
  const done = () => {
    qc.clear();
    nav(nextPath(params), { replace: true });
  };
  const open = async (id: string) => {
    try {
      await post(`/api/app/workspaces/${id}/switch`);
      setOpened(true);
      qc.clear();
    } catch (e) {
      if (e instanceof ApiError && e.code === "workspace_reauth_required") nav(`/app/security/workspace?workspace_id=${id}`, { replace: true });
      else toast.error(errorMessage(e));
    }
  };
  const signOut = async () => {
    await post("/api/app/auth/logout").catch(() => undefined);
    qc.clear();
    nav("/auth/login", { replace: true });
  };
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md p-6 sm:p-8">
        <div className="mx-auto mb-4 w-fit rounded-2xl bg-brand-soft p-3 text-brand-text">
          <ShieldCheck size={26} />
        </div>
        <h1 className="text-center text-lg font-semibold">{codes ? "Two-step authentication is on" : "Turn on two-step authentication"}</h1>
        <p className="mt-1.5 text-center text-sm text-muted">
          {codes ? "Keep these codes somewhere safe, then carry on." : `${data.workspace?.name ?? "This workspace"} asks everyone in it to sign in with a code from an authenticator app.`}
        </p>
        <div className="mt-6">
          {codes ? (
            <div className="space-y-4">
              <RecoveryCodes codes={codes} />
              <Button variant="primary" className="w-full" onClick={done}>
                I saved them, continue
              </Button>
            </div>
          ) : (
            <TwoStepSetup
              hasPassword={data.user.has_password !== false}
              onDone={async (c) => {
                setCodes(c);
                await qc.invalidateQueries({ queryKey: ME_KEY });
              }}
            />
          )}
        </div>
        {!codes && (
          <div className="mt-6 space-y-3 border-t border-line pt-4">
            {others.length > 0 && (
              <div>
                <p className="text-xs text-muted">Or open another workspace:</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {others.map((w) => (
                    <Button key={w.id} size="sm" onClick={() => void open(w.id)}>
                      {w.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

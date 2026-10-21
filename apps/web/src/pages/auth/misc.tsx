import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MailCheck, XCircle } from "lucide-react";
import { errorMessage, get, post } from "@/lib/api";
import { ME_KEY, useBrand, useMe, usePublicConfig } from "@/lib/session";
import { Button, ButtonLink, Callout, Field, FullPageSpinner, Input } from "@/components/ui";
import { ROLE_LABELS, type Role } from "@reachstack/shared";
import { AuthLayout } from "./AuthLayout";
import { PasswordInput } from "./Login";

/** /auth/reset-password: request a link, or (with ?token=) choose a new password. */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const nav = useNavigate();
  // An installation that can't send email prints the link in the window it runs in instead.
  const mailless = usePublicConfig().data?.email_delivery === false;
  const brand = useBrand();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (token) {
        await post("/api/app/auth/password-reset/confirm", { token, password });
        nav("/auth/login?reset=1", { replace: true });
      } else {
        await post("/api/app/auth/password-reset/request", { email });
        setSent(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <AuthLayout
        title={mailless ? `Find the link in the ${brand} window` : "Check your inbox"}
        subtitle={
          mailless
            ? `This installation can't send email, so if an account exists for ${email}, its reset link is printed in the window where ${brand} is running, and listed in the owner's Settings → Installation, under System emails. The link expires in 1 hour.`
            : `If an account exists for ${email}, we've sent a link to reset your password. The link expires in 1 hour.`
        }
        footer={
          <Link to="/auth/login" className="text-brand-text hover:underline">
            Back to log in
          </Link>
        }
      >
        <div className="flex justify-center text-brand">
          <MailCheck size={48} strokeWidth={1.5} />
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title={token ? "Choose a new password" : "Reset your password"}
      subtitle={token ? "You'll be signed out of other devices." : "Enter the email you use to log in and we'll send you a reset link."}
      footer={
        <Link to="/auth/login" className="text-brand-text hover:underline">
          Back to log in
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Callout tone="bad">{error}</Callout>}
        {token ? (
          <Field label="New password" hint="At least 8 characters.">
            {(id) => <PasswordInput id={id} value={password} onChange={setPassword} autoComplete="new-password" />}
          </Field>
        ) : (
          <Field label="Email">{(id) => <Input id={id} type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          {token ? "Update password" : "Send reset link"}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** /auth/verify?token=… confirms an email address; without a token it offers to resend the link. */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const me = useMe();
  const qc = useQueryClient();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">(token ? "working" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const ran = useRef(false);
  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    post("/api/app/auth/verify-email", { token })
      .then(() => {
        setState("done");
        qc.invalidateQueries({ queryKey: ME_KEY });
      })
      .catch((e) => {
        setError(errorMessage(e));
        setState("error");
      });
  }, [token, qc]);

  if (state === "working") return <FullPageSpinner label="Confirming your email…" />;
  if (state === "done")
    return (
      <AuthLayout title="Email confirmed" subtitle="Thanks — your email address is verified.">
        <div className="mb-6 flex justify-center text-ok">
          <CheckCircle2 size={48} strokeWidth={1.5} />
        </div>
        <ButtonLink to={me.data ? "/app/dashboard" : "/auth/login"} variant="primary" size="lg" className="w-full">
          Continue
        </ButtonLink>
      </AuthLayout>
    );
  return (
    <AuthLayout
      title={state === "error" ? "Link expired" : "Confirm your email"}
      subtitle={
        state === "error"
          ? error ?? "This link is invalid or has expired."
          : me.data
            ? `We sent a confirmation link to ${me.data.user.email}. Click it to verify your address.`
            : "Open the confirmation link we emailed you."
      }
    >
      {me.data && !me.data.user.email_verified ? (
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={resent}
          onClick={async () => {
            try {
              await post("/api/app/auth/resend-verification");
              setResent(true);
            } catch (e) {
              setError(errorMessage(e));
              setState("error");
            }
          }}
        >
          {resent ? "Sent — check your inbox" : "Resend confirmation email"}
        </Button>
      ) : (
        <ButtonLink to={me.data ? "/app/dashboard" : "/auth/login"} variant="primary" size="lg" className="w-full">
          {me.data ? "Go to dashboard" : "Log in"}
        </ButtonLink>
      )}
    </AuthLayout>
  );
}

interface InvitationInfo {
  email: string;
  role: Role;
  workspace: { id: string; name: string };
  user_exists: boolean;
  accepted: boolean;
}

/** /invitations?token=… */
export function Invitations() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inv = useQuery({ queryKey: ["invitation", token], queryFn: () => get<InvitationInfo>(`/api/app/invitations/${encodeURIComponent(token)}`), enabled: !!token, retry: false });

  if (!token || inv.error)
    return (
      <AuthLayout title="Invitation not found" subtitle="This invitation link is invalid, was revoked, or has already been used." aside={false}>
        <ButtonLink to="/auth/login" variant="primary" size="lg" className="w-full">
          Go to log in
        </ButtonLink>
      </AuthLayout>
    );
  if (inv.isLoading || me.isLoading) return <FullPageSpinner />;
  const i = inv.data!;
  const here = `/invitations?token=${encodeURIComponent(token)}`;
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/app/invitations/${encodeURIComponent(token)}/accept`);
      qc.clear();
      nav("/app/dashboard", { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title={`Join ${i.workspace.name}`} subtitle={`You've been invited as ${ROLE_LABELS[i.role] ?? i.role}. The invitation was sent to ${i.email}.`} aside={false}>
      {error && <Callout tone="bad" className="mb-4">{error}</Callout>}
      {i.accepted ? (
        <ButtonLink to="/app/dashboard" variant="primary" size="lg" className="w-full">
          Already accepted — open the app
        </ButtonLink>
      ) : me.data ? (
        me.data.user.email === i.email ? (
          <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={accept}>
            Accept invitation
          </Button>
        ) : (
          <Callout tone="warn" title={`You're logged in as ${me.data.user.email}`}>
            Log out and sign in as {i.email} to accept this invitation.
          </Callout>
        )
      ) : i.user_exists ? (
        <ButtonLink to={`/auth/login?email=${encodeURIComponent(i.email)}&next=${encodeURIComponent(here)}`} variant="primary" size="lg" className="w-full">
          Log in to accept
        </ButtonLink>
      ) : (
        <ButtonLink to={`/auth/signup?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(i.email)}`} variant="primary" size="lg" className="w-full">
          Create account and join
        </ButtonLink>
      )}
    </AuthLayout>
  );
}

/** /workspace-group-invitation/:token — an agency invited this workspace into its group. */
export function WorkspaceGroupInvitation() {
  const { token = "" } = useParams();
  const me = useMe();
  const [done, setDone] = useState<"accepted" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inv = useQuery({
    queryKey: ["group-invitation", token],
    queryFn: () => get<{ admin_workspace_name: string | null; sub_workspace_name: string | null; status: string }>(`/api/app/workspace-group-invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  if (inv.isLoading || me.isLoading) return <FullPageSpinner />;
  if (inv.error)
    return (
      <AuthLayout title="Invitation not found" subtitle="This link is invalid or was already answered." aside={false}>
        <ButtonLink to="/app/dashboard" variant="primary" className="w-full">
          Open the app
        </ButtonLink>
      </AuthLayout>
    );
  const g = inv.data!;
  const respond = async (accept: boolean) => {
    setError(null);
    try {
      await post(`/api/app/workspace-group-invitations/${encodeURIComponent(token)}/respond`, { accept });
      setDone(accept ? "accepted" : "rejected");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (done)
    return (
      <AuthLayout title={done === "accepted" ? "You're connected" : "Invitation declined"} subtitle={done === "accepted" ? `${g.admin_workspace_name} can now manage ${g.sub_workspace_name}.` : "Nothing has changed."} aside={false}>
        <ButtonLink to="/app/dashboard" variant="primary" className="w-full">
          Open the app
        </ButtonLink>
      </AuthLayout>
    );
  return (
    <AuthLayout
      title="Agency access request"
      subtitle={`${g.admin_workspace_name ?? "An agency workspace"} wants to manage ${g.sub_workspace_name ?? "your workspace"}. Admins of the agency will be able to open your workspace and work in it.`}
      aside={false}
    >
      {error && <Callout tone="bad" className="mb-4">{error}</Callout>}
      {me.data ? (
        <div className="flex gap-3">
          <Button className="flex-1" onClick={() => respond(false)}>
            Decline
          </Button>
          <Button variant="primary" className="flex-1" onClick={() => respond(true)}>
            Accept
          </Button>
        </div>
      ) : (
        <ButtonLink to={`/auth/login?next=${encodeURIComponent(`/workspace-group-invitation/${token}`)}`} variant="primary" size="lg" className="w-full">
          Log in to respond
        </ButtonLink>
      )}
    </AuthLayout>
  );
}

/** /auth/oauthfinal — end of a mailbox connection started from the API; the API client polls for the result. */
export function OAuthFinal() {
  const [params] = useSearchParams();
  const ok = params.get("status") === "success";
  return (
    <AuthLayout title={ok ? "Account connected" : "Connection failed"} subtitle={ok ? `${params.get("email") ?? "The mailbox"} is connected. You can close this tab.` : params.get("error") ?? "The provider didn't complete the sign-in."} aside={false}>
      <div className={`flex justify-center ${ok ? "text-ok" : "text-bad"}`}>{ok ? <CheckCircle2 size={48} strokeWidth={1.5} /> : <XCircle size={48} strokeWidth={1.5} />}</div>
    </AuthLayout>
  );
}

/** /auth/oauth-handler — legacy landing for provider redirects; forwards to the right screen. */
export function OAuthHandler() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  useEffect(() => {
    const error = params.get("error");
    if (error) nav(`/app/accounts?error=${encodeURIComponent(params.get("error_description") ?? error)}`, { replace: true });
    else nav("/app/accounts", { replace: true });
  }, [params, nav]);
  return <FullPageSpinner />;
}

/** /auth/oauth/authorize — third-party app authorization (not offered; API keys cover integrations). */
export function OAuthAuthorize() {
  const [params] = useSearchParams();
  return (
    <AuthLayout title="Connect an app" subtitle={`${params.get("client_name") ?? "This app"} asked for access to your workspace.`} aside={false}>
      <Callout tone="info" title="Use an API key instead">
        This installation doesn't run an OAuth authorization server. Create a scoped API key in Settings → Integrations & API → API keys and paste it into the app you want to connect.
      </Callout>
      <ButtonLink to="/app/settings/integrations?tab=api" variant="primary" className="mt-5 w-full">
        Create an API key
      </ButtonLink>
    </AuthLayout>
  );
}

/** /app/settings/change-owner?token=… — the new owner confirms a transfer. */
export function ConfirmOwnerChange() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"working" | "done" | "error">(token ? "working" : "error");
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its token.");
  const ran = useRef(false);
  const qc = useQueryClient();
  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    post("/api/app/workspaces/current/change-owner/confirm", { token })
      .then(() => {
        setState("done");
        qc.clear();
      })
      .catch((e) => {
        setError(errorMessage(e));
        setState("error");
      });
  }, [token, qc]);
  if (state === "working") return <FullPageSpinner label="Transferring ownership…" />;
  return (
    <AuthLayout title={state === "done" ? "You're the owner now" : "Couldn't transfer ownership"} subtitle={state === "done" ? "The previous owner is now an admin of the workspace." : error ?? undefined} aside={false}>
      <ButtonLink to="/app/dashboard" variant="primary" className="w-full">
        Open the app
      </ButtonLink>
    </AuthLayout>
  );
}

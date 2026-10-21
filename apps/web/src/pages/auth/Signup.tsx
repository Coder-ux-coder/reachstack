import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage, post } from "@/lib/api";
import { browserZone } from "@/lib/dates";
import { ME_KEY, usePublicConfig } from "@/lib/session";
import { Button, Callout, Field, Input } from "@/components/ui";
import { AuthLayout, OAuthButtons } from "./AuthLayout";
import { PasswordInput } from "./Login";

function partnerRef(): string | undefined {
  try {
    return localStorage.getItem("rs-partner") ?? undefined;
  } catch {
    return undefined;
  }
}

export function SignupForm({ clientPortal = false }: { clientPortal?: boolean }) {
  const [params] = useSearchParams();
  const invite = params.get("invite") ?? undefined;
  const cfg = usePublicConfig();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [form, setForm] = useState({ first_name: "", last_name: "", email: params.get("email") ?? "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const strength = form.password.length >= 12 ? 3 : form.password.length >= 8 ? 2 : form.password.length > 0 ? 1 : 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post("/api/app/auth/signup", { ...form, invite_token: invite, partner: partnerRef(), timezone: browserZone(), ...(clientPortal ? { client_portal: true } : {}) });
      await qc.invalidateQueries({ queryKey: ME_KEY });
      nav(invite || clientPortal ? "/app/dashboard" : "/app/signup-know-user", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const mode = cfg.data?.signup_mode ?? "open";
  const firstRun = !!cfg.data?.first_run && !clientPortal && !invite;
  if (!invite && mode !== "open" && !firstRun)
    return (
      <AuthLayout
        title={mode === "invite" ? "You need an invitation" : "Sign-up is closed"}
        subtitle={mode === "invite" ? "Accounts here are by invitation only." : "This installation isn't taking new accounts."}
        footer={
          <>
            Already have an account?{" "}
            <Link to={clientPortal ? "/client/login" : "/auth/login"} className="font-medium text-brand-text hover:underline">
              Log in
            </Link>
          </>
        }
      >
        <Callout tone="info">
          {mode === "invite"
            ? "Ask someone in your team to invite you from Workspace & members. The email they send has a link to create your account."
            : "If you should have an account, ask the person who runs this installation."}
        </Callout>
      </AuthLayout>
    );

  const termsUrl = cfg.data?.privacy.terms_url;
  const policyUrl = cfg.data?.privacy.policy_url;
  return (
    <AuthLayout
      title={invite ? "Join your team" : clientPortal ? "Create your client account" : firstRun ? "Create the owner account" : "Create your account"}
      subtitle={
        invite
          ? "Create an account to accept the invitation."
          : firstRun
            ? "The first account runs this installation: its settings, the people in it and every workspace."
            : cfg.data?.billing.stripe
              ? "Free to start. No credit card required."
              : "It only takes a minute."
      }
      footer={
        <>
          Already have an account?{" "}
          <Link to={clientPortal ? "/client/login" : `/auth/login${invite ? `?next=${encodeURIComponent(`/invitations?token=${invite}`)}` : ""}`} className="font-medium text-brand-text hover:underline">
            Log in
          </Link>
        </>
      }
    >
      {!invite && !clientPortal && <OAuthButtons google={!!cfg.data?.sign_in.google} microsoft={!!cfg.data?.sign_in.microsoft} label="Sign up" returnTo="/app/signup-know-user" />}
      <form onSubmit={submit} className="space-y-4">
        {error && <Callout tone="bad">{error}</Callout>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">{(id) => <Input id={id} autoComplete="given-name" autoFocus value={form.first_name} onChange={(e) => set("first_name")(e.target.value)} required />}</Field>
          <Field label="Last name">{(id) => <Input id={id} autoComplete="family-name" value={form.last_name} onChange={(e) => set("last_name")(e.target.value)} />}</Field>
        </div>
        <Field label="Work email">
          {(id) => <Input id={id} type="email" autoComplete="email" value={form.email} readOnly={!!invite && !!params.get("email")} onChange={(e) => set("email")(e.target.value)} required placeholder="you@company.com" />}
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          {(id) => (
            <div>
              <PasswordInput id={id} value={form.password} onChange={set("password")} autoComplete="new-password" />
              {strength > 0 && (
                <div className="mt-2 flex gap-1" aria-hidden>
                  {[1, 2, 3].map((i) => (
                    <span key={i} className={`h-1 flex-1 rounded-full ${i <= strength ? (strength === 1 ? "bg-bad" : strength === 2 ? "bg-warn" : "bg-ok") : "bg-panel-2"}`} />
                  ))}
                </div>
              )}
            </div>
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Create account
        </Button>
        <p className="text-center text-xs text-faint">
          By signing up you agree to the{" "}
          {termsUrl && (
            <>
              <a href={termsUrl} target="_blank" rel="noreferrer" className="underline">
                terms
              </a>{" "}
              and the{" "}
            </>
          )}
          {policyUrl ? (
            <a href={policyUrl} target="_blank" rel="noreferrer" className="underline">
              privacy policy
            </a>
          ) : (
            <Link to="/privacy/info" className="underline">
              privacy policy
            </Link>
          )}
          .
        </p>
      </form>
    </AuthLayout>
  );
}

export default function Signup() {
  return <SignupForm />;
}

export function ClientSignup() {
  return <SignupForm clientPortal />;
}

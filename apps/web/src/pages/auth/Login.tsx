import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { ApiError, errorMessage, post } from "@/lib/api";
import { ME_KEY, useMe, usePublicConfig } from "@/lib/session";
import { Button, Callout, Field, Input } from "@/components/ui";
import { AuthLayout, OAuthButtons } from "./AuthLayout";

function safeNext(v: string | null) {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/app/dashboard";
}

export function PasswordInput(props: { id?: string; value: string; onChange: (v: string) => void; autoComplete?: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <Input
      id={props.id}
      type={show ? "text" : "password"}
      value={props.value}
      autoComplete={props.autoComplete}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      required
      trailing={
        <button type="button" className="rounded p-1 hover:text-text" aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(!show)}>
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      }
    />
  );
}

function MfaStep({ next }: { next: string }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/app/auth/mfa/verify", recovery ? { recovery_code: code } : { code });
      await qc.invalidateQueries({ queryKey: ME_KEY });
      nav(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    await post("/api/app/auth/logout").catch(() => undefined);
    qc.clear();
    nav("/auth/login", { replace: true });
  };
  return (
    <AuthLayout
      title="Two-step verification"
      subtitle={recovery ? "Enter one of the recovery codes you saved when you turned on two-step verification." : "Enter the 6-digit code from your authenticator app."}
      footer={
        <button type="button" className="hover:text-text" onClick={logout}>
          Sign in with a different account
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Callout tone="bad">{error}</Callout>}
        <Field label={recovery ? "Recovery code" : "Verification code"}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              autoComplete="one-time-code"
              inputMode={recovery ? "text" : "numeric"}
              value={code}
              onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder={recovery ? "xxxx-xxxx-xxxx" : "123456"}
              className="tracking-widest"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={recovery ? code.trim().length < 6 : code.length !== 6}>
          Verify
        </Button>
        <button
          type="button"
          className="w-full text-center text-[13px] text-brand-text hover:underline"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
            setError(null);
          }}
        >
          {recovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
        </button>
      </form>
    </AuthLayout>
  );
}

export function LoginForm({ clientPortal = false }: { clientPortal?: boolean }) {
  const [params] = useSearchParams();
  const cfg = usePublicConfig();
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("error"));
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(params.get("mfa") === "1");

  const mfaPending = me.data?.session.mfa_pending || (me.error instanceof ApiError && me.error.code === "mfa_required");
  if (mfa || mfaPending) return <MfaStep next={next} />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ mfa_required: boolean }>("/api/app/auth/login", { email, password, ...(clientPortal ? { client_portal: true } : {}) });
      if (r.mfa_required) {
        setMfa(true);
        return;
      }
      await qc.invalidateQueries({ queryKey: ME_KEY });
      nav(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={clientPortal ? "Client portal" : "Welcome back"}
      subtitle={clientPortal ? "Sign in to see the campaigns your agency runs for you." : "Log in to your account."}
      footer={
        <>
          Don't have an account?{" "}
          <Link to={clientPortal ? "/client/sign-up" : "/auth/signup"} className="font-medium text-brand-text hover:underline">
            Sign up
          </Link>
        </>
      }
    >
      {!clientPortal && <OAuthButtons google={!!cfg.data?.sign_in.google} microsoft={!!cfg.data?.sign_in.microsoft} returnTo={next} />}
      <form onSubmit={submit} className="space-y-4">
        {cfg.data?.first_run && !clientPortal && (
          <Callout tone="info">
            Nobody has an account here yet.{" "}
            <Link to="/auth/signup" className="font-medium text-brand-text hover:underline">
              Create the first one
            </Link>
            : it runs this installation.
          </Callout>
        )}
        {error && <Callout tone="bad">{error}</Callout>}
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" />}</Field>
        {/* The reset link sits outside the label so the field keeps a clean name and the tab order runs email → password. */}
        <div className="relative">
          <Field label="Password">{(id) => <PasswordInput id={id} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
          <Link to="/auth/reset-password" className="absolute right-0 top-0 text-[13px] text-brand-text hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Log in
        </Button>
      </form>
    </AuthLayout>
  );
}

export default function Login() {
  return <LoginForm />;
}

export function ClientLogin() {
  return <LoginForm clientPortal />;
}

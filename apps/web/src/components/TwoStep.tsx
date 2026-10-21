// Turning on two-step authentication, shared by Profile & security and the screen a workspace shows when it requires it.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Smartphone } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, post } from "@/lib/api";
import { Button, Callout, CopyButton, Field, Input } from "@/components/ui";

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-2">
      <Callout tone="warn" title="Save these recovery codes">
        Each code works once if you lose your phone. They won't be shown again.
      </Callout>
      <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-line bg-panel-2 p-3 font-mono text-[13px]">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <CopyButton value={codes.join("\n")} label="Copy codes" />
    </div>
  );
}

/**
 * Password first (when the account has one, so a browser left signed in can't turn it on for someone else), then
 * scan the code, then confirm one code. Calls `onDone` with the recovery codes.
 */
export function TwoStepSetup({ hasPassword, onDone, onCancel }: { hasPassword: boolean; onDone: (codes: string[]) => void | Promise<void>; onCancel?: () => void }) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ secret: string; qr_data_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () => run(async () => setSetup(await post("/api/app/auth/mfa/setup", hasPassword ? { password } : {})));

  // Without a password there's nothing to ask first.
  useEffect(() => {
    if (!hasPassword && !started.current) {
      started.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPassword]);

  if (!setup) {
    if (!hasPassword) return <p className="text-sm text-muted">{busy ? "Preparing your setup code…" : "Couldn't start the setup."}</p>;
    return (
      <form
        className="max-w-md space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void start();
        }}
      >
        <Field label="Your password" hint="Confirms it's you before an authenticator is linked to your account.">
          {(id) => <Input id={id} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" icon={<Smartphone size={14} />} loading={busy} disabled={!password}>
            Continue
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    );
  }
  return (
    <div className="max-w-md space-y-3">
      <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
        <li>Scan the code with an authenticator app (Google Authenticator, 1Password, Authy…).</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-4">
        <img src={setup.qr_data_url} alt="Authenticator setup QR code" className="h-40 w-40 rounded-lg border border-line bg-white p-1" />
        <div className="min-w-0 text-xs text-muted">
          Can't scan? Enter this key:
          <code className="mt-1 block break-all rounded bg-panel-2 px-2 py-1 font-mono text-text">{setup.secret}</code>
        </div>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await post<{ recovery_codes: string[] }>("/api/app/auth/mfa/enable", { code });
            await onDone(r.recovery_codes);
          });
        }}
      >
        <Field label="Code" className="w-40">
          {(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
          Turn on
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </form>
    </div>
  );
}

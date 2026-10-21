import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CAMPAIGN_TIMEZONES } from "@reachstack/shared";
import { KeyRound, LogOut, Monitor, ShieldCheck, Smartphone, Upload } from "lucide-react";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { ago } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { imageToDataUrl } from "@/lib/image";
import { ME_KEY, resendConfirmation, useSession } from "@/lib/session";
import { applyTheme, type Theme } from "@/lib/theme";
import { Avatar, Badge, Button, Card, Dialog, Field, Input, NativeSelect, Section, Segmented } from "@/components/ui";
import { RecoveryCodes, TwoStepSetup } from "@/components/TwoStep";
import { SettingsHeader } from "./parts";

type User = ReturnType<typeof useSession>["user"] & { has_password?: boolean; phone?: string | null };

interface SessionRow {
  id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl|node|python/i.test(ua) ? "Script" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function ProfileSection({ user }: { user: User }) {
  const qc = useQueryClient();
  const [first, setFirst] = useState(user.first_name);
  const [last, setLast] = useState(user.last_name);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [tz, setTz] = useState(user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const dirty = first !== user.first_name || last !== user.last_name || phone !== (user.phone ?? "") || tz !== (user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  const save = async (changes: Record<string, unknown>, message = "Profile updated") => {
    setBusy(true);
    try {
      await patch("/api/app/auth/profile", changes);
      await qc.invalidateQueries({ queryKey: ME_KEY });
      toast.success(message);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const zones = (CAMPAIGN_TIMEZONES as readonly string[]).includes(tz) ? [...CAMPAIGN_TIMEZONES] : [tz, ...CAMPAIGN_TIMEZONES];

  return (
    <Section title="Profile" description="How you appear to teammates and in activity logs.">
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <Avatar name={`${user.first_name} ${user.last_name}`} email={user.email} src={user.avatar_url} size={56} />
          <div className="flex flex-wrap gap-2">
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  await save({ avatar_url: await imageToDataUrl(f, 256) }, "Photo updated");
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            />
            <Button size="sm" icon={<Upload size={14} />} onClick={() => file.current?.click()}>
              Upload photo
            </Button>
            {user.avatar_url && (
              <Button size="sm" variant="ghost" onClick={() => save({ avatar_url: null }, "Photo removed")}>
                Remove
              </Button>
            )}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name">{(id) => <Input id={id} value={first} maxLength={80} onChange={(e) => setFirst(e.target.value)} />}</Field>
          <Field label="Last name">{(id) => <Input id={id} value={last} maxLength={80} onChange={(e) => setLast(e.target.value)} />}</Field>
          <Field label="Phone" optional>
            {(id) => <Input id={id} type="tel" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 010 0100" />}
          </Field>
          <Field label="Your timezone" hint="Used for dates and times you see.">
            {(id) => <NativeSelect id={id} value={tz} onChange={setTz} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} />}
          </Field>
        </div>
        <Button variant="primary" disabled={!dirty || !first.trim()} loading={busy} onClick={() => save({ first_name: first.trim(), last_name: last.trim(), phone: phone.trim() || null, timezone: tz })}>
          Save profile
        </Button>
      </div>
    </Section>
  );
}

function AppearanceSection({ user }: { user: User }) {
  const [theme, setTheme] = useState<Theme>((user.theme as Theme | null) ?? "system");
  return (
    <Section title="Appearance" description="Applies on every device you sign in from.">
      <Segmented
        value={theme}
        onChange={(t) => {
          setTheme(t);
          applyTheme(t);
          patch("/api/app/auth/profile", { theme: t }).catch((e) => toast.error(errorMessage(e)));
        }}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "Match system" },
        ]}
      />
    </Section>
  );
}

function EmailSection({ user }: { user: User }) {
  const qc = useQueryClient();
  const { features } = useSession();
  // Without system email, codes and links only reach the owner's System emails list (Settings → Installation).
  const mail = !!features.system_smtp;
  const noMail = features.owner
    ? "This installation can't send email yet, so the code is in Settings → Installation, under System emails."
    : "This installation can't send email yet. Ask whoever runs it for the code.";
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const needsPassword = user.has_password !== false;
  useEffect(() => {
    if (open) {
      setEmail("");
      setPassword("");
      setCode("");
      setSent(false);
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (!sent) {
        await post("/api/app/auth/change-email/send-code", { new_email: email, ...(needsPassword ? { current_password: password } : {}) });
        setSent(true);
        if (mail) toast.success(`We sent a code to ${email}`);
      } else {
        await post("/api/app/auth/change-email/verify", { code });
        await qc.invalidateQueries({ queryKey: ME_KEY });
        toast.success("Email address changed");
        setOpen(false);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Email address" description="Used to sign in and for notifications.">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{user.email}</span>
        {user.email_verified ? <Badge tone="ok">Verified</Badge> : mail && <Badge tone="warn">Not verified</Badge>}
        <Button size="sm" onClick={() => setOpen(true)}>
          Change email
        </Button>
        {!user.email_verified && mail && (
          <Button size="sm" variant="ghost" onClick={() => void resendConfirmation(!!features.owner)}>
            Resend verification
          </Button>
        )}
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Change email address"
        description={
          sent
            ? mail
              ? `Enter the 6-digit code we sent to ${email}.`
              : noMail
            : "We'll send a confirmation code to the new address. Other devices are signed out once it's changed."
        }
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" form="change-email" variant="primary" loading={busy} disabled={sent ? code.trim().length < 6 : !email.includes("@") || (needsPassword && !password)}>
              {sent ? "Confirm" : "Send code"}
            </Button>
          </>
        }
      >
        <form id="change-email" onSubmit={submit} className="space-y-3">
          {!sent ? (
            <>
              <Field label="New email address">{(id) => <Input id={id} type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />}</Field>
              {needsPassword && (
                <Field label="Your password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
              )}
            </>
          ) : (
            <Field label="Confirmation code">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} maxLength={6} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />}</Field>
          )}
        </form>
      </Dialog>
    </Section>
  );
}

function PasswordSection({ user }: { user: User }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const hasPassword = user.has_password !== false;
  const mismatch = !!repeat && next !== repeat;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post("/api/app/auth/change-password", { current_password: hasPassword ? current : undefined, new_password: next });
      setCurrent("");
      setNext("");
      setRepeat("");
      toast.success("Password updated. Other devices were signed out.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={hasPassword ? "Password" : "Set a password"} description={hasPassword ? "Changing it signs you out everywhere else." : "You sign in with Google or Microsoft. Add a password to sign in with your email too."}>
      <form onSubmit={submit} className="grid max-w-md gap-3">
        {hasPassword && <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>}
        <Field label="New password" hint="At least 8 characters.">
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Field label="Repeat new password" error={mismatch ? "The passwords don't match" : null}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={repeat} invalid={mismatch} onChange={(e) => setRepeat(e.target.value)} />}
        </Field>
        <div>
          <Button type="submit" variant="primary" icon={<KeyRound size={14} />} loading={busy} disabled={next.length < 8 || next !== repeat || (hasPassword && !current)}>
            {hasPassword ? "Update password" : "Set password"}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function TwoStepSection({ user }: { user: User }) {
  const qc = useQueryClient();
  const [setting, setSetting] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);

  return (
    <Section title="Two-step authentication" description="Ask for a code from an authenticator app when you sign in.">
      {codes ? (
        <div className="max-w-md space-y-3">
          <RecoveryCodes codes={codes} />
          <Button onClick={() => setCodes(null)}>I saved them</Button>
        </div>
      ) : user.totp_enabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok" dot>
            On
          </Badge>
          <Button size="sm" onClick={() => setRegenOpen(true)}>
            New recovery codes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDisableOpen(true)}>
            Turn off
          </Button>
        </div>
      ) : setting ? (
        <TwoStepSetup
          hasPassword={user.has_password !== false}
          onCancel={() => setSetting(false)}
          onDone={async (c) => {
            await qc.invalidateQueries({ queryKey: ME_KEY });
            setSetting(false);
            setCodes(c);
            toast.success("Two-step authentication is on. Other devices were signed out.");
          }}
        />
      ) : (
        <Button icon={<Smartphone size={14} />} onClick={() => setSetting(true)}>
          Set up two-step authentication
        </Button>
      )}

      <CodeDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Turn off two-step authentication?"
        description="Enter a code from your authenticator app, or your password."
        allowPassword
        confirmLabel="Turn off"
        onConfirm={async (v) => {
          await post("/api/app/auth/mfa/disable", v);
          await qc.invalidateQueries({ queryKey: ME_KEY });
          toast.success("Two-step authentication is off");
        }}
      />
      <CodeDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        title="Create new recovery codes"
        description="Your old codes stop working. Enter a code from your authenticator app to continue."
        confirmLabel="Create codes"
        onConfirm={async (v) => {
          const r = await post<{ recovery_codes: string[] }>("/api/app/auth/mfa/recovery-codes", { code: v.code });
          setCodes(r.recovery_codes);
        }}
      />
    </Section>
  );
}

function CodeDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  allowPassword,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  allowPassword?: boolean;
  onConfirm: (v: { code?: string; password?: string }) => Promise<void>;
}) {
  const [mode, setMode] = useState<"code" | "password">("code");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue("");
      setMode("code");
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onConfirm(mode === "code" ? { code: value } : { password: value });
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="code-dialog" variant="primary" loading={busy} disabled={!value}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id="code-dialog" onSubmit={submit} className="space-y-3">
        {allowPassword && (
          <Segmented
            size="sm"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setValue("");
            }}
            options={[
              { value: "code", label: "Authenticator code" },
              { value: "password", label: "Password" },
            ]}
          />
        )}
        {mode === "code" ? (
          <Field label="Code">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" autoFocus value={value} maxLength={6} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} />}</Field>
        ) : (
          <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        )}
      </form>
    </Dialog>
  );
}

function SessionsSection() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["auth-sessions"], queryFn: () => get<SessionRow[]>("/api/app/auth/sessions") });
  const others = (sessions.data ?? []).filter((s) => !s.current);
  const end = async (ids: string[]) => {
    try {
      for (const id of ids) await del(`/api/app/auth/sessions/${id}`);
      await qc.invalidateQueries({ queryKey: ["auth-sessions"] });
      toast.success(ids.length === 1 ? "Signed out of that device" : "Signed out of other devices");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Section
      title="Where you're signed in"
      description="Sign out of devices you don't recognise."
      actions={
        others.length > 1 ? (
          <Button size="sm" icon={<LogOut size={14} />} onClick={() => end(others.map((s) => s.id))}>
            Sign out of all others
          </Button>
        ) : undefined
      }
    >
      <Card padded={false} className="divide-y divide-line">
        {(sessions.data ?? []).map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-3">
            <Monitor size={16} className="shrink-0 text-faint" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                {describeAgent(s.user_agent)} {s.current && <Badge tone="brand">This device</Badge>}
              </p>
              <p className="truncate text-xs text-muted">
                {s.ip ?? "Unknown IP"} · active {ago(s.last_seen_at)} · signed in {ago(s.created_at)}
              </p>
            </div>
            {!s.current && (
              <Button size="xs" variant="ghost" onClick={() => end([s.id])}>
                Sign out
              </Button>
            )}
          </div>
        ))}
        {sessions.isLoading && <p className="px-4 py-3 text-[13px] text-muted">Loading…</p>}
      </Card>
    </Section>
  );
}

function DeleteAccountSection({ user }: { user: User }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  // /app/settings/delete-user lands here with the confirmation already open.
  const [open, setOpen] = useState(() => window.location.hash === "#delete-account");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await del("/api/app/auth/account", { password: password || undefined, confirm });
      qc.clear();
      nav("/auth/login", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Delete account" description="Removes your login and any workspace only you belong to. Shared workspaces must be handed to someone else first.">
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete my account
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Delete your account?"
        description="This can't be undone."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" form="delete-account" variant="danger" loading={busy} disabled={confirm !== "DELETE" || (user.has_password !== false && !password)}>
              Delete account
            </Button>
          </>
        }
      >
        <form id="delete-account" onSubmit={submit} className="space-y-3">
          {user.has_password !== false && <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>}
          <Field label={<>Type DELETE to confirm</>}>{(id) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        </form>
      </Dialog>
    </Section>
  );
}

/** /app/settings/account */
export default function Profile() {
  usePageTitle("Profile & security");
  const me = useSession();
  const user = me.user as User;
  return (
    <div>
      <SettingsHeader title="Profile & security" description="Your own login. Workspace settings are in the sections below it." />
      <ProfileSection key={`${user.id}:${user.first_name}:${user.last_name}:${user.timezone}`} user={user} />
      <AppearanceSection user={user} />
      <EmailSection user={user} />
      <PasswordSection user={user} />
      <TwoStepSection user={user} />
      <SessionsSection />
      <Section title="Sign-in methods" description="Single sign-on providers the installation offers.">
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <ShieldCheck size={14} /> Google and Microsoft sign-in work when the server administrator has added their OAuth credentials.
        </p>
      </Section>
      <DeleteAccountSection user={user} />
    </div>
  );
}

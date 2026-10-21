// /app/settings/installation/services — keys and services the installation owner sets here instead of in the server's
// .env file: AI (Claude or a local model), system email, Google and Microsoft sign-in, email checks, calls and texts,
// and the name and privacy contacts people see. A saved value is in use at once; clearing it goes back to .env. Saved
// keys never come back to the browser, only their last four characters.
import { useEffect, useId, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldOff } from "lucide-react";
import { errorMessage, get, patch, post } from "@/lib/api";
import { ago } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Badge, Button, Callout, Card, CardHeader, CopyButton, EmptyState, Input, Segmented, Skeleton, Switch, useConfirm } from "@/components/ui";

// ---------- Types ----------

type Value = string | number | boolean;

interface ServiceField {
  key: string;
  env: string;
  kind: "text" | "secret" | "url" | "email" | "port" | "switch" | "choice";
  choices?: string[];
  source: "saved" | "env" | "none";
  value: Value | null;
  hint: string | null;
  env_set: boolean;
}

interface ServicesView {
  fields: ServiceField[];
  updated_at: string | null;
  updated_by: string | null;
  redirect_uris: { google: string; microsoft: string };
}

type TestService = "ai" | "smtp" | "smtp_send" | "spamd";
interface TestResult {
  ok: boolean;
  message: string;
}

const KEY = ["admin", "services"];

/** What the page calls each setting. */
const LABELS: Record<string, { label: string; placeholder?: string; hint?: ReactNode }> = {
  "anthropic.api_key": { label: "Anthropic API key", placeholder: "sk-ant-…", hint: "From console.anthropic.com → API keys." },
  "anthropic.model": { label: "Model", placeholder: "claude-opus-5-5" },
  "anthropic.base_url": { label: "API address", placeholder: "https://api.anthropic.com", hint: "Leave empty to use Anthropic's API." },
  "openai.base_url": { label: "Server address", placeholder: "http://localhost:11434/v1", hint: "Ollama: http://localhost:11434/v1. LM Studio: http://localhost:1234/v1." },
  "openai.model": { label: "Model", placeholder: "qwen3:14b", hint: "The model's name on that server. Bigger models write better emails." },
  "openai.api_key": { label: "API key", hint: "Only if the server asks for one." },
  "google.client_id": { label: "Client ID", placeholder: "…apps.googleusercontent.com" },
  "google.client_secret": { label: "Client secret" },
  "microsoft.client_id": { label: "Application (client) ID" },
  "microsoft.client_secret": { label: "Client secret value" },
  "smtp.host": { label: "SMTP server", placeholder: "smtp.example.com" },
  "smtp.port": { label: "Port", hint: "587 for STARTTLS, 465 for SSL." },
  "smtp.user": { label: "Username" },
  "smtp.pass": { label: "Password" },
  "smtp.from": { label: "From", placeholder: "Reachstack <no-reply@example.com>", hint: "Leave empty to send from the username." },
  "verify.smtp_probe": {
    label: "Ask the receiving server",
    hint: "Verification and the email finder also ask the address's mail server whether it exists. This server then connects out on port 25, which many home and cloud networks block.",
  },
  "spamd.host": { label: "spamd host", placeholder: "127.0.0.1", hint: "SpamAssassin's spamd scores emails in the spam check. Without it a built-in check runs." },
  "spamd.port": { label: "spamd port" },
  "hunter.api_key": { label: "Hunter API key", hint: "Finds emails the Lead Finder data doesn't have." },
  "ipinfo.token": { label: "IPinfo token", hint: "Matches website visits to companies for every workspace without a token of its own." },
  "twilio.account_sid": { label: "Twilio account SID" },
  "twilio.auth_token": { label: "Twilio auth token" },
  "brand.name": { label: "Product name", hint: "Shown in the app, system emails and unsubscribe pages." },
  "privacy.email": { label: "Privacy email", placeholder: "privacy@example.com" },
  "privacy.phone": { label: "Privacy phone" },
  "privacy.policy_url": { label: "Privacy policy address", placeholder: "https://example.com/privacy" },
  "privacy.terms_url": { label: "Terms address", placeholder: "https://example.com/terms" },
};

// ---------- Page ----------

export function InstallationServices() {
  const me = useSession();
  // On a phone this tab can start out of view: bring it into the tab row's view.
  useEffect(() => {
    document.querySelector<HTMLElement>('nav a[aria-current="page"][href$="/installation/services"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  if (!me.features.owner) {
    return <EmptyState icon={<ShieldOff size={24} />} title="Only the owner of this installation can see its keys and services" description="Ask whoever runs this installation if something needs changing." />;
  }
  return <Services />;
}

function Services() {
  const q = useQuery({ queryKey: KEY, queryFn: () => get<ServicesView>("/api/app/admin/services") });
  const d = q.data;
  if (q.isError) return <Callout tone="bad">{errorMessage(q.error)}</Callout>;
  if (!d) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <Callout tone="info">
        A value saved here is used at once and replaces the server's .env file; clear it to go back to .env. Keys are stored encrypted and only their last four
        characters are shown again.{d.updated_at ? ` Last changed ${ago(d.updated_at)}.` : ""}
      </Callout>

      <ServiceCard
        view={d}
        title="AI"
        description="Writing, reply labels, the reply agent and the other AI features, for every workspace without a key of its own."
        keys={["ai.provider", "anthropic.api_key", "anthropic.model", "anthropic.base_url", "openai.base_url", "openai.model", "openai.api_key"]}
        tests={[{ service: "ai", label: "Test AI" }]}
        render={(field, values) => {
          const local = values["ai.provider"] === "openai";
          return (
            <>
              {field("ai.provider")}
              {local ? (
                <>
                  <Callout tone="info">
                    A model on your own computer or server through the OpenAI chat API (Ollama, LM Studio, vLLM…). Nothing leaves your network. Every AI feature
                    uses it, Copilot included; for Copilot pick a model that supports tool calls (Llama 3.1, Qwen 2.5 or bigger).
                  </Callout>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {field("openai.base_url")}
                    {field("openai.model")}
                  </div>
                  {field("openai.api_key")}
                </>
              ) : (
                <>
                  {field("anthropic.api_key")}
                  <div className="grid gap-4 sm:grid-cols-2">
                    {field("anthropic.model")}
                    {field("anthropic.base_url")}
                  </div>
                </>
              )}
            </>
          );
        }}
      />

      <ServiceCard
        view={d}
        title="System email"
        description="Sign-up confirmations, password links, invitations and alerts. Without it they're printed in the server's console."
        keys={["smtp.host", "smtp.port", "smtp.user", "smtp.pass", "smtp.from"]}
        tests={[
          { service: "smtp", label: "Test sign-in" },
          { service: "smtp_send", label: "Send me a test email" },
        ]}
        render={(field) => (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              {field("smtp.host")}
              {field("smtp.port")}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {field("smtp.user")}
              {field("smtp.pass")}
            </div>
            {field("smtp.from")}
          </>
        )}
      />

      <ServiceCard
        view={d}
        title="Sign in with Google and Microsoft"
        description="People sign in with Google or Microsoft and connect Gmail and Outlook mailboxes in one click. Without these, mailboxes connect with an app password over IMAP and SMTP."
        keys={["google.client_id", "google.client_secret", "microsoft.client_id", "microsoft.client_secret"]}
        render={(field) => (
          <>
            <Provider
              name="Google"
              where="Google Cloud console → APIs & Services → Credentials → Create OAuth client ID (Web application). Add this as an authorised redirect URI:"
              uri={d.redirect_uris.google}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {field("google.client_id")}
              {field("google.client_secret")}
            </div>
            <Provider name="Microsoft" where="Microsoft Entra admin center → App registrations → New registration (Web). Add this as a redirect URI:" uri={d.redirect_uris.microsoft} />
            <div className="grid gap-4 sm:grid-cols-2">
              {field("microsoft.client_id")}
              {field("microsoft.client_secret")}
            </div>
          </>
        )}
      />

      <ServiceCard
        view={d}
        title="Email checks"
        description="Spam scoring, address verification and finding emails."
        keys={["spamd.host", "spamd.port", "verify.smtp_probe", "hunter.api_key"]}
        tests={[{ service: "spamd", label: "Test spamd" }]}
        render={(field) => (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              {field("spamd.host")}
              {field("spamd.port")}
            </div>
            {field("verify.smtp_probe")}
            {field("hunter.api_key")}
          </>
        )}
      />

      <ServiceCard
        view={d}
        title="Website visitors, calls and texts"
        keys={["ipinfo.token", "twilio.account_sid", "twilio.auth_token"]}
        render={(field) => (
          <>
            {field("ipinfo.token")}
            <div className="grid gap-4 sm:grid-cols-2">
              {field("twilio.account_sid")}
              {field("twilio.auth_token")}
            </div>
          </>
        )}
      />

      <ServiceCard
        view={d}
        title="Name and privacy contacts"
        description="What people see: the product's name, and who to contact about their data on the privacy and opt-out pages."
        keys={["brand.name", "privacy.email", "privacy.phone", "privacy.policy_url", "privacy.terms_url"]}
        render={(field) => (
          <>
            {field("brand.name")}
            <div className="grid gap-4 sm:grid-cols-2">
              {field("privacy.email")}
              {field("privacy.phone")}
              {field("privacy.policy_url")}
              {field("privacy.terms_url")}
            </div>
          </>
        )}
      />
    </div>
  );
}

function Provider({ name, where, uri }: { name: string; where: string; uri: string }) {
  return (
    <div className="rounded-lg bg-panel-2 px-3.5 py-3 text-[13px]">
      <p className="font-medium">{name}</p>
      <p className="mt-0.5 text-muted">{where}</p>
      <div className="mt-2 flex min-w-0 items-center gap-1 rounded-md border border-line bg-panel px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate text-xs">{uri}</code>
        <CopyButton value={uri} label={`Copy the ${name} redirect address`} />
      </div>
    </div>
  );
}

// ---------- One card of settings ----------

/** What a field holds before any change: a secret's box starts empty (typing replaces it). */
const initial = (f: ServiceField): Value => (f.kind === "secret" ? "" : f.kind === "switch" ? f.value === true : f.value === null ? "" : f.value);

function ServiceCard({
  view,
  title,
  description,
  keys,
  tests = [],
  render,
}: {
  view: ServicesView;
  title: string;
  description?: string;
  keys: string[];
  tests?: Array<{ service: TestService; label: string }>;
  render: (field: (key: string) => ReactNode, values: Record<string, Value>) => ReactNode;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const byKey = new Map(view.fields.map((f) => [f.key, f]));
  const [edits, setEdits] = useState<Record<string, Value>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<TestService | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const values = Object.fromEntries(keys.map((k) => [k, k in edits ? edits[k]! : initial(byKey.get(k)!)]));
  const dirty = Object.keys(edits).length > 0;

  const edit = (key: string, v: Value) =>
    setEdits((e) => {
      const next = { ...e };
      if (v === initial(byKey.get(key)!)) delete next[key];
      else next[key] = v;
      return next;
    });

  const send = async (patchValues: Record<string, Value | null>, done: string) => {
    setSaving(true);
    try {
      qc.setQueryData(KEY, await patch<ServicesView>("/api/app/admin/services", { values: patchValues }));
      setResult(null);
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (await send(edits, `${title}: saved and in use.`)) setEdits({});
  };

  const clear = async (f: ServiceField) => {
    const label = LABELS[f.key]?.label ?? f.key;
    if (f.kind === "secret") {
      const ok = await confirm({
        title: `Remove the saved ${label.toLowerCase()}?`,
        description: f.env_set ? `The server goes back to the one in its .env file (${f.env}).` : "Nothing replaces it: what it's for stops working until you add one again.",
        confirmLabel: "Remove",
        danger: !f.env_set,
      });
      if (!ok) return;
    }
    if (await send({ [f.key]: null }, f.env_set ? `${label}: back to the .env value.` : `${label}: cleared.`)) {
      setEdits((e) => {
        const next = { ...e };
        delete next[f.key];
        return next;
      });
    }
  };

  const test = async (service: TestService) => {
    setTesting(service);
    setResult(null);
    try {
      setResult(await post<TestResult>("/api/app/admin/services/test", { service }));
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) });
    } finally {
      setTesting(null);
    }
  };

  const field = (key: string): ReactNode => {
    const f = byKey.get(key);
    return f ? <SettingField key={key} f={f} value={values[key]!} onEdit={(x) => edit(key, x)} onClear={() => clear(f)} busy={saving} /> : null;
  };

  return (
    <Card>
      <CardHeader title={title} description={description} />
      <div className="space-y-4">{render(field, values)}</div>
      {result && (
        <Callout tone={result.ok ? "ok" : "bad"} className="mt-4">
          {result.message}
        </Callout>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {tests.map((t) => (
          <Button key={t.service} size="sm" loading={testing === t.service} disabled={!!testing || dirty} onClick={() => test(t.service)}>
            {t.label}
          </Button>
        ))}
        {dirty && tests.length > 0 && <span className="text-xs text-muted">Save to test the new values.</span>}
        <div className="ml-auto flex gap-2">
          {dirty && (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEdits({})}>
              Discard
            </Button>
          )}
          <Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** One setting: its label, where its value comes from, a way back to .env, and the box or switch to change it. */
function SettingField({ f, value, onEdit, onClear, busy }: { f: ServiceField; value: Value; onEdit: (v: Value) => void; onClear: () => void; busy: boolean }) {
  const id = useId();
  const meta = LABELS[f.key] ?? { label: f.key };
  const reset =
    f.source === "saved" ? (
      <button type="button" className="shrink-0 text-xs font-medium text-brand-text hover:underline disabled:opacity-50" disabled={busy} onClick={onClear}>
        {f.env_set ? "Use .env" : "Clear"}
      </button>
    ) : null;

  if (f.kind === "choice") {
    return (
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <p className="text-[13px] font-medium">Which AI</p>
          <SourceBadge f={f} />
          <span className="ml-auto">{reset}</span>
        </div>
        <Segmented
          aria-label="Which AI"
          value={String(value)}
          onChange={onEdit}
          options={[
            { value: "anthropic", label: "Claude" },
            { value: "openai", label: "Local or other AI server" },
          ]}
        />
      </div>
    );
  }
  if (f.kind === "switch") {
    return (
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={id} className="text-[13px] font-medium">
              {meta.label}
            </label>
            <SourceBadge f={f} />
            {reset}
          </div>
          {meta.hint && <p className="mt-0.5 text-xs text-muted">{meta.hint}</p>}
        </div>
        <Switch id={id} checked={value === true} onChange={onEdit} />
      </div>
    );
  }
  const secret = f.kind === "secret";
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex min-h-5 items-center gap-2">
        <label htmlFor={id} className="truncate text-[13px] font-medium">
          {meta.label}
        </label>
        <SourceBadge f={f} />
        <span className="ml-auto">{reset}</span>
      </div>
      <Input
        id={id}
        type={secret ? "password" : f.kind === "url" ? "url" : f.kind === "email" ? "email" : "text"}
        inputMode={f.kind === "port" ? "numeric" : undefined}
        value={String(value)}
        onChange={(e) => onEdit(e.target.value)}
        placeholder={secret ? (f.hint ? `${f.source === "saved" ? "Saved" : "From .env"}${f.hint === "set" ? "" : ` (${f.hint})`}. Type to replace it.` : "Not set") : meta.placeholder}
        // Keep the browser and password managers from filling in the owner's own sign-in.
        autoComplete={secret ? "new-password" : "off"}
        data-1p-ignore
        data-lpignore="true"
        spellCheck={false}
      />
      {meta.hint && <p className="mt-1.5 text-xs text-muted">{meta.hint}</p>}
    </div>
  );
}

function SourceBadge({ f }: { f: ServiceField }) {
  if (f.source === "saved") return <Badge tone="info">Saved here</Badge>;
  if (f.source === "env") return <Badge>From .env</Badge>;
  return null;
}

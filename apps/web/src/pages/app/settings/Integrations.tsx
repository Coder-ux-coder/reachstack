import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { API_SCOPE_ACTIONS, API_SCOPE_RESOURCES } from "@reachstack/shared";
import { Bot, CalendarCheck, CheckCircle2, Code2, KeyRound, Play, Plus, RotateCcw, Send, Slack, Trash2, Webhook, XCircle } from "lucide-react";
import { del, errorMessage, get, patch, post, put, type Page } from "@/lib/api";
import { ago, dateTime, num } from "@/lib/format";
import { usePageTitle, useQueryState } from "@/lib/hooks";
import { useBrand, useCan, useSession } from "@/lib/session";
import { useLeadStatuses } from "@/lib/statuses";
import { useCampaignNames } from "@/lib/pickers";
import { Badge, Button, Callout, Card, CardHeader, CopyButton, Dialog, EmptyState, Field, Input, NativeSelect, Segmented, TabPanel, Tabs, useConfirm } from "@/components/ui";
import { SettingsHeader } from "./parts";
import { ScrollX } from "@/components/ui/scroll-x";

type Tab = "apps" | "assistants" | "api" | "webhooks" | "ai";

// ---------- Apps ----------

interface Connection {
  id: string;
  type: "slack" | "calendly";
  name: string;
  status: string;
  error: string | null;
  config: Record<string, unknown>;
  created_at: string;
}

const APP_INFO = {
  slack: { title: "Slack", icon: Slack, field: "webhook_url", label: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/…", about: "Agent alerts and reply notifications in a channel." },
  calendly: { title: "Calendly", icon: CalendarCheck, field: "scheduling_url", label: "Scheduling link", placeholder: "https://calendly.com/your-name/30min", about: "The booking link reply agents offer to interested leads." },
} as const;

function ConnectDialog({ type, onClose }: { type: "slack" | "calendly" | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName("");
    setValue("");
  }, [type]);
  if (!type) return null;
  const info = APP_INFO[type];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post("/api/app/integrations", { type, name: name.trim() || undefined, config: { [info.field]: value.trim() } });
      await qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.success(`${info.title} connected`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Connect ${info.title}`}
      description={info.about}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="connect-app" variant="primary" loading={busy} disabled={!value.trim()}>
            Connect
          </Button>
        </>
      }
    >
      <form id="connect-app" onSubmit={submit} className="space-y-3">
        <Field label="Name" optional>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "slack" ? "#sales-alerts" : "Intro call"} />}
        </Field>
        <Field label={info.label} hint={type === "slack" ? "In Slack: Apps → Incoming Webhooks → Add to a channel, then copy the URL." : undefined}>
          {(id) => <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={info.placeholder} />}
        </Field>
      </form>
    </Dialog>
  );
}

function AppsTab({ writable }: { writable: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [connecting, setConnecting] = useState<"slack" | "calendly" | null>(null);
  const list = useQuery({ queryKey: ["integrations"], queryFn: () => get<{ items: Connection[] }>("/api/app/integrations") });
  const items = list.data?.items ?? [];
  const test = async (c: Connection) => {
    try {
      const r = await post<{ ok: boolean; error: string | null }>(`/api/app/integrations/${c.id}/test`);
      if (r.ok) toast.success(c.type === "slack" ? "Test message sent" : "Booking page is reachable");
      else toast.error(r.error ?? "The test failed");
      qc.invalidateQueries({ queryKey: ["integrations"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async (c: Connection) => {
    if (!(await confirm({ title: `Disconnect ${c.name}?`, description: "Agents and automations that use it stop posting there.", confirmLabel: "Disconnect", danger: true }))) return;
    await del(`/api/app/integrations/${c.id}`).catch((e) => toast.error(errorMessage(e)));
    qc.invalidateQueries({ queryKey: ["integrations"] });
  };
  return (
    <div className="space-y-6 pt-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(APP_INFO) as Array<keyof typeof APP_INFO>).map((type) => {
          const info = APP_INFO[type];
          const Icon = info.icon;
          const mine = items.filter((i) => i.type === type);
          return (
            <Card key={type} className="flex flex-col">
              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-panel-2 p-2">
                  <Icon size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{info.title}</p>
                  <p className="text-[13px] text-muted">{info.about}</p>
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                {mine.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px]">
                    {c.status === "error" ? <XCircle size={14} className="text-bad" /> : <CheckCircle2 size={14} className="text-ok" />}
                    <span className="min-w-0 flex-1 truncate" title={c.error ?? undefined}>
                      {c.name}
                    </span>
                    {writable && (
                      <>
                        <Button size="xs" variant="ghost" onClick={() => test(c)}>
                          Test
                        </Button>
                        <Button size="xs" variant="ghost" aria-label={`Disconnect ${c.name}`} onClick={() => remove(c)}>
                          <Trash2 size={12} />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {writable && (
                <Button size="sm" className="mt-3 self-start" icon={<Plus size={14} />} onClick={() => setConnecting(type)}>
                  {mine.length ? "Add another" : "Connect"}
                </Button>
              )}
            </Card>
          );
        })}
      </div>
      <Card>
        <CardHeader title="CRMs, Zapier, Make and n8n" description="Anything that accepts a webhook or calls a REST API can connect." />
        <ul className="space-y-1.5 text-[13px] text-muted">
          <li>
            <span className="font-medium text-text">Push events out:</span> add a webhook (replies, opens, clicks, bounces, status changes) and point it at a Zapier/Make/n8n catch hook or your CRM's inbound endpoint.
          </li>
          <li>
            <span className="font-medium text-text">Pull or push data in:</span> create an API key and call the v2 API (campaigns, leads, emails, accounts, analytics). Paths and fields follow the widely used v2 shape, so existing integrations work with a changed base URL.
          </li>
          <li>
            <span className="font-medium text-text">AI assistants</span> (Claude, Cursor, Codex and others) work in the workspace through its MCP server: an admin connects them under AI assistants.
          </li>
          <li>
            <span className="font-medium text-text">Third-party OAuth apps</span> aren't offered on this installation; use API keys instead.
          </li>
        </ul>
      </Card>
      <ConnectDialog type={connecting} onClose={() => setConnecting(null)} />
    </div>
  );
}

// ---------- AI assistants (MCP) ----------

type AssistantApp = "claude-code" | "claude-desktop" | "cursor" | "other";

function Snippet({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="scroll-thin overflow-x-auto rounded-lg bg-panel-2 p-3 pr-10 text-xs">{code}</pre>
      <CopyButton value={code} className="absolute right-1.5 top-1.5" />
    </div>
  );
}

function AssistantsTab() {
  const qc = useQueryClient();
  const brand = useBrand();
  const [access, setAccess] = useState<"full" | "read">("full");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [appName, setAppName] = useState<AssistantApp>("claude-code");
  const info = useQuery({ queryKey: ["mcp-info"], queryFn: () => get<{ bridge: string | null; node: string }>("/api/app/mcp") });
  const origin = window.location.origin;
  const url = `${origin}/mcp`;
  const shown = key ?? "<your key>";

  const make = async () => {
    setBusy(true);
    try {
      const r = await post<{ key: string }>("/api/v2/api-keys", { name: access === "full" ? "AI assistant" : "AI assistant (read only)", scopes: [access === "full" ? "all:all" : "all:read"] });
      setKey(r.key);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setups: Record<AssistantApp, { how: string; code: string }> = {
    "claude-code": { how: "Run this in a terminal:", code: `claude mcp add --transport http reachstack ${url} --header "Authorization: Bearer ${shown}"` },
    "claude-desktop": {
      how: "In Claude, open Settings → Developer → Edit Config, add this to claude_desktop_config.json and restart Claude. It starts the bridge in this installation's folder, so it works on the computer the server runs on; elsewhere, copy tools/mcp.mjs over and change the path.",
      code: JSON.stringify({ mcpServers: { reachstack: { command: info.data?.node ?? "node", args: [info.data?.bridge ?? "<the Reachstack folder>/tools/mcp.mjs"], env: { REACHSTACK_URL: origin, REACHSTACK_API_KEY: shown } } } }, null, 2),
    },
    cursor: { how: "Add this to .cursor/mcp.json in a project, or to ~/.cursor/mcp.json for all of them:", code: JSON.stringify({ mcpServers: { reachstack: { url, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2) },
    other: { how: "Any app that connects to MCP servers over HTTP (VS Code, Windsurf, Cline, Codex…) needs the address and this header:", code: `${url}\nAuthorization: Bearer ${shown}` },
  };

  return (
    <div className="space-y-5 pt-5">
      <Card>
        <CardHeader
          title="Connect an AI assistant"
          description="Claude, Cursor, Codex and other AI assistants can work in this workspace for you: connect mailboxes, find and import leads, write and launch campaigns, and answer replies. They connect to its MCP server with an API key."
        />
        <div className="space-y-5">
          <div className="space-y-2">
            <p className="text-[13px] font-medium">1. Make a key for it</p>
            {key ? (
              <>
                <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{key}</code>
                  <CopyButton value={key} />
                </div>
                <p className="text-xs text-muted">It won't be shown again, so it's filled in below. Delete it any time under API keys.</p>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  aria-label="What the assistant may do"
                  value={access}
                  onChange={setAccess}
                  options={[
                    { value: "full", label: "Full access" },
                    { value: "read", label: "Read only" },
                  ]}
                />
                <Button variant="primary" icon={<KeyRound size={14} />} loading={busy} onClick={make}>
                  Make a key
                </Button>
              </div>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-[13px] font-medium">2. Add {brand} to the assistant</p>
            <Segmented
              size="sm"
              aria-label="Assistant"
              value={appName}
              onChange={setAppName}
              options={[
                { value: "claude-code", label: "Claude Code" },
                { value: "claude-desktop", label: "Claude Desktop" },
                { value: "cursor", label: "Cursor" },
                { value: "other", label: "Other apps" },
              ]}
            />
            <p className="text-xs text-muted">{setups[appName].how}</p>
            <Snippet code={setups[appName].code} />
          </div>
          <p className="text-xs text-muted">
            Then ask it something like "connect my mailboxes and launch a campaign to these leads". The MCP address is <span className="break-all font-mono">{url}</span>.
          </p>
        </div>
      </Card>
      <Callout tone="info" title="What an assistant can do with the key">
        A full-access key lets it do anything you can here, sending email included. Good assistants ask before they launch a campaign or send a reply; with a read-only key one can look and change nothing. Deleting the key under API keys cuts it off at once.
      </Callout>
      <Card>
        <CardHeader title="Assistants that can't connect to MCP" description="ChatGPT in a browser and other assistants without MCP can still help." />
        <p className="text-[13px] text-muted">
          One that can run commands can use the same tools from a terminal (<span className="font-mono">node tools/mcp.mjs</span> in {brand}'s folder), or call the REST API with a key (see{" "}
          <a className="text-brand-text underline" href="/developers">
            the API reference
          </a>
          ). The file docs/agents.md in that folder explains all of it: give it to the assistant.
        </p>
      </Card>
    </div>
  );
}

// ---------- API keys ----------

interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  key: string;
  timestamp_created: string;
  last_used_at: string | null;
  created_by?: { id: string; name: string } | null;
  /** False once the person who made it no longer manages the workspace: the key stops working. */
  active?: boolean;
}

function ApiKeysTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [full, setFull] = useState(true);
  const [scopes, setScopes] = useState<Array<{ resource: string; action: string }>>([{ resource: "campaigns", action: "read" }]);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => get<Page<ApiKey>>("/api/v2/api-keys", { limit: 100 }) });
  const origin = window.location.origin;

  useEffect(() => {
    if (open) {
      setName("");
      setFull(true);
      setScopes([{ resource: "campaigns", action: "read" }]);
      setCreated(null);
    }
  }, [open]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post<{ key: string; name: string }>("/api/v2/api-keys", { name: name.trim(), scopes: full ? ["all:all"] : [...new Set(scopes.map((s) => `${s.resource}:${s.action}`))] });
      setCreated(r);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k: ApiKey) => {
    if (!(await confirm({ title: `Delete the key "${k.name}"?`, description: "Anything using it stops working immediately.", confirmLabel: "Delete key", danger: true }))) return;
    await del(`/api/v2/api-keys/${k.id}`).catch((e) => toast.error(errorMessage(e)));
    qc.invalidateQueries({ queryKey: ["api-keys"] });
  };

  return (
    <div className="space-y-5 pt-5">
      <Card>
        <CardHeader
          title="API keys"
          description="Keys act for this workspace. Send them as a Bearer token."
          actions={
            <Button size="sm" variant="primary" icon={<KeyRound size={14} />} onClick={() => setOpen(true)}>
              Create key
            </Button>
          }
        />
        <pre className="scroll-thin overflow-x-auto rounded-lg bg-panel-2 p-3 text-xs">
          {`curl ${origin}/api/v2/campaigns \\\n  -H "Authorization: Bearer <your key>"`}
        </pre>
        <div className="mt-4 divide-y divide-line rounded-lg border border-line">
          {(keys.data?.items ?? []).map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <KeyRound size={15} className="text-faint" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                  {k.name}
                  {k.active === false && <Badge tone="bad">Stopped</Badge>}
                </p>
                <p className="truncate text-xs text-muted">
                  <span className="font-mono">{k.key}</span> · {k.scopes.includes("all:all") ? "full access" : k.scopes.join(", ")} · created {ago(k.timestamp_created)}
                  {k.created_by ? ` by ${k.created_by.name}` : ""} · {k.last_used_at ? `used ${ago(k.last_used_at)}` : "never used"}
                </p>
                {k.active === false && <p className="text-xs text-bad">{k.created_by?.name ?? "Whoever created it"} no longer manages this workspace, so this key stopped working. Create a new one.</p>}
              </div>
              <Button size="xs" variant="ghost" aria-label={`Delete ${k.name}`} onClick={() => revoke(k)}>
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
          {!keys.isLoading && !keys.data?.items.length && <EmptyState className="py-8" icon={<Code2 size={20} />} title="No API keys yet" />}
        </div>
      </Card>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={created ? "Copy your key" : "Create API key"}
        description={created ? "It won't be shown again. Store it somewhere safe." : undefined}
        footer={
          created ? (
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" form="api-key-form" variant="primary" loading={busy} disabled={!name.trim() || (!full && !scopes.length)}>
                Create key
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{created.key}</code>
            <CopyButton value={created.key} />
          </div>
        ) : (
          <form id="api-key-form" onSubmit={create} className="space-y-4">
            <Field label="Name">{(id) => <Input id={id} autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="CRM sync" />}</Field>
            <Field label="Access">
              {(id) => (
                <NativeSelect
                  id={id}
                  value={full ? "full" : "scoped"}
                  onChange={(v) => setFull(v === "full")}
                  options={[
                    { value: "full", label: "Full access" },
                    { value: "scoped", label: "Only what I choose" },
                  ]}
                />
              )}
            </Field>
            {!full && (
              <div className="space-y-2">
                {scopes.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <NativeSelect className="flex-1" value={s.resource} onChange={(v) => setScopes(scopes.map((x, j) => (j === i ? { ...x, resource: v } : x)))} options={API_SCOPE_RESOURCES.map((r) => ({ value: r, label: r === "all" ? "Everything" : r.replace(/[_-]/g, " ") }))} aria-label="Resource" />
                    <NativeSelect className="w-28" value={s.action} onChange={(v) => setScopes(scopes.map((x, j) => (j === i ? { ...x, action: v } : x)))} options={API_SCOPE_ACTIONS.map((a) => ({ value: a, label: a }))} aria-label="Action" />
                    <Button size="icon-sm" variant="ghost" aria-label="Remove scope" onClick={() => setScopes(scopes.filter((_, j) => j !== i))}>
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
                <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => setScopes([...scopes, { resource: "leads", action: "read" }])}>
                  Add scope
                </Button>
              </div>
            )}
          </form>
        )}
      </Dialog>
    </div>
  );
}

// ---------- Webhooks ----------

interface Hook {
  id: string;
  name: string | null;
  target_hook_url: string;
  event_type: string | null;
  custom_interest_value: number | null;
  campaign: string | null;
  headers: Record<string, string> | null;
  status: number;
  timestamp_error: string | null;
  timestamp_created: string;
}

interface HookEvent {
  id: string;
  timestamp_created: string;
  success: boolean;
  status_code: number | null;
  error_message: string | null;
  webhook_url: string;
  event_type: string;
  lead_email: string | null;
  retry_count: number;
  will_retry: boolean;
  response_time_ms: number | null;
  payload: unknown;
}

function HookDialog({ hook, open, onOpenChange }: { hook: Hook | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const statuses = useLeadStatuses();
  const types = useQuery({ queryKey: ["webhook-event-types"], queryFn: () => get<{ event_types: Array<{ id: string; label: string }> }>("/api/v2/webhooks/event-types"), enabled: open });
  const campaigns = useCampaignNames(open);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [event, setEvent] = useState("all_events");
  const [campaign, setCampaign] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [sign, setSign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(hook?.name ?? "");
    setUrl(hook?.target_hook_url ?? "");
    setEvent(hook?.custom_interest_value != null ? `label:${hook.custom_interest_value}` : (hook?.event_type ?? "all_events"));
    setCampaign(hook?.campaign ?? "");
    setHeaderText(
      Object.entries(hook?.headers ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
    );
    setSign(false);
    setSecret(null);
  }, [open, hook]);
  const custom = statuses.all.filter((s) => s.custom);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const headers: Record<string, string> = {};
    for (const line of headerText.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const label = event.startsWith("label:") ? Number(event.slice(6)) : null;
    const payload = { name: name.trim() || null, target_hook_url: url.trim(), event_type: label === null ? event : null, custom_interest_value: label, campaign: campaign || null, headers: Object.keys(headers).length ? headers : null };
    setBusy(true);
    try {
      if (hook) await patch(`/api/v2/webhooks/${hook.id}`, payload);
      else {
        const r = await post<{ signing_secret?: string }>("/api/v2/webhooks", { ...payload, signing_secret: sign });
        if (r.signing_secret) {
          setSecret(r.signing_secret);
          qc.invalidateQueries({ queryKey: ["webhooks"] });
          return;
        }
      }
      await qc.invalidateQueries({ queryKey: ["webhooks"] });
      toast.success(hook ? "Webhook updated" : "Webhook added");
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
      title={secret ? "Signing secret" : hook ? "Edit webhook" : "Add webhook"}
      description={secret ? "Each delivery carries an HMAC-SHA256 signature made with this secret. It won't be shown again." : "We POST a JSON payload to your URL for each matching event."}
      footer={
        secret ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" form="hook-form" variant="primary" loading={busy} disabled={!/^https?:\/\//.test(url.trim())}>
              {hook ? "Save" : "Add webhook"}
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{secret}</code>
          <CopyButton value={secret} />
        </div>
      ) : (
        <form id="hook-form" onSubmit={submit} className="space-y-3">
          <Field label="Name" optional>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Replies to HubSpot" />}
          </Field>
          <Field label="Endpoint URL">{(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/…" />}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Event">
              {(id) => (
                <NativeSelect
                  id={id}
                  value={event}
                  onChange={setEvent}
                  options={[
                    { group: "Events", options: (types.data?.event_types ?? [{ id: "all_events", label: "All events" }]).map((t) => ({ value: t.id, label: t.label })) },
                    ...(custom.length ? [{ group: "Custom labels", options: custom.map((s) => ({ value: `label:${s.code}`, label: s.label })) }] : []),
                  ]}
                />
              )}
            </Field>
            <Field label="Campaign">
              {(id) => <NativeSelect id={id} value={campaign} onChange={setCampaign} options={[{ value: "", label: "All campaigns" }, ...(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))]} />}
            </Field>
          </div>
          <Field label="Extra headers" optional hint="One per line, like Authorization: Bearer abc">
            {(id) => <textarea id={id} rows={2} value={headerText} onChange={(e) => setHeaderText(e.target.value)} className="w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none" />}
          </Field>
          {!hook && (
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} /> Sign deliveries with a secret
            </label>
          )}
        </form>
      )}
    </Dialog>
  );
}

function WebhooksTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Hook | null>(null);
  const [open, setOpen] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [viewing, setViewing] = useState<HookEvent | null>(null);
  const hooks = useQuery({ queryKey: ["webhooks"], queryFn: () => get<{ items: Hook[] }>("/api/v2/webhooks", { limit: 100 }) });
  const summary = useQuery({ queryKey: ["webhook-events", "summary"], queryFn: () => get<{ total_events: number; success_rate: number; failed_events: number }>("/api/v2/webhook-events/summary") });
  const events = useQuery({ queryKey: ["webhook-events", failedOnly], queryFn: () => get<{ items: HookEvent[] }>("/api/v2/webhook-events", { limit: 50, ...(failedOnly ? { success: false } : {}) }), refetchInterval: 15_000 });
  const types = useQuery({ queryKey: ["webhook-event-types"], queryFn: () => get<{ event_types: Array<{ id: string; label: string }> }>("/api/v2/webhooks/event-types") });
  const statuses = useLeadStatuses();
  const label = (h: Hook) => (h.custom_interest_value != null ? `Label: ${statuses.all.find((s) => s.code === h.custom_interest_value)?.label ?? h.custom_interest_value}` : (types.data?.event_types.find((t) => t.id === h.event_type)?.label ?? h.event_type ?? "All events"));

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      qc.invalidateQueries({ queryKey: ["webhooks"] });
      qc.invalidateQueries({ queryKey: ["webhook-events"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-5 pt-5">
      <Card>
        <CardHeader
          title="Webhooks"
          description="Failed deliveries retry with backoff; a webhook pauses after repeated failures."
          actions={
            <Button
              size="sm"
              variant="primary"
              icon={<Webhook size={14} />}
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              Add webhook
            </Button>
          }
        />
        <div className="divide-y divide-line rounded-lg border border-line">
          {(hooks.data?.items ?? []).map((h) => (
            <div key={h.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              {h.status === 1 ? <Badge tone="ok">Active</Badge> : <Badge tone="warn">Paused</Badge>}
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  setEditing(h);
                  setOpen(true);
                }}
              >
                <p className="truncate text-[13px] font-medium">{h.name || h.target_hook_url}</p>
                <p className="truncate text-xs text-muted">
                  {label(h)} · {h.target_hook_url}
                </p>
              </button>
              <Button size="xs" variant="ghost" icon={<Send size={12} />} onClick={() => act(() => post(`/api/v2/webhooks/${h.id}/test`), "Test event sent")}>
                Test
              </Button>
              {h.status !== 1 && (
                <Button size="xs" variant="ghost" icon={<Play size={12} />} onClick={() => act(() => post(`/api/v2/webhooks/${h.id}/resume`), "Webhook resumed")}>
                  Resume
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                aria-label="Delete webhook"
                onClick={async () => {
                  if (await confirm({ title: "Delete this webhook?", confirmLabel: "Delete", danger: true })) await act(() => del(`/api/v2/webhooks/${h.id}`), "Webhook deleted");
                }}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
          {!hooks.isLoading && !hooks.data?.items.length && <EmptyState className="py-8" icon={<Webhook size={20} />} title="No webhooks yet" description="Send replies, opens, clicks and status changes to another tool." />}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Recent deliveries"
          description={summary.data ? `${num(summary.data.total_events)} sent · ${summary.data.success_rate}% delivered · ${num(summary.data.failed_events)} failed` : undefined}
          actions={
            <NativeSelect
              size="sm"
              value={failedOnly ? "failed" : "all"}
              onChange={(v) => setFailedOnly(v === "failed")}
              options={[
                { value: "all", label: "All deliveries" },
                { value: "failed", label: "Failed only" },
              ]}
              aria-label="Filter deliveries"
            />
          }
        />
        <ScrollX>
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Event</th>
                <th className="py-2 pr-3 font-medium">Lead</th>
                <th className="py-2 pr-3 font-medium">Result</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(events.data?.items ?? []).map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap py-2 pr-3 text-muted">{dateTime(e.timestamp_created)}</td>
                  <td className="py-2 pr-3">{e.event_type}</td>
                  <td className="max-w-[12rem] truncate py-2 pr-3 text-muted">{e.lead_email ?? "—"}</td>
                  <td className="py-2 pr-3">
                    {e.success ? <Badge tone="ok">{e.status_code ?? "OK"}</Badge> : <Badge tone="bad">{e.status_code ?? "Failed"}</Badge>}
                    {e.will_retry && <span className="ml-1.5 text-xs text-muted">retrying</span>}
                    {e.response_time_ms != null && <span className="ml-1.5 text-xs text-faint">{e.response_time_ms} ms</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    <Button size="xs" variant="ghost" onClick={() => setViewing(e)}>
                      Details
                    </Button>
                    {!e.success && (
                      <Button size="xs" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => act(() => post(`/api/app/webhook-events/${e.id}/retry`), "Queued for retry")}>
                        Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!events.isLoading && !events.data?.items.length && <p className="py-6 text-center text-[13px] text-muted">No deliveries yet.</p>}
        </ScrollX>
      </Card>

      <HookDialog hook={editing} open={open} onOpenChange={setOpen} />
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)} size="lg" title="Delivery details" description={viewing ? `${viewing.event_type} → ${viewing.webhook_url}` : undefined}>
        {viewing && (
          <div className="space-y-3 text-[13px]">
            {viewing.error_message && <Callout tone="bad">{viewing.error_message}</Callout>}
            <p className="text-muted">
              {viewing.retry_count} {viewing.retry_count === 1 ? "retry" : "retries"} · {viewing.success ? "delivered" : viewing.will_retry ? "will retry" : "gave up"}
            </p>
            <pre className="scroll-thin max-h-96 overflow-auto rounded-lg bg-panel-2 p-3 text-xs">{JSON.stringify(viewing.payload, null, 2)}</pre>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ---------- AI ----------

interface AiSettings {
  server_key_configured: boolean;
  workspace_key_set: boolean;
  model: string | null;
  default_model: string;
  available: boolean;
}

function AiTab({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["ai-settings"], queryFn: () => get<AiSettings>("/api/app/ai/settings") });
  const usage = useQuery({ queryKey: ["ai-usage"], queryFn: () => get<Array<{ feature: string; model: string; requests: number; input: number; output: number; cache_read: number }>>("/api/app/ai/usage", { days: 30 }) });
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) setModel(settings.data.model ?? "");
  }, [settings.data]);
  const s = settings.data;
  const save = async (changes: Record<string, unknown>, ok: string) => {
    setBusy("save");
    try {
      await put("/api/app/ai/settings", changes);
      await qc.invalidateQueries({ queryKey: ["ai-settings"] });
      setKey("");
      toast.success(ok);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    try {
      const r = await post<{ model: string }>("/api/app/ai/test");
      toast.success(`Working · ${r.model}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  if (!s) return null;
  return (
    <div className="space-y-5 pt-5" id="ai">
      <Card>
        <CardHeader
          title="Claude (Anthropic)"
          description="Powers the writing assistant, reply labels, reply agent, sales agent and Copilot."
          actions={
            <Button size="sm" icon={<Bot size={14} />} loading={busy === "test"} disabled={!s.available} onClick={test}>
              Test
            </Button>
          }
        />
        <div className="mb-4 flex flex-wrap gap-2 text-[13px]">
          {s.workspace_key_set ? <Badge tone="ok">Workspace key set</Badge> : s.server_key_configured ? <Badge tone="info">Using the server's key</Badge> : <Badge tone="warn">No key — AI features are off</Badge>}
          <Badge>Model: {s.model ?? s.default_model}</Badge>
        </div>
        {admin ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Workspace API key" hint={s.server_key_configured ? "Optional. Overrides the server's key for this workspace." : "Create one at console.anthropic.com."}>
              {(id) => <Input id={id} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.workspace_key_set ? "•••••••• (saved)" : "sk-ant-…"} />}
            </Field>
            <Field label="Model" hint={`Leave empty for the default (${s.default_model}).`}>
              {(id) => <Input id={id} value={model} onChange={(e) => setModel(e.target.value)} placeholder={s.default_model} />}
            </Field>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button variant="primary" loading={busy === "save"} disabled={!key.trim() && model === (s.model ?? "")} onClick={() => save({ ...(key.trim() ? { anthropic_api_key: key.trim() } : {}), model: model.trim() || null }, "AI settings saved")}>
                Save
              </Button>
              {s.workspace_key_set && (
                <Button variant="ghost" onClick={() => save({ anthropic_api_key: null }, "Workspace key removed")}>
                  Remove workspace key
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted">Only admins can change the key or model.</p>
        )}
      </Card>
      <Card>
        <CardHeader title="Usage, last 30 days" description="Tokens per feature. Cached input is billed at a fraction of the normal rate." />
        <ScrollX>
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">Feature</th>
                <th className="py-2 pr-3 font-medium">Model</th>
                <th className="py-2 pr-3 text-right font-medium">Requests</th>
                <th className="py-2 pr-3 text-right font-medium">Input</th>
                <th className="py-2 pr-3 text-right font-medium">Cached</th>
                <th className="py-2 text-right font-medium">Output</th>
              </tr>
            </thead>
            <tbody>
              {(usage.data ?? []).map((u) => (
                <tr key={`${u.feature}:${u.model}`} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">{u.feature.replace(/_/g, " ")}</td>
                  <td className="py-2 pr-3 text-muted">{u.model}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{num(u.requests)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{num(u.input)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{num(u.cache_read)}</td>
                  <td className="py-2 text-right tabular-nums">{num(u.output)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!usage.isLoading && !usage.data?.length && <p className="py-6 text-center text-[13px] text-muted">No AI requests in the last 30 days.</p>}
        </ScrollX>
      </Card>
    </div>
  );
}

/** /app/settings/integrations */
export default function Integrations() {
  usePageTitle("Integrations & API");
  const can = useCan();
  const me = useSession();
  const { hash } = useLocation();
  const [tab, setTab] = useQueryState("tab", hash === "#ai" ? "ai" : "apps");
  const writable = can.perm("settings") && can.write;
  return (
    <div>
      <SettingsHeader title="Integrations & API" description="Connect other tools, automate with the API, and manage the AI key." />
      {!can.perm("settings") ? (
        <Callout tone="warn" className="mt-4">
          You don't have access to integrations in {me.workspace?.name ?? "this workspace"}.
        </Callout>
      ) : (
        <Tabs
          value={tab as Tab}
          onChange={setTab}
          tabs={[
            { value: "apps", label: "Apps" },
            ...(can.admin ? [{ value: "assistants" as Tab, label: "AI assistants" }, { value: "api" as Tab, label: "API keys" }] : []),
            { value: "webhooks", label: "Webhooks" },
            { value: "ai", label: "AI" },
          ]}
        >
          <TabPanel value="apps">
            <AppsTab writable={writable} />
          </TabPanel>
          {can.admin && (
            <TabPanel value="assistants">
              <AssistantsTab />
            </TabPanel>
          )}
          {can.admin && (
            <TabPanel value="api">
              <ApiKeysTab />
            </TabPanel>
          )}
          <TabPanel value="webhooks">
            <WebhooksTab />
          </TabPanel>
          <TabPanel value="ai">
            <AiTab admin={can.admin} />
          </TabPanel>
        </Tabs>
      )}
    </div>
  );
}

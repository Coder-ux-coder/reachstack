// /app/settings/installation — the whole installation, for its owner and administrators: health, people, workspaces,
// limits, who can sign up and which product areas are on. Changing things is for the owner; administrators can look,
// help people (sign out, turn off) and open workspaces.
import { useMemo, useState, type ReactNode } from "react";
import { Outlet } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Crown, Database, KeyRound, LogIn, LogOut, Power, ServerCog, Shield, ShieldOff, Trash2, Users } from "lucide-react";
import {
  INSTALLATION_MODULES,
  NEW_WORKSPACE_MODE_LABELS,
  NEW_WORKSPACE_MODES,
  SIGNUP_MODE_LABELS,
  SIGNUP_MODES,
  type InstallationSettings,
  type ModuleKey,
  type NewWorkspaceMode,
  type SignupMode,
} from "@reachstack/shared";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { ago, bytes, dateOnly, duration, num, plural } from "@/lib/format";
import { useDebounced, usePageTitle } from "@/lib/hooks";
import { ME_KEY, useSession } from "@/lib/session";
import { cn } from "@/lib/cn";
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  CopyButton,
  DataTable,
  Dialog,
  Dot,
  EmptyState,
  Field,
  Input,
  KeyValue,
  LinkTabs,
  MenuItem,
  MenuSeparator,
  NativeSelect,
  NumberInput,
  RowMenu,
  SearchInput,
  Sheet,
  StatCard,
  SwitchRow,
  Tooltip,
  useConfirm,
  type Column,
} from "@/components/ui";
import { HealthSummary } from "./installation/Health";
import { SettingsHeader } from "./parts";
import { RestartButton } from "./installation/RestartButton";

// ---------- Types ----------

interface EngineLoop {
  name: string;
  interval_ms: number;
  running: boolean;
  runs: number;
  failures: number;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_duration_ms: number | null;
  last_error: { at: string; message: string } | null;
}

interface Overview {
  you: { owner: boolean };
  owner: { id: string; email: string; name: string } | null;
  counts: { users: number; active_users_30d: number; workspaces: number; campaigns: number; leads: number; email_accounts: number; emails_sent_30d: number };
  jobs: Record<string, number>;
  failed_jobs: Array<{ id: string; type: string; error: string | null; at: string | null; workspace: string | null }>;
  storage: { data_dir: string; database_bytes: number };
  runtime: {
    version: string;
    node: string;
    platform: string;
    uptime_s: number;
    worker_in_process: boolean;
    /** False while another server or worker on the same data runs the engine (this one stands by). */
    engine_here: boolean;
    engine_holder: string | null;
    can_restart: boolean;
  };
  engine: { pid: number; started_at: string; updated_at: string; loops: EngineLoop[] } | null;
  services: Record<"system_email" | "billing" | "ai" | "google_sign_in" | "microsoft_sign_in" | "calls_and_texts" | "ip_lookup", boolean>;
  settings: InstallationSettings;
}

interface Person {
  id: string;
  email: string;
  name: string;
  created_at: string;
  last_login_at: string | null;
  email_verified: boolean;
  two_step: boolean;
  disabled: boolean;
  owner: boolean;
  admin: boolean;
  workspaces: Array<{ id: string; name: string; role: string }>;
}

interface WorkspaceRow {
  id: string;
  name: string;
  owner: { id: string; email: string | null; is_installation_owner: boolean };
  created_at: string;
  unlimited: boolean;
  plan_ids: Record<string, string | null>;
  trial_ends_at: string | null;
  members: number;
  campaigns: number;
  email_accounts: number;
  leads: number;
}

interface PlanInfo {
  id: string;
  product: string;
  name: string;
}

const OVERVIEW_KEY = ["installation", "overview"];

const JOB_NAMES: Record<string, string> = {
  "lf-dataset-import": "Lead Finder data import",
  "lf-demo-dataset": "Demo data",
  "lf-export": "Lead Finder export",
  "lead-finder-import": "Lead Finder import",
  "company-list-build": "Company list",
  "enrich-leads": "Lead enrichment",
  "import-leads": "Lead import",
  "import-accounts": "Mailbox import",
  "move-leads": "Lead move",
  "edit-leads": "Lead edit",
  "export-leads": "Lead export",
  "delete-leads": "Lead deletion",
  "rename-variable": "Variable rename",
  "delete-variable": "Variable removal",
  "update-warmup-accounts": "Warmup update",
  "verify-emails": "Email verification",
  "verify-leads": "Lead verification",
  "workspace-export": "Workspace export",
};
const PAGE = 50;

function usePaged<T>(key: unknown[], path: string, search: string) {
  return useInfiniteQuery({
    queryKey: ["installation", ...key, search],
    queryFn: ({ pageParam }) => get<{ items: T[]; total: number }>(path, { search: search || undefined, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
}

const useOverview = () => useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => get<Overview>("/api/app/admin/overview"), refetchInterval: 30_000 });

// ---------- Layout ----------

export function InstallationLayout() {
  usePageTitle("Installation");
  const me = useSession();
  if (!me.features.instance_admin)
    return <EmptyState icon={<ShieldOff size={24} />} title="Only the owner of this installation can open this page" description="Ask whoever runs this installation if you need something changed." />;
  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Installation"
        description={
          me.features.owner
            ? "You own this installation. Your workspaces are unlimited and free, and only you can change what's on this page."
            : "Everything on this installation: health, people and workspaces. Its owner decides the settings; as an administrator you can look and help people."
        }
      />
      <LinkTabs
        tabs={[
          { to: "/app/settings/installation", label: "Overview" },
          { to: "/app/settings/installation/health", label: "Health" },
          { to: "/app/settings/installation/people", label: "People" },
          { to: "/app/settings/installation/workspaces", label: "Workspaces" },
          { to: "/app/settings/installation/access", label: "Access & features" },
          { to: "/app/settings/installation/services", label: "Services", hidden: !me.features.owner },
          { to: "/app/settings/installation/backups", label: "Backups", hidden: !me.features.owner },
        ]}
      />
      <Outlet />
    </div>
  );
}

// ---------- Overview ----------

const LOOP_NAMES: Record<string, string> = {
  sender: "Sending",
  "inbox-sync": "Inbox sync",
  warmup: "Warmup",
  "warmup-scores": "Warmup scores",
  webhooks: "Webhooks",
  jobs: "Background jobs",
  "scheduled-emails": "Scheduled emails",
  "placement-runner": "Placement tests (sending)",
  "placement-checker": "Placement tests (checking)",
  "esp-detection": "Email provider detection",
  "lead-timezones": "Lead time zones",
  "inbox-manager": "Reply agent",
  "lead-finder-agent": "Lead Finder agent",
  "deliverability-scheduler": "Deliverability agent (schedule)",
  "deliverability-checks": "Deliverability agent (checks)",
  "sales-agent": "Outbound sales agent",
  "copilot-tasks": "Copilot tasks",
  "website-visitors": "Website visitors",
  "blocklist-sheets": "Blocklist sheet sync",
  automations: "Automations",
  "automation-schedules": "Automation schedules",
  backups: "Backups",
  reminders: "Reminders",
  "send-watchdog": "Send watchdog",
  "sequence-tasks": "Sequence tasks",
  "domain-dns": "Domain DNS checks",
  "recently-deleted": "Emptying Recently deleted",
};

type LoopState = { tone: "ok" | "warn" | "bad" | "neutral"; label: string };

function loopState(l: EngineLoop): LoopState {
  // The engine keeps a loop's last error after later turns work: failing means its latest turn failed.
  if (l.last_error && !l.running && l.last_started_at && new Date(l.last_error.at) >= new Date(l.last_started_at)) return { tone: "bad", label: "Failing" };
  if (l.running) return { tone: "ok", label: "Running" };
  if (!l.last_finished_at) return { tone: "neutral", label: "Starting" };
  const lateAfter = Math.max(l.interval_ms * 3, 120_000);
  if (Date.now() - new Date(l.last_finished_at).getTime() > lateAfter) return { tone: "warn", label: "Late" };
  return { tone: "ok", label: "OK" };
}

/** `env` is shown for billing only: everything else is set on the Services tab. */
const SERVICES: Array<{ key: keyof Overview["services"]; label: string; on: string; off: string; env?: string }> = [
  { key: "system_email", label: "System email", on: "Sign-up confirmations and password links are emailed.", off: "Not set up: those emails are printed in the server console and kept in the list below." },
  { key: "ai", label: "AI", on: "AI features work in every workspace.", off: "Off for the whole installation. A workspace can still add its own key in Settings → Integrations & API → AI." },
  { key: "google_sign_in", label: "Google sign-in and Gmail connect", on: "People can sign in with Google and connect Gmail accounts.", off: "Gmail accounts connect over IMAP/SMTP instead." },
  { key: "microsoft_sign_in", label: "Microsoft sign-in and Outlook connect", on: "People can sign in with Microsoft and connect Outlook accounts.", off: "Outlook accounts connect over IMAP/SMTP instead." },
  { key: "calls_and_texts", label: "Calls and texts", on: "The CRM can call and text.", off: "CRM calls and texts are off." },
  { key: "ip_lookup", label: "Website visitor lookup", on: "Visits are matched to companies for every workspace.", off: "Each workspace can add its own lookup token in Website visitors → Setup." },
  { key: "billing", label: "Billing", on: "Other people can buy plans. You are never charged.", off: "Off: nobody is charged. You set other workspaces' limits on the Workspaces tab.", env: "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET in the server's .env file" },
];

export function InstallationOverview() {
  const me = useSession();
  const q = useOverview();
  const d = q.data;
  if (q.isError) return <Callout tone="bad">{errorMessage(q.error)}</Callout>;
  const engineAge = d?.engine ? Date.now() - new Date(d.engine.updated_at).getTime() : null;
  return (
    <div className="space-y-5">
      {d && !d.you.owner && d.owner && (
        <Callout tone="info" title="You're an administrator">
          {d.owner.name || d.owner.email} owns this installation and decides its settings.
        </Callout>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="People" value={d ? num(d.counts.users) : "–"} sub={d ? `${num(d.counts.active_users_30d)} active in 30 days` : undefined} />
        <StatCard label="Workspaces" value={d ? num(d.counts.workspaces) : "–"} />
        <StatCard label="Campaigns" value={d ? num(d.counts.campaigns) : "–"} />
        <StatCard label="Leads" value={d ? num(d.counts.leads) : "–"} />
        <StatCard label="Email accounts" value={d ? num(d.counts.email_accounts) : "–"} />
        <StatCard label="Sent, 30 days" value={d ? num(d.counts.emails_sent_30d) : "–"} />
      </div>

      <HealthSummary />

      <Card>
        <CardHeader
          title="Background engine"
          description="Sending, inbox sync, warmup and the agents run here. Each line shows when it last ran."
          actions={d?.engine ? <span className="text-xs text-muted">Reported {ago(d.engine.updated_at)}</span> : undefined}
        />
        {!d ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : !d.engine ? (
          <Callout tone="warn">
            The engine hasn't reported yet. It reports about a minute after the server starts.{" "}
            {d.runtime.worker_in_process ? "" : "This server runs it as a separate worker: start it with npm run worker -w @reachstack/server."}
          </Callout>
        ) : (
          <>
            {engineAge !== null && engineAge > 120_000 && (
              <Callout tone="bad" className="mb-4">
                The engine stopped reporting {ago(d.engine.updated_at)}. Emails aren't sent and inboxes aren't checked while it's down. Restart the server
                {d.runtime.worker_in_process ? "" : " or the worker"}.
                {d.runtime.can_restart && d.runtime.worker_in_process && (
                  <div className="mt-2">
                    <RestartButton />
                  </div>
                )}
              </Callout>
            )}
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {d.engine.loops.map((l) => {
                const s = loopState(l);
                return (
                  <div key={l.name} className="flex min-w-0 items-center gap-2.5 border-b border-line/60 py-1.5 text-[13px] last:border-0">
                    <Dot tone={s.tone} />
                    <span className="min-w-0 flex-1 truncate">{LOOP_NAMES[l.name] ?? l.name}</span>
                    {l.last_error ? (
                      <Tooltip content={`${l.last_error.message} (${ago(l.last_error.at)})`}>
                        <span className="cursor-help text-xs text-bad">{plural(l.failures, "failure")}</span>
                      </Tooltip>
                    ) : null}
                    <span className="shrink-0 text-xs tabular-nums text-muted">{l.running ? "running now" : l.last_finished_at ? ago(l.last_finished_at) : "not yet"}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Services"
          description={me.features.owner ? "What this installation can reach. Set them up on the Services tab." : "What this installation can reach. Its owner sets them up."}
          actions={
            me.features.owner ? (
              <ButtonLink size="sm" to="/app/settings/installation/services">
                Set up
              </ButtonLink>
            ) : undefined
          }
        />
        <ul className="divide-y divide-line">
          {SERVICES.map((s) => {
            const on = !!d?.services[s.key];
            return (
              <li key={s.key} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-4">
                <div className="flex items-start gap-2.5 sm:w-72 sm:shrink-0">
                  <Badge tone={on ? "ok" : "neutral"} className="mt-px w-10 shrink-0 justify-center">
                    {!d ? "…" : on ? "On" : "Off"}
                  </Badge>
                  <span className="text-[13px] font-medium">{s.label}</span>
                </div>
                <div className="min-w-0 text-[13px] text-muted">
                  <p>{on ? s.on : s.off}</p>
                  {!on && s.env && <p className="mt-0.5 break-words text-xs text-faint">Settings: {s.env}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Storage and version" actions={d?.runtime.can_restart ? <RestartButton label="Restart" /> : undefined} />
          {d && (
            <KeyValue
              items={[
                [
                  "Data folder",
                  <span key="dir" className="flex min-w-0 items-center gap-1.5">
                    <code className="truncate text-xs">{d.storage.data_dir}</code>
                    <CopyButton value={d.storage.data_dir} />
                  </span>,
                ],
                ["Database", bytes(d.storage.database_bytes)],
                ["Version", d.runtime.version],
                ["Node.js", `${d.runtime.node} on ${d.runtime.platform}`],
                ["Server up for", duration(d.runtime.uptime_s)],
                [
                  "Background engine",
                  d.runtime.engine_here ? "Inside the server" : d.runtime.worker_in_process ? `Standing by: ${d.runtime.engine_holder ?? "another process"} runs it` : "Separate worker",
                ],
              ]}
            />
          )}
        </Card>
        <Card>
          <CardHeader title="Background jobs" description="Imports, exports, enrichment and other long tasks." />
          {d && (
            <KeyValue
              items={[
                ["Waiting", num(d.jobs.pending ?? 0)],
                ["Running", num(d.jobs["in-progress"] ?? 0)],
                ["Finished", num(d.jobs.success ?? 0)],
                ["Cancelled", num(d.jobs.cancelled ?? 0)],
                ["Failed", <span key="f" className={cn((d.jobs.failed ?? 0) > 0 && "text-bad")}>{num(d.jobs.failed ?? 0)}</span>],
              ]}
            />
          )}
          {!!d?.failed_jobs.length && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-xs font-medium text-muted">Latest failures</p>
              <ul className="mt-1.5 space-y-1.5">
                {d.failed_jobs.map((j) => (
                  <li key={j.id} className="text-[13px]">
                    <span className="font-medium">{JOB_NAMES[j.type] ?? j.type}</span>
                    {j.workspace && <span className="text-muted"> · {j.workspace}</span>}
                    <span className="text-faint"> · {ago(j.at)}</span>
                    {j.error && <p className="break-words text-xs text-bad">{j.error}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      {me.features.owner && d && !d.services.system_email && <MailLog />}
    </div>
  );
}

interface MailEntry {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  at: string;
}

/** Without system email, sign-up confirmations and password links only exist here and in the server console. */
function MailLog() {
  const q = useQuery({ queryKey: ["installation", "mail-log"], queryFn: () => get<{ items: MailEntry[] }>("/api/app/admin/mail-log"), refetchInterval: 30_000 });
  const items = q.data?.items ?? [];
  return (
    <Card>
      <CardHeader title="System emails" description="This installation can't send email yet, so the emails it would have sent are kept here (until the server restarts). Pass a link on to whoever needs it." />
      {!items.length ? (
        <p className="text-[13px] text-muted">None since the server started.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.slice(0, 20).map((m, i) => {
            const link = (m.text ?? "").match(/https?:\/\/\S+/)?.[0];
            return (
              <li key={`${m.at}-${i}`} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{m.subject}</p>
                  <p className="truncate text-xs text-muted">
                    To {m.to} · {ago(m.at)}
                  </p>
                </div>
                {link && <CopyButton value={link} label="Copy link" />}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------- People ----------

export function InstallationPeople() {
  const me = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const list = usePaged<Person>(["people"], "/api/app/admin/users", q);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const [link, setLink] = useState<{ email: string; url: string; emailed: boolean } | null>(null);
  const owner = !!me.features.owner;

  const refresh = () => qc.invalidateQueries({ queryKey: ["installation"] });
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<Person>[] = [
    {
      key: "person",
      header: "Person",
      cell: (p) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{p.name || p.email}</span>
            {p.id === me.user.id && <Badge>You</Badge>}
            {p.owner && (
              <Badge tone="brand">
                <Crown size={11} className="mr-0.5 inline" /> Owner
              </Badge>
            )}
            {!p.owner && p.admin && <Badge tone="info">Administrator</Badge>}
            {p.disabled && <Badge tone="bad">Turned off</Badge>}
            {!p.email_verified && <Badge tone="warn">Email not confirmed</Badge>}
          </div>
          {p.name && <p className="truncate text-xs text-muted">{p.email}</p>}
        </div>
      ),
    },
    {
      key: "workspaces",
      header: "Workspaces",
      hideBelow: "md",
      cell: (p) => <span className="text-[13px] text-muted">{p.workspaces.length ? p.workspaces.map((w) => w.name).join(", ") : "None"}</span>,
    },
    { key: "login", header: "Last sign-in", hideBelow: "sm", cell: (p) => <span className="text-[13px] text-muted">{ago(p.last_login_at)}</span> },
    { key: "joined", header: "Joined", hideBelow: "lg", cell: (p) => <span className="text-[13px] text-muted">{dateOnly(p.created_at)}</span> },
    {
      key: "actions",
      header: "",
      className: "w-10 text-right",
      cell: (p) =>
        p.owner || p.id === me.user.id || (p.admin && !owner) ? null : (
          <RowMenu label={`Actions for ${p.email}`}>
            <MenuItem
              icon={<Power size={14} />}
              onSelect={() =>
                void act(() => patch(`/api/app/admin/users/${p.id}`, { disabled: !p.disabled }), p.disabled ? `${p.email} can sign in again` : `${p.email} is turned off and signed out`)
              }
            >
              {p.disabled ? "Turn back on" : "Turn off"}
            </MenuItem>
            <MenuItem icon={<LogOut size={14} />} onSelect={() => void act(() => post(`/api/app/admin/users/${p.id}/sign-out`), `${p.email} is signed out everywhere`)}>
              Sign out everywhere
            </MenuItem>
            {owner && (
              <>
                <MenuItem
                  icon={<KeyRound size={14} />}
                  onSelect={async () => {
                    try {
                      const r = await post<{ url: string; emailed: boolean }>(`/api/app/admin/users/${p.id}/reset-link`);
                      setLink({ email: p.email, ...r });
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Create a password link
                </MenuItem>
                <MenuItem
                  icon={<Shield size={14} />}
                  onSelect={() => void act(() => patch(`/api/app/admin/users/${p.id}`, { admin: !p.admin }), p.admin ? `${p.email} is no longer an administrator` : `${p.email} is now an administrator`)}
                >
                  {p.admin ? "Remove administrator" : "Make administrator"}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 size={14} />}
                  danger
                  onSelect={async () => {
                    const ok = await confirm({
                      title: `Delete ${p.email}?`,
                      description: "Their account and the workspaces only they belong to are deleted. This can't be undone.",
                      confirmLabel: "Delete account",
                      danger: true,
                    });
                    if (ok) await act(() => del(`/api/app/admin/users/${p.id}`), `${p.email} was deleted`);
                  }}
                >
                  Delete account
                </MenuItem>
              </>
            )}
          </RowMenu>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <SearchInput value={search} onChange={setSearch} placeholder="Search by name or email" className="max-w-sm" />
      <DataTable
        rows={rows}
        rowKey={(p) => p.id}
        columns={columns}
        loading={list.isLoading}
        hasMore={list.hasNextPage}
        onLoadMore={() => list.fetchNextPage()}
        loadingMore={list.isFetchingNextPage}
        empty={<EmptyState icon={<Users size={22} />} title={q ? "No matches" : "Nobody yet"} description={q ? "Try another search." : undefined} />}
      />
      <Dialog
        open={!!link}
        onOpenChange={(v) => !v && setLink(null)}
        title="Password link"
        description={link ? `Send this to ${link.email}. It lets them choose a new password and works for 24 hours.` : undefined}
        footer={<Button onClick={() => setLink(null)}>Done</Button>}
      >
        {link && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs">{link.url}</code>
              <CopyButton value={link.url} />
            </div>
            <p className="text-xs text-muted">{link.emailed ? "We also emailed it to them." : "This installation can't send email, so it wasn't emailed."}</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ---------- Workspaces ----------

function limitsLabel(w: WorkspaceRow, plans: PlanInfo[]): { tone: "ok" | "warn" | "bad" | "neutral" | "brand"; text: string } {
  if (w.unlimited) return { tone: w.owner.is_installation_owner ? "brand" : "ok", text: "Unlimited" };
  const names = Object.values(w.plan_ids)
    .filter(Boolean)
    .map((id) => plans.find((p) => p.id === id)?.name ?? id!);
  if (names.length) return { tone: "neutral", text: names.join(", ") };
  if (w.trial_ends_at && new Date(w.trial_ends_at).getTime() > Date.now()) return { tone: "warn", text: `Trial until ${dateOnly(w.trial_ends_at)}` };
  return { tone: "bad", text: "Trial ended" };
}

export function InstallationWorkspaces() {
  const me = useSession();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const list = usePaged<WorkspaceRow>(["workspaces"], "/api/app/admin/workspaces", q);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const plans = useQuery({ queryKey: ["installation", "plans"], queryFn: () => get<PlanInfo[]>("/api/app/admin/plans"), staleTime: Infinity });
  const [editing, setEditing] = useState<WorkspaceRow | null>(null);
  const owner = !!me.features.owner;

  const enter = async (w: WorkspaceRow) => {
    try {
      await post(`/api/app/admin/workspaces/${w.id}/enter`);
      // A full load so every cached screen belongs to the workspace just opened.
      window.location.assign("/app/dashboard");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<WorkspaceRow>[] = [
    {
      key: "name",
      header: "Workspace",
      cell: (w) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{w.name}</span>
            {me.workspace?.id === w.id && <Badge>Open now</Badge>}
          </div>
          <p className="truncate text-xs text-muted">Owner: {w.owner.is_installation_owner ? "you" : (w.owner.email ?? "unknown")}</p>
        </div>
      ),
    },
    {
      key: "limits",
      header: "Limits",
      cell: (w) => {
        const l = limitsLabel(w, plans.data ?? []);
        return <Badge tone={l.tone}>{l.text}</Badge>;
      },
    },
    { key: "members", header: "Members", hideBelow: "md", cell: (w) => <span className="tabular-nums">{num(w.members)}</span> },
    { key: "campaigns", header: "Campaigns", hideBelow: "lg", cell: (w) => <span className="tabular-nums">{num(w.campaigns)}</span> },
    { key: "accounts", header: "Accounts", hideBelow: "lg", cell: (w) => <span className="tabular-nums">{num(w.email_accounts)}</span> },
    { key: "leads", header: "Leads", hideBelow: "md", cell: (w) => <span className="tabular-nums">{num(w.leads)}</span> },
    {
      key: "actions",
      header: "",
      className: "w-10 text-right",
      cell: (w) => (
        <RowMenu label={`Actions for ${w.name}`}>
          {me.workspace?.id !== w.id && (
            <MenuItem icon={<LogIn size={14} />} onSelect={() => void enter(w)}>
              Open this workspace
            </MenuItem>
          )}
          {owner && (
            <MenuItem icon={<ServerCog size={14} />} onSelect={() => setEditing(w)}>
              Limits and credits
            </MenuItem>
          )}
        </RowMenu>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <SearchInput value={search} onChange={setSearch} placeholder="Search workspaces" className="max-w-sm" />
      <DataTable
        rows={rows}
        rowKey={(w) => w.id}
        columns={columns}
        loading={list.isLoading}
        hasMore={list.hasNextPage}
        onLoadMore={() => list.fetchNextPage()}
        loadingMore={list.isFetchingNextPage}
        empty={<EmptyState icon={<Database size={22} />} title={q ? "No matches" : "No workspaces"} />}
      />
      <p className="text-xs text-muted">
        &ldquo;Open this workspace&rdquo; adds you as an administrator of it so you can help. You stay a member until someone removes you there.
      </p>
      {editing && <LimitsSheet ws={editing} plans={plans.data ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

const PRODUCT_LABELS: Record<string, string> = {
  outreach: "Outreach",
  credits: "Lead credits",
  bundle: "Bundle",
  crm: "CRM",
  website_visitors: "Website visitors",
  inbox_placement: "Inbox placement",
};

function LimitsSheet({ ws, plans, onClose }: { ws: WorkspaceRow; plans: PlanInfo[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [unlimited, setUnlimited] = useState(ws.unlimited);
  const [planIds, setPlanIds] = useState<Record<string, string | null>>(ws.plan_ids);
  const [trialEnd, setTrialEnd] = useState(ws.trial_ends_at ? ws.trial_ends_at.slice(0, 10) : "");
  const [pool, setPool] = useState<"credits" | "verification" | "visitors">("credits");
  const [amount, setAmount] = useState<number | null>(1000);
  const [busy, setBusy] = useState(false);
  const products = useMemo(() => [...new Set(plans.map((p) => p.product))], [plans]);
  const mine = ws.owner.is_installation_owner;

  const save = async () => {
    setBusy(true);
    try {
      await patch(`/api/app/admin/workspaces/${ws.id}`, {
        unlimited,
        ...(unlimited ? {} : { plan_ids: Object.fromEntries(products.map((p) => [p, planIds[p] ?? null])), trial_ends_at: trialEnd ? new Date(`${trialEnd}T23:59:59Z`).toISOString() : null }),
      });
      toast.success(`Saved limits for ${ws.name}`);
      await qc.invalidateQueries({ queryKey: ["installation"] });
      await qc.invalidateQueries({ queryKey: ME_KEY });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const grant = async () => {
    if (!amount) return;
    try {
      await post(`/api/app/admin/workspaces/${ws.id}/credits`, { pool, amount });
      toast.success(`Added ${num(amount)} ${pool === "credits" ? "credits" : pool === "verification" ? "verification credits" : "visitor credits"} to ${ws.name}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Sheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Limits: ${ws.name}`}
      description="Nobody pays for anything you set here."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={mine && !unlimited}>
            Save limits
          </Button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        {mine && <Callout tone="info">This is your workspace, so it's always unlimited.</Callout>}
        <SwitchRow label="Unlimited" description="No plans, credits, trials or monthly limits." checked={unlimited} onChange={setUnlimited} disabled={mine} />
        {!unlimited && (
          <div className="space-y-4">
            {products.map((product) => (
              <Field key={product} label={PRODUCT_LABELS[product] ?? product}>
                {(id) => (
                  <NativeSelect
                    id={id}
                    value={planIds[product] ?? ""}
                    onChange={(v) => setPlanIds({ ...planIds, [product]: v || null })}
                    options={[{ value: "", label: "No plan" }, ...plans.filter((p) => p.product === product).map((p) => ({ value: p.id, label: p.name }))]}
                  />
                )}
              </Field>
            ))}
            <Field label="Trial ends" hint="Trial limits apply until this day when the workspace has no plan.">
              {(id) => <Input id={id} type="date" value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} />}
            </Field>
          </div>
        )}
        {!unlimited && (
          <div className="rounded-xl border border-line p-4">
            <p className="text-[13px] font-medium">Add credits</p>
            <p className="mt-0.5 text-xs text-muted">Credits pay for Lead Finder reveals, enrichment and agents; verification and visitor credits are separate.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="min-w-44 flex-1">
                <NativeSelect
                  value={pool}
                  onChange={(v) => setPool(v as typeof pool)}
                  aria-label="Credit type"
                  options={[
                    { value: "credits", label: "Credits" },
                    { value: "verification", label: "Verification credits" },
                    { value: "visitors", label: "Visitor credits" },
                  ]}
                />
              </div>
              <div className="w-32">
                <NumberInput value={amount} onChange={setAmount} min={1} aria-label="Amount" />
              </div>
              <Button onClick={grant} disabled={!amount}>
                Add
              </Button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ---------- Access & features ----------

function Choice<V extends string>({ value, current, onPick, label, description, disabled }: { value: V; current: V; onPick: (v: V) => void; label: ReactNode; description: ReactNode; disabled?: boolean }) {
  const active = value === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={() => onPick(value)}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        active ? "border-brand bg-brand-soft/40" : "border-line hover:border-line-strong",
      )}
    >
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", active ? "border-brand" : "border-line-strong")}>
        {active && <span className="size-2 rounded-full bg-brand" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted">{description}</span>
      </span>
    </button>
  );
}

export function InstallationAccess() {
  const me = useSession();
  const qc = useQueryClient();
  const owner = !!me.features.owner;
  const settings = useQuery({ queryKey: ["installation", "settings"], queryFn: () => get<InstallationSettings>("/api/app/admin/settings") });
  const [transfer, setTransfer] = useState(false);
  const s = settings.data;

  const update = async (patchBody: Partial<Omit<InstallationSettings, "modules">> & { modules?: Partial<Record<ModuleKey, boolean>> }, done?: string) => {
    try {
      const next = await patch<InstallationSettings>("/api/app/admin/settings", patchBody);
      qc.setQueryData(["installation", "settings"], next);
      await qc.invalidateQueries({ queryKey: ME_KEY });
      await qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      if (done) toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (settings.isError) return <Callout tone="bad">{errorMessage(settings.error)}</Callout>;
  if (!s) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="space-y-5">
      {!owner && <Callout tone="info">Only the owner can change these settings.</Callout>}
      <Card>
        <CardHeader title="Who can create an account" description="Everyone who already has an account keeps it." />
        <div role="radiogroup" aria-label="Who can create an account" className="grid gap-2 md:grid-cols-3">
          {SIGNUP_MODES.map((m) => (
            <Choice<SignupMode>
              key={m}
              value={m}
              current={s.signup_mode}
              disabled={!owner}
              onPick={(v) => void update({ signup_mode: v }, "Saved who can sign up")}
              label={SIGNUP_MODE_LABELS[m].label}
              description={SIGNUP_MODE_LABELS[m].description}
            />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="New workspaces" description="What a workspace someone else creates starts with. Yours are always unlimited." />
        <div role="radiogroup" aria-label="New workspaces" className="grid gap-2 md:grid-cols-2">
          {NEW_WORKSPACE_MODES.map((m) => (
            <Choice<NewWorkspaceMode>
              key={m}
              value={m}
              current={s.new_workspace_mode}
              disabled={!owner}
              onPick={(v) => void update({ new_workspace_mode: v }, "Saved the default for new workspaces")}
              label={NEW_WORKSPACE_MODE_LABELS[m].label}
              description={NEW_WORKSPACE_MODE_LABELS[m].description}
            />
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">Existing workspaces keep their limits. Change them on the Workspaces tab.</p>
      </Card>

      <Card>
        <CardHeader
          title="Product areas"
          description="Switch off what you don't use. It disappears for everyone, including you. Nothing is deleted, and you can switch it back on any time."
        />
        <div className="divide-y divide-line">
          {INSTALLATION_MODULES.map((m) => (
            <SwitchRow
              key={m.key}
              label={m.label}
              description={m.description}
              checked={s.modules[m.key]}
              disabled={!owner}
              onChange={(v) => void update({ modules: { [m.key]: v } }, `${m.label} ${v ? "is on" : "is off"}`)}
            />
          ))}
        </div>
      </Card>

      {owner && (
        <Card>
          <CardHeader
            title="Owner"
            description="The owner has full access, and their workspaces are always unlimited and free. There's one owner."
            actions={
              <Button icon={<Crown size={14} />} onClick={() => setTransfer(true)}>
                Make someone else the owner
              </Button>
            }
          />
          <p className="text-[13px] text-muted">
            You can also change the owner on the machine this runs on: <code className="text-xs">npm run owner -- name@example.com</code>
          </p>
        </Card>
      )}
      {transfer && <TransferOwner onClose={() => setTransfer(false)} />}
    </div>
  );
}

function TransferOwner({ onClose }: { onClose: () => void }) {
  const me = useSession();
  const people = useQuery({ queryKey: ["installation", "people", "all"], queryFn: () => get<{ items: Person[] }>("/api/app/admin/users", { limit: 200 }) });
  const candidates = (people.data?.items ?? []).filter((p) => !p.owner && !p.disabled && p.id !== me.user.id);
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await post("/api/app/admin/owner", { user_id: userId, password });
      // A full load: your own access changes everywhere.
      window.location.assign("/app/settings/installation");
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title="Make someone else the owner"
      description="They get full access and unlimited workspaces. You become an administrator, and your workspaces keep their current limits."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!userId || (me.user.has_password && !password)} onClick={submit}>
            Change owner
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!candidates.length && !people.isLoading ? (
          <Callout tone="info">There's nobody else to choose yet. They need an account first.</Callout>
        ) : (
          <Field label="New owner">
            {(id) => <NativeSelect id={id} value={userId} onChange={setUserId} options={[{ value: "", label: "Choose a person" }, ...candidates.map((p) => ({ value: p.id, label: p.name ? `${p.name} (${p.email})` : p.email }))]} />}
          </Field>
        )}
        {me.user.has_password && (
          <Field label="Your password">
            {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
        )}
      </div>
    </Dialog>
  );
}

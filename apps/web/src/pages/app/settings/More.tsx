import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, CheckCircle2, Download, ExternalLink, Globe, History, LogIn, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { AUDIT_ACTIVITY_LABELS, PERMISSIONS, type Permission } from "@reachstack/shared";
import { del, errorMessage, get, post, type Page } from "@/lib/api";
import { dateTime, downloadBlob, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useBrand, useCan, useSession } from "@/lib/session";
import { textOn } from "@/lib/theme";
import { useUnsavedChanges } from "@/lib/unsaved";
import { Badge, Button, Callout, Card, Checkbox, CopyButton, Dialog, EmptyState, Field, Input, NativeSelect, SearchInput, Section, Segmented, SkeletonRows, SwitchRow, Textarea, useConfirm } from "@/components/ui";
import { SettingsHeader, useWorkspaceSettings, type AgencySettings } from "./parts";
import { ScrollX } from "@/components/ui/scroll-x";
import { toCsv } from "@/lib/csv";

// ---------------------------------------------------------------------------------------------------------------
// Custom warmup copy

const SAMPLE = { name: "Sam", topic: "the quarterly planning doc", day: "Thursday" };
const fill = (t: string) => t.replace(/\{(\w+)\}/g, (_m, k: string) => SAMPLE[k as keyof typeof SAMPLE] ?? "");

/** /app/settings/custom-warmup-copy */
export function WarmupCopy() {
  usePageTitle("Custom warmup copy");
  const can = useCan();
  const { settings, update } = useWorkspaceSettings();
  const saved = settings?.custom_warmup_copy;
  const [enabled, setEnabled] = useState(false);
  const [subjects, setSubjects] = useState("");
  const [bodies, setBodies] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!settings) return;
    setEnabled(!!saved?.enabled);
    setSubjects((saved?.subjects ?? []).join("\n"));
    setBodies(saved?.bodies?.length ? saved.bodies : [""]);
  }, [settings, saved]);

  const subjectList = subjects
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const bodyList = bodies.map((b) => b.trim()).filter(Boolean);
  const dirty =
    !!settings &&
    (enabled !== !!saved?.enabled || subjectList.join("\n") !== (saved?.subjects ?? []).join("\n") || bodyList.join("\u0000") !== (saved?.bodies ?? []).join("\u0000"));
  useUnsavedChanges(dirty);
  const incomplete = enabled && (!subjectList.length || !bodyList.length);
  const tooLong = subjectList.some((s) => s.length > 200);

  const save = async () => {
    setBusy(true);
    await update({ custom_warmup_copy: { enabled, subjects: subjectList.slice(0, 100), bodies: bodyList.slice(0, 100) } }, "Warmup copy saved");
    setBusy(false);
  };

  if (!settings) return <SettingsHeader title="Custom warmup copy" />;
  return (
    <div>
      <SettingsHeader
        title="Custom warmup copy"
        description="Warmup emails normally use built-in everyday messages. Write your own so warmup traffic reads like your real mail."
        actions={
          can.admin && (
            <Button variant="primary" loading={busy} disabled={!dirty || incomplete || tooLong} onClick={save}>
              Save changes
            </Button>
          )
        }
      />
      <Section title="Use your copy" description="Applies to every mailbox in this workspace while it's warming up.">
        <SwitchRow label="Send warmup emails with my copy" description="Each email picks a random subject and body from your lists." checked={enabled} onChange={setEnabled} disabled={!can.admin} />
        {incomplete && (
          <Callout tone="warn" className="mt-3">
            Add at least one subject and one body. Until then the built-in copy keeps being used.
          </Callout>
        )}
      </Section>
      <Section
        title="Subjects"
        description={
          <>
            One per line, up to 100. The warmup tag is added to the end, like <span className="font-mono text-xs">Quick question | warmup</span>.
          </>
        }
      >
        <Field hint={plural(subjectList.length, "subject")} error={tooLong ? "Keep each subject under 200 characters." : null}>
          {(id) => <Textarea id={id} aria-label="Subjects, one per line" rows={6} value={subjects} onChange={(e) => setSubjects(e.target.value)} disabled={!can.admin} placeholder={"Notes from {day}\nQuick question about {topic}\nFollowing up"} />}
        </Field>
      </Section>
      <Section title="Bodies" description="Each email gets a greeting, one of these bodies, a sign-off with the sender's first name, and the warmup tag.">
        <div className="space-y-3">
          {bodies.map((b, i) => (
            <div key={i} className="flex gap-2">
              <Textarea
                rows={4}
                value={b}
                onChange={(e) => setBodies(bodies.map((x, j) => (j === i ? e.target.value : x)))}
                disabled={!can.admin}
                maxLength={5000}
                aria-label={`Body ${i + 1}`}
                placeholder="Did you get a chance to look at {topic}? Happy to go through it on {day} if that's easier."
              />
              {can.admin && bodies.length > 1 && (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove body ${i + 1}`} onClick={() => setBodies(bodies.filter((_, j) => j !== i))}>
                  <Trash2 size={15} />
                </Button>
              )}
            </div>
          ))}
          {can.admin && bodies.length < 100 && (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setBodies([...bodies, ""])}>
              Add body
            </Button>
          )}
        </div>
      </Section>
      <Section title="Variables" description="Filled in fresh for every email.">
        <dl className="grid gap-2 text-[13px] sm:grid-cols-[7rem_1fr]">
          <dt className="font-mono text-xs leading-5">{"{name}"}</dt>
          <dd className="text-muted">The recipient's first name</dd>
          <dt className="font-mono text-xs leading-5">{"{topic}"}</dt>
          <dd className="text-muted">An everyday work topic, like "the quarterly planning doc"</dd>
          <dt className="font-mono text-xs leading-5">{"{day}"}</dt>
          <dd className="text-muted">A day, like "Thursday" or "next week"</dd>
        </dl>
        {subjectList[0] && bodyList[0] && (
          <Card className="mt-4 bg-panel-2/40">
            <p className="text-xs font-medium uppercase tracking-wide text-faint">Preview</p>
            <p className="mt-2 text-sm font-medium">{fill(subjectList[0])} | warmup</p>
            <div className="mt-2 whitespace-pre-wrap text-[13px] text-muted">{`Hi ${SAMPLE.name},\n\n${fill(bodyList[0])}\n\nThanks,\nAlex\n\nwarmup`}</div>
          </Card>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Audit logs

interface AuditRow {
  id: string;
  timestamp: string;
  activity_type: number;
  user_agent: string | null;
  user_id: string | null;
  ip_address: string | null;
  from_api: boolean;
  affected_count: number | null;
  campaign_id: string | null;
  list_id: string | null;
  audit_metadata: Record<string, unknown>;
  user_name: string | null;
}

function details(r: AuditRow): string {
  const m = r.audit_metadata ?? {};
  const parts: string[] = [];
  for (const k of ["name", "campaign_name", "email", "label", "plan_id", "reason"]) {
    const v = m[k];
    if (typeof v === "string" && v) parts.push(v);
  }
  if (r.affected_count) parts.push(`${r.affected_count.toLocaleString()} affected`);
  return parts.join(" · ");
}

/** /app/settings/audit-logs */
export function AuditLogs() {
  usePageTitle("Audit logs");
  const [type, setType] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [search, setSearch] = useState("");
  const filters = { activity_type: type || undefined, start_date: start || undefined, end_date: end || undefined, search: search.trim() || undefined };
  const q = useInfiniteQuery({
    queryKey: ["audit-logs", filters],
    queryFn: ({ pageParam }) => get<Page<AuditRow>>("/api/v2/audit-logs", { ...filters, limit: 50, starting_after: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (p) => p.next_starting_after ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const typeOptions = useMemo(
    () => [{ value: "", label: "All activity" }, ...Object.entries(AUDIT_ACTIVITY_LABELS).map(([v, label]) => ({ value: v, label })).sort((a, b) => a.label.localeCompare(b.label))],
    [],
  );
  const exportCsv = () =>
    downloadBlob(
      "audit-log.csv",
      toCsv(
        rows.map((r) => ({
          time: r.timestamp,
          activity: AUDIT_ACTIVITY_LABELS[r.activity_type] ?? r.activity_type,
          user: r.user_name ?? "",
          via_api: r.from_api ? "yes" : "no",
          details: details(r),
          ip_address: r.ip_address ?? "",
          user_agent: r.user_agent ?? "",
        })),
      ),
    );
  return (
    <div className="space-y-4">
      <SettingsHeader
        title="Audit logs"
        description="Sign-ins and changes that matter: deletions, exports, API keys, members, billing."
        actions={
          <Button icon={<Download size={15} />} disabled={!rows.length} onClick={exportCsv}>
            Download CSV
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-2">
        <NativeSelect value={type} onChange={setType} options={typeOptions} className="w-56" aria-label="Activity" />
        <Field label="From" className="w-40">
          {(id) => <Input id={id} type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} />}
        </Field>
        <Field label="To" className="w-40">
          {(id) => <Input id={id} type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />}
        </Field>
        <SearchInput value={search} onChange={setSearch} placeholder="User or IP address" className="w-56" />
      </div>
      <Card padded={false} className="overflow-hidden">
        {q.isLoading ? (
          <SkeletonRows rows={6} />
        ) : !rows.length ? (
          <EmptyState icon={<History size={22} />} title="Nothing logged" description={type || start || end || search ? "Nothing matches these filters." : "Activity shows up here as people use the workspace."} />
        ) : (
          <ScrollX>
            <table className="w-full min-w-[720px] text-[13px]">
              <thead className="border-b border-line bg-panel-2/50 text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Activity</th>
                  <th className="px-4 py-2.5 font-medium">By</th>
                  <th className="px-4 py-2.5 font-medium">Details</th>
                  <th className="px-4 py-2.5 font-medium">IP address</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{dateTime(r.timestamp)}</td>
                    <td className="px-4 py-2.5 font-medium">{AUDIT_ACTIVITY_LABELS[r.activity_type] ?? `Activity ${r.activity_type}`}</td>
                    <td className="px-4 py-2.5">
                      {r.user_name ?? "—"}
                      {r.from_api && (
                        <Badge className="ml-1.5" tone="info">
                          API
                        </Badge>
                      )}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2.5 text-muted" title={details(r)}>
                      {details(r) || "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted" title={r.user_agent ?? undefined}>
                      {r.ip_address ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
        )}
        {q.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <Button size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Workspace group

interface GroupRow {
  id: string;
  admin_workspace_id: string;
  sub_workspace_id: string;
  status: "pending" | "accepted" | "rejected";
  timestamp_created: string;
  sub_workspace_name: string | null;
  admin_workspace_name: string | null;
}

const GROUP_KEY = ["workspace-group"];
const STATUS_TONE = { pending: "warn", accepted: "ok", rejected: "bad" } as const;

function AddWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const me = useSession();
  const qc = useQueryClient();
  const mine = me.workspaces.filter((w) => w.id !== me.workspace?.id && (w.role === "owner" || w.role === "admin"));
  const [mode, setMode] = useState<"mine" | "email">(mine.length ? "mine" : "email");
  const [sub, setSub] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setMode(mine.length ? "mine" : "email");
      setSub(mine[0]?.id ?? "");
      setEmail("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const g = await post<GroupRow & { message?: string }>("/api/v2/workspace-group-members", mode === "mine" ? { sub_workspace_id: sub } : { email: email.trim() });
      // By email the answer is the same whether or not that address has a workspace here.
      toast.success(g.message ?? (g.status === "accepted" ? `${g.sub_workspace_name ?? "Workspace"} added` : "Invitation sent to the workspace owner"));
      qc.invalidateQueries({ queryKey: GROUP_KEY });
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
      title="Add a workspace"
      description="Admins of this workspace will be able to open it and work in it."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="group-form" variant="primary" loading={busy} disabled={mode === "mine" ? !sub : !email.includes("@")}>
            {mode === "mine" ? "Add workspace" : "Send invitation"}
          </Button>
        </>
      }
    >
      <form id="group-form" onSubmit={submit} className="space-y-4">
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "mine", label: "One of my workspaces" },
            { value: "email", label: "Invite by owner email" },
          ]}
        />
        {mode === "mine" ? (
          mine.length ? (
            <Field label="Workspace" hint="You're an admin there, so it's added straight away.">
              {(id) => <NativeSelect id={id} value={sub} onChange={setSub} options={mine.map((w) => ({ value: w.id, label: w.name }))} />}
            </Field>
          ) : (
            <p className="text-[13px] text-muted">You aren't an admin of any other workspace. Invite one by its owner's email instead.</p>
          )
        ) : (
          <Field label="Owner's email" hint="They get an email to accept. They can also accept from their own settings.">
            {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@client.com" />}
          </Field>
        )}
      </form>
    </Dialog>
  );
}

/** /app/settings/workspace-group */
export function WorkspaceGroup() {
  usePageTitle("Workspace group");
  const me = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const wsId = me.workspace?.id;
  const groups = useQuery({ queryKey: GROUP_KEY, queryFn: () => get<Page<GroupRow>>("/api/v2/workspace-group-members") });
  const items = groups.data?.items ?? [];
  const managed = items.filter((g) => g.admin_workspace_id === wsId);
  const managers = items.filter((g) => g.sub_workspace_id === wsId && g.status !== "rejected");

  const enter = async (g: GroupRow) => {
    try {
      await post(`/api/app/workspace-groups/${g.sub_workspace_id}/enter`);
      qc.clear();
      nav("/app/dashboard");
      toast.success(`Switched to ${g.sub_workspace_name ?? "workspace"}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async (g: GroupRow, leaving: boolean) => {
    const name = leaving ? g.admin_workspace_name : g.sub_workspace_name;
    const ok = await confirm({
      title: leaving ? `Leave ${name ?? "this group"}?` : `Remove ${name ?? "this workspace"}?`,
      description: leaving
        ? "Its admins lose their way in, and the places they took here through the group are removed. People you invited yourself stay."
        : "You can no longer open it from here, and admins who opened it from this workspace lose their place there. People its owner invited stay.",
      confirmLabel: leaving ? "Leave group" : "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/v2/workspace-group-members/${g.id}`);
      toast.success(leaving ? "Left the group" : "Workspace removed");
      qc.invalidateQueries({ queryKey: GROUP_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const respond = async (g: GroupRow, accept: boolean) => {
    try {
      await post(`/api/app/workspace-group-members/${g.id}/respond`, { accept });
      toast.success(accept ? `${g.admin_workspace_name ?? "The agency"} can now manage this workspace` : "Invitation declined");
      qc.invalidateQueries({ queryKey: GROUP_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Workspace group"
        description="Run several workspaces, such as one per client, from this one. Admins here can jump into any workspace in the group."
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>
            Add workspace
          </Button>
        }
      />
      {managers.map((g) => (
        <Callout
          key={g.id}
          tone={g.status === "pending" ? "warn" : "info"}
          title={g.status === "pending" ? `${g.admin_workspace_name ?? "Another workspace"} wants to manage this workspace` : `Managed by ${g.admin_workspace_name ?? "another workspace"}`}
          action={
            g.status === "pending" ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => respond(g, false)}>
                  Decline
                </Button>
                <Button size="sm" variant="primary" onClick={() => respond(g, true)}>
                  Accept
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="danger" onClick={() => remove(g, true)}>
                Leave group
              </Button>
            )
          }
        >
          {g.status === "pending" ? "If you accept, its admins can open this workspace and work in it." : "Its admins can open this workspace and work in it."}
        </Callout>
      ))}
      <Card padded={false}>
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">Workspaces in this group</h2>
        </div>
        {groups.isLoading ? (
          <SkeletonRows rows={3} />
        ) : !managed.length ? (
          <EmptyState
            icon={<Building2 size={22} />}
            title="No workspaces yet"
            description="Add workspaces you run for clients or teams. Each keeps its own accounts, campaigns, leads and billing."
            action={
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>
                Add workspace
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {managed.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{g.sub_workspace_name ?? g.sub_workspace_id}</p>
                  <p className="text-xs text-muted">Added {dateTime(g.timestamp_created)}</p>
                </div>
                <Badge tone={STATUS_TONE[g.status]} dot>
                  {g.status === "pending" ? "Waiting for owner" : g.status === "accepted" ? "Active" : "Declined"}
                </Badge>
                {g.status === "accepted" && (
                  <Button size="sm" icon={<LogIn size={14} />} onClick={() => enter(g)}>
                    Open
                  </Button>
                )}
                <Button size="icon-sm" variant="ghost" aria-label={`Remove ${g.sub_workspace_name ?? "workspace"}`} onClick={() => remove(g, false)}>
                  <Trash2 size={15} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <AddWorkspaceDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Agency & white label

const PERMISSION_LABELS: Record<Permission, string> = {
  dashboard: "Home dashboard",
  view_campaigns: "View campaigns",
  edit_campaigns: "Edit campaigns",
  unibox: "Unibox",
  analytics: "Analytics",
  accounts: "Email accounts",
  leads: "Leads & lists",
  crm: "CRM",
  lead_finder: "Lead Finder",
  blocklist: "Blocklist",
  settings: "Settings",
  billing: "Billing",
  team: "Team",
};
const DEFAULT_CLIENT: Permission[] = ["dashboard", "view_campaigns", "analytics", "unibox"];
const HEX = /^#[0-9a-f]{6}$/i;

interface WhiteLabelDomain {
  domain: string | null;
  verified: boolean;
  cname_target: string;
}

function PortalDomain() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const d = useQuery({ queryKey: ["whitelabel-domain"], queryFn: () => get<WhiteLabelDomain>("/api/v2/workspaces/current/whitelabel-domain") });
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post("/api/v2/workspaces/current/whitelabel-domain", { domain: domain.trim() });
      toast.success("Portal domain saved");
      setDomain("");
      qc.invalidateQueries({ queryKey: ["whitelabel-domain"] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: "Remove the portal domain?", description: "Clients can still sign in through the regular client login.", confirmLabel: "Remove", danger: true }))) return;
    try {
      await del("/api/v2/workspaces/current/whitelabel-domain");
      qc.invalidateQueries({ queryKey: ["whitelabel-domain"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (d.isLoading) return <SkeletonRows rows={2} />;
  const current = d.data?.domain;
  const target = d.data?.cname_target ?? "";
  if (!current)
    return (
      <form onSubmit={save} className="flex flex-wrap items-end gap-2">
        <Field label="Domain" className="min-w-[16rem] flex-1">
          {(id) => <Input id={id} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="portal.youragency.com" />}
        </Field>
        <Button type="submit" loading={busy} disabled={!domain.includes(".")}>
          Save domain
        </Button>
      </form>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Globe size={15} className="text-muted" />
        <span className="text-sm font-medium">{current}</span>
        {d.data?.verified ? (
          <Badge tone="ok" dot>
            Connected
          </Badge>
        ) : (
          <Badge tone="warn" dot>
            Waiting for DNS
          </Badge>
        )}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={d.isFetching} onClick={() => d.refetch()}>
            Check again
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={remove}>
            Remove
          </Button>
        </div>
      </div>
      <div className="rounded-lg border border-line text-[13px]">
        <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 p-3 sm:grid-cols-[5rem_1fr_1fr]">
          <span className="text-xs text-muted">Type</span>
          <span className="text-xs text-muted">Name</span>
          <span className="hidden text-xs text-muted sm:block">Points to</span>
          <span className="font-mono text-xs">CNAME</span>
          <span className="truncate font-mono text-xs">{current}</span>
          <span className="col-span-2 flex items-center gap-1 sm:col-span-1">
            <span className="truncate font-mono text-xs">{target}</span>
            <CopyButton value={target} />
          </span>
        </div>
      </div>
      <p className="text-xs text-muted">
        Clients sign in at <span className="font-mono">https://{current}/client/login</span>. Whoever runs this server also needs to serve HTTPS for the domain (for example with a reverse proxy certificate).
      </p>
    </div>
  );
}

/** /app/settings/agency */
export function Agency() {
  usePageTitle("Agency & white label");
  const me = useSession();
  const product = useBrand();
  const { settings, update } = useWorkspaceSettings();
  const agency: AgencySettings = settings?.agency ?? {};
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4f46e5");
  const [perms, setPerms] = useState<Permission[]>(DEFAULT_CLIENT);
  useEffect(() => {
    if (!settings) return;
    setName(agency.brand_name ?? "");
    setColor(agency.brand_color ?? "#4f46e5");
    setPerms(agency.client_permissions?.length ? agency.client_permissions : DEFAULT_CLIENT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  const members = useQuery({ queryKey: ["workspace-members"], queryFn: () => get<Page<{ id: string; role: string; accepted: boolean }>>("/api/v2/workspace-members", { limit: 100 }) });
  const clients = (members.data?.items ?? []).filter((m) => m.role === "client");
  const save = (changes: AgencySettings, message?: string) =>
    update({ agency: { enabled: !!agency.enabled, brand_name: agency.brand_name ?? null, brand_color: agency.brand_color ?? null, client_permissions: agency.client_permissions, ...changes } }, message);
  const brandDirty = name.trim() !== (agency.brand_name ?? "") || color !== (agency.brand_color ?? "#4f46e5");
  const permsDirty = perms.slice().sort().join() !== (agency.client_permissions?.length ? agency.client_permissions : DEFAULT_CLIENT).slice().sort().join();
  const shownName = name.trim() || me.workspace?.name || "Your agency";
  const shownColor = HEX.test(color) ? color : "#4f46e5";

  if (!settings) return <SettingsHeader title="Agency & white label" />;
  return (
    <div>
      <SettingsHeader title="Agency & white label" description="Give clients their own login to follow the campaigns you run for them, under your agency's name." />

      <Section title="Clients" description="Client members only see what you allow below.">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm">
            <Users size={16} className="text-muted" />
            {members.isLoading ? "…" : plural(clients.length, "client")}
            {clients.some((c) => !c.accepted) && <span className="text-xs text-muted">({clients.filter((c) => !c.accepted).length} invited)</span>}
          </span>
          <Link to="/app/crm/workspace-and-members?invite=1" className="-my-1 py-1 text-[13px] font-medium text-brand-text hover:underline">
            Invite a client
          </Link>
          <a href="/client/login" target="_blank" rel="noreferrer" className="-my-1 inline-flex items-center gap-1 py-1 text-[13px] text-muted hover:text-text">
            Client login page <ExternalLink size={12} />
          </a>
        </div>
      </Section>

      <Section title="What clients can see" description="The default for client members. You can still set access per person from Workspace & members.">
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-line p-3 sm:grid-cols-3">
          {PERMISSIONS.map((p) => (
            <Checkbox key={p} label={PERMISSION_LABELS[p]} checked={perms.includes(p)} onChange={(on) => setPerms(on ? [...perms, p] : perms.filter((x) => x !== p))} />
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="primary" disabled={!permsDirty || !perms.length} onClick={() => save({ client_permissions: perms }, "Client access saved")}>
            Save access
          </Button>
          {permsDirty && (
            <Button size="sm" variant="ghost" onClick={() => setPerms(agency.client_permissions?.length ? agency.client_permissions : DEFAULT_CLIENT)}>
              Reset
            </Button>
          )}
        </div>
      </Section>

      <Section title="White label" description="Your name, colour and logo replace ours for client members and on your portal domain.">
        <SwitchRow label="Brand the client portal as my agency" checked={!!agency.enabled} onChange={(v) => save({ enabled: v }, v ? "White label on" : "White label off")} />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Agency name" hint={`Defaults to the workspace name, "${me.workspace?.name ?? ""}".`}>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={me.workspace?.name} />}
          </Field>
          <Field label="Brand colour" error={HEX.test(color) ? null : "Use a hex colour like #4f46e5"}>
            {(id) => (
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Pick a colour" value={HEX.test(color) ? color : "#4f46e5"} onChange={(e) => setColor(e.target.value)} className="h-9 w-10 cursor-pointer rounded-md border border-line bg-panel p-1" />
                <Input id={id} value={color} onChange={(e) => setColor(e.target.value.trim())} maxLength={7} className="font-mono" />
              </div>
            )}
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted">
          The logo is the workspace logo from <Link to="/app/settings/preferences" className="text-brand-text hover:underline">Preferences</Link>.
        </p>
        <div className="mt-4 overflow-hidden rounded-lg border border-line">
          <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2.5">
            {me.workspace?.logo_url ? (
              <img src={me.workspace.logo_url} alt="" className="h-6 w-6 rounded-md object-cover" />
            ) : (
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold" style={{ background: shownColor, color: textOn(shownColor) }}>
                {shownName.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="text-sm font-semibold">{shownName}</span>
            <span className="ml-auto text-xs text-faint">Client portal preview</span>
          </div>
          <div className="flex items-center gap-2 bg-panel-2/40 px-3 py-3">
            <span className="rounded-md px-2.5 py-1 text-xs font-medium" style={{ background: shownColor, color: textOn(shownColor) }}>
              Campaigns
            </span>
            <span className="text-xs text-muted">Analytics</span>
            <span className="text-xs text-muted">Unibox</span>
          </div>
        </div>
        <div className="mt-3">
          <Button size="sm" variant="primary" disabled={!brandDirty || !HEX.test(color)} onClick={() => save({ brand_name: name.trim() || null, brand_color: color }, "Branding saved")}>
            Save branding
          </Button>
        </div>
      </Section>

      <Section title="Portal domain" description="Clients sign in on your own domain instead of ours.">
        <PortalDomain />
      </Section>

      {!!agency.enabled && (
        <Callout tone="ok" className="mt-2">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={14} /> Client members now see {shownName} instead of {product}.
          </span>
        </Callout>
      )}
    </div>
  );
}

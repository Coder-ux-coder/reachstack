import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PERMISSIONS, ROLE_DESCRIPTIONS, ROLE_LABELS, type Permission, type Role } from "@reachstack/shared";
import { Crown, LogOut, Mail, RefreshCcw, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { del, errorMessage, get, patch, post, type Page } from "@/lib/api";
import { ago } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { ME_KEY, useCan, useSession } from "@/lib/session";
import { Avatar, Badge, Button, Callout, Card, Checkbox, CopyButton, Dialog, EmptyState, Field, MenuItem, NativeSelect, RowMenu, Section, Select, SwitchRow, TagInput, useConfirm } from "@/components/ui";
import { SettingsHeader } from "./parts";
import { WorkspaceExportSection } from "./WorkspaceExport";

interface Member {
  id: string;
  email: string;
  user_id: string | null;
  nickname: string | null;
  name: { first: string; last: string };
  role: Role;
  accepted: boolean;
  permissions: Permission[] | null;
  timestamp_created: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  owner: string;
  scheduled_for_removal_at: string | null;
  security: { require_2fa?: boolean; reauth_hours?: number | null };
}

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

const ASSIGNABLE: Role[] = ["admin", "editor", "view", "client"];
const MEMBERS_KEY = ["workspace-members"];

function PermissionPicker({ value, onChange }: { value: Permission[]; onChange: (v: Permission[]) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border border-line p-3">
      {PERMISSIONS.map((p) => (
        <Checkbox key={p} label={PERMISSION_LABELS[p]} checked={value.includes(p)} onChange={(on) => onChange(on ? [...value, p] : value.filter((x) => x !== p))} />
      ))}
    </div>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<Role>("editor");
  const [custom, setCustom] = useState(false);
  const clientDefault = (useSession().workspace?.settings.agency as { client_permissions?: Permission[] } | undefined)?.client_permissions;
  const [perms, setPerms] = useState<Permission[]>(["dashboard", "view_campaigns", "analytics", "unibox"]);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<Array<{ email: string; url: string }>>([]);
  useEffect(() => {
    if (open) {
      setEmails([]);
      setRole("editor");
      setCustom(false);
      setLinks([]);
      setPerms(clientDefault?.length ? clientDefault : ["dashboard", "view_campaigns", "analytics", "unibox"]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const made: Array<{ email: string; url: string }> = [];
    try {
      for (const email of emails) {
        const r = await post<{ invite_url: string }>("/api/v2/workspace-members", { email, role, permissions: role === "client" || custom ? perms : null });
        made.push({ email, url: r.invite_url });
      }
      toast.success(made.length === 1 ? `Invitation sent to ${made[0]!.email}` : `${made.length} invitations sent`);
      setLinks(made);
    } catch (err) {
      toast.error(errorMessage(err));
      if (made.length) setLinks(made);
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: MEMBERS_KEY });
    }
  };
  const needsPerms = role === "client" || custom;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite teammates"
      description="They get an email with a link to join this workspace."
      footer={
        links.length ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" form="invite-form" variant="primary" loading={busy} disabled={!emails.length || (needsPerms && !perms.length)}>
              Send {emails.length > 1 ? `${emails.length} invitations` : "invitation"}
            </Button>
          </>
        )
      }
    >
      {links.length ? (
        <div className="space-y-2 text-[13px]">
          <p className="text-muted">If email delivery isn't set up on this server, share these links directly:</p>
          {links.map((l) => (
            <div key={l.email} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
              <span className="min-w-0 flex-1 truncate">{l.email}</span>
              <CopyButton value={l.url} label="Copy link" />
            </div>
          ))}
        </div>
      ) : (
        <form id="invite-form" onSubmit={submit} className="space-y-4">
          <Field label="Email addresses" hint="Separate several with commas.">
            {(id) => <TagInput id={id} value={emails} onChange={setEmails} placeholder="name@company.com" validate={(v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)} />}
          </Field>
          <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
            {(id) => <Select id={id} value={role} onChange={(v) => setRole(v as Role)} options={ASSIGNABLE.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />}
          </Field>
          {role !== "admin" && role !== "client" && <Checkbox label="Customise what they can see" checked={custom} onChange={setCustom} />}
          {needsPerms && <PermissionPicker value={perms} onChange={setPerms} />}
        </form>
      )}
    </Dialog>
  );
}

function PermissionsDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [perms, setPerms] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (member) setPerms(member.permissions ?? []);
  }, [member]);
  const save = async (value: Permission[] | null) => {
    if (!member) return;
    setBusy(true);
    try {
      await patch(`/api/v2/workspace-members/${member.id}`, { permissions: value });
      await qc.invalidateQueries({ queryKey: MEMBERS_KEY });
      toast.success("Access updated");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!member}
      onOpenChange={(v) => !v && onClose()}
      title="Custom access"
      description={member ? `Sections ${member.email} can open. Role defaults apply when nothing is customised.` : undefined}
      footer={
        <>
          {member?.permissions && member.role !== "client" && (
            <Button variant="ghost" className="mr-auto" onClick={() => save(null)}>
              Use role defaults
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!perms.length} onClick={() => save(perms)}>
            Save
          </Button>
        </>
      }
    >
      <PermissionPicker value={perms} onChange={setPerms} />
    </Dialog>
  );
}

function SecuritySection({ ws, owner }: { ws: WorkspaceRow; owner: boolean }) {
  const qc = useQueryClient();
  const me = useSession();
  const [hours, setHours] = useState<string>(String(ws.security.reauth_hours ?? ""));
  const save = async (changes: Record<string, unknown>) => {
    try {
      await patch("/api/app/workspaces/current/security", changes);
      await qc.invalidateQueries({ queryKey: ["workspace-current"] });
      toast.success("Security updated");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Section title="Workspace security" description="Applies to everyone who opens this workspace.">
      {!me.user.totp_enabled && owner && (
        <Callout tone="info" className="mb-2">
          Turn on two-step authentication for your own account first (Profile &amp; security).
        </Callout>
      )}
      <SwitchRow label="Require two-step authentication" description="Members without it are asked to set it up before they can continue." checked={!!ws.security.require_2fa} onChange={(v) => save({ require_2fa: v })} disabled={!owner || !me.user.totp_enabled} />
      <div className="flex flex-wrap items-end gap-2 py-3">
        <Field label="Ask for a fresh code every" hint="Members re-enter an authenticator code after this long." className="w-56">
          {(id) => (
            <NativeSelect
              id={id}
              value={hours}
              onChange={(v) => {
                setHours(v);
                void save({ reauth_hours: v ? Number(v) : null });
              }}
              disabled={!owner || !me.user.totp_enabled}
              options={[
                { value: "", label: "Never" },
                { value: "8", label: "8 hours" },
                { value: "24", label: "24 hours" },
                { value: "72", label: "3 days" },
                { value: "168", label: "7 days" },
              ]}
            />
          )}
        </Field>
      </div>
    </Section>
  );
}

function DangerSection({ ws, members }: { ws: WorkspaceRow; members: Member[] }) {
  const can = useCan();
  const qc = useQueryClient();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [newOwner, setNewOwner] = useState("");
  const candidates = members.filter((m) => m.accepted && m.role !== "owner");

  const leave = async () => {
    if (!(await confirm({ title: `Leave ${ws.name}?`, description: "You'll lose access until someone invites you again.", confirmLabel: "Leave workspace", danger: true }))) return;
    try {
      await post("/api/app/workspaces/current/leave");
      qc.clear();
      nav("/app/redirect", { replace: true });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete ${ws.name}?`, description: "Campaigns stop, and the workspace's accounts, leads and history are removed. This can't be undone.", confirmLabel: "Delete workspace", danger: true, typeToConfirm: ws.name }))) return;
    try {
      await del("/api/app/workspaces/current", { confirm_name: ws.name });
      qc.clear();
      nav("/app/redirect", { replace: true });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const transfer = async () => {
    try {
      await post("/api/v2/workspaces/current/change-owner", { email: newOwner });
      toast.success("Check your inbox to confirm the change");
      setOwnerOpen(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Section title="Leave or delete" description={can.owner ? "Hand the workspace to someone else before you leave it." : undefined}>
      <div className="flex flex-wrap gap-2">
        {can.owner ? (
          <>
            <Button icon={<Crown size={14} />} onClick={() => setOwnerOpen(true)} disabled={!candidates.length}>
              Transfer ownership
            </Button>
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={remove}>
              Delete workspace
            </Button>
          </>
        ) : (
          <Button variant="danger" icon={<LogOut size={14} />} onClick={leave}>
            Leave workspace
          </Button>
        )}
      </div>
      <Dialog
        open={ownerOpen}
        onOpenChange={setOwnerOpen}
        size="sm"
        title="Transfer ownership"
        description="You become an admin. We email you a link to confirm."
        footer={
          <>
            <Button onClick={() => setOwnerOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!newOwner} onClick={transfer}>
              Send confirmation
            </Button>
          </>
        }
      >
        <Field label="New owner">{(id) => <Select id={id} value={newOwner} onChange={setNewOwner} placeholder="Choose a member" options={candidates.map((m) => ({ value: m.email, label: m.email }))} />}</Field>
      </Dialog>
    </Section>
  );
}

/** /app/crm/workspace-and-members */
export default function Members() {
  usePageTitle("Workspace & members");
  const qc = useQueryClient();
  const me = useSession();
  const can = useCan();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const [inviteOpen, setInviteOpen] = useState(params.get("invite") === "1");
  const [editing, setEditing] = useState<Member | null>(null);
  const ws = useQuery({ queryKey: ["workspace-current"], queryFn: () => get<WorkspaceRow>("/api/v2/workspaces/current") });
  const members = useQuery({ queryKey: MEMBERS_KEY, queryFn: () => get<Page<Member>>("/api/v2/workspace-members", { limit: 100 }) });
  const all = members.data?.items ?? [];
  const accepted = all.filter((m) => m.accepted);
  const pending = all.filter((m) => !m.accepted);
  const manage = can.admin;

  const setRole = async (m: Member, role: Role) => {
    try {
      await patch(`/api/v2/workspace-members/${m.id}`, { role, ...(role === "admin" ? { permissions: null } : {}) });
      await qc.invalidateQueries({ queryKey: MEMBERS_KEY });
      toast.success(`${m.email} is now ${ROLE_LABELS[role]}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async (m: Member) => {
    const ok = await confirm({ title: m.accepted ? `Remove ${m.email}?` : `Cancel the invitation to ${m.email}?`, confirmLabel: m.accepted ? "Remove" : "Cancel invitation", danger: true });
    if (!ok) return;
    try {
      await del(`/api/v2/workspace-members/${m.id}`);
      await qc.invalidateQueries({ queryKey: MEMBERS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const resend = async (m: Member) => {
    try {
      const r = await post<{ invite_url: string }>(`/api/app/workspace-members/${m.id}/resend`);
      await navigator.clipboard?.writeText(r.invite_url).catch(() => undefined);
      toast.success("Invitation sent again. The link is on your clipboard too.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <SettingsHeader
        title="Workspace & members"
        description="Who can open this workspace and what they can do."
        actions={
          manage && (
            <Button variant="primary" icon={<UserPlus size={14} />} onClick={() => setInviteOpen(true)}>
              Invite
            </Button>
          )
        }
      />
      <Section title="Members" description={`${accepted.length} ${accepted.length === 1 ? "person has" : "people have"} access. Owners and admins see everything; editors can't manage the team or billing.`}>
        <Card padded={false} className="divide-y divide-line">
          {accepted.map((m) => {
            const self = m.user_id === me.user.id;
            const name = `${m.name.first} ${m.name.last}`.trim();
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar name={name || m.email} email={m.email} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {name || m.email} {self && <span className="text-xs font-normal text-muted">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {m.email}
                    {m.permissions && m.role !== "admin" && m.role !== "owner" ? ` · custom access (${m.permissions.length} sections)` : ""}
                  </p>
                </div>
                {m.role === "owner" || self || !manage ? (
                  <Badge tone={m.role === "owner" ? "brand" : "neutral"}>{ROLE_LABELS[m.role]}</Badge>
                ) : (
                  <NativeSelect size="sm" className="w-40" value={m.role} onChange={(v) => setRole(m, v as Role)} options={ASSIGNABLE.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} aria-label={`Role for ${m.email}`} />
                )}
                {manage && !self && m.role !== "owner" && (
                  <RowMenu label={`Actions for ${m.email}`}>
                    {m.role !== "admin" && (
                      <MenuItem icon={<ShieldCheck size={14} />} onSelect={() => setEditing(m)}>
                        Custom access
                      </MenuItem>
                    )}
                    <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => remove(m)}>
                      Remove from workspace
                    </MenuItem>
                  </RowMenu>
                )}
              </div>
            );
          })}
          {members.isLoading && <p className="px-4 py-3 text-[13px] text-muted">Loading…</p>}
        </Card>
      </Section>

      <Section title="Pending invitations" description="Invitations expire after 7 days; send them again to renew.">
        {pending.length ? (
          <Card padded={false} className="divide-y divide-line">
            {pending.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Mail size={16} className="text-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{m.email}</p>
                  <p className="text-xs text-muted">
                    {ROLE_LABELS[m.role]} · invited {ago(m.timestamp_created)}
                  </p>
                </div>
                {manage && (
                  <>
                    <Button size="xs" icon={<RefreshCcw size={12} />} onClick={() => resend(m)}>
                      Resend
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => remove(m)}>
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            ))}
          </Card>
        ) : (
          <EmptyState className="rounded-xl border border-dashed border-line py-6" title="No pending invitations" />
        )}
      </Section>

      {ws.data && <SecuritySection ws={ws.data} owner={can.owner} />}
      {can.admin && <WorkspaceExportSection />}
      {ws.data && <DangerSection ws={ws.data} members={all} />}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={(v) => {
          setInviteOpen(v);
          if (!v && params.get("invite")) {
            params.delete("invite");
            setParams(params, { replace: true });
            qc.invalidateQueries({ queryKey: ME_KEY });
          }
        }}
      />
      <PermissionsDialog member={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

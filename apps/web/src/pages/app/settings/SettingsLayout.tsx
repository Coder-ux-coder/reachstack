import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import type { ModuleKey, Permission } from "@reachstack/shared";
import { cn } from "@/lib/cn";
import { moduleOn, useCan, useSession } from "@/lib/session";
import { NativeSelect } from "@/components/ui";

interface Item {
  to: string;
  label: string;
  perm?: Permission;
  admin?: boolean;
  /** Only for whoever runs the installation (not a workspace role). */
  instance?: boolean;
  /** Hidden when the installation owner switched this product area off. */
  module?: ModuleKey;
}

const SETTINGS_NAV: Array<{ label: string; items: Item[] }> = [
  {
    label: "Account",
    items: [{ to: "/app/settings/account", label: "Profile & security" }],
  },
  {
    label: "Workspace",
    items: [
      { to: "/app/settings/preferences", label: "Preferences" },
      { to: "/app/crm/workspace-and-members", label: "Workspace & members" },
      { to: "/app/settings/workspace-group", label: "Workspace group", admin: true },
      { to: "/app/settings/lead-labels", label: "Lead labels", perm: "leads" },
      { to: "/app/settings/custom-variables", label: "Custom variables", perm: "leads" },
      { to: "/app/settings/custom-tags", label: "Custom tags" },
      { to: "/app/settings/billing", label: "Billing & usage", perm: "billing" },
      { to: "/app/settings/recently-deleted", label: "Recently deleted" },
      { to: "/app/settings/audit-logs", label: "Audit logs", admin: true },
    ],
  },
  {
    label: "CRM",
    items: [{ to: "/app/crm/calls-and-sms", label: "Calls & SMS", perm: "crm", module: "crm" }],
  },
  {
    label: "Sending",
    items: [
      { to: "/app/settings/integrations", label: "Integrations & API" },
      { to: "/app/settings/blocklist", label: "Blocklist", perm: "blocklist" },
      { to: "/app/settings/advanced-deliverability", label: "Advanced deliverability" },
      { to: "/app/settings/custom-warmup-copy", label: "Custom warmup copy" },
      { to: "/app/settings/agency", label: "Agency & white label", admin: true, module: "agency" },
    ],
  },
  {
    label: "Installation",
    items: [
      { to: "/app/settings/installation", label: "Installation", instance: true },
      { to: "/app/settings/privacy", label: "Privacy center", instance: true },
    ],
  },
];

/** Settings shell: section nav on the left (a select on phones), the page on the right. */
export default function SettingsLayout() {
  const can = useCan();
  const me = useSession();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const groups = SETTINGS_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => (!i.admin || can.admin) && (!i.perm || can.perm(i.perm)) && (!i.instance || me.features.instance_admin) && moduleOn(me, i.module)),
  })).filter((g) => g.items.length);
  const all = groups.flatMap((g) => g.items);
  const current = all.find((i) => pathname.startsWith(i.to))?.to ?? all[0]!.to;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row">
      <aside className="md:w-56 md:shrink-0">
        <div className="md:hidden">
          <NativeSelect value={current} onChange={(v) => nav(v)} options={groups.map((g) => ({ group: g.label, options: g.items.map((i) => ({ value: i.to, label: i.label })) }))} aria-label="Settings section" />
        </div>
        <nav aria-label="Settings" className="sticky top-6 hidden space-y-5 md:block">
          <div className="px-2.5">
            <p className="text-lg font-semibold tracking-tight">Settings</p>
            {me.workspace && <p className="truncate text-xs text-muted">{me.workspace.name}</p>}
          </div>
          {groups.map((g) => (
            <div key={g.label}>
              <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{g.label}</p>
              {g.items.map((i) => (
                <NavLink key={i.to} to={i.to} className={({ isActive }) => cn("block rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-panel-2", isActive ? "bg-brand-soft/60 font-medium text-brand-text hover:bg-brand-soft/60" : "text-muted")}>
                  {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

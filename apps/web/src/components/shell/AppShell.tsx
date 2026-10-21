import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronsUpDown, CircleHelp, Crown, LogOut, Menu as MenuIcon, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, PowerOff, Search, Server, Settings, Sun, X } from "lucide-react";
import { INSTALLATION_MODULES } from "@reachstack/shared";
import { cn } from "@/lib/cn";
import { ApiError, errorMessage, get, patch, post } from "@/lib/api";
import { ME_KEY, moduleOn, useBrand, useBrandInfo, useCan, useSession } from "@/lib/session";
import { applyTheme, savedTheme, type Theme } from "@/lib/theme";
import { Avatar, ButtonLink, EmptyState, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui";
import { moduleForPath, NAV, SETTINGS_ITEM, type NavItem } from "./nav";
import { CommandPalette } from "./CommandPalette";
import { NotificationBell } from "./NotificationBell";

function useCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("rs-nav-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem("rs-nav-collapsed", v ? "1" : "0");
    } catch {
      // ignore
    }
  };
  return [collapsed, set] as const;
}

export function BrandMark({ size = 28 }: { size?: number }) {
  const brand = useBrandInfo();
  if (brand.logo_url) return <img src={brand.logo_url} alt="" className="shrink-0 rounded-lg object-cover" style={{ width: size, height: size }} />;
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg bg-brand font-bold text-on-brand" style={{ width: size, height: size, fontSize: size * 0.5 }}>
      {brand.name.charAt(0).toUpperCase()}
    </span>
  );
}

function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const me = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const switchTo = async (id: string) => {
    try {
      await post(`/api/app/workspaces/${id}/switch`);
      qc.clear();
      nav("/app/dashboard");
      toast.success("Workspace switched");
    } catch (e) {
      if (e instanceof ApiError && e.code === "workspace_reauth_required") nav(`/app/security/workspace?workspace_id=${id}`);
      else toast.error(errorMessage(e));
    }
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={cn("flex w-full items-center gap-2 rounded-lg border border-line bg-panel px-2 py-1.5 text-left hover:bg-panel-2", collapsed && "justify-center px-1")}
          aria-label="Switch workspace"
        >
          <Avatar name={me.workspace?.name} src={me.workspace?.logo_url} size={24} className="rounded-md!" />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{me.workspace?.name}</span>
                <span className="block truncate text-[11px] capitalize text-faint">{me.membership?.role}</span>
              </span>
              <ChevronsUpDown size={14} className="text-faint" />
            </>
          )}
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="w-64">
        <MenuLabel>Workspaces</MenuLabel>
        {me.workspaces.map((w) => (
          <MenuItem key={w.id} onSelect={() => w.id !== me.workspace?.id && switchTo(w.id)} icon={w.id === me.workspace?.id ? <Check size={14} /> : <span />}>
            <span className="block truncate">{w.name}</span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Plus size={14} />} onSelect={() => nav("/app/organization/create")}>
          New workspace
        </MenuItem>
        <MenuItem icon={<Settings size={14} />} onSelect={() => nav("/app/settings/preferences")}>
          Workspace settings
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function useBadges(enabled: { unibox: boolean; accounts: boolean; tasks: boolean }) {
  const unibox = useQuery({
    queryKey: ["unibox", "summary"],
    queryFn: () => get<{ unread: { primary: number; others: number } }>("/api/app/unibox/summary"),
    enabled: enabled.unibox,
    refetchInterval: 60_000,
  });
  const accounts = useQuery({
    queryKey: ["accounts", "summary"],
    queryFn: () => get<{ errors: number; total: number }>("/api/app/accounts/summary"),
    enabled: enabled.accounts,
    refetchInterval: 120_000,
  });
  // Tasks the sequences are waiting on (Today); finishing one refreshes ["sequence-tasks"], this included.
  const tasks = useQuery({
    queryKey: ["sequence-tasks", "count"],
    queryFn: () => get<{ open: number }>("/api/app/sequence-tasks/count"),
    enabled: enabled.tasks,
    refetchInterval: 60_000,
  });
  return { unibox: unibox.data?.unread.primary ?? 0, accounts: accounts.data?.errors ?? 0, tasks: tasks.data?.open ?? 0 };
}

/** What a menu badge counts, for screen readers and the collapsed menu's tooltips. */
const BADGE_SAYS: Record<NonNullable<NavItem["badge"]>, (n: number) => string> = {
  unibox: (n) => `${n} unread`,
  accounts: (n) => `${n} with errors`,
  tasks: (n) => `${n} ${n === 1 ? "task" : "tasks"} waiting`,
};

function NavEntry({ item, collapsed, badge, onNavigate }: { item: NavItem; collapsed: boolean; badge?: number; onNavigate?: () => void }) {
  const loc = useLocation();
  const extra = item.match?.some((m) => loc.pathname.startsWith(m));
  const Icon = item.icon;
  const says = badge && item.badge ? BADGE_SAYS[item.badge](badge) : null;
  const link = (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
          isActive || extra ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-panel-2 hover:text-text",
          collapsed && "justify-center px-0",
        )
      }
    >
      <span className="relative flex">
        <Icon size={17} strokeWidth={1.9} />
        {collapsed && !!badge && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-bad" />}
      </span>
      {collapsed ? <span className="sr-only">{item.label}</span> : <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && !!badge && (
        <span aria-hidden className={cn("rounded-full px-1.5 text-[11px] font-semibold tabular-nums", item.badge === "accounts" ? "bg-bad-soft text-bad" : "bg-brand text-on-brand")}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {says && <span className="sr-only">, {says}</span>}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={says ? `${item.label} · ${says}` : item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function Sidebar({ collapsed, onToggle, onNavigate, mobile }: { collapsed: boolean; onToggle?: () => void; onNavigate?: () => void; mobile?: boolean }) {
  const can = useCan();
  const me = useSession();
  const brand = useBrand();
  const badges = useBadges({ unibox: can.perm("unibox"), accounts: can.perm("accounts"), tasks: can.perm("view_campaigns") });
  return (
    <aside className={cn("flex h-full flex-col border-r border-line bg-panel", collapsed ? "w-[60px]" : "w-60")}>
      <div className={cn("flex h-14 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
        <Link to="/app/dashboard" className="flex items-center gap-2" onClick={onNavigate}>
          <BrandMark />
          {!collapsed && <span className="text-[15px] font-semibold tracking-tight">{brand}</span>}
        </Link>
        {mobile && (
          <button type="button" className="ml-auto rounded-md p-1.5 text-muted hover:bg-panel-2" onClick={onNavigate} aria-label="Close menu">
            <X size={18} />
          </button>
        )}
      </div>
      <div className="px-2.5 pb-2">
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>
      <nav className="scroll-thin flex-1 space-y-4 overflow-y-auto px-2.5 py-2">
        {NAV.map((g, i) => {
          const items = g.items.filter((it) => (!it.perm || can.perm(it.perm)) && moduleOn(me, it.module));
          if (!items.length) return null;
          return (
            <div key={i} className="space-y-0.5">
              {g.label && !collapsed && <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">{g.label}</p>}
              {g.label && collapsed && <div className="mx-auto mb-1 h-px w-6 bg-line" />}
              {items.map((it) => (
                <NavEntry key={it.to} item={it} collapsed={collapsed} onNavigate={onNavigate} badge={it.badge ? badges[it.badge] : undefined} />
              ))}
            </div>
          );
        })}
      </nav>
      <div className="space-y-0.5 border-t border-line p-2.5">
        <NavEntry item={SETTINGS_ITEM} collapsed={collapsed} onNavigate={onNavigate} />
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            className={cn("flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-muted hover:bg-panel-2 hover:text-text", collapsed && "justify-center px-0")}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            {!collapsed && <span>Collapse</span>}
          </button>
        )}
      </div>
    </aside>
  );
}

function ThemeItems() {
  const [theme, setTheme] = useState<Theme>(savedTheme());
  const qc = useQueryClient();
  const set = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    patch("/api/app/auth/profile", { theme: t })
      .then(() => qc.invalidateQueries({ queryKey: ME_KEY }))
      .catch(() => undefined);
  };
  const opts: Array<[Theme, string, ReactNode]> = [
    ["light", "Light", <Sun size={14} key="l" />],
    ["dark", "Dark", <Moon size={14} key="d" />],
    ["system", "System", <Monitor size={14} key="s" />],
  ];
  return (
    <div className="flex gap-1 px-1.5 py-1">
      {opts.map(([v, label, icon]) => (
        <button
          key={v}
          type="button"
          onClick={() => set(v)}
          className={cn("flex flex-1 flex-col items-center gap-1 rounded-md py-1.5 text-[11px]", theme === v ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-panel-2")}
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  );
}

function UserMenu() {
  const me = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const name = [me.user.first_name, me.user.last_name].filter(Boolean).join(" ");
  const logout = async () => {
    try {
      await post("/api/app/auth/logout");
    } finally {
      qc.clear();
      nav("/auth/login");
    }
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="rounded-full ring-offset-2 ring-offset-bg focus-visible:ring-2" aria-label="Account menu">
          <Avatar name={name} email={me.user.email} src={me.user.avatar_url} size={30} />
        </button>
      </MenuTrigger>
      <MenuContent className="w-60">
        <div className="px-2.5 py-2">
          <p className="truncate text-sm font-medium">{name || me.user.email}</p>
          <p className="truncate text-xs text-muted">{me.user.email}</p>
        </div>
        <MenuSeparator />
        <MenuItem icon={<Settings size={14} />} onSelect={() => nav("/app/settings/account")}>
          Account settings
        </MenuItem>
        {me.features.instance_admin && (
          <MenuItem icon={me.features.owner ? <Crown size={14} /> : <Server size={14} />} onSelect={() => nav("/app/settings/installation")}>
            {me.features.owner ? "Your installation" : "Installation"}
          </MenuItem>
        )}
        <MenuSeparator />
        <ThemeItems />
        <MenuSeparator />
        <MenuItem icon={<LogOut size={14} />} onSelect={logout}>
          Log out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function HelpMenu() {
  const nav = useNavigate();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-text" aria-label="Help">
          <CircleHelp size={18} />
        </button>
      </MenuTrigger>
      <MenuContent className="w-60">
        <MenuItem onSelect={() => nav("/app/onboarding")}>Getting started checklist</MenuItem>
        <MenuItem onSelect={() => window.open("/developers", "_blank")}>API documentation</MenuItem>
        <MenuItem onSelect={() => window.dispatchEvent(new CustomEvent("rs:command"))}>
          Command menu <span className="ml-auto text-xs text-faint">Ctrl K</span>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function AppShell() {
  const [collapsed, setCollapsed] = useCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const loc = useLocation();
  const me = useSession();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    const onCmd = () => setPaletteOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("rs:command", onCmd);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("rs:command", onCmd);
    };
  }, []);
  const trialDays = me.workspace?.trial_ends_at ? Math.ceil((new Date(me.workspace.trial_ends_at).getTime() - Date.now()) / 86_400_000) : null;

  return (
    <div className="flex h-full">
      <div className="hidden md:block">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="animate-in relative h-full w-60">
            <Sidebar collapsed={false} mobile onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:px-4">
          <button type="button" className="rounded-lg p-2 text-muted hover:bg-panel-2 md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <MenuIcon size={18} />
          </button>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-full max-w-xs items-center gap-2 rounded-lg border border-line bg-bg px-2.5 text-[13px] text-faint hover:border-line-strong"
          >
            <Search size={14} />
            <span className="flex-1 text-left">Search or jump to…</span>
            <span className="hidden text-[11px] sm:inline">Ctrl K</span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            {trialDays !== null && trialDays >= 0 && (
              <Link to="/app/settings/billing" className="mr-2 hidden rounded-full bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn sm:inline">
                Trial: {trialDays} {trialDays === 1 ? "day" : "days"} left
              </Link>
            )}
            <HelpMenu />
            <NotificationBell />
            <div className="ml-1">
              <UserMenu />
            </div>
          </div>
        </header>
        <main id="main" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <ModuleGate>
            <Outlet />
          </ModuleGate>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/** Pages of a product area the installation owner switched off say so instead of loading. */
function ModuleGate({ children }: { children: ReactNode }) {
  const me = useSession();
  const { pathname } = useLocation();
  const module = moduleForPath(pathname);
  if (!module || moduleOn(me, module)) return <>{children}</>;
  const label = INSTALLATION_MODULES.find((m) => m.key === module)?.label ?? "This area";
  return (
    <EmptyState
      className="py-24"
      icon={<PowerOff size={24} />}
      title={`${label} is switched off`}
      description={me.features.owner ? "You switched it off for this installation. Switch it back on whenever you need it." : "The owner of this installation switched it off."}
      action={
        me.features.owner ? (
          <ButtonLink to="/app/settings/installation/access" variant="primary">
            Product areas
          </ButtonLink>
        ) : (
          <ButtonLink to="/app/dashboard">Go to Home</ButtonLink>
        )
      }
    />
  );
}

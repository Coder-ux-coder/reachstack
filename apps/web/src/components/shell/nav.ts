import type { ModuleKey, Permission } from "@reachstack/shared";
import {
  BarChart3,
  Bot,
  Building2,
  CalendarClock,
  Contact,
  Gauge,
  Inbox,
  LayoutDashboard,
  Mail,
  MessageSquareText,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: Permission;
  /** Extra path prefixes that should highlight this item. */
  match?: string[];
  badge?: "unibox" | "accounts" | "tasks";
  /** Hidden when the installation owner switched this product area off. */
  module?: ModuleKey;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    items: [
      { to: "/app/dashboard", label: "Home", icon: LayoutDashboard, perm: "dashboard" },
      { to: "/app/copilot", label: "Copilot", icon: Sparkles, module: "copilot" },
    ],
  },
  {
    label: "Outreach",
    items: [
      { to: "/app/today", label: "Today", icon: CalendarClock, perm: "view_campaigns", badge: "tasks" },
      { to: "/app/campaigns", label: "Campaigns", icon: Send, perm: "view_campaigns", match: ["/app/campaign/"] },
      { to: "/app/unibox", label: "Unibox", icon: Inbox, perm: "unibox", badge: "unibox" },
      { to: "/app/accounts", label: "Email accounts", icon: Mail, perm: "accounts", match: ["/app/account/"], badge: "accounts" },
      { to: "/app/analytics/overview", label: "Analytics", icon: BarChart3, perm: "analytics" },
    ],
  },
  {
    label: "Prospects",
    items: [
      { to: "/app/lead-finder", label: "Lead Finder", icon: Search, perm: "lead_finder", module: "lead_finder" },
      { to: "/app/crm", label: "CRM", icon: Contact, perm: "crm", module: "crm" },
      { to: "/app/website-visitors", label: "Website visitors", icon: Building2, perm: "crm", module: "website_visitors" },
      { to: "/app/verification/single", label: "Verification", icon: ShieldCheck, perm: "leads", match: ["/app/verification/"], module: "verification" },
    ],
  },
  {
    label: "Automate",
    items: [
      { to: "/app/ai-agents", label: "Agents", icon: Bot, perm: "edit_campaigns", match: ["/app/ai-sales-agent/"], module: "ai_agents" },
      { to: "/app/automations", label: "Automations", icon: Workflow, perm: "edit_campaigns", module: "automations" },
      { to: "/app/inbox-placement", label: "Inbox placement", icon: Gauge, perm: "accounts", module: "inbox_placement" },
      { to: "/app/templates", label: "Templates", icon: MessageSquareText, perm: "edit_campaigns", module: "templates" },
    ],
  },
];

export const SETTINGS_ITEM: NavItem = { to: "/app/settings/account", label: "Settings", icon: Settings, match: ["/app/settings/"] };

/** App paths that belong to a product area the owner can switch off (checked in order; exceptions first). */
const MODULE_PATHS: Array<[prefix: string, module: ModuleKey | null]> = [
  ["/app/crm/workspace-and-members", null],
  ["/app/crm/calls-and-sms", "crm"],
  ["/app/crm", "crm"],
  ["/app/copilot", "copilot"],
  ["/app/ai-agents", "ai_agents"],
  ["/app/ai-sales-agent", "ai_agents"],
  ["/app/automations", "automations"],
  ["/app/lead-finder", "lead_finder"],
  ["/app/verification", "verification"],
  ["/app/website-visitors", "website_visitors"],
  ["/app/inbox-placement", "inbox_placement"],
  ["/app/templates", "templates"],
  ["/app/settings/agency", "agency"],
];

export function moduleForPath(pathname: string): ModuleKey | null {
  for (const [prefix, module] of MODULE_PATHS) if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return module;
  return null;
}

export const ROLES = ["owner", "admin", "editor", "view", "client"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  view: "View / VA access",
  client: "Client",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "All permissions",
  admin: "Manage team, billing and settings, but cannot delete the workspace",
  editor: "Manage everything except team and billing",
  view: "Reply in Unibox and update email account settings",
  client: "Restricted access configured from the Agency settings",
};

/** Section permissions (used to restrict "client" members and custom roles). */
export const PERMISSIONS = [
  "dashboard",
  "view_campaigns",
  "edit_campaigns",
  "unibox",
  "analytics",
  "accounts",
  "leads",
  "crm",
  "lead_finder",
  "blocklist",
  "settings",
  "billing",
  "team",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const ROLE_DEFAULTS: Record<Role, Set<Permission>> = {
  owner: ALL,
  admin: ALL,
  editor: new Set(PERMISSIONS.filter((p) => p !== "billing" && p !== "team")),
  view: new Set<Permission>(["dashboard", "view_campaigns", "unibox", "analytics", "accounts"]),
  client: new Set<Permission>(["dashboard", "view_campaigns", "analytics", "unibox"]),
};

export function roleAllows(role: Role, permission: Permission, overrides?: Permission[] | null): boolean {
  if (role === "owner" || role === "admin") return true;
  if (overrides && overrides.length) return overrides.includes(permission);
  return ROLE_DEFAULTS[role]?.has(permission) ?? false;
}

/** Roles allowed to write (create/update/delete) most resources. */
export function canWrite(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "editor";
}

/** Resources an API key can be scoped to: exactly the ones public API routes declare. */
export const API_SCOPE_RESOURCES = [
  "all",
  "accounts",
  "account_campaign_mappings",
  "agent_items",
  "ai_agents",
  "api_keys",
  "audit_logs",
  "background-jobs",
  "block_list_entries",
  "campaigns",
  "crm_actions",
  "custom_tag_mappings",
  "custom_tags",
  "dfy_email_account_orders",
  "email_verifications",
  "emails",
  "inbox_placement_analytics",
  "inbox_placement_reports",
  "inbox_placement_tests",
  "lead-labels",
  "lead_lists",
  "leads",
  "subsequences",
  "supersearch_enrichments",
  "webhook_events",
  "webhooks",
  "workspace_billing",
  "workspace_group_members",
  "workspace_members",
  "workspaces",
  "ai_sdr",
  "ai_sdr_replies",
  "ai_inbox_manager_analytics",
] as const;

export const API_SCOPE_ACTIONS = ["all", "create", "read", "update", "delete"] as const;

/**
 * Whether the granted scopes cover a whole scope string, including the "all" wildcards:
 * scopeCovers(["campaigns:all"], "campaigns:read") is true, scopeCovers(["campaigns:read"], "all:read") is false.
 */
export function scopeCovers(granted: string[], requested: string): boolean {
  const [resource, action] = requested.split(":");
  return granted.some((s) => {
    const [res, act] = s.split(":");
    return (res === "all" || res === resource) && (act === "all" || act === action);
  });
}

/** e.g. scopeAllows(["campaigns:read"], "campaigns", "read") */
export function scopeAllows(scopes: string[], resource: string, action: "create" | "read" | "update" | "delete"): boolean {
  for (const s of scopes) {
    const [res, act] = s.split(":");
    const resOk = res === "all" || res === resource;
    const actOk = act === "all" || act === action;
    if (resOk && actOk) return true;
  }
  return false;
}

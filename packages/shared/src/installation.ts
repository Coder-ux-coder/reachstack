// Installation-wide settings shared by the server and the web app: who can sign up, what new workspaces get,
// and which product areas are switched on for everyone.

/** Who may create an account. The first account on a fresh install can always be created. */
export const SIGNUP_MODES = ["open", "invite", "closed"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export const SIGNUP_MODE_LABELS: Record<SignupMode, { label: string; description: string }> = {
  open: { label: "Anyone", description: "Anyone who can reach this installation can create an account." },
  invite: { label: "Invited people only", description: "Only people invited to a workspace (or to a client portal) can create an account." },
  closed: { label: "Nobody", description: "No new accounts. Existing accounts keep working." },
};

/** What a workspace created by someone other than the owner starts with. The owner's workspaces are always unlimited. */
export const NEW_WORKSPACE_MODES = ["unlimited", "trial"] as const;
export type NewWorkspaceMode = (typeof NEW_WORKSPACE_MODES)[number];

export const NEW_WORKSPACE_MODE_LABELS: Record<NewWorkspaceMode, { label: string; description: string }> = {
  unlimited: { label: "Unlimited", description: "No plans, credits or limits." },
  trial: { label: "14-day trial, then a plan", description: "Trial limits for 14 days. After that, a plan you assign (or one they buy, when billing is set up)." },
};

/** Product areas the owner can switch off for everyone. Campaigns, the inbox, email accounts, analytics and settings always stay on. */
export const INSTALLATION_MODULES = [
  { key: "copilot", label: "Copilot", description: "The chat assistant and its scheduled tasks." },
  { key: "ai_agents", label: "AI agents", description: "Reply, lead finder, deliverability and outbound sales agents." },
  { key: "automations", label: "Automations", description: "Workflows that run on replies, sends and other events." },
  { key: "lead_finder", label: "Lead Finder", description: "Searching the people and company dataset." },
  { key: "verification", label: "Email verification", description: "Single, bulk and list verification." },
  { key: "crm", label: "CRM", description: "Deals, tasks, calls, texts and CRM reports." },
  { key: "website_visitors", label: "Website visitors", description: "Identifying companies that visit your website." },
  { key: "inbox_placement", label: "Inbox placement", description: "Seed tests that show where your emails land." },
  { key: "templates", label: "Templates", description: "Saved sequence templates." },
  { key: "agency", label: "Agency and client portal", description: "Client workspaces, the client portal and white label." },
  { key: "dfy", label: "Done-for-you domains and mailboxes", description: "Ordering domains and mailboxes in the app." },
] as const;
export type ModuleKey = (typeof INSTALLATION_MODULES)[number]["key"];
export type ModuleSwitches = Record<ModuleKey, boolean>;

export const ALL_MODULES_ON: ModuleSwitches = Object.fromEntries(INSTALLATION_MODULES.map((m) => [m.key, true])) as ModuleSwitches;

/** How often the server backs itself up (Settings → Installation → Backups). */
export const BACKUP_FREQUENCIES = ["off", "daily", "weekly"] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

export const BACKUP_FREQUENCY_LABELS: Record<BackupFrequency, string> = { off: "Off", daily: "Every day", weekly: "Every week" };

export interface BackupSchedule {
  frequency: BackupFrequency;
  /** Hour of the day (0–23) in the server's time zone. */
  hour: number;
  /** Day of the week for weekly backups: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** How many automatic backups to keep; older ones are deleted after each new one. Backups made by hand stay until deleted. */
  keep: number;
}

export const BACKUP_KEEP_MAX = 100;
export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = { frequency: "off", hour: 3, weekday: 7, keep: 7 };

export interface InstallationSettings {
  signup_mode: SignupMode;
  new_workspace_mode: NewWorkspaceMode;
  modules: ModuleSwitches;
  backups: BackupSchedule;
}

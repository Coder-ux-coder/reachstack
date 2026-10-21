// Installation-wide settings the owner controls from Settings → Installation (stored in app_settings).
import {
  ALL_MODULES_ON,
  BACKUP_FREQUENCIES,
  BACKUP_KEEP_MAX,
  DEFAULT_BACKUP_SCHEDULE,
  INSTALLATION_MODULES,
  NEW_WORKSPACE_MODES,
  SIGNUP_MODES,
  type BackupFrequency,
  type BackupSchedule,
  type InstallationSettings,
  type ModuleKey,
  type NewWorkspaceMode,
  type SignupMode,
} from "@reachstack/shared";
import { isNull } from "drizzle-orm";
import { db, schema } from "../db/client";
import { config } from "../env";
import { HttpError } from "../http/errors";
import { getAppSetting, setAppSetting } from "./instance";

const KEY = "installation";
const CACHE_MS = 5_000;
let cache: { value: InstallationSettings; at: number } | null = null;

function defaults(): InstallationSettings {
  return {
    // A server someone puts online doesn't take accounts from strangers: its owner invites people, or opens sign-up.
    // The first account on a fresh install can always be made.
    signup_mode: "invite",
    // Without billing there's nothing to buy after a trial, so other people's workspaces start unlimited, as before.
    new_workspace_mode: config.stripe.secretKey ? "trial" : "unlimited",
    modules: { ...ALL_MODULES_ON },
    backups: { ...DEFAULT_BACKUP_SCHEDULE },
  };
}

const wholeIn = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback);

function normalizeBackups(raw: Partial<BackupSchedule> | null | undefined): BackupSchedule {
  const d = DEFAULT_BACKUP_SCHEDULE;
  return {
    frequency: BACKUP_FREQUENCIES.includes(raw?.frequency as BackupFrequency) ? (raw!.frequency as BackupFrequency) : d.frequency,
    hour: wholeIn(raw?.hour, 0, 23, d.hour),
    weekday: wholeIn(raw?.weekday, 1, 7, d.weekday),
    keep: wholeIn(raw?.keep, 1, BACKUP_KEEP_MAX, d.keep),
  };
}

function normalize(raw: Partial<InstallationSettings> | null | undefined): InstallationSettings {
  const d = defaults();
  const modules = { ...d.modules };
  for (const m of INSTALLATION_MODULES) {
    const v = raw?.modules?.[m.key];
    if (typeof v === "boolean") modules[m.key] = v;
  }
  return {
    signup_mode: SIGNUP_MODES.includes(raw?.signup_mode as SignupMode) ? (raw!.signup_mode as SignupMode) : d.signup_mode,
    new_workspace_mode: NEW_WORKSPACE_MODES.includes(raw?.new_workspace_mode as NewWorkspaceMode) ? (raw!.new_workspace_mode as NewWorkspaceMode) : d.new_workspace_mode,
    modules,
    backups: normalizeBackups(raw?.backups),
  };
}

export async function getInstallationSettings(): Promise<InstallationSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = normalize(await getAppSetting<Partial<InstallationSettings> | null>(KEY, null));
  cache = { value, at: Date.now() };
  return value;
}

export async function updateInstallationSettings(
  patch: Partial<Omit<InstallationSettings, "modules" | "backups">> & { modules?: Partial<Record<ModuleKey, boolean>>; backups?: Partial<BackupSchedule> },
) {
  const cur = await getInstallationSettings();
  const next = normalize({ ...cur, ...patch, modules: { ...cur.modules, ...(patch.modules ?? {}) }, backups: { ...cur.backups, ...(patch.backups ?? {}) } });
  await setAppSetting(KEY, next);
  cache = { value: next, at: Date.now() };
  return next;
}

export async function moduleEnabled(key: ModuleKey): Promise<boolean> {
  return (await getInstallationSettings()).modules[key];
}

/** Whether anyone has an account yet. A fresh install has none, and its first account becomes the owner. */
export async function hasAccounts(): Promise<boolean> {
  const [anyone] = await db.select({ id: schema.users.id }).from(schema.users).where(isNull(schema.users.deletedAt)).limit(1);
  return !!anyone;
}

/**
 * Throws unless a new account may be created now. `invited`: the person holds a valid workspace invitation.
 * The first account on a fresh install is always allowed, so a closed setting can't lock the owner out.
 */
export async function assertSignupAllowed(invited: boolean) {
  const mode = (await getInstallationSettings()).signup_mode;
  if (mode === "open" || !(await hasAccounts())) return;
  if (mode === "invite" && invited) return;
  throw new HttpError(
    403,
    mode === "invite" ? "Accounts here are by invitation only. Ask a workspace admin to invite you." : "New accounts are turned off on this installation.",
    "signup_closed",
  );
}

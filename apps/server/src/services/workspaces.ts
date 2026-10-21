import { and, eq, isNull } from "drizzle-orm";
import { IANAZone } from "luxon";
import { DEFAULT_WORKSPACE_TIMEZONE, type Role } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { Member, User, Workspace } from "../http/context";
import { iso } from "../lib/time";
import { getInstallationSettings } from "./installation";
import { isOwner } from "./instance";

export const DEFAULT_WORKSPACE_SETTINGS = {
  default_timezone: DEFAULT_WORKSPACE_TIMEZONE,
  unibox_show_auto_replies: false,
  unibox_focused_inbox: true,
  limit_emails_per_company: { enabled: false, daily_limit: 3 },
  auto_label_with_ai: false,
  esp_matching_default: false,
  bounce_protect_threshold: 5,
  warmup_pool: "installation" as const,
};

/** A time zone named the way browsers name them ("Europe/London"), or nothing when it isn't one. */
export function ianaZone(zone: string | null | undefined): string | undefined {
  return zone && zone.length <= 64 && IANAZone.isValidZone(zone) ? zone : undefined;
}

/**
 * A new workspace, on its owner's clock: the time zone in their profile, else their browser's (`timezone`), else the
 * default. Its sending schedules, daily limits and "today" follow it, so a far-off default would shift them all.
 */
export async function createWorkspace(owner: User, name: string, opts: { timezone?: string | null } = {}): Promise<Workspace> {
  // The installation owner's workspaces are never metered; everyone else's start the way the owner chose.
  const selfHosted = (await isOwner(owner)) || (await getInstallationSettings()).new_workspace_mode === "unlimited";
  const zone = ianaZone(owner.timezone) ?? ianaZone(opts.timezone) ?? DEFAULT_WORKSPACE_TIMEZONE;
  const [ws] = await db
    .insert(schema.workspaces)
    .values({
      name: name.trim() || "My Workspace",
      ownerId: owner.id,
      selfHosted,
      trialEndsAt: selfHosted ? null : new Date(Date.now() + 14 * 86_400_000),
      planIds: {},
      settings: { ...DEFAULT_WORKSPACE_SETTINGS, default_timezone: zone },
      security: { require_2fa: false, reauth_hours: null },
    })
    .returning();
  await db.insert(schema.workspaceMembers).values({
    workspaceId: ws!.id,
    userId: owner.id,
    email: owner.email,
    role: "owner",
    accepted: true,
    issuerId: owner.id,
  });
  return ws!;
}

export async function listUserWorkspaces(userId: string) {
  const rows = await db
    .select({ ws: schema.workspaces, role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(and(eq(schema.workspaceMembers.userId, userId), eq(schema.workspaceMembers.accepted, true), isNull(schema.workspaces.deletedAt)))
    .orderBy(schema.workspaces.createdAt);
  return rows.map((r) => ({ id: r.ws.id, name: r.ws.name, role: r.role as Role, logo_url: r.ws.logoUrl }));
}

export function serializeUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    first_name: u.firstName,
    last_name: u.lastName,
    avatar_url: u.avatarUrl,
    phone: u.phone,
    timezone: u.timezone,
    language: u.language,
    theme: u.theme,
    totp_enabled: u.totpEnabled,
    has_password: !!u.passwordHash,
    email_verified: !!u.emailVerifiedAt,
    onboarding_completed: u.onboardingCompleted,
    onboarding: u.onboarding ?? {},
    preferences: u.preferences ?? {},
    is_superadmin: u.isSuperadmin,
    timestamp_created: iso(u.createdAt),
  };
}

export function serializeWorkspace(w: Workspace) {
  const plans = w.planIds ?? {};
  return {
    id: w.id,
    timestamp_created: iso(w.createdAt),
    timestamp_updated: iso(w.updatedAt),
    scheduled_for_removal_at: iso(w.scheduledForRemovalAt),
    owner: w.ownerId,
    name: w.name,
    plan_id: plans.outreach ?? (w.selfHosted ? "self_hosted" : null),
    plan_id_bundle: plans.bundle ?? null,
    plan_id_leadfinder: plans.credits ?? null,
    plan_id_crm: plans.crm ?? null,
    plan_id_website_visitor: plans.website_visitors ?? null,
    plan_id_inbox_placement: plans.inbox_placement ?? null,
    add_unsub_to_block: w.addUnsubToBlock,
    default_opportunity_value: w.defaultOpportunityValue,
    org_logo_url: w.logoUrl,
    org_client_domain: w.clientDomain,
    self_hosted: w.selfHosted,
    trial_ends_at: iso(w.trialEndsAt),
    settings: publicSettings(w),
    security: w.security ?? {},
  };
}

/** Workspace settings without secrets: every member reads these (they come with the session). */
export function publicSettings(w: Workspace) {
  const s = { ...(w.settings ?? {}) } as Record<string, unknown>;
  if (s.anthropic_api_key_enc) {
    s.anthropic_api_key_set = true;
    delete s.anthropic_api_key_enc;
  }
  // The CRM's Stripe link keeps its key (encrypted) here; members only need to know it's connected.
  if (s.crm_stripe && typeof s.crm_stripe === "object") {
    const { secret: _secret, ...link } = s.crm_stripe as Record<string, unknown>;
    s.crm_stripe = link;
  }
  return s;
}

export function serializeMember(m: Member, user?: User | null) {
  return {
    id: m.id,
    email: m.email,
    user_id: m.userId,
    user_email: user?.email ?? m.email,
    nickname: m.nickname,
    name: { first: user?.firstName ?? "", last: user?.lastName ?? "" },
    role: m.role,
    timestamp_created: iso(m.createdAt),
    workspace_id: m.workspaceId,
    accepted: m.accepted,
    issuer_id: m.issuerId,
    permissions: m.permissions ?? null,
  };
}

export async function getWorkspaceSetting<T>(workspaceId: string, key: string, fallback: T): Promise<T> {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const v = (ws?.settings as Record<string, unknown> | null)?.[key];
  return (v === undefined ? fallback : (v as T)) ?? fallback;
}

export async function patchWorkspaceSettings(workspaceId: string, patch: Record<string, unknown>) {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  if (!ws) return null;
  const settings = { ...(ws.settings ?? {}), ...patch };
  const [updated] = await db.update(schema.workspaces).set({ settings }).where(eq(schema.workspaces.id, workspaceId)).returning();
  return updated ?? null;
}

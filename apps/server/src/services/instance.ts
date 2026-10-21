// The installation's owner and administrators, plus installation-wide settings.
//
// The owner is one person: the first account on a fresh install, or whoever `npm run owner` or the current owner
// names. The owner is an installation administrator, and every workspace they own is unmetered (no plans, credits,
// trials or limits). Superadmins are administrators too, but only the owner gets the unmetered workspaces.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/client";
import { forbidden } from "../http/errors";
import type { User } from "../http/context";

const OWNER_KEY = "owner_user_id";
const OWNER_CACHE_MS = 30_000;
let ownerCache: { id: string | null; at: number } | null = null;

export async function getAppSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? fallback;
}

export async function setAppSetting(key: string, value: unknown) {
  await db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } });
}

async function activeUser(id: string) {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
    .limit(1);
  return u ?? null;
}

/**
 * The owner's user id, or null on a fresh install with no accounts. When none is stored yet (installs from before
 * owners existed, or the first sign-up), the earliest account that still exists becomes the owner and is stored, so
 * later sign-ups never change it.
 */
export async function getOwnerId(): Promise<string | null> {
  if (ownerCache && Date.now() - ownerCache.at < OWNER_CACHE_MS) return ownerCache.id;
  let id = await getAppSetting<string | null>(OWNER_KEY, null);
  if (id && !(await activeUser(id))) id = null;
  if (!id) {
    const [first] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(isNull(schema.users.deletedAt))
      .orderBy(asc(schema.users.createdAt))
      .limit(1);
    id = first?.id ?? null;
    if (id) await setOwnerRecord(id);
  }
  // Not cached while there's no owner, so the first sign-up is recognized at once.
  ownerCache = id ? { id, at: Date.now() } : null;
  return id;
}

async function setOwnerRecord(userId: string) {
  await setAppSetting(OWNER_KEY, userId);
  ownerCache = { id: userId, at: Date.now() };
  await unmeterOwnedWorkspaces(userId);
}

/** Makes `userId` the installation owner. Their workspaces become unmetered; the previous owner's stay as they are. */
export async function setOwner(userId: string) {
  if (!(await activeUser(userId))) throw new Error("That account doesn't exist");
  await setOwnerRecord(userId);
}

export async function isOwner(user: Pick<User, "id">): Promise<boolean> {
  return (await getOwnerId()) === user.id;
}

/** Workspaces owned by the installation owner have no plans, credits, trials or limits. */
export async function unmeterOwnedWorkspaces(userId: string) {
  await db.update(schema.workspaces).set({ selfHosted: true, trialEndsAt: null }).where(eq(schema.workspaces.ownerId, userId));
}

export async function isInstanceAdmin(user: Pick<User, "id" | "isSuperadmin">): Promise<boolean> {
  return user.isSuperadmin || (await isOwner(user));
}

export async function requireInstanceAdmin(user: User) {
  if (!(await isInstanceAdmin(user))) throw forbidden("Only the administrator of this installation can do this");
}

export async function requireOwner(user: User) {
  if (!(await isOwner(user))) throw forbidden("Only the owner of this installation can do this");
}

/** Email addresses of the installation's administrators: the owner and any superadmins. */
export async function instanceAdminEmails(): Promise<string[]> {
  const ownerId = await getOwnerId();
  const rows = await db
    .select({ email: schema.users.email, id: schema.users.id, superadmin: schema.users.isSuperadmin })
    .from(schema.users)
    .where(and(isNull(schema.users.deletedAt), isNull(schema.users.disabledAt)));
  return [...new Set(rows.filter((u) => u.superadmin || u.id === ownerId).map((u) => u.email))];
}

/** Clears the cached owner (tests, and after the owner is changed from another process). */
export function forgetOwnerCache() {
  ownerCache = null;
}

/** Which of `userIds` are installation administrators (for lists). */
export async function adminFlags(userIds: string[]): Promise<Map<string, { owner: boolean; admin: boolean }>> {
  const ownerId = await getOwnerId();
  const out = new Map<string, { owner: boolean; admin: boolean }>();
  if (!userIds.length) return out;
  const rows = await db.select({ id: schema.users.id, superadmin: schema.users.isSuperadmin }).from(schema.users).where(inArray(schema.users.id, userIds));
  for (const r of rows) out.set(r.id, { owner: r.id === ownerId, admin: r.superadmin || r.id === ownerId });
  return out;
}

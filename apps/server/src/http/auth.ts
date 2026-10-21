import type { FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { canWrite, roleAllows, scopeAllows, type Permission, type Role } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { randomToken, sha256 } from "../lib/ids";
import type { AuthContext, RouteAuthConfig, Session, User, Workspace, WorkspaceGate } from "./context";
import { effectivePermissions } from "../services/branding";
import { workspaceInUse } from "../services/live-workspaces";
import { forbidden, HttpError, unauthorized } from "./errors";
import { clientIp } from "./util";

export const SESSION_COOKIE = "rs_sid";
const SESSION_TTL_MS = 30 * 86_400_000;

const M = schema.workspaceMembers;
const U = schema.users;
const W = schema.workspaces;

const emptyAuth = (): AuthContext => ({
  via: "none",
  user: null,
  session: null,
  apiKey: null,
  workspace: null,
  member: null,
  role: null,
  scopes: null,
  gate: null,
});

/** Key in sessions.workspaceReauth for a code entered at sign-in (or when turning two-step on): it counts everywhere. */
export const ANY_WORKSPACE = "*";

export const GATE_MESSAGES: Record<WorkspaceGate, string> = {
  totp_required: "This workspace requires two-step authentication. Turn it on in your profile to continue.",
  workspace_reauth_required: "Enter a code from your authenticator app to keep working in this workspace.",
};

/**
 * What a workspace's security settings still ask of a session: two-step authentication on the account, and with
 * `reauth_hours`, a code from the authenticator within that many hours (the code entered at sign-in counts).
 */
export function workspaceGate(ws: Workspace, user: User, session: Session | null): WorkspaceGate | null {
  const sec = ws.security ?? {};
  if (sec.require_2fa && !user.totpEnabled) return "totp_required";
  if (sec.reauth_hours && user.totpEnabled) {
    const seen = session?.workspaceReauth ?? {};
    const last = Math.max(seen[ws.id] ?? 0, seen[ANY_WORKSPACE] ?? 0);
    if (Date.now() - last > sec.reauth_hours * 3_600_000) return "workspace_reauth_required";
  }
  return null;
}

export async function createSession(
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
  opts: { workspaceId?: string | null; mfaPending?: boolean; clientPortal?: boolean } = {},
) {
  const token = randomToken(32);
  const now = Date.now();
  const [session] = await db
    .insert(schema.sessions)
    .values({
      userId,
      tokenHash: sha256(token),
      currentWorkspaceId: opts.workspaceId ?? null,
      ip: clientIp(req),
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 400),
      mfaPending: opts.mfaPending ?? false,
      isClientPortal: opts.clientPortal ?? false,
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + SESSION_TTL_MS),
    })
    .returning();
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https://"),
    maxAge: SESSION_TTL_MS / 1000,
  });
  return session!;
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

async function loadWorkspaceForUser(userId: string, workspaceId: string | null) {
  if (!workspaceId) return { workspace: null, member: null };
  const [row] = await db
    .select({ ws: schema.workspaces, member: schema.workspaceMembers })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId),
        eq(schema.workspaceMembers.accepted, true),
        isNull(schema.workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return { workspace: null, member: null };
  return { workspace: row.ws, member: row.member };
}

/**
 * The workspace a session opens in when none is chosen: the first one the person belongs to, passing over any that
 * requires two-step authentication they haven't turned on (unless every one does).
 */
export async function defaultWorkspaceId(user: Pick<User, "id" | "totpEnabled">): Promise<string | null> {
  const rows = await db
    .select({ id: W.id, security: W.security })
    .from(M)
    .innerJoin(W, eq(W.id, M.workspaceId))
    .where(and(eq(M.userId, user.id), eq(M.accepted, true), isNull(W.deletedAt)))
    .orderBy(asc(M.createdAt));
  return (rows.find((r) => user.totpEnabled || !r.security?.require_2fa) ?? rows[0])?.id ?? null;
}

/** Whether this person (an account that's neither deleted nor turned off) still owns or administers the workspace. */
export async function managesWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: M.role })
    .from(M)
    .innerJoin(U, eq(U.id, M.userId))
    .where(and(eq(M.workspaceId, workspaceId), eq(M.userId, userId), eq(M.accepted, true), isNull(U.deletedAt), isNull(U.disabledAt)))
    .limit(1);
  return row?.role === "owner" || row?.role === "admin";
}

const invalidKey = () => unauthorized("Invalid API key");

// Keys and apps stop with their workspace: when it's deleted, or its owner's account is turned off or deleted.
async function assertRunning(workspaceId: string) {
  if (!(await workspaceInUse(workspaceId))) throw new HttpError(403, "This workspace is stopped because its owner's account is turned off.", "workspace_stopped");
}

async function resolveBearer(token: string): Promise<AuthContext> {
  const hash = sha256(token);
  if (token.startsWith("oat_")) {
    const [grant] = await db
      .select()
      .from(schema.oauthGrants)
      .where(and(eq(schema.oauthGrants.accessTokenHash, hash), isNull(schema.oauthGrants.revokedAt), gt(schema.oauthGrants.accessExpiresAt, new Date())))
      .limit(1);
    if (!grant) throw invalidKey();
    // An app acts for the person who allowed it, so it stops when their account is turned off or deleted.
    const [user] = await db
      .select()
      .from(U)
      .where(and(eq(U.id, grant.userId), isNull(U.deletedAt), isNull(U.disabledAt)))
      .limit(1);
    const { workspace, member } = await loadWorkspaceForUser(grant.userId, grant.workspaceId);
    if (!user || !workspace || !member) throw invalidKey();
    await assertRunning(workspace.id);
    return { ...emptyAuth(), via: "oauth", user, workspace, member, role: member.role as Role, scopes: grant.scopes };
  }
  const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyHash, hash)).limit(1);
  if (!key) throw invalidKey();
  const [workspace] = await db
    .select()
    .from(W)
    .where(and(eq(W.id, key.workspaceId), isNull(W.deletedAt)))
    .limit(1);
  if (!workspace) throw invalidKey();
  await assertRunning(workspace.id);
  // A key works while the person who made it still runs the workspace: someone removed, demoted or turned off can't
  // keep using one they took with them. (Keys from before this was recorded have no creator and keep working.)
  if (key.createdBy && !(await managesWorkspace(key.createdBy, workspace.id))) {
    throw new HttpError(401, "This API key no longer works: the person who created it doesn't manage this workspace any more. Create a new key in Settings → Integrations & API → API keys.", "api_key_orphaned");
  }
  // Touch last-used at most once a minute.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, key.id));
  }
  return { ...emptyAuth(), via: "api_key", apiKey: key, workspace, role: "owner", scopes: key.scopes };
}

async function resolveSession(req: FastifyRequest): Promise<AuthContext | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  if (!session) return null;
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, session.userId), isNull(schema.users.deletedAt), isNull(schema.users.disabledAt)))
    .limit(1);
  if (!user) return null;
  const now = Date.now();
  if (!session.lastSeenAt || now - session.lastSeenAt.getTime() > 5 * 60_000) {
    await db
      .update(schema.sessions)
      .set({ lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(schema.sessions.id, session.id));
  }
  // Allow an explicit workspace header (multi-tab) when the user is a member.
  const headerWs = req.headers["x-workspace-id"];
  let wsId = typeof headerWs === "string" && headerWs ? headerWs : session.currentWorkspaceId;
  let { workspace, member } = await loadWorkspaceForUser(user.id, wsId);
  if (!workspace) {
    wsId = await defaultWorkspaceId(user);
    ({ workspace, member } = await loadWorkspaceForUser(user.id, wsId));
    if (workspace && wsId !== session.currentWorkspaceId) {
      await db.update(schema.sessions).set({ currentWorkspaceId: wsId }).where(eq(schema.sessions.id, session.id));
    }
  }
  return {
    ...emptyAuth(),
    via: "session",
    user,
    session,
    workspace,
    member,
    role: (member?.role as Role) ?? null,
    scopes: null,
    // Checked on every request, however the session got here (sign-in, an invitation, a link, a header).
    gate: workspace ? workspaceGate(workspace, user, session) : null,
  };
}

/** Whether the request's member has this permission (an API key's scopes are what the route checks instead). */
export function may(req: FastifyRequest, perm: Permission): boolean {
  const a = req.auth;
  if (a.via === "api_key") return true;
  return !!a.role && roleAllows(a.role, perm, effectivePermissions(a.workspace, a.member));
}

export async function resolveAuth(req: FastifyRequest): Promise<AuthContext> {
  const header = req.headers.authorization;
  if (header && /^bearer\s+/i.test(header)) {
    const token = header.replace(/^bearer\s+/i, "").trim();
    if (!token) throw invalidKey();
    return resolveBearer(token);
  }
  return (await resolveSession(req)) ?? emptyAuth();
}

/** Global preHandler enforcing the per-route auth config. */
export async function authHook(req: FastifyRequest) {
  const cfg: RouteAuthConfig = (req.routeOptions?.config as RouteAuthConfig) ?? {};
  // Outside /api/ only the built web app's files and its index.html fallback have no auth config; they must load signed out.
  const mode = cfg.auth ?? (req.url.startsWith("/api/") ? "workspace" : "public");
  req.auth = emptyAuth();
  if (mode === "public") {
    // Best effort: public routes may still read the session (e.g. /auth/me style helpers).
    try {
      req.auth = await resolveAuth(req);
    } catch {
      req.auth = emptyAuth();
    }
    return;
  }
  req.auth = await resolveAuth(req);
  const a = req.auth;
  if (a.via === "none") throw unauthorized();
  // Bearer credentials skip the role checks below, so they may only reach routes that declare an API scope.
  if ((a.via === "api_key" || a.via === "oauth") && !cfg.scope) throw forbidden("This endpoint can't be used with an API key");
  if (a.via === "session" && a.session?.mfaPending && mode !== "mfa") {
    throw new HttpError(401, "Two-step verification required", "mfa_required");
  }
  if (mode === "mfa" || mode === "user") return;

  if (!a.workspace) throw new HttpError(409, "No workspace selected", "no_workspace");
  // Your own account settings (two-step setup included) are "user" routes, so they stay open while this asks.
  if (a.gate) throw new HttpError(403, GATE_MESSAGES[a.gate], a.gate);
  assertAccess(a, cfg);
}

/**
 * Turns the request away unless its credentials may use a route configured with `cfg`: an API key's scopes, a member's
 * role and permissions. A handler checks again with a stricter config when one of its actions needs more than its
 * route does (a bulk route that also deletes).
 */
export function assertAccess(a: AuthContext, cfg: RouteAuthConfig): void {
  if (a.via === "api_key" || a.via === "oauth") {
    const granted = a.scopes ?? [];
    const alsoOk = (cfg.scopeAlso ?? []).some(([res, act]) => granted.includes(`${res}:${act}`) || (act !== "all" && scopeAllows(granted, res, act)));
    if (cfg.scope && !scopeAllows(granted, cfg.scope[0], cfg.scope[1]) && !alsoOk) {
      throw forbidden(`API key is missing the ${cfg.scope[0]}:${cfg.scope[1]} scope`);
    }
    for (const [res, act] of cfg.scopeExtra ?? []) {
      if (!scopeAllows(granted, res, act)) throw forbidden(`API key is missing the ${res}:${act} scope`);
    }
    if (a.via === "api_key") return;
  }
  const role = a.role;
  if (!role) throw forbidden();
  const perms = effectivePermissions(a.workspace, a.member);
  if (cfg.owner && role !== "owner") throw forbidden("Only the workspace owner can do this");
  if (cfg.admin && role !== "owner" && role !== "admin") throw forbidden();
  if (cfg.write && !canWrite(role)) {
    // "view" members may still reply in the Unibox and change their mailboxes' settings, and nothing more: connecting,
    // deleting or testing mailboxes, and placement tests, are for people who can write.
    const viewMay = cfg.perm === "unibox" || (cfg.perm === "accounts" && cfg.scope?.[0] === "accounts" && cfg.scope[1] === "update");
    if (!(viewMay && roleAllows(role, cfg.perm!, perms))) throw forbidden();
  }
  if (cfg.perm && !roleAllows(role, cfg.perm, perms)) throw forbidden();
}

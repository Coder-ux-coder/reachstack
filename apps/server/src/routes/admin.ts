// Settings → Installation: the owner's and administrators' view of the whole installation (users, workspaces,
// limits, sign-up, product areas, health). Administrators can look and help; changing limits, admins, settings
// or ownership is for the owner only.
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { NEW_WORKSPACE_MODES, PLANS, SIGNUP_MODES, type ModuleKey } from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { engineRunsHere, type EngineStatus } from "../engine";
import { describeHolder, readLease } from "../engine/lease";
import { config, REPO_ROOT } from "../env";
import { ctx } from "../http/context";
import { badRequest, forbidden, notFound } from "../http/errors";
import { rateLimit } from "../http/rate-limit";
import { body, params, query } from "../http/util";
import { verifyPassword } from "../lib/crypto";
import { iso } from "../lib/time";
import { issueToken } from "../services/auth-tokens";
import { systemHealth } from "../services/health";
import { aiConfigured } from "../services/ai";
import { getInstallationSettings, updateInstallationSettings } from "../services/installation";
import { adminFlags, getAppSetting, getOwnerId, isOwner, requireInstanceAdmin, requireOwner, setOwner } from "../services/instance";
import { sendSystemMail, systemMailLayout, systemMailLog } from "../services/system-mail";
import { forgetStoppedWorkspaces } from "../services/live-workspaces";
import { releaseMember, removeEnteredSeats } from "../services/members";
import { canRestart, restartSoon } from "../services/restart";

const id = z.object({ id: z.string().min(1) });
const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

let version: string | null = null;
async function appVersion() {
  if (version) return version;
  try {
    version = (JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    version = "unknown";
  }
  return version;
}

function fileSize(file: string) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

const count = sql<number>`count(*)`;

export default async function adminRoutes(app: FastifyInstance) {
  const user = { config: { auth: "user" as const } };

  app.get("/api/app/admin/overview", user, async (req) => {
    const me = ctx(req).user;
    await requireInstanceAdmin(me);
    const ownerId = await getOwnerId();
    const [owner] = ownerId ? await db.select().from(schema.users).where(eq(schema.users.id, ownerId)).limit(1) : [];
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    const [users] = await db.select({ n: count }).from(schema.users).where(isNull(schema.users.deletedAt));
    const [activeUsers] = await db
      .select({ n: count })
      .from(schema.users)
      .where(and(isNull(schema.users.deletedAt), gte(schema.users.lastLoginAt, monthAgo)));
    const [workspaces] = await db.select({ n: count }).from(schema.workspaces).where(isNull(schema.workspaces.deletedAt));
    const [campaigns] = await db.select({ n: count }).from(schema.campaigns);
    const [leads] = await db.select({ n: count }).from(schema.leads);
    const [accounts] = await db.select({ n: count }).from(schema.emailAccounts);
    const [sent] = await db
      .select({ n: count })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.type, "sent"), gte(schema.emailEvents.createdAt, monthAgo)));
    const jobs = await db.select({ status: schema.backgroundJobs.status, n: count }).from(schema.backgroundJobs).groupBy(schema.backgroundJobs.status);
    const failedJobs = await db
      .select({ id: schema.backgroundJobs.id, type: schema.backgroundJobs.type, error: schema.backgroundJobs.error, at: schema.backgroundJobs.updatedAt, workspace: schema.workspaces.name })
      .from(schema.backgroundJobs)
      .leftJoin(schema.workspaces, eq(schema.workspaces.id, schema.backgroundJobs.workspaceId))
      .where(eq(schema.backgroundJobs.status, "failed"))
      .orderBy(desc(schema.backgroundJobs.updatedAt))
      .limit(5);
    const engine = await getAppSetting<EngineStatus | null>("engine_status", null);
    return {
      you: { owner: me.id === ownerId },
      owner: owner ? { id: owner.id, email: owner.email, name: `${owner.firstName} ${owner.lastName}`.trim() } : null,
      counts: {
        users: Number(users?.n ?? 0),
        active_users_30d: Number(activeUsers?.n ?? 0),
        workspaces: Number(workspaces?.n ?? 0),
        campaigns: Number(campaigns?.n ?? 0),
        leads: Number(leads?.n ?? 0),
        email_accounts: Number(accounts?.n ?? 0),
        emails_sent_30d: Number(sent?.n ?? 0),
      },
      jobs: Object.fromEntries(jobs.map((j) => [j.status, Number(j.n)])),
      failed_jobs: failedJobs.map((j) => ({ id: j.id, type: j.type, error: j.error, at: iso(j.at), workspace: j.workspace })),
      storage: {
        data_dir: config.dataDir,
        database_bytes: fileSize(config.dbFile) + fileSize(`${config.dbFile}-wal`),
      },
      runtime: {
        version: await appVersion(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        uptime_s: Math.round(process.uptime()),
        worker_in_process: config.runWorkerInProcess,
        /** Whether this server runs the engine now, or another server or worker on the same data does (engine/lease.ts). */
        engine_here: engineRunsHere(),
        engine_holder: engineRunsHere() ? null : describeHolder(await readLease()),
        can_restart: canRestart() && me.id === ownerId,
      },
      engine,
      services: {
        system_email: !!config.systemSmtp.host,
        billing: !!config.stripe.secretKey,
        ai: aiConfigured(),
        google_sign_in: !!(config.google.clientId && config.google.clientSecret),
        microsoft_sign_in: !!(config.microsoft.clientId && config.microsoft.clientSecret),
        calls_and_texts: !!(config.twilio.accountSid && config.twilio.authToken),
        ip_lookup: !!config.ipinfoToken,
      },
      settings: await getInstallationSettings(),
    };
  });

  // Engine loops, inbox sync lag, job queue, stalled campaigns and disk space (Installation → Health).
  app.get("/api/app/admin/health", user, async (req) => {
    const me = ctx(req).user;
    await requireInstanceAdmin(me);
    return { ...(await systemHealth()), can_restart: canRestart() && (await isOwner(me)) };
  });

  // ---------- People ----------

  app.get("/api/app/admin/users", user, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const q = query(req, listQuery);
    const where = and(
      isNull(schema.users.deletedAt),
      q.search ? or(contains(schema.users.email, q.search), contains(sql`${schema.users.firstName} || ' ' || ${schema.users.lastName}`, q.search)) : undefined,
    );
    const [total] = await db.select({ n: count }).from(schema.users).where(where);
    const rows = await db.select().from(schema.users).where(where).orderBy(asc(schema.users.createdAt)).limit(q.limit).offset(q.offset);
    const ids = rows.map((r) => r.id);
    const flags = await adminFlags(ids);
    const memberships = ids.length
      ? await db
          .select({ userId: schema.workspaceMembers.userId, role: schema.workspaceMembers.role, id: schema.workspaces.id, name: schema.workspaces.name })
          .from(schema.workspaceMembers)
          .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
          .where(and(inArray(schema.workspaceMembers.userId, ids), eq(schema.workspaceMembers.accepted, true), isNull(schema.workspaces.deletedAt)))
      : [];
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: `${u.firstName} ${u.lastName}`.trim(),
        created_at: iso(u.createdAt),
        last_login_at: iso(u.lastLoginAt),
        email_verified: !!u.emailVerifiedAt,
        two_step: u.totpEnabled,
        disabled: !!u.disabledAt,
        owner: flags.get(u.id)?.owner ?? false,
        admin: flags.get(u.id)?.admin ?? false,
        workspaces: memberships.filter((m) => m.userId === u.id).map((m) => ({ id: m.id, name: m.name, role: m.role })),
      })),
    };
  });

  /** Loads a person an administrator may act on: never the owner (unless it's the owner acting) and never yourself. */
  async function target(req: Parameters<typeof ctx>[0], userId: string) {
    const me = ctx(req).user;
    await requireInstanceAdmin(me);
    if (userId === me.id) throw badRequest("Use your own account settings for your account");
    const [u] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .limit(1);
    if (!u) throw notFound("Person");
    if ((await getOwnerId()) === u.id) throw forbidden("The owner of this installation can't be changed here");
    const meIsOwner = await isOwner(me);
    if (u.isSuperadmin && !meIsOwner) throw forbidden("Only the owner can change another administrator");
    return { me, u, meIsOwner };
  }

  app.patch("/api/app/admin/users/:id", user, async (req) => {
    const p = params(req, id);
    const b = body(req, z.object({ disabled: z.boolean().optional(), admin: z.boolean().optional() }).strict());
    const { u, meIsOwner } = await target(req, p.id);
    if (b.admin !== undefined && !meIsOwner) throw forbidden("Only the owner can choose administrators");
    const set: Partial<typeof schema.users.$inferInsert> = {};
    if (b.disabled !== undefined) set.disabledAt = b.disabled ? new Date() : null;
    if (b.admin !== undefined) set.isSuperadmin = b.admin;
    if (Object.keys(set).length) await db.update(schema.users).set(set).where(eq(schema.users.id, u.id));
    if (b.disabled) await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
    // No longer an administrator: the workspaces they opened from Installation → Workspaces go with it.
    if (b.admin === false && u.isSuperadmin) await removeEnteredSeats("installation", { userId: u.id });
    // Their workspaces stop (or start again) on the background loops' next pass.
    if (b.disabled !== undefined) forgetStoppedWorkspaces();
    return { ok: true };
  });

  app.post("/api/app/admin/users/:id/sign-out", user, async (req) => {
    const { u } = await target(req, params(req, id).id);
    const removed = await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).returning({ id: schema.sessions.id });
    return { ok: true, sessions: removed.length };
  });

  // A one-day password link the owner can pass on (useful when this installation can't send email).
  app.post("/api/app/admin/users/:id/reset-link", user, async (req) => {
    const { me, u, meIsOwner } = await target(req, params(req, id).id);
    if (!meIsOwner) throw forbidden("Only the owner can create password links");
    const token = await issueToken("password_reset", { userId: u.id, ttlMs: 24 * 60 * 60_000 });
    const url = `${config.webUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;
    const m = systemMailLayout("Choose a new password", [`${me.firstName || "The owner of this installation"} sent you a link to choose a new password. It works for 24 hours.`], {
      label: "Choose a new password",
      url,
    });
    await sendSystemMail({ to: u.email, subject: `Choose a new ${config.brandName} password`, ...m }).catch(() => undefined);
    return { url, emailed: !!config.systemSmtp.host };
  });

  app.delete("/api/app/admin/users/:id", user, async (req) => {
    const { u, meIsOwner } = await target(req, params(req, id).id);
    if (!meIsOwner) throw forbidden("Only the owner can delete accounts");
    const owned = await db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.ownerId, u.id), isNull(schema.workspaces.deletedAt)));
    for (const w of owned) {
      const [other] = await db
        .select({ id: schema.workspaceMembers.id })
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, w.id), eq(schema.workspaceMembers.accepted, true), sql`${schema.workspaceMembers.userId} is not ${u.id}`))
        .limit(1);
      if (other) throw badRequest(`"${w.name}" has other members. Give that workspace a new owner first.`);
    }
    for (const w of owned) await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, w.id));
    await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u.id));
    await releaseMember(u.id);
    await db
      .update(schema.users)
      .set({ deletedAt: new Date(), email: `deleted+${u.id}@invalid.local`, passwordHash: null })
      .where(eq(schema.users.id, u.id));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
    forgetStoppedWorkspaces();
    return { ok: true, workspaces_deleted: owned.length };
  });

  // ---------- Workspaces ----------

  app.get("/api/app/admin/workspaces", user, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const q = query(req, listQuery);
    const where = and(isNull(schema.workspaces.deletedAt), q.search ? contains(schema.workspaces.name, q.search) : undefined);
    const [total] = await db.select({ n: count }).from(schema.workspaces).where(where);
    const rows = await db
      .select({ ws: schema.workspaces, ownerEmail: schema.users.email })
      .from(schema.workspaces)
      .leftJoin(schema.users, eq(schema.users.id, schema.workspaces.ownerId))
      .where(where)
      .orderBy(asc(schema.workspaces.createdAt))
      .limit(q.limit)
      .offset(q.offset);
    const ids = rows.map((r) => r.ws.id);
    const tally = async (table: typeof schema.campaigns | typeof schema.emailAccounts | typeof schema.leads) => {
      if (!ids.length) return new Map<string, number>();
      const res = await db.select({ ws: table.workspaceId, n: count }).from(table).where(inArray(table.workspaceId, ids)).groupBy(table.workspaceId);
      return new Map(res.map((r) => [r.ws, Number(r.n)]));
    };
    const [campaigns, accounts, leads] = [await tally(schema.campaigns), await tally(schema.emailAccounts), await tally(schema.leads)];
    const members = ids.length
      ? new Map(
          (
            await db
              .select({ ws: schema.workspaceMembers.workspaceId, n: count })
              .from(schema.workspaceMembers)
              .where(and(inArray(schema.workspaceMembers.workspaceId, ids), eq(schema.workspaceMembers.accepted, true)))
              .groupBy(schema.workspaceMembers.workspaceId)
          ).map((r) => [r.ws, Number(r.n)]),
        )
      : new Map<string, number>();
    const ownerId = await getOwnerId();
    return {
      total: Number(total?.n ?? 0),
      items: rows.map(({ ws, ownerEmail }) => ({
        id: ws.id,
        name: ws.name,
        owner: { id: ws.ownerId, email: ownerEmail ?? null, is_installation_owner: ws.ownerId === ownerId },
        created_at: iso(ws.createdAt),
        unlimited: ws.selfHosted,
        plan_ids: ws.planIds ?? {},
        trial_ends_at: iso(ws.trialEndsAt),
        members: members.get(ws.id) ?? 0,
        campaigns: campaigns.get(ws.id) ?? 0,
        email_accounts: accounts.get(ws.id) ?? 0,
        leads: leads.get(ws.id) ?? 0,
      })),
    };
  });

  app.patch("/api/app/admin/workspaces/:id", user, async (req) => {
    await requireOwner(ctx(req).user);
    const p = params(req, id);
    const planIds = new Set(PLANS.map((x) => x.id));
    const b = body(
      req,
      z
        .object({
          unlimited: z.boolean().optional(),
          plan_ids: z.record(z.string(), z.string().nullable()).optional(),
          trial_ends_at: z.string().datetime().nullable().optional(),
        })
        .strict(),
    );
    for (const v of Object.values(b.plan_ids ?? {})) if (v && !planIds.has(v)) throw badRequest(`Unknown plan "${v}"`);
    const [ws] = await db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, p.id), isNull(schema.workspaces.deletedAt)))
      .limit(1);
    if (!ws) throw notFound("Workspace");
    if (b.unlimited === false && ws.ownerId === (await getOwnerId())) throw badRequest("Your own workspaces are always unlimited");
    await db
      .update(schema.workspaces)
      .set({
        ...(b.unlimited !== undefined ? { selfHosted: b.unlimited } : {}),
        ...(b.plan_ids ? { planIds: Object.fromEntries(Object.entries({ ...(ws.planIds ?? {}), ...b.plan_ids }).filter(([, v]) => v)) } : {}),
        ...(b.trial_ends_at !== undefined ? { trialEndsAt: b.trial_ends_at ? new Date(b.trial_ends_at) : null } : {}),
        ...(b.unlimited ? { trialEndsAt: null } : {}),
      })
      .where(eq(schema.workspaces.id, ws.id));
    return { ok: true };
  });

  app.post("/api/app/admin/workspaces/:id/credits", user, async (req) => {
    const me = ctx(req).user;
    await requireOwner(me);
    const p = params(req, id);
    const b = body(req, z.object({ pool: z.enum(["credits", "verification", "visitors"]), amount: z.number().positive().max(10_000_000), note: z.string().trim().max(200).optional() }));
    const [ws] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, p.id)).limit(1);
    if (!ws) throw notFound("Workspace");
    await db.insert(schema.creditLedger).values({ workspaceId: ws.id, pool: b.pool, delta: b.amount, reason: b.note ? `admin_grant: ${b.note}` : "admin_grant", userId: me.id });
    return { ok: true };
  });

  // Joins a workspace as an admin (to help someone) and switches to it.
  app.post("/api/app/admin/workspaces/:id/enter", user, async (req) => {
    const c = ctx(req);
    await requireInstanceAdmin(c.user);
    const p = params(req, id);
    const [ws] = await db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, p.id), isNull(schema.workspaces.deletedAt)))
      .limit(1);
    if (!ws) throw notFound("Workspace");
    // Administrators help everyone else; the owner's workspaces, and other administrators', are only the owner's to open.
    if (!(await isOwner(c.user)) && ws.ownerId !== c.user.id) {
      const [wsOwner] = await db.select({ isSuperadmin: schema.users.isSuperadmin }).from(schema.users).where(eq(schema.users.id, ws.ownerId)).limit(1);
      if (ws.ownerId === (await getOwnerId()) || wsOwner?.isSuperadmin) throw forbidden("Only the owner of this installation can open this workspace");
    }
    const [member] = await db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, c.user.id)))
      .limit(1);
    if (!member) {
      // Marked, so the seat goes if they stop being an administrator.
      await db
        .insert(schema.workspaceMembers)
        .values({ workspaceId: ws.id, userId: c.user.id, email: c.user.email, role: "admin", accepted: true, issuerId: c.user.id, enteredVia: "installation" });
    } else if (!member.accepted) {
      await db.update(schema.workspaceMembers).set({ accepted: true, inviteTokenHash: null }).where(eq(schema.workspaceMembers.id, member.id));
    }
    const session = c.auth.session;
    if (session) await db.update(schema.sessions).set({ currentWorkspaceId: ws.id }).where(eq(schema.sessions.id, session.id));
    return { ok: true, workspace_id: ws.id };
  });

  // ---------- Installation settings and ownership ----------

  app.get("/api/app/admin/settings", user, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    return getInstallationSettings();
  });

  app.patch("/api/app/admin/settings", user, async (req) => {
    await requireOwner(ctx(req).user);
    const b = body(
      req,
      z
        .object({
          signup_mode: z.enum(SIGNUP_MODES).optional(),
          new_workspace_mode: z.enum(NEW_WORKSPACE_MODES).optional(),
          modules: z.record(z.string(), z.boolean()).optional(),
        })
        .strict(),
    );
    return updateInstallationSettings({ ...b, modules: b.modules as Partial<Record<ModuleKey, boolean>> | undefined });
  });

  app.post("/api/app/admin/owner", user, async (req) => {
    const me = ctx(req).user;
    await requireOwner(me);
    const b = body(req, z.object({ user_id: z.string().min(1), password: z.string().optional() }));
    rateLimit(`owner-transfer:${me.id}`, 5);
    if (me.passwordHash && !(await verifyPassword(b.password ?? "", me.passwordHash))) throw badRequest("Incorrect password");
    if (b.user_id === me.id) return { ok: true };
    const [u] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, b.user_id), isNull(schema.users.deletedAt), isNull(schema.users.disabledAt)))
      .limit(1);
    if (!u) throw notFound("Person");
    await setOwner(u.id);
    // The previous owner stays an administrator, as the confirmation promised.
    await db.update(schema.users).set({ isSuperadmin: true }).where(eq(schema.users.id, me.id));
    return { ok: true };
  });

  // Restarts the server (to finish a restore, or get a stopped engine going) when something starts it again.
  app.post("/api/app/admin/restart", user, async (req) => {
    await requireOwner(ctx(req).user);
    if (!canRestart()) {
      throw badRequest("This server can't restart itself: restart it the way it was started. (Started with npm run local or Start Reachstack, it can.)");
    }
    restartSoon(app);
    return { ok: true };
  });

  // System emails (sign-up confirmations, password links) kept in memory, for installations that can't send email.
  app.get("/api/app/admin/mail-log", user, async (req) => {
    await requireOwner(ctx(req).user);
    return { delivery: !!config.systemSmtp.host, items: [...systemMailLog].reverse() };
  });

  app.get("/api/app/admin/plans", user, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    return PLANS.map((p) => ({ id: p.id, product: p.product, name: p.name, limits: p.limits }));
  });

  // Recent sign-ins across the installation (helps spot accounts someone else is using).
  app.get("/api/app/admin/sessions", user, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const rows = await db
      .select({ s: schema.sessions, email: schema.users.email })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .orderBy(desc(schema.sessions.lastSeenAt))
      .limit(100);
    return rows.map(({ s, email }) => ({ id: s.id, email, ip: s.ip, user_agent: s.userAgent, created_at: iso(s.createdAt), last_seen_at: iso(s.lastSeenAt) }));
  });
}

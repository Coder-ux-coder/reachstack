import type { FastifyInstance } from "fastify";
import type { FastifyRequest } from "fastify";
import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity, PERMISSIONS, canWrite, isValidEmailSyntax, roleAllows, scopeCovers } from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { config } from "../env";
import { GATE_MESSAGES, managesWorkspace, workspaceGate } from "../http/auth";
import { ctx } from "../http/context";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http/errors";
import { rateLimit } from "../http/rate-limit";
import { body, pageInfo, pageQuery, paginated, query, zInt } from "../http/util";
import { randomToken, sha256 } from "../lib/ids";
import { verifyCname } from "../lib/dns";
import { iso, isValidZone } from "../lib/time";
import { audit } from "../services/audit";
import { effectivePermissions, forgetPortalBrands } from "../services/branding";
import { sendSystemMail, systemMailLayout } from "../services/system-mail";
import { createWorkspace, listUserWorkspaces, patchWorkspaceSettings, serializeMember, serializeWorkspace } from "../services/workspaces";
import { forgetWorkspaceZones, workspaceRange } from "../services/workspace-clock";
import { consumeToken, issueToken } from "./auth";
import { requireOwner } from "../services/instance";
import { forgetStoppedWorkspaces } from "../services/live-workspaces";
import { inviteExpired, releaseMember, removeEnteredSeats } from "../services/members";

/** API keys and apps: they act without a person, so some things stay with people signed in to the app. */
const isBearer = (req: FastifyRequest) => req.auth.via === "api_key" || req.auth.via === "oauth";

/**
 * Making someone an admin hands over everything, keys included. A key or app may only do it with full access, or a
 * key scoped to inviting people could make its holder an admin.
 */
function assertMayGrantAdmin(req: FastifyRequest) {
  if (isBearer(req) && !(req.auth.scopes ?? []).includes("all:all")) throw forbidden("Only a key with full access (all:all) can make someone an admin");
}

/** Whether this member may see the whole team (emails, roles, invitations) rather than just teammates' names. */
function seesWholeTeam(req: FastifyRequest): boolean {
  const a = req.auth;
  if (a.via === "api_key") return true;
  const role = a.role;
  return !!role && (canWrite(role) || roleAllows(role, "team", effectivePermissions(a.workspace, a.member)));
}

async function sendInvite(workspaceName: string, inviter: string, email: string, token: string) {
  const url = `${config.webUrl}/invitations?token=${encodeURIComponent(token)}`;
  const m = systemMailLayout(`You're invited to ${workspaceName}`, [`${inviter} invited you to join the <b>${workspaceName}</b> workspace on ${config.brandName}.`], {
    label: "Accept invitation",
    url,
  });
  await sendSystemMail({ to: email, subject: `${inviter} invited you to ${workspaceName}`, ...m });
}

export default async function workspaceRoutes(app: FastifyInstance) {
  // ---------- App endpoints ----------
  app.get("/api/app/workspaces", { config: { auth: "user" } }, async (req) => listUserWorkspaces(ctx(req).user.id));

  app.post("/api/app/workspaces", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ name: z.string().trim().min(1).max(120), timezone: z.string().max(80).optional() }));
    const user = ctx(req).user;
    const ws = await createWorkspace(user, b.name, { timezone: b.timezone });
    if (req.auth.session) await db.update(schema.sessions).set({ currentWorkspaceId: ws.id }).where(eq(schema.sessions.id, req.auth.session.id));
    return serializeWorkspace(ws);
  });

  app.post("/api/app/workspaces/:id/switch", { config: { auth: "user" } }, async (req) => {
    const { id } = req.params as { id: string };
    const user = ctx(req).user;
    const list = await listUserWorkspaces(user.id);
    if (!list.some((w) => w.id === id)) throw notFound("Workspace");
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).limit(1);
    const gate = ws ? workspaceGate(ws, user, req.auth.session) : null;
    if (gate) throw new HttpError(403, GATE_MESSAGES[gate], gate);
    await db.update(schema.sessions).set({ currentWorkspaceId: id }).where(eq(schema.sessions.id, req.auth.session!.id));
    return { ok: true };
  });

  app.get("/api/app/invitations/:token", { config: { auth: "public" } }, async (req) => {
    const { token } = req.params as { token: string };
    const [m] = await db
      .select({ member: schema.workspaceMembers, ws: schema.workspaces })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(eq(schema.workspaceMembers.inviteTokenHash, sha256(token)))
      .limit(1);
    if (!m) throw notFound("Invitation");
    if (inviteExpired(m.member)) throw new HttpError(410, "This invitation has expired. Ask the workspace admin to send it again.", "invitation_expired");
    const [existingUser] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, m.member.email)).limit(1);
    return { email: m.member.email, role: m.member.role, workspace: { id: m.ws.id, name: m.ws.name }, user_exists: !!existingUser, accepted: m.member.accepted };
  });

  app.post("/api/app/invitations/:token/accept", { config: { auth: "user" } }, async (req) => {
    const { token } = req.params as { token: string };
    const user = ctx(req).user;
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.inviteTokenHash, sha256(token))).limit(1);
    if (!m) throw notFound("Invitation");
    if (inviteExpired(m)) throw new HttpError(410, "This invitation has expired. Ask the workspace admin to send it again.", "invitation_expired");
    if (m.email !== user.email) throw forbidden(`This invitation was sent to ${m.email}. Log in with that email to accept it.`);
    await db.update(schema.workspaceMembers).set({ userId: user.id, accepted: true, inviteTokenHash: null }).where(eq(schema.workspaceMembers.id, m.id));
    await db.update(schema.sessions).set({ currentWorkspaceId: m.workspaceId }).where(eq(schema.sessions.id, req.auth.session!.id));
    return { ok: true, workspace_id: m.workspaceId };
  });

  app.post("/api/app/workspaces/current/leave", { config: { auth: "workspace" } }, async (req) => {
    const c = ctx(req);
    if (req.auth.role === "owner") throw badRequest("The owner cannot leave the workspace. Transfer ownership first.");
    await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, c.wsId), eq(schema.workspaceMembers.userId, c.user.id)));
    await releaseMember(c.user.id, c.wsId);
    // Workspaces they opened from this one's group go with it.
    await removeEnteredSeats(`agency:${c.wsId}`, { userId: c.user.id });
    await db.update(schema.sessions).set({ currentWorkspaceId: null }).where(eq(schema.sessions.id, req.auth.session!.id));
    return { ok: true };
  });

  app.get("/api/app/workspaces/current/settings", { config: { auth: "workspace" } }, async (req) => serializeWorkspace(ctx(req).workspace).settings);

  // Preferences and advanced deliverability. AI keys and models go through /api/app/ai/settings.
  app.patch("/api/app/workspaces/current/settings", { config: { auth: "workspace", admin: true } }, async (req) => {
    const filterAction = z.enum(["send_as_usual", "skip", "send_last"]);
    const b = body(
      req,
      z
        .object({
          default_timezone: z.string().max(64).refine(isValidZone, "Unknown timezone").optional(),
          timezone_confirmed: z.boolean().optional(),
          unibox_show_auto_replies: z.boolean().optional(),
          unibox_save_non_campaign_emails: z.boolean().optional(),
          unibox_save_undelivered: z.boolean().optional(),
          stop_campaign_on_lead_reply_from_any_campaign: z.boolean().optional(),
          disable_global_lead_status_sync: z.boolean().optional(),
          auto_label_ooo: z.boolean().optional(),
          update_existing_labels_with_ai: z.boolean().optional(),
          ai_label_codes: z.array(z.number().int()).max(200).nullable().optional(),
          limit_emails_per_company: z.object({ enabled: z.boolean(), daily_limit: z.number().int().min(1).max(1_000), scope: z.enum(["per_campaign", "across_workspace"]).optional() }).optional(),
          esp_matching_default: z.boolean().optional(),
          first_email_text_only: z.boolean().optional(),
          disable_open_tracking: z.boolean().optional(),
          auto_pause_on_bounce: z.boolean().optional(),
          single_account_per_gap: z.boolean().optional(),
          send_one_at_a_time: z.boolean().optional(),
          sticky_sending_accounts_for_leads: z.boolean().optional(),
          bounce_protect_threshold: z.number().int().min(1).max(20).optional(),
          ai_lead_filtering: z.object({ unlikely_to_reply: filterAction, hostile: filterAction }).optional(),
          notify_account_disconnect: z.boolean().optional(),
          notify_positive_reply: z.boolean().optional(),
          notification_recipients: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
          custom_warmup_copy: z.object({ enabled: z.boolean(), subjects: z.array(z.string().trim().max(200)).max(100), bodies: z.array(z.string().max(5_000)).max(100) }).optional(),
          crm_pipeline_statuses: z.array(z.number().int()).max(50).optional(),
          crm_default_view: z.string().max(50).optional(),
          agency: z
            .object({
              enabled: z.boolean(),
              brand_name: z.string().trim().max(60).nullable().optional(),
              brand_color: z
                .string()
                .regex(/^#[0-9a-f]{6}$/i, "Use a hex colour like #4f46e5")
                .nullable()
                .optional(),
              client_permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    );
    // A timezone picked on purpose: the dashboard stops asking whether it's the right one.
    const ws = await patchWorkspaceSettings(ctx(req).wsId, b.default_timezone !== undefined ? { ...b, timezone_confirmed: true } : b);
    if (b.agency) forgetPortalBrands();
    // A new timezone applies at once here (other processes pick it up within half a minute).
    if (b.default_timezone !== undefined) forgetWorkspaceZones(ctx(req).wsId);
    return serializeWorkspace(ws!).settings;
  });

  app.patch("/api/app/workspaces/current/security", { config: { auth: "workspace", owner: true } }, async (req) => {
    const b = body(req, z.object({ require_2fa: z.boolean().optional(), reauth_hours: z.number().int().min(1).max(168).nullable().optional() }));
    const c = ctx(req);
    if ((b.require_2fa || b.reauth_hours) && !c.user.totpEnabled) {
      throw badRequest("Set up two-step authentication on your account before requiring it for your team.");
    }
    const security = { ...(c.workspace.security ?? {}), ...b };
    await db.update(schema.workspaces).set({ security }).where(eq(schema.workspaces.id, c.wsId));
    return security;
  });

  app.patch("/api/app/workspaces/current", { config: { auth: "workspace", admin: true } }, async (req) => {
    const b = body(
      req,
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        logo_url: z.string().max(500_000).nullable().optional(),
        add_unsub_to_block: z.boolean().optional(),
        default_opportunity_value: z.number().min(0).nullable().optional(),
      }),
    );
    const c = ctx(req);
    const [ws] = await db
      .update(schema.workspaces)
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.logo_url !== undefined ? { logoUrl: b.logo_url } : {}),
        ...(b.add_unsub_to_block !== undefined ? { addUnsubToBlock: b.add_unsub_to_block } : {}),
        ...(b.default_opportunity_value !== undefined ? { defaultOpportunityValue: b.default_opportunity_value } : {}),
      })
      .where(eq(schema.workspaces.id, c.wsId))
      .returning();
    return serializeWorkspace(ws!);
  });

  app.delete("/api/app/workspaces/current", { config: { auth: "workspace", owner: true } }, async (req) => {
    const b = body(req, z.object({ confirm_name: z.string() }));
    const c = ctx(req);
    if (b.confirm_name.trim() !== c.workspace.name) throw badRequest("Type the workspace name to confirm");
    await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, c.wsId));
    await db.update(schema.sessions).set({ currentWorkspaceId: null }).where(eq(schema.sessions.currentWorkspaceId, c.wsId));
    await removeEnteredSeats(`agency:${c.wsId}`);
    forgetStoppedWorkspaces();
    return { ok: true };
  });

  app.post("/api/app/workspaces/current/change-owner/confirm", { config: { auth: "public" } }, async (req) => {
    const b = body(req, z.object({ token: z.string() }));
    const row = await consumeToken("owner_change", b.token);
    const data = row?.data as { workspace_id?: string; new_owner_user_id?: string } | null;
    if (!data?.workspace_id || !data.new_owner_user_id) throw badRequest("This confirmation link is invalid or has expired");
    const newOwner = data.new_owner_user_id;
    const [ws] = await db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, data.workspace_id), isNull(schema.workspaces.deletedAt)))
      .limit(1);
    if (!ws) throw notFound("Workspace");
    // Only the owner who sent it can hand the workspace over: an old link can't take it back after it changed hands.
    if (!row?.userId || row.userId !== ws.ownerId) throw badRequest("This link was sent by someone who no longer owns the workspace, so ownership stays as it is.");
    if (newOwner === ws.ownerId) throw badRequest("They already own this workspace.");
    const [still] = await db
      .select({ id: schema.workspaceMembers.id })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, newOwner), eq(schema.workspaceMembers.accepted, true)))
      .limit(1);
    if (!still) throw badRequest("The new owner is no longer a member of this workspace, so ownership stays as it is.");
    const T = schema.authTokens;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.workspaceMembers)
        .set({ role: "admin" })
        .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, ws.ownerId)));
      await tx
        .update(schema.workspaceMembers)
        .set({ role: "owner", enteredVia: null })
        .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, newOwner)));
      await tx.update(schema.workspaces).set({ ownerId: newOwner }).where(eq(schema.workspaces.id, ws.id));
      // Any other change of owner still waiting for this workspace was meant for the old situation.
      await tx
        .update(T)
        .set({ usedAt: new Date() })
        .where(and(eq(T.type, "owner_change"), isNull(T.usedAt), sql`json_extract(${T.data}, '$.workspace_id') = ${ws.id}`));
    });
    return { ok: true };
  });

  // ---------- API v2: workspace ----------
  app.get("/api/v2/workspaces/current", { config: { scope: ["workspaces", "read"] } }, async (req) => serializeWorkspace(ctx(req).workspace));

  app.patch("/api/v2/workspaces/current", { config: { scope: ["workspaces", "update"], admin: true } }, async (req) => {
    const b = body(req, z.object({ name: z.string().trim().min(1).max(120).optional(), org_logo_url: z.string().nullable().optional() }));
    const c = ctx(req);
    const [ws] = await db
      .update(schema.workspaces)
      .set({ ...(b.name ? { name: b.name } : {}), ...(b.org_logo_url !== undefined ? { logoUrl: b.org_logo_url } : {}) })
      .where(eq(schema.workspaces.id, c.wsId))
      .returning();
    return serializeWorkspace(ws!);
  });

  app.post("/api/v2/workspaces/current/schedule-for-removal", { config: { scope: ["workspaces", "update"], owner: true } }, async (req) => {
    const c = ctx(req);
    const [ws] = await db
      .update(schema.workspaces)
      .set({ scheduledForRemovalAt: new Date(Date.now() + 30 * 86_400_000) })
      .where(eq(schema.workspaces.id, c.wsId))
      .returning();
    return serializeWorkspace(ws!);
  });

  app.delete("/api/v2/workspaces/current/schedule-for-removal", { config: { scope: ["workspaces", "update"], owner: true } }, async (req) => {
    const c = ctx(req);
    const [ws] = await db.update(schema.workspaces).set({ scheduledForRemovalAt: null }).where(eq(schema.workspaces.id, c.wsId)).returning();
    return serializeWorkspace(ws!);
  });

  // The portal domain is a CNAME to this server; "verified" means DNS already points here.
  app.get("/api/v2/workspaces/current/whitelabel-domain", { config: { scope: ["workspaces", "read"] } }, async (req) => {
    const ws = ctx(req).workspace;
    const target = new URL(config.appUrl).hostname;
    const verified = ws.clientDomain ? await verifyCname(ws.clientDomain, target).catch(() => false) : false;
    return { domain: ws.clientDomain, verified, cname_target: target };
  });

  app.post("/api/v2/workspaces/current/whitelabel-domain", { config: { scope: ["workspaces", "update"], admin: true } }, async (req) => {
    const b = body(req, z.object({ domain: z.string().trim().toLowerCase().min(3).max(253) }));
    const c = ctx(req);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(b.domain)) throw badRequest("Enter a valid domain like portal.youragency.com");
    const [taken] = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.clientDomain, b.domain), ne(schema.workspaces.id, c.wsId)))
      .limit(1);
    if (taken) throw conflict("This domain is already used by another workspace");
    await db.update(schema.workspaces).set({ clientDomain: b.domain }).where(eq(schema.workspaces.id, c.wsId));
    forgetPortalBrands();
    return { domain: b.domain, cname_target: new URL(config.appUrl).hostname };
  });

  app.delete("/api/v2/workspaces/current/whitelabel-domain", { config: { scope: ["workspaces", "update"], admin: true } }, async (req) => {
    await db.update(schema.workspaces).set({ clientDomain: null }).where(eq(schema.workspaces.id, ctx(req).wsId));
    forgetPortalBrands();
    return { ok: true };
  });

  app.post("/api/v2/workspaces/current/change-owner", { config: { scope: ["workspaces", "update"], owner: true } }, async (req) => {
    const b = body(req, z.object({ email: z.string().trim().toLowerCase(), sec: z.string().optional() }));
    const c = ctx(req);
    const [target] = await db
      .select({ m: schema.workspaceMembers })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, c.wsId), eq(schema.workspaceMembers.email, b.email), eq(schema.workspaceMembers.accepted, true)))
      .limit(1);
    if (!target?.m.userId) throw badRequest("The new owner must be an accepted member of this workspace");
    if (target.m.userId === c.workspace.ownerId) throw badRequest("They already own this workspace");
    // Sent to the owner, who confirms it; the link only works while they still own the workspace.
    const token = await issueToken("owner_change", {
      userId: c.workspace.ownerId,
      data: { workspace_id: c.wsId, new_owner_user_id: target.m.userId },
      ttlMs: 24 * 3_600_000,
    });
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, c.workspace.ownerId)).limit(1);
    const url = `${config.webUrl}/app/settings/change-owner?token=${encodeURIComponent(token)}`;
    const m = systemMailLayout("Confirm the ownership change", [`You asked to make <b>${b.email}</b> the owner of <b>${c.workspace.name}</b>.`], { label: "Confirm change", url });
    if (owner) await sendSystemMail({ to: owner.email, subject: `Confirm ownership change for ${c.workspace.name}`, ...m });
    return { ok: true, message: "Confirmation email sent" };
  });

  // ---------- API v2: workspace members ----------
  app.get("/api/v2/workspace-members", { config: { scope: ["workspace_members", "read"] } }, async (req) => {
    const q = query(req, pageQuery.extend({ accepted: z.enum(["true", "false"]).optional() }));
    const c = ctx(req);
    const { limit, startingAfter } = pageInfo(q, 100);
    // Clients and view-only members see who their teammates are, not their emails, roles or pending invitations.
    const whole = seesWholeTeam(req);
    const conds = [eq(schema.workspaceMembers.workspaceId, c.wsId)];
    if (!whole) conds.push(eq(schema.workspaceMembers.accepted, true));
    if (q.accepted) conds.push(eq(schema.workspaceMembers.accepted, q.accepted === "true"));
    if (q.search && whole) conds.push(contains(schema.workspaceMembers.email, q.search.toLowerCase()));
    if (startingAfter) conds.push(gte(schema.workspaceMembers.id, startingAfter), ne(schema.workspaceMembers.id, startingAfter));
    const rows = await db
      .select({ m: schema.workspaceMembers, u: schema.users })
      .from(schema.workspaceMembers)
      .leftJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(and(...conds))
      .orderBy(schema.workspaceMembers.id)
      .limit(limit + 1);
    return paginated(
      rows.map((r) => (whole ? serializeMember(r.m, r.u) : teammate(r.m, r.u))),
      limit,
    );
  });

  app.get("/api/v2/workspace-members/:id", { config: { scope: ["workspace_members", "read"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const [r] = await db
      .select({ m: schema.workspaceMembers, u: schema.users })
      .from(schema.workspaceMembers)
      .leftJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(and(eq(schema.workspaceMembers.id, id), eq(schema.workspaceMembers.workspaceId, ctx(req).wsId)))
      .limit(1);
    if (!r) throw notFound("Workspace member");
    if (seesWholeTeam(req)) return serializeMember(r.m, r.u);
    if (!r.m.accepted) throw notFound("Workspace member");
    return teammate(r.m, r.u);
  });

  app.post("/api/v2/workspace-members", { config: { scope: ["workspace_members", "create"], perm: "team", admin: true } }, async (req) => {
    const b = body(
      req,
      z.object({
        email: z.string().trim().toLowerCase(),
        user_email: z.string().optional(),
        nickname: z.string().max(80).nullable().optional(),
        role: z.enum(["admin", "editor", "view", "client"]),
        permissions: z.array(z.enum(PERMISSIONS)).nullable().optional(),
      }),
    );
    const c = ctx(req);
    if (!isValidEmailSyntax(b.email)) throw badRequest("Please enter a valid email address");
    if (b.role === "admin") assertMayGrantAdmin(req);
    const [exists] = await db
      .select({ id: schema.workspaceMembers.id })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, c.wsId), eq(schema.workspaceMembers.email, b.email)))
      .limit(1);
    if (exists) throw conflict("This person is already a member or has a pending invitation");
    const token = randomToken(24);
    const [member] = await db
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: c.wsId,
        email: b.email,
        role: b.role,
        nickname: b.nickname ?? null,
        permissions: b.permissions ?? null,
        accepted: false,
        issuerId: c.userId,
        inviteTokenHash: sha256(token),
        invitedAt: new Date(),
      })
      .returning();
    const inviter = req.auth.user ? `${req.auth.user.firstName} ${req.auth.user.lastName}`.trim() || req.auth.user.email : config.brandName;
    await sendInvite(c.workspace.name, inviter, b.email, token);
    // The link goes to the invited inbox only. Handed to a key, it would let the key's holder sign up as that person.
    if (isBearer(req)) return serializeMember(member!);
    return { ...serializeMember(member!), invite_url: `${config.webUrl}/invitations?token=${encodeURIComponent(token)}` };
  });

  app.post("/api/app/workspace-members/:id/resend", { config: { auth: "workspace", admin: true } }, async (req) => {
    const { id } = req.params as { id: string };
    const c = ctx(req);
    const [m] = await db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.id, id), eq(schema.workspaceMembers.workspaceId, c.wsId)))
      .limit(1);
    if (!m || m.accepted) throw notFound("Pending invitation");
    const token = randomToken(24);
    await db.update(schema.workspaceMembers).set({ inviteTokenHash: sha256(token), invitedAt: new Date() }).where(eq(schema.workspaceMembers.id, m.id));
    await sendInvite(c.workspace.name, req.auth.user?.email ?? config.brandName, m.email, token);
    return { ok: true, invite_url: `${config.webUrl}/invitations?token=${encodeURIComponent(token)}` };
  });

  app.patch("/api/v2/workspace-members/:id", { config: { scope: ["workspace_members", "update"], admin: true } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = body(
      req,
      z.object({
        nickname: z.string().max(80).nullable().optional(),
        role: z.enum(["admin", "editor", "view", "client"]).optional(),
        permissions: z.array(z.enum(PERMISSIONS)).nullable().optional(),
      }),
    );
    const c = ctx(req);
    const [m] = await db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.id, id), eq(schema.workspaceMembers.workspaceId, c.wsId)))
      .limit(1);
    if (!m) throw notFound("Workspace member");
    if (m.role === "owner" && b.role) throw badRequest("Only the current owner can change the owner of a workspace");
    if (m.userId && m.userId === c.userId && b.role) throw badRequest("You can't change your own role");
    if (b.role === "admin" && m.role !== "admin") assertMayGrantAdmin(req);
    const [updated] = await db
      .update(schema.workspaceMembers)
      .set({
        ...(b.nickname !== undefined ? { nickname: b.nickname } : {}),
        ...(b.role ? { role: b.role } : {}),
        ...(b.permissions !== undefined ? { permissions: b.permissions } : {}),
      })
      .where(eq(schema.workspaceMembers.id, id))
      .returning();
    // No longer an admin here: the workspaces they opened from this one's group go too.
    if (b.role && b.role !== "admin" && m.role === "admin" && m.userId) await removeEnteredSeats(`agency:${c.wsId}`, { userId: m.userId });
    return serializeMember(updated!);
  });

  app.delete("/api/v2/workspace-members/:id", { config: { scope: ["workspace_members", "delete"], admin: true } }, async (req) => {
    const { id } = req.params as { id: string };
    const c = ctx(req);
    const [m] = await db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.id, id), eq(schema.workspaceMembers.workspaceId, c.wsId)))
      .limit(1);
    if (!m) throw notFound("Workspace member");
    if (m.role === "owner") throw badRequest("The owner can't be removed");
    if (m.userId && m.userId === c.userId) throw badRequest("You can't remove yourself from the organization, please leave the organization instead");
    await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, id));
    if (m.userId) {
      await releaseMember(m.userId, c.wsId);
      await removeEnteredSeats(`agency:${c.wsId}`, { userId: m.userId });
    }
    return serializeMember(m);
  });

  // ---------- API v2: workspace groups (agency) ----------
  /**
   * The managing side doesn't see the other workspace's name until it accepts, so a guessed id or email tells it
   * nothing about who has an account here.
   */
  const serializeGroup = async (g: typeof schema.workspaceGroupMembers.$inferSelect, viewerWsId: string) => {
    const names = await db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(inArray(schema.workspaces.id, [g.adminWorkspaceId, g.subWorkspaceId]));
    const hidden = g.status !== "accepted" && viewerWsId !== g.subWorkspaceId;
    const nameOf = (id: string) => (hidden && id === g.subWorkspaceId ? null : (names.find((n) => n.id === id)?.name ?? null));
    return {
      id: g.id,
      admin_workspace_id: g.adminWorkspaceId,
      sub_workspace_id: hidden ? null : g.subWorkspaceId,
      status: g.status,
      timestamp_created: iso(g.createdAt),
      timestamp_updated: iso(g.updatedAt),
      sub_workspace_name: nameOf(g.subWorkspaceId),
      admin_workspace_name: nameOf(g.adminWorkspaceId),
    };
  };

  app.get("/api/v2/workspace-group-members", { config: { scope: ["workspace_group_members", "read"] } }, async (req) => {
    const c = ctx(req);
    const rows = await db
      .select()
      .from(schema.workspaceGroupMembers)
      .where(or(eq(schema.workspaceGroupMembers.adminWorkspaceId, c.wsId), eq(schema.workspaceGroupMembers.subWorkspaceId, c.wsId)))
      .orderBy(desc(schema.workspaceGroupMembers.createdAt));
    return { items: await Promise.all(rows.map((g) => serializeGroup(g, c.wsId))), next_starting_after: null };
  });

  app.get("/api/v2/workspace-group-members/admin", { config: { scope: ["workspace_group_members", "read"] } }, async (req) => {
    const [g] = await db
      .select()
      .from(schema.workspaceGroupMembers)
      .where(and(eq(schema.workspaceGroupMembers.subWorkspaceId, ctx(req).wsId), eq(schema.workspaceGroupMembers.status, "accepted")))
      .limit(1);
    return g ? serializeGroup(g, ctx(req).wsId) : null;
  });

  app.get("/api/v2/workspace-group-members/:id", { config: { scope: ["workspace_group_members", "read"] } }, async (req) => {
    const { id } = req.params as { id: string };
    const c = ctx(req);
    const [g] = await db.select().from(schema.workspaceGroupMembers).where(eq(schema.workspaceGroupMembers.id, id)).limit(1);
    if (!g || (g.adminWorkspaceId !== c.wsId && g.subWorkspaceId !== c.wsId)) throw notFound("Workspace group member");
    return serializeGroup(g, c.wsId);
  });

  app.post("/api/v2/workspace-group-members", { config: { scope: ["workspace_group_members", "create"], admin: true } }, async (req) => {
    const b = body(req, z.object({ sub_workspace_id: z.string().optional(), email: z.string().optional() }));
    const c = ctx(req);
    rateLimit(`group-invite:${c.wsId}`, 30, 60 * 60_000);
    const byEmail = !b.sub_workspace_id && !!b.email;
    // By email, every address gets the same answer, so nobody learns which emails have accounts here.
    const sent = { ok: true, message: "If that email owns a workspace here, its owner has been asked to accept." };
    let subId = b.sub_workspace_id ?? null;
    if (byEmail) {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, b.email!.trim().toLowerCase())).limit(1);
      const [w] = u ? await db.select().from(schema.workspaces).where(and(eq(schema.workspaces.ownerId, u.id), isNull(schema.workspaces.deletedAt))).limit(1) : [];
      subId = w?.id ?? null;
      if (!subId) return sent;
    }
    if (!subId) throw badRequest("Provide sub_workspace_id or the email of a workspace owner");
    if (subId === c.wsId) {
      if (byEmail) return sent;
      throw badRequest("A workspace can't manage itself");
    }
    const [sub] = await db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, subId), isNull(schema.workspaces.deletedAt)))
      .limit(1);
    if (!sub) throw notFound("Workspace");
    // A workspace the caller also runs is added at once; anyone else's owner is asked.
    const callerRunsIt = !!req.auth.user && (await managesWorkspace(req.auth.user.id, subId));
    const status = callerRunsIt ? "accepted" : "pending";
    const G = schema.workspaceGroupMembers;
    const [existing] = await db
      .select()
      .from(G)
      .where(and(eq(G.adminWorkspaceId, c.wsId), eq(G.subWorkspaceId, subId)))
      .limit(1);
    // A declined invitation isn't sent again unless the caller runs that workspace too; one already accepted stays so.
    if (existing && (existing.status === "accepted" || (existing.status === "rejected" && !callerRunsIt))) {
      return byEmail ? sent : serializeGroup(existing, c.wsId);
    }
    const token = randomToken(24);
    const [g] = await db
      .insert(G)
      .values({ adminWorkspaceId: c.wsId, subWorkspaceId: subId, status, inviteTokenHash: sha256(token) })
      .onConflictDoUpdate({ target: [G.adminWorkspaceId, G.subWorkspaceId], set: { status, inviteTokenHash: sha256(token) } })
      .returning();
    if (status === "pending") {
      const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, sub.ownerId)).limit(1);
      if (owner) {
        const url = `${config.webUrl}/workspace-group-invitation/${encodeURIComponent(token)}`;
        const m = systemMailLayout("Workspace group invitation", [`<b>${c.workspace.name}</b> wants to manage your workspace <b>${sub.name}</b>.`], {
          label: "Review invitation",
          url,
        });
        await sendSystemMail({ to: owner.email, subject: `${c.workspace.name} invited ${sub.name} to a workspace group`, ...m });
      }
    }
    return byEmail ? sent : serializeGroup(g!, c.wsId);
  });

  app.get("/api/app/workspace-group-invitations/:token", { config: { auth: "public" } }, async (req) => {
    const { token } = req.params as { token: string };
    const [g] = await db.select().from(schema.workspaceGroupMembers).where(eq(schema.workspaceGroupMembers.inviteTokenHash, sha256(token))).limit(1);
    if (!g) throw notFound("Invitation");
    // The link went to the invited workspace's owner, who sees both names.
    return serializeGroup(g, g.subWorkspaceId);
  });

  app.post("/api/app/workspace-group-invitations/:token/respond", { config: { auth: "user" } }, async (req) => {
    const { token } = req.params as { token: string };
    const b = body(req, z.object({ accept: z.boolean() }));
    const [g] = await db.select().from(schema.workspaceGroupMembers).where(eq(schema.workspaceGroupMembers.inviteTokenHash, sha256(token))).limit(1);
    if (!g) throw notFound("Invitation");
    const [m] = await db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, g.subWorkspaceId), eq(schema.workspaceMembers.userId, ctx(req).user.id)))
      .limit(1);
    if (!m || (m.role !== "owner" && m.role !== "admin")) throw forbidden("Only admins of the invited workspace can respond");
    await db
      .update(schema.workspaceGroupMembers)
      .set({ status: b.accept ? "accepted" : "rejected", inviteTokenHash: null })
      .where(eq(schema.workspaceGroupMembers.id, g.id));
    return { ok: true };
  });

  /** The same answer as the emailed link, given from the invited workspace's settings. */
  app.post("/api/app/workspace-group-members/:id/respond", { config: { auth: "workspace", admin: true } }, async (req) => {
    const { id } = req.params as { id: string };
    const b = body(req, z.object({ accept: z.boolean() }));
    const c = ctx(req);
    const [g] = await db.select().from(schema.workspaceGroupMembers).where(eq(schema.workspaceGroupMembers.id, id)).limit(1);
    if (!g || g.subWorkspaceId !== c.wsId) throw notFound("Invitation");
    if (g.status !== "pending") throw badRequest("This invitation was already answered");
    const [updated] = await db
      .update(schema.workspaceGroupMembers)
      .set({ status: b.accept ? "accepted" : "rejected", inviteTokenHash: null })
      .where(eq(schema.workspaceGroupMembers.id, g.id))
      .returning();
    return serializeGroup(updated!, c.wsId);
  });

  app.delete("/api/v2/workspace-group-members/:id", { config: { scope: ["workspace_group_members", "delete"], admin: true } }, async (req) => {
    const { id } = req.params as { id: string };
    const c = ctx(req);
    const [g] = await db.select().from(schema.workspaceGroupMembers).where(eq(schema.workspaceGroupMembers.id, id)).limit(1);
    if (!g || (g.adminWorkspaceId !== c.wsId && g.subWorkspaceId !== c.wsId)) throw notFound("Workspace group member");
    await db.delete(schema.workspaceGroupMembers).where(eq(schema.workspaceGroupMembers.id, id));
    // The managing workspace's admins lose the seats they took there through the group.
    await removeEnteredSeats(`agency:${g.adminWorkspaceId}`, { workspaceId: g.subWorkspaceId });
    return serializeGroup(g, c.wsId);
  });

  /** Sub-workspaces an agency admin can jump into (adds the admin user as a member on first use). */
  app.post("/api/app/workspace-groups/:subId/enter", { config: { auth: "workspace", admin: true } }, async (req) => {
    const { subId } = req.params as { subId: string };
    const c = ctx(req);
    const [g] = await db
      .select()
      .from(schema.workspaceGroupMembers)
      .where(and(eq(schema.workspaceGroupMembers.adminWorkspaceId, c.wsId), eq(schema.workspaceGroupMembers.subWorkspaceId, subId), eq(schema.workspaceGroupMembers.status, "accepted")))
      .limit(1);
    if (!g) throw notFound("Managed workspace");
    const user = c.user;
    // Marked as taken through the group, so it goes when the group link (or their place here) does.
    await db
      .insert(schema.workspaceMembers)
      .values({ workspaceId: subId, userId: user.id, email: user.email, role: "admin", accepted: true, issuerId: user.id, enteredVia: `agency:${c.wsId}` })
      .onConflictDoNothing();
    await db.update(schema.sessions).set({ currentWorkspaceId: subId }).where(eq(schema.sessions.id, req.auth.session!.id));
    return { ok: true };
  });

  // ---------- API v2: API keys ----------
  app.get("/api/v2/api-keys", { config: { scope: ["api_keys", "read"], admin: true } }, async (req) => {
    const q = query(req, pageQuery);
    const { limit, startingAfter } = pageInfo(q, 100);
    const conds = [eq(schema.apiKeys.workspaceId, ctx(req).wsId)];
    if (startingAfter) conds.push(lt(schema.apiKeys.id, startingAfter));
    const rows = await db.select().from(schema.apiKeys).where(and(...conds)).orderBy(desc(schema.apiKeys.id)).limit(limit + 1);
    const creatorIds = [...new Set(rows.map((k) => k.createdBy).filter((x): x is string => !!x))];
    const creators = creatorIds.length
      ? await db.select({ id: schema.users.id, f: schema.users.firstName, l: schema.users.lastName, e: schema.users.email }).from(schema.users).where(inArray(schema.users.id, creatorIds))
      : [];
    const stillManage = new Map(await Promise.all(creatorIds.map(async (id) => [id, await managesWorkspace(id, ctx(req).wsId)] as const)));
    return paginated(
      rows.map((k) => {
        const u = creators.find((x) => x.id === k.createdBy);
        return {
          id: k.id,
          name: k.name,
          scopes: k.scopes,
          key: `${k.keyPrefix}••••••••`,
          organization_id: k.workspaceId,
          timestamp_created: iso(k.createdAt),
          timestamp_updated: iso(k.updatedAt),
          last_used_at: iso(k.lastUsedAt),
          created_by: u ? { id: u.id, name: [u.f, u.l].filter(Boolean).join(" ") || u.e } : null,
          // A key stops working once the person who made it no longer manages the workspace.
          active: !k.createdBy || (stillManage.get(k.createdBy) ?? false),
        };
      }),
      limit,
    );
  });

  app.post("/api/v2/api-keys", { config: { scope: ["api_keys", "create"], admin: true } }, async (req) => {
    const b = body(req, z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.string()).min(1) }));
    const c = ctx(req);
    for (const s of b.scopes) {
      if (!/^[a-z_-]+:(all|create|read|update|delete)$/.test(s)) throw badRequest(`Invalid scope: ${s}`);
    }
    // A key (or app) creating keys can't hand out more than it has itself.
    const granted = c.auth.via === "api_key" || c.auth.via === "oauth" ? (c.auth.scopes ?? []) : null;
    const beyond = granted ? b.scopes.filter((s) => !scopeCovers(granted, s)) : [];
    if (beyond.length) throw forbidden(`This API key can't create a key with ${beyond.join(", ")}: it doesn't have that access itself`);
    const raw = `rs_${randomToken(30)}`;
    const [k] = await db
      .insert(schema.apiKeys)
      // A key made by another key belongs to the same person, so it stops with theirs.
      .values({ workspaceId: c.wsId, name: b.name, keyHash: sha256(raw), keyPrefix: raw.slice(0, 10), scopes: b.scopes, createdBy: c.userId ?? c.auth.apiKey?.createdBy ?? null })
      .returning();
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.API_KEY_CREATED, req, metadata: { name: b.name } });
    return { id: k!.id, name: k!.name, scopes: k!.scopes, key: raw, organization_id: c.wsId, timestamp_created: iso(k!.createdAt), timestamp_updated: iso(k!.updatedAt) };
  });

  app.delete("/api/v2/api-keys/:id", { config: { scope: ["api_keys", "delete"], admin: true } }, async (req) => {
    const { id } = req.params as { id: string };
    const c = ctx(req);
    const [k] = await db.delete(schema.apiKeys).where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.workspaceId, c.wsId))).returning();
    if (!k) throw notFound("API key");
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.API_KEY_DELETED, req, metadata: { name: k.name } });
    return { id: k.id, name: k.name, scopes: k.scopes };
  });

  // ---------- API v2: audit logs ----------
  app.get("/api/v2/audit-logs", { config: { scope: ["audit_logs", "read"], admin: true } }, async (req) => {
    const q = query(
      req,
      pageQuery.extend({ activity_type: zInt().optional(), start_date: z.string().optional(), end_date: z.string().optional() }),
    );
    const c = ctx(req);
    const { limit, startingAfter } = pageInfo(q, 50);
    const conds = [eq(schema.auditLogs.workspaceId, c.wsId)];
    if (q.activity_type !== undefined) conds.push(eq(schema.auditLogs.activityType, q.activity_type));
    // Whole days on the workspace's clock.
    const range = await workspaceRange(c.wsId, q.start_date, q.end_date?.slice(0, 10));
    if (range.start !== undefined) conds.push(gte(schema.auditLogs.createdAt, new Date(range.start)));
    if (range.end !== undefined) conds.push(lte(schema.auditLogs.createdAt, new Date(range.end)));
    if (q.search) conds.push(or(contains(schema.auditLogs.userName, q.search), contains(schema.auditLogs.ipAddress, q.search))!);
    if (startingAfter) conds.push(lt(schema.auditLogs.id, startingAfter));
    const rows = await db.select().from(schema.auditLogs).where(and(...conds)).orderBy(desc(schema.auditLogs.id)).limit(limit + 1);
    return paginated(
      rows.map((r) => ({
        id: r.id,
        timestamp: iso(r.createdAt),
        organization_id: r.workspaceId,
        activity_type: r.activityType,
        user_agent: r.userAgent,
        user_id: r.userId,
        ip_address: r.ipAddress,
        from_api: r.fromApi,
        api_key_id: r.apiKeyId,
        affected_count: r.affectedCount,
        campaign_id: r.campaignId,
        webhook_id: r.webhookId,
        subsequence_id: r.subsequenceId,
        list_id: r.listId,
        audit_metadata: r.metadata ?? {},
        user_name: r.userName,
      })),
      limit,
    );
  });

  // ---------- Superadmin helpers for self-hosted installs ----------
  app.get("/api/app/system/mail-log", { config: { auth: "user" } }, async (req) => {
    // On a self-hosted install without SMTP, the owner can read system mails (verification links).
    await requireOwner(ctx(req).user);
    const { systemMailLog } = await import("../services/system-mail");
    return systemMailLog;
  });
}

/** What clients and view-only members see of a teammate: who they are, not how to reach them or their role. */
function teammate(m: typeof schema.workspaceMembers.$inferSelect, user?: typeof schema.users.$inferSelect | null) {
  return { id: m.id, user_id: m.userId, email: null, name: { first: user?.firstName ?? "", last: user?.lastName ?? "" }, accepted: true, workspace_id: m.workspaceId };
}

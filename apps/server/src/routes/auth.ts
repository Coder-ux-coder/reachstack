import { randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import QRCode from "qrcode";
import { AuditActivity, escapeHtml, isValidEmailSyntax, type Me, type Role } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { ANY_WORKSPACE, createSession, defaultWorkspaceId, destroySession, SESSION_COOKIE } from "../http/auth";
import { ctx, type User } from "../http/context";
import { badRequest, conflict, forbidden, HttpError, unauthorized } from "../http/errors";
import { assertFewFailures, clearFailures, noteFailure, rateLimit } from "../http/rate-limit";
import { body, clientIp } from "../http/util";
import { decrypt, encrypt, hashPassword, verifyPassword } from "../lib/crypto";
import { sha256 } from "../lib/ids";
import { iso, isValidZone } from "../lib/time";
import { generateRecoveryCodes, generateTotpSecret, otpauthUri, verifyTotp } from "../lib/totp";
import { aiConfigured } from "../services/ai";
import { audit } from "../services/audit";
import { consumeToken, issueToken } from "../services/auth-tokens";
import { agencyBrand, effectivePermissions, productBrand } from "../services/branding";
import { assertSignupAllowed, getInstallationSettings } from "../services/installation";
import { forgetOwnerCache, getOwnerId, isInstanceAdmin } from "../services/instance";
import { sendSystemMail, systemMailLayout } from "../services/system-mail";
import { reachableFromInternet } from "../services/tracking";
import { createWorkspace, listUserWorkspaces, publicSettings, serializeUser } from "../services/workspaces";
import { forgetStoppedWorkspaces } from "../services/live-workspaces";
import { inviteExpired, releaseMember } from "../services/members";

const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(128, "Enter a password with no more than 128 characters");

export async function sendVerificationEmail(user: User) {
  const token = await issueToken("email_verify", { userId: user.id, email: user.email, ttlMs: 7 * 86_400_000 });
  const url = `${config.webUrl}/auth/verify?token=${encodeURIComponent(token)}`;
  const m = systemMailLayout("Confirm your email", [`Hi ${user.firstName || "there"},`, `Please confirm your email address to finish setting up ${config.brandName}.`], {
    label: "Confirm email",
    url,
  });
  await sendSystemMail({ to: user.email, subject: `Confirm your email for ${config.brandName}`, ...m });
}

/** Builds the "me" payload consumed by the SPA. */
export async function buildMe(req: FastifyRequest): Promise<Me & Record<string, unknown>> {
  const a = req.auth;
  const user = a.user!;
  const workspaces = await listUserWorkspaces(user.id);
  const ws = a.workspace;
  const features = {
    ai: aiConfigured() || !!(ws?.settings as Record<string, unknown> | null)?.anthropic_api_key_enc,
    google_oauth: !!config.google.clientId,
    microsoft_oauth: !!config.microsoft.clientId,
    stripe: !!config.stripe.secretKey,
    twilio: !!config.twilio.accountSid,
    ipinfo: !!config.ipinfoToken,
    system_smtp: !!config.systemSmtp.host,
    instance_admin: await isInstanceAdmin(user),
    owner: (await getOwnerId()) === user.id,
    /** Whether people who get an email can reach this server's tracking and unsubscribe links (not on a laptop). */
    tracking_reachable: reachableFromInternet(config.trackingBaseUrl),
  };
  return {
    user: { ...serializeUser(user), timezone: user.timezone ?? null, theme: user.theme ?? null } as Me["user"],
    workspace: ws
      ? {
          id: ws.id,
          name: ws.name,
          owner: ws.ownerId,
          logo_url: ws.logoUrl,
          plan_ids: ws.planIds ?? {},
          self_hosted: ws.selfHosted,
          trial_ends_at: iso(ws.trialEndsAt),
          settings: publicSettings(ws),
        }
      : null,
    membership: a.member ? { role: a.member.role as Role, permissions: effectivePermissions(ws, a.member) } : null,
    workspaces,
    features,
    brand: ((a.session?.isClientPortal || a.member?.role === "client") && agencyBrand(ws)) || productBrand(),
    session: {
      client_portal: a.session?.isClientPortal ?? false,
      mfa_pending: a.session?.mfaPending ?? false,
      /** What the current workspace still asks first: two-step authentication, or a fresh code. */
      workspace_gate: a.gate,
    },
    /** Product areas the owner switched on for everyone. */
    modules: (await getInstallationSettings()).modules,
  };
}

/** Tells someone by email that their sign-in settings changed, in case it wasn't them. */
async function securityNotice(user: User, title: string, line: string) {
  const m = systemMailLayout(title, [line, "If you didn't do this, reset your password and contact the owner of this installation."]);
  await sendSystemMail({ to: user.email, subject: `${title} (${config.brandName})`, ...m }).catch(() => undefined);
}

// Wrong passwords for one account from anywhere: after this many in an hour, that account's sign-in waits.
const ACCOUNT_FAILURES = 30;
const failureKey = (email: string) => `login:${email}`;

async function finishLogin(req: FastifyRequest, reply: FastifyReply, user: User, opts: { clientPortal?: boolean } = {}) {
  const wsId = await defaultWorkspaceId(user);
  const session = await createSession(reply, req, user.id, { workspaceId: wsId, mfaPending: user.totpEnabled, clientPortal: opts.clientPortal });
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  if (wsId && !user.totpEnabled) {
    await audit({ workspaceId: wsId, activityType: AuditActivity.USER_LOGIN, req, userId: user.id });
  }
  return { mfa_required: user.totpEnabled, session_id: session.id };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post("/api/app/auth/signup", { config: { auth: "public" } }, async (req, reply) => {
    const b = body(
      req,
      z.object({
        email: z.string().trim().toLowerCase(),
        password: passwordSchema,
        first_name: z.string().trim().max(80).default(""),
        last_name: z.string().trim().max(80).default(""),
        workspace_name: z.string().trim().max(120).optional(),
        /** The browser's time zone, for the new workspace's clock (ignored when it isn't one). */
        timezone: z.string().max(80).optional(),
        invite_token: z.string().optional(),
        partner: z.string().max(80).optional(),
        client_portal: z.boolean().optional(),
      }),
    );
    rateLimit(`signup:${clientIp(req)}`, 20);
    if (!isValidEmailSyntax(b.email)) throw badRequest("Please enter a valid email address");
    const [invite] = b.invite_token
      ? await db
          .select()
          .from(schema.workspaceMembers)
          .where(and(eq(schema.workspaceMembers.inviteTokenHash, sha256(b.invite_token)), eq(schema.workspaceMembers.accepted, false)))
          .limit(1)
      : [];
    const member = invite && invite.email === b.email ? invite : null;
    if (member && inviteExpired(member)) throw new HttpError(410, "This invitation has expired. Ask the workspace admin to send it again.", "invitation_expired");
    // Checked first, so a closed installation doesn't tell strangers which emails have accounts.
    await assertSignupAllowed(!!member);
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, b.email)).limit(1);
    if (existing) throw conflict("An account with this email already exists. Please log in instead.");

    const [user] = await db
      .insert(schema.users)
      .values({
        email: b.email,
        passwordHash: await hashPassword(b.password),
        firstName: b.first_name,
        lastName: b.last_name,
        referralPartner: b.partner ?? null,
        onboarding: {},
      })
      .returning();

    // On a fresh install the first account becomes the installation owner before its workspace is made.
    forgetOwnerCache();
    await getOwnerId();

    let workspaceId: string | null = null;
    if (member) {
      await db
        .update(schema.workspaceMembers)
        .set({ userId: user!.id, accepted: true, inviteTokenHash: null })
        .where(eq(schema.workspaceMembers.id, member.id));
      workspaceId = member.workspaceId;
      // Invited users already proved access to the inbox.
      await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user!.id));
    }
    if (!workspaceId && !b.client_portal) {
      const ws = await createWorkspace(user!, b.workspace_name || `${b.first_name || b.email.split("@")[0]}'s Workspace`, { timezone: b.timezone });
      workspaceId = ws.id;
    }
    await createSession(reply, req, user!.id, { workspaceId, clientPortal: b.client_portal });
    if (!b.invite_token) await sendVerificationEmail(user!).catch(() => undefined);
    return { ok: true };
  });

  app.post("/api/app/auth/login", { config: { auth: "public" } }, async (req, reply) => {
    const b = body(req, z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1), client_portal: z.boolean().optional() }));
    rateLimit(`login:${clientIp(req)}:${b.email}`);
    // The limit above is per address; this one holds for the account however many addresses guess at it.
    assertFewFailures(failureKey(b.email), ACCOUNT_FAILURES, "Too many failed sign-ins for this account. Try again in an hour, or reset your password.");
    const [user] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.email, b.email), isNull(schema.users.deletedAt)))
      .limit(1);
    if (!user || !(await verifyPassword(b.password, user.passwordHash))) {
      noteFailure(failureKey(b.email));
      throw unauthorized("Invalid email or password");
    }
    if (user.disabledAt) throw new HttpError(403, "This account is turned off. Ask the owner of this installation to turn it back on.", "account_disabled");
    if (b.client_portal) {
      const ws = await listUserWorkspaces(user.id);
      if (!ws.some((w) => w.role === "client")) throw forbidden("This account does not have client portal access");
    }
    return finishLogin(req, reply, user, { clientPortal: b.client_portal });
  });

  app.post("/api/app/auth/mfa/verify", { config: { auth: "mfa" } }, async (req) => {
    const b = body(req, z.object({ code: z.string().optional(), recovery_code: z.string().optional() }));
    const a = req.auth;
    const user = a.user!;
    if (!a.session?.mfaPending) return { ok: true };
    rateLimit(`mfa:${user.id}`, 8);
    const secret = decrypt(user.totpSecretEnc);
    const wsId = a.session.currentWorkspaceId;
    let ok = false;
    if (b.code && secret) ok = verifyTotp(secret, b.code);
    if (!ok && b.recovery_code) {
      const hashed = sha256(b.recovery_code.trim().toLowerCase());
      const codes = user.recoveryCodes ?? [];
      if (codes.includes(hashed)) {
        ok = true;
        await db
          .update(schema.users)
          .set({ recoveryCodes: codes.filter((c) => c !== hashed) })
          .where(eq(schema.users.id, user.id));
        if (wsId) await audit({ workspaceId: wsId, activityType: AuditActivity.MFA_RECOVERY_USED, req, userId: user.id });
      }
    }
    if (!ok) {
      if (wsId) await audit({ workspaceId: wsId, activityType: AuditActivity.MFA_CHALLENGE_FAILED, req, userId: user.id });
      throw badRequest("Invalid verification code");
    }
    // The code just entered also counts as a fresh one for workspaces that ask again every few hours.
    await db
      .update(schema.sessions)
      .set({ mfaPending: false, workspaceReauth: { ...(a.session.workspaceReauth ?? {}), [ANY_WORKSPACE]: Date.now() } })
      .where(eq(schema.sessions.id, a.session.id));
    if (wsId) {
      await audit({ workspaceId: wsId, activityType: AuditActivity.MFA_LOGIN_SUCCEEDED, req, userId: user.id });
      await audit({ workspaceId: wsId, activityType: AuditActivity.USER_LOGIN, req, userId: user.id });
    }
    return { ok: true };
  });

  app.post("/api/app/auth/logout", { config: { auth: "public" } }, async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get("/api/app/auth/me", { config: { auth: "user" } }, async (req) => buildMe(req));

  app.post("/api/app/auth/verify-email", { config: { auth: "public" } }, async (req) => {
    const b = body(req, z.object({ token: z.string().min(10) }));
    const row = await consumeToken("email_verify", b.token);
    if (!row?.userId) throw badRequest("This verification link is invalid or has expired");
    await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, row.userId));
    return { ok: true };
  });

  app.post("/api/app/auth/resend-verification", { config: { auth: "user" } }, async (req) => {
    const user = ctx(req).user;
    rateLimit(`verify:${user.id}`, 5, 60 * 60_000);
    if (user.emailVerifiedAt) return { ok: true, already_verified: true };
    await sendVerificationEmail(user);
    // Without system email the link only reaches the owner's System emails list (Settings → Installation).
    return { ok: true, emailed: !!config.systemSmtp.host };
  });

  app.post("/api/app/auth/password-reset/request", { config: { auth: "public" } }, async (req) => {
    const b = body(req, z.object({ email: z.string().trim().toLowerCase() }));
    rateLimit(`reset:${clientIp(req)}`, 10, 60 * 60_000);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, b.email)).limit(1);
    if (user) {
      const token = await issueToken("password_reset", { userId: user.id, ttlMs: 60 * 60_000 });
      const url = `${config.webUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;
      const m = systemMailLayout("Reset your password", ["We received a request to reset your password. This link is valid for 1 hour.", "If you didn't request this you can ignore this email."], {
        label: "Choose a new password",
        url,
      });
      await sendSystemMail({ to: user.email, subject: `Reset your ${config.brandName} password`, ...m });
    }
    return { ok: true };
  });

  app.post("/api/app/auth/password-reset/confirm", { config: { auth: "public" } }, async (req) => {
    const b = body(req, z.object({ token: z.string().min(10), password: passwordSchema }));
    const row = await consumeToken("password_reset", b.token);
    if (!row?.userId) throw badRequest("This reset link is invalid or has expired");
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
    // The link reached the inbox, which proves the address. Google or Microsoft sign-ins linked without the provider
    // vouching for it may belong to someone else who set the account up first, so they go.
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(b.password), ...(user && !user.emailVerifiedAt ? { emailVerifiedAt: new Date() } : {}) })
      .where(eq(schema.users.id, row.userId));
    await db.delete(schema.oauthIdentities).where(and(eq(schema.oauthIdentities.userId, row.userId), eq(schema.oauthIdentities.verified, false)));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, row.userId));
    if (user) clearFailures(failureKey(user.email));
    return { ok: true };
  });

  app.post("/api/app/auth/change-password", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ current_password: z.string().optional(), new_password: passwordSchema }));
    const user = ctx(req).user;
    rateLimit(`password-check:${user.id}`, 10);
    if (user.passwordHash && !(await verifyPassword(b.current_password ?? "", user.passwordHash))) {
      throw badRequest("Your current password is incorrect");
    }
    await db.update(schema.users).set({ passwordHash: await hashPassword(b.new_password) }).where(eq(schema.users.id, user.id));
    await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, user.id), ne(schema.sessions.id, req.auth.session!.id)));
    return { ok: true };
  });

  app.post("/api/app/auth/change-email/send-code", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ new_email: z.string().trim().toLowerCase(), current_password: z.string().optional() }));
    const user = ctx(req).user;
    if (!isValidEmailSyntax(b.new_email)) throw badRequest("Please enter a valid email address");
    rateLimit(`email-change:${user.id}`, 5, 60 * 60_000);
    // Whoever holds an open session can't move the account to their own address without the password.
    if (user.passwordHash && !(await verifyPassword(b.current_password ?? "", user.passwordHash))) throw badRequest("Your current password is incorrect");
    const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, b.new_email)).limit(1);
    if (taken) throw conflict("This email is already in use");
    const code = String(randomInt(100000, 1000000));
    await db.insert(schema.authTokens).values({
      type: "email_change",
      userId: user.id,
      email: b.new_email,
      tokenHash: sha256(`${user.id}:${code}`),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const m = systemMailLayout("Confirm your new email", [`Your verification code is <b>${code}</b>. It expires in 30 minutes.`]);
    await sendSystemMail({ to: b.new_email, subject: `${config.brandName} verification code: ${code}`, ...m });
    return { ok: true };
  });

  app.post("/api/app/auth/change-email/verify", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ code: z.string().trim() }));
    const user = ctx(req).user;
    rateLimit(`email-change-verify:${user.id}`, 10);
    // The token hash is sha256("<userId>:<code>"), so the code is only valid for the user who requested it.
    const row = await consumeToken("email_change", `${user.id}:${b.code}`);
    if (!row?.email) throw badRequest("Invalid or expired code");
    const email = row.email;
    // Someone may have signed up with that address since the code was sent.
    const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (taken) throw conflict("This email is already in use");
    const M = schema.workspaceMembers;
    await db.transaction(async (tx) => {
      // An invitation to the new address in a workspace they're already in would clash with their membership there.
      const mine = await tx.select({ ws: M.workspaceId }).from(M).where(eq(M.userId, user.id));
      if (mine.length) await tx.delete(M).where(and(inArray(M.workspaceId, mine.map((m) => m.ws)), eq(M.email, email), eq(M.accepted, false)));
      await tx.update(schema.users).set({ email, emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
      await tx.update(M).set({ email }).where(eq(M.userId, user.id));
      // Other sessions end, and the old address hears about it in case it wasn't them.
      await tx.delete(schema.sessions).where(and(eq(schema.sessions.userId, user.id), ne(schema.sessions.id, req.auth.session!.id)));
    });
    const notice = systemMailLayout("Your sign-in email changed", [
      `The email address for your ${config.brandName} account is now <b>${escapeHtml(row.email)}</b>.`,
      "If you didn't make this change, reset your password and contact the owner of this installation.",
    ]);
    await sendSystemMail({ to: user.email, subject: `Your ${config.brandName} sign-in email changed`, ...notice }).catch(() => undefined);
    return { ok: true, email: row.email };
  });

  app.patch("/api/app/auth/profile", { config: { auth: "user" } }, async (req) => {
    const b = body(
      req,
      z.object({
        first_name: z.string().trim().max(80).optional(),
        last_name: z.string().trim().max(80).optional(),
        avatar_url: z.string().max(500_000).nullable().optional(),
        phone: z.string().max(40).nullable().optional(),
        timezone: z.string().max(80).refine(isValidZone, "Unknown timezone").nullable().optional(),
        language: z.string().max(10).optional(),
        theme: z.enum(["light", "dark", "system"]).optional(),
        preferences: z.record(z.unknown()).optional(),
      }),
    );
    const user = ctx(req).user;
    const [updated] = await db
      .update(schema.users)
      .set({
        ...(b.first_name !== undefined ? { firstName: b.first_name } : {}),
        ...(b.last_name !== undefined ? { lastName: b.last_name } : {}),
        ...(b.avatar_url !== undefined ? { avatarUrl: b.avatar_url } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.timezone !== undefined ? { timezone: b.timezone } : {}),
        ...(b.language !== undefined ? { language: b.language } : {}),
        ...(b.theme !== undefined ? { theme: b.theme } : {}),
        ...(b.preferences !== undefined ? { preferences: { ...(user.preferences ?? {}), ...b.preferences } } : {}),
      })
      .where(eq(schema.users.id, user.id))
      .returning();
    return serializeUser(updated!);
  });

  app.post("/api/app/auth/onboarding", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ answers: z.record(z.unknown()).default({}), completed: z.boolean().optional() }));
    const user = ctx(req).user;
    await db
      .update(schema.users)
      .set({
        onboarding: { ...(user.onboarding ?? {}), ...b.answers },
        ...(b.completed !== undefined ? { onboardingCompleted: b.completed } : {}),
      })
      .where(eq(schema.users.id, user.id));
    return { ok: true };
  });

  // ---- Two-step authentication management ----
  app.post("/api/app/auth/mfa/setup", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ password: z.string().optional() }));
    const user = ctx(req).user;
    if (user.totpEnabled) throw badRequest("Two-step authentication is already on. Turn it off first to move it to another authenticator app.");
    // Someone with only an open session can't lock the owner of the account out with an authenticator of their own.
    if (user.passwordHash) {
      rateLimit(`mfa-setup:${user.id}`, 10);
      if (!(await verifyPassword(b.password ?? "", user.passwordHash))) throw badRequest("Your password is incorrect");
    }
    const secret = generateTotpSecret();
    await db.update(schema.users).set({ totpPendingSecretEnc: encrypt(secret) }).where(eq(schema.users.id, user.id));
    const uri = otpauthUri(secret, user.email, config.brandName);
    const wsId = req.auth.workspace?.id;
    if (wsId) await audit({ workspaceId: wsId, activityType: AuditActivity.TOTP_ENROLL_STARTED, req });
    return { secret, otpauth_uri: uri, qr_data_url: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  });

  app.post("/api/app/auth/mfa/enable", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ code: z.string() }));
    const user = ctx(req).user;
    if (user.totpEnabled) throw badRequest("Two-step authentication is already on.");
    const pending = decrypt(user.totpPendingSecretEnc);
    if (!pending) throw badRequest("Start the setup first");
    rateLimit(`mfa-enable:${user.id}`, 10);
    if (!verifyTotp(pending, b.code)) throw badRequest("Invalid verification code");
    const codes = generateRecoveryCodes();
    await db
      .update(schema.users)
      .set({ totpSecretEnc: encrypt(pending), totpPendingSecretEnc: null, totpEnabled: true, recoveryCodes: codes.map((c) => sha256(c)) })
      .where(eq(schema.users.id, user.id));
    // Sessions that never gave a code end; this one just did, which also counts as a fresh code everywhere.
    const session = req.auth.session!;
    await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, user.id), ne(schema.sessions.id, session.id)));
    await db
      .update(schema.sessions)
      .set({ workspaceReauth: { ...(session.workspaceReauth ?? {}), [ANY_WORKSPACE]: Date.now() } })
      .where(eq(schema.sessions.id, session.id));
    const wsId = req.auth.workspace?.id;
    if (wsId) await audit({ workspaceId: wsId, activityType: AuditActivity.TOTP_ENABLED, req });
    await securityNotice(user, "Two-step authentication is on", `Signing in to ${config.brandName} now also asks for a code from your authenticator app. Other devices were signed out.`);
    return { recovery_codes: codes };
  });

  app.post("/api/app/auth/mfa/disable", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ code: z.string().optional(), password: z.string().optional() }));
    const user = ctx(req).user;
    rateLimit(`mfa-off:${user.id}`, 8);
    const secret = decrypt(user.totpSecretEnc);
    const ok = (b.code && secret && verifyTotp(secret, b.code)) || (b.password && (await verifyPassword(b.password, user.passwordHash)));
    if (!ok) throw badRequest("Invalid code or password");
    await db
      .update(schema.users)
      .set({ totpEnabled: false, totpSecretEnc: null, totpPendingSecretEnc: null, recoveryCodes: null })
      .where(eq(schema.users.id, user.id));
    const wsId = req.auth.workspace?.id;
    if (wsId) await audit({ workspaceId: wsId, activityType: AuditActivity.TOTP_DISABLED, req });
    if (user.totpEnabled) await securityNotice(user, "Two-step authentication is off", `Signing in to ${config.brandName} no longer asks for a code from your authenticator app.`);
    return { ok: true };
  });

  app.post("/api/app/auth/mfa/recovery-codes", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ code: z.string() }));
    const user = ctx(req).user;
    const secret = decrypt(user.totpSecretEnc);
    if (!user.totpEnabled || !secret || !verifyTotp(secret, b.code)) throw badRequest("Invalid verification code");
    const codes = generateRecoveryCodes();
    await db.update(schema.users).set({ recoveryCodes: codes.map((c) => sha256(c)) }).where(eq(schema.users.id, user.id));
    const wsId = req.auth.workspace?.id;
    if (wsId) await audit({ workspaceId: wsId, activityType: AuditActivity.MFA_RECOVERY_GENERATED, req });
    return { recovery_codes: codes };
  });

  // ---- Sessions ----
  app.get("/api/app/auth/sessions", { config: { auth: "user" } }, async (req) => {
    const user = ctx(req).user;
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, user.id), gt(schema.sessions.expiresAt, new Date())))
      .orderBy(desc(schema.sessions.lastSeenAt));
    const current = req.cookies?.[SESSION_COOKIE] ? sha256(req.cookies[SESSION_COOKIE]!) : null;
    return rows.map((s) => ({
      id: s.id,
      ip: s.ip,
      user_agent: s.userAgent,
      created_at: iso(s.createdAt),
      last_seen_at: iso(s.lastSeenAt),
      current: s.tokenHash === current,
    }));
  });

  app.delete("/api/app/auth/sessions/:id", { config: { auth: "user" } }, async (req) => {
    const user = ctx(req).user;
    const { id } = req.params as { id: string };
    await db.delete(schema.sessions).where(and(eq(schema.sessions.id, id), eq(schema.sessions.userId, user.id)));
    return { ok: true };
  });

  app.delete("/api/app/auth/account", { config: { auth: "user" } }, async (req, reply) => {
    const b = body(req, z.object({ password: z.string().optional(), confirm: z.literal("DELETE") }));
    const user = ctx(req).user;
    rateLimit(`delete-account:${user.id}`, 8);
    if (user.passwordHash && !(await verifyPassword(b.password ?? "", user.passwordHash))) throw badRequest("Incorrect password");
    // Deleting the owner would hand the installation to the next oldest account.
    if ((await getOwnerId()) === user.id) {
      const [other] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(isNull(schema.users.deletedAt), ne(schema.users.id, user.id)))
        .limit(1);
      if (other) throw badRequest("You own this installation. Make someone else the owner (Settings → Installation) before deleting your account.");
    }
    const owned = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.ownerId, user.id), isNull(schema.workspaces.deletedAt)));
    for (const w of owned) {
      const others = await db
        .select({ id: schema.workspaceMembers.id })
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, w.id), ne(schema.workspaceMembers.userId, user.id), eq(schema.workspaceMembers.accepted, true)))
        .limit(1);
      if (others.length) throw badRequest("Transfer ownership of your shared workspaces before deleting your account");
      await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, w.id));
    }
    await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, user.id));
    await releaseMember(user.id);
    await db
      .update(schema.users)
      .set({ deletedAt: new Date(), email: `deleted+${user.id}@invalid.local`, passwordHash: null })
      .where(eq(schema.users.id, user.id));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
    forgetStoppedWorkspaces();
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---- Workspace re-authentication (when workspace security requires a fresh code) ----
  app.post("/api/app/auth/workspace-reauth", { config: { auth: "user" } }, async (req) => {
    const b = body(req, z.object({ workspace_id: z.string(), code: z.string() }));
    const user = ctx(req).user;
    rateLimit(`reauth:${user.id}`, 8);
    const secret = decrypt(user.totpSecretEnc);
    if (!secret || !verifyTotp(secret, b.code)) throw badRequest("Invalid verification code");
    const session = req.auth.session!;
    const reauth = { ...(session.workspaceReauth ?? {}), [b.workspace_id]: Date.now() };
    await db.update(schema.sessions).set({ workspaceReauth: reauth }).where(eq(schema.sessions.id, session.id));
    return { ok: true };
  });
}

export { issueToken, consumeToken, rateLimit };

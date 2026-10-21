// OAuth callbacks for Google / Microsoft: connecting mailboxes and "Continue with Google/Microsoft" sign-in.
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { createSession, defaultWorkspaceId } from "../http/auth";
import { params, query } from "../http/util";
import { bindToBrowser, buildAuthUrl, cameBackToSameBrowser, exchangeCode, readState, type OAuthProvider } from "../mail/oauth";
import { upsertOAuthAccount } from "../services/account-connect";
import { audit } from "../services/audit";
import { createWorkspace, ianaZone } from "../services/workspaces";
import { assertSignupAllowed } from "../services/installation";
import { forgetOwnerCache, getOwnerId } from "../services/instance";

export default async function oauthRoutes(app: FastifyInstance) {
  // Starts "Continue with Google / Microsoft" sign-in.
  app.get("/api/app/auth/oauth/:provider/start", { config: { auth: "public" } }, async (req, reply) => {
    const { provider } = params(req, z.object({ provider: z.enum(["google", "microsoft"]) }));
    const q = query(req, z.object({ return_to: z.string().optional(), tz: z.string().max(80).optional() }));
    try {
      return reply.redirect(buildAuthUrl({ provider: provider as OAuthProvider, purpose: "login", return_to: q.return_to, nonce: bindToBrowser(reply), timezone: ianaZone(q.tz) }));
    } catch (err) {
      return reply.redirect(`${config.webUrl}/auth/login?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.get("/api/app/oauth/:provider/callback", { config: { auth: "public" } }, async (req, reply) => {
    const { provider } = params(req, z.object({ provider: z.enum(["google", "microsoft"]) }));
    const q = query(req, z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }));
    let state;
    try {
      state = readState(q.state);
    } catch (err) {
      return reply.redirect(`${config.webUrl}/app/accounts?error=${encodeURIComponent((err as Error).message)}`);
    }
    const back = state.purpose === "login" ? `${config.webUrl}/auth/login` : `${config.webUrl}/app/account/connect`;
    if (!cameBackToSameBrowser(req, reply, state)) {
      return reply.redirect(`${back}?error=${encodeURIComponent("This sign-in was started in another browser or tab session. Please start it again here.")}`);
    }
    const sessionId = state.session_id;
    // API-started connections end on a "you can close this tab" page; the API client polls the session status.
    const finishSession = async (outcome: { status: "success" | "error"; email?: string; name?: string; error?: string; error_description?: string }) => {
      if (!sessionId) return null;
      await db
        .update(schema.oauthSessions)
        .set({ status: outcome.status, email: outcome.email ?? null, name: outcome.name ?? null, error: outcome.error ?? null, errorDescription: outcome.error_description ?? null })
        .where(eq(schema.oauthSessions.id, sessionId));
      const qs = new URLSearchParams({ status: outcome.status, ...(outcome.email ? { email: outcome.email } : {}), ...(outcome.error_description ? { error: outcome.error_description } : {}) });
      return `${config.webUrl}/auth/oauthfinal?${qs}`;
    };
    if (q.error || !q.code) {
      const msg = q.error_description || q.error || "Sign-in was cancelled";
      const done = await finishSession({ status: "error", error: q.error ?? "access_denied", error_description: msg });
      return reply.redirect(done ?? `${back}?error=${encodeURIComponent(msg)}`);
    }
    try {
      const identity = await exchangeCode(provider as OAuthProvider, q.code, state.purpose);
      if (state.purpose === "connect_account") {
        if (!state.workspace_id) throw new Error("Missing workspace");
        const row = await upsertOAuthAccount(state.workspace_id, state.user_id ?? null, identity, { enableWarmup: state.return_to !== "no_warmup" });
        const done = await finishSession({ status: "success", email: row.email, name: `${identity.first_name} ${identity.last_name}`.trim() || undefined });
        if (done) return reply.redirect(done);
        return reply.redirect(`${config.webUrl}/app/accounts?connected=${encodeURIComponent(row.email)}${row.created ? "" : "&reconnected=1"}`);
      }
      // Sign-in: by the provider's account id first. An existing account is only matched by email when the provider
      // vouches for the address and the account has no password (a password account is never taken over this way).
      const I = schema.oauthIdentities;
      const providerName = provider === "google" ? "Google" : "Microsoft";
      const [identityRow] = await db
        .select()
        .from(I)
        .where(and(eq(I.provider, provider), eq(I.subject, identity.subject)))
        .limit(1);
      let [user] = identityRow
        ? await db.select().from(schema.users).where(eq(schema.users.id, identityRow.userId)).limit(1)
        : await db.select().from(schema.users).where(eq(schema.users.email, identity.email)).limit(1);
      if (identityRow && identity.email_verified && !identityRow.verified) {
        await db.update(I).set({ verified: true }).where(eq(I.id, identityRow.id));
      }
      if (user && !identityRow) {
        if (user.passwordHash) throw new Error("An account with this email already exists. Sign in with your password.");
        if (!identity.email_verified) throw new Error(`${providerName} didn't confirm this email address, so it can't be used to sign in to an existing account.`);
        // This sign-in proves the address. Others linked without that proof may belong to whoever set the account up
        // first, so they go, and so do their sessions.
        const dropped = await db
          .delete(I)
          .where(and(eq(I.userId, user.id), eq(I.verified, false)))
          .returning({ id: I.id });
        if (dropped.length) await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
      }
      if (!user) {
        // An address the provider doesn't vouch for could be anyone's: an account made with it would be waiting for
        // its real owner, with someone else's sign-in attached.
        if (!identity.email_verified) throw new Error(`${providerName} didn't confirm this email address, so it can't be used to create an account. Sign up with your email and a password instead.`);
        await assertSignupAllowed(false);
        [user] = await db
          .insert(schema.users)
          .values({ email: identity.email, firstName: identity.first_name, lastName: identity.last_name, emailVerifiedAt: identity.email_verified ? new Date() : null, onboarding: {} })
          .returning();
        // On a fresh install the first account becomes the installation owner before its workspace is made.
        forgetOwnerCache();
        await getOwnerId();
        await createWorkspace(user!, `${identity.first_name || identity.email.split("@")[0]}'s workspace`, { timezone: state.timezone });
      } else if (!user.emailVerifiedAt && identity.email_verified && identity.email === user.email) {
        await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, user.id));
      }
      if (!identityRow) {
        await db.insert(I).values({ userId: user!.id, provider, subject: identity.subject, email: identity.email, verified: identity.email_verified }).onConflictDoNothing();
      }
      if (user!.deletedAt) throw new Error("This account was deleted");
      if (user!.disabledAt) throw new Error("This account is turned off. Ask the owner of this installation to turn it back on.");
      const workspaceId = await defaultWorkspaceId(user!);
      await createSession(reply, req, user!.id, { workspaceId, mfaPending: user!.totpEnabled });
      await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user!.id));
      if (workspaceId) await audit({ workspaceId, activityType: AuditActivity.USER_LOGIN, req, userId: user!.id, metadata: { method: provider } });
      if (user!.totpEnabled) return reply.redirect(`${config.webUrl}/auth/login?mfa=1`);
      const target = state.return_to && state.return_to.startsWith("/") && !state.return_to.startsWith("//") ? state.return_to : "/app/dashboard";
      return reply.redirect(`${config.webUrl}${target}`);
    } catch (err) {
      const done = await finishSession({ status: "error", error: "connection_failed", error_description: (err as Error).message });
      return reply.redirect(done ?? `${back}?error=${encodeURIComponent((err as Error).message)}`);
    }
  });
}

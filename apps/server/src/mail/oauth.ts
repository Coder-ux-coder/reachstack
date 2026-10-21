// OAuth 2.0 for connecting Google Workspace / Gmail and Microsoft 365 / Outlook mailboxes (IMAP + SMTP via XOAUTH2).
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../env";
import { HttpError, badRequest } from "../http/errors";
import { signPayload, verifyPayload } from "../lib/crypto";
import { randomToken } from "../lib/ids";
import { MailError } from "./types";

export type OAuthProvider = "google" | "microsoft";

export interface OAuthTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number; // epoch ms
  scope?: string;
  provider: OAuthProvider;
}

export interface OAuthState {
  provider: OAuthProvider;
  purpose: "connect_account" | "login";
  workspace_id?: string;
  user_id?: string;
  /** Where the browser returns after the callback. */
  return_to?: string;
  /** API connect session (POST /api/v2/oauth/{provider}/init) to report the outcome to. */
  session_id?: string;
  /** Matches the OAUTH_COOKIE of the browser that started the flow. */
  nonce?: string;
  /** Sign-in: the browser's time zone, for the clock of a workspace made for a new account. */
  timezone?: string;
  exp: number;
}

/** Ties a sign-in or mailbox connection to the browser that started it, so nobody can finish theirs in yours. */
export const OAUTH_COOKIE = "rs_oauth";

export function bindToBrowser(reply: FastifyReply): string {
  const nonce = randomToken(18);
  reply.setCookie(OAUTH_COOKIE, nonce, { path: "/api/app/oauth", httpOnly: true, sameSite: "lax", secure: config.appUrl.startsWith("https://"), maxAge: 15 * 60 });
  return nonce;
}

/** True when the callback came back to the browser that started the flow (API-started connections have no browser). */
export function cameBackToSameBrowser(req: FastifyRequest, reply: FastifyReply, state: OAuthState): boolean {
  reply.clearCookie(OAUTH_COOKIE, { path: "/api/app/oauth" });
  if (state.purpose === "connect_account" && state.session_id) return true;
  return !!state.nonce && req.cookies?.[OAUTH_COOKIE] === state.nonce;
}

const GOOGLE_SCOPES = ["https://mail.google.com/", "openid", "email", "profile"];
const MICROSOFT_SCOPES = [
  "offline_access",
  "openid",
  "email",
  "profile",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
];
const LOGIN_SCOPES = { google: ["openid", "email", "profile"], microsoft: ["openid", "email", "profile", "offline_access"] };

export function oauthConfigured(provider: OAuthProvider): boolean {
  const c = provider === "google" ? config.google : config.microsoft;
  return !!(c.clientId && c.clientSecret);
}

export function redirectUri(provider: OAuthProvider): string {
  return `${config.appUrl}/api/app/oauth/${provider}/callback`;
}

export function buildAuthUrl(state: Omit<OAuthState, "exp">, loginHint?: string): string {
  const provider = state.provider;
  if (!oauthConfigured(provider)) {
    throw badRequest(
      provider === "google"
        ? "Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or connect the mailbox with an app password over IMAP/SMTP."
        : "Microsoft sign-in is not configured on this server. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, or connect the mailbox over IMAP/SMTP.",
    );
  }
  const signed = signPayload({ ...state, exp: Date.now() + 15 * 60_000 });
  const scopes = state.purpose === "login" ? LOGIN_SCOPES[provider] : provider === "google" ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
  if (provider === "google") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", config.google.clientId);
    u.searchParams.set("redirect_uri", redirectUri("google"));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", scopes.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", state.purpose === "login" ? "select_account" : "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", signed);
    if (loginHint) u.searchParams.set("login_hint", loginHint);
    return u.toString();
  }
  const u = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  u.searchParams.set("client_id", config.microsoft.clientId);
  u.searchParams.set("redirect_uri", redirectUri("microsoft"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("state", signed);
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

export function readState(token: string | undefined): OAuthState {
  const s = verifyPayload<OAuthState>(token);
  if (!s || s.exp < Date.now()) throw badRequest("The sign-in link expired. Please try connecting again.");
  return s;
}

async function tokenRequest(provider: OAuthProvider, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = provider === "google" ? "https://oauth2.googleapis.com/token" : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const c = provider === "google" ? config.google : config.microsoft;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(data.error_description ?? data.error ?? `HTTP ${res.status}`);
    throw badRequest(`${provider === "google" ? "Google" : "Microsoft"} rejected the sign-in: ${msg}`, { status: res.status, error: data.error ?? null });
  }
  return data;
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface OAuthIdentity {
  email: string;
  /** The provider vouches that this person controls the address. */
  email_verified: boolean;
  subject: string;
  first_name: string;
  last_name: string;
  tokens: OAuthTokens;
}

export async function exchangeCode(provider: OAuthProvider, code: string, purpose: OAuthState["purpose"]): Promise<OAuthIdentity> {
  const scopes = purpose === "login" ? LOGIN_SCOPES[provider] : provider === "google" ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
  const data = await tokenRequest(provider, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider),
    ...(provider === "microsoft" ? { scope: scopes.join(" ") } : {}),
  });
  const claims = decodeJwt(String(data.id_token ?? ""));
  let email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? "").toLowerCase();
  let given = String(claims.given_name ?? "");
  let family = String(claims.family_name ?? "");
  if (provider === "google" && (!email || !given)) {
    const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${String(data.access_token)}` },
    })
      .then((r) => r.json() as Promise<Record<string, unknown>>)
      .catch(() => ({}) as Record<string, unknown>);
    if (!email && info.email_verified === true) claims.email_verified = true;
    email ||= String(info.email ?? "").toLowerCase();
    given ||= String(info.given_name ?? "");
    family ||= String(info.family_name ?? "");
  }
  if (!given && claims.name) {
    const [f, ...rest] = String(claims.name).split(" ");
    given = f ?? "";
    family = rest.join(" ");
  }
  if (!email) throw badRequest("Could not read the mailbox address from the provider.");
  // Google says so outright. Microsoft's /common endpoint takes any tenant, whose email claims aren't checked, so
  // only its "email domain owner verified" claim counts.
  const verified = provider === "google" ? claims.email_verified === true || claims.email_verified === "true" : claims.xms_edov === true || claims.xms_edov === "1" || claims.xms_edov === 1;
  return {
    email,
    email_verified: verified,
    subject: String(claims.sub ?? claims.oid ?? email),
    first_name: given,
    last_name: family,
    tokens: {
      provider,
      access_token: String(data.access_token),
      refresh_token: data.refresh_token ? String(data.refresh_token) : null,
      expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000,
      scope: data.scope ? String(data.scope) : undefined,
    },
  };
}

/**
 * Returns a valid access token, refreshing it when it expires within 2 minutes. A sign-in the provider refuses
 * (revoked, expired, the app's secret changed) is a login failure: only connecting the mailbox again fixes it, so it
 * takes the mailbox out of sending. Not reaching the provider is a connection failure, tried again later.
 */
export async function freshAccessToken(tokens: OAuthTokens): Promise<{ tokens: OAuthTokens; refreshed: boolean }> {
  if (tokens.expires_at - Date.now() > 120_000) return { tokens, refreshed: false };
  const who = tokens.provider === "google" ? "Google" : "Microsoft";
  const again = `Connect the mailbox again with Sign in with ${who}.`;
  if (!tokens.refresh_token) throw new MailError("auth", `The ${who} sign-in for this mailbox expired. ${again}`);
  const scopes = tokens.provider === "google" ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
  let data: Record<string, unknown>;
  try {
    data = await tokenRequest(tokens.provider, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      ...(tokens.provider === "microsoft" ? { scope: scopes.join(" ") } : {}),
    });
  } catch (err) {
    const message = (err as Error).message.replace(/\.+$/, "");
    const status = err instanceof HttpError ? (err.details as { status?: number } | undefined)?.status : undefined;
    if (status && status >= 400 && status < 500 && status !== 429) {
      // Google expires the sign-ins of an app still in Testing after 7 days.
      const testing = tokens.provider === "google" ? " If this happens about once a week, the Google app is still in Testing: publish it in Google Cloud (OAuth consent screen → Publish app)." : "";
      throw new MailError("auth", `${message}. ${again}${testing}`);
    }
    throw new MailError("connection", `Couldn't renew the ${who} sign-in: ${message}`);
  }
  return {
    refreshed: true,
    tokens: {
      ...tokens,
      access_token: String(data.access_token),
      refresh_token: data.refresh_token ? String(data.refresh_token) : tokens.refresh_token,
      expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    },
  };
}

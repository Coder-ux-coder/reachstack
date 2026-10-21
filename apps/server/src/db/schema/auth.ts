import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, createdAt, json, pk, ts, updatedAt } from "./_helpers";

export const users = sqliteTable(
  "users",
  {
    id: pk(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    avatarUrl: text("avatar_url"),
    phone: text("phone"),
    timezone: text("timezone"),
    language: text("language").default("en"),
    theme: text("theme").default("system"),
    emailVerifiedAt: ts("email_verified_at"),
    totpSecretEnc: text("totp_secret_enc"),
    totpPendingSecretEnc: text("totp_pending_secret_enc"),
    totpEnabled: bool("totp_enabled").notNull().default(false),
    recoveryCodes: json<string[]>("recovery_codes"),
    onboarding: json<Record<string, unknown>>("onboarding"),
    onboardingCompleted: bool("onboarding_completed").notNull().default(false),
    isSuperadmin: bool("is_superadmin").notNull().default(false),
    referralPartner: text("referral_partner"),
    appsumoCode: text("appsumo_code"),
    preferences: json<Record<string, unknown>>("preferences"),
    lastLoginAt: ts("last_login_at"),
    failedMfaAttempts: text("failed_mfa_attempts"),
    /** Set by the installation owner or an admin: the account can't sign in and its sessions stop working. */
    disabledAt: ts("disabled_at"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: pk(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    currentWorkspaceId: text("current_workspace_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    mfaPending: bool("mfa_pending").notNull().default(false),
    workspaceReauth: json<Record<string, number>>("workspace_reauth"),
    isClientPortal: bool("is_client_portal").notNull().default(false),
    impersonatorId: text("impersonator_id"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at"),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: pk(),
    userId: text("user_id"),
    email: text("email"),
    type: text("type").notNull(), // email_verify | password_reset | email_change | owner_change | login_code
    tokenHash: text("token_hash").notNull(),
    data: json<Record<string, unknown>>("data"),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("auth_tokens_hash_uq").on(t.tokenHash), index("auth_tokens_user_idx").on(t.userId)],
);

export const oauthIdentities = sqliteTable(
  "oauth_identities",
  {
    id: pk(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(), // google | microsoft
    subject: text("subject").notNull(),
    email: text("email"),
    /** The provider vouched for the email when this sign-in was linked (see routes/oauth.ts). */
    verified: bool("verified").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("oauth_identities_uq").on(t.provider, t.subject)],
);

/** OAuth 2.0 clients registered by developers so third-party apps can access a workspace. */
export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    id: pk(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretHash: text("client_secret_hash").notNull(),
    redirectUris: json<string[]>("redirect_uris").notNull(),
    scopes: json<string[]>("scopes").notNull(),
    logoUrl: text("logo_url"),
    websiteUrl: text("website_url"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("oauth_clients_client_id_uq").on(t.clientId)],
);

export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: pk(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    codeHash: text("code_hash"),
    codeChallenge: text("code_challenge"),
    redirectUri: text("redirect_uri"),
    accessTokenHash: text("access_token_hash"),
    refreshTokenHash: text("refresh_token_hash"),
    scopes: json<string[]>("scopes").notNull(),
    codeExpiresAt: ts("code_expires_at"),
    accessExpiresAt: ts("access_expires_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("oauth_grants_code_idx").on(t.codeHash),
    index("oauth_grants_access_idx").on(t.accessTokenHash),
    index("oauth_grants_refresh_idx").on(t.refreshTokenHash),
  ],
);

/** Requests from the public privacy center (see services/privacy.ts); abuse reports have their own table. */
export const privacyRequests = sqliteTable(
  "privacy_requests",
  {
    id: pk(),
    type: text("type").notNull(), // opt_out | data_request | removal (the privacy request form)
    email: text("email").notNull(),
    name: text("name"),
    details: json<Record<string, unknown>>("details"),
    // pending: waiting for the email link · verified: confirmed, waiting for the administrator · resolved · rejected
    status: text("status").notNull().default("pending"),
    tokenHash: text("token_hash"),
    verifiedAt: ts("verified_at"),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [index("privacy_requests_email_idx").on(t.email)],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value"),
  updatedAt: updatedAt(),
});

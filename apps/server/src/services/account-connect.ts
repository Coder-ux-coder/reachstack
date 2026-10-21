// Connecting mailboxes: credential validation, connection tests and creating/updating account rows.
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { AccountStatus, AuditActivity, ProviderCode, WarmupStatus, isValidEmailSyntax, type AccountWarmupConfig } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { ServerConfig } from "../db/schema";
import { badRequest, conflict, paymentRequired } from "../http/errors";
import { encrypt, encryptJson } from "../lib/crypto";
import { shortCode } from "../lib/ids";
import { assertPublicHost } from "../lib/net";
import type { OAuthTokens } from "../mail/oauth";
import { SmtpImapDriver, dropTransport } from "../mail/smtp-imap";
import { PROVIDER_PRESETS, providerForHosts } from "../mail/providers";
import type { ConnectionCheck } from "../mail/types";
import { clearAccountError, defaultWarmup, mergeWarmup } from "./accounts";
import { audit } from "./audit";
import { emit } from "./bus";
import { workspaceLimits } from "./billing-limits";
import { trackingDomainInput, trackingStatusFor } from "./tracking-domains";

export const warmupSchema = z
  .object({
    limit: z.number().min(0).max(200).optional(),
    increment: z.enum(["disabled", "0", "1", "2", "3", "4"]).optional(),
    reply_rate: z.number().min(0).max(100).optional(),
    warmup_custom_ftag: z.string().trim().max(60).nullable().optional(),
    advanced: z
      .object({
        warm_ctd: z.boolean().optional(),
        open_rate: z.number().min(0).max(100).optional(),
        important_rate: z.number().min(0).max(100).optional(),
        read_emulation: z.boolean().optional(),
        spam_save_rate: z.number().min(0).max(100).optional(),
        weekday_only: z.boolean().optional(),
      })
      .partial()
      .optional(),
  })
  .partial();

export const createAccountSchema = z.object({
  email: z.string().trim().toLowerCase(),
  first_name: z.string().trim().max(100).default(""),
  last_name: z.string().trim().max(100).default(""),
  provider_code: z.coerce.number().int().default(ProviderCode.CUSTOM),
  imap_username: z.string().trim().optional(),
  imap_password: z.string().optional(),
  imap_host: z.string().trim().optional(),
  imap_port: z.coerce.number().int().min(1).max(65535).optional(),
  smtp_username: z.string().trim().optional(),
  smtp_password: z.string().optional(),
  smtp_host: z.string().trim().optional(),
  smtp_port: z.coerce.number().int().min(1).max(65535).optional(),
  warmup: warmupSchema.optional(),
  warmup_custom_ftag: z.string().trim().max(60).optional(),
  daily_limit: z.coerce.number().int().min(0).max(10_000).nullable().optional(),
  sending_gap: z.coerce.number().int().min(0).max(1440).optional(),
  signature: z.string().max(20_000).nullable().optional(),
  reply_to: z.string().trim().nullable().optional(),
  tracking_domain_name: trackingDomainInput.nullable().optional(),
  /** Accepted for compatibility: the status is what the check finds. */
  tracking_domain_status: z.string().nullable().optional(),
  enable_slow_ramp: z.boolean().nullable().optional(),
  inbox_placement_test_limit: z.coerce.number().int().nullable().optional(),
  /** Accepted for compatibility: HTTPS answering from this installation is what's checked, not the record. */
  skip_cname_check: z.boolean().optional(),
  // App-only extras
  enable_warmup: z.boolean().optional(),
  skip_connection_test: z.boolean().optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

const secureFor = (port: number, kind: "imap" | "smtp") => (kind === "imap" ? port === 993 : port === 465);

export function serverConfigs(input: CreateAccountInput): { imap: ServerConfig; smtp: ServerConfig } {
  const preset = input.provider_code === ProviderCode.GOOGLE ? PROVIDER_PRESETS[0] : input.provider_code === ProviderCode.MICROSOFT ? PROVIDER_PRESETS[1] : null;
  const imapHost = input.imap_host || preset?.imap.host;
  const smtpHost = input.smtp_host || preset?.smtp.host;
  if (!imapHost || !smtpHost) throw badRequest("IMAP and SMTP hosts are required");
  const imapPort = input.imap_port ?? preset?.imap.port ?? 993;
  const smtpPort = input.smtp_port ?? preset?.smtp.port ?? 587;
  return {
    imap: { host: imapHost, port: imapPort, secure: secureFor(imapPort, "imap"), user: input.imap_username || input.email },
    smtp: { host: smtpHost, port: smtpPort, secure: secureFor(smtpPort, "smtp"), user: input.smtp_username || input.imap_username || input.email },
  };
}

/** Tests IMAP + SMTP credentials without saving anything. */
export async function testCredentials(input: CreateAccountInput): Promise<{ imap: ConnectionCheck; smtp: ConnectionCheck }> {
  const { imap, smtp } = serverConfigs(input);
  await assertPublicHost(imap.host, "The IMAP server");
  await assertPublicHost(smtp.host, "The SMTP server");
  const driver = new SmtpImapDriver({
    id: `test:${input.email}`,
    email: input.email,
    imap,
    imapPassword: input.imap_password ?? "",
    smtp,
    smtpPassword: input.smtp_password ?? input.imap_password ?? "",
    oauth: null,
  });
  return driver.verify();
}

async function assertCapacity(workspaceId: string) {
  const limits = await workspaceLimits(workspaceId);
  if (limits.email_accounts === null) return;
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, workspaceId));
  if (Number(row?.n ?? 0) >= limits.email_accounts) {
    throw paymentRequired(`Your plan allows ${limits.email_accounts} email accounts. Upgrade to connect more.`);
  }
}

function connectError(checks: { imap: ConnectionCheck; smtp: ConnectionCheck }) {
  const parts: string[] = [];
  if (!checks.imap.ok) parts.push(`IMAP: ${checks.imap.error}${checks.imap.hint ? ` (${checks.imap.hint})` : ""}`);
  if (!checks.smtp.ok && !(checks.smtp.hint && checks.smtp.hint === checks.imap.hint)) parts.push(`SMTP: ${checks.smtp.error}${checks.smtp.hint ? ` (${checks.smtp.hint})` : ""}`);
  else if (!checks.smtp.ok) parts.push(`SMTP: ${checks.smtp.error}`);
  return badRequest(`Could not connect to the mailbox. ${parts.join(" | ")}`, { imap: checks.imap, smtp: checks.smtp });
}

const SANDBOX_NAMES = [
  ["Alex", "Morgan"],
  ["Sam", "Rivera"],
  ["Jordan", "Lee"],
  ["Taylor", "Brooks"],
  ["Casey", "Nguyen"],
  ["Riley", "Patel"],
  ["Jamie", "Cohen"],
  ["Avery", "Diaz"],
  ["Drew", "Kim"],
  ["Quinn", "Foster"],
] as const;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether another workspace has test mailboxes at this domain. Their mail is kept by address, so two can't share one. */
async function sandboxDomainTaken(workspaceId: string, domain: string) {
  const A = schema.emailAccounts;
  const [row] = await db
    .select({ id: A.id })
    .from(A)
    .where(and(eq(A.providerCode, ProviderCode.SANDBOX), ne(A.workspaceId, workspaceId), sql`substr(${A.email}, instr(${A.email}, '@') + 1) = ${domain}`))
    .limit(1);
  return !!row;
}

/** Sandbox mailboxes (provider 99) on a made-up .test domain: what they send and receive stays in the database. */
export async function createSandboxAccounts(
  workspace: { id: string; name: string },
  userId: string | null,
  opts: { count: number; domain?: string; enableWarmup: boolean },
  req?: Parameters<typeof audit>[0]["req"],
) {
  let domain = opts.domain?.trim().toLowerCase() ?? "";
  if (domain) {
    if (!DOMAIN.test(domain)) throw badRequest("Enter a domain like team-demo.test");
    if (await sandboxDomainTaken(workspace.id, domain)) throw conflict("Another workspace on this server has test mailboxes at that domain. Pick another one.");
  } else {
    const name = workspace.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "team";
    // A domain of its own: another workspace's (however unlikely) gets another code.
    do domain = `${name}-${shortCode(4)}.test`;
    while (await sandboxDomainTaken(workspace.id, domain));
  }
  const created = [];
  for (let i = 0; i < opts.count; i++) {
    const [first, last] = SANDBOX_NAMES[i % SANDBOX_NAMES.length]!;
    const email = `${first.toLowerCase()}${i >= SANDBOX_NAMES.length ? i : ""}@${domain}`;
    created.push(await createAccount(workspace.id, userId, createAccountSchema.parse({ email, first_name: first, last_name: last, provider_code: ProviderCode.SANDBOX, enable_warmup: opts.enableWarmup }), req));
  }
  return created;
}

/** Create an IMAP/SMTP (or sandbox) account after verifying the connection. */
export async function createAccount(workspaceId: string, userId: string | null, input: CreateAccountInput, req?: Parameters<typeof audit>[0]["req"]) {
  if (!isValidEmailSyntax(input.email)) throw badRequest("Enter a valid email address");
  const [existing] = await db
    .select({ id: schema.emailAccounts.id })
    .from(schema.emailAccounts)
    .where(and(eq(schema.emailAccounts.workspaceId, workspaceId), eq(schema.emailAccounts.email, input.email)))
    .limit(1);
  if (existing) throw conflict(`${input.email} is already connected to this workspace`);
  await assertCapacity(workspaceId);

  const sandbox = input.provider_code === ProviderCode.SANDBOX;
  let imap: ServerConfig | null = null;
  let smtp: ServerConfig | null = null;
  if (!sandbox) {
    ({ imap, smtp } = serverConfigs(input));
    if (!input.imap_password) throw badRequest("IMAP password is required");
    await assertPublicHost(imap.host, "The IMAP server");
    await assertPublicHost(smtp.host, "The SMTP server");
    if (!input.skip_connection_test) {
      const checks = await testCredentials(input);
      if (!checks.imap.ok || !checks.smtp.ok) throw connectError(checks);
    }
  }
  const warmup: AccountWarmupConfig = mergeWarmup(defaultWarmup(), {
    ...(input.warmup ?? {}),
    ...(input.warmup_custom_ftag ? { warmup_custom_ftag: input.warmup_custom_ftag } : {}),
  } as Partial<AccountWarmupConfig>);
  // Links only use a tracking domain once they'd work there: checked, as when it's changed later, whatever status the
  // request names.
  const trackingDomain = input.tracking_domain_name || null;
  const trackingStatus = trackingDomain ? await trackingStatusFor(trackingDomain) : null;
  const [row] = await db
    .insert(schema.emailAccounts)
    .values({
      workspaceId,
      email: input.email,
      firstName: input.first_name,
      lastName: input.last_name,
      // Gmail or Microsoft 365 servers make it a Google or Microsoft mailbox, even when added as "any provider".
      providerCode: sandbox ? ProviderCode.SANDBOX : input.provider_code === ProviderCode.CUSTOM ? providerForHosts(imap!.host, smtp!.host) : input.provider_code,
      imap,
      imapPasswordEnc: sandbox ? null : encrypt(input.imap_password ?? ""),
      smtp,
      smtpPasswordEnc: sandbox ? null : encrypt(input.smtp_password || input.imap_password || ""),
      status: AccountStatus.ACTIVE,
      warmupStatus: input.enable_warmup ? WarmupStatus.ACTIVE : WarmupStatus.PAUSED,
      warmup,
      warmupStartedAt: input.enable_warmup ? new Date() : null,
      dailyLimit: input.daily_limit === undefined ? 30 : input.daily_limit,
      sendingGap: input.sending_gap ?? 10,
      signature: input.signature ?? null,
      replyTo: input.reply_to || null,
      trackingDomainName: trackingDomain,
      trackingDomainStatus: trackingStatus,
      enableSlowRamp: input.enable_slow_ramp ?? false,
      inboxPlacementTestLimit: input.inbox_placement_test_limit ?? null,
      addedBy: userId,
      modifiedBy: userId,
    })
    .returning();
  await audit({ workspaceId, activityType: AuditActivity.ACCOUNT_ADDITION, req, userId, metadata: { email: input.email } });
  emit("account_added", workspaceId, { account_id: row!.id, email: row!.email });
  return row!;
}

/** Create or refresh an OAuth-connected Google / Microsoft account. */
export async function upsertOAuthAccount(
  workspaceId: string,
  userId: string | null,
  identity: { email: string; first_name: string; last_name: string; tokens: OAuthTokens },
  opts: { enableWarmup?: boolean } = {},
) {
  const provider = identity.tokens.provider;
  const preset = provider === "google" ? PROVIDER_PRESETS[0]! : PROVIDER_PRESETS[1]!;
  const credentials = {
    providerCode: provider === "google" ? ProviderCode.GOOGLE : ProviderCode.MICROSOFT,
    imap: { ...preset.imap, user: identity.email },
    smtp: { ...preset.smtp, user: identity.email },
    oauthEnc: encryptJson(identity.tokens),
    imapPasswordEnc: null,
    smtpPasswordEnc: null,
    modifiedBy: userId,
  };
  const values = { ...credentials, status: AccountStatus.ACTIVE, statusMessage: null, consecutiveErrors: 0 };
  const [existing] = await db
    .select()
    .from(schema.emailAccounts)
    .where(and(eq(schema.emailAccounts.workspaceId, workspaceId), eq(schema.emailAccounts.email, identity.email)))
    .limit(1);
  if (existing) {
    // Signed in again: the login failure is cleared and the mailbox goes back to what it was (a paused one stays
    // paused). Another inbox server has other folders, read afresh.
    const moved = existing.imap?.host !== credentials.imap.host;
    await db
      .update(schema.emailAccounts)
      .set({ ...credentials, ...(moved ? { folders: null, syncState: null } : {}) })
      .where(eq(schema.emailAccounts.id, existing.id));
    dropTransport(existing.id);
    await clearAccountError({ ...existing, ...credentials }, "all");
    const [row] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, existing.id)).limit(1);
    return { ...row!, created: false };
  }
  await assertCapacity(workspaceId);
  const [row] = await db
    .insert(schema.emailAccounts)
    .values({
      workspaceId,
      email: identity.email,
      firstName: identity.first_name,
      lastName: identity.last_name,
      ...values,
      warmup: defaultWarmup(),
      warmupStatus: opts.enableWarmup === false ? WarmupStatus.PAUSED : WarmupStatus.ACTIVE,
      warmupStartedAt: opts.enableWarmup === false ? null : new Date(),
      addedBy: userId,
    })
    .returning();
  await audit({ workspaceId, activityType: AuditActivity.ACCOUNT_ADDITION, userId, metadata: { email: identity.email, provider } });
  emit("account_added", workspaceId, { account_id: row!.id, email: row!.email });
  return { ...row!, created: true };
}

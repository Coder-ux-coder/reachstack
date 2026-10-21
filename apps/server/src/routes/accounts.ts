// Email accounts: API v2 (/api/v2/accounts…) and app endpoints (/api/app/accounts…).
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  ACCOUNT_STATUS_LABELS,
  AccountStatus,
  AuditActivity,
  PROVIDER_LABELS,
  ProviderCode,
  SHEET_MAXIMUMS,
  WARMUP_STATUS_LABELS,
  WarmupStatus,
  domainOf,
  readSheetNumber,
  readWarmupIncrease,
  type AccountWarmupConfig,
  type MailboxHealth,
} from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { config } from "../env";
import { assertAccess } from "../http/auth";
import { ctx } from "../http/context";
import { badRequest, forbidden, notFound } from "../http/errors";
import { body, pageQuery, paginated, params, parse, query, zBool, zInt, zList } from "../http/util";
import { decrypt, encrypt } from "../lib/crypto";
import { checkDomainAuth } from "../lib/dns";
import { assertPublicHost } from "../lib/net";
import { iso } from "../lib/time";
import { newMessageId } from "../mail/compose";
import { driverFor, type AccountRow } from "../mail/driver";
import { bindToBrowser, buildAuthUrl, oauthConfigured, type OAuthProvider } from "../mail/oauth";
import { detectProvider, PROVIDER_PRESETS, providerForHosts } from "../mail/providers";
import { dropTransport } from "../mail/smtp-imap";
import type { ConnectionCheck } from "../mail/types";
import { createAccount, createAccountSchema, createSandboxAccounts, serverConfigs, testCredentials, warmupSchema } from "../services/account-connect";
import { checkMailboxDomains, checkableDomain, mailboxDns, missingRecord, saveDomainCheck } from "../services/domain-dns";
import { clearAccountError, effectiveDailyLimit, mergeWarmup, noteSendSuccess, recordAccountError, retryInboxSoon, serializeAccount, serializeAccounts, todayStats } from "../services/accounts";
import { healthTrend, mailboxHealth } from "../services/mailbox-health";
import { dayOf, dayOn, daysBefore, daySql, workspaceRange, workspaceToday, workspaceZone } from "../services/workspace-clock";
import { audit } from "../services/audit";
import { refusedAtSend } from "../services/bounce-report";
import { createJob, registerJobHandler, serializeJob } from "../services/jobs";
import { assertTags, resourcesWithTags } from "../services/tags";
import { reachableFromInternet } from "../services/tracking";
import { checkTrackingDomain, trackingDomainInput, trackingHost } from "../services/tracking-domains";
import { disableWarmup, enableWarmup, warmupAnalytics, warmupStanding } from "../engine/warmup";
import { syncAccount } from "../engine/inbox-sync";
import { jobErrorMessage } from "../engine/jobs";
import { toCsv } from "../lib/csv";

const t = schema.emailAccounts;

interface AccountQuery {
  search?: string;
  status?: number;
  provider_code?: number;
  filter?: string | { filter?: string; tag_id?: string; tag_ids?: string[]; search?: string } | null;
  tag_ids?: string[];
  tag_ids_all?: string[];
}

/** WHERE conditions for account lists and "select all" bulk actions. */
async function accountConditions(wsId: string, q: AccountQuery): Promise<SQL[]> {
  const conds: SQL[] = [eq(t.workspaceId, wsId)];
  const filterObj = typeof q.filter === "object" && q.filter ? q.filter : null;
  const filter = typeof q.filter === "string" ? q.filter : filterObj?.filter;
  const search = q.search ?? filterObj?.search;
  if (search) {
    const s = search.trim().toLowerCase();
    conds.push(or(contains(t.email, s), contains(sql`lower(${t.firstName} || ' ' || ${t.lastName})`, s))!);
  }
  if (q.status !== undefined) conds.push(eq(t.status, q.status));
  if (q.provider_code !== undefined) conds.push(eq(t.providerCode, q.provider_code));
  const anyTags = [...(q.tag_ids ?? []), ...(filterObj?.tag_ids ?? []), ...(filterObj?.tag_id ? [filterObj.tag_id] : [])];
  if (anyTags.length) {
    const ids = await resourcesWithTags(wsId, anyTags, "any");
    conds.push(inArray(t.id, ids.length ? ids : ["__none__"]));
  }
  if (q.tag_ids_all?.length) {
    const ids = await resourcesWithTags(wsId, q.tag_ids_all, "all");
    conds.push(inArray(t.id, ids.length ? ids : ["__none__"]));
  }
  switch (filter) {
    case "ACC_FILTER_PAUSED":
      conds.push(eq(t.status, AccountStatus.PAUSED));
      break;
    case "ACC_FILTER_ERROR":
      conds.push(lt(t.status, 0));
      break;
    case "ACC_FILTER_NO_CTD":
      conds.push(isNull(t.trackingDomainName));
      break;
    case "ACC_FILTER_PW_ACCOUNTS": {
      const orders = await db
        .select({ id: schema.dfyOrders.id })
        .from(schema.dfyOrders)
        .where(and(eq(schema.dfyOrders.workspaceId, wsId), eq(schema.dfyOrders.isPreWarmedUp, true)));
      conds.push(inArray(t.dfyOrderId, orders.length ? orders.map((o) => o.id) : ["__none__"]));
      break;
    }
    case "ACC_FILTER_DFY":
      conds.push(isNotNull(t.dfyOrderId));
      break;
    case "ACC_FILTER_DFY_SETUP_PENDING":
      conds.push(eq(t.setupPending, true));
      break;
    case "ACC_FILTER_W_ACTIVE":
      conds.push(eq(t.warmupStatus, WarmupStatus.ACTIVE));
      break;
    case "ACC_FILTER_W_PAUSED":
      conds.push(eq(t.warmupStatus, WarmupStatus.PAUSED));
      break;
    case "ACC_FILTER_W_ERROR":
      conds.push(lt(t.warmupStatus, 0));
      break;
    case "ACC_FILTER_DNS": {
      // Mailboxes whose domain was found missing a DNS record (services/domain-dns.ts).
      const all = await db.select({ id: t.id, email: t.email, providerCode: t.providerCode }).from(t).where(eq(t.workspaceId, wsId));
      const dns = await mailboxDns(wsId, all);
      const ids = all.filter((a) => missingRecord(dns.get(a.id))).map((a) => a.id);
      conds.push(inArray(t.id, ids.length ? ids : ["__none__"]));
      break;
    }
  }
  return conds;
}

export async function findAccount(wsId: string, email: string): Promise<AccountRow> {
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.workspaceId, wsId), eq(t.email, decodeURIComponent(email).trim().toLowerCase())))
    .limit(1);
  if (!row) throw notFound("Account");
  return row;
}

const bulkTarget = z.object({
  emails: z.array(z.string()).optional(),
  include_all_emails: z.boolean().optional(),
  excluded_emails: z.array(z.string()).optional(),
  filter: z.union([z.string(), z.record(z.unknown())]).nullable().optional(),
  search: z.string().optional(),
});

async function resolveTargets(wsId: string, b: z.infer<typeof bulkTarget>): Promise<AccountRow[]> {
  if (b.include_all_emails) {
    const conds = await accountConditions(wsId, { search: b.search, filter: b.filter as AccountQuery["filter"] });
    const rows = await db.select().from(t).where(and(...conds));
    const excluded = new Set((b.excluded_emails ?? []).map((e) => e.toLowerCase()));
    return rows.filter((r) => !excluded.has(r.email));
  }
  const emails = [...new Set((b.emails ?? []).map((e) => e.trim().toLowerCase()))];
  if (!emails.length) return [];
  return db.select().from(t).where(and(eq(t.workspaceId, wsId), inArray(t.email, emails)));
}

const patchSchema = z.object({
  first_name: z.string().trim().max(100).optional(),
  last_name: z.string().trim().max(100).optional(),
  warmup: warmupSchema.optional(),
  daily_limit: z.coerce.number().int().min(0).max(10_000).nullable().optional(),
  tracking_domain_name: trackingDomainInput.nullable().optional(),
  /** Accepted for compatibility: the status is what the check finds. */
  tracking_domain_status: z.string().nullable().optional(),
  enable_slow_ramp: z.boolean().nullable().optional(),
  inbox_placement_test_limit: z.coerce.number().int().min(0).nullable().optional(),
  sending_gap: z.coerce.number().int().min(0).max(1440).optional(),
  signature: z.string().max(20_000).nullable().optional(),
  reply_to: z.string().trim().nullable().optional(),
  /** Accepted for compatibility: HTTPS answering from this installation is what's checked, not the record. */
  skip_cname_check: z.boolean().optional(),
  remove_tracking_domain: z.boolean().optional(),
  /** Pause campaign sending (warmup continues) until a date; null resumes it now. */
  campaign_pause_until: z.string().datetime().nullable().optional(),
  // App extras: update credentials when reconnecting a password account.
  imap_password: z.string().optional(),
  smtp_password: z.string().optional(),
  imap_host: z.string().trim().optional(),
  imap_port: z.coerce.number().int().optional(),
  imap_username: z.string().trim().optional(),
  smtp_host: z.string().trim().optional(),
  smtp_port: z.coerce.number().int().optional(),
  smtp_username: z.string().trim().optional(),
});

/** Providers told apart by their servers (the others are set by how the mailbox was connected). */
const BY_HOSTS = new Set<number>([ProviderCode.CUSTOM, ProviderCode.GOOGLE, ProviderCode.MICROSOFT, ProviderCode.AWS]);

async function patchAccount(account: AccountRow, b: z.infer<typeof patchSchema>, userId: string | null) {
  const set: Partial<typeof t.$inferInsert> = { modifiedBy: userId };
  if (b.first_name !== undefined) set.firstName = b.first_name;
  if (b.last_name !== undefined) set.lastName = b.last_name;
  if (b.warmup) set.warmup = mergeWarmup(account.warmup, b.warmup as Partial<AccountWarmupConfig>);
  if (b.daily_limit !== undefined) set.dailyLimit = b.daily_limit;
  if (b.enable_slow_ramp !== undefined) set.enableSlowRamp = b.enable_slow_ramp;
  if (b.inbox_placement_test_limit !== undefined) set.inboxPlacementTestLimit = b.inbox_placement_test_limit;
  if (b.sending_gap !== undefined) set.sendingGap = b.sending_gap;
  if (b.campaign_pause_until !== undefined) set.campaignPauseUntil = b.campaign_pause_until ? new Date(b.campaign_pause_until) : null;
  if (b.signature !== undefined) set.signature = b.signature;
  if (b.reply_to !== undefined) set.replyTo = b.reply_to || null;
  if (b.remove_tracking_domain) {
    set.trackingDomainName = null;
    set.trackingDomainStatus = null;
  } else if (b.tracking_domain_name !== undefined) {
    const host = b.tracking_domain_name || null;
    set.trackingDomainName = host;
    // Links only use the domain once they'd work there (services/tracking-domains): checked when it's new or not
    // working yet, whatever status the request names. Saving other settings doesn't check a working one again.
    if (!host) set.trackingDomainStatus = null;
    else if (host !== account.trackingDomainName || account.trackingDomainStatus !== "verified") set.trackingDomainStatus = (await checkTrackingDomain(host)).status;
  } else if (b.tracking_domain_status !== undefined && account.trackingDomainName) {
    set.trackingDomainStatus = (await checkTrackingDomain(account.trackingDomainName)).status;
  }

  const credsChanged = b.imap_password || b.smtp_password || b.imap_host || b.smtp_host || b.imap_port || b.smtp_port || b.imap_username || b.smtp_username;
  if (credsChanged && account.providerCode !== ProviderCode.SANDBOX) {
    // A saved password or sign-in token only ever goes to the server it was entered for: moving a side to another
    // host, port or username needs that side's password again.
    const same = (next: string | number | undefined, prev: string | number | undefined) => next === undefined || String(next).trim().toLowerCase() === String(prev ?? "").trim().toLowerCase();
    const imapMoved = !same(b.imap_host, account.imap?.host) || !same(b.imap_port, account.imap?.port) || !same(b.imap_username, account.imap?.user);
    const smtpMoved = !same(b.smtp_host, account.smtp?.host) || !same(b.smtp_port, account.smtp?.port) || !same(b.smtp_username, account.smtp?.user);
    if (imapMoved && !b.imap_password) throw badRequest("Enter the IMAP password again to change the IMAP server, port or username");
    if (smtpMoved && !b.smtp_password && !b.imap_password) throw badRequest("Enter the SMTP password again to change the SMTP server, port or username");
    if (b.imap_host && imapMoved) await assertPublicHost(b.imap_host, "The IMAP server");
    if (b.smtp_host && smtpMoved) await assertPublicHost(b.smtp_host, "The SMTP server");
    const { imap, smtp } = serverConfigs({
      email: account.email,
      provider_code: account.providerCode,
      first_name: account.firstName,
      last_name: account.lastName,
      imap_host: b.imap_host ?? account.imap?.host,
      imap_port: b.imap_port ?? account.imap?.port,
      imap_username: b.imap_username ?? account.imap?.user,
      smtp_host: b.smtp_host ?? account.smtp?.host,
      smtp_port: b.smtp_port ?? account.smtp?.port,
      smtp_username: b.smtp_username ?? account.smtp?.user,
    });
    set.imap = imap;
    set.smtp = smtp;
    // The servers say whose mailbox it is: one moved onto Gmail's is a Google mailbox now, one moved off a custom one.
    if (BY_HOSTS.has(account.providerCode)) set.providerCode = providerForHosts(imap.host, smtp.host);
    if (b.imap_password) set.imapPasswordEnc = encrypt(b.imap_password);
    // A new IMAP password also becomes the SMTP one only when they were the same, or SMTP had none, or its server moved
    // without one of its own: a separate SMTP password (a relay's, say) stays.
    const sharedPassword = !account.smtpPasswordEnc || decrypt(account.smtpPasswordEnc) === decrypt(account.imapPasswordEnc);
    if (b.smtp_password) set.smtpPasswordEnc = encrypt(b.smtp_password);
    else if (b.imap_password && (sharedPassword || smtpMoved)) set.smtpPasswordEnc = encrypt(b.imap_password);
    set.oauthEnc = b.imap_password ? null : account.oauthEnc;
    // Another inbox server has other folders: they're read afresh, and sync starts over there.
    if (imapMoved) {
      set.folders = null;
      set.syncState = null;
    }
    dropTransport(account.id);
  }
  const [row] = await db.update(t).set(set).where(eq(t.id, account.id)).returning();
  // New inbox credentials are tried within a minute, not after the wait the old ones' failures had built up.
  if (credsChanged && account.providerCode !== ProviderCode.SANDBOX && (b.imap_password || b.imap_host || b.imap_port || b.imap_username)) await retryInboxSoon(account.id);
  return row!;
}

/** A connection test checked both sides: a side that passed is cleared, a side that failed is recorded. */
async function applyConnectionTest(account: AccountRow, r: { smtp: ConnectionCheck; imap: ConnectionCheck }) {
  if (r.smtp.ok && r.imap.ok) return clearAccountError(account, "all");
  for (const side of ["smtp", "imap"] as const) {
    const check = r[side];
    if (check.ok) await clearAccountError(account, side);
    else await recordAccountError(account, check.code ?? "connection", check.error ?? "Connection failed", {}, side);
  }
}

async function deleteAccounts(wsId: string, rows: AccountRow[]) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const emails = rows.map((r) => r.email);
  await db.delete(t).where(inArray(t.id, ids));
  await db.delete(schema.accountDailyStats).where(inArray(schema.accountDailyStats.accountId, ids));
  // A seed inbox read through one of these mailboxes can't be read any more.
  await db.update(schema.placementSeeds).set({ active: false }).where(inArray(schema.placementSeeds.accountId, ids));
  await db.delete(schema.customTagMappings).where(and(eq(schema.customTagMappings.workspaceId, wsId), inArray(schema.customTagMappings.resourceId, ids)));
  for (const id of ids) dropTransport(id);
  // Remove the addresses from campaign sender lists.
  const campaigns = await db.select({ id: schema.campaigns.id, emailList: schema.campaigns.emailList }).from(schema.campaigns).where(eq(schema.campaigns.workspaceId, wsId));
  for (const c of campaigns) {
    const next = (c.emailList ?? []).filter((e) => !emails.includes(e.toLowerCase()));
    if (next.length !== (c.emailList ?? []).length) await db.update(schema.campaigns).set({ emailList: next }).where(eq(schema.campaigns.id, c.id));
  }
}

/** Each mailbox's emails and what came of them, per day on the workspace's clock. */
async function dailyAnalytics(wsId: string, emails: string[], startDate: string, endDate: string) {
  const e = schema.emailEvents;
  const range = await workspaceRange(wsId, startDate, endDate);
  const day = daySql(e.createdAt, range);
  const start = range.start!;
  const end = range.end!;
  const rows = await db
    .select({
      date: day,
      email_account: e.accountEmail,
      sent: sql<number>`sum(case when ${e.type} = 'sent' then 1 else 0 end)`,
      bounced: sql<number>`sum(case when ${e.type} = 'bounce' and ${e.value} = 1 then 1 else 0 end)`,
      contacted: sql<number>`count(distinct case when ${e.type} = 'sent' then ${e.leadId} end)`,
      new_leads_contacted: sql<number>`sum(case when ${e.type} = 'sent' and ${e.isFirst} = 1 then 1 else 0 end)`,
      opened: sql<number>`sum(case when ${e.type} = 'open' then 1 else 0 end)`,
      unique_opened: sql<number>`count(distinct case when ${e.type} = 'open' then ${e.leadId} end)`,
      replies: sql<number>`sum(case when ${e.type} = 'reply' then 1 else 0 end)`,
      unique_replies: sql<number>`count(distinct case when ${e.type} = 'reply' then ${e.leadId} end)`,
      replies_automatic: sql<number>`sum(case when ${e.type} = 'auto_reply' then 1 else 0 end)`,
      unique_replies_automatic: sql<number>`count(distinct case when ${e.type} = 'auto_reply' then ${e.leadId} end)`,
      clicks: sql<number>`sum(case when ${e.type} = 'click' then 1 else 0 end)`,
      unique_clicks: sql<number>`count(distinct case when ${e.type} = 'click' then ${e.leadId} end)`,
    })
    .from(e)
    .where(
      and(
        eq(e.workspaceId, wsId),
        inArray(e.accountEmail, emails),
        sql`${e.createdAt} >= ${start}`,
        sql`${e.createdAt} <= ${end}`,
      ),
    )
    .groupBy(day, e.accountEmail)
    .orderBy(day);
  return rows.map((r) => ({
    date: r.date,
    email_account: r.email_account,
    sent: Number(r.sent),
    bounced: Number(r.bounced),
    contacted: Number(r.contacted),
    new_leads_contacted: Number(r.new_leads_contacted),
    opened: Number(r.opened),
    unique_opened: Number(r.unique_opened),
    replies: Number(r.replies),
    unique_replies: Number(r.unique_replies),
    replies_automatic: Number(r.replies_automatic),
    unique_replies_automatic: Number(r.unique_replies_automatic),
    clicks: Number(r.clicks),
    unique_clicks: Number(r.unique_clicks),
  }));
}

async function campaignMappings(wsId: string, account: AccountRow) {
  const tagRows = await db
    .select({ tagId: schema.customTagMappings.tagId })
    .from(schema.customTagMappings)
    .where(and(eq(schema.customTagMappings.workspaceId, wsId), eq(schema.customTagMappings.resourceId, account.id)));
  const tagIds = tagRows.map((r) => r.tagId);
  const c = schema.campaigns;
  const byEmail = sql`exists (select 1 from json_each(${c.emailList}) where lower(json_each.value) = ${account.email})`;
  const byTag = tagIds.length
    ? sql`exists (select 1 from json_each(${c.emailTagList}) where json_each.value in (${sql.join(
        tagIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`
    : sql`0`;
  const rows = await db
    .select({ id: c.id, name: c.name, status: c.status, createdAt: c.createdAt })
    .from(c)
    .where(and(eq(c.workspaceId, wsId), or(byEmail, byTag)))
    .orderBy(desc(c.createdAt));
  return rows.map((r) => ({ id: r.id, campaign_id: r.id, campaign_name: r.name, status: r.status, timestamp_created: iso(r.createdAt) }));
}

/** A number as spreadsheets write it ("50/day", "1,000"), at most `max`; anything else is left out, so the default applies. */
const sheetNumber = (max: number) => z.preprocess(readSheetNumber, z.number().transform((n) => Math.min(max, Math.round(n))).optional());

const csvAccount = z.object({
  email: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  imap_username: z.string().optional(),
  imap_password: z.string().optional(),
  imap_host: z.string().optional(),
  imap_port: sheetNumber(SHEET_MAXIMUMS.imap_port),
  smtp_username: z.string().optional(),
  smtp_password: z.string().optional(),
  smtp_host: z.string().optional(),
  smtp_port: sheetNumber(SHEET_MAXIMUMS.smtp_port),
  daily_limit: sheetNumber(SHEET_MAXIMUMS.daily_limit),
  warmup_limit: sheetNumber(SHEET_MAXIMUMS.warmup_limit),
  // "Recommended", "+2", "off": anything else is left out, so the default applies.
  warmup_increment: z.preprocess(readWarmupIncrease, z.string().optional()),
  reply_rate: sheetNumber(SHEET_MAXIMUMS.reply_rate),
});

registerJobHandler("import-accounts", async ({ job, progress, cancelled, secret }) => {
  const data = job.data as { accounts?: z.infer<typeof csvAccount>[]; enable_warmup?: boolean };
  const results: Array<{ email: string; ok: boolean; error?: string }> = [];
  // The mailboxes (with their passwords) travel encrypted; `accounts` is for jobs queued before that.
  const list = secret<z.infer<typeof csvAccount>[]>() ?? data.accounts ?? [];
  for (let i = 0; i < list.length; i++) {
    if (await cancelled()) break;
    const a = list[i]!;
    try {
      await createAccount(
        job.workspaceId,
        job.userId,
        // Read the same way as the API's: a value that can't be used says which and why.
        parse(createAccountSchema, {
          ...a,
          email: a.email,
          provider_code: ProviderCode.CUSTOM,
          enable_warmup: data.enable_warmup ?? true,
          warmup: {
            ...(a.warmup_limit !== undefined ? { limit: a.warmup_limit } : {}),
            ...(a.warmup_increment ? { increment: a.warmup_increment } : {}),
            ...(a.reply_rate !== undefined ? { reply_rate: a.reply_rate } : {}),
          },
        }),
      );
      results.push({ email: a.email, ok: true });
    } catch (err) {
      results.push({ email: a.email, ok: false, error: jobErrorMessage(err) });
    }
    await progress(((i + 1) / list.length) * 100, { results });
  }
  return { imported: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
});

export default async function accountRoutes(app: FastifyInstance) {
  const read = { scope: ["accounts", "read"] as ["accounts", "read"], perm: "accounts" as const };
  const create = { scope: ["accounts", "create"] as ["accounts", "create"], perm: "accounts" as const, write: true };
  const update = { scope: ["accounts", "update"] as ["accounts", "update"], perm: "accounts" as const, write: true };
  const del = { scope: ["accounts", "delete"] as ["accounts", "delete"], perm: "accounts" as const, write: true };

  // ---------- API v2 ----------
  app.get("/api/v2/accounts", { config: read }, async (req) => {
    const q = query(
      req,
      pageQuery.extend({
        status: zInt().optional(),
        provider_code: zInt().optional(),
        tag_ids: zList,
        tag_ids_all: zList,
        include_tags: zBool,
        filter: z.string().optional(),
        sort_by: z.enum(["timestamp_created", "email", "stat_warmup_score", "status", "health_score"]).optional(),
        sort_order: z.enum(["asc", "desc"]).optional(),
        skip: zInt(0).optional(),
      }),
    );
    const c = ctx(req);
    const limit = Math.min(q.limit ?? 100, 1000);
    const conds = await accountConditions(c.wsId, q);
    // Sorted lists page by position: next_starting_after is one, and is taken back as starting_after (or skip).
    const position = q.skip ?? (q.starting_after && /^\d+$/.test(q.starting_after) ? Number(q.starting_after) : 0);
    const withHealth = async (rows: AccountRow[], health?: Map<string, MailboxHealth>) =>
      serializeAccounts(c.wsId, rows, { includeTags: !!q.include_tags, health: health ?? (await mailboxHealth(rows)) });
    if (q.sort_by === "health_score") {
      // Health comes from each mailbox's recent days, so this sort happens here rather than in the database.
      const all = await db.select().from(t).where(and(...conds));
      const health = await mailboxHealth(all);
      const dir = (q.sort_order ?? "desc") === "asc" ? 1 : -1;
      const score = (a: AccountRow) => health.get(a.id)?.score ?? null;
      all.sort((a, b) => {
        const x = score(a);
        const y = score(b);
        // Mailboxes without a score yet go last either way.
        if (x === null || y === null) return x === y ? b.id.localeCompare(a.id) : x === null ? 1 : -1;
        return (x - y) * dir || b.id.localeCompare(a.id);
      });
      return { items: await withHealth(all.slice(position, position + limit), health), next_starting_after: all.length > position + limit ? String(position + limit) : null };
    }
    if (q.sort_by) {
      const col = { timestamp_created: t.createdAt, email: t.email, stat_warmup_score: t.warmupScore, status: t.status }[q.sort_by];
      const dir = (q.sort_order ?? "desc") === "asc" ? asc : desc;
      const rows = await db
        .select()
        .from(t)
        .where(and(...conds))
        .orderBy(dir(col), desc(t.id))
        .limit(limit + 1)
        .offset(position);
      const items = await withHealth(rows.slice(0, limit));
      return { items, next_starting_after: rows.length > limit ? String(position + limit) : null };
    }
    if (q.starting_after) conds.push(lt(t.id, q.starting_after));
    const rows = await db
      .select()
      .from(t)
      .where(and(...conds))
      .orderBy(desc(t.id))
      .limit(limit + 1);
    const page = paginated(rows, limit);
    return { ...page, items: await withHealth(page.items) };
  });

  app.post("/api/v2/accounts", { config: create }, async (req) => {
    const c = ctx(req);
    const b = body(req, createAccountSchema);
    const row = await createAccount(c.wsId, c.userId, b, req);
    return serializeAccount(row);
  });

  app.get("/api/v2/accounts/:email", { config: read }, async (req) => {
    const { email } = req.params as { email: string };
    const row = await findAccount(ctx(req).wsId, email);
    const [one] = await serializeAccounts(row.workspaceId, [row], { includeTags: true, health: await mailboxHealth([row]) });
    const standing = await warmupStanding(row);
    return { ...one, warmup_partners: standing.partners, warmup_elsewhere: standing.elsewhere, warmup_address_confirmed: standing.addressConfirmed };
  });

  app.patch("/api/v2/accounts/:email", { config: update }, async (req) => {
    const { email } = req.params as { email: string };
    const c = ctx(req);
    const account = await findAccount(c.wsId, email);
    const row = await patchAccount(account, body(req, patchSchema), c.userId);
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.ACCOUNT_UPDATE, req, metadata: { email: row.email } });
    return serializeAccount(row);
  });

  app.delete("/api/v2/accounts/:email", { config: del }, async (req) => {
    const { email } = req.params as { email: string };
    const c = ctx(req);
    const account = await findAccount(c.wsId, email);
    await deleteAccounts(c.wsId, [account]);
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.ACCOUNT_DELETION, req, metadata: { email: account.email } });
    return serializeAccount(account);
  });

  for (const action of ["enable", "disable"] as const) {
    app.post(`/api/v2/accounts/warmup/${action}`, { config: update }, async (req) => {
      const c = ctx(req);
      const b = body(req, bulkTarget);
      const targets = await resolveTargets(c.wsId, b);
      if (!targets.length) throw badRequest("No accounts selected");
      const skipped = action === "enable" ? targets.filter((a) => a.status !== AccountStatus.ACTIVE) : [];
      const ids = targets.filter((a) => !skipped.includes(a)).map((a) => a.id);
      if (action === "enable") await enableWarmup(ids);
      else await disableWarmup(ids);
      const job = await createJob({
        workspaceId: c.wsId,
        userId: c.userId,
        type: "update-warmup-accounts",
        entityType: "workspace",
        entityId: c.wsId,
        data: {
          action,
          total: targets.length,
          success_count: ids.length,
          failed: skipped.map((a) => ({ email: a.email, reason: a.status === AccountStatus.PAUSED ? "Account is paused" : "Account has a connection error" })),
        },
      });
      // The update is applied synchronously; the job row is kept for the activity log and polling clients.
      const [done] = await db
        .update(schema.backgroundJobs)
        .set({ status: "success", progress: 100, result: { success_count: ids.length, failed_count: skipped.length } })
        .where(eq(schema.backgroundJobs.id, job.id))
        .returning();
      return serializeJob(done!);
    });
  }

  app.post("/api/v2/accounts/warmup-analytics", { config: read }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ emails: z.array(z.string()).min(1).max(1000), days: z.number().int().min(1).max(90).optional() }));
    const rows = await db
      .select({ id: t.id, email: t.email })
      .from(t)
      .where(and(eq(t.workspaceId, c.wsId), inArray(t.email, b.emails.map((e) => e.toLowerCase()))));
    return warmupAnalytics(rows, b.days ?? 14, await workspaceZone(c.wsId));
  });

  app.get("/api/v2/accounts/analytics/daily", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ start_date: z.string().optional(), end_date: z.string().optional(), emails: zList }));
    const zone = await workspaceZone(c.wsId);
    const end = q.end_date ?? dayOn(zone);
    // Thirty days up to the end's day (a date and time counts as the day it falls on).
    const start = q.start_date ?? daysBefore(dayOf(end, zone), 29);
    const emails = [...new Set((q.emails ?? []).map((e) => e.toLowerCase()))];
    if (!emails.length) throw badRequest("emails is required");
    if (emails.length > 200) throw badRequest("At most 200 accounts per request");
    return dailyAnalytics(c.wsId, emails, start, end);
  });

  // Every mailbox's figures for the whole period (all time without dates). A person counts once, however many days
  // they got emails: adding up the days counted them again each day.
  app.get("/api/app/accounts/analytics/totals", { config: read }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ start_date: z.string().optional(), end_date: z.string().optional() }));
    const range = await workspaceRange(c.wsId, q.start_date, q.end_date);
    const e = schema.emailEvents;
    const people = (type: string) => sql<number>`count(distinct case when ${e.type} = ${type} then ${e.leadId} end)`;
    const rows = await db
      .select({
        email: e.accountEmail,
        sent: sql<number>`sum(case when ${e.type} = 'sent' then 1 else 0 end)`,
        contacted: people("sent"),
        opened: people("open"),
        replied: people("reply"),
        bounced: sql<number>`sum(case when ${e.type} = 'bounce' and ${e.value} = 1 then 1 else 0 end)`,
        // Tries the receiving server refused at once: never sent, yet tried (a bounce rate is out of sent + refused).
        refused: sql<number>`sum(case when ${refusedAtSend} then 1 else 0 end)`,
      })
      .from(e)
      .where(
        and(
          eq(e.workspaceId, c.wsId),
          isNotNull(e.accountEmail),
          range.start !== undefined ? sql`${e.createdAt} >= ${range.start}` : undefined,
          range.end !== undefined ? sql`${e.createdAt} <= ${range.end}` : undefined,
        ),
      )
      .groupBy(e.accountEmail);
    return rows.map((r) => ({
      email: r.email!,
      sent: Number(r.sent),
      refused: Number(r.refused),
      contacted: Number(r.contacted),
      opened: Number(r.opened),
      replied: Number(r.replied),
      bounced: Number(r.bounced),
    }));
  });

  app.post("/api/v2/accounts/pause", { config: update }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ emails: z.array(z.string()).min(1) }));
    const emails = [...new Set(b.emails.map((e) => e.trim().toLowerCase()))];
    const rows = await db.select().from(t).where(and(eq(t.workspaceId, c.wsId), inArray(t.email, emails)));
    const pausable = rows.filter((r) => r.status !== AccountStatus.PAUSED);
    if (pausable.length) await db.update(t).set({ status: AccountStatus.PAUSED, modifiedBy: c.userId }).where(inArray(t.id, pausable.map((r) => r.id)));
    const paused = new Set(pausable.map((r) => r.email));
    return { paused_emails: [...paused], failed_emails: emails.filter((e) => !paused.has(e)) };
  });

  app.post("/api/v2/accounts/:email/pause", { config: update }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    const [row] = await db.update(t).set({ status: AccountStatus.PAUSED, modifiedBy: c.userId }).where(eq(t.id, account.id)).returning();
    return serializeAccount(row!);
  });

  app.post("/api/v2/accounts/:email/resume", { config: update }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    const [row] = await db
      .update(t)
      .set({ status: account.status === AccountStatus.PAUSED ? AccountStatus.ACTIVE : account.status, modifiedBy: c.userId })
      .where(eq(t.id, account.id))
      .returning();
    return serializeAccount(row!);
  });

  app.post("/api/v2/accounts/:email/mark-fixed", { config: update }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    // Both sides count as working again; the mailbox goes back to the status it had before (a paused one stays paused).
    await clearAccountError(account, "all");
    const [row] = await db
      .update(t)
      .set({
        autofixFailed: null,
        warmupStatus: account.warmupStatus < 0 && account.warmupStatus !== WarmupStatus.PERMANENT_SUSPENSION ? WarmupStatus.ACTIVE : account.warmupStatus,
        modifiedBy: c.userId,
      })
      .where(eq(t.id, account.id))
      .returning();
    dropTransport(account.id);
    return serializeAccount(row!);
  });

  app.get("/api/v2/accounts/ctd/status", { config: read }, async (req) => {
    const q = query(req, z.object({ host: z.string().trim().toLowerCase().min(3) }));
    const r = await checkTrackingDomain(q.host);
    return { success: r.status === "verified", ssl: r.ssl, cname: r.cname, host: q.host, expected_target: trackingHost() };
  });

  app.post("/api/v2/accounts/test/vitals", { config: read }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ accounts: z.array(z.string()).max(5000).optional() }));
    // The workspace's own mailboxes (the ones named, or all), not any address someone names; sandbox ones have no DNS.
    const own = await db.select({ email: t.email }).from(t).where(and(eq(t.workspaceId, c.wsId), ne(t.providerCode, ProviderCode.SANDBOX)));
    const named = new Set((b.accounts ?? []).map((e) => e.trim().toLowerCase()));
    const emails = own.map((r) => r.email).filter((e) => !named.size || named.has(e));
    const domains = [...new Set(emails.map(domainOf).filter(Boolean))];
    // Asked for now: looked up afresh, not from answers kept a while, four domains at a time.
    const results: Awaited<ReturnType<typeof checkDomainAuth>>[] = [];
    for (let i = 0; i < domains.length; i += 4) results.push(...(await Promise.all(domains.slice(i, i + 4).map((d) => checkDomainAuth(d, undefined, { fresh: true })))));
    // Kept as each domain's latest check, as if run from Accounts.
    for (const r of results) if (checkableDomain(r.domain)) await saveDomainCheck(c.wsId, r);
    const strip = (r: (typeof results)[number]) => ({ domain: r.domain, allPass: r.allPass, mx: r.mx, spf: r.spf, dkim: r.dkim, dmarc: r.dmarc, indeterminate: r.indeterminate, details: r.details });
    return { status: "success", success_list: results.filter((r) => r.allPass).map(strip), failure_list: results.filter((r) => !r.allPass).map(strip) };
  });

  /** Checks the DNS (MX, SPF, DKIM, DMARC) of the chosen mailboxes' domains now. Sandbox mailboxes are left out. */
  app.post("/api/app/accounts/dns-check", { config: read }, async (req) => {
    const c = ctx(req);
    const targets = await resolveTargets(c.wsId, body(req, bulkTarget));
    // "Check again" after fixing a record: looked up afresh, not from answers kept a while.
    return { items: await checkMailboxDomains(c.wsId, targets, { fresh: true }), sandbox: targets.filter((a) => a.providerCode === ProviderCode.SANDBOX).length };
  });

  app.post("/api/v2/accounts/move", { config: { ...update, admin: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ emails: z.array(z.string()).min(1), source_workspace_id: z.string(), destination_workspace_id: z.string() }));
    if (b.source_workspace_id !== c.wsId) throw forbidden("source_workspace_id must be the current workspace");
    if (b.destination_workspace_id === b.source_workspace_id) throw badRequest("Source and destination are the same workspace");
    const [dest] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, b.destination_workspace_id)).limit(1);
    if (!dest || dest.deletedAt) throw notFound("Destination workspace");
    if (c.auth.user) {
      const [m] = await db
        .select()
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, dest.id), eq(schema.workspaceMembers.userId, c.auth.user.id)))
        .limit(1);
      if (!m || (m.role !== "owner" && m.role !== "admin")) throw forbidden("You must be an admin of the destination workspace");
    } else if (dest.ownerId !== c.workspace.ownerId) {
      throw forbidden("API keys can only move accounts between workspaces with the same owner");
    }
    const rows = await db.select().from(t).where(and(eq(t.workspaceId, c.wsId), inArray(t.email, b.emails.map((e) => e.toLowerCase()))));
    const destExisting = new Set(
      (await db.select({ email: t.email }).from(t).where(and(eq(t.workspaceId, dest.id), inArray(t.email, rows.map((r) => r.email))))).map((r) => r.email),
    );
    const movable = rows.filter((r) => !destExisting.has(r.email));
    if (movable.length) {
      const ids = movable.map((r) => r.id);
      await db.update(t).set({ workspaceId: dest.id, modifiedBy: c.userId }).where(inArray(t.id, ids));
      await db.update(schema.accountDailyStats).set({ workspaceId: dest.id }).where(inArray(schema.accountDailyStats.accountId, ids));
      await db.delete(schema.customTagMappings).where(and(eq(schema.customTagMappings.workspaceId, c.wsId), inArray(schema.customTagMappings.resourceId, ids)));
    }
    return { status: "success", moved: movable.map((r) => r.email), skipped: rows.filter((r) => destExisting.has(r.email)).map((r) => r.email) };
  });

  app.get("/api/v2/account-campaign-mappings/:email", { config: { scope: ["account_campaign_mappings", "read"], perm: "accounts" } }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    const q = query(req, pageQuery);
    const all = await campaignMappings(c.wsId, account);
    const startIdx = q.starting_after ? all.findIndex((m) => m.id === q.starting_after) + 1 : 0;
    const limit = q.limit ?? 100;
    const slice = all.slice(startIdx, startIdx + limit + 1);
    return paginated(slice, limit);
  });

  // ---------- App endpoints ----------
  app.get("/api/app/accounts/providers", { config: { perm: "accounts" } }, async () => ({
    presets: PROVIDER_PRESETS,
    oauth: { google: oauthConfigured("google"), microsoft: oauthConfigured("microsoft") },
    provider_labels: PROVIDER_LABELS,
    status_labels: ACCOUNT_STATUS_LABELS,
    warmup_status_labels: WARMUP_STATUS_LABELS,
    tracking_host: trackingHost(),
    /** False on a server people can't reach (a laptop): a tracking domain would have nothing to point at. */
    tracking_reachable: reachableFromInternet(config.trackingBaseUrl),
  }));

  app.post("/api/app/accounts/detect", { config: { perm: "accounts" } }, async (req) => {
    const b = body(req, z.object({ email: z.string().trim().toLowerCase() }));
    return { preset: await detectProvider(b.email) };
  });

  app.post("/api/app/accounts/test-connection", { config: { perm: "accounts", write: true } }, async (req) => {
    const b = body(req, createAccountSchema);
    return testCredentials(b);
  });

  app.post("/api/app/accounts", { config: create }, async (req) => {
    const c = ctx(req);
    const b = body(req, createAccountSchema);
    const row = await createAccount(c.wsId, c.userId, b, req);
    return serializeAccount(row);
  });

  app.post("/api/app/accounts/sandbox", { config: create }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ count: z.number().int().min(1).max(25).default(3), domain: z.string().trim().toLowerCase().optional(), enable_warmup: z.boolean().default(true) }));
    const rows = await createSandboxAccounts(c.workspace, c.userId, { count: b.count, domain: b.domain, enableWarmup: b.enable_warmup }, req);
    return { items: rows.map((r) => serializeAccount(r)) };
  });

  app.get("/api/app/accounts/oauth/:provider/url", { config: create }, async (req, reply) => {
    const c = ctx(req);
    const { provider } = params(req, z.object({ provider: z.enum(["google", "microsoft"]) }));
    const q = query(req, z.object({ login_hint: z.string().optional(), enable_warmup: zBool }));
    const url = buildAuthUrl(
      {
        provider: provider as OAuthProvider,
        purpose: "connect_account",
        workspace_id: c.wsId,
        user_id: c.userId ?? undefined,
        return_to: q.enable_warmup === false ? "no_warmup" : undefined,
        nonce: bindToBrowser(reply),
      },
      q.login_hint,
    );
    return { url };
  });

  app.post("/api/app/accounts/import", { config: create }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ accounts: z.array(csvAccount).min(1).max(5000), enable_warmup: z.boolean().default(true) }));
    const job = await createJob({
      workspaceId: c.wsId,
      userId: c.userId,
      type: "import-accounts",
      entityType: "workspace",
      entityId: c.wsId,
      data: { enable_warmup: b.enable_warmup, total: b.accounts.length, emails: b.accounts.map((a) => a.email) },
      secret: b.accounts,
    });
    return serializeJob(job);
  });

  app.post("/api/app/accounts/bulk", { config: update }, async (req) => {
    const c = ctx(req);
    const b = body(req, bulkTarget.extend({ action: z.enum(["pause", "resume", "delete", "reconnect", "update", "mark_fixed"]), patch: patchSchema.optional() }));
    const targets = await resolveTargets(c.wsId, b);
    if (!targets.length) throw badRequest("No accounts selected");
    const ids = targets.map((a) => a.id);
    switch (b.action) {
      case "pause":
        await db.update(t).set({ status: AccountStatus.PAUSED, modifiedBy: c.userId }).where(inArray(t.id, ids));
        break;
      case "resume":
        await db.update(t).set({ status: AccountStatus.ACTIVE, modifiedBy: c.userId }).where(and(inArray(t.id, ids), eq(t.status, AccountStatus.PAUSED)));
        break;
      case "mark_fixed": {
        const failing = targets.filter((x) => x.status < 0);
        for (const a of failing) await clearAccountError(a, "all");
        if (failing.length) await db.update(t).set({ autofixFailed: null, modifiedBy: c.userId }).where(inArray(t.id, failing.map((x) => x.id)));
        break;
      }
      case "delete":
        // What DELETE /api/v2/accounts/:email asks for: an API key needs accounts:delete, a member more than viewing rights.
        assertAccess(req.auth, del);
        await deleteAccounts(c.wsId, targets);
        await audit({ workspaceId: c.wsId, activityType: AuditActivity.ACCOUNT_DELETION, req, affectedCount: targets.length });
        break;
      case "reconnect": {
        // A connection test, as POST /api/app/accounts/test-connection: for members who can write.
        assertAccess(req.auth, { perm: "accounts", write: true });
        const results = await Promise.all(
          targets.map(async (a) => {
            const r = await driverFor(a).verify();
            await applyConnectionTest(a, r);
            return { email: a.email, ok: r.imap.ok && r.smtp.ok, imap: r.imap, smtp: r.smtp };
          }),
        );
        return { ok: true, results };
      }
      case "update": {
        if (!b.patch) throw badRequest("patch is required");
        for (const a of targets) await patchAccount(a, b.patch, c.userId);
        await audit({ workspaceId: c.wsId, activityType: AuditActivity.ACCOUNT_UPDATE, req, affectedCount: targets.length });
        break;
      }
    }
    return { ok: true, affected: targets.length };
  });

  app.get("/api/app/accounts/export", { config: read }, async (req, reply) => {
    const c = ctx(req);
    const rows = await db.select().from(t).where(eq(t.workspaceId, c.wsId)).orderBy(asc(t.email));
    const health = await mailboxHealth(rows);
    const items = await serializeAccounts(c.wsId, rows, { includeTags: true });
    const csv = toCsv(
      items.map((a) => ({
        email: a.email,
        first_name: a.first_name,
        last_name: a.last_name,
        provider: PROVIDER_LABELS[a.provider_code] ?? a.provider_code,
        status: ACCOUNT_STATUS_LABELS[a.status] ?? a.status,
        warmup_status: WARMUP_STATUS_LABELS[a.warmup_status] ?? a.warmup_status,
        daily_limit: a.daily_limit,
        sending_gap_minutes: a.sending_gap,
        warmup_daily_limit: a.warmup?.limit,
        warmup_reply_rate: a.warmup?.reply_rate,
        health_score: health.get(a.id)?.score ?? "",
        warmup_score: a.stat_warmup_score ?? "",
        tracking_domain: a.tracking_domain_name ?? "",
        tags: ((a.tags as unknown as Array<{ label: string }>) ?? []).map((x) => x.label).join("|"),
        created_at: a.timestamp_created,
      })),
    );
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="email-accounts-${await workspaceToday(c.wsId)}.csv"`);
    return csv;
  });

  app.get("/api/app/accounts/summary", { config: read }, async (req) => {
    const c = ctx(req);
    const rows = await db.select().from(t).where(eq(t.workspaceId, c.wsId));
    const since = daysBefore(dayOn(await workspaceZone(c.wsId)), 6);
    const [stats] = await db
      .select({
        sent: sql<number>`coalesce(sum(${schema.accountDailyStats.sent}), 0)`,
        warmup: sql<number>`coalesce(sum(${schema.accountDailyStats.warmupSent}), 0)`,
      })
      .from(schema.accountDailyStats)
      .where(and(eq(schema.accountDailyStats.workspaceId, c.wsId), sql`${schema.accountDailyStats.date} >= ${since}`));
    const [health, today, dns] = await Promise.all([mailboxHealth(rows), todayStats(rows), mailboxDns(c.wsId, rows)]);
    const scores = rows.map((r) => health.get(r.id)?.score).filter((s): s is number => s !== null && s !== undefined);
    const resting = (r: AccountRow) => !!r.campaignPauseUntil && r.campaignPauseUntil.getTime() > Date.now();
    return {
      total: rows.length,
      active: rows.filter((r) => r.status === AccountStatus.ACTIVE).length,
      paused: rows.filter((r) => r.status === AccountStatus.PAUSED).length,
      errors: rows.filter((r) => r.status < 0).length,
      resting: rows.filter(resting).length,
      warmup_active: rows.filter((r) => r.warmupStatus === WarmupStatus.ACTIVE).length,
      emails_sent_7d: Number(stats?.sent ?? 0),
      warmup_emails_7d: Number(stats?.warmup ?? 0),
      // Average mailbox health (see services/mailbox-health), over mailboxes with enough activity to judge.
      health_score: scores.length ? Math.round(scores.reduce((s, n) => s + n, 0) / scores.length) : null,
      at_risk: rows.filter((r) => health.get(r.id)?.status === "at_risk").length,
      // What campaigns can send today: working mailboxes that aren't resting, at today's limit (slow ramp included).
      daily_capacity: rows.filter((r) => r.status === AccountStatus.ACTIVE && !resting(r)).reduce((s, r) => s + effectiveDailyLimit(r, today.get(r.id)), 0),
      // Mailboxes whose domain is missing an SPF, DKIM, DMARC or MX record.
      dns_issues: rows.filter((r) => missingRecord(dns.get(r.id))).length,
    };
  });

  app.get("/api/app/accounts/:email/health", { config: read }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    const q = query(req, z.object({ days: zInt(7, 90).optional() }));
    const [health, trend] = await Promise.all([mailboxHealth([account]), healthTrend(account, q.days ?? 30)]);
    return { health: health.get(account.id) ?? null, trend, timezone: await workspaceZone(c.wsId) };
  });

  app.get("/api/app/accounts/:email/campaigns", { config: read }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    return { items: await campaignMappings(c.wsId, account) };
  });

  app.post("/api/app/accounts/:email/reconnect", { config: update }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    dropTransport(account.id);
    const r = await driverFor(account).verify();
    await applyConnectionTest(account, r);
    const [row] = await db.select().from(t).where(eq(t.id, account.id));
    return { ok: r.imap.ok && r.smtp.ok, imap: r.imap, smtp: r.smtp, account: serializeAccount(row!) };
  });

  app.post("/api/app/accounts/:email/sync", { config: update }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    return syncAccount(account);
  });

  app.post("/api/app/accounts/:email/test-email", { config: update }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    const b = body(req, z.object({ to: z.string().trim().toLowerCase() }));
    const messageId = newMessageId(account.email);
    try {
      await driverFor(account).send({
        from: { name: `${account.firstName} ${account.lastName}`.trim(), address: account.email },
        to: [{ address: b.to }],
        subject: `Test email from ${account.email}`,
        html: `<p>This is a test email sent from <b>${account.email}</b> through ${config.brandName}.</p><p>If you can read this, sending works.</p>${account.signature ? `<br/>${account.signature}` : ""}`,
        messageId,
      });
      // A send that works ends a sending failure, like a campaign send would.
      await noteSendSuccess(account);
      return { ok: true, message_id: messageId };
    } catch (err) {
      const e = err as Error & { kind?: string };
      return { ok: false, error: e.message, kind: e.kind ?? "unknown" };
    }
  });

  app.post("/api/app/accounts/:email/ctd/check", { config: update }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    if (!account.trackingDomainName) throw badRequest("No custom tracking domain is set for this account");
    const r = await checkTrackingDomain(account.trackingDomainName);
    // Every mailbox here with this domain gets the answer.
    await db.update(t).set({ trackingDomainStatus: r.status }).where(and(eq(t.workspaceId, c.wsId), eq(t.trackingDomainName, account.trackingDomainName)));
    return { ...r, host: account.trackingDomainName, expected_target: trackingHost() };
  });

  app.post("/api/app/accounts/tags", { config: update }, async (req) => {
    const c = ctx(req);
    const b = body(req, bulkTarget.extend({ tag_ids: z.array(z.string()).min(1), assign: z.boolean() }));
    await assertTags(c.wsId, b.tag_ids);
    const targets = await resolveTargets(c.wsId, b);
    const ids = targets.map((a) => a.id);
    if (!ids.length) throw badRequest("No accounts selected");
    if (b.assign) {
      const values = ids.flatMap((rid) => b.tag_ids.map((tagId) => ({ workspaceId: c.wsId, tagId, resourceId: rid, resourceType: 1 })));
      for (let i = 0; i < values.length; i += 500) await db.insert(schema.customTagMappings).values(values.slice(i, i + 500)).onConflictDoNothing();
    } else {
      await db
        .delete(schema.customTagMappings)
        .where(and(eq(schema.customTagMappings.workspaceId, c.wsId), inArray(schema.customTagMappings.tagId, b.tag_ids), inArray(schema.customTagMappings.resourceId, ids)));
    }
    return { success: true, affected: ids.length };
  });

  app.get("/api/app/accounts/:email/warmup-log", { config: read }, async (req) => {
    const c = ctx(req);
    const account = await findAccount(c.wsId, (req.params as { email: string }).email);
    const w = schema.warmupMessages;
    const rows = await db
      .select()
      .from(w)
      .where(or(eq(w.senderAccountId, account.id), eq(w.recipientAccountId, account.id)))
      .orderBy(desc(w.sentAt))
      .limit(50);
    return {
      items: rows.map((r) => ({
        id: r.id,
        direction: r.senderAccountId === account.id ? "sent" : "received",
        subject: r.subject,
        is_reply: r.isReply,
        sent_at: iso(r.sentAt),
        delivered_at: iso(r.deliveredAt),
        folder: r.folder,
        saved_from_spam: r.savedFromSpam,
        opened: r.opened,
        important: r.important,
        replied: r.replied,
      })),
    };
  });

  // Accounts without any campaign or warmup activity, used by onboarding checklists.
  app.get("/api/app/accounts/idle", { config: read }, async (req) => {
    const c = ctx(req);
    const rows = await db
      .select({ email: t.email })
      .from(t)
      .where(and(eq(t.workspaceId, c.wsId), isNull(t.lastSentAt), ne(t.warmupStatus, WarmupStatus.ACTIVE)));
    return { items: rows.map((r) => r.email) };
  });
}

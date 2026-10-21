// Emails / Unibox (API v2 + app endpoints): list, read, reply, forward, test sends, unread counts,
// thread views, folders and search counts, reminders, scheduled sends, bulk actions, attachments and exports.
import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity, DEFAULT_INTEREST_STATUSES, EmailType, LeadStatus, delayToMs } from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { ctx } from "../http/context";
import { HttpError, assertFound, badRequest, notFound } from "../http/errors";
import { body, chunk, query, zBool, zInt, zList, zWhen } from "../http/util";
import { resolveStoredPath } from "../lib/data-files";
import { iso } from "../lib/time";
import { newMessageId } from "../mail/compose";
import { driverFor } from "../mail/driver";
import { MailError } from "../mail/types";
import { classifyError } from "../mail/smtp-imap";
import { campaignName, type EmailRow } from "../services/activity";
import { aiAvailable, toHttpError } from "../services/ai";
import { audit } from "../services/audit";
import { AgentType, businessContext, guidanceText } from "../services/agents/common";
import { payloadOf } from "../services/agents/inbox-manager";
import { draftReply, threadMessages } from "../services/agents/reply-engine";
import { calendlyLink } from "../services/integrations";
import { serializeLead } from "../services/leads";
import { assertMembers } from "../services/members";
import {
  MAX_UPLOAD_BYTES,
  attachmentRows,
  checkContinuation,
  chronological,
  composeAndSend,
  mbox,
  rawMessage,
  removeUploads,
  saveUpload,
  reminderAfterSend,
  scheduleContinuation,
  searchConditions,
  sendNewEmail,
  serializeEmail,
  tooLarge,
} from "../services/unibox";
import { untrackHtml, untrackText } from "../services/tracking";
import { workspaceRange, workspaceToday } from "../services/workspace-clock";
import { findAccount } from "./accounts";
import { toCsv } from "../lib/csv";

const M = schema.emails;

async function findEmail(wsId: string, id: string): Promise<EmailRow> {
  const [row] = await db
    .select()
    .from(M)
    .where(and(eq(M.id, id), eq(M.workspaceId, wsId), isNull(M.deletedAt)))
    .limit(1);
  return assertFound(row, "Email");
}

/** The lead a conversation belongs to: the newest of its emails that has one. */
async function threadLeadId(wsId: string, threadId: string | null): Promise<string | null> {
  if (!threadId) return null;
  const [row] = await db
    .select({ leadId: M.leadId })
    .from(M)
    .where(and(eq(M.workspaceId, wsId), eq(M.threadId, threadId), isNotNull(M.leadId), isNull(M.deletedAt)))
    .orderBy(desc(M.timestampEmail))
    .limit(1);
  return row?.leadId ?? null;
}

async function withCampaignNames(rows: EmailRow[], previewOnly = false) {
  return Promise.all(rows.map(async (r) => serializeEmail(r, { previewOnly, campaignName: r.campaignId ? await campaignName(r.campaignId) : null })));
}

const listQuery = z.object({
  limit: zInt(1, 100).optional(),
  starting_after: z.string().optional(),
  search: z.string().optional(),
  campaign_id: z.string().optional(),
  list_id: z.string().optional(),
  i_status: zInt().optional(),
  eaccount: zList,
  is_unread: zBool,
  has_reminder: zBool,
  mode: z.enum(["emode_focused", "emode_others", "emode_all"]).optional(),
  preview_only: zBool,
  sort_order: z.enum(["asc", "desc"]).optional(),
  scheduled_only: zBool,
  assigned_to: z.string().optional(),
  lead: z.string().optional(),
  company_domain: z.string().optional(),
  marked_as_done: zBool,
  email_type: z.enum(["received", "sent", "manual"]).optional(),
  min_timestamp_created: zWhen.optional(),
  max_timestamp_created: zWhen.optional(),
  latest_of_thread: zBool,
});
type ListQuery = z.infer<typeof listQuery>;

/**
 * Shared filters for the v2 list and the Unibox thread list. Scheduled (unsent) emails are left out unless asked for,
 * or `anyType` is set (the Unibox adds its own folder conditions).
 */
async function emailConditions(wsId: string, q: Partial<ListQuery>, opts: { anyType?: boolean } = {}): Promise<SQL[]> {
  const conds: SQL[] = [eq(M.workspaceId, wsId), isNull(M.deletedAt)];
  if (q.search) conds.push(...(await searchConditions(wsId, q.search)));
  if (q.campaign_id) conds.push(eq(M.campaignId, q.campaign_id));
  if (q.list_id) conds.push(eq(M.listId, q.list_id));
  if (q.i_status !== undefined) conds.push(eq(M.interestStatus, q.i_status));
  if (q.eaccount?.length) conds.push(inArray(M.eaccount, q.eaccount.map((e) => e.toLowerCase())));
  if (q.is_unread !== undefined) conds.push(eq(M.isUnread, q.is_unread ? 1 : 0));
  if (q.has_reminder) conds.push(isNotNull(M.reminderAt));
  if (q.mode === "emode_focused") conds.push(eq(M.isFocused, 1));
  if (q.mode === "emode_others") conds.push(eq(M.isFocused, 0));
  if (q.scheduled_only) conds.push(eq(M.ueType, EmailType.SCHEDULED));
  else if (!q.email_type && !opts.anyType) conds.push(ne(M.ueType, EmailType.SCHEDULED));
  if (q.lead) conds.push(eq(M.leadEmail, q.lead.toLowerCase()));
  if (q.company_domain) conds.push(sql`${M.leadEmail} like ${`%@${q.company_domain.toLowerCase()}`}`);
  if (q.marked_as_done !== undefined) conds.push(eq(M.archived, !!q.marked_as_done));
  if (q.email_type === "received") conds.push(eq(M.ueType, EmailType.RECEIVED));
  if (q.email_type === "sent") conds.push(eq(M.ueType, EmailType.CAMPAIGN_SENT));
  if (q.email_type === "manual") conds.push(eq(M.ueType, EmailType.SENT));
  if (q.min_timestamp_created || q.max_timestamp_created) {
    // A date is the whole day on the workspace clock; an exact time stays exact.
    const r = await workspaceRange(wsId, q.min_timestamp_created, q.max_timestamp_created);
    if (r.start !== undefined) conds.push(gte(M.createdAt, new Date(r.start)));
    if (r.end !== undefined) conds.push(lte(M.createdAt, new Date(r.end)));
  }
  if (q.assigned_to) {
    const leads = await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(and(eq(schema.leads.workspaceId, wsId), eq(schema.leads.assignedTo, q.assigned_to)));
    conds.push(inArray(M.leadId, [...leads.map((l) => l.id), "__none__"]));
  }
  return conds;
}

// ---------- Unibox folders ----------

const uniboxQuery = listQuery.extend({
  folder: z.enum(["inbox", "sent", "scheduled", "reminders", "done", "all"]).optional(),
  page: zInt(1).optional(),
});
type UniboxQuery = z.infer<typeof uniboxQuery>;
type Folder = NonNullable<UniboxQuery["folder"]>;

/** The thread has a reply nobody marked done, so it is (back) in the inbox. */
const openReplyInThread = sql`exists (select 1 from emails x where x.workspace_id = ${M.workspaceId} and x.thread_id = ${M.threadId} and x.ue_type = ${EmailType.RECEIVED} and x.archived = 0 and x.deleted_at is null)`;

/** What puts one email in a folder. A thread shows in a folder when at least one of its emails is in it. */
function folderCondition(folder: Folder, mode: ListQuery["mode"] = "emode_focused"): SQL | undefined {
  switch (folder) {
    case "inbox":
      // Marking a thread done takes it out of the inbox until a new reply arrives.
      return and(eq(M.ueType, EmailType.RECEIVED), eq(M.archived, false), mode === "emode_all" ? undefined : eq(M.isFocused, mode === "emode_others" ? 0 : 1));
    case "sent":
      return inArray(M.ueType, [EmailType.SENT, EmailType.CAMPAIGN_SENT]);
    case "scheduled":
      return eq(M.ueType, EmailType.SCHEDULED);
    case "reminders":
      return and(isNotNull(M.reminderAt), ne(M.ueType, EmailType.SCHEDULED));
    case "done":
      return and(eq(M.archived, true), ne(M.ueType, EmailType.SCHEDULED), sql`not ${openReplyInThread}`);
    case "all":
      return undefined;
  }
}

/** Workspace Unibox preferences hide auto-replies and bounce notices from the inbox unless the user searches for them. */
function inboxPreferences(settings: unknown, search: string | undefined): SQL[] {
  const prefs = (settings ?? {}) as Record<string, unknown>;
  if (search) return [];
  const conds: SQL[] = [];
  if (prefs.unibox_show_auto_replies === false) conds.push(eq(M.isAutoReply, 0));
  if (prefs.unibox_save_undelivered === false) conds.push(eq(M.isBounce, false));
  return conds;
}

/** Conditions on the emails that put a thread in the list: the folder, the filters and the search. */
async function uniboxFilters(wsId: string, settings: unknown, q: UniboxQuery, folder: Folder): Promise<SQL[]> {
  const conds = await emailConditions(wsId, { ...q, mode: folder === "inbox" ? undefined : q.mode }, { anyType: true });
  const inFolder = folderCondition(folder, q.mode);
  if (inFolder) conds.push(inFolder);
  if (folder === "inbox") conds.push(...inboxPreferences(settings, q.search));
  return conds;
}

/** Threads with at least one matching email, newest activity first, with their counts, first reminder and scheduled send. */
async function threadGroups(wsId: string, folder: Folder, filters: SQL[], limit: number, offset = 0) {
  const matching = db.select({ threadId: M.threadId }).from(M).where(and(...filters));
  const visible = and(eq(M.workspaceId, wsId), isNull(M.deletedAt), inArray(M.threadId, matching))!;
  const lastAt = sql<number>`max(${M.timestampEmail})`;
  return db
    .select({
      threadId: M.threadId,
      lastAt,
      count: sql<number>`count(*)`,
      unread: sql<number>`sum(case when ${M.ueType} = ${EmailType.RECEIVED} then ${M.isUnread} else 0 end)`,
      reminder: sql<number | null>`min(${M.reminderAt})`,
      scheduled: sql<number | null>`min(${M.scheduledAt})`,
    })
    .from(M)
    .where(folder === "scheduled" ? visible : and(visible, ne(M.ueType, EmailType.SCHEDULED)))
    .groupBy(M.threadId)
    .orderBy(desc(lastAt), desc(M.threadId))
    .limit(limit)
    .offset(offset);
}

/** Interest status code → label name: the built-in statuses plus the workspace's own labels. */
async function labelNames(wsId: string): Promise<Map<number, string>> {
  const custom = await db.select({ code: schema.leadLabels.interestStatus, label: schema.leadLabels.label }).from(schema.leadLabels).where(eq(schema.leadLabels.workspaceId, wsId));
  return new Map<number, string>([...DEFAULT_INTEREST_STATUSES.map((s) => [s.code, s.label] as [number, string]), ...custom.map((c) => [c.code, c.label] as [number, string])]);
}

/** `attachment` Content-Disposition with an ASCII fallback name and the UTF-8 name (RFC 6266). */
function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** A file name made from an email subject. */
const fileStem = (subject: string | null | undefined) =>
  (subject ?? "")
    .replace(/^\s*((re|fwd?)\s*:\s*)+/i, "")
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "conversation";

const addressLabel = (a: { address: string; name?: string | null } | undefined) => (a ? (a.name?.trim() ? `${a.name.trim()} <${a.address}>` : a.address) : "");

/** What the Unibox shows of an email: tracking removed, so reading your own send never counts as the lead's open or click. */
function forDisplay<T extends { body: { text: string; html: string }; content_preview: string | null }>(e: T): T {
  return {
    ...e,
    body: { text: untrackText(e.body.text ?? ""), html: untrackHtml(e.body.html ?? "") },
    content_preview: e.content_preview ? untrackText(e.content_preview) : e.content_preview,
  };
}

/** Most conversations one CSV export holds; most messages and attachment bytes one mbox export holds. */
const EXPORT_MAX_THREADS = 10_000;
const MBOX_MAX_THREADS = 200;
const MBOX_MAX_MESSAGES = 2_000;
const MBOX_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const bodySchema = z.object({ html: z.string().max(5_000_000).optional(), text: z.string().max(5_000_000).optional() });
const csv = (v?: string) => (v ?? "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const continuationSchema = z
  .object({
    subsequence_id: z.string(),
    step: z.number().int().min(0),
    wait: z.number().min(0).max(10_000),
    wait_unit: z.enum(["minutes", "hours", "days"]).default("days"),
  })
  .optional();

export default async function emailRoutes(app: FastifyInstance) {
  const read = { scope: ["emails", "read"] as ["emails", "read"], perm: "unibox" as const };
  const write = (action: "create" | "update" | "delete") => ({ scope: ["emails", action] as ["emails", typeof action], perm: "unibox" as const });

  app.get("/api/v2/emails", { config: read }, async (req) => {
    const q = query(req, listQuery);
    const c = ctx(req);
    const limit = q.limit ?? 10;
    const conds = await emailConditions(c.wsId, q);
    const asc_ = q.sort_order === "asc";
    if (q.starting_after) conds.push(asc_ ? gt(M.id, q.starting_after) : lt(M.id, q.starting_after));
    if (q.latest_of_thread) {
      conds.push(sql`not exists (select 1 from emails x where x.workspace_id = ${M.workspaceId} and x.thread_id = ${M.threadId} and x.deleted_at is null and x.ue_type != ${EmailType.SCHEDULED} and x.timestamp_email > ${M.timestampEmail})`);
    }
    const rows = await db
      .select()
      .from(M)
      .where(and(...conds))
      .orderBy(asc_ ? asc(M.id) : desc(M.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: await withCampaignNames(page, !!q.preview_only), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  app.get("/api/v2/emails/unread/count", { config: read }, async (req) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(M)
      .where(and(eq(M.workspaceId, ctx(req).wsId), eq(M.isUnread, 1), isNull(M.deletedAt), eq(M.ueType, EmailType.RECEIVED)));
    return { count: Number(row?.n ?? 0) };
  });

  app.post("/api/v2/emails/threads/:thread_id/mark-as-read", { config: write("update") }, async (req) => {
    const { thread_id } = req.params as { thread_id: string };
    await db
      .update(M)
      .set({ isUnread: 0 })
      .where(and(eq(M.workspaceId, ctx(req).wsId), eq(M.threadId, thread_id)));
    return { success: true };
  });

  app.post("/api/v2/emails/test", { config: write("create") }, async (req, reply) => {
    const c = ctx(req);
    const b = body(req, z.object({ eaccount: z.string(), to_address_email_list: z.string(), subject: z.string().max(998), body: z.object({ html: z.string() }) }));
    const [account] = await db
      .select()
      .from(schema.emailAccounts)
      .where(and(eq(schema.emailAccounts.workspaceId, c.wsId), eq(schema.emailAccounts.email, b.eaccount.toLowerCase())))
      .limit(1);
    if (!account) return reply.code(400).send({ status: "error", error: "ACC_NOT_FOUND", message: "Email account not found in this workspace" });
    const to = csv(b.to_address_email_list);
    if (!to.length) throw badRequest("Email has no recipient!");
    try {
      await driverFor(account).send({
        from: { name: `${account.firstName} ${account.lastName}`.trim(), address: account.email },
        to: to.map((address) => ({ address })),
        subject: b.subject,
        html: b.body.html,
        messageId: newMessageId(account.email),
      });
      return { status: "success" };
    } catch (err) {
      const e = err instanceof MailError ? err : classifyError(err);
      return reply.code(400).send({ status: "error", error: e.kind === "auth" ? "ACC_AUTH_ERROR" : "ACC_UNKNOWN_ERROR", message: e.message });
    }
  });

  const replySchema = z.object({
    eaccount: z.string(),
    reply_to_uuid: z.string(),
    subject: z.string().max(998),
    body: bodySchema,
    additional_recipients: z.array(z.string().email()).optional(),
    cc_address_email_list: z.string().optional(),
    bcc_address_email_list: z.string().optional(),
    reminder_ts: zWhen.optional(),
    assigned_to: z.string().optional(),
    // App extensions.
    to: z.array(z.string().email()).optional(),
    attachment_ids: z.array(z.string()).optional(),
    include_quote: z.boolean().optional(),
    scheduled_at: zWhen.optional(),
    continuation: continuationSchema,
  });

  app.post("/api/v2/emails/reply", { config: write("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, replySchema);
    await assertMembers(c.wsId, [b.assigned_to], "assigned_to");
    const original = await findEmail(c.wsId, b.reply_to_uuid);
    const account = await findAccount(c.wsId, b.eaccount);
    const scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw badRequest("Invalid scheduled_at");
    if (b.continuation && scheduledAt) throw badRequest("Subsequence continuation is available for immediate replies only. Turn it off to use Send later.");
    // The continuation is checked before anything goes out: refused, nothing was sent.
    const plan = b.continuation
      ? await checkContinuation(c.wsId, original.leadId ?? (await threadLeadId(c.wsId, original.threadId)), {
          subsequenceId: b.continuation.subsequence_id,
          step: b.continuation.step,
          waitMs: delayToMs(b.continuation.wait, b.continuation.wait_unit),
        })
      : null;
    const row = await composeAndSend({
      workspaceId: c.wsId,
      account,
      original,
      kind: "reply",
      subject: b.subject,
      html: b.body.html,
      text: b.body.text,
      to: b.to,
      additionalRecipients: b.additional_recipients,
      cc: csv(b.cc_address_email_list),
      bcc: csv(b.bcc_address_email_list),
      attachments: await attachmentRows(c.wsId, b.attachment_ids ?? []),
      includeQuote: b.include_quote,
      reminderAt: b.reminder_ts ? new Date(b.reminder_ts) : null,
      scheduledAt,
    });
    if (b.assigned_to && original.leadId) await db.update(schema.leads).set({ assignedTo: b.assigned_to }).where(eq(schema.leads.id, original.leadId));
    let continuation = null;
    let continuationError: string | null = null;
    if (plan) {
      try {
        continuation = await scheduleContinuation(plan, account.id);
      } catch (err) {
        // The reply went out, so it's answered as sent, with what didn't follow.
        req.log.warn({ err }, "continuation not scheduled after a reply");
        continuationError = err instanceof HttpError && err.statusCode < 500 ? err.message : "The subsequence couldn't be continued: something went wrong on the server.";
      }
    }
    return { ...serializeEmail(row), ...(continuation ? { continuation } : {}), ...(continuationError ? { continuation_error: continuationError } : {}) };
  });

  /** A new email, not a reply: starts its own conversation (the Unibox's "New email"). */
  app.post("/api/v2/emails/send", { config: write("create") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        eaccount: z.string(),
        to: z.array(z.string().trim().email()).min(1, "Add at least one recipient").max(50),
        cc: z.array(z.string().trim().email()).max(50).optional(),
        bcc: z.array(z.string().trim().email()).max(50).optional(),
        subject: z.string().trim().min(1, "Add a subject").max(998),
        body: bodySchema,
        attachment_ids: z.array(z.string()).optional(),
        reminder_ts: zWhen.optional(),
        scheduled_at: zWhen.optional(),
      }),
    );
    const account = await findAccount(c.wsId, b.eaccount);
    const scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw badRequest("Invalid scheduled_at");
    const reminderAt = b.reminder_ts ? new Date(b.reminder_ts) : null;
    if (reminderAt && Number.isNaN(reminderAt.getTime())) throw badRequest("Invalid reminder_ts");
    const row = await sendNewEmail({
      workspaceId: c.wsId,
      account,
      to: b.to,
      cc: b.cc,
      bcc: b.bcc,
      subject: b.subject,
      html: b.body.html,
      text: b.body.text,
      attachments: await attachmentRows(c.wsId, b.attachment_ids ?? []),
      reminderAt,
      scheduledAt,
    });
    return serializeEmail(row);
  });

  app.post("/api/v2/emails/forward", { config: write("create") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        eaccount: z.string(),
        reply_to_uuid: z.string(),
        to_address_email_list: z.string(),
        subject: z.string().max(998),
        body: bodySchema.optional(),
        cc_address_email_list: z.string().optional(),
        bcc_address_email_list: z.string().optional(),
        reply_to: z.string().optional(),
        forwarded_attachments: z.string().optional(),
        include_original_body: z.boolean().optional(),
        attachment_ids: z.array(z.string()).optional(),
        scheduled_at: zWhen.optional(),
      }),
    );
    const original = await findEmail(c.wsId, b.reply_to_uuid);
    const account = await findAccount(c.wsId, b.eaccount);
    const to = csv(b.to_address_email_list);
    if (!to.length) throw badRequest("Email has no recipient!");
    const scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw badRequest("Invalid scheduled_at");
    const row = await composeAndSend({
      workspaceId: c.wsId,
      account,
      original,
      kind: "forward",
      subject: b.subject,
      html: b.body?.html,
      text: b.body?.text,
      to,
      cc: csv(b.cc_address_email_list),
      bcc: csv(b.bcc_address_email_list),
      replyTo: b.reply_to ?? null,
      attachments: await attachmentRows(c.wsId, b.attachment_ids ?? []),
      includeQuote: b.include_original_body ?? false,
      scheduledAt,
    });
    return serializeEmail(row);
  });

  app.get("/api/v2/emails/:id", { config: read }, async (req) => {
    const row = await findEmail(ctx(req).wsId, (req.params as { id: string }).id);
    return serializeEmail(row, { campaignName: row.campaignId ? await campaignName(row.campaignId) : null });
  });

  app.patch("/api/v2/emails/:id", { config: write("update") }, async (req) => {
    const c = ctx(req);
    const row = await findEmail(c.wsId, (req.params as { id: string }).id);
    const b = body(
      req,
      z.object({
        is_unread: z.number().int().min(0).max(1).nullable().optional(),
        reminder_ts: zWhen.nullable().optional(),
        is_focused: z.number().int().min(0).max(1).optional(),
        marked_as_done: z.boolean().optional(),
      }),
    );
    const patch: Partial<typeof M.$inferInsert> = {};
    if (b.is_unread !== undefined) patch.isUnread = b.is_unread ?? 0;
    if (b.reminder_ts !== undefined) patch.reminderAt = b.reminder_ts ? new Date(b.reminder_ts) : null;
    if (b.is_focused !== undefined) patch.isFocused = b.is_focused;
    if (b.marked_as_done !== undefined) patch.archived = b.marked_as_done;
    if (!Object.keys(patch).length) return serializeEmail(row);
    const [updated] = await db.update(M).set(patch).where(eq(M.id, row.id)).returning();
    return serializeEmail(updated!);
  });

  app.delete("/api/v2/emails/:id", { config: write("delete") }, async (req) => {
    const c = ctx(req);
    const row = await findEmail(c.wsId, (req.params as { id: string }).id);
    await db.update(M).set({ deletedAt: new Date() }).where(eq(M.id, row.id));
    return serializeEmail(row);
  });

  // ---------- Unibox app endpoints ----------

  /**
   * Thread list for the Unibox: one row per thread with its latest message, counts and lead. Folder "all" covers every
   * folder and tab (the web app uses it for searches); "done" lists threads marked done that got no reply since.
   */
  app.get("/api/app/unibox/threads", { config: { perm: "unibox" } }, async (req) => {
    const q = query(req, uniboxQuery);
    const c = ctx(req);
    const limit = q.limit ?? 25;
    const folder = q.folder ?? "inbox";
    const filters = await uniboxFilters(c.wsId, c.workspace.settings, q, folder);
    const groups = await threadGroups(c.wsId, folder, filters, limit + 1, ((q.page ?? 1) - 1) * limit);
    const page = groups.slice(0, limit);
    const ids = page.map((g) => g.threadId!).filter(Boolean);
    const rows = ids.length
      ? await db
          .select()
          .from(M)
          .where(and(eq(M.workspaceId, c.wsId), isNull(M.deletedAt), inArray(M.threadId, ids), folder === "scheduled" ? undefined : ne(M.ueType, EmailType.SCHEDULED)))
          .orderBy(desc(M.timestampEmail))
      : [];
    const latest = new Map<string, EmailRow>();
    // The conversation's lead: its newest email's, or else the newest one's that has a lead (a colleague answering a
    // forward isn't the lead, but the conversation still is theirs).
    const threadLead = new Map<string, string>();
    for (const r of rows.sort((a, b) => chronological(b, a))) {
      if (r.threadId && !latest.has(r.threadId)) latest.set(r.threadId, r);
      if (r.threadId && r.leadId && !threadLead.has(r.threadId)) threadLead.set(r.threadId, r.leadId);
    }
    const leadIds = [...new Set(threadLead.values())];
    const leads = leadIds.length ? await db.select().from(schema.leads).where(inArray(schema.leads.id, leadIds)) : [];
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    const items = await Promise.all(
      page.map(async (g) => {
        const e = latest.get(g.threadId!);
        if (!e) return null;
        const leadId = e.leadId ?? threadLead.get(g.threadId!);
        const lead = leadId ? leadMap.get(leadId) : undefined;
        return {
          thread_id: g.threadId,
          last_activity_at: iso(Number(g.lastAt)),
          message_count: Number(g.count),
          unread: Number(g.unread) > 0,
          reminder_ts: g.reminder ? iso(Number(g.reminder)) : null,
          scheduled_at: g.scheduled ? iso(Number(g.scheduled)) : null,
          latest: forDisplay(serializeEmail(e, { previewOnly: true, campaignName: e.campaignId ? await campaignName(e.campaignId) : null })),
          lead: lead
            ? { id: lead.id, email: lead.email, first_name: lead.firstName, last_name: lead.lastName, company_name: lead.companyName, lt_interest_status: lead.interestStatus, status: lead.status }
            : null,
        };
      }),
    );
    return { items: items.filter(Boolean), page: q.page ?? 1, has_more: groups.length > limit };
  });

  /**
   * How many threads match a search in each folder and tab, so the user can jump to them. Filters other than the
   * folder (label, campaign, mailbox, unread) still apply. A thread can count in several folders; "all" counts it once.
   */
  app.get("/api/app/unibox/search-counts", { config: { perm: "unibox" } }, async (req) => {
    const q = query(req, uniboxQuery);
    const c = ctx(req);
    const base = await emailConditions(c.wsId, { ...q, mode: undefined }, { anyType: true });
    const prefs = inboxPreferences(c.workspace.settings, q.search);
    const threads = (cond?: SQL) => sql<number>`count(distinct case when ${cond ?? sql`1`} then ${M.threadId} end)`;
    const inbox = (mode: ListQuery["mode"]) => and(folderCondition("inbox", mode), ...prefs);
    const [row] = await db
      .select({
        all: threads(),
        primary: threads(inbox("emode_focused")),
        others: threads(inbox("emode_others")),
        sent: threads(folderCondition("sent")),
        scheduled: threads(folderCondition("scheduled")),
        reminders: threads(folderCondition("reminders")),
        done: threads(folderCondition("done")),
      })
      .from(M)
      .where(and(...base));
    return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v ?? 0)])) as Record<"all" | "primary" | "others" | "sent" | "scheduled" | "reminders" | "done", number>;
  });

  /**
   * People the workspace has conversations with, matched by address, lead name, company or the sender's display name
   * (the command palette's "find a person"). Most recent conversation first.
   */
  app.get("/api/app/unibox/people", { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ q: z.string().trim().min(1).max(200), limit: zInt(1, 20).optional() }));
    const L = schema.leads;
    const named = db
      .select({ email: L.email })
      .from(L)
      .where(and(eq(L.workspaceId, c.wsId), or(contains(L.firstName, q.q), contains(L.lastName, q.q), contains(sql`(coalesce(${L.firstName}, '') || ' ' || coalesce(${L.lastName}, ''))`, q.q), contains(L.companyName, q.q))));
    const lastAt = sql<number>`max(${M.timestampEmail})`;
    const rows = await db
      .select({ email: M.leadEmail, threads: sql<number>`count(distinct ${M.threadId})`, lastAt })
      .from(M)
      .where(
        and(
          eq(M.workspaceId, c.wsId),
          isNull(M.deletedAt),
          isNotNull(M.leadEmail),
          ne(M.ueType, EmailType.SCHEDULED),
          or(contains(M.leadEmail, q.q), and(eq(M.ueType, EmailType.RECEIVED), contains(M.fromJson, q.q)), inArray(M.leadEmail, named)),
        ),
      )
      .groupBy(M.leadEmail)
      .orderBy(desc(lastAt))
      .limit(q.limit ?? 6);
    const emails = rows.map((r) => r.email!);
    const leads = emails.length
      ? await db
          .select({ id: L.id, email: L.email, firstName: L.firstName, lastName: L.lastName, companyName: L.companyName })
          .from(L)
          .where(and(eq(L.workspaceId, c.wsId), inArray(L.email, emails)))
          .orderBy(desc(L.lastContactAt), desc(L.createdAt))
      : [];
    const leadBy = new Map<string, (typeof leads)[number]>();
    for (const l of leads) if (l.email && !leadBy.has(l.email)) leadBy.set(l.email, l);
    // Senders who aren't leads: the display name from their latest email.
    const others = emails.filter((e) => !leadBy.get(e)?.firstName && !leadBy.get(e)?.lastName);
    const senders = others.length
      ? await db
          .select({ address: M.fromAddress, from: M.fromJson })
          .from(M)
          .where(and(eq(M.workspaceId, c.wsId), eq(M.ueType, EmailType.RECEIVED), isNull(M.deletedAt), inArray(M.fromAddress, others)))
          .orderBy(desc(M.timestampEmail))
          .limit(200)
      : [];
    const senderName = new Map<string, string>();
    for (const s of senders) {
      const name = s.from?.find((a) => a.address === s.address)?.name?.trim();
      if (s.address && name && !senderName.has(s.address)) senderName.set(s.address, name);
    }
    return {
      items: rows.map((r) => {
        const lead = leadBy.get(r.email!);
        const name = [lead?.firstName, lead?.lastName].filter(Boolean).join(" ") || senderName.get(r.email!) || null;
        return { email: r.email, name, company_name: lead?.companyName ?? null, lead_id: lead?.id ?? null, threads: Number(r.threads), last_activity_at: iso(Number(r.lastAt)) };
      }),
    };
  });

  /** The current list (folder, filters and search) as a CSV: one row per conversation, newest first. */
  app.get("/api/app/unibox/export/csv", { config: { perm: "unibox" } }, async (req, reply) => {
    const q = query(req, uniboxQuery);
    const c = ctx(req);
    const folder = q.folder ?? "inbox";
    const groups = await threadGroups(c.wsId, folder, await uniboxFilters(c.wsId, c.workspace.settings, q, folder), EXPORT_MAX_THREADS + 1);
    const page = groups.slice(0, EXPORT_MAX_THREADS);
    // Only the columns the CSV needs: a big export must not load every body.
    const threadRows = (ids: string[]) =>
      db
        .select({
          threadId: M.threadId,
          timestampEmail: M.timestampEmail,
          ueType: M.ueType,
          subject: M.subject,
          fromAddress: M.fromAddress,
          fromJson: M.fromJson,
          toList: M.toList,
          contentPreview: M.contentPreview,
          campaignId: M.campaignId,
          leadId: M.leadId,
          leadEmail: M.leadEmail,
          interestStatus: M.interestStatus,
        })
        .from(M)
        .where(and(eq(M.workspaceId, c.wsId), isNull(M.deletedAt), inArray(M.threadId, ids), folder === "scheduled" ? undefined : ne(M.ueType, EmailType.SCHEDULED)));
    const latest = new Map<string, Awaited<ReturnType<typeof threadRows>>[number]>();
    for (const ids of chunk(page.map((g) => g.threadId!).filter(Boolean), 500)) {
      for (const r of await threadRows(ids)) {
        const cur = latest.get(r.threadId!);
        if (!cur || chronological(r, cur) > 0) latest.set(r.threadId!, r);
      }
    }
    const leadIds = [...new Set([...latest.values()].map((r) => r.leadId).filter((x): x is string => !!x))];
    const leadStatus = new Map<string, number | null>();
    for (const ids of chunk(leadIds, 500)) {
      for (const l of await db.select({ id: schema.leads.id, status: schema.leads.interestStatus }).from(schema.leads).where(and(eq(schema.leads.workspaceId, c.wsId), inArray(schema.leads.id, ids)))) {
        leadStatus.set(l.id, l.status);
      }
    }
    const labels = await labelNames(c.wsId);
    const data: string[][] = [];
    for (const g of page) {
      const e = latest.get(g.threadId!);
      if (!e) continue;
      const code = (e.leadId ? leadStatus.get(e.leadId) : undefined) ?? e.interestStatus;
      data.push([
        addressLabel(e.fromJson?.[0] ?? (e.fromAddress ? { address: e.fromAddress } : undefined)),
        (e.toList ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean).join(", "),
        e.subject ?? "",
        iso(e.timestampEmail) ?? "",
        code === null || code === undefined ? "" : (labels.get(code) ?? `Label ${code}`),
        (e.campaignId ? await campaignName(e.campaignId) : null) ?? "",
        untrackText(e.contentPreview ?? ""),
        e.leadEmail ?? "",
        String(Number(g.count)),
      ]);
    }
    // Spreadsheet apps treat cells starting with = + - @ as formulas, and anyone can send an email with such a subject.
    const csv = toCsv({ fields: ["from", "to", "subject", "date", "label", "campaign", "last_message", "lead", "messages"], data });
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", attachmentDisposition(`unibox-${await workspaceToday(c.wsId)}.csv`))
      .header("x-content-type-options", "nosniff")
      .header("x-export-rows", String(data.length));
    if (groups.length > EXPORT_MAX_THREADS) reply.header("x-export-truncated", String(EXPORT_MAX_THREADS));
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.UNIBOX_EXPORTED, req, affectedCount: data.length, metadata: { format: "csv", folder, search: q.search ?? null } });
    // The byte order mark lets Excel read the file as UTF-8 (names with accents).
    return `﻿${csv}`;
  });

  /** Conversations as one .mbox file (all their sent and received emails, oldest first per conversation). */
  app.get("/api/app/unibox/export/mbox", { config: { perm: "unibox" } }, async (req, reply) => {
    const c = ctx(req);
    const q = query(req, z.object({ thread_ids: zList }));
    const ids = [...new Set(q.thread_ids ?? [])];
    if (!ids.length) throw badRequest("Choose at least one conversation to export");
    if (ids.length > MBOX_MAX_THREADS) throw badRequest(`Export up to ${MBOX_MAX_THREADS} conversations at a time`);
    const order = new Map(ids.map((id, i) => [id, i]));
    const rows: EmailRow[] = [];
    for (const part of chunk(ids, 500)) {
      rows.push(...(await db.select().from(M).where(and(eq(M.workspaceId, c.wsId), isNull(M.deletedAt), inArray(M.threadId, part), ne(M.ueType, EmailType.SCHEDULED)))));
    }
    if (!rows.length) throw notFound("Conversation");
    if (rows.length > MBOX_MAX_MESSAGES) throw badRequest(`These conversations hold ${rows.length} emails. Export up to ${MBOX_MAX_MESSAGES} at a time.`);
    const attachmentBytes = rows.reduce((n, r) => n + (r.attachments?.files ?? []).reduce((m, f) => m + (f.size || 0), 0), 0);
    if (attachmentBytes > MBOX_MAX_ATTACHMENT_BYTES) throw badRequest("These conversations have more than 100 MB of attachments. Export fewer at a time.");
    rows.sort((a, b) => order.get(a.threadId!)! - order.get(b.threadId!)! || chronological(a, b));
    const name = new Set(rows.map((r) => r.threadId)).size === 1 ? `${fileStem(rows[0]!.subject)}.mbox` : `unibox-${await workspaceToday(c.wsId)}.mbox`;
    reply.header("content-type", "application/mbox").header("content-disposition", attachmentDisposition(name)).header("x-content-type-options", "nosniff");
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.UNIBOX_EXPORTED, req, affectedCount: new Set(rows.map((r) => r.threadId)).size, metadata: { format: "mbox", emails: rows.length } });
    return reply.send(await mbox(rows));
  });

  /** One email as an .eml file. */
  app.get("/api/app/unibox/emails/:id/eml", { config: { perm: "unibox" } }, async (req, reply) => {
    const c = ctx(req);
    const row = await findEmail(c.wsId, (req.params as { id: string }).id);
    if (row.ueType === EmailType.SCHEDULED) throw badRequest("This email hasn't been sent yet");
    reply.header("content-type", "message/rfc822").header("content-disposition", attachmentDisposition(`${fileStem(row.subject)}.eml`)).header("x-content-type-options", "nosniff");
    return reply.send(await rawMessage(row));
  });

  /** Whole conversation plus the lead, campaign and subsequence context for the right-hand panel. */
  app.get("/api/app/unibox/threads/:threadId", { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const { threadId } = req.params as { threadId: string };
    const q = query(req, z.object({ mark_read: zBool }));
    const emails = (
      await db
        .select()
        .from(M)
        .where(and(eq(M.workspaceId, c.wsId), eq(M.threadId, threadId), isNull(M.deletedAt)))
        .orderBy(asc(M.timestampEmail))
    ).sort(chronological);
    if (!emails.length) throw notFound("Thread");
    if (q.mark_read) await db.update(M).set({ isUnread: 0 }).where(and(eq(M.workspaceId, c.wsId), eq(M.threadId, threadId), eq(M.isUnread, 1)));
    const leadId = emails.find((e) => e.leadId)?.leadId;
    const [lead] = leadId ? await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)) : [];
    const campaignId = lead?.campaignId ?? emails.find((e) => e.campaignId)?.campaignId ?? null;
    const subs = campaignId
      ? await db.select({ id: schema.subsequences.id, name: schema.subsequences.name, status: schema.subsequences.status, sequences: schema.subsequences.sequences }).from(schema.subsequences).where(eq(schema.subsequences.parentCampaignId, campaignId))
      : [];
    const lastOwn = [...emails].reverse().find((e) => e.ueType !== EmailType.RECEIVED && e.ueType !== EmailType.SCHEDULED);
    const lastReceived = [...emails].reverse().find((e) => e.ueType === EmailType.RECEIVED);
    // A reply answers what someone wrote: not a bounce notice (that goes back to the mail server), nor an email that
    // hasn't gone out yet.
    const lastWritten = [...emails].reverse().find((e) => e.ueType === EmailType.RECEIVED && !e.isBounce);
    const lastSent = [...emails].reverse().find((e) => e.ueType !== EmailType.SCHEDULED && !e.isBounce);
    return {
      thread_id: threadId,
      emails: emails.map((e) => forDisplay(serializeEmail(e))),
      lead: lead ? serializeLead(lead) : null,
      campaign: campaignId ? { id: campaignId, name: await campaignName(campaignId) } : null,
      subsequences: subs.map((s) => ({ id: s.id, name: s.name, status: s.status, steps: s.sequences?.[0]?.steps?.length ?? 0 })),
      continuation:
        lead?.subsequenceId && lead.subseqStatus === LeadStatus.ACTIVE
          ? { subsequence_id: lead.subsequenceId, name: subs.find((s) => s.id === lead.subsequenceId)?.name ?? null, step: lead.subseqNextStep + 1, scheduled_for: iso(lead.subseqNextSendAt) }
          : null,
      suggested_account: lastOwn?.eaccount ?? lastReceived?.eaccount ?? null,
      reply_target_id: (lastWritten ?? lastSent ?? emails[emails.length - 1]!).id,
    };
  });

  /**
   * Drafts a reply to the thread's newest message with the reply engine the Inbox Manager uses. The workspace's
   * Inbox Manager guidance and booking link are applied when one exists. Nothing is sent or saved.
   */
  app.post("/api/app/unibox/threads/:threadId/ai-reply", { config: { perm: "unibox", write: true } }, async (req) => {
    const c = ctx(req);
    const { threadId } = req.params as { threadId: string };
    const b = body(req, z.object({ instruction: z.string().trim().max(2000).optional(), eaccount: z.string().optional() }));
    const [last] = await db
      .select()
      .from(M)
      .where(and(eq(M.workspaceId, c.wsId), eq(M.threadId, threadId), isNull(M.deletedAt), ne(M.ueType, EmailType.SCHEDULED)))
      .orderBy(desc(M.timestampEmail))
      .limit(1);
    if (!last) throw notFound("Thread");
    if (!(await aiAvailable(c.wsId))) throw badRequest("AI is not configured. Add an Anthropic API key in Settings → Integrations & API → AI.");
    const leadId = last.leadId ?? (await db.select({ id: M.leadId }).from(M).where(and(eq(M.threadId, threadId), isNotNull(M.leadId))).limit(1))[0]?.id;
    const [lead] = leadId ? await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)) : [];
    const A = schema.aiAgents;
    const [agent] = await db
      .select()
      .from(A)
      .where(and(eq(A.workspaceId, c.wsId), eq(A.type, AgentType.INBOX_MANAGER)))
      .orderBy(desc(A.status), asc(A.createdAt))
      .limit(1);
    const settings = agent ? payloadOf(agent) : null;
    const fromEmail = (b.eaccount || last.eaccount || "").toLowerCase();
    const [account] = fromEmail
      ? await db
          .select()
          .from(schema.emailAccounts)
          .where(and(eq(schema.emailAccounts.workspaceId, c.wsId), eq(schema.emailAccounts.email, fromEmail)))
          .limit(1)
      : [];
    const user = c.auth.user;
    const senderName = account ? `${account.firstName} ${account.lastName}`.trim() : user ? `${user.firstName} ${user.lastName}`.trim() : "";
    try {
      const draft = await draftReply({
        workspaceId: c.wsId,
        feature: "unibox_reply",
        agentName: agent?.name ?? "Unibox",
        guidance: await guidanceText(agent?.id ?? ""), // no agent: the default tone and length
        context: await businessContext(c.wsId),
        bookingLink: await calendlyLink(c.wsId, settings?.integrations?.calendly?.connection_id),
        extraInstructions: [
          settings?.handle_objections ? "If the prospect declines, you may address the objection once, briefly and respectfully." : "",
          b.instruction ? `The salesperson asked for this reply: ${b.instruction}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        thread: await threadMessages(threadId, last.id),
        lead: lead
          ? { first_name: lead.firstName, last_name: lead.lastName, company_name: lead.companyName, job_title: lead.jobTitle, email: lead.email, interest_status: lead.interestStatus }
          : { email: last.leadEmail, interest_status: last.interestStatus },
        sender: { name: senderName || fromEmail || "Sales", email: account?.email ?? fromEmail },
      });
      return {
        decision: draft.decision,
        html: draft.html,
        confidence: draft.confidence,
        needs_human: draft.needsHuman,
        human_reason: draft.humanReason,
        information_requested: draft.informationRequested,
        used_booking_link: draft.usedBookingLink,
        guidance_from: agent ? { id: agent.id, name: agent.name } : null,
      };
    } catch (err) {
      throw toHttpError(err);
    }
  });

  /**
   * Sidebar counters, counted the way the lists show them: unread conversations per tab and in the whole inbox (once
   * each), reminders, scheduled, labels, campaigns and inboxes. Done threads don't count, nor what the workspace hides.
   */
  app.get("/api/app/unibox/summary", { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const base = and(eq(M.workspaceId, c.wsId), isNull(M.deletedAt));
    const hidden = inboxPreferences(c.workspace.settings, undefined);
    const threadsWhere = async (extra: SQL) => {
      const [r] = await db.select({ n: sql<number>`count(distinct ${M.threadId})` }).from(M).where(and(base, extra));
      return Number(r?.n ?? 0);
    };
    const unreadIn = (mode: ListQuery["mode"]) => and(folderCondition("inbox", mode), eq(M.isUnread, 1), ...hidden)!;
    const [primaryUnread, othersUnread, inboxUnread, reminders, scheduled] = await Promise.all([
      threadsWhere(unreadIn("emode_focused")),
      threadsWhere(unreadIn("emode_others")),
      threadsWhere(unreadIn("emode_all")),
      threadsWhere(folderCondition("reminders")!),
      threadsWhere(folderCondition("scheduled")!),
    ]);
    const labels = await db
      .select({ status: M.interestStatus, n: sql<number>`count(distinct ${M.threadId})` })
      .from(M)
      .where(and(base, folderCondition("inbox", "emode_all"), isNotNull(M.interestStatus), ...hidden))
      .groupBy(M.interestStatus);
    const campaigns = await db
      .select({ id: schema.campaigns.id, name: schema.campaigns.name })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.workspaceId, c.wsId))
      .orderBy(desc(schema.campaigns.createdAt));
    const inboxes = await db
      .select({ email: schema.emailAccounts.email, status: schema.emailAccounts.status })
      .from(schema.emailAccounts)
      .where(eq(schema.emailAccounts.workspaceId, c.wsId))
      .orderBy(asc(schema.emailAccounts.email));
    return {
      unread: { primary: primaryUnread, others: othersUnread, inbox: inboxUnread },
      reminders,
      scheduled,
      labels: labels.map((l) => ({ i_status: l.status, threads: Number(l.n) })),
      campaigns,
      inboxes,
    };
  });

  app.post("/api/app/unibox/bulk", { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        thread_ids: z.array(z.string()).min(1).max(1000),
        action: z.enum(["mark_read", "mark_unread", "delete", "move_primary", "move_others", "mark_done", "mark_not_done", "clear_reminder"]),
      }),
    );
    const where = and(eq(M.workspaceId, c.wsId), inArray(M.threadId, b.thread_ids))!;
    const set: Partial<typeof M.$inferInsert> = {
      mark_read: { isUnread: 0 },
      mark_unread: { isUnread: 1 },
      delete: { deletedAt: new Date() },
      move_primary: { isFocused: 1 },
      move_others: { isFocused: 0 },
      mark_done: { archived: true },
      mark_not_done: { archived: false },
      clear_reminder: { reminderAt: null },
    }[b.action];
    // Unread only applies to received mail; the rest apply to the whole thread.
    const scoped = b.action === "mark_unread" ? and(where, eq(M.ueType, EmailType.RECEIVED))! : where;
    const res = await db.update(M).set(set).where(scoped).returning({ id: M.id });
    return { updated: res.length };
  });

  /** Cancels a scheduled email (it is removed; nothing is sent). */
  app.post("/api/app/emails/:id/cancel-scheduled", { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const row = await findEmail(c.wsId, (req.params as { id: string }).id);
    if (row.ueType !== EmailType.SCHEDULED) throw badRequest("This email is not scheduled");
    await db.update(M).set({ deletedAt: new Date(), scheduledAt: null }).where(eq(M.id, row.id));
    return { ok: true };
  });

  app.post("/api/app/emails/:id/reschedule", { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const row = await findEmail(c.wsId, (req.params as { id: string }).id);
    if (row.ueType !== EmailType.SCHEDULED) throw badRequest("This email is not scheduled");
    const b = body(req, z.object({ scheduled_at: z.string().optional(), now: z.boolean().optional() }));
    // "Send now" (an email that wasn't sent, or one not due yet) is picked up by the scheduled-email loop within seconds.
    const at = b.now ? new Date() : new Date(b.scheduled_at ?? "");
    if (Number.isNaN(at.getTime()) || (!b.now && at.getTime() < Date.now())) throw badRequest("Choose a future date");
    // A reminder set to follow the send moves with it.
    const planned = row.scheduledAt ?? row.timestampEmail;
    const moved = row.reminderAt && row.reminderAt > planned ? new Date(row.reminderAt.getTime() + (at.getTime() - planned.getTime())) : row.reminderAt;
    const [updated] = await db
      .update(M)
      .set({ scheduledAt: at, timestampEmail: at, sendError: null, reminderAt: reminderAfterSend(moved, at, new Date()) })
      .where(and(eq(M.id, row.id), eq(M.ueType, EmailType.SCHEDULED)))
      .returning();
    if (!updated) throw badRequest("This email was sent in the meantime.");
    return serializeEmail(updated);
  });

  /** Cancels a pending subsequence continuation for a lead. */
  app.post("/api/app/leads/:id/cancel-continuation", { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const res = await db
      .update(schema.leads)
      .set({ subseqStatus: LeadStatus.COMPLETED, subseqNextSendAt: null })
      .where(and(eq(schema.leads.id, id), eq(schema.leads.workspaceId, c.wsId), eq(schema.leads.subseqStatus, LeadStatus.ACTIVE)))
      .returning({ id: schema.leads.id });
    return { cancelled: res.length > 0 };
  });

  app.post("/api/app/uploads", { config: { perm: "unibox" } }, async (req) => {
    const c = ctx(req);
    const out: Array<{ id: string; filename: string; size: number; content_type: string }> = [];
    try {
      // A file over the limit stops at the limit: it's never held whole.
      for await (const part of req.files({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 } })) {
        const buffer = await part.toBuffer();
        const row = await saveUpload(c.wsId, { filename: part.filename, mimetype: part.mimetype, buffer });
        out.push({ id: row.id, filename: row.filename, size: row.size, content_type: row.contentType });
      }
    } catch (err) {
      // Nothing of a refused upload is kept.
      await removeUploads(out.map((o) => o.id));
      const e = err as { code?: string; part?: { filename?: string } };
      if (e.code === "FST_REQ_FILE_TOO_LARGE") throw new HttpError(413, tooLarge(e.part?.filename || "The file"), "too_large");
      if (e.code === "FST_FILES_LIMIT") throw new HttpError(413, "Attach up to 10 files at a time.", "too_many_files");
      throw err;
    }
    if (!out.length) throw badRequest("No files received");
    return { files: out };
  });

  app.get("/api/app/attachments/:id", { config: { perm: "unibox" } }, async (req, reply) => {
    const c = ctx(req);
    const [row] = await db
      .select()
      .from(schema.emailAttachments)
      .where(and(eq(schema.emailAttachments.id, (req.params as { id: string }).id), eq(schema.emailAttachments.workspaceId, c.wsId)))
      .limit(1);
    const file = row ? resolveStoredPath(row.storagePath) : null;
    if (!row || !file || !existsSync(file)) throw notFound("Attachment");
    const inline = /^image\/(png|jpe?g|gif|webp)$/i.test(row.contentType) && (req.query as { inline?: string }).inline === "1";
    reply.header("content-type", row.contentType);
    reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    reply.header("x-content-type-options", "nosniff");
    return reply.send(createReadStream(file));
  });
}

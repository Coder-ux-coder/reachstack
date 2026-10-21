// Unibox: email serialization, search operators, manual replies/forwards, uploads, scheduled sends and exports.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import { AccountStatus, CampaignStatus, EmailType, LeadStatus, escapeHtml, htmlToText, snippet, textToHtml } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { AttachmentMeta } from "../db/schema/emails";
import { config } from "../env";
import { badRequest } from "../http/errors";
import { resolveStoredPath, toStoredPath } from "../lib/data-files";
import { uuidv7 } from "../lib/ids";
import { iso } from "../lib/time";
import { bracketId, buildRaw, forwardSubject, newMessageId, quoteHtml, replySubject } from "../mail/compose";
import { driverFor, type AccountRow } from "../mail/driver";
import type { Address, OutgoingAttachment } from "../mail/types";
import { MailError } from "../mail/types";
import { classifyError } from "../mail/smtp-imap";
import { noteSendFailure, noteSendSuccess } from "./accounts";
import { blockedSet } from "./leads";
import { untrackHtml, untrackText } from "./tracking";
import { inUse } from "./live-workspaces";
import { workspaceZone } from "./workspace-clock";
import type { EmailRow, LeadRow } from "./activity";
import { reopenForSubsequences, type SubsequenceRow } from "./campaigns";

const M = schema.emails;
const A = schema.emailAttachments;

/** Date headers only carry whole seconds: within one second, what we sent comes before what came back. */
export function chronological(a: Pick<EmailRow, "timestampEmail" | "ueType">, b: Pick<EmailRow, "timestampEmail" | "ueType">): number {
  const sec = Math.floor(a.timestampEmail.getTime() / 1000) - Math.floor(b.timestampEmail.getTime() / 1000);
  return sec || Number(a.ueType === EmailType.RECEIVED) - Number(b.ueType === EmailType.RECEIVED);
}

export function serializeEmail(e: EmailRow, opts: { previewOnly?: boolean; campaignName?: string | null } = {}) {
  return {
    id: e.id,
    timestamp_created: iso(e.createdAt),
    timestamp_email: iso(e.timestampEmail),
    message_id: e.messageId,
    subject: e.subject,
    from_address_email: e.fromAddress,
    to_address_email_list: e.toList,
    cc_address_email_list: e.ccList,
    bcc_address_email_list: e.bccList,
    reply_to: e.replyTo,
    body: opts.previewOnly ? { text: e.contentPreview ?? "", html: "" } : { text: e.bodyText, html: e.bodyHtml },
    organization_id: e.workspaceId,
    campaign_id: e.campaignId,
    subsequence_id: e.subsequenceId,
    list_id: e.listId,
    lead: e.leadEmail,
    lead_id: e.leadId,
    eaccount: e.eaccount,
    ue_type: e.ueType,
    step: e.step,
    is_unread: e.isUnread,
    is_auto_reply: e.isAutoReply,
    reminder_ts: iso(e.reminderAt),
    ai_interest_value: e.aiInterestValue,
    ai_assisted: e.aiAssisted,
    is_focused: e.isFocused,
    i_status: e.interestStatus,
    thread_id: e.threadId,
    content_preview: e.contentPreview,
    attachment_json: e.attachments?.files?.length ? e.attachments : null,
    from_address_json: e.fromJson,
    to_address_json: e.toJson,
    cc_address_json: e.ccJson,
    ai_agent_id: e.aiAgentId,
    // Extensions used by the web app.
    scheduled_at: iso(e.scheduledAt),
    send_error: e.sendError,
    is_bounce: e.isBounce,
    marked_as_done: e.archived,
    variant: e.variant,
    ...(opts.campaignName !== undefined ? { campaign_name: opts.campaignName } : {}),
  };
}

// ---------- Search operators ----------

export interface ParsedSearch {
  terms: string[];
  ops: Array<{ key: string; value: string }>;
}

/** Splits `from:john subject:"pricing call" hello` into operators and free terms. */
export function parseSearch(input: string): ParsedSearch {
  const out: ParsedSearch = { terms: [], ops: [] };
  const re = /(\w+):(?:"([^"]*)"|(\S+))|"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m[1]) out.ops.push({ key: m[1].toLowerCase(), value: (m[2] ?? m[3] ?? "").trim() });
    else out.terms.push((m[4] ?? m[5] ?? "").trim());
  }
  out.terms = out.terms.filter(Boolean);
  return out;
}

/** A year, month or day in a search (2026, 2026-10, 2026-10-15) on the workspace clock: its start, or its end. */
function parseLooseDate(v: string, end: boolean, zone: string): Date | null {
  const [y, m, d] = v.split(/[-/]/).map(Number);
  if (/^\d{4}([-/]\d{1,2}){0,2}$/.test(v)) {
    const unit = d !== undefined ? "day" : m !== undefined ? "month" : "year";
    const local = DateTime.fromObject({ year: y, month: m ?? 1, day: d ?? 1 }, { zone });
    if (!local.isValid) return null;
    // A day counts from its start either way (after:2026-10-15 includes the 15th); a month or year ends after its last day.
    return (end && unit !== "day" ? local.endOf(unit) : local).toJSDate();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** SQL conditions for a Unibox search string (operators + free-text keywords). */
export async function searchConditions(workspaceId: string, input: string): Promise<SQL[]> {
  const conds: SQL[] = [];
  const q = input.trim();
  if (!q) return conds;
  if (q.startsWith("thread:")) return [eq(M.threadId, q.slice(7).trim())];
  if (/^[^\s@:]+@[^\s@]+$/.test(q)) return [or(eq(M.leadEmail, q.toLowerCase()), like(M.fromAddress, `%${q}%`), like(M.toList, `%${q}%`))!];
  const { terms, ops } = parseSearch(q);
  let zone: string | undefined;
  const clock = async () => (zone ??= await workspaceZone(workspaceId));
  for (const { key, value } of ops) {
    const v = value.toLowerCase();
    if (!v) continue;
    switch (key) {
      // A full address matches exactly; anything else is a substring match.
      case "from":
        conds.push(isEmail(v) ? eq(M.fromAddress, v) : like(M.fromAddress, `%${v}%`));
        break;
      case "to":
        conds.push(isEmail(v) ? sql`(',' || ${M.toList} || ',') like ${`%,${v},%`}` : like(M.toList, `%${v}%`));
        break;
      case "lead":
        conds.push(isEmail(v) ? eq(M.leadEmail, v) : like(M.leadEmail, `%${v}%`));
        break;
      case "subject":
        conds.push(like(M.subject, `%${value}%`));
        break;
      case "has":
        if (v === "attachment" || v === "attachments") conds.push(sql`json_array_length(${M.attachments}, '$.files') > 0`);
        else if (v === "reminder") conds.push(isNotNull(M.reminderAt));
        break;
      case "is":
        if (v === "unread") conds.push(eq(M.isUnread, 1));
        else if (v === "read") conds.push(eq(M.isUnread, 0));
        else if (v === "scheduled") conds.push(eq(M.ueType, EmailType.SCHEDULED));
        else if (v === "bounce" || v === "bounced") conds.push(eq(M.isBounce, true));
        else if (v === "auto" || v === "autoreply" || v === "auto-reply") conds.push(eq(M.isAutoReply, 1));
        else if (v === "done") conds.push(eq(M.archived, true));
        break;
      case "in":
        if (v === "sent") conds.push(inArray(M.ueType, [EmailType.CAMPAIGN_SENT, EmailType.SENT]));
        else if (v === "received" || v === "inbox") conds.push(eq(M.ueType, EmailType.RECEIVED));
        break;
      case "before": {
        const d = parseLooseDate(v, false, await clock());
        if (d) conds.push(lt(M.timestampEmail, d));
        break;
      }
      case "after": {
        const d = parseLooseDate(v, true, await clock());
        if (d) conds.push(gte(M.timestampEmail, d));
        break;
      }
      case "campaign": {
        const camps = await db
          .select({ id: schema.campaigns.id })
          .from(schema.campaigns)
          .where(and(eq(schema.campaigns.workspaceId, workspaceId), or(eq(schema.campaigns.id, value), like(schema.campaigns.name, `%${value}%`))));
        conds.push(inArray(M.campaignId, [...camps.map((c) => c.id), "__none__"]));
        break;
      }
      default:
        terms.push(`${key}:${value}`);
    }
  }
  for (const t of terms) {
    const p = `%${t}%`;
    conds.push(or(like(M.subject, p), like(M.fromAddress, p), like(M.toList, p), like(M.leadEmail, p), like(M.bodyText, p), sql`${M.attachments} like ${p}`)!);
  }
  return conds;
}

// ---------- Attachments ----------

/** The largest file an email can carry. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Files attached to an email that never went out (a draft closed, a send that failed) are kept this long. */
const UPLOAD_KEPT_MS = 7 * 86_400_000;

export const tooLarge = (filename: string) => `"${filename}" is too large. Attachments can be up to 25 MB.`;

export async function saveUpload(workspaceId: string, file: { filename: string; mimetype: string; buffer: Buffer }) {
  if (file.buffer.length > MAX_UPLOAD_BYTES) throw badRequest(tooLarge(file.filename));
  const id = uuidv7();
  const dir = path.join(config.dataDir, "attachments", workspaceId, "uploads");
  await mkdir(dir, { recursive: true });
  const safe = file.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
  const target = path.join(dir, `${id}-${safe}`);
  await writeFile(target, file.buffer);
  const [row] = await db
    .insert(A)
    .values({ id, workspaceId, emailId: null, filename: file.filename, contentType: file.mimetype || "application/octet-stream", size: file.buffer.length, storagePath: toStoredPath(target) })
    .returning();
  return row!;
}

export async function attachmentRows(workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await db.select().from(A).where(and(eq(A.workspaceId, workspaceId), inArray(A.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest("An attachment is no longer there (files that weren't sent are kept for 7 days). Remove it and attach it again.");
  return rows;
}

/** Uploaded files that no email carries: their rows and their files go. */
export async function removeUploads(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const gone = await db
    .delete(A)
    .where(and(inArray(A.id, ids), isNull(A.emailId)))
    .returning({ storagePath: A.storagePath });
  for (const g of gone) await rm(resolveStoredPath(g.storagePath), { force: true }).catch(() => {});
  return gone.length;
}

/** Daily: files uploaded for an email that never went out, once they're a week old. */
export async function pruneUploads(now = Date.now()): Promise<number> {
  let removed = 0;
  for (;;) {
    const old = await db
      .select({ id: A.id })
      .from(A)
      .where(and(isNull(A.emailId), lt(A.createdAt, new Date(now - UPLOAD_KEPT_MS))))
      .limit(500);
    removed += await removeUploads(old.map((o) => o.id));
    if (old.length < 500) return removed;
  }
}

const metaOf = (a: typeof A.$inferSelect): AttachmentMeta => ({ id: a.id, filename: a.filename, size: a.size, content_type: a.contentType, content_id: a.contentId });
const outgoingOf = (a: typeof A.$inferSelect): OutgoingAttachment => ({
  filename: a.filename,
  contentType: a.contentType,
  path: resolveStoredPath(a.storagePath),
  ...(a.contentId ? { cid: a.contentId } : {}),
});

// ---------- Sending ----------

const splitList = (v: string | null | undefined) =>
  (v ?? "")
    .split(/[,;\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));

export interface ComposeInput {
  workspaceId: string;
  account: AccountRow;
  original: EmailRow;
  kind: "reply" | "forward";
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  to?: string[];
  additionalRecipients?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string | null;
  attachments?: (typeof A.$inferSelect)[];
  includeQuote?: boolean;
  reminderAt?: Date | null;
  scheduledAt?: Date | null;
}

/** Who a reply goes to when it names no one: whoever wrote a received email (its Reply-To first), the recipients of a sent one. */
export function replyRecipients(original: Pick<EmailRow, "ueType" | "toList" | "replyTo" | "fromAddress">): string[] {
  return original.ueType === EmailType.RECEIVED ? splitList(original.replyTo || original.fromAddress) : splitList(original.toList);
}

/**
 * A paused mailbox doesn't send. One with a connection problem may work again, so the send is tried and a failure says
 * what went wrong.
 */
export function pausedRefusal(account: AccountRow): string | null {
  return account.status === AccountStatus.PAUSED ? `${account.email} is paused. Resume it in Email accounts to send from it.` : null;
}

/** Builds the stored row for a manual reply/forward. Sends now, or stores it as scheduled. */
export async function composeAndSend(input: ComposeInput): Promise<EmailRow> {
  const { original, account } = input;
  if (original.ueType === EmailType.SCHEDULED) throw badRequest("This email hasn't been sent yet, so it can't be replied to or forwarded. Choose an email that was sent.");
  const paused = pausedRefusal(account);
  if (paused) throw badRequest(paused);
  let to = input.to?.length ? input.to : [];
  if (!to.length && input.kind === "reply") to = replyRecipients(original);
  to = [...new Set([...to, ...(input.additionalRecipients ?? []).map((x) => x.toLowerCase())])];
  if (!to.length) throw badRequest("Email has no recipient!");
  let html = input.html ?? (input.text ? textToHtml(input.text) : "");
  if (!htmlToText(html).trim() && !input.attachments?.length && input.kind === "reply") throw badRequest("Email has no content!");
  // The list preview shows what was written now, not the quoted history appended below.
  const ownText = htmlToText(html);
  const prevFrom = original.fromJson?.[0] ? `${original.fromJson[0].name ? `${original.fromJson[0].name} ` : ""}<${original.fromJson[0].address}>` : (original.fromAddress ?? "");
  // What's quoted or forwarded goes without our tracking (a campaign email's pixel, click redirects and unsubscribe link,
  // also inside a lead's reply that quotes it): whoever reads the copy isn't the lead opening, clicking or unsubscribing.
  const previous = { html: original.bodyHtml ? untrackHtml(original.bodyHtml) : null, text: untrackText(original.bodyText ?? "") };
  if (input.kind === "forward") {
    const line = (label: string, value: string) => `${label}: ${escapeHtml(value)}<br/>`;
    const header = `<br/><div>---------- Forwarded message ---------<br/>${line("From", prevFrom)}${line("Date", original.timestampEmail.toUTCString())}${line("Subject", original.subject ?? "")}${line("To", original.toList ?? "")}</div><br/>`;
    if (input.includeQuote !== false) html = `${html}${header}${previous.html || textToHtml(previous.text)}`;
  } else if (input.includeQuote) {
    html = `${html}${quoteHtml({ ...previous, from: prevFrom, date: original.timestampEmail })}`;
  }
  const subject = (input.subject?.trim() || (input.kind === "forward" ? forwardSubject(original.subject) : replySubject(original.subject))).slice(0, 998);
  const references = input.kind === "reply" ? [...(original.references ?? "").split(/\s+/).filter(Boolean), bracketId(original.messageId)].slice(-20) : [];
  const files = [...(input.attachments ?? [])];
  if (input.kind === "forward" && original.attachments?.files?.length) {
    const orig = await db.select().from(A).where(inArray(A.id, original.attachments.files.map((f) => f.id)));
    for (const o of orig) if (!files.some((f) => f.id === o.id)) files.push(o);
  }
  const messageId = newMessageId(account.email);
  const scheduled = input.scheduledAt && input.scheduledAt.getTime() > Date.now() + 30_000 ? input.scheduledAt : null;
  const now = new Date();
  const id = uuidv7();
  const text = htmlToText(html);
  const row: typeof M.$inferInsert = {
    id,
    workspaceId: input.workspaceId,
    messageId,
    threadId: original.threadId,
    inReplyTo: input.kind === "reply" ? bracketId(original.messageId) : null,
    references: references.join(" ") || null,
    subject,
    fromAddress: account.email,
    fromJson: [{ address: account.email, name: `${account.firstName} ${account.lastName}`.trim() }],
    toList: to.join(","),
    toJson: to.map((address) => ({ address, name: "" })),
    ccList: input.cc?.length ? input.cc.join(",") : null,
    ccJson: input.cc?.length ? input.cc.map((address) => ({ address, name: "" })) : null,
    bccList: input.bcc?.length ? input.bcc.join(",") : null,
    replyTo: input.replyTo ?? account.replyTo ?? null,
    bodyText: text,
    bodyHtml: html,
    contentPreview: snippet(ownText || text, 160),
    timestampEmail: scheduled ?? now,
    campaignId: original.campaignId,
    subsequenceId: original.subsequenceId,
    listId: original.listId,
    leadEmail: original.leadEmail,
    leadId: original.leadId,
    accountId: account.id,
    eaccount: account.email,
    ueType: scheduled ? EmailType.SCHEDULED : EmailType.SENT,
    isUnread: 0,
    isFocused: original.isFocused,
    interestStatus: original.interestStatus,
    attachments: files.length ? { files: files.map(metaOf) } : null,
    reminderAt: reminderAfterSend(input.reminderAt, scheduled, now),
    scheduledAt: scheduled,
  };
  if (!scheduled) await deliver(row, account, files);
  const [stored] = await db.insert(M).values(row).returning();
  if (input.attachments?.length) await db.update(A).set({ emailId: id }).where(inArray(A.id, input.attachments.map((a) => a.id)));
  await db.update(M).set({ isUnread: 0 }).where(eq(M.id, original.id));
  if (!scheduled && original.leadId) {
    // Only an email to the lead contacts them: a forward to a colleague doesn't.
    if (toLead(row)) await db.update(schema.leads).set({ lastTouchAt: now, lastContactAt: now }).where(eq(schema.leads.id, original.leadId));
    if (input.kind === "reply") await appendThreadMessage(original.leadId, messageId, account.id);
  }
  return stored!;
}

/** The email goes to its lead (in To, Cc or Bcc). */
function toLead(row: { leadEmail?: string | null; toList?: string | null; ccList?: string | null; bccList?: string | null }): boolean {
  const lead = row.leadEmail?.toLowerCase();
  return !!lead && [row.toList, row.ccList, row.bccList].some((list) => splitList(list).includes(lead));
}

export interface NewEmailInput {
  workspaceId: string;
  account: AccountRow;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  attachments?: (typeof A.$inferSelect)[];
  reminderAt?: Date | null;
  scheduledAt?: Date | null;
}

/**
 * A new conversation rather than a reply: its own thread, tied to the lead with the first recipient's address when
 * there is one, so their reply lands with that lead. Blocklisted and unsubscribed addresses are refused.
 */
export async function sendNewEmail(input: NewEmailInput): Promise<EmailRow> {
  const { account } = input;
  const paused = pausedRefusal(account);
  if (paused) throw badRequest(paused);
  const to = [...new Set(input.to.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (!to.length) throw badRequest("Email has no recipient!");
  const subject = input.subject.trim().slice(0, 998);
  if (!subject) throw badRequest("Add a subject.");
  const html = input.html ?? (input.text ? textToHtml(input.text) : "");
  if (!htmlToText(html).trim() && !input.attachments?.length) throw badRequest("Email has no content!");
  const everyone = [...new Set([...to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((x) => x.toLowerCase()))];
  const blocked = await blockedSet(input.workspaceId, everyone);
  const unsubscribed = await db
    .select({ email: schema.unsubscribes.email })
    .from(schema.unsubscribes)
    .where(and(eq(schema.unsubscribes.workspaceId, input.workspaceId), inArray(schema.unsubscribes.email, everyone)));
  const refused = [...new Set([...blocked, ...unsubscribed.map((u) => u.email)])];
  if (refused.length) throw badRequest(`${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} on your blocklist or unsubscribed, so this email wasn't sent.`);

  const L = schema.leads;
  const [lead] = await db
    .select()
    .from(L)
    .where(and(eq(L.workspaceId, input.workspaceId), eq(L.email, to[0]!)))
    .orderBy(desc(L.lastContactAt), desc(L.createdAt))
    .limit(1);
  const scheduled = input.scheduledAt && input.scheduledAt.getTime() > Date.now() + 30_000 ? input.scheduledAt : null;
  const now = new Date();
  const id = uuidv7();
  const text = htmlToText(html);
  const files = input.attachments ?? [];
  const row: typeof M.$inferInsert = {
    id,
    workspaceId: input.workspaceId,
    messageId: newMessageId(account.email),
    threadId: uuidv7(),
    subject,
    fromAddress: account.email,
    fromJson: [{ address: account.email, name: `${account.firstName} ${account.lastName}`.trim() }],
    toList: to.join(","),
    toJson: to.map((address) => ({ address, name: "" })),
    ccList: input.cc?.length ? input.cc.join(",") : null,
    ccJson: input.cc?.length ? input.cc.map((address) => ({ address, name: "" })) : null,
    bccList: input.bcc?.length ? input.bcc.join(",") : null,
    replyTo: account.replyTo ?? null,
    bodyText: text,
    bodyHtml: html,
    contentPreview: snippet(text, 160),
    timestampEmail: scheduled ?? now,
    campaignId: lead?.campaignId ?? null,
    listId: lead?.listId ?? null,
    leadEmail: to[0]!,
    leadId: lead?.id ?? null,
    accountId: account.id,
    eaccount: account.email,
    ueType: scheduled ? EmailType.SCHEDULED : EmailType.SENT,
    isUnread: 0,
    isFocused: 1,
    interestStatus: lead?.interestStatus ?? null,
    attachments: files.length ? { files: files.map(metaOf) } : null,
    reminderAt: reminderAfterSend(input.reminderAt, scheduled, now),
    scheduledAt: scheduled,
  };
  if (!scheduled) await deliver(row, account, files);
  const [stored] = await db.insert(M).values(row).returning();
  if (files.length) await db.update(A).set({ emailId: id }).where(inArray(A.id, files.map((a) => a.id)));
  if (!scheduled && lead) await db.update(L).set({ lastTouchAt: now, lastContactAt: now }).where(eq(L.id, lead.id));
  return stored!;
}

/** Keeps the lead's thread pointers current so later automated follow-ups thread under the manual reply. */
async function appendThreadMessage(leadId: string, messageId: string, accountId: string) {
  const [lead] = await db.select({ ids: schema.leads.threadMessageIds }).from(schema.leads).where(eq(schema.leads.id, leadId));
  await db
    .update(schema.leads)
    .set({ threadMessageIds: [...(lead?.ids ?? []).slice(-20), messageId], senderAccountId: accountId })
    .where(eq(schema.leads.id, leadId));
}

async function deliver(row: typeof M.$inferInsert, account: AccountRow, files: (typeof A.$inferSelect)[]) {
  try {
    await driverFor(account).send({
      from: { name: `${account.firstName} ${account.lastName}`.trim(), address: account.email },
      to: splitList(row.toList).map((address) => ({ address })),
      cc: splitList(row.ccList).map((address) => ({ address })),
      bcc: splitList(row.bccList).map((address) => ({ address })),
      replyTo: row.replyTo,
      subject: row.subject ?? "",
      html: row.bodyHtml,
      text: row.bodyText,
      messageId: row.messageId,
      inReplyTo: row.inReplyTo,
      references: (row.references ?? "").split(/\s+/).filter(Boolean),
      attachments: files.map(outgoingOf),
      date: row.timestampEmail instanceof Date ? row.timestampEmail : undefined,
    });
  } catch (err) {
    const e = err instanceof MailError ? err : classifyError(err);
    await noteSendFailure(account, e);
    throw badRequest(`Error sending email: ${e.message}`, { kind: e.kind });
  }
  await noteSendSuccess(account);
}

const U = schema.unsubscribes;
const B = schema.blockList;

/**
 * A scheduled email was written earlier, so what changed since is checked again before it goes out: its mailbox paused
 * or removed, a recipient who unsubscribed or was blocklisted in the meantime. Returns why it can't be sent, or null.
 * (What was already true when it was written was the writer's choice: a reply confirming an unsubscribe still goes.)
 */
async function changedSince(row: EmailRow, account: AccountRow | undefined): Promise<string | null> {
  if (!account) return "The mailbox it was going to be sent from was removed. Write it again from another mailbox.";
  if (account.status === AccountStatus.PAUSED) return `${account.email} is paused. Resume it in Email accounts, then reschedule this email.`;
  const everyone = [...new Set([...splitList(row.toList), ...splitList(row.ccList), ...splitList(row.bccList)])];
  if (!everyone.length) return "It has no recipient.";
  const domains = [...new Set(everyone.map((e) => e.split("@")[1]!))];
  const [unsubscribed, blocked] = await Promise.all([
    db
      .select({ email: U.email })
      .from(U)
      .where(and(eq(U.workspaceId, row.workspaceId), inArray(U.email, everyone), gte(U.createdAt, row.createdAt))),
    db
      .select({ value: B.value })
      .from(B)
      .where(and(eq(B.workspaceId, row.workspaceId), inArray(B.value, [...everyone, ...domains]), gte(B.createdAt, row.createdAt))),
  ]);
  const listed = (xs: string[]) => `${xs.join(", ")} ${xs.length === 1 ? "was" : "were"}`;
  if (unsubscribed.length) return `${listed(unsubscribed.map((u) => u.email))} unsubscribed after this email was scheduled, so it wasn't sent.`;
  const values = new Set(blocked.map((b) => b.value));
  const refused = everyone.filter((e) => values.has(e) || values.has(e.split("@")[1]!));
  if (refused.length) return `${listed(refused)} added to your blocklist after this email was scheduled, so it wasn't sent.`;
  return null;
}

/** Shown on a scheduled email whose send was cut short (the app stopped mid-send), until the send finishes. */
const INTERRUPTED = "The app stopped while this email was being sent, so it may have gone out. Check the mailbox's Sent folder before rescheduling it.";

/** Engine loop: sends scheduled Unibox emails that are due. */
/**
 * A reminder due before its email goes out counts from the send instead ("send Monday, remind me in a day" reminds on
 * Tuesday), keeping the gap it was set with; at least an hour. `from` is when that gap started.
 */
export function reminderAfterSend(reminderAt: Date | null | undefined, sendAt: Date | null, from: Date): Date | null {
  if (!reminderAt) return null;
  if (!sendAt || reminderAt.getTime() > sendAt.getTime()) return reminderAt;
  return new Date(sendAt.getTime() + Math.max(reminderAt.getTime() - from.getTime(), 3_600_000));
}

export async function runScheduledEmails() {
  const due = await db
    .select()
    .from(M)
    .where(and(eq(M.ueType, EmailType.SCHEDULED), isNotNull(M.scheduledAt), sql`${M.scheduledAt} <= ${Date.now()}`, isNull(M.deletedAt), await inUse(M.workspaceId)))
    .limit(20);
  for (const row of due) {
    // Claim the row so a second engine never sends it twice; one deleted since it was picked (with its conversation)
    // isn't sent.
    const [claimed] = await db
      .update(M)
      .set({ scheduledAt: null, sendError: INTERRUPTED })
      .where(and(eq(M.id, row.id), eq(M.ueType, EmailType.SCHEDULED), isNotNull(M.scheduledAt), isNull(M.deletedAt)))
      .returning({ id: M.id });
    if (!claimed) continue;
    const [account] = row.accountId ? await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, row.accountId)) : [];
    const refusal = await changedSince(row, account);
    if (refusal || !account) {
      await db.update(M).set({ sendError: refusal }).where(eq(M.id, row.id));
      continue;
    }
    const files = row.attachments?.files?.length ? await db.select().from(A).where(inArray(A.id, row.attachments.files.map((f) => f.id))) : [];
    const now = new Date();
    try {
      await deliver({ ...row, timestampEmail: now }, account, files);
      // Sent later than planned: a reminder set to follow the send still does.
      const reminderAt = reminderAfterSend(row.reminderAt, now, row.scheduledAt ?? row.createdAt);
      await db.update(M).set({ ueType: EmailType.SENT, timestampEmail: now, sendError: null, reminderAt }).where(eq(M.id, row.id));
      if (row.leadId) {
        if (toLead(row)) await db.update(schema.leads).set({ lastTouchAt: now, lastContactAt: now }).where(eq(schema.leads.id, row.leadId));
        if (row.inReplyTo) await appendThreadMessage(row.leadId, row.messageId, account.id);
      }
    } catch (err) {
      await db.update(M).set({ sendError: (err as Error).message.slice(0, 500) }).where(eq(M.id, row.id));
    }
  }
}

// ---------- Export (.eml and .mbox) ----------

const addressList = (json: Array<{ address: string; name: string }> | null, list: string | null | undefined): Address[] =>
  json?.length ? json.map((a) => ({ address: a.address, name: a.name || null })) : splitList(list).map((address) => ({ address }));

/**
 * One stored email rebuilt as an RFC 822 message (CRLF line ends), with its attachments when their files still exist.
 * Received mail keeps the text it arrived with; for our own sends the text part is made from the cleaned HTML.
 */
export async function rawMessage(e: EmailRow): Promise<Buffer> {
  const ids = (e.attachments?.files ?? []).map((f) => f.id);
  const files = ids.length ? await db.select().from(A).where(and(eq(A.workspaceId, e.workspaceId), inArray(A.id, ids))) : [];
  const html = e.bodyHtml?.trim() ? untrackHtml(e.bodyHtml) : null;
  const text = e.ueType === EmailType.RECEIVED || !html ? untrackText(e.bodyText ?? "") : htmlToText(html);
  const from = e.fromJson?.[0] ?? { address: e.fromAddress || e.eaccount, name: "" };
  return buildRaw({
    from: { address: from.address, name: from.name || null },
    to: addressList(e.toJson, e.toList),
    cc: addressList(e.ccJson, e.ccList),
    replyTo: e.replyTo,
    subject: e.subject ?? "",
    html,
    text,
    messageId: bracketId(e.messageId) ?? newMessageId(e.eaccount),
    inReplyTo: e.inReplyTo,
    references: (e.references ?? "").split(/\s+/).filter(Boolean),
    date: e.timestampEmail,
    attachments: files.map(outgoingOf).filter((f) => !!f.path && existsSync(f.path)),
  });
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const asctime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
};

/** An mbox file (mboxrd: lines starting with "From " inside a message get a ">"), oldest message first per thread. */
export async function mbox(rows: EmailRow[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const e of rows) {
    const body = (await rawMessage(e)).toString("latin1").replace(/\r\n/g, "\n").replace(/^(>*From )/gm, ">$1");
    const sender = (e.fromAddress || e.eaccount || "MAILER-DAEMON").replace(/\s+/g, "");
    parts.push(Buffer.from(`From ${sender} ${asctime(e.timestampEmail)}\n${body}${body.endsWith("\n") ? "" : "\n"}\n`, "latin1"));
  }
  return Buffer.concat(parts);
}

export interface ContinuationPlan {
  lead: LeadRow;
  sub: SubsequenceRow;
  /** The step to continue at, from 0. */
  step: number;
  waitMs: number;
}

const ENDED: number[] = [LeadStatus.BOUNCED, LeadStatus.UNSUBSCRIBED];

/**
 * "If no reply, continue subsequence X at step N" after a manual reply, checked before the reply goes out, so a refusal
 * means nothing was sent. `leadId`: the conversation's lead.
 */
export async function checkContinuation(workspaceId: string, leadId: string | null, opts: { subsequenceId: string; step: number; waitMs: number }): Promise<ContinuationPlan> {
  const off = "Turn this option off to send only your reply.";
  const L = schema.leads;
  const [lead] = leadId ? await db.select().from(L).where(and(eq(L.id, leadId), eq(L.workspaceId, workspaceId))) : [];
  if (!lead) throw badRequest(`This conversation has no lead, so no subsequence can continue. ${off}`);
  const [sub] = await db.select().from(schema.subsequences).where(eq(schema.subsequences.id, opts.subsequenceId));
  if (!sub || sub.workspaceId !== workspaceId) throw badRequest(`Continuation is no longer available. ${off}`);
  if (lead.campaignId !== sub.parentCampaignId) throw badRequest(`The lead is not in this subsequence's campaign. ${off}`);
  const steps = sub.sequences?.[0]?.steps ?? [];
  if (opts.step < 0 || opts.step >= steps.length) throw badRequest(`That step does not exist in the subsequence. ${off}`);
  if (ENDED.includes(lead.status)) throw badRequest(`${lead.email} ${lead.status === LeadStatus.BOUNCED ? "bounced" : "unsubscribed"}, so nothing more is sent to them. ${off}`);
  return { lead, sub, step: opts.step, waitMs: opts.waitMs };
}

/** Puts the lead into the subsequence at the planned step (see checkContinuation). `running`: it goes out on its own. */
export async function scheduleContinuation(plan: ContinuationPlan, accountId: string) {
  const { lead, sub } = plan;
  const L = schema.leads;
  const at = Date.now() + plan.waitMs;
  const [entered] = await db
    .update(L)
    .set({
      subsequenceId: sub.id,
      subseqStatus: LeadStatus.ACTIVE,
      subseqNextStep: plan.step,
      subseqNextSendAt: at,
      addedSubsequenceAt: new Date(),
      senderAccountId: accountId,
      status: sql`case when ${L.status} = ${LeadStatus.ACTIVE} then ${LeadStatus.COMPLETED} else ${L.status} end`,
      nextSendAt: null,
    })
    // A bounce or unsubscribe that came in meanwhile stands.
    .where(and(eq(L.id, lead.id), notInArray(L.status, ENDED)))
    .returning({ id: L.id });
  if (!entered) throw badRequest(`${lead.email} bounced or unsubscribed meanwhile, so the subsequence doesn't continue.`);
  await reopenForSubsequences(sub.workspaceId, sub.parentCampaignId);
  const [campaign] = await db.select({ status: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, sub.parentCampaignId));
  const sending: number[] = [CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES, CampaignStatus.ACCOUNTS_UNHEALTHY];
  return {
    subsequence_id: sub.id,
    name: sub.name,
    step: plan.step + 1,
    scheduled_for: new Date(at).toISOString(),
    running: sub.status === CampaignStatus.ACTIVE && sending.includes(campaign?.status ?? CampaignStatus.PAUSED),
  };
}

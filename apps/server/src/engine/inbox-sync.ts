// Inbox sync: pulls new mail over IMAP (or the sandbox), files replies into the Unibox, detects bounces
// and auto-replies, and hands warmup emails to the warmup engine.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { EmailType, WarmupStatus } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { MailFolders } from "../db/schema";
import { config } from "../env";
import { toStoredPath } from "../lib/data-files";
import { uuidv7 } from "../lib/ids";
import { bracketId } from "../mail/compose";
import { driverFor, isSandbox, type AccountRow } from "../mail/driver";
import { parseInbound, type InboundMessage } from "../mail/parse";
import { detectOptOut, newestReplyText } from "../mail/reply-text";
import type { FetchBatch, FetchedMessage, FolderInfo, MailSession } from "../mail/types";
import { MailError } from "../mail/types";
import { classifyError } from "../mail/smtp-imap";
import { clearAccountError, errorState, failuresBeforeOut, recordAccountError } from "../services/accounts";
import { getWorkspaceSetting } from "../services/workspaces";
import { handleBounce, handleReply, handleUnsubscribe, type EmailRow, type LeadRow } from "../services/activity";
import { handleWarmupMessage } from "./warmup";
import { stoppedWorkspaces } from "../services/live-workspaces";

const M = schema.emails;
const A = schema.emailAccounts;

/** How often a mailbox's folder list is read again: folders get added, renamed or hidden from IMAP. */
const FOLDERS_RECHECK_MS = 24 * 3_600_000;
/** How many passes a message that fails to file (while others around it go through) is tried on before it's skipped. */
const MESSAGE_TRIES = 3;
/** Messages that failed to file, by account, folder and UID, and how many passes they've failed on (in-memory). */
const failedMessages = new Map<string, number>();

export function detectFolders(list: FolderInfo[]): MailFolders {
  const by = (use: string) => list.find((f) => f.specialUse === use)?.path ?? null;
  const byName = (re: RegExp) => list.find((f) => re.test(f.path))?.path ?? null;
  return {
    inbox: list.find((f) => f.path.toUpperCase() === "INBOX")?.path ?? "INBOX",
    spam: by("\\Junk") ?? byName(/(^|[/.])(spam|junk|junk e-?mail|bulk( mail)?)$/i),
    sent: by("\\Sent") ?? byName(/(^|[/.])sent( items| mail| messages)?$/i),
    trash: by("\\Trash") ?? byName(/(^|[/.])(trash|deleted( items| messages)?|bin)$/i),
    archive: by("\\Archive") ?? byName(/(^|[/.])archive$/i),
    important: by("\\Important"),
    all: by("\\All") ?? byName(/(^|[/.])all mail$/i),
  };
}

/**
 * Where replies end up when a filter or rule skips the inbox: Gmail's All Mail, else the archive. Read for replies
 * from leads only; the inbox and spam folders stay the main source.
 */
function repliesFolder(f: MailFolders): string | null {
  const extra = f.all ?? f.archive;
  return extra && extra !== f.inbox && extra !== f.spam ? extra : null;
}

/** Saves what it can: a file that can't be written (disk full, antivirus) is left out, and the email is kept anyway. */
async function saveAttachments(workspaceId: string, emailId: string, parsed: InboundMessage) {
  const files: Array<{ id: string; filename: string; size: number; content_type: string; content_id: string | null }> = [];
  if (!parsed.attachments.length) return files;
  const dir = path.join(config.dataDir, "attachments", workspaceId, emailId);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    console.warn(`[inbox-sync] attachments of ${emailId} not saved: ${(err as Error).message}`);
    return files;
  }
  for (const a of parsed.attachments.slice(0, 20)) {
    if (a.size > 25 * 1024 * 1024) continue;
    const id = uuidv7();
    const safe = a.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
    const file = path.join(dir, `${id}-${safe}`);
    try {
      await writeFile(file, a.content);
    } catch (err) {
      console.warn(`[inbox-sync] attachment ${a.filename} of ${emailId} not saved: ${(err as Error).message}`);
      continue;
    }
    await db
      .insert(schema.emailAttachments)
      .values({ id, workspaceId, emailId, filename: a.filename, contentType: a.contentType, size: a.size, storagePath: toStoredPath(file), contentId: a.contentId });
    files.push({ id, filename: a.filename, size: a.size, content_type: a.contentType, content_id: a.contentId });
  }
  return files;
}

/**
 * The mail a mailbox's messages are matched against: its workspace's, and what it sent and filed itself, wherever that
 * is (a mailbox moved to another workspace still gets the replies to the emails it sent before).
 */
const mailOf = (account: AccountRow) => or(eq(M.workspaceId, account.workspaceId), eq(M.accountId, account.id))!;

/** The emails a message answers, nearest first: In-Reply-To, then References from the end. */
const answeredIds = (parsed: InboundMessage) => [parsed.inReplyTo, ...parsed.references.slice().reverse()].filter((x): x is string => !!x).slice(0, 20);

/** Finds the email this message answers (In-Reply-To / References). */
async function findParent(account: AccountRow, parsed: InboundMessage): Promise<EmailRow | null> {
  const ids = answeredIds(parsed);
  if (!ids.length) return null;
  const rows = await db
    .select()
    .from(M)
    .where(and(mailOf(account), inArray(M.messageId, ids)))
    .orderBy(desc(M.timestampEmail))
    .limit(5);
  if (!rows.length) return null;
  // Prefer the direct parent, then this workspace's.
  return rows.find((r) => r.messageId === parsed.inReplyTo) ?? rows.find((r) => r.workspaceId === account.workspaceId) ?? rows[0]!;
}

/** It answers an email this address sent from another workspace (the same mailbox is connected there too). */
async function answersElsewhere(account: AccountRow, parsed: InboundMessage): Promise<boolean> {
  const ids = answeredIds(parsed);
  if (!ids.length) return false;
  const [row] = await db
    .select({ id: M.id })
    .from(M)
    .where(and(inArray(M.messageId, ids), eq(M.eaccount, account.email), ne(M.workspaceId, account.workspaceId), ne(M.ueType, EmailType.RECEIVED)))
    .limit(1);
  return !!row;
}

async function findLeadByEmail(workspaceId: string, email: string): Promise<LeadRow | null> {
  const rows = await db
    .select()
    .from(schema.leads)
    .where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.email, email)))
    .orderBy(desc(schema.leads.lastContactAt), desc(schema.leads.createdAt))
    .limit(5);
  return rows.find((r) => r.campaignId && r.lastContactAt) ?? rows.find((r) => r.campaignId) ?? rows[0] ?? null;
}

async function isOwnOutgoing(account: AccountRow, messageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: M.id })
    .from(M)
    .where(and(mailOf(account), eq(M.messageId, messageId), ne(M.ueType, EmailType.RECEIVED)))
    .limit(1);
  return !!row;
}

/**
 * Filed already: from another folder (All Mail holds the inbox's messages too), or by another of the workspace's
 * mailboxes (a reply sent to two of them, one copied in) — each message is filed, and acted on, once. `retry`: what it
 * sets off failed last time (see act).
 */
async function storedCopy(account: AccountRow, messageId: string): Promise<{ id: string; retry: boolean } | null> {
  const [row] = await db
    .select({ id: M.id, retry: M.retryHandling })
    .from(M)
    .where(and(mailOf(account), eq(M.messageId, messageId), eq(M.ueType, EmailType.RECEIVED)))
    .orderBy(desc(M.retryHandling))
    .limit(1);
  return row ?? null;
}

/** Takes a filed message whose follow-up failed, to do it now; null once it's done or another pass has taken it. */
async function takeRetry(id: string): Promise<EmailRow | null> {
  const [row] = await db.update(M).set({ retryHandling: false }).where(and(eq(M.id, id), eq(M.retryHandling, true))).returning();
  return row ?? null;
}

/** Files a received message once. Done again (see act), it's the copy filed before. */
async function file(again: EmailRow | null, values: typeof M.$inferInsert): Promise<EmailRow | undefined> {
  if (again) return again;
  const [row] = await db.insert(M).values(values).onConflictDoNothing().returning();
  return row;
}

/**
 * Waits for what a filed message sets off (a reply stops the lead, a bounce marks the address). When that fails partway,
 * the message is marked, and the next pass that reads it (a message that failed is fetched again) does it then.
 */
async function act(emailId: string, work: Promise<void>) {
  try {
    await work;
  } catch (err) {
    await db
      .update(M)
      .set({ retryHandling: true })
      .where(eq(M.id, emailId))
      .catch(() => {});
    throw err;
  }
}

/** How often inbox sync reads a mailbox whose inbox works: every 15 s for a test mailbox, every minute for a real one. */
export const syncIntervalMs = (a: Pick<AccountRow, "providerCode">) => (isSandbox(a) ? 15_000 : 60_000);

const RETRY_INBOX_MS = 10 * 60_000;
const RETRY_INBOX_MAX_MS = 24 * 3_600_000;

/**
 * When inbox sync next reads a mailbox. Only a failing inbox slows down (a mailbox that can't send still gets its
 * replies on time): once its failures took it out, it's tried after 10 minutes, then twice as long after each further
 * failure, up to a day. A changed password isn't tried every few minutes for ever: providers lock accounts that keep
 * failing to sign in, and shared servers ban the address they come from.
 */
export function syncDueAt(a: Pick<AccountRow, "statusMessage" | "providerCode" | "lastSyncAt">): number {
  const failure = errorState(a.statusMessage)?.sides?.imap;
  const last = Math.max(a.lastSyncAt?.getTime() ?? 0, failure?.at ?? 0);
  const over = failure ? failure.count - failuresBeforeOut(failure.code, "imap") : -1;
  if (!failure || over < 0) return last + syncIntervalMs(a);
  return failure.at + Math.min(RETRY_INBOX_MAX_MS, RETRY_INBOX_MS * 2 ** Math.min(over, 10));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a message was written to this address: in To or Cc, or as the address it was delivered to. */
function addressedTo(parsed: InboundMessage, email: string): boolean {
  const me = email.toLowerCase();
  if ([...parsed.to, ...parsed.cc].some((a) => a.address.toLowerCase() === me)) return true;
  const exact = new RegExp(`(^|[^a-z0-9._%+-])${escapeRe(me)}($|[^a-z0-9.-])`);
  return ["delivered-to", "x-original-to"].some((h) => exact.test(JSON.stringify(parsed.headers.get(h) ?? "").toLowerCase()));
}

/** The Message-ID from the raw header block, without parsing the whole message. */
function headerMessageId(raw: Buffer): string | null {
  const head = raw.subarray(0, 32_768).toString("utf8").split(/\r?\n\r?\n/, 1)[0] ?? "";
  return bracketId(/^Message-ID:\s*(<[^>\s]+>)/im.exec(head)?.[1] ?? null);
}

/** The display name on a reply is the lead's own ("Pat Lee <p.lee@…>" for the lead pat@…): their other address. */
function namedAsLead(name: string | undefined, lead: LeadRow): boolean {
  const words = (s: string | null | undefined) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const first = words(lead.firstName);
  const last = words(lead.lastName);
  if (!first.length || !last.length) return false;
  const said = new Set(words(name));
  return [...first, ...last].every((w) => said.has(w));
}

/** The lead wrote it: from their address, or under their own name from another. */
function byLead(parsed: InboundMessage, lead: LeadRow): boolean {
  return (parsed.from?.address ?? "").toLowerCase() === lead.email?.toLowerCase() || namedAsLead(parsed.from?.name, lead);
}

/** One of our emails went to this address (To, Cc or Bcc). */
function sentTo(email: EmailRow, address: string | null): boolean {
  const a = address?.toLowerCase();
  return !!a && [email.toList, email.ccList, email.bccList].some((list) => (list ?? "").toLowerCase().split(/[,;\s]+/).includes(a));
}

/** `repliesOnly`: a folder read only for replies from leads (see repliesFolder); everything else there is left alone. */
async function processMessage(account: AccountRow, session: MailSession, folders: MailFolders, fetched: FetchedMessage, repliesOnly = false) {
  // All Mail repeats the inbox: what's filed already is skipped before it's parsed again.
  if (repliesOnly) {
    const id = headerMessageId(fetched.raw);
    const copy = id ? await storedCopy(account, id) : null;
    if (copy && !copy.retry) return;
  }
  const parsed = await parseInbound(fetched.raw);
  // Mail to the mailbox's address arriving here proves the address is its own: warmup can write to it from now on.
  if (!account.addressSeenAt && !repliesOnly && (fetched.folder === folders.inbox || fetched.folder === folders.spam) && addressedTo(parsed, account.email)) {
    account.addressSeenAt = new Date();
    await db.update(A).set({ addressSeenAt: account.addressSeenAt }).where(eq(A.id, account.id));
  }
  const from = parsed.from?.address ?? "";
  if (!from || from === account.email.toLowerCase()) return;

  // Warmup pool messages never reach the Unibox.
  const [wm] = await db.select().from(schema.warmupMessages).where(eq(schema.warmupMessages.messageId, parsed.messageId)).limit(1);
  if (wm) {
    if (wm.recipientAccountId === account.id && !repliesOnly) await handleWarmupMessage(account, session, folders, fetched, wm);
    return;
  }

  if (await isOwnOutgoing(account, parsed.messageId)) return;
  // Seen in another folder or mailbox already: nothing to file again, no attachments to save twice. Only what it sets
  // off is done again, when that failed last time.
  const copy = await storedCopy(account, parsed.messageId);
  const again = copy?.retry ? await takeRetry(copy.id) : null;
  if (copy && !again) return;

  const inSpam = !!folders.spam && fetched.folder === folders.spam;

  if (parsed.bounce) {
    const bounce = parsed.bounce;
    // A notice about a warmup email (a partner's mailbox full, suspended or gone) isn't for the Unibox, and says nothing
    // about a lead: the warmup pool notices a partner that stopped answering on its own.
    if (bounce.originalMessageId) {
      const [warm] = await db.select({ id: schema.warmupMessages.id }).from(schema.warmupMessages).where(eq(schema.warmupMessages.messageId, bounce.originalMessageId)).limit(1);
      if (warm) return;
    }
    const original = bounce.originalMessageId ? (await db.select().from(M).where(and(mailOf(account), eq(M.messageId, bounce.originalMessageId))).limit(1))[0] : undefined;
    const home = original?.workspaceId ?? account.workspaceId;
    let lead: LeadRow | null = null;
    if (original?.leadId) [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, original.leadId)).limit(1);
    // A notice about someone else on the email (a cc or bcc address, someone copied on a reply) isn't the lead's bounce,
    // and doesn't count against the campaign; it only matters when that address is a lead itself.
    const aboutOriginal = !bounce.recipients.length || !original?.leadEmail || bounce.recipients.includes(original.leadEmail.toLowerCase());
    if (!aboutOriginal) lead = null;
    if (!lead && bounce.recipient) lead = await findLeadByEmail(home, bounce.recipient);
    const source = aboutOriginal ? original : undefined;
    const stored = await file(again, {
      workspaceId: home,
      messageId: parsed.messageId,
      threadId: original?.threadId ?? lead?.threadId ?? uuidv7(),
      inReplyTo: parsed.inReplyTo,
      subject: parsed.subject,
      fromAddress: from,
      fromJson: parsed.from ? [parsed.from] : null,
      toList: parsed.to.map((t) => t.address).join(","),
      toJson: parsed.to,
      bodyText: parsed.text,
      bodyHtml: parsed.html,
      contentPreview: parsed.preview,
      timestampEmail: parsed.date,
      campaignId: source?.campaignId ?? lead?.campaignId ?? null,
      leadEmail: lead?.email ?? bounce.recipient,
      leadId: lead?.id ?? null,
      accountId: account.id,
      eaccount: account.email,
      ueType: EmailType.RECEIVED,
      isUnread: 0,
      isBounce: true,
      isFocused: 0,
      folder: fetched.folder,
      imapUid: fetched.uid,
    });
    if (!stored || bounce.kind === "delayed" || (!source && !lead)) return;
    await act(
      stored.id,
      handleBounce({
        workspaceId: home,
        lead,
        campaignId: source?.campaignId ?? lead?.campaignId ?? null,
        accountId: account.id,
        accountEmail: account.email,
        emailId: source?.id ?? null,
        subsequenceId: source?.subsequenceId ?? null,
        step: source?.step != null ? Number(source.step) : null,
        variant: source?.variant ?? null,
        hard: bounce.hard,
        diagnostic: bounce.diagnostic,
        status: bounce.status,
      }),
    );
    return;
  }

  const parent = await findParent(account, parsed);
  // Where the conversation lives: a mailbox moved to another workspace still files replies to what it sent before.
  const home = again?.workspaceId ?? parent?.workspaceId ?? account.workspaceId;
  let lead: LeadRow | null = null;
  // Done again: for the lead it was filed with.
  const leadId = again ? again.leadId : parent?.leadId;
  if (leadId) [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1);
  if (again && !lead) return;
  // Someone else answering one of our emails that didn't go to the lead (a forward to a colleague, a reply written to
  // someone else on the thread) isn't the lead replying: it's filed with the conversation and sets nothing off for the
  // lead (stopping its campaign, reply webhooks, an agent answering it as the lead).
  const aside = !again && !!lead && !!parent && parent.ueType !== EmailType.RECEIVED && !sentTo(parent, lead.email) && !byLead(parsed, lead);
  if (aside) lead = null;
  // A reply to what this address sent from another workspace (the same mailbox is connected there too) is that
  // workspace's conversation: here it isn't put down to a lead by the sender's address.
  if (!lead && (parent || !(await answersElsewhere(account, parsed)))) lead = await findLeadByEmail(home, from);

  if (!parent && !lead) {
    // Mail that isn't part of any outreach is never picked out of the archive.
    if (repliesOnly) return;
    // A List-Unsubscribe email from an address that isn't a lead (an alias, say): that address isn't emailed either.
    if (detectOptOut(parsed.subject, newestReplyText(parsed.text)) === "request") await handleUnsubscribe({ workspaceId: home, email: from, source: "header" });
    // Otherwise it's only kept when the workspace wants it in the Unibox.
    if ((await getWorkspaceSetting(home, "unibox_save_non_campaign_emails", true)) === false) return;
  }

  const threadId = again?.threadId ?? parent?.threadId ?? lead?.threadId ?? uuidv7();
  if (lead && !lead.threadId) await db.update(schema.leads).set({ threadId }).where(eq(schema.leads.id, lead.id));

  const emailId = uuidv7();
  const stored = await file(again, {
    id: emailId,
    workspaceId: home,
    messageId: parsed.messageId,
    threadId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references.join(" ") || null,
    subject: parsed.subject,
    fromAddress: from,
    fromJson: parsed.from ? [parsed.from] : null,
    toList: parsed.to.map((t) => t.address).join(","),
    toJson: parsed.to,
    ccList: parsed.cc.map((t) => t.address).join(",") || null,
    ccJson: parsed.cc.length ? parsed.cc : null,
    replyTo: parsed.replyTo,
    bodyText: parsed.text,
    bodyHtml: parsed.html,
    contentPreview: parsed.preview,
    timestampEmail: parsed.date,
    campaignId: parent?.campaignId ?? lead?.campaignId ?? null,
    subsequenceId: parent?.subsequenceId ?? lead?.subsequenceId ?? null,
    listId: lead?.listId ?? null,
    leadEmail: lead?.email ?? from,
    leadId: lead?.id ?? null,
    accountId: account.id,
    eaccount: account.email,
    ueType: EmailType.RECEIVED,
    step: parent?.step ?? null,
    isUnread: 1,
    isAutoReply: parsed.isAutoReply ? 1 : 0,
    // Auto-replies and non-lead mail go to "Others"; an answer to something we sent aside stays with its conversation.
    isFocused: (lead || aside) && !parsed.isAutoReply ? 1 : 0,
    interestStatus: lead?.interestStatus ?? null,
    folder: inSpam ? "spam" : repliesOnly ? "archive" : "inbox",
    imapUid: fetched.uid,
  });
  if (!stored) return;
  // Attachments are saved once the email is: one that can't be saved never loses the reply, or what it sets off.
  if (!again) {
    try {
      const files = await saveAttachments(home, emailId, parsed);
      if (files.length) {
        await db.update(M).set({ attachments: { files } }).where(eq(M.id, emailId));
        stored.attachments = { files };
      }
    } catch (err) {
      console.warn(`[inbox-sync] attachments of ${emailId} not saved: ${(err as Error).message}`);
    }
  }

  if (lead) {
    await act(
      stored.id,
      handleReply({
        workspaceId: home,
        lead,
        email: stored,
        repliedTo: parent,
        isAutoReply: parsed.isAutoReply,
        accountId: account.id,
        accountEmail: account.email,
        // Someone else on the thread (a colleague copied in, an assistant): their opt-out is theirs, not the lead's.
        byLead: byLead(parsed, lead),
      }),
    );
  }
}

/** Reads the folder list again (daily, and after a folder couldn't be opened); a spam folder that turns up ends "spam folder unknown". */
async function refreshFolders(account: AccountRow, session: MailSession): Promise<MailFolders> {
  const folders: MailFolders = { ...detectFolders(await session.folders()), checked_at: Date.now() };
  const warmupStatus =
    !folders.spam && account.warmupStatus === WarmupStatus.ACTIVE
      ? WarmupStatus.SPAM_FOLDER_UNKNOWN
      : folders.spam && account.warmupStatus === WarmupStatus.SPAM_FOLDER_UNKNOWN
        ? WarmupStatus.ACTIVE
        : account.warmupStatus;
  await db.update(A).set({ folders, warmupStatus }).where(eq(A.id, account.id));
  return folders;
}

/** One sync pass for an account. */
export async function syncAccount(account: AccountRow): Promise<{ processed: number }> {
  const driver = driverFor(account);
  let session: MailSession | null = null;
  let processed = 0;
  const state = { ...(account.syncState ?? {}) };
  try {
    session = await driver.open();
    let folders: MailFolders | null = account.folders;
    // Read again daily, and once more for mailboxes last looked at before All Mail was read (no `all` yet).
    if (!folders || folders.all === undefined || Date.now() - (folders.checked_at ?? 0) > FOLDERS_RECHECK_MS) folders = await refreshFolders(account, session);
    const firstSyncSince = new Date(Date.now() - 3 * 86_400_000);
    const extra = repliesFolder(folders);
    for (const folder of [folders.inbox, folders.spam, extra].filter((f): f is string => !!f)) {
      const repliesOnly = folder === extra;
      const cur = state[folder];
      let batch: FetchBatch;
      try {
        batch = await session.fetchNew(folder, cur?.lastUid ?? 0, { uidValidity: cur?.uidValidity, max: isSandbox(account) ? 200 : 100, sinceDate: firstSyncSince });
      } catch (err) {
        // Only the inbox decides whether the mailbox can be read. A spam or archive folder that can't be opened (deleted,
        // renamed, hidden from IMAP) is skipped, and the folder list is read again on the next pass.
        if (folder === folders.inbox) throw err;
        console.warn(`[inbox-sync] ${account.email} ${folder}: ${classifyError(err).message}`);
        await db.update(A).set({ folders: { ...folders, checked_at: 0 } }).where(eq(A.id, account.id));
        continue;
      }
      const failed = [...(batch.failed ?? [])];
      let filed = 0;
      for (const m of batch.messages) {
        try {
          await processMessage(account, session, folders, m, repliesOnly);
          processed++;
          filed++;
        } catch (err) {
          console.error(`[inbox-sync] ${account.email} ${folder} uid ${m.uid}:`, (err as Error).message);
          failed.push(m.uid);
        }
      }
      // A message that fails while others go through is tried on the next passes, then skipped. When nothing went
      // through, the trouble isn't that message: all of them are tried again, with no try counted.
      let resumeAt: number | null = null;
      for (const uid of failed.sort((a, b) => a - b)) {
        const key = `${account.id}:${folder}:${uid}`;
        const tries = (failedMessages.get(key) ?? 0) + (filed ? 1 : 0);
        if (tries >= MESSAGE_TRIES) {
          failedMessages.delete(key);
          console.warn(`[inbox-sync] ${account.email} ${folder} uid ${uid}: skipped after ${MESSAGE_TRIES} tries`);
          continue;
        }
        failedMessages.set(key, tries);
        resumeAt ??= uid;
      }
      state[folder] = { uidValidity: batch.uidValidity, lastUid: resumeAt !== null ? Math.min(batch.highestUid, resumeAt - 1) : batch.highestUid };
      // Saved folder by folder: a later folder that fails doesn't bring this one's messages round again.
      await db.update(A).set({ syncState: state }).where(eq(A.id, account.id));
    }
    // The last sync that worked: the installation's Health page counts how far behind each inbox is from it.
    await db.update(A).set({ syncState: state, lastSyncAt: new Date() }).where(eq(A.id, account.id));
    // A good sync only vouches for the inbox side: a sending failure stays until a send works again.
    await clearAccountError(account, "imap");
  } catch (err) {
    try {
      const e = err instanceof MailError ? err : classifyError(err);
      // Raises account_error (rate limited) when this takes the mailbox out of sending. The failure's time is when the
      // next try comes due (syncDueAt).
      await recordAccountError(account, e.kind, e.message, { command: e.command, responseCode: e.responseCode, response: e.response }, "imap");
    } catch (inner) {
      console.error(`[inbox-sync] ${account.email}: couldn't record the failure`, inner);
    }
  } finally {
    await session?.close().catch(() => {});
  }
  return { processed };
}

/** Inbox syncs running at once, and how long one pass of the loop keeps starting more. */
const SYNC_WORKERS = 8;
const PASS_MS = 45_000;

/**
 * Engine loop: reads the mailboxes that are due (see syncDueAt), the longest waiting first, a few at a time. Each worker
 * takes the next mailbox as soon as it's done with one, so a slow server holds up only its own worker, and the pass goes
 * on until nothing is due or it has run for 45 seconds.
 */
export async function syncDueAccounts() {
  const stopped = await stoppedWorkspaces();
  const now = Date.now();
  // Only what deciding needs, for every mailbox; a mailbox's whole row is read when its turn comes.
  const rows = await db
    .select({ id: A.id, workspaceId: A.workspaceId, statusMessage: A.statusMessage, providerCode: A.providerCode, lastSyncAt: A.lastSyncAt })
    .from(A)
    .where(eq(A.setupPending, false));
  const due = rows
    .filter((a) => !stopped.has(a.workspaceId))
    .map((a) => ({ id: a.id, at: syncDueAt(a) }))
    .filter((a) => a.at <= now)
    .sort((x, y) => x.at - y.at);
  if (!due.length) return;
  const until = now + PASS_MS;
  let next = 0;
  const worker = async () => {
    while (next < due.length && Date.now() < until) {
      const id = due[next++]!.id;
      const [account] = await db.select().from(A).where(and(eq(A.id, id), eq(A.setupPending, false))).limit(1);
      // One mailbox's trouble never keeps the others from syncing.
      if (account) await syncAccount(account).catch((err) => console.error("[inbox-sync]", err));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNC_WORKERS, due.length) }, worker));
}

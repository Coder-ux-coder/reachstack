// Warmup engine. Mailboxes with warmup on exchange natural emails with the other warmup mailboxes in this installation;
// recipients rescue them from spam, open them, mark them important and reply, and where they land (inbox or spam)
// drives each mailbox's warmup score. Real mailboxes only warm up with real ones and sandbox mailboxes with sandbox
// ones, so a real mailbox never mails a test address. Hours, weekdays and ramp days follow the workspace clock.
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { AccountStatus, WARMUP_HOURS, WarmupStatus, domainOf, warmupTarget } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { MailFolders } from "../db/schema";
import { newMessageId, replySubject } from "../mail/compose";
import { driverFor, isSandbox, type AccountRow } from "../mail/driver";
import { classifyError } from "../mail/smtp-imap";
import { MailError, type FetchedMessage, type MailSession } from "../mail/types";
import { bumpAccountStat, defaultWarmup, noteSendFailure, noteSendSuccess, todayStats } from "../services/accounts";
import { recheckSendingFailures } from "../services/mailbox-health";
import { clockAt, dayOn, daysBefore, workspaceZones } from "../services/workspace-clock";
import { warmupEmail, warmupReply } from "./warmup-content";

type WarmupRow = typeof schema.warmupMessages.$inferSelect;
const A = schema.emailAccounts;

const pct = (v: number | undefined, fallback: number) => Math.max(0, Math.min(100, v ?? fallback)) / 100;

/** Recipient side: called by inbox sync for a pool message addressed to this account. */
export async function handleWarmupMessage(account: AccountRow, session: MailSession, folders: MailFolders, fetched: FetchedMessage, wm: WarmupRow) {
  if (wm.processedAt) return;
  // Claimed first: a message read twice at once (two syncs, or two folders) is acted on and counted once.
  const [claimed] = await db
    .update(schema.warmupMessages)
    .set({ processedAt: new Date() })
    .where(and(eq(schema.warmupMessages.id, wm.id), isNull(schema.warmupMessages.processedAt)))
    .returning({ id: schema.warmupMessages.id });
  if (!claimed) return;
  const inSpam = !!folders.spam && fetched.folder === folders.spam;
  const [sender] = await db.select().from(A).where(eq(A.id, wm.senderAccountId)).limit(1);
  // What happens to a warmup email is its sender's setting: "Open rate" and the rest are about that mailbox's emails.
  const senderCfg = sender?.warmup ?? defaultWarmup();
  const adv = senderCfg.advanced ?? {};
  let savedFromSpam = false;
  let opened = false;
  let important = false;
  try {
    let folderNow = fetched.folder;
    let uidNow: number | null = fetched.uid;
    if (inSpam && Math.random() < pct(adv.spam_save_rate, 100)) {
      // A move gives the message a new UID in the inbox: the server says which, or it's looked up by Message-ID.
      const moved = await session.move(fetched.folder, fetched.uid, folders.inbox);
      savedFromSpam = true;
      folderNow = folders.inbox;
      uidNow = moved ?? (await session.findByMessageId(wm.messageId, [folders.inbox]))?.uid ?? null;
    }
    if (uidNow !== null) {
      if (Math.random() < pct(adv.open_rate, 100)) {
        await session.addFlags(folderNow, uidNow, ["\\Seen"]);
        opened = true;
      }
      if (Math.random() < pct(adv.important_rate, 100)) {
        await session.addFlags(folderNow, uidNow, ["\\Important"]);
        important = true;
      }
    }
  } catch (err) {
    console.error(`[warmup] ${account.email}: could not act on warmup message`, (err as Error).message);
  }

  const wantsReply = !wm.isReply && Math.random() < pct(senderCfg.reply_rate, 30);
  const delayMin = isSandbox(account) ? 1 + Math.random() * 4 : 10 + Math.random() * 80;
  await db
    .update(schema.warmupMessages)
    .set({
      deliveredAt: new Date(),
      folder: inSpam ? "spam" : "inbox",
      savedFromSpam,
      opened,
      important,
      processedAt: new Date(),
      replyDueAt: wantsReply ? new Date(Date.now() + delayMin * 60_000) : null,
    })
    .where(eq(schema.warmupMessages.id, wm.id));

  await bumpAccountStat(account.workspaceId, account.id, "warmupReceived");
  if (sender) {
    await bumpAccountStat(sender.workspaceId, sender.id, inSpam ? "warmupSpam" : "warmupInbox");
    if (savedFromSpam) await bumpAccountStat(sender.workspaceId, sender.id, "warmupSavedFromSpam");
  }
}

/** Workspaces still in use: not deleted, and owned by an account that's neither turned off nor deleted. */
async function liveWorkspaces(ids: string[]): Promise<Set<string>> {
  const W = schema.workspaces;
  const U = schema.users;
  const rows = await db
    .select({ id: W.id })
    .from(W)
    .innerJoin(U, eq(U.id, W.ownerId))
    .where(and(inArray(W.id, [...new Set(ids)]), isNull(W.deletedAt), isNull(U.deletedAt), isNull(U.disabledAt)));
  return new Set(rows.map((r) => r.id));
}

/**
 * Mailboxes taking part in warmup: warmup on, the mailbox working (not paused, failing or still being set up) and its
 * workspace in use. Resting mailboxes stay in: a rest only keeps campaigns away.
 */
export async function warmupPool(): Promise<AccountRow[]> {
  const rows = await db
    .select()
    .from(A)
    .where(and(eq(A.warmupStatus, WarmupStatus.ACTIVE), eq(A.status, AccountStatus.ACTIVE), eq(A.setupPending, false)));
  if (!rows.length) return rows;
  const live = await liveWorkspaces(rows.map((r) => r.workspaceId));
  // The same mailbox connected in two workspaces warms up once, from the connection whose warmup started first: twice
  // would send twice its daily amount.
  const first = new Map<string, AccountRow>();
  for (const r of rows.filter((r) => live.has(r.workspaceId)).sort(byWarmupStart)) if (!first.has(lower(r.email))) first.set(lower(r.email), r);
  return [...first.values()];
}

const lower = (s: string) => s.toLowerCase();
const at = (d: Date | null) => d?.getTime() ?? Number.MAX_SAFE_INTEGER;
const byWarmupStart = (a: AccountRow, b: AccountRow) => at(a.warmupStartedAt) - at(b.warmupStartedAt) || at(a.createdAt) - at(b.createdAt) || a.id.localeCompare(b.id);

/** Real mailboxes warm up with real ones, sandbox mailboxes with sandbox ones (whose mail never leaves this installation). */
const sameWorld = (a: AccountRow, b: AccountRow) => isSandbox(a) === isSandbox(b);

/**
 * Whether mail to the mailbox's address is known to reach it: a test mailbox, one signed in with Google or Microsoft
 * (they say whose it is), one that signs in with its address, or one whose inbox has shown mail to that address. Only
 * these get warmup emails, so a mistyped address never has the pool writing to a stranger.
 */
export function addressConfirmed(a: AccountRow): boolean {
  if (isSandbox(a) || a.oauthEnc || a.addressSeenAt) return true;
  return lower((a.imap?.user ?? "").trim()) === lower(a.email);
}

/** Who `account` can send warmup to: the rest of the pool in its world, at confirmed addresses, never itself (nor its own address in another workspace). */
const partnersOf = (account: AccountRow, pool: AccountRow[]) =>
  pool.filter((r) => r.id !== account.id && lower(r.email) !== lower(account.email) && sameWorld(account, r) && addressConfirmed(r));

/**
 * Where a mailbox stands in warmup, for its account sheet: how many mailboxes it can warm up with (none: it warns),
 * whether its warmup runs from the same address's connection in another workspace, and whether its address is
 * confirmed (until then it only sends).
 */
export async function warmupStanding(account: AccountRow): Promise<{ partners: number; elsewhere: boolean; addressConfirmed: boolean }> {
  const pool = await warmupPool();
  return {
    partners: partnersOf(account, pool).length,
    elsewhere: !pool.some((r) => r.id === account.id) && pool.some((r) => lower(r.email) === lower(account.email)),
    addressConfirmed: addressConfirmed(account),
  };
}

/** A random partner for `sender`, on another domain when there is one. */
function pickRecipient(sender: AccountRow, pool: AccountRow[]): AccountRow | null {
  const others = partnersOf(sender, pool);
  const elsewhere = others.filter((r) => domainOf(r.email) !== domainOf(sender.email));
  const choices = elsewhere.length ? elsewhere : others;
  return choices.length ? choices[Math.floor(Math.random() * choices.length)]! : null;
}

async function workspaceCustomCopy(workspaceId: string) {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const c = ws?.settings?.custom_warmup_copy;
  return c?.enabled ? c : null;
}

const asMailError = (err: unknown) => (err instanceof MailError ? err : classifyError(err));

async function sendOne(sender: AccountRow, recipient: AccountRow) {
  const cfg = sender.warmup ?? defaultWarmup();
  const tag = cfg.warmup_custom_ftag || "warmup";
  const link =
    cfg.advanced?.warm_ctd && sender.trackingDomainName && sender.trackingDomainStatus === "verified" ? `https://${sender.trackingDomainName}/` : null;
  const copy = warmupEmail({ recipientFirstName: recipient.firstName, senderFirstName: sender.firstName, tag, custom: await workspaceCustomCopy(sender.workspaceId), link });
  const messageId = newMessageId(sender.email);
  const days = Math.max(0, (Date.now() - (sender.warmupStartedAt?.getTime() ?? Date.now())) / 86_400_000);
  await db.insert(schema.warmupMessages).values({
    senderAccountId: sender.id,
    recipientAccountId: recipient.id,
    messageId,
    subject: copy.subject,
    tag,
    sentAt: new Date(),
  });
  try {
    await driverFor(sender).send({
      from: { name: `${sender.firstName} ${sender.lastName}`.trim(), address: sender.email },
      to: [{ name: `${recipient.firstName} ${recipient.lastName}`.trim(), address: recipient.email }],
      subject: copy.subject,
      text: copy.text,
      html: copy.html,
      messageId,
      sandbox: { spamChance: Math.max(0.02, 0.3 - 0.02 * days) },
    });
  } catch (err) {
    await db.delete(schema.warmupMessages).where(eq(schema.warmupMessages.messageId, messageId));
    // A failure on the sender's side counts against its health, and login problems, limits and refusals take it out of sending.
    await noteSendFailure(sender, asMailError(err));
    throw err;
  }
  await bumpAccountStat(sender.workspaceId, sender.id, "warmupSent");
  await noteSendSuccess(sender);
}

/** Today's warmup emails per mailbox (replies included) against its daily target. */
type Quota = { sent: Map<string, number>; target: Map<string, number> };
const atLimit = (q: Quota, id: string) => (q.sent.get(id) ?? 0) >= (q.target.get(id) ?? 0);

/**
 * A mailbox that can't send warmup right now, new emails or replies: on a weekend with "weekdays only", or, for a real
 * mailbox, outside WARMUP_HOURS on its workspace clock (sandbox mailboxes send at any hour, so demos show activity).
 */
function restingNow(a: AccountRow, zone: string, now: number) {
  const clock = clockAt(zone, now);
  if (clock.weekend && a.warmup?.advanced?.weekday_only) return true;
  return !isSandbox(a) && (clock.hour < WARMUP_HOURS.from || clock.hour >= WARMUP_HOURS.to);
}

/** A reply that failed to send is tried again this much later; one owed for over a day is let go. */
const REPLY_RETRY_MS = 30 * 60_000;
const REPLY_GIVE_UP_MS = 24 * 3_600_000;

/** Sends the replies that are due; returns the mailboxes whose sending failed, which send nothing more this pass. */
async function sendDueReplies(pool: AccountRow[], quota: Quota, resting: Set<string>, now: number): Promise<Set<string>> {
  const members = new Map(pool.map((a) => [a.id, a]));
  const W = schema.warmupMessages;
  // A reply is a warmup email like any other: a mailbox at today's limit, or outside its warmup hours or days, replies
  // later, and its replies stay owed.
  const waiting = pool.filter((a) => atLimit(quota, a.id) || resting.has(a.id)).map((a) => a.id);
  const due = await db
    .select()
    .from(W)
    .where(and(isNotNull(W.replyDueAt), lte(W.replyDueAt, new Date(now)), eq(W.replied, false), waiting.length ? notInArray(W.recipientAccountId, waiting) : undefined))
    .orderBy(asc(W.replyDueAt))
    .limit(25);
  const failed = new Set<string>();
  for (const wm of due) {
    const replier = members.get(wm.recipientAccountId);
    // Its day was used up earlier in this pass, or it just failed to send: later.
    if (replier && (atLimit(quota, replier.id) || failed.has(replier.id))) continue;
    const original = members.get(wm.senderAccountId);
    // Let go: when either end has left the pool, they're in different worlds, the original's address isn't confirmed,
    // or the reply has been owed for over a day.
    const stale = now - (wm.processedAt ?? wm.sentAt).getTime() > REPLY_GIVE_UP_MS;
    if (!replier || !original || !sameWorld(replier, original) || !addressConfirmed(original) || stale) {
      await db.update(W).set({ replied: true, replyDueAt: null }).where(eq(W.id, wm.id));
      continue;
    }
    // Claimed, so only one pass sends it.
    const [claimed] = await db
      .update(W)
      .set({ replied: true, replyDueAt: null })
      .where(and(eq(W.id, wm.id), eq(W.replied, false)))
      .returning({ id: W.id });
    if (!claimed) continue;
    const tag = wm.tag;
    const body = warmupReply({ recipientFirstName: original.firstName, senderFirstName: replier.firstName, tag });
    const messageId = newMessageId(replier.email);
    await db.insert(schema.warmupMessages).values({
      senderAccountId: replier.id,
      recipientAccountId: original.id,
      messageId,
      inReplyTo: wm.messageId,
      subject: replySubject(wm.subject),
      tag,
      isReply: true,
      sentAt: new Date(),
    });
    try {
      await driverFor(replier).send({
        from: { name: `${replier.firstName} ${replier.lastName}`.trim(), address: replier.email },
        to: [{ name: `${original.firstName} ${original.lastName}`.trim(), address: original.email }],
        subject: replySubject(wm.subject),
        text: body.text,
        html: body.html,
        messageId,
        inReplyTo: wm.messageId,
        references: [wm.messageId],
        sandbox: { spamChance: 0.02 },
      });
    } catch (err) {
      await db.delete(schema.warmupMessages).where(eq(schema.warmupMessages.messageId, messageId));
      // Still owed: tried again in a while, not straight away (and the replier's other replies wait with it).
      await db
        .update(W)
        .set({ replied: false, replyDueAt: new Date(now + REPLY_RETRY_MS) })
        .where(eq(W.id, wm.id));
      failed.add(replier.id);
      await noteSendFailure(replier, asMailError(err));
      console.error(`[warmup] reply from ${replier.email} failed:`, (err as Error).message);
      continue;
    }
    await bumpAccountStat(replier.workspaceId, replier.id, "warmupSent");
    await bumpAccountStat(original.workspaceId, original.id, "warmupReplied");
    await noteSendSuccess(replier);
    quota.sent.set(replier.id, (quota.sent.get(replier.id) ?? 0) + 1);
  }
  return failed;
}

/**
 * Engine loop: owed replies go out first, then each mailbox in the pool sends at most one new warmup email per pass,
 * toward today's ramp target; replies count toward it too. Real mailboxes spread the day over WARMUP_HOURS on the
 * workspace clock and send nothing outside them; "weekdays only" skips weekends; sandbox mailboxes send at any hour.
 */
export async function runWarmup(now = Date.now()) {
  const pool = await warmupPool();
  const zones = await workspaceZones(pool.map((a) => a.workspaceId));
  const stats = await todayStats(pool, now);
  const quota: Quota = {
    sent: new Map(pool.map((a) => [a.id, stats.get(a.id)?.warmupSent ?? 0])),
    target: new Map(pool.map((a) => [a.id, warmupTarget(a.warmup ?? defaultWarmup(), stats.get(a.id)?.warmupDays ?? 0)])),
  };
  const resting = new Set(pool.filter((a) => restingNow(a, zones.get(a.workspaceId)!, now)).map((a) => a.id));
  const failed = await sendDueReplies(pool, quota, resting, now);
  for (const sender of pool) {
    if (resting.has(sender.id) || failed.has(sender.id)) continue;
    const clock = clockAt(zones.get(sender.workspaceId)!, now);
    const target = quota.target.get(sender.id)!;
    const sent = quota.sent.get(sender.id)!;
    const share = Math.max(0, Math.min(1, (clock.hour - WARMUP_HOURS.from) / (WARMUP_HOURS.to - WARMUP_HOURS.from)));
    const expected = isSandbox(sender) ? target : Math.ceil(target * share);
    if (sent >= expected || sent >= target) continue;
    const recipient = pickRecipient(sender, pool);
    if (!recipient) continue;
    try {
      await sendOne(sender, recipient);
      quota.sent.set(sender.id, sent + 1);
    } catch (err) {
      console.error(`[warmup] ${sender.email} → ${recipient.email} failed:`, (err as Error).message);
    }
  }
}

/** Engine loop: recompute warmup scores, expire undelivered pool messages, and re-test mailboxes whose sending failed. */
export async function updateWarmupScores() {
  const cutoff = new Date(Date.now() - 48 * 3_600_000);
  await db
    .update(schema.warmupMessages)
    .set({ folder: "missing", processedAt: new Date() })
    .where(and(isNull(schema.warmupMessages.processedAt), lte(schema.warmupMessages.sentAt, cutoff)));

  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db
    .select({
      sender: schema.warmupMessages.senderAccountId,
      inbox: sql<number>`sum(case when ${schema.warmupMessages.folder} = 'inbox' then 1 else 0 end)`,
      total: sql<number>`sum(case when ${schema.warmupMessages.folder} in ('inbox','spam','missing') then 1 else 0 end)`,
    })
    .from(schema.warmupMessages)
    .where(and(gte(schema.warmupMessages.sentAt, since), isNotNull(schema.warmupMessages.processedAt)))
    .groupBy(schema.warmupMessages.senderAccountId);
  for (const r of rows) {
    if (Number(r.total) < 3) continue;
    const score = (Number(r.inbox) / Number(r.total)) * 100;
    await db.update(A).set({ warmupScore: score }).where(eq(A.id, r.sender));
  }
  await recheckSendingFailures();
}

/** Warmup analytics for the accounts page (POST /accounts/warmup-analytics): the last `days` days on the workspace clock. */
export async function warmupAnalytics(accountIds: Array<{ id: string; email: string }>, days = 14, zone = "UTC") {
  const start = daysBefore(dayOn(zone), days - 1);
  const ids = accountIds.map((a) => a.id);
  const rows = ids.length
    ? await db
        .select()
        .from(schema.accountDailyStats)
        .where(and(inArray(schema.accountDailyStats.accountId, ids), gte(schema.accountDailyStats.date, start)))
    : [];
  const emailById = new Map(accountIds.map((a) => [a.id, a.email]));
  const email_date_data: Record<string, Record<string, { sent: number; landed_inbox: number; landed_spam: number; received: number; saved_from_spam: number; replied: number }>> = {};
  const aggregate_data: Record<string, { sent: number; landed_inbox: number; landed_spam: number; received: number; saved_from_spam: number; replied: number; health_score_label: string; health_score: number | null }> = {};
  for (const a of accountIds) {
    email_date_data[a.email] = {};
    aggregate_data[a.email] = { sent: 0, landed_inbox: 0, landed_spam: 0, received: 0, saved_from_spam: 0, replied: 0, health_score_label: "", health_score: null };
  }
  for (const r of rows) {
    const email = emailById.get(r.accountId)!;
    const d = { sent: r.warmupSent, landed_inbox: r.warmupInbox, landed_spam: r.warmupSpam, received: r.warmupReceived, saved_from_spam: r.warmupSavedFromSpam, replied: r.warmupReplied };
    email_date_data[email]![r.date] = d;
    const agg = aggregate_data[email]!;
    agg.sent += d.sent;
    agg.landed_inbox += d.landed_inbox;
    agg.landed_spam += d.landed_spam;
    agg.received += d.received;
    agg.saved_from_spam += d.saved_from_spam;
    agg.replied += d.replied;
  }
  for (const agg of Object.values(aggregate_data)) {
    const landed = agg.landed_inbox + agg.landed_spam;
    // Nothing landed yet, nothing to score: not a perfect 100.
    agg.health_score = landed ? Math.round((agg.landed_inbox / landed) * 100) : null;
    agg.health_score_label = landed ? `${agg.health_score}%` : "No data yet";
  }
  return { email_date_data, aggregate_data };
}

/** Ensures the account has warmup config and a start date when warmup is turned on. */
export async function enableWarmup(accountIds: string[]) {
  if (!accountIds.length) return;
  const rows = await db.select().from(A).where(inArray(A.id, accountIds));
  for (const a of rows) {
    await db
      .update(A)
      .set({ warmupStatus: WarmupStatus.ACTIVE, warmup: a.warmup ?? defaultWarmup(), warmupStartedAt: a.warmupStartedAt ?? new Date() })
      .where(eq(A.id, a.id));
  }
}

export async function disableWarmup(accountIds: string[]) {
  if (!accountIds.length) return;
  await db
    .update(A)
    .set({ warmupStatus: WarmupStatus.PAUSED })
    .where(and(inArray(A.id, accountIds), ne(A.warmupStatus, WarmupStatus.PERMANENT_SUSPENSION)));
}

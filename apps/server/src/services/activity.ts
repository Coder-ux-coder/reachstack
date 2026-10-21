// Lead activity: opens, clicks, replies, bounces, unsubscribes and interest changes.
// Every path records an analytics event, updates the lead, queues webhooks and emits a bus event.
import { and, desc, eq, inArray, isNull, lte, ne, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  EmailType,
  FREE_MAIL_DOMAINS,
  INTEREST_WEBHOOK_EVENT,
  LeadStatus,
  htmlToText,
  interestSentiment,
  snippet,
  type WebhookPayload,
} from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { isValidZone } from "../lib/time";
import { chunk } from "../http/util";
import { detectOptOut, isAbsenceNotice, newestReplyText, parseReturnDate, resumeAfterAbsence } from "../mail/reply-text";
import { bumpAccountStat } from "./accounts";
import { emit } from "./bus";
import { enqueueWebhooks } from "./webhooks";
import { workspaceZone } from "./workspace-clock";
import { getWorkspaceSetting } from "./workspaces";

export type LeadRow = typeof schema.leads.$inferSelect;
export type CampaignRow = typeof schema.campaigns.$inferSelect;
export type EmailRow = typeof schema.emails.$inferSelect;

export async function recordEvent(e: typeof schema.emailEvents.$inferInsert) {
  await db.insert(schema.emailEvents).values(e);
}

const nameCache = new Map<string, { name: string; at: number }>();
export async function campaignName(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const hit = nameCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.name;
  const [c] = await db.select({ name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.id, id)).limit(1);
  const [s] = c ? [] : await db.select({ name: schema.subsequences.name }).from(schema.subsequences).where(eq(schema.subsequences.id, id)).limit(1);
  const name = c?.name ?? s?.name ?? null;
  if (name) nameCache.set(id, { name, at: Date.now() });
  return name;
}

export function uniboxUrl(leadEmail: string | null | undefined) {
  return leadEmail ? `${config.webUrl}/app/unibox?search=${encodeURIComponent(leadEmail)}` : `${config.webUrl}/app/unibox`;
}

/** The lead's fields for a webhook: its own variables first, so a column named "lead_email" never replaces the real one. */
async function leadPayload(lead: LeadRow | null): Promise<Partial<WebhookPayload>> {
  if (!lead) return {};
  return {
    ...(lead.payload ?? {}),
    lead_email: lead.email,
    firstName: lead.firstName,
    lastName: lead.lastName,
    companyName: lead.companyName,
    website: lead.website,
    phone: lead.phone,
    jobTitle: lead.jobTitle,
    personalization: lead.personalization,
    lead_id: lead.id,
  };
}

/** A webhook's lead and campaign fields (every lead event carries them). */
export async function basePayload(lead: LeadRow | null, campaignId: string | null | undefined, accountEmail?: string | null) {
  return {
    ...(await leadPayload(lead)),
    campaign_id: campaignId ?? null,
    campaign_name: await campaignName(campaignId),
    email_account: accountEmail ?? null,
    unibox_url: uniboxUrl(lead?.email),
  };
}

export async function getLead(id: string | null | undefined): Promise<LeadRow | null> {
  if (!id) return null;
  const [l] = await db.select().from(schema.leads).where(eq(schema.leads.id, id)).limit(1);
  return l ?? null;
}

export interface TrackContext {
  workspaceId: string;
  leadId: string | null;
  campaignId: string | null;
  subsequenceId?: string | null;
  emailId?: string | null;
  accountId?: string | null;
  accountEmail?: string | null;
  step?: number | null;
  variant?: number | null;
  ip?: string;
  userAgent?: string;
}

/**
 * Counts an open or a click on the lead in one statement, so two arriving together can't both be its first: the step
 * and variant are kept from the first one only. Whether this was the first comes back.
 */
async function countActivity(leadId: string, kind: "open" | "click", step: number | null, variant: number | null): Promise<boolean> {
  const L = schema.leads;
  const now = new Date();
  // In an UPDATE every expression reads the row as it was: a count of 0 there means none before this one.
  const firstOr = (count: SQLWrapper, value: number | null, kept: SQLWrapper) => sql<number | null>`case when ${count} = 0 then ${value} else ${kept} end`;
  const set =
    kind === "open"
      ? { openCount: sql<number>`${L.openCount} + 1`, lastOpenAt: now, openedStep: firstOr(L.openCount, step, L.openedStep), openedVariant: firstOr(L.openCount, variant, L.openedVariant) }
      : { clickCount: sql<number>`${L.clickCount} + 1`, lastClickAt: now, clickedStep: firstOr(L.clickCount, step, L.clickedStep), clickedVariant: firstOr(L.clickCount, variant, L.clickedVariant) };
  const [row] = await db
    .update(L)
    .set({ ...set, lastTouchAt: now })
    .where(eq(L.id, leadId))
    .returning({ opens: L.openCount, clicks: L.clickCount });
  return (kind === "open" ? row?.opens : row?.clicks) === 1;
}

export async function handleOpen(t: TrackContext) {
  const lead = await getLead(t.leadId);
  const isFirst = lead ? await countActivity(lead.id, "open", t.step ?? null, t.variant ?? null) : false;
  await recordEvent({
    workspaceId: t.workspaceId,
    type: "open",
    campaignId: t.campaignId,
    subsequenceId: t.subsequenceId ?? null,
    leadId: t.leadId,
    leadEmail: lead?.email ?? null,
    accountId: t.accountId ?? null,
    accountEmail: t.accountEmail ?? null,
    emailId: t.emailId ?? null,
    step: t.step ?? null,
    variant: t.variant ?? null,
    ip: t.ip,
    userAgent: t.userAgent,
    isFirst,
  });
  await enqueueWebhooks(
    t.workspaceId,
    "email_opened",
    { ...(await basePayload(lead, t.campaignId, t.accountEmail)), step: (t.step ?? 0) + 1, variant: t.variant ?? null, is_first: isFirst, email_id: t.emailId ?? null },
    { campaignId: t.campaignId },
  );
  emit("email_opened", t.workspaceId, { lead_id: t.leadId, campaign_id: t.campaignId, subsequence_id: t.subsequenceId, step: t.step, is_first: isFirst });
}

export async function handleClick(t: TrackContext & { url: string }) {
  const lead = await getLead(t.leadId);
  const isFirst = lead ? await countActivity(lead.id, "click", t.step ?? null, t.variant ?? null) : false;
  await recordEvent({
    workspaceId: t.workspaceId,
    type: "click",
    campaignId: t.campaignId,
    subsequenceId: t.subsequenceId ?? null,
    leadId: t.leadId,
    leadEmail: lead?.email ?? null,
    accountId: t.accountId ?? null,
    accountEmail: t.accountEmail ?? null,
    emailId: t.emailId ?? null,
    step: t.step ?? null,
    variant: t.variant ?? null,
    url: t.url.slice(0, 2000),
    ip: t.ip,
    userAgent: t.userAgent,
    isFirst,
  });
  await enqueueWebhooks(
    t.workspaceId,
    "email_link_clicked",
    { ...(await basePayload(lead, t.campaignId, t.accountEmail)), step: (t.step ?? 0) + 1, variant: t.variant ?? null, is_first: isFirst, link: t.url },
    { campaignId: t.campaignId },
  );
  emit("email_link_clicked", t.workspaceId, { lead_id: t.leadId, campaign_id: t.campaignId, subsequence_id: t.subsequenceId, step: t.step, url: t.url });
}

/** Still being emailed, or paused: in the main sequence or in a subsequence. */
const GOING = [LeadStatus.ACTIVE, LeadStatus.PAUSED];
export const stillGoing = () => or(inArray(schema.leads.status, GOING), inArray(schema.leads.subseqStatus, GOING))!;

/** Stops sending to leads (completed), in the main sequence and in any subsequence, paused or not. */
export async function completeLeads(where: SQL) {
  await db
    .update(schema.leads)
    .set({ status: LeadStatus.COMPLETED, nextSendAt: null, completedAt: new Date() })
    .where(and(where, inArray(schema.leads.status, GOING)));
  await db
    .update(schema.leads)
    .set({ subseqStatus: LeadStatus.COMPLETED, subseqNextSendAt: null })
    .where(and(where, inArray(schema.leads.subseqStatus, GOING)));
}

/** Stop sending to a lead (status completed), in the main sequence and in any subsequence. */
export const stopLead = (leadId: string) => completeLeads(eq(schema.leads.id, leadId));

/** Pauses leads' emails, in the main sequence and in a subsequence. */
export async function pauseLeads(where: SQL) {
  await db.update(schema.leads).set({ status: LeadStatus.PAUSED }).where(and(where, eq(schema.leads.status, LeadStatus.ACTIVE)));
  await db.update(schema.leads).set({ subseqStatus: LeadStatus.PAUSED }).where(and(where, eq(schema.leads.subseqStatus, LeadStatus.ACTIVE)));
}

/** Paused leads carry on where they were. */
export async function resumeLeads(where: SQL) {
  await db.update(schema.leads).set({ status: LeadStatus.ACTIVE }).where(and(where, eq(schema.leads.status, LeadStatus.PAUSED)));
  await db.update(schema.leads).set({ subseqStatus: LeadStatus.ACTIVE }).where(and(where, eq(schema.leads.subseqStatus, LeadStatus.PAUSED)));
}

/** A lead that bounced or unsubscribed: its subsequence (running or paused) ends the same way, so nothing more goes out. */
export const endSubsequence = (status: number) =>
  sql<number>`case when ${schema.leads.subseqStatus} in (${LeadStatus.ACTIVE}, ${LeadStatus.PAUSED}) then ${status} else ${schema.leads.subseqStatus} end`;

/** "Stop a lead in every campaign when they reply to one": on unless the workspace turned it off. */
export const stopsInEveryCampaign = (settings: Record<string, unknown> | null | undefined) => settings?.stop_campaign_on_lead_reply_from_any_campaign !== false;

/** The timezone the lead's emails go out in: the lead's own when sending on each lead's clock, else the campaign schedule's, else the workspace default. */
async function sendingTimezone(workspaceId: string, campaign: CampaignRow | undefined, lead: LeadRow): Promise<string> {
  const tz = campaign?.schedule?.lead_timezone && lead.timezone ? lead.timezone : campaign?.schedule?.schedules?.[0]?.timezone;
  if (tz && isValidZone(tz)) return tz;
  return workspaceZone(workspaceId);
}

/**
 * Out of office: the person's emails wait until `resumeAt`, in every campaign and subsequence where the address is
 * still being emailed. Nothing is stopped; sending carries on by itself afterwards.
 */
async function pauseForAbsence(workspaceId: string, lead: LeadRow, resumeAt: Date) {
  const L = schema.leads;
  const at = resumeAt.getTime();
  const who = lead.email ? and(eq(L.workspaceId, workspaceId), eq(L.email, lead.email)) : eq(L.id, lead.id);
  await db
    .update(L)
    .set({ nextSendAt: sql`max(coalesce(${L.nextSendAt}, 0), ${at})` })
    .where(and(who, eq(L.status, LeadStatus.ACTIVE)));
  await db
    .update(L)
    .set({ subseqNextSendAt: sql`max(coalesce(${L.subseqNextSendAt}, 0), ${at})` })
    .where(and(who, eq(L.subseqStatus, LeadStatus.ACTIVE)));
}

/** When a reply was written, at the latest: its Date header (whole seconds, a clock a little off) or when it arrived. */
const writtenBy = (reply: EmailRow) => new Date(Math.min(reply.timestampEmail.getTime() + 5_000, reply.createdAt.getTime()));

/**
 * The campaign email a reply answers: the one it names, else the newest one the lead got before replying (some mail
 * apps drop the headers that name it, and a reply linked to a lead by hand has none), so it counts for the right step,
 * variant and subsequence.
 */
async function answeredEmail(lead: LeadRow, reply: EmailRow, repliedTo: EmailRow | null): Promise<EmailRow | null> {
  if (repliedTo?.step != null) return repliedTo;
  if (!lead.email) return repliedTo;
  const M = schema.emails;
  const [last] = await db
    .select()
    .from(M)
    .where(and(eq(M.workspaceId, lead.workspaceId), eq(M.leadEmail, lead.email), eq(M.ueType, EmailType.CAMPAIGN_SENT), lte(M.timestampEmail, writtenBy(reply))))
    .orderBy(desc(M.timestampEmail))
    .limit(1);
  return last ?? repliedTo;
}

export async function handleReply(input: {
  workspaceId: string;
  lead: LeadRow;
  email: EmailRow;
  repliedTo: EmailRow | null;
  isAutoReply: boolean;
  accountId: string | null;
  accountEmail: string;
  /** The lead wrote it; false when someone else on the thread did (a colleague copied in, an assistant). Default true. */
  byLead?: boolean;
}) {
  const { lead, email, repliedTo, isAutoReply } = input;
  const campaignId = lead.campaignId;
  const [campaign] = campaignId ? await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1) : [];
  const answered = await answeredEmail(lead, email, repliedTo);
  const step = answered?.step != null ? Number(answered.step) : lead.nextStep > 0 ? lead.nextStep - 1 : 0;
  const variant = answered?.variant ?? null;
  // A reply to a campaign email counts for the campaign, even from a lead that has moved into a subsequence since.
  const subsequenceId = answered?.step != null ? (answered.subsequenceId ?? null) : lead.subsequenceId;
  // What the person wrote this time: no quoted history (our own email) and no signature.
  const latest = newestReplyText(email.bodyText || htmlToText(email.bodyHtml));
  const optOut = detectOptOut(email.subject, latest);
  const byLead = input.byLead !== false;
  const writer = (email.fromAddress ?? "").toLowerCase();
  // An opt-out unsubscribes whoever asked: the lead, or the other person on the thread (not the lead on their behalf).
  const address = byLead ? (lead.email ?? writer) : writer;

  // A bare unsubscribe email (a List-Unsubscribe mailto, or "Unsubscribe" with nothing else) isn't a conversation:
  // it unsubscribes the address and counts as nothing more.
  if (optOut === "request") {
    if (address) await handleUnsubscribe({ workspaceId: input.workspaceId, email: address, campaignId, subsequenceId, source: "header", leadId: byLead ? lead.id : null });
    return;
  }

  const isFirst = !isAutoReply && lead.replyCount === 0;

  if (!isAutoReply) {
    await db
      .update(schema.leads)
      .set({
        replyCount: sql`${schema.leads.replyCount} + 1`,
        lastReplyAt: email.timestampEmail,
        lastTouchAt: new Date(),
        ...(isFirst ? { repliedStep: step, repliedVariant: variant } : {}),
      })
      .where(eq(schema.leads.id, lead.id));
  } else {
    await db.update(schema.leads).set({ lastTouchAt: new Date() }).where(eq(schema.leads.id, lead.id));
  }

  // Out of office: unless the campaign stops on automatic replies, the emails wait until the day after the person
  // is back (a week when the notice gives no date, 30 days at most), then carry on.
  let absence: { returnDate: string | null; resumeAt: Date | null } | null = null;
  let detail: string | null = null;
  if (isAutoReply && !byLead) {
    // Someone else's automatic reply on the thread (a colleague copied in) says nothing about the lead: no pause, no
    // stop and no "Out of office" label.
  } else if (isAutoReply) {
    const stops = !!campaign?.stopOnAutoReply;
    if (isAbsenceNotice(email.subject, latest)) {
      const tz = await sendingTimezone(input.workspaceId, campaign, lead);
      const returnDate = parseReturnDate(latest, email.timestampEmail, tz) ?? (isAbsenceNotice(email.subject, "") ? parseReturnDate(email.subject, email.timestampEmail, tz) : null);
      const resumeAt = stops ? null : resumeAfterAbsence(returnDate, new Date(), tz);
      if (resumeAt) await pauseForAbsence(input.workspaceId, lead, resumeAt);
      absence = { returnDate, resumeAt };
      const day = (d: DateTime) => d.toFormat("d LLL yyyy");
      const away = returnDate ? `Out of office until ${day(DateTime.fromISO(returnDate))}.` : "Out of office, no return date given.";
      detail = resumeAt ? `${away} Emails resume ${day(DateTime.fromJSDate(resumeAt).setZone(tz))}.` : `${away} The campaign stops on automatic replies.`;
    }
    if (stops) await stopLead(lead.id);
  } else if (campaign ? campaign.stopOnReply !== false : true) {
    await stopLead(lead.id);
  }

  if (!isAutoReply && campaign?.stopForCompany && lead.companyDomain && !FREE_MAIL_DOMAINS.has(lead.companyDomain)) {
    const others = await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(and(eq(schema.leads.campaignId, campaign.id), eq(schema.leads.companyDomain, lead.companyDomain), ne(schema.leads.id, lead.id), stillGoing()));
    for (const o of others) await stopLead(o.id);
  }

  // The same person in other campaigns (or their subsequences) stops too, unless the workspace turned that off or
  // that campaign is set to keep sending after a reply; so does someone else on the thread who wrote, in theirs.
  const people = [...new Set([lead.email, byLead ? null : writer].filter((e): e is string => !!e))];
  if (!isAutoReply && people.length) {
    const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId)).limit(1);
    if (stopsInEveryCampaign(ws?.settings)) {
      const L = schema.leads;
      const same = await db
        .select({ id: L.id })
        .from(L)
        .leftJoin(schema.campaigns, eq(schema.campaigns.id, L.campaignId))
        .where(
          and(
            eq(L.workspaceId, input.workspaceId),
            inArray(L.email, people),
            ne(L.id, lead.id),
            stillGoing(),
            or(isNull(schema.campaigns.stopOnReply), ne(schema.campaigns.stopOnReply, false)),
          ),
        );
      for (const o of same) await stopLead(o.id);
    }
  }

  await recordEvent({
    workspaceId: input.workspaceId,
    type: isAutoReply ? "auto_reply" : "reply",
    campaignId,
    subsequenceId,
    leadId: lead.id,
    leadEmail: lead.email,
    accountId: input.accountId,
    accountEmail: input.accountEmail,
    emailId: email.id,
    step,
    variant,
    isFirst,
    detail,
  });
  // "Please take me off your list": the reply counts as a reply, and the address is unsubscribed (and blocked, when
  // the workspace adds unsubscribes to the blocklist) before anything else reacts to it.
  const optedOut = !isAutoReply && optOut === "reply" && !!address;
  if (optedOut) await handleUnsubscribe({ workspaceId: input.workspaceId, email: address, campaignId, subsequenceId, source: "reply", leadId: byLead ? lead.id : null });
  if (input.accountId && !isAutoReply) await bumpAccountStat(input.workspaceId, input.accountId, "replies");

  const payload: Partial<WebhookPayload> = {
    ...(await basePayload(lead, campaignId, input.accountEmail)),
    step: step + 1,
    variant,
    is_first: isFirst,
    email_id: email.id,
    reply_subject: email.subject,
    reply_text: email.bodyText,
    reply_html: email.bodyHtml,
    reply_text_snippet: snippet(email.bodyText || email.bodyHtml, 300),
    email_subject: repliedTo?.subject ?? null,
    email_html: repliedTo?.bodyHtml ?? null,
    email_text: repliedTo?.bodyText ?? null,
  };
  await enqueueWebhooks(input.workspaceId, isAutoReply ? "auto_reply_received" : "reply_received", payload, { campaignId });
  emit(isAutoReply ? "auto_reply_received" : "reply_received", input.workspaceId, {
    lead_id: lead.id,
    lead_email: lead.email,
    campaign_id: campaignId,
    subsequence_id: lead.subsequenceId,
    email_id: email.id,
    thread_id: email.threadId,
    account_id: input.accountId,
    account_email: input.accountEmail,
    text: email.bodyText,
    /** Only what the person wrote this time: phrase triggers and keyword labels read this, not our quoted email. */
    latest_text: latest,
    subject: email.subject,
    is_first: isFirst,
    /** The lead asked to be taken off the list (someone else on the thread asking is about them, not the lead). */
    opted_out: optedOut && byLead,
    out_of_office: absence ? { return_date: absence.returnDate, resume_at: absence.resumeAt?.toISOString() ?? null } : null,
  });
}

export async function handleBounce(input: {
  workspaceId: string;
  lead: LeadRow | null;
  campaignId: string | null;
  accountId: string | null;
  accountEmail: string | null;
  emailId?: string | null;
  subsequenceId?: string | null;
  step?: number | null;
  variant?: number | null;
  hard: boolean;
  diagnostic?: string | null;
  /** The enhanced status code, e.g. 5.1.1. */
  status?: string | null;
}) {
  const { lead } = input;
  if (lead && input.hard) {
    await db
      .update(schema.leads)
      .set({ status: LeadStatus.BOUNCED, nextSendAt: null, subseqStatus: endSubsequence(LeadStatus.BOUNCED), subseqNextSendAt: null, lastTouchAt: new Date() })
      .where(eq(schema.leads.id, lead.id));
    // The address doesn't work, so the same person waiting in other campaigns, or in a subsequence, isn't emailed either,
    // nor when they're added again later.
    if (lead.email) {
      await suppressAddress(input.workspaceId, lead.email, "bounced");
      const sameAddress = and(eq(schema.leads.workspaceId, input.workspaceId), eq(schema.leads.email, lead.email));
      await db
        .update(schema.leads)
        .set({ status: LeadStatus.BOUNCED, nextSendAt: null, subseqNextSendAt: null })
        .where(and(sameAddress, inArray(schema.leads.status, GOING)));
      await db
        .update(schema.leads)
        .set({ subseqStatus: LeadStatus.BOUNCED, subseqNextSendAt: null })
        .where(and(sameAddress, inArray(schema.leads.subseqStatus, GOING)));
    }
  }
  const detail = [input.status, input.diagnostic?.replace(/\s+/g, " ").trim()].filter(Boolean).join(" · ").slice(0, 500) || null;
  await recordEvent({
    workspaceId: input.workspaceId,
    type: "bounce",
    campaignId: input.campaignId,
    leadId: lead?.id ?? null,
    leadEmail: lead?.email ?? null,
    accountId: input.accountId,
    accountEmail: input.accountEmail,
    emailId: input.emailId ?? null,
    subsequenceId: input.subsequenceId ?? null,
    step: input.step ?? null,
    variant: input.variant ?? null,
    value: input.hard ? 1 : 0,
    detail,
  });
  // Only hard bounces say something about the mailbox's list quality; a full inbox elsewhere doesn't.
  if (input.accountId && input.hard) await bumpAccountStat(input.workspaceId, input.accountId, "bounced");
  await enqueueWebhooks(
    input.workspaceId,
    "email_bounced",
    { ...(await basePayload(lead, input.campaignId, input.accountEmail)), step: (input.step ?? 0) + 1, bounce_type: input.hard ? "hard" : "soft", diagnostic: input.diagnostic ?? null },
    { campaignId: input.campaignId },
  );
  emit("email_bounced", input.workspaceId, { lead_id: lead?.id, campaign_id: input.campaignId, account_id: input.accountId, hard: input.hard });
}

/** `subsequenceId`: the subsequence whose email led to it, so its analytics count it. */
export async function handleUnsubscribe(input: { workspaceId: string; email: string; campaignId?: string | null; subsequenceId?: string | null; source: string; leadId?: string | null }) {
  const email = input.email.trim().toLowerCase();
  await db.insert(schema.unsubscribes).values({ workspaceId: input.workspaceId, email, campaignId: input.campaignId ?? null, source: input.source }).onConflictDoNothing();
  const [ws] = await db.select({ addUnsubToBlock: schema.workspaces.addUnsubToBlock }).from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId)).limit(1);
  if (ws?.addUnsubToBlock !== false) {
    await db.insert(schema.blockList).values({ workspaceId: input.workspaceId, value: email, isDomain: false, source: "unsubscribe" }).onConflictDoNothing();
  }
  const affected = await db
    .update(schema.leads)
    .set({ status: LeadStatus.UNSUBSCRIBED, nextSendAt: null, subseqNextSendAt: null, lastTouchAt: new Date() })
    .where(and(eq(schema.leads.workspaceId, input.workspaceId), eq(schema.leads.email, email), inArray(schema.leads.status, [LeadStatus.ACTIVE, LeadStatus.PAUSED, LeadStatus.COMPLETED])))
    .returning({ id: schema.leads.id, campaignId: schema.leads.campaignId });
  // Subsequences too, whatever the lead's own status.
  await db
    .update(schema.leads)
    .set({ subseqStatus: LeadStatus.UNSUBSCRIBED, subseqNextSendAt: null })
    .where(and(eq(schema.leads.workspaceId, input.workspaceId), eq(schema.leads.email, email), inArray(schema.leads.subseqStatus, GOING)));
  const lead = input.leadId ? await getLead(input.leadId) : affected[0] ? await getLead(affected[0].id) : null;
  await recordEvent({
    workspaceId: input.workspaceId,
    type: "unsubscribe",
    campaignId: input.campaignId ?? lead?.campaignId ?? null,
    subsequenceId: input.subsequenceId ?? null,
    leadId: lead?.id ?? null,
    leadEmail: email,
  });
  await enqueueWebhooks(input.workspaceId, "lead_unsubscribed", { ...(await basePayload(lead, input.campaignId ?? lead?.campaignId)), lead_email: email, source: input.source }, {
    campaignId: input.campaignId ?? lead?.campaignId ?? null,
  });
  emit("lead_unsubscribed", input.workspaceId, { email, lead_id: lead?.id, campaign_id: input.campaignId ?? lead?.campaignId });
}

/**
 * Remembers an address the workspace mustn't email again, whatever happens to its leads: one that hard-bounced (by any
 * campaign), or one that asked `campaignId` to stop (by that campaign). Deleting the lead, or its campaign, and adding
 * it again undoes neither.
 */
export async function suppressAddress(workspaceId: string, email: string, reason: "bounced" | "unsubscribed", campaignId = "") {
  await db.insert(schema.leadSuppressions).values({ workspaceId, email: email.trim().toLowerCase(), reason, campaignId }).onConflictDoNothing();
}

/** Why a campaign mustn't email an address: it hard-bounced, or it asked this campaign to stop. Null when neither. */
export async function suppressedFor(workspaceId: string, email: string, campaignId: string): Promise<"bounced" | "unsubscribed" | null> {
  const S = schema.leadSuppressions;
  const rows = await db
    .select({ reason: S.reason })
    .from(S)
    .where(and(eq(S.workspaceId, workspaceId), eq(S.email, email.trim().toLowerCase()), or(eq(S.reason, "bounced"), and(eq(S.reason, "unsubscribed"), eq(S.campaignId, campaignId)))));
  if (rows.some((r) => r.reason === "bounced")) return "bounced";
  return rows.length ? "unsubscribed" : null;
}

/** Stops one campaign (and its subsequences) for an address without unsubscribing it from the workspace. */
export async function unsubscribeFromCampaign(input: { workspaceId: string; email: string; campaignId: string; subsequenceId?: string | null; leadId?: string | null }) {
  const email = input.email.trim().toLowerCase();
  await suppressAddress(input.workspaceId, email, "unsubscribed", input.campaignId);
  const affected = await db
    .update(schema.leads)
    .set({ status: LeadStatus.UNSUBSCRIBED, nextSendAt: null, subseqNextSendAt: null, lastTouchAt: new Date() })
    .where(
      and(
        eq(schema.leads.workspaceId, input.workspaceId),
        eq(schema.leads.campaignId, input.campaignId),
        eq(schema.leads.email, email),
        inArray(schema.leads.status, [LeadStatus.ACTIVE, LeadStatus.PAUSED, LeadStatus.COMPLETED]),
      ),
    )
    .returning({ id: schema.leads.id });
  await db
    .update(schema.leads)
    .set({ subseqStatus: LeadStatus.UNSUBSCRIBED, subseqNextSendAt: null })
    .where(and(eq(schema.leads.workspaceId, input.workspaceId), eq(schema.leads.campaignId, input.campaignId), eq(schema.leads.email, email), inArray(schema.leads.subseqStatus, GOING)));
  const lead = input.leadId ? await getLead(input.leadId) : affected[0] ? await getLead(affected[0].id) : null;
  await recordEvent({ workspaceId: input.workspaceId, type: "unsubscribe", campaignId: input.campaignId, subsequenceId: input.subsequenceId ?? null, leadId: lead?.id ?? null, leadEmail: email });
  await enqueueWebhooks(input.workspaceId, "lead_unsubscribed", { ...(await basePayload(lead, input.campaignId)), lead_email: email, source: "campaign" }, { campaignId: input.campaignId });
  emit("lead_unsubscribed", input.workspaceId, { email, lead_id: lead?.id, campaign_id: input.campaignId });
}

/**
 * Sets the interest status (lead label) for leads; fires opportunity + status webhooks. Any number of leads, a few
 * hundred at a time.
 */
export async function setInterestStatus(input: {
  workspaceId: string;
  leadIds: string[];
  value: number | null;
  userId?: string | null;
  source?: "user" | "ai" | "api" | "automation";
}) {
  if (!input.leadIds.length) return 0;
  const L = schema.leads;
  const E = schema.emailEvents;
  const source = input.source ?? "user";
  const positive = interestSentiment(input.value) === "positive";
  const builtIn = input.value !== null ? INTEREST_WEBHOOK_EVENT[input.value] : undefined;
  const hooked = (await db.select({ id: schema.webhooks.id }).from(schema.webhooks).where(and(eq(schema.webhooks.workspaceId, input.workspaceId), eq(schema.webhooks.status, 1))).limit(1)).length > 0;
  // What a new opportunity is worth: its campaign's value, else the workspace's.
  const worth = new Map<string, number>();
  const worthOf = async (campaignId: string | null) => {
    const key = campaignId ?? "";
    if (!worth.has(key)) {
      const [c] = campaignId ? await db.select({ plValue: schema.campaigns.plValue }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)) : [];
      const [ws] = c?.plValue != null ? [] : await db.select({ v: schema.workspaces.defaultOpportunityValue }).from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId));
      worth.set(key, Math.round(c?.plValue ?? ws?.v ?? 0));
    }
    return worth.get(key)!;
  };
  const emails = new Set<string>();
  let changed = 0;
  for (const part of chunk(input.leadIds, 500)) {
    const leads = await db.select().from(L).where(and(eq(L.workspaceId, input.workspaceId), inArray(L.id, part)));
    for (const l of leads) if (l.email) emails.add(l.email);
    const moving = leads.filter((l) => l.interestStatus !== input.value);
    if (!moving.length) continue;
    changed += moving.length;
    await db.update(L).set({ interestStatus: input.value, interestSynced: false, lastInterestChangeAt: new Date() }).where(inArray(L.id, moving.map((l) => l.id)));
    // A lead's value counts once in the pipeline: turning positive again is an opportunity with no value of its own.
    const opening = positive ? moving.filter((l) => interestSentiment(l.interestStatus) !== "positive") : [];
    const earlier = new Set(
      opening.length
        ? (await db.select({ leadId: E.leadId }).from(E).where(and(inArray(E.leadId, opening.map((l) => l.id)), eq(E.type, "opportunity")))).map((r) => r.leadId)
        : [],
    );
    const events: Array<typeof E.$inferInsert> = [];
    for (const lead of moving) {
      const about = { workspaceId: input.workspaceId, campaignId: lead.campaignId, leadId: lead.id, leadEmail: lead.email };
      events.push({ ...about, type: "interest_change", value: input.value });
      if (opening.includes(lead)) events.push({ ...about, type: "opportunity", value: earlier.has(lead.id) ? 0 : await worthOf(lead.campaignId) });
    }
    for (const rows of chunk(events, 200)) await db.insert(E).values(rows);
    for (const lead of moving) {
      if (hooked) {
        const payload = { ...(await basePayload({ ...lead, interestStatus: input.value }, lead.campaignId)), interest_status: input.value, previous_interest_status: lead.interestStatus, source };
        if (builtIn) await enqueueWebhooks(input.workspaceId, builtIn, payload, { campaignId: lead.campaignId });
        else if (input.value === null) await enqueueWebhooks(input.workspaceId, "lead_neutral", payload, { campaignId: lead.campaignId });
        // Lost and custom labels have no event of their own: "all events" webhooks hear of them as lead_interest_changed.
        if (input.value !== null) await enqueueWebhooks(input.workspaceId, "lead_interest_changed", payload, { campaignId: lead.campaignId, interestValue: input.value, allEvents: !builtIn });
      }
      emit("lead_interest_changed", input.workspaceId, {
        lead_id: lead.id,
        lead_email: lead.email,
        campaign_id: lead.campaignId,
        value: input.value,
        previous: lead.interestStatus,
        source,
      });
    }
  }
  // Global lead status sync: the same address in other campaigns and lists follows the change, quietly (no extra
  // opportunities or webhooks, and analytics don't count it again), unless the workspace turned it off in Preferences.
  // The leads changed above already have the new status, so the sync passes them by.
  const sync = !(await getWorkspaceSetting(input.workspaceId, "disable_global_lead_status_sync", false));
  for (const part of chunk([...emails], 500)) {
    if (sync) {
      await db
        .update(L)
        .set({ interestStatus: input.value, interestSynced: input.value !== null, lastInterestChangeAt: new Date() })
        .where(
          and(
            eq(L.workspaceId, input.workspaceId),
            inArray(L.email, part),
            input.value === null ? sql`${L.interestStatus} is not null` : sql`(${L.interestStatus} is null or ${L.interestStatus} != ${input.value})`,
          ),
        );
    }
    // Keep Unibox thread labels in sync.
    await db
      .update(schema.emails)
      .set({ interestStatus: input.value })
      .where(and(eq(schema.emails.workspaceId, input.workspaceId), inArray(schema.emails.leadEmail, part)));
  }
  return changed;
}

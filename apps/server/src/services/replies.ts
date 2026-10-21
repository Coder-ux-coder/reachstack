// Reply safety: the last look before a follow-up goes out, and replies that arrived without a lead (written from
// another address, forwarded, a colleague answering) linked to one by hand, so that lead's emails stop.
import { and, desc, eq, gt, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { CampaignStatus, EmailType, FREE_MAIL_DOMAINS, LeadStatus, domainOf, isValidEmailSyntax } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { badRequest, conflict, notFound } from "../http/errors";
import { uuidv7 } from "../lib/ids";
import { campaignName, handleReply, stopLead, stopsInEveryCampaign, type CampaignRow, type EmailRow, type LeadRow } from "./activity";
import { emit } from "./bus";

const E = schema.emails;
const L = schema.leads;

// ---------- Just before sending ----------

/**
 * True when the email must not go out now. The lead is read again (this sending pass may have loaded it before a
 * reply stopped it or an out-of-office notice pushed it back). Before a follow-up, a reply from the address since the
 * last email also stops the lead here: the same way the reply would have, had it been filed in time.
 */
export async function holdSend(kind: "campaign" | "subsequence", campaign: CampaignRow, lead: LeadRow, settings: Record<string, unknown>): Promise<boolean> {
  const [now] = await db.select().from(L).where(eq(L.id, lead.id)).limit(1);
  if (!now) return true;
  // Still the same email: the lead hasn't been moved to another campaign or sent back to an earlier step meanwhile.
  const due =
    kind === "campaign"
      ? now.status === LeadStatus.ACTIVE && now.campaignId === lead.campaignId && now.nextStep === lead.nextStep && (now.nextSendAt ?? 0) <= Date.now()
      : now.subseqStatus === LeadStatus.ACTIVE &&
        now.status !== LeadStatus.BOUNCED &&
        now.status !== LeadStatus.UNSUBSCRIBED &&
        now.subsequenceId === lead.subsequenceId &&
        now.subseqNextStep === lead.subseqNextStep &&
        (now.subseqNextSendAt ?? 0) <= Date.now();
  if (!due) return true;
  // Paused or deleted since this pass loaded the campaign (or the subsequence).
  const [live] = await db.select({ status: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, campaign.id)).limit(1);
  if (live?.status !== CampaignStatus.ACTIVE && live?.status !== CampaignStatus.RUNNING_SUBSEQUENCES) return true;
  if (kind === "subsequence") {
    const [sub] = await db.select({ status: schema.subsequences.status }).from(schema.subsequences).where(eq(schema.subsequences.id, now.subsequenceId!)).limit(1);
    if (sub?.status !== CampaignStatus.ACTIVE) return true;
  }
  // Nothing sent yet (a first email), or the campaign keeps writing after replies on purpose.
  const lastSent = kind === "campaign" ? now.lastContactAt : [now.lastContactAt, now.addedSubsequenceAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  if (!lastSent || !now.email || campaign.stopOnReply === false) return false;
  const replies = await db
    .select({ leadId: E.leadId, campaignId: E.campaignId })
    .from(E)
    .where(
      and(
        eq(E.workspaceId, campaign.workspaceId),
        eq(E.leadEmail, now.email),
        eq(E.ueType, EmailType.RECEIVED),
        eq(E.isAutoReply, 0),
        eq(E.isBounce, false),
        // Filed after the last email, by our clock: the Date a sender's mail app writes can run ahead.
        gt(E.createdAt, lastSent),
      ),
    )
    .limit(20);
  if (!replies.length) return false;
  const here = replies.some((r) => r.leadId === lead.id || r.campaignId === campaign.id);
  if (!here && !stopsInEveryCampaign(settings)) return false;
  await stopLead(lead.id);
  return true;
}

// ---------- Replies without a lead ----------

export interface LeadSuggestion {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  list_id: string | null;
  status: number;
  /** Why it's suggested: the same address, someone on the thread, copied on the reply, the subject we sent from this mailbox, the same company, or a search match. */
  reason: "same_address" | "same_thread" | "copied" | "same_subject" | "same_company" | "search";
}

/** A received email (not a bounce notice) in the workspace. */
export async function receivedEmail(workspaceId: string, emailId: string): Promise<EmailRow> {
  const [e] = await db
    .select()
    .from(E)
    .where(and(eq(E.id, emailId), eq(E.workspaceId, workspaceId), isNull(E.deletedAt)))
    .limit(1);
  if (!e) throw notFound("Email");
  if (e.ueType !== EmailType.RECEIVED || e.isBounce) throw badRequest("Only a reply someone wrote can be linked to a lead");
  return e;
}

const addresses = (list: string | null | undefined) =>
  (list ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.includes("@"));

const bareSubject = (s: string) => s.replace(/^\s*((re|aw|sv|vs|antw|rif|r|odp|ref|res|tr|fw|fwd|wg)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();

/** Leads this reply probably belongs to, best guesses first; with `q`, leads matching the search instead. */
export async function leadSuggestions(workspaceId: string, email: EmailRow, q?: string): Promise<LeadSuggestion[]> {
  const found: Array<{ lead: LeadRow; reason: LeadSuggestion["reason"] }> = [];
  const add = (rows: LeadRow[], reason: LeadSuggestion["reason"]) => {
    for (const lead of rows) if (!found.some((f) => f.lead.id === lead.id)) found.push({ lead, reason });
  };
  const ws = eq(L.workspaceId, workspaceId);
  const recent = desc(sql`coalesce(${L.lastContactAt}, ${L.createdAt})`);
  const term = q?.trim().toLowerCase();
  if (term) {
    const p = `%${term.replace(/[%_]/g, "")}%`;
    add(
      await db
        .select()
        .from(L)
        .where(and(ws, isNotNull(L.email), or(like(L.email, p), like(sql`lower(coalesce(${L.firstName}, '') || ' ' || coalesce(${L.lastName}, ''))`, p), like(sql`lower(coalesce(${L.companyName}, ''))`, p))))
        .orderBy(recent)
        .limit(20),
      "search",
    );
  } else {
    const from = (email.fromAddress ?? "").toLowerCase();
    if (from) add(await db.select().from(L).where(and(ws, eq(L.email, from))).orderBy(recent).limit(5), "same_address");
    if (email.threadId) {
      const onThread = await db
        .selectDistinct({ id: E.leadId })
        .from(E)
        .where(and(eq(E.workspaceId, workspaceId), eq(E.threadId, email.threadId), isNotNull(E.leadId)))
        .limit(5);
      const ids = onThread.map((r) => r.id).filter((x): x is string => !!x);
      if (ids.length) add(await db.select().from(L).where(and(ws, inArray(L.id, ids))), "same_thread");
    }
    const ours = (email.eaccount ?? "").toLowerCase();
    const copied = [...addresses(email.toList), ...addresses(email.ccList)].filter((a) => a !== from && a !== ours);
    if (copied.length) add(await db.select().from(L).where(and(ws, inArray(L.email, copied.slice(0, 50)))).orderBy(recent).limit(10), "copied");
    const subject = bareSubject(email.subject);
    if (subject && email.accountId) {
      add(await db.select().from(L).where(and(ws, eq(L.senderAccountId, email.accountId), sql`lower(${L.lastSubject}) = ${subject.toLowerCase()}`)).orderBy(recent).limit(10), "same_subject");
    }
    const domain = domainOf(from);
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) add(await db.select().from(L).where(and(ws, eq(L.companyDomain, domain))).orderBy(recent).limit(10), "same_company");
  }
  const out: LeadSuggestion[] = [];
  for (const { lead, reason } of found.slice(0, 20)) {
    out.push({
      id: lead.id,
      email: lead.email,
      first_name: lead.firstName,
      last_name: lead.lastName,
      company_name: lead.companyName,
      campaign_id: lead.campaignId,
      campaign_name: await campaignName(lead.campaignId),
      list_id: lead.listId,
      status: lead.status,
      reason,
    });
  }
  return out;
}

/**
 * Files the reply's conversation under the lead: the reply and the rest of that thread's unlinked emails join the
 * lead's thread, then the reply counts as the lead's reply (their emails stop, labels and agents react).
 */
async function linkReply(workspaceId: string, email: EmailRow, lead: LeadRow) {
  const threadId = lead.threadId ?? email.threadId ?? uuidv7();
  if (!lead.threadId) await db.update(L).set({ threadId }).where(eq(L.id, lead.id));
  const unlinked = email.threadId ? and(eq(E.workspaceId, workspaceId), eq(E.threadId, email.threadId), isNull(E.leadId)) : eq(E.id, email.id);
  await db
    .update(E)
    .set({
      threadId,
      leadId: lead.id,
      leadEmail: lead.email ?? email.leadEmail,
      campaignId: lead.campaignId,
      subsequenceId: lead.subsequenceId,
      listId: lead.listId,
      interestStatus: lead.interestStatus,
      // Automatic replies stay under "Others".
      isFocused: sql`case when ${E.isAutoReply} = 1 then 0 else 1 end`,
    })
    .where(unlinked!);
  const [linked] = await db.select().from(E).where(eq(E.id, email.id)).limit(1);
  const [fresh] = await db.select().from(L).where(eq(L.id, lead.id)).limit(1);
  await handleReply({
    workspaceId,
    lead: fresh ?? lead,
    email: linked ?? email,
    repliedTo: null,
    isAutoReply: !!email.isAutoReply,
    accountId: email.accountId,
    accountEmail: email.eaccount,
  });
  return { email: linked ?? email, lead: (await db.select().from(L).where(eq(L.id, lead.id)).limit(1))[0] ?? lead };
}

/** Links a reply that arrived without a lead to an existing lead. */
export async function attachReplyToLead(workspaceId: string, emailId: string, leadId: string) {
  const email = await receivedEmail(workspaceId, emailId);
  if (email.leadId) throw conflict("This reply is already linked to a lead");
  const [lead] = await db
    .select()
    .from(L)
    .where(and(eq(L.id, leadId), eq(L.workspaceId, workspaceId)))
    .limit(1);
  if (!lead) throw notFound("Lead");
  return linkReply(workspaceId, email, lead);
}

/**
 * Makes the sender of a reply that arrived without a lead a new lead in a campaign or list, linked to the reply. In
 * a campaign the new lead starts as completed: they wrote to you, so the sequence never begins for them.
 */
export async function createLeadFromReply(
  workspaceId: string,
  emailId: string,
  input: { campaignId?: string | null; listId?: string | null; firstName?: string | null; lastName?: string | null; companyName?: string | null },
  userId: string | null,
) {
  const email = await receivedEmail(workspaceId, emailId);
  if (email.leadId) throw conflict("This reply is already linked to a lead");
  if (!!input.campaignId === !!input.listId) throw badRequest("Pick a campaign or a list for the new lead");
  if (input.campaignId) {
    const [c] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.id, input.campaignId), eq(schema.campaigns.workspaceId, workspaceId))).limit(1);
    if (!c) throw notFound("Campaign");
  } else {
    const [l] = await db.select({ id: schema.leadLists.id }).from(schema.leadLists).where(and(eq(schema.leadLists.id, input.listId!), eq(schema.leadLists.workspaceId, workspaceId))).limit(1);
    if (!l) throw notFound("Lead list");
  }
  const address = (email.replyTo || email.fromAddress || "").trim().toLowerCase();
  if (!isValidEmailSyntax(address)) throw badRequest("The reply has no address to make a lead from");
  const [existing] = await db
    .select({ id: L.id })
    .from(L)
    .where(and(eq(L.workspaceId, workspaceId), eq(L.email, address), input.campaignId ? eq(L.campaignId, input.campaignId) : eq(L.listId, input.listId!)))
    .limit(1);
  if (existing) throw conflict(`${address} is already a lead there. Link the reply to that lead instead.`);
  // The name the sender's mail app shows, unless one was typed in.
  const shown = (email.fromJson?.[0]?.name ?? "").replace(/["']/g, "").trim();
  const [first, ...rest] = shown.includes("@") ? [] : shown.split(/\s+/).filter(Boolean);
  const now = new Date();
  const [lead] = await db
    .insert(L)
    .values({
      workspaceId,
      campaignId: input.campaignId ?? null,
      listId: input.listId ?? null,
      email: address,
      firstName: input.firstName?.trim() || first || null,
      lastName: input.lastName?.trim() || rest.join(" ") || null,
      companyName: input.companyName?.trim() || null,
      companyDomain: domainOf(address),
      status: input.campaignId ? LeadStatus.COMPLETED : LeadStatus.ACTIVE,
      completedAt: input.campaignId ? now : null,
      uploadMethod: "manual",
      uploadedByUser: userId,
      assignedTo: userId,
    })
    .returning();
  emit("lead_added", workspaceId, { campaign_id: input.campaignId ?? null, list_id: input.listId ?? null, lead_ids: [lead!.id], count: 1, verify: false });
  return linkReply(workspaceId, email, lead!);
}

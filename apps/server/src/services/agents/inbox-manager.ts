// AI Inbox Manager: answers prospects' replies for the campaigns and mailboxes it covers. It sorts each reply first
// (out-of-office notices, unsubscribe requests and automatic emails are left alone) and fills in the lead's status.
// In review mode every reply waits for approval; in autopilot, confident replies go out after a short human-like
// delay and the rest wait for review. Drafts that went stale (the lead wrote again, someone answered by hand) are
// discarded. It can also follow up when a prospect goes quiet and win back meeting no-shows.
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { AccountStatus, CUSTOM_TAG_RESOURCE, EmailType, InterestStatus, LeadStatus } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { config } from "../../env";
import { iso } from "../../lib/time";
import Anthropic from "@anthropic-ai/sdk";
import { setInterestStatus } from "../activity";
import { AiRefusalError, aiAvailable, aiErrorMessage } from "../ai";
import { chargeCredits, refundCredits, workspaceLimits } from "../billing-limits";
import { on } from "../bus";
import { inUse } from "../live-workspaces";
import { calendlyLink, postToSlack } from "../integrations";
import { resourcesWithTags } from "../tags";
import { composeAndSend, replyRecipients } from "../unibox";
import { dayOn, parseRange, startOfDayOn, startOfMonthOn, workspaceZone } from "../workspace-clock";
import { getWorkspaceSetting } from "../workspaces";
import { AgentStatus, AgentType, businessContext, conversationMovedOn, guidanceText, logAgentEvent, type AgentRow, type DiscardReason } from "./common";
import { recipientRefusal, type RecipientRefusal } from "./recipients";
import { draftReply, threadMessages } from "./reply-engine";
import { CATEGORY_STATUS, classifyIncoming, type ReplyClass } from "./reply-classifier";

export type { DiscardReason };

const R = schema.aiAgentReplies;
const E = schema.emails;
type ReplyRow = typeof R.$inferSelect;
type EmailRow = typeof E.$inferSelect;

export const JobType = { REPLY: 1, FOLLOWUP: 2, NO_SHOW: 3 } as const;
export const SendingStatus = { FAILED: -1, SENT: 1, SCHEDULED: 2 } as const;

export interface InboxManagerPayload {
  configuration_type: 1 | 2; // 1 = review every reply, 2 = autopilot
  tags?: string[];
  handle_followup?: boolean;
  respond_to_automatic_emails?: boolean;
  handle_objections?: boolean;
  integrations?: { slack?: { connection_id?: string; enabled?: boolean } | null; calendly?: { connection_id?: string } | null };
  no_show?: { enabled?: boolean; max_followups?: number; fallback_sending_accounts?: { accounts?: string[]; tag_ids?: string[] } };
  trigger_on_labels_enabled?: boolean;
  trigger_on_labels?: number[];
  trigger_on_labels_mode?: "include" | "exclude";
  monthly_credit_budget?: number | null;
  followup_business_days_only?: boolean;
  active_since?: string;
}

const AUTOPILOT_MIN_CONFIDENCE = 70;
/** Why a draft waits in review mode: routine approval, not a reply the agent couldn't handle. */
const REVIEW_MODE_REASON = "Review mode: approve before it is sent";
/** On autopilot, an answer to an older reply (a mailbox that synced late, say) waits for a person. */
const AUTOPILOT_MAX_AGE_HOURS = 48;
/** The agent fills in a lead's status from its own reading of the reply only when it's this sure. */
const LABEL_MIN_CONFIDENCE = 0.6;
const FOLLOWUP_AFTER_DAYS = [2, 4]; // days of silence before follow-up #1 and #2
const NO_SHOW_SPACING_DAYS = 2;
/** How long a pass's claim on an agent lasts unless it renews it; one cut short by a restart frees the agent after this. */
const PASS_CLAIM_MS = 5 * 60_000;
/** Why the agent left a conversation alone because of who it would write to (the activity feed says it). */
const REFUSAL_SKIP: Record<RecipientRefusal, string> = { blocked: "recipient_blocked", unsubscribed: "recipient_unsubscribed", bounced: "recipient_bounced" };
/** The error on a reply that wasn't sent for that reason. */
const REFUSAL_CODE: Record<RecipientRefusal, string> = { blocked: "RECIPIENT_BLOCKED", unsubscribed: "RECIPIENT_UNSUBSCRIBED", bounced: "RECIPIENT_BOUNCED" };

export const payloadOf = (a: AgentRow) => (a.payload ?? {}) as unknown as InboxManagerPayload;

const meta = (r: ReplyRow) => (r.usageMetadata ?? {}) as { classification?: ReplyClass; discarded?: DiscardReason };
/** A draft that needed a person for more than routine approval in review mode. */
const neededPerson = (r: ReplyRow) => r.requiresHitl && r.requiresHitlReason !== REVIEW_MODE_REASON;

export function serializeReply(r: ReplyRow) {
  return {
    id: r.id,
    organization_id: r.workspaceId,
    timestamp_created: iso(r.createdAt),
    timestamp_updated: iso(r.updatedAt),
    agent_id: r.agentId,
    thread_id: r.threadId,
    lead: r.leadEmail,
    feedback_positive: r.feedbackPositive,
    feedback_text: r.feedbackText,
    html: r.html,
    requires_hitl: r.requiresHitl,
    requires_hitl_reason: r.requiresHitlReason,
    generation_lag_seconds: r.generationLagSeconds,
    is_automatic_email: r.isAutomaticEmail,
    in_reply_to: r.inReplyToEmailId,
    usage_metadata: r.usageMetadata ?? {},
    calendly_tool_used: r.calendlyToolUsed,
    confidence_score: r.confidenceScore,
    information_requested: r.informationRequested,
    estimated_time_saved_seconds: r.estimatedTimeSavedSeconds,
    action_pending: r.actionPending,
    sending_status: r.sendingStatus,
    is_followup: r.isFollowup,
    error_code: r.errorCode ?? undefined,
    // Extra context for the review screen.
    subject: r.subject,
    account_email: r.accountEmail,
    lead_id: r.leadId,
    campaign_id: r.campaignId,
    job_type: r.jobType,
    followup_number: r.followupNumber,
    scheduled_send_at: iso(r.scheduledSendAt),
    sent_email_id: r.sentEmailId,
    /** How the agent read the lead's message: interested, out_of_office, unsubscribe… */
    classification: meta(r).classification ?? null,
    discarded_reason: meta(r).discarded ?? null,
  };
}

/** What an agent works on: null means any. Empty sets (tags that pick nothing) mean nothing. */
export interface AgentScope {
  accounts: Set<string> | null;
  campaigns: Set<string> | null;
}

/**
 * The "default" tag (or none) covers everything. Otherwise the agent's tags pick campaigns, mailboxes or both; with
 * both, a conversation must be in one of the tagged campaigns and reach one of the tagged mailboxes.
 */
export async function agentScope(a: AgentRow): Promise<AgentScope | "all"> {
  const tags = payloadOf(a).tags ?? ["default"];
  if (!tags.length || tags.includes("default")) return "all";
  const M = schema.customTagMappings;
  const rows = await db
    .select({ id: M.resourceId, type: M.resourceType })
    .from(M)
    .where(and(eq(M.workspaceId, a.workspaceId), inArray(M.tagId, tags)));
  const accounts = new Set(rows.filter((r) => r.type === CUSTOM_TAG_RESOURCE.ACCOUNT).map((r) => r.id));
  const campaigns = new Set(rows.filter((r) => r.type === CUSTOM_TAG_RESOURCE.CAMPAIGN).map((r) => r.id));
  return { accounts: accounts.size || !campaigns.size ? accounts : null, campaigns: campaigns.size ? campaigns : null };
}

export function inScope(scope: AgentScope | "all", e: { accountId: string | null; campaignId: string | null }): boolean {
  if (scope === "all") return true;
  if (scope.accounts && !(e.accountId && scope.accounts.has(e.accountId))) return false;
  if (scope.campaigns && !(e.campaignId && scope.campaigns.has(e.campaignId))) return false;
  return true;
}

function labelAllowed(p: InboxManagerPayload, status: number | null): boolean {
  if (!p.trigger_on_labels_enabled || !p.trigger_on_labels?.length) return true;
  const listed = status !== null && p.trigger_on_labels.includes(status);
  return (p.trigger_on_labels_mode ?? "include") === "include" ? listed : !listed;
}

/** Drafts this month, on the workspace clock. */
async function monthlyUsage(agentId: string, workspaceId: string): Promise<number> {
  const start = new Date(startOfMonthOn(await workspaceZone(workspaceId)));
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(R)
    .where(and(eq(R.agentId, agentId), gte(R.createdAt, start), sql`coalesce(${R.errorCode}, '') not in ('MONTHLY_BUDGET_EXCEEDED', 'OUT_OF_CREDITS')`));
  return Number(row?.n ?? 0);
}

const skip = (a: AgentRow, emailId: string, reason: string) => logAgentEvent(a.workspaceId, a.id, "reply_skipped", { email_id: emailId, reason });

const timeSaved = (html: string) => 90 + Math.round(html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length * 2.5);

/** Generates (or records why it could not generate) one reply row. */
async function generate(
  a: AgentRow,
  opts: { original: EmailRow; lead: typeof schema.leads.$inferSelect; jobType: number; followupNumber?: number; daysSinceLast?: number; classification?: ReplyClass },
): Promise<ReplyRow | null> {
  const p = payloadOf(a);
  const { original, lead } = opts;
  const base = {
    workspaceId: a.workspaceId,
    agentId: a.id,
    threadId: original.threadId,
    inReplyToEmailId: original.id,
    leadEmail: lead.email,
    leadId: lead.id,
    campaignId: original.campaignId,
    accountId: original.accountId,
    accountEmail: original.eaccount,
    subject: original.subject,
    jobType: opts.jobType,
    isFollowup: opts.jobType !== JobType.REPLY,
    followupNumber: opts.followupNumber ?? null,
    isAutomaticEmail: !!original.isAutoReply,
  };
  const fail = async (errorCode: string) => {
    const [row] = await db.insert(R).values({ ...base, sendingStatus: SendingStatus.FAILED, actionPending: true, errorCode }).returning();
    return row!;
  };
  if (p.monthly_credit_budget != null && (await monthlyUsage(a.id, a.workspaceId)) >= p.monthly_credit_budget) return fail("MONTHLY_BUDGET_EXCEEDED");
  const metered = !(await workspaceLimits(a.workspaceId)).self_hosted;
  if (metered && !(await chargeCredits(a.workspaceId, 1, "ai_agent:reply", { refId: a.id }))) return fail("OUT_OF_CREDITS");
  const [account] = original.accountId ? await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, original.accountId)).limit(1) : [];
  const started = Date.now();
  const draft = await draftReply({
    workspaceId: a.workspaceId,
    feature: "inbox_manager",
    agentName: a.name,
    guidance: await guidanceText(a.id),
    context: await businessContext(a.workspaceId),
    bookingLink: await calendlyLink(a.workspaceId, p.integrations?.calendly?.connection_id),
    extraInstructions: p.handle_objections ? "If the prospect declines, you may address the objection once, briefly and respectfully." : "If the prospect declines, do not try to change their mind.",
    thread: await threadMessages(original.threadId, original.id),
    lead: { first_name: lead.firstName, last_name: lead.lastName, company_name: lead.companyName, job_title: lead.jobTitle, email: lead.email, interest_status: lead.interestStatus },
    sender: { name: account ? `${account.firstName} ${account.lastName}`.trim() || account.email : original.eaccount, email: account?.email ?? original.eaccount },
    mode: opts.jobType === JobType.FOLLOWUP ? { kind: "followup", number: opts.followupNumber ?? 1, daysSinceLast: opts.daysSinceLast ?? 2 } : opts.jobType === JobType.NO_SHOW ? { kind: "no_show", number: opts.followupNumber ?? 1 } : { kind: "reply" },
  }).catch(async (err) => {
    // Nothing was written (the AI failed or declined): the credit goes back.
    if (metered) await refundCredits(a.workspaceId, 1, "ai_agent:reply_refund", { refId: a.id });
    throw err;
  });
  if (draft.decision === "no_reply") {
    await skip(a, original.id, "agent_chose_not_to_reply");
    return null;
  }
  const autopilot = p.configuration_type === 2;
  const ageHours = (Date.now() - original.timestampEmail.getTime()) / 3_600_000;
  // What would stop autopilot sending this; in review mode it's shown instead of the routine reason.
  const concern =
    draft.decision === "request_info"
      ? "The agent needs information to answer"
      : draft.needsHuman
        ? (draft.humanReason ?? "Needs a person")
        : draft.confidence < AUTOPILOT_MIN_CONFIDENCE
          ? `Low confidence (${draft.confidence})`
          : opts.jobType === JobType.REPLY && ageHours > AUTOPILOT_MAX_AGE_HOURS
            ? `The lead wrote ${Math.floor(ageHours / 24)} days ago, so check the answer still fits`
            : null;
  const review = concern ?? (autopilot ? null : REVIEW_MODE_REASON);
  const sendAt = new Date(Date.now() + (60 + Math.floor(Math.random() * 180)) * 1000);
  const [row] = await db
    .insert(R)
    .values({
      ...base,
      html: draft.html,
      confidenceScore: draft.confidence,
      requiresHitl: !!review,
      requiresHitlReason: review,
      informationRequested: draft.informationRequested,
      calendlyToolUsed: draft.usedBookingLink,
      sendingStatus: SendingStatus.SCHEDULED,
      actionPending: !!review,
      scheduledSendAt: review ? null : sendAt,
      generationLagSeconds: Math.round((Date.now() - original.timestampEmail.getTime()) / 100) / 10,
      estimatedTimeSavedSeconds: timeSaved(draft.html),
      usageMetadata: { generation_ms: Date.now() - started, decision: draft.decision, ...(opts.classification ? { classification: opts.classification } : {}) },
    })
    .returning();
  if (review && p.integrations?.slack?.enabled !== false && p.integrations?.slack?.connection_id) {
    await postToSlack(a.workspaceId, p.integrations.slack.connection_id, `${a.name}: a reply to ${lead.email ?? "a lead"} needs review (${review}). ${config.webUrl}/app/ai-agents/${a.id}?tab=activity`);
  }
  return row!;
}

/**
 * Why a draft that hasn't gone out would now be wrong to send: the lead wrote again after the message it answers,
 * someone answered (or scheduled an answer) by hand, or the lead unsubscribed. Null while it still fits.
 */
export async function staleDraftReason(r: ReplyRow): Promise<DiscardReason | null> {
  if (r.sendingStatus === SendingStatus.SENT) return null;
  return conversationMovedOn(r.workspaceId, r.inReplyToEmailId, { leadId: r.leadId, ownEmailId: r.sentEmailId });
}

/** SQL for "not being sent right now" (see replyInFlight). */
export const notInFlight = () => sql`not (${R.sendingStatus} = ${SendingStatus.SCHEDULED} and ${R.actionPending} = 0 and ${R.scheduledSendAt} is null)`;

/**
 * Drops a draft without sending it. Not a failure: the overview's "Failed" count leaves these out. A reply someone is
 * sending is left to them (`sending` is that sender itself), so its own email going out never discards it.
 */
export async function discardDraft(r: ReplyRow, reason: DiscardReason, opts: { sending?: boolean } = {}): Promise<ReplyRow> {
  const [row] = await db
    .update(R)
    .set({ sendingStatus: SendingStatus.FAILED, errorCode: null, actionPending: false, scheduledSendAt: null, usageMetadata: { ...meta(r), discarded: reason } })
    .where(and(eq(R.id, r.id), ne(R.sendingStatus, SendingStatus.SENT), ...(opts.sending ? [] : [notInFlight()])))
    .returning();
  if (row && r.agentId) await logAgentEvent(r.workspaceId, r.agentId, "draft_discarded", { reply_id: r.id, lead_email: r.leadEmail, reason });
  return row ?? r;
}

/** Drafts still waiting (for review or their send time) that the conversation has moved past. */
async function discardStaleDrafts(a: AgentRow) {
  const waiting = await db
    .select()
    .from(R)
    .where(and(eq(R.agentId, a.id), eq(R.sendingStatus, SendingStatus.SCHEDULED)))
    .limit(200);
  for (const r of waiting) {
    const reason = await staleDraftReason(r);
    if (reason) await discardDraft(r, reason);
  }
}

/** A reply being sent right now: taken for sending (see sendReply) and not yet marked sent or failed. */
export const replyInFlight = (r: Pick<ReplyRow, "sendingStatus" | "actionPending" | "scheduledSendAt">) =>
  r.sendingStatus === SendingStatus.SCHEDULED && !r.actionPending && !r.scheduledSendAt;

/**
 * Sends a scheduled or approved reply through the thread's mailbox (or a fallback for no-show emails). It takes the
 * reply first, so the loop and an approval never both send it; when someone else has it, this returns it as it is.
 */
export async function sendReply(due: ReplyRow): Promise<ReplyRow> {
  const [r] = await db
    .update(R)
    .set({ scheduledSendAt: null })
    .where(and(eq(R.id, due.id), eq(R.sendingStatus, SendingStatus.SCHEDULED), isNotNull(R.scheduledSendAt)))
    .returning();
  if (!r) return (await db.select().from(R).where(eq(R.id, due.id)).limit(1))[0] ?? due;
  const fail = async (code: string) => {
    const [row] = await db.update(R).set({ sendingStatus: SendingStatus.FAILED, errorCode: code, actionPending: true }).where(eq(R.id, r.id)).returning();
    return row!;
  };
  // The conversation may have moved on since the draft was written.
  const stale = await staleDraftReason(r);
  if (stale) return discardDraft(r, stale, { sending: true });
  const [original] = r.inReplyToEmailId ? await db.select().from(E).where(eq(E.id, r.inReplyToEmailId)).limit(1) : [];
  if (!original) return fail("SEND_FAILED");
  const refusal = await recipientRefusal(r.workspaceId, [original.leadEmail, ...replyRecipients(original)], { campaignId: original.campaignId, unprompted: r.jobType !== JobType.REPLY });
  if (refusal) return fail(REFUSAL_CODE[refusal]);
  let accountId = r.accountId ?? original.accountId;
  let account: typeof schema.emailAccounts.$inferSelect | undefined = accountId ? (await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, accountId)).limit(1))[0] : undefined;
  if ((!account || account.status !== AccountStatus.ACTIVE) && r.jobType === JobType.NO_SHOW && r.agentId) {
    const [agent] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, r.agentId)).limit(1);
    const fb = agent ? payloadOf(agent).no_show?.fallback_sending_accounts : undefined;
    const tagged = fb?.tag_ids?.length ? await resourcesWithTags(r.workspaceId, fb.tag_ids, "any") : [];
    const candidates = await db.select().from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, r.workspaceId), eq(schema.emailAccounts.status, AccountStatus.ACTIVE)));
    account = candidates.find((c) => (fb?.accounts ?? []).map((x) => x.toLowerCase()).includes(c.email) || tagged.includes(c.id));
    accountId = account?.id ?? null;
  }
  if (!account) return fail("NO_SENDING_ACCOUNT");
  if (account.status !== AccountStatus.ACTIVE) return fail("ACCOUNT_INACTIVE");
  try {
    const sent = await composeAndSend({ workspaceId: r.workspaceId, account, original, kind: "reply", html: r.html ?? "", includeQuote: true });
    await db.update(E).set({ aiAgentId: r.agentId, aiAssisted: 1 }).where(eq(E.id, sent.id));
    const [row] = await db
      .update(R)
      .set({ sendingStatus: SendingStatus.SENT, sentEmailId: sent.id, actionPending: false, errorCode: null, accountId, accountEmail: account.email })
      .where(eq(R.id, r.id))
      .returning();
    return row!;
  } catch (err) {
    console.error(`[inbox-manager] send failed: ${(err as Error).message}`);
    return fail("SEND_FAILED");
  }
}

/**
 * Replies that reached the Unibox since the agent was switched on and that nobody (person or agent) has handled,
 * however late the mailbox delivered them (on autopilot, old ones wait for review: see generate).
 */
async function pendingReplies(a: AgentRow, scope: AgentScope | "all"): Promise<EmailRow[]> {
  const p = payloadOf(a);
  const since = Date.parse(p.active_since ?? "") || a.createdAt.getTime();
  // Other agents' conversations are left out here, so they can't crowd this agent's out of the batch.
  const within = (col: typeof E.accountId | typeof E.campaignId, ids: Set<string> | null) => (!ids ? undefined : !ids.size ? sql`0` : ids.size <= 500 ? inArray(col, [...ids]) : undefined);
  return db
    .select()
    .from(E)
    .where(
      and(
        eq(E.workspaceId, a.workspaceId),
        eq(E.ueType, EmailType.RECEIVED),
        eq(E.isBounce, false),
        sql`${E.leadId} is not null`,
        scope === "all" ? undefined : within(E.accountId, scope.accounts),
        scope === "all" ? undefined : within(E.campaignId, scope.campaigns),
        // When it was filed decides; the date it was written only keeps the query on its index.
        gt(E.timestampEmail, new Date(since - 30 * 86_400_000)),
        gt(E.createdAt, new Date(since)),
        lte(E.createdAt, new Date(Date.now() - 30_000)), // give reply labelling a moment first
        sql`not exists (select 1 from ai_agent_replies r where r.in_reply_to = ${E.id})`,
        sql`not exists (select 1 from ai_agent_events v where v.agent_id = ${a.id} and v.event_type = 'reply_skipped' and json_extract(v.payload, '$.email_id') = ${E.id})`,
        // A Sales Agent that's on and answers replies handles its own campaigns' (see salesAgentAnswers).
        sql`not exists (select 1 from campaigns c join ai_sales_agents s on s.id = c.ai_sdr_id where c.id = ${E.campaignId} and s.status = 1 and coalesce(json_extract(s.config, '$.autonomy_settings.auto_reply_to_responses'), 1) <> 0)`,
      ),
    )
    .orderBy(desc(E.timestampEmail))
    .limit(25);
}

async function salesAgentAnswers(campaignId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: schema.aiSalesAgents.status, config: schema.aiSalesAgents.config })
    .from(schema.campaigns)
    .innerJoin(schema.aiSalesAgents, eq(schema.aiSalesAgents.id, schema.campaigns.aiSdrId))
    .where(eq(schema.campaigns.id, campaignId))
    .limit(1);
  const autoReply = (row?.config as { autonomy_settings?: { auto_reply_to_responses?: boolean } } | undefined)?.autonomy_settings?.auto_reply_to_responses;
  return !!row && row.status === 1 && autoReply !== false;
}

/**
 * Fills in the lead's status from the agent's reading of the reply when nobody has set one yet (or it still says
 * "Out of office"), the reading is sure enough and the workspace lets the AI use that status. A person's label is
 * never replaced.
 */
async function labelFromReading(a: AgentRow, lead: typeof schema.leads.$inferSelect, reading: ReplyClass): Promise<number | null> {
  const code = CATEGORY_STATUS[reading.category];
  if (code === undefined || reading.confidence < LABEL_MIN_CONFIDENCE) return lead.interestStatus;
  if (lead.interestStatus !== null && lead.interestStatus !== InterestStatus.OUT_OF_OFFICE) return lead.interestStatus;
  const allowed = await getWorkspaceSetting<number[] | null>(a.workspaceId, "ai_label_codes", null);
  if (allowed && !allowed.includes(code)) return lead.interestStatus;
  if (lead.interestStatus !== code) await setInterestStatus({ workspaceId: a.workspaceId, leadIds: [lead.id], value: code, source: "ai" });
  return code;
}

async function handleIncoming(a: AgentRow, email: EmailRow, scope: AgentScope | "all", seenThreads: Set<string>) {
  const p = payloadOf(a);
  if (!inScope(scope, email)) return; // another agent's campaigns or mailboxes
  const threadKey = email.threadId ?? email.id;
  if (seenThreads.has(threadKey)) return skip(a, email.id, "superseded_by_newer_message");
  seenThreads.add(threadKey);
  const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, email.leadId!)).limit(1);
  if (!lead) return skip(a, email.id, "lead_missing");
  // An active AI Sales Agent answers the replies in its own campaigns.
  if (lead.campaignId && (await salesAgentAnswers(lead.campaignId))) return skip(a, email.id, "handled_by_sales_agent");
  // A person already answered after this message arrived.
  const [answered] = await db
    .select({ id: E.id })
    .from(E)
    .where(and(eq(E.workspaceId, a.workspaceId), email.threadId ? eq(E.threadId, email.threadId) : eq(E.leadId, lead.id), inArray(E.ueType, [EmailType.SENT, EmailType.SCHEDULED]), gt(E.timestampEmail, email.timestampEmail)))
    .limit(1);
  if (answered) return skip(a, email.id, "answered_by_person");
  if (lead.status === LeadStatus.UNSUBSCRIBED) return skip(a, email.id, "lead_unsubscribed");
  // Sort the message before writing anything: some are never answered.
  const reading = await classifyIncoming(a.workspaceId, email);
  if (reading.category === "unsubscribe") return skip(a, email.id, "unsubscribe_request");
  if (reading.category === "out_of_office") {
    await labelFromReading(a, lead, reading);
    return skip(a, email.id, "out_of_office");
  }
  if ((email.isAutoReply || reading.category === "automatic") && !p.respond_to_automatic_emails) return skip(a, email.id, "automatic_email");
  const status = await labelFromReading(a, lead, reading);
  const declined = status === InterestStatus.NOT_INTERESTED || status === InterestStatus.WRONG_PERSON || status === InterestStatus.LOST || reading.category === "not_interested" || reading.category === "wrong_person";
  if (declined && !p.handle_objections) return skip(a, email.id, "objection_handling_off");
  if (!labelAllowed(p, status)) return skip(a, email.id, "label_not_targeted");
  const refusal = await recipientRefusal(a.workspaceId, [lead.email, ...replyRecipients(email)], { campaignId: email.campaignId ?? lead.campaignId });
  if (refusal) return skip(a, email.id, REFUSAL_SKIP[refusal]);
  try {
    await generate(a, { original: email, lead: { ...lead, interestStatus: status }, jobType: JobType.REPLY, classification: reading });
  } catch (err) {
    if (err instanceof AiRefusalError) return skip(a, email.id, "model_declined");
    throw err;
  }
}

/** Key or model problems will not fix themselves: flag the agent instead of retrying every pass. */
const fatalAiError = (err: unknown) => err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError;

function businessDayOk(p: InboxManagerPayload, tz: string) {
  if (!p.followup_business_days_only) return true;
  const wd = DateTime.now().setZone(tz).weekday;
  return wd >= 1 && wd <= 5;
}

/**
 * Whether the agent already wrote in answer to this email (a draft counts, also one that was discarded or failed) or
 * decided not to: either way it isn't drafted (and paid for) again every pass.
 */
async function triedOn(a: AgentRow, emailId: string, since?: Date): Promise<boolean> {
  const [drafted] = await db
    .select({ id: R.id })
    .from(R)
    .where(and(eq(R.agentId, a.id), eq(R.inReplyToEmailId, emailId), since ? gte(R.createdAt, since) : undefined))
    .limit(1);
  if (drafted) return true;
  const AE = schema.aiAgentEvents;
  const [skipped] = await db
    .select({ id: AE.id })
    .from(AE)
    .where(and(eq(AE.agentId, a.id), eq(AE.eventType, "reply_skipped"), sql`json_extract(${AE.payload}, '$.email_id') = ${emailId}`, since ? gte(AE.createdAt, since) : undefined))
    .limit(1);
  return !!skipped;
}

/** Keeps the pass's claim on the agent while it works through its replies (see claimedPass). */
const holdClaim = (agentId: string) => db.update(schema.aiAgents).set({ runningUntil: new Date(Date.now() + PASS_CLAIM_MS) }).where(eq(schema.aiAgents.id, agentId));

/** Drafts what the agent writes unprompted; a model that declines to write it is noted, like a reply it declined. */
async function generateUnprompted(a: AgentRow, opts: Parameters<typeof generate>[1]) {
  await holdClaim(a.id);
  try {
    await generate(a, opts);
  } catch (err) {
    if (err instanceof AiRefusalError) await skip(a, opts.original.id, "model_declined");
    else throw err;
  }
}

/** Follow-ups after the agent's own sent replies when the prospect stays silent. */
async function followUps(a: AgentRow, tz: string, scope: AgentScope | "all") {
  const p = payloadOf(a);
  if (!p.handle_followup || !businessDayOk(p, tz)) return;
  const sent = await db
    .select()
    .from(R)
    .where(and(eq(R.agentId, a.id), eq(R.sendingStatus, SendingStatus.SENT), inArray(R.jobType, [JobType.REPLY, JobType.FOLLOWUP]), gte(R.updatedAt, new Date(Date.now() - 30 * 86_400_000))))
    .orderBy(desc(R.updatedAt))
    .limit(200);
  const latestByThread = new Map<string, ReplyRow>();
  for (const r of sent) if (r.threadId && !latestByThread.has(r.threadId)) latestByThread.set(r.threadId, r);
  for (const r of latestByThread.values()) {
    if (!inScope(scope, r)) continue;
    const number = r.jobType === JobType.FOLLOWUP ? (r.followupNumber ?? 1) + 1 : 1;
    if (number > FOLLOWUP_AFTER_DAYS.length) continue;
    const days = (Date.now() - r.updatedAt.getTime()) / 86_400_000;
    if (days < FOLLOWUP_AFTER_DAYS[number - 1]!) continue;
    const [pending] = await db.select({ id: R.id }).from(R).where(and(eq(R.threadId, r.threadId!), eq(R.agentId, a.id), eq(R.sendingStatus, SendingStatus.SCHEDULED))).limit(1);
    if (pending) continue;
    const [newer] = await db.select({ id: E.id }).from(E).where(and(eq(E.threadId, r.threadId!), eq(E.ueType, EmailType.RECEIVED), gt(E.timestampEmail, r.updatedAt))).limit(1);
    if (newer) continue; // they answered; the reply flow takes it from here
    const [sentEmail] = r.sentEmailId ? await db.select().from(E).where(eq(E.id, r.sentEmailId)).limit(1) : [];
    const [lead] = r.leadId ? await db.select().from(schema.leads).where(eq(schema.leads.id, r.leadId)).limit(1) : [];
    if (!sentEmail || !lead || lead.status === LeadStatus.UNSUBSCRIBED || (await triedOn(a, sentEmail.id))) continue;
    const refusal = await recipientRefusal(a.workspaceId, [lead.email, ...replyRecipients(sentEmail)], { campaignId: sentEmail.campaignId ?? lead.campaignId, unprompted: true });
    if (refusal) {
      await skip(a, sentEmail.id, REFUSAL_SKIP[refusal]);
      continue;
    }
    await generateUnprompted(a, { original: sentEmail, lead, jobType: JobType.FOLLOWUP, followupNumber: number, daysSinceLast: Math.floor(days) });
  }
}

/** Win-back emails after a lead is marked as a meeting no-show. */
async function noShows(a: AgentRow, scope: AgentScope | "all") {
  const p = payloadOf(a);
  if (!p.no_show?.enabled) return;
  const max = Math.max(1, Math.min(5, p.no_show.max_followups ?? 2));
  const open = await db
    .select()
    .from(schema.aiAgentEvents)
    .where(and(eq(schema.aiAgentEvents.agentId, a.id), eq(schema.aiAgentEvents.eventType, "no_show_detected"), gte(schema.aiAgentEvents.createdAt, new Date(Date.now() - 30 * 86_400_000))));
  for (const ev of open) {
    const leadId = ev.payload.lead_id as string;
    if (ev.payload.closed) continue;
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1);
    if (!lead || lead.interestStatus !== InterestStatus.NO_SHOW) continue;
    const done = await db.select().from(R).where(and(eq(R.agentId, a.id), eq(R.leadId, leadId), eq(R.jobType, JobType.NO_SHOW), gte(R.createdAt, ev.createdAt))).orderBy(desc(R.createdAt));
    if (done.length >= max || done.some((d) => d.sendingStatus === SendingStatus.SCHEDULED)) continue;
    const last = done[0]?.createdAt ?? ev.createdAt;
    if (done.length && Date.now() - last.getTime() < NO_SHOW_SPACING_DAYS * 86_400_000) continue;
    const [original] = await db.select().from(E).where(and(eq(E.workspaceId, a.workspaceId), eq(E.leadId, leadId))).orderBy(desc(E.timestampEmail)).limit(1);
    if (!original || !inScope(scope, { accountId: original.accountId, campaignId: original.campaignId ?? lead.campaignId })) continue;
    if (await triedOn(a, original.id, ev.createdAt)) continue;
    const refusal = await recipientRefusal(a.workspaceId, [lead.email, ...replyRecipients(original)], { campaignId: original.campaignId ?? lead.campaignId, unprompted: true });
    if (refusal) {
      await skip(a, original.id, REFUSAL_SKIP[refusal]);
      continue;
    }
    await generateUnprompted(a, { original, lead, jobType: JobType.NO_SHOW, followupNumber: done.length + 1 });
  }
}

/** Passes running in this process: "Run now" during a scheduled pass joins it instead of starting another. */
const passes = new Map<string, Promise<number | null>>();

/**
 * One pass of an agent: new replies, follow-ups, no-show win-backs. Returns how many replies it drafted, or null
 * when another server is running a pass for the agent right now.
 */
export function runInboxManager(a: AgentRow): Promise<number | null> {
  const running = passes.get(a.id);
  if (running) return running;
  const pass = claimedPass(a).finally(() => passes.delete(a.id));
  passes.set(a.id, pass);
  return pass;
}

async function claimedPass(a: AgentRow): Promise<number | null> {
  if (!(await aiAvailable(a.workspaceId))) return 0;
  const now = new Date();
  // Claimed in one statement, so a scheduled pass and "Run now" on another server never draft the same replies twice.
  const [claimed] = await db
    .update(schema.aiAgents)
    .set({ runningUntil: new Date(now.getTime() + PASS_CLAIM_MS) })
    .where(and(eq(schema.aiAgents.id, a.id), or(isNull(schema.aiAgents.runningUntil), lt(schema.aiAgents.runningUntil, now))))
    .returning({ id: schema.aiAgents.id });
  if (!claimed) return null;
  try {
    return await onePass(a);
  } finally {
    await db.update(schema.aiAgents).set({ runningUntil: null }).where(eq(schema.aiAgents.id, a.id));
  }
}

async function onePass(a: AgentRow): Promise<number> {
  const [{ n: before }] = (await db.select({ n: sql<number>`count(*)` }).from(R).where(eq(R.agentId, a.id))) as [{ n: number }];
  try {
    await discardStaleDrafts(a);
    const scope = await agentScope(a);
    const seen = new Set<string>();
    for (const email of await pendingReplies(a, scope)) {
      await holdClaim(a.id);
      await handleIncoming(a, email, scope, seen);
    }
    const tz = await workspaceZone(a.workspaceId);
    await followUps(a, tz, scope);
    await noShows(a, scope);
    await db.update(schema.aiAgents).set({ lastRunAt: new Date() }).where(eq(schema.aiAgents.id, a.id));
  } catch (err) {
    const message = aiErrorMessage(err);
    console.error(`[inbox-manager] ${a.id}: ${message}`);
    await logAgentEvent(a.workspaceId, a.id, "run_failed", { error: message });
    if (fatalAiError(err)) await db.update(schema.aiAgents).set({ status: AgentStatus.ERROR }).where(eq(schema.aiAgents.id, a.id));
  }
  const [{ n: after }] = (await db.select({ n: sql<number>`count(*)` }).from(R).where(eq(R.agentId, a.id))) as [{ n: number }];
  return Number(after) - Number(before);
}

export async function runInboxManagers() {
  // A send cut short by a restart goes back for review. If it did go out, the thread shows it and review discards it.
  await db
    .update(R)
    .set({ actionPending: true, requiresHitl: true, requiresHitlReason: "Sending was interrupted. Check the conversation before you approve it again." })
    .where(and(eq(R.sendingStatus, SendingStatus.SCHEDULED), eq(R.actionPending, false), isNull(R.scheduledSendAt), lt(R.updatedAt, new Date(Date.now() - 10 * 60_000))));
  const agents = await db
    .select()
    .from(schema.aiAgents)
    .where(and(eq(schema.aiAgents.type, AgentType.INBOX_MANAGER), eq(schema.aiAgents.status, AgentStatus.ACTIVE), await inUse(schema.aiAgents.workspaceId)));
  for (const a of agents) await runInboxManager(a);
  // Autopilot replies whose short delay has passed.
  const due = await db
    .select()
    .from(R)
    .where(and(eq(R.sendingStatus, SendingStatus.SCHEDULED), eq(R.actionPending, false), lte(R.scheduledSendAt, new Date()), await inUse(R.workspaceId)))
    .limit(50);
  for (const r of due) {
    const [agent] = r.agentId ? await db.select({ id: schema.aiAgents.id }).from(schema.aiAgents).where(eq(schema.aiAgents.id, r.agentId)).limit(1) : [];
    if (!agent) await db.update(R).set({ sendingStatus: SendingStatus.FAILED, errorCode: "AGENT_NOT_FOUND", actionPending: true }).where(eq(R.id, r.id));
    else await sendReply(r);
  }
}

/** Pausing an agent (or switching it to review mode) turns its not-yet-sent autopilot replies into drafts awaiting review. */
export async function holdScheduledReplies(agentId: string, why: "paused" | "review" = "paused") {
  await db
    .update(R)
    .set({ actionPending: true, requiresHitl: true, requiresHitlReason: why === "review" ? REVIEW_MODE_REASON : "The agent was paused before this reply was sent", scheduledSendAt: null })
    .where(and(eq(R.agentId, agentId), eq(R.sendingStatus, SendingStatus.SCHEDULED), eq(R.actionPending, false)));
}

// No-shows open a win-back; a reply or a new booking closes it as a recovery.
on("lead_interest_changed", async (ev) => {
  const leadId = ev.data.lead_id as string | undefined;
  if (!leadId) return;
  const agents = await db.select().from(schema.aiAgents).where(and(eq(schema.aiAgents.workspaceId, ev.workspaceId), eq(schema.aiAgents.type, AgentType.INBOX_MANAGER), eq(schema.aiAgents.status, AgentStatus.ACTIVE)));
  for (const a of agents) {
    if (!payloadOf(a).no_show?.enabled) continue;
    if (ev.data.value === InterestStatus.NO_SHOW) await logAgentEvent(ev.workspaceId, a.id, "no_show_detected", { lead_id: leadId, lead_email: ev.data.lead_email ?? null });
    else if (ev.data.value === InterestStatus.MEETING_BOOKED || ev.data.value === InterestStatus.MEETING_COMPLETED) await closeNoShow(a, leadId, ev.data.source === "calendly" ? "calendly_meeting" : "manual");
  }
});

on("reply_received", async (ev) => {
  const leadId = ev.data.lead_id as string | undefined;
  if (!leadId) return;
  const agents = await db.select().from(schema.aiAgents).where(and(eq(schema.aiAgents.workspaceId, ev.workspaceId), eq(schema.aiAgents.type, AgentType.INBOX_MANAGER)));
  for (const a of agents) await closeNoShow(a, leadId, "lead_reply");
});

async function closeNoShow(a: AgentRow, leadId: string, method: string) {
  const AE = schema.aiAgentEvents;
  const open = await db
    .select()
    .from(AE)
    .where(and(eq(AE.agentId, a.id), eq(AE.eventType, "no_show_detected"), sql`json_extract(${AE.payload}, '$.lead_id') = ${leadId}`, sql`json_extract(${AE.payload}, '$.closed') is null`));
  if (!open.length) return;
  const sentRecovery = await db.select({ id: R.id }).from(R).where(and(eq(R.agentId, a.id), eq(R.leadId, leadId), eq(R.jobType, JobType.NO_SHOW), eq(R.sendingStatus, SendingStatus.SENT))).limit(1);
  for (const ev of open) await db.update(AE).set({ payload: { ...ev.payload, closed: true } }).where(eq(AE.id, ev.id));
  if (!sentRecovery.length) return; // recovered without the agent's help
  await logAgentEvent(a.workspaceId, a.id, "recovery", { lead_id: leadId, lead_email: open[0]!.payload.lead_email ?? null, recovery_method: method, revenue_recovered: await leadValue(a.workspaceId, leadId) });
}

/** The lead's open deal value, else the workspace's default opportunity value. */
async function leadValue(workspaceId: string, leadId: string): Promise<number | null> {
  const O = schema.crmOpportunities;
  const [opp] = await db.select({ value: O.value }).from(O).where(and(eq(O.workspaceId, workspaceId), eq(O.leadId, leadId), isNull(O.archivedAt))).orderBy(desc(O.createdAt)).limit(1);
  if (opp) return opp.value;
  const [ws] = await db.select({ v: schema.workspaces.defaultOpportunityValue }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  return ws?.v ?? null;
}

// ---------- Analytics ----------

/** Whole days on the workspace clock from `from` to `to`; by default the last 30 days, today included. */
async function period(a: AgentRow, from?: string, to?: string) {
  const zone = await workspaceZone(a.workspaceId);
  const r = parseRange(from, to, zone);
  const end = new Date(r.end ?? Date.now());
  const start = new Date(r.start ?? startOfDayOn(zone, end.getTime() - 29 * 86_400_000));
  return { start, end, zone };
}

export async function inboxManagerSummary(a: AgentRow, from?: string, to?: string) {
  const { start, end } = await period(a, from, to);
  const rows = await db.select().from(R).where(and(eq(R.agentId, a.id), gte(R.createdAt, start), lte(R.createdAt, end)));
  const recoveries = await db
    .select()
    .from(schema.aiAgentEvents)
    .where(and(eq(schema.aiAgentEvents.agentId, a.id), eq(schema.aiAgentEvents.eventType, "recovery"), gte(schema.aiAgentEvents.createdAt, start), lte(schema.aiAgentEvents.createdAt, end)));
  const noShowRows = rows.filter((r) => r.jobType === JobType.NO_SHOW);
  const replies = rows.filter((r) => r.jobType === JobType.REPLY);
  const human = rows.filter(neededPerson).length;
  const scored = rows.filter((r) => r.confidenceScore !== null);
  const threads = new Set(rows.map((r) => r.threadId ?? r.id));
  // Involvement: threads the agent acted on among threads with a prospect reply in the window.
  const [{ n: replyThreads }] = (await db
    .select({ n: sql<number>`count(distinct coalesce(${E.threadId}, ${E.id}))` })
    .from(E)
    .where(and(eq(E.workspaceId, a.workspaceId), eq(E.ueType, EmailType.RECEIVED), gte(E.timestampEmail, start), lte(E.timestampEmail, end)))) as [{ n: number }];
  // Sent without needing a person beyond approving it; drafts dropped because the conversation moved on don't count.
  const handsFree = rows.filter((r) => r.sendingStatus === SendingStatus.SENT && !neededPerson(r)).length;
  const counted = rows.filter((r) => !meta(r).discarded).length;
  const noShowLeads = new Set(noShowRows.map((r) => r.leadId)).size;
  return {
    total_actions: rows.length,
    replies_count: replies.length,
    follow_ups_count: rows.filter((r) => r.jobType === JobType.FOLLOWUP).length,
    human_intervention: human,
    info_requested: rows.filter((r) => !!r.informationRequested).length,
    unique_conversations: threads.size,
    time_saved: rows.filter((r) => r.sendingStatus === SendingStatus.SENT).reduce((s, r) => s + (r.estimatedTimeSavedSeconds ?? 0), 0),
    average_confidence_score: scored.length ? Math.round(scored.reduce((s, r) => s + (r.confidenceScore ?? 0), 0) / scored.length) : 0,
    involvement_rate: Number(replyThreads) ? Math.min(100, Math.round((threads.size / Number(replyThreads)) * 100)) : 0,
    resolution_rate: counted ? Math.round((handsFree / counted) * 100) : 0,
    no_show_follow_ups_generated: noShowRows.length,
    no_show_total_leads_recovered: recoveries.length,
    no_show_total_revenue_recovered: recoveries.reduce((s, r) => s + (Number(r.payload.revenue_recovered) || 0), 0),
    no_show_time_saved: noShowRows.reduce((s, r) => s + (r.estimatedTimeSavedSeconds ?? 0), 0),
    no_show_recovery_rate: noShowLeads ? Math.round((recoveries.length / noShowLeads) * 100) : 0,
  };
}

export async function inboxManagerByDate(a: AgentRow, from?: string, to?: string) {
  const { start, end, zone } = await period(a, from, to);
  const rows = await db.select().from(R).where(and(eq(R.agentId, a.id), gte(R.createdAt, start), lte(R.createdAt, end)));
  const recoveries = await db
    .select()
    .from(schema.aiAgentEvents)
    .where(and(eq(schema.aiAgentEvents.agentId, a.id), eq(schema.aiAgentEvents.eventType, "recovery"), gte(schema.aiAgentEvents.createdAt, start), lte(schema.aiAgentEvents.createdAt, end)));
  // Each on the day it happened on the workspace clock.
  const byDay = <T extends { createdAt: Date }>(list: T[]) => {
    const out = new Map<string, T[]>();
    for (const r of list) {
      const key = dayOn(zone, r.createdAt);
      out.set(key, [...(out.get(key) ?? []), r]);
    }
    return out;
  };
  const replyDays = byDay(rows);
  const recoveryDays = byDay(recoveries);
  const out: Array<Record<string, unknown>> = [];
  for (let d = DateTime.fromJSDate(start, { zone }).startOf("day"); d.toMillis() <= end.getTime(); d = d.plus({ days: 1 })) {
    const key = d.toISODate()!;
    const day = replyDays.get(key) ?? [];
    out.push({
      date: key,
      total_actions: day.length,
      replies_count: day.filter((r) => r.jobType === JobType.REPLY).length,
      follow_ups_count: day.filter((r) => r.jobType === JobType.FOLLOWUP).length,
      human_intervention: day.filter(neededPerson).length,
      info_requested: day.filter((r) => !!r.informationRequested).length,
      unique_conversations: new Set(day.map((r) => r.threadId ?? r.id)).size,
      no_show_follow_ups_generated: day.filter((r) => r.jobType === JobType.NO_SHOW).length,
      no_show_total_leads_recovered: recoveryDays.get(key)?.length ?? 0,
    });
  }
  return out;
}

export async function inboxManagerActivity(a: AgentRow, q: { limit: number; startingAfter?: string; actionPending?: boolean; activityType?: string; jobType?: number }) {
  type Item = Record<string, unknown> & { id: string; timestamp_created: string };
  const items: Item[] = [];
  if (q.activityType !== "recovery") {
    const conds = [eq(R.agentId, a.id)];
    if (q.actionPending !== undefined) conds.push(eq(R.actionPending, q.actionPending));
    if (q.activityType === "reply") conds.push(eq(R.isFollowup, false));
    if (q.activityType === "followup") conds.push(eq(R.isFollowup, true));
    if (q.jobType) conds.push(eq(R.jobType, q.jobType));
    if (q.startingAfter) conds.push(sql`${R.id} < ${q.startingAfter}`);
    const rows = await db.select().from(R).where(and(...conds)).orderBy(desc(R.id)).limit(q.limit + 1);
    for (const r of rows) {
      items.push({
        id: r.id,
        timestamp_created: iso(r.createdAt)!,
        activity_type: r.isFollowup ? "followup" : "reply",
        job_type: r.jobType,
        lead_email: r.leadEmail ?? "",
        thread_id: r.threadId,
        requires_hitl: r.requiresHitl,
        action_pending: r.actionPending,
        sending_status: r.sendingStatus,
        error_code: r.errorCode,
        is_followup: r.isFollowup,
        followup_number: r.followupNumber,
        estimated_time_saved_seconds: r.estimatedTimeSavedSeconds,
        information_requested: r.informationRequested,
        recovery_method: null,
        revenue_recovered: null,
        classification: meta(r).classification?.category ?? null,
        discarded_reason: meta(r).discarded ?? null,
      });
    }
  }
  if ((q.activityType === undefined || q.activityType === "recovery") && q.actionPending === undefined && !q.jobType) {
    const AE = schema.aiAgentEvents;
    const conds = [eq(AE.agentId, a.id), eq(AE.eventType, "recovery")];
    if (q.startingAfter) conds.push(sql`${AE.id} < ${q.startingAfter}`);
    const rows = await db.select().from(AE).where(and(...conds)).orderBy(desc(AE.id)).limit(q.limit + 1);
    for (const r of rows) {
      items.push({
        id: r.id,
        timestamp_created: iso(r.createdAt)!,
        activity_type: "recovery",
        job_type: null,
        lead_email: String(r.payload.lead_email ?? ""),
        thread_id: null,
        requires_hitl: null,
        action_pending: null,
        sending_status: null,
        error_code: null,
        is_followup: null,
        followup_number: null,
        estimated_time_saved_seconds: null,
        information_requested: null,
        recovery_method: r.payload.recovery_method ?? null,
        revenue_recovered: r.payload.revenue_recovered ?? null,
        classification: null,
        discarded_reason: null,
      });
    }
  }
  items.sort((x, y) => (x.id < y.id ? 1 : -1));
  const page = items.slice(0, q.limit);
  const hasMore = items.length > q.limit;
  return { items: page, ...(hasMore ? { next_starting_after: page[page.length - 1]!.id } : {}), has_more: hasMore };
}

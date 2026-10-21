// Sending engine: picks due leads for active campaigns and subsequences, chooses a sending account and
// variant, renders the email, sends it and advances the lead.
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, lte, ne, notInArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  AccountStatus,
  CampaignNotSendingStatus,
  CampaignStatus,
  EmailType,
  EspCode,
  FREE_MAIL_DOMAINS,
  LeadStatus,
  ProviderCode,
  VerificationStatus,
  delayToMs,
  domainOf,
  emptyVariables,
  htmlToText,
  isReservedDomain,
  isTaskStep,
  leadVariables,
  renderTemplate,
  senderVariables,
  snippet,
  textToHtml,
  timeVariables,
  variableUses,
  type CampaignSchedule,
  type SequenceStep,
  type TemplateObject,
} from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { badRequest } from "../http/errors";
import { uuidv7 } from "../lib/ids";
import { DEFAULT_SCHEDULE, isScheduleOpen, isValidZone, leadClock } from "../lib/time";
import { newMessageId, replySubject } from "../mail/compose";
import { driverFor, isSandbox, type AccountRow } from "../mail/driver";
import { MailError, type OutgoingMessage } from "../mail/types";
import { enhancedCode } from "../mail/refusals";
import { classifyError } from "../mail/smtp-imap";
import { bumpAccountStat, effectiveDailyLimit, noteSendFailure, noteSendSuccess, sentByTwinsToday, todayStats } from "../services/accounts";
import { startOfDayOn, startOfNextDayOn, workspaceZone } from "../services/workspace-clock";
import { monthlyEmailsSent, workspaceLimits } from "../services/billing-limits";
import { basePayload, endSubsequence, handleBounce, recordEvent, suppressedFor } from "../services/activity";
import { emit } from "../services/bus";
import { BOUNCE_PROTECTION, activeSteps, campaignSenders, hasEmailBody, rampedDailyLimit, recentBounceStats, sendableVariant, type CampaignRow, type SubsequenceRow } from "../services/campaigns";
import { blockedSet, type LeadRow } from "../services/leads";
import { inZones, openLeadZones } from "../services/lead-zones";
import { stoppedWorkspaces } from "../services/live-workspaces";
import { sendingBlocked } from "../services/privacy";
import { holdSend } from "../services/replies";
import { appendOpenPixel, emailToken, reachableFromInternet, rewriteLinks, trackingBase, unsubscribeMailto, unsubscribeUrl, untrackHtml, untrackText } from "../services/tracking";
import { enqueueWebhooks } from "../services/webhooks";
import { noteSenderError, WATCHDOG_REASONS } from "../services/watchdog";
import { keepSending } from "./index";
import { filteringPrefs, leadRisk, sendLastOrder } from "./lead-filtering";

const L = schema.leads;
const E = schema.emailEvents;
/** How leads that came from this installation's own data were added (they get an X-Report-Abuse link). */
const PLATFORM_SOURCED = new Set(["lead-finder", "lead-finder-agent", "website-visitor"]);

/** Headers that act for the lead (unsubscribe, report abuse): never on the copy for the campaign's cc and bcc addresses. */
const LEAD_HEADERS = new Set(["List-Unsubscribe", "List-Unsubscribe-Post", "X-Report-Abuse"]);

/** Last send per account with its random extra wait (in-memory; falls back to last_sent_at after restarts). */
const lastSend = new Map<string, { at: number; jitterMs: number }>();
/** Accounts backing off after a connection/auth/quota failure. */
const backoffUntil = new Map<string, number>();
/** Last send per campaign/subsequence, for the "single sending account per time gap" preference. */
const flowLastSend = new Map<string, number>();
/** Temporary or unclear send failures in a row, per lead (in-memory), for backing off. */
const leadRetries = new Map<string, number>();

/** Soft bounces (a full mailbox, a refusal without a reason) an address gets before it's written off as bounced. */
export const SOFT_BOUNCE_LIMIT = 3;

async function softBounces(leadId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(E)
    .where(and(eq(E.leadId, leadId), eq(E.type, "bounce"), sql`coalesce(${E.value}, 0) <> 1`));
  return Number(row?.n ?? 0);
}

/** When an account may send next for this campaign; gap settings are read live so edits apply at once. */
function readyAt(c: CampaignRow, a: AccountRow): number {
  const gapMs = Math.max(c.emailGap ?? 10, a.sendingGap ?? 0) * 60_000;
  const last = lastSend.get(a.id) ?? (a.lastSentAt ? { at: a.lastSentAt.getTime(), jitterMs: 0 } : null);
  return Math.max(last ? last.at + gapMs + last.jitterMs : 0, backoffUntil.get(a.id) ?? 0);
}

interface Flow {
  kind: "campaign" | "subsequence";
  campaign: CampaignRow;
  sub: SubsequenceRow | null;
  steps: SequenceStep[];
  schedule: CampaignSchedule;
  dailyLimit: number | null;
  ignoreAccountLimit: boolean;
  autoVariant: CampaignRow["autoVariantSelect"];
  /** Per step: each variant's sends and metric hits so far (loaded once per pass, counted up as it sends). */
  variantStats?: Map<number, Map<number, { sent: number; hits: number }>>;
  /** Per step: each variant's share of the step's latest sends and when it last went, for taking turns (recentTurns). */
  turns?: Map<number, Map<number, Turns>>;
}

async function countSentSince(conds: SQL[]): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(E).where(and(eq(E.type, "sent"), ...conds));
  return Number(row?.n ?? 0);
}

function espCategory(espCode: number): "google" | "outlook" | "other" {
  if (espCode === EspCode.GOOGLE) return "google";
  if (espCode === EspCode.MICROSOFT) return "outlook";
  return "other";
}

function senderCategory(a: AccountRow): "google" | "outlook" | "other" {
  if (a.providerCode === ProviderCode.GOOGLE) return "google";
  if (a.providerCode === ProviderCode.MICROSOFT) return "outlook";
  return "other";
}

/** Applies ESP routing rules: which sender categories may email this recipient. */
function routingAllows(rules: CampaignRow["providerRoutingRules"], recipient: string, sender: string): boolean {
  if (!rules?.length) return true;
  const matches = (list: string[], v: string) => list.includes("all") || list.includes(v);
  const relevant = rules.filter((r) => matches(r.recipient_esp, recipient));
  if (!relevant.length) return true;
  if (relevant.some((r) => r.action === "do_not_send" && matches(r.sender_esp, sender))) return false;
  const sendRules = relevant.filter((r) => r.action === "send");
  return sendRules.length ? sendRules.some((r) => matches(r.sender_esp, sender)) : true;
}

/**
 * A/B testing. Variants take turns: the one sent least among the step's latest sends goes next, and between equals the
 * one that has waited longest (ties at random only when none has gone yet), so the split stays even, and a variant
 * added or switched back on later catches up within those instead of taking every send until its all-time count
 * matches the others'.
 * With auto-optimize on, the best variant by the chosen metric takes over once each has AB_TEST.minSends sends and
 * the variants have AB_TEST.minHits hits between them (ties at random); one send in ten keeps testing the others.
 * Open and click rates only count when that tracking is on.
 */
export const AB_TEST = { minSends: 50, minHits: 5, explore: 0.1, turnsPerVariant: 20 } as const;

const pickAtRandom = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

async function variantStats(flow: Flow, stepIndex: number) {
  flow.variantStats ??= new Map();
  const cached = flow.variantStats.get(stepIndex);
  if (cached) return cached;
  const trigger = flow.autoVariant?.trigger;
  const type = trigger === "click_rate" ? "click" : trigger === "open_rate" ? "open" : "reply";
  const scope = flow.kind === "campaign" ? and(eq(E.campaignId, flow.campaign.id), isNull(E.subsequenceId))! : eq(E.subsequenceId, flow.sub!.id);
  const rows = await db
    .select({
      variant: E.variant,
      sent: sql<number>`sum(case when ${E.type} = 'sent' then 1 else 0 end)`,
      hits: sql<number>`count(distinct case when ${E.type} = ${type} then ${E.leadId} end)`,
    })
    .from(E)
    .where(and(scope, eq(E.step, stepIndex)))
    .groupBy(E.variant);
  const stats = new Map(rows.map((r) => [r.variant ?? 0, { sent: Number(r.sent), hits: Number(r.hits) }]));
  flow.variantStats.set(stepIndex, stats);
  return stats;
}

interface Turns {
  /** Sends among the step's latest ones. */
  n: number;
  /** When its newest of those went (ms). */
  last: number;
}

/** For each variant: how many of the step's latest sends (AB_TEST.turnsPerVariant per variant taking part) it had. */
async function recentTurns(flow: Flow, stepIndex: number, variants: number) {
  flow.turns ??= new Map();
  const cached = flow.turns.get(stepIndex);
  if (cached) return cached;
  const scope = flow.kind === "campaign" ? and(eq(E.campaignId, flow.campaign.id), isNull(E.subsequenceId))! : eq(E.subsequenceId, flow.sub!.id);
  const rows = await db
    .select({ variant: E.variant, at: E.createdAt })
    .from(E)
    .where(and(scope, eq(E.step, stepIndex), eq(E.type, "sent")))
    .orderBy(desc(E.createdAt), desc(E.id))
    .limit(variants * AB_TEST.turnsPerVariant);
  const turns = new Map<number, Turns>();
  // Newest first: a variant's first row is its newest send.
  for (const r of rows) {
    const t = turns.get(r.variant ?? 0);
    if (t) t.n++;
    else turns.set(r.variant ?? 0, { n: 1, last: r.at.getTime() });
  }
  flow.turns.set(stepIndex, turns);
  return turns;
}

/** The variant to send, or null when the step has nothing to send (no enabled variant with a body and every {{ closed). */
async function chooseVariant(flow: Flow, stepIndex: number, step: SequenceStep): Promise<number | null> {
  const enabled = step.variants.map((v, i) => ({ v, i })).filter((x) => !x.v.v_disabled && sendableVariant(x.v));
  if (!enabled.length) return null;
  if (enabled.length === 1) return enabled[0]!.i;
  const stats = await variantStats(flow, stepIndex);
  const sent = (i: number) => stats.get(i)?.sent ?? 0;
  const trigger = flow.autoVariant?.trigger;
  const measurable = trigger === "open_rate" ? !!flow.campaign.openTracking : trigger === "click_rate" ? !!flow.campaign.linkTracking : !!trigger;
  let pick: number | null = null;
  if (measurable && Math.random() >= AB_TEST.explore) {
    const hits = enabled.reduce((n, x) => n + (stats.get(x.i)?.hits ?? 0), 0);
    if (enabled.every((x) => sent(x.i) >= AB_TEST.minSends) && hits >= AB_TEST.minHits) {
      const rate = (i: number) => (stats.get(i)?.hits ?? 0) / Math.max(1, sent(i));
      const best = Math.max(...enabled.map((x) => rate(x.i)));
      pick = pickAtRandom(enabled.filter((x) => rate(x.i) === best)).i;
    }
  }
  const turns = await recentTurns(flow, stepIndex, enabled.length);
  if (pick === null) {
    const turn = (i: number) => turns.get(i)?.n ?? 0;
    const last = (i: number) => turns.get(i)?.last ?? 0;
    const least = Math.min(...enabled.map((x) => turn(x.i)));
    // Counts over a sliding window tie as old sends drop out of it: the one that has waited longest goes then, or a
    // variant could go twice while another waits.
    const tied = enabled.filter((x) => turn(x.i) === least);
    const longest = Math.min(...tied.map((x) => last(x.i)));
    pick = pickAtRandom(tied.filter((x) => last(x.i) === longest)).i;
  }
  stats.set(pick, { sent: sent(pick) + 1, hits: stats.get(pick)?.hits ?? 0 });
  turns.set(pick, { n: (turns.get(pick)?.n ?? 0) + 1, last: Date.now() });
  return pick;
}

async function setNotSending(c: CampaignRow, status: number | null) {
  if (c.notSendingStatus === status) return;
  // The send watchdog's verdicts stay until the campaign sends again (sendStep) or another reason replaces them.
  if (status === null && c.notSendingStatus !== null && WATCHDOG_REASONS.has(c.notSendingStatus)) return;
  c.notSendingStatus = status;
  await db.update(schema.campaigns).set({ notSendingStatus: status }).where(eq(schema.campaigns.id, c.id));
}

/** Company/domain daily limit (workspace setting or per-campaign override), by the domain of the addresses emailed. */
async function companyLimitReached(flow: Flow, lead: LeadRow, settings: Record<string, unknown>, sinceMs: number): Promise<boolean> {
  // Counted the way sends are found (by address), so a company domain typed on the lead that differs from its email's
  // can't let it past the limit or hold it back for someone else's emails.
  const domain = domainOf(lead.email);
  if (!domain || FREE_MAIL_DOMAINS.has(domain)) return false;
  const override = flow.campaign.limitEmailsPerCompanyOverride;
  const ws = settings.limit_emails_per_company as { enabled?: boolean; daily_limit?: number; scope?: "per_campaign" | "across_workspace" } | undefined;
  let limit: number | null = null;
  let scope: "per_campaign" | "across_workspace" = "across_workspace";
  if (override?.mode === "disabled") return false;
  if (override?.mode === "custom" && override.daily_limit) {
    limit = override.daily_limit;
    scope = override.scope ?? "per_campaign";
  } else if (ws?.enabled && ws.daily_limit) {
    limit = ws.daily_limit;
    scope = ws.scope ?? "across_workspace";
  }
  if (!limit) return false;
  const conds: SQL[] = [eq(E.workspaceId, flow.campaign.workspaceId), gte(E.createdAt, new Date(sinceMs)), like(E.leadEmail, `%@${domain}`)];
  if (scope === "per_campaign") conds.push(eq(E.campaignId, flow.campaign.id));
  return (await countSentSince(conds)) >= limit;
}

/** Template variables for a lead + sending account (sample values when either is missing, e.g. previews). */
export function templateVars(lead: LeadRow | null, account: AccountRow | null, tz: string, unsubUrl: string): TemplateObject {
  return {
    ...leadVariables(
      lead
        ? {
            email: lead.email,
            first_name: lead.firstName,
            last_name: lead.lastName,
            company_name: lead.companyName,
            company_domain: lead.companyDomain,
            website: lead.website,
            phone: lead.phone,
            job_title: lead.jobTitle,
            personalization: lead.personalization,
            linkedin_url: lead.linkedinUrl,
            location: lead.location,
            payload: lead.payload,
          }
        : { email: "alex@example.com", first_name: "Alex", last_name: "Morgan", company_name: "Example Co", company_domain: "example.com", website: "example.com", job_title: "Head of Growth" },
    ),
    ...senderVariables(
      account
        ? { email: account.email, first_name: account.firstName, last_name: account.lastName, signature: account.signature }
        : { email: "you@yourdomain.com", first_name: "Sam", last_name: "Lee", signature: "" },
    ),
    ...timeVariables(new Date(), isValidZone(tz) ? tz : "UTC"),
    unsubscribe_url: unsubUrl,
    unsubscribeLink: unsubUrl,
  };
}

/** Whether a step goes out as plain text: the campaign's choice, or the first email's (the campaign's or the workspace's). */
export function sendsTextOnly(c: Pick<CampaignRow, "textOnly" | "firstEmailTextOnly">, kind: "campaign" | "subsequence", stepIndex: number, settings: Record<string, unknown>): boolean {
  return !!c.textOnly || (stepIndex === 0 && kind === "campaign" && (!!c.firstEmailTextOnly || settings.first_email_text_only === true));
}

/** Whether a rendered email has nothing in it: no text, and no image unless it goes out as plain text. */
export function blankEmail(html: string, textOnly: boolean): boolean {
  return textOnly ? !htmlToText(html).trim() : !hasEmailBody({ body: html });
}

interface SendOutcome {
  ok: boolean;
  accountError?: boolean;
  /** The step has no email to send; nothing was sent and the lead wasn't moved on. */
  emptyStep?: boolean;
  /** The email came out blank for this lead (these {{variables}} have no value); nothing was sent. */
  blank?: string[];
}

/** Renders and sends one step to one lead from one account, then records everything. */
async function sendStep(flow: Flow, lead: LeadRow, account: AccountRow, stepIndex: number, settings: Record<string, unknown> = {}): Promise<SendOutcome> {
  const c = flow.campaign;
  const step = flow.steps[stepIndex]!;
  const chosen = await chooseVariant(flow, stepIndex, step);
  if (chosen === null) return { ok: false, emptyStep: true };
  const variantIndex = chosen;
  const variant = step.variants[variantIndex]!;
  const emailId = uuidv7();
  const base = trackingBase(account);
  // Tracking and unsubscribe links must lead somewhere the recipient can reach. From a server without a public address
  // (npm run local on a laptop) they couldn't: links stay as written, there's no open pixel, and the unsubscribe link
  // becomes an email asking to unsubscribe, which inbox sync acts on. Sandbox mailboxes never leave this server.
  const linkable = account.providerCode === ProviderCode.SANDBOX || reachableFromInternet(base);
  const unsubUrl = linkable ? unsubscribeUrl(base, emailId) : unsubscribeMailto(account);
  // Time variables (day of the week, morning or afternoon) on the lead's clock when sending in each lead's timezone.
  const vars = templateVars(lead, account, leadClock(flow.schedule, lead.timezone), unsubUrl);

  const inThread = flow.kind === "campaign" ? stepIndex > 0 : lead.subseqNextStep > 0 || !!lead.threadMessageIds?.length;
  const threadIds = lead.threadMessageIds ?? [];
  const subjectRendered = renderTemplate(variant.subject ?? "", vars).output.trim();
  let subject = subjectRendered;
  let inReplyTo: string | null = null;
  let references: string[] = [];
  if (!subject && inThread && lead.lastSubject) {
    subject = replySubject(lead.lastSubject);
    inReplyTo = threadIds[threadIds.length - 1] ?? null;
    references = threadIds.slice(-10);
  } else if (!subject) {
    subject = lead.lastSubject ? replySubject(lead.lastSubject) : "(no subject)";
  }
  let html = renderTemplate(variant.body ?? "", vars, { escapeHtml: true }).output;
  // Workspace-wide deliverability preferences apply on top of each campaign's own options.
  const textOnly = sendsTextOnly(c, flow.kind, stepIndex, settings);
  // Written only of variables this lead has no value for, the email would go out blank: it doesn't (see holdBlank).
  if (blankEmail(html, textOnly)) return { ok: false, blank: emptyVariables(variableUses(variant.body ?? ""), vars) };
  let text: string | null = null;
  if (textOnly) {
    text = htmlToText(html);
    html = "";
  } else {
    if (c.linkTracking && linkable) html = rewriteLinks(html, base, emailId);
    if (c.openTracking && linkable && settings.disable_open_tracking !== true) html = appendOpenPixel(html, base, emailId);
  }
  const messageId = newMessageId(account.email);
  const headers: Record<string, string> = {};
  if (c.insertUnsubscribeHeader) {
    const byEmail = `<${unsubscribeMailto(account)}>`;
    headers["List-Unsubscribe"] = linkable ? `<${unsubUrl}>, ${byEmail}` : byEmail;
    // One click needs a web address the mail provider can reach, over HTTPS (RFC 8058).
    if (linkable && unsubUrl.startsWith("https://")) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  // People found through this installation's own data (Lead Finder, website visitors) can report unwanted outreach.
  if (PLATFORM_SOURCED.has(lead.uploadMethod ?? "") && (account.providerCode === ProviderCode.SANDBOX || reachableFromInternet(config.webUrl))) {
    headers["X-Report-Abuse"] = `Please report abuse here: ${config.webUrl}/privacy/report-abuse/${emailToken(emailId)}`;
  }
  const toName = `${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim();
  // The lead as this pass found it: in this flow, at this step and being emailed (not moved, reset or paused since).
  const here =
    flow.kind === "campaign"
      ? and(eq(L.id, lead.id), eq(L.campaignId, c.id), eq(L.nextStep, stepIndex))
      : and(eq(L.id, lead.id), eq(L.subsequenceId, flow.sub!.id), eq(L.subseqNextStep, stepIndex));
  // Stamped before sending so an instant reply never sorts ahead of the email it answers.
  const now = new Date();
  const threadId = lead.threadId ?? uuidv7();
  const isLast = stepIndex >= flow.steps.length - 1;
  const nextAt = isLast ? null : now.getTime() + delayToMs(step.delay, step.delay_unit);
  const stepRef = `${flow.kind === "campaign" ? c.id : flow.sub!.id}:${stepIndex}:${variantIndex}`;
  const cc = (c.ccList ?? []).map((address) => ({ address }));
  // The campaign's cc and bcc addresses get their own copy (below), never the lead's.
  const copies = [...new Set([...(c.ccList ?? []), ...(c.bccList ?? [])])].filter((a) => a !== lead.email);
  const touched = {
    senderAccountId: account.id,
    threadId,
    threadMessageIds: [...threadIds.slice(-20), messageId],
    lastSubject: subjectRendered ? subject : (lead.lastSubject ?? subject),
    lastStepFrom: flow.kind,
    lastStepId: stepRef,
    lastStepAt: now,
    lastContactAt: now,
    lastTouchAt: now,
  };

  // The lead moves on, and the email is written down, before it goes out: whatever fails once it's sent (a database
  // write, the process stopping), the lead is never sent the same step twice. A send that fails puts both back.
  const claimed = await db.transaction(async (tx) => {
    const [moved] = await tx
      .update(L)
      .set(
        flow.kind === "campaign"
          ? { ...touched, nextStep: stepIndex + 1, nextSendAt: nextAt, ...(isLast ? { status: LeadStatus.COMPLETED, completedAt: now } : {}) }
          : { ...touched, subseqNextStep: stepIndex + 1, subseqNextSendAt: nextAt, ...(isLast ? { subseqStatus: LeadStatus.COMPLETED } : {}) },
      )
      .where(and(here, flow.kind === "campaign" ? eq(L.status, LeadStatus.ACTIVE) : eq(L.subseqStatus, LeadStatus.ACTIVE)))
      .returning({ id: L.id });
    if (!moved) return false;
    await tx.insert(schema.emails).values({
      id: emailId,
      workspaceId: c.workspaceId,
      messageId,
      threadId,
      inReplyTo,
      references: references.join(" ") || null,
      subject,
      fromAddress: account.email,
      fromJson: [{ address: account.email, name: `${account.firstName} ${account.lastName}`.trim() }],
      toList: lead.email!,
      toJson: [{ address: lead.email!, name: toName }],
      ccList: (c.ccList ?? []).join(",") || null,
      bccList: (c.bccList ?? []).join(",") || null,
      replyTo: account.replyTo,
      bodyText: text ?? htmlToText(html),
      bodyHtml: html || textToHtml(text ?? ""),
      contentPreview: snippet(text ?? html, 160),
      timestampEmail: now,
      campaignId: c.id,
      subsequenceId: flow.sub?.id ?? null,
      leadEmail: lead.email,
      leadId: lead.id,
      accountId: account.id,
      eaccount: account.email,
      ueType: EmailType.CAMPAIGN_SENT,
      step: String(stepIndex),
      variant: variantIndex,
      isUnread: 0,
      isFocused: 1,
      interestStatus: lead.interestStatus,
    });
    return true;
  });
  // Moved, reset, paused or stopped since this pass loaded it: nothing is sent.
  if (!claimed) return { ok: false };

  /** After a failed send: the lead is back at this step (unless something else moved it meanwhile), the email gone. */
  const unclaim = async () => {
    // A bounce or unsubscribe that came in meanwhile keeps its status; only the completion this send wrote is undone.
    const undoCompleted = (col: SQLWrapper, before: number | null) => sql<number>`case when ${col} = ${LeadStatus.COMPLETED} then ${before} else ${col} end`;
    const back = {
      senderAccountId: lead.senderAccountId,
      threadId: lead.threadId,
      threadMessageIds: lead.threadMessageIds,
      lastSubject: lead.lastSubject,
      lastStepFrom: lead.lastStepFrom,
      lastStepId: lead.lastStepId,
      lastStepAt: lead.lastStepAt,
      lastContactAt: lead.lastContactAt,
      lastTouchAt: lead.lastTouchAt,
    };
    try {
      await db.delete(schema.emails).where(eq(schema.emails.id, emailId));
      await db
        .update(L)
        .set(
          flow.kind === "campaign"
            ? { ...back, nextStep: stepIndex, nextSendAt: lead.nextSendAt, ...(isLast ? { status: undoCompleted(L.status, lead.status), completedAt: lead.completedAt } : {}) }
            : { ...back, subseqNextStep: stepIndex, subseqNextSendAt: lead.subseqNextSendAt, ...(isLast ? { subseqStatus: undoCompleted(L.subseqStatus, lead.subseqStatus) } : {}) },
        )
        .where(and(eq(L.id, lead.id), eq(L.lastStepId, stepRef), eq(L.lastStepAt, now)));
    } catch (err) {
      // The lead stays moved on: at worst it misses this step, never gets it twice.
      console.error(`[sender] couldn't put ${lead.email} back after a failed send`, err);
    }
  };

  const message: OutgoingMessage = {
    from: { name: `${account.firstName} ${account.lastName}`.trim(), address: account.email },
    to: [{ name: toName || null, address: lead.email! }],
    cc,
    replyTo: account.replyTo,
    subject,
    html: textOnly ? null : html,
    text,
    messageId,
    inReplyTo,
    references,
    headers,
    date: now,
  };
  const driver = driverFor(account);
  try {
    // With cc or bcc addresses, this transmission goes to the lead alone; the headers still show who's copied.
    await driver.send(copies.length ? { ...message, envelopeTo: [lead.email!] } : message);
  } catch (err) {
    await unclaim();
    const e = err instanceof MailError ? err : classifyError(err);
    // A try counts like a send for the mailbox's gap: one whose emails keep being refused doesn't get to try another
    // lead every few seconds.
    lastSend.set(account.id, { at: Date.now(), jitterMs: Math.random() * (c.randomWaitMax ?? 0) * 60_000 });
    const later = (at: number) => db.update(L).set(flow.kind === "campaign" ? { nextSendAt: at } : { subseqNextSendAt: at }).where(here);
    if (e.kind === "recipient") {
      // A full mailbox, or a refusal that gives no reason, gets a few more tries a day apart before it counts as bounced.
      const retry = !!e.soft && (await softBounces(lead.id)) + 1 < SOFT_BOUNCE_LIMIT;
      await handleBounce({
        workspaceId: c.workspaceId,
        lead,
        campaignId: c.id,
        subsequenceId: flow.sub?.id ?? null,
        accountId: account.id,
        accountEmail: account.email,
        step: stepIndex,
        variant: variantIndex,
        hard: !retry,
        status: enhancedCode(e.response ?? e.message) ?? (e.responseCode ? String(e.responseCode) : null),
        diagnostic: e.response ?? e.message,
      });
      // A try all the same: the mailbox's bounce rate is out of what it sent and what was refused.
      await bumpAccountStat(c.workspaceId, account.id, "refused");
      if (retry) await later(Date.now() + 24 * 3_600_000);
      return { ok: false };
    }
    // The mailbox's own failures (login, connection, provider limit, refusal) count against its health and back it off;
    // most also take it out of sending until a send or an SMTP re-test works again.
    if (await noteSendFailure(account, e)) {
      backoffUntil.set(account.id, Date.now() + (e.kind === "quota" || e.kind === "rejected" ? 6 * 3_600_000 : 15 * 60_000));
      return { ok: false, accountError: true };
    }
    // Temporary or unclear failure: this lead is tried again later, waiting twice as long each time (up to a day).
    const tries = (leadRetries.get(lead.id) ?? 0) + 1;
    leadRetries.set(lead.id, tries);
    await later(Date.now() + Math.min(30 * 60_000 * 2 ** (tries - 1), 24 * 3_600_000));
    console.error(`[sender] ${account.email} → ${lead.email}: ${e.message}`);
    return { ok: false };
  }
  leadRetries.delete(lead.id);

  // The cc and bcc copy goes on its own, without the lead's tracking: opens and clicks there aren't the lead's, and the
  // lead's unsubscribe and report-abuse links would act for the lead. A copy that fails doesn't undo the lead's email.
  if (copies.length) {
    const own = Object.fromEntries(Object.entries(headers).filter(([name]) => !LEAD_HEADERS.has(name)));
    await driver
      .send({ ...message, html: message.html ? untrackHtml(message.html) : null, text: text === null ? null : untrackText(text), headers: own, envelopeTo: copies })
      .catch((err) => console.warn(`[sender] the cc/bcc copy of ${messageId} wasn't sent: ${(err as Error).message}`));
  }

  // Nothing below can make the lead get this step again; a failure here is logged and the pass carries on.
  try {
    await recordEvent({
      workspaceId: c.workspaceId,
      type: "sent",
      campaignId: c.id,
      subsequenceId: flow.sub?.id ?? null,
      leadId: lead.id,
      leadEmail: lead.email,
      accountId: account.id,
      accountEmail: account.email,
      emailId,
      step: stepIndex,
      variant: variantIndex,
      isFirst: flow.kind === "campaign" && stepIndex === 0,
    });
    await bumpAccountStat(c.workspaceId, account.id, "sent");
    await noteSendSuccess(account);
    await db.update(schema.emailAccounts).set({ lastSentAt: now }).where(eq(schema.emailAccounts.id, account.id));
    // A send from the campaign itself settles any "not sending" reason.
    const sending = flow.kind === "campaign" && c.notSendingStatus !== null;
    await db
      .update(schema.campaigns)
      .set({ lastSendAt: now, ...(sending ? { notSendingStatus: null } : {}) })
      .where(eq(schema.campaigns.id, c.id));
    if (sending) c.notSendingStatus = null;
  } catch (err) {
    console.error(`[sender] ${lead.email} was sent step ${stepIndex + 1}, but recording it failed`, err);
  }
  lastSend.set(account.id, { at: now.getTime(), jitterMs: Math.random() * (c.randomWaitMax ?? 0) * 60_000 });

  // Completed by this email, unless it bounced or unsubscribed while it went out.
  let completed = false;
  if (isLast) {
    const [after] = await db.select({ status: L.status, subseqStatus: L.subseqStatus }).from(L).where(eq(L.id, lead.id)).limit(1);
    completed = (flow.kind === "campaign" ? after?.status : after?.subseqStatus) === LeadStatus.COMPLETED;
  }
  await enqueueWebhooks(
    c.workspaceId,
    "email_sent",
    {
      ...(await basePayload(lead, c.id, account.email)),
      step: stepIndex + 1,
      variant: variantIndex,
      is_first: stepIndex === 0,
      email_id: emailId,
      email_subject: subject,
      // As written, without the tracking: a copy shown in another app mustn't count as the lead opening or clicking.
      email_html: html ? untrackHtml(html) : null,
      email_text: text === null ? null : untrackText(text),
      subsequence_id: flow.sub?.id ?? null,
    },
    { campaignId: c.id },
  );
  emit("email_sent", c.workspaceId, { lead_id: lead.id, campaign_id: c.id, subsequence_id: flow.sub?.id ?? null, step: stepIndex, completed, account_id: account.id });
  if (completed) emit("lead_status_changed", c.workspaceId, { lead_id: lead.id, campaign_id: c.id, subsequence_id: flow.sub?.id ?? null, status: "completed", reply_count: lead.replyCount });
  return { ok: true };
}

/** Skip leads that must not be contacted; returns true when the lead was skipped. */
async function screenLead(flow: Flow, lead: LeadRow, settings: Record<string, unknown> = {}): Promise<boolean> {
  const c = flow.campaign;
  const statusField = flow.kind === "campaign" ? { status: LeadStatus.SKIPPED, nextSendAt: null } : { subseqStatus: LeadStatus.SKIPPED, subseqNextSendAt: null };
  if (!lead.email) {
    await db.update(L).set(statusField).where(eq(L.id, lead.id));
    return true;
  }
  if ((await blockedSet(c.workspaceId, [lead.email])).size) {
    await db.update(L).set(statusField).where(eq(L.id, lead.id));
    return true;
  }
  // Reported one of this installation's emails as abuse: no campaign emails them again.
  if (await sendingBlocked(lead.email)) {
    await db.update(L).set(statusField).where(eq(L.id, lead.id));
    return true;
  }
  const [unsub] = await db
    .select({ id: schema.unsubscribes.id })
    .from(schema.unsubscribes)
    .where(and(eq(schema.unsubscribes.workspaceId, c.workspaceId), eq(schema.unsubscribes.email, lead.email)))
    .limit(1);
  if (unsub) {
    await db.update(L).set({ status: LeadStatus.UNSUBSCRIBED, nextSendAt: null, subseqStatus: endSubsequence(LeadStatus.UNSUBSCRIBED), subseqNextSendAt: null }).where(eq(L.id, lead.id));
    return true;
  }
  // An address that hard-bounced anywhere in the workspace isn't tried again (a lead added later, another campaign, the
  // same lead deleted and added again), and one that asked this campaign to stop isn't emailed by it again.
  const suppressed = await suppressedFor(c.workspaceId, lead.email, c.id);
  if (suppressed) {
    const ended = suppressed === "bounced" ? LeadStatus.BOUNCED : LeadStatus.UNSUBSCRIBED;
    await db.update(L).set({ status: ended, nextSendAt: null, subseqStatus: endSubsequence(ended), subseqNextSendAt: null }).where(eq(L.id, lead.id));
    return true;
  }
  if (lead.verificationStatus === VerificationStatus.INVALID || (lead.verificationStatus === VerificationStatus.RISKY && !c.allowRiskyContacts)) {
    await db.update(L).set(statusField).where(eq(L.id, lead.id));
    return true;
  }
  // Lead filtering only decides whether a sequence starts; leads already in one keep going.
  const risk = flow.kind === "campaign" && lead.nextStep === 0 ? leadRisk(lead.email) : null;
  if (risk && filteringPrefs(settings)[risk] === "skip") {
    await db.update(L).set(statusField).where(eq(L.id, lead.id));
    return true;
  }
  if (lead.verificationStatus === VerificationStatus.PENDING || lead.verificationStatus === VerificationStatus.PENDING_JOB) {
    // Wait for verification to finish before the first email (a subsequence's too, to someone the campaign never emailed).
    return lead.nextStep === 0;
  }
  return false;
}

/**
 * Which due leads a pass can serve, so ones it can't never hold up the rest of the queue: a follow-up waits for its own
 * mailbox (sticky sender) to be ready, and any other lead needs a ready mailbox its provider rules allow.
 */
interface Fit {
  /** For follow-ups and subsequence emails, which keep to the mailbox that started the thread. */
  sticky: SQL;
  /** For first emails (undefined: any lead). */
  fresh?: SQL;
}

/** How long a first email waits for its lead's provider to be looked up, when provider rules or matching need it. */
const PROVIDER_WAIT_MS = 6 * 3_600_000;

/** The lead's provider is known, or was looked for long enough (it then counts as "other"). */
const providerKnown = (now: number) => or(ne(L.espCode, EspCode.IN_QUEUE), lt(L.createdAt, new Date(now - PROVIDER_WAIT_MS)))!;

function fitFor(c: CampaignRow, senders: AccountRow[], ready: AccountRow[], matchEsp: boolean): Fit {
  const routable = routableEsps(c.providerRoutingRules, ready);
  // Matching the lead's provider needs it known as well.
  const fresh = matchEsp ? and(routable, providerKnown(Date.now())) : routable;
  const unclaimed = or(isNull(L.senderAccountId), notInArray(L.senderAccountId, senders.map((a) => a.id)))!;
  return { sticky: or(inArray(L.senderAccountId, ready.map((a) => a.id)), fresh ? and(unclaimed, fresh) : unclaimed)!, fresh };
}

/** The recipients' providers (by ESP code) that at least one ready mailbox may email under the rules; undefined: all. */
function routableEsps(rules: CampaignRow["providerRoutingRules"], ready: AccountRow[]): SQL | undefined {
  if (!rules?.length) return undefined;
  const open = (esp: "google" | "outlook" | "other") => ready.some((a) => routingAllows(rules, esp, senderCategory(a)));
  const parts: SQL[] = [];
  if (open("google")) parts.push(eq(L.espCode, EspCode.GOOGLE));
  if (open("outlook")) parts.push(eq(L.espCode, EspCode.MICROSOFT));
  // A provider not looked up yet would count as "other" (a company on Google Workspace, say): the lead waits for it.
  if (open("other")) parts.push(and(notInArray(L.espCode, [EspCode.GOOGLE, EspCode.MICROSOFT]), providerKnown(Date.now()))!);
  return parts.length ? or(...parts) : sql`0`;
}

const AWAITING_VERIFICATION = [VerificationStatus.PENDING, VerificationStatus.PENDING_JOB];
/** A lead's own end: nothing more goes out to it, from the campaign or a subsequence. */
const ENDED = [LeadStatus.BOUNCED, LeadStatus.UNSUBSCRIBED];

interface DueOptions {
  /** With "each lead's timezone": only leads in these timezones (null: leads without one), whose clock has the schedule open. */
  zones?: Array<string | null> | null;
  /** Only leads this pass can serve (see Fit); null: every due lead. */
  fit?: Fit | null;
  /** Include first emails still waiting for their verification. */
  awaitingVerification?: boolean;
}

/** Leads due now, follow-ups first unless new leads come first. Leads at a task step wait for it (services/sequence-tasks). */
async function dueLeads(flow: Flow, limit: number, newAllowed: number, settings: Record<string, unknown> = {}, opts: DueOptions = {}): Promise<LeadRow[]> {
  const now = Date.now();
  const inOpenZone = opts.zones ? inZones(opts.zones) : undefined;
  const tasks = flow.steps.flatMap((s, i) => (isTaskStep(s) ? [i] : []));
  if (flow.kind === "subsequence") {
    return db
      .select()
      .from(L)
      .where(
        and(
          eq(L.subsequenceId, flow.sub!.id),
          eq(L.subseqStatus, LeadStatus.ACTIVE),
          // An address that bounced or unsubscribed gets no subsequence emails, whatever the subsequence says.
          notInArray(L.status, ENDED),
          lte(L.subseqNextSendAt, now),
          // Someone the campaign never emailed waits for their verification, like a first email does (screenLead).
          opts.awaitingVerification ? undefined : or(sql`${L.nextStep} > 0`, notInArray(L.verificationStatus, AWAITING_VERIFICATION)),
          tasks.length ? notInArray(L.subseqNextStep, tasks) : undefined,
          inOpenZone,
          opts.fit?.sticky,
        ),
      )
      .orderBy(asc(L.subseqNextSendAt))
      .limit(limit);
  }
  const c = flow.campaign;
  const followUps = () =>
    db
      .select()
      .from(L)
      .where(
        and(
          eq(L.campaignId, c.id),
          eq(L.status, LeadStatus.ACTIVE),
          sql`${L.nextStep} > 0`,
          lte(L.nextSendAt, now),
          tasks.length ? notInArray(L.nextStep, tasks) : undefined,
          inOpenZone,
          opts.fit?.sticky,
        ),
      )
      .orderBy(asc(L.nextSendAt))
      .limit(limit);
  const fresh = (n: number) =>
    n <= 0
      ? Promise.resolve([] as LeadRow[])
      : db
          .select()
          .from(L)
          .where(
            and(
              eq(L.campaignId, c.id),
              eq(L.status, LeadStatus.ACTIVE),
              eq(L.nextStep, 0),
              or(isNull(L.nextSendAt), lte(L.nextSendAt, now)),
              inOpenZone,
              opts.fit?.fresh,
              // A first email waits for the lead's verification to finish.
              opts.awaitingVerification ? undefined : notInArray(L.verificationStatus, AWAITING_VERIFICATION),
            ),
          )
          .orderBy(...[sendLastOrder(filteringPrefs(settings)), asc(L.createdAt)].filter((o): o is SQL => !!o))
          .limit(n);
  if (c.prioritizeNewLeads) {
    const n = await fresh(Math.min(limit, newAllowed));
    return n.length >= limit ? n : [...n, ...(await followUps()).slice(0, limit - n.length)];
  }
  const f = await followUps();
  return f.length >= limit ? f : [...f, ...(await fresh(Math.min(limit - f.length, newAllowed)))];
}

/** Why a campaign with ready mailboxes has nothing it can send right now; null: its due leads wait for their mailboxes. */
async function idleReason(flow: Flow, newAllowed: number, settings: Record<string, unknown>, zones: Array<string | null> | null): Promise<number | null> {
  const any = (opts: DueOptions) => dueLeads(flow, 1, newAllowed, settings, { awaitingVerification: true, ...opts }).then((l) => l.length > 0);
  if (!(await any({}))) return CampaignNotSendingStatus.WAITING_FOR_LEAD;
  // Due only on their own clock, which has the schedule closed.
  if (zones && !(await any({ zones }))) return CampaignNotSendingStatus.OUTSIDE_SCHEDULE;
  if (!(await any({ zones, awaitingVerification: false }))) return CampaignNotSendingStatus.VERIFYING;
  return null;
}

/** The account that last emailed this address from the workspace, for "sticky sending accounts for leads". */
async function previousSender(workspaceId: string, email: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: E.accountId })
    .from(E)
    .where(and(eq(E.workspaceId, workspaceId), eq(E.type, "sent"), eq(E.leadEmail, email)))
    .orderBy(desc(E.createdAt))
    .limit(1);
  return row?.accountId ?? null;
}

async function processFlow(flow: Flow, settings: Record<string, unknown>) {
  const c = flow.campaign;
  if (!flow.steps.length) return;
  const flowKey = flow.sub?.id ?? c.id;
  // One account per gap: the whole campaign waits out the gap after any send, instead of each mailbox separately.
  const singleAccount = settings.single_account_per_gap === true;
  if (singleAccount && Date.now() < (flowLastSend.get(flowKey) ?? 0) + (c.emailGap ?? 10) * 60_000) return;
  // Sending in each lead's timezone: the timezones whose clock has the schedule open now (null: leads without one).
  const zones = flow.schedule.lead_timezone ? await openLeadZones(flow.schedule, { kind: flow.kind, id: flowKey }) : null;
  if (zones ? !zones.length : !isScheduleOpen(flow.schedule)) {
    if (flow.kind === "campaign") await setNotSending(c, CampaignNotSendingStatus.OUTSIDE_SCHEDULE);
    return;
  }
  // Daily limits (the campaign's, its mailboxes', per company) reset at midnight on the workspace clock; the schedule's
  // own timezone only decides when sending windows open.
  const zone = await workspaceZone(c.workspaceId);
  const since = startOfDayOn(zone);
  const scopeCond = flow.kind === "campaign" ? and(eq(E.campaignId, c.id), isNull(E.subsequenceId))! : eq(E.subsequenceId, flow.sub!.id);
  const sentToday = await countSentSince([scopeCond, gte(E.createdAt, new Date(since))]);
  const limit = flow.kind === "campaign" ? rampedDailyLimit(c, flow.dailyLimit, zone) : flow.dailyLimit;
  if (limit !== null && sentToday >= limit) {
    if (flow.kind === "campaign") await setNotSending(c, CampaignNotSendingStatus.CAMPAIGN_DAILY_LIMIT);
    return;
  }

  const senders = await campaignSenders(c, { activeOnly: true });
  if (!senders.length) {
    if (flow.kind === "campaign")
      await setNotSending(c, (await campaignSenders(c)).length ? CampaignNotSendingStatus.ACCOUNTS_UNAVAILABLE : CampaignNotSendingStatus.NO_ACCOUNTS);
    return;
  }
  const stats = await todayStats(senders);
  // The same address connected in another workspace too: what it sent there today counts here as well.
  const twins = flow.ignoreAccountLimit ? new Map<string, number>() : await sentByTwinsToday(senders);
  const now = Date.now();
  const capacity = new Map<string, number>();
  for (const a of senders) {
    const remaining = flow.ignoreAccountLimit ? 1000 : effectiveDailyLimit(a, stats.get(a.id)) - (stats.get(a.id)?.sent ?? 0) - (twins.get(a.email) ?? 0);
    capacity.set(a.id, remaining);
  }
  const ready = senders.filter((a) => {
    if ((capacity.get(a.id) ?? 0) <= 0) return false;
    return now >= readyAt(c, a);
  });
  if (!ready.length) {
    if (flow.kind === "campaign") {
      const allFull = senders.every((a) => (capacity.get(a.id) ?? 0) <= 0);
      await setNotSending(c, allFull ? CampaignNotSendingStatus.ACCOUNTS_DAILY_LIMIT : null);
    }
    return;
  }

  let newAllowed = Number.MAX_SAFE_INTEGER;
  if (flow.kind === "campaign" && c.dailyMaxLeads) {
    const newToday = await countSentSince([eq(E.campaignId, c.id), eq(E.isFirst, true), gte(E.createdAt, new Date(since))]);
    newAllowed = Math.max(0, c.dailyMaxLeads - newToday);
  }
  // "Send emails one at a time" and the single-account mode release one email per pass.
  const perPass = singleAccount || settings.send_one_at_a_time === true ? 1 : ready.length * 2;
  const batch = Math.min(perPass, limit === null ? perPass : limit - sentToday);
  const leads = await dueLeads(flow, batch, newAllowed, settings, { zones, fit: fitFor(c, senders, ready, !!c.matchLeadEsp || settings.esp_matching_default === true) });
  if (!leads.length) {
    if (flow.kind === "campaign") await setNotSending(c, await idleReason(flow, newAllowed, settings, zones));
    return;
  }
  if (flow.kind === "campaign") await setNotSending(c, null);

  const available = new Set(ready.map((a) => a.id));
  const byId = new Map(senders.map((a) => [a.id, a]));
  let sentNow = 0;
  for (const lead of leads) {
    // Shutting down (or another process took over sending): stop between emails, never in the middle of one.
    if (!keepSending()) break;
    if (!available.size) break;
    if (limit !== null && sentToday + sentNow >= limit) break;
    if (await screenLead(flow, lead, settings)) continue;
    if (await companyLimitReached(flow, lead, settings, since)) {
      const tomorrow = startOfNextDayOn(zone);
      await db.update(L).set(flow.kind === "campaign" ? { nextSendAt: tomorrow } : { subseqNextSendAt: tomorrow }).where(eq(L.id, lead.id));
      continue;
    }
    const stepIndex = flow.kind === "campaign" ? lead.nextStep : lead.subseqNextStep;
    // A task step is done by hand: the lead waits for its task.
    if (isTaskStep(flow.steps[stepIndex])) continue;
    if (stepIndex >= flow.steps.length) {
      if (flow.kind === "campaign") await db.update(L).set({ status: LeadStatus.COMPLETED, nextSendAt: null, completedAt: new Date() }).where(eq(L.id, lead.id));
      else await db.update(L).set({ subseqStatus: LeadStatus.COMPLETED, subseqNextSendAt: null }).where(eq(L.id, lead.id));
      continue;
    }

    // Sticky sender keeps follow-ups in the same mailbox thread.
    let account: AccountRow | undefined;
    if (lead.senderAccountId && (stepIndex > 0 || flow.kind === "subsequence")) {
      const sticky = byId.get(lead.senderAccountId);
      if (sticky) {
        if (!available.has(sticky.id)) continue; // wait for that mailbox
        account = sticky;
      }
    }
    if (!account && stepIndex === 0 && flow.kind === "campaign" && settings.sticky_sending_accounts_for_leads === true) {
      const previous = await previousSender(c.workspaceId, lead.email!);
      const sticky = previous ? byId.get(previous) : undefined;
      if (sticky && available.has(sticky.id) && routingAllows(c.providerRoutingRules, espCategory(lead.espCode), senderCategory(sticky))) account = sticky;
    }
    if (!account) {
      const recipientEsp = espCategory(lead.espCode);
      let candidates = [...available].map((id) => byId.get(id)!).filter((a) => routingAllows(c.providerRoutingRules, recipientEsp, senderCategory(a)));
      if (!candidates.length) continue;
      if (c.matchLeadEsp || settings.esp_matching_default === true) {
        const same = candidates.filter((a) => senderCategory(a) === recipientEsp && recipientEsp !== "other");
        if (same.length) candidates = same;
      }
      candidates.sort((a, b) => (capacity.get(b.id) ?? 0) - (capacity.get(a.id) ?? 0) || Math.random() - 0.5);
      account = candidates[0];
    }
    if (!account) continue;
    // Reserved test domains (.test, .example, ...) have no mail servers; only sandbox mailboxes can deliver
    // there. A real mailbox would only collect bounces, so the lead is skipped instead.
    if (!isSandbox(account) && isReservedDomain(domainOf(lead.email))) {
      await db.update(L).set(flow.kind === "campaign" ? { status: LeadStatus.SKIPPED, nextSendAt: null } : { subseqStatus: LeadStatus.SKIPPED, subseqNextSendAt: null }).where(eq(L.id, lead.id));
      continue;
    }
    // Last look: the lead may have replied, unsubscribed or gone out of office since this pass loaded it.
    if (await holdSend(flow.kind, c, lead, settings)) continue;
    // The plan's monthly emails ran out during this pass.
    if ((await planLeft(c.workspaceId)) <= 0) break;
    const outcome = await sendStep(flow, lead, account, stepIndex, settings);
    if (outcome.emptyStep) {
      // Never send a blank email. A campaign keeps sending its other steps and says why these leads wait;
      // a subsequence pauses until someone writes the missing email.
      if (flow.kind === "campaign") {
        await setNotSending(c, CampaignNotSendingStatus.EMPTY_STEP);
        await db.update(L).set({ nextSendAt: Date.now() + 60 * 60_000 }).where(eq(L.id, lead.id));
        continue;
      }
      await db
        .update(schema.subsequences)
        .set({ status: CampaignStatus.PAUSED })
        .where(and(eq(schema.subsequences.id, flow.sub!.id), eq(schema.subsequences.status, CampaignStatus.ACTIVE)));
      console.warn(`[sender] subsequence ${flow.sub!.id} paused: step ${stepIndex + 1} has no email to send`);
      break;
    }
    if (outcome.blank) {
      await holdBlank(flow, lead, stepIndex, outcome.blank);
      continue;
    }
    available.delete(account.id);
    if (outcome.ok) {
      sentNow++;
      notePlanSend(c.workspaceId);
      capacity.set(account.id, (capacity.get(account.id) ?? 1) - 1);
      flowLastSend.set(flowKey, Date.now());
      if (singleAccount) break;
    }
  }
}

/**
 * A lead whose email came out blank (its {{variables}} have no values) waits, paused in that campaign or subsequence,
 * with the reason in its activity, until someone fills in its details and resumes it.
 */
async function holdBlank(flow: Flow, lead: LeadRow, stepIndex: number, missing: string[]) {
  const [paused] = await db
    .update(L)
    .set(flow.kind === "campaign" ? { status: LeadStatus.PAUSED } : { subseqStatus: LeadStatus.PAUSED })
    .where(and(eq(L.id, lead.id), flow.kind === "campaign" ? eq(L.status, LeadStatus.ACTIVE) : eq(L.subseqStatus, LeadStatus.ACTIVE)))
    .returning({ id: L.id });
  if (!paused) return;
  await recordEvent({
    workspaceId: flow.campaign.workspaceId,
    type: "not_sent",
    campaignId: flow.campaign.id,
    subsequenceId: flow.sub?.id ?? null,
    leadId: lead.id,
    leadEmail: lead.email,
    step: stepIndex,
    detail: `Step ${stepIndex + 1} came out blank${missing.length ? `: nothing for ${missing.join(", ")}` : ""}. Fill in the lead's details, then resume it.`,
  });
}

/**
 * Engine status changes apply only from the status this pass saw: a pause, resume or delete in the meantime wins.
 * Each one is announced like a change made in the app (automations, notifications and agents hear of it).
 */
async function moveStatus(c: CampaignRow, status: number, extra: Partial<typeof schema.campaigns.$inferInsert> = {}, reason?: string): Promise<boolean> {
  const previous = c.status;
  const [row] = await db
    .update(schema.campaigns)
    .set({ status, ...extra })
    .where(and(eq(schema.campaigns.id, c.id), eq(schema.campaigns.status, previous)))
    .returning({ id: schema.campaigns.id });
  if (!row) return false;
  c.status = status;
  emit("campaign_status_changed", c.workspaceId, { campaign_id: c.id, status, previous, ...(reason ? { reason } : {}) });
  return true;
}

/**
 * Bounce protection, and the end of a campaign: "running subsequences" once no lead has steps left but some are still in
 * a subsequence, completed once none are. Leads added meanwhile put a campaign running subsequences back to active.
 */
async function finalizeCampaign(c: CampaignRow, settings: Record<string, unknown>) {
  if (c.status !== CampaignStatus.ACTIVE && c.status !== CampaignStatus.RUNNING_SUBSEQUENCES) return;
  // Bounce protection: pause when the hard-bounce rate over the last week is too high (see BOUNCE_PROTECTION).
  const inGrace = !!c.bounceGraceUntil && c.bounceGraceUntil.getTime() > Date.now();
  if (c.status === CampaignStatus.ACTIVE && !c.disableBounceProtect && settings.auto_pause_on_bounce !== false && !inGrace) {
    const { sent, rate } = await recentBounceStats(c.id);
    const threshold = Number(settings.bounce_protect_threshold ?? BOUNCE_PROTECTION.defaultThreshold);
    if (sent >= BOUNCE_PROTECTION.minSends && rate >= threshold) {
      await moveStatus(c, CampaignStatus.BOUNCE_PROTECT, {}, "bounce_protect");
      return;
    }
  }
  const [pending] = await db
    .select({ n: sql<number>`count(*)` })
    .from(L)
    .where(and(eq(L.campaignId, c.id), inArray(L.status, [LeadStatus.ACTIVE, LeadStatus.PAUSED])));
  if (Number(pending?.n ?? 0) > 0) {
    if (c.status === CampaignStatus.RUNNING_SUBSEQUENCES) await moveStatus(c, CampaignStatus.ACTIVE);
    return;
  }
  if (c.isEvergreen) return;
  // A Lead Finder Agent keeps this campaign stocked: running out of leads is temporary.
  const [stocked] = await db
    .select({ id: schema.aiAgents.id })
    .from(schema.aiAgents)
    .where(and(eq(schema.aiAgents.type, 6), eq(schema.aiAgents.status, 1), sql`json_extract(${schema.aiAgents.payload}, '$.campaign_id') = ${c.id}`))
    .limit(1);
  if (stocked) return;
  // So does an active AI Sales Agent that finds its own leads.
  if (c.aiSdrId) {
    const [sdr] = await db.select({ status: schema.aiSalesAgents.status, config: schema.aiSalesAgents.config }).from(schema.aiSalesAgents).where(eq(schema.aiSalesAgents.id, c.aiSdrId)).limit(1);
    const manual = (sdr?.config as { autonomy_settings?: { manual_leads_mode?: boolean } } | undefined)?.autonomy_settings?.manual_leads_mode;
    if (sdr?.status === 1 && !manual) return;
  }
  const [total] = await db.select({ n: sql<number>`count(*)` }).from(L).where(eq(L.campaignId, c.id));
  if (!Number(total?.n ?? 0)) return;
  // Leads still going through a subsequence, including a paused one or paused leads (they carry on when resumed).
  const [inSubsequence] = await db
    .select({ n: sql<number>`count(*)` })
    .from(L)
    .innerJoin(schema.subsequences, eq(schema.subsequences.id, L.subsequenceId))
    .where(
      and(
        eq(L.campaignId, c.id),
        inArray(L.subseqStatus, [LeadStatus.ACTIVE, LeadStatus.PAUSED]),
        notInArray(L.status, ENDED),
        inArray(schema.subsequences.status, [CampaignStatus.ACTIVE, CampaignStatus.PAUSED]),
      ),
    );
  const status = Number(inSubsequence?.n ?? 0) > 0 ? CampaignStatus.RUNNING_SUBSEQUENCES : CampaignStatus.COMPLETED;
  if (status === c.status) return;
  if (!(await moveStatus(c, status, status === CampaignStatus.COMPLETED ? { completedAt: new Date(), notSendingStatus: null } : {}))) return;
  if (status === CampaignStatus.COMPLETED) {
    await enqueueWebhooks(c.workspaceId, "campaign_completed", { campaign_id: c.id, campaign_name: c.name }, { campaignId: c.id });
    emit("campaign_completed", c.workspaceId, { campaign_id: c.id });
  }
}

const settingsCache = new Map<string, { at: number; settings: Record<string, unknown> }>();
async function wsSettings(workspaceId: string) {
  const hit = settingsCache.get(workspaceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.settings;
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  const settings = (ws?.settings ?? {}) as Record<string, unknown>;
  settingsCache.set(workspaceId, { at: Date.now(), settings });
  return settings;
}

/**
 * Hosted workspaces stop sending when the trial ends or the plan's monthly emails run out: what's left is read once a
 * minute and counted down with every email in between, so a busy minute can't run past the plan.
 */
const planCache = new Map<string, { at: number; left: number }>();
async function planLeft(workspaceId: string): Promise<number> {
  const hit = planCache.get(workspaceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.left;
  const limits = await workspaceLimits(workspaceId);
  const left = limits.self_hosted || (!limits.trial_expired && limits.monthly_emails === null) ? Infinity : limits.trial_expired ? 0 : limits.monthly_emails! - (await monthlyEmailsSent(workspaceId));
  planCache.set(workspaceId, { at: Date.now(), left });
  return left;
}
function notePlanSend(workspaceId: string) {
  const hit = planCache.get(workspaceId);
  if (hit) hit.left--;
}

const SENDING = [CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES, CampaignStatus.ACCOUNTS_UNHEALTHY];

export async function runSender() {
  const due = await db.select({ id: schema.campaigns.id, workspaceId: schema.campaigns.workspaceId }).from(schema.campaigns).where(inArray(schema.campaigns.status, SENDING));
  // A deleted workspace, or one whose owner was turned off, sends nothing; its campaigns keep their state.
  const stopped = await stoppedWorkspaces();
  for (const { id, workspaceId } of due) {
    if (!keepSending()) return;
    if (stopped.has(workspaceId)) continue;
    try {
      // Read now, not when the pass started: sending for earlier campaigns can take a while, and this one may have been
      // paused, changed or deleted since.
      const [c] = await db
        .select()
        .from(schema.campaigns)
        .where(and(eq(schema.campaigns.id, id), inArray(schema.campaigns.status, SENDING)))
        .limit(1);
      if (!c) continue;
      const settings = await wsSettings(c.workspaceId);
      if ((await planLeft(c.workspaceId)) <= 0) {
        await setNotSending(c, CampaignNotSendingStatus.PLAN_LIMIT);
        continue;
      }
      // Recover campaigns paused for unhealthy accounts once a mailbox works again (and vice versa).
      const senders = await campaignSenders(c);
      if (senders.length) {
        const healthy = senders.some((a) => a.status === AccountStatus.ACTIVE);
        if (!healthy && c.status === CampaignStatus.ACTIVE && senders.every((a) => a.status < 0)) {
          await moveStatus(c, CampaignStatus.ACCOUNTS_UNHEALTHY, {}, "accounts_unhealthy");
          continue;
        }
        if (healthy && c.status === CampaignStatus.ACCOUNTS_UNHEALTHY) await moveStatus(c, CampaignStatus.ACTIVE);
      }
      if (c.status === CampaignStatus.ACCOUNTS_UNHEALTHY) continue;
      // Running subsequences too: leads added after the main sequence finished still get it.
      await processFlow(
        {
          kind: "campaign",
          campaign: c,
          sub: null,
          steps: activeSteps(c),
          schedule: c.schedule ?? DEFAULT_SCHEDULE,
          dailyLimit: c.dailyLimit ?? null,
          ignoreAccountLimit: false,
          autoVariant: c.autoVariantSelect,
        },
        settings,
      );
      const subs = await db
        .select()
        .from(schema.subsequences)
        .where(and(eq(schema.subsequences.parentCampaignId, c.id), eq(schema.subsequences.status, CampaignStatus.ACTIVE)));
      for (const sub of subs) {
        await processFlow(
          {
            kind: "subsequence",
            campaign: c,
            sub,
            steps: sub.sequences?.[0]?.steps ?? [],
            schedule: sub.schedule ?? c.schedule ?? DEFAULT_SCHEDULE,
            dailyLimit: sub.dailyLimitMode === "unlimited" ? null : sub.dailyLimitMode === "custom" ? (sub.dailyLimit ?? null) : (c.dailyLimit ?? null),
            ignoreAccountLimit: sub.ignoreAccountDailyLimit,
            autoVariant: sub.autoVariantSelect,
          },
          settings,
        );
      }
      if (keepSending()) await finalizeCampaign(c, settings);
    } catch (err) {
      console.error(`[sender] campaign ${id}`, err);
      noteSenderError(id, err);
    }
  }
}

/** Sends a one-off test of a step to an arbitrary address (no lead state changes). */
export async function sendTestEmail(opts: { account: AccountRow; to: string; subject: string; body: string; vars?: TemplateObject; textOnly?: boolean }) {
  const vars: TemplateObject = {
    ...senderVariables({ email: opts.account.email, first_name: opts.account.firstName, last_name: opts.account.lastName, signature: opts.account.signature }),
    ...timeVariables(new Date(), "UTC"),
    unsubscribe_url: "#",
    ...(opts.vars ?? {}),
  };
  const subject = renderTemplate(opts.subject, vars).output || "(no subject)";
  const html = renderTemplate(opts.body, vars, { escapeHtml: true }).output;
  if (blankEmail(html, !!opts.textOnly)) {
    const missing = emptyVariables(variableUses(opts.body), vars);
    throw badRequest(missing.length ? `This email comes out blank for this lead: there's nothing for ${missing.join(", ")}.` : "This email comes out blank. Write something first.");
  }
  const messageId = newMessageId(opts.account.email);
  await driverFor(opts.account).send({
    from: { name: `${opts.account.firstName} ${opts.account.lastName}`.trim(), address: opts.account.email },
    to: [{ address: opts.to }],
    subject,
    html: opts.textOnly ? null : html,
    text: opts.textOnly ? htmlToText(html) : null,
    messageId,
  });
  return { message_id: messageId, subject };
}

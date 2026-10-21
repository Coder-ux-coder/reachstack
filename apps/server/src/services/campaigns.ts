// Campaigns: validation schemas, serialization, sender resolution and analytics.
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  AccountStatus,
  CUSTOM_INTEREST_BASE,
  CampaignStatus,
  LeadStatus,
  TASK_STEP_KINDS,
  interestSentiment,
  isHolidayCountry,
  isTaskStep,
  taskStepProblem,
  validateBraces,
  type Campaign,
  type CampaignSchedule,
  type Sequence,
} from "@reachstack/shared";
import { db, schema } from "../db/client";
import { DEFAULT_SCHEDULE, iso, isValidZone } from "../lib/time";
import type { AccountRow } from "../mail/driver";
import { bounceRate, refusedAtSend } from "./bounce-report";
import { emit } from "./bus";
import { resourcesWithTags, tagsFor } from "./tags";
import { dayOn, daysBetween, daySql, workspaceZone, type DateRange } from "./workspace-clock";

export type CampaignRow = typeof schema.campaigns.$inferSelect;
export type SubsequenceRow = typeof schema.subsequences.$inferSelect;

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");
/** Days nothing goes out: public holidays of some countries, and dates of your own (sorted, without repeats). */
export const daysOffSchema = z
  .object({
    holidays: z.array(z.string().refine(isHolidayCountry, "Holidays aren't available for that country")).max(10).optional(),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")).max(366).optional(),
  })
  .transform((d) => ({ holidays: [...new Set(d.holidays ?? [])], dates: [...new Set(d.dates ?? [])].sort() }))
  .nullable()
  .optional();
/** A calendar day (YYYY-MM-DD), the way schedules compare dates; a date with a time keeps only its day, and "" clears it. */
const scheduleDay = z.preprocess(
  (v) => (v === "" ? null : v),
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Use a date like 2026-10-15")
    .transform((v) => v.slice(0, 10))
    .refine((v) => {
      const day = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(v);
    }, "That date doesn't exist")
    .nullable()
    .optional(),
);
export const scheduleSchema = z.object({
  start_date: scheduleDay,
  end_date: scheduleDay,
  schedules: z
    .array(
      z.object({
        name: z.string().trim().max(120).default("Schedule"),
        timing: z.object({ from: hm, to: hm }),
        days: z.record(z.enum(["0", "1", "2", "3", "4", "5", "6"]), z.boolean()),
        timezone: z.string().refine(isValidZone, "Unknown timezone"),
      }),
    )
    .min(1),
  days_off: daysOffSchema,
  lead_timezone: z.boolean().optional(),
});

/** A schedule as stored: days off only when there are some, and "each lead's timezone" only when it's on. */
export function storedSchedule(b: z.infer<typeof scheduleSchema>): CampaignSchedule {
  const off = b.days_off && (b.days_off.holidays.length || b.days_off.dates.length) ? b.days_off : null;
  return {
    start_date: b.start_date ?? null,
    end_date: b.end_date ?? null,
    schedules: b.schedules as CampaignSchedule["schedules"],
    ...(off ? { days_off: off } : {}),
    ...(b.lead_timezone ? { lead_timezone: true } : {}),
  };
}

export const variantSchema = z
  .object({ subject: z.string().max(2000).default(""), body: z.string().max(200_000).default(""), v_disabled: z.boolean().optional() })
  // A {{ left open would reach the lead as written.
  .superRefine((v, issue) => {
    const problem = validateBraces(`${v.subject}\n${v.body}`);
    if (problem) issue.addIssue({ code: "custom", message: problem, path: ["body"] });
  });
export const stepSchema = z
  .object({
    type: z.enum(["email", "task"]).default("email"),
    task: z.enum(TASK_STEP_KINDS).optional(),
    delay: z.number().min(0).max(10_000).default(0),
    delay_unit: z.enum(["minutes", "hours", "days"]).optional(),
    pre_delay: z.number().min(0).optional(),
    pre_delay_unit: z.enum(["minutes", "hours", "days"]).optional(),
    variants: z.array(variantSchema).min(1),
  })
  .refine((s) => s.type !== "task" || !!s.task, { message: "a task step needs a kind: linkedin_visit, linkedin_connect, linkedin_message, call or todo", path: ["task"] })
  // A task has one title and note; an email step has no task kind.
  .transform(({ task, ...s }) => (s.type === "task" ? { ...s, task, variants: s.variants.slice(0, 1).map((v) => ({ subject: v.subject, body: v.body })) } : s));
export const sequencesSchema = z.array(z.object({ steps: z.array(stepSchema) })).max(1);
/** A campaign opens with an email: it starts the conversation, and the thread its follow-ups reply in. */
const campaignSequencesSchema = sequencesSchema.refine((seq) => !isTaskStep(seq[0]?.steps[0]), {
  message: "A campaign starts with an email. Put task steps after it (a subsequence can start with one).",
  path: [0, "steps", 0, "type"],
});

const providerRule = z.object({
  action: z.enum(["send", "do_not_send"]),
  recipient_esp: z.array(z.enum(["all", "google", "outlook", "other"])),
  sender_esp: z.array(z.enum(["all", "google", "outlook", "other"])),
});

export const campaignFieldsSchema = z.object({
  name: z.string().trim().min(1).max(250),
  pl_value: z.number().nullable().optional(),
  is_evergreen: z.boolean().nullable().optional(),
  campaign_schedule: scheduleSchema,
  sequences: campaignSequencesSchema.optional(),
  email_gap: z.number().int().min(0).max(1440).nullable().optional(),
  random_wait_max: z.number().int().min(0).max(1440).nullable().optional(),
  text_only: z.boolean().nullable().optional(),
  first_email_text_only: z.boolean().nullable().optional(),
  email_list: z.array(z.string()).optional(),
  daily_limit: z.number().int().min(0).max(100_000).nullable().optional(),
  stop_on_reply: z.boolean().nullable().optional(),
  email_tag_list: z.array(z.string()).optional(),
  link_tracking: z.boolean().nullable().optional(),
  open_tracking: z.boolean().optional(),
  stop_on_auto_reply: z.boolean().nullable().optional(),
  daily_max_leads: z.number().int().min(0).nullable().optional(),
  prioritize_new_leads: z.boolean().nullable().optional(),
  auto_variant_select: z.object({ trigger: z.enum(["reply_rate", "click_rate", "open_rate"]) }).nullable().optional(),
  match_lead_esp: z.boolean().nullable().optional(),
  stop_for_company: z.boolean().nullable().optional(),
  insert_unsubscribe_header: z.boolean().nullable().optional(),
  allow_risky_contacts: z.boolean().nullable().optional(),
  disable_bounce_protect: z.boolean().nullable().optional(),
  limit_emails_per_company_override: z
    .object({ mode: z.enum(["custom", "disabled"]), daily_limit: z.number().int().min(1).optional(), scope: z.enum(["per_campaign", "across_workspace"]).optional() })
    .nullable()
    .optional(),
  cc_list: z.array(z.string()).optional(),
  bcc_list: z.array(z.string()).optional(),
  owned_by: z.string().nullable().optional(),
  ai_sdr_id: z.string().nullable().optional(),
  provider_routing_rules: z.array(providerRule).optional(),
  slow_ramp_up: z.boolean().nullable().optional(),
  custom_variables: z.record(z.unknown()).nullable().optional(),
});
export const createCampaignSchema = campaignFieldsSchema;
export const patchCampaignSchema = campaignFieldsSchema.partial();

export const DEFAULT_SEQUENCES: Sequence[] = [{ steps: [{ type: "email", delay: 2, delay_unit: "days", variants: [{ subject: "", body: "" }] }] }];

/** Maps API fields onto DB columns. Only keys present in `b` are returned. */
export function campaignColumns(b: z.infer<typeof patchCampaignSchema>): Partial<typeof schema.campaigns.$inferInsert> {
  const out: Partial<typeof schema.campaigns.$inferInsert> = {};
  const lowerList = (l?: string[]) => (l ? [...new Set(l.map((e) => e.trim().toLowerCase()).filter(Boolean))] : undefined);
  if (b.name !== undefined) out.name = b.name;
  if (b.pl_value !== undefined) out.plValue = b.pl_value;
  if (b.is_evergreen !== undefined) out.isEvergreen = b.is_evergreen;
  if (b.campaign_schedule !== undefined) out.schedule = storedSchedule(b.campaign_schedule);
  if (b.sequences !== undefined) out.sequences = b.sequences as Sequence[];
  if (b.email_gap !== undefined) out.emailGap = b.email_gap;
  if (b.random_wait_max !== undefined) out.randomWaitMax = b.random_wait_max;
  if (b.text_only !== undefined) out.textOnly = b.text_only;
  if (b.first_email_text_only !== undefined) out.firstEmailTextOnly = b.first_email_text_only;
  if (b.email_list !== undefined) out.emailList = lowerList(b.email_list)!;
  if (b.daily_limit !== undefined) out.dailyLimit = b.daily_limit;
  if (b.stop_on_reply !== undefined) out.stopOnReply = b.stop_on_reply;
  if (b.email_tag_list !== undefined) out.emailTagList = b.email_tag_list;
  if (b.link_tracking !== undefined) out.linkTracking = b.link_tracking;
  if (b.open_tracking !== undefined) out.openTracking = b.open_tracking;
  if (b.stop_on_auto_reply !== undefined) out.stopOnAutoReply = b.stop_on_auto_reply;
  if (b.daily_max_leads !== undefined) out.dailyMaxLeads = b.daily_max_leads;
  if (b.prioritize_new_leads !== undefined) out.prioritizeNewLeads = b.prioritize_new_leads;
  if (b.auto_variant_select !== undefined) out.autoVariantSelect = b.auto_variant_select;
  if (b.match_lead_esp !== undefined) out.matchLeadEsp = b.match_lead_esp;
  if (b.stop_for_company !== undefined) out.stopForCompany = b.stop_for_company;
  if (b.insert_unsubscribe_header !== undefined) out.insertUnsubscribeHeader = b.insert_unsubscribe_header;
  if (b.allow_risky_contacts !== undefined) out.allowRiskyContacts = b.allow_risky_contacts;
  if (b.disable_bounce_protect !== undefined) out.disableBounceProtect = b.disable_bounce_protect;
  if (b.limit_emails_per_company_override !== undefined) out.limitEmailsPerCompanyOverride = b.limit_emails_per_company_override as Campaign["limit_emails_per_company_override"];
  if (b.cc_list !== undefined) out.ccList = lowerList(b.cc_list)!;
  if (b.bcc_list !== undefined) out.bccList = lowerList(b.bcc_list)!;
  if (b.owned_by !== undefined) out.ownedBy = b.owned_by;
  if (b.ai_sdr_id !== undefined) out.aiSdrId = b.ai_sdr_id;
  if (b.provider_routing_rules !== undefined) out.providerRoutingRules = b.provider_routing_rules;
  if (b.slow_ramp_up !== undefined) out.slowRampUp = b.slow_ramp_up;
  if (b.custom_variables !== undefined) out.customVariables = b.custom_variables ? Object.keys(b.custom_variables) : null;
  return out;
}

export function serializeCampaign(c: CampaignRow, extra: { tags?: unknown[] } = {}): Campaign & Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    pl_value: c.plValue,
    is_evergreen: c.isEvergreen,
    campaign_schedule: c.schedule ?? DEFAULT_SCHEDULE,
    sequences: c.sequences?.length ? c.sequences : DEFAULT_SEQUENCES,
    timestamp_created: iso(c.createdAt)!,
    timestamp_updated: iso(c.updatedAt)!,
    email_gap: c.emailGap,
    random_wait_max: c.randomWaitMax,
    text_only: c.textOnly,
    first_email_text_only: c.firstEmailTextOnly,
    email_list: c.emailList ?? [],
    daily_limit: c.dailyLimit,
    stop_on_reply: c.stopOnReply,
    email_tag_list: c.emailTagList ?? [],
    link_tracking: c.linkTracking,
    open_tracking: c.openTracking,
    stop_on_auto_reply: c.stopOnAutoReply,
    daily_max_leads: c.dailyMaxLeads,
    prioritize_new_leads: c.prioritizeNewLeads,
    auto_variant_select: c.autoVariantSelect,
    match_lead_esp: c.matchLeadEsp,
    not_sending_status: c.notSendingStatus,
    stop_for_company: c.stopForCompany,
    insert_unsubscribe_header: c.insertUnsubscribeHeader,
    allow_risky_contacts: c.allowRiskyContacts,
    disable_bounce_protect: c.disableBounceProtect,
    bounce_grace_until: iso(c.bounceGraceUntil),
    limit_emails_per_company_override: c.limitEmailsPerCompanyOverride,
    cc_list: c.ccList ?? [],
    bcc_list: c.bccList ?? [],
    organization: c.workspaceId,
    owned_by: c.ownedBy,
    created_by: c.createdBy,
    ai_sdr_id: c.aiSdrId,
    provider_routing_rules: c.providerRoutingRules ?? [],
    slow_ramp_up: c.slowRampUp,
    core_variables: null,
    custom_variables: c.customVariables ? Object.fromEntries(c.customVariables.map((k) => [k, ""])) : null,
    timestamp_launched: iso(c.launchedAt),
    timestamp_last_send: iso(c.lastSendAt),
    ...(extra.tags ? { tags: extra.tags as string[] } : {}),
  };
}

export async function serializeCampaigns(workspaceId: string, rows: CampaignRow[]) {
  const tags = await tagsFor(workspaceId, rows.map((r) => r.id));
  return rows.map((r) => serializeCampaign(r, { tags: tags.get(r.id) ?? [] }));
}

export function activeSteps(c: Pick<CampaignRow, "sequences">) {
  return c.sequences?.[0]?.steps ?? [];
}

/** Whether a variant has something to send: text, or at least an image. */
export function hasEmailBody(v: { body?: string | null }): boolean {
  const body = v.body ?? "";
  return /<img\b/i.test(body) || !!body.replace(/<[^>]+>/g, "").replace(/&nbsp;|\u00a0/g, " ").trim();
}

/** Whether a variant can go out as written: something to send, and every {{ closed. */
export function sendableVariant(v: { subject?: string | null; body?: string | null }): boolean {
  return hasEmailBody(v) && !validateBraces(`${v.subject ?? ""}\n${v.body ?? ""}`);
}

/**
 * Problems that would make a sequence send blank emails, or create tasks that say nothing. Subsequences may leave the
 * subject empty (a reply in the thread).
 */
export function sequenceProblems(steps: ReturnType<typeof activeSteps>, opts: { firstNeedsSubject: boolean }): string[] {
  const problems: string[] = [];
  if (!steps.length) problems.push("Add at least one step to the sequence.");
  steps.forEach((s, i) => {
    if (isTaskStep(s)) {
      const problem = taskStepProblem(s, i + 1);
      if (problem) problems.push(problem);
      return;
    }
    const enabled = s.variants.filter((v) => !v.v_disabled);
    if (!enabled.length) problems.push(`Step ${i + 1} has no enabled variants.`);
    for (const v of enabled) {
      if (!hasEmailBody(v)) problems.push(`Step ${i + 1} has an empty email body.`);
      if (opts.firstNeedsSubject && i === 0 && !v.subject?.trim()) problems.push("The first step needs a subject line.");
      const braces = validateBraces(`${v.subject ?? ""}\n${v.body ?? ""}`);
      if (braces) problems.push(`Step ${i + 1}${s.variants.length > 1 ? ` variant ${String.fromCharCode(65 + s.variants.indexOf(v))}` : ""}: ${braces}`);
    }
  });
  return problems;
}

/** Validates a campaign before launch; returns human readable problems. */
export async function launchProblems(c: CampaignRow): Promise<string[]> {
  const problems = sequenceProblems(activeSteps(c), { firstNeedsSubject: true });
  const senders = await campaignSenders(c);
  if (!senders.length) problems.push("Select at least one sending account.");
  return [...new Set(problems)];
}

/** Sending accounts for a campaign: explicit email_list plus accounts carrying any of email_tag_list. */
export async function campaignSenders(c: Pick<CampaignRow, "workspaceId" | "emailList" | "emailTagList">, opts: { activeOnly?: boolean } = {}): Promise<AccountRow[]> {
  const emails = (c.emailList ?? []).map((e) => e.toLowerCase());
  const tagged = c.emailTagList?.length ? await resourcesWithTags(c.workspaceId, c.emailTagList, "any") : [];
  if (!emails.length && !tagged.length) return [];
  const conds: SQL[] = [eq(schema.emailAccounts.workspaceId, c.workspaceId)];
  const byEmail = emails.length ? inArray(schema.emailAccounts.email, emails) : null;
  const byTag = tagged.length ? inArray(schema.emailAccounts.id, tagged) : null;
  conds.push(byEmail && byTag ? sql`(${byEmail} or ${byTag})` : (byEmail ?? byTag)!);
  if (opts.activeOnly) {
    conds.push(eq(schema.emailAccounts.status, AccountStatus.ACTIVE));
    // Accounts whose campaign sending is paused (warmup continues) sit out until the pause ends.
    conds.push(or(isNull(schema.emailAccounts.campaignPauseUntil), lte(schema.emailAccounts.campaignPauseUntil, new Date()))!);
  }
  return db.select().from(schema.emailAccounts).where(and(...conds));
}

// ---------- Analytics ----------


const E = schema.emailEvents;

function eventRangeConds(workspaceId: string, campaignIds: string[] | null, r: DateRange): SQL[] {
  const conds: SQL[] = [eq(E.workspaceId, workspaceId)];
  if (campaignIds) conds.push(inArray(E.campaignId, campaignIds.length ? campaignIds : ["__none__"]));
  if (r.start !== undefined) conds.push(gte(E.createdAt, new Date(r.start)));
  if (r.end !== undefined) conds.push(lte(E.createdAt, new Date(r.end)));
  return conds;
}

const countIf = (type: string) => sql<number>`sum(case when ${E.type} = ${type} then 1 else 0 end)`;
const uniqueLeads = (type: string) => sql<number>`count(distinct case when ${E.type} = ${type} then ${E.leadId} end)`;
/** Leads whose email hard-bounced (soft bounces and delays are temporary and don't count). */
const hardBounced = sql<number>`count(distinct case when ${E.type} = 'bounce' and ${E.value} = 1 then ${E.leadId} end)`;
const uniqueLeadSteps = (type: string) => sql<number>`count(distinct case when ${E.type} = ${type} then ${E.leadId} || ':' || coalesce(${E.step}, -1) end)`;

const metricColumns = {
  emails_sent_count: countIf("sent"),
  /** Tries the receiving server refused at once: never sent (not in emails_sent_count), yet tried, and bounced. */
  emails_refused_count: sql<number>`sum(case when ${refusedAtSend} then 1 else 0 end)`,
  contacted_count: uniqueLeads("sent"),
  new_leads_contacted_count: sql<number>`sum(case when ${E.type} = 'sent' and ${E.isFirst} = 1 then 1 else 0 end)`,
  open_count: countIf("open"),
  open_count_unique: uniqueLeads("open"),
  open_count_unique_by_step: uniqueLeadSteps("open"),
  reply_count: countIf("reply"),
  reply_count_unique: uniqueLeads("reply"),
  reply_count_unique_by_step: uniqueLeadSteps("reply"),
  reply_count_automatic: countIf("auto_reply"),
  reply_count_automatic_unique: uniqueLeads("auto_reply"),
  reply_count_automatic_unique_by_step: uniqueLeadSteps("auto_reply"),
  link_click_count: countIf("click"),
  link_click_count_unique: uniqueLeads("click"),
  link_click_count_unique_by_step: uniqueLeadSteps("click"),
  bounced_count: hardBounced,
  unsubscribed_count: uniqueLeads("unsubscribe"),
  total_opportunities: uniqueLeads("opportunity"),
  total_opportunity_value: sql<number>`coalesce(sum(case when ${E.type} = 'opportunity' then ${E.value} else 0 end), 0)`,
};

type MetricKey = keyof typeof metricColumns;
export type Metrics = Record<MetricKey, number>;

function numberify<T extends Record<string, unknown>>(row: T | undefined, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = Number((row as Record<string, unknown> | undefined)?.[k] ?? 0);
  return out;
}

/** Totals for a set of campaigns (the whole workspace when campaignIds is null), their subsequences' emails included; or for one subsequence. */
export async function aggregateMetrics(workspaceId: string, campaignIds: string[] | null, r: DateRange, subsequenceId?: string): Promise<Metrics> {
  const conds = eventRangeConds(workspaceId, campaignIds, r);
  if (subsequenceId) conds.push(eq(E.subsequenceId, subsequenceId));
  const [row] = await db.select(metricColumns).from(E).where(and(...conds));
  return numberify(row, Object.keys(metricColumns)) as Metrics;
}

/** Per-campaign metrics map. */
export async function metricsByCampaign(workspaceId: string, campaignIds: string[], r: DateRange): Promise<Map<string, Metrics>> {
  if (!campaignIds.length) return new Map();
  const rows = await db
    .select({ campaignId: E.campaignId, ...metricColumns })
    .from(E)
    .where(and(...eventRangeConds(workspaceId, campaignIds, r)))
    .groupBy(E.campaignId);
  return new Map(rows.map((row) => [row.campaignId!, numberify(row, Object.keys(metricColumns)) as Metrics]));
}

/** Lead counts per campaign (total / completed / by status). */
/**
 * A campaign's leads by where they are. `done`: no email left to send them (finished, replied, bounced, unsubscribed or
 * skipped), the same test that completes a campaign, so a completed campaign is always 100% done.
 */
export interface LeadCounts {
  total: number;
  completed: number;
  active: number;
  paused: number;
  bounced: number;
  unsubscribed: number;
  contacted: number;
  done: number;
}

/** Lead counts of the workspace's campaigns (ids of another workspace's count nothing). */
export async function leadCounts(workspaceId: string, campaignIds: string[]) {
  if (!campaignIds.length) return new Map<string, LeadCounts>();
  const L = schema.leads;
  const rows = await db
    .select({
      campaignId: L.campaignId,
      total: sql<number>`count(*)`,
      completed: sql<number>`sum(case when ${L.status} = ${LeadStatus.COMPLETED} then 1 else 0 end)`,
      active: sql<number>`sum(case when ${L.status} = ${LeadStatus.ACTIVE} then 1 else 0 end)`,
      paused: sql<number>`sum(case when ${L.status} = ${LeadStatus.PAUSED} then 1 else 0 end)`,
      bounced: sql<number>`sum(case when ${L.status} = ${LeadStatus.BOUNCED} then 1 else 0 end)`,
      unsubscribed: sql<number>`sum(case when ${L.status} = ${LeadStatus.UNSUBSCRIBED} then 1 else 0 end)`,
      contacted: sql<number>`sum(case when ${L.lastContactAt} is not null then 1 else 0 end)`,
    })
    .from(L)
    .where(and(eq(L.workspaceId, workspaceId), inArray(L.campaignId, campaignIds)))
    .groupBy(L.campaignId);
  return new Map<string, LeadCounts>(
    rows.map((r) => [
      r.campaignId!,
      {
        total: Number(r.total),
        completed: Number(r.completed),
        active: Number(r.active),
        paused: Number(r.paused),
        bounced: Number(r.bounced),
        unsubscribed: Number(r.unsubscribed),
        contacted: Number(r.contacted),
        done: Number(r.total) - Number(r.active) - Number(r.paused),
      } satisfies LeadCounts,
    ]),
  );
}

/** Opportunity counts by current interest status, for overview cards. */
/**
 * Leads at each stage of the funnel in the period, from events. Lead statuses 1-4 are ordered (interested, meeting
 * booked, meeting completed, won), so a lead counts toward every stage up to the furthest it reached: a win also
 * counts as a meeting, even if nobody set the meeting status first. A positive label of your own counts as interest,
 * as it does for opportunities; it has no place in the order after that.
 */
export async function funnelCounts(workspaceId: string, campaignIds: string[] | null, r: DateRange) {
  const reached = (stage: number) => sql<number>`count(distinct case when ${E.type} = 'interest_change' and ${E.value} between ${stage} and 4 then ${E.leadId} end)`;
  const ownPositive = sql`${E.value} between ${CUSTOM_INTEREST_BASE.positive} and ${CUSTOM_INTEREST_BASE.neutral - 1}`;
  const columns = {
    contacted: uniqueLeads("sent"),
    opened: uniqueLeads("open"),
    clicked: uniqueLeads("click"),
    replied: uniqueLeads("reply"),
    replied_with_auto: sql<number>`count(distinct case when ${E.type} in ('reply', 'auto_reply') then ${E.leadId} end)`,
    interested: sql<number>`count(distinct case when ${E.type} = 'interest_change' and (${E.value} between 1 and 4 or ${ownPositive}) then ${E.leadId} end)`,
    meeting_booked: reached(2),
    meeting_completed: reached(3),
    won: reached(4),
  };
  const [row] = await db.select(columns).from(E).where(and(...eventRangeConds(workspaceId, campaignIds, r)));
  return numberify(row, Object.keys(columns)) as Record<keyof typeof columns, number>;
}

/** Leads by status, set in the period (a status the sync copied over from the person's lead elsewhere counts there only). */
export async function interestTotals(workspaceId: string, campaignIds: string[] | null, r: DateRange) {
  const L = schema.leads;
  const conds: SQL[] = [eq(L.workspaceId, workspaceId), isNotNull(L.interestStatus), eq(L.interestSynced, false)];
  if (campaignIds) conds.push(inArray(L.campaignId, campaignIds.length ? campaignIds : ["__none__"]));
  if (r.start !== undefined) conds.push(gte(L.lastInterestChangeAt, new Date(r.start)));
  if (r.end !== undefined) conds.push(lte(L.lastInterestChangeAt, new Date(r.end)));
  const rows = await db.select({ s: L.interestStatus, n: sql<number>`count(*)` }).from(L).where(and(...conds)).groupBy(L.interestStatus);
  const by = new Map(rows.map((x) => [x.s, Number(x.n)]));
  let positive = 0;
  for (const [s, n] of by) if (interestSentiment(s) === "positive") positive += n;
  return {
    total_interested: by.get(1) ?? 0,
    total_meeting_booked: by.get(2) ?? 0,
    total_meeting_completed: by.get(3) ?? 0,
    total_closed: by.get(4) ?? 0,
    total_positive: positive,
  };
}

/**
 * Every status change in the period instead of each lead once (the overview's expand_crm_events): a lead that went from
 * interested to meeting booked to won counts at each, and each time it turned positive is an opportunity.
 */
export async function interestChangeTotals(workspaceId: string, campaignIds: string[] | null, r: DateRange) {
  const changedTo = (v: number) => sql<number>`sum(case when ${E.type} = 'interest_change' and ${E.value} = ${v} then 1 else 0 end)`;
  const [row] = await db
    .select({ opportunities: countIf("opportunity"), interested: changedTo(1), booked: changedTo(2), completed: changedTo(3), closed: changedTo(4) })
    .from(E)
    .where(and(...eventRangeConds(workspaceId, campaignIds, r), inArray(E.type, ["interest_change", "opportunity"])));
  return {
    total_opportunities: Number(row?.opportunities ?? 0),
    total_interested: Number(row?.interested ?? 0),
    total_meeting_booked: Number(row?.booked ?? 0),
    total_meeting_completed: Number(row?.completed ?? 0),
    total_closed: Number(row?.closed ?? 0),
  };
}

/** Figures per day on the period's clock, for campaigns (their subsequences' emails included) or one subsequence. */
export async function dailyMetrics(workspaceId: string, campaignIds: string[] | null, r: DateRange, subsequenceId?: string) {
  const day = daySql(E.createdAt, r);
  const conds = eventRangeConds(workspaceId, campaignIds, r);
  if (subsequenceId) conds.push(eq(E.subsequenceId, subsequenceId));
  const rows = await db
    .select({
      date: day,
      sent: countIf("sent"),
      contacted: uniqueLeads("sent"),
      new_leads_contacted: sql<number>`sum(case when ${E.type} = 'sent' and ${E.isFirst} = 1 then 1 else 0 end)`,
      opened: countIf("open"),
      unique_opened: uniqueLeads("open"),
      replies: countIf("reply"),
      unique_replies: uniqueLeads("reply"),
      replies_automatic: countIf("auto_reply"),
      unique_replies_automatic: uniqueLeads("auto_reply"),
      clicks: countIf("click"),
      unique_clicks: uniqueLeads("click"),
      opportunities: countIf("opportunity"),
      unique_opportunities: uniqueLeads("opportunity"),
      bounced: hardBounced,
    })
    .from(E)
    .where(and(...conds))
    .groupBy(day)
    .orderBy(day);
  return rows.map((row) => ({ date: row.date, ...numberify(row, Object.keys(row).filter((k) => k !== "date")) }));
}

export async function stepMetrics(workspaceId: string, campaignIds: string[] | null, r: DateRange, includeOpportunities: boolean, subsequenceId?: string) {
  const conds = eventRangeConds(workspaceId, campaignIds, r);
  // Subsequence emails have their own steps; they'd otherwise count as the campaign's step 1, 2…
  conds.push(subsequenceId ? eq(E.subsequenceId, subsequenceId) : isNull(E.subsequenceId));
  const rows = await db
    .select({
      step: E.step,
      variant: E.variant,
      sent: countIf("sent"),
      opened: countIf("open"),
      unique_opened: uniqueLeads("open"),
      replies: countIf("reply"),
      unique_replies: uniqueLeads("reply"),
      replies_automatic: countIf("auto_reply"),
      unique_replies_automatic: uniqueLeads("auto_reply"),
      clicks: countIf("click"),
      unique_clicks: uniqueLeads("click"),
      bounced: hardBounced,
      tasks_done: countIf("task_done"),
      tasks_skipped: countIf("task_skipped"),
    })
    .from(E)
    .where(and(...conds, sql`${E.type} in ('sent','open','reply','auto_reply','click','bounce','task_done','task_skipped')`))
    .groupBy(E.step, E.variant)
    .orderBy(E.step, E.variant);
  type Opps = { opportunities: number; unique_opportunities: number; meetings_booked: number; won: number };
  const keyOf = (step: number | null, variant: number | null) => `${step}:${variant ?? "-"}`;
  const opp = new Map<string, Opps & { step: number | null; variant: number | null }>();
  if (includeOpportunities) {
    // Leads that turned positive in the period, credited to the email their first reply answered (one of this
    // campaign's own steps, not a subsequence's). A status the sync copied over isn't a conversion here.
    const L = schema.leads;
    const lconds: SQL[] = [eq(L.workspaceId, workspaceId), isNotNull(L.interestStatus), eq(L.interestSynced, false)];
    if (campaignIds) lconds.push(inArray(L.campaignId, campaignIds.length ? campaignIds : ["__none__"]));
    if (r.start !== undefined) lconds.push(gte(L.lastInterestChangeAt, new Date(r.start)));
    if (r.end !== undefined) lconds.push(lte(L.lastInterestChangeAt, new Date(r.end)));
    const leads = await db
      .select({ step: E.step, variant: E.variant, s: L.interestStatus })
      .from(L)
      .innerJoin(E, and(eq(E.leadId, L.id), eq(E.type, "reply"), eq(E.isFirst, true), eq(E.campaignId, L.campaignId), isNull(E.subsequenceId)))
      .where(and(...lconds));
    for (const l of leads) {
      if (interestSentiment(l.s) !== "positive" || l.step === null) continue;
      const key = keyOf(l.step, l.variant);
      const cur = opp.get(key) ?? { step: l.step, variant: l.variant, opportunities: 0, unique_opportunities: 0, meetings_booked: 0, won: 0 };
      cur.opportunities++;
      cur.unique_opportunities++;
      if (l.s === 2) cur.meetings_booked++;
      if (l.s === 4) cur.won++;
      opp.set(key, cur);
    }
  }
  const none: Opps = { opportunities: 0, unique_opportunities: 0, meetings_booked: 0, won: 0 };
  const oppsOf = (key: string): Opps => {
    const o = opp.get(key);
    return o ? { opportunities: o.opportunities, unique_opportunities: o.unique_opportunities, meetings_booked: o.meetings_booked, won: o.won } : none;
  };
  const COUNTS = ["sent", "opened", "unique_opened", "replies", "unique_replies", "replies_automatic", "unique_replies_automatic", "clicks", "unique_clicks", "bounced", "tasks_done", "tasks_skipped"] as const;
  const out = rows.map((row) => ({
    step: row.step === null ? null : String(row.step),
    variant: row.variant === null ? null : String(row.variant),
    ...numberify(row, [...COUNTS]),
    ...(includeOpportunities ? oppsOf(keyOf(row.step, row.variant)) : {}),
  }));
  // A step whose emails went out before the period still shows the leads that turned positive in it.
  const shown = new Set(rows.map((row) => keyOf(row.step, row.variant)));
  const zeros = Object.fromEntries(COUNTS.map((k) => [k, 0])) as Record<(typeof COUNTS)[number], number>;
  for (const [key, o] of opp) if (!shown.has(key)) out.push({ step: String(o.step), variant: o.variant === null ? null : String(o.variant), ...zeros, ...oppsOf(key) });
  // In step and variant order, with figures whose variant isn't known after a step's variants.
  const order = (v: string | null) => (v === null ? Infinity : Number(v));
  return out.sort((a, b) => order(a.step) - order(b.step) || order(a.variant) - order(b.variant));
}

/** Campaigns a lead email belongs to (search-by-contact). */
export async function campaignsForContact(workspaceId: string, email: string) {
  const ids = (
    await db
      .select({ id: schema.leads.campaignId })
      .from(schema.leads)
      .where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.email, email.toLowerCase()), isNotNull(schema.leads.campaignId)))
  ).map((r) => r.id!);
  if (!ids.length) return [];
  return db.select().from(schema.campaigns).where(inArray(schema.campaigns.id, ids)).orderBy(desc(schema.campaigns.createdAt));
}

export const CAMPAIGN_STATUS_ALLOWED_FOR_SENDING = [CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES] as number[];

/** A new campaign's schedule: weekdays 9 to 5 on the workspace's clock (Settings → Preferences → Workspace timezone). */
async function defaultSchedule(wsId: string): Promise<CampaignSchedule> {
  const zone = await workspaceZone(wsId);
  return { ...DEFAULT_SCHEDULE, schedules: DEFAULT_SCHEDULE.schedules.map((w) => ({ ...w, timezone: zone })) };
}

/** Inserts a draft campaign with sensible defaults for anything not provided. */
export async function insertCampaign(wsId: string, userId: string | null, values: Partial<typeof schema.campaigns.$inferInsert> & { name: string }) {
  const [row] = await db
    .insert(schema.campaigns)
    .values({
      workspaceId: wsId,
      sequences: DEFAULT_SEQUENCES,
      emailList: [],
      emailTagList: [],
      ccList: [],
      bccList: [],
      createdBy: userId,
      ownedBy: userId,
      ...values,
      // After the given values, so one left undefined still gets the default.
      schedule: values.schedule ?? (await defaultSchedule(wsId)),
      status: CampaignStatus.DRAFT,
    })
    .returning();
  return row!;
}

/**
 * Bounce protection: a campaign pauses when its hard-bounce rate over the last 7 days reaches the workspace's
 * threshold, once it has sent at least 200 emails in that time. Resuming it gives 7 days' grace.
 */
export const BOUNCE_PROTECTION = { windowDays: 7, minSends: 200, graceDays: 7, defaultThreshold: 5 } as const;

/**
 * Hard bounces over the week up to `until`, out of the emails the campaign sent or tried to send: an address whose mail
 * server refused it at once never got a "sent" event, yet it was a try that bounced. A bounce notice the app couldn't
 * match to an email counts as a bounce, not as another try.
 */
export async function recentBounceStats(campaignId: string, until = Date.now()) {
  const since = new Date(until - BOUNCE_PROTECTION.windowDays * 86_400_000);
  const [row] = await db
    .select({
      sent: countIf("sent"),
      refused: sql<number>`sum(case when ${refusedAtSend} then 1 else 0 end)`,
      bounced: sql<number>`sum(case when ${E.type} = 'bounce' and ${E.value} = 1 then 1 else 0 end)`,
    })
    .from(E)
    .where(and(eq(E.campaignId, campaignId), gte(E.createdAt, since), lte(E.createdAt, new Date(until))));
  const sent = Number(row?.sent ?? 0) + Number(row?.refused ?? 0);
  const bounced = Number(row?.bounced ?? 0);
  return { sent, bounced, rate: bounceRate(bounced, sent) };
}

/**
 * The figures behind a bounce-protection pause, however long ago it was: the week up to the campaign's last send or
 * bounce, which is when protection judged it, rather than the week up to now, which empties as the days pass.
 */
export async function pausedBounceStats(campaignId: string) {
  const [last] = await db
    .select({ at: sql<number | null>`max(${E.createdAt})` })
    .from(E)
    .where(and(eq(E.campaignId, campaignId), inArray(E.type, ["sent", "bounce"])));
  return recentBounceStats(campaignId, last?.at ? Number(last.at) : Date.now());
}

/**
 * A campaign's daily limit with its slow ramp-up: 20 emails on the day it launched and 20 more each day after, up to
 * `limit` (no limit: the ramp's). `zone` is its workspace's clock.
 */
export function rampedDailyLimit(c: Pick<CampaignRow, "slowRampUp" | "launchedAt">, limit: number | null, zone: string, at = Date.now()): number | null {
  if (!c.slowRampUp || !c.launchedAt) return limit;
  const ramp = 20 * (Math.max(0, daysBetween(dayOn(zone, c.launchedAt), dayOn(zone, at))) + 1);
  return limit === null ? ramp : Math.min(limit, ramp);
}

/** A finished campaign runs again for its subsequences (a lead just went into one), announced like any status change. */
export async function reopenForSubsequences(workspaceId: string, campaignId: string) {
  const [row] = await db
    .update(schema.campaigns)
    .set({ status: CampaignStatus.RUNNING_SUBSEQUENCES })
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.status, CampaignStatus.COMPLETED)))
    .returning({ id: schema.campaigns.id });
  if (row) emit("campaign_status_changed", workspaceId, { campaign_id: campaignId, status: CampaignStatus.RUNNING_SUBSEQUENCES, previous: CampaignStatus.COMPLETED });
}

export async function setCampaignStatus(c: CampaignRow, status: number) {
  const patch: Partial<typeof schema.campaigns.$inferInsert> = { status, notSendingStatus: null };
  if (status === CampaignStatus.ACTIVE && !c.launchedAt) patch.launchedAt = new Date();
  // Someone looked at a bounce pause and resumed: protection waits a week instead of pausing again at once.
  if (status === CampaignStatus.ACTIVE && c.status === CampaignStatus.BOUNCE_PROTECT) patch.bounceGraceUntil = new Date(Date.now() + BOUNCE_PROTECTION.graceDays * 86_400_000);
  // A finished campaign resumed for leads added since: it finishes again once they're done.
  if (status === CampaignStatus.ACTIVE && c.status === CampaignStatus.COMPLETED) patch.completedAt = null;
  const [row] = await db.update(schema.campaigns).set(patch).where(eq(schema.campaigns.id, c.id)).returning();
  emit("campaign_status_changed", c.workspaceId, { campaign_id: c.id, status, previous: c.status });
  return row!;
}

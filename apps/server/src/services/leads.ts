// Leads: serialization, filtering (API filters + smart-view queries), bulk add with dedupe/blocklist, move/copy, delete
// (into Recently deleted).
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  EmailType,
  EsgCode,
  EspCode,
  FREE_MAIL_DOMAINS,
  LeadStatus,
  MAX_LEAD_RULES,
  VerificationStatus,
  domainOf,
  emailFromCell,
  inferLeadTimezone,
  isValidEmailSyntax,
  parseTimezone,
  type Lead,
  type LeadEditField,
} from "@reachstack/shared";
import { db, schema } from "../db/client";
import { badRequest, notFound, paymentRequired } from "../http/errors";
import { chunk } from "../http/util";
import { uuidv7 } from "../lib/ids";
import { iso } from "../lib/time";
import type { Actor } from "./audit";
import { emit } from "./bus";
import { chargeCredits, uploadedContacts, workspaceLimits } from "./billing-limits";
import { dealsFollowOwner, flowConditions, type FlowQuery } from "./crm";
import { createJob } from "./jobs";
import { findSavedView, leadRuleSchema, leadSortSchema, presetConditions, ruleCondition, searchCondition, viewRules } from "./lead-filters";
import { workspaceZone } from "./workspace-clock";
import { trashLeads } from "./recently-deleted";

export type LeadRow = typeof schema.leads.$inferSelect;
const L = schema.leads;

export function serializeLead(l: LeadRow): Lead & Record<string, unknown> {
  return {
    id: l.id,
    timestamp_created: iso(l.createdAt)!,
    timestamp_updated: iso(l.updatedAt)!,
    organization: l.workspaceId,
    campaign: l.campaignId,
    list_id: l.listId,
    status: l.status,
    email: l.email,
    personalization: l.personalization,
    website: l.website,
    last_name: l.lastName,
    first_name: l.firstName,
    company_name: l.companyName,
    job_title: l.jobTitle,
    phone: l.phone,
    linkedin_url: l.linkedinUrl,
    location: l.location,
    email_open_count: l.openCount,
    email_reply_count: l.replyCount,
    email_click_count: l.clickCount,
    company_domain: l.companyDomain,
    status_summary: {
      lastStep: l.lastStepId ? { from: l.lastStepFrom ?? "campaign", stepID: l.lastStepId, timestamp_executed: iso(l.lastStepAt) ?? "" } : undefined,
      domain_complete: false,
    },
    payload: l.payload,
    last_step_from: l.lastStepFrom,
    last_step_id: l.lastStepId,
    last_step_timestamp_executed: iso(l.lastStepAt),
    email_opened_step: l.openedStep,
    email_opened_variant: l.openedVariant,
    email_replied_step: l.repliedStep,
    email_replied_variant: l.repliedVariant,
    email_clicked_step: l.clickedStep,
    email_clicked_variant: l.clickedVariant,
    lt_interest_status: l.interestStatus,
    subsequence_id: l.subsequenceId,
    verification_status: l.verificationStatus,
    pl_value_lead: l.plValueLead,
    timestamp_added_subsequence: iso(l.addedSubsequenceAt),
    timestamp_last_contact: iso(l.lastContactAt),
    timestamp_last_open: iso(l.lastOpenAt),
    timestamp_last_reply: iso(l.lastReplyAt),
    timestamp_last_interest_change: iso(l.lastInterestChangeAt),
    timestamp_last_click: iso(l.lastClickAt),
    timestamp_last_touch: iso(l.lastTouchAt),
    enrichment_status: l.enrichmentStatus,
    last_contacted_from: l.lastStepFrom,
    uploaded_by_user: l.uploadedByUser,
    upload_method: l.uploadMethod,
    assigned_to: l.assignedTo,
    is_website_visitor: l.isWebsiteVisitor,
    esp_code: l.espCode,
    esg_code: l.esgCode,
    timezone: l.timezone,
    next_step: l.nextStep,
    timestamp_next_send: iso(l.nextSendAt),
  };
}

export const smartQuerySchema = z.object({
  actionType: z.enum(["reply", "email-open", "last-contacted", "link-click", "lead-status", "lead-status-change"]),
  values: z
    .object({
      "occurrence-days": z.number().optional(),
      "occurrence-count": z.object({ condition: z.enum(["more", "less", "equal"]), count: z.number() }).optional(),
      "lead-status": z.object({ status: z.number().nullable(), condition: z.enum(["is", "is-not"]) }).optional(),
    })
    .passthrough(),
});

export const leadFilterSchema = z.object({
  search: z.string().optional(),
  filter: z.string().optional(),
  campaign: z.string().optional(),
  list_id: z.string().optional(),
  in_campaign: z.boolean().optional(),
  in_list: z.boolean().optional(),
  ids: z.array(z.string()).optional(),
  excluded_ids: z.array(z.string()).optional(),
  contacts: z.array(z.string()).optional(),
  queries: z.array(smartQuerySchema).optional(),
  smart_view_id: z.string().optional(),
  is_website_visitor: z.boolean().optional(),
  enrichment_status: z.number().optional(),
  esg_code: z.string().optional(),
  esp_code: z.number().optional(),
  assigned_to: z.string().optional(),
  interest_status: z.number().nullable().optional(),
  subsequence_id: z.string().optional(),
  status: z.number().optional(),
  /** Filter builder rules, all of which must match (see services/lead-filters.ts). */
  rules: z.array(leadRuleSchema).max(MAX_LEAD_RULES).optional(),
  ...leadSortSchema,
});
export type LeadFilter = z.infer<typeof leadFilterSchema>;

/** True when a request narrows the leads down by anything (bulk deletes refuse requests that don't). */
export const isFiltered = (f: LeadFilter) =>
  !!(f.ids?.length || f.campaign || f.list_id || f.search || f.filter || f.interest_status !== undefined || f.rules?.length || f.smart_view_id || f.queries?.length || f.contacts?.length);

function eventCountSubquery(type: string, days: number | undefined) {
  const e = schema.emailEvents;
  const since = days ? Date.now() - days * 86_400_000 : 0;
  return sql<number>`(select count(*) from ${e} where ${e.leadId} = ${L.id} and ${e.type} = ${type} and ${e.createdAt} >= ${since})`;
}

function smartQueryCondition(q: z.infer<typeof smartQuerySchema>): SQL | null {
  const days = q.values["occurrence-days"];
  const count = q.values["occurrence-count"];
  const compare = (expr: SQL<number>) => {
    if (!count) return sql`${expr} > 0`;
    if (count.condition === "more") return sql`${expr} > ${count.count}`;
    if (count.condition === "less") return sql`${expr} < ${count.count}`;
    return sql`${expr} = ${count.count}`;
  };
  switch (q.actionType) {
    case "reply":
      return compare(eventCountSubquery("reply", days));
    case "email-open":
      return compare(eventCountSubquery("open", days));
    case "link-click":
      return compare(eventCountSubquery("click", days));
    case "last-contacted":
      return days ? gte(L.lastContactAt, new Date(Date.now() - days * 86_400_000)) : isNotNull(L.lastContactAt);
    case "lead-status": {
      const s = q.values["lead-status"];
      if (!s) return null;
      if (s.status === null) return s.condition === "is" ? isNull(L.interestStatus) : isNotNull(L.interestStatus);
      return s.condition === "is" ? eq(L.interestStatus, s.status) : or(isNull(L.interestStatus), ne(L.interestStatus, s.status))!;
    }
    case "lead-status-change":
      return days ? gte(L.lastInterestChangeAt, new Date(Date.now() - days * 86_400_000)) : isNotNull(L.lastInterestChangeAt);
  }
}

/** Translates the API lead filter into SQL conditions. */
export async function leadConditions(wsId: string, f: LeadFilter): Promise<SQL[]> {
  const conds: SQL[] = [eq(L.workspaceId, wsId)];
  if (f.campaign) conds.push(eq(L.campaignId, f.campaign));
  if (f.list_id) conds.push(eq(L.listId, f.list_id));
  if (f.in_campaign === true) conds.push(isNotNull(L.campaignId));
  if (f.in_campaign === false) conds.push(isNull(L.campaignId));
  if (f.in_list === true) conds.push(isNotNull(L.listId));
  if (f.in_list === false) conds.push(isNull(L.listId));
  if (f.ids?.length) conds.push(inArray(L.id, f.ids));
  if (f.excluded_ids?.length) conds.push(notInArray(L.id, f.excluded_ids));
  if (f.contacts?.length) conds.push(inArray(L.email, f.contacts.map((c) => c.toLowerCase())));
  if (f.is_website_visitor !== undefined) conds.push(eq(L.isWebsiteVisitor, f.is_website_visitor));
  if (f.enrichment_status !== undefined) conds.push(eq(L.enrichmentStatus, f.enrichment_status));
  if (f.esp_code !== undefined) conds.push(eq(L.espCode, f.esp_code));
  if (f.esg_code && f.esg_code !== "all") conds.push(f.esg_code === "none" ? eq(L.esgCode, EsgCode.NONE) : eq(L.esgCode, Number(f.esg_code)));
  if (f.assigned_to) conds.push(eq(L.assignedTo, f.assigned_to));
  if (f.subsequence_id) conds.push(eq(L.subsequenceId, f.subsequence_id));
  if (f.status !== undefined) conds.push(eq(L.status, f.status));
  if (f.interest_status !== undefined) conds.push(f.interest_status === null ? isNull(L.interestStatus) : eq(L.interestStatus, f.interest_status));
  if (f.search) conds.push(searchCondition(f.search));
  conds.push(...presetConditions(f.filter));
  const zone = f.rules?.length || f.smart_view_id ? await workspaceZone(wsId) : "UTC";
  for (const rule of f.rules ?? []) conds.push(ruleCondition(rule, zone));
  let queries = f.queries ?? [];
  if (f.smart_view_id) {
    // A saved view of the leads tables (its rules), an older smart view (activity queries), or a Salesflow.
    const view = await findSavedView(wsId, f.smart_view_id);
    if (view) {
      const rules = viewRules(view);
      if (rules) conds.push(...rules.map((r) => ruleCondition(r, zone)));
      else queries = [...queries, ...(z.array(smartQuerySchema).safeParse(view.filters).data ?? [])];
    } else {
      const [flow] = await db.select().from(schema.salesFlows).where(and(eq(schema.salesFlows.id, f.smart_view_id), eq(schema.salesFlows.workspaceId, wsId))).limit(1);
      // An unknown view must never widen a bulk action to every lead.
      if (!flow) throw notFound("Saved view");
      conds.push(isNotNull(L.email), ...flowConditions(wsId, flow.queries as FlowQuery[]));
      if (flow.campaignId) conds.push(eq(L.campaignId, flow.campaignId));
      if (flow.listId === "all-lists") conds.push(isNotNull(L.listId));
      else if (flow.listId) conds.push(eq(L.listId, flow.listId));
    }
  }
  for (const q of queries) {
    const c = smartQueryCondition(q);
    if (c) conds.push(c);
  }
  return conds;
}

// ---------- Bulk add ----------

export const leadInputSchema = z.object({
  email: z.string().trim().toLowerCase().nullable().optional(),
  personalization: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
  company_domain: z.string().nullable().optional(),
  job_title: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  /** An IANA name (America/New_York), an abbreviation (EST) or an offset (UTC+2); worked out from the rest when left out. */
  timezone: z.string().nullable().optional(),
  lt_interest_status: z.number().nullable().optional(),
  pl_value_lead: z.string().nullable().optional(),
  assigned_to: z.string().nullable().optional(),
  custom_variables: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type LeadInput = z.infer<typeof leadInputSchema>;

export interface AddLeadsOptions {
  workspaceId: string;
  campaignId?: string | null;
  listId?: string | null;
  leads: LeadInput[];
  userId?: string | null;
  uploadMethod?: "manual" | "api" | "website-visitor" | "lead-finder" | "lead-finder-agent" | "csv" | "sheet" | "automation";
  assignedTo?: string | null;
  skipIfInWorkspace?: boolean;
  skipIfInCampaign?: boolean;
  skipIfInList?: boolean;
  /** Skip the blocklist check (only for internal moves of already-checked leads). */
  skipBlocklist?: boolean;
  isWebsiteVisitor?: boolean;
  verifyOnImport?: boolean;
  /** The import this part belongs to (its job id): automations on "Lead added" count runs per import, not per part. */
  batchId?: string | null;
}

export interface AddLeadsResult {
  status: "success";
  total_sent: number;
  leads_uploaded: number;
  in_blocklist: number;
  blocklist_used: string | null;
  duplicated_leads: number;
  skipped_count: number;
  invalid_email_count: number;
  incomplete_count: number;
  duplicate_email_count: number;
  remaining_in_plan: number | null;
  /** Rows left out because the plan's contact limit was reached. */
  over_plan_limit: number;
  created_leads: Array<{ index: number; id: string; email: string | null; first_name: string | null; last_name: string | null; phone: string | null }>;
}

export async function blockedSet(workspaceId: string, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!emails.length) return out;
  const domains = [...new Set(emails.map(domainOf).filter(Boolean))];
  for (const part of chunk([...emails, ...domains], 800)) {
    const rows = await db
      .select({ value: schema.blockList.value })
      .from(schema.blockList)
      .where(and(eq(schema.blockList.workspaceId, workspaceId), inArray(schema.blockList.value, part)));
    for (const r of rows) out.add(r.value);
  }
  return new Set(emails.filter((e) => out.has(e) || out.has(domainOf(e))));
}

export async function isBlocked(workspaceId: string, email: string): Promise<boolean> {
  return (await blockedSet(workspaceId, [email])).size > 0;
}

/**
 * The addresses (lowercased) a campaign would turn away when it came to email them: on the blocklist, unsubscribed
 * from the workspace (or from `campaignId`), hard-bounced in the workspace, or barred from every campaign for
 * reporting one of this installation's emails as abuse. Lead Finder leaves them out before paying to reveal anyone.
 */
export async function uncontactable(workspaceId: string, emails: string[], campaignId?: string | null): Promise<Set<string>> {
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const out = await blockedSet(workspaceId, list);
  const U = schema.unsubscribes;
  const S = schema.leadSuppressions;
  const P = schema.privacySuppressions;
  const suppressed = or(eq(S.reason, "bounced"), campaignId ? and(eq(S.reason, "unsubscribed"), eq(S.campaignId, campaignId)) : undefined);
  for (const part of chunk(list, 500)) {
    for (const r of await db.select({ email: U.email }).from(U).where(and(eq(U.workspaceId, workspaceId), inArray(U.email, part)))) out.add(r.email);
    for (const r of await db.select({ email: S.email }).from(S).where(and(eq(S.workspaceId, workspaceId), inArray(S.email, part), suppressed))) out.add(r.email);
    for (const r of await db.select({ value: P.value }).from(P).where(and(eq(P.type, "email"), eq(P.blockSending, true), inArray(P.value, part)))) out.add(r.value);
  }
  return out;
}

export async function addLeads(o: AddLeadsOptions): Promise<AddLeadsResult> {
  if (!o.campaignId && !o.listId) throw badRequest("campaign_id or list_id is required");
  if (o.campaignId && o.listId) throw badRequest("Use campaign_id or list_id, not both");
  if (o.campaignId) {
    const [c] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.id, o.campaignId), eq(schema.campaigns.workspaceId, o.workspaceId)));
    if (!c) throw badRequest("Campaign not found");
  }
  if (o.listId) {
    const [l] = await db.select({ id: schema.leadLists.id }).from(schema.leadLists).where(and(eq(schema.leadLists.id, o.listId), eq(schema.leadLists.workspaceId, o.workspaceId)));
    if (!l) throw badRequest("Lead list not found");
  }
  const result: AddLeadsResult = {
    status: "success",
    total_sent: o.leads.length,
    leads_uploaded: 0,
    in_blocklist: 0,
    blocklist_used: o.skipBlocklist ? null : "workspace",
    duplicated_leads: 0,
    skipped_count: 0,
    invalid_email_count: 0,
    incomplete_count: 0,
    duplicate_email_count: 0,
    remaining_in_plan: null,
    over_plan_limit: 0,
    created_leads: [],
  };

  // 1. validate + dedupe inside the payload
  const seen = new Set<string>();
  const candidates: Array<{ index: number; lead: LeadInput; email: string | null }> = [];
  o.leads.forEach((lead, index) => {
    // "Jo Doe <jo@x.com>" and "mailto:jo@x.com" are taken as the address in them.
    const email = lead.email?.trim() ? emailFromCell(lead.email) : null;
    if (o.campaignId && !email) {
      result.invalid_email_count++;
      return;
    }
    if (email && !isValidEmailSyntax(email)) {
      result.invalid_email_count++;
      return;
    }
    if (!email && !lead.first_name && !lead.last_name && !lead.phone && !lead.linkedin_url) {
      result.incomplete_count++;
      return;
    }
    if (email) {
      if (seen.has(email)) {
        result.duplicate_email_count++;
        return;
      }
      seen.add(email);
    }
    candidates.push({ index, lead, email });
  });

  // 2. blocklist
  let rows = candidates;
  if (!o.skipBlocklist) {
    const blocked = await blockedSet(o.workspaceId, rows.map((r) => r.email).filter((e): e is string => !!e));
    result.in_blocklist = rows.filter((r) => r.email && blocked.has(r.email)).length;
    rows = rows.filter((r) => !r.email || !blocked.has(r.email));
  }

  // 3. skip_if_in_* flags
  if (o.skipIfInWorkspace || o.skipIfInCampaign || o.skipIfInList) {
    const emails = rows.map((r) => r.email).filter((e): e is string => !!e);
    const existing = new Set<string>();
    for (const part of chunk(emails, 800)) {
      const where = [eq(L.workspaceId, o.workspaceId), inArray(L.email, part)];
      if (!o.skipIfInWorkspace) {
        if (o.skipIfInCampaign && !o.skipIfInList) where.push(isNotNull(L.campaignId));
        if (o.skipIfInList && !o.skipIfInCampaign) where.push(isNotNull(L.listId));
      }
      for (const r of await db.select({ email: L.email }).from(L).where(and(...where))) if (r.email) existing.add(r.email);
    }
    result.skipped_count = rows.filter((r) => r.email && existing.has(r.email)).length;
    rows = rows.filter((r) => !r.email || !existing.has(r.email));
  }

  // 4. plan limit (unique contacts)
  const limits = await workspaceLimits(o.workspaceId);
  if (limits.uploaded_contacts !== null && o.campaignId) {
    const used = await uploadedContacts(o.workspaceId);
    const remaining = Math.max(0, limits.uploaded_contacts - used);
    if (remaining <= 0 && rows.length) throw paymentRequired("You have reached the uploaded contacts limit of your plan.");
    result.over_plan_limit = Math.max(0, rows.length - remaining);
    rows = rows.slice(0, remaining);
    result.remaining_in_plan = remaining;
  }

  // 5. insert (unique indexes reject duplicates already in the target)
  // With verification on, the new leads with an address wait for one run: this import's own, tagged on them.
  const verifyRun = o.verifyOnImport ? uuidv7() : null;
  const customKeys = new Set<string>();
  for (const part of chunk(rows, 400)) {
    const values = part.map(({ lead, email }) => {
      for (const k of Object.keys(lead.custom_variables ?? {})) customKeys.add(k);
      const domain = lead.company_domain || (email ? domainOf(email) : "") || "";
      return {
        workspaceId: o.workspaceId,
        campaignId: o.campaignId ?? null,
        listId: o.listId ?? null,
        email,
        firstName: lead.first_name ?? null,
        lastName: lead.last_name ?? null,
        companyName: lead.company_name ?? null,
        companyDomain: domain,
        website: lead.website ?? null,
        jobTitle: lead.job_title ?? null,
        phone: lead.phone ?? null,
        linkedinUrl: lead.linkedin_url ?? null,
        location: lead.location ?? null,
        personalization: lead.personalization ?? null,
        payload: lead.custom_variables && Object.keys(lead.custom_variables).length ? lead.custom_variables : null,
        interestStatus: lead.lt_interest_status ?? null,
        plValueLead: lead.pl_value_lead ?? null,
        assignedTo: lead.assigned_to ?? o.assignedTo ?? o.userId ?? null,
        uploadedByUser: o.userId ?? null,
        uploadMethod: o.uploadMethod ?? "manual",
        isWebsiteVisitor: o.isWebsiteVisitor ?? false,
        ...mailCodes(email),
        timezone: inferLeadTimezone({ timezone: lead.timezone, location: lead.location, phone: lead.phone, payload: lead.custom_variables }),
        verificationStatus: verifyRun && email ? VerificationStatus.PENDING_JOB : VerificationStatus.NOT_VERIFIED,
        verifyRunId: email ? verifyRun : null,
        status: LeadStatus.ACTIVE,
      };
    });
    const inserted = await db.insert(L).values(values).onConflictDoNothing().returning({ id: L.id, email: L.email, firstName: L.firstName, lastName: L.lastName, phone: L.phone });
    const byEmail = new Map(inserted.map((i) => [i.email, i]));
    const noEmail = inserted.filter((i) => !i.email);
    let noEmailIdx = 0;
    for (const r of part) {
      const hit = r.email ? byEmail.get(r.email) : noEmail[noEmailIdx++];
      if (hit) result.created_leads.push({ index: r.index, id: hit.id, email: hit.email, first_name: hit.firstName, last_name: hit.lastName, phone: hit.phone });
    }
    result.duplicated_leads += part.length - inserted.length;
  }
  result.leads_uploaded = result.created_leads.length;
  if (result.remaining_in_plan !== null) result.remaining_in_plan = Math.max(0, result.remaining_in_plan - result.leads_uploaded);

  // 6. campaign custom variable registry
  if (o.campaignId && customKeys.size) {
    const [c] = await db.select({ vars: schema.campaigns.customVariables }).from(schema.campaigns).where(eq(schema.campaigns.id, o.campaignId));
    const merged = [...new Set([...(c?.vars ?? []), ...customKeys])];
    if (merged.length !== (c?.vars ?? []).length) await db.update(schema.campaigns).set({ customVariables: merged }).where(eq(schema.campaigns.id, o.campaignId));
  }
  if (verifyRun && result.created_leads.length) await queueImportVerification(o, verifyRun, result.created_leads);
  if (result.leads_uploaded) {
    emit("lead_added", o.workspaceId, {
      campaign_id: o.campaignId ?? null,
      list_id: o.listId ?? null,
      lead_ids: result.created_leads.map((c) => c.id),
      count: result.leads_uploaded,
      verify: !!o.verifyOnImport,
      batch_id: o.batchId ?? null,
    });
  }
  return result;
}

/**
 * "Verify on import": one verification run for the leads just added, with the id they were tagged with. They wait
 * (pending) until it ends, so the first email only goes to addresses that checked out, and the run takes only them:
 * not another import's leads, which wait for (and were paid for with) their own run. Without verification credits
 * they're added unverified instead.
 */
async function queueImportVerification(o: AddLeadsOptions, runId: string, created: AddLeadsResult["created_leads"]) {
  const count = new Set(created.filter((l) => l.email).map((l) => l.email!.toLowerCase())).size;
  if (!count) return;
  if (!(await chargeCredits(o.workspaceId, count, "lead_verification", { pool: "verification", userId: o.userId ?? null }))) {
    await releaseVerifyRun(runId);
    return;
  }
  await createJob({
    id: runId,
    workspaceId: o.workspaceId,
    userId: o.userId ?? null,
    type: "verify-leads",
    entityId: o.campaignId ?? o.listId ?? null,
    data: { pending_import: true, own_leads: true, campaign_id: o.campaignId ?? undefined, list_id: o.listId ?? undefined, name: "Verify on import", charged: count },
  });
}

/**
 * A verify-on-import run lets go of its leads (it ended, or never got queued): the ones still waiting for it go out
 * unverified, as if verification were off, and none keeps its tag.
 */
export async function releaseVerifyRun(runId: string) {
  const waiting = inArray(L.verificationStatus, [VerificationStatus.PENDING, VerificationStatus.PENDING_JOB]);
  await db
    .update(L)
    .set({ verificationStatus: sql`case when ${waiting} then ${VerificationStatus.NOT_VERIFIED} else ${L.verificationStatus} end`, verifyRunId: null })
    .where(eq(L.verifyRunId, runId));
}

/**
 * Provider and gateway codes for an address: a free-mail provider's are known at once (and it has no security
 * gateway); other domains are looked up by the engine (services/verification.ts).
 */
export function mailCodes(email: string | null | undefined): { espCode: number; esgCode: number } {
  if (!email) return { espCode: EspCode.NOT_FOUND, esgCode: EsgCode.NONE };
  const domain = domainOf(email);
  return FREE_MAIL_DOMAINS.has(domain) ? { espCode: freeMailEsp(domain), esgCode: EsgCode.NONE } : { espCode: EspCode.IN_QUEUE, esgCode: EsgCode.IN_QUEUE };
}

function freeMailEsp(domain: string): number {
  if (domain === "gmail.com" || domain === "googlemail.com") return EspCode.GOOGLE;
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) return EspCode.MICROSOFT;
  if (domain.startsWith("yahoo.")) return EspCode.YAHOO;
  if (domain === "zoho.com") return EspCode.ZOHO;
  if (domain.startsWith("yandex.")) return EspCode.YANDEX;
  if (domain === "web.de") return EspCode.WEBDE;
  if (domain === "libero.it") return EspCode.LIBERO;
  return EspCode.OTHER;
}

/**
 * Deletes the matching leads into Recently deleted, as one entry for the whole delete (restorable for 30 days). Their
 * emails, events, notes and tasks stay where they are. Returns how many went, and the entry.
 */
export async function deleteLeadsWhere(workspaceId: string, conds: SQL[], actor: Actor, limit?: number): Promise<{ count: number; entryId: string | null }> {
  const ids = (await db.select({ id: L.id }).from(L).where(and(...conds)).limit(limit ?? 1_000_000)).map((r) => r.id);
  return trashLeads(workspaceId, ids, actor);
}

/** The step and variant a lead opened, replied to and clicked are the campaign's: a lead moving on starts without. */
const NO_STEPS = { openedStep: null, openedVariant: null, repliedStep: null, repliedVariant: null, clickedStep: null, clickedVariant: null };

/** Move or copy leads into a campaign or list. Used by the move-leads job and the UI. */
export async function moveLeads(opts: {
  workspaceId: string;
  leadIds: string[];
  toCampaignId?: string | null;
  toListId?: string | null;
  copy?: boolean;
  checkDuplicates?: boolean;
  checkDuplicatesInCampaigns?: boolean;
  skipInvalid?: boolean;
  resetInterestStatus?: boolean;
  assignedTo?: string | null;
}): Promise<{ moved: string[]; skipped: number }> {
  const moved: string[] = [];
  let skipped = 0;
  // Leads moved to someone (not copies: those stay with the original's owner too) take their deals along.
  const handedOver: string[] = [];
  for (const part of chunk(opts.leadIds, 400)) {
    const leads = await db.select().from(L).where(and(eq(L.workspaceId, opts.workspaceId), inArray(L.id, part)));
    // A lead already where it's going stays as it is: moving it there again would start its emails over.
    let candidates = leads.filter((l) => (opts.toCampaignId ? l.campaignId !== opts.toCampaignId : !opts.toListId || l.listId !== opts.toListId));
    if (opts.skipInvalid) {
      candidates = candidates.filter((l) => l.verificationStatus !== VerificationStatus.INVALID && l.verificationStatus !== VerificationStatus.RISKY);
    }
    // "Check for duplicates": leave out people who are also in another campaign (or list, for a list), not counting
    // the lead being moved itself. Duplicates in the destination are refused by its unique index either way.
    const intoCampaign = !!opts.toCampaignId;
    if (intoCampaign ? opts.checkDuplicates || opts.checkDuplicatesInCampaigns : opts.checkDuplicates) {
      const emails = [...new Set(candidates.map((l) => l.email).filter((e): e is string => !!e))];
      const holders = new Map<string, string[]>();
      for (const emailPart of chunk(emails, 800)) {
        const rows = await db
          .select({ id: L.id, email: L.email })
          .from(L)
          .where(and(eq(L.workspaceId, opts.workspaceId), intoCampaign ? isNotNull(L.campaignId) : isNotNull(L.listId), inArray(L.email, emailPart)));
        for (const r of rows) holders.set(r.email!, [...(holders.get(r.email!) ?? []), r.id]);
      }
      candidates = candidates.filter((l) => !l.email || !(holders.get(l.email) ?? []).some((id) => id !== l.id));
    }
    for (const l of candidates) {
      const target = { campaignId: opts.toCampaignId ?? null, listId: opts.toListId ?? null };
      // An address that bounced or unsubscribed keeps that status wherever it goes: nothing more is sent to it.
      const ended = l.status === LeadStatus.BOUNCED || l.status === LeadStatus.UNSUBSCRIBED;
      const freshState = {
        status: ended ? l.status : LeadStatus.ACTIVE,
        nextStep: 0,
        nextSendAt: null,
        senderAccountId: null,
        threadMessageIds: null,
        lastSubject: null,
        subsequenceId: null,
        subseqNextStep: 0,
        subseqNextSendAt: null,
        subseqStatus: null,
        addedSubsequenceAt: null,
        ...(opts.resetInterestStatus ? { interestStatus: null, interestSynced: false } : {}),
        ...(opts.assignedTo ? { assignedTo: opts.assignedTo } : {}),
      };
      // Opens, clicks and replies belong to the campaign they happened in, not the one the lead moves to.
      const history = {
        openCount: 0,
        replyCount: 0,
        clickCount: 0,
        lastContactAt: null,
        lastOpenAt: null,
        lastReplyAt: null,
        lastClickAt: null,
        lastStepFrom: null,
        lastStepId: null,
        lastStepAt: null,
        completedAt: null,
        ...NO_STEPS,
      };
      if (opts.copy) {
        const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = l;
        // A copy's status is the person's, not a conversion of its own.
        const synced = !opts.resetInterestStatus && l.interestStatus !== null;
        const [row] = await db
          .insert(L)
          .values({ ...rest, ...target, ...freshState, ...history, interestSynced: synced || l.interestSynced })
          .onConflictDoNothing()
          .returning({ id: L.id });
        if (row) moved.push(l.email ?? row.id);
        else skipped++;
      } else {
        const counters = target.campaignId && target.campaignId !== l.campaignId ? history : {};
        try {
          const [row] = await db
            .update(L)
            .set({ ...target, ...freshState, ...counters })
            .where(eq(L.id, l.id))
            .returning({ id: L.id });
          if (row) moved.push(l.email ?? row.id);
          if (row && opts.assignedTo) handedOver.push(row.id);
        } catch {
          // Unique constraint: the lead already exists in the destination.
          skipped++;
        }
      }
    }
    skipped += leads.length - candidates.length;
  }
  if (handedOver.length) await dealsFollowOwner(opts.workspaceId, handedOver, opts.assignedTo!);
  return { moved, skipped };
}

// ---------- Editing many leads at once ----------

const EDIT_COLUMNS = {
  first_name: "firstName",
  last_name: "lastName",
  company_name: "companyName",
  job_title: "jobTitle",
  website: "website",
  phone: "phone",
  linkedin_url: "linkedinUrl",
  location: "location",
  timezone: "timezone",
  personalization: "personalization",
} as const satisfies Record<LeadEditField, keyof typeof L.$inferInsert>;

/** One field, or one custom variable, to set for many leads; a null value (or only spaces) clears it. */
export type LeadEdit = { field: LeadEditField; variable?: undefined; value: string | null } | { field?: undefined; variable: string; value: string | null };

/** Selections up to this size are edited while the request waits; bigger ones by a background job. */
export const EDIT_INLINE_MAX = 2_000;

/** What a lead's timezone can be worked out from. */
export interface LeadPlace {
  location: string | null;
  phone: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * Changes where these leads of a workspace are or the custom variables they have, a few hundred at a time, writing only
 * the leads that change (`change` gives back what changes; the same payload object means no change). A timezone that
 * was worked out from those follows them, while one somebody gave stays, unless `rezone` works every one out again.
 */
export async function changeLeads(
  workspaceId: string,
  leadIds: string[],
  change: (lead: LeadPlace) => Partial<LeadPlace>,
  opts: { rezone?: boolean; onProgress?: (done: number) => Promise<void> } = {},
) {
  let done = 0;
  for (const part of chunk(leadIds, 500)) {
    const rows = await db
      .select({ id: L.id, location: L.location, phone: L.phone, payload: L.payload, timezone: L.timezone })
      .from(L)
      .where(and(eq(L.workspaceId, workspaceId), inArray(L.id, part)));
    const writes = rows.flatMap((lead) => {
      const next: LeadPlace = { location: lead.location, phone: lead.phone, payload: lead.payload, ...change(lead) };
      const worked = inferLeadTimezone({ location: lead.location, phone: lead.phone, payload: lead.payload });
      const timezone = opts.rezone || !lead.timezone || lead.timezone === worked ? inferLeadTimezone(next) : lead.timezone;
      const set: Partial<typeof L.$inferInsert> = {};
      if (next.location !== lead.location) set.location = next.location;
      if (next.phone !== lead.phone) set.phone = next.phone;
      if (next.payload !== lead.payload) set.payload = next.payload;
      if (timezone !== lead.timezone) set.timezone = timezone;
      return Object.keys(set).length ? [db.update(L).set(set).where(eq(L.id, lead.id))] : [];
    });
    const [first, ...rest] = writes;
    if (first) await db.batch([first, ...rest]);
    done += part.length;
    await opts.onProgress?.(done);
  }
}

/** The payload with a custom variable set (or removed, for null): the same object when that changes nothing. */
export function withVariable(payload: Record<string, unknown> | null, name: string, value: unknown): Record<string, unknown> | null {
  const has = !!payload && Object.hasOwn(payload, name);
  if (has ? payload![name] === value : value === null) return payload;
  const next: Record<string, unknown> = { ...(payload ?? {}) };
  if (value === null) delete next[name];
  else next[name] = value;
  return Object.keys(next).length ? next : null;
}

/**
 * Sets one field or custom variable on these leads of a workspace, writing only the leads it changes. A timezone that
 * was worked out from where a lead is follows a new location, phone or custom field, while one somebody gave stays;
 * clearing the timezone works it out again. A timezone has to be one `parseTimezone` reads (the caller checks).
 */
export async function editLeads(workspaceId: string, leadIds: string[], edit: LeadEdit, onProgress?: (done: number) => Promise<void>) {
  const value = edit.value?.trim() ? edit.value.trim() : null;
  if (edit.field && edit.field !== "location" && edit.field !== "phone" && !(edit.field === "timezone" && !value)) {
    const column = EDIT_COLUMNS[edit.field];
    const next = edit.field === "timezone" ? parseTimezone(value) : value;
    let done = 0;
    for (const part of chunk(leadIds, 500)) {
      await db
        .update(L)
        .set({ [column]: next } as Partial<typeof L.$inferInsert>)
        .where(and(eq(L.workspaceId, workspaceId), inArray(L.id, part), sql`${L[column]} is not ${next}`));
      done += part.length;
      await onProgress?.(done);
    }
    return;
  }
  await changeLeads(
    workspaceId,
    leadIds,
    (lead) => (edit.field === "location" ? { location: value } : edit.field === "phone" ? { phone: value } : edit.variable ? { payload: withVariable(lead.payload, edit.variable, value) } : {}),
    { rezone: edit.field === "timezone", onProgress },
  );
}

/** Thread + lead context shown in the Unibox / CRM lead panel. */
export async function leadActivity(workspaceId: string, lead: LeadRow) {
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(and(eq(schema.emailEvents.workspaceId, workspaceId), eq(schema.emailEvents.leadId, lead.id)))
    .orderBy(desc(schema.emailEvents.createdAt))
    .limit(200);
  const emails = lead.email
    ? await db
        .select({ id: schema.emails.id, subject: schema.emails.subject, ueType: schema.emails.ueType, at: schema.emails.timestampEmail, step: schema.emails.step })
        .from(schema.emails)
        .where(and(eq(schema.emails.workspaceId, workspaceId), eq(schema.emails.leadEmail, lead.email), ne(schema.emails.ueType, EmailType.SCHEDULED)))
        .orderBy(desc(schema.emails.timestampEmail))
        .limit(100)
    : [];
  return {
    events: events.map((e) => ({ id: e.id, type: e.type, campaign_id: e.campaignId, step: e.step, variant: e.variant, url: e.url, value: e.value, detail: e.detail, timestamp: iso(e.createdAt) })),
    emails: emails.map((e) => ({ id: e.id, subject: e.subject, ue_type: e.ueType, step: e.step, timestamp: iso(e.at) })),
  };
}

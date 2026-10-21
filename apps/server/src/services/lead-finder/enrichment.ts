// Enrichments attached to a list or campaign: configuration rows (one per type), runs as background jobs,
// results written onto leads (standard fields or custom variables), credits per successful row.
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  CREDIT_COSTS,
  NORMALIZE_TARGET_KEYS,
  VerificationStatus,
  cleanCompanyName,
  cleanDomain,
  cleanPersonName,
  domainOf,
  isReservedDomain,
  normalizeKeys,
  renderTemplate,
  type EnrichmentType,
} from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { conflict, notFound } from "../../http/errors";
import { iso } from "../../lib/time";
import { cachedSystem, complete, pageText, resolveAi } from "../ai";
import { chargeCredits, workspaceLimits } from "../billing-limits";
import { emit, on } from "../bus";
import { createJob, registerJobCleanup, registerJobHandler, type JobContext } from "../jobs";
import { leadConditions, type LeadFilter, type LeadRow } from "../leads";
import { leadVerificationCode, verifyAndStore } from "../verification";
import { enqueueWebhooks } from "../webhooks";
import { companyNews, engagementScore, findWorkEmail, jobListings, websiteProfile } from "./enrichers";
import { findAction } from "./integrations";

const E = schema.enrichments;
const L = schema.leads;
const RUNS = schema.enrichmentRuns;
const J = schema.backgroundJobs;
const ACTIVE = ["pending", "in-progress"];

/** API resource types: 1 = campaign, 2 = list. */
export type ResourceType = 1 | 2;

export async function resolveResource(workspaceId: string, resourceId: string): Promise<{ type: ResourceType; name: string }> {
  const [list] = await db.select({ name: schema.leadLists.name }).from(schema.leadLists).where(and(eq(schema.leadLists.id, resourceId), eq(schema.leadLists.workspaceId, workspaceId))).limit(1);
  if (list) return { type: 2, name: list.name };
  const [camp] = await db.select({ name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.id, resourceId), eq(schema.campaigns.workspaceId, workspaceId))).limit(1);
  if (camp) return { type: 1, name: camp.name };
  throw notFound("List or campaign");
}

const resourceCond = (type: ResourceType, id: string) => (type === 1 ? eq(L.campaignId, id) : eq(L.listId, id));

export interface AiColumnConfig {
  output_column: string;
  prompt: string;
  input_columns?: string[];
  model_version?: string;
  overwrite?: boolean;
  use_instantly_account?: boolean;
  skip_leads_without_email?: boolean;
  template_id?: string | null;
  status?: number;
  /** Fill in leads added later (unset: follows the enrichment's auto_update). */
  auto_update?: boolean;
}

export type EnrichmentRow = typeof E.$inferSelect;

export async function upsertEnrichment(input: {
  workspaceId: string;
  resourceId: string;
  resourceType: ResourceType;
  type: EnrichmentType | "supersearch" | "integration" | "normalize";
  payload?: Record<string, unknown>;
  limit?: number | null;
  autoUpdate?: boolean;
  skipRowsWithoutEmail?: boolean;
  userId?: string | null;
}): Promise<EnrichmentRow> {
  const [existing] = await db.select().from(E).where(and(eq(E.workspaceId, input.workspaceId), eq(E.resourceId, input.resourceId), eq(E.type, input.type))).limit(1);
  if (existing) {
    const [row] = await db
      .update(E)
      .set({
        enrichmentPayload: { ...(existing.enrichmentPayload ?? {}), ...(input.payload ?? {}) },
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.autoUpdate !== undefined ? { autoUpdate: input.autoUpdate } : {}),
        ...(input.skipRowsWithoutEmail !== undefined ? { skipRowsWithoutEmail: input.skipRowsWithoutEmail } : {}),
      })
      .where(eq(E.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(E)
    .values({
      workspaceId: input.workspaceId,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      type: input.type,
      enrichmentPayload: input.payload ?? {},
      limit: input.limit ?? null,
      autoUpdate: input.autoUpdate ?? false,
      skipRowsWithoutEmail: input.skipRowsWithoutEmail ?? false,
      createdBy: input.userId ?? null,
    })
    .returning();
  if (input.resourceType === 2) await db.update(schema.leadLists).set({ hasEnrichmentTask: true }).where(eq(schema.leadLists.id, input.resourceId));
  return row!;
}

export interface RunOptions {
  leadIds?: string[];
  limit?: number;
  overwrite?: boolean;
  columnName?: string;
  startingRow?: number;
  count?: number;
  filters?: Array<{ column_name: string; type: number; value: string[] }>;
  /** Only these types (default: every enrichment configured on the resource). */
  types?: string[];
  /** Delete the leads the email lookup found no address for (a Lead Finder import that skips people without one). */
  dropWithoutEmail?: boolean;
  /** Only the leads matching a leads-table filter (a "select all" in the table). */
  leadFilter?: LeadFilter;
  /** A run for leads that were just added (columns that fill in new leads automatically). */
  auto?: boolean;
  /** Leads an import just added: no run already going can cover them, so the run is never refused for overlapping. */
  justAdded?: boolean;
  /** The AI columns the run fills (set when it's queued, so a column added later gets its own run). */
  aiColumns?: string[];
}

/** Queues a run of the resource's enrichments and records it in the run history. */
export async function scheduleRun(workspaceId: string, userId: string | null, resourceId: string, opts: RunOptions = {}) {
  const enrichments = await db.select().from(E).where(and(eq(E.workspaceId, workspaceId), eq(E.resourceId, resourceId)));
  const selected = enrichments.filter((e) => e.type !== "supersearch" && (!opts.types || opts.types.includes(e.type)));
  if (!selected.length) return null;
  const ai = selected.find((e) => e.type === "ai_enrichment");
  const aiColumns = ai ? (opts.columnName ? [opts.columnName] : Object.values(((ai.enrichmentPayload ?? {}).columns ?? {}) as Record<string, AiColumnConfig>).map((c) => c.output_column)) : undefined;
  // Two runs of a column over the same leads would look each one up, and charge for it, twice.
  if (!opts.auto && !opts.justAdded) await assertNotRunning(workspaceId, resourceId, selected, aiColumns);
  const { leadIds, ...rest } = opts;
  const job = await createJob({
    workspaceId,
    userId,
    type: "enrich-leads",
    entityId: resourceId,
    entityType: "enrichment",
    data: { resource_id: resourceId, enrichment_ids: selected.map((e) => e.id), ...rest, ...(aiColumns ? { aiColumns } : {}), ...(leadIds ? { lead_count: leadIds.length } : {}) },
    // Kept apart from what the job shows: an import's leads can number in the tens of thousands.
    ...(leadIds ? { input: { leadIds } } : {}),
  });
  for (const e of selected) {
    await db.insert(RUNS).values({ workspaceId, enrichmentId: e.id, resourceId, type: e.type, jobId: job.id, status: "running" });
  }
  await db.update(E).set({ inProgress: true }).where(inArray(E.id, selected.map((e) => e.id)));
  return job;
}

/** Refuses a run of an enrichment (or AI column) that a run waiting or going already fills on this list or campaign. */
async function assertNotRunning(workspaceId: string, resourceId: string, selected: EnrichmentRow[], aiColumns: string[] | undefined) {
  const active = await db
    .select({ data: J.data })
    .from(J)
    .where(and(eq(J.workspaceId, workspaceId), eq(J.type, "enrich-leads"), eq(J.entityId, resourceId), inArray(J.status, ACTIVE)));
  for (const { data } of active) {
    const d = (data ?? {}) as { enrichment_ids?: string[]; columnName?: string; aiColumns?: string[] };
    // Runs queued before the AI columns were noted fill the one they name, or all of them.
    const theirs = d.aiColumns ?? (d.columnName ? [d.columnName] : null);
    const busy = selected.find((e) => d.enrichment_ids?.includes(e.id) && (e.type !== "ai_enrichment" || !theirs || !aiColumns || aiColumns.some((c) => theirs.includes(c))));
    if (busy) throw conflict(`This enrichment is already running on this ${busy.resourceType === 1 ? "campaign" : "list"}. Wait for it to finish, or stop it, then try again.`);
  }
}

/** Clears the running flag of the enrichments no other run is waiting on or working through. */
async function settleRunning(workspaceId: string, resourceId: string, enrichmentIds: string[], jobId: string) {
  const others = await db
    .select({ data: J.data })
    .from(J)
    .where(and(eq(J.workspaceId, workspaceId), eq(J.type, "enrich-leads"), eq(J.entityId, resourceId), inArray(J.status, ACTIVE), ne(J.id, jobId)));
  const busy = new Set(others.flatMap((o) => ((o.data ?? {}) as { enrichment_ids?: string[] }).enrichment_ids ?? []));
  const idle = enrichmentIds.filter((id) => !busy.has(id));
  if (idle.length) await db.update(E).set({ inProgress: false }).where(inArray(E.id, idle));
}

// Integration columns cost what their providers charge (StepResult.cost).
const COST: Record<string, number> = { ...CREDIT_COSTS, engagement_score: 0, normalize: 0, custom_flow: CREDIT_COSTS.work_email_enrichment };

/** Value of a lead column for prompts and filters (standard field or custom variable). */
export function leadColumn(lead: LeadRow, column: string): string {
  const map: Record<string, unknown> = {
    email: lead.email,
    first_name: lead.firstName,
    firstName: lead.firstName,
    last_name: lead.lastName,
    lastName: lead.lastName,
    company_name: lead.companyName,
    companyName: lead.companyName,
    company_domain: lead.companyDomain,
    website: lead.website,
    job_title: lead.jobTitle,
    jobTitle: lead.jobTitle,
    phone: lead.phone,
    linkedin_url: lead.linkedinUrl,
    linkedIn: lead.linkedinUrl,
    location: lead.location,
    personalization: lead.personalization,
  };
  const v = column in map ? map[column] : (lead.payload ?? {})[column];
  return v === null || v === undefined ? "" : String(v);
}

function matchesFilters(lead: LeadRow, filters: RunOptions["filters"]): boolean {
  // Filter codes used by this server: 4 = is empty, 5 = is not empty, anything else = contains one of the values.
  for (const f of filters ?? []) {
    const v = leadColumn(lead, f.column_name).toLowerCase();
    if (f.type === 4 && v) return false;
    if (f.type === 5 && !v) return false;
    if (f.type !== 4 && f.type !== 5 && f.value.length && !f.value.some((x) => v.includes(x.toLowerCase()))) return false;
  }
  return true;
}

const companyDomainOf = (lead: LeadRow) => lead.companyDomain || (lead.website ? lead.website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]! : "") || (lead.email ? domainOf(lead.email) : "");

/** The dataset's record of a company (shared rows or the workspace's own import). */
async function datasetCompany(workspaceId: string, domain: string) {
  const LC = schema.lfCompanies;
  const [row] = await db
    .select()
    .from(LC)
    .where(and(eq(LC.domain, domain), or(isNull(LC.workspaceId), eq(LC.workspaceId, workspaceId))))
    .orderBy(sql`${LC.workspaceId} is null`)
    .limit(1);
  return row ?? null;
}

async function setPayload(lead: LeadRow, values: Record<string, unknown>, fields: Partial<typeof L.$inferInsert> = {}) {
  // Merged in SQL, so two runs filling different columns of the same leads never undo each other's values.
  await db
    .update(L)
    .set({ payload: sql`json_patch(coalesce(${L.payload}, '{}'), ${JSON.stringify(values)})`, ...fields })
    .where(eq(L.id, lead.id));
  lead.payload = { ...(lead.payload ?? {}), ...values };
  Object.assign(lead, fields);
}

// Variables that show a kind already ran for a lead; with overwrite off those leads are left alone.
export const FILLED_BY: Record<string, string[]> = {
  fully_enriched_profile: ["seniority", "company_industry", "company_size", "company_description"],
  technologies: ["technologies"],
  news: ["latest_news"],
  joblisting: ["open_roles"],
  funding: ["funding_stage"],
};

function alreadyFilled(e: EnrichmentRow, lead: LeadRow): boolean {
  if (e.type === "email_verification") return !([VerificationStatus.NOT_VERIFIED, VerificationStatus.PENDING, VerificationStatus.PENDING_JOB] as number[]).includes(lead.verificationStatus);
  if (e.type === "normalize") return normalizeKeys(normalizeTargets(e)).every((k) => leadColumn(lead, k));
  return (FILLED_BY[e.type] ?? []).some((k) => leadColumn(lead, k));
}

/** What a clean-up column tidies: names, company names, domains (all three when not set). */
export const normalizeTargets = (e: Pick<EnrichmentRow, "enrichmentPayload">): string[] => {
  const t = (e.enrichmentPayload ?? {}).targets;
  return Array.isArray(t) && t.length ? t.filter((x): x is string => typeof x === "string") : [...NORMALIZE_TARGET_KEYS];
};

const AI_SYSTEM = `You fill one cell of a sales prospecting spreadsheet.
Do the task in the user message for the lead described there. Use only the information provided;
if it is not enough, give your best short answer based on it rather than inventing specifics.
Reply with the cell value only: no preamble, no quotes, no explanation.`;

interface StepResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  /** What the step costs when it isn't the kind's usual price: a check reused for free, a provider's own price. */
  cost?: number;
}

/** Runs one AI column prompt for a lead: {{variables}} resolve per lead, the answer is returned unsaved. */
export async function aiColumnValue(lead: LeadRow, prompt: string, inputColumns?: string[]): Promise<string> {
  const domain = companyDomainOf(lead);
  const inputs = inputColumns?.length ? inputColumns : ["first_name", "last_name", "job_title", "company_name", "website", "location"];
  const data: Record<string, string> = {};
  for (const k of inputs) if (k !== "website_content") data[k] = leadColumn(lead, k);
  if (inputs.includes("website_content") || /\{\{\s*website_content\s*\}\}/.test(prompt)) {
    data.website_content = domain ? await pageText(`https://${domain}`, 8_000).catch(() => "") : "";
  }
  // {{variables}} in the prompt resolve per lead (standard fields in either spelling, custom variables).
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(lead.payload ?? {})) vars[k] = v === null || v === undefined ? "" : String(v);
  for (const k of ["email", "first_name", "firstName", "last_name", "lastName", "company_name", "companyName", "company_domain", "website", "job_title", "jobTitle", "phone", "linkedin_url", "location", "personalization"]) {
    vars[k] = leadColumn(lead, k);
  }
  vars.companyDomain = vars.company_domain!;
  if (data.website_content !== undefined) vars.website_content = data.website_content;
  const task = renderTemplate(prompt, vars).output;
  const out = await complete({
    workspaceId: lead.workspaceId,
    feature: "ai_enrichment",
    effort: "low",
    maxTokens: 2_000,
    system: cachedSystem(AI_SYSTEM),
    messages: [{ role: "user", content: `<task>\n${task}\n</task>\n\n<lead>\n${JSON.stringify(data, null, 2)}\n</lead>` }],
  });
  return out.text.slice(0, 5_000);
}

async function enrichOne(e: EnrichmentRow, lead: LeadRow, opts: RunOptions & { workspaceKey: boolean }): Promise<StepResult> {
  const p = (e.enrichmentPayload ?? {}) as Record<string, unknown>;
  const domain = companyDomainOf(lead);
  // Runs from the leads table say whether to redo leads that already have a value; API runs keep their old behaviour.
  if (opts.overwrite === false && alreadyFilled(e, lead)) return { ok: false, skipped: true };
  switch (e.type) {
    case "work_email_enrichment":
    case "custom_flow": {
      if (lead.email && !opts.overwrite) return { ok: false, skipped: true };
      const found = await findWorkEmail({ first_name: lead.firstName, last_name: lead.lastName, domain }, (p.custom_flow as string[] | undefined) ?? ["instantly"], lead.workspaceId);
      if (!found.email) {
        await setPayload(lead, { email_finder_status: found.note ?? "not_found" });
        return { ok: false };
      }
      try {
        await setPayload(lead, { email_finder_status: found.status, email_source: found.source }, {
          email: found.email,
          verificationStatus: found.status === "verified" ? VerificationStatus.VERIFIED : found.status === "catch_all" ? VerificationStatus.CATCH_ALL : VerificationStatus.RISKY,
        });
        return { ok: true };
      } catch {
        return { ok: false, error: "duplicate_email" }; // the address already belongs to another lead in this list
      }
    }
    case "fully_enriched_profile": {
      const P = schema.lfPeople;
      const C = schema.lfCompanies;
      const conds = [or(isNull(P.workspaceId), eq(P.workspaceId, lead.workspaceId))!];
      const match = lead.email
        ? eq(P.email, lead.email)
        : lead.linkedinUrl
          ? eq(P.linkedinUrl, lead.linkedinUrl)
          : and(sql`lower(${P.firstName}) = ${(lead.firstName ?? "").toLowerCase()}`, sql`lower(coalesce(${P.lastName}, '')) = ${(lead.lastName ?? "").toLowerCase()}`, eq(C.domain, domain));
      const [row] = await db.select({ p: P, c: C }).from(P).leftJoin(C, eq(C.id, P.companyId)).where(and(...conds, match)).limit(1);
      if (!row) return { ok: false };
      const { p: person, c: company } = row;
      await setPayload(
        lead,
        {
          seniority: person.seniority,
          department: person.department,
          company_industry: company?.industry ?? null,
          company_sub_industry: company?.subIndustry ?? null,
          company_size: company?.employeeCount ?? null,
          company_revenue: company?.revenueRange ?? null,
          company_linkedin: company?.linkedinUrl ?? null,
          company_description: company?.description ?? null,
          company_location: [company?.city, company?.state, company?.country].filter(Boolean).join(", ") || null,
        },
        {
          jobTitle: lead.jobTitle || person.title,
          phone: lead.phone || person.phone,
          linkedinUrl: lead.linkedinUrl || person.linkedinUrl,
          location: lead.location || [person.city, person.state, person.country].filter(Boolean).join(", ") || null,
          companyName: lead.companyName || company?.name || null,
          website: lead.website || (company?.domain ? `https://${company.domain}` : null),
          companyDomain: lead.companyDomain || company?.domain || "",
        },
      );
      return { ok: true };
    }
    case "email_verification": {
      if (!lead.email) return { ok: false, skipped: true };
      const r = await verifyAndStore(lead.workspaceId, lead.email);
      lead.verificationStatus = leadVerificationCode(r.status);
      // No verdict (the domain's mail servers couldn't be looked up) isn't a result; a check reused from the last 30
      // days costs nothing.
      if (r.status === "unknown") return { ok: false };
      return r.cached ? { ok: true, cost: 0 } : { ok: true };
    }
    case "technologies": {
      if (!domain) return { ok: false, skipped: true };
      const known = await datasetCompany(lead.workspaceId, domain);
      if (known?.technologies?.length) {
        await setPayload(lead, { technologies: known.technologies.join(", ") });
        return { ok: true };
      }
      if (isReservedDomain(domain)) return { ok: false };
      const site = await websiteProfile(domain);
      if (!site) return { ok: false };
      await setPayload(lead, {
        technologies: site.technologies.join(", "),
        company_description: (lead.payload?.company_description as string | undefined) ?? site.description,
        company_linkedin: (lead.payload?.company_linkedin as string | undefined) ?? site.socials.linkedin ?? null,
      });
      return { ok: site.technologies.length > 0 };
    }
    case "news": {
      if (!lead.companyName && !domain) return { ok: false, skipped: true };
      const known = domain ? await datasetCompany(lead.workspaceId, domain) : null;
      const stored = [...(known?.news ?? [])].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      const news = stored.length ? stored : lead.companyName && !isReservedDomain(domain) ? await companyNews(lead.companyName, 5) : [];
      if (!news.length) return { ok: false };
      await setPayload(lead, { latest_news: `${news[0]!.title}${news[0]!.date ? ` (${news[0]!.date})` : ""}`, latest_news_url: news[0]!.url ?? null, news_count: news.length });
      return { ok: true };
    }
    case "joblisting": {
      const known = domain ? await datasetCompany(lead.workspaceId, domain) : null;
      const jobs = known?.jobPostings?.length ? known.jobPostings : isReservedDomain(domain) ? [] : await jobListings(lead.companyName, domain);
      if (!jobs.length) return { ok: false };
      await setPayload(lead, { open_roles: jobs.length, job_titles: jobs.slice(0, 5).map((j) => j.title).join("; "), jobs_url: jobs[0]!.url ?? null });
      return { ok: true };
    }
    case "funding": {
      const company = domain ? await datasetCompany(lead.workspaceId, domain) : null;
      if (!company?.funding?.stage) return { ok: false };
      await setPayload(lead, { funding_stage: company.funding.stage, funding_total: company.funding.total ?? null, last_funding_at: company.funding.last_round_at ?? null });
      return { ok: true };
    }
    case "engagement_score": {
      await setPayload(lead, { engagement_score: engagementScore(lead) });
      return { ok: true };
    }
    case "normalize": {
      // Local clean-up, no AI and no credits: tidy copies of names, the company name and the company domain.
      const targets = normalizeTargets(e);
      const out: Record<string, string> = {};
      if (targets.includes("name")) {
        out.clean_first_name = cleanPersonName(lead.firstName);
        out.clean_last_name = cleanPersonName(lead.lastName);
      }
      if (targets.includes("company")) out.clean_company_name = cleanCompanyName(lead.companyName);
      if (targets.includes("domain")) out.clean_company_domain = cleanDomain(lead.website) || cleanDomain(lead.companyDomain) || cleanDomain(lead.email);
      const values = Object.fromEntries(Object.entries(out).filter(([, v]) => v));
      if (!Object.keys(values).length) return { ok: false, skipped: true };
      await setPayload(lead, values);
      return { ok: true };
    }
    case "ai_enrichment": {
      const columns = Object.values((p.columns ?? {}) as Record<string, AiColumnConfig>).filter(
        (col) => (!opts.columnName || col.output_column === opts.columnName) && (!opts.aiColumns || opts.aiColumns.includes(col.output_column)),
      );
      let any = false;
      for (const col of columns) {
        if (col.status === 2) continue; // paused column
        if (opts.auto && col.auto_update === false) continue;
        if (col.skip_leads_without_email && !lead.email) continue;
        if (leadColumn(lead, col.output_column) && !(opts.overwrite ?? col.overwrite)) continue;
        await setPayload(lead, { [col.output_column]: await aiColumnValue(lead, col.prompt, col.input_columns) });
        any = true;
      }
      return { ok: any, skipped: !any };
    }
    case "integration": {
      // Provider actions configured through `integration_actions`: inputs come from mapped lead columns. Each action
      // that finds something costs its provider's price.
      const actions = (p.actions ?? {}) as Record<string, Record<string, { mapping: Record<string, string> }>>;
      let any = false;
      let cost = 0;
      let total = 0;
      let filled = 0;
      for (const [providerId, acts] of Object.entries(actions)) {
        for (const [actionId, cfg] of Object.entries(acts)) {
          const { provider, action } = findAction(providerId, actionId);
          total++;
          if (opts.overwrite === false && leadColumn(lead, action.outputColumn)) {
            filled++;
            continue;
          }
          const inputs = Object.fromEntries(Object.entries(cfg.mapping).map(([key, column]) => [key, leadColumn(lead, column)]));
          if (action.inputs.some((i) => i.required && !inputs[i.key])) continue;
          const r = await action.run(lead.workspaceId, inputs);
          if (r.value === null) continue;
          await setPayload(lead, { [action.outputColumn]: r.value });
          any = true;
          if (!r.free) cost += provider.creditCostPerAction;
        }
      }
      if (total && filled === total) return { ok: false, skipped: true };
      return { ok: any, cost };
    }
    default:
      return { ok: false, skipped: true };
  }
}

async function enrichLeads({ job, input, progress, cancelled }: JobContext) {
  const d = job.data as unknown as RunOptions & { resource_id: string; enrichment_ids: string[] };
  // Runs queued before the leads were kept apart from the job carry them in its data.
  const leadIds = d.leadIds ?? input<{ leadIds?: string[] }>()?.leadIds;
  const resource = await resolveResource(job.workspaceId, d.resource_id);
  const enrichments = await db.select().from(E).where(inArray(E.id, d.enrichment_ids));
  // Order matters: find emails before verifying them, profiles before AI columns use them.
  const ORDER = ["fully_enriched_profile", "work_email_enrichment", "custom_flow", "email_verification", "normalize", "technologies", "news", "joblisting", "funding", "engagement_score", "integration", "ai_enrichment"];
  enrichments.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  // When people without an address are dropped, look the address up first so nothing else is spent on them.
  const isLookup = (t: string) => t === "work_email_enrichment" || t === "custom_flow";
  if (d.dropWithoutEmail) enrichments.sort((a, b) => Number(isLookup(b.type)) - Number(isLookup(a.type)));
  const dropped: string[] = [];
  const conds = [eq(L.workspaceId, job.workspaceId), resourceCond(resource.type, d.resource_id)];
  if (d.leadFilter) conds.push(...(await leadConditions(job.workspaceId, d.leadFilter)));
  let leads: LeadRow[];
  if (leadIds?.length) {
    // A part at a time: an import's leads would pass the database's limit on values in one statement.
    leads = [];
    for (let i = 0; i < leadIds.length; i += 500) leads.push(...(await db.select().from(L).where(and(...conds, inArray(L.id, leadIds.slice(i, i + 500))))));
    // Rows picked in the leads table run in the table's order, so the rows on screen fill in first.
    const at = new Map(leadIds.map((id, i) => [id, i]));
    leads.sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  } else leads = await db.select().from(L).where(and(...conds)).orderBy(asc(L.createdAt), asc(L.id));
  if (d.startingRow) leads = leads.slice(Math.max(0, d.startingRow - 1));
  if (d.count) leads = leads.slice(0, d.count);
  leads = leads.filter((l) => matchesFilters(l, d.filters));
  const max = d.limit ?? Math.min(...enrichments.map((e) => e.limit ?? Number.MAX_SAFE_INTEGER));
  if (Number.isFinite(max)) leads = leads.slice(0, max);
  const workspaceKey = enrichments.some((e) => e.type === "ai_enrichment") ? (await resolveAi(job.workspaceId).catch(() => null))?.source === "workspace" : false;
  const unmetered = (await workspaceLimits(job.workspaceId)).self_hosted;
  // Picked up again after the app stopped mid-run: the leads it already did are left alone, so nothing is charged twice.
  const overwrite = job.attempts > 0 ? false : d.overwrite;
  const stats = new Map(enrichments.map((e) => [e.id, { processed: 0, succeeded: 0, failed: 0, credits: 0 }]));
  let stopReason: string | null = null;
  outer: for (let i = 0; i < leads.length; i++) {
    if (i % 5 === 0 && (await cancelled())) {
      stopReason = "cancelled";
      break;
    }
    const lead = leads[i]!;
    for (const e of enrichments) {
      const s = stats.get(e.id)!;
      if (e.skipRowsWithoutEmail && !lead.email && e.type !== "work_email_enrichment" && e.type !== "custom_flow") continue;
      let r: StepResult;
      try {
        r = await enrichOne(e, lead, { ...d, overwrite, workspaceKey });
      } catch (err) {
        r = { ok: false, error: (err as Error).message };
      }
      if (r.skipped) continue;
      s.processed++;
      if (!r.ok) {
        s.failed++;
        if (d.dropWithoutEmail && isLookup(e.type)) {
          dropped.push(lead.id);
          break;
        }
        continue;
      }
      s.succeeded++;
      const cost = unmetered || (e.type === "ai_enrichment" && workspaceKey) ? 0 : (r.cost ?? COST[e.type] ?? 0);
      if (cost > 0) {
        if (!(await chargeCredits(job.workspaceId, cost, `enrichment:${e.type}`, { refId: lead.id, userId: job.userId }))) {
          stopReason = "OUT_OF_CREDITS";
          break outer;
        }
        s.credits += cost;
      }
    }
    if (i % 5 === 0 || i === leads.length - 1) await progress(Math.round(((i + 1) / Math.max(1, leads.length)) * 100), { processed: i + 1, total: leads.length });
  }
  for (let i = 0; i < dropped.length; i += 800) await db.delete(L).where(and(eq(L.workspaceId, job.workspaceId), inArray(L.id, dropped.slice(i, i + 800))));
  for (const e of enrichments) {
    const s = stats.get(e.id)!;
    await db.update(E).set({ processed: sql`${E.processed} + ${s.processed}`, succeeded: sql`${E.succeeded} + ${s.succeeded}` }).where(eq(E.id, e.id));
    await db
      .update(RUNS)
      .set({ status: stopReason === "cancelled" ? "cancelled" : stopReason ? "failed" : "completed", processed: s.processed, succeeded: s.succeeded, failed: s.failed, creditsUsed: s.credits, error: stopReason, finishedAt: new Date() })
      .where(and(eq(RUNS.jobId, job.id), eq(RUNS.enrichmentId, e.id)));
  }
  emit("enrichment_completed", job.workspaceId, { resource_id: d.resource_id, resource_type: resource.type, leads: leads.length, stop_reason: stopReason });
  // The webhook event offered for it ("Lead finder enrichment completed"). The run is done either way.
  const campaignId = resource.type === 1 ? d.resource_id : null;
  await enqueueWebhooks(
    job.workspaceId,
    "supersearch_enrichment_completed",
    {
      campaign_id: campaignId,
      campaign_name: campaignId ? resource.name : null,
      list_id: campaignId ? null : d.resource_id,
      list_name: campaignId ? null : resource.name,
      leads: leads.length,
      removed_without_email: dropped.length,
      stop_reason: stopReason,
      enrichments: enrichments.map((e) => ({ type: e.type, ...stats.get(e.id)! })),
    },
    { campaignId },
  ).catch((err) => console.warn(`[enrichment] webhook for job ${job.id} not queued: ${(err as Error).message}`));
  return {
    leads: leads.length,
    stop_reason: stopReason,
    removed_without_email: dropped.length,
    ...Object.fromEntries([...stats.entries()].map(([id, s]) => [enrichments.find((e) => e.id === id)!.type, s])),
  };
}

registerJobHandler("enrich-leads", enrichLeads);

// However a run ended (finished, failed, its list deleted meanwhile, stopped before it started, given up after
// restarts), its history says so, and its columns stop showing as running unless another run still fills them.
registerJobCleanup("enrich-leads", async (job, { handlerRan }) => {
  const d = job.data as unknown as { resource_id: string; enrichment_ids?: string[] };
  const stopped = !handlerRan && job.status === "cancelled";
  await db
    .update(RUNS)
    .set(
      stopped
        ? { status: "cancelled", error: "cancelled", finishedAt: new Date() }
        : { status: "failed", error: (!handlerRan && job.error) || "The run stopped because of an error. Run it again.", finishedAt: new Date() },
    )
    .where(and(eq(RUNS.jobId, job.id), eq(RUNS.status, "running")));
  await settleRunning(job.workspaceId, d.resource_id, d.enrichment_ids ?? [], job.id);
});

// New leads in a resource with auto-updating enrichments are enriched automatically.
on("lead_added", async (ev) => {
  const resourceId = (ev.data.list_id ?? ev.data.campaign_id) as string | null;
  const ids = ev.data.lead_ids as string[] | undefined;
  if (!resourceId || !ids?.length) return;
  const auto = await db.select({ type: E.type }).from(E).where(and(eq(E.workspaceId, ev.workspaceId), eq(E.resourceId, resourceId), eq(E.autoUpdate, true)));
  const types = auto.map((a) => a.type).filter((t) => t !== "supersearch");
  if (types.length) await scheduleRun(ev.workspaceId, null, resourceId, { leadIds: ids, types, auto: true });
});

// ---------- Serializers ----------

export async function resourceEnrichmentSummary(workspaceId: string, resourceId: string) {
  const rows = await db.select().from(E).where(and(eq(E.workspaceId, workspaceId), eq(E.resourceId, resourceId)));
  const [anyLead] = await db.select({ id: L.id }).from(L).where(and(eq(L.workspaceId, workspaceId), or(eq(L.listId, resourceId), eq(L.campaignId, resourceId)))).limit(1);
  const flags: Record<string, unknown> = { work_email_enrichment: false, fully_enriched_profile: false, email_verification: false, joblisting: false, technologies: false, news: false, funding: false, engagement_score: false, ai_enrichment: {}, custom_flow: [], limit: null, autofill: false };
  let searchFilters: unknown = undefined;
  for (const r of rows) {
    if (r.type === "supersearch") {
      searchFilters = (r.enrichmentPayload ?? {}).search_filters;
      if (r.limit) flags.limit = r.limit;
      continue;
    }
    if (r.type === "ai_enrichment") flags.ai_enrichment = (r.enrichmentPayload ?? {}).columns ?? {};
    else if (r.type === "custom_flow") flags.custom_flow = (r.enrichmentPayload ?? {}).custom_flow ?? [];
    else flags[r.type] = true;
    if (r.limit) flags.limit = r.limit;
  }
  return {
    resource_id: resourceId,
    in_progress: rows.some((r) => r.inProgress),
    has_no_leads: !anyLead,
    exists: rows.length > 0,
    enrichment_payload: flags,
    auto_update: rows.some((r) => r.autoUpdate),
    is_evergreen: rows.some((r) => !!(r.enrichmentPayload ?? {}).is_evergreen),
    ...(searchFilters ? { search_filters: searchFilters } : {}),
  };
}

export function serializeEnrichment(r: EnrichmentRow, jobId?: string | null) {
  return {
    id: r.id,
    job_id: jobId ?? null,
    limit: r.limit,
    organization_id: r.workspaceId,
    resource_id: r.resourceId,
    resource_type: r.resourceType,
    type: r.type,
    enrichment_payload: r.enrichmentPayload ?? {},
    auto_update: r.autoUpdate,
    skip_rows_without_email: r.skipRowsWithoutEmail,
    in_progress: r.inProgress,
  };
}

export async function enrichmentHistory(workspaceId: string, resourceId: string, page: { limit: number; offset: number }) {
  const rows = await db
    .select()
    .from(RUNS)
    .where(and(eq(RUNS.workspaceId, workspaceId), eq(RUNS.resourceId, resourceId)))
    .orderBy(desc(RUNS.startedAt))
    .limit(page.limit)
    .offset(page.offset);
  return rows.map((r) => ({
    id: r.id,
    enrichment_id: r.enrichmentId,
    resource_id: r.resourceId,
    type: r.type,
    status: r.status,
    processed: r.processed,
    succeeded: r.succeeded,
    failed: r.failed,
    credits_used: r.creditsUsed,
    error: r.error,
    job_id: r.jobId,
    timestamp_created: iso(r.startedAt),
    timestamp_finished: iso(r.finishedAt),
  }));
}

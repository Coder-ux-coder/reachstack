// Lead Finder (SuperSearch): people search over the installation's dataset, imports into lists/campaigns,
// enrichment columns, saved searches, company lists (API v2) and the app's search/reveal/export screens.
import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import * as z4 from "zod/v4";
import {
  EMPLOYEE_BANDS,
  ENRICHMENT_COLUMN_KINDS,
  ENRICHMENT_COLUMN_TYPES,
  ENRICHMENT_TYPES,
  FUNDING_TYPES,
  INDUSTRY_TREE,
  LF_DEPARTMENTS,
  LF_LEVELS,
  LF_NEWS_TYPES,
  NORMALIZE_TARGET_KEYS,
  REVENUE_BANDS,
  SIGNAL_TYPES,
  WATERFALL_PROVIDERS,
  aiColumnNameError,
  type NormalizeTarget,
} from "@reachstack/shared";
import { contains, db, escapeLike, schema } from "../db/client";
import { config } from "../env";
import { ctx } from "../http/context";
import { may } from "../http/auth";
import { assertFound, badRequest, conflict, forbidden, notFound } from "../http/errors";
import { body, query, zInt } from "../http/util";
import { uuidv7 } from "../lib/ids";
import { iso } from "../lib/time";
import { workspaceToday } from "../services/workspace-clock";
import { aiAvailable, cachedSystem, resolveAi, structured, toHttpError } from "../services/ai";
import { createJob, getJob, registerJobHandler, serializeJob } from "../services/jobs";
import { isInstanceAdmin, requireInstanceAdmin } from "../services/instance";
import {
  LOCAL_PROVIDER,
  LOCAL_SOURCE,
  MAX_COMPANY_LIST_RECORDS,
  companyListRecipes,
  companySources,
  countCompanies,
  filterOptions,
  serializeCompanyList,
  validateCompanyListFilters,
} from "../services/lead-finder/company-lists";
import { checkDatasetHeaders, clearWorkspaceDataset, datasetStats, deleteDemoDataset, parseDatasetCsv } from "../services/lead-finder/dataset";
import {
  enrichmentHistory,
  resolveResource,
  resourceEnrichmentSummary,
  scheduleRun,
  serializeEnrichment,
  upsertEnrichment,
  type AiColumnConfig,
} from "../services/lead-finder/enrichment";
import { columnKey, findColumn, listColumns, removeColumn, resourceColumns, runColumn, stopColumn } from "../services/lead-finder/enrichment-columns";
import { unlockPeople } from "../services/lead-finder/imports";
import { findAction, providerRegistry, validateIntegrationActions } from "../services/lead-finder/integrations";
import { countPeople, peopleByIds, personLocation, previewLead, searchConditions, searchFiltersSchema, searchPeople, SIGNAL_NEWS, type PersonResult, type SearchFilters } from "../services/lead-finder/search";
import { chargeCredits, creditBalance, workspaceLimits } from "../services/billing-limits";
import { leadFilterSchema } from "../services/leads";
import { toCsv } from "../lib/csv";

const SS = "supersearch_enrichments";
const ssRead = { scope: [SS, "read"] as [string, "read"], perm: "lead_finder" as const };
const ssWrite = (a: "create" | "update" | "delete") => ({ scope: [SS, a] as [string, typeof a], perm: "lead_finder" as const, write: true });
// Enrichment columns live on lists and campaigns, so they follow the leads permission.
const enrRead = { scope: [SS, "read"] as [string, "read"], perm: "leads" as const };
const enrWrite = (a: "create" | "update") => ({ scope: [SS, a] as [string, typeof a], perm: "leads" as const, write: true });

const filtersBody = z.object({ search_filters: searchFiltersSchema, skip_owned_leads: z.boolean().optional(), show_one_lead_per_company: z.boolean().optional() });
const withFlags = (b: z.infer<typeof filtersBody>): SearchFilters => ({
  ...b.search_filters,
  ...(b.skip_owned_leads !== undefined ? { skip_owned_leads: b.skip_owned_leads } : {}),
  ...(b.show_one_lead_per_company !== undefined ? { show_one_lead_per_company: b.show_one_lead_per_company } : {}),
});

const customFlowSchema = z
  .array(z.string())
  .min(1, "custom_flow must list at least one provider")
  .superRefine((ids, c) => {
    const bad = ids.filter((id, i) => !(WATERFALL_PROVIDERS as readonly string[]).includes(id) || ids.indexOf(id) !== i);
    if (bad.length) c.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid or repeated provider: ${[...new Set(bad)].join(", ")}. Use: ${WATERFALL_PROVIDERS.join(", ")}` });
  });

const aiColumnSchema = z.object({
  output_column: z.string().trim().min(1).max(100),
  prompt: z.string().max(20_000).optional(),
  template_id: z.string().nullable().optional(),
  input_columns: z.array(z.string()).max(50).optional(),
  model_version: z.string().max(100).optional(),
  use_instantly_account: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  skip_leads_without_email: z.boolean().optional(),
  status: z.number().int().optional(),
});

/** Resolves a prompt template into the column's prompt and checks that AI can run for the workspace. */
async function aiColumnConfig(workspaceId: string, raw: z.infer<typeof aiColumnSchema>): Promise<AiColumnConfig> {
  let prompt = raw.prompt?.trim() ?? "";
  if (raw.template_id) {
    const T = schema.customPromptTemplates;
    const [t] = await db.select().from(T).where(and(eq(T.id, raw.template_id), or(eq(T.workspaceId, workspaceId), eq(T.isPublic, true)))).limit(1);
    if (!t) throw badRequest("Prompt template not found");
    prompt = t.prompt;
  }
  if (!prompt) throw badRequest("Provide a prompt or a template_id");
  if (raw.use_instantly_account === false && (await resolveAi(workspaceId).catch(() => null))?.source !== "workspace") {
    throw badRequest("Add your own Anthropic API key in Settings → Integrations & API → AI, or set use_instantly_account to true");
  }
  if (!(await aiAvailable(workspaceId))) throw badRequest("AI is not configured on this server. Add an Anthropic API key in Settings → Integrations & API → AI.");
  return {
    output_column: raw.output_column,
    prompt,
    input_columns: raw.input_columns,
    model_version: raw.model_version,
    overwrite: raw.overwrite ?? false,
    use_instantly_account: raw.use_instantly_account ?? true,
    skip_leads_without_email: raw.skip_leads_without_email ?? false,
    template_id: raw.template_id ?? null,
    status: raw.status ?? 1,
  };
}

async function addAiColumn(workspaceId: string, userId: string | null, resourceId: string, resourceType: 1 | 2, col: AiColumnConfig, extra: { autoUpdate?: boolean; limit?: number | null }) {
  const [existing] = await db.select().from(schema.enrichments).where(and(eq(schema.enrichments.workspaceId, workspaceId), eq(schema.enrichments.resourceId, resourceId), eq(schema.enrichments.type, "ai_enrichment"))).limit(1);
  const columns = { ...(((existing?.enrichmentPayload ?? {}).columns ?? {}) as Record<string, AiColumnConfig>), [col.output_column]: col };
  let autoUpdate = extra.autoUpdate;
  if (col.auto_update !== undefined) {
    // Columns saved from the leads table each say whether they fill in new leads; older columns keep what they did.
    for (const [name, other] of Object.entries(columns)) if (other.auto_update === undefined) columns[name] = { ...other, auto_update: !!existing?.autoUpdate };
    autoUpdate = Object.values(columns).some((c) => c.auto_update);
  }
  return upsertEnrichment({ workspaceId, resourceId, resourceType, type: "ai_enrichment", payload: { columns }, autoUpdate, limit: extra.limit, userId });
}

const maskEmail = (e: string | null) => {
  if (!e) return null;
  const [local, domain] = e.split("@");
  return `${local![0]}${"*".repeat(Math.max(3, Math.min(8, local!.length - 1)))}@${domain}`;
};

function appPerson(p: PersonResult, revealed: boolean) {
  return {
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    full_name: p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(" "),
    title: p.title,
    seniority: p.seniority,
    department: p.department,
    location: personLocation(p),
    linkedin_url: p.linkedin_url,
    email: revealed ? p.email : null,
    email_masked: revealed ? null : maskEmail(p.email),
    email_status: p.email ? p.email_status : null,
    has_email: !!p.email,
    phone: revealed ? p.phone : null,
    has_phone: !!p.phone,
    revealed,
    owned: !!p.owned,
    company: p.company_id
      ? {
          id: p.company_id,
          name: p.company_name,
          domain: p.company_domain,
          industry: p.industry,
          sub_industry: p.sub_industry,
          employee_count: p.employee_count,
          revenue_range: p.revenue_range,
          logo_url: p.logo_url,
          linkedin_url: p.company_linkedin,
          location: [p.company_city, p.company_state, p.company_country].filter(Boolean).join(", "),
        }
      : null,
  };
}

/** A short label for a search, used for history entries and default list names. */
function describeFilters(f: SearchFilters): string {
  const parts: string[] = [];
  if (f.title?.include?.length) parts.push(f.title.include.slice(0, 2).join(", "));
  if (f.level?.length) parts.push(f.level.slice(0, 2).join(", "));
  if (f.department?.length) parts.push(f.department.slice(0, 2).join(", "));
  if (f.industry?.include?.length) parts.push(f.industry.include.slice(0, 2).join(", "));
  const locs = Array.isArray(f.locations) ? f.locations : (f.locations?.include ?? []);
  if (locs.length) parts.push(`in ${locs.slice(0, 2).map((l) => (typeof l === "string" ? l : l.label)).join(", ")}`);
  if (f.employeeCount?.length) parts.push(`${f.employeeCount.map((e) => (typeof e === "string" ? e : `${e.min}+`)).join(", ")} employees`);
  if (f.company_name?.include?.length) parts.push(`at ${f.company_name.include.slice(0, 2).join(", ")}`);
  if (f.keyword_filter?.include) parts.push(`"${f.keyword_filter.include.slice(0, 30)}"`);
  return parts.join(" · ") || "All people";
}

const serializeSaved = (s: typeof schema.lfSavedSearches.$inferSelect) => ({ id: s.id, name: s.name, search_filters: s.filters, organization_id: s.workspaceId, timestamp_created: iso(s.createdAt) });

registerJobHandler("lf-export", async ({ job, progress }) => {
  const d = job.data as { filters?: SearchFilters; person_ids?: string[]; limit: number };
  const people = d.person_ids?.length ? await peopleByIds(job.workspaceId, d.person_ids) : await searchPeople(job.workspaceId, d.filters ?? {}, { limit: d.limit, offset: 0 });
  await progress(30);
  const { allowed, charged, outOfCredits } = await unlockPeople(job.workspaceId, job.userId, people.slice(0, d.limit), "lead_finder:export");
  const rows = allowed.map((p) => ({
    first_name: p.first_name ?? "",
    last_name: p.last_name ?? "",
    title: p.title ?? "",
    seniority: p.seniority ?? "",
    department: p.department ?? "",
    email: p.email ?? "",
    email_status: p.email_status ?? "",
    phone: p.phone ?? "",
    linkedin_url: p.linkedin_url ?? "",
    location: personLocation(p),
    company_name: p.company_name ?? "",
    company_domain: p.company_domain ?? "",
    industry: p.industry ?? "",
    employee_count: p.employee_count ?? "",
    revenue_range: p.revenue_range ?? "",
  }));
  const file = path.join(config.dataDir, "exports", `${job.id}.csv`);
  await writeFile(file, toCsv(rows));
  await db.insert(schema.lfExports).values({ workspaceId: job.workspaceId, name: (job.data as { name?: string }).name ?? `Lead Finder export ${await workspaceToday(job.workspaceId)}`, count: rows.length, filePath: `${job.id}.csv`, createdBy: job.userId });
  return { count: rows.length, credits_used: charged, out_of_credits: outOfCredits, file: `${job.id}.csv` };
});

export default async function leadFinderRoutes(app: FastifyInstance) {
  // ---------- Search (API v2) ----------

  app.post("/api/v2/supersearch-enrichment/count-leads-from-supersearch", { config: ssRead }, async (req) => {
    const c = ctx(req);
    const b = body(req, filtersBody);
    return { number_of_leads: await countPeople(c.wsId, withFlags(b)) };
  });

  app.post("/api/v2/supersearch-enrichment/preview-leads-from-supersearch", { config: ssRead }, async (req) => {
    const c = ctx(req);
    const b = body(req, filtersBody);
    const f = withFlags(b);
    const [total, rows] = await Promise.all([countPeople(c.wsId, f), searchPeople(c.wsId, f, { limit: 25, offset: 0 })]);
    const mode = f.location_mode ?? f.locationMode ?? "contact";
    return { number_of_leads: total, number_of_redacted_results: 0, leads: rows.map((p) => previewLead(p, mode)) };
  });

  app.post("/api/v2/supersearch-enrichment/signal-keywords-facet", { config: ssRead }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ category: z.string(), field: z.string(), prefix: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }));
    if (!(SIGNAL_TYPES as readonly string[]).includes(b.category)) throw badRequest(`Unknown signal category: ${b.category}`);
    const types = SIGNAL_NEWS[b.category];
    if (!types) return { keywords: [] }; // only website news signals have local records
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const rows = await db.all<{ title: string; name: string }>(
      sql`select json_extract(value, '$.title') as title, c.name as name from lf_companies c, json_each(c.news)
          where (c.workspace_id is null or c.workspace_id = ${c.wsId}) and json_extract(value, '$.type') in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
          and coalesce(json_extract(value, '$.date'), '') >= ${since} limit 20000`,
    );
    const STOP = new Set(["the", "a", "an", "and", "of", "in", "to", "for", "with", "its", "new", "on", "by", "at", "from", "as", "is", "this", "year"]);
    const counts = new Map<string, number>();
    const words = (s: string | null) => s?.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
    for (const r of rows) {
      const own = new Set(words(r.name)); // the company's own name says nothing about the signal
      for (const w of new Set(words(r.title))) if (!STOP.has(w) && !own.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const prefix = b.prefix?.toLowerCase() ?? "";
    const keywords = [...counts.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort((a, b2) => b2[1] - a[1])
      .slice(0, b.limit ?? 20)
      .map(([keyword, count]) => ({ keyword, count }));
    return { keywords };
  });

  // ---------- Import from a search ----------

  app.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { config: ssWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        search_filters: searchFiltersSchema,
        search_name: z.string().max(200).optional(),
        work_email_enrichment: z.boolean().optional(),
        fully_enriched_profile: z.boolean().optional(),
        email_verification: z.boolean().optional(),
        custom_flow: customFlowSchema.optional(),
        signal_enrichment: z.array(z.union([z.string(), z.object({ key: z.string(), period_days: z.number().optional(), keywords: z.unknown().optional() })])).optional(),
        resource_id: z.string().optional(),
        auto_update: z.boolean().optional(),
        skip_rows_without_email: z.boolean().optional(),
        list_name: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50_000),
        ai_enrichment: z.record(aiColumnSchema.omit({ output_column: true }).extend({ output_column: z.string().optional() })).optional(),
      }),
    );
    const badSignals = (b.signal_enrichment ?? []).map((s) => (typeof s === "string" ? s : s.key)).filter((k) => !(SIGNAL_TYPES as readonly string[]).includes(k));
    if (badSignals.length) throw badRequest(`Unknown signal categories: ${badSignals.join(", ")}`);
    // A search that can't run (a company list that's gone or still being built) fails here, before a list is made.
    await searchConditions(c.wsId, b.search_filters);
    // Columns are configured before the list exists so a bad AI setup fails before anything is created.
    const aiColumns: AiColumnConfig[] = [];
    for (const [name, cfg] of Object.entries(b.ai_enrichment ?? {})) aiColumns.push(await aiColumnConfig(c.wsId, { ...cfg, output_column: cfg.output_column ?? name }));

    let resourceId = b.resource_id;
    let resourceType: 1 | 2 = 2;
    let listName: string | undefined;
    if (resourceId) {
      // Adding people to an existing list or campaign changes its leads (a campaign starts emailing them).
      if (!may(req, "leads")) throw forbidden("Adding people to an existing list or campaign needs access to leads. Save them to a new list instead.");
      const r = await resolveResource(c.wsId, resourceId);
      resourceType = r.type;
      listName = r.name;
    } else {
      listName = b.list_name?.trim() || b.search_name?.trim() || `${describeFilters(b.search_filters).slice(0, 80)} (${await workspaceToday(c.wsId)})`;
      const [list] = await db.insert(schema.leadLists).values({ workspaceId: c.wsId, name: listName, hasEnrichmentTask: true, ownedBy: c.userId, createdBy: c.userId }).returning();
      resourceId = list!.id;
    }
    const common = { workspaceId: c.wsId, resourceId, resourceType, userId: c.userId, autoUpdate: b.auto_update, skipRowsWithoutEmail: b.skip_rows_without_email };
    const ss = await upsertEnrichment({ ...common, type: "supersearch", limit: b.limit, payload: { search_filters: b.search_filters, search_name: b.search_name ?? null, list_name: listName } });
    const types: string[] = [];
    if (b.custom_flow) {
      await upsertEnrichment({ ...common, type: "custom_flow", payload: { custom_flow: b.custom_flow } });
      types.push("custom_flow");
    } else if (b.work_email_enrichment && resourceType === 2) {
      await upsertEnrichment({ ...common, type: "work_email_enrichment" });
      types.push("work_email_enrichment");
    }
    if (b.fully_enriched_profile) {
      await upsertEnrichment({ ...common, type: "fully_enriched_profile" });
      types.push("fully_enriched_profile");
    }
    if (b.email_verification) {
      await upsertEnrichment({ ...common, type: "email_verification" });
      types.push("email_verification");
    }
    for (const col of aiColumns) await addAiColumn(c.wsId, c.userId, resourceId, resourceType, col, { autoUpdate: b.auto_update });
    if (aiColumns.length) types.push("ai_enrichment");
    await db.update(schema.enrichments).set({ inProgress: true }).where(eq(schema.enrichments.id, ss.id));
    const job = await createJob({
      workspaceId: c.wsId,
      userId: c.userId,
      type: "lead-finder-import",
      entityId: resourceId,
      entityType: resourceType === 1 ? "campaign" : "list",
      data: {
        resource_id: resourceId,
        search_filters: b.search_filters,
        limit: b.limit,
        types,
        signal_enrichment: b.signal_enrichment ?? [],
        supersearch_enrichment_id: ss.id,
        skip_rows_without_email: !!b.skip_rows_without_email,
      },
    });
    return {
      id: ss.id,
      organization_id: c.wsId,
      resource_id: resourceId,
      resource_type: resourceType,
      search_filters: b.search_filters,
      limit: b.limit,
      list_name: listName,
      custom_flow: b.custom_flow ?? [],
      background_job_id: job.id,
      live_list_workflow_id: null,
    };
  });

  // ---------- Enrichment columns on a list or campaign ----------

  app.post("/api/v2/supersearch-enrichment", { config: enrWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        resource_id: z.string(),
        type: z.enum([...ENRICHMENT_TYPES, "normalize"] as [string, ...string[]]).optional(),
        limit: z.number().int().positive().optional(),
        filters: z.array(z.object({ column_name: z.string(), type: z.number(), value: z.array(z.string()) })).optional(),
        custom_flow: customFlowSchema.optional(),
        integration_actions: z.unknown().optional(),
      }),
    );
    if (!b.type && !b.integration_actions) throw badRequest("Send a type or integration_actions");
    if (b.type && b.integration_actions) throw badRequest("type and integration_actions cannot be combined");
    if (b.type === "custom_flow" && !b.custom_flow) throw badRequest("custom_flow is required for a custom_flow enrichment");
    if (b.type === "ai_enrichment") throw badRequest("Create AI columns with POST /api/v2/supersearch-enrichment/ai");
    const r = await resolveResource(c.wsId, b.resource_id);
    const type = b.integration_actions ? "integration" : b.type!;
    const payload = b.integration_actions ? { actions: validateIntegrationActions(b.integration_actions) } : b.type === "custom_flow" ? { custom_flow: b.custom_flow } : {};
    const row = await upsertEnrichment({ workspaceId: c.wsId, resourceId: b.resource_id, resourceType: r.type, type: type as never, payload, limit: b.limit ?? null, userId: c.userId });
    const job = await scheduleRun(c.wsId, c.userId, b.resource_id, { types: [type], limit: b.limit, filters: b.filters });
    const summary = await resourceEnrichmentSummary(c.wsId, b.resource_id);
    return { ...serializeEnrichment(row, job?.id), enrichment_payload: summary.enrichment_payload };
  });

  app.get("/api/v2/supersearch-enrichment/:resource_id", { config: enrRead }, async (req) => {
    const c = ctx(req);
    const { resource_id } = req.params as { resource_id: string };
    await resolveResource(c.wsId, resource_id);
    return resourceEnrichmentSummary(c.wsId, resource_id);
  });

  app.patch("/api/v2/supersearch-enrichment/:resource_id/settings", { config: enrWrite("update") }, async (req) => {
    const c = ctx(req);
    const { resource_id } = req.params as { resource_id: string };
    const b = body(req, z.object({ auto_update: z.boolean().optional(), skip_rows_without_email: z.boolean().optional(), is_evergreen: z.boolean().optional() }));
    await resolveResource(c.wsId, resource_id);
    const E = schema.enrichments;
    const rows = await db.select().from(E).where(and(eq(E.workspaceId, c.wsId), eq(E.resourceId, resource_id)));
    if (!rows.length) throw notFound("Enrichment");
    for (const r of rows) {
      await db
        .update(E)
        .set({
          ...(b.auto_update !== undefined ? { autoUpdate: b.auto_update } : {}),
          ...(b.skip_rows_without_email !== undefined ? { skipRowsWithoutEmail: b.skip_rows_without_email } : {}),
          ...(b.is_evergreen !== undefined ? { enrichmentPayload: { ...(r.enrichmentPayload ?? {}), is_evergreen: b.is_evergreen } } : {}),
        })
        .where(eq(E.id, r.id));
    }
    const [first] = await db.select().from(E).where(and(eq(E.workspaceId, c.wsId), eq(E.resourceId, resource_id))).orderBy(E.createdAt).limit(1);
    return serializeEnrichment(first!);
  });

  app.post("/api/v2/supersearch-enrichment/ai", { config: enrWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      aiColumnSchema.extend({
        resource_id: z.string(),
        resource_type: z.union([z.literal(1), z.literal(2)]),
        model_version: z.string().max(100),
        auto_update: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        filters: z.array(z.object({ column_name: z.string(), type: z.number(), value: z.array(z.string()) })).optional(),
      }),
    );
    const r = await resolveResource(c.wsId, b.resource_id);
    if (r.type !== b.resource_type) throw badRequest(`resource_id is a ${r.type === 1 ? "campaign" : "list"}; set resource_type to ${r.type}`);
    const col = await aiColumnConfig(c.wsId, b);
    const row = await addAiColumn(c.wsId, c.userId, b.resource_id, r.type, col, { autoUpdate: b.auto_update, limit: b.limit ?? null });
    if (col.status !== 2) await scheduleRun(c.wsId, c.userId, b.resource_id, { types: ["ai_enrichment"], columnName: col.output_column, limit: b.limit, filters: b.filters });
    return {
      id: row.id,
      resource_id: b.resource_id,
      resource_type: r.type,
      output_column: col.output_column,
      status: col.status ?? 1,
      model_version: b.model_version,
      input_columns: col.input_columns ?? [],
      overwrite: col.overwrite ?? false,
      auto_update: row.autoUpdate ?? false,
      limit: b.limit,
      template_id: col.template_id ?? null,
    };
  });

  app.get("/api/v2/supersearch-enrichment/ai/:resource_id/in-progress", { config: enrRead }, async (req) => {
    const c = ctx(req);
    const { resource_id } = req.params as { resource_id: string };
    const r = await resolveResource(c.wsId, resource_id);
    const [row] = await db.select().from(schema.enrichments).where(and(eq(schema.enrichments.workspaceId, c.wsId), eq(schema.enrichments.resourceId, resource_id), eq(schema.enrichments.type, "ai_enrichment"))).limit(1);
    if (!row?.inProgress) return [];
    return Object.values(((row.enrichmentPayload ?? {}).columns ?? {}) as Record<string, AiColumnConfig>).map((col) => ({
      id: row.id,
      organization_id: c.wsId,
      resource_id,
      resource_type: r.type,
      output_column: col.output_column,
      status: col.status === 2 ? 2 : 1,
    }));
  });

  app.post("/api/v2/supersearch-enrichment/run", { config: enrWrite("update") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        resource_id: z.string(),
        lead_ids: z.array(z.string()).max(10_000).optional(),
        limit: z.number().int().positive().optional(),
        column_name: z.string().optional(),
        overwrite: z.boolean().optional(),
        starting_row: z.number().int().min(1).optional(),
        count: z.number().int().positive().optional(),
        filters: z.array(z.object({ column_name: z.string(), type: z.number(), value: z.array(z.string()) })).optional(),
      }),
    );
    if (!b.column_name && (b.overwrite !== undefined || b.starting_row || b.count)) throw badRequest("overwrite, starting_row and count need column_name");
    await resolveResource(c.wsId, b.resource_id);
    const job = await scheduleRun(c.wsId, c.userId, b.resource_id, {
      leadIds: b.lead_ids,
      limit: b.limit,
      overwrite: b.overwrite,
      columnName: b.column_name,
      startingRow: b.starting_row,
      count: b.count,
      filters: b.filters,
      ...(b.column_name ? { types: ["ai_enrichment"] } : {}),
    });
    if (!job) throw badRequest("This list or campaign has no enrichments to run");
    const summary = await resourceEnrichmentSummary(c.wsId, b.resource_id);
    const [first] = await db.select({ id: schema.enrichments.id }).from(schema.enrichments).where(and(eq(schema.enrichments.workspaceId, c.wsId), eq(schema.enrichments.resourceId, b.resource_id))).limit(1);
    return { id: first?.id, resource_id: b.resource_id, enrichment_payload: summary.enrichment_payload, job_id: job.id };
  });

  app.get("/api/v2/supersearch-enrichment/history/:resource_id", { config: enrRead }, async (req) => {
    const c = ctx(req);
    const { resource_id } = req.params as { resource_id: string };
    const q = query(req, z.object({ offset: zInt(0).optional(), limit: zInt(1, 100).optional() }));
    await resolveResource(c.wsId, resource_id);
    return enrichmentHistory(c.wsId, resource_id, { limit: q.limit ?? 20, offset: q.offset ?? 0 });
  });

  // ---------- App: enrichment columns in the leads table of a list or campaign ----------

  const rowsSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("first"), count: z.number().int().min(1).max(10_000), filter: leadFilterSchema.optional() }),
    z.object({ mode: z.literal("ids"), ids: z.array(z.string()).min(1).max(10_000) }),
    z.object({ mode: z.literal("filter"), filter: leadFilterSchema }),
    z.object({ mode: z.literal("all") }),
  ]);
  const runFields = { rows: rowsSchema, overwrite: z.boolean().optional() };
  const columnSettings = {
    prompt: z.string().trim().max(20_000).optional(),
    skip_leads_without_email: z.boolean().optional(),
    targets: z
      .array(z.enum(NORMALIZE_TARGET_KEYS as [NormalizeTarget, ...NormalizeTarget[]]))
      .min(1, "Pick at least one thing to clean up")
      .optional(),
    auto_update: z.boolean().optional(),
  };
  const columnRead = { perm: "leads" as const };
  const columnWrite = { perm: "leads" as const, write: true };

  app.get("/api/app/enrichment-columns/:resource_id", { config: columnRead }, async (req) => {
    const c = ctx(req);
    const { resource_id } = req.params as { resource_id: string };
    const r = await resolveResource(c.wsId, resource_id);
    const limits = await workspaceLimits(c.wsId);
    return {
      resource_id,
      resource_type: r.type,
      ai_available: await aiAvailable(c.wsId),
      self_hosted: limits.self_hosted,
      credits: limits.self_hosted ? null : await creditBalance(c.wsId),
      ...(await listColumns(c.wsId, resource_id, r.type)),
    };
  });

  app.post("/api/app/enrichment-columns", { config: columnWrite }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({ resource_id: z.string(), type: z.enum(ENRICHMENT_COLUMN_TYPES), name: z.string().trim().optional(), ...columnSettings, run: z.object(runFields).optional() }),
    );
    const r = await resolveResource(c.wsId, b.resource_id);
    const kind = ENRICHMENT_COLUMN_KINDS.find((k) => k.type === b.type)!;
    if (kind.listsOnly && r.type !== 2) throw badRequest(`${kind.label} columns work on lists`);
    if (kind.campaignsOnly && r.type !== 1) throw badRequest(`${kind.label} columns work on campaigns`);
    const existing = await resourceColumns(c.wsId, b.resource_id);
    let key: string = b.type;
    if (b.type === "ai_enrichment") {
      const name = b.name ?? "";
      const nameError = aiColumnNameError(name);
      if (nameError) throw badRequest(`name: ${nameError}`);
      if (existing.some((x) => x.name?.toLowerCase() === name.toLowerCase())) throw conflict(`There's already a column called ${name}`);
      const col = await aiColumnConfig(c.wsId, { output_column: name, prompt: b.prompt, skip_leads_without_email: b.skip_leads_without_email });
      await addAiColumn(c.wsId, c.userId, b.resource_id, r.type, { ...col, auto_update: b.auto_update ?? false }, {});
      key = columnKey(b.type, name);
    } else {
      if (existing.some((x) => x.type === b.type)) throw conflict(`This ${r.type === 1 ? "campaign" : "list"} already has a ${kind.label} column`);
      await upsertEnrichment({
        workspaceId: c.wsId,
        resourceId: b.resource_id,
        resourceType: r.type,
        type: b.type,
        payload: b.type === "normalize" ? { targets: b.targets ?? NORMALIZE_TARGET_KEYS } : {},
        autoUpdate: b.auto_update ?? false,
        userId: c.userId,
      });
    }
    const job = b.run ? await runColumn(c.wsId, c.userId, await findColumn(c.wsId, b.resource_id, key), r.type, b.run.rows, b.run.overwrite ?? false) : null;
    return { key, job_id: job?.id ?? null };
  });

  app.patch("/api/app/enrichment-columns", { config: columnWrite }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ resource_id: z.string(), key: z.string(), ...columnSettings, paused: z.boolean().optional() }));
    const r = await resolveResource(c.wsId, b.resource_id);
    const col = await findColumn(c.wsId, b.resource_id, b.key);
    if (col.ai) {
      if (b.targets) throw badRequest("targets: only clean-up columns have targets");
      const prompt = b.prompt !== undefined ? (await aiColumnConfig(c.wsId, { output_column: col.ai.output_column, prompt: b.prompt })).prompt : col.ai.prompt;
      await addAiColumn(
        c.wsId,
        c.userId,
        b.resource_id,
        r.type,
        {
          ...col.ai,
          prompt,
          skip_leads_without_email: b.skip_leads_without_email ?? col.ai.skip_leads_without_email ?? false,
          auto_update: b.auto_update ?? col.ai.auto_update ?? !!col.row.autoUpdate,
          status: b.paused === undefined ? col.ai.status : b.paused ? 2 : 1,
        },
        {},
      );
    } else {
      if (b.prompt !== undefined || b.skip_leads_without_email !== undefined || b.paused !== undefined) throw badRequest("Only AI columns have a prompt");
      if (b.targets && col.type !== "normalize") throw badRequest("targets: only clean-up columns have targets");
      const E = schema.enrichments;
      const set = {
        ...(b.targets ? { enrichmentPayload: { ...(col.row.enrichmentPayload ?? {}), targets: b.targets } } : {}),
        ...(b.auto_update !== undefined ? { autoUpdate: b.auto_update } : {}),
      };
      if (Object.keys(set).length) await db.update(E).set(set).where(eq(E.id, col.row.id));
    }
    return { key: col.key };
  });

  app.post("/api/app/enrichment-columns/run", { config: columnWrite }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ resource_id: z.string(), key: z.string(), ...runFields }));
    const r = await resolveResource(c.wsId, b.resource_id);
    const col = await findColumn(c.wsId, b.resource_id, b.key);
    if (col.ai?.status === 2) throw badRequest("This column is paused. Resume it first.");
    if (col.ai && !(await aiAvailable(c.wsId))) throw badRequest("AI is not configured on this server. Add an Anthropic API key in Settings → Integrations & API → AI.");
    const job = await runColumn(c.wsId, c.userId, col, r.type, b.rows, b.overwrite ?? false);
    if (!job) throw badRequest("No leads match, so there's nothing to run it on");
    return { key: col.key, job_id: job.id };
  });

  app.post("/api/app/enrichment-columns/stop", { config: columnWrite }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ resource_id: z.string(), key: z.string() }));
    await resolveResource(c.wsId, b.resource_id);
    return { stopped: await stopColumn(c.wsId, await findColumn(c.wsId, b.resource_id, b.key)) };
  });

  app.post("/api/app/enrichment-columns/remove", { config: columnWrite }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ resource_id: z.string(), key: z.string(), clear_values: z.boolean().optional() }));
    const r = await resolveResource(c.wsId, b.resource_id);
    await removeColumn(c.wsId, await findColumn(c.wsId, b.resource_id, b.key), r.type, b.clear_values ?? false);
    return { removed: true };
  });

  // ---------- Integration providers ----------

  app.get("/api/v2/supersearch-enrichment/integrations/providers", { config: ssRead }, async (req) => providerRegistry(ctx(req).wsId));

  app.post("/api/v2/supersearch-enrichment/integrations/run", { config: ssWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ provider_id: z.string(), action_id: z.string(), inputs: z.record(z.union([z.string(), z.number(), z.null()])), credential_source: z.enum(["workspace_key", "instantly_key"]), app_connection_id: z.string().optional() }));
    if (b.credential_source === "workspace_key") throw badRequest("This server runs providers with its own credentials; use credential_source instantly_key");
    const { provider, action } = findAction(b.provider_id, b.action_id);
    const inputs = Object.fromEntries(Object.entries(b.inputs).map(([k, v]) => [k, v === null ? "" : String(v)]));
    const missing = action.inputs.filter((i) => i.required && !inputs[i.key]).map((i) => i.key);
    if (missing.length) throw badRequest(`Missing inputs: ${missing.join(", ")}`);
    const r = await action.run(c.wsId, inputs);
    let credits = 0;
    if (r.value !== null && !r.free && provider.creditCostPerAction > 0 && !(await workspaceLimits(c.wsId)).self_hosted) {
      if (!(await chargeCredits(c.wsId, provider.creditCostPerAction, `integration:${provider.id}:${action.id}`, { userId: c.userId }))) throw badRequest("Not enough credits");
      credits = provider.creditCostPerAction;
    }
    return { provider_id: provider.id, action_id: action.id, output_column: action.outputColumn, value: r.value, output: r.output, credits_used: credits };
  });

  // ---------- Saved searches ----------

  const SV = schema.lfSavedSearches;

  app.get("/api/v2/supersearch-enrichment/saved-searches", { config: ssRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), search: z.string().optional() }));
    const limit = q.limit ?? 20;
    const conds = [eq(SV.workspaceId, c.wsId), eq(SV.isHistory, false)];
    if (q.search) conds.push(contains(sql`lower(${SV.name})`, q.search.toLowerCase()));
    if (q.starting_after) conds.push(lt(SV.id, q.starting_after));
    const rows = await db.select().from(SV).where(and(...conds)).orderBy(desc(SV.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(serializeSaved), ...(rows.length > limit ? { next_starting_after: page[page.length - 1]!.id } : {}) };
  });

  app.post("/api/v2/supersearch-enrichment/saved-searches", { config: ssWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(200), search_filters: searchFiltersSchema }));
    const [row] = await db.insert(SV).values({ workspaceId: c.wsId, name: b.name, filters: b.search_filters, createdBy: c.userId }).returning();
    return serializeSaved(row!);
  });

  const findSaved = async (wsId: string, id: string) => {
    const [row] = await db.select().from(SV).where(and(eq(SV.id, id), eq(SV.workspaceId, wsId), eq(SV.isHistory, false))).limit(1);
    return assertFound(row, "Saved search");
  };

  app.get("/api/v2/supersearch-enrichment/saved-searches/:id", { config: ssRead }, async (req) => serializeSaved(await findSaved(ctx(req).wsId, (req.params as { id: string }).id)));

  app.patch("/api/v2/supersearch-enrichment/saved-searches/:id", { config: ssWrite("update") }, async (req) => {
    const c = ctx(req);
    const row = await findSaved(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(200).optional(), search_filters: searchFiltersSchema.optional() }));
    const [updated] = await db
      .update(SV)
      .set({ ...(b.name ? { name: b.name } : {}), ...(b.search_filters ? { filters: b.search_filters } : {}) })
      .where(eq(SV.id, row.id))
      .returning();
    return serializeSaved(updated!);
  });

  app.delete("/api/v2/supersearch-enrichment/saved-searches/:id", { config: ssWrite("delete") }, async (req) => {
    const c = ctx(req);
    const row = await findSaved(c.wsId, (req.params as { id: string }).id);
    await db.delete(SV).where(eq(SV.id, row.id));
    return { success: true };
  });

  // ---------- Company lists ----------

  const CL = schema.companyLists;
  const findList = async (wsId: string, id: string) => {
    const [row] = await db.select().from(CL).where(and(eq(CL.id, id), eq(CL.workspaceId, wsId))).limit(1);
    return assertFound(row, "Company list");
  };
  const terminal = (s: string) => s === "COMPLETED" || s === "FAILED";

  app.get("/api/v2/supersearch-enrichment/company-lists/recipes", { config: ssRead }, async () => companyListRecipes());
  app.get("/api/v2/supersearch-enrichment/company-lists/sources", { config: ssRead }, async () => companySources());

  app.get("/api/v2/supersearch-enrichment/company-lists/filter-options", { config: ssRead }, async (req) => {
    const q = query(req, z.object({ catalog_id: z.string(), q: z.string().optional(), limit: zInt(1, 500).optional() }));
    return filterOptions(ctx(req).wsId, q.catalog_id, q.q ?? "", q.limit ?? 50);
  });

  app.post("/api/v2/supersearch-enrichment/company-lists", { config: ssWrite("create") }, async (req, reply) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(200), provider_id: z.string(), company_source_id: z.string(), filters: z.record(z.unknown()), limit: z.number().int().min(1) }));
    if (b.provider_id !== LOCAL_PROVIDER || b.company_source_id !== LOCAL_SOURCE) {
      throw badRequest(`Provider ${b.provider_id} is not connected on this server. Available: ${LOCAL_PROVIDER} (company_source_id ${LOCAL_SOURCE}).`);
    }
    if (b.limit > MAX_COMPANY_LIST_RECORDS) throw badRequest(`limit can be at most ${MAX_COMPANY_LIST_RECORDS}`);
    validateCompanyListFilters(b.filters);
    const [row] = await db
      .insert(CL)
      .values({ workspaceId: c.wsId, name: b.name, providerId: b.provider_id, companySourceId: b.company_source_id, requestedCount: b.limit, filters: b.filters, createdBy: c.userId })
      .returning();
    await createJob({ workspaceId: c.wsId, userId: c.userId, type: "company-list-build", entityId: row!.id, entityType: "company_list" });
    reply.code(202);
    return { id: row!.id, status: "PENDING" };
  });

  app.get("/api/v2/supersearch-enrichment/company-lists", { config: ssRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), cursor: z.string().optional(), search: z.string().optional() }));
    const limit = q.limit ?? 20;
    const conds = [eq(CL.workspaceId, c.wsId)];
    if (q.search) conds.push(contains(sql`lower(${CL.name})`, q.search.toLowerCase()));
    const [{ n }] = (await db.select({ n: sql<number>`count(*)` }).from(CL).where(and(...conds))) as [{ n: number }];
    const after = q.starting_after ?? q.cursor;
    if (after) conds.push(lt(CL.id, after));
    const rows = await db.select().from(CL).where(and(...conds)).orderBy(desc(CL.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page[page.length - 1]!.id : undefined;
    return { data: page.map((l) => serializeCompanyList(l)), ...(next ? { next_starting_after: next, next_cursor: next } : {}), total: Math.min(10_000, Number(n)) };
  });

  app.get("/api/v2/supersearch-enrichment/company-lists/:company_list_id", { config: ssRead }, async (req) => {
    const c = ctx(req);
    return serializeCompanyList(await findList(c.wsId, (req.params as { company_list_id: string }).company_list_id), true);
  });

  app.patch("/api/v2/supersearch-enrichment/company-lists/:company_list_id", { config: ssWrite("update") }, async (req) => {
    const c = ctx(req);
    const list = await findList(c.wsId, (req.params as { company_list_id: string }).company_list_id);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(200) }));
    if (!terminal(list.status)) throw conflict("The company list is still being built");
    const [row] = await db.update(CL).set({ name: b.name }).where(eq(CL.id, list.id)).returning();
    return serializeCompanyList(row!, true);
  });

  app.delete("/api/v2/supersearch-enrichment/company-lists/:company_list_id", { config: ssWrite("delete") }, async (req) => {
    const c = ctx(req);
    const list = await findList(c.wsId, (req.params as { company_list_id: string }).company_list_id);
    if (!terminal(list.status)) throw conflict("The company list is still being built");
    await db.delete(schema.companyListMembers).where(eq(schema.companyListMembers.listId, list.id));
    await db.delete(CL).where(eq(CL.id, list.id));
    return { success: true };
  });

  app.get("/api/v2/supersearch-enrichment/company-lists/:company_list_id/companies", { config: ssRead }, async (req) => {
    const c = ctx(req);
    const list = await findList(c.wsId, (req.params as { company_list_id: string }).company_list_id);
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional(), cursor: z.string().optional() }));
    const limit = q.limit ?? 20;
    const M = schema.companyListMembers;
    const conds = [eq(M.listId, list.id)];
    const after = q.starting_after ?? q.cursor;
    if (after) conds.push(sql`${M.id} > ${after}`);
    const rows = await db.select().from(M).where(and(...conds)).orderBy(M.id).limit(limit + 1);
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page[page.length - 1]!.id : undefined;
    return { data: page.map((m) => m.data), ...(next ? { next_starting_after: next, next_cursor: next } : {}) };
  });

  // ---------- App: search screen ----------

  app.get("/api/app/lead-finder/filters", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    const [tech, countries] = await Promise.all([filterOptions(c.wsId, "technologies", "", 300), filterOptions(c.wsId, "countries", "", 300)]);
    return {
      departments: LF_DEPARTMENTS,
      levels: LF_LEVELS,
      employee_bands: Object.keys(EMPLOYEE_BANDS),
      revenue_bands: REVENUE_BANDS,
      news_types: LF_NEWS_TYPES,
      funding_types: FUNDING_TYPES,
      industries: INDUSTRY_TREE,
      signals: SIGNAL_TYPES.map((key) => ({ key, available: !!SIGNAL_NEWS[key] })),
      technologies: tech.options.map((o) => o.label),
      countries: countries.options.map((o) => o.label),
      waterfall_providers: WATERFALL_PROVIDERS,
    };
  });

  app.get("/api/app/lead-finder/locations", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ q: z.string().trim().min(1).max(100) }));
    const needle = `${escapeLike(q.q.toLowerCase())}%`;
    const rows = await db.all<{ city: string | null; state: string | null; country: string | null; n: number }>(
      sql`select city, state, country, count(*) as n from lf_people where (workspace_id is null or workspace_id = ${c.wsId})
          and (lower(city) like ${needle} escape '\\' or lower(state) like ${needle} escape '\\' or lower(country) like ${needle} escape '\\')
          group by lower(city), lower(state), lower(country) order by n desc limit 400`,
    );
    const out = new Map<string, { label: string; place_id: string; type: string; count: number }>();
    const add = (label: string, type: string, n: number) => {
      const key = label.toLowerCase();
      const prev = out.get(key);
      if (prev) prev.count += n;
      else out.set(key, { label, place_id: `${type}:${key}`, type, count: n });
    };
    for (const r of rows) {
      if (r.country?.toLowerCase().startsWith(q.q.toLowerCase())) add(r.country, "country", r.n);
      if (r.state?.toLowerCase().startsWith(q.q.toLowerCase())) add([r.state, r.country].filter(Boolean).join(", "), "region", r.n);
      if (r.city?.toLowerCase().startsWith(q.q.toLowerCase())) add([r.city, r.state, r.country].filter(Boolean).join(", "), "city", r.n);
    }
    return [...out.values()].sort((a, b) => b.count - a.count).slice(0, 15);
  });

  app.post("/api/app/lead-finder/search", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ filters: searchFiltersSchema, page: z.number().int().min(1).max(400).default(1), page_size: z.number().int().min(1).max(100).default(25), record_history: z.boolean().default(true) }));
    const [total, rows, limits] = await Promise.all([countPeople(c.wsId, b.filters), searchPeople(c.wsId, b.filters, { limit: b.page_size, offset: (b.page - 1) * b.page_size }), workspaceLimits(c.wsId)]);
    if (b.page === 1 && b.record_history) {
      const [last] = await db.select().from(SV).where(and(eq(SV.workspaceId, c.wsId), eq(SV.isHistory, true))).orderBy(desc(SV.createdAt)).limit(1);
      if (!last || JSON.stringify(last.filters) !== JSON.stringify(b.filters)) {
        await db.insert(SV).values({ workspaceId: c.wsId, name: describeFilters(b.filters), filters: b.filters, isHistory: true, resultCount: total, createdBy: c.userId });
        // Keep the 50 most recent history entries.
        await db.run(sql`delete from lf_saved_searches where workspace_id = ${c.wsId} and is_history = 1 and id not in (select id from lf_saved_searches where workspace_id = ${c.wsId} and is_history = 1 order by created_at desc limit 50)`);
      }
    }
    // Revealing is free on an unlimited workspace, so its people come with their emails.
    return { total, page: b.page, page_size: b.page_size, items: rows.map((p) => appPerson(p, limits.self_hosted || !!p.unlocked)) };
  });

  app.post("/api/app/lead-finder/reveal", { config: { perm: "lead_finder", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ person_ids: z.array(z.string()).min(1).max(100) }));
    const rows = await peopleByIds(c.wsId, b.person_ids);
    if (!rows.length) throw notFound("People");
    const res = await unlockPeople(c.wsId, c.userId, rows, "lead_finder:reveal");
    const allowed = new Set(res.allowed.map((p) => p.id));
    return { revealed: rows.filter((p) => allowed.has(p.id)).map((p) => appPerson(p, true)), credits_used: res.charged, out_of_credits: res.outOfCredits };
  });

  app.get("/api/app/lead-finder/companies/:id", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    const C = schema.lfCompanies;
    const [co] = await db.select().from(C).where(and(eq(C.id, (req.params as { id: string }).id), or(isNull(C.workspaceId), eq(C.workspaceId, c.wsId)))).limit(1);
    const company = assertFound(co, "Company");
    const [{ n }] = (await db.select({ n: sql<number>`count(*)` }).from(schema.lfPeople).where(eq(schema.lfPeople.companyId, company.id))) as [{ n: number }];
    return {
      id: company.id,
      name: company.name,
      domain: company.domain,
      industry: company.industry,
      sub_industry: company.subIndustry,
      employee_count: company.employeeCount,
      revenue_range: company.revenueRange,
      founded_year: company.foundedYear,
      location: [company.city, company.state, company.country].filter(Boolean).join(", "),
      description: company.description,
      keywords: company.keywords,
      technologies: company.technologies ?? [],
      funding: company.funding,
      linkedin_url: company.linkedinUrl,
      logo_url: company.logoUrl,
      phone: company.phone,
      news: company.news ?? [],
      job_postings: company.jobPostings ?? [],
      people_count: Number(n),
    };
  });

  /** "Describe who you're looking for": turns a sentence into search filters the user can review. */
  app.post("/api/app/lead-finder/ai-filters", { config: { perm: "lead_finder", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ prompt: z.string().trim().min(3).max(1000) }));
    if (!(await aiAvailable(c.wsId))) throw badRequest("AI is not configured. Add an Anthropic API key in Settings → Integrations & API → AI.");
    const industries = Object.keys(INDUSTRY_TREE);
    const bands = Object.keys(EMPLOYEE_BANDS);
    const list = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");
    const system = `You turn a description of a target audience into filters for a B2B people search.
Use only what the description says or clearly implies; leave a filter empty when it doesn't say.
Job titles are short title phrases as they appear on profiles ("Head of Sales", "VP Marketing"); add common variants.
Levels must come from: ${list(LF_LEVELS)}.
Departments must come from: ${list(LF_DEPARTMENTS)}.
Industries must come from: ${list(industries)}.
Employee bands must come from: ${list(bands)}.
Revenue bands must come from: ${list(REVENUE_BANDS)}.
Locations are country, state or city names in English ("United States", "Texas", "Berlin").
Keywords describe what the company does ("payroll software", "dental clinics").
The explanation is one short sentence describing the search in plain words.`;
    let out;
    try {
      out = await structured({
        workspaceId: c.wsId,
        feature: "lead_finder_ai_search",
        effort: "low",
        maxTokens: 2_000,
        system: cachedSystem(system),
        messages: [{ role: "user", content: b.prompt }],
        schema: z4.object({
          job_titles: z4.array(z4.string()),
          exclude_job_titles: z4.array(z4.string()),
          levels: z4.array(z4.string()),
          departments: z4.array(z4.string()),
          locations: z4.array(z4.string()),
          industries: z4.array(z4.string()),
          employee_bands: z4.array(z4.string()),
          revenue_bands: z4.array(z4.string()),
          technologies: z4.array(z4.string()),
          keywords: z4.array(z4.string()),
          company_names: z4.array(z4.string()),
          explanation: z4.string(),
        }),
      });
    } catch (err) {
      throw toHttpError(err);
    }
    // Keep only values the search understands; models occasionally paraphrase a list entry.
    const pick = (values: string[], allowed: readonly string[]) => [
      ...new Set(values.map((v) => allowed.find((a) => a.toLowerCase() === v.trim().toLowerCase())).filter((v): v is string => !!v)),
    ];
    const clean = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))].slice(0, 25);
    const filters: SearchFilters = {};
    if (out.job_titles.length || out.exclude_job_titles.length) filters.title = { include: clean(out.job_titles), exclude: clean(out.exclude_job_titles), includeMode: "CONTAINS", excludeMode: "CONTAINS" };
    const levels = pick(out.levels, LF_LEVELS);
    if (levels.length) filters.level = levels;
    const departments = pick(out.departments, LF_DEPARTMENTS);
    if (departments.length) filters.department = departments;
    if (out.locations.length) filters.locations = { include: clean(out.locations).map((label) => ({ label, place_id: `ai:${label.toLowerCase()}` })) };
    const ind = pick(out.industries, industries);
    if (ind.length) filters.industry = { include: ind };
    const emp = pick(out.employee_bands, bands);
    if (emp.length) filters.employeeCount = emp;
    const rev = pick(out.revenue_bands, REVENUE_BANDS);
    if (rev.length) filters.revenue = rev;
    if (out.technologies.length) filters.technologies = clean(out.technologies);
    if (out.keywords.length) filters.keyword_filter = { include: clean(out.keywords).join(", "), include_mode: "ANY" };
    if (out.company_names.length) filters.company_name = { include: clean(out.company_names) };
    return { filters, explanation: out.explanation.trim() };
  });

  /** Credit balance for the search screen header; null means unlimited (self-hosted). */
  app.get("/api/app/lead-finder/credits", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    const limits = await workspaceLimits(c.wsId);
    if (limits.self_hosted) return { credits: null, monthly_credits: null, unlimited: true };
    return { credits: await creditBalance(c.wsId, "credits"), monthly_credits: limits.monthly_credits, unlimited: false };
  });

  app.get("/api/app/lead-finder/history", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    const rows = await db.select().from(SV).where(and(eq(SV.workspaceId, c.wsId), eq(SV.isHistory, true))).orderBy(desc(SV.createdAt)).limit(50);
    return rows.map((r) => ({ ...serializeSaved(r), result_count: r.resultCount }));
  });

  app.delete("/api/app/lead-finder/history", { config: { perm: "lead_finder", write: true } }, async (req) => {
    const c = ctx(req);
    const res = await db.delete(SV).where(and(eq(SV.workspaceId, c.wsId), eq(SV.isHistory, true)));
    return { deleted: res.rowsAffected };
  });

  // ---------- App: exports ----------

  app.post("/api/app/lead-finder/export", { config: { perm: "lead_finder", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ filters: searchFiltersSchema.optional(), person_ids: z.array(z.string()).max(10_000).optional(), limit: z.number().int().min(1).max(10_000).default(1_000), name: z.string().max(200).optional() }));
    if (!b.filters && !b.person_ids?.length) throw badRequest("Send filters or person_ids");
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: "lf-export", entityType: "lead_finder", data: { filters: b.filters ?? {}, person_ids: b.person_ids, limit: b.limit, name: b.name ?? `${describeFilters(b.filters ?? {})} (${await workspaceToday(c.wsId)})` } });
    return serializeJob(job);
  });

  app.get("/api/app/lead-finder/exports", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    const rows = await db.select().from(schema.lfExports).where(eq(schema.lfExports.workspaceId, c.wsId)).orderBy(desc(schema.lfExports.createdAt)).limit(100);
    return rows.map((r) => ({ id: r.id, name: r.name, count: r.count, job_id: r.filePath?.replace(/\.csv$/, "") ?? null, created_at: iso(r.createdAt) }));
  });

  app.get("/api/app/lead-finder/exports/:id/download", { config: { perm: "lead_finder" } }, async (req, reply) => {
    const c = ctx(req);
    const [row] = await db.select().from(schema.lfExports).where(and(eq(schema.lfExports.id, (req.params as { id: string }).id), eq(schema.lfExports.workspaceId, c.wsId))).limit(1);
    const exp = assertFound(row, "Export");
    const file = path.join(config.dataDir, "exports", path.basename(exp.filePath ?? ""));
    if (!exp.filePath || !existsSync(file)) throw notFound("Export file");
    reply.header("content-type", "text/csv; charset=utf-8").header("x-content-type-options", "nosniff").header("content-disposition", `attachment; filename="lead-finder-${exp.id.slice(0, 8)}.csv"`);
    return reply.send(createReadStream(file));
  });

  // ---------- App: dataset management ----------

  app.get("/api/app/lead-finder/dataset", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    // instance_admin tells the screen whether shared imports and the demo dataset are offered.
    return { ...(await datasetStats(c.wsId)), instance_admin: c.auth.user ? await isInstanceAdmin(c.auth.user) : false };
  });

  /** CSV upload (multipart field "file"; field "scope" = workspace | shared). Shared imports need the instance admin. */
  app.post("/api/app/lead-finder/dataset/import", { config: { perm: "lead_finder", write: true, admin: true } }, async (req) => {
    const c = ctx(req);
    const part = await req.file();
    if (!part) throw badRequest("Upload a CSV file in the field 'file'");
    const scopeField = part.fields.scope as { value?: string } | undefined;
    const shared = scopeField?.value === "shared";
    if (shared) await requireInstanceAdmin(c.user);
    const text = (await part.toBuffer()).toString("utf8");
    const { rows, headers } = parseDatasetCsv(text);
    const mapping = checkDatasetHeaders(headers); // reject unusable files before queuing
    if (!rows.length) throw badRequest("The file has no rows");
    const file = path.join(config.dataDir, "uploads", `lf-${uuidv7()}.csv`);
    await writeFile(file, text);
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: "lf-dataset-import", entityType: "lead_finder", data: { file, shared, rows: rows.length, mapping } });
    return serializeJob(job);
  });

  app.delete("/api/app/lead-finder/dataset", { config: { perm: "lead_finder", write: true, admin: true } }, async (req) => clearWorkspaceDataset(ctx(req).wsId));

  app.post("/api/app/admin/lead-finder/demo-dataset", { config: { write: true } }, async (req) => {
    const c = ctx(req);
    await requireInstanceAdmin(c.user);
    const b = body(req, z.object({ companies: z.number().int().min(10).max(20_000).optional(), seed: z.number().int().optional() }));
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: "lf-demo-dataset", entityType: "lead_finder", data: b });
    return serializeJob(job);
  });

  app.delete("/api/app/admin/lead-finder/demo-dataset", { config: { write: true } }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    return deleteDemoDataset();
  });

  /** Count for the company-list builder before creating a list. */
  app.post("/api/app/lead-finder/company-lists/preview", { config: { perm: "lead_finder" } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ filters: z.record(z.unknown()) }));
    validateCompanyListFilters(b.filters);
    return { count: await countCompanies(c.wsId, b.filters) };
  });

  app.get("/api/app/lead-finder/jobs/:id", { config: { perm: "lead_finder" } }, async (req) => {
    const job = await getJob((req.params as { id: string }).id);
    if (!job || job.workspaceId !== ctx(req).wsId) throw notFound("Job");
    return serializeJob(job);
  });

}

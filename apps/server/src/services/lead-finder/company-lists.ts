// Company lists: a set of companies built from a company source, then used as the audience boundary of a
// people search (search filter `company_list_id`). This server has one source, its own company dataset;
// third-party company databases would plug in as further sources.
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { EMPLOYEE_BANDS, FUNDING_TYPES, INDUSTRY_TREE, LF_NEWS_TYPES, REVENUE_BANDS } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { config } from "../../env";
import { badRequest } from "../../http/errors";
import { iso } from "../../lib/time";
import { normalizeDomain } from "../domains";
import { registerJobCleanup, registerJobHandler } from "../jobs";

export const LOCAL_PROVIDER = "local_dataset";
export const LOCAL_SOURCE = "companies";
const MAX_RECORDS = 10_000;

/** Technology names become slugs the same way in SQL and in JS: lower case, spaces and dots to dashes. */
export const techSlug = (name: string) => name.toLowerCase().replace(/[ .]/g, "-");
const techSlugSql = (col: SQL | string) => sql`replace(replace(lower(${typeof col === "string" ? sql.raw(col) : col}), ' ', '-'), '.', '-')`;

const FILTERS = [
  { key: "industry_or", label: "Industry", type: "multiselect", options_source: { catalog_id: "industries", supports_search: true, renderer: "tree" } },
  { key: "company_technology_slug_or", label: "Uses technology", type: "multiselect", options_source: { catalog_id: "technologies", supports_search: true, renderer: "flat" } },
  {
    key: "employee_count",
    label: "Employees",
    type: "range",
    value_type: "number",
    min: 0,
    presets: Object.entries(EMPLOYEE_BANDS).map(([label, [min, max]]) => ({ label, min, max: max >= Number.MAX_SAFE_INTEGER ? 10_000_000 : max })),
  },
  { key: "founded_year", label: "Founded", type: "range", value_type: "number", min: 1800, max: new Date().getUTCFullYear() },
  { key: "revenue_or", label: "Revenue", type: "multiselect", options: REVENUE_BANDS.map((v) => ({ label: v, value: v })) },
  { key: "country_or", label: "Headquarters country", type: "multiselect", options_source: { catalog_id: "countries", supports_search: true, renderer: "flat" } },
  { key: "keywords", label: "Keywords", type: "text", description_key: "comma_separated" },
  { key: "funding_stage_or", label: "Latest funding round", type: "multiselect", options: FUNDING_TYPES.map((v) => ({ label: v.replace(/_/g, " "), value: v })) },
  { key: "hiring_for", label: "Hiring for (job title)", type: "string_list", max_values: 20 },
  { key: "news_type_or", label: "Recent news", type: "multiselect", options: LF_NEWS_TYPES.map((v) => ({ label: v.replace(/_/g, " "), value: v })) },
  { key: "domain_list", label: "Company domains", type: "domain_list", max_values: 5_000 },
];

const RECIPES = [
  { recipe_id: "recently_funded", title: "Recently funded startups", description: "Seed to Series B companies with 10 to 500 employees.", visible_filter_keys: ["funding_stage_or", "employee_count"], prefilled: { funding_stage_or: ["seed", "series_a", "series_b"], employee_count: { min: 10, max: 500 } } },
  { recipe_id: "hiring_sales", title: "Companies hiring salespeople", description: "Open roles for account executives or SDRs.", visible_filter_keys: ["hiring_for", "country_or"], prefilled: { hiring_for: ["Account Executive", "Sales Development Representative"] } },
  { recipe_id: "hubspot_users", title: "HubSpot users", description: "Companies whose website runs HubSpot.", visible_filter_keys: ["company_technology_slug_or", "employee_count"], prefilled: { company_technology_slug_or: [{ value: "hubspot", label: "HubSpot" }] } },
  { recipe_id: "mid_market_software", title: "Mid-market software companies", description: "Software & Internet companies with 100 to 1,000 employees.", visible_filter_keys: ["industry_or", "employee_count"], prefilled: { industry_or: [{ value: "Software & Internet", label: "Software & Internet" }], employee_count: { min: 100, max: 1_000 } } },
  { recipe_id: "expanding", title: "Companies opening new offices", description: "News about new offices or locations in the last year.", visible_filter_keys: ["news_type_or", "country_or"], prefilled: { news_type_or: ["expands_offices_to", "expands_offices_in", "opens_new_location"] } },
];

export function companySources() {
  return [
    {
      provider_id: LOCAL_PROVIDER,
      provider_name: `${config.brandName} dataset`,
      logo_id: "dataset",
      company_source_id: LOCAL_SOURCE,
      source_name: "Companies",
      credential_sources: ["instantly_key"],
      credit_cost_per_saved_record: 0,
      max_records_per_build: MAX_RECORDS,
      supports_preview: true,
      connected: true,
      filters: FILTERS,
      require_any_of: [],
      recipes: RECIPES,
    },
  ];
}

export function companyListRecipes() {
  return RECIPES.map((r) => ({ recipe_id: r.recipe_id, source_id: LOCAL_PROVIDER, company_source_id: LOCAL_SOURCE, title: r.title, description: r.description, prefilled: r.prefilled }));
}

/** Catalog-backed filter values arrive as plain strings or {value, label}. */
const values = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map((x) => String(typeof x === "object" && x && "value" in x ? (x as { value: unknown }).value : x)).filter(Boolean);
const range = (v: unknown): { min?: number; max?: number } => {
  if (!v || typeof v !== "object") return {};
  const r = v as { min?: unknown; max?: unknown };
  const n = (x: unknown) => (x === null || x === undefined || x === "" || Number.isNaN(Number(x)) ? undefined : Number(x));
  return { min: n(r.min), max: n(r.max) };
};

export function validateCompanyListFilters(filters: Record<string, unknown>) {
  const known = new Set(FILTERS.map((f) => f.key));
  const unknown = Object.keys(filters).filter((k) => !known.has(k));
  if (unknown.length) throw badRequest(`Unknown filter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  const meaningful = Object.values(filters).some((v) => values(v).length || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).some((x) => x !== null && x !== undefined && x !== "")));
  if (!meaningful) throw badRequest("Set at least one filter");
}

function companyConditions(workspaceId: string, f: Record<string, unknown>): SQL[] {
  const conds: SQL[] = [sql`(c.workspace_id is null or c.workspace_id = ${workspaceId})`, sql`c.domain is not null`];
  const list = (k: string) => values(f[k]);
  const inList = (col: string, xs: string[]) => sql`${sql.raw(col)} in (${sql.join(xs.map((x) => sql`${x}`), sql`, `)})`;
  if (list("industry_or").length) {
    // Values may name an industry or one of its sub-industries.
    const xs = list("industry_or");
    conds.push(sql`(${inList("c.industry", xs)} or ${inList("c.sub_industry", xs)})`);
  }
  if (list("company_technology_slug_or").length) {
    conds.push(sql`exists (select 1 from json_each(c.technologies) where ${techSlugSql("value")} in (${sql.join(list("company_technology_slug_or").map((x) => sql`${techSlug(x)}`), sql`, `)}))`);
  }
  const emp = range(f.employee_count);
  if (emp.min !== undefined) conds.push(sql`c.employee_count >= ${emp.min}`);
  if (emp.max !== undefined) conds.push(sql`c.employee_count <= ${emp.max}`);
  const founded = range(f.founded_year);
  if (founded.min !== undefined) conds.push(sql`c.founded_year >= ${founded.min}`);
  if (founded.max !== undefined) conds.push(sql`c.founded_year <= ${founded.max}`);
  if (list("revenue_or").length) conds.push(inList("c.revenue_range", list("revenue_or")));
  if (list("country_or").length) conds.push(sql`lower(c.country) in (${sql.join(list("country_or").map((x) => sql`${x.toLowerCase()}`), sql`, `)})`);
  const keywords = typeof f.keywords === "string" ? f.keywords.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean) : list("keywords").map((s) => s.toLowerCase());
  if (keywords.length) {
    conds.push(sql`(${sql.join(keywords.map((k) => sql`(lower(coalesce(c.keywords, '')) like ${`%${k}%`} or lower(coalesce(c.description, '')) like ${`%${k}%`})`), sql` or `)})`);
  }
  if (list("funding_stage_or").length) conds.push(sql`json_extract(c.funding, '$.stage') in (${sql.join(list("funding_stage_or").map((x) => sql`${x}`), sql`, `)})`);
  if (list("hiring_for").length) {
    conds.push(sql`exists (select 1 from json_each(c.job_postings) where ${sql.join(list("hiring_for").map((t) => sql`lower(json_extract(value, '$.title')) like ${`%${t.toLowerCase()}%`}`), sql` or `)})`);
  }
  if (list("news_type_or").length) {
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    conds.push(sql`exists (select 1 from json_each(c.news) where json_extract(value, '$.type') in (${sql.join(list("news_type_or").map((x) => sql`${x}`), sql`, `)}) and coalesce(json_extract(value, '$.date'), '') >= ${since})`);
  }
  if (list("domain_list").length) conds.push(inList("c.domain", list("domain_list").map(normalizeDomain)));
  return conds;
}

type CompanyRow = {
  id: string;
  name: string;
  domain: string;
  industry: string | null;
  sub_industry: string | null;
  technologies: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  employee_count: number | null;
  founded_year: number | null;
  linkedin_url: string | null;
  funding: string | null;
};

export async function countCompanies(workspaceId: string, filters: Record<string, unknown>) {
  const [row] = await db.all<{ n: number }>(sql`select count(distinct c.domain) as n from lf_companies c where ${sql.join(companyConditions(workspaceId, filters), sql` and `)}`);
  return Number(row?.n ?? 0);
}

function memberData(c: CompanyRow) {
  const parse = <T>(s: string | null, d: T): T => {
    try {
      return s ? (JSON.parse(s) as T) : d;
    } catch {
      return d;
    }
  };
  const funding = parse<{ total?: number }>(c.funding, {});
  return {
    member_identity: c.domain,
    normalized_domain: c.domain,
    company_name: c.name,
    website: `https://${c.domain}`,
    provider_company_ids: [c.id],
    linkedin_company_ids: [] as string[],
    linkedin_company_urls: c.linkedin_url ? [c.linkedin_url] : [],
    linkedin_company_slugs: c.linkedin_url ? [c.linkedin_url.replace(/\/+$/, "").split("/").pop()!] : [],
    industry: c.industry ? [c.industry] : [],
    sub_industry: c.sub_industry ? [c.sub_industry] : [],
    technologies: parse<string[]>(c.technologies, []),
    headquarters_country: c.country ?? undefined,
    headquarters_region: c.state ?? undefined,
    headquarters_city: c.city ?? undefined,
    employee_count: c.employee_count ?? undefined,
    founded_year: c.founded_year ?? undefined,
    funding_total_usd: funding.total ?? undefined,
  };
}

registerJobHandler("company-list-build", async ({ job, progress }) => {
  const listId = job.entityId!;
  const CL = schema.companyLists;
  const [list] = await db.select().from(CL).where(eq(CL.id, listId)).limit(1);
  if (!list) return { error: "deleted" };
  await db.update(CL).set({ status: "IN_PROGRESS" }).where(eq(CL.id, listId));
  try {
    const conds = companyConditions(list.workspaceId, list.filters);
    // One row per domain: a workspace's private copy wins over the shared row.
    const rows = await db.all<CompanyRow>(
      sql`select * from (select c.id, c.name, c.domain, c.industry, c.sub_industry, c.technologies, c.country, c.state, c.city, c.employee_count, c.founded_year, c.linkedin_url, c.funding,
            row_number() over (partition by c.domain order by c.workspace_id is null) as rn
          from lf_companies c where ${sql.join(conds, sql` and `)}) where rn = 1 order by employee_count desc, domain limit ${list.requestedCount}`,
    );
    for (let i = 0; i < rows.length; i += 200) {
      await db
        .insert(schema.companyListMembers)
        .values(rows.slice(i, i + 200).map((c) => ({ listId, normalizedDomain: c.domain, companyName: c.name, data: memberData(c) })))
        .onConflictDoNothing();
      await progress(Math.round(((i + 200) / Math.max(1, rows.length)) * 100));
    }
    const reason = rows.length === 0 ? "NO_RESULTS" : rows.length >= list.requestedCount ? "MAX_COMPANIES_REACHED" : "PROVIDER_EXHAUSTED";
    await db.update(CL).set({ status: "COMPLETED", terminalReason: reason, companyCount: rows.length, savedCount: rows.length }).where(eq(CL.id, listId));
    return { companies: rows.length, terminal_reason: reason };
  } catch (err) {
    await db.update(CL).set({ status: "FAILED", terminalReason: "INTERNAL_ERROR" }).where(eq(CL.id, listId));
    throw err;
  }
});

// A build stopped before it started, or given up after restarts, doesn't show as building forever.
registerJobCleanup("company-list-build", async (job) => {
  if (!job.entityId) return;
  const CL = schema.companyLists;
  await db
    .update(CL)
    .set({ status: "FAILED", terminalReason: job.status === "cancelled" ? "CANCELLED" : "INTERNAL_ERROR" })
    .where(and(eq(CL.id, job.entityId), inArray(CL.status, ["PENDING", "IN_PROGRESS"])));
});

export function serializeCompanyList(l: typeof schema.companyLists.$inferSelect, withCost = false) {
  return {
    company_list_id: l.id,
    name: l.name,
    provider_id: l.providerId,
    company_source_id: l.companySourceId,
    status: l.status,
    terminal_reason: l.terminalReason ?? undefined,
    requested_count: l.requestedCount,
    company_count: l.companyCount,
    saved_count: l.savedCount,
    credits_charged: l.creditsCharged,
    filters: l.filters,
    timestamp_created: iso(l.createdAt),
    timestamp_updated: iso(l.updatedAt),
    ...(withCost ? { credit_cost_per_saved_record: 0 } : {}),
  };
}

export const MAX_COMPANY_LIST_RECORDS = MAX_RECORDS;

/** Options for catalog-backed filters (industries tree, technologies and countries seen in the dataset). */
export async function filterOptions(workspaceId: string, catalogId: string, q: string, limit: number) {
  const needle = q.trim().toLowerCase();
  if (catalogId === "industries") {
    const options = Object.entries(INDUSTRY_TREE)
      .map(([industry, subs]) => ({ label: industry, value: industry, children: subs.filter((s) => !needle || s.toLowerCase().includes(needle) || industry.toLowerCase().includes(needle)).map((s) => ({ label: s, value: s })) }))
      .filter((o) => !needle || o.label.toLowerCase().includes(needle) || o.children.length);
    return { options: options.slice(0, limit), stale: false };
  }
  if (catalogId === "technologies") {
    const rows = await db.all<{ name: string; n: number }>(
      sql`select value as name, count(*) as n from lf_companies c, json_each(c.technologies)
          where (c.workspace_id is null or c.workspace_id = ${workspaceId}) ${needle ? sql`and lower(value) like ${`%${needle}%`}` : sql``}
          group by lower(value) order by n desc limit ${limit}`,
    );
    return { options: rows.map((r) => ({ label: r.name, value: techSlug(r.name) })), stale: false };
  }
  if (catalogId === "countries") {
    const rows = await db.all<{ name: string }>(
      sql`select country as name from lf_companies where country is not null and (workspace_id is null or workspace_id = ${workspaceId}) ${needle ? sql`and lower(country) like ${`%${needle}%`}` : sql``}
          group by lower(country) order by count(*) desc limit ${limit}`,
    );
    return { options: rows.map((r) => ({ label: r.name, value: r.name })), stale: false };
  }
  return { options: [], stale: false, error: "Unknown catalog" };
}

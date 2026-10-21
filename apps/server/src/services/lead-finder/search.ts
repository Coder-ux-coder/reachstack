// Lead Finder search over the installation's people/company dataset (shared rows have workspace_id NULL,
// a workspace's private imports carry its id). Filters follow the public SuperSearch filter shape.
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { EMPLOYEE_BANDS } from "@reachstack/shared";
import { db, escapeLike, schema } from "../../db/client";
import { badRequest } from "../../http/errors";
import { normalizeDomain } from "../domains";

/** A filter's term. Its lists are bounded too: every term becomes part of the search's SQL. */
const term = z.string().max(500);
const terms = (max: number) => z.array(term).max(max);
const location = z.union([term, z.object({ place_id: z.string().max(500).optional(), label: term }).passthrough()]);
const incExc = z.object({ include: terms(300).optional(), exclude: terms(100).optional() }).partial();

export const searchFiltersSchema = z
  .object({
    company_list_id: z.string().max(100),
    locations: z.union([z.array(location).max(300), z.object({ include: z.array(location).max(300).optional(), exclude: z.array(location).max(100).optional() })]),
    department: terms(300),
    level: terms(300),
    employeeCount: z.array(z.union([term, z.object({ op: z.literal("gte").optional(), min: z.number(), max: z.number().nullable().optional() })])).max(100),
    revenue: terms(300),
    news: terms(300),
    jobListing: terms(300),
    jobListingFilter: terms(300),
    title: z.object({ include: terms(300).optional(), exclude: terms(100).optional(), includeMode: z.enum(["EXACT", "CONTAINS"]).optional(), excludeMode: z.enum(["EXACT", "CONTAINS"]).optional() }),
    name: terms(300),
    company_name: incExc,
    look_alike: term,
    lookAlike: term,
    lookAlikeMode: term,
    technologies: terms(300),
    fundingType: terms(300),
    funding_type: terms(300),
    locationMode: z.enum(["contact", "company"]),
    location_mode: z.enum(["contact", "company"]),
    keyword_filter: z.object({ include: z.string().max(2_000).optional(), exclude: z.string().max(2_000).optional(), include_mode: z.enum(["ANY", "ALL"]).optional() }),
    industry: incExc,
    subIndustry: incExc,
    // Matched as one list, so a pasted list of domains can be long.
    domains: z.array(z.string().max(253)).max(10_000),
    website_visitors: z.boolean(),
    signals: z.array(z.union([z.string().max(200), z.object({ key: z.string().max(200), period_days: z.number().optional(), keywords: z.unknown().optional() }).passthrough()])).max(50),
    skip_owned_leads: z.boolean(),
    show_one_lead_per_company: z.boolean(),
  })
  .partial()
  .passthrough();

export type SearchFilters = z.infer<typeof searchFiltersSchema>;

const COUNTRY_ALIASES: Record<string, string> = {
  us: "united states",
  usa: "united states",
  "u.s.": "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  gb: "united kingdom",
  "great britain": "united kingdom",
  england: "united kingdom",
  uae: "united arab emirates",
  deutschland: "germany",
};
const country = (s: string) => COUNTRY_ALIASES[s] ?? s;

/** Signals we can answer from company news (other signal sources are not available on this server). */
export const SIGNAL_NEWS: Record<string, string[]> = {
  website_funding: ["receives_financing"],
  website_product_launch: ["launches", "is_developing"],
  website_expansion: ["expands_offices_to", "expands_offices_in", "opens_new_location", "expands_facilities", "increases_headcount_by"],
  website_executive_change: ["hires", "leaves", "promotes", "retires_from"],
  website_partnership: ["partners_with", "integrates_with", "signs_new_client"],
};

const contains = (col: string, term: string) => sql`lower(${sql.raw(col)}) like ${`%${escapeLike(term.trim().toLowerCase())}%`} escape '\\'`;
const equalsCi = (col: string, term: string) => sql`lower(${sql.raw(col)}) = ${term.trim().toLowerCase()}`;
const anyOf = (parts: SQL[]) => (parts.length ? sql`(${sql.join(parts, sql` or `)})` : sql`1`);
const inList = (col: string, values: Array<string | number>) => sql`${sql.raw(col)} in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;

function locationCond(raw: string | { label: string }, mode: "contact" | "company"): SQL {
  const label = typeof raw === "string" ? raw : raw.label;
  const parts = label.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return sql`1`;
  const t = mode === "company" ? "c" : "p";
  const [first] = parts;
  const firstCond = sql`(lower(${sql.raw(`${t}.city`)}) = ${first} or lower(${sql.raw(`${t}.state`)}) = ${first} or lower(${sql.raw(`${t}.country`)}) = ${country(first!)})`;
  if (parts.length === 1) return firstCond;
  const last = parts[parts.length - 1]!;
  return sql`(${firstCond} and (lower(${sql.raw(`${t}.country`)}) = ${country(last)} or lower(${sql.raw(`${t}.state`)}) = ${last}))`;
}

/** WHERE conditions for a search (aliases: p = lf_people, c = lf_companies). */
export async function searchConditions(workspaceId: string, f: SearchFilters): Promise<SQL[]> {
  const conds: SQL[] = [sql`(p.workspace_id is null or p.workspace_id = ${workspaceId})`];
  const mode = f.location_mode ?? f.locationMode ?? "contact";

  if (f.locations) {
    const inc = Array.isArray(f.locations) ? f.locations : (f.locations.include ?? []);
    const exc = Array.isArray(f.locations) ? [] : (f.locations.exclude ?? []);
    if (inc.length) conds.push(anyOf(inc.map((l) => locationCond(l as never, mode))));
    for (const l of exc) conds.push(sql`not ${locationCond(l as never, mode)}`);
  }
  if (f.department?.length) conds.push(inList("p.department", f.department));
  if (f.level?.length) conds.push(inList("p.seniority", f.level));
  if (f.employeeCount?.length) {
    conds.push(
      anyOf(
        f.employeeCount.map((b) => {
          const [min, max] = typeof b === "string" ? (EMPLOYEE_BANDS[b] ?? [0, Number.MAX_SAFE_INTEGER]) : [b.min, b.max ?? Number.MAX_SAFE_INTEGER];
          return sql`(c.employee_count >= ${min} and c.employee_count <= ${max})`;
        }),
      ),
    );
  }
  if (f.revenue?.length) conds.push(inList("c.revenue_range", f.revenue));

  const newsTypes = [...(f.news ?? [])];
  let newsWindowDays: number | null = null;
  for (const s of f.signals ?? []) {
    const key = typeof s === "string" ? s : s.key;
    const mapped = SIGNAL_NEWS[key];
    if (mapped) newsTypes.push(...mapped);
    if (typeof s !== "string" && s.period_days) newsWindowDays = Math.max(newsWindowDays ?? 0, s.period_days);
  }
  if (newsTypes.length) {
    const since = newsWindowDays ? new Date(Date.now() - newsWindowDays * 86_400_000).toISOString().slice(0, 10) : null;
    conds.push(
      sql`exists (select 1 from json_each(c.news) where json_extract(value, '$.type') in (${sql.join([...new Set(newsTypes)].map((v) => sql`${v}`), sql`, `)})${since ? sql` and json_extract(value, '$.date') >= ${since}` : sql``})`,
    );
  }
  const jobs = f.jobListing?.length ? f.jobListing : f.jobListingFilter;
  if (jobs?.length) {
    conds.push(sql`exists (select 1 from json_each(c.job_postings) where ${anyOf(jobs.map((j) => sql`lower(json_extract(value, '$.title')) like ${`%${escapeLike(j.toLowerCase())}%`} escape '\\'`))})`);
  }
  if (f.title?.include?.length) conds.push(anyOf(f.title.include.map((t) => (f.title?.includeMode === "EXACT" ? equalsCi("p.title", t) : contains("p.title", t)))));
  for (const t of f.title?.exclude ?? []) conds.push(sql`not coalesce(${f.title?.excludeMode === "EXACT" ? equalsCi("p.title", t) : contains("p.title", t)}, 0)`);
  if (f.name?.length) conds.push(anyOf(f.name.map((n) => contains("coalesce(p.full_name, p.first_name || ' ' || p.last_name)", n))));
  if (f.company_name?.include?.length) conds.push(anyOf(f.company_name.include.map((n) => contains("c.name", n))));
  for (const n of f.company_name?.exclude ?? []) conds.push(sql`not coalesce(${contains("c.name", n)}, 0)`);
  if (f.technologies?.length) {
    conds.push(sql`exists (select 1 from json_each(c.technologies) where lower(value) in (${sql.join(f.technologies.map((t) => sql`${t.toLowerCase()}`), sql`, `)}))`);
  }
  const funding = f.funding_type?.length ? f.funding_type : f.fundingType;
  if (funding?.length) conds.push(sql`json_extract(c.funding, '$.stage') in (${sql.join(funding.map((v) => sql`${v}`), sql`, `)})`);
  if (f.keyword_filter?.include?.trim()) {
    const words = f.keyword_filter.include.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
    const per = words.map((w) => anyOf([contains("c.keywords", w), contains("c.description", w), contains("c.name", w)]));
    conds.push(f.keyword_filter.include_mode === "ALL" ? sql`(${sql.join(per, sql` and `)})` : anyOf(per));
  }
  if (f.keyword_filter?.exclude?.trim()) {
    for (const w of f.keyword_filter.exclude.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
      conds.push(sql`not coalesce(${anyOf([contains("c.keywords", w), contains("c.description", w)])}, 0)`);
    }
  }
  if (f.industry?.include?.length) conds.push(inList("c.industry", f.industry.include));
  if (f.industry?.exclude?.length) conds.push(sql`coalesce(c.industry, '') not in (${sql.join(f.industry.exclude.map((v) => sql`${v}`), sql`, `)})`);
  if (f.subIndustry?.include?.length) conds.push(inList("c.sub_industry", f.subIndustry.include));
  if (f.subIndustry?.exclude?.length) conds.push(sql`coalesce(c.sub_industry, '') not in (${sql.join(f.subIndustry.exclude.map((v) => sql`${v}`), sql`, `)})`);
  if (f.domains?.length) conds.push(inList("c.domain", f.domains.map(normalizeDomain)));
  if (f.website_visitors) {
    // Companies your website visitor tracking identified (visits you hid don't count).
    conds.push(sql`c.domain in (select company_domain from visitor_sessions where workspace_id = ${workspaceId} and identified = 1 and hidden = 0 and company_domain is not null)`);
  }
  if (f.company_list_id) {
    const [list] = await db.select().from(schema.companyLists).where(eq(schema.companyLists.id, f.company_list_id)).limit(1);
    if (!list || list.workspaceId !== workspaceId) throw badRequest("Company list not found");
    if (list.status !== "COMPLETED") throw badRequest("The company list is still being built");
    conds.push(sql`c.domain in (select normalized_domain from company_list_members where list_id = ${list.id})`);
  }
  const look = f.look_alike ?? f.lookAlike;
  if (look?.trim()) {
    const domain = normalizeDomain(look);
    // From the shared dataset or this workspace's own import (preferred), never another workspace's private companies.
    const LC = schema.lfCompanies;
    const [ref] = await db
      .select()
      .from(LC)
      .where(and(eq(LC.domain, domain), or(isNull(LC.workspaceId), eq(LC.workspaceId, workspaceId))))
      .orderBy(sql`${LC.workspaceId} is null`)
      .limit(1);
    if (!ref) conds.push(sql`0`); // unknown company: nothing to compare against
    else {
      conds.push(sql`c.domain != ${domain}`);
      if (ref.industry) conds.push(sql`c.industry = ${ref.industry}`);
      if (ref.employeeCount) conds.push(sql`c.employee_count between ${Math.floor(ref.employeeCount / 4)} and ${ref.employeeCount * 4}`);
    }
  }
  if (f.skip_owned_leads) {
    conds.push(sql`not exists (select 1 from leads l where l.workspace_id = ${workspaceId} and l.email = p.email)`);
    conds.push(sql`not exists (select 1 from lf_unlocks u where u.workspace_id = ${workspaceId} and u.person_id = p.id)`);
  }
  return conds;
}

const FROM = sql.raw("from lf_people p left join lf_companies c on c.id = p.company_id");
/** Most senior first; reads the person table aliased as `p`. */
export const SENIORITY_RANK = sql.raw(
  "case p.seniority when 'C-Level' then 0 when 'Chief X Officer (CxO)' then 0 when 'Owner' then 1 when 'VP-Level' then 2 when 'Vice President (VP)' then 2 when 'Director-Level' then 3 when 'Director' then 3 when 'Manager-Level' then 4 else 5 end",
);

export async function countPeople(workspaceId: string, f: SearchFilters): Promise<number> {
  const conds = await searchConditions(workspaceId, f);
  const expr = f.show_one_lead_per_company ? sql.raw("count(distinct coalesce(p.company_id, p.id))") : sql.raw("count(*)");
  const [row] = await db.all<{ n: number }>(sql`select ${expr} as n ${FROM} where ${sql.join(conds, sql` and `)}`);
  return Math.min(1_000_000, Number(row?.n ?? 0));
}

export interface PersonResult {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  email: string | null;
  email_status: string | null;
  phone: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
  industry: string | null;
  sub_industry: string | null;
  employee_count: number | null;
  revenue_range: string | null;
  logo_url: string | null;
  company_linkedin: string | null;
  company_city: string | null;
  company_state: string | null;
  company_country: string | null;
  company_phone: string | null;
  description: string | null;
  technologies: string | null;
  funding: string | null;
  unlocked: number;
  owned: number;
}

const personCols = (workspaceId: string) => sql`p.id, p.first_name, p.last_name, p.full_name, p.title, p.seniority, p.department, p.email, p.email_status, p.phone, p.linkedin_url,
    p.city, p.state, p.country, c.id as company_id, c.name as company_name, c.domain as company_domain, c.industry, c.sub_industry,
    c.employee_count, c.revenue_range, c.logo_url, c.linkedin_url as company_linkedin, c.city as company_city, c.state as company_state,
    c.country as company_country, c.phone as company_phone, c.description, c.technologies, c.funding,
    exists (select 1 from lf_unlocks u where u.workspace_id = ${workspaceId} and u.person_id = p.id) as unlocked,
    exists (select 1 from leads l where l.workspace_id = ${workspaceId} and l.email = p.email) as owned`;

export async function searchPeople(workspaceId: string, f: SearchFilters, page: { limit: number; offset: number }): Promise<PersonResult[]> {
  const conds = await searchConditions(workspaceId, f);
  const cols = personCols(workspaceId);
  const where = sql.join(conds, sql` and `);
  if (f.show_one_lead_per_company) {
    return db.all<PersonResult>(
      sql`select * from (select ${cols}, row_number() over (partition by coalesce(p.company_id, p.id) order by ${SENIORITY_RANK}, p.id) as rn ${FROM} where ${where}) where rn = 1 order by id limit ${page.limit} offset ${page.offset}`,
    );
  }
  return db.all<PersonResult>(sql`select ${cols} ${FROM} where ${where} order by p.id limit ${page.limit} offset ${page.offset}`);
}

/**
 * The page of people after `after` (null: the first page), and where the next page starts: for going through every
 * match while people drop out of the search on the way (an import that skips the people you already have).
 */
export async function searchPeopleAfter(workspaceId: string, f: SearchFilters, limit: number, after: string | null): Promise<{ people: PersonResult[]; next: string | null }> {
  const conds = await searchConditions(workspaceId, f);
  const cols = personCols(workspaceId);
  const where = sql.join(conds, sql` and `);
  if (f.show_one_lead_per_company) {
    // Company by company, so a company whose pick was just added isn't picked again through its next person.
    const key = sql.raw("coalesce(p.company_id, p.id)");
    const rows = await db.all<PersonResult & { grp: string }>(
      sql`select * from (select ${cols}, ${key} as grp, row_number() over (partition by ${key} order by ${SENIORITY_RANK}, p.id) as rn ${FROM} where ${where}) where rn = 1${after === null ? sql`` : sql` and grp > ${after}`} order by grp limit ${limit}`,
    );
    return { people: rows, next: rows.at(-1)?.grp ?? after };
  }
  const rows = await db.all<PersonResult>(sql`select ${cols} ${FROM} where ${where}${after === null ? sql`` : sql` and p.id > ${after}`} order by p.id limit ${limit}`);
  return { people: rows, next: rows.at(-1)?.id ?? after };
}

/** Specific people visible to the workspace (shared rows and its own imports). */
export async function peopleByIds(workspaceId: string, ids: string[]): Promise<PersonResult[]> {
  const out: PersonResult[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    out.push(
      ...(await db.all<PersonResult>(
        sql`select ${personCols(workspaceId)} ${FROM} where (p.workspace_id is null or p.workspace_id = ${workspaceId}) and p.id in (${sql.join(part.map((id) => sql`${id}`), sql`, `)})`,
      )),
    );
  }
  return out;
}

export function personLocation(p: Pick<PersonResult, "city" | "state" | "country">): string {
  return [p.city, p.state, p.country].filter(Boolean).join(", ");
}

/** API v2 preview shape. Names and emails of people the workspace has not unlocked stay hidden behind credits. */
export function previewLead(p: PersonResult, mode: "contact" | "company") {
  return {
    firstName: p.first_name ?? "",
    lastName: p.last_name ?? "",
    fullName: p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(" "),
    jobTitle: p.title ?? "",
    location: mode === "company" ? [p.company_city, p.company_state, p.company_country].filter(Boolean).join(", ") : personLocation(p),
    linkedIn: p.linkedin_url ?? "",
    companyName: p.company_name ?? "",
    companyLogo: p.logo_url ?? "",
    companyId: p.company_id ?? "",
    isOwned: !!p.owned || !!p.unlocked,
    identityHidden: false,
  };
}

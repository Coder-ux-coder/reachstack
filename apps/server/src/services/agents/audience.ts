// Audience suggestions for a Lead Finder Agent: profiles the people already in a campaign (matched against the
// Lead Finder dataset) and proposes searches that find more people like them. With AI configured the model
// writes the suggestions from the profile; otherwise they come from the profile's most common traits.
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as z from "zod/v4";
import { EMPLOYEE_BANDS, LF_DEPARTMENTS, LF_LEVELS, INDUSTRY_TREE } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { aiAvailable, cachedSystem, structured } from "../ai";
import { countPeople, type SearchFilters } from "../lead-finder/search";

interface Profile {
  departments: Array<[string, number]>;
  levels: Array<[string, number]>;
  industries: Array<[string, number]>;
  sizes: Array<[string, number]>;
  countries: Array<[string, number]>;
  titleWords: Array<[string, number]>;
  topDomains: string[];
}

export interface AudienceSuggestion {
  label: string;
  query: string;
  rationale: string;
  filters?: SearchFilters;
}

const tally = (values: Array<string | null | undefined>) => {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const bandOf = (n: number | null) => (n === null ? null : (Object.entries(EMPLOYEE_BANDS).find(([, [min, max]]) => n >= min && n <= max)?.[0] ?? null));

const STOP = new Set(["of", "and", "the", "for", "&", "-", "at", "in", "to", "senior", "sr", "jr", "head", "lead", "global", "chief", "officer", "vp", "vice", "president", "director", "manager"]);

async function buildProfile(workspaceId: string, campaignId: string) {
  const L = schema.leads;
  const leads = await db
    .select({ email: L.email, title: L.jobTitle, domain: L.companyDomain, location: L.location, payload: L.payload })
    .from(L)
    .where(and(eq(L.workspaceId, workspaceId), eq(L.campaignId, campaignId)))
    .orderBy(desc(L.createdAt))
    .limit(500);
  const [{ n: total }] = (await db.select({ n: sql<number>`count(*)` }).from(L).where(and(eq(L.workspaceId, workspaceId), eq(L.campaignId, campaignId)))) as [{ n: number }];
  const emails = leads.map((l) => l.email).filter((e): e is string => !!e);
  const P = schema.lfPeople;
  const C = schema.lfCompanies;
  const scope = (t: typeof P | typeof C) => or(isNull(t.workspaceId), eq(t.workspaceId, workspaceId));
  const people = emails.length
    ? await db
        .select({ email: P.email, seniority: P.seniority, department: P.department, country: P.country, companyId: P.companyId })
        .from(P)
        .where(and(scope(P), inArray(P.email, emails)))
    : [];
  const byEmail = new Map(people.map((p) => [p.email, p]));
  const domains = [...new Set(leads.map((l) => l.domain).filter(Boolean))];
  const companies = domains.length
    ? await db.select({ id: C.id, domain: C.domain, industry: C.industry, employees: C.employeeCount, country: C.country }).from(C).where(and(scope(C), inArray(C.domain, domains)))
    : [];
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const companyByDomain = new Map(companies.map((c) => [c.domain, c]));
  let matched = 0;
  const rows = leads.map((l) => {
    const p = l.email ? byEmail.get(l.email) : undefined;
    const c = (p?.companyId ? companyById.get(p.companyId) : undefined) ?? (l.domain ? companyByDomain.get(l.domain) : undefined);
    if (p || c) matched++;
    const pl = (l.payload ?? {}) as Record<string, unknown>;
    return {
      title: l.title,
      department: p?.department ?? (pl.department as string | undefined) ?? null,
      level: p?.seniority ?? (pl.seniority as string | undefined) ?? null,
      industry: c?.industry ?? (pl.industry as string | undefined) ?? null,
      size: bandOf(c?.employees ?? (typeof pl.company_size === "number" ? pl.company_size : null)),
      country: p?.country ?? c?.country ?? null,
      domain: l.domain || null,
    };
  });
  const words = rows.flatMap((r) =>
    (r.title ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
  const profile: Profile = {
    departments: tally(rows.map((r) => r.department)).filter(([d]) => (LF_DEPARTMENTS as readonly string[]).includes(d)),
    levels: tally(rows.map((r) => r.level)).filter(([lv]) => (LF_LEVELS as readonly string[]).includes(lv)),
    industries: tally(rows.map((r) => r.industry)).filter(([i]) => i in INDUSTRY_TREE),
    sizes: tally(rows.map((r) => r.size)),
    countries: tally(rows.map((r) => r.country)),
    titleWords: tally(words),
    topDomains: tally(rows.map((r) => r.domain)).map(([d]) => d),
  };
  return { profile, analyzed: leads.length, total: Number(total), matched };
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const top = (list: Array<[string, number]>, k: number, of: number, minShare = 15) => list.filter(([, n]) => pct(n, of) >= minShare).slice(0, k).map(([v]) => v);

function summarize(p: Profile, analyzed: number): string {
  if (!analyzed) return "The campaign has no leads yet, so there is nothing to learn from.";
  const parts: string[] = [];
  const lv = top(p.levels, 2, analyzed);
  const dep = top(p.departments, 2, analyzed);
  const ind = top(p.industries, 2, analyzed);
  const size = top(p.sizes, 1, analyzed);
  const country = top(p.countries, 1, analyzed, 30);
  parts.push(`Mostly ${lv.length ? lv.join(" and ") + " " : ""}people${dep.length ? ` in ${dep.join(" and ")}` : ""}`);
  if (ind.length) parts.push(`at ${ind.join(" and ")} companies`);
  if (size.length) parts.push(`with ${size[0]} employees`);
  if (country.length) parts.push(`based in ${country[0]}`);
  const words = p.titleWords.slice(0, 3).map(([w]) => w);
  return `${parts.join(" ")}.${words.length ? ` Common title words: ${words.join(", ")}.` : ""}`;
}

function heuristicSuggestions(p: Profile, analyzed: number): AudienceSuggestion[] {
  const lv = top(p.levels, 2, analyzed);
  const dep = top(p.departments, 1, analyzed);
  const ind = top(p.industries, 2, analyzed);
  const size = top(p.sizes, 2, analyzed);
  const country = top(p.countries, 1, analyzed, 30);
  const loc = country.length ? { locations: country.map((label) => ({ label })) } : {};
  const out: AudienceSuggestion[] = [];
  const base: SearchFilters = { ...(dep.length ? { department: dep } : {}), ...(lv.length ? { level: lv } : {}), ...loc };
  if (dep.length || lv.length || ind.length) {
    out.push({
      label: "More of the same",
      query: [lv.join(" or "), dep[0], ind[0] && `at ${ind[0]} companies`, size[0] && `(${size[0]} employees)`, country[0] && `in ${country[0]}`].filter(Boolean).join(" "),
      rationale: "Matches the traits most of the campaign's current leads share.",
      filters: { ...base, ...(ind.length ? { industry: { include: [ind[0]!] } } : {}), ...(size.length ? { employeeCount: size } : {}) },
    });
  }
  if (p.topDomains[0]) {
    out.push({
      label: `Companies like ${p.topDomains[0]}`,
      query: `${[lv.join(" or "), dep[0]].filter(Boolean).join(" ") || "Decision makers"} at companies similar to ${p.topDomains[0]}`,
      rationale: `${p.topDomains[0]} appears most often in the campaign; similar companies are a natural next audience.`,
      filters: { ...base, look_alike: p.topDomains[0] },
    });
  }
  if (ind.length > 1) {
    out.push({
      label: `${ind[1]} expansion`,
      query: `${[lv.join(" or "), dep[0]].filter(Boolean).join(" ")} at ${ind[1]} companies`,
      rationale: `${ind[1]} is the campaign's second industry; it can carry more volume.`,
      filters: { ...base, industry: { include: [ind[1]!] } },
    });
  }
  if (dep.length && lv.length) {
    const idx = LF_LEVELS.indexOf(lv[0] as (typeof LF_LEVELS)[number]);
    const next = idx >= 0 ? LF_LEVELS[Math.min(idx + 1, 3)] : undefined;
    if (next && !lv.includes(next)) {
      out.push({
        label: `${next} in ${dep[0]}`,
        query: `${next} people in ${dep[0]}${ind[0] ? ` at ${ind[0]} companies` : ""}`,
        rationale: "One level below the current audience: more people, often closer to the day-to-day problem.",
        filters: { department: dep, level: [next], ...(ind.length ? { industry: { include: [ind[0]!] } } : {}), ...loc },
      });
    }
  }
  if (dep.length || lv.length) {
    out.push({
      label: "Same roles, any industry",
      query: `${[lv.join(" or "), dep[0]].filter(Boolean).join(" ")}${country[0] ? ` in ${country[0]}` : ""}, any industry`,
      rationale: "Keeps the roles that work and drops the industry limit for a much larger pool.",
      filters: base,
    });
  }
  return out;
}

const suggestionSchema = z.object({
  profile_summary: z.string(),
  suggestions: z.array(
    z.object({
      label: z.string(),
      query: z.string(),
      rationale: z.string(),
      departments: z.array(z.string()),
      levels: z.array(z.string()),
      industries: z.array(z.string()),
      employee_bands: z.array(z.string()),
      countries: z.array(z.string()),
      title_keywords: z.array(z.string()),
      look_alike_domain: z.string(),
    }),
  ),
});

const SYSTEM = `You help a salesperson find more prospects like the ones already in an email campaign. You get a
statistical profile of the campaign's current leads and must propose distinct audiences to search next.

Rules:
- Base every suggestion on the profile. Do not invent customers, results or facts about companies.
- Each suggestion must be meaningfully different (another seniority, an adjacent industry, look-alike
  companies, a wider geography), not a reworded copy of another.
- Only use values from the allowed lists for departments, levels, industries and employee bands. Leave a
  list empty rather than guessing. look_alike_domain must be one of the domains in the profile, or empty.
- label: 2-5 words. query: one plain-English line describing who to find. rationale: one sentence.`;

export async function suggestAudience(workspaceId: string, campaignId: string, count: number) {
  const { profile, analyzed, total, matched } = await buildProfile(workspaceId, campaignId);
  const confidence: "high" | "low" = analyzed >= 20 && matched >= analyzed / 2 ? "high" : "low";
  let summary = summarize(profile, analyzed);
  let suggestions: AudienceSuggestion[] = [];
  if (analyzed && (await aiAvailable(workspaceId))) {
    const describe = (list: Array<[string, number]>) => list.slice(0, 8).map(([v, n]) => `${v} (${pct(n, analyzed)}%)`).join(", ") || "unknown";
    const out = await structured({
      workspaceId,
      feature: "lead_finder_agent_audience",
      effort: "low",
      maxTokens: 3_000,
      system: cachedSystem(SYSTEM),
      messages: [
        {
          role: "user",
          content: [
            `<profile leads_analyzed="${analyzed}" matched_in_dataset="${matched}">`,
            `Departments: ${describe(profile.departments)}`,
            `Levels: ${describe(profile.levels)}`,
            `Industries: ${describe(profile.industries)}`,
            `Employee bands: ${describe(profile.sizes)}`,
            `Countries: ${describe(profile.countries)}`,
            `Common title words: ${profile.titleWords.slice(0, 12).map(([w]) => w).join(", ") || "none"}`,
            `Most frequent company domains: ${profile.topDomains.slice(0, 5).join(", ") || "none"}`,
            `</profile>`,
            `<allowed>`,
            `departments: ${LF_DEPARTMENTS.join(" | ")}`,
            `levels: ${LF_LEVELS.join(" | ")}`,
            `industries: ${Object.keys(INDUSTRY_TREE).join(" | ")}`,
            `employee_bands: ${Object.keys(EMPLOYEE_BANDS).join(" | ")}`,
            `</allowed>`,
            `Propose ${count} audience${count === 1 ? "" : "s"} and a one-sentence profile_summary.`,
          ].join("\n"),
        },
      ],
      schema: suggestionSchema,
    });
    summary = out.profile_summary.trim() || summary;
    const domains = new Set(profile.topDomains);
    suggestions = out.suggestions.map((s) => {
      const keep = (vals: string[], allowed: readonly string[]) => vals.filter((v) => allowed.includes(v));
      const filters: SearchFilters = {};
      const department = keep(s.departments, LF_DEPARTMENTS);
      const level = keep(s.levels, LF_LEVELS);
      const industry = keep(s.industries, Object.keys(INDUSTRY_TREE));
      const bands = keep(s.employee_bands, Object.keys(EMPLOYEE_BANDS));
      if (department.length) filters.department = department;
      if (level.length) filters.level = level;
      if (industry.length) filters.industry = { include: industry };
      if (bands.length) filters.employeeCount = bands;
      if (s.countries.length) filters.locations = s.countries.slice(0, 5).map((label) => ({ label }));
      if (s.title_keywords.length) filters.title = { include: s.title_keywords.slice(0, 10), includeMode: "CONTAINS" };
      if (s.look_alike_domain && domains.has(s.look_alike_domain)) filters.look_alike = s.look_alike_domain;
      return { label: s.label.trim(), query: s.query.trim(), rationale: s.rationale.trim(), filters };
    });
  } else {
    suggestions = heuristicSuggestions(profile, analyzed);
  }
  // Show how many people each audience reaches in this installation's dataset.
  const sized = await Promise.all(
    suggestions.slice(0, count).map(async (s) => ({ ...s, ...(s.filters ? { estimated_leads: await countPeople(workspaceId, s.filters).catch(() => null) } : {}) })),
  );
  return { campaign_id: campaignId, analyzed_lead_count: analyzed, total_lead_count: total, confidence, profile_summary: summary, suggestions: sized };
}

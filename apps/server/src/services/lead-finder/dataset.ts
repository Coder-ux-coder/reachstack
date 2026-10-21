// The people/company dataset behind the Lead Finder. Nothing ships with the server: an instance admin
// imports a CSV export they are licensed to use (shared with every workspace), a workspace imports its
// own private CSV, or an admin loads the demo dataset — fictional companies on reserved .test domains, which the sandbox handles
// so searches, unlocks and enrichments can be tried end to end without real personal data.
import { readFile, unlink } from "node:fs/promises";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import Papa from "papaparse";
import { EMPLOYEE_BANDS, FUNDING_TYPES, INDUSTRY_TREE, LF_NEWS_TYPES, REVENUE_BANDS, departmentOf, levelOf, unescapeCsvFormula } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { badRequest } from "../../http/errors";
import { normalizeDomain } from "../domains";
import { normLinkedin, suppressedValues } from "../privacy";
import { registerJobCleanup, registerJobHandler } from "../jobs";

const C = schema.lfCompanies;
const P = schema.lfPeople;
type CompanyInsert = typeof C.$inferInsert;
type PersonInsert = typeof P.$inferInsert;

const CHUNK = 200;
async function insertChunks<T extends Record<string, unknown>>(table: typeof C | typeof P, rows: T[]) {
  for (let i = 0; i < rows.length; i += CHUNK) await db.insert(table).values(rows.slice(i, i + CHUNK) as never);
}

const scopeCond = (col: typeof C.workspaceId | typeof P.workspaceId, workspaceId: string | null) => (workspaceId ? eq(col, workspaceId) : isNull(col));

// ---------- CSV import ----------

/** Accepted header spellings per field (compared after lower-casing and turning spaces/dashes into underscores). */
const COLUMNS: Record<string, string[]> = {
  first_name: ["first_name", "firstname", "given_name"],
  last_name: ["last_name", "lastname", "surname", "family_name"],
  full_name: ["full_name", "name", "fullname", "contact_name"],
  title: ["title", "job_title", "position", "role", "headline"],
  seniority: ["seniority", "level"],
  department: ["department", "function", "departments"],
  email: ["email", "email_address", "work_email", "e_mail", "business_email"],
  email_status: ["email_status", "verification_status", "email_verification"],
  phone: ["phone", "phone_number", "mobile", "mobile_phone", "direct_phone", "work_phone"],
  linkedin_url: ["linkedin", "linkedin_url", "person_linkedin_url", "linkedin_profile", "profile_url"],
  city: ["city", "person_city"],
  state: ["state", "region", "person_state", "province"],
  country: ["country", "person_country"],
  company_name: ["company", "company_name", "organization", "organization_name", "account_name", "employer"],
  company_domain: ["domain", "company_domain", "website", "company_website", "organization_website", "website_url"],
  industry: ["industry", "company_industry"],
  sub_industry: ["sub_industry", "subindustry"],
  employee_count: ["employees", "employee_count", "company_size", "headcount", "number_of_employees", "num_employees", "estimated_num_employees"],
  revenue: ["revenue", "revenue_range", "annual_revenue", "company_revenue"],
  founded_year: ["founded", "founded_year", "year_founded"],
  company_city: ["company_city", "organization_city", "hq_city"],
  company_state: ["company_state", "organization_state", "hq_state"],
  company_country: ["company_country", "organization_country", "hq_country"],
  description: ["description", "company_description", "short_description", "about"],
  keywords: ["keywords", "company_keywords", "tags", "specialties"],
  technologies: ["technologies", "tech_stack", "technology", "technologies_used"],
  funding_stage: ["funding_stage", "latest_funding", "last_funding_type", "latest_funding_stage"],
  funding_total: ["funding_total", "total_funding"],
  company_linkedin: ["company_linkedin", "company_linkedin_url", "organization_linkedin_url"],
  company_phone: ["company_phone", "organization_phone", "hq_phone"],
};

const headerKey = (h: string) => h.trim().toLowerCase().replace(/^#\s*/, "").replace(/[\s\-./]+/g, "_").replace(/[^a-z0-9_]/g, "");

export function mapHeaders(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const keyed = new Map(headers.map((h) => [headerKey(h), h]));
  for (const [field, names] of Object.entries(COLUMNS)) {
    const hit = names.find((n) => keyed.has(n));
    if (hit) out[field] = keyed.get(hit)!;
  }
  return out;
}

const clean = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
  return s && !/^(n\/?a|null|none|-)$/i.test(s) ? s : null;
};

/** "51-200", "1,001-5,000", "5000+", "1200" -> a single head count. */
export function parseEmployees(raw: string | null): number | null {
  if (!raw) return null;
  const nums = raw.replace(/,/g, "").match(/\d+(\.\d+)?\s*[kK]?/g)?.map((n) => (/k$/i.test(n.trim()) ? parseFloat(n) * 1000 : parseFloat(n)));
  if (!nums?.length) return null;
  return Math.round(nums.length > 1 ? (nums[0]! + nums[1]!) / 2 : nums[0]!);
}

/** A revenue figure ("$12,000,000", "12M", "1.2B") or an existing band label -> one of the revenue bands. */
export function revenueBand(raw: string | null): string | null {
  if (!raw) return null;
  if ((REVENUE_BANDS as readonly string[]).includes(raw)) return raw;
  const m = raw.replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([kmb])?/i);
  if (!m) return null;
  const n = parseFloat(m[1]!) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1);
  const millions = n / 1e6;
  if (millions < 1) return "$0 - 1M";
  if (millions < 10) return "$1 - 10M";
  if (millions < 50) return "$10 - 50M";
  if (millions < 100) return "$50 - 100M";
  if (millions < 250) return "$100 - 250M";
  if (millions < 500) return "$250 - 500M";
  if (millions < 1000) return "$500M - 1B";
  return "> $1B";
}

const listOf = (raw: string | null) => (raw ? raw.split(/[;,|]/).map((s) => s.trim()).filter(Boolean) : []);
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const FUNDING_ALIASES: Record<string, string> = { "pre-seed": "pre_seed", "series a": "series_a", "series b": "series_b", "series c": "series_c", "series d": "series_d", "series e": "series_e" };

export interface ImportSummary {
  rows: number;
  companies_created: number;
  companies_updated: number;
  people_created: number;
  people_updated: number;
  skipped: number;
  /** People left out because they opted out of the shared data (privacy center). */
  suppressed: number;
  unmapped_columns: string[];
}

/** Imports CSV rows into the dataset. workspaceId null = shared with the whole installation. */
/** Checks that a file has the columns an import needs; returns the field -> header mapping. */
export function checkDatasetHeaders(headers: string[]): Record<string, string> {
  const map = mapHeaders(headers);
  if (!map.company_domain && !map.company_name) throw badRequest("The file needs a company name or website/domain column");
  if (!map.email && !map.first_name && !map.full_name && !map.linkedin_url) throw badRequest("The file needs an email, name or LinkedIn column for each person");
  return map;
}

export async function importDatasetRows(rows: Array<Record<string, string>>, headers: string[], workspaceId: string | null, onProgress?: (done: number) => Promise<void>): Promise<ImportSummary> {
  const map = checkDatasetHeaders(headers);
  const mapped = new Set(Object.values(map));
  const summary: ImportSummary = { rows: rows.length, companies_created: 0, companies_updated: 0, people_created: 0, people_updated: 0, skipped: 0, suppressed: 0, unmapped_columns: headers.filter((h) => !mapped.has(h)) };
  const get = (row: Record<string, string>, field: string) => (map[field] ? clean(row[map[field]!]) : null);

  for (let start = 0; start < rows.length; start += 500) {
    const batch = rows.slice(start, start + 500);
    // Companies: one per domain (or per name when the file has no domain column).
    const companies = new Map<string, CompanyInsert>();
    const keyOf = (row: Record<string, string>) => {
      const d = get(row, "company_domain");
      if (d) return normalizeDomain(d);
      const name = get(row, "company_name");
      return name ? `name:${name.toLowerCase()}` : null;
    };
    for (const row of batch) {
      const key = keyOf(row);
      if (!key || companies.has(key)) continue;
      const employees = parseEmployees(get(row, "employee_count"));
      const fundingStage = get(row, "funding_stage")?.toLowerCase() ?? null;
      const stage = fundingStage ? (FUNDING_ALIASES[fundingStage] ?? fundingStage.replace(/[\s-]+/g, "_")) : null;
      const total = get(row, "funding_total");
      companies.set(key, {
        workspaceId,
        name: get(row, "company_name") ?? key.replace(/^name:/, ""),
        domain: key.startsWith("name:") ? null : key,
        industry: get(row, "industry"),
        subIndustry: get(row, "sub_industry"),
        employeeCount: employees,
        revenueRange: revenueBand(get(row, "revenue")),
        foundedYear: Number(get(row, "founded_year")) || null,
        country: get(row, "company_country") ?? get(row, "country"),
        state: get(row, "company_state") ?? get(row, "state"),
        city: get(row, "company_city") ?? get(row, "city"),
        description: get(row, "description"),
        keywords: get(row, "keywords"),
        technologies: listOf(get(row, "technologies")),
        funding: stage ? { stage, ...(total ? { total: Number(total.replace(/[$,]/g, "")) || undefined } : {}) } : null,
        linkedinUrl: get(row, "company_linkedin"),
        phone: get(row, "company_phone"),
      });
    }
    const domains = [...companies.keys()].filter((k) => !k.startsWith("name:"));
    const names = [...companies.keys()].filter((k) => k.startsWith("name:")).map((k) => k.slice(5));
    const existing = new Map<string, typeof C.$inferSelect>();
    if (domains.length) for (const c of await db.select().from(C).where(and(scopeCond(C.workspaceId, workspaceId), inArray(C.domain, domains)))) existing.set(c.domain!, c);
    if (names.length) {
      for (const c of await db.select().from(C).where(and(scopeCond(C.workspaceId, workspaceId), isNull(C.domain), inArray(sql`lower(${C.name})`, names)))) existing.set(`name:${c.name.toLowerCase()}`, c);
    }
    const companyIds = new Map<string, string>();
    const toCreate: CompanyInsert[] = [];
    for (const [key, c] of companies) {
      const prev = existing.get(key);
      if (!prev) {
        toCreate.push(c);
        continue;
      }
      companyIds.set(key, prev.id);
      // Fill in what the existing row lacks; never blank out known values.
      const patch: Partial<CompanyInsert> = {};
      for (const [k, v] of Object.entries(c) as Array<[keyof CompanyInsert, unknown]>) {
        if (k === "workspaceId" || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
        const cur = prev[k as keyof typeof prev];
        if (cur === null || cur === undefined || (Array.isArray(cur) && !cur.length)) (patch as Record<string, unknown>)[k] = v;
      }
      if (Object.keys(patch).length) {
        await db.update(C).set(patch).where(eq(C.id, prev.id));
        summary.companies_updated++;
      }
    }
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const created = await db.insert(C).values(toCreate.slice(i, i + CHUNK)).returning({ id: C.id, domain: C.domain, name: C.name });
      for (const c of created) companyIds.set(c.domain ?? `name:${c.name.toLowerCase()}`, c.id);
    }
    summary.companies_created += toCreate.length;

    // People: deduplicated by email, then LinkedIn URL, then name within the company.
    const people: PersonInsert[] = [];
    for (const row of batch) {
      let first = get(row, "first_name");
      let last = get(row, "last_name");
      const full = get(row, "full_name");
      if (!first && full) [first, last] = [full.split(/\s+/)[0]!, full.split(/\s+/).slice(1).join(" ") || null];
      const email = get(row, "email")?.toLowerCase() ?? null;
      const linkedin = get(row, "linkedin_url");
      if (!email && !linkedin && !first) {
        summary.skipped++;
        continue;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        summary.skipped++;
        continue;
      }
      const key = keyOf(row);
      const title = get(row, "title");
      people.push({
        workspaceId,
        companyId: key ? (companyIds.get(key) ?? null) : null,
        firstName: first ? titleCase(first) : null,
        lastName: last ? titleCase(last) : null,
        fullName: full ?? ([first, last].filter(Boolean).join(" ") || null),
        title,
        seniority: get(row, "seniority") ?? (title ? levelOf(title) : null),
        department: get(row, "department") ?? (title ? departmentOf(title) : null),
        email,
        emailStatus: get(row, "email_status")?.toLowerCase() ?? (email ? "unverified" : null),
        phone: get(row, "phone"),
        linkedinUrl: linkedin,
        country: get(row, "country"),
        state: get(row, "state"),
        city: get(row, "city"),
      });
    }
    // The shared data never takes back people who opted out of it.
    if (!workspaceId) {
      const outEmails = await suppressedValues("email", people.map((p) => p.email));
      const outLinks = await suppressedValues("linkedin", people.map((p) => normLinkedin(p.linkedinUrl)));
      const kept = people.filter((p) => !(p.email && outEmails.has(p.email)) && !outLinks.has(normLinkedin(p.linkedinUrl) ?? ""));
      summary.suppressed += people.length - kept.length;
      people.splice(0, people.length, ...kept);
    }
    const emails = people.map((p) => p.email).filter((e): e is string => !!e);
    const links = people.map((p) => p.linkedinUrl).filter((e): e is string => !!e);
    const known = (emails.length || links.length)
      ? await db.select({ id: P.id, email: P.email, linkedinUrl: P.linkedinUrl }).from(P).where(and(scopeCond(P.workspaceId, workspaceId), or(...(emails.length ? [inArray(P.email, emails)] : []), ...(links.length ? [inArray(P.linkedinUrl, links)] : []))))
      : [];
    const byEmail = new Map(known.filter((k) => k.email).map((k) => [k.email!, k.id]));
    const byLink = new Map(known.filter((k) => k.linkedinUrl).map((k) => [k.linkedinUrl!, k.id]));
    const seen = new Set<string>();
    const fresh: PersonInsert[] = [];
    for (const p of people) {
      const dedupeKey = p.email ?? p.linkedinUrl ?? `${p.companyId}|${p.fullName?.toLowerCase()}`;
      if (seen.has(dedupeKey)) {
        summary.skipped++;
        continue;
      }
      seen.add(dedupeKey);
      const existingId = (p.email && byEmail.get(p.email)) || (p.linkedinUrl && byLink.get(p.linkedinUrl)) || null;
      if (!existingId) {
        fresh.push(p);
        continue;
      }
      const patch = Object.fromEntries(Object.entries(p).filter(([k, v]) => k !== "workspaceId" && v !== null && v !== undefined));
      await db.update(P).set(patch).where(eq(P.id, existingId));
      summary.people_updated++;
    }
    await insertChunks(P, fresh);
    summary.people_created += fresh.length;
    await onProgress?.(Math.min(rows.length, start + batch.length));
  }
  return summary;
}

export function parseDatasetCsv(text: string) {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transform: unescapeCsvFormula });
  if (!parsed.meta.fields?.length) throw badRequest("The file has no header row");
  return { rows: parsed.data, headers: parsed.meta.fields };
}

registerJobHandler("lf-dataset-import", async ({ job, progress }) => {
  const d = job.data as { file: string; shared: boolean };
  const { rows, headers } = parseDatasetCsv(await readFile(d.file, "utf8"));
  return { ...(await importDatasetRows(rows, headers, d.shared ? null : job.workspaceId, (done) => progress(Math.round((done / Math.max(1, rows.length)) * 100), { done }))) };
});

// The uploaded file goes however the import ended, also when it was stopped before it started.
registerJobCleanup("lf-dataset-import", async (job) => {
  const file = (job.data as { file?: string } | null)?.file;
  if (file) await unlink(file).catch(() => {});
});

// ---------- Demo dataset ----------

/** Deterministic PRNG (mulberry32) so the same seed always produces the same demo dataset. */
function prng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!;
  const chance = (p: number) => next() < p;
  const sample = <T>(arr: readonly T[], n: number): T[] => {
    const copy = [...arr];
    const out: T[] = [];
    while (out.length < n && copy.length) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]!);
    return out;
  };
  return { next, int, pick, chance, sample };
}

const SYL_A = ["Al", "Bri", "Cor", "Dav", "El", "Fen", "Gal", "Hal", "Is", "Jun", "Kel", "Lum", "Mar", "Nov", "Or", "Pel", "Quin", "Ros", "Sol", "Tav", "Ul", "Ver", "Wes", "Yor", "Zen", "Ar", "Bel", "Cal", "Dor", "Ev"];
const SYL_B = ["a", "e", "i", "o", "", "ar", "en", "or", "is", "an"];
const SYL_C = ["ra", "nix", "tora", "vex", "mont", "dale", "ton", "wick", "ly", "via", "sio", "quest", "path", "forge", "loop", "grid", "field", "stone", "bridge", "wave"];
const SUFFIXES = ["Labs", "Systems", "Group", "Partners", "Analytics", "Health", "Logistics", "Studio", "Works", "Software", "Solutions", "Foods", "Capital", "Robotics", "Energy", "Media", "Supply", "Consulting"];

const FIRST = ["James", "Mary", "Wei", "Priya", "Mohammed", "Sofia", "Liam", "Olivia", "Noah", "Emma", "Lucas", "Ava", "Mateo", "Mia", "Ethan", "Amara", "Hiroshi", "Yuki", "Fatima", "Omar", "Chen", "Aisha", "Daniel", "Grace", "Samuel", "Chloe", "Ali", "Zara", "David", "Hannah", "Arjun", "Ananya", "Carlos", "Lucia", "Jonas", "Freya", "Kwame", "Adaeze", "Ivan", "Elena", "Ben", "Nora", "Tom", "Leah", "Ravi", "Meera", "Diego", "Valentina", "Ahmed", "Sara", "Michael", "Laura", "Kenji", "Ines", "Tariq", "Maya", "Felix", "Ruth", "Hugo", "Iris"];
const LAST = ["Smith", "Johnson", "Lee", "Patel", "Khan", "Garcia", "Martinez", "Nguyen", "Kim", "Chen", "Brown", "Williams", "Jones", "Miller", "Davis", "Rodriguez", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Martin", "Thompson", "White", "Lopez", "Clark", "Lewis", "Walker", "Hall", "Allen", "Young", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell", "Roberts", "Carter", "Evans", "Turner", "Torres", "Parker", "Collins", "Murphy", "Cook", "Morgan", "Cooper", "Reed", "Bailey", "Gomez", "Kelly", "Ward", "Diaz", "Wood", "Watson", "Brooks", "Bennett", "Gray", "Hughes", "Price", "Foster", "Ross", "Sullivan", "Ortiz", "Fisher", "Ahmed", "Hussain", "Singh", "Sharma", "Tanaka", "Yamamoto", "Schmidt", "Rossi", "Silva", "Santos", "Okafor", "Mensah", "Novak", "Larsen", "Dubois", "Moreau"];

type Loc = [city: string, state: string | null, country: string, dial: string | null];
const LOCATIONS: Loc[] = [
  ["San Francisco", "California", "United States", "+1"],
  ["New York", "New York", "United States", "+1"],
  ["Austin", "Texas", "United States", "+1"],
  ["Chicago", "Illinois", "United States", "+1"],
  ["Seattle", "Washington", "United States", "+1"],
  ["Boston", "Massachusetts", "United States", "+1"],
  ["Denver", "Colorado", "United States", "+1"],
  ["Atlanta", "Georgia", "United States", "+1"],
  ["Miami", "Florida", "United States", "+1"],
  ["Los Angeles", "California", "United States", "+1"],
  ["Toronto", "Ontario", "Canada", "+1"],
  ["Vancouver", "British Columbia", "Canada", "+1"],
  ["London", "England", "United Kingdom", null],
  ["Manchester", "England", "United Kingdom", null],
  ["Dublin", "Leinster", "Ireland", null],
  ["Berlin", "Berlin", "Germany", null],
  ["Munich", "Bavaria", "Germany", null],
  ["Paris", "Île-de-France", "France", null],
  ["Amsterdam", "North Holland", "Netherlands", null],
  ["Stockholm", "Stockholm", "Sweden", null],
  ["Madrid", "Madrid", "Spain", null],
  ["Sydney", "New South Wales", "Australia", null],
  ["Melbourne", "Victoria", "Australia", null],
  ["Singapore", null, "Singapore", null],
  ["Bangalore", "Karnataka", "India", null],
  ["Dubai", "Dubai", "United Arab Emirates", null],
  ["São Paulo", "São Paulo", "Brazil", null],
  ["Mexico City", "Mexico City", "Mexico", null],
  ["Lagos", "Lagos", "Nigeria", null],
  ["Karachi", "Sindh", "Pakistan", null],
  ["Lahore", "Punjab", "Pakistan", null],
];

const ROLES: Record<string, { c: string[]; vp: string[]; dir: string[]; mgr: string[]; ic: string[] }> = {
  Engineering: { c: ["Chief Technology Officer", "CTO"], vp: ["VP of Engineering"], dir: ["Director of Engineering", "Head of Platform"], mgr: ["Engineering Manager", "Lead Software Engineer"], ic: ["Senior Software Engineer", "Software Engineer", "DevOps Engineer", "Data Engineer"] },
  Sales: { c: ["Chief Revenue Officer"], vp: ["VP of Sales"], dir: ["Director of Sales", "Head of Business Development"], mgr: ["Sales Manager", "Regional Sales Manager"], ic: ["Account Executive", "Sales Development Representative", "Business Development Representative"] },
  Marketing: { c: ["Chief Marketing Officer"], vp: ["VP of Marketing"], dir: ["Director of Marketing", "Head of Growth"], mgr: ["Marketing Manager", "Content Marketing Manager"], ic: ["Marketing Specialist", "SEO Specialist", "Demand Generation Specialist"] },
  "Finance & Administration": { c: ["Chief Financial Officer"], vp: ["VP of Finance"], dir: ["Finance Director", "Financial Controller"], mgr: ["Finance Manager", "Accounting Manager"], ic: ["Financial Analyst", "Accountant"] },
  "Human Resources": { c: ["Chief People Officer"], vp: ["VP of People"], dir: ["Director of Human Resources", "Head of Talent"], mgr: ["HR Manager", "Recruiting Manager"], ic: ["Recruiter", "HR Generalist", "Talent Acquisition Specialist"] },
  "IT & IS": { c: ["Chief Information Officer"], vp: ["VP of IT"], dir: ["IT Director", "Head of Security"], mgr: ["IT Manager", "Security Manager"], ic: ["Systems Administrator", "Network Engineer", "Security Analyst"] },
  Operations: { c: ["Chief Operating Officer"], vp: ["VP of Operations"], dir: ["Director of Operations", "Head of Supply Chain"], mgr: ["Operations Manager", "Logistics Manager"], ic: ["Operations Analyst", "Procurement Specialist"] },
  Support: { c: [], vp: ["VP of Customer Success"], dir: ["Director of Customer Success", "Head of Support"], mgr: ["Customer Success Manager", "Support Manager"], ic: ["Customer Support Specialist", "Customer Success Associate"] },
};

const TECH = ["Google Analytics", "Google Tag Manager", "HubSpot", "Salesforce", "Marketo", "Intercom", "Zendesk", "Stripe", "Shopify", "WordPress", "Webflow", "React", "Next.js", "Vue.js", "Angular", "Cloudflare", "Amazon Web Services", "Google Cloud", "Microsoft Azure", "Segment", "Mixpanel", "Amplitude", "Hotjar", "Slack", "Zoom", "Okta", "Jira", "Notion", "Gong", "Outreach", "Salesloft", "Pipedrive", "Zoho CRM", "Mailchimp", "Klaviyo", "Twilio", "SendGrid", "Datadog", "Snowflake", "Tableau", "Looker", "Workday", "BambooHR", "Greenhouse", "Lever", "NetSuite", "QuickBooks", "Xero", "DocuSign", "Calendly", "Optimizely", "Vercel", "WooCommerce", "BigCommerce"];
const PRODUCTS = ["a self-serve plan", "a partner program", "a new mobile app", "an open API", "a customer portal", "a usage-based pricing tier", "a reporting suite", "an integrations marketplace"];
const PITCHES = [
  "It helps operations teams replace spreadsheets with one shared workspace.",
  "Its platform shortens the time between a first order and repeat business.",
  "It sells to mid-market companies that have outgrown their first tools.",
  "Its customers use it to cut manual reporting from days to minutes.",
  "It works with regional distributors to keep inventory moving.",
  "It runs a subscription model with annual contracts.",
  "Its team focuses on onboarding and long-term customer success.",
];
const PATTERNS = ["first.last", "first.last", "first.last", "first", "flast", "firstl", "first_last", "f.last"] as const;

function emailFor(pattern: (typeof PATTERNS)[number], first: string, last: string, domain: string) {
  const f = first.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
  const l = last.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
  const local = { "first.last": `${f}.${l}`, first: f, flast: `${f[0]}${l}`, firstl: `${f}${l[0]}`, first_last: `${f}_${l}`, "f.last": `${f[0]}.${l}` }[pattern];
  return `${local}@${domain}`;
}

const dateDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const fakePhone = (r: ReturnType<typeof prng>, dial: string | null) => (dial === "+1" ? `+1 (${r.int(201, 989)}) 555-01${String(r.int(0, 99)).padStart(2, "0")}` : null);

function revenueForEmployees(n: number, r: ReturnType<typeof prng>) {
  const perHead = r.int(80, 320) * 1000;
  return revenueBand(String(n * perHead));
}

export interface DemoSummary {
  companies: number;
  people: number;
  seed: number;
}

/**
 * Generates fictional companies (reserved .test domains, 555-01xx phone numbers, no social profiles)
 * and their employees. Safe to load more than once: earlier demo rows are replaced.
 */
export async function loadDemoDataset(opts: { companies?: number; seed?: number } = {}, onProgress?: (pct: number) => Promise<void>): Promise<DemoSummary> {
  const count = Math.max(10, Math.min(20_000, opts.companies ?? 1_500));
  const seed = opts.seed ?? 20_260_101;
  const r = prng(seed);
  await deleteDemoDataset();
  const industries = Object.keys(INDUSTRY_TREE);
  const usedDomains = new Set<string>();
  const companyNames: string[] = [];
  const companies: Array<CompanyInsert & { _people: number; _pattern: (typeof PATTERNS)[number]; _loc: Loc; _dept: string[] }> = [];
  for (let i = 0; i < count; i++) {
    const base = `${r.pick(SYL_A)}${r.pick(SYL_B)}${r.pick(SYL_C)}`;
    const suffix = r.chance(0.6) ? r.pick(SUFFIXES) : "";
    let domain = `${base}${suffix}`.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
    while (usedDomains.has(domain)) domain = `${domain}${r.int(2, 99)}`;
    usedDomains.add(domain);
    const name = suffix ? `${base} ${suffix}` : base;
    companyNames.push(name);
    const bucket = r.next();
    const employees = bucket < 0.45 ? r.int(2, 50) : bucket < 0.75 ? r.int(51, 500) : bucket < 0.93 ? r.int(501, 5_000) : r.int(5_001, 60_000);
    const industry = r.pick(industries);
    const subIndustry = r.pick(INDUSTRY_TREE[industry]!);
    const loc = r.pick(LOCATIONS);
    const founded = employees > 5_000 ? r.int(1950, 2010) : r.int(1985, 2024);
    const funded = founded >= 2008 && employees <= 3_000 && r.chance(0.4);
    const stages = employees < 30 ? ["pre_seed", "seed"] : employees < 150 ? ["seed", "series_a"] : employees < 600 ? ["series_a", "series_b", "series_c"] : ["series_c", "series_d", "series_e"];
    const stage = funded ? r.pick(stages.filter((s) => (FUNDING_TYPES as readonly string[]).includes(s))) : null;
    companies.push({
      workspaceId: null,
      name,
      domain: `${domain}.test`,
      industry,
      subIndustry,
      employeeCount: employees,
      revenueRange: revenueForEmployees(employees, r),
      foundedYear: founded,
      city: loc[0],
      state: loc[1],
      country: loc[2],
      description: `${name} is a ${employees < 50 ? "small" : employees < 1_000 ? "growing" : "large"} ${subIndustry.toLowerCase()} company based in ${loc[0]}, founded in ${founded}. ${r.pick(PITCHES)}`,
      keywords: [subIndustry.toLowerCase(), industry.toLowerCase(), r.chance(0.5) ? "b2b" : "b2c", r.chance(0.3) ? "saas" : "services"].join(", "),
      technologies: r.sample(TECH, r.int(3, 10)),
      funding: stage ? { stage, total: r.int(5, 400) * 100_000 * (stages.indexOf(stage) + 1), last_round_at: dateDaysAgo(r.int(20, 900)) } : null,
      phone: fakePhone(r, loc[3]),
      linkedinUrl: null,
      logoUrl: null,
      news: [],
      jobPostings: [],
      _people: Math.min(14, 1 + Math.round(Math.log2(employees + 1) * r.int(6, 12) / 10)),
      _pattern: r.pick(PATTERNS),
      _loc: loc,
      _dept: Object.keys(ROLES),
    });
  }
  // News and job posts reference other demo companies, never real ones.
  for (const c of companies) {
    const items = r.int(0, 4);
    for (let i = 0; i < items; i++) {
      const picked = r.pick(["launches", "expands_offices_to", "hires", "partners_with", "receives_financing", "receives_award", "acquires", "increases_headcount_by", "signs_new_client", "integrates_with", "is_developing", "opens_new_location", "promotes"] as const satisfies readonly (typeof LF_NEWS_TYPES)[number][]);
      // Funding news only for companies that have a funding round on record.
      const type = picked === "receives_financing" && !c.funding ? "launches" : picked;
      const other = r.pick(companyNames);
      const city = r.pick(LOCATIONS)[0];
      const title = {
        launches: `${c.name} launches ${r.pick(PRODUCTS)}`,
        expands_offices_to: `${c.name} opens an office in ${city}`,
        hires: `${c.name} hires a new ${r.pick(["VP of Sales", "Chief Marketing Officer", "Head of Growth", "Chief Financial Officer", "VP of Engineering"])}`,
        partners_with: `${c.name} partners with ${other}`,
        receives_financing: `${c.name} raises a ${titleCase((c.funding?.stage ?? "new").replace(/_/g, " "))} round`,
        receives_award: `${c.name} named one of ${c.city}'s best places to work`,
        acquires: `${c.name} acquires ${other}`,
        increases_headcount_by: `${c.name} plans to grow its team by ${r.int(10, 60)}% this year`,
        signs_new_client: `${c.name} signs a multi-year agreement with ${other}`,
        integrates_with: `${c.name} adds an integration with ${r.pick(TECH)}`,
        is_developing: `${c.name} is developing ${r.pick(PRODUCTS)}`,
        opens_new_location: `${c.name} opens a new location in ${city}`,
        promotes: `${c.name} promotes a new ${r.pick(["COO", "VP of Operations", "Head of Sales"])}`,
      }[type];
      c.news!.push({ title, type, date: dateDaysAgo(r.int(1, 365)), url: `https://${c.domain}/news/${slug(title)}` });
    }
    if (r.chance(0.45)) {
      const dept = ROLES[r.pick(Object.keys(ROLES))]!;
      for (const t of r.sample([...dept.ic, ...dept.mgr], r.int(1, 4))) c.jobPostings!.push({ title: t, date: dateDaysAgo(r.int(1, 60)), url: `https://${c.domain}/careers/${slug(t)}` });
    }
  }
  for (let i = 0; i < companies.length; i += CHUNK) {
    const slice = companies.slice(i, i + CHUNK);
    const created = await db
      .insert(C)
      .values(slice.map(({ _people, _pattern, _loc, _dept, ...c }) => c))
      .returning({ id: C.id });
    created.forEach((row, j) => ((slice[j] as { id?: string }).id = row.id));
    await onProgress?.(Math.round(((i + slice.length) / companies.length) * 40));
  }
  let people = 0;
  const batch: PersonInsert[] = [];
  for (let ci = 0; ci < companies.length; ci++) {
    const c = companies[ci]!;
    const used = new Set<string>();
    const catchAll = r.chance(0.12);
    for (let k = 0; k < c._people; k++) {
      let first = r.pick(FIRST);
      let last = r.pick(LAST);
      for (let tries = 0; used.has(`${first} ${last}`) && tries < 5; tries++) [first, last] = [r.pick(FIRST), r.pick(LAST)];
      if (used.has(`${first} ${last}`)) continue;
      used.add(`${first} ${last}`);
      const small = (c.employeeCount ?? 0) < 50;
      const deptName = k === 0 ? null : r.pick(c._dept);
      const roles = deptName ? ROLES[deptName]! : null;
      const title =
        k === 0
          ? r.pick(small ? ["Founder & CEO", "Co-Founder", "Owner", "CEO"] : ["CEO", "President", "Founder & CEO"])
          : r.pick(
              (() => {
                const roll = r.next();
                if (roll < 0.08 && roles!.c.length) return roles!.c;
                if (roll < 0.2) return roles!.vp;
                if (roll < 0.4) return roles!.dir;
                if (roll < 0.65) return roles!.mgr;
                return roles!.ic;
              })(),
            );
      const loc = r.chance(0.8) ? c._loc : r.pick(LOCATIONS);
      const hasEmail = r.chance(0.93);
      const statusRoll = r.next();
      batch.push({
        workspaceId: null,
        companyId: (c as { id?: string }).id!,
        firstName: first,
        lastName: last,
        fullName: `${first} ${last}`,
        title,
        seniority: levelOf(title),
        department: deptName ?? departmentOf(title),
        email: hasEmail ? emailFor(c._pattern, first, last, c.domain!) : null,
        emailStatus: !hasEmail ? null : catchAll ? "catch_all" : statusRoll < 0.85 ? "verified" : "risky",
        phone: r.chance(0.3) ? fakePhone(r, loc[3]) : null,
        linkedinUrl: null,
        city: loc[0],
        state: loc[1],
        country: loc[2],
      });
      people++;
    }
    if (batch.length >= 1_000 || ci === companies.length - 1) {
      await insertChunks(P, batch.splice(0));
      await onProgress?.(40 + Math.round(((ci + 1) / companies.length) * 60));
    }
  }
  return { companies: companies.length, people, seed };
}

/** Removes the demo rows (shared rows on .test domains) and nothing else. */
export async function deleteDemoDataset(): Promise<{ companies: number; people: number }> {
  const demo = and(isNull(C.workspaceId), like(C.domain, "%.test"));
  const ids = (await db.select({ id: C.id }).from(C).where(demo)).map((c) => c.id);
  let people = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const res = await db.delete(P).where(and(isNull(P.workspaceId), inArray(P.companyId, ids.slice(i, i + 500))));
    people += res.rowsAffected;
  }
  const res = await db.delete(C).where(demo);
  return { companies: res.rowsAffected, people };
}

registerJobHandler("lf-demo-dataset", async ({ job, progress }) => {
  const d = job.data as { companies?: number; seed?: number };
  return { ...(await loadDemoDataset(d, (pct) => progress(pct))) };
});

export async function datasetStats(workspaceId: string) {
  const [shared] = await db.all<{ companies: number; people: number; demo: number }>(
    sql`select (select count(*) from lf_companies where workspace_id is null) as companies,
               (select count(*) from lf_people where workspace_id is null) as people,
               (select count(*) from lf_companies where workspace_id is null and domain like '%.test') as demo`,
  );
  const [own] = await db.all<{ companies: number; people: number }>(
    sql`select (select count(*) from lf_companies where workspace_id = ${workspaceId}) as companies, (select count(*) from lf_people where workspace_id = ${workspaceId}) as people`,
  );
  return {
    shared: { companies: Number(shared?.companies ?? 0), people: Number(shared?.people ?? 0), demo_companies: Number(shared?.demo ?? 0) },
    workspace: { companies: Number(own?.companies ?? 0), people: Number(own?.people ?? 0) },
    employee_bands: Object.keys(EMPLOYEE_BANDS),
  };
}

/** Deletes this workspace's private dataset rows. */
export async function clearWorkspaceDataset(workspaceId: string) {
  const people = await db.delete(P).where(eq(P.workspaceId, workspaceId));
  const companies = await db.delete(C).where(eq(C.workspaceId, workspaceId));
  return { companies: companies.rowsAffected, people: people.rowsAffected };
}

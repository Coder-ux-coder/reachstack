// Enrichment columns on lists and campaigns: which lead variables each kind writes, and the local clean-up
// ("normalize") rules that tidy names, company names and domains without AI.

import { FREE_MAIL_DOMAINS } from "./constants";

/** Values the clean-up column can tidy, and the variable each one is saved to. */
export const NORMALIZE_TARGETS = {
  name: ["clean_first_name", "clean_last_name"],
  company: ["clean_company_name"],
  domain: ["clean_company_domain"],
} as const;
export type NormalizeTarget = keyof typeof NORMALIZE_TARGETS;
export const NORMALIZE_TARGET_KEYS = Object.keys(NORMALIZE_TARGETS) as NormalizeTarget[];

/**
 * Lead variables (custom variables) each enrichment kind fills in. Kinds that write standard fields (the work email,
 * the email check) list only their extra variables. AI columns write the variable named after the column.
 */
export const ENRICHMENT_OUTPUT_KEYS: Record<string, readonly string[]> = {
  work_email_enrichment: ["email_finder_status", "email_source"],
  custom_flow: ["email_finder_status", "email_source"],
  email_verification: [],
  fully_enriched_profile: ["seniority", "department", "company_industry", "company_sub_industry", "company_size", "company_revenue", "company_linkedin", "company_description", "company_location"],
  technologies: ["technologies"],
  news: ["latest_news", "latest_news_url", "news_count"],
  joblisting: ["open_roles", "job_titles", "jobs_url"],
  funding: ["funding_stage", "funding_total", "last_funding_at"],
  engagement_score: ["engagement_score"],
};

/** Variables written by a clean-up column for the chosen targets. */
export const normalizeKeys = (targets: readonly string[]) => NORMALIZE_TARGET_KEYS.filter((t) => targets.includes(t)).flatMap((t) => [...NORMALIZE_TARGETS[t]]);

/** Columns people can add to a list or campaign from the leads table. */
export const ENRICHMENT_COLUMN_TYPES = [
  "work_email_enrichment",
  "email_verification",
  "fully_enriched_profile",
  "technologies",
  "news",
  "joblisting",
  "funding",
  "engagement_score",
  "normalize",
  "ai_enrichment",
] as const;
export type EnrichmentColumnType = (typeof ENRICHMENT_COLUMN_TYPES)[number];

export interface EnrichmentColumnKind {
  type: EnrichmentColumnType;
  label: string;
  description: string;
  /** Only offered on lists (campaign leads always have an address). */
  listsOnly?: boolean;
  /** Only offered on campaigns (it reads email activity). */
  campaignsOnly?: boolean;
}

export const ENRICHMENT_COLUMN_KINDS: EnrichmentColumnKind[] = [
  { type: "work_email_enrichment", label: "Work email", description: "Finds a work address from the name and company domain.", listsOnly: true },
  { type: "email_verification", label: "Email check", description: "Checks that each address can receive mail." },
  { type: "fully_enriched_profile", label: "Full profile", description: "Seniority, department, company size, industry and more." },
  { type: "technologies", label: "Technologies", description: "Tools the company's website is built with." },
  { type: "news", label: "Company news", description: "The latest headline about the company." },
  { type: "joblisting", label: "Job openings", description: "Roles the company is hiring for." },
  { type: "funding", label: "Funding", description: "Latest funding stage and total raised." },
  { type: "engagement_score", label: "Engagement score", description: "0 to 100, from opens, clicks and replies.", campaignsOnly: true },
  { type: "normalize", label: "Clean up", description: "Tidies names, company names and domains. Free, no AI." },
  { type: "ai_enrichment", label: "AI column", description: "Ask a question about each lead and save the answer." },
];

/** Lead fields and the variables other columns write, which an AI column can't be named after. */
const RESERVED_NAMES = new Set(
  [
    "email",
    "first_name",
    "firstname",
    "last_name",
    "lastname",
    "company_name",
    "companyname",
    "company_domain",
    "companydomain",
    "website",
    "website_content",
    "phone",
    "job_title",
    "jobtitle",
    "linkedin_url",
    "linkedin",
    "location",
    "personalization",
    "unsubscribe_url",
    "unsubscribelink",
    ...Object.values(ENRICHMENT_OUTPUT_KEYS).flat(),
    ...Object.values(NORMALIZE_TARGETS).flat(),
  ].map((s) => s.toLowerCase()),
);

/** Why an AI column name can't be used, or null. The name is the {{variable}} the answers are saved to. */
export function aiColumnNameError(name: string): string | null {
  if (!name) return "Give the column a name";
  if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name)) return "Use letters, numbers and underscores, starting with a letter (60 at most)";
  if (RESERVED_NAMES.has(name.toLowerCase())) return `"${name}" is already a lead field. Pick another name.`;
  return null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const hasLetters = (s: string) => /\p{L}/u.test(s);
const isLower = (s: string) => hasLetters(s) && s === s.toLowerCase();
const isUpper = (s: string) => hasLetters(s) && s === s.toUpperCase();
const capitalize = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);

// Legal forms at the end of a company name. Long ones match in any case; two-letter ones only as written in
// capitals (or with dots), so ordinary words like "as" or "co" in a name stay.
const LEGAL_ANY_CASE =
  /[\s,]+(incorporated|inc|l\.?l\.?c|ltd|limited|corp|corporation|company|gmbh|plc|l\.?l\.?p|pty\.? ltd|pty|pte\.? ltd|pte|sarl|s\.?a\.?r\.?l|s\.?r\.?l|s\.?p\.?a|ltda|limitada|sdn\.? bhd|bhd|pvt\.? ltd|private limited|kgaa|sp\. z o\.o)\.?$/i;
const LEGAL_CAPS = /[\s,]+(AG|SA|S\.A|BV|B\.V|NV|N\.V|AB|AS|A\/S|ApS|Oy|OY|SE|KK|K\.K|LP|L\.P|Co|CO|co\.|SAS|S\.A\.S|KG|GmbH & Co\.? KG)\.?$/;
const WEB_SUFFIX = /^([\p{L}\d][\p{L}\d-]*)\.(com|io|co|ai|net|org|app|dev|so|xyz|tech|co\.uk)$/iu;

/** "Acme Inc." → "Acme", "ACME WIDGETS LTD" → "Acme Widgets", "acme.io" → "Acme". */
export function cleanCompanyName(input: string | null | undefined): string {
  const original = collapse(input ?? "");
  if (!original) return "";
  let s = original;
  // Taglines after a separator: "Acme | Payroll software", "Acme - The widget people".
  const tagline = /^(.{2,}?)\s+[|–—-]\s+.+$/.exec(s);
  if (tagline) s = tagline[1]!;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
    s = s.replace(LEGAL_ANY_CASE, "").replace(LEGAL_CAPS, "").trim();
    s = s.replace(/[\s,.;:&-]+$/, "").trim();
    if (s === before) break;
  }
  const web = WEB_SUFFIX.exec(s);
  if (web && !s.includes(" ")) s = web[1]!;
  if (!s) return original;
  if (isLower(s)) return s.split(" ").map((w, i) => (i > 0 && /^(and|of|the|for|de|la|du)$/.test(w) ? w : capitalize(w))).join(" ");
  // A whole name in capitals reads as shouting; short words (IT, HR, UK) are likely acronyms and stay.
  if (isUpper(s) && s.includes(" ")) return s.split(" ").map((w) => (w.replace(/[^\p{L}]/gu, "").length <= 2 ? w : capitalize(w))).join(" ");
  return s;
}

const PARTICLES = new Set(["van", "von", "de", "der", "den", "da", "di", "du", "del", "della", "la", "le", "ter", "ten", "bin", "al", "dos", "das"]);
const TITLES = /^(mr|mrs|ms|miss|dr|prof|sir)\.?\s+/i;

function capitalizeName(word: string, first: boolean): string {
  const lower = word.toLowerCase();
  if (!first && PARTICLES.has(lower)) return lower;
  if (/^mc\p{L}{2,}/u.test(lower)) return `Mc${capitalize(lower.slice(2))}`;
  // Hyphens and apostrophes start a new part: Mary-Jane, O'Neil.
  return lower.replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** "JOHN" → "John", "mary-jane o'neil" → "Mary-Jane O'Neil", "Smith, MBA" → "Smith". Mixed case is kept as typed. */
export function cleanPersonName(input: string | null | undefined): string {
  let s = collapse(input ?? "");
  if (!s) return "";
  s = s.replace(TITLES, "");
  // Credentials after a comma ("Smith, PhD") and characters that aren't part of a name (emoji, digits, quotes).
  s = s.replace(/,.*$/, "");
  s = collapse(s.replace(/[^\p{L}\p{M}\s.'’-]/gu, " "));
  s = s.replace(/^[.'’-]+|[.'’-]+$/g, "").trim();
  if (!s) return "";
  if (!isLower(s) && !isUpper(s)) return s;
  return s
    .split(" ")
    .map((w, i) => capitalizeName(w, i === 0))
    .join(" ");
}

/** "https://www.Acme.com/about" → "acme.com"; free mailbox domains (gmail.com) and non-domains → "". */
export function cleanDomain(input: string | null | undefined): string {
  let s = (input ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\d?\./, "");
  s = s.split(/[/?#:\s]/)[0]!.replace(/\.+$/, "");
  if (!/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s)) return "";
  if (FREE_MAIL_DOMAINS.has(s)) return "";
  return s;
}

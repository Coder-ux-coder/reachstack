// Integration providers: single lookups that can run on demand (POST .../integrations/run) or as an
// enrichment column (`integration_actions`). Each provider here runs on this server's own capabilities;
// Hunter appears only when HUNTER_API_KEY is set.
import { and, eq, isNull, or } from "drizzle-orm";
import { db, schema } from "../../db/client";
import { config } from "../../env";
import { badRequest } from "../../http/errors";
import { workspaceLimits } from "../billing-limits";
import { verifyAndStore } from "../verification";
import { companyNews, findWorkEmail, hunterFind, jobListings, websiteProfile } from "./enrichers";
import { normalizeDomain } from "../domains";

type Input = { key: string; label: string; required: boolean; type: "column" | "text" | "list"; placeholder?: string };
interface Action {
  id: string;
  name: string;
  description: string;
  outputColumn: string;
  category: "person" | "company" | "verification";
  subcategory?: "firmographics" | "ads_marketing" | "technology" | "funding_investors" | "jobs" | "web_ecommerce";
  inputs: Input[];
  /** `free`: the result costs nothing (a check reused from the last 30 days, or one that reached no verdict). */
  run(workspaceId: string, inputs: Record<string, string>): Promise<{ value: string | null; output: Record<string, unknown>; free?: boolean }>;
}
interface Provider {
  id: string;
  name: string;
  creditCostPerAction: number;
  isFeatured: boolean;
  available: () => boolean;
  actions: Action[];
}

const col = (key: string, label: string, required = true): Input => ({ key, label, required, type: "column" });
const domainOf = (v: string | undefined) => (v ? normalizeDomain(v.includes("@") ? v.split("@")[1]! : v) : "");

const PROVIDERS: Provider[] = [
  {
    id: "dataset",
    name: "Lead Finder dataset",
    creditCostPerAction: 1,
    isFeatured: true,
    available: () => true,
    actions: [
      {
        id: "dataset_find_email",
        name: "Find work email",
        description: "Looks the person up in the people dataset by name and company domain.",
        outputColumn: "work_email",
        category: "person",
        inputs: [col("first_name", "First name"), col("last_name", "Last name"), col("domain", "Company domain")],
        async run(ws, i) {
          const r = await findWorkEmail({ first_name: i.first_name ?? null, last_name: i.last_name ?? null, domain: domainOf(i.domain) }, [], ws);
          return { value: r.email, output: { ...r } };
        },
      },
      {
        id: "dataset_company_profile",
        name: "Company profile",
        description: "Industry, size, revenue band, location and funding from the company dataset.",
        outputColumn: "company_profile",
        category: "company",
        subcategory: "firmographics",
        inputs: [col("domain", "Company domain")],
        async run(ws, i) {
          const C = schema.lfCompanies;
          const [c] = await db.select().from(C).where(and(eq(C.domain, domainOf(i.domain)), or(isNull(C.workspaceId), eq(C.workspaceId, ws)))).limit(1);
          if (!c) return { value: null, output: {} };
          const output = { name: c.name, industry: c.industry, sub_industry: c.subIndustry, employee_count: c.employeeCount, revenue_range: c.revenueRange, founded_year: c.foundedYear, city: c.city, state: c.state, country: c.country, funding: c.funding };
          return { value: [c.industry, c.employeeCount ? `${c.employeeCount} employees` : null, c.country].filter(Boolean).join(" · "), output };
        },
      },
    ],
  },
  {
    id: "website",
    name: "Company website",
    creditCostPerAction: 1,
    isFeatured: true,
    available: () => true,
    actions: [
      {
        id: "website_technologies",
        name: "Technologies",
        description: "Reads the company homepage and detects the tools it runs (analytics, CRM, chat, hosting...).",
        outputColumn: "technologies",
        category: "company",
        subcategory: "technology",
        inputs: [col("domain", "Company domain or website")],
        async run(_ws, i) {
          const p = await websiteProfile(i.domain ?? "");
          return { value: p?.technologies.join(", ") || null, output: { ...(p ?? {}) } };
        },
      },
      {
        id: "website_jobs",
        name: "Open jobs",
        description: "Open roles from the company's public job board (Greenhouse, Lever or Ashby).",
        outputColumn: "open_roles",
        category: "company",
        subcategory: "jobs",
        inputs: [col("company_name", "Company name", false), col("domain", "Company domain", false)],
        async run(_ws, i) {
          const jobs = await jobListings(i.company_name ?? null, i.domain ? domainOf(i.domain) : null);
          return { value: jobs.length ? jobs.slice(0, 5).map((j) => j.title).join("; ") : null, output: { count: jobs.length, jobs } };
        },
      },
      {
        id: "website_news",
        name: "Recent news",
        description: "Latest news headlines that mention the company.",
        outputColumn: "latest_news",
        category: "company",
        subcategory: "firmographics",
        inputs: [col("company_name", "Company name")],
        async run(_ws, i) {
          const news = await companyNews(i.company_name ?? "", 5);
          return { value: news[0]?.title ?? null, output: { news } };
        },
      },
    ],
  },
  {
    id: "verifier",
    name: "Email verification",
    creditCostPerAction: 0.25,
    isFeatured: false,
    available: () => true,
    actions: [
      {
        id: "verify_email",
        name: "Verify email",
        description: "Checks the address syntax, domain, mail server and (when enabled) the mailbox itself.",
        outputColumn: "email_status",
        category: "verification",
        inputs: [col("email", "Email")],
        async run(ws, i) {
          if (!i.email) return { value: null, output: {} };
          const r = await verifyAndStore(ws, i.email);
          return { value: r.status, output: { ...r }, free: !!r.cached || r.status === "unknown" };
        },
      },
    ],
  },
  {
    id: "hunter",
    name: "Hunter",
    creditCostPerAction: 1,
    isFeatured: false,
    available: () => !!config.hunterApiKey,
    actions: [
      {
        id: "hunter_find_email",
        name: "Find email (Hunter)",
        description: "Asks hunter.io for the person's address at the company domain.",
        outputColumn: "work_email",
        category: "person",
        inputs: [col("first_name", "First name"), col("last_name", "Last name"), col("domain", "Company domain")],
        async run(_ws, i) {
          const r = await hunterFind(i.first_name ?? "", i.last_name ?? "", domainOf(i.domain));
          return { value: r?.email ?? null, output: { ...(r ?? { status: "not_found" }) } };
        },
      },
    ],
  },
];

export async function providerRegistry(workspaceId: string) {
  const selfHosted = (await workspaceLimits(workspaceId)).self_hosted;
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    creditCostPerAction: p.creditCostPerAction,
    requiresUserConnection: false,
    isFeatured: p.isFeatured,
    isConnected: p.available(),
    credentialSource: p.available() ? "instantly_key" : "unavailable",
    effectiveCostPerAction: p.available() ? (selfHosted ? 0 : p.creditCostPerAction) : null,
    actions: p.actions.map(({ run: _run, ...a }) => a),
  }));
}

export function findAction(providerId: string, actionId: string) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) throw badRequest(`Unknown provider: ${providerId}`);
  if (!provider.available()) throw badRequest(`${provider.name} is not configured on this server`);
  const action = provider.actions.find((a) => a.id === actionId);
  if (!action) throw badRequest(`Unknown action ${actionId} for provider ${providerId}`);
  return { provider, action };
}

/** Checks an `integration_actions` object: {provider: {action: {mapping: {input: column}}}}. */
export function validateIntegrationActions(v: unknown): Record<string, Record<string, { mapping: Record<string, string> }>> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw badRequest("integration_actions must be an object keyed by provider id");
  const out: Record<string, Record<string, { mapping: Record<string, string> }>> = {};
  for (const [providerId, actions] of Object.entries(v as Record<string, unknown>)) {
    if (!actions || typeof actions !== "object") throw badRequest(`integration_actions.${providerId} must be an object keyed by action id`);
    out[providerId] = {};
    for (const [actionId, cfg] of Object.entries(actions as Record<string, unknown>)) {
      const { action } = findAction(providerId, actionId);
      const mapping = (cfg as { mapping?: unknown })?.mapping;
      if (!mapping || typeof mapping !== "object") throw badRequest(`integration_actions.${providerId}.${actionId}.mapping is required`);
      const m = mapping as Record<string, unknown>;
      const missing = action.inputs.filter((i) => i.required && typeof m[i.key] !== "string").map((i) => i.key);
      if (missing.length) throw badRequest(`integration_actions.${providerId}.${actionId}.mapping needs: ${missing.join(", ")}`);
      out[providerId][actionId] = { mapping: Object.fromEntries(Object.entries(m).filter(([, c]) => typeof c === "string")) as Record<string, string> };
    }
  }
  if (!Object.keys(out).length) throw badRequest("integration_actions is empty");
  return out;
}

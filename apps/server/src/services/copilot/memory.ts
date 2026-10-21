// Copilot memory: what the workspace sells and to whom (business details, ideal customer profiles and
// writing rules). One record per workspace, shared with the AI Sales Agent ("memory_from_workspace").
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../../db/client";
import { HttpError } from "../../http/errors";
import { usesLocalAi } from "../ai";
import { extractMemory, type SalesMemory } from "../agents/sales-ai";

const M = schema.copilotMemory;
export const MEMORY_KEY = "business_details";
export const MAX_RULES = 10;

const strList = (max = 30) => z.array(z.string().trim().min(1).max(500)).max(max);

export const icpSchema = z.object({
  name: z.string().trim().min(1).max(200),
  location: strList(50).optional(),
  problems_solved: strList().optional(),
  benefits: strList().optional(),
  business_offer: z.string().max(5_000).optional(),
  usp: z.string().max(5_000).optional(),
  customer_goals: strList().optional(),
  success_stories: z.string().max(10_000).optional(),
  keywords: z.object({ include: z.string().max(2_000).nullable().optional(), exclude: z.string().max(2_000).nullable().optional() }).optional(),
  company_size: z.array(z.string()).max(20).optional(),
  industry: z.array(z.string()).max(100).optional(),
  job_title: z.object({ include: strList(50).optional(), exclude: strList(50).optional() }).optional(),
});

export const memorySchema = z.object({
  website: z.string().trim().max(500).optional(),
  company: z.string().trim().max(500).optional(),
  business_description: z.string().max(20_000).optional(),
  business_offers: z.array(z.string().trim().min(1).max(2_000)).max(20).optional(),
  active_business_offers_indexes: z.array(z.number().int().min(0)).max(20).optional(),
  awards: z.string().max(5_000).optional(),
  outreach_goal: z.string().max(2_000).optional(),
  icps: z.array(icpSchema).max(10).optional(),
  active_icps_indexes: z.array(z.number().int().min(0)).max(10).optional(),
  custom_fields: z.array(z.string().trim().min(1).max(2_000)).max(MAX_RULES).optional(),
  predefined_rules: z
    .object({
      liquid_spintax: z.boolean().optional(),
      default_language: z.string().trim().max(60).nullable().optional(),
      keep_short: z.boolean().optional(),
    })
    .optional(),
});

export type CopilotMemory = z.infer<typeof memorySchema>;

export async function getMemory(workspaceId: string) {
  const [row] = await db.select().from(M).where(and(eq(M.workspaceId, workspaceId), eq(M.key, MEMORY_KEY))).limit(1);
  return row ? { data: row.data as CopilotMemory, updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
}

/** Drops empty values and indexes that no longer point anywhere. */
export function cleanMemory(m: CopilotMemory): CopilotMemory {
  const offers = (m.business_offers ?? []).filter((o) => o.trim());
  const icps = m.icps ?? [];
  return {
    ...m,
    business_offers: offers,
    active_business_offers_indexes: (m.active_business_offers_indexes ?? offers.map((_, i) => i)).filter((i) => i < offers.length),
    icps,
    active_icps_indexes: (m.active_icps_indexes ?? icps.map((_, i) => i)).filter((i) => i < icps.length),
    custom_fields: (m.custom_fields ?? []).filter((r) => r.trim()),
  };
}

export async function saveMemory(workspaceId: string, userId: string | null, data: CopilotMemory) {
  const value = cleanMemory(data) as Record<string, unknown>;
  await db
    .insert(M)
    .values({ workspaceId, key: MEMORY_KEY, data: value, updatedBy: userId })
    .onConflictDoUpdate({ target: [M.workspaceId, M.key], set: { data: value, updatedBy: userId, updatedAt: new Date() } });
  return (await getMemory(workspaceId))!;
}

export async function clearMemory(workspaceId: string) {
  await db.delete(M).where(and(eq(M.workspaceId, workspaceId), eq(M.key, MEMORY_KEY)));
}

/** The sales-agent brief turned into the copilot's memory shape. */
function fromSales(m: SalesMemory, website?: string): CopilotMemory {
  return cleanMemory({
    website,
    company: m.company,
    business_description: m.business_description,
    business_offers: m.business_offers,
    icps: (m.icps ?? []).map((i) => ({ ...i, location: [], business_offer: "" })),
  });
}

export async function extractFromWebsite(workspaceId: string, url: string): Promise<CopilotMemory> {
  return fromSales(await extractMemory(workspaceId, { type: "website", input: url }), url);
}

/** Reads a PDF (Claude reads the document itself) or a plain text file. */
export async function extractFromFile(workspaceId: string, file: { name: string; mime: string; bytes: Buffer }): Promise<CopilotMemory> {
  const isPdf = file.mime === "application/pdf" || /\.pdf$/i.test(file.name);
  // The local AI gets text only: a PDF would reach it empty, and it would make the details up.
  if (isPdf && (await usesLocalAi(workspaceId)))
    throw new HttpError(400, "Reading a PDF needs Claude: add an Anthropic API key in Settings → Integrations & API → AI. With the local AI, upload the text as a .txt file instead.", "pdf_needs_claude");
  const source = isPdf
    ? ({ type: "pdf", data: file.bytes.toString("base64"), name: file.name } as const)
    : ({ type: "pitch_deck", input: file.bytes.toString("utf8") } as const);
  return fromSales(await extractMemory(workspaceId, source));
}

/** Memory as prompt text for the copilot's system prompt. */
export function memoryPrompt(m: CopilotMemory | null): string {
  if (!m) return "";
  const lines: string[] = [];
  const add = (label: string, v: unknown) => {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return;
    lines.push(`${label}: ${Array.isArray(v) ? v.join("; ") : String(v)}`);
  };
  add("Company", m.company);
  add("Website", m.website);
  add("What they do", m.business_description);
  // No list of what's on means all of it; an empty one means none.
  const offers = (m.business_offers ?? []).filter((_, i) => !m.active_business_offers_indexes || m.active_business_offers_indexes.includes(i));
  add("Offers", offers);
  add("Awards and recognition", m.awards);
  add("Outreach goal", m.outreach_goal);
  const icps = (m.icps ?? []).filter((_, i) => !m.active_icps_indexes || m.active_icps_indexes.includes(i));
  icps.forEach((icp, i) => {
    lines.push(`\nIdeal customer profile ${i + 1}: ${icp.name}`);
    add("  Locations", icp.location);
    add("  Problems solved", icp.problems_solved);
    add("  Benefits", icp.benefits);
    add("  Offer for them", icp.business_offer);
    add("  Unique selling points", icp.usp);
    add("  Their goals", icp.customer_goals);
    add("  Success stories", icp.success_stories);
    add("  Job titles", icp.job_title?.include);
    add("  Excluded titles", icp.job_title?.exclude);
    add("  Industries", icp.industry);
    add("  Company sizes", icp.company_size);
    add("  Keywords", icp.keywords?.include);
    add("  Excluded keywords", icp.keywords?.exclude);
  });
  const rules = [...(m.custom_fields ?? [])];
  const p = m.predefined_rules ?? {};
  if (p.liquid_spintax) rules.push("Use spintax ({{RANDOM | a | b}}) and fallbacks ({{firstName | there}}) in emails you write.");
  if (p.default_language) rules.push(`Write emails in ${p.default_language} unless asked otherwise.`);
  if (p.keep_short) rules.push("Keep emails short: under 90 words.");
  if (rules.length) lines.push(`\nRules from the user:\n${rules.map((r) => `- ${r}`).join("\n")}`);
  return lines.join("\n").trim();
}

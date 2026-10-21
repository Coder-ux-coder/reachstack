// The AI Sales Agent's writing: learning the business from a website or pitch, drafting a sequence for an ideal
// customer profile, and researching a lead into a grounded opening line.
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { EMPLOYEE_BANDS, INDUSTRY_TREE } from "@reachstack/shared";
import { cachedSystem, pageText, structured } from "../ai";

export interface Icp {
  /** Lasting id: campaigns are linked to their profile by it. */
  id?: string;
  name: string;
  problems_solved?: string[];
  benefits?: string[];
  usp?: string;
  customer_goals?: string[];
  success_stories?: string;
  keywords?: { include?: string | null; exclude?: string | null };
  company_size?: string[];
  industry?: string[];
  job_title?: { include?: string[]; exclude?: string[] };
}

export interface SalesMemory {
  company?: string;
  business_description?: string;
  icps?: Icp[];
  active_icps_indexes?: number[];
  business_offers?: string[];
  active_business_offers_indexes?: number[];
  custom_fields?: string[];
  [key: string]: unknown;
}

const INDUSTRIES = Object.keys(INDUSTRY_TREE);
const BANDS = Object.keys(EMPLOYEE_BANDS);

const memorySchema = z.object({
  company: z.string(),
  business_description: z.string(),
  business_offers: z.array(z.string()),
  icps: z.array(
    z.object({
      name: z.string(),
      problems_solved: z.array(z.string()),
      benefits: z.array(z.string()),
      usp: z.string(),
      customer_goals: z.array(z.string()),
      job_titles: z.array(z.string()),
      industries: z.array(z.string()),
      company_sizes: z.array(z.string()),
    }),
  ),
});

const MEMORY_SYSTEM = `You read about a company and write the brief a sales development rep needs before prospecting.

Rules:
- Use only what the source says or clearly implies. Never invent customers, numbers, awards or results.
- business_description: two or three plain sentences on what they sell and to whom.
- business_offers: concrete things a rep can offer in a cold email (a demo, an audit, a trial), only if supported.
- icps: one to three distinct ideal customer profiles. job_titles are titles of the people to email (for
  example "Head of Sales"). industries and company_sizes must come from the allowed lists; leave them empty
  when the source gives no basis.`;

export type MemorySource = { type: "website" | "pitch_deck"; input: string } | { type: "pdf"; data: string; name?: string };

/** Learns the business from a website (fetched here), pasted pitch text, or a PDF Claude reads directly. */
export async function extractMemory(workspaceId: string, source: MemorySource): Promise<SalesMemory> {
  const allowed = `<allowed_industries>${INDUSTRIES.join(" | ")}</allowed_industries>\n<allowed_company_sizes>${BANDS.join(" | ")}</allowed_company_sizes>`;
  let content: Anthropic.Beta.BetaMessageParam["content"];
  if (source.type === "pdf") {
    content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: source.data }, ...(source.name ? { title: source.name.slice(0, 200) } : {}) },
      { type: "text", text: `${allowed}\nThe attached document describes the business. Write the brief from it.` },
    ];
  } else {
    const text = source.type === "website" ? await pageText(source.input, 14_000) : source.input.slice(0, 30_000);
    if (text.trim().length < 80) throw Object.assign(new Error("Not enough readable text to learn the business from"), { code: "scrape_site_not_supported" });
    content = `${allowed}\n<source type="${source.type}"${source.type === "website" ? ` url="${source.input}"` : ""}>\n${text}\n</source>`;
  }
  const out = await structured({
    workspaceId,
    feature: "ai_sales_agent_setup",
    effort: "medium",
    maxTokens: 6_000,
    system: cachedSystem(MEMORY_SYSTEM),
    messages: [{ role: "user", content }],
    schema: memorySchema,
  });
  const icps: Icp[] = out.icps.slice(0, 3).map((i) => ({
    name: i.name.trim() || "Primary buyers",
    problems_solved: i.problems_solved.slice(0, 6),
    benefits: i.benefits.slice(0, 6),
    usp: i.usp,
    customer_goals: i.customer_goals.slice(0, 6),
    success_stories: "",
    keywords: { include: null, exclude: null },
    company_size: i.company_sizes.filter((s) => BANDS.includes(s)),
    industry: i.industries.filter((s) => INDUSTRIES.includes(s)),
    job_title: { include: i.job_titles.slice(0, 8), exclude: [] },
  }));
  return {
    company: out.company.trim(),
    business_description: out.business_description.trim(),
    business_offers: out.business_offers.slice(0, 5),
    active_business_offers_indexes: out.business_offers.length ? [0] : [],
    icps,
    active_icps_indexes: icps.map((_, i) => i),
  };
}

const sequenceSchema = z.object({
  campaign_name: z.string(),
  steps: z.array(z.object({ delay_days: z.number(), subject: z.string(), body: z.string() })),
  reasoning: z.string(),
});

const SEQUENCE_SYSTEM = `You write short cold email sequences for a sales development rep.

Rules:
- Three emails. The first opens with the {{personalization}} variable on its own line, then one or two short
  paragraphs on the prospect's likely problem and one concrete offer. Follow-ups are two to four sentences
  and add something new each time.
- delay_days: days to wait after the previous email before this one (0 for the first email).
- Use only facts from the brief. No invented numbers, customers or claims. No spam phrases ("act now",
  "free", "guarantee"), no exclamation marks, at most one link.
- Variables available: {{firstName}}, {{companyName}}, {{personalization}}, {{sendingAccountFirstName}}.
- Bodies are plain text paragraphs separated by blank lines. Subjects are 2-5 words, lowercase except names.
- Sign off with {{sendingAccountFirstName}}.`;

export interface DraftedSequence {
  name: string;
  /** `delay` is the wait in days after this email before the next one, as campaign steps store it. */
  steps: Array<{ delay: number; subject: string; body: string }>;
  reasoning: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toHtml = (text: string) =>
  text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

export async function writeSequence(workspaceId: string, brief: { memory: SalesMemory; icp: Icp; guidance: string[]; agentName: string; optOutLine: string | null; extraContext?: string }): Promise<DraftedSequence> {
  const m = brief.memory;
  const offers = (m.active_business_offers_indexes?.length ? m.active_business_offers_indexes.map((i) => m.business_offers?.[i]) : m.business_offers)?.filter(Boolean) ?? [];
  const out = await structured({
    workspaceId,
    feature: "ai_sales_agent_sequence",
    effort: "medium",
    maxTokens: 5_000,
    system: cachedSystem(SEQUENCE_SYSTEM),
    messages: [
      {
        role: "user",
        content: [
          `<company>${m.company ?? ""}</company>`,
          `<business>${m.business_description ?? ""}</business>`,
          offers.length ? `<offers>\n${offers.map((o) => `- ${o}`).join("\n")}\n</offers>` : "",
          `<icp>\n${JSON.stringify(brief.icp, null, 2)}\n</icp>`,
          brief.guidance.length ? `<rules>\n${brief.guidance.map((g) => `- ${g}`).join("\n")}\n</rules>` : "",
          brief.extraContext ? `<performance>\n${brief.extraContext}\n</performance>` : "",
          `Write the sequence. campaign_name: "${brief.agentName} · <short ICP label>".`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    schema: sequenceSchema,
  });
  const drafted = out.steps.slice(0, 4);
  // The model gives each email's wait since the previous one; a campaign step stores the wait before the next.
  const gapBefore = (i: number) => Math.max(1, Math.min(14, Math.round(drafted[i]?.delay_days ?? 0) || 3));
  const steps = drafted.map((s, i) => ({
    delay: i + 1 < drafted.length ? gapBefore(i + 1) : 2,
    subject: s.subject.trim().slice(0, 120) || (i === 0 ? "quick question" : ""),
    body: toHtml(brief.optOutLine && i === 0 ? `${s.body.trim()}\n\n${brief.optOutLine}` : s.body.trim()),
  }));
  if (!steps.length) throw new Error("The sequence came back empty");
  return { name: out.campaign_name.trim().slice(0, 120) || `${brief.agentName} · ${brief.icp.name}`, steps, reasoning: out.reasoning.trim() };
}

const researchSchema = z.object({
  first_line: z.string(),
  used_facts: z.array(z.object({ fact: z.string(), source_url: z.string() })),
});

const RESEARCH_SYSTEM = `You research a prospect for a cold email and write one opening line.

Rules:
- The line must reference something specific and true from the research notes (what the company does, a
  recent announcement, an open role). Never invent details. If the notes are thin, write a short, honest
  line about their role and company instead.
- One sentence, under 30 words, no greeting, no flattery, no questions about their week.
- used_facts: each fact you relied on with the URL it came from (only URLs present in the notes).`;

export interface LeadResearch {
  firstLine: string;
  grounding: Array<{ field: string; citations: Array<{ url: string; title: string }> }>;
  sources: Array<{ url: string }>;
}

export async function researchLead(
  workspaceId: string,
  lead: { first_name: string | null; job_title: string | null; company_name: string | null; company_domain: string | null; news?: Array<{ title: string; url?: string; date?: string }> },
  context: { company?: string; business?: string },
): Promise<LeadResearch> {
  const sources: Array<{ url: string; text: string }> = [];
  if (lead.company_domain && !/\.(test|example|invalid|localhost)$/i.test(lead.company_domain)) {
    const url = `https://${lead.company_domain}`;
    const text = await pageText(url, 5_000).catch(() => "");
    if (text) sources.push({ url, text });
  }
  for (const n of (lead.news ?? []).slice(0, 3)) sources.push({ url: n.url ?? `https://${lead.company_domain ?? "news"}`, text: `${n.date ?? ""} ${n.title}` });
  const notes = sources.length ? sources.map((s) => `<note url="${s.url}">\n${s.text}\n</note>`).join("\n") : "(no external notes)";
  const out = await structured({
    workspaceId,
    feature: "ai_sales_agent_research",
    effort: "low",
    maxTokens: 1_500,
    system: cachedSystem(RESEARCH_SYSTEM),
    messages: [
      {
        role: "user",
        content: `<seller>${context.company ?? ""}: ${context.business ?? ""}</seller>\n<prospect>${JSON.stringify({ first_name: lead.first_name, job_title: lead.job_title, company: lead.company_name, domain: lead.company_domain })}</prospect>\n<research>\n${notes}\n</research>`,
      },
    ],
    schema: researchSchema,
  });
  const known = new Set(sources.map((s) => s.url));
  const cited = out.used_facts.filter((f) => known.has(f.source_url));
  return {
    firstLine: out.first_line.trim().replace(/\s+/g, " ").slice(0, 300),
    grounding: cited.length ? [{ field: "personalization", citations: cited.map((f) => ({ url: f.source_url, title: f.fact.slice(0, 160) })) }] : [],
    sources: sources.map((s) => ({ url: s.url })),
  };
}

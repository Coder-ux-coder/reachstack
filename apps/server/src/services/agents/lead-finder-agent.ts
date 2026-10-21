// AI Lead Finder Agent: keeps a campaign stocked. When the campaign's active leads drop below a threshold it
// searches the Lead Finder dataset, adds people the campaign has not seen (revealing them costs credits on
// metered installs), optionally fills AI columns before releasing them to the sequence, and decides what to do
// when the audience runs dry: pause, switch to a fallback audience, or broaden the filters step by step.
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  CREDIT_COSTS,
  EMPLOYEE_BANDS,
  FUNDING_TYPES,
  INDUSTRY_TREE,
  LF_DEPARTMENTS,
  LF_LEVELS,
  LF_NEWS_TYPES,
  LeadStatus,
  REVENUE_BANDS,
} from "@reachstack/shared";
import { z } from "zod";
import { db, schema } from "../../db/client";
import { inUse } from "../live-workspaces";
import { badRequest } from "../../http/errors";
import { iso } from "../../lib/time";
import { aiAvailable, aiErrorMessage } from "../ai";
import { chargeCredits, refundCredits, workspaceLimits } from "../billing-limits";
import { on } from "../bus";
import { addLeads, uncontactable, type LeadRow } from "../leads";
import { aiColumnValue } from "../lead-finder/enrichment";
import { leadInput, payableInFull, unlockPeople } from "../lead-finder/imports";
import { personLocation, searchFiltersSchema, searchPeopleAfter, type PersonResult, type SearchFilters } from "../lead-finder/search";
import { AgentStatus, AgentType, logAgentEvent, type AgentRow } from "./common";

export interface AiStep {
  model_version?: string;
  prompt: string;
  input_columns?: string[];
  use_instantly_account?: boolean;
  overwrite?: boolean;
  order?: number;
  required?: boolean;
  verb?: string;
  object?: string;
  fallback?: string;
  skip_if_input_empty?: boolean;
}

export interface LeadFinderAgentPayload {
  campaign_id: string;
  campaign_name?: string;
  search_filters: SearchFilters;
  min_active_leads: number;
  on_exhaustion: "pause" | "fallback" | "broaden";
  fallback_search_filters?: SearchFilters | null;
  show_one_lead_per_company?: boolean;
  ai_enrichment?: Record<string, AiStep> | null;
  ai_enrichment_workflow?: string | null;
  source?: string;
  // Bookkeeping, not part of the API shape.
  audience?: "primary" | "fallback" | "broadened";
  broadened_filters?: SearchFilters | null;
  broadened_removed?: string[];
  next_check_at?: string;
}

export const LFA_EVENTS = [
  "top_up_started",
  "top_up_completed",
  "top_up_failed",
  "search_exhausted",
  "fallback_activated",
  "fallback_exhausted",
  "paused_exhausted",
  "paused_insufficient_credits",
  "paused_ai_failed",
  "campaign_not_found",
  "agent_paused",
  "agent_resumed",
] as const;

const CHECK_EVERY_MS = 5 * 60_000;
const MAX_PER_TOP_UP = 1_000;
const MAX_SCANNED = 20_000;
const AE = schema.aiAgentEvents;
const L = schema.leads;

export const lfaPayload = (a: AgentRow) => (a.payload ?? {}) as unknown as LeadFinderAgentPayload;

export function serializeLeadFinderAgent(a: AgentRow) {
  const p = lfaPayload(a);
  return {
    id: a.id,
    organization_id: a.workspaceId,
    name: a.name,
    payload: {
      campaign_id: p.campaign_id,
      campaign_name: p.campaign_name ?? null,
      search_filters: p.search_filters ?? {},
      min_active_leads: p.min_active_leads,
      on_exhaustion: p.on_exhaustion,
      fallback_search_filters: p.fallback_search_filters ?? null,
      show_one_lead_per_company: p.show_one_lead_per_company !== false,
      ai_enrichment: p.ai_enrichment ?? null,
      ai_enrichment_workflow: p.ai_enrichment_workflow ?? null,
      // Which audience the agent is drawing from right now (primary, fallback, or broadened filters).
      active_audience: p.audience ?? "primary",
      broadened_removed: p.broadened_removed ?? [],
    },
    type: a.type,
    timestamp_created: iso(a.createdAt),
    timestamp_updated: iso(a.updatedAt),
    status: a.status,
    is_auto_created: a.isAutoCreated ?? false,
    created_by: a.createdBy,
    description: a.description,
  };
}

export function serializeLfaEvent(e: typeof AE.$inferSelect) {
  const { leads_added, campaign_active_leads_after, reason, ...rest } = e.payload as Record<string, unknown>;
  return {
    id: e.id,
    agent_id: e.agentId,
    organization_id: e.workspaceId,
    timestamp_created: iso(e.createdAt),
    event_type: e.eventType,
    payload: {
      ...(leads_added !== undefined ? { leads_added } : {}),
      ...(campaign_active_leads_after !== undefined ? { campaign_active_leads_after } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...rest,
    },
  };
}

// ---------- Validation ----------

const strictFilters = searchFiltersSchema.strict();
const ALLOWED: Record<string, readonly string[]> = {
  department: LF_DEPARTMENTS,
  level: LF_LEVELS,
  revenue: REVENUE_BANDS,
  news: LF_NEWS_TYPES,
  funding_type: FUNDING_TYPES,
  fundingType: FUNDING_TYPES,
};

/** Parses search filters the way the agent endpoints require: unknown keys and unknown enum values rejected. */
export async function validateAgentFilters(workspaceId: string, raw: unknown, field: string): Promise<SearchFilters> {
  const r = strictFilters.safeParse(raw ?? {});
  if (!r.success) {
    const issue = r.error.issues[0]!;
    const keys = (issue as { keys?: string[] }).keys;
    throw badRequest(`${field}: ${keys?.length ? `unknown key ${keys.map((k) => `"${k}"`).join(", ")}` : `${issue.path.join(".")}: ${issue.message}`}`);
  }
  const f = r.data;
  for (const [key, allowed] of Object.entries(ALLOWED)) {
    const bad = ((f as Record<string, unknown>)[key] as string[] | undefined)?.find((v) => !allowed.includes(v));
    if (bad) throw badRequest(`${field}.${key}: "${bad}" is not a valid value`);
  }
  const bands = (f.employeeCount ?? []).filter((v): v is string => typeof v === "string");
  const badBand = bands.find((b) => !(b in EMPLOYEE_BANDS));
  if (badBand) throw badRequest(`${field}.employeeCount: "${badBand}" is not a valid value`);
  const industries = [...(f.industry?.include ?? []), ...(f.industry?.exclude ?? [])];
  const badIndustry = industries.find((i) => !(i in INDUSTRY_TREE));
  if (badIndustry) throw badRequest(`${field}.industry: "${badIndustry}" is not a valid value`);
  const subs = new Set(Object.values(INDUSTRY_TREE).flat());
  const badSub = [...(f.subIndustry?.include ?? []), ...(f.subIndustry?.exclude ?? [])].find((s) => !subs.has(s));
  if (badSub) throw badRequest(`${field}.subIndustry: "${badSub}" is not a valid value`);
  if (f.jobListing?.length && f.jobListingFilter?.length) throw badRequest(`${field}: use jobListing or jobListingFilter, not both`);
  if (f.company_list_id) {
    const CL = schema.companyLists;
    const [list] = await db.select({ status: CL.status }).from(CL).where(and(eq(CL.id, f.company_list_id), eq(CL.workspaceId, workspaceId))).limit(1);
    if (!list) throw badRequest(`${field}.company_list_id: company list not found`);
    if (list.status !== "COMPLETED") throw badRequest(`${field}.company_list_id: the company list is still building`);
  }
  return f;
}

const aiStepSchema = z
  .object({
    model_version: z.string().max(100),
    prompt: z.string().trim().min(1).max(10_000),
    input_columns: z.array(z.string()).optional(),
    use_instantly_account: z.boolean().optional(),
    overwrite: z.boolean().optional(),
    order: z.number().optional(),
    required: z.boolean().optional(),
    verb: z.string().max(200).optional(),
    object: z.string().max(200).optional(),
    fallback: z.string().max(5_000).optional(),
    skip_if_input_empty: z.boolean().optional(),
  })
  .strict();

/** AI columns keyed by output column. Inputs and "required" are derived from the prompt and the fallback. */
export function validateAiEnrichment(raw: unknown): Record<string, AiStep> | null {
  if (raw === null || raw === undefined) return null;
  const r = z.record(aiStepSchema).safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw badRequest(`ai_enrichment.${issue.path.join(".")}: ${issue.message}`);
  }
  const entries = Object.entries(r.data);
  if (entries.length > 10) throw badRequest("ai_enrichment: at most 10 columns");
  const out: Record<string, AiStep> = {};
  entries.forEach(([column, step], i) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(column)) throw badRequest(`ai_enrichment: "${column}" is not a valid column name (letters, digits, underscores)`);
    const inputs = [...new Set([...step.prompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))];
    out[column] = { ...step, input_columns: inputs, required: step.fallback === undefined || step.fallback === "", order: step.order ?? i };
  });
  return out;
}

// ---------- Top-ups ----------

const activeLeadCount = async (campaignId: string) =>
  Number((await db.select({ n: sql<number>`count(*)` }).from(L).where(and(eq(L.campaignId, campaignId), eq(L.status, LeadStatus.ACTIVE))))[0]?.n ?? 0);

/** Held leads tried again after a resume, at most. */
const HELD_RETRY_MAX = 100;

/** Top up to a little above the threshold so the agent does not run on every lead the campaign finishes. */
const topUpTarget = (min: number) => Math.max(min + 5, Math.ceil(min * 1.25));

interface AddResult {
  added: number;
  /** People passed over because a "skip if an input is empty" AI step could not use them. */
  skippedEmpty: number;
  created: string[];
  exhausted: boolean;
  outOfCredits: boolean;
}

/** Lead fields a dataset person already has, by the names prompts use. */
const PERSON_FIELDS: Record<string, (p: PersonResult) => string | null> = {
  first_name: (p) => p.first_name,
  firstName: (p) => p.first_name,
  last_name: (p) => p.last_name,
  lastName: (p) => p.last_name,
  job_title: (p) => p.title,
  jobTitle: (p) => p.title,
  company_name: (p) => p.company_name,
  companyName: (p) => p.company_name,
  company_domain: (p) => p.company_domain,
  companyDomain: (p) => p.company_domain,
  website: (p) => p.company_domain,
  linkedin_url: (p) => p.linkedin_url,
  phone: (p) => p.phone,
  location: (p) => personLocation(p) || null,
  email: (p) => p.email,
  seniority: (p) => p.seniority,
  department: (p) => p.department,
  industry: (p) => p.industry,
};

/** False when a "skip if an input is empty" step would discard this person (only standard fields can be known now). */
function passesInputChecks(person: PersonResult, steps: Record<string, AiStep> | null | undefined): boolean {
  for (const step of Object.values(steps ?? {})) {
    if (!step.skip_if_input_empty) continue;
    for (const input of step.input_columns ?? []) {
      const get = PERSON_FIELDS[input];
      if (get && !(get(person) ?? "").trim()) return false;
    }
  }
  return true;
}

/** Adds up to `need` new people from a search to the campaign. */
async function addFromSearch(a: AgentRow, filters: SearchFilters, need: number, companies: Set<string>): Promise<AddResult> {
  const p = lfaPayload(a);
  const ws = a.workspaceId;
  const onePerCompany = p.show_one_lead_per_company !== false;
  const hold = !!p.ai_enrichment && Object.keys(p.ai_enrichment).length > 0;
  const metered = !(await workspaceLimits(ws)).self_hosted;
  const unit = CREDIT_COSTS.work_email_enrichment;
  let after: string | null = null;
  let scanned = 0;
  const out: AddResult = { added: 0, skippedEmpty: 0, created: [], exhausted: false, outOfCredits: false };
  while (out.added < need) {
    if (scanned >= MAX_SCANNED) {
      out.exhausted = true;
      break;
    }
    // Paused (or deleted) while the check runs: it stops before the next page.
    if (!(await stillActive(a.id))) break;
    // Each page starts after the last person seen: the people added on the way drop out of a search that skips leads
    // you already have, so counting rows to skip would jump past matches.
    const { people: page, next } = await searchPeopleAfter(ws, filters, 500, after);
    if (!page.length) {
      out.exhausted = true;
      break;
    }
    after = next;
    scanned += page.length;
    const inCampaign = new Set(
      (
        await db
          .select({ pid: sql<string>`json_extract(${L.payload}, '$.lf_person_id')`, email: L.email })
          .from(L)
          .where(
            and(
              eq(L.campaignId, p.campaign_id),
              sql`(json_extract(${L.payload}, '$.lf_person_id') in (${sql.join(page.map((x) => sql`${x.id}`), sql`, `)}) or ${L.email} in (${sql.join(page.map((x) => sql`${x.email ?? ""}`), sql`, `)}))`,
            ),
          )
      ).flatMap((r) => [r.pid, r.email].filter(Boolean) as string[]),
    );
    // People the campaign would turn away (blocked, unsubscribed, bounced, or already a lead here when those are
    // skipped) aren't revealed or paid for.
    const emails = page.map((x) => (x.email ?? "").toLowerCase()).filter(Boolean);
    const blocked = await uncontactable(ws, emails, p.campaign_id);
    const owned = new Set<string>();
    if (filters.skip_owned_leads && emails.length) {
      for (const r of await db.select({ email: L.email }).from(L).where(and(eq(L.workspaceId, ws), inArray(L.email, emails)))) if (r.email) owned.add(r.email);
    }
    const picked = [];
    for (const person of page) {
      const email = (person.email ?? "").toLowerCase();
      if (!email || inCampaign.has(person.id) || inCampaign.has(email) || blocked.has(email) || owned.has(email)) continue;
      if (!passesInputChecks(person, p.ai_enrichment)) {
        out.skippedEmpty++; // would be skipped anyway: don't pay to reveal it
        continue;
      }
      const company = person.company_id ?? person.company_domain ?? person.company_name ?? "";
      if (onePerCompany && company && companies.has(company)) continue;
      picked.push(person);
      if (company) companies.add(company);
      if (out.added + picked.length >= need) break;
    }
    if (picked.length) {
      // Only people it can pay for in full (the reveal and the address): a reveal is never paid for without its address.
      const payable = metered ? await payableInFull(ws, picked) : picked;
      if (payable.length < picked.length) out.outOfCredits = true;
      const unlocked = payable.length ? await unlockPeople(ws, null, payable, "ai_agent:lead_finder") : { allowed: [], outOfCredits: false };
      if (unlocked.outOfCredits) out.outOfCredits = true;
      let people = unlocked.allowed;
      if (people.length && metered && !(await chargeCredits(ws, people.length * unit, "ai_agent:lead_finder:email", { refId: a.id }))) {
        people = [];
        out.outOfCredits = true;
      }
      if (people.length) {
        let r: Awaited<ReturnType<typeof addLeads>>;
        try {
          r = await addLeads({
            workspaceId: ws,
            campaignId: p.campaign_id,
            leads: people.map((x) => leadInput(x, true, { lf_agent_id: a.id })),
            uploadMethod: "lead-finder-agent",
            skipIfInWorkspace: !!filters.skip_owned_leads,
          });
        } catch (err) {
          if (metered) await refundCredits(ws, people.length * unit, "ai_agent:lead_finder:email_refund", { refId: a.id });
          throw err;
        }
        const ids = r.created_leads.map((l) => l.id);
        // Addresses are paid for only for the leads that went in (not duplicates, or over the plan's contact limit).
        if (metered && people.length > ids.length) await refundCredits(ws, (people.length - ids.length) * unit, "ai_agent:lead_finder:email_refund", { refId: a.id });
        // Leads wait (paused) until their AI columns are filled.
        if (hold && ids.length) await db.update(L).set({ status: LeadStatus.PAUSED }).where(inArray(L.id, ids));
        out.added += ids.length;
        out.created.push(...ids);
      }
    }
    if (out.outOfCredits) break;
    if (page.length < 500) {
      out.exhausted = out.added < need;
      break;
    }
  }
  return out;
}

/**
 * Fills the AI columns in order; leads whose required steps all succeed are released to the sequence. Held leads
 * tried again keep the columns they already have.
 */
async function fillAiColumns(a: AgentRow, leadIds: string[]): Promise<{ released: number; held: number; skipped: number; reason: string | null; outOfCredits: boolean }> {
  const steps = Object.entries(lfaPayload(a).ai_enrichment ?? {}).sort(([, x], [, y]) => (x.order ?? 0) - (y.order ?? 0));
  const counts = { released: 0, held: 0, skipped: 0, reason: null as string | null, outOfCredits: false };
  if (!leadIds.length) return counts;
  const leads = await db.select().from(L).where(inArray(L.id, leadIds));
  for (const lead of leads) {
    let current: LeadRow = lead;
    let outcome: "release" | "hold" | "skip" = "release";
    let holdReason: string | null = null;
    for (const [column, step] of steps) {
      if (String((current.payload ?? {})[column] ?? "").trim()) continue;
      const inputs = step.input_columns ?? [];
      const values = inputs.map((k) => {
        const v = (current.payload ?? {})[k] ?? (current as unknown as Record<string, unknown>)[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
        return v === null || v === undefined ? "" : String(v);
      });
      if (step.skip_if_input_empty && values.some((v) => !v.trim())) {
        outcome = "skip";
        break;
      }
      let value: string | null = null;
      if (!(await chargeCredits(a.workspaceId, CREDIT_COSTS.ai_enrichment, "ai_agent:lead_finder:ai", { refId: a.id }))) {
        counts.outOfCredits = true;
        holdReason = `${column}: not enough credits.`;
      } else {
        try {
          value = (await aiColumnValue(current, step.prompt, inputs.length ? inputs : undefined)).trim() || null;
        } catch (err) {
          // No answer came back: the credit is given back.
          await refundCredits(a.workspaceId, CREDIT_COSTS.ai_enrichment, "ai_agent:lead_finder:ai_refund", { refId: a.id });
          holdReason = `${column}: ${aiErrorMessage(err)}`;
        }
      }
      if (!value && step.fallback) value = step.fallback;
      if (!value) {
        outcome = "hold";
        holdReason ??= `${column}: the AI had no answer and the column has no fallback text.`;
        break;
      }
      const payload = { ...(current.payload ?? {}), [column]: value };
      await db.update(L).set({ payload }).where(eq(L.id, current.id));
      current = { ...current, payload };
    }
    const { lf_agent_hold: _held, ...payload } = current.payload ?? {};
    if (outcome === "release") {
      await db.update(L).set({ status: LeadStatus.ACTIVE, payload }).where(eq(L.id, lead.id));
      counts.released++;
    } else if (outcome === "skip") {
      await db.update(L).set({ status: LeadStatus.SKIPPED, payload }).where(eq(L.id, lead.id));
      counts.skipped++;
    } else {
      await db.update(L).set({ payload: { ...payload, lf_agent_hold: holdReason } }).where(eq(L.id, lead.id));
      counts.held++;
      counts.reason ??= holdReason;
    }
  }
  return counts;
}

/** Filters to relax, in order, when broadening; the core audience (place, industry, company boundary) stays. */
const BROADEN_ORDER: Array<[keyof SearchFilters, string]> = [
  ["signals", "signals"],
  ["news", "company news"],
  ["jobListing", "job listings"],
  ["jobListingFilter", "job listings"],
  ["technologies", "technologies"],
  ["keyword_filter", "keywords"],
  ["revenue", "revenue"],
  ["funding_type", "funding"],
  ["fundingType", "funding"],
  ["employeeCount", "company size"],
  ["subIndustry", "sub-industry"],
  ["title", "job titles"],
  ["level", "seniority"],
  ["department", "department"],
];

function broaden(f: SearchFilters): { filters: SearchFilters; removed: string } | null {
  for (const [key, label] of BROADEN_ORDER) {
    const v = f[key];
    const empty = v === undefined || v === null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.values(v as object).some((x) => (Array.isArray(x) ? x.length : !!x)));
    if (empty) continue;
    // Exact title matching relaxes to "contains" before titles are dropped.
    if (key === "title" && f.title?.include?.length && f.title.includeMode !== "CONTAINS") return { filters: { ...f, title: { ...f.title, includeMode: "CONTAINS" } }, removed: "exact job title matching" };
    const next = { ...f };
    delete next[key];
    return { filters: next, removed: label };
  }
  return null;
}

/** The settings a person edits: not what checks note on the agent (the next check, the audience in use, the campaign's name). */
function settingsKey(payload: Record<string, unknown> | null): string {
  const { next_check_at: _next, audience: _audience, broadened_filters: _broadened, broadened_removed: _removed, campaign_name: _name, ...rest } = payload ?? {};
  return JSON.stringify(rest);
}

/**
 * Changes the agent's status, and notes `payload` on it, as it is now. When someone paused or edited it while the
 * check ran (`settings` is what it had when the check began), theirs stands: the next check works from it.
 */
async function setStatus(a: AgentRow, settings: string, status: number, payload?: Partial<LeadFinderAgentPayload>) {
  const [fresh] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, a.id)).limit(1);
  if (!fresh || fresh.status !== AgentStatus.ACTIVE || settingsKey(fresh.payload) !== settings) return;
  await db
    .update(schema.aiAgents)
    .set({ status, ...(payload ? { payload: { ...(fresh.payload ?? {}), ...payload } as Record<string, unknown> } : {}) })
    .where(and(eq(schema.aiAgents.id, a.id), eq(schema.aiAgents.status, AgentStatus.ACTIVE)));
}

async function stillActive(agentId: string): Promise<boolean> {
  const [row] = await db.select({ status: schema.aiAgents.status }).from(schema.aiAgents).where(eq(schema.aiAgents.id, agentId)).limit(1);
  return row?.status === AgentStatus.ACTIVE;
}

const running = new Set<string>();

/**
 * One check: tops the campaign up when it is below the threshold. After a resume (or Check now) the leads held for
 * their AI columns get another try first: the prompt or the AI key may be fixed now.
 */
export async function checkLeadFinderAgent(agentId: string, opts: { force?: boolean; retryHeld?: boolean } = {}): Promise<void> {
  if (running.has(agentId)) return;
  running.add(agentId);
  try {
    const [a] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agentId)).limit(1);
    if (!a || a.status !== AgentStatus.ACTIVE) return;
    let p = lfaPayload(a);
    const nextCheck = new Date(Date.now() + CHECK_EVERY_MS).toISOString();
    await db.update(schema.aiAgents).set({ lastRunAt: new Date(), payload: { ...a.payload, next_check_at: nextCheck } }).where(eq(schema.aiAgents.id, a.id));
    a.payload = { ...a.payload, next_check_at: nextCheck };
    // What a person had set when the check began: a pause or an edit made while it runs stands (see setStatus).
    const settings = settingsKey(a.payload);
    const [campaign] = await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.id, p.campaign_id), eq(schema.campaigns.workspaceId, a.workspaceId))).limit(1);
    if (!campaign) {
      await logAgentEvent(a.workspaceId, a.id, "campaign_not_found", { reason: "The campaign was deleted" });
      await setStatus(a, settings, AgentStatus.ERROR);
      return;
    }
    const hasAi = !!p.ai_enrichment && Object.keys(p.ai_enrichment).length > 0;
    if (hasAi && opts.retryHeld && (await aiAvailable(a.workspaceId))) {
      const held = await db
        .select({ id: L.id })
        .from(L)
        .where(
          and(
            eq(L.campaignId, campaign.id),
            eq(L.status, LeadStatus.PAUSED),
            sql`json_extract(${L.payload}, '$.lf_agent_id') = ${a.id}`,
            sql`json_extract(${L.payload}, '$.lf_agent_hold') is not null`,
          ),
        )
        .limit(HELD_RETRY_MAX);
      if (held.length) await fillAiColumns(a, held.map((h) => h.id));
    }
    const active = await activeLeadCount(campaign.id);
    if (active >= p.min_active_leads && !opts.force) return;
    if (hasAi && !(await aiAvailable(a.workspaceId))) {
      await logAgentEvent(a.workspaceId, a.id, "top_up_failed", { reason: "AI enrichment needs an Anthropic API key (Settings → Integrations & API → AI)", leads_added: 0, campaign_active_leads_after: active });
      return;
    }
    const target = topUpTarget(p.min_active_leads);
    const need = Math.min(MAX_PER_TOP_UP, Math.max(0, target - active));
    if (!need) return;
    await logAgentEvent(a.workspaceId, a.id, "top_up_started", { campaign_active_leads_before: active, target });
    const companies = new Set<string>();
    let added = 0;
    const created: string[] = [];
    let outOfCredits = false;
    let exhausted = false;
    // Draw from the current audience; on exhaustion follow the agent's rule until satisfied or out of options.
    for (let guard = 0; guard < 20 && added < need; guard++) {
      const audience = p.audience ?? "primary";
      const filters = audience === "fallback" ? (p.fallback_search_filters ?? {}) : audience === "broadened" ? (p.broadened_filters ?? p.search_filters) : p.search_filters;
      const r = await addFromSearch(a, filters, need - added, companies);
      added += r.added;
      created.push(...r.created);
      if (r.outOfCredits) {
        outOfCredits = true;
        break;
      }
      if (!r.exhausted) break;
      const why = r.skippedEmpty ? ` (${r.skippedEmpty} passed over because an AI step's input field was empty)` : "";
      await logAgentEvent(a.workspaceId, a.id, "search_exhausted", { audience, leads_added: r.added, reason: `No more new people match the audience${why}` });
      if (p.on_exhaustion === "fallback" && audience === "primary" && p.fallback_search_filters) {
        p = { ...p, audience: "fallback" };
        await setStatus(a, settings, AgentStatus.ACTIVE, { audience: "fallback" });
        await logAgentEvent(a.workspaceId, a.id, "fallback_activated", { reason: "Switched to the fallback audience" });
        continue;
      }
      if (p.on_exhaustion === "broaden") {
        const next = broaden(audience === "broadened" ? (p.broadened_filters ?? p.search_filters) : p.search_filters);
        if (next) {
          const removed = [...(p.broadened_removed ?? []), next.removed];
          p = { ...p, audience: "broadened", broadened_filters: next.filters, broadened_removed: removed };
          await setStatus(a, settings, AgentStatus.ACTIVE, { audience: "broadened", broadened_filters: next.filters, broadened_removed: removed });
          await logAgentEvent(a.workspaceId, a.id, "fallback_activated", { reason: `Broadened the audience: dropped ${next.removed}` });
          continue;
        }
      }
      if (p.on_exhaustion === "fallback" && audience === "fallback") await logAgentEvent(a.workspaceId, a.id, "fallback_exhausted", { reason: "The fallback audience has no more new people" });
      exhausted = true;
      break;
    }
    let held = 0;
    let aiFailed: string | null = null;
    if (hasAi && created.length) {
      const fill = await fillAiColumns(a, created);
      held = fill.held;
      added -= fill.skipped;
      if (fill.outOfCredits) outOfCredits = true;
      // Not one new lead could be released: every later top-up would only add (and pay for) more held leads.
      else if (fill.held && !fill.released) aiFailed = fill.reason;
    }
    const after = await activeLeadCount(campaign.id);
    if (added > 0 || !outOfCredits) {
      await logAgentEvent(a.workspaceId, a.id, "top_up_completed", { leads_added: added, campaign_active_leads_after: after, ...(held ? { leads_held: held } : {}) });
    }
    if (exhausted) {
      await setStatus(a, settings, AgentStatus.PAUSED);
      await logAgentEvent(a.workspaceId, a.id, "paused_exhausted", { campaign_active_leads_after: after, reason: "Paused: the audience ran out of new people. Widen the filters and resume." });
    }
    if (outOfCredits) {
      await setStatus(a, settings, AgentStatus.PAUSED);
      await logAgentEvent(a.workspaceId, a.id, "paused_insufficient_credits", { leads_added: added, campaign_active_leads_after: after, reason: "Paused: not enough credits to add more leads" });
    }
    if (aiFailed && !exhausted && !outOfCredits) {
      await setStatus(a, settings, AgentStatus.PAUSED);
      await logAgentEvent(a.workspaceId, a.id, "paused_ai_failed", {
        leads_held: held,
        campaign_active_leads_after: after,
        reason: `Paused: no new lead got its AI columns. ${aiFailed} Fix the prompt or the AI key, then resume: the held leads get another try.`,
      });
    }
    if (p.campaign_name !== campaign.name) {
      const [fresh] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, a.id)).limit(1);
      if (fresh) await db.update(schema.aiAgents).set({ payload: { ...fresh.payload, campaign_name: campaign.name } }).where(eq(schema.aiAgents.id, a.id));
    }
  } catch (err) {
    console.error(`[lead-finder-agent] ${agentId}:`, err);
    const [a] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agentId)).limit(1);
    if (a) await logAgentEvent(a.workspaceId, a.id, "top_up_failed", { reason: (err as Error).message?.slice(0, 300) ?? "Unexpected error", leads_added: 0 });
  } finally {
    running.delete(agentId);
  }
}

export async function runLeadFinderAgents() {
  const agents = await db
    .select()
    .from(schema.aiAgents)
    .where(and(eq(schema.aiAgents.type, AgentType.LEAD_FINDER), eq(schema.aiAgents.status, AgentStatus.ACTIVE), await inUse(schema.aiAgents.workspaceId)));
  const now = Date.now();
  for (const a of agents) {
    const due = Date.parse(lfaPayload(a).next_check_at ?? "") || 0;
    if (due <= now) await checkLeadFinderAgent(a.id);
  }
}

export async function leadFinderAgentStats(agentId: string) {
  const rows = await db
    .select({ type: AE.eventType, n: sql<number>`count(*)`, added: sql<number>`coalesce(sum(json_extract(${AE.payload}, '$.leads_added')), 0)` })
    .from(AE)
    .where(and(eq(AE.agentId, agentId), inArray(AE.eventType, ["top_up_completed", "top_up_failed"])))
    .groupBy(AE.eventType);
  const completed = rows.find((r) => r.type === "top_up_completed");
  return { leads_added_total: Number(completed?.added ?? 0), top_ups_completed: Number(completed?.n ?? 0), top_ups_failed: Number(rows.find((r) => r.type === "top_up_failed")?.n ?? 0) };
}

export async function leadFinderAgentActivities(agentId: string, limit: number, startingAfter?: string) {
  const conds = [eq(AE.agentId, agentId), inArray(AE.eventType, [...LFA_EVENTS])];
  if (startingAfter) conds.push(lt(AE.id, startingAfter));
  const rows = await db.select().from(AE).where(and(...conds)).orderBy(desc(AE.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(serializeLfaEvent), ...(rows.length > limit ? { next_starting_after: page[page.length - 1]!.id } : {}) };
}

// A deleted campaign stops its agent right away rather than at the next check.
on("campaign_status_changed", async (ev) => {
  if (ev.data.status !== "deleted") return;
  const agents = await db
    .select()
    .from(schema.aiAgents)
    .where(and(eq(schema.aiAgents.workspaceId, ev.workspaceId), eq(schema.aiAgents.type, AgentType.LEAD_FINDER), sql`json_extract(${schema.aiAgents.payload}, '$.campaign_id') = ${String(ev.data.campaign_id)}`));
  for (const a of agents) {
    await logAgentEvent(a.workspaceId, a.id, "campaign_not_found", { reason: "The campaign was deleted" });
    await db.update(schema.aiAgents).set({ status: AgentStatus.ERROR }).where(eq(schema.aiAgents.id, a.id));
  }
});

// AI Sales Agent: runs outbound for one offer. It learns the business (website, pitch text or the workspace's
// business details), writes a campaign per ideal customer profile, finds and researches leads in the Lead Finder
// dataset, recommends them into the campaigns, answers replies, and reviews performance. In copilot mode every
// proposed action waits for approval; in autopilot it carries them out itself.
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { CREDIT_COSTS, CampaignStatus, EMPLOYEE_BANDS, INDUSTRY_TREE, LeadStatus, isTaskStep, type SequenceStep } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { inUse } from "../live-workspaces";
import { config as env } from "../../env";
import { uuidv7 } from "../../lib/ids";
import { iso, DEFAULT_SCHEDULE } from "../../lib/time";
import { AiRefusalError, aiAvailable, aiErrorMessage } from "../ai";
import { chargeCredits, refundCredits, workspaceLimits } from "../billing-limits";
import { on } from "../bus";
import { aggregateMetrics, insertCampaign, launchProblems, setCampaignStatus, type CampaignRow } from "../campaigns";
import { postToSlack } from "../integrations";
import { workspaceToday } from "../workspace-clock";
import { addLeads, isBlocked, moveLeads, uncontactable, type LeadRow } from "../leads";
import { leadInput, payableInFull, unlockPeople } from "../lead-finder/imports";
import { peopleByIds, personLocation, searchPeople, type PersonResult, type SearchFilters } from "../lead-finder/search";
import { recordSequenceVersion } from "../sequence-versions";
import { composeAndSend, replyRecipients } from "../unibox";
import { cleanReplyHtml, conversationMovedOn, type DiscardReason } from "./common";
import { recipientRefusal } from "./recipients";
import { draftReply, threadMessages } from "./reply-engine";
import { extractMemory, researchLead, writeSequence, type Icp, type SalesMemory } from "./sales-ai";

const S = schema.aiSalesAgents;
const ACT = schema.aiSalesAgentActivities;
const L = schema.leads;
export type SalesAgentRow = typeof S.$inferSelect;
export type SalesActivityRow = typeof ACT.$inferSelect;

export const ACTION_TYPES = [
  "create_campaign",
  "edit_campaign",
  "stop_campaign",
  "pause_campaign",
  "enrich_leads",
  "push_lead",
  "recommend_lead",
  "warning",
  "initial_setup_scrape",
  "initial_setup_campaigns",
  "initial_setup_enrich",
  "email_sent",
  "lead_meeting_booked",
  "lead_closed",
  "email_opened",
  "reply_received",
  "opportunity_received",
  "campaign_completed",
  "imported_leads",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ACTION_STATUSES = ["pending", "approved", "rejected", "in_progress", "completed", "failed"] as const;
export const SIGNAL_CATEGORIES = [
  "linkedin_post_company", "linkedin_post_contact", "linkedin_comment", "twitter_post_company", "twitter_post_contact", "youtube_company", "youtube_contact",
  "reddit_buying_intent", "reddit_pain_point", "reddit_churn_risk", "reddit_competitor_mention", "glassdoor_negative", "glassdoor_positive",
  "website_product_launch", "website_pricing_change", "website_expansion", "website_executive_change", "website_funding", "website_partnership",
  "website_compliance", "website_technology_adoption", "job_change", "promotion", "work_anniversary", "traffic_surge", "traffic_decline",
] as const;

/** Used when signal targeting is on and no categories were chosen: funding, leadership change, pricing change,
 * product launch, expansion and buying intent. */
export const DEFAULT_SIGNALS: string[] = ["website_funding", "website_executive_change", "website_pricing_change", "website_product_launch", "website_expansion", "reddit_buying_intent"];

/** Event activities only record what happened; they are never approved or executed. */
const EVENT_TYPES = new Set<string>(["warning", "email_opened", "reply_received", "lead_meeting_booked", "lead_closed", "opportunity_received", "campaign_completed", "imported_leads"]);

type ErrorCode =
  | "insufficient_credits"
  | "insufficient_upload_limit"
  | "no_leads_with_email"
  | "scrape_site_not_supported"
  | "campaign_operation_failed"
  | "lead_move_failed"
  | "enrichment_failed"
  | "configuration_error"
  | "master_list_missing"
  | "temporary_failure"
  | "prospecting_incomplete"
  | "internal_error";

class SdrError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SalesConfig {
  memory: SalesMemory;
  position_details?: string;
  investment_details?: string;
  research_details?: string;
  partnership_details?: string;
  enrichment_settings: { enrichment_limit_per_run: number; signal_targeting_enabled: boolean; signal_targeting_categories: string[] };
  outreach_settings: {
    campaign_schedule?: typeof DEFAULT_SCHEDULE;
    email_list: string[];
    email_tag_list: string[];
    daily_limit: number;
    stop_on_reply: boolean;
    open_tracking: boolean;
    first_email_text_only: boolean;
    prioritize_new_leads: boolean;
    match_lead_esp: boolean;
    opt_out_settings: { text_opt_out_enabled: boolean };
  };
  autonomy_settings: { autopilot_mode: boolean; auto_reply_to_responses: boolean; manual_leads_mode: boolean };
  slack_connection_id?: string | null;
  /**
   * Bookkeeping: the profile each campaign serves (by id; by position before profiles had ids), the campaigns it
   * paused when it was turned off, the last daily report and the last warnings.
   */
  _state?: { campaign_icps?: Record<string, string | number>; paused_when_off?: string[]; last_report_on?: string; warned?: Record<string, string> };
}

export function defaultConfig(): SalesConfig {
  return {
    memory: { company: "", business_description: "", icps: [], active_icps_indexes: [], business_offers: [], active_business_offers_indexes: [], custom_fields: [] },
    enrichment_settings: { enrichment_limit_per_run: 25, signal_targeting_enabled: true, signal_targeting_categories: [...DEFAULT_SIGNALS] },
    outreach_settings: {
      email_list: [],
      email_tag_list: [],
      daily_limit: 30,
      stop_on_reply: true,
      open_tracking: false,
      first_email_text_only: true,
      prioritize_new_leads: false,
      match_lead_esp: false,
      opt_out_settings: { text_opt_out_enabled: true },
    },
    autonomy_settings: { autopilot_mode: false, auto_reply_to_responses: true, manual_leads_mode: false },
    slack_connection_id: null,
  };
}

export const cfgOf = (a: SalesAgentRow) => {
  const d = defaultConfig();
  const c = (a.config ?? {}) as Partial<SalesConfig>;
  return {
    ...d,
    ...c,
    memory: { ...d.memory, ...(c.memory ?? {}) },
    enrichment_settings: { ...d.enrichment_settings, ...(c.enrichment_settings ?? {}) },
    outreach_settings: { ...d.outreach_settings, ...(c.outreach_settings ?? {}), opt_out_settings: { ...d.outreach_settings.opt_out_settings, ...(c.outreach_settings?.opt_out_settings ?? {}) } },
    autonomy_settings: { ...d.autonomy_settings, ...(c.autonomy_settings ?? {}) },
  } as SalesConfig;
};

/** Merges a config update: memory key by key, the other sections field by field. */
export function mergeConfig(current: SalesConfig, patch: Partial<SalesConfig>): SalesConfig {
  const next: SalesConfig = { ...current };
  if (patch.memory) {
    next.memory = { ...current.memory, ...patch.memory };
    if (patch.memory.icps) next.memory.icps = withIcpIds(patch.memory.icps, current.memory.icps);
  }
  for (const k of ["position_details", "investment_details", "research_details", "partnership_details"] as const) if (patch[k] !== undefined) next[k] = patch[k];
  if (patch.enrichment_settings) next.enrichment_settings = { ...current.enrichment_settings, ...patch.enrichment_settings };
  if (patch.outreach_settings) {
    next.outreach_settings = {
      ...current.outreach_settings,
      ...patch.outreach_settings,
      opt_out_settings: { ...current.outreach_settings.opt_out_settings, ...(patch.outreach_settings.opt_out_settings ?? {}) },
    };
  }
  if (patch.autonomy_settings) next.autonomy_settings = { ...current.autonomy_settings, ...patch.autonomy_settings };
  if (patch.slack_connection_id !== undefined) next.slack_connection_id = patch.slack_connection_id;
  return next;
}

export function serializeSalesAgent(a: SalesAgentRow) {
  const { _state: _ignored, ...config } = cfgOf(a);
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    name: a.name,
    description: a.description,
    type: a.type,
    input: a.input,
    status: a.status,
    config,
    created_by: a.createdBy,
    master_lead_list_id: a.masterLeadListId,
    initial_scrape_ready: a.initialScrapeReady,
    agent_type: a.agentType,
    self_improvement: a.selfImprovement,
    timestamp_created: iso(a.createdAt),
    timestamp_updated: iso(a.updatedAt),
    timestamp_last_action: iso(a.lastActionAt),
    timestamp_last_decision: iso(a.lastDecisionAt),
    next_decision_time: iso(a.nextDecisionAt),
  };
}

export function serializeSalesActivity(r: SalesActivityRow) {
  return {
    id: r.id,
    ai_sdr_id: r.aiSdrId,
    workspace_id: r.workspaceId,
    action_type: r.actionType,
    action_status: r.actionStatus,
    action_payload: r.actionPayload ?? {},
    action_output: r.actionOutput ?? {},
    email_id: r.emailId,
    approved_by: r.approvedBy,
    approved_at: iso(r.approvedAt),
    rejected_by: r.rejectedBy,
    rejected_at: iso(r.rejectedAt),
    rejection_reason: r.rejectionReason,
    ai_reasoning: r.aiReasoning,
    ai_confidence: r.aiConfidence,
    result: r.result ?? {},
    error_message: r.errorMessage,
    error_code: r.errorCode ?? undefined,
    timestamp_created: iso(r.createdAt),
    timestamp_updated: iso(r.updatedAt),
    timestamp_executed: iso(r.executedAt),
    timestamp_completed: iso(r.completedAt),
  };
}

// ---------- Guidance rules (stored in memory.custom_fields) ----------

export interface GuidanceRule {
  id: string;
  title: string;
  content: string;
}

export function guidanceRules(cfg: SalesConfig): GuidanceRule[] {
  return (cfg.memory.custom_fields ?? []).map((raw, i) => {
    try {
      const v = JSON.parse(raw) as { title?: string; content?: string };
      if (v && typeof v === "object" && typeof v.content === "string") return { id: `rule-${i}`, title: v.title || `Rule ${i + 1}`, content: v.content };
    } catch {
      // plain-text rule
    }
    return { id: `rule-${i}`, title: `Rule ${i + 1}`, content: raw };
  });
}

export const encodeRule = (r: { title: string; content: string }) => JSON.stringify({ title: r.title, content: r.content });

// ---------- Activities ----------

async function log(a: SalesAgentRow, type: ActionType, status: (typeof ACTION_STATUSES)[number], fields: Partial<typeof ACT.$inferInsert> = {}) {
  const [row] = await db
    .insert(ACT)
    .values({ workspaceId: a.workspaceId, aiSdrId: a.id, actionType: type, actionStatus: status, ...(status === "completed" ? { completedAt: new Date() } : {}), ...fields })
    .returning();
  await db.update(S).set({ lastActionAt: new Date() }).where(eq(S.id, a.id));
  return row!;
}

/** A proposal: waits for approval in copilot mode, runs right away on autopilot. */
async function propose(a: SalesAgentRow, type: ActionType, fields: Partial<typeof ACT.$inferInsert>) {
  const autopilot = cfgOf(a).autonomy_settings.autopilot_mode;
  const row = await log(a, type, autopilot ? "approved" : "pending", { ...(autopilot ? { approvedAt: new Date() } : {}), ...fields });
  return autopilot ? execute(a, row) : row;
}

async function agentCampaigns(a: SalesAgentRow) {
  return db.select().from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, a.workspaceId), eq(schema.campaigns.aiSdrId, a.id)));
}

function activeIcps(cfg: SalesConfig): Array<{ index: number; icp: Icp }> {
  const icps = cfg.memory.icps ?? [];
  const idx = cfg.memory.active_icps_indexes?.length ? cfg.memory.active_icps_indexes : icps.map((_, i) => i);
  return idx.filter((i) => icps[i]).map((i) => ({ index: i, icp: icps[i]! }));
}

/**
 * The profiles, each with a lasting id, so campaigns stay linked to theirs when others are added, removed or
 * reordered. Ids already there are kept; a profile that arrives without one (from an older page, or learned again)
 * takes the id of the earlier profile with the same name.
 */
export function withIcpIds(icps: Icp[] | undefined, before: Icp[] = []): Icp[] {
  const byName = new Map(before.filter((i) => i.id).map((i) => [i.name.trim().toLowerCase(), i.id!]));
  const taken = new Set<string>();
  return (icps ?? []).map((icp) => {
    let id = icp.id ?? byName.get(icp.name.trim().toLowerCase());
    if (!id || taken.has(id)) id = `icp_${uuidv7()}`;
    taken.add(id);
    return { ...icp, id };
  });
}

/** The profile a campaign was written for; undefined once that profile was removed. */
function campaignIcp(cfg: SalesConfig, campaignId: string): Icp | undefined {
  const link = cfg._state?.campaign_icps?.[campaignId];
  const icps = cfg.memory.icps ?? [];
  return typeof link === "string" ? icps.find((i) => i.id === link) : typeof link === "number" ? icps[link] : undefined;
}

/** The profile a proposal or run names: by id, or by position for ones made before profiles had ids. */
function namedIcp(cfg: SalesConfig, p: Record<string, unknown>): Icp | undefined {
  const icps = cfg.memory.icps ?? [];
  return typeof p.icp_id === "string" ? icps.find((i) => i.id === p.icp_id) : icps[Number(p.icp_index ?? 0)];
}

/** Older agents linked campaigns to profiles by position: gives their profiles ids and links by id from now on. */
async function ensureIcpIds(a: SalesAgentRow): Promise<SalesAgentRow> {
  const cfg = cfgOf(a);
  const icps = cfg.memory.icps ?? [];
  const links = cfg._state?.campaign_icps ?? {};
  if (icps.every((i) => i.id) && Object.values(links).every((v) => typeof v === "string")) return a;
  const named = withIcpIds(icps);
  const relinked: Record<string, string> = {};
  for (const [campaignId, link] of Object.entries(links)) {
    const id = typeof link === "number" ? named[link]?.id : link;
    if (id) relinked[campaignId] = id;
  }
  const next = { ...cfg, memory: { ...cfg.memory, icps: named }, _state: { ...(cfg._state ?? {}), campaign_icps: relinked } };
  const [row] = await db.update(S).set({ config: next as unknown as Record<string, unknown> }).where(eq(S.id, a.id)).returning();
  return row ?? a;
}

/** Lead Finder filters for an ICP. */
export function icpFilters(icp: Icp, signals: string[] = []): SearchFilters {
  const f: SearchFilters = { show_one_lead_per_company: true, skip_owned_leads: true };
  const industries = (icp.industry ?? []).filter((x) => x in INDUSTRY_TREE);
  const sizes = (icp.company_size ?? []).filter((x) => x in EMPLOYEE_BANDS);
  if (industries.length) f.industry = { include: industries };
  if (sizes.length) f.employeeCount = sizes;
  if (icp.job_title?.include?.length || icp.job_title?.exclude?.length) f.title = { include: icp.job_title.include ?? [], exclude: icp.job_title.exclude ?? [], includeMode: "CONTAINS", excludeMode: "CONTAINS" };
  if (icp.keywords?.include) f.keyword_filter = { include: icp.keywords.include, ...(icp.keywords.exclude ? { exclude: icp.keywords.exclude } : {}), include_mode: "ANY" };
  if (signals.length) f.signals = signals.map((key) => ({ key, period_days: 90 }));
  return f;
}

async function setState(a: SalesAgentRow, patch: Partial<NonNullable<SalesConfig["_state"]>>) {
  const [fresh] = await db.select().from(S).where(eq(S.id, a.id)).limit(1);
  const cfg = cfgOf(fresh ?? a);
  const state = cfg._state ?? {};
  const next = {
    ...cfg,
    _state: {
      ...state,
      ...patch,
      ...(patch.campaign_icps ? { campaign_icps: { ...(state.campaign_icps ?? {}), ...patch.campaign_icps } } : {}),
      ...(patch.warned ? { warned: { ...(state.warned ?? {}), ...patch.warned } } : {}),
    },
  };
  await db.update(S).set({ config: next as unknown as Record<string, unknown> }).where(eq(S.id, a.id));
}

/** Logs a warning at most once a day (on the workspace clock) per key. */
async function warnOnce(a: SalesAgentRow, key: string, message: string, payload: Record<string, unknown> = {}) {
  const today = await workspaceToday(a.workspaceId);
  const [fresh] = await db.select().from(S).where(eq(S.id, a.id)).limit(1);
  if (cfgOf(fresh ?? a)._state?.warned?.[key] === today) return;
  await log(a, "warning", "completed", { actionPayload: { key, ...payload }, actionOutput: { message } });
  await setState(a, { warned: { [key]: today } });
}

// ---------- Executors ----------

type ExecOut = { output?: Record<string, unknown>; result?: Record<string, unknown>; emailId?: string | null };

async function execInitialScrape(a: SalesAgentRow, p: Record<string, unknown>): Promise<ExecOut> {
  if (!a.input || (a.type !== "website" && a.type !== "pitch_deck")) throw new SdrError("configuration_error", "Add a website URL or pitch text first");
  if (!(await aiAvailable(a.workspaceId))) throw new SdrError("configuration_error", "Learning the business needs AI. Add an Anthropic API key in Settings → Integrations & API → AI.");
  let memory: SalesMemory;
  try {
    memory = await extractMemory(a.workspaceId, { type: a.type as "website" | "pitch_deck", input: a.input });
  } catch (err) {
    if ((err as { code?: string }).code === "scrape_site_not_supported" || /fetch|URL|redirect|resolve|ENOTFOUND|reach/i.test((err as Error).message)) {
      throw new SdrError("scrape_site_not_supported", `Could not read ${a.type === "website" ? "the website" : "the pitch"}: ${(err as Error).message}`);
    }
    throw err;
  }
  // Written onto the agent as it is now, so settings saved while it was reading stay.
  const [fresh] = await db.select().from(S).where(eq(S.id, a.id)).limit(1);
  const cfg = cfgOf(fresh ?? a);
  // The first pass keeps anything the user already filled in; learning again replaces the profile. Guidance rules stay.
  const merged: SalesMemory = { ...memory, custom_fields: cfg.memory.custom_fields ?? [] };
  if (!p.replace) {
    for (const [k, v] of Object.entries(cfg.memory)) {
      const filled = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "";
      if (filled) merged[k] = v;
    }
  }
  // A profile learned again under the same name keeps its campaigns.
  merged.icps = withIcpIds(merged.icps, cfg.memory.icps);
  await db.update(S).set({ config: { ...cfg, memory: merged } as unknown as Record<string, unknown>, initialScrapeReady: true }).where(eq(S.id, a.id));
  return { output: { company: merged.company, icps: (merged.icps ?? []).map((i) => i.name), offers: merged.business_offers ?? [] } };
}

/** Sequence versions the agent saves carry its name. */
const agentActor = (a: SalesAgentRow) => ({ userId: null, name: `AI sales agent “${a.name}”` });

async function execCreateCampaign(a: SalesAgentRow, p: Record<string, unknown>): Promise<ExecOut> {
  const cfg = cfgOf(a);
  const o = cfg.outreach_settings;
  const steps = (p.steps as Array<{ delay: number; subject: string; body: string }> | undefined) ?? [];
  if (!steps.length) throw new SdrError("configuration_error", "The proposal has no emails");
  const icp = namedIcp(cfg, p);
  if (!icp) throw new SdrError("configuration_error", "The customer profile this campaign was written for was removed");
  const sequence: SequenceStep[] = steps.map((s) => ({ type: "email", delay: s.delay, delay_unit: "days", variants: [{ subject: s.subject, body: s.body }] }) as SequenceStep);
  let c;
  try {
    c = await insertCampaign(a.workspaceId, null, {
      name: String(p.name ?? `${a.name} campaign`),
      // Without a schedule of the agent's own, the workspace's default (its timezone, its hours).
      schedule: o.campaign_schedule,
      sequences: [{ steps: sequence }],
      emailList: o.email_list,
      emailTagList: o.email_tag_list,
      dailyLimit: o.daily_limit,
      stopOnReply: o.stop_on_reply,
      openTracking: o.open_tracking,
      firstEmailTextOnly: o.first_email_text_only,
      prioritizeNewLeads: o.prioritize_new_leads,
      matchLeadEsp: o.match_lead_esp,
      insertUnsubscribeHeader: true,
      aiSdrId: a.id,
    });
  } catch (err) {
    throw new SdrError("campaign_operation_failed", (err as Error).message);
  }
  await recordSequenceVersion({ workspaceId: c.workspaceId, campaignId: c.id, before: null, after: c.sequences, actor: agentActor(a), source: "create" });
  await setState(a, { campaign_icps: { [c.id]: icp.id ?? Number(p.icp_index ?? 0) } });
  let activated = false;
  // Whether the agent is on now: it may have been paused while the emails were being written.
  const [now] = await db.select({ status: S.status }).from(S).where(eq(S.id, a.id)).limit(1);
  if (now?.status === 1) {
    const problems = await launchProblems(c);
    if (!problems.length) {
      await setCampaignStatus(c, CampaignStatus.ACTIVE);
      activated = true;
    } else await warnOnce(a, `launch:${c.id}`, `"${c.name}" is ready but cannot start yet: ${problems[0]}`, { campaign_id: c.id });
  }
  return { output: { campaign_id: c.id, campaign_name: c.name, steps: steps.length, activated }, result: { campaign_id: c.id } };
}

async function execEditCampaign(a: SalesAgentRow, p: Record<string, unknown>): Promise<ExecOut> {
  const [c] = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, String(p.campaign_id)), eq(schema.campaigns.aiSdrId, a.id))).limit(1);
  if (!c) throw new SdrError("campaign_operation_failed", "The campaign no longer exists");
  const seq = structuredClone(c.sequences ?? [{ steps: [] }]);
  const variant = p.add_variant as { step: number; subject: string; body: string } | undefined;
  if (variant) {
    const step = seq[0]?.steps?.[variant.step];
    if (!step) throw new SdrError("campaign_operation_failed", `Step ${variant.step + 1} no longer exists`);
    if (isTaskStep(step)) throw new SdrError("campaign_operation_failed", `Step ${variant.step + 1} is a task done by hand, not an email`);
    step.variants = [...(step.variants ?? []), { subject: variant.subject, body: variant.body }];
  }
  await db.update(schema.campaigns).set({ sequences: seq }).where(eq(schema.campaigns.id, c.id));
  await recordSequenceVersion({ workspaceId: c.workspaceId, campaignId: c.id, before: c.sequences, after: seq, beforeAt: c.updatedAt, actor: agentActor(a), source: "agent" });
  return { output: { campaign_id: c.id, campaign_name: c.name, change: variant ? `Added variant ${(seq[0]!.steps[variant.step]!.variants ?? []).length} to step ${variant.step + 1}` : "Updated" } };
}

async function execCampaignStatus(a: SalesAgentRow, p: Record<string, unknown>, status: number): Promise<ExecOut> {
  const [c] = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, String(p.campaign_id)), eq(schema.campaigns.aiSdrId, a.id))).limit(1);
  if (!c) throw new SdrError("campaign_operation_failed", "The campaign no longer exists");
  await setCampaignStatus(c, status);
  return { output: { campaign_id: c.id, campaign_name: c.name } };
}

async function requireMasterList(a: SalesAgentRow): Promise<string> {
  if (!a.masterLeadListId) throw new SdrError("master_list_missing", "The agent's master lead list is missing");
  const [list] = await db.select({ id: schema.leadLists.id }).from(schema.leadLists).where(eq(schema.leadLists.id, a.masterLeadListId)).limit(1);
  if (!list) throw new SdrError("master_list_missing", "The agent's master lead list was deleted");
  return list.id;
}

/** Writes a lead's opening line from its company's website and news. Falls back to a plain line without AI. */
async function researchInto(a: SalesAgentRow, lead: LeadRow, companyId: string | null): Promise<boolean> {
  const cfg = cfgOf(a);
  let found: { line: string; research: { grounding: Array<{ field: string; citations: Array<{ url: string; title: string }> }>; sources: Array<{ url: string }> } } | null = null;
  try {
    const news = companyId ? ((await db.select({ news: schema.lfCompanies.news }).from(schema.lfCompanies).where(eq(schema.lfCompanies.id, companyId)).limit(1))[0]?.news ?? []) : [];
    const r = await researchLead(
      a.workspaceId,
      { first_name: lead.firstName, job_title: lead.jobTitle, company_name: lead.companyName, company_domain: lead.companyDomain || null, news: news as Array<{ title: string; url?: string; date?: string }> },
      { company: cfg.memory.company, business: cfg.memory.business_description },
    );
    if (r.firstLine) found = { line: r.firstLine, research: { grounding: r.grounding, sources: r.sources } };
  } catch (err) {
    if (!(err instanceof AiRefusalError)) console.warn(`[sales-agent] research failed for ${lead.email}: ${aiErrorMessage(err)}`);
  }
  const line = found?.line ?? `I came across your work as ${lead.jobTitle ?? "a leader"} at ${lead.companyName ?? "your company"}.`;
  await db.update(L).set({ personalization: line }).where(eq(L.id, lead.id));
  if (found && (found.research.grounding.length || found.research.sources.length)) {
    await db
      .insert(schema.aiLeadResearch)
      .values({ workspaceId: a.workspaceId, agentId: a.id, leadId: lead.id, research: found.research })
      .onConflictDoUpdate({ target: [schema.aiLeadResearch.agentId, schema.aiLeadResearch.leadId], set: { research: found.research } });
  }
  return !!found;
}

type Delivery = { outcome: "delivered" | "no_email_found" | "not_moved" | "skipped"; leadId?: string; email?: string | null; reason?: string; refunded?: boolean };

/**
 * Reveals people (charging credits), researches each one and places them in the campaign through the master list.
 * Leads that could not be created after their email was paid for are refunded.
 */
async function revealInto(a: SalesAgentRow, campaignId: string, people: PersonResult[]) {
  const listId = await requireMasterList(a);
  const outcomes = new Map<string, Delivery>();
  const withEmail = people.filter((p) => {
    if (!p.email) outcomes.set(p.id, { outcome: "no_email_found", reason: "No work email on record", refunded: false });
    else if (p.owned) outcomes.set(p.id, { outcome: "skipped", reason: "Already a lead in this workspace" });
    return !!p.email && !p.owned;
  });
  // People the campaign would turn away aren't revealed or paid for.
  const refused = await uncontactable(a.workspaceId, withEmail.map((p) => p.email!), campaignId);
  const eligible = withEmail.filter((p) => {
    const no = refused.has(p.email!.toLowerCase());
    if (no) outcomes.set(p.id, { outcome: "skipped", reason: "On the blocklist, unsubscribed or bounced before" });
    return !no;
  });
  if (!eligible.length) return { outcomes, credits: 0, researched: 0 };
  const free = (await workspaceLimits(a.workspaceId)).self_hosted;
  // Only people it can pay for in full (the reveal and the address): a reveal is never paid for without its address.
  const payable = free ? eligible : await payableInFull(a.workspaceId, eligible);
  if (!payable.length) throw new SdrError("insufficient_credits", "Not enough credits to reveal new leads");
  const unlocked = await unlockPeople(a.workspaceId, null, payable, "ai_sales_agent:prospecting");
  let paid = unlocked.allowed;
  const unit = CREDIT_COSTS.work_email_enrichment;
  if (paid.length && !free && !(await chargeCredits(a.workspaceId, paid.length * unit, "ai_sales_agent:email", { refId: a.id }))) paid = [];
  if (!paid.length) throw new SdrError("insufficient_credits", "Not enough credits to reveal new leads");
  let credits = unlocked.charged + (free ? 0 : paid.length * unit);
  const added = await addLeads({ workspaceId: a.workspaceId, listId, leads: paid.map((x) => leadInput(x, true, { lf_agent_id: a.id })), uploadMethod: "lead-finder", skipIfInWorkspace: true }).catch(async (err) => {
    // No lead went in: the addresses paid for go back.
    if (!free) await refundCredits(a.workspaceId, paid.length * unit, "ai_sales_agent:refund", { refId: a.id });
    throw err;
  });
  const created = added.created_leads.length ? await db.select().from(L).where(inArray(L.id, added.created_leads.map((x) => x.id))) : [];
  const byEmail = new Map(created.map((l) => [(l.email ?? "").toLowerCase(), l]));
  let researched = 0;
  let refund = 0;
  try {
    for (const person of paid) {
      const lead = byEmail.get(person.email!.toLowerCase());
      if (!lead) {
        if (!free) refund += unit;
        outcomes.set(person.id, { outcome: "skipped", reason: "Already a lead in this workspace", refunded: !free });
        continue;
      }
      if (await researchInto(a, lead, person.company_id)) researched++;
      const moved = await moveLeads({ workspaceId: a.workspaceId, leadIds: [lead.id], toCampaignId: campaignId, checkDuplicatesInCampaigns: true });
      outcomes.set(person.id, moved.moved.length ? { outcome: "delivered", leadId: lead.id, email: lead.email } : { outcome: "not_moved", leadId: lead.id, email: lead.email, reason: "Already in another campaign; kept in the master list" });
    }
  } finally {
    // Given back however the loop ended: an error part-way keeps the refunds counted before it.
    if (refund) credits -= await refundCredits(a.workspaceId, refund, "ai_sales_agent:refund", { refId: a.id });
  }
  if ([...outcomes.values()].some((o) => o.outcome === "delivered")) await resumeIfFinished(a, campaignId);
  return { outcomes, credits, researched };
}

/** A campaign of the agent's that finished takes the leads the agent adds, and starts again when it can send. */
async function resumeIfFinished(a: SalesAgentRow, campaignId: string) {
  const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1);
  if (!c || c.status !== CampaignStatus.COMPLETED || a.status !== 1) return;
  if (!(await launchProblems(c)).length) await setCampaignStatus(c, CampaignStatus.ACTIVE);
}

/**
 * A sourcing run for one campaign. People with recent buying signals come first, then other matches for the
 * profile. On autopilot the people are revealed and added right away; in copilot each one becomes a
 * recommendation that is revealed (and charged) only once approved.
 */
async function execSourcing(a: SalesAgentRow, p: Record<string, unknown>): Promise<ExecOut> {
  const cfg = cfgOf(a);
  const [c] = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, String(p.campaign_id ?? "")), eq(schema.campaigns.aiSdrId, a.id))).limit(1);
  if (!c) throw new SdrError("campaign_operation_failed", "The campaign no longer exists");
  await requireMasterList(a);
  const icp = namedIcp(cfg, p);
  if (!icp) throw new SdrError("configuration_error", "The ideal customer profile for this campaign was removed");
  const limit = Math.max(1, Math.min(200, Number(p.limit ?? cfg.enrichment_settings.enrichment_limit_per_run)));
  // Nobody is recommended twice, whatever happened to the earlier recommendation.
  const recommended = new Set(
    (await db.select({ pid: sql<string>`json_extract(${ACT.actionPayload}, '$.person_id')` }).from(ACT).where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "recommend_lead"))))
      .map((r) => r.pid)
      .filter(Boolean),
  );
  const es = cfg.enrichment_settings;
  const signals = es.signal_targeting_enabled ? es.signal_targeting_categories : [];
  const picked: PersonResult[] = [];
  const withSignal = new Set<string>();
  const passes = signals.length ? [icpFilters(icp, signals), icpFilters(icp)] : [icpFilters(icp)];
  for (const [pass, filters] of passes.entries()) {
    for (let offset = 0; picked.length < limit && offset < 5_000; offset += 500) {
      const page = await searchPeople(a.workspaceId, filters, { limit: 500, offset });
      for (const person of page) {
        if (picked.length >= limit) break;
        if (!person.email || person.owned || recommended.has(person.id)) continue;
        recommended.add(person.id);
        picked.push(person);
        if (signals.length && pass === 0) withSignal.add(person.id);
      }
      if (page.length < 500) break;
    }
    if (picked.length >= limit) break;
  }
  if (!picked.length) throw new SdrError("no_leads_with_email", `No new people with a work email match the "${icp.name}" profile`);
  const base = { campaign_id: c.id, campaign_name: c.name, icp_name: icp.name, leads_found: picked.length, with_signals: withSignal.size };
  if (cfg.autonomy_settings.autopilot_mode) {
    const r = await revealInto(a, c.id, picked);
    const delivered = [...r.outcomes.values()].filter((o) => o.outcome === "delivered");
    return { output: { ...base, leads_added: delivered.length, researched: r.researched, credits_used: r.credits }, result: { lead_ids: delivered.map((o) => o.leadId) } };
  }
  for (const person of picked) {
    const signal = withSignal.has(person.id);
    await log(a, "recommend_lead", "pending", {
      actionPayload: { person_id: person.id, campaign_id: c.id, icp_id: icp.id ?? null },
      actionOutput: {
        lead_name: person.full_name || [person.first_name, person.last_name].filter(Boolean).join(" "),
        job_title: person.title,
        company_name: person.company_name,
        company_domain: person.company_domain,
        location: personLocation(person) || null,
        linkedin_url: person.linkedin_url,
        campaign_name: c.name,
        has_signal: signal,
      },
      aiReasoning: `${person.title ?? "This contact"} at ${person.company_name ?? "their company"} fits the "${icp.name}" profile${signal ? ", and the company shows a recent buying signal" : ""}.`,
      aiConfidence: signal ? 0.85 : 0.7,
    });
  }
  return { output: { ...base, recommended: picked.length } };
}

/** An approved recommendation: reveal the person, write their opening line and add them to the campaign. */
async function execRecommend(a: SalesAgentRow, p: Record<string, unknown>, row: SalesActivityRow): Promise<ExecOut> {
  const output = { ...(row.actionOutput ?? {}) };
  const [c] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.id, String(p.campaign_id ?? "")), eq(schema.campaigns.aiSdrId, a.id))).limit(1);
  if (!c) return { output: { ...output, delivery_outcome: "not_moved", reason: "The campaign was deleted", credits_used: 0, refunded: false } };
  const [person] = await peopleByIds(a.workspaceId, [String(p.person_id ?? "")]);
  if (!person) return { output: { ...output, delivery_outcome: "skipped", reason: "The person is no longer in the dataset", credits_used: 0, refunded: false } };
  const r = await revealInto(a, c.id, [person]);
  const o = r.outcomes.get(person.id) ?? { outcome: "skipped" as const };
  return {
    output: { ...output, delivery_outcome: o.outcome, ...(o.email ? { lead_email: o.email } : {}), ...(o.reason ? { reason: o.reason } : {}), credits_used: r.credits, refunded: !!o.refunded },
    result: o.leadId ? { lead_id: o.leadId } : {},
  };
}

/** Manual leads mode: moves a lead the user uploaded to the master list into a campaign. */
async function execPush(a: SalesAgentRow, p: Record<string, unknown>, row: SalesActivityRow): Promise<ExecOut> {
  const [c] = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, String(p.campaign_id ?? "")), eq(schema.campaigns.aiSdrId, a.id))).limit(1);
  if (!c) throw new SdrError("campaign_operation_failed", "The campaign no longer exists");
  const [lead] = await db.select().from(L).where(and(eq(L.id, String(p.lead_id ?? "")), eq(L.workspaceId, a.workspaceId))).limit(1);
  if (!lead) throw new SdrError("lead_move_failed", "The lead was deleted");
  const output = { ...(row.actionOutput ?? {}), campaign_name: c.name };
  if (lead.campaignId === c.id) return { output, result: { lead_id: lead.id } };
  // Someone put the lead in another campaign since the proposal: it stays there.
  if (lead.campaignId) throw new SdrError("lead_move_failed", "The lead is already in another campaign");
  if (!lead.email) throw new SdrError("lead_move_failed", "The lead has no email address");
  if (await isBlocked(a.workspaceId, lead.email)) throw new SdrError("lead_move_failed", "The lead is on the blocklist");
  if (!lead.personalization) await researchInto(a, lead, null);
  const moved = await moveLeads({ workspaceId: a.workspaceId, leadIds: [lead.id], toCampaignId: c.id, checkDuplicatesInCampaigns: true });
  if (!moved.moved.length) throw new SdrError("lead_move_failed", "The lead is already in another campaign");
  await resumeIfFinished(a, c.id);
  return { output, result: { lead_id: lead.id } };
}

/** Why a drafted reply wasn't sent after all, as the live feed says it. */
const NOT_SENT: Record<DiscardReason, string> = {
  lead_replied_again: "The lead wrote again; the agent answers their newest message instead.",
  answered_by_person: "Someone already answered this conversation.",
  lead_unsubscribed: "The lead unsubscribed.",
};

/** A reply the conversation has moved past: dropped, not failed. */
class NotSent extends Error {
  constructor(public reason: DiscardReason) {
    super(NOT_SENT[reason]);
  }
}

/** Drops a drafted reply without sending it, if it's still in one of the `from` states. */
async function dropReply(row: SalesActivityRow, reason: DiscardReason, from: Array<(typeof ACTION_STATUSES)[number]>): Promise<SalesActivityRow> {
  const [dropped] = await db
    .update(ACT)
    .set({ actionStatus: "rejected", rejectedAt: new Date(), completedAt: new Date(), rejectionReason: NOT_SENT[reason], actionOutput: { ...(row.actionOutput ?? {}), not_sent: reason } })
    .where(and(eq(ACT.id, row.id), inArray(ACT.actionStatus, from)))
    .returning();
  return dropped ?? row;
}

async function execSendReply(a: SalesAgentRow, p: Record<string, unknown>): Promise<ExecOut> {
  const [original] = await db.select().from(schema.emails).where(and(eq(schema.emails.id, String(p.in_reply_to_email_id)), eq(schema.emails.workspaceId, a.workspaceId))).limit(1);
  if (!original) throw new SdrError("internal_error", "The email being answered was deleted");
  // The conversation may have moved on since the draft was written.
  const moved = await conversationMovedOn(a.workspaceId, original.id, { leadId: p.lead_id ? String(p.lead_id) : original.leadId });
  if (moved) throw new NotSent(moved);
  const [account] = original.accountId ? await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, original.accountId)).limit(1) : [];
  if (!account) throw new SdrError("configuration_error", "The mailbox for this conversation is no longer connected");
  // Every address the reply goes to, not only the lead's.
  const refusal = await recipientRefusal(a.workspaceId, [original.leadEmail, ...replyRecipients(original)], { campaignId: original.campaignId });
  if (refusal === "unsubscribed") throw new NotSent("lead_unsubscribed");
  if (refusal) throw new SdrError("configuration_error", "An address this reply goes to is on your blocklist");
  const sent = await composeAndSend({ workspaceId: a.workspaceId, account, original, kind: "reply", html: String(p.html ?? ""), includeQuote: true });
  await db.update(schema.emails).set({ aiAssisted: 1 }).where(eq(schema.emails.id, sent.id));
  return { output: { lead_email: original.leadEmail, subject: sent.subject }, emailId: sent.id };
}

/** Runs an approved activity and records the outcome. Only the caller that claims the activity runs it. */
export async function execute(a: SalesAgentRow, row: SalesActivityRow): Promise<SalesActivityRow> {
  if (EVENT_TYPES.has(row.actionType)) return row;
  const [claimed] = await db
    .update(ACT)
    .set({ actionStatus: "in_progress", executedAt: new Date() })
    .where(and(eq(ACT.id, row.id), eq(ACT.actionStatus, "approved")))
    .returning();
  if (!claimed) return (await db.select().from(ACT).where(eq(ACT.id, row.id)).limit(1))[0] ?? row;
  const p = (row.actionPayload ?? {}) as Record<string, unknown>;
  try {
    let out: ExecOut = {};
    switch (row.actionType) {
      case "initial_setup_scrape":
        out = await execInitialScrape(a, p);
        break;
      case "initial_setup_campaigns":
        out = { output: { proposed: await proposeCampaigns(a) } };
        break;
      case "create_campaign":
        out = await execCreateCampaign(a, p);
        break;
      case "edit_campaign":
        out = await execEditCampaign(a, p);
        break;
      case "pause_campaign":
        out = await execCampaignStatus(a, p, CampaignStatus.PAUSED);
        break;
      case "stop_campaign":
        out = await execCampaignStatus(a, p, CampaignStatus.COMPLETED);
        break;
      case "enrich_leads":
      case "initial_setup_enrich":
        out = await execSourcing(a, p);
        break;
      case "recommend_lead":
        out = await execRecommend(a, p, row);
        break;
      case "push_lead":
        out = await execPush(a, p, row);
        break;
      case "email_sent":
        out = await execSendReply(a, p);
        break;
      default:
        throw new SdrError("internal_error", `Unsupported action ${row.actionType}`);
    }
    const [done] = await db
      .update(ACT)
      .set({
        actionStatus: "completed",
        completedAt: new Date(),
        actionOutput: { ...(row.actionOutput ?? {}), ...(out.output ?? {}) },
        result: out.result ?? {},
        emailId: out.emailId ?? row.emailId,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(ACT.id, row.id))
      .returning();
    await db.update(S).set({ lastActionAt: new Date() }).where(eq(S.id, a.id));
    return done!;
  } catch (err) {
    if (err instanceof NotSent) return dropReply(row, err.reason, ["in_progress"]);
    // A first reading that failed leaves the memory to fill in by hand or to learn again, instead of "learning" forever.
    if (row.actionType === "initial_setup_scrape") await db.update(S).set({ initialScrapeReady: true }).where(and(eq(S.id, a.id), eq(S.initialScrapeReady, false)));
    const code: ErrorCode = err instanceof SdrError ? err.code : /rate|overloaded|timeout|ECONN/i.test((err as Error).message) ? "temporary_failure" : "internal_error";
    const [failed] = await db
      .update(ACT)
      .set({ actionStatus: "failed", completedAt: new Date(), errorCode: code, errorMessage: err instanceof SdrError ? err.message : aiErrorMessage(err) })
      .where(eq(ACT.id, row.id))
      .returning();
    return failed!;
  }
}

export async function approveActivity(a: SalesAgentRow, row: SalesActivityRow, userId: string | null) {
  const [approved] = await db.update(ACT).set({ actionStatus: "approved", approvedBy: userId, approvedAt: new Date() }).where(and(eq(ACT.id, row.id), eq(ACT.actionStatus, "pending"))).returning();
  if (!approved) return row;
  return execute(a, approved);
}

export async function rejectActivity(row: SalesActivityRow, userId: string | null, reason: string) {
  const [rejected] = await db
    .update(ACT)
    .set({ actionStatus: "rejected", rejectedBy: userId, rejectedAt: new Date(), rejectionReason: reason.slice(0, 2_000) })
    .where(and(eq(ACT.id, row.id), eq(ACT.actionStatus, "pending")))
    .returning();
  return rejected ?? row;
}

// ---------- Decisions ----------

/** An open proposal of this kind for the campaign, or one the user turned down in the last `days` days. */
const proposedLately = async (a: SalesAgentRow, type: ActionType, campaignId: string, days: number) =>
  (
    await db
      .select({ id: ACT.id })
      .from(ACT)
      .where(
        and(
          eq(ACT.aiSdrId, a.id),
          eq(ACT.actionType, type),
          sql`json_extract(${ACT.actionPayload}, '$.campaign_id') = ${campaignId}`,
          or(inArray(ACT.actionStatus, ["pending", "approved", "in_progress"]), and(eq(ACT.actionStatus, "rejected"), gte(ACT.rejectedAt, new Date(Date.now() - days * 86_400_000)))),
        ),
      )
      .limit(1)
  ).length > 0;

/** An open proposal for this profile, or a recent one the user turned down (or whose campaign they deleted). */
const recentCampaignProposal = async (a: SalesAgentRow, icp: Icp, index: number) =>
  (
    await db
      .select({ id: ACT.id })
      .from(ACT)
      .where(
        and(
          eq(ACT.aiSdrId, a.id),
          eq(ACT.actionType, "create_campaign"),
          // Proposals made before profiles had ids name theirs by position.
          sql`(json_extract(${ACT.actionPayload}, '$.icp_id') = ${icp.id ?? ""} or (json_extract(${ACT.actionPayload}, '$.icp_id') is null and json_extract(${ACT.actionPayload}, '$.icp_index') = ${index}))`,
          or(inArray(ACT.actionStatus, ["pending", "approved", "in_progress"]), and(sql`${ACT.actionStatus} <> 'failed'`, gte(ACT.createdAt, new Date(Date.now() - 14 * 86_400_000)))),
        ),
      )
      .limit(1)
  ).length > 0;

/** Proposes a campaign for each active ICP that has none yet. Returns how many it proposed. */
async function proposeCampaigns(agent: SalesAgentRow): Promise<number> {
  const a = await ensureIcpIds(agent);
  const cfg = cfgOf(a);
  const campaigns = await agentCampaigns(a);
  const served = new Set(campaigns.map((c) => campaignIcp(cfg, c.id)).filter((x): x is Icp => !!x));
  let proposed = 0;
  const rules = guidanceRules(cfg).map((r) => r.content);
  const optOut = cfg.outreach_settings.opt_out_settings.text_opt_out_enabled ? "If this isn't relevant, just let me know and I won't follow up." : null;
  for (const { index, icp } of activeIcps(cfg)) {
    if (served.has(icp) || (await recentCampaignProposal(a, icp, index))) continue;
    const seq = await writeSequence(a.workspaceId, { memory: cfg.memory, icp, guidance: rules, agentName: a.name, optOutLine: optOut });
    await propose(a, "create_campaign", {
      actionPayload: { icp_id: icp.id ?? null, icp_index: index, name: seq.name, steps: seq.steps },
      actionOutput: { campaign_name: seq.name, icp_name: icp.name, steps: seq.steps.length, first_subject: seq.steps[0]?.subject },
      aiReasoning: seq.reasoning || `A dedicated campaign for the "${icp.name}" profile.`,
      aiConfidence: 0.8,
    });
    proposed++;
  }
  return proposed;
}

const DECIDE_EVERY_MS = 60 * 60_000;

/** Starts a sourcing run when a campaign has fewer than about two days of leads waiting. */
async function keepStocked(a: SalesAgentRow, c: CampaignRow) {
  const cfg = cfgOf(a);
  const icp = campaignIcp(cfg, c.id);
  if (!icp) {
    await warnOnce(a, `profile:${c.id}`, `The customer profile behind "${c.name}" was removed, so the agent no longer adds leads to it.`, { campaign_id: c.id });
    return;
  }
  // A profile that was unticked gets no new prospects.
  if (!activeIcps(cfg).some((x) => x.icp === icp)) return;
  const [last] = await db
    .select({ status: ACT.actionStatus, createdAt: ACT.createdAt })
    .from(ACT)
    .where(and(eq(ACT.aiSdrId, a.id), inArray(ACT.actionType, ["enrich_leads", "initial_setup_enrich"]), sql`json_extract(${ACT.actionPayload}, '$.campaign_id') = ${c.id}`))
    .orderBy(desc(ACT.createdAt))
    .limit(1);
  // One run at a time; after a failed run the agent waits a day before trying again.
  if (last && (["pending", "approved", "in_progress"].includes(last.status) || (last.status === "failed" && last.createdAt.getTime() > Date.now() - 86_400_000))) return;
  const [counts] = await db
    .select({ waiting: sql<number>`sum(case when ${L.status} = ${LeadStatus.ACTIVE} and ${L.lastContactAt} is null then 1 else 0 end)`, total: sql<number>`count(*)` })
    .from(L)
    .where(eq(L.campaignId, c.id));
  const [{ n: recommended }] = (await db
    .select({ n: sql<number>`count(*)` })
    .from(ACT)
    .where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "recommend_lead"), eq(ACT.actionStatus, "pending"), sql`json_extract(${ACT.actionPayload}, '$.campaign_id') = ${c.id}`))) as [{ n: number }];
  const threshold = Math.max(10, (c.dailyLimit ?? cfg.outreach_settings.daily_limit) * 2);
  const stocked = Number(counts?.waiting ?? 0) + Number(recommended);
  if (stocked >= threshold) return;
  const first = Number(counts?.total ?? 0) === 0 && !last;
  const row = await log(a, first ? "initial_setup_enrich" : "enrich_leads", "approved", {
    approvedAt: new Date(),
    actionPayload: { campaign_id: c.id, icp_id: icp.id ?? null, limit: Math.min(cfg.enrichment_settings.enrichment_limit_per_run, threshold * 2 - stocked) },
    actionOutput: { campaign_name: c.name, icp_name: icp.name },
    aiReasoning: first ? `Finding the first leads for "${c.name}".` : `"${c.name}" has ${stocked} leads waiting; it needs about ${threshold} to keep sending.`,
    aiConfidence: 0.9,
  });
  await execute(a, row);
}

/** The campaign whose profile's job titles match the lead, else the first one (marked as not matched). */
function pickCampaign(cfg: SalesConfig, campaigns: CampaignRow[], lead: LeadRow): { campaign: CampaignRow; matched: boolean } {
  const title = (lead.jobTitle ?? "").toLowerCase();
  const match = title ? campaigns.find((c) => (campaignIcp(cfg, c.id)?.job_title?.include ?? []).some((t) => t && title.includes(t.toLowerCase()))) : undefined;
  return { campaign: match ?? campaigns[0]!, matched: !!match };
}

/** Manual leads mode: proposes placing each lead the user uploaded to the master list into a campaign. */
async function proposePushes(a: SalesAgentRow, campaigns: CampaignRow[]) {
  if (!a.masterLeadListId || !campaigns.length) return;
  const cfg = cfgOf(a);
  const waiting = await db
    .select()
    .from(L)
    .where(
      and(
        eq(L.workspaceId, a.workspaceId),
        eq(L.listId, a.masterLeadListId),
        isNull(L.campaignId),
        // Leads proposed before, whatever became of it, don't take up the batch.
        sql`not exists (select 1 from ai_sales_agent_activities p where p.ai_sdr_id = ${a.id} and p.action_type = 'push_lead' and json_extract(p.action_payload, '$.lead_id') = ${L.id})`,
      ),
    )
    .orderBy(L.createdAt)
    .limit(200);
  let proposed = 0;
  for (const lead of waiting) {
    if (proposed >= 50) break;
    if (!lead.email) continue;
    const { campaign: c, matched } = pickCampaign(cfg, campaigns, lead);
    const who = `${lead.jobTitle ?? "This lead"} at ${lead.companyName ?? "their company"}`;
    await propose(a, "push_lead", {
      actionPayload: { lead_id: lead.id, campaign_id: c.id },
      actionOutput: { lead_email: lead.email, lead_name: [lead.firstName, lead.lastName].filter(Boolean).join(" "), job_title: lead.jobTitle, company_name: lead.companyName, campaign_name: c.name },
      aiReasoning: matched ? `${who} matches the job titles targeted by "${c.name}".` : `${who} doesn't match any profile's job titles; "${c.name}" is the closest available campaign.`,
      aiConfidence: matched ? 0.8 : 0.4,
    });
    proposed++;
  }
}

/** How long a planning round may hold its claim; one cut short by a restart frees the agent after this. */
const DECIDE_CLAIM_MS = 30 * 60_000;

/** One planning round for an active agent. False when it isn't due, is off, or another round is running. */
export async function decide(agentId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const now = new Date();
  // Claimed in one statement, so a scheduled round and "Run now" never plan (and propose campaigns) twice.
  const [claimed] = await db
    .update(S)
    .set({ decidingUntil: new Date(now.getTime() + DECIDE_CLAIM_MS), lastDecisionAt: now, nextDecisionAt: new Date(now.getTime() + DECIDE_EVERY_MS) })
    .where(and(eq(S.id, agentId), eq(S.status, 1), or(isNull(S.decidingUntil), lt(S.decidingUntil, now)), ...(opts.force ? [] : [or(isNull(S.nextDecisionAt), lte(S.nextDecisionAt, now))])))
    .returning();
  if (!claimed) return false;
  try {
    await planRound(claimed);
  } finally {
    await db.update(S).set({ decidingUntil: null }).where(eq(S.id, agentId));
  }
  return true;
}

async function planRound(claimed: SalesAgentRow) {
  const agentId = claimed.id;
  let a: SalesAgentRow | undefined = claimed;
  if (!(await aiAvailable(a.workspaceId))) {
    await warnOnce(a, "ai", "The agent needs AI to write and research. Add an Anthropic API key in Settings → Integrations & API → AI.");
    return;
  }
  try {
    a = await ensureIcpIds(a);
    if (!a.initialScrapeReady) {
      const [running] = await db.select({ id: ACT.id }).from(ACT).where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "initial_setup_scrape"), inArray(ACT.actionStatus, ["pending", "approved", "in_progress"]))).limit(1);
      if (running) return;
      const row = await log(a, "initial_setup_scrape", "approved", { actionPayload: { type: a.type, input: a.type === "website" ? a.input : "(pitch text)" }, approvedAt: new Date() });
      const done = await execute(a, row);
      if (done.actionStatus !== "completed") return;
      [a] = await db.select().from(S).where(eq(S.id, agentId)).limit(1);
      if (!a) return;
    }
    const cfg = cfgOf(a);
    if (!activeIcps(cfg).length) {
      await warnOnce(a, "icp", "Add at least one ideal customer profile so the agent knows who to contact.");
      return;
    }
    const [setup] = await db.select().from(ACT).where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "initial_setup_campaigns"))).orderBy(desc(ACT.createdAt)).limit(1);
    if (!setup && !(await agentCampaigns(a)).length) {
      const row = await log(a, "initial_setup_campaigns", "approved", { approvedAt: new Date(), aiReasoning: "Setting up one campaign per ideal customer profile." });
      await execute(a, row);
    } else if (setup?.actionStatus === "approved") await execute(a, setup);
    else await proposeCampaigns(a);
    [a] = await db.select().from(S).where(eq(S.id, agentId)).limit(1);
    if (!a) return;
    await launchReadyCampaigns(a);
    const stopped = new Set(
      (await db.select({ id: sql<string>`json_extract(${ACT.actionPayload}, '$.campaign_id')` }).from(ACT).where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "stop_campaign"), eq(ACT.actionStatus, "completed")))).map((r) => r.id),
    );
    // Drafts that still can't start get no leads; finished campaigns take more (and start again), unless it stopped them.
    const campaigns = (await agentCampaigns(a)).filter((c) => c.status === CampaignStatus.ACTIVE || (c.status === CampaignStatus.COMPLETED && !stopped.has(c.id)));
    if (cfgOf(a).autonomy_settings.manual_leads_mode) await proposePushes(a, campaigns);
    else for (const c of campaigns) await keepStocked(a, c);
    await reviewPerformance(a, campaigns);
    await dailyReport(a);
  } catch (err) {
    console.error(`[sales-agent] ${agentId}:`, err);
    await warnOnce(a ?? claimed, "decision_error", `The agent hit a problem and will retry: ${aiErrorMessage(err)}`);
  }
}

/**
 * Starts the agent's campaigns that were never launched (made while it was off, or before mailboxes were picked) once
 * they can send, and says what holds back the ones that can't.
 */
export async function launchReadyCampaigns(a: SalesAgentRow) {
  for (const c of await agentCampaigns(a)) {
    if (c.status !== CampaignStatus.DRAFT) continue;
    const problems = await launchProblems(c);
    if (!problems.length) await setCampaignStatus(c, CampaignStatus.ACTIVE);
    else await warnOnce(a, `launch:${c.id}`, `"${c.name}" is ready but can't start yet: ${problems[0]}`, { campaign_id: c.id });
  }
}

/** Turning the agent off pauses its sending campaigns, and replies it queued on its own go back for review. */
export async function agentTurnedOff(a: SalesAgentRow) {
  const paused: string[] = [];
  for (const c of await agentCampaigns(a)) {
    if (c.status !== CampaignStatus.ACTIVE) continue;
    await setCampaignStatus(c, CampaignStatus.PAUSED);
    paused.push(c.id);
  }
  // Turning it on again resumes just these, not campaigns paused for a reason (by someone, or for bounces).
  await setState(a, { paused_when_off: paused });
  await holdQueuedReplies(a.id);
}

/** Replies the agent queued to send by itself go back for review: it was turned off, or autopilot was. */
export async function holdQueuedReplies(agentId: string) {
  await db
    .update(ACT)
    .set({ actionStatus: "pending", approvedAt: null })
    .where(and(eq(ACT.aiSdrId, agentId), eq(ACT.actionType, "email_sent"), eq(ACT.actionStatus, "approved"), isNull(ACT.approvedBy)));
}

/** Turning it on resumes the campaigns it paused when it was turned off, and starts the ones it never could. */
export async function agentTurnedOn(a: SalesAgentRow) {
  const [fresh] = await db.select().from(S).where(eq(S.id, a.id)).limit(1);
  const agent = fresh ?? a;
  const list = cfgOf(agent)._state?.paused_when_off;
  for (const c of await agentCampaigns(agent)) {
    // Agents turned off before this was noted resume every paused campaign, as they used to.
    if (c.status !== CampaignStatus.PAUSED || (list && !list.includes(c.id))) continue;
    if (!(await launchProblems(c)).length) await setCampaignStatus(c, CampaignStatus.ACTIVE);
  }
  if (list?.length) await setState(agent, { paused_when_off: [] });
  await launchReadyCampaigns(agent);
}

/** Self-improvement: low reply rates get a new challenger variant; bounce spikes get a pause proposal. */
async function reviewPerformance(a: SalesAgentRow, campaigns: Array<typeof schema.campaigns.$inferSelect>) {
  const cfg = cfgOf(a);
  const since = Date.now() - 14 * 86_400_000;
  for (const c of campaigns.filter((x) => x.status === CampaignStatus.ACTIVE)) {
    const m = await aggregateMetrics(a.workspaceId, [c.id], { start: since });
    const sent = Number(m.emails_sent_count ?? 0);
    if (sent < 100) continue;
    // Out of the emails tried: an address refused at once was never sent, yet it bounced.
    const bounceRate = Math.min(1, Number(m.bounced_count ?? 0) / (sent + Number(m.emails_refused_count ?? 0)));
    // A pause the user turned down isn't proposed again for a week.
    if (bounceRate >= 0.05 && !(await proposedLately(a, "pause_campaign", c.id, 7))) {
      await propose(a, "pause_campaign", {
        actionPayload: { campaign_id: c.id, reason: "bounce_rate" },
        actionOutput: { campaign_name: c.name, bounce_rate: Math.round(bounceRate * 1000) / 10 },
        aiReasoning: `${Math.round(bounceRate * 100)}% of emails bounced in the last two weeks; pausing protects the sending mailboxes.`,
        aiConfidence: 0.9,
      });
      continue;
    }
    if (!a.selfImprovement) continue;
    const replyRate = Number(m.reply_count_unique ?? 0) / sent;
    const recentEdit = await db
      .select({ id: ACT.id })
      .from(ACT)
      .where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "edit_campaign"), gte(ACT.createdAt, new Date(Date.now() - 7 * 86_400_000)), sql`json_extract(${ACT.actionPayload}, '$.campaign_id') = ${c.id}`))
      .limit(1);
    if (replyRate >= 0.01 || recentEdit.length) continue;
    const icp = campaignIcp(cfg, c.id);
    if (!icp) continue;
    const first = c.sequences?.[0]?.steps?.[0]?.variants?.[0];
    const seq = await writeSequence(a.workspaceId, {
      memory: cfg.memory,
      icp,
      guidance: guidanceRules(cfg).map((r) => r.content),
      agentName: a.name,
      optOutLine: null,
      extraContext: `The current first email (subject "${first?.subject ?? ""}") got ${Math.round(replyRate * 1000) / 10}% replies over ${sent} sends. Write a clearly different angle.`,
    });
    const challenger = seq.steps[0]!;
    await propose(a, "edit_campaign", {
      actionPayload: { campaign_id: c.id, add_variant: { step: 0, subject: challenger.subject, body: challenger.body } },
      actionOutput: { campaign_name: c.name, change: "New first-email variant to test against the current one", subject: challenger.subject },
      aiReasoning: `Reply rate is ${Math.round(replyRate * 1000) / 10}% after ${sent} sends; a new angle is worth testing.`,
      aiConfidence: 0.6,
    });
  }
}

/** Daily Slack summary when a Slack connection is set: the first pass of each day on the workspace clock. */
async function dailyReport(a: SalesAgentRow) {
  const cfg = cfgOf(a);
  const today = await workspaceToday(a.workspaceId);
  if (!cfg.slack_connection_id || cfg._state?.last_report_on === today) return;
  const ids = (await agentCampaigns(a)).map((c) => c.id);
  const m = await aggregateMetrics(a.workspaceId, ids, { start: Date.now() - 86_400_000 });
  const [{ n: pending }] = (await db.select({ n: sql<number>`count(*)` }).from(ACT).where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionStatus, "pending")))) as [{ n: number }];
  const ok = await postToSlack(
    a.workspaceId,
    cfg.slack_connection_id,
    `${a.name} — last 24h: ${m.emails_sent_count ?? 0} sent, ${m.reply_count_unique ?? 0} replies, ${m.total_opportunities ?? 0} opportunities. ${Number(pending)} action(s) waiting for approval: ${env.webUrl}/app/ai-agents/sales/${a.id}`,
  );
  if (ok) await setState(a, { last_report_on: today });
}

export async function runSalesAgents() {
  // Work cut short by a restart is reported rather than left hanging.
  await db
    .update(ACT)
    .set({ actionStatus: "failed", completedAt: new Date(), errorCode: "temporary_failure", errorMessage: "Interrupted before it finished; the agent will try again" })
    .where(and(eq(ACT.actionStatus, "in_progress"), lt(ACT.executedAt, new Date(Date.now() - 15 * 60_000))));
  const agents = await db.select().from(S).where(and(eq(S.status, 1), or(isNull(S.nextDecisionAt), lte(S.nextDecisionAt, new Date())), await inUse(S.workspaceId)));
  for (const a of agents) await decide(a.id);
  // Approved work: bulk approvals, setup steps and autopilot replies once their human-like delay has passed. While an
  // agent is off its own queued work waits (without holding up anyone else's); what a person approved still runs.
  const due = await db
    .select({ row: ACT })
    .from(ACT)
    .innerJoin(S, eq(S.id, ACT.aiSdrId))
    .where(
      and(
        eq(ACT.actionStatus, "approved"),
        sql`coalesce(json_extract(${ACT.actionPayload}, '$.send_at'), 0) <= ${Date.now()}`,
        await inUse(ACT.workspaceId),
        or(eq(S.status, 1), isNotNull(ACT.approvedBy), eq(ACT.actionType, "initial_setup_scrape")),
      ),
    )
    .orderBy(ACT.createdAt)
    .limit(25);
  for (const { row } of due) {
    const [a] = await db.select().from(S).where(eq(S.id, row.aiSdrId)).limit(1);
    if (a) await execute(a, row);
  }
}

// ---------- Events from the agent's campaigns ----------

/** On autopilot, answers to messages older than this wait for review. */
const AUTO_REPLY_MAX_AGE_MS = 48 * 3_600_000;

async function agentForCampaign(workspaceId: string, campaignId: unknown) {
  if (!campaignId) return null;
  const [c] = await db.select({ aiSdrId: schema.campaigns.aiSdrId, name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.id, String(campaignId)), eq(schema.campaigns.workspaceId, workspaceId))).limit(1);
  if (!c?.aiSdrId) return null;
  const [a] = await db.select().from(S).where(eq(S.id, c.aiSdrId)).limit(1);
  return a ? { agent: a, campaignName: c.name } : null;
}

on("reply_received", async (ev) => {
  const hit = await agentForCampaign(ev.workspaceId, ev.data.campaign_id);
  if (!hit) return;
  const { agent: a, campaignName } = hit;
  await log(a, "reply_received", "completed", {
    emailId: String(ev.data.email_id ?? "") || null,
    actionPayload: { lead_id: ev.data.lead_id, campaign_id: ev.data.campaign_id },
    actionOutput: { lead_email: ev.data.lead_email, campaign_name: campaignName, snippet: String(ev.data.text ?? "").slice(0, 280) },
  });
  // Replies still waiting for this lead answer an older message: the new draft answers the whole thread.
  if (ev.data.lead_id) {
    const open = await db
      .select()
      .from(ACT)
      .where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "email_sent"), inArray(ACT.actionStatus, ["pending", "approved"]), sql`json_extract(${ACT.actionPayload}, '$.lead_id') = ${String(ev.data.lead_id)}`));
    for (const row of open) await dropReply(row, "lead_replied_again", ["pending", "approved"]);
  }
  const cfg = cfgOf(a);
  if (a.status !== 1 || !cfg.autonomy_settings.auto_reply_to_responses || !(await aiAvailable(a.workspaceId))) return;
  const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, String(ev.data.email_id))).limit(1);
  const [lead] = ev.data.lead_id ? await db.select().from(L).where(eq(L.id, String(ev.data.lead_id))).limit(1) : [];
  if (!email || !lead) return;
  // Nobody it may not email gets a draft: one it could never send.
  if (lead.status === LeadStatus.UNSUBSCRIBED || (await recipientRefusal(a.workspaceId, [lead.email, ...replyRecipients(email)], { campaignId: email.campaignId }))) return;
  const [account] = email.accountId ? await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, email.accountId)).limit(1) : [];
  const offers = cfg.memory.business_offers ?? [];
  const context = [
    `## Company\n${cfg.memory.company ?? ""}: ${cfg.memory.business_description ?? ""}`,
    offers.length ? `## Offers\n${offers.map((o) => `- ${o}`).join("\n")}` : "",
    cfg.position_details ? `## Role\n${cfg.position_details}` : "",
    cfg.investment_details ? `## Investment thesis\n${cfg.investment_details}` : "",
    cfg.research_details ? `## Research goals\n${cfg.research_details}` : "",
    cfg.partnership_details ? `## Partnership goals\n${cfg.partnership_details}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const draft = await draftReply({
      workspaceId: a.workspaceId,
      feature: "ai_sales_agent_reply",
      agentName: a.name,
      guidance: { text: guidanceRules(cfg).map((r) => `- ${r.title}: ${r.content}`).join("\n"), tone: "warm and professional", length: "one short paragraph" },
      context,
      thread: await threadMessages(email.threadId, email.id),
      lead: { first_name: lead.firstName, last_name: lead.lastName, company_name: lead.companyName, job_title: lead.jobTitle, email: lead.email, interest_status: lead.interestStatus },
      sender: { name: account ? `${account.firstName} ${account.lastName}`.trim() || account.email : email.eaccount, email: account?.email ?? email.eaccount },
    });
    if (draft.decision === "no_reply") return;
    // On autopilot only a recent message is answered without review (a mailbox that synced late waits for a person).
    const recent = email.timestampEmail.getTime() > Date.now() - AUTO_REPLY_MAX_AGE_MS;
    const auto = cfg.autonomy_settings.autopilot_mode && recent && draft.decision === "reply" && !draft.needsHuman && draft.confidence >= 70;
    await log(a, "email_sent", auto ? "approved" : "pending", {
      ...(auto ? { approvedAt: new Date() } : {}),
      actionPayload: { in_reply_to_email_id: email.id, lead_id: lead.id, campaign_id: ev.data.campaign_id, html: cleanReplyHtml(draft.html), send_at: Date.now() + (60 + Math.floor(Math.random() * 180)) * 1000 },
      actionOutput: { lead_email: lead.email, campaign_name: campaignName, reply_preview: draft.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280), information_requested: draft.informationRequested },
      aiReasoning: draft.needsHuman
        ? (draft.humanReason ?? "Needs a person")
        : draft.decision === "request_info"
          ? `Needs information: ${draft.informationRequested ?? ""}`
          : cfg.autonomy_settings.autopilot_mode && !recent
            ? "Answers a message from more than two days ago, so it waits for you."
            : "Answers the prospect's latest message.",
      aiConfidence: draft.confidence / 100,
    });
  } catch (err) {
    if (!(err instanceof AiRefusalError)) await warnOnce(a, "reply_error", `Could not draft a reply: ${aiErrorMessage(err)}`);
  }
});

on("lead_interest_changed", async (ev) => {
  const type = ({ 1: "opportunity_received", 2: "lead_meeting_booked", 4: "lead_closed" } as Record<number, ActionType>)[Number(ev.data.value)];
  if (!type) return;
  const hit = await agentForCampaign(ev.workspaceId, ev.data.campaign_id);
  if (!hit) return;
  await log(hit.agent, type, "completed", { actionPayload: { lead_id: ev.data.lead_id, campaign_id: ev.data.campaign_id, value: ev.data.value }, actionOutput: { lead_email: ev.data.lead_email, campaign_name: hit.campaignName } });
});

on("email_opened", async (ev) => {
  if (!ev.data.is_first) return;
  const hit = await agentForCampaign(ev.workspaceId, ev.data.campaign_id);
  if (!hit) return;
  const [lead] = ev.data.lead_id ? await db.select({ email: L.email }).from(L).where(eq(L.id, String(ev.data.lead_id))).limit(1) : [];
  await log(hit.agent, "email_opened", "completed", { actionPayload: { lead_id: ev.data.lead_id, campaign_id: ev.data.campaign_id, step: ev.data.step }, actionOutput: { lead_email: lead?.email ?? null, campaign_name: hit.campaignName } });
});

// The platform stopped one of the agent's campaigns (bounce protection, unhealthy accounts, suspension).
const STOP_REASONS: Record<number, string> = {
  [CampaignStatus.BOUNCE_PROTECT]: "was paused by bounce protection because too many emails bounced. Check the lead source and mailbox health, then resume it",
  [CampaignStatus.ACCOUNTS_UNHEALTHY]: "stopped because its sending accounts are unhealthy. Reconnect or replace them in Email Accounts",
  [CampaignStatus.ACCOUNT_SUSPENDED]: "stopped because the workspace's sending is suspended",
};
on("campaign_status_changed", async (ev) => {
  const reason = STOP_REASONS[Number(ev.data.status)];
  if (!reason) return;
  const hit = await agentForCampaign(ev.workspaceId, ev.data.campaign_id);
  if (!hit) return;
  await log(hit.agent, "warning", "completed", {
    actionPayload: { campaign_id: ev.data.campaign_id, status: ev.data.status },
    actionOutput: { campaign_name: hit.campaignName, message: `"${hit.campaignName}" ${reason}.` },
  });
});

on("campaign_completed", async (ev) => {
  const hit = await agentForCampaign(ev.workspaceId, ev.data.campaign_id);
  if (hit) await log(hit.agent, "campaign_completed", "completed", { actionPayload: { campaign_id: ev.data.campaign_id }, actionOutput: { campaign_name: hit.campaignName } });
});

// Leads someone uploads into the agent's campaigns (the agent's own moves don't emit lead_added).
on("lead_added", async (ev) => {
  const hit = await agentForCampaign(ev.workspaceId, ev.data.campaign_id);
  if (!hit) return;
  const recent = await db
    .select()
    .from(ACT)
    .where(and(eq(ACT.aiSdrId, hit.agent.id), eq(ACT.actionType, "imported_leads"), gte(ACT.createdAt, new Date(Date.now() - 10 * 60_000)), sql`json_extract(${ACT.actionPayload}, '$.campaign_id') = ${String(ev.data.campaign_id)}`))
    .orderBy(desc(ACT.createdAt))
    .limit(1);
  const count = Number(ev.data.count ?? 0);
  if (recent[0]) {
    const prev = Number((recent[0].actionOutput ?? {}).count ?? 0);
    await db.update(ACT).set({ actionOutput: { ...(recent[0].actionOutput ?? {}), count: prev + count } }).where(eq(ACT.id, recent[0].id));
  } else await log(hit.agent, "imported_leads", "completed", { actionPayload: { campaign_id: ev.data.campaign_id }, actionOutput: { campaign_name: hit.campaignName, count } });
});

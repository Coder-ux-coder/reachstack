// The copilot's tools. Each one acts through the app's own API as the signed-in user (see Invoke), so
// permissions, validation and audit logs are exactly what that user gets in the app. A tool returns what the
// model reads back and, separately, the card the chat shows.
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import {
  ACCOUNT_STATUS_LABELS,
  CAMPAIGN_STATUS_LABELS,
  EMPLOYEE_BANDS,
  FUNDING_TYPES,
  INDUSTRY_TREE,
  LF_DEPARTMENTS,
  LF_LEVELS,
  LF_NEWS_TYPES,
  REVENUE_BANDS,
} from "@reachstack/shared";
import { textToParagraphs } from "../agents/common";
import { daysBefore, daysBetween, workspaceToday, workspaceZone } from "../workspace-clock";
import type { CopilotSettings } from "./settings";

export class ToolError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** Calls the app's API as the user; throws ToolError with the API's message on 4xx/5xx. */
export type Invoke = <T = Record<string, unknown>>(method: Method, url: string, body?: unknown) => Promise<T>;

export interface ToolCtx {
  wsId: string;
  userId: string;
  threadId: string;
  timezone: string;
  settings: CopilotSettings;
  invoke: Invoke;
}

export interface ToolResult {
  /** What the model reads back. */
  content: unknown;
  /** What the chat card shows. */
  card?: Record<string, unknown>;
}

/** read: looks only. display: shows a card, changes nothing. write: changes data. question: waits for the user. */
export type ToolKind = "read" | "display" | "write" | "question";

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  kind: ToolKind;
  /** Shown while it runs ("Searching the lead database"). */
  working: string;
  /** Rough minutes a person would spend doing this by hand, for the time-saved count. */
  minutesSaved: number;
  /** One line for the approval card: what will happen (`names`: the campaign's name, looked up when there is one). */
  describe?: (input: never, names: Names) => string;
  run: (input: never, ctx: ToolCtx) => Promise<ToolResult>;
}

/** Names for a call's ids, so its approval line says "the campaign "Q3 push"" rather than an id. */
export interface Names {
  campaign: string | null;
}

const tool = <S extends z.ZodType>(d: {
  name: string;
  description: string;
  schema: S;
  kind: ToolKind;
  working: string;
  minutesSaved: number;
  describe?: (input: z.infer<S>, names: Names) => string;
  run: (input: z.infer<S>, ctx: ToolCtx) => Promise<ToolResult>;
}): ToolDef => d as unknown as ToolDef;

/** A call's line for its approval card, with the name of the campaign it's about (null without a describe). */
export async function describeAction(def: ToolDef, input: unknown, ctx: ToolCtx): Promise<string | null> {
  if (!def.describe) return null;
  const id = (input as { campaign_id?: unknown } | null)?.campaign_id;
  const campaign = typeof id === "string" && id ? await ctx.invoke<{ name?: string }>("GET", `/api/v2/campaigns/${encodeURIComponent(id)}`).then((c) => c.name ?? null, () => null) : null;
  try {
    return def.describe(input as never, { campaign });
  } catch {
    return null;
  }
}

// ---------- Shared shapes ----------

const BANDS = Object.keys(EMPLOYEE_BANDS) as [string, ...string[]];
const INDUSTRIES = Object.keys(INDUSTRY_TREE) as [string, ...string[]];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const leadFilters = z
  .object({
    job_titles: z.array(z.string().min(1).max(100)).max(25).optional().describe("Job titles to include (matched by contains), e.g. 'Head of Sales'"),
    exclude_job_titles: z.array(z.string().min(1).max(100)).max(25).optional(),
    levels: z.array(z.enum(LF_LEVELS)).optional(),
    departments: z.array(z.enum(LF_DEPARTMENTS)).optional(),
    locations: z.array(z.string().min(2).max(100)).max(25).optional().describe("Countries, states or cities, e.g. 'United States' or 'Austin, Texas'"),
    exclude_locations: z.array(z.string().min(2).max(100)).max(25).optional(),
    employee_counts: z.array(z.enum(BANDS)).optional(),
    revenue: z.array(z.enum(REVENUE_BANDS)).optional(),
    industries: z.array(z.enum(INDUSTRIES)).optional(),
    exclude_industries: z.array(z.enum(INDUSTRIES)).optional(),
    technologies: z.array(z.string().min(1).max(80)).max(25).optional().describe("Technologies the company uses, e.g. 'HubSpot'"),
    keywords: z.string().max(300).optional().describe("Company keywords, comma separated"),
    company_names: z.array(z.string().min(1).max(120)).max(50).optional(),
    domains: z.array(z.string().min(3).max(253)).max(100).optional(),
    news: z.array(z.enum(LF_NEWS_TYPES)).optional().describe("Recent company news types"),
    funding_types: z.array(z.enum(FUNDING_TYPES)).optional(),
  })
  .describe("Lead database filters. Leave out anything the user did not ask for.");
type LeadFilters = z.infer<typeof leadFilters>;

/** Copilot filter names to the Lead Finder (SuperSearch) filter shape. */
export function toSearchFilters(f: LeadFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.job_titles?.length || f.exclude_job_titles?.length) out.title = { include: f.job_titles ?? [], exclude: f.exclude_job_titles ?? [], includeMode: "CONTAINS", excludeMode: "CONTAINS" };
  if (f.levels?.length) out.level = f.levels;
  if (f.departments?.length) out.department = f.departments;
  if (f.locations?.length || f.exclude_locations?.length) out.locations = { include: f.locations ?? [], exclude: f.exclude_locations ?? [] };
  if (f.employee_counts?.length) out.employeeCount = f.employee_counts;
  if (f.revenue?.length) out.revenue = f.revenue;
  if (f.industries?.length || f.exclude_industries?.length) out.industry = { include: f.industries ?? [], exclude: f.exclude_industries ?? [] };
  if (f.technologies?.length) out.technologies = f.technologies;
  if (f.keywords?.trim()) out.keyword_filter = { include: f.keywords.trim(), include_mode: "ANY" };
  if (f.company_names?.length) out.company_name = { include: f.company_names };
  if (f.domains?.length) out.domains = f.domains;
  if (f.news?.length) out.news = f.news;
  if (f.funding_types?.length) out.funding_type = f.funding_types;
  return out;
}

const countFilters = (f: LeadFilters) => Object.values(f).filter((v) => (Array.isArray(v) ? v.length : typeof v === "string" ? v.trim() : v)).length;

const sequenceSteps = z
  .array(
    z.object({
      delay_days: z.number().int().min(0).max(30).describe("Days to wait after the previous email (0 for the first)"),
      variants: z
        .array(z.object({ subject: z.string().max(200).describe("Empty on follow-ups to reply in the same thread"), body: z.string().min(1).max(5_000).describe("Plain text; blank lines between paragraphs") }))
        .min(1)
        .max(3),
    }),
  )
  .min(1)
  .max(8);
type Steps = z.infer<typeof sequenceSteps>;

/** Copilot steps (wait before each email) to campaign steps (wait after each email before the next). */
export function toCampaignSteps(steps: Steps) {
  return steps.map((s, i) => ({
    type: "email" as const,
    delay: i + 1 < steps.length ? Math.max(1, steps[i + 1]!.delay_days || 1) : 2,
    delay_unit: "days" as const,
    variants: s.variants.map((v) => ({ subject: v.subject.trim(), body: textToParagraphs(v.body) })),
  }));
}

const pct = (n: number, d: number) => (d ? Math.min(100, Math.round((n / d) * 1000) / 10) : 0);
const campaignLabel = (s: unknown) => CAMPAIGN_STATUS_LABELS[Number(s)] ?? String(s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Every item of a list, `perPage` at a time (the most the list takes), up to `max`, and whether there were more. */
async function everyPage(ctx: ToolCtx, path: string, perPage: number, max = 10_000): Promise<{ items: Row[]; more: boolean }> {
  const items: Row[] = [];
  let after: string | null | undefined = null;
  do {
    const q = new URLSearchParams({ limit: String(perPage), ...(after ? { starting_after: after } : {}) });
    const page: PageOf = await ctx.invoke<PageOf>("GET", `${path}${path.includes("?") ? "&" : "?"}${q}`);
    items.push(...page.items);
    after = page.items.length ? page.next_starting_after : null;
  } while (after && items.length < max);
  return { items, more: !!after };
}

async function safely<T>(f: () => Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await f();
  } catch (err) {
    return { unavailable: (err as Error).message };
  }
}

type Row = Record<string, unknown>;
interface PageOf {
  items: Row[];
  next_starting_after?: string | null;
}

// ---------- Tools ----------

const getOverview = tool({
  name: "get_workspace_overview",
  description:
    "Snapshot of the workspace: email accounts by status and warmup, campaigns by status, sending results for the last 30 days, and AI agents. Use it first for audits and general questions about how things are going.",
  schema: z.object({}),
  kind: "read",
  working: "Reviewing your workspace",
  minutesSaved: 10,
  run: async (_i, ctx) => {
    // The last 30 days on the workspace clock, the days analytics count by.
    const end = await workspaceToday(ctx.wsId);
    const start = daysBefore(end, 29);
    const [accounts, campaigns, totals, agents] = await Promise.all([
      safely(() => everyPage(ctx, "/api/v2/accounts", 1000)),
      safely(() => everyPage(ctx, "/api/v2/campaigns", 100)),
      safely(() => ctx.invoke<Row>("GET", `/api/v2/campaigns/analytics/overview?start_date=${start}&end_date=${end}`)),
      safely(() => ctx.invoke<{ items: Row[] }>("GET", "/api/app/ai-agents")),
    ]);
    const acc = "items" in accounts ? accounts.items : [];
    const camp = "items" in campaigns ? campaigns.items : [];
    const count = (rows: Row[], key: string) => rows.reduce<Record<string, number>>((m, r) => ((m[String(r[key])] = (m[String(r[key])] ?? 0) + 1), m), {});
    const accountsByStatus = Object.fromEntries(Object.entries(count(acc, "status")).map(([k, v]) => [ACCOUNT_STATUS_LABELS[Number(k)] ?? k, v]));
    const campaignsByStatus = Object.fromEntries(Object.entries(count(camp, "status")).map(([k, v]) => [campaignLabel(k), v]));
    const warmupOn = acc.filter((a) => Number(a.warmup_status) === 1).length;
    const scores = acc.map((a) => Number(a.stat_warmup_score)).filter((n) => Number.isFinite(n) && n > 0);
    const t = "unavailable" in totals ? null : totals;
    const sent = Number(t?.emails_sent_count ?? 0);
    const summary = {
      email_accounts:
        "unavailable" in accounts
          ? accounts
          : { total: acc.length, by_status: accountsByStatus, warmup_on: warmupOn, average_warmup_score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null, ...(accounts.more ? { counted_first: acc.length } : {}) },
      campaigns: "unavailable" in campaigns ? campaigns : { total: camp.length, by_status: campaignsByStatus, ...(campaigns.more ? { counted_first: camp.length } : {}) },
      last_30_days: t
        ? {
            emails_sent: sent,
            leads_contacted: t.contacted_count,
            unique_opens: t.open_count_unique,
            unique_replies: t.reply_count_unique,
            reply_rate_pct: pct(Number(t.reply_count_unique ?? 0), Number(t.contacted_count ?? 0)),
            bounced: t.bounced_count,
            // Out of the emails tried: an address refused at once was never sent, yet it bounced.
            bounce_rate_pct: pct(Number(t.bounced_count ?? 0), sent + Number(t.emails_refused_count ?? 0)),
            opportunities: t.total_opportunities,
            opportunity_value: t.total_opportunity_value,
            meetings_booked: t.total_meeting_booked,
          }
        : totals,
      ai_agents: "unavailable" in agents ? agents : agents.items.map((a) => ({ kind: a.kind, name: a.name, status: a.status })),
    };
    return {
      content: summary,
      card: {
        type: "overview",
        accounts: { total: acc.length, active: accountsByStatus.Active ?? 0, errors: acc.filter((a) => Number(a.status) < 0).length, warmup_on: warmupOn },
        campaigns: { total: camp.length, active: campaignsByStatus.Active ?? 0, paused: campaignsByStatus.Paused ?? 0, drafts: campaignsByStatus.Draft ?? 0 },
        last_30_days: t ? { sent, replies: Number(t.reply_count_unique ?? 0), opportunities: Number(t.total_opportunities ?? 0), value: Number(t.total_opportunity_value ?? 0) } : null,
        agents: "unavailable" in agents ? null : agents.items.length,
      },
    };
  },
});

const listCampaigns = tool({
  name: "list_campaigns",
  description: "Lists campaigns with their status. Use it to find a campaign's id by name.",
  schema: z.object({
    search: z.string().max(100).optional(),
    status: z.enum(["draft", "active", "paused", "completed"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  kind: "read",
  working: "Looking up campaigns",
  minutesSaved: 1,
  run: async (i, ctx) => {
    const status = i.status ? { draft: 0, active: 1, paused: 2, completed: 3 }[i.status] : undefined;
    const q = new URLSearchParams({ limit: String(i.limit ?? 50) });
    if (i.search) q.set("search", i.search);
    if (status !== undefined) q.set("status", String(status));
    const page = await ctx.invoke<PageOf>("GET", `/api/v2/campaigns?${q}`);
    const items = page.items.map((c) => ({ id: c.id, name: c.name, status: campaignLabel(c.status), daily_limit: c.daily_limit ?? null, created: c.timestamp_created }));
    return { content: { campaigns: items, more: !!page.next_starting_after }, card: { type: "campaigns", items: items.slice(0, 25), total: items.length } };
  },
});

const campaignAnalytics = tool({
  name: "get_campaign_analytics",
  description:
    "Sending results per campaign for a date range: emails sent, leads contacted, unique opens and replies, bounces, opportunities and their value. Leave campaign_ids out for every campaign. Set include_daily for a day-by-day series.",
  schema: z.object({
    campaign_ids: z.array(z.string()).max(50).optional(),
    start_date: day.optional().describe("Defaults to 7 days ago"),
    end_date: day.optional().describe("Defaults to today"),
    include_daily: z.boolean().optional(),
  }),
  kind: "read",
  working: "Pulling campaign analytics",
  minutesSaved: 5,
  run: async (i, ctx) => {
    const end = i.end_date ?? (await workspaceToday(ctx.wsId));
    const start = i.start_date ?? daysBefore(end, 6);
    const q = new URLSearchParams({ start_date: start, end_date: end });
    for (const id of i.campaign_ids ?? []) q.append("ids", id);
    const rows = await ctx.invoke<Row[]>("GET", `/api/v2/campaigns/analytics?${q}`);
    const shaped = rows.map((r) => {
      const contacted = Number(r.contacted_count ?? 0);
      return {
        id: r.campaign_id,
        name: r.campaign_name,
        status: campaignLabel(r.campaign_status),
        leads: r.leads_count,
        emails_sent: Number(r.emails_sent_count ?? 0),
        contacted,
        unique_opens: Number(r.open_count_unique ?? 0),
        open_rate_pct: pct(Number(r.open_count_unique ?? 0), contacted),
        unique_replies: Number(r.reply_count_unique ?? 0),
        reply_rate_pct: pct(Number(r.reply_count_unique ?? 0), contacted),
        bounced: Number(r.bounced_count ?? 0),
        opportunities: Number(r.total_opportunities ?? 0),
        opportunity_value: Number(r.total_opportunity_value ?? 0),
      };
    });
    const sum = (k: keyof (typeof shaped)[number]) => shaped.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    const totals = { emails_sent: sum("emails_sent"), contacted: sum("contacted"), unique_opens: sum("unique_opens"), unique_replies: sum("unique_replies"), bounced: sum("bounced"), opportunities: sum("opportunities"), opportunity_value: sum("opportunity_value") };
    // The card always charts the days when the range is short enough; the model only gets them on request.
    const days = daysBetween(start, end) + 1;
    let daily: Row[] | undefined;
    if (i.include_daily || (days >= 2 && days <= 92)) {
      const dq = new URLSearchParams({ start_date: start, end_date: end });
      for (const id of i.campaign_ids ?? []) dq.append("ids", id);
      daily = await ctx.invoke<Row[]>("GET", `/api/v2/campaigns/analytics/daily?${dq}`).catch(() => undefined);
    }
    return {
      content: { range: { start, end }, totals, campaigns: shaped, ...(daily && i.include_daily ? { daily } : {}) },
      card: { type: "analytics", range: { start, end }, totals, rows: shaped.slice(0, 30), ...(daily ? { daily: daily.slice(-92) } : {}) },
    };
  },
});

const listAccounts = tool({
  name: "list_email_accounts",
  description: "Lists sending email accounts with status, warmup state, warmup health score and daily limit. Use it to check deliverability problems.",
  schema: z.object({ only_problems: z.boolean().optional().describe("Only accounts with errors, paused warmup or a low warmup score") }),
  kind: "read",
  working: "Checking email accounts",
  minutesSaved: 3,
  run: async (i, ctx) => {
    const page = await everyPage(ctx, "/api/v2/accounts", 1000);
    let items = page.items.map((a) => ({
      email: a.email,
      status: ACCOUNT_STATUS_LABELS[Number(a.status)] ?? String(a.status),
      warmup: Number(a.warmup_status) === 1 ? "on" : Number(a.warmup_status) === 0 ? "off" : "problem",
      warmup_score: a.stat_warmup_score ?? null,
      daily_limit: a.daily_limit ?? null,
      error: Number(a.status) < 0,
    }));
    if (i.only_problems) items = items.filter((a) => a.error || a.warmup !== "on" || (typeof a.warmup_score === "number" && a.warmup_score < 80));
    // Problems first, so a long list still shows them.
    items.sort((a, b) => Number(b.error) - Number(a.error) || Number(b.warmup !== "on") - Number(a.warmup !== "on"));
    const shown = items.slice(0, 300);
    return {
      content: { total: items.length, accounts: shown, ...(shown.length < items.length ? { listed: `the first ${shown.length}, problems first` } : {}), ...(page.more ? { counted_first: page.items.length } : {}) },
      card: { type: "accounts", items: items.slice(0, 50), total: items.length },
    };
  },
});

const listReplies = tool({
  name: "list_recent_replies",
  description: "Latest replies from leads in the Unibox, newest first, with the lead's interest status when it is set.",
  schema: z.object({ limit: z.number().int().min(1).max(25).optional(), campaign_id: z.string().optional(), unread_only: z.boolean().optional() }),
  kind: "read",
  working: "Reading recent replies",
  minutesSaved: 4,
  run: async (i, ctx) => {
    const q = new URLSearchParams({ email_type: "received", limit: String(i.limit ?? 10), latest_of_thread: "true", mode: "emode_focused", preview_only: "true" });
    if (i.campaign_id) q.set("campaign_id", i.campaign_id);
    if (i.unread_only) q.set("is_unread", "true");
    const page = await ctx.invoke<PageOf>("GET", `/api/v2/emails?${q}`);
    const items = page.items.map((e) => ({
      thread_id: e.thread_id,
      from: e.from_address_email ?? e.lead,
      subject: e.subject,
      snippet: String((e.body as Row | undefined)?.text ?? e.content_preview ?? "").replace(/\s+/g, " ").slice(0, 280),
      at: e.timestamp_email ?? e.timestamp_created,
      campaign: e.campaign_name ?? null,
      interest_status: e.i_status ?? null,
    }));
    return { content: { replies: items }, card: { type: "replies", items } };
  },
});

const listAgents = tool({
  name: "list_ai_agents",
  description: "Lists the workspace's AI agents (sales, reply, lead finder, deliverability) with their status.",
  schema: z.object({}),
  kind: "read",
  working: "Checking AI agents",
  minutesSaved: 1,
  run: async (_i, ctx) => {
    const r = await ctx.invoke<{ items: Row[] }>("GET", "/api/app/ai-agents");
    const items = r.items.map((a) => ({ id: a.id, kind: a.kind, name: a.name, status: Number(a.status) === 1 ? "active" : Number(a.status) === 0 ? "paused" : "error", stats: a.stats ?? null }));
    return { content: { agents: items }, card: { type: "agents", items } };
  },
});

const searchLeads = tool({
  name: "search_lead_database",
  description:
    "Counts and previews people in the lead database who match filters, and shows the user a filter card they can open in Lead Finder. Use it to suggest lead lists. It does not add leads anywhere.",
  schema: z.object({ filters: leadFilters, explanation: z.string().max(500).describe("One sentence on who these filters target") }),
  kind: "read",
  working: "Searching the lead database",
  minutesSaved: 5,
  run: async (i, ctx) => {
    if (!countFilters(i.filters)) throw new ToolError("Add at least one filter.");
    const search_filters = toSearchFilters(i.filters);
    const r = await ctx.invoke<{ total: number; items: Row[] }>("POST", "/api/app/lead-finder/search", { filters: search_filters, page: 1, page_size: 8, record_history: false });
    const preview = r.items.map((p) => ({
      name: p.full_name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || ""),
      title: p.title ?? "",
      company: (p.company as Row | null | undefined)?.name ?? "",
      location: p.location ?? "",
    }));
    return {
      content: { total_matches: r.total, sample: preview.slice(0, 5), note: r.total ? undefined : "No matches. Suggest broader filters." },
      card: { type: "lead_filters", filters: i.filters, search_filters, total: r.total, preview, explanation: i.explanation },
    };
  },
});

const proposeSequence = tool({
  name: "propose_sequence",
  description:
    "Shows the user an email sequence as a card with a 'Use in a campaign' button (they pick or create the campaign). Use it whenever you write a sequence instead of pasting emails into the chat. It creates nothing by itself.",
  schema: z.object({
    campaign_name: z.string().min(1).max(120),
    steps: sequenceSteps,
    notes: z.string().max(600).optional().describe("Why the sequence is built this way, in one or two sentences"),
  }),
  kind: "display",
  working: "Writing the sequence",
  minutesSaved: 20,
  run: async (i) => ({
    content: { shown: true, emails: i.steps.length, note: "The user sees the sequence and can add it to a campaign from the card. Don't repeat the emails in your reply." },
    card: { type: "sequence", campaign_name: i.campaign_name, steps: i.steps, notes: i.notes ?? null },
  }),
});

const askUser = tool({
  name: "ask_user_question",
  description:
    "Asks the user one to four multiple-choice questions in a card and waits for the answers. Use it when a choice would change what you do (audience, tone, which campaign); don't use it for open-ended questions.",
  schema: z.object({
    questions: z
      .array(
        z.object({
          header: z.string().min(1).max(24).describe("Short tab label, e.g. 'Audience'"),
          question: z.string().min(3).max(300),
          options: z.array(z.object({ label: z.string().min(1).max(80), description: z.string().max(200).optional() })).min(2).max(6),
          multi_select: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
  kind: "question",
  working: "Preparing a question",
  minutesSaved: 0,
  run: async (i) => ({ content: null, card: { type: "questions", questions: i.questions } }),
});

const createCampaign = tool({
  name: "create_campaign",
  description:
    "Creates a draft campaign with a sequence and sending schedule. It does not start sending and adds no leads. Use the sequence you proposed unless the user asked for changes.",
  schema: z.object({
    name: z.string().min(1).max(250),
    steps: sequenceSteps,
    schedule: z
      .object({
        timezone: z.string().describe("IANA timezone, e.g. America/New_York"),
        days: z.array(z.number().int().min(0).max(6)).min(1).describe("0 = Sunday"),
        from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
      .optional()
      .describe("Defaults to weekdays 9:00-17:00 in the workspace's timezone"),
    daily_limit: z.number().int().min(1).max(10_000).optional(),
    sending_accounts: z.array(z.string().email()).max(100).optional().describe("Emails of the user's sending accounts to use"),
  }),
  kind: "write",
  working: "Creating the campaign",
  minutesSaved: 15,
  describe: (i) => `Create a draft campaign "${i.name}" with ${plural(i.steps.length, "email")}`,
  run: async (i, ctx) => {
    const s = i.schedule ?? { timezone: await workspaceZone(ctx.wsId), days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };
    const days = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), s.days.includes(d)]));
    const created = await ctx.invoke<Row>("POST", "/api/v2/campaigns", {
      name: i.name,
      campaign_schedule: { schedules: [{ name: "Working hours", timing: { from: s.from, to: s.to }, days, timezone: s.timezone }] },
      sequences: [{ steps: toCampaignSteps(i.steps) }],
      ...(i.daily_limit ? { daily_limit: i.daily_limit } : {}),
      ...(i.sending_accounts?.length ? { email_list: i.sending_accounts } : {}),
    });
    return {
      content: { campaign_id: created.id, name: created.name, status: "Draft", next: "Add leads and sending accounts, then activate it." },
      card: { type: "campaign_created", id: created.id, name: created.name, emails: i.steps.length },
    };
  },
});

const setCampaignStatus = tool({
  name: "set_campaign_status",
  description: "Starts (activates) or pauses a campaign.",
  schema: z.object({ campaign_id: z.string().min(1), action: z.enum(["activate", "pause"]) }),
  kind: "write",
  working: "Updating the campaign",
  minutesSaved: 1,
  describe: (i, n) => `${i.action === "activate" ? "Start sending" : "Pause"} ${n.campaign ? `the campaign "${n.campaign}"` : `campaign ${i.campaign_id}`}`,
  run: async (i, ctx) => {
    const c = await ctx.invoke<Row>("GET", `/api/v2/campaigns/${encodeURIComponent(i.campaign_id)}`);
    const after = await ctx.invoke<Row>("POST", `/api/v2/campaigns/${encodeURIComponent(i.campaign_id)}/${i.action}`);
    return { content: { campaign: c.name, status: campaignLabel(after.status) }, card: { type: "campaign_status", id: c.id, name: c.name, status: campaignLabel(after.status) } };
  },
});

const addLeads = tool({
  name: "add_leads_from_search",
  description:
    "Finds emails for people matching lead filters and adds them to a new lead list or an existing campaign. Uses lead credits. The import runs in the background.",
  schema: z.object({
    filters: leadFilters,
    limit: z.number().int().min(1).max(50_000).describe("How many leads to add"),
    campaign_id: z.string().optional().describe("Add to this campaign; otherwise a new list is created"),
    list_name: z.string().max(200).optional(),
  }),
  kind: "write",
  working: "Finding emails and adding leads",
  minutesSaved: 20,
  describe: (i, n) =>
    `Find emails for up to ${i.limit.toLocaleString("en-US")} leads and add them to ${i.campaign_id ? (n.campaign ? `the campaign "${n.campaign}"` : "the campaign") : `a new list${i.list_name ? ` "${i.list_name}"` : ""}`}`,
  run: async (i, ctx) => {
    if (!countFilters(i.filters)) throw new ToolError("Add at least one filter.");
    // The cap is for WARP mode, which adds without asking: approved one by one, a request is added in full.
    const warp = ctx.settings.execute_tools && ctx.settings.warp_mode;
    const limit = warp ? Math.min(i.limit, ctx.settings.enrich_leads_limit) : i.limit;
    const r = await ctx.invoke<Row>("POST", "/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", {
      search_filters: toSearchFilters(i.filters),
      limit,
      work_email_enrichment: true,
      skip_rows_without_email: true,
      ...(i.campaign_id ? { resource_id: i.campaign_id } : { list_name: i.list_name }),
    });
    const resourceId = String(r.resource_id ?? i.campaign_id ?? "");
    const kind = i.campaign_id ? "campaign" : "list";
    return {
      content: { started: true, adding_up_to: limit, ...(limit < i.limit ? { capped_by_setting: `WARP mode adds at most ${ctx.settings.enrich_leads_limit} leads at once` } : {}), destination: kind, id: resourceId },
      card: { type: "leads_import", destination: kind, id: resourceId, name: r.list_name ?? i.list_name ?? null, limit },
    };
  },
});

const createSalesAgent = tool({
  name: "create_ai_sales_agent",
  description:
    "Creates an AI Sales Agent that learns the business, finds leads and runs campaigns on its own. It uses the business details in memory, or a website when given one. It starts paused for the user to review.",
  schema: z.object({ name: z.string().min(1).max(200), website: z.string().url().optional() }),
  kind: "write",
  working: "Creating your AI Sales Agent",
  minutesSaved: 30,
  describe: (i) => `Create an AI Sales Agent "${i.name}"${i.website ? ` from ${i.website}` : " from your business details"}`,
  run: async (i, ctx) => {
    const a = await ctx.invoke<Row>("POST", "/api/v2/ai-agents/sales", i.website ? { name: i.name, type: "website", input: i.website } : { name: i.name, memory_from_workspace: true });
    return {
      content: { agent_id: a.id, name: a.name, next: "The user reviews the agent's plan and turns it on." },
      card: { type: "agent_created", agent: "sales", id: a.id, name: a.name, url: `/app/ai-sales-agent/${a.id}` },
    };
  },
});

const createLeadFinderAgent = tool({
  name: "create_lead_finder_agent",
  description: "Creates an AI Lead Finder Agent that keeps a campaign topped up with fresh leads matching filters.",
  schema: z.object({
    name: z.string().min(1).max(200),
    campaign_id: z.string().min(1),
    filters: leadFilters,
    min_active_leads: z.number().int().min(1).max(100_000).optional().describe("Top up when the campaign has fewer leads left than this (default 100)"),
    on_exhaustion: z.enum(["pause", "broaden"]).optional().describe("What to do when no leads are left (default pause)"),
  }),
  kind: "write",
  working: "Setting up the Lead Finder Agent",
  minutesSaved: 20,
  describe: (i, n) => `Create a Lead Finder Agent "${i.name}" that keeps ${n.campaign ? `"${n.campaign}"` : "the campaign"} stocked with ${i.min_active_leads ?? 100}+ leads`,
  run: async (i, ctx) => {
    if (!countFilters(i.filters)) throw new ToolError("Add at least one filter.");
    const a = await ctx.invoke<Row>("POST", "/api/v2/ai-agents/lead-finder", {
      name: i.name,
      campaign_id: i.campaign_id,
      search_filters: toSearchFilters(i.filters),
      min_active_leads: i.min_active_leads ?? 100,
      on_exhaustion: i.on_exhaustion ?? "pause",
    });
    return { content: { agent_id: a.id, name: a.name }, card: { type: "agent_created", agent: "lead_finder", id: a.id, name: a.name, url: `/app/ai-agents/${a.id}` } };
  },
});

const createReplyAgent = tool({
  name: "create_reply_agent",
  description: "Creates an AI Reply Agent that drafts replies to leads, for the user to review (review) or sent automatically (autopilot).",
  schema: z.object({ name: z.string().min(1).max(200), mode: z.enum(["review", "autopilot"]), handle_followups: z.boolean().optional() }),
  kind: "write",
  working: "Setting up the Reply Agent",
  minutesSaved: 15,
  describe: (i) => `Create a Reply Agent "${i.name}" that ${i.mode === "autopilot" ? "sends replies automatically" : "drafts replies for you to review"}`,
  run: async (i, ctx) => {
    const a = await ctx.invoke<Row>("POST", "/api/v2/ai-agents/inbox-manager", { name: i.name, payload: { configuration_type: i.mode === "autopilot" ? 2 : 1, handle_followup: !!i.handle_followups } });
    return { content: { agent_id: a.id, name: a.name }, card: { type: "agent_created", agent: "reply", id: a.id, name: a.name, url: `/app/ai-agents/${a.id}/configuration` } };
  },
});

const deployDeliverability = tool({
  name: "deploy_deliverability_agent",
  description: "Turns on the AI Deliverability Agent, which checks sending accounts, DNS and blocklists on a schedule and flags problems.",
  schema: z.object({}),
  kind: "write",
  working: "Deploying the Deliverability Agent",
  minutesSaved: 10,
  describe: () => "Turn on the Deliverability Agent for this workspace",
  run: async (_i, ctx) => {
    const r = await ctx.invoke<{ agent: Row; already_deployed: boolean }>("POST", "/api/v2/ai-agents/deliverability/deploy", {});
    return {
      content: { agent_id: r.agent.id, already_active: r.already_deployed },
      card: { type: "agent_created", agent: "deliverability", id: r.agent.id, name: r.agent.name, url: "/app/ai-agents/deliverability", already: r.already_deployed },
    };
  },
});

const saveMemory = tool({
  name: "save_business_details",
  description:
    "Saves business details to memory so future chats and agents use them: company, description, offers, outreach goal, an ideal customer profile, or writing rules. Only save what the user stated or confirmed.",
  schema: z.object({
    company: z.string().max(500).optional(),
    website: z.string().max(500).optional(),
    business_description: z.string().max(5_000).optional(),
    add_offers: z.array(z.string().min(1).max(500)).max(10).optional(),
    outreach_goal: z.string().max(500).optional(),
    add_icp: z
      .object({
        name: z.string().min(1).max(200),
        job_titles: z.array(z.string().min(1).max(100)).max(20).optional(),
        industries: z.array(z.enum(INDUSTRIES)).optional(),
        company_sizes: z.array(z.enum(BANDS)).optional(),
        locations: z.array(z.string().min(1).max(100)).max(20).optional(),
        problems_solved: z.array(z.string().min(1).max(300)).max(10).optional(),
        benefits: z.array(z.string().min(1).max(300)).max(10).optional(),
      })
      .optional(),
    add_rules: z.array(z.string().min(1).max(500)).max(5).optional(),
  }),
  kind: "write",
  working: "Saving to memory",
  minutesSaved: 5,
  describe: (i) => {
    const parts = [i.company && "company", i.business_description && "description", i.add_offers?.length && "offers", i.outreach_goal && "outreach goal", i.add_icp && `ICP "${i.add_icp.name}"`, i.add_rules?.length && "rules"].filter(Boolean);
    return `Save ${parts.join(", ") || "details"} to your business memory`;
  },
  run: async (i, ctx) => {
    const cur = (await ctx.invoke<{ memory: Record<string, unknown> | null }>("GET", "/api/app/copilot/memory")).memory ?? {};
    const next: Record<string, unknown> = { ...cur };
    if (i.company) next.company = i.company;
    if (i.website) next.website = i.website;
    if (i.business_description) next.business_description = i.business_description;
    if (i.outreach_goal) next.outreach_goal = i.outreach_goal;
    const offers = (cur.business_offers as string[] | undefined) ?? [];
    const icps = (cur.icps as Array<{ name?: string }> | undefined) ?? [];
    const rules = (cur.custom_fields as string[] | undefined) ?? [];
    const known = (list: string[]) => new Set(list.map((s) => s.trim().toLowerCase()));
    const newOffers = [...new Set((i.add_offers ?? []).map((o) => o.trim()))].filter((o) => !known(offers).has(o.toLowerCase()));
    const newRules = [...new Set((i.add_rules ?? []).map((r) => r.trim()))].filter((r) => !known(rules).has(r.toLowerCase()));
    const full = [
      offers.length + newOffers.length > 20 && `${offers.length} of 20 offers`,
      i.add_icp && icps.length >= 10 && `${icps.length} of 10 customer profiles`,
      rules.length + newRules.length > 10 && `${rules.length} of 10 rules`,
    ].filter(Boolean);
    if (full.length) throw new ToolError(`Memory is full (${full.join(", ")}): nothing was saved. Remove some in Copilot → Memory, or save fewer.`);
    // What the user switched off stays off, and what's added is on (no list of what's on means all of it).
    const on = (key: string, count: number, added: number) => [...((cur[key] as number[] | undefined) ?? Array.from({ length: count }, (_, k) => k)), ...Array.from({ length: added }, (_, k) => count + k)];
    if (newOffers.length) {
      next.business_offers = [...offers, ...newOffers];
      next.active_business_offers_indexes = on("active_business_offers_indexes", offers.length, newOffers.length);
    }
    if (newRules.length) next.custom_fields = [...rules, ...newRules];
    if (i.add_icp) {
      const icp = {
        name: i.add_icp.name,
        job_title: { include: i.add_icp.job_titles ?? [], exclude: [] },
        industry: i.add_icp.industries ?? [],
        company_size: i.add_icp.company_sizes ?? [],
        location: i.add_icp.locations ?? [],
        problems_solved: i.add_icp.problems_solved ?? [],
        benefits: i.add_icp.benefits ?? [],
      };
      next.icps = [...icps, icp];
      next.active_icps_indexes = on("active_icps_indexes", icps.length, 1);
    }
    await ctx.invoke("PUT", "/api/app/copilot/memory", { memory: next });
    const fields = Object.keys(i).filter((k) => (i as Record<string, unknown>)[k] !== undefined);
    return { content: { saved: fields }, card: { type: "memory_saved", fields } };
  },
});

const createTask = tool({
  name: "create_recurring_task",
  description:
    "Schedules a prompt to run again automatically (daily, weekly or monthly), for example a weekly analytics summary. Each run opens a new chat with the answer and can notify Slack.",
  schema: z.object({
    title: z.string().min(1).max(120),
    prompt: z.string().min(3).max(4_000).describe("What to do on each run, written as the user would ask it"),
    frequency: z.enum(["daily", "weekly", "monthly"]),
    time_of_day: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("24h time in the user's timezone, default 09:00"),
  }),
  kind: "write",
  working: "Scheduling the task",
  minutesSaved: 2,
  describe: (i) => `Run "${i.title}" ${i.frequency} at ${i.time_of_day ?? "09:00"}`,
  run: async (i, ctx) => {
    const t = await ctx.invoke<Row>("POST", "/api/app/copilot/tasks", { title: i.title, prompt: i.prompt, frequency: i.frequency, time_of_day: i.time_of_day ?? "09:00", timezone: ctx.timezone, source_thread_id: ctx.threadId });
    return { content: { task_id: t.id, next_run_at: t.next_run_at }, card: { type: "task_created", id: t.id, title: t.title, frequency: t.frequency, next_run_at: t.next_run_at } };
  },
});

const dfyItem = z.object({
  domain: z.string().min(3).max(253),
  email_provider: z.union([z.literal(1), z.literal(2)]).optional().describe("1 Google, 2 Microsoft (default 1)"),
  forwarding_domain: z.string().max(253).optional().describe("The user's main website, where visitors to the new domain are sent"),
  accounts: z.array(z.object({ email_address_prefix: z.string().min(1).max(64), first_name: z.string().min(1).max(80), last_name: z.string().min(1).max(80) })).max(5),
});

const quoteDfy = tool({
  name: "quote_dfy_order",
  description:
    "Prices an order for new sending domains with ready-made mailboxes (done-for-you email accounts) and shows the user a quote card. Nothing is ordered until the user presses Place order on the card. Up to 5 mailboxes per domain; use pre_warmed_up for domains from the pre-warmed inventory (mailboxes included).",
  schema: z.object({ order_type: z.enum(["dfy", "pre_warmed_up"]), items: z.array(dfyItem).min(1).max(20) }),
  kind: "display",
  working: "Checking price",
  minutesSaved: 10,
  run: async (i, ctx) => {
    const order = { order_type: i.order_type, items: i.items.map((it) => ({ ...it, email_provider: it.email_provider ?? 1 })) };
    const q = await ctx.invoke<Row>("POST", "/api/v2/dfy-email-account-orders", { ...order, simulation: true });
    const valid = !!q.order_is_valid;
    const quote = {
      valid,
      ...quoteProblems(q),
      due_now: q.total_price,
      monthly: q.total_accounts_price_per_month,
      yearly_domains: q.total_domains_price_per_year,
      items: q.order_items,
    };
    return {
      content: valid
        ? { quoted: true, due_now: quote.due_now, monthly: quote.monthly, yearly_domains: quote.yearly_domains, note: "The user confirms on the card. Don't say the order is placed." }
        : { quoted: false, problems: quote.problems, note: "Explain the problems and offer alternatives (for example other domain names)." },
      card: { type: "dfy_quote", order, quote, status: valid ? "quoted" : "invalid" },
    };
  },
});

/** Why a priced order can't be placed: the order's error and each list of domains or mailboxes with a problem. */
export function quoteProblems(q: Row): { error: unknown; problems: Record<string, unknown> } {
  const keys = ["unavailable_domains", "blacklist_domains", "invalid_domains", "invalid_forwarding_domains", "domains_without_accounts", "invalid_accounts"];
  return { error: q.order_error ?? null, problems: Object.fromEntries(keys.filter((k) => Array.isArray(q[k]) && (q[k] as unknown[]).length).map((k) => [k, q[k]])) };
}

export const TOOLS: ToolDef[] = [
  getOverview,
  listCampaigns,
  campaignAnalytics,
  listAccounts,
  listReplies,
  listAgents,
  searchLeads,
  proposeSequence,
  askUser,
  createCampaign,
  setCampaignStatus,
  addLeads,
  createSalesAgent,
  createLeadFinderAgent,
  createReplyAgent,
  deployDeliverability,
  saveMemory,
  createTask,
  quoteDfy,
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Whether a call runs right away or waits for the user's approval. */
export function needsApproval(t: ToolDef, s: CopilotSettings): boolean {
  if (t.kind === "question") return false;
  if (!s.execute_tools) return true;
  return t.kind === "write" && !s.warp_mode;
}

function inputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest as Anthropic.Beta.BetaTool.InputSchema;
}

let cached: { eager: boolean; params: Anthropic.Beta.BetaTool[] } | null = null;

/**
 * Tool definitions for the request. The list never changes within a running server, so every turn of a
 * chat sends identical tools (thinking blocks stay valid and the prompt cache keeps hitting).
 */
export function toolParams(eager: boolean): Anthropic.Beta.BetaTool[] {
  if (cached?.eager === eager) return cached.params;
  const params = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: inputSchema(t.schema), ...(eager ? { eager_input_streaming: true } : {}) })) as Anthropic.Beta.BetaTool[];
  cached = { eager, params };
  return params;
}

/** Model-facing text for a tool result, capped so one large result can't crowd the context. */
export function resultText(content: unknown): string {
  const s = typeof content === "string" ? content : JSON.stringify(content);
  return s.length > 20_000 ? `${s.slice(0, 20_000)}… (truncated)` : s;
}

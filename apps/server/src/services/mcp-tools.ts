// The tools AI assistants use over MCP (routes/mcp.ts). Each one is a few calls to this installation's API made with the
// assistant's own API key, so a tool can do exactly what the key may, and every change is checked and recorded the same
// way as from anywhere else. Inputs are friendlier than the API's (a schedule as days and hours, each step with the wait
// before it) and answers keep to what an assistant needs; api_request reaches everything else.
import { z } from "zod/v4"; // zod's v4 API for its JSON Schema output: tool inputs are published as JSON Schema
import {
  ACCOUNT_STATUS_LABELS,
  AccountStatus,
  CAMPAIGN_STATUS_LABELS,
  EMPLOYEE_BANDS,
  INDUSTRY_TREE,
  INTEREST_STATUS_LABELS,
  InterestStatus,
  LEAD_STATUS_LABELS,
  LF_DEPARTMENTS,
  LF_LEVELS,
  LeadStatus,
  PROVIDER_LABELS,
  ProviderCode,
  TASK_STEP_KINDS,
  WARMUP_STATUS_LABELS,
  WEBHOOK_EVENT_TYPES,
  htmlToText,
  textToHtml,
} from "@reachstack/shared";
import { apiEndpoints } from "../http/api-reference";
import { PROVIDER_PRESETS, detectProvider } from "../mail/providers";
import { workspaceZone } from "./workspace-clock";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiAnswer {
  status: number;
  body: unknown;
}

export interface ToolContext {
  /** Calls this installation's API with the assistant's key. */
  api(method: ApiMethod, path: string, opts?: { query?: Record<string, unknown>; body?: unknown }): Promise<ApiAnswer>;
  workspaceId: string;
}

/** A tool's answer that the assistant reads as a failure (isError), in words it can act on. */
export class ToolError extends Error {}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
/** Changes that reach people outside: email goes out. */
const SENDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

function tool<S extends z.ZodObject>(t: { name: string; title: string; description: string; input: S; annotations: ToolAnnotations; run: (args: z.output<S>, ctx: ToolContext) => Promise<unknown> }): McpTool {
  return t as unknown as McpTool;
}

// ---------- Calling the API ----------

// The API answers in loose JSON; tools read the fields they need from it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The API's own words for a refusal, with every problem when it listed them. */
function failure(res: ApiAnswer): string {
  const b = res.body as { message?: unknown; details?: { problems?: unknown } } | string | null;
  if (typeof b === "string" || !b) return `The request failed (${res.status})${b ? `: ${String(b).slice(0, 500)}` : ""}`;
  const message = typeof b.message === "string" ? b.message : `The request failed (${res.status})`;
  const problems = Array.isArray(b.details?.problems) ? (b.details.problems as unknown[]).map(String) : [];
  return problems.length > 1 ? `${message}\nEverything to fix:\n${problems.map((p) => `- ${p}`).join("\n")}` : message;
}

async function call(ctx: ToolContext, method: ApiMethod, path: string, opts?: { query?: Record<string, unknown>; body?: unknown }): Promise<Json> {
  const res = await ctx.api(method, path, opts);
  if (res.status >= 400) throw new ToolError(failure(res));
  return res.body;
}

/** The same call, or null when the key isn't allowed (so an overview can leave a part out). */
async function maybe(ctx: ToolContext, method: ApiMethod, path: string, opts?: { query?: Record<string, unknown>; body?: unknown }): Promise<Json | null> {
  const res = await ctx.api(method, path, opts);
  return res.status >= 400 ? null : res.body;
}

const id = (v: string) => encodeURIComponent(v.trim());
const label = (labels: Record<number, string>, code: unknown) => (typeof code === "number" ? (labels[code] ?? String(code)) : null);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ---------- Email accounts ----------

const PROVIDERS = PROVIDER_PRESETS.map((p) => p.key);

function mailbox(a: Json) {
  return {
    email: a.email,
    name: [a.first_name, a.last_name].filter(Boolean).join(" ") || null,
    provider: label(PROVIDER_LABELS, a.provider_code),
    test_mailbox: a.provider_code === ProviderCode.SANDBOX,
    status: label(ACCOUNT_STATUS_LABELS, a.status),
    ...(a.status_message ? { problem: typeof a.status_message === "string" ? a.status_message : (a.status_message.message ?? a.status_message) } : {}),
    warmup: label(WARMUP_STATUS_LABELS, a.warmup_status),
    warmup_score: a.stat_warmup_score ?? null,
    health_score: a.health?.score ?? null,
    daily_limit: a.daily_limit,
    ...(a.daily_limit_today !== undefined ? { daily_limit_today: a.daily_limit_today, sent_today: a.sent_today } : {}),
    minutes_between_emails: a.sending_gap,
    ...(a.campaign_pause_until ? { campaigns_paused_until: a.campaign_pause_until } : {}),
  };
}

async function allMailboxes(ctx: ToolContext): Promise<Json[]> {
  return (await call(ctx, "GET", "/api/v2/accounts", { query: { limit: 1000 } })).items ?? [];
}

/** The addresses a campaign sends from, checked against the workspace's mailboxes. */
async function senders(ctx: ToolContext, a: { mailboxes?: string[]; use_all_mailboxes?: boolean }): Promise<string[] | undefined> {
  if (!a.use_all_mailboxes && !a.mailboxes) return undefined;
  const all = await allMailboxes(ctx);
  if (a.use_all_mailboxes) {
    const active = all.filter((m) => m.status === AccountStatus.ACTIVE).map((m) => m.email as string);
    if (!active.length) throw new ToolError("There's no active email account to send from yet. Connect one (connect_email_account), or make test mailboxes (create_test_mailboxes).");
    return active;
  }
  const known = new Set(all.map((m) => String(m.email).toLowerCase()));
  const unknown = a.mailboxes!.filter((e) => !known.has(e.trim().toLowerCase()));
  if (unknown.length) {
    throw new ToolError(`Not connected in this workspace: ${unknown.join(", ")}. Connected: ${all.map((m) => m.email).join(", ") || "none yet"}.`);
  }
  return a.mailboxes!.map((e) => e.trim().toLowerCase());
}

// ---------- Sequences ----------

const DEFAULT_WAIT_DAYS = 3;
const UNIT_DAYS: Record<string, number> = { minutes: 1 / 1440, hours: 1 / 24, days: 1 };

const versionInput = z.object({
  subject: z.string().max(2000).optional().describe("Subject line."),
  body: z.string().max(200_000).describe("The email: plain text (line breaks are kept) or HTML."),
  disabled: z.boolean().optional().describe("Keep this version but stop sending it."),
});

const stepInput = z.object({
  subject: z.string().max(2000).optional().describe("Subject line. A follow-up can leave it empty to reply in the same thread."),
  body: z.string().max(200_000).optional().describe("The email: plain text (line breaks are kept) or HTML."),
  variants: z.array(versionInput).min(1).max(26).optional().describe("Two or more versions of this step to A/B test, instead of subject and body. Each lead gets one of them."),
  wait_days: z.number().min(0).max(365).optional().describe(`Days to wait after the previous step before this one goes out (ignored for the first step). Default ${DEFAULT_WAIT_DAYS}. Fractions work: 0.5 is 12 hours.`),
  type: z.enum(["email", "task"]).optional().describe("email (the default), or task: something to do by hand, like a call or a LinkedIn message. The first step must be an email."),
  task: z.enum(TASK_STEP_KINDS).optional().describe("For a task step: what to do. Its subject is the task's title and its body the note."),
});
type StepInput = z.output<typeof stepInput>;

const STEPS_HELP =
  "Each step is an email (or a task). In subject and body, {{firstName}}, {{lastName}}, {{companyName}}, {{jobTitle}}, {{website}}, {{personalization}} and your own lead fields fill in per lead; {{firstName | there}} gives a fallback; {{RANDOM | Hi | Hello}} picks one at random; {{sendingAccountFirstName}} and {{accountSignature}} come from the mailbox that sends; {{unsubscribe_url}} is a link that unsubscribes the lead.";

/** Plain text becomes HTML that keeps its line breaks; HTML stays as it is. */
const asHtml = (body: string) => (/<[a-z][^>]*>/i.test(body) ? body : textToHtml(body));

function apiSequences(steps: StepInput[]) {
  steps.forEach((s, i) => {
    if (!s.variants?.length && !s.body?.trim()) throw new ToolError(`Step ${i + 1} needs a body (or variants).`);
  });
  return [
    {
      steps: steps.map((s, i) => {
        const versions: Array<{ subject?: string; body: string; disabled?: boolean }> = s.variants?.length ? s.variants : [{ subject: s.subject, body: s.body ?? "" }];
        return {
          type: s.type ?? "email",
          ...(s.type === "task" && s.task ? { task: s.task } : {}),
          // The API keeps each wait on the step before it: how long after that one the next goes out.
          delay: steps[i + 1]?.wait_days ?? DEFAULT_WAIT_DAYS,
          delay_unit: "days",
          variants: versions.map((v) => ({ subject: v.subject ?? "", body: asHtml(v.body), ...(v.disabled ? { v_disabled: true } : {}) })),
        };
      }),
    },
  ];
}

function readableSteps(sequences: Json) {
  const steps: Json[] = sequences?.[0]?.steps ?? [];
  return steps.map((s, i) => {
    const before = steps[i - 1];
    const wait = before ? Math.round((before.delay ?? 0) * (UNIT_DAYS[before.delay_unit ?? "days"] ?? 1) * 1000) / 1000 : null;
    const versions = (s.variants ?? []).map((v: Json) => ({ subject: v.subject ?? "", body: v.body ?? "", ...(v.v_disabled ? { disabled: true } : {}) }));
    const head = { step: i + 1, ...(wait !== null ? { wait_days: wait } : {}), ...(s.type === "task" ? { type: "task", task: s.task } : {}) };
    return versions.length === 1 && !versions[0].disabled ? { ...head, subject: versions[0].subject, body: versions[0].body } : { ...head, variants: versions };
  });
}

// ---------- Schedules ----------

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_GROUPS: Record<string, number[]> = { weekdays: [1, 2, 3, 4, 5], weekends: [0, 6], weekend: [0, 6], everyday: [0, 1, 2, 3, 4, 5, 6], daily: [0, 1, 2, 3, 4, 5, 6] };
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm, like 09:00");
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const scheduleInput = z.object({
  days: z.array(z.string()).min(1).optional().describe("Days emails go out: monday … sunday (mon … sun), or weekdays, weekends, everyday. Default Monday to Friday."),
  from: hm.optional().describe("When sending starts each day, HH:mm on a 24-hour clock. Default 09:00."),
  to: hm.optional().describe("When it stops, HH:mm. Default 17:00."),
  timezone: z.string().optional().describe("IANA timezone of those hours, like America/New_York or Europe/Berlin. Default: the workspace's."),
  start_date: isoDay.nullable().optional().describe("First day to send, YYYY-MM-DD. Default: as soon as it's launched."),
  end_date: isoDay.nullable().optional().describe("Last day to send, YYYY-MM-DD."),
  in_each_leads_timezone: z.boolean().optional().describe("Use those hours on each lead's own clock where their timezone is known."),
});
type ScheduleInput = z.output<typeof scheduleInput>;

function dayKeys(days: string[]): Record<string, boolean> {
  const on = new Set<number>();
  for (const raw of days) {
    const d = raw.trim().toLowerCase().replace(/[\s-]/g, "");
    const group = DAY_GROUPS[d];
    const one = d.length >= 3 ? DAY_NAMES.findIndex((n) => n.startsWith(d.slice(0, 3))) : -1;
    if (group) group.forEach((n) => on.add(n));
    else if (one >= 0) on.add(one);
    else throw new ToolError(`"${raw}" isn't a day: use monday … sunday, weekdays, weekends or everyday.`);
  }
  return Object.fromEntries(DAY_NAMES.map((_, i) => [String(i), on.has(i)]));
}

/** The API's schedule: the first sending window takes what was given, anything else stays as it was. */
async function apiSchedule(ctx: ToolContext, input: ScheduleInput | undefined, current: Json | null) {
  const first = current?.schedules?.[0];
  const window = {
    name: first?.name ?? "Schedule",
    timing: { from: input?.from ?? first?.timing?.from ?? "09:00", to: input?.to ?? first?.timing?.to ?? "17:00" },
    days: input?.days ? dayKeys(input.days) : (first?.days ?? dayKeys(["weekdays"])),
    timezone: input?.timezone ?? first?.timezone ?? (await workspaceZone(ctx.workspaceId)),
  };
  return {
    start_date: input?.start_date !== undefined ? input.start_date : (current?.start_date ?? null),
    end_date: input?.end_date !== undefined ? input.end_date : (current?.end_date ?? null),
    schedules: [window, ...(current?.schedules?.slice(1) ?? [])],
    ...(current?.days_off ? { days_off: current.days_off } : {}),
    lead_timezone: input?.in_each_leads_timezone ?? !!current?.lead_timezone,
  };
}

function readableSchedule(s: Json) {
  const first = s?.schedules?.[0];
  if (!first) return null;
  return {
    days: DAY_NAMES.filter((_, i) => first.days?.[String(i)]),
    from: first.timing?.from,
    to: first.timing?.to,
    timezone: first.timezone,
    start_date: s.start_date ?? null,
    end_date: s.end_date ?? null,
    in_each_leads_timezone: !!s.lead_timezone,
    ...(s.schedules.length > 1 ? { more_windows: s.schedules.length - 1 } : {}),
    ...(s.days_off ? { days_off: s.days_off } : {}),
  };
}

// ---------- Campaigns ----------

const campaignSettings = {
  mailboxes: z.array(z.string()).optional().describe("Addresses of the email accounts to send from (see list_email_accounts). Replaces the current ones."),
  use_all_mailboxes: z.boolean().optional().describe("Send from every active email account in the workspace."),
  schedule: scheduleInput.optional().describe("When emails go out. Default: Monday to Friday, 09:00 to 17:00 in the workspace's timezone."),
  daily_limit: z.number().int().min(0).max(100_000).nullable().optional().describe("Most emails the campaign sends a day across its mailboxes (each mailbox also keeps its own limit)."),
  max_new_leads_per_day: z.number().int().min(0).nullable().optional().describe("Most leads who get their first email each day."),
  stop_on_reply: z.boolean().optional().describe("Stop emailing a lead once they reply. On unless turned off."),
  stop_on_auto_reply: z.boolean().optional().describe("Also stop on automatic replies, such as out of office."),
  open_tracking: z.boolean().optional().describe("Track opens with a pixel (can slightly lower inbox placement)."),
  link_tracking: z.boolean().optional().describe("Track link clicks."),
  text_only: z.boolean().optional().describe("Send every email as plain text."),
  minutes_between_emails: z.number().int().min(0).max(1440).nullable().optional().describe("Least time between two of this campaign's emails from one mailbox."),
  pick_winner_by: z.enum(["reply_rate", "click_rate", "open_rate"]).nullable().optional().describe("With A/B versions, send more of the best one by this measure; null turns it off."),
  unsubscribe_header: z.boolean().optional().describe("Add the List-Unsubscribe header Gmail and Yahoo look for, so people can unsubscribe from their inbox. On for new campaigns unless turned off."),
  more_settings: z.record(z.string(), z.unknown()).optional().describe("Any other field of the campaign API (POST /api/v2/campaigns), sent as it is: for example cc_list, prioritize_new_leads or stop_for_company."),
};
type CampaignSettings = { [K in keyof typeof campaignSettings]?: z.output<(typeof campaignSettings)[K]> };

async function settingsBody(ctx: ToolContext, a: CampaignSettings): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...(a.more_settings ?? {}) };
  const emails = await senders(ctx, a);
  if (emails) out.email_list = emails;
  if (a.daily_limit !== undefined) out.daily_limit = a.daily_limit;
  if (a.max_new_leads_per_day !== undefined) out.daily_max_leads = a.max_new_leads_per_day;
  if (a.stop_on_reply !== undefined) out.stop_on_reply = a.stop_on_reply;
  if (a.stop_on_auto_reply !== undefined) out.stop_on_auto_reply = a.stop_on_auto_reply;
  if (a.open_tracking !== undefined) out.open_tracking = a.open_tracking;
  if (a.link_tracking !== undefined) out.link_tracking = a.link_tracking;
  if (a.text_only !== undefined) out.text_only = a.text_only;
  if (a.minutes_between_emails !== undefined) out.email_gap = a.minutes_between_emails;
  if (a.pick_winner_by !== undefined) out.auto_variant_select = a.pick_winner_by ? { trigger: a.pick_winner_by } : null;
  if (a.unsubscribe_header !== undefined) out.insert_unsubscribe_header = a.unsubscribe_header;
  return out;
}

function campaignLine(c: Json) {
  return {
    id: c.id,
    name: c.name,
    status: label(CAMPAIGN_STATUS_LABELS, c.status),
    steps: c.sequences?.[0]?.steps?.length ?? 0,
    mailboxes: c.email_list?.length ?? 0,
    created: c.timestamp_created,
    launched: c.timestamp_launched ?? null,
  };
}

function campaignDetails(c: Json) {
  return {
    id: c.id,
    name: c.name,
    status: label(CAMPAIGN_STATUS_LABELS, c.status),
    steps: readableSteps(c.sequences),
    mailboxes: c.email_list ?? [],
    ...(c.email_tag_list?.length ? { mailbox_tags: c.email_tag_list } : {}),
    schedule: readableSchedule(c.campaign_schedule),
    settings: {
      daily_limit: c.daily_limit,
      max_new_leads_per_day: c.daily_max_leads,
      stop_on_reply: c.stop_on_reply !== false,
      stop_on_auto_reply: !!c.stop_on_auto_reply,
      open_tracking: !!c.open_tracking,
      link_tracking: !!c.link_tracking,
      text_only: !!c.text_only,
      minutes_between_emails: c.email_gap,
      pick_winner_by: c.auto_variant_select?.trigger ?? null,
      unsubscribe_header: !!c.insert_unsubscribe_header,
    },
    created: c.timestamp_created,
    launched: c.timestamp_launched ?? null,
    last_sent: c.timestamp_last_send ?? null,
  };
}

/** A lead of the campaign by address, for previews and tests. */
async function campaignLeadId(ctx: ToolContext, campaignId: string, email: string | undefined): Promise<string | undefined> {
  if (!email) return undefined;
  const found = await call(ctx, "POST", "/api/v2/leads/list", { body: { campaign: campaignId, contacts: [email.trim().toLowerCase()], limit: 1 } });
  const leadId = found.items?.[0]?.id;
  if (!leadId) throw new ToolError(`${email} isn't a lead of this campaign.`);
  return leadId;
}

// ---------- Leads ----------

const INTEREST_CODES: Record<string, number | null> = {
  interested: InterestStatus.INTERESTED,
  meeting_booked: InterestStatus.MEETING_BOOKED,
  meeting_completed: InterestStatus.MEETING_COMPLETED,
  won: InterestStatus.WON,
  out_of_office: InterestStatus.OUT_OF_OFFICE,
  not_interested: InterestStatus.NOT_INTERESTED,
  wrong_person: InterestStatus.WRONG_PERSON,
  lost: InterestStatus.LOST,
  no_show: InterestStatus.NO_SHOW,
  none: null,
};
const interestName = z.enum(Object.keys(INTEREST_CODES) as [string, ...string[]]);
const LEAD_STATUS_CODES: Record<string, number> = {
  active: LeadStatus.ACTIVE,
  paused: LeadStatus.PAUSED,
  completed: LeadStatus.COMPLETED,
  bounced: LeadStatus.BOUNCED,
  unsubscribed: LeadStatus.UNSUBSCRIBED,
  skipped: LeadStatus.SKIPPED,
};

const leadInput = z.object({
  email: z.string().max(254).describe("Email address."),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  company_name: z.string().max(300).optional(),
  company_domain: z.string().max(253).optional(),
  job_title: z.string().max(300).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().max(500).optional(),
  linkedin_url: z.string().max(500).optional(),
  location: z.string().max(300).optional(),
  timezone: z.string().max(60).optional().describe("IANA timezone, for sending on the lead's own clock."),
  personalization: z.string().max(5000).optional().describe("A line written for this lead, used in emails as {{personalization}}."),
  custom_variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Your own fields, used in emails as {{field_name}}."),
});

function leadLine(l: Json) {
  return {
    id: l.id,
    email: l.email,
    name: [l.first_name, l.last_name].filter(Boolean).join(" ") || null,
    company: l.company_name ?? null,
    job_title: l.job_title ?? null,
    campaign_id: l.campaign ?? null,
    list_id: l.list_id ?? null,
    status: label(LEAD_STATUS_LABELS, l.status),
    interest: label(INTEREST_STATUS_LABELS, l.lt_interest_status),
    opens: l.email_open_count ?? 0,
    replies: l.email_reply_count ?? 0,
    clicks: l.email_click_count ?? 0,
    last_contacted: l.timestamp_last_contact ?? null,
    last_reply: l.timestamp_last_reply ?? null,
    ...(l.payload && Object.keys(l.payload).length ? { custom_variables: l.payload } : {}),
  };
}

// ---------- Inbox ----------

const EMAIL_KINDS: Record<number, string> = { 1: "sent by a campaign", 2: "received", 3: "sent", 4: "scheduled" };

function emailText(e: Json, max: number) {
  const text = (e.body?.text || "").trim() || htmlToText(e.body?.html ?? "");
  return clip(text.trim(), max);
}

function replyLine(e: Json) {
  return {
    id: e.id,
    thread_id: e.thread_id,
    from: e.from_address_email,
    lead: e.lead ?? null,
    to_mailbox: e.eaccount,
    subject: e.subject,
    preview: e.content_preview ?? "",
    at: e.timestamp_email,
    kind: EMAIL_KINDS[e.ue_type] ?? null,
    unread: !!e.is_unread,
    ...(e.is_auto_reply ? { auto_reply: true } : {}),
    interest: label(INTEREST_STATUS_LABELS, e.i_status),
    campaign_id: e.campaign_id ?? null,
    ...(e.campaign_name ? { campaign: e.campaign_name } : {}),
  };
}

// ---------- Lead Finder ----------

const finderInput = {
  job_titles: z.array(z.string()).optional().describe("Job titles to include, like \"Head of Marketing\" (matched as words in the title)."),
  exclude_job_titles: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional().describe("Countries, states or cities where the people are, like \"United States\" or \"Berlin\"."),
  industries: z.array(z.enum(Object.keys(INDUSTRY_TREE) as [string, ...string[]])).optional(),
  company_sizes: z.array(z.enum(Object.keys(EMPLOYEE_BANDS) as [string, ...string[]])).optional().describe("Employee counts."),
  levels: z.array(z.enum(LF_LEVELS)).optional().describe("Seniority."),
  departments: z.array(z.enum(LF_DEPARTMENTS)).optional(),
  keywords: z.string().max(2000).optional().describe("Words to look for in what the companies do."),
  company_domains: z.array(z.string()).max(10_000).optional().describe("Only these companies, by website domain."),
  company_names: z.array(z.string()).optional(),
  skip_owned_leads: z.boolean().optional().describe("Leave out people already in your campaigns and lists. On unless turned off."),
  one_per_company: z.boolean().optional().describe("At most one person per company."),
  more_filters: z.record(z.string(), z.unknown()).optional().describe("Any other Lead Finder filter of the API (search_filters), sent as it is: technologies, revenue, fundingType, news…"),
};
type FinderInput = { [K in keyof typeof finderInput]?: z.output<(typeof finderInput)[K]> };

function searchFilters(a: FinderInput): Record<string, unknown> {
  const f: Record<string, unknown> = { ...(a.more_filters ?? {}) };
  if (a.job_titles?.length || a.exclude_job_titles?.length) f.title = { ...(a.job_titles?.length ? { include: a.job_titles } : {}), ...(a.exclude_job_titles?.length ? { exclude: a.exclude_job_titles } : {}) };
  if (a.locations?.length) f.locations = a.locations;
  if (a.industries?.length) f.industry = { include: a.industries };
  if (a.company_sizes?.length) f.employeeCount = a.company_sizes;
  if (a.levels?.length) f.level = a.levels;
  if (a.departments?.length) f.department = a.departments;
  if (a.keywords) f.keyword_filter = { include: a.keywords };
  if (a.company_domains?.length) f.domains = a.company_domains;
  if (a.company_names?.length) f.company_name = { include: a.company_names };
  f.skip_owned_leads = a.skip_owned_leads ?? true;
  if (a.one_per_company !== undefined) f.show_one_lead_per_company = a.one_per_company;
  return f;
}

// ---------- The tools ----------

export const MCP_TOOLS: McpTool[] = [
  tool({
    name: "get_overview",
    title: "Workspace overview",
    description: "Start here: the workspace, its email accounts, its campaigns and how many replies wait unread. Parts the API key may not see are left out.",
    input: z.object({}),
    annotations: READ,
    async run(_a, ctx) {
      const [workspace, accounts, campaigns, unread] = await Promise.all([
        maybe(ctx, "GET", "/api/v2/workspaces/current"),
        maybe(ctx, "GET", "/api/v2/accounts", { query: { limit: 1000 } }),
        maybe(ctx, "GET", "/api/v2/campaigns", { query: { limit: 100 } }),
        maybe(ctx, "GET", "/api/v2/emails/unread/count"),
      ]);
      const mailboxes: Json[] = accounts?.items ?? [];
      const byStatus: Record<string, number> = {};
      for (const m of mailboxes) {
        const s = label(ACCOUNT_STATUS_LABELS, m.status) ?? "unknown";
        byStatus[s] = (byStatus[s] ?? 0) + 1;
      }
      return {
        workspace: workspace ? { id: workspace.id, name: workspace.name, timezone: await workspaceZone(ctx.workspaceId) } : { id: ctx.workspaceId },
        email_accounts: accounts
          ? { total: mailboxes.length, by_status: byStatus, warmup_on: mailboxes.filter((m) => m.warmup_status === 1).length, test_mailboxes: mailboxes.filter((m) => m.provider_code === ProviderCode.SANDBOX).length }
          : "not available with this API key",
        campaigns: campaigns ? { shown: campaigns.items.length, more: !!campaigns.next_starting_after, items: campaigns.items.map(campaignLine) } : "not available with this API key",
        unread_replies: unread ? unread.count : "not available with this API key",
      };
    },
  }),

  // ---------- Email accounts ----------
  tool({
    name: "list_email_accounts",
    title: "List email accounts",
    description: "The mailboxes campaigns send from: status, warmup, health and daily limits.",
    input: z.object({
      search: z.string().optional().describe("Part of an address or name."),
      status: z.enum(["active", "paused", "connection_error"]).optional(),
    }),
    annotations: READ,
    async run(a, ctx) {
      const status = a.status ? { active: AccountStatus.ACTIVE, paused: AccountStatus.PAUSED, connection_error: AccountStatus.CONNECTION_ERROR }[a.status] : undefined;
      const res = await call(ctx, "GET", "/api/v2/accounts", { query: { limit: 1000, search: a.search, status } });
      return { total: res.items.length, accounts: res.items.map(mailbox) };
    },
  }),
  tool({
    name: "connect_email_account",
    title: "Connect an email account",
    description:
      "Connects a mailbox with IMAP and SMTP (Gmail and Google Workspace with an app password, Zoho, Yahoo, Fastmail, iCloud, your own server…). The login is tested before it's saved. Outlook and Microsoft 365 don't accept passwords: those connect with Sign in with Microsoft in the app (Email accounts → Connect). People may prefer to type mailbox passwords into the app themselves rather than share them in a chat.",
    input: z.object({
      email: z.string().describe("The mailbox's address."),
      password: z.string().describe("Its password, or app password (Gmail: myaccount.google.com/apppasswords, with 2-Step Verification on)."),
      provider: z.enum(PROVIDERS as [string, ...string[]]).optional().describe("Fills in the servers. Without it and without hosts, they're looked up from the address's domain."),
      imap_host: z.string().optional(),
      imap_port: z.number().int().min(1).max(65535).optional().describe("Default 993."),
      smtp_host: z.string().optional(),
      smtp_port: z.number().int().min(1).max(65535).optional().describe("Default 587."),
      username: z.string().optional().describe("Login name, when it isn't the address."),
      smtp_username: z.string().optional().describe("SMTP login, when it differs from the IMAP one."),
      smtp_password: z.string().optional().describe("SMTP password, when it differs."),
      first_name: z.string().max(100).optional().describe("Sender's first name, shown to recipients."),
      last_name: z.string().max(100).optional(),
      daily_limit: z.number().int().min(0).max(10_000).optional().describe("Most campaign emails a day from this mailbox. Default 30."),
      minutes_between_emails: z.number().int().min(0).max(1440).optional().describe("Least time between two emails. Default 10."),
      warmup: z.boolean().optional().describe("Warm it up (on unless turned off). New mailboxes should warm up for about two weeks before campaigns."),
      signature: z.string().max(20_000).optional().describe("HTML signature, used as {{accountSignature}}."),
    }),
    annotations: WRITE,
    async run(a, ctx) {
      const preset = a.provider ? PROVIDER_PRESETS.find((p) => p.key === a.provider) : !a.imap_host && !a.smtp_host ? await detectProvider(a.email).catch(() => null) : null;
      if (!preset && (!a.imap_host || !a.smtp_host)) throw new ToolError("Couldn't tell which servers this mailbox uses: give provider, or imap_host and smtp_host (the mail provider's help pages list them).");
      // A refused login comes back with the provider's advice (app passwords, IMAP turned on…).
      const created = await call(ctx, "POST", "/api/v2/accounts", {
        body: {
          email: a.email,
          first_name: a.first_name ?? "",
          last_name: a.last_name ?? "",
          provider_code: preset?.providerCode ?? ProviderCode.CUSTOM,
          imap_host: a.imap_host ?? preset?.imap.host,
          imap_port: a.imap_port ?? (a.imap_host ? undefined : preset?.imap.port),
          imap_username: a.username ?? a.email,
          imap_password: a.password,
          smtp_host: a.smtp_host ?? preset?.smtp.host,
          smtp_port: a.smtp_port ?? (a.smtp_host ? undefined : preset?.smtp.port),
          smtp_username: a.smtp_username ?? a.username ?? a.email,
          smtp_password: a.smtp_password ?? a.password,
          daily_limit: a.daily_limit,
          sending_gap: a.minutes_between_emails,
          enable_warmup: a.warmup ?? true,
          signature: a.signature,
        },
      }).catch((err) => {
        throw err instanceof ToolError && preset?.hint ? new ToolError(`${err.message}\n${preset.hint}`) : err;
      });
      return { connected: mailbox(created) };
    },
  }),
  tool({
    name: "connect_with_sign_in",
    title: "Connect a Google or Microsoft mailbox by signing in",
    description:
      "Connects a Gmail, Google Workspace, Outlook or Microsoft 365 mailbox with the provider's own sign-in, so nobody shares a password: gives a link for the person to open in their browser and sign in with that mailbox. check_sign_in then says whether it connected. The owner sets up Google or Microsoft sign-in once, in Settings → Installation → Services.",
    input: z.object({ provider: z.enum(["google", "microsoft"]) }),
    annotations: WRITE,
    async run(a, ctx) {
      const s = await call(ctx, "POST", `/api/v2/oauth/${a.provider}/init`, { body: {} });
      return { link: s.auth_url, session_id: s.session_id, expires_at: s.expires_at, next: "Ask the person to open the link and sign in with the mailbox within 10 minutes, then call check_sign_in with session_id." };
    },
  }),
  tool({
    name: "check_sign_in",
    title: "Check a mailbox sign-in",
    description: "Whether the mailbox from connect_with_sign_in has connected: pending, success (with its address), error (with why) or expired.",
    input: z.object({ session_id: z.string() }),
    annotations: READ,
    async run(a, ctx) {
      return call(ctx, "GET", `/api/v2/oauth/session/status/${id(a.session_id)}`);
    },
  }),
  tool({
    name: "create_test_mailboxes",
    title: "Make test mailboxes",
    description:
      "Mailboxes that live inside Reachstack and never send real email, to try everything safely. Campaigns sent from them reach nobody outside, and leads whose addresses start with interested… or yes… (a positive reply), meeting… (proposes a time), notinterested… (declines), ooo… (out of office) or bounce… (bounces) answer that way.",
    input: z.object({
      count: z.number().int().min(1).max(25).optional().describe("How many. Default 3."),
      domain: z.string().optional().describe("Their domain, like team-demo.test. Default: one made from the workspace's name."),
    }),
    annotations: WRITE,
    async run(a, ctx) {
      const res = await call(ctx, "POST", "/api/app/accounts/sandbox", { body: { count: a.count ?? 3, ...(a.domain ? { domain: a.domain } : {}), enable_warmup: true } });
      return { created: res.items.map(mailbox) };
    },
  }),
  tool({
    name: "update_email_account",
    title: "Change an email account",
    description: "Changes a mailbox's sender name, daily limit, gap between emails or signature, or pauses and resumes it.",
    input: z.object({
      email: z.string().describe("The mailbox's address."),
      first_name: z.string().max(100).optional(),
      last_name: z.string().max(100).optional(),
      daily_limit: z.number().int().min(0).max(10_000).optional(),
      minutes_between_emails: z.number().int().min(0).max(1440).optional(),
      signature: z.string().max(20_000).nullable().optional(),
      paused: z.boolean().optional().describe("true pauses all sending from it, false resumes it."),
    }),
    annotations: WRITE,
    async run(a, ctx) {
      const path = `/api/v2/accounts/${id(a.email)}`;
      const patch: Record<string, unknown> = {};
      if (a.first_name !== undefined) patch.first_name = a.first_name;
      if (a.last_name !== undefined) patch.last_name = a.last_name;
      if (a.daily_limit !== undefined) patch.daily_limit = a.daily_limit;
      if (a.minutes_between_emails !== undefined) patch.sending_gap = a.minutes_between_emails;
      if (a.signature !== undefined) patch.signature = a.signature;
      let row = Object.keys(patch).length ? await call(ctx, "PATCH", path, { body: patch }) : null;
      if (a.paused !== undefined) row = await call(ctx, "POST", `${path}/${a.paused ? "pause" : "resume"}`, { body: {} });
      return mailbox(row ?? (await call(ctx, "GET", path)));
    },
  }),
  tool({
    name: "set_warmup",
    title: "Turn warmup on or off",
    description: "Turns warmup on or off for some mailboxes, or for all of them.",
    input: z.object({
      on: z.boolean().describe("true turns warmup on, false off."),
      emails: z.array(z.string()).optional().describe("Which mailboxes."),
      all: z.boolean().optional().describe("Every mailbox in the workspace."),
    }),
    annotations: { ...WRITE, idempotentHint: true },
    async run(a, ctx) {
      if (!a.all && !a.emails?.length) throw new ToolError("Say which mailboxes: emails, or all: true.");
      const job = await call(ctx, "POST", `/api/v2/accounts/warmup/${a.on ? "enable" : "disable"}`, { body: a.all ? { include_all_emails: true } : { emails: a.emails } });
      return { warmup: a.on ? "on" : "off", changed: job.result?.success_count ?? job.data?.success_count, ...(job.data?.failed?.length ? { not_changed: job.data.failed } : {}) };
    },
  }),

  // ---------- Campaigns ----------
  tool({
    name: "list_campaigns",
    title: "List campaigns",
    description: "Campaigns with their status, newest first.",
    input: z.object({
      search: z.string().optional().describe("Part of a name."),
      status: z.enum(["draft", "active", "paused", "completed"]).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 50."),
      starting_after: z.string().optional().describe("next_starting_after from the previous page."),
    }),
    annotations: READ,
    async run(a, ctx) {
      const status = a.status ? { draft: 0, active: 1, paused: 2, completed: 3 }[a.status] : undefined;
      const res = await call(ctx, "GET", "/api/v2/campaigns", { query: { limit: a.limit ?? 50, search: a.search, status, starting_after: a.starting_after } });
      return { campaigns: res.items.map(campaignLine), next_starting_after: res.next_starting_after ?? null };
    },
  }),
  tool({
    name: "get_campaign",
    title: "Show a campaign",
    description: "A campaign's steps (every email), mailboxes, schedule, settings and lead count.",
    input: z.object({ campaign_id: z.string() }),
    annotations: READ,
    async run(a, ctx) {
      const c = await call(ctx, "GET", `/api/v2/campaigns/${id(a.campaign_id)}`);
      const stats = await maybe(ctx, "GET", "/api/v2/campaigns/analytics", { query: { id: c.id } });
      return { ...campaignDetails(c), leads: stats?.[0]?.leads_count ?? null };
    },
  }),
  tool({
    name: "create_campaign",
    title: "Create a campaign",
    description: `Creates a campaign as a draft: its steps, the mailboxes it sends from, its schedule and settings. Nothing is sent until launch_campaign. Then add people with add_leads (or import_from_lead_finder). ${STEPS_HELP}`,
    input: z.object({
      name: z.string().min(1).max(250),
      steps: z.array(stepInput).min(1).max(30).describe("The emails in order: the first goes out when a lead starts, each next one wait_days after the one before."),
      ...campaignSettings,
    }),
    annotations: WRITE,
    async run(a, ctx) {
      const { name, steps, ...settings } = a;
      const created = await call(ctx, "POST", "/api/v2/campaigns", {
        body: { insert_unsubscribe_header: true, ...(await settingsBody(ctx, settings)), name, sequences: apiSequences(steps), campaign_schedule: await apiSchedule(ctx, settings.schedule, null) },
      });
      return { ...campaignDetails(created), next: "Add leads with add_leads, look it over with check_campaign and preview_email, then launch_campaign once the person approves." };
    },
  }),
  tool({
    name: "update_campaign",
    title: "Change a campaign",
    description: `Changes a campaign: its name, steps (given steps replace the whole sequence), mailboxes, schedule (only the parts given) or settings. Works on a running campaign too: leads continue from where they are. ${STEPS_HELP}`,
    input: z.object({
      campaign_id: z.string(),
      name: z.string().min(1).max(250).optional(),
      steps: z.array(stepInput).min(1).max(30).optional().describe("The whole new sequence, in order."),
      ...campaignSettings,
    }),
    annotations: WRITE,
    async run(a, ctx) {
      const { campaign_id, name, steps, ...settings } = a;
      const path = `/api/v2/campaigns/${id(campaign_id)}`;
      const current = settings.schedule ? await call(ctx, "GET", path) : null;
      const patch: Record<string, unknown> = await settingsBody(ctx, settings);
      if (name !== undefined) patch.name = name;
      if (steps) patch.sequences = apiSequences(steps);
      if (settings.schedule) patch.campaign_schedule = await apiSchedule(ctx, settings.schedule, current.campaign_schedule);
      if (!Object.keys(patch).length) throw new ToolError("Nothing to change: give a name, steps, mailboxes, a schedule or a setting.");
      return campaignDetails(await call(ctx, "PATCH", path, { body: patch }));
    },
  }),
  tool({
    name: "check_campaign",
    title: "Check a campaign before launch",
    description: "Whether the campaign can launch: problems that stop it, warnings worth a look, and leads whose emails would come out with a gap where a {{variable}} goes.",
    input: z.object({ campaign_id: z.string() }),
    annotations: READ,
    async run(a, ctx) {
      return call(ctx, "GET", `/api/app/campaigns/${id(a.campaign_id)}/launch-check`);
    },
  }),
  tool({
    name: "preview_email",
    title: "Preview an email",
    description: "One step of a campaign as a lead will get it, with every variable filled in, plus warnings (an empty variable, a blank email).",
    input: z.object({
      campaign_id: z.string(),
      step: z.number().int().min(1).optional().describe("Which step, from 1. Default 1."),
      variant: z.number().int().min(1).optional().describe("Which A/B version, from 1. Default 1."),
      lead_email: z.string().optional().describe("A lead of the campaign. Default: its first lead (or sample details when it has none)."),
    }),
    annotations: READ,
    async run(a, ctx) {
      const leadId = await campaignLeadId(ctx, a.campaign_id, a.lead_email);
      const p = await call(ctx, "POST", `/api/app/campaigns/${id(a.campaign_id)}/preview`, { body: { step: (a.step ?? 1) - 1, variant: (a.variant ?? 1) - 1, ...(leadId ? { lead_id: leadId } : {}) } });
      return { subject: p.subject, text: htmlToText(p.body ?? ""), html: p.body, lead: p.lead, from_mailbox: p.account_email, text_only: p.text_only, warnings: p.warnings };
    },
  }),
  tool({
    name: "send_test_email",
    title: "Send a test email",
    description: "Sends one step of a campaign to an address of your choosing (usually the person's own), filled in for a lead, so they see it in a real inbox. It goes out from one of the campaign's mailboxes.",
    input: z.object({
      campaign_id: z.string(),
      to: z.string().describe("Where to send the test."),
      step: z.number().int().min(1).optional().describe("Which step, from 1. Default 1."),
      variant: z.number().int().min(1).optional(),
      lead_email: z.string().optional().describe("Fill it in for this lead of the campaign. Default: sample details."),
      from_mailbox: z.string().optional().describe("Which of the campaign's mailboxes sends it."),
    }),
    annotations: SENDS,
    async run(a, ctx) {
      const leadId = await campaignLeadId(ctx, a.campaign_id, a.lead_email);
      const res = await call(ctx, "POST", `/api/app/campaigns/${id(a.campaign_id)}/test-email`, {
        body: { to: a.to, step: (a.step ?? 1) - 1, variant: (a.variant ?? 1) - 1, ...(leadId ? { lead_id: leadId } : {}), ...(a.from_mailbox ? { account_email: a.from_mailbox } : {}) },
      });
      return { sent: true, to: a.to, from: res.from };
    },
  }),
  tool({
    name: "launch_campaign",
    title: "Launch a campaign",
    description: "Starts sending: leads get the first email in the next sending window, from the campaign's mailboxes. This emails real people (unless every mailbox is a test mailbox), so confirm with the person first. If something stops it, the answer lists what to fix.",
    input: z.object({ campaign_id: z.string() }),
    annotations: { ...SENDS, idempotentHint: true },
    async run(a, ctx) {
      const c = await call(ctx, "POST", `/api/v2/campaigns/${id(a.campaign_id)}/activate`, { body: {} });
      return { id: c.id, name: c.name, status: label(CAMPAIGN_STATUS_LABELS, c.status), next: "campaign_status says what it's doing now; replies arrive in list_replies." };
    },
  }),
  tool({
    name: "pause_campaign",
    title: "Pause a campaign",
    description: "Stops sending until it's launched again. Leads keep their place.",
    input: z.object({ campaign_id: z.string() }),
    annotations: { ...WRITE, idempotentHint: true },
    async run(a, ctx) {
      const c = await call(ctx, "POST", `/api/v2/campaigns/${id(a.campaign_id)}/pause`, { body: {} });
      return { id: c.id, name: c.name, status: label(CAMPAIGN_STATUS_LABELS, c.status) };
    },
  }),
  tool({
    name: "campaign_status",
    title: "Why a campaign is or isn't sending",
    description: "Right now: whether the campaign is sending, every reason it isn't (schedule, limits, mailboxes, leads), today's numbers and each mailbox's capacity.",
    input: z.object({ campaign_id: z.string() }),
    annotations: READ,
    async run(a, ctx) {
      const s = await call(ctx, "GET", `/api/v2/campaigns/${id(a.campaign_id)}/sending-status`);
      return { ...s.summary, details: s.diagnostics };
    },
  }),
  tool({
    name: "campaign_analytics",
    title: "Campaign results",
    description: "Sent, opened, replied, clicked, bounced, unsubscribed and opportunities, for one campaign or all of them, over all time or between two days.",
    input: z.object({
      campaign_id: z.string().optional().describe("Default: every campaign."),
      start_date: isoDay.optional(),
      end_date: isoDay.optional(),
    }),
    annotations: READ,
    async run(a, ctx) {
      const rows: Json[] = await call(ctx, "GET", "/api/v2/campaigns/analytics", { query: { id: a.campaign_id, start_date: a.start_date, end_date: a.end_date } });
      return rows.map((r) => ({
        campaign_id: r.campaign_id,
        campaign: r.campaign_name,
        status: label(CAMPAIGN_STATUS_LABELS, r.campaign_status),
        leads: r.leads_count,
        contacted: r.contacted_count,
        emails_sent: r.emails_sent_count,
        opened: r.open_count_unique,
        replied: r.reply_count_unique,
        auto_replies: r.reply_count_automatic_unique,
        clicked: r.link_click_count_unique,
        bounced: r.bounced_count,
        unsubscribed: r.unsubscribed_count,
        completed: r.completed_count,
        opportunities: r.total_opportunities,
        opportunity_value: r.total_opportunity_value,
      }));
    },
  }),

  // ---------- Leads ----------
  tool({
    name: "add_leads",
    title: "Add leads",
    description: "Adds up to 1,000 people at a time to a campaign (a running campaign starts emailing them) or to a list. People on the blocklist, unsubscribed or bounced before, are left out.",
    input: z.object({
      campaign_id: z.string().optional().describe("Add them to this campaign."),
      list_id: z.string().optional().describe("Or to this lead list."),
      leads: z.array(leadInput).min(1).max(1000),
      skip_if_in_workspace: z.boolean().optional().describe("Leave out anyone already in any campaign or list here."),
      skip_if_in_campaign: z.boolean().optional().describe("Leave out anyone already in another campaign."),
      verify_emails: z.boolean().optional().describe("Check each address first (uses verification credits)."),
    }),
    annotations: WRITE,
    async run(a, ctx) {
      if (!a.campaign_id === !a.list_id) throw new ToolError("Give campaign_id or list_id (one of them).");
      return call(ctx, "POST", "/api/v2/leads/add", {
        body: {
          ...(a.campaign_id ? { campaign_id: a.campaign_id } : { list_id: a.list_id }),
          leads: a.leads,
          skip_if_in_workspace: a.skip_if_in_workspace,
          skip_if_in_campaign: a.skip_if_in_campaign,
          verify_leads_on_import: a.verify_emails,
        },
      });
    },
  }),
  tool({
    name: "list_leads",
    title: "Find leads",
    description: "Leads of a campaign or list, or across the workspace: who they are, where they stand and their interest.",
    input: z.object({
      campaign_id: z.string().optional(),
      list_id: z.string().optional(),
      search: z.string().optional().describe("Part of an address, name or company."),
      interest: interestName.optional(),
      status: z.enum(Object.keys(LEAD_STATUS_CODES) as [string, ...string[]]).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
      starting_after: z.string().optional().describe("next_starting_after from the previous page."),
    }),
    annotations: READ,
    async run(a, ctx) {
      const res = await call(ctx, "POST", "/api/v2/leads/list", {
        body: {
          campaign: a.campaign_id,
          list_id: a.list_id,
          search: a.search,
          ...(a.interest ? { interest_status: INTEREST_CODES[a.interest] } : {}),
          ...(a.status ? { status: LEAD_STATUS_CODES[a.status] } : {}),
          limit: a.limit ?? 25,
          starting_after: a.starting_after,
          with_total: true,
        },
      });
      return { total: res.total ?? null, leads: res.items.map(leadLine), next_starting_after: res.next_starting_after ?? null };
    },
  }),
  tool({
    name: "set_lead_interest",
    title: "Label a lead's interest",
    description: "Marks a lead as interested, meeting booked, won, not interested… (stopping or continuing the campaign the way that label is set up to).",
    input: z.object({
      email: z.string(),
      interest: interestName.optional().describe("none clears it."),
      code: z.number().int().optional().describe("A custom label's number, instead of interest."),
      campaign_id: z.string().optional().describe("Only the lead in this campaign."),
    }),
    annotations: { ...WRITE, idempotentHint: true },
    async run(a, ctx) {
      if (a.interest === undefined && a.code === undefined) throw new ToolError("Give interest (or a custom label's code).");
      await call(ctx, "POST", "/api/v2/leads/update-interest-status", {
        body: { lead_email: a.email, interest_value: a.code ?? INTEREST_CODES[a.interest!], ...(a.campaign_id ? { campaign_id: a.campaign_id } : {}) },
      });
      return { email: a.email, interest: a.code !== undefined ? a.code : a.interest };
    },
  }),
  tool({
    name: "list_lead_lists",
    title: "List lead lists",
    description: "Lists that hold leads outside campaigns.",
    input: z.object({ search: z.string().optional() }),
    annotations: READ,
    async run(a, ctx) {
      const res = await call(ctx, "GET", "/api/v2/lead-lists", { query: { limit: 100, search: a.search } });
      return res.items.map((l: Json) => ({ id: l.id, name: l.name, created: l.timestamp_created }));
    },
  }),
  tool({
    name: "create_lead_list",
    title: "Create a lead list",
    description: "A new list to collect leads in before they go into a campaign.",
    input: z.object({ name: z.string().min(1).max(200) }),
    annotations: WRITE,
    async run(a, ctx) {
      const l = await call(ctx, "POST", "/api/v2/lead-lists", { body: { name: a.name } });
      return { id: l.id, name: l.name };
    },
  }),

  // ---------- Inbox ----------
  tool({
    name: "list_replies",
    title: "List replies",
    description: "Replies from leads, newest first, across every mailbox (the Unibox): who wrote, a preview and the interest label. get_conversation shows a whole exchange.",
    input: z.object({
      unread_only: z.boolean().optional(),
      campaign_id: z.string().optional(),
      lead_email: z.string().optional(),
      search: z.string().optional(),
      interest: interestName.optional(),
      include_sent: z.boolean().optional().describe("Also emails sent to leads, not only replies."),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      starting_after: z.string().optional().describe("next_starting_after from the previous page."),
    }),
    annotations: READ,
    async run(a, ctx) {
      const interest = a.interest ? INTEREST_CODES[a.interest] : undefined;
      const res = await call(ctx, "GET", "/api/v2/emails", {
        query: {
          email_type: a.include_sent ? undefined : "received",
          is_unread: a.unread_only || undefined,
          campaign_id: a.campaign_id,
          lead: a.lead_email,
          search: a.search,
          i_status: interest ?? undefined,
          limit: a.limit ?? 20,
          starting_after: a.starting_after,
          preview_only: true,
        },
      });
      return { replies: res.items.map(replyLine), next_starting_after: res.next_starting_after ?? null };
    },
  }),
  tool({
    name: "get_conversation",
    title: "Read a conversation",
    description: "Every email with one lead, oldest first: what was sent and what they answered, as text.",
    input: z.object({
      lead_email: z.string(),
      campaign_id: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
    }),
    annotations: READ,
    async run(a, ctx) {
      const res = await call(ctx, "GET", "/api/v2/emails", { query: { lead: a.lead_email.trim().toLowerCase(), campaign_id: a.campaign_id, sort_order: "asc", limit: a.limit ?? 30 } });
      return {
        lead: a.lead_email,
        emails: res.items.map((e: Json) => ({ id: e.id, thread_id: e.thread_id, kind: EMAIL_KINDS[e.ue_type] ?? null, from: e.from_address_email, to: e.to_address_email_list, mailbox: e.eaccount, subject: e.subject, at: e.timestamp_email, text: emailText(e, 6000) })),
      };
    },
  }),
  tool({
    name: "reply_to_email",
    title: "Reply to an email",
    description: "Answers an email (usually a lead's reply) in its thread, from the mailbox that received it. This sends a real email, so confirm the wording with the person unless they've said to go ahead.",
    input: z.object({
      email_id: z.string().describe("The email being answered: id from list_replies or get_conversation."),
      body: z.string().min(1).max(200_000).describe("The reply: plain text (line breaks are kept) or HTML. The earlier emails are quoted below it."),
      subject: z.string().max(998).optional().describe("Default: Re: and the original subject."),
      from_mailbox: z.string().optional().describe("Default: the mailbox that received it."),
      cc: z.array(z.string()).optional(),
      send_at: z.string().optional().describe("Send later instead: an ISO time like 2026-11-03T09:30:00-05:00."),
    }),
    annotations: SENDS,
    async run(a, ctx) {
      const original = await call(ctx, "GET", `/api/v2/emails/${id(a.email_id)}`);
      const subject = a.subject ?? (/^re:/i.test(original.subject ?? "") ? original.subject : `Re: ${original.subject ?? ""}`.trim());
      const sent = await call(ctx, "POST", "/api/v2/emails/reply", {
        body: {
          eaccount: a.from_mailbox ?? original.eaccount,
          reply_to_uuid: original.id,
          subject,
          body: { html: asHtml(a.body) },
          ...(a.cc?.length ? { cc_address_email_list: a.cc.join(",") } : {}),
          ...(a.send_at ? { scheduled_at: a.send_at } : {}),
          include_quote: true,
        },
      });
      return { [a.send_at ? "scheduled" : "sent"]: true, id: sent.id, from: sent.eaccount, to: sent.to_address_email_list, subject: sent.subject, ...(sent.scheduled_at ? { send_at: sent.scheduled_at } : {}) };
    },
  }),
  tool({
    name: "mark_thread_read",
    title: "Mark a conversation read",
    description: "Marks every email in a thread as read.",
    input: z.object({ thread_id: z.string() }),
    annotations: { ...WRITE, idempotentHint: true },
    async run(a, ctx) {
      await call(ctx, "POST", `/api/v2/emails/threads/${id(a.thread_id)}/mark-as-read`, { body: {} });
      return { thread_id: a.thread_id, read: true };
    },
  }),

  // ---------- Lead Finder ----------
  tool({
    name: "search_lead_finder",
    title: "Search Lead Finder",
    description: "Searches the people and companies in Lead Finder (the data this installation has: the demo data, or what was imported). Shows how many match and the first 25; import_from_lead_finder takes them into a list or campaign.",
    input: z.object(finderInput),
    annotations: READ,
    async run(a, ctx) {
      const res = await call(ctx, "POST", "/api/v2/supersearch-enrichment/preview-leads-from-supersearch", { body: { search_filters: searchFilters(a) } });
      return {
        matches: res.number_of_leads,
        first_25: res.leads.map((p: Json) => ({ name: p.fullName, job_title: p.jobTitle, company: p.companyName, location: p.location, ...(p.isOwned ? { already_yours: true } : {}) })),
        ...(res.number_of_leads === 0 ? { tip: "No match. Loosen the filters, or check that Lead Finder has data (Lead Finder → Data source in the app)." } : {}),
      };
    },
  }),
  tool({
    name: "import_from_lead_finder",
    title: "Import from Lead Finder",
    description: "Takes people matching a Lead Finder search into a new list, or an existing list or campaign (a running campaign starts emailing them), finding work emails where needed. Uses Lead Finder credits. It runs in the background: get_background_job shows how far it got.",
    input: z.object({
      ...finderInput,
      limit: z.number().int().min(1).max(50_000).describe("How many people at most."),
      into: z.string().optional().describe("A campaign's or list's id. Default: a new list."),
      list_name: z.string().max(200).optional().describe("Name of the new list."),
      find_emails: z.boolean().optional().describe("Find work emails for people who have none (on unless turned off)."),
      verify_emails: z.boolean().optional().describe("Verify the addresses (uses verification credits)."),
      skip_people_without_email: z.boolean().optional().describe("Leave out people no email was found for (on unless turned off)."),
    }),
    annotations: WRITE,
    async run(a, ctx) {
      const res = await call(ctx, "POST", "/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", {
        body: {
          search_filters: searchFilters(a),
          limit: a.limit,
          ...(a.into ? { resource_id: a.into } : {}),
          ...(a.list_name ? { list_name: a.list_name } : {}),
          work_email_enrichment: a.find_emails ?? true,
          email_verification: a.verify_emails ?? false,
          skip_rows_without_email: a.skip_people_without_email ?? true,
        },
      });
      return { background_job_id: res.background_job_id, into: res.resource_id, into_type: res.resource_type === 1 ? "campaign" : "list", list_name: res.list_name };
    },
  }),
  tool({
    name: "get_background_job",
    title: "Check a background job",
    description: "How an import or other long job is going: its status, progress and result.",
    input: z.object({ job_id: z.string() }),
    annotations: READ,
    async run(a, ctx) {
      const j = await call(ctx, "GET", `/api/v2/background-jobs/${id(a.job_id)}`);
      return { id: j.id, type: j.type, status: j.status, progress: j.progress, result: j.result, error: j.error, updated: j.updated_at };
    },
  }),

  // ---------- Other ----------
  tool({
    name: "verify_email",
    title: "Verify an email address",
    description: "Checks whether an address can receive email (its domain, its mail server and whether it accepts everything). Uses a verification credit; a recent answer is reused for free.",
    input: z.object({ email: z.string() }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(a, ctx) {
      const r = await call(ctx, "POST", "/api/v2/email-verification", { body: { email: a.email } });
      return { email: r.email, result: r.verification_status, catch_all: r.catch_all, ...(r.reason ? { reason: r.reason } : {}) };
    },
  }),
  tool({
    name: "create_webhook",
    title: "Send events to another tool",
    description: "Sends Reachstack's events (replies, interested leads, bounces…) to another tool's webhook address: a CRM, Zapier, Make, n8n, Slack…",
    input: z.object({
      url: z.string().describe("The address to send events to (https)."),
      event: z.enum(WEBHOOK_EVENT_TYPES).optional().describe("Which event. Default all_events."),
      name: z.string().max(200).optional(),
      campaign_id: z.string().optional().describe("Only this campaign's events."),
    }),
    annotations: { ...WRITE, openWorldHint: true },
    async run(a, ctx) {
      const w = await call(ctx, "POST", "/api/v2/webhooks", { body: { target_hook_url: a.url, event_type: a.event ?? "all_events", ...(a.name ? { name: a.name } : {}), ...(a.campaign_id ? { campaign: a.campaign_id } : {}) } });
      return { id: w.id, url: w.target_hook_url, event: w.event_type, campaign_id: w.campaign ?? null };
    },
  }),
  tool({
    name: "api_reference",
    title: "API reference",
    description: "Every endpoint of Reachstack's REST API (method, path, what it does, the API key scope it needs), for what the other tools don't cover. Call them with api_request.",
    input: z.object({ search: z.string().optional().describe("Words to look for in the path, area or description, like \"subsequence\" or \"blocklist\".") }),
    annotations: READ,
    async run(a) {
      const words = (a.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const rows = apiEndpoints().filter((e) => words.every((w) => `${e.method} ${e.path} ${e.group} ${e.summary}`.toLowerCase().includes(w)));
      return { base: "/api/v2", endpoints: rows.map((e) => `${e.method} ${e.path} (${e.scope}): ${e.summary || e.group}`) };
    },
  }),
  tool({
    name: "api_request",
    title: "Call the REST API",
    description: "Calls any endpoint of the REST API (see api_reference) with this key: GET to read, POST, PATCH or DELETE to change. Field names follow the API, which answers with what was wrong when a request doesn't fit.",
    input: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().describe("Starting /api/v2/, like /api/v2/subsequences. A query string can go on the end."),
      body: z.unknown().optional().describe("The JSON body, for POST, PUT and PATCH."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async run(a, ctx) {
      const path = a.path.trim();
      if (!/^\/api\/v2\/[\w\-./%:@]*(\?.*)?$/.test(path) || path.includes("..")) throw new ToolError("path must start with /api/v2/ (see api_reference).");
      const res = await ctx.api(a.method, path, a.body !== undefined || a.method !== "GET" ? { body: a.body ?? {} } : undefined);
      if (res.status >= 400) throw new ToolError(`${res.status}: ${failure(res)}`);
      return res.body ?? { status: res.status };
    },
  }),
];

const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
export const findTool = (name: string) => byName.get(name);

/** A tool as tools/list describes it. */
export function toolListing(t: McpTool) {
  const schema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, title: t.title, description: t.description, inputSchema: tidy(schema), annotations: { title: t.title, ...t.annotations } };
}

/** Drops the safe-integer bounds zod writes on every integer: noise to a model reading the schema. */
function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === "maximum" && v === Number.MAX_SAFE_INTEGER) || (k === "minimum" && v === Number.MIN_SAFE_INTEGER)) continue;
    out[k] = tidy(v);
  }
  return out;
}

/** Reads a tool's arguments, or says what's wrong with them. */
export function readArguments(t: McpTool, args: unknown): Record<string, unknown> {
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) throw new ToolError(`The arguments don't fit ${t.name}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data as Record<string, unknown>;
}

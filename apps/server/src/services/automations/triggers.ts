// Starting automations. Core triggers listen for engine and API events on the bus; "Catch a webhook",
// schedules and the Run button start runs directly. Every trigger turns its record into the data the rest of
// the run references as {{trigger.…}}, and the same builders produce the records offered when testing.
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  AUTOMATION_TRIGGERS,
  CAMPAIGN_STATUS_LABELS,
  CampaignStatus,
  INTEREST_STATUS_LABELS,
  LEAD_STATUS_LABELS,
  LeadStatus,
  snippet,
  triggerDef,
  type AutomationGraph,
} from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { newestReplyText } from "../../mail/reply-text";
import { campaignName, uniboxUrl } from "../activity";
import { on, type BusEvent, type BusEventType } from "../bus";
import type { VisitorCompany } from "../visitors";
import { createRun, createRuns, type WorkflowRow } from "./runs";
import { automationScope, currentChainDepth, MAX_CHAIN_DEPTH } from "./scope";

const W = schema.workflows;
const L = schema.leads;
type LeadRow = typeof L.$inferSelect;
export type TriggerOutput = Record<string, unknown>;

/** One event, or one import however many parts it's added in, starts at most this many runs of an automation. */
export const MAX_RUNS_PER_EVENT = 1000;

export const triggerNode = (graph: AutomationGraph) => graph.nodes.find((n) => n.type === "trigger") ?? null;

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clip = (s: string, max = 20_000) => (s.length > max ? `${s.slice(0, max)}…` : s);

// ---------------------------------------------------------------------------------------------------------------
// Records → trigger data

async function labelLookup(workspaceId: string) {
  const rows = await db
    .select({ code: schema.leadLabels.interestStatus, label: schema.leadLabels.label })
    .from(schema.leadLabels)
    .where(eq(schema.leadLabels.workspaceId, workspaceId));
  const custom = new Map(rows.map((r) => [r.code, r.label]));
  return (code: number | null | undefined) => (code === null || code === undefined ? null : (custom.get(code) ?? INTEREST_STATUS_LABELS[code] ?? `Label ${code}`));
}

async function userEmails(ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, unique));
  return new Map(rows.map((r) => [r.id, r.email]));
}

/** What {{trigger.lead.…}} offers. */
async function leadOutputs(workspaceId: string, leads: LeadRow[]) {
  const label = await labelLookup(workspaceId);
  const owners = await userEmails(leads.map((l) => l.assignedTo));
  return new Map(
    leads.map((l) => [
      l.id,
      {
        id: l.id,
        email: l.email,
        first_name: l.firstName,
        last_name: l.lastName,
        full_name: [l.firstName, l.lastName].filter(Boolean).join(" ") || null,
        company_name: l.companyName,
        company_domain: l.companyDomain || null,
        job_title: l.jobTitle,
        phone: l.phone,
        website: l.website,
        linkedin_url: l.linkedinUrl,
        location: l.location,
        personalization: l.personalization,
        label: label(l.interestStatus),
        label_code: l.interestStatus,
        status: LEAD_STATUS_LABELS[l.status] ?? String(l.status),
        owner_email: (l.assignedTo && owners.get(l.assignedTo)) || null,
        deal_value: l.plValueLead,
        campaign_id: l.campaignId,
        list_id: l.listId,
        custom: l.payload ?? {},
      } as TriggerOutput,
    ]),
  );
}

/**
 * The trigger data with its lead as it is now: a run that waited (a Delay) checks and uses the lead's status, label and
 * fields of today, not the ones the event carried. A lead deleted since keeps what the event said.
 */
export async function withCurrentLead(workspaceId: string, trigger: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  const id = str((trigger?.lead as { id?: unknown } | null | undefined)?.id);
  if (!trigger || !id) return trigger;
  const [lead] = await leadsByIds(workspaceId, [id]);
  return lead ? { ...trigger, lead: (await leadOutputs(workspaceId, [lead])).get(lead.id) } : trigger;
}

export async function leadsByIds(workspaceId: string, ids: string[]): Promise<LeadRow[]> {
  const out: LeadRow[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...(await db.select().from(L).where(and(eq(L.workspaceId, workspaceId), inArray(L.id, ids.slice(i, i + 500))))));
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/** The lead for an address: the most recently updated one, preferring the given campaign. */
export async function leadByEmail(workspaceId: string, email: string, campaignId?: string | null): Promise<LeadRow | null> {
  const rows = await db
    .select()
    .from(L)
    .where(and(eq(L.workspaceId, workspaceId), eq(L.email, email.trim().toLowerCase())))
    .orderBy(desc(L.updatedAt))
    .limit(25);
  return rows.find((r) => campaignId && r.campaignId === campaignId) ?? rows[0] ?? null;
}

async function campaignRef(id: unknown) {
  const cid = str(id);
  return cid ? { id: cid, name: await campaignName(cid) } : null;
}

async function listRef(id: unknown) {
  const lid = str(id);
  if (!lid) return null;
  const [l] = await db.select({ name: schema.leadLists.name }).from(schema.leadLists).where(eq(schema.leadLists.id, lid)).limit(1);
  return { id: lid, name: l?.name ?? null };
}

async function accountEmail(id: unknown) {
  const aid = str(id);
  if (!aid) return null;
  const [a] = await db.select({ email: schema.emailAccounts.email }).from(schema.emailAccounts).where(eq(schema.emailAccounts.id, aid)).limit(1);
  return a?.email ?? null;
}

const campaignStatusLabel = (code: number | null) => (code === null ? null : (CAMPAIGN_STATUS_LABELS[code] ?? String(code)));

/** The trigger data for an event; several entries when one event covers many leads. */
export async function eventOutputs(ev: BusEvent): Promise<TriggerOutput[]> {
  const d = ev.data;
  const ws = ev.workspaceId;
  const head = { event: ev.type, occurred_at: new Date(ev.at).toISOString() };
  const withLead = async (extra: TriggerOutput, ref: { id?: unknown; email?: unknown; campaignId?: unknown }) => {
    const id = str(ref.id);
    const email = str(ref.email);
    const lead = id ? ((await leadsByIds(ws, [id]))[0] ?? null) : email ? await leadByEmail(ws, email, str(ref.campaignId)) : null;
    const out = lead ? (await leadOutputs(ws, [lead])).get(lead.id)! : null;
    return { ...head, lead: out, campaign: await campaignRef(str(ref.campaignId) ?? lead?.campaignId), ...extra };
  };
  switch (ev.type) {
    case "reply_received":
    case "auto_reply_received": {
      const text = str(d.text) ?? "";
      const reply = {
        subject: str(d.subject) ?? "",
        text: clip(text),
        // The preview is what the lead wrote, not our quoted email under it.
        snippet: snippet(str(d.latest_text) || newestReplyText(text) || text, 300),
        is_first: !!d.is_first,
        email_id: str(d.email_id),
        account_email: str(d.account_email),
        unibox_url: uniboxUrl(str(d.lead_email)),
      };
      return [await withLead({ reply }, { id: d.lead_id, email: d.lead_email, campaignId: d.campaign_id })];
    }
    case "email_sent": {
      const email = { step: (num(d.step) ?? 0) + 1, account_email: await accountEmail(d.account_id), last_step: !!d.completed, subsequence_id: str(d.subsequence_id) };
      return [await withLead({ email }, { id: d.lead_id, campaignId: d.campaign_id })];
    }
    case "email_opened":
      return [await withLead({ email: { step: (num(d.step) ?? 0) + 1, is_first: !!d.is_first } }, { id: d.lead_id, campaignId: d.campaign_id })];
    case "email_link_clicked":
      return [await withLead({ email: { step: (num(d.step) ?? 0) + 1 }, link: { url: str(d.url) } }, { id: d.lead_id, campaignId: d.campaign_id })];
    case "email_bounced":
      return [await withLead({ bounce: { type: d.hard ? "hard" : "soft" } }, { id: d.lead_id, campaignId: d.campaign_id })];
    case "lead_unsubscribed":
      return [await withLead({}, { id: d.lead_id, email: d.email, campaignId: d.campaign_id })];
    case "lead_interest_changed": {
      const label = await labelLookup(ws);
      const code = num(d.value);
      const previous = num(d.previous);
      const change = { label: label(code), code, previous_label: label(previous), previous_code: previous, source: str(d.source) ?? "user" };
      return [await withLead({ label_change: change }, { id: d.lead_id, email: d.lead_email, campaignId: d.campaign_id })];
    }
    case "lead_added": {
      const ids = (Array.isArray(d.lead_ids) ? d.lead_ids : []).filter((x): x is string => typeof x === "string");
      if (ids.length > MAX_RUNS_PER_EVENT) console.warn(`[automations] lead_added: ${ids.length} leads in one event, starting runs for the first ${MAX_RUNS_PER_EVENT}`);
      const leads = await leadsByIds(ws, ids.slice(0, MAX_RUNS_PER_EVENT));
      const outs = await leadOutputs(ws, leads);
      const [campaign, list] = await Promise.all([campaignRef(d.campaign_id), listRef(d.list_id)]);
      return leads.map((l) => ({ ...head, lead: outs.get(l.id)!, campaign, list }));
    }
    case "lead_status_changed":
      if (d.status !== "completed") return [];
      return [await withLead({ sequence: { replied: Number(d.reply_count ?? 0) > 0, subsequence_id: str(d.subsequence_id) } }, { id: d.lead_id, campaignId: d.campaign_id })];
    case "campaign_status_changed": {
      const deleted = d.status === "deleted";
      const code = deleted ? null : num(d.status);
      const previous = num(d.previous);
      const status = {
        code: deleted ? "deleted" : code,
        label: deleted ? "Deleted" : campaignStatusLabel(code),
        previous_code: previous,
        previous_label: campaignStatusLabel(previous),
        reason: str(d.reason),
      };
      return [{ ...head, campaign: await campaignRef(d.campaign_id), status }];
    }
    case "campaign_completed":
      return [{ ...head, campaign: await campaignRef(d.campaign_id) }];
    case "account_error":
      return [{ ...head, account: { id: str(d.account_id), email: str(d.email), error: str(d.error) } }];
    case "account_added":
      return [{ ...head, account: { id: str(d.account_id), email: str(d.email) } }];
    case "crm_task_created": {
      const assignee = str(d.assigned_to);
      const owners = await userEmails([assignee]);
      const task = { id: str(d.task_id), title: str(d.title), due_at: str(d.due_at), assigned_to: (assignee && owners.get(assignee)) || null };
      return [await withLead({ task }, { email: d.lead_email })];
    }
    case "call_completed": {
      const id = str(d.call_id);
      const [row] = id ? await db.select().from(schema.crmCalls).where(eq(schema.crmCalls.id, id)).limit(1) : [];
      const call = {
        id,
        status: str(d.status) ?? row?.status ?? null,
        direction: str(d.direction) ?? row?.direction ?? null,
        duration_sec: num(d.duration_sec) ?? row?.durationSec ?? 0,
        outcome: str(d.outcome) ?? row?.outcome ?? null,
        phone_number: row?.phoneNumber ?? null,
      };
      return [await withLead({ call }, { email: d.lead_email })];
    }
    case "sms_received":
      return [await withLead({ sms: { id: str(d.sms_id), from: str(d.from), body: clip(str(d.body) ?? "") } }, { email: d.lead_email })];
    case "website_visit": {
      const id = str(d.visit_id);
      const [s] = id ? await db.select().from(schema.visitorSessions).where(eq(schema.visitorSessions.id, id)).limit(1) : [];
      const company = (s?.companyData ?? {}) as Partial<VisitorCompany>;
      return [
        {
          ...head,
          visit: {
            id,
            site_id: str(d.site_id) ?? s?.siteId ?? null,
            landing_url: s?.landingUrl ?? null,
            pageviews: num(d.pageviews) ?? s?.pageviews ?? 0,
            duration_sec: s?.durationSec ?? 0,
            referrer: s?.referrer ?? null,
            country: s?.country ?? null,
            city: s?.city ?? null,
          },
          company: {
            name: str(d.company_name) ?? company.name ?? null,
            domain: str(d.company_domain) ?? company.domain ?? null,
            industry: company.industry ?? null,
            employee_count: company.employee_count ?? null,
            country: company.country ?? null,
            matches_icp: typeof d.matches_icp === "boolean" ? d.matches_icp : (s?.matchesIcp ?? null),
          },
        },
      ];
    }
    case "enrichment_completed":
      return [{ ...head, enrichment: { resource_id: str(d.resource_id), resource_type: str(d.resource_type), leads: num(d.leads) ?? 0, stop_reason: str(d.stop_reason) } }];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Filters

const at = (o: unknown, ...path: string[]) => path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
const isSet = (v: unknown) => v !== undefined && v !== null && v !== "";

/** Whether trigger data passes the trigger's filters (only fields the trigger has count). */
export function matchesTrigger(key: string, config: Record<string, unknown>, out: TriggerOutput): boolean {
  const fields = new Set(triggerDef(key)?.fields.map((f) => f.key) ?? []);
  const f = (k: string) => (fields.has(k) ? config[k] : undefined);
  if (isSet(f("campaign_id")) && at(out, "campaign", "id") !== f("campaign_id")) return false;
  if (f("first_only") === true && at(out, key === "email_opened" ? "email" : "reply", "is_first") !== true) return false;
  if (isSet(f("step")) && Number(at(out, "email", "step")) !== Number(f("step"))) return false;
  if (isSet(f("url_contains")) && !String(at(out, "link", "url") ?? "").toLowerCase().includes(String(f("url_contains")).trim().toLowerCase())) return false;
  if (f("hard_only") === true && at(out, "bounce", "type") !== "hard") return false;
  if (isSet(f("label"))) {
    const code = at(out, "label_change", "code");
    if (f("label") === "none" ? code !== null && code !== undefined : String(code) !== String(f("label"))) return false;
  }
  if (isSet(f("destination"))) {
    const [type, id] = String(f("destination")).split(":");
    if (at(out, type === "list" ? "list" : "campaign", "id") !== id) return false;
  }
  if (f("no_reply_only") === true && at(out, "sequence", "replied") !== false) return false;
  if (isSet(f("status")) && String(at(out, "status", "code")) !== String(f("status"))) return false;
  if (isSet(f("site_id")) && at(out, "visit", "site_id") !== f("site_id")) return false;
  if (f("icp_only") === true && at(out, "company", "matches_icp") !== true) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Events → runs

const CORE_TRIGGERS = AUTOMATION_TRIGGERS.filter((t) => t.app === "core").map((t) => t.key as BusEventType);

/** Runs each automation started for an import so far, by automation and import (an import adds its leads in parts). */
const importRuns = new Map<string, { runs: number; at: number }>();
const importKey = (wf: WorkflowRow, ev: BusEvent) => (typeof ev.data.batch_id === "string" && ev.data.batch_id ? `${wf.id}:${ev.data.batch_id}` : null);
const importRoom = (key: string | null) => (key ? MAX_RUNS_PER_EVENT - (importRuns.get(key)?.runs ?? 0) : MAX_RUNS_PER_EVENT);

async function startRuns(ev: BusEvent) {
  let flows = await db
    .select()
    .from(W)
    .where(and(eq(W.workspaceId, ev.workspaceId), eq(W.status, "active"), eq(W.triggerType, ev.type)));
  if (ev.data.batch_id) {
    for (const [key, v] of importRuns) if (Date.now() - v.at > 86_400_000) importRuns.delete(key);
    flows = flows.filter((wf) => importRoom(importKey(wf, ev)) > 0);
  }
  if (!flows.length) return;
  const depth = currentChainDepth();
  if (depth > MAX_CHAIN_DEPTH) {
    const names = flows.map((f) => `“${f.name}”`).join(", ");
    automationScope.getStore()?.notes.push(`Didn't start ${names}: automations can set each other off at most ${MAX_CHAIN_DEPTH} times in a row.`);
    return;
  }
  const outputs = await eventOutputs(ev);
  if (!outputs.length) return;
  for (const wf of flows) {
    const node = triggerNode(wf.graph);
    if (node?.data.key !== ev.type) continue;
    let matching = outputs.filter((o) => matchesTrigger(ev.type, node.data.config ?? {}, o));
    const key = importKey(wf, ev);
    if (key) {
      const room = importRoom(key);
      if (matching.length > room) console.warn(`[automations] “${wf.name}”: an import of more than ${MAX_RUNS_PER_EVENT} leads starts runs for the first ${MAX_RUNS_PER_EVENT}`);
      matching = matching.slice(0, room);
      importRuns.set(key, { runs: (importRuns.get(key)?.runs ?? 0) + matching.length, at: Date.now() });
    }
    if (matching.length) await createRuns(wf, matching, { depth });
  }
}

/** Runs started by a step's events are created before that step counts as done. */
function startFromEvent(ev: BusEvent) {
  const work = startRuns(ev);
  automationScope.getStore()?.pending.push(work.catch(() => {}));
  return work;
}

for (const type of CORE_TRIGGERS) on(type, startFromEvent);

// ---------------------------------------------------------------------------------------------------------------
// Webhooks, schedules and manual runs

const PRIVATE_HEADER = /authorization|cookie|token|secret|signature|password|api[-_]?key|^x-forwarded|^x-real-ip$|^forwarded$|^proxy-|^cf-|^true-client-ip$/i;

export interface IncomingRequest {
  method: string;
  body: unknown;
  query: unknown;
  headers: Record<string, unknown>;
  contentType: string | null;
}

export function webhookOutput(req: IncomingRequest): TriggerOutput {
  // Credentials and proxy details stay out of run data.
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k, v]) => typeof v === "string" && !PRIVATE_HEADER.test(k)));
  return {
    event: "webhook",
    occurred_at: new Date().toISOString(),
    request: { method: req.method, body: req.body ?? null, query: req.query ?? {}, headers, content_type: req.contentType },
  };
}

/** A request to an automation's webhook URL: kept as test data, and starts a run when the automation is on. */
export async function receiveWebhook(token: string, req: IncomingRequest): Promise<{ started: boolean; run_id: string | null } | null> {
  const [wf] = await db.select().from(W).where(eq(W.webhookToken, token)).limit(1);
  if (!wf || triggerNode(wf.graph)?.data.key !== "webhook") return null;
  const out = webhookOutput(req);
  await db
    .update(W)
    .set({ webhookSamples: [out, ...(wf.webhookSamples ?? [])].slice(0, 5), updatedAt: sql`${W.updatedAt}` })
    .where(eq(W.id, wf.id));
  if (wf.status !== "active") return { started: false, run_id: null };
  const run = await createRun(wf, out);
  return { started: true, run_id: run.id };
}

export const scheduleOutput = (scheduledFor: Date, runNumber: number): TriggerOutput => ({
  event: "schedule",
  occurred_at: new Date().toISOString(),
  schedule: { scheduled_for: scheduledFor.toISOString(), run_number: runNumber },
});

export const manualOutput = (user: { name: string; email: string } | null): TriggerOutput => ({ event: "manual", occurred_at: new Date().toISOString(), started_by: user });

// ---------------------------------------------------------------------------------------------------------------
// Test data: recent real records for the trigger

export interface TriggerSample {
  id: string;
  label: string;
  at: string | null;
  output: TriggerOutput;
}

type Candidate = { id: string; ev: BusEvent };

async function candidates(workspaceId: string, key: string): Promise<Candidate[]> {
  const E = schema.emailEvents;
  const make = (id: string, when: Date | null | undefined, data: Record<string, unknown>): Candidate => ({ id, ev: { type: key as BusEventType, workspaceId, at: when?.getTime() ?? Date.now(), data } });
  const events = (type: string) => db.select().from(E).where(and(eq(E.workspaceId, workspaceId), eq(E.type, type))).orderBy(desc(E.createdAt)).limit(50);
  switch (key) {
    case "reply_received":
    case "auto_reply_received": {
      const rows = await events(key === "reply_received" ? "reply" : "auto_reply");
      const ids = rows.map((r) => r.emailId).filter((x): x is string => !!x);
      const mails = ids.length ? await db.select({ id: schema.emails.id, subject: schema.emails.subject, text: schema.emails.bodyText }).from(schema.emails).where(inArray(schema.emails.id, ids)) : [];
      const byId = new Map(mails.map((m) => [m.id, m]));
      return rows.map((r) => {
        const m = byId.get(r.emailId ?? "");
        return make(r.id, r.createdAt, { lead_id: r.leadId, lead_email: r.leadEmail, campaign_id: r.campaignId, email_id: r.emailId, account_email: r.accountEmail, subject: m?.subject ?? "", text: m?.text ?? "", is_first: r.isFirst });
      });
    }
    case "email_sent":
      return (await events("sent")).map((r) => make(r.id, r.createdAt, { lead_id: r.leadId, campaign_id: r.campaignId, subsequence_id: r.subsequenceId, step: r.step, completed: false, account_id: r.accountId }));
    case "email_opened":
      return (await events("open")).map((r) => make(r.id, r.createdAt, { lead_id: r.leadId, campaign_id: r.campaignId, step: r.step, is_first: r.isFirst }));
    case "email_link_clicked":
      return (await events("click")).map((r) => make(r.id, r.createdAt, { lead_id: r.leadId, campaign_id: r.campaignId, step: r.step, url: r.url }));
    case "email_bounced":
      return (await events("bounce")).map((r) => make(r.id, r.createdAt, { lead_id: r.leadId, campaign_id: r.campaignId, hard: r.value === 1 }));
    case "lead_unsubscribed":
      return (await events("unsubscribe")).map((r) => make(r.id, r.createdAt, { lead_id: r.leadId, email: r.leadEmail, campaign_id: r.campaignId }));
    case "lead_interest_changed":
      return (await events("interest_change")).map((r) => make(r.id, r.createdAt, { lead_id: r.leadId, lead_email: r.leadEmail, campaign_id: r.campaignId, value: r.value, previous: null, source: "user" }));
    case "lead_added": {
      const rows = await db.select({ id: L.id, campaignId: L.campaignId, listId: L.listId, createdAt: L.createdAt }).from(L).where(eq(L.workspaceId, workspaceId)).orderBy(desc(L.createdAt)).limit(50);
      return rows.map((r) => make(r.id, r.createdAt, { lead_ids: [r.id], campaign_id: r.campaignId, list_id: r.listId }));
    }
    case "lead_status_changed": {
      const rows = await db
        .select({ id: L.id, campaignId: L.campaignId, replyCount: L.replyCount, completedAt: L.completedAt })
        .from(L)
        .where(and(eq(L.workspaceId, workspaceId), eq(L.status, LeadStatus.COMPLETED), isNotNull(L.completedAt)))
        .orderBy(desc(L.completedAt))
        .limit(50);
      return rows.map((r) => make(r.id, r.completedAt, { lead_id: r.id, campaign_id: r.campaignId, status: "completed", reply_count: r.replyCount, subsequence_id: null }));
    }
    case "campaign_status_changed":
    case "campaign_completed": {
      const C = schema.campaigns;
      const conds = [eq(C.workspaceId, workspaceId), ...(key === "campaign_completed" ? [eq(C.status, CampaignStatus.COMPLETED)] : [])];
      const rows = await db.select({ id: C.id, status: C.status, updatedAt: C.updatedAt }).from(C).where(and(...conds)).orderBy(desc(C.updatedAt)).limit(50);
      return rows.map((r) => make(r.id, r.updatedAt, { campaign_id: r.id, status: r.status, previous: null }));
    }
    case "account_error":
    case "account_added": {
      const A = schema.emailAccounts;
      const conds = [eq(A.workspaceId, workspaceId), ...(key === "account_error" ? [lt(A.status, 0)] : [])];
      const rows = await db.select().from(A).where(and(...conds)).orderBy(desc(key === "account_error" ? A.lastErrorAt : A.createdAt)).limit(50);
      return rows.map((r) =>
        make(r.id, key === "account_error" ? r.lastErrorAt : r.createdAt, { account_id: r.id, email: r.email, error: (r.statusMessage as { e_message?: string } | null)?.e_message ?? null }),
      );
    }
    case "crm_task_created": {
      const T = schema.crmTasks;
      const rows = await db.select().from(T).where(eq(T.workspaceId, workspaceId)).orderBy(desc(T.createdAt)).limit(50);
      return rows.map((r) => make(r.id, r.createdAt, { task_id: r.id, title: r.title, lead_email: r.leadEmail, assigned_to: r.assignedTo, due_at: r.dueAt?.toISOString() ?? null }));
    }
    case "call_completed": {
      const C = schema.crmCalls;
      const rows = await db.select().from(C).where(eq(C.workspaceId, workspaceId)).orderBy(desc(C.createdAt)).limit(50);
      return rows.map((r) => make(r.id, r.createdAt, { call_id: r.id, status: r.status, lead_email: r.leadEmail, direction: r.direction, duration_sec: r.durationSec, outcome: r.outcome }));
    }
    case "sms_received": {
      const S = schema.crmSms;
      const rows = await db
        .select()
        .from(S)
        .where(and(eq(S.workspaceId, workspaceId), eq(S.direction, "inbound")))
        .orderBy(desc(S.createdAt))
        .limit(50);
      return rows.map((r) => make(r.id, r.createdAt, { sms_id: r.id, from: r.phoneNumber, body: r.body, lead_email: r.leadEmail }));
    }
    case "website_visit": {
      const V = schema.visitorSessions;
      const rows = await db
        .select()
        .from(V)
        .where(and(eq(V.workspaceId, workspaceId), eq(V.identified, true), eq(V.hidden, false)))
        .orderBy(desc(V.lastSeenAt))
        .limit(50);
      return rows.map((r) => make(r.id, r.lastSeenAt, { visit_id: r.id, site_id: r.siteId, company_name: r.companyName, company_domain: r.companyDomain, matches_icp: r.matchesIcp, pageviews: r.pageviews }));
    }
    case "enrichment_completed": {
      const R = schema.enrichmentRuns;
      const rows = await db
        .select()
        .from(R)
        .where(and(eq(R.workspaceId, workspaceId), isNotNull(R.finishedAt)))
        .orderBy(desc(R.finishedAt))
        .limit(50);
      const resources = [...new Set(rows.map((r) => r.resourceId))];
      const campaigns = resources.length ? await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(inArray(schema.campaigns.id, resources)) : [];
      const isCampaign = new Set(campaigns.map((c) => c.id));
      return rows.map((r) =>
        make(r.id, r.finishedAt, { resource_id: r.resourceId, resource_type: isCampaign.has(r.resourceId) ? "campaign" : "list", leads: r.processed, stop_reason: r.status === "completed" ? null : (r.error ?? r.status) }),
      );
    }
    default:
      return [];
  }
}

function sampleLabel(out: TriggerOutput): string {
  const name = (path: string[]) => str(at(out, ...path));
  const subject = name(["lead", "email"]) ?? name(["account", "email"]) ?? name(["company", "name"]) ?? name(["task", "title"]) ?? name(["sms", "from"]) ?? name(["campaign", "name"]);
  const extra = out.lead ? name(["campaign", "name"]) : out.status ? name(["status", "label"]) : null;
  return [subject ?? "Record", extra].filter(Boolean).join(" · ");
}

/** Recent records that match the trigger and its filters, newest first. */
export async function triggerSamples(wf: WorkflowRow, key: string, config: Record<string, unknown>, user: { name: string; email: string } | null): Promise<TriggerSample[]> {
  if (key === "webhook") {
    return (wf.webhookSamples ?? []).map((out, i) => {
      const request = (out.request ?? {}) as { method?: string; content_type?: string | null };
      return { id: `webhook-${i}`, label: [request.method ?? "POST", request.content_type].filter(Boolean).join(" · "), at: str(out.occurred_at), output: out };
    });
  }
  if (key === "schedule") {
    const when = wf.nextRunAt ?? new Date();
    return [{ id: "schedule", label: "Next scheduled run", at: when.toISOString(), output: scheduleOutput(when, wf.runCount + 1) }];
  }
  if (key === "manual") return [{ id: "manual", label: user ? `Started by ${user.name || user.email}` : "Manual start", at: new Date().toISOString(), output: manualOutput(user) }];
  const out: TriggerSample[] = [];
  for (const c of await candidates(wf.workspaceId, key)) {
    for (const o of await eventOutputs(c.ev)) {
      if (!matchesTrigger(key, config, o)) continue;
      out.push({ id: c.id, label: sampleLabel(o), at: str(o.occurred_at), output: o });
    }
    if (out.length >= 10) break;
  }
  return out.slice(0, 10);
}

// What each automation action does. A runner gets the step's fields with every {{ }} reference filled in and
// returns the step's output, which later steps reference as {{steps.<id>.…}}.
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as z from "zod/v4";
import {
  CAMPAIGN_STATUS_LABELS,
  CampaignStatus,
  INTEREST_STATUS_LABELS,
  LEAD_STATUS_LABELS,
  LeadStatus,
  domainOf,
  fieldVisible,
  defaultConfig,
  isValidEmailSyntax,
  resolveDate,
  resolveValue,
  type ActionDef,
  type OutputField,
  type RunVariables,
} from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { describeFetchError, safeFetch } from "../../lib/net";
import { completeLeads, pauseLeads, resumeLeads, setInterestStatus } from "../activity";
import { aiErrorMessage, structured } from "../ai";
import { addBlocked, blockValue } from "../blocklist";
import { launchProblems, setCampaignStatus } from "../campaigns";
import { createTask, dealsFollowOwner, isKnownStatus } from "../crm";
import { postToSlack } from "../integrations";
import { addLeads, moveLeads, type LeadInput } from "../leads";
import { enrollInSubsequence } from "../subsequences";
import { sendSystemMail, systemMailLayout } from "../system-mail";
import { workspaceZone } from "../workspace-clock";
import type { RunRow, WorkflowRow } from "./runs";
import { leadByEmail, leadsByIds } from "./triggers";

const L = schema.leads;
type LeadRow = typeof L.$inferSelect;
type Output = Record<string, unknown>;

/** A step failure with a message for the run's History (and, optionally, what the step got back). */
export class StepError extends Error {
  output: Output | null;
  constructor(message: string, output: Output | null = null) {
    super(message);
    this.output = output;
  }
}

export interface ActionContext {
  workspaceId: string;
  workflow: Pick<WorkflowRow, "id" | "name">;
  run: Pick<RunRow, "id" | "isTest"> | null;
  vars: RunVariables;
  /** The step's fields, references filled in. */
  values: Record<string, unknown>;
  log(message: string, level?: "info" | "warn"): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Filling in fields

export type KeyValueRow = { key: string; value: unknown };

/** Fields with defaults applied and every {{ }} reference resolved; hidden fields are left out. */
export function resolveFields(def: ActionDef, config: Record<string, unknown>, vars: RunVariables): Record<string, unknown> {
  const merged = { ...defaultConfig(def.fields), ...config };
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (!fieldVisible(f, merged)) continue;
    const raw = merged[f.key];
    if (f.kind === "keyvalue") {
      const rows = Array.isArray(raw) ? (raw as Array<{ key?: unknown; value?: unknown }>) : [];
      out[f.key] = rows.filter((r) => String(r?.key ?? "").trim()).map((r) => ({ key: String(r.key).trim(), value: resolveValue(r.value ?? "", vars) }));
    } else out[f.key] = typeof raw === "string" && raw.includes("{{") ? resolveValue(raw, vars) : raw;
  }
  return out;
}

const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).trim();

/** Required fields that came out empty once their references were filled in. */
export function emptyRequired(def: ActionDef, values: Record<string, unknown>): string[] {
  return def.fields
    .filter((f) => f.required && f.key in values)
    .filter((f) => {
      const v = values[f.key];
      if (f.kind === "boolean") return false;
      if (Array.isArray(v)) return f.kind === "output_fields" ? !v.some((r) => text((r as { name?: unknown }).name)) : v.length === 0;
      return text(v) === "";
    })
    .map((f) => f.label);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared lookups

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs in the catalog's example data (see EXAMPLE_LEAD in the shared catalog). */
const EXAMPLE_ID = /^00000000-0000-7000-8000-00000000e0[0-9a-f]{2}$/i;
const exampleError = (what: string) =>
  new StepError(`This step needs a real ${what}, but the trigger was tested with example data. Test the trigger with a real record, or fill in the field yourself.`);

/** The lead a step works on: a lead ID or an email address (the most recent lead with it, preferring the trigger's campaign). */
async function findLead(c: ActionContext): Promise<LeadRow> {
  const ref = text(c.values.lead);
  if (!ref) throw new StepError("The Lead field is empty. Choose the lead this step works on.");
  const trigger = c.vars.trigger as { example?: unknown; lead?: { email?: unknown } };
  if (EXAMPLE_ID.test(ref) || (trigger.example === true && ref === text(trigger.lead?.email))) throw exampleError("lead");
  const campaignId = text((c.vars.trigger as { campaign?: { id?: unknown } }).campaign?.id) || null;
  const lead = UUID.test(ref) ? ((await leadsByIds(c.workspaceId, [ref]))[0] ?? null) : ref.includes("@") ? await leadByEmail(c.workspaceId, ref, campaignId) : null;
  if (!lead) throw new StepError(`No lead found for “${ref}”.`);
  return lead;
}

const leadOut = (lead: LeadRow, extra: Output = {}): Output => ({ lead_id: lead.id, email: lead.email, ...extra });

async function destination(workspaceId: string, value: unknown) {
  const [type, id] = text(value).split(":");
  if (!id || (type !== "campaign" && type !== "list")) throw new StepError("Choose a campaign or list.");
  if (type === "campaign") {
    const [c] = await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.workspaceId, workspaceId)));
    if (!c) throw new StepError("The chosen campaign no longer exists. Choose another one.");
    return { type: "campaign" as const, id: c.id, name: c.name };
  }
  const [l] = await db.select({ id: schema.leadLists.id, name: schema.leadLists.name }).from(schema.leadLists).where(and(eq(schema.leadLists.id, id), eq(schema.leadLists.workspaceId, workspaceId)));
  if (!l) throw new StepError("The chosen list no longer exists. Choose another one.");
  return { type: "list" as const, id: l.id, name: l.name };
}

/** Accepted workspace members among the given user IDs whose accounts still work, with their sign-in address. */
async function members(workspaceId: string, userIds: string[]) {
  if (!userIds.length) return [];
  const M = schema.workspaceMembers;
  const U = schema.users;
  return db
    .select({ userId: M.userId, email: U.email })
    .from(M)
    .innerJoin(U, eq(U.id, M.userId))
    .where(and(eq(M.workspaceId, workspaceId), eq(M.accepted, true), inArray(M.userId, userIds), isNull(U.deletedAt), isNull(U.disabledAt)));
}

async function labelName(workspaceId: string, code: number | null) {
  if (code === null) return null;
  if (INTEREST_STATUS_LABELS[code]) return INTEREST_STATUS_LABELS[code]!;
  const [row] = await db
    .select({ label: schema.leadLabels.label })
    .from(schema.leadLabels)
    .where(and(eq(schema.leadLabels.workspaceId, workspaceId), eq(schema.leadLabels.interestStatus, code)))
    .limit(1);
  return row?.label ?? `Label ${code}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const LEAD_COLUMNS: Record<string, keyof typeof L.$inferInsert> = {
  first_name: "firstName",
  last_name: "lastName",
  company_name: "companyName",
  company_domain: "companyDomain",
  job_title: "jobTitle",
  phone: "phone",
  website: "website",
  linkedin_url: "linkedinUrl",
  location: "location",
  personalization: "personalization",
  pl_value_lead: "plValueLead",
};
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// ---------------------------------------------------------------------------------------------------------------
// AI step

function aiSchema(fields: OutputField[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    const described = <T extends z.ZodType>(s: T) => (f.description?.trim() ? s.describe(f.description.trim()) : s);
    if (f.type === "number") shape[f.name] = described(z.number());
    else if (f.type === "boolean") shape[f.name] = described(z.boolean());
    else if (f.type === "array") shape[f.name] = described(z.array(z.string()));
    else if (f.type === "enum" && f.values?.filter((v) => v.trim()).length) shape[f.name] = described(z.enum(f.values.filter((v) => v.trim()) as [string, ...string[]]));
    else shape[f.name] = described(z.string());
  }
  return z.object(shape);
}

function fieldNotes(fields: OutputField[]) {
  return fields
    .map((f) => {
      const rules = [
        f.type === "number" && f.integer ? "a whole number" : null,
        f.type === "number" && f.min !== null && f.min !== undefined ? `at least ${f.min}` : null,
        f.type === "number" && f.max !== null && f.max !== undefined ? `at most ${f.max}` : null,
        f.type === "enum" && f.values?.length ? `one of: ${f.values.join(", ")}` : null,
      ].filter(Boolean);
      return `- ${f.name} (${f.type}${rules.length ? `; ${rules.join(", ")}` : ""})${f.description?.trim() ? `: ${f.description.trim()}` : ""}`;
    })
    .join("\n");
}

const AI_SYSTEM = `You are one step in an automation for a cold email outreach workspace. Follow the user's instructions using only the data they include, and return every requested field. When the data doesn't say, give your best careful judgment rather than inventing facts. Write plainly; no preamble.`;

// ---------------------------------------------------------------------------------------------------------------
// Runners

export type ActionRunner = (c: ActionContext) => Promise<Output>;

export const ACTION_RUNNERS: Record<string, ActionRunner> = {
  async set_lead_label(c) {
    const lead = await findLead(c);
    const raw = text(c.values.label);
    const code = raw === "none" ? null : Number(raw);
    if (code !== null && (!Number.isInteger(code) || !(await isKnownStatus(c.workspaceId, code)))) throw new StepError("The chosen label no longer exists. Choose another one.");
    const changed = await setInterestStatus({ workspaceId: c.workspaceId, leadIds: [lead.id], value: code, source: "automation" });
    return leadOut(lead, { label: await labelName(c.workspaceId, code), label_code: code, changed: changed > 0 });
  },

  async move_lead(c) {
    const lead = await findLead(c);
    const to = await destination(c.workspaceId, c.values.destination);
    const copy = c.values.copy === true;
    const already = to.type === "campaign" ? lead.campaignId === to.id : lead.listId === to.id;
    if (already && !copy) {
      c.log(`The lead is already in “${to.name}”, so it wasn't moved.`, "warn");
      return leadOut(lead, { moved: false, moved_to: to, copied: false, skipped_reason: "Already there" });
    }
    const r = await moveLeads({ workspaceId: c.workspaceId, leadIds: [lead.id], ...(to.type === "campaign" ? { toCampaignId: to.id } : { toListId: to.id }), copy });
    if (!r.moved.length) {
      c.log(`The lead is already in “${to.name}”, so it wasn't ${copy ? "copied" : "moved"}.`, "warn");
      return leadOut(lead, { moved: false, moved_to: to, copied: false, skipped_reason: "Already there" });
    }
    return leadOut(lead, { moved: true, moved_to: to, copied: copy, skipped_reason: null });
  },

  async add_lead(c) {
    const to = await destination(c.workspaceId, c.values.destination);
    const email = text(c.values.email).toLowerCase();
    if (!isValidEmailSyntax(email)) throw new StepError(`“${email}” isn't a valid email address.`);
    const custom: Record<string, string | number | boolean | null> = {};
    for (const row of (c.values.custom as KeyValueRow[] | undefined) ?? []) {
      const v = row.value;
      custom[row.key] = v === null || v === undefined || v === "" ? null : typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean);
    }
    const field = (k: string) => text(c.values[k]) || null;
    const input: LeadInput = {
      email,
      first_name: field("first_name"),
      last_name: field("last_name"),
      company_name: field("company_name"),
      job_title: field("job_title"),
      phone: field("phone"),
      website: field("website"),
      personalization: field("personalization"),
      ...(Object.keys(custom).length ? { custom_variables: custom } : {}),
    };
    const r = await addLeads({
      workspaceId: c.workspaceId,
      ...(to.type === "campaign" ? { campaignId: to.id } : { listId: to.id }),
      leads: [input],
      uploadMethod: "automation",
      skipIfInWorkspace: c.values.skip_existing !== false,
    });
    const created = r.created_leads[0];
    if (created) return { lead_id: created.id, email, added: true, skipped_reason: null, destination: to };
    const reason = r.in_blocklist
      ? "On the blocklist"
      : r.invalid_email_count
        ? "Invalid email address"
        : r.duplicated_leads || r.skipped_count || r.duplicate_email_count
          ? c.values.skip_existing !== false
            ? "Already in the workspace"
            : `Already in this ${to.type}`
          : "Not added";
    c.log(`${email} wasn't added: ${reason.toLowerCase()}.`, "warn");
    return { lead_id: null, email, added: false, skipped_reason: reason, destination: to };
  },

  async update_lead(c) {
    const lead = await findLead(c);
    const set: Partial<typeof L.$inferInsert> = {};
    const custom: Record<string, unknown> = { ...(lead.payload ?? {}) };
    const updated: string[] = [];
    let customChanged = false;
    for (const row of (c.values.values as KeyValueRow[] | undefined) ?? []) {
      const value = text(row.value);
      const column = LEAD_COLUMNS[row.key];
      if (column) (set as Record<string, unknown>)[column] = column === "companyDomain" ? value.toLowerCase() : value || null;
      else {
        custom[row.key] = value === "" ? null : typeof row.value === "number" || typeof row.value === "boolean" ? row.value : value;
        customChanged = true;
      }
      updated.push(row.key);
    }
    if (!updated.length) throw new StepError("Add at least one field to update.");
    if (customChanged) set.payload = custom;
    await db.update(L).set(set).where(eq(L.id, lead.id));
    return leadOut(lead, { updated });
  },

  async lead_sending(c) {
    const lead = await findLead(c);
    const mode = text(c.values.mode);
    const change = mode === "pause" ? pauseLeads : mode === "resume" ? resumeLeads : mode === "stop" ? completeLeads : null;
    if (!change) throw new StepError("Choose whether to pause, resume or stop the lead.");
    // In its campaign and in a subsequence alike.
    await change(eq(L.id, lead.id));
    const [now] = await db.select({ status: L.status, subseqStatus: L.subseqStatus }).from(L).where(eq(L.id, lead.id));
    const changed = !!now && (now.status !== lead.status || now.subseqStatus !== lead.subseqStatus);
    const status = now?.status ?? lead.status;
    if (!changed) c.log(`Nothing to change: the lead's status is ${LEAD_STATUS_LABELS[status] ?? status}.`);
    return leadOut(lead, { status: LEAD_STATUS_LABELS[status] ?? String(status), changed });
  },

  async assign_lead(c) {
    const lead = await findLead(c);
    const [member] = await members(c.workspaceId, [text(c.values.member)]);
    if (!member?.userId) throw new StepError("The chosen owner is no longer a member of this workspace. Choose another one.");
    await db.update(L).set({ assignedTo: member.userId }).where(eq(L.id, lead.id));
    await dealsFollowOwner(c.workspaceId, [lead.id], member.userId);
    return leadOut(lead, { owner_email: member.email });
  },

  async add_note(c) {
    const lead = await findLead(c);
    const body = text(c.values.note).slice(0, 20_000);
    const [row] = await db
      .insert(schema.leadNotes)
      .values({ workspaceId: c.workspaceId, leadId: lead.id, leadEmail: lead.email?.toLowerCase() ?? null, body, createdBy: null })
      .returning({ id: schema.leadNotes.id });
    return leadOut(lead, { note_id: row!.id });
  },

  async add_to_subsequence(c) {
    const lead = await findLead(c);
    const S = schema.subsequences;
    const [sub] = await db
      .select()
      .from(S)
      .where(and(eq(S.id, text(c.values.subsequence_id)), eq(S.workspaceId, c.workspaceId)))
      .limit(1);
    if (!sub) throw new StepError("The chosen subsequence no longer exists. Choose another one.");
    if (lead.campaignId !== sub.parentCampaignId) {
      const [parent] = await db.select({ name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.id, sub.parentCampaignId));
      throw new StepError(`The lead isn't in “${parent?.name ?? "the subsequence's campaign"}”, the campaign this subsequence belongs to.`);
    }
    if (lead.status === LeadStatus.BOUNCED || lead.status === LeadStatus.UNSUBSCRIBED) throw new StepError(`The lead is ${LEAD_STATUS_LABELS[lead.status]!.toLowerCase()}, so it can't start a subsequence.`);
    await enrollInSubsequence(lead, sub);
    return leadOut(lead, { subsequence: { id: sub.id, name: sub.name } });
  },

  async create_task(c) {
    // A typed date is the workspace's: "2026-03-01 15:00" is 3 PM on its clock, wherever the server runs.
    const due = c.values.due ? resolveDate(c.values.due, new Date(), await workspaceZone(c.workspaceId)) : null;
    if (c.values.due && !due) throw new StepError(`“${text(c.values.due)}” isn't a date. Use a date or an expression such as $now + 2d.`);
    const assignee = text(c.values.assignee);
    const [member] = assignee ? await members(c.workspaceId, [assignee]) : [];
    if (assignee && !member?.userId) throw new StepError("The chosen assignee is no longer a member of this workspace. Choose another one.");
    const task = await createTask(c.workspaceId, null, {
      title: text(c.values.title).slice(0, 300),
      description: text(c.values.description) || null,
      type: text(c.values.type) || "todo",
      priority: text(c.values.priority) || "normal",
      due_at: due?.toISOString() ?? null,
      lead_email: text(c.values.lead_email) || null,
      assigned_to: member?.userId ?? null,
      source: "automation",
    });
    return { task_id: task.id, title: task.title, due_at: task.dueAt?.toISOString() ?? null, assigned_to: member?.email ?? null };
  },

  async add_to_blocklist(c) {
    const raw = text(c.values.value).toLowerCase();
    const value = c.values.block_domain === true && raw.includes("@") ? domainOf(raw) : raw;
    if (!blockValue(value)) throw new StepError(`“${raw}” isn't an email address or domain.`);
    const r = await addBlocked(c.workspaceId, [value], "automation");
    return { value, added: r.added > 0 };
  },

  async campaign_status(c) {
    const id = text(c.values.campaign_id);
    if (EXAMPLE_ID.test(id)) throw exampleError("campaign");
    const C = schema.campaigns;
    const [campaign] = id ? await db.select().from(C).where(and(eq(C.id, id), eq(C.workspaceId, c.workspaceId))).limit(1) : [];
    if (!campaign) throw new StepError(id ? "The campaign no longer exists." : "The trigger has no campaign. Choose a campaign.");
    const target = text(c.values.status) === "pause" ? CampaignStatus.PAUSED : CampaignStatus.ACTIVE;
    const label = (s: number) => CAMPAIGN_STATUS_LABELS[s] ?? String(s);
    if (campaign.status === target) {
      c.log(`“${campaign.name}” is already ${label(target).toLowerCase()}.`);
      return { campaign_id: campaign.id, name: campaign.name, status: label(target), previous_status: label(campaign.status), changed: false };
    }
    if (target === CampaignStatus.ACTIVE) {
      const problems = await launchProblems(campaign);
      if (problems.length) throw new StepError(`“${campaign.name}” can't be launched: ${problems.join(" ")}`);
    }
    await setCampaignStatus(campaign, target);
    return { campaign_id: campaign.id, name: campaign.name, status: label(target), previous_status: label(campaign.status), changed: true };
  },

  async notify_team(c) {
    const ids = (Array.isArray(c.values.to) ? c.values.to : [c.values.to]).map(text).filter(Boolean);
    const to = [...new Set((await members(c.workspaceId, ids)).map((m) => m.email.toLowerCase()))];
    if (!to.length) throw new StepError("None of the chosen people are members of this workspace any more. Choose who gets the email.");
    const subject = text(c.values.subject).slice(0, 300);
    const body = text(c.values.body);
    const paragraphs = body.split(/\n{2,}/).map((p) => escapeHtml(p).replace(/\n/g, "<br/>"));
    const { html } = systemMailLayout(escapeHtml(subject), paragraphs);
    for (const address of to) await sendSystemMail({ to: address, subject, text: `${subject}\n\n${body}\n\n— ${c.workflow.name}`, html });
    return { sent_to: to, subject };
  },

  async slack_message(c) {
    const ok = await postToSlack(c.workspaceId, text(c.values.connection_id), text(c.values.text));
    if (!ok) throw new StepError("Slack didn't accept the message. Check the connection in Settings → Integrations & API → Apps.");
    return { delivered: true };
  },

  async send_webhook(c) {
    const method = (text(c.values.method) || "POST").toUpperCase();
    const headers: Record<string, string> = {};
    for (const row of (c.values.headers as KeyValueRow[] | undefined) ?? []) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(row.key) || /^(host|content-length|connection|transfer-encoding)$/i.test(row.key)) throw new StepError(`“${row.key}” can't be used as a header name.`);
      headers[row.key.toLowerCase()] = text(row.value).replace(/[\r\n]+/g, " ");
    }
    let body: string | undefined;
    if (method !== "GET") {
      const mode = text(c.values.body_mode) || "trigger";
      if (mode === "raw") {
        body = text(c.values.raw);
        if (!headers["content-type"]) {
          let json = false;
          try {
            JSON.parse(body);
            json = true;
          } catch {
            // plain text
          }
          headers["content-type"] = json ? "application/json" : "text/plain; charset=utf-8";
        }
      } else {
        const payload = mode === "fields" ? Object.fromEntries(((c.values.fields as KeyValueRow[] | undefined) ?? []).map((r) => [r.key, r.value ?? null])) : c.vars.trigger;
        body = JSON.stringify(payload);
        headers["content-type"] ??= "application/json";
      }
    }
    let res: Response;
    try {
      res = await safeFetch(text(c.values.url), { method, headers, body, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new StepError(`The request failed: ${(err as { statusCode?: number }).statusCode ? (err as Error).message : describeFetchError(err)}`);
    }
    const raw = (await res.text().catch(() => "")).slice(0, 50_000);
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // keep the text
    }
    const output = { status: res.status, ok: res.ok, body: parsed };
    if (!res.ok) throw new StepError(`The server answered HTTP ${res.status}.`, output);
    return output;
  },

  async ai_prompt(c) {
    const fields = ((c.values.output_fields as OutputField[] | undefined) ?? []).filter((f) => text(f?.name));
    if (!fields.length) throw new StepError("Add at least one field for the AI to return.");
    const bad = fields.find((f) => !IDENTIFIER.test(f.name));
    if (bad) throw new StepError(`“${bad.name}” can't be used as a field name. Use letters, numbers and underscores, starting with a letter.`);
    let answer: Record<string, unknown>;
    try {
      answer = await structured({
        workspaceId: c.workspaceId,
        feature: "automation",
        system: AI_SYSTEM,
        messages: [{ role: "user", content: `${text(c.values.prompt)}\n\nReturn these fields:\n${fieldNotes(fields)}` }],
        schema: aiSchema(fields),
        effort: "low",
        maxTokens: 8_000,
      });
    } catch (err) {
      throw new StepError(aiErrorMessage(err));
    }
    for (const f of fields) {
      const v = answer[f.name];
      if (f.type !== "number" || typeof v !== "number") continue;
      let n = f.integer ? Math.round(v) : v;
      if (f.min !== null && f.min !== undefined) n = Math.max(f.min, n);
      if (f.max !== null && f.max !== undefined) n = Math.min(f.max, n);
      answer[f.name] = n;
    }
    return answer;
  },

  async log(c) {
    const message = text(c.values.message).slice(0, 2_000);
    c.log(message);
    return { message };
  },
};

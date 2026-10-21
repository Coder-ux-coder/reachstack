// Leads, lead lists, block list, lead labels, custom tags and background jobs (API v2 + app endpoints).
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import Papa from "papaparse";
import { z } from "zod";
import {
  APP_VARIABLES,
  AuditActivity,
  DEFAULT_INTEREST_STATUSES,
  LEAD_EDIT_FIELDS,
  LEAD_IMPORT_MAX,
  LEAD_SORTS,
  LEAD_SORT_KEYS,
  MAX_LEAD_RULES,
  VerificationStatus,
  domainOf,
  inferLeadTimezone,
  isLeadFieldName,
  parseTimezone,
  unescapeCsvFormula,
  type LeadEditField,
  type LeadSortKey,
  type Permission,
} from "@reachstack/shared";
import { contains, db, schema } from "../db/client";
import { config } from "../env";
import { ctx } from "../http/context";
import { may } from "../http/auth";
import { HttpError, assertFound, badRequest, conflict, forbidden, notFound } from "../http/errors";
import { body, chunk, pageQuery, paginated, query, zBool, zList } from "../http/util";
import { iso } from "../lib/time";
import { completeLeads, pauseLeads, resumeLeads, setInterestStatus } from "../services/activity";
import { actorForUser, actorOf, audit } from "../services/audit";
import { blockValue } from "../services/blocklist";
import { addJobInputPart, cleanUpJob, createJob, dropJobInput, getJob, JOB_PERMISSIONS, jobInputPart, registerJobHandler, serializeJob, type JobRow } from "../services/jobs";
import { afterLead, leadRuleSchema, requestedSort, serializeSavedView, sortOrder } from "../services/lead-filters";
import { deleteLeadVariable, leadsWithVariable, listLeadVariables, renameLeadVariable } from "../services/lead-variables";
import {
  addLeads,
  deleteLeadsWhere,
  EDIT_INLINE_MAX,
  editLeads,
  isFiltered,
  leadActivity,
  leadConditions,
  leadFilterSchema,
  leadInputSchema,
  mailCodes,
  moveLeads,
  serializeLead,
  type LeadEdit,
  type LeadFilter,
  type LeadRow,
} from "../services/leads";
import { nextLabelCode, retireLabelCode } from "../services/lead-labels";
import { dealsFollowOwner } from "../services/crm";
import { assertMembers } from "../services/members";
import { trashLeadList, trashLeads } from "../services/recently-deleted";
import { enrollInSubsequence, removeFromSubsequence } from "../services/subsequences";
import { assertTags, serializeTag } from "../services/tags";
import { toCsv } from "../lib/csv";

const L = schema.leads;

async function findLead(wsId: string, id: string): Promise<LeadRow> {
  const [row] = await db.select().from(L).where(and(eq(L.id, id), eq(L.workspaceId, wsId))).limit(1);
  return assertFound(row, "Lead");
}

function serializeList(l: typeof schema.leadLists.$inferSelect, count?: number) {
  return {
    id: l.id,
    organization_id: l.workspaceId,
    name: l.name,
    has_enrichment_task: l.hasEnrichmentTask,
    owned_by: l.ownedBy,
    timestamp_created: iso(l.createdAt),
    ...(count !== undefined ? { lead_count: count } : {}),
  };
}

function serializeBlock(b: typeof schema.blockList.$inferSelect) {
  return { id: b.id, organization_id: b.workspaceId, bl_value: b.value, is_domain: b.isDomain, source: b.source, timestamp_created: iso(b.createdAt) };
}

function serializeLabel(l: typeof schema.leadLabels.$inferSelect) {
  return {
    id: l.id,
    organization_id: l.workspaceId,
    timestamp_created: iso(l.createdAt),
    created_by: l.createdBy,
    label: l.label,
    interest_status_label: l.interestStatusLabel,
    interest_status: l.interestStatus,
    description: l.description,
    use_with_ai: l.useWithAi,
    color: l.color,
  };
}

/** Bulk changes need a selection: a filter that went missing never widens one to every lead of the workspace. */
const everyLead = { all_leads: z.boolean().optional() };
function assertSelection(b: LeadFilter & { all_leads?: boolean }) {
  if (!isFiltered(b) && !b.all_leads) throw badRequest("Choose the leads: select them, or a campaign, list or filter. To include every lead in the workspace, send all_leads: true.");
}

const editSchema = leadFilterSchema.extend({
  ...everyLead,
  field: z.enum(LEAD_EDIT_FIELDS.map((f) => f.value) as [LeadEditField, ...LeadEditField[]]).optional(),
  variable: z.string().trim().min(1, "Name the variable").max(64, "A variable name has up to 64 characters").optional(),
  value: z.string().max(10_000, "A value has up to 10,000 characters").nullable(),
});
type EditRequest = Pick<z.infer<typeof editSchema>, "field" | "variable" | "value">;

const variableName = z.string().trim().min(1, "Name the variable").max(64, "A variable name has up to 64 characters");

/** A name a custom variable can be given, or the reason it can't. */
function checkVariableName(name: string) {
  if (/[{}|]/.test(name) || name === "__proto__") throw badRequest("A variable name can't have { } or | in it.");
  if (isLeadFieldName(name)) throw badRequest(`“${name}” is one of the lead's own fields. Choose it from the list instead.`);
  checkAppVariable(name);
}

/** Variables the app reads stay as they are. */
function checkAppVariable(name: string) {
  if (Object.hasOwn(APP_VARIABLES, name)) throw badRequest(`{{${name}}} can't be changed: ${APP_VARIABLES[name]}`);
}

/** What a request to edit leads asks for, refused when it can't be done. */
function leadEditOf(b: EditRequest): LeadEdit {
  if (!b.field === !b.variable) throw badRequest("Choose one field or custom variable to change.");
  if (b.field) {
    if (b.field === "timezone") checkTimezone(b.value?.trim());
    return { field: b.field, value: b.value };
  }
  checkVariableName(b.variable!);
  return { variable: b.variable!, value: b.value };
}

const moveSchema = leadFilterSchema.extend({
  ...everyLead,
  to_campaign_id: z.string().optional(),
  to_list_id: z.string().optional(),
  ignore_resource_filter_clauses: z.boolean().optional(),
  check_duplicates_in_campaigns: z.boolean().optional(),
  skip_leads_in_verification: z.boolean().optional(),
  skip_invalid_emails: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  copy_leads: z.boolean().optional(),
  check_duplicates: z.boolean().optional(),
  reset_interest_status: z.boolean().optional(),
  assign_to: z.string().optional(),
});

const EXPORT_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "company_name",
  "company_domain",
  "job_title",
  "phone",
  "website",
  "linkedin_url",
  "location",
  "personalization",
  "status",
  "lt_interest_status",
  "verification_status",
  "email_open_count",
  "email_reply_count",
  "email_click_count",
  "timestamp_last_contact",
  "timestamp_last_reply",
  "campaign",
  "list_id",
];

// ---------- Job handlers ----------

/** How long an import sent in parts waits for its next part before it ends with what came. */
export const importParts = { waitMs: 2 * 60_000 };

/** Part `seq` of an import sent in parts, once it's here; null when the import was stopped while it waited. */
async function importPart(job: JobRow, seq: number, parts: number, cancelled: () => Promise<boolean>) {
  for (const started = Date.now(); ; ) {
    const rows = await jobInputPart<z.infer<typeof leadInputSchema>[]>(job.id, seq);
    if (rows) return rows;
    if (await cancelled()) return null;
    if (Date.now() - started >= importParts.waitMs) {
      throw new Error(`The file stopped arriving after part ${seq - 1} of ${parts}, so the rest wasn't imported. Import the file again: leads already added are left out.`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

registerJobHandler("import-leads", async ({ job, input, progress, cancelled }) => {
  const d = job.data as {
    campaign_id?: string;
    list_id?: string;
    leads?: z.infer<typeof leadInputSchema>[];
    skip_if_in_workspace?: boolean;
    skip_if_in_campaign?: boolean;
    skip_if_in_list?: boolean;
    verify_leads_on_import?: boolean;
    upload_method?: string;
    /** Sent in this many parts: the first is the job's input, the rest arrive while it runs. */
    parts?: number;
  };
  const totals = {
    total_sent: 0,
    leads_uploaded: 0,
    in_blocklist: 0,
    duplicated_leads: 0,
    skipped_count: 0,
    invalid_email_count: 0,
    incomplete_count: 0,
    duplicate_email_count: 0,
    over_plan_limit: 0,
  };
  const parts = Math.max(1, d.parts ?? 1);
  // Once the plan's contact limit is reached, the rest isn't added, and the import says how much that was.
  let full = false;
  for (let seq = 1; seq <= parts; seq++) {
    // The rows are kept apart from the job (imports queued before that carry them in its data).
    const rows = seq === 1 ? (input<z.infer<typeof leadInputSchema>[]>() ?? d.leads ?? []) : await importPart(job, seq, parts, cancelled);
    if (!rows) break;
    const chunks = chunk(rows, 500);
    for (let i = 0; i < chunks.length; i++) {
      if (await cancelled()) return totals;
      if (full) {
        totals.over_plan_limit += chunks[i]!.length;
        continue;
      }
      let r: Awaited<ReturnType<typeof addLeads>>;
      try {
        r = await addLeads({
          workspaceId: job.workspaceId,
          campaignId: d.campaign_id ?? null,
          listId: d.list_id ?? null,
          leads: chunks[i]!,
          userId: job.userId,
          uploadMethod: (d.upload_method as "csv") ?? "csv",
          skipIfInWorkspace: d.skip_if_in_workspace,
          skipIfInCampaign: d.skip_if_in_campaign,
          skipIfInList: d.skip_if_in_list,
          verifyOnImport: d.verify_leads_on_import,
          batchId: job.id,
        });
      } catch (err) {
        if (!(err instanceof HttpError && err.statusCode === 402)) throw err;
        full = true;
        totals.over_plan_limit += chunks[i]!.length;
        continue;
      }
      for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += r[k] as number;
      await progress(((seq - 1 + (i + 1) / chunks.length) / parts) * 100, { counts: totals });
    }
  }
  return totals;
});

registerJobHandler("move-leads", async ({ job, progress }) => {
  const d = job.data as z.infer<typeof moveSchema>;
  const conds = await leadConditions(job.workspaceId, d as LeadFilter);
  if (d.skip_leads_in_verification) conds.push(ne(L.verificationStatus, VerificationStatus.PENDING), ne(L.verificationStatus, VerificationStatus.PENDING_JOB));
  const ids = (await db.select({ id: L.id }).from(L).where(and(...conds)).orderBy(asc(L.id)).limit(d.limit ?? 1_000_000)).map((r) => r.id);
  const moved: string[] = [];
  let skipped = 0;
  const parts = chunk(ids, 1000);
  for (let i = 0; i < parts.length; i++) {
    const r = await moveLeads({
      workspaceId: job.workspaceId,
      leadIds: parts[i]!,
      toCampaignId: d.to_campaign_id ?? null,
      toListId: d.to_list_id ?? null,
      copy: d.copy_leads,
      checkDuplicates: d.check_duplicates,
      checkDuplicatesInCampaigns: d.check_duplicates_in_campaigns,
      skipInvalid: d.skip_invalid_emails,
      resetInterestStatus: d.reset_interest_status,
      assignedTo: d.assign_to ?? null,
    });
    moved.push(...r.moved);
    skipped += r.skipped;
    await progress(((i + 1) / parts.length) * 100);
  }
  await db
    .update(schema.backgroundJobs)
    .set({ data: { ...(job.data ?? {}), moved_lead_emails: moved.slice(0, 10_000), moved_count: moved.length, skipped_count: skipped } })
    .where(eq(schema.backgroundJobs.id, job.id));
  await audit({ workspaceId: job.workspaceId, activityType: AuditActivity.LEAD_MOVED, userId: job.userId, affectedCount: moved.length, campaignId: d.to_campaign_id ?? null, listId: d.to_list_id ?? null });
  return { moved_count: moved.length, skipped_count: skipped };
});

registerJobHandler("export-leads", async ({ job, progress }) => {
  const d = job.data as LeadFilter & { columns?: string[] };
  const where = and(...(await leadConditions(job.workspaceId, d)))!;
  // Rows come out in the order the table showed them when it was sorted; oldest first otherwise. Only the ids are read
  // at once: the leads follow a page at a time, so a big export never sits in memory whole.
  const sort = await requestedSort(job.workspaceId, d);
  const ids = (
    await db
      .select({ id: L.id })
      .from(L)
      .where(where)
      .orderBy(...(sort ? sortOrder(sort) : [asc(L.createdAt), asc(L.id)]))
  ).map((r) => r.id);
  // The columns asked for (a lead's own fields, or custom variables by name), then every other custom variable these
  // leads have. One named like a lead's own field gets "custom_" in front, so neither hides the other.
  const cols = d.columns?.length ? d.columns : EXPORT_COLUMNS;
  const keys = (
    await db.all<{ key: string }>(
      sql`select distinct j.key as key from ${L}, json_each(${L.payload}) as j where ${where} and ${L.payload} is not null and json_valid(${L.payload}) and json_type(${L.payload}) = 'object'`,
    )
  )
    .map((r) => String(r.key))
    .sort((a, b) => a.localeCompare(b));
  const file = path.join(config.dataDir, "exports", `${job.id}.csv`);
  const out = createWriteStream(file);
  const closed = once(out, "close");
  closed.catch(() => undefined);
  const write = async (text: string) => {
    if (!out.write(text)) await once(out, "drain");
  };
  const header = async (sample: Record<string, unknown>) => {
    const own = new Set(Object.keys(sample));
    const extra = keys.filter((k) => own.has(k) || !cols.includes(k));
    await write(toCsv([[...cols, ...extra.map((k) => (own.has(k) ? `custom_${k}` : k))]]));
    return { own, extra };
  };
  let columns: { own: Set<string>; extra: string[] } | null = null;
  let count = 0;
  try {
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000);
      const found = new Map((await db.select().from(L).where(inArray(L.id, part))).map((r) => [r.id, r]));
      // A lead deleted since the export started is left out.
      const rows = part.flatMap((id) => found.get(id) ?? []).map((r) => ({ s: serializeLead(r) as Record<string, unknown>, vars: (r.payload ?? {}) as Record<string, unknown> }));
      if (!rows.length) continue;
      columns ??= await header(rows[0]!.s);
      const { own, extra } = columns;
      await write(`\r\n${toCsv(rows.map(({ s, vars }) => [...cols.map((c) => (own.has(c) ? s[c] : vars[c]) ?? ""), ...extra.map((k) => vars[k] ?? "")]))}`);
      count += rows.length;
      await progress(Math.min(99, ((i + part.length) / ids.length) * 100));
    }
    if (!columns) await header({});
    out.end();
    await closed;
  } catch (err) {
    out.destroy();
    await rm(file, { force: true }).catch(() => undefined);
    throw err;
  }
  await audit({ workspaceId: job.workspaceId, activityType: AuditActivity.LEAD_EXPORTED, userId: job.userId, affectedCount: count });
  return { count, file: `${job.id}.csv` };
});

/** A timezone given for one lead must be one we can read (a lead list import just works it out instead). */
function checkTimezone(value: string | null | undefined) {
  if (value && !parseTimezone(value)) throw badRequest(`Unknown timezone “${value}”. Use a name like America/New_York, an abbreviation like EST, or an offset like UTC+2.`);
}

registerJobHandler("edit-leads", async ({ job, input, progress }) => {
  const d = job.data as EditRequest & { campaign?: string; list_id?: string };
  const ids = input<string[]>() ?? [];
  await editLeads(job.workspaceId, ids, leadEditOf(d), (done) => progress((done / Math.max(ids.length, 1)) * 100));
  await audit({ workspaceId: job.workspaceId, activityType: AuditActivity.LEAD_EDITED, userId: job.userId, affectedCount: ids.length, campaignId: d.campaign ?? null, listId: d.list_id ?? null, metadata: { field: d.field ?? null, variable: d.variable ?? null, cleared: !d.value?.trim() } });
  return { count: ids.length };
});

registerJobHandler("rename-variable", async ({ job, input, progress }) => {
  const d = job.data as { name: string; to: string; emails: boolean };
  const ids = input<string[]>() ?? [];
  const actor = await actorForUser(job.userId);
  const r = await renameLeadVariable({ workspaceId: job.workspaceId, leadIds: ids, from: d.name, to: d.to, emails: d.emails, actor }, (pct) => progress(pct));
  await audit({ workspaceId: job.workspaceId, activityType: AuditActivity.VARIABLE_RENAMED, userId: job.userId, affectedCount: ids.length, metadata: { from: d.name, to: d.to, emails: r.emails } });
  return r;
});

registerJobHandler("delete-variable", async ({ job, input, progress }) => {
  const d = job.data as { name: string };
  const ids = input<string[]>() ?? [];
  const r = await deleteLeadVariable({ workspaceId: job.workspaceId, leadIds: ids, name: d.name }, (pct) => progress(pct));
  await audit({ workspaceId: job.workspaceId, activityType: AuditActivity.VARIABLE_DELETED, userId: job.userId, affectedCount: ids.length, metadata: { name: d.name } });
  return r;
});

registerJobHandler("delete-leads", async ({ job }) => {
  const d = job.data as LeadFilter & { limit?: number };
  const conds = await leadConditions(job.workspaceId, d);
  const { count, entryId } = await deleteLeadsWhere(job.workspaceId, conds, await actorForUser(job.userId), d.limit);
  await audit({ workspaceId: job.workspaceId, activityType: AuditActivity.LEAD_DELETION, userId: job.userId, affectedCount: count, campaignId: d.campaign ?? null, listId: d.list_id ?? null });
  return { count, recently_deleted_id: entryId };
});

export default async function leadRoutes(app: FastifyInstance) {
  const leadsRead = { scope: ["leads", "read"] as ["leads", "read"], perm: "leads" as const };
  const leadsCreate = { scope: ["leads", "create"] as ["leads", "create"], perm: "leads" as const, write: true };
  const leadsUpdate = { scope: ["leads", "update"] as ["leads", "update"], perm: "leads" as const, write: true };
  const leadsDelete = { scope: ["leads", "delete"] as ["leads", "delete"], perm: "leads" as const, write: true };

  // ---------- Leads ----------
  app.post("/api/v2/leads", { config: leadsCreate }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      leadInputSchema.extend({
        campaign: z.string().nullable().optional(),
        list_id: z.string().nullable().optional(),
        skip_if_in_workspace: z.boolean().optional(),
        skip_if_in_campaign: z.boolean().optional(),
        skip_if_in_list: z.boolean().optional(),
        verify_leads_on_import: z.boolean().optional(),
        verify_leads_for_lead_finder: z.boolean().optional(),
        blocklist_id: z.string().optional(),
      }),
    );
    checkTimezone(b.timezone);
    await assertMembers(c.wsId, [b.assigned_to], "assigned_to");
    if (!b.campaign && !b.list_id) {
      // A lead must live somewhere; default to an "Uncategorized" list like the app does.
      const [existing] = await db.select().from(schema.leadLists).where(and(eq(schema.leadLists.workspaceId, c.wsId), eq(schema.leadLists.name, "Uncategorized"))).limit(1);
      b.list_id = existing?.id ?? (await db.insert(schema.leadLists).values({ workspaceId: c.wsId, name: "Uncategorized", createdBy: c.userId }).returning())[0]!.id;
    }
    const r = await addLeads({
      workspaceId: c.wsId,
      campaignId: b.campaign ?? null,
      listId: b.campaign ? null : (b.list_id ?? null),
      leads: [b],
      userId: c.userId,
      uploadMethod: c.auth.via === "session" ? "manual" : "api",
      skipIfInWorkspace: b.skip_if_in_workspace,
      skipIfInCampaign: b.skip_if_in_campaign,
      skipIfInList: b.skip_if_in_list,
      verifyOnImport: b.verify_leads_on_import,
    });
    const created = r.created_leads[0];
    if (!created) {
      if (r.in_blocklist) throw badRequest("The lead is on the block list");
      if (r.invalid_email_count) throw badRequest("Invalid email address");
      if (r.skipped_count || r.duplicated_leads) throw conflict("The lead already exists");
      throw badRequest("The lead could not be created");
    }
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_ADDED, req, affectedCount: 1, campaignId: b.campaign ?? null, listId: b.list_id ?? null });
    return serializeLead(await findLead(c.wsId, created.id));
  });

  app.post("/api/v2/leads/add", { config: leadsCreate }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        campaign_id: z.string().optional(),
        list_id: z.string().optional(),
        leads: z.array(leadInputSchema).min(1).max(1000),
        blocklist_id: z.string().nullable().optional(),
        assigned_to: z.string().optional(),
        verify_leads_on_import: z.boolean().optional(),
        skip_if_in_workspace: z.boolean().optional(),
        skip_if_in_campaign: z.boolean().optional(),
        skip_if_in_list: z.boolean().optional(),
      }),
    );
    await assertMembers(c.wsId, [b.assigned_to, ...b.leads.map((l) => l.assigned_to)], "assigned_to");
    const r = await addLeads({
      workspaceId: c.wsId,
      campaignId: b.campaign_id ?? null,
      listId: b.list_id ?? null,
      leads: b.leads,
      userId: c.userId,
      assignedTo: b.assigned_to,
      uploadMethod: c.auth.via === "session" ? "manual" : "api",
      skipIfInWorkspace: b.skip_if_in_workspace,
      skipIfInCampaign: b.skip_if_in_campaign,
      skipIfInList: b.skip_if_in_list,
      verifyOnImport: b.verify_leads_on_import,
    });
    if (r.leads_uploaded) await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_ADDED, req, affectedCount: r.leads_uploaded, campaignId: b.campaign_id ?? null, listId: b.list_id ?? null });
    return r;
  });

  app.post("/api/v2/leads/list", { config: leadsRead }, async (req) => {
    const c = ctx(req);
    const b = body(req, leadFilterSchema.extend({ limit: z.number().int().min(1).max(1000).optional(), starting_after: z.string().optional(), distinct_contacts: z.boolean().optional(), with_total: z.boolean().optional() }));
    const limit = b.limit ?? 100;
    const conds = await leadConditions(c.wsId, b);
    const total = b.with_total ? Number((await db.select({ n: sql<number>`count(*)` }).from(L).where(and(...conds)))[0]?.n ?? 0) : undefined;
    // Newest first unless a sort is asked for; `starting_after` stays a lead id either way.
    const sort = await requestedSort(c.wsId, b);
    const order = sort ? sortOrder(sort) : [desc(L.id)];
    const after = async (id: string) => (sort ? await afterLead(c.wsId, sort, id) : lt(L.id, id));
    const pageAfter = async (id: string | undefined, n: number) =>
      db
        .select()
        .from(L)
        .where(and(...conds, id ? await after(id) : undefined))
        .orderBy(...order)
        .limit(n);
    let rows: LeadRow[];
    let resumeAt: string | null = null;
    if (!b.distinct_contacts) rows = await pageAfter(b.starting_after, limit + 1);
    else {
      // One lead per address: the first of its matching leads in this order, wherever that falls, so a later page
      // never repeats an address, and a page short of repeats still leads on to the rest.
      rows = [];
      let cursor = b.starting_after;
      for (let pass = 0; rows.length <= limit; pass++) {
        // A long run of repeats: this page ends short, and the next one carries on from where it stopped.
        if (pass === 20) {
          resumeAt = cursor ?? null;
          break;
        }
        const batch = await pageAfter(cursor, limit + 1);
        if (!batch.length) break;
        const emails = [...new Set(batch.map((r) => r.email).filter((e): e is string => !!e))];
        const ranked = db.$with("ranked").as(
          db
            .select({ id: L.id, n: sql<number>`row_number() over (partition by ${L.email} order by ${sql.join(order, sql`, `)})`.as("n") })
            .from(L)
            .where(and(...conds, inArray(L.email, emails.length ? emails : ["__none__"]))),
        );
        const firsts = new Set((await db.with(ranked).select({ id: ranked.id }).from(ranked).where(eq(ranked.n, 1))).map((r) => r.id));
        rows.push(...batch.filter((r) => !r.email || firsts.has(r.id)));
        cursor = batch[batch.length - 1]!.id;
        if (batch.length <= limit) break;
      }
    }
    const page = paginated(rows, limit, total);
    if (resumeAt && !page.next_starting_after) page.next_starting_after = resumeAt;
    return { ...page, items: page.items.map(serializeLead) };
  });

  app.get("/api/v2/leads/:id", { config: leadsRead }, async (req) => serializeLead(await findLead(ctx(req).wsId, (req.params as { id: string }).id)));

  app.patch("/api/v2/leads/:id", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const lead = await findLead(c.wsId, (req.params as { id: string }).id);
    const b = body(req, leadInputSchema.omit({ email: true }).extend({ email: z.string().trim().toLowerCase().optional() }));
    // A lead can stay with someone who has since left (saving its other details); giving it to someone needs a member.
    if (b.assigned_to !== undefined && b.assigned_to !== lead.assignedTo) await assertMembers(c.wsId, [b.assigned_to], "assigned_to");
    const set: Partial<typeof L.$inferInsert> = {};
    if (b.first_name !== undefined) set.firstName = b.first_name;
    if (b.last_name !== undefined) set.lastName = b.last_name;
    if (b.company_name !== undefined) set.companyName = b.company_name;
    if (b.company_domain !== undefined) set.companyDomain = b.company_domain ?? "";
    if (b.website !== undefined) set.website = b.website;
    if (b.job_title !== undefined) set.jobTitle = b.job_title;
    if (b.phone !== undefined) set.phone = b.phone;
    if (b.linkedin_url !== undefined) set.linkedinUrl = b.linkedin_url;
    if (b.location !== undefined) set.location = b.location;
    if (b.personalization !== undefined) set.personalization = b.personalization;
    if (b.pl_value_lead !== undefined) set.plValueLead = b.pl_value_lead;
    if (b.assigned_to !== undefined) set.assignedTo = b.assigned_to;
    if (b.custom_variables !== undefined) {
      const merged: Record<string, unknown> = { ...(lead.payload ?? {}) };
      for (const [k, v] of Object.entries(b.custom_variables)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      set.payload = Object.keys(merged).length ? merged : null;
    }
    if (b.email && b.email !== lead.email) {
      // A campaign or list holds each address once.
      const holders = [lead.campaignId ? eq(L.campaignId, lead.campaignId) : undefined, lead.listId ? eq(L.listId, lead.listId) : undefined].filter((x) => x !== undefined);
      if (holders.length) {
        const [taken] = await db
          .select({ id: L.id })
          .from(L)
          .where(and(eq(L.workspaceId, c.wsId), eq(L.email, b.email), ne(L.id, lead.id), or(...holders)))
          .limit(1);
        if (taken) throw conflict(`${b.email} is already a lead in this ${lead.campaignId ? "campaign" : "list"}.`);
      }
      set.email = b.email;
      set.companyDomain = b.company_domain ?? domainOf(b.email);
      // A new address can mean a new provider and gateway: free mail is known at once, the rest is looked up again.
      Object.assign(set, mailCodes(b.email));
    }
    // The timezone as given; or, when it was worked out from where they are and that changes, worked out again.
    checkTimezone(b.timezone);
    if (b.timezone) set.timezone = parseTimezone(b.timezone);
    else if (b.timezone === null || set.location !== undefined || set.phone !== undefined || set.payload !== undefined) {
      const worked = inferLeadTimezone({ location: lead.location, phone: lead.phone, payload: lead.payload });
      if (b.timezone === null || !lead.timezone || lead.timezone === worked) {
        set.timezone = inferLeadTimezone({
          location: set.location !== undefined ? set.location : lead.location,
          phone: set.phone !== undefined ? set.phone : lead.phone,
          payload: set.payload !== undefined ? set.payload : lead.payload,
        });
      }
    }
    const [row] = Object.keys(set).length ? await db.update(L).set(set).where(eq(L.id, lead.id)).returning() : [lead];
    if (set.assignedTo !== undefined && set.assignedTo !== lead.assignedTo) await dealsFollowOwner(c.wsId, [lead.id], set.assignedTo);
    if (b.lt_interest_status !== undefined && b.lt_interest_status !== lead.interestStatus) {
      await setInterestStatus({ workspaceId: c.wsId, leadIds: [lead.id], value: b.lt_interest_status, userId: c.userId, source: c.auth.via === "session" ? "user" : "api" });
      return serializeLead(await findLead(c.wsId, lead.id));
    }
    return serializeLead(row!);
  });

  // Deleted leads wait in Recently deleted for 30 days (the answer carries the entry, for an undo).
  app.delete("/api/v2/leads/:id", { config: leadsDelete }, async (req) => {
    const c = ctx(req);
    const lead = await findLead(c.wsId, (req.params as { id: string }).id);
    const { entryId } = await trashLeads(c.wsId, [lead.id], actorOf(req));
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_DELETION, req, affectedCount: 1, campaignId: lead.campaignId, listId: lead.listId });
    return { ...serializeLead(lead), recently_deleted_id: entryId };
  });

  app.delete("/api/v2/leads", { config: leadsDelete }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ campaign_id: z.string().optional(), list_id: z.string().optional(), status: z.number().optional(), ids: z.array(z.string()).optional(), limit: z.number().int().positive().optional() }));
    if (!b.campaign_id && !b.list_id) throw badRequest("campaign_id or list_id is required");
    const conds = await leadConditions(c.wsId, { campaign: b.campaign_id, list_id: b.list_id, status: b.status, ids: b.ids });
    const { count, entryId } = await deleteLeadsWhere(c.wsId, conds, actorOf(req), b.limit);
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_DELETION, req, affectedCount: count, campaignId: b.campaign_id ?? null, listId: b.list_id ?? null });
    return { count, recently_deleted_id: entryId };
  });

  app.post("/api/v2/leads/merge", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ lead_id: z.string(), destination_lead_id: z.string() }));
    if (b.lead_id === b.destination_lead_id) throw badRequest("Cannot merge a lead into itself");
    const src = await findLead(c.wsId, b.lead_id);
    const dst = await findLead(c.wsId, b.destination_lead_id);
    const [row] = await db
      .update(L)
      .set({
        firstName: dst.firstName ?? src.firstName,
        lastName: dst.lastName ?? src.lastName,
        companyName: dst.companyName ?? src.companyName,
        website: dst.website ?? src.website,
        jobTitle: dst.jobTitle ?? src.jobTitle,
        phone: dst.phone ?? src.phone,
        linkedinUrl: dst.linkedinUrl ?? src.linkedinUrl,
        personalization: dst.personalization ?? src.personalization,
        payload: { ...(src.payload ?? {}), ...(dst.payload ?? {}) },
        openCount: dst.openCount + src.openCount,
        replyCount: dst.replyCount + src.replyCount,
        clickCount: dst.clickCount + src.clickCount,
        interestStatus: dst.interestStatus ?? src.interestStatus,
        interestSynced: dst.interestStatus !== null ? dst.interestSynced : src.interestSynced,
      })
      .where(eq(L.id, dst.id))
      .returning();
    // Re-point history to the surviving lead.
    await db.update(schema.emails).set({ leadId: dst.id, leadEmail: dst.email }).where(eq(schema.emails.leadId, src.id));
    await db.update(schema.emailEvents).set({ leadId: dst.id, leadEmail: dst.email }).where(eq(schema.emailEvents.leadId, src.id));
    // One person is one opportunity: the merged lead's value is its first opportunity's.
    await db.run(
      sql`update email_events set value = 0 where lead_id = ${dst.id} and type = 'opportunity' and value <> 0 and id <> (select id from email_events where lead_id = ${dst.id} and type = 'opportunity' order by created_at, id limit 1)`,
    );
    await db.update(schema.leadNotes).set({ leadId: dst.id, leadEmail: dst.email }).where(eq(schema.leadNotes.leadId, src.id));
    await db.delete(L).where(eq(L.id, src.id));
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_MERGED, req, affectedCount: 2 });
    return serializeLead(row!);
  });

  app.post("/api/v2/leads/update-interest-status", { config: leadsUpdate }, async (req, reply) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        lead_email: z.string().trim().toLowerCase(),
        interest_value: z.number().nullable(),
        campaign_id: z.string().optional(),
        list_id: z.string().optional(),
        ai_interest_value: z.number().optional(),
        disable_auto_interest: z.boolean().optional(),
      }),
    );
    const conds = [eq(L.workspaceId, c.wsId), eq(L.email, b.lead_email)];
    if (b.campaign_id) conds.push(eq(L.campaignId, b.campaign_id));
    if (b.list_id) conds.push(eq(L.listId, b.list_id));
    const ids = (await db.select({ id: L.id }).from(L).where(and(...conds))).map((r) => r.id);
    if (!ids.length) throw notFound("Lead");
    await setInterestStatus({ workspaceId: c.wsId, leadIds: ids, value: b.interest_value, userId: c.userId, source: b.ai_interest_value !== undefined ? "ai" : c.auth.via === "session" ? "user" : "api" });
    if (b.ai_interest_value !== undefined) {
      await db
        .update(schema.emails)
        .set({ aiInterestValue: b.ai_interest_value })
        .where(and(eq(schema.emails.workspaceId, c.wsId), eq(schema.emails.leadEmail, b.lead_email)));
    }
    reply.code(202);
    return { message: "Lead interest status update background job submitted" };
  });

  app.post("/api/v2/leads/bulk-assign", { config: leadsUpdate }, async (req, reply) => {
    const c = ctx(req);
    const b = body(req, leadFilterSchema.extend({ organization_user_ids: z.array(z.string()).min(1), limit: z.number().int().positive().optional(), has_clause: z.boolean().optional() }));
    await assertMembers(c.wsId, b.organization_user_ids, "organization_user_ids");
    const conds = await leadConditions(c.wsId, b);
    const ids = (await db.select({ id: L.id }).from(L).where(and(...conds)).limit(b.limit ?? 1_000_000)).map((r) => r.id);
    // Round-robin across the chosen members.
    const buckets = new Map<string, string[]>(b.organization_user_ids.map((user) => [user, []]));
    ids.forEach((id, i) => buckets.get(b.organization_user_ids[i % b.organization_user_ids.length]!)!.push(id));
    for (const [user, list] of buckets) {
      for (const part of chunk(list, 800)) await db.update(L).set({ assignedTo: user }).where(inArray(L.id, part));
      await dealsFollowOwner(c.wsId, list, user);
    }
    reply.code(202);
    return { status: "success", message: `${ids.length} leads assigned` };
  });

  app.post("/api/v2/leads/move", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, moveSchema);
    if (!b.to_campaign_id && !b.to_list_id) throw badRequest("to_campaign_id or to_list_id is required");
    assertSelection(b);
    await assertMembers(c.wsId, [b.assign_to], "assign_to");
    if (b.to_campaign_id) {
      const [camp] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.id, b.to_campaign_id), eq(schema.campaigns.workspaceId, c.wsId)));
      if (!camp) throw notFound("Destination campaign");
    }
    if (b.to_list_id) {
      const [list] = await db.select({ id: schema.leadLists.id }).from(schema.leadLists).where(and(eq(schema.leadLists.id, b.to_list_id), eq(schema.leadLists.workspaceId, c.wsId)));
      if (!list) throw notFound("Destination list");
    }
    const job = await createJob({
      workspaceId: c.wsId,
      userId: c.userId,
      type: "move-leads",
      entityType: b.to_campaign_id ? "campaign" : "list",
      entityId: b.to_campaign_id ?? b.to_list_id ?? null,
      data: b as Record<string, unknown>,
    });
    return serializeJob(job);
  });

  app.post("/api/v2/leads/subsequence/move", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ id: z.string(), subsequence_id: z.string() }));
    const lead = await findLead(c.wsId, b.id);
    const [sub] = await db
      .select()
      .from(schema.subsequences)
      .where(and(eq(schema.subsequences.id, b.subsequence_id), eq(schema.subsequences.workspaceId, c.wsId)))
      .limit(1);
    if (!sub) throw notFound("Subsequence");
    if (lead.campaignId !== sub.parentCampaignId) throw badRequest("The lead does not belong to the subsequence's parent campaign");
    if (!(await enrollInSubsequence(lead, sub))) throw badRequest("This lead bounced or unsubscribed, so it can't start a subsequence: nothing more is sent to it.");
    return serializeLead(await findLead(c.wsId, lead.id));
  });

  app.post("/api/v2/leads/subsequence/remove", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ id: z.string() }));
    const lead = await findLead(c.wsId, b.id);
    await removeFromSubsequence(lead.id);
    return serializeLead(await findLead(c.wsId, lead.id));
  });

  // ---------- Lead lists ----------
  const listsRead = { scope: ["lead_lists", "read"] as ["lead_lists", "read"], perm: "leads" as const };
  const listsWrite = (a: "create" | "update" | "delete") => ({ scope: ["lead_lists", a] as ["lead_lists", typeof a], perm: "leads" as const, write: true });

  async function listCounts(ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const rows = await db.select({ id: L.listId, n: sql<number>`count(*)` }).from(L).where(inArray(L.listId, ids)).groupBy(L.listId);
    return new Map(rows.map((r) => [r.id!, Number(r.n)]));
  }

  app.post("/api/v2/lead-lists", { config: listsWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(200), has_enrichment_task: z.boolean().nullable().optional(), owned_by: z.string().nullable().optional() }));
    await assertMembers(c.wsId, [b.owned_by], "owned_by");
    const [row] = await db
      .insert(schema.leadLists)
      .values({ workspaceId: c.wsId, name: b.name, hasEnrichmentTask: b.has_enrichment_task ?? false, ownedBy: b.owned_by ?? c.userId, createdBy: c.userId })
      .returning();
    return serializeList(row!, 0);
  });

  app.get("/api/v2/lead-lists", { config: listsRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, pageQuery.extend({ has_enrichment_task: zBool }));
    const limit = q.limit ?? 100;
    const conds = [eq(schema.leadLists.workspaceId, c.wsId)];
    if (q.search) conds.push(contains(sql`lower(${schema.leadLists.name})`, q.search.toLowerCase()));
    if (q.has_enrichment_task !== undefined) conds.push(eq(schema.leadLists.hasEnrichmentTask, q.has_enrichment_task));
    if (q.starting_after) conds.push(lt(schema.leadLists.id, q.starting_after));
    const rows = await db
      .select()
      .from(schema.leadLists)
      .where(and(...conds))
      .orderBy(desc(schema.leadLists.id))
      .limit(limit + 1);
    const page = paginated(rows, limit);
    const counts = await listCounts(page.items.map((r) => r.id));
    return { ...page, items: page.items.map((r) => serializeList(r, counts.get(r.id) ?? 0)) };
  });

  app.get("/api/v2/lead-lists/:id", { config: listsRead }, async (req) => {
    const c = ctx(req);
    const [row] = await db.select().from(schema.leadLists).where(and(eq(schema.leadLists.id, (req.params as { id: string }).id), eq(schema.leadLists.workspaceId, c.wsId)));
    const list = assertFound(row, "Lead list");
    return serializeList(list, (await listCounts([list.id])).get(list.id) ?? 0);
  });

  app.patch("/api/v2/lead-lists/:id", { config: listsWrite("update") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(200).optional(), has_enrichment_task: z.boolean().nullable().optional(), owned_by: z.string().nullable().optional() }));
    await assertMembers(c.wsId, [b.owned_by], "owned_by");
    const [row] = await db
      .update(schema.leadLists)
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.has_enrichment_task !== undefined ? { hasEnrichmentTask: b.has_enrichment_task } : {}),
        ...(b.owned_by !== undefined ? { ownedBy: b.owned_by } : {}),
      })
      .where(and(eq(schema.leadLists.id, (req.params as { id: string }).id), eq(schema.leadLists.workspaceId, c.wsId)))
      .returning();
    return serializeList(assertFound(row, "Lead list"));
  });

  app.delete("/api/v2/lead-lists/:id", { config: listsWrite("delete") }, async (req) => {
    const c = ctx(req);
    const id = (req.params as { id: string }).id;
    const [row] = await db.select().from(schema.leadLists).where(and(eq(schema.leadLists.id, id), eq(schema.leadLists.workspaceId, c.wsId)));
    const list = assertFound(row, "Lead list");
    // The list and its leads wait in Recently deleted for 30 days.
    const { entryId, leads } = await trashLeadList(list, actorOf(req));
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_DELETION, req, affectedCount: leads, listId: id });
    return { ...serializeList(list), recently_deleted_id: entryId };
  });

  app.get("/api/v2/lead-lists/:id/verification-stats", { config: listsRead }, async (req) => {
    const c = ctx(req);
    const id = (req.params as { id: string }).id;
    const rows = await db
      .select({ s: L.verificationStatus, n: sql<number>`count(*)` })
      .from(L)
      .where(and(eq(L.workspaceId, c.wsId), eq(L.listId, id)))
      .groupBy(L.verificationStatus);
    const m = new Map(rows.map((r) => [r.s, Number(r.n)]));
    return {
      stats: {
        verified: m.get(VerificationStatus.VERIFIED) ?? 0,
        invalid: m.get(VerificationStatus.INVALID) ?? 0,
        risky: m.get(VerificationStatus.RISKY) ?? 0,
        catch_all: m.get(VerificationStatus.CATCH_ALL) ?? 0,
        job_change: m.get(VerificationStatus.JOB_CHANGE) ?? 0,
        verification_job_pending_leadfinder: 0,
        verification_job_pending_user: (m.get(VerificationStatus.PENDING) ?? 0) + (m.get(VerificationStatus.PENDING_JOB) ?? 0),
        not_verified: m.get(VerificationStatus.NOT_VERIFIED) ?? 0,
      },
      total: rows.reduce((s, r) => s + Number(r.n), 0),
    };
  });

  // ---------- Block list ----------
  const blRead = { scope: ["block_list_entries", "read"] as ["block_list_entries", "read"], perm: "blocklist" as const };
  const blWrite = (a: "create" | "update" | "delete") => ({ scope: ["block_list_entries", a] as ["block_list_entries", typeof a], perm: "blocklist" as const, write: true });
  const B = schema.blockList;

  function blockConds(wsId: string, q: { domains_only?: boolean; search?: string }) {
    const conds = [eq(B.workspaceId, wsId)];
    if (q.domains_only) conds.push(eq(B.isDomain, true));
    if (q.search) conds.push(contains(B.value, q.search.toLowerCase()));
    return conds;
  }

  app.post("/api/v2/block-lists-entries", { config: blWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ bl_value: z.string() }));
    const v = blockValue(b.bl_value);
    if (!v) throw badRequest("Enter a valid email address or domain");
    const [row] = await db.insert(B).values({ workspaceId: c.wsId, value: v.value, isDomain: v.isDomain, source: c.auth.via === "session" ? "manual" : "api" }).onConflictDoNothing().returning();
    if (!row) throw conflict(`${v.value} is already on the block list`);
    return serializeBlock(row);
  });

  app.post("/api/v2/block-lists-entries/bulk-create", { config: blWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ bl_values: z.array(z.string()).min(1).max(100_000) }));
    const valid = [...new Map(b.bl_values.map(blockValue).filter((v): v is NonNullable<typeof v> => !!v).map((v) => [v.value, v])).values()];
    const items: (typeof B.$inferSelect)[] = [];
    for (const part of chunk(valid, 500)) {
      items.push(
        ...(await db
          .insert(B)
          .values(part.map((v) => ({ workspaceId: c.wsId, value: v.value, isDomain: v.isDomain, source: c.auth.via === "session" ? "manual" : "api" })))
          .onConflictDoNothing()
          .returning()),
      );
    }
    return { items: items.map(serializeBlock), valid_count: valid.length, invalid_count: b.bl_values.length - valid.length, created_count: items.length };
  });

  app.get("/api/v2/block-lists-entries", { config: blRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, pageQuery.extend({ domains_only: zBool }));
    const limit = q.limit ?? 100;
    const conds = blockConds(c.wsId, q);
    const total = q.with_total ? Number((await db.select({ n: sql<number>`count(*)` }).from(B).where(and(...conds)))[0]?.n ?? 0) : undefined;
    if (q.starting_after) conds.push(lt(B.id, q.starting_after));
    const rows = await db
      .select()
      .from(B)
      .where(and(...conds))
      .orderBy(desc(B.id))
      .limit(limit + 1);
    const page = paginated(rows, limit, total);
    return { ...page, items: page.items.map(serializeBlock) };
  });

  app.get("/api/v2/block-lists-entries/download", { config: blRead }, async (req, reply) => {
    const c = ctx(req);
    const rows = await db.select().from(B).where(eq(B.workspaceId, c.wsId)).orderBy(asc(B.value));
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="blocklist.csv"');
    return toCsv(rows.map((r) => ({ value: r.value, is_domain: r.isDomain, source: r.source ?? "", created_at: iso(r.createdAt) })));
  });

  app.get("/api/v2/block-lists-entries/:id", { config: blRead }, async (req) => {
    const c = ctx(req);
    const [row] = await db.select().from(B).where(and(eq(B.id, (req.params as { id: string }).id), eq(B.workspaceId, c.wsId)));
    return serializeBlock(assertFound(row, "Block list entry"));
  });

  app.patch("/api/v2/block-lists-entries/:id", { config: blWrite("update") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ bl_value: z.string() }));
    const v = blockValue(b.bl_value);
    if (!v) throw badRequest("Enter a valid email address or domain");
    const [row] = await db.update(B).set({ value: v.value, isDomain: v.isDomain }).where(and(eq(B.id, (req.params as { id: string }).id), eq(B.workspaceId, c.wsId))).returning();
    return serializeBlock(assertFound(row, "Block list entry"));
  });

  app.delete("/api/v2/block-lists-entries/:id", { config: blWrite("delete") }, async (req) => {
    const c = ctx(req);
    const [row] = await db.delete(B).where(and(eq(B.id, (req.params as { id: string }).id), eq(B.workspaceId, c.wsId))).returning();
    return serializeBlock(assertFound(row, "Block list entry"));
  });

  app.post("/api/v2/block-lists-entries/bulk-delete", { config: blWrite("delete") }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ ids: z.array(z.string()).min(1) }));
    const out: (typeof B.$inferSelect)[] = [];
    for (const part of chunk(b.ids, 800)) out.push(...(await db.delete(B).where(and(eq(B.workspaceId, c.wsId), inArray(B.id, part))).returning()));
    return out.map(serializeBlock);
  });

  app.delete("/api/v2/block-lists-entries", { config: blWrite("delete") }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ domains_only: zBool, search: z.string().optional() }));
    const rows = await db.delete(B).where(and(...blockConds(c.wsId, q))).returning();
    return rows.map(serializeBlock);
  });

  // ---------- Lead labels (custom interest statuses) ----------
  const LL = schema.leadLabels;
  const labelsRead = { scope: ["lead-labels", "read"] as ["lead-labels", "read"], perm: "leads" as const };
  const labelsWrite = (a: "create" | "update" | "delete") => ({ scope: ["lead-labels", a] as ["lead-labels", typeof a], perm: "leads" as const, write: true });

  app.post("/api/v2/lead-labels", { config: labelsWrite("create") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        label: z.string().trim().min(1).max(80),
        interest_status_label: z.enum(["positive", "negative", "neutral"]),
        description: z.string().max(2000).nullable().optional(),
        use_with_ai: z.boolean().nullable().optional(),
        color: z.string().max(20).nullable().optional(),
      }),
    );
    const value = await nextLabelCode(c.wsId, b.interest_status_label);
    const [row] = await db
      .insert(LL)
      .values({ workspaceId: c.wsId, label: b.label, interestStatusLabel: b.interest_status_label, interestStatus: value, description: b.description ?? null, useWithAi: b.use_with_ai ?? false, color: b.color ?? null, createdBy: c.userId })
      .returning();
    return serializeLabel(row!);
  });

  app.get("/api/v2/lead-labels", { config: labelsRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, pageQuery.extend({ interest_status: z.enum(["positive", "neutral", "negative"]).optional() }));
    const limit = q.limit ?? 100;
    const conds = [eq(LL.workspaceId, c.wsId)];
    if (q.search) conds.push(contains(sql`lower(${LL.label})`, q.search.toLowerCase()));
    if (q.interest_status) conds.push(eq(LL.interestStatusLabel, q.interest_status));
    if (q.starting_after) conds.push(gt(LL.id, q.starting_after));
    const rows = await db
      .select()
      .from(LL)
      .where(and(...conds))
      .orderBy(asc(LL.id))
      .limit(limit + 1);
    const page = paginated(rows, limit);
    return { ...page, items: page.items.map(serializeLabel) };
  });

  app.get("/api/v2/lead-labels/:id", { config: labelsRead }, async (req) => {
    const c = ctx(req);
    const [row] = await db.select().from(LL).where(and(eq(LL.id, (req.params as { id: string }).id), eq(LL.workspaceId, c.wsId)));
    return serializeLabel(assertFound(row, "Lead label"));
  });

  app.patch("/api/v2/lead-labels/:id", { config: labelsWrite("update") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        label: z.string().trim().min(1).max(80).optional(),
        interest_status_label: z.enum(["positive", "negative", "neutral"]).optional(),
        description: z.string().max(2000).nullable().optional(),
        use_with_ai: z.boolean().nullable().optional(),
        color: z.string().max(20).nullable().optional(),
      }),
    );
    const [current] = await db.select().from(LL).where(and(eq(LL.id, (req.params as { id: string }).id), eq(LL.workspaceId, c.wsId)));
    const label = assertFound(current, "Lead label");
    if (b.interest_status_label && b.interest_status_label !== label.interestStatusLabel) {
      throw badRequest("Positive / negative status can't be changed once the label is created");
    }
    const [row] = await db
      .update(LL)
      .set({
        ...(b.label !== undefined ? { label: b.label } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.use_with_ai !== undefined ? { useWithAi: b.use_with_ai } : {}),
        ...(b.color !== undefined ? { color: b.color } : {}),
      })
      .where(eq(LL.id, label.id))
      .returning();
    return serializeLabel(row!);
  });

  app.delete("/api/v2/lead-labels/:id", { config: labelsWrite("delete") }, async (req) => {
    const c = ctx(req);
    const [row] = await db.delete(LL).where(and(eq(LL.id, (req.params as { id: string }).id), eq(LL.workspaceId, c.wsId))).returning();
    const label = assertFound(row, "Lead label");
    // Leads and conversations carrying the deleted label fall back to "Lead" (no status).
    await retireLabelCode(c.wsId, label.interestStatus);
    return serializeLabel(label);
  });

  app.get("/api/app/lead-statuses", { config: { perm: "leads" } }, async (req) => {
    const c = ctx(req);
    const custom = await db.select().from(LL).where(eq(LL.workspaceId, c.wsId)).orderBy(asc(LL.createdAt));
    return {
      built_in: DEFAULT_INTEREST_STATUSES,
      custom: custom.map(serializeLabel),
    };
  });

  // ---------- Custom tags ----------
  const T = schema.customTags;
  const TM = schema.customTagMappings;
  const tagsRead = { scope: ["custom_tags", "read"] as ["custom_tags", "read"] };
  const tagsWrite = (a: "create" | "update" | "delete") => ({ scope: ["custom_tags", a] as ["custom_tags", typeof a], write: true });
  /** Tags go on mailboxes, campaigns and the workspace: changing them takes the right to manage what they're on. */
  const assertMayTag = (req: FastifyRequest, anyOf: Permission[]) => {
    if (!anyOf.some((p) => may(req, p))) throw forbidden("You don't have access to change these tags.");
  };

  app.post("/api/v2/custom-tags", { config: tagsWrite("create") }, async (req) => {
    const c = ctx(req);
    assertMayTag(req, ["accounts", "edit_campaigns"]);
    const b = body(req, z.object({ label: z.string().trim().min(1).max(60), description: z.string().max(500).nullable().optional(), color: z.string().max(20).nullable().optional() }));
    const [row] = await db.insert(T).values({ workspaceId: c.wsId, label: b.label, description: b.description ?? null, color: b.color ?? null }).onConflictDoNothing().returning();
    if (!row) throw conflict(`A tag named "${b.label}" already exists`);
    return serializeTag(row);
  });

  app.get("/api/v2/custom-tags", { config: tagsRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, pageQuery.extend({ resource_ids: zList, tag_ids: zList }));
    const limit = q.limit ?? 100;
    const conds = [eq(T.workspaceId, c.wsId)];
    if (q.search) conds.push(contains(sql`lower(${T.label})`, q.search.toLowerCase()));
    if (q.tag_ids?.length) conds.push(inArray(T.id, q.tag_ids));
    if (q.resource_ids?.length) {
      const ids = (await db.select({ tagId: TM.tagId }).from(TM).where(and(eq(TM.workspaceId, c.wsId), inArray(TM.resourceId, q.resource_ids)))).map((r) => r.tagId);
      conds.push(inArray(T.id, ids.length ? ids : ["__none__"]));
    }
    if (q.starting_after) conds.push(gt(T.id, q.starting_after));
    const rows = await db
      .select()
      .from(T)
      .where(and(...conds))
      .orderBy(asc(T.id))
      .limit(limit + 1);
    const page = paginated(rows, limit);
    return { ...page, items: page.items.map(serializeTag) };
  });

  app.get("/api/v2/custom-tags/:id", { config: tagsRead }, async (req) => {
    const c = ctx(req);
    const [row] = await db.select().from(T).where(and(eq(T.id, (req.params as { id: string }).id), eq(T.workspaceId, c.wsId)));
    return serializeTag(assertFound(row, "Custom tag"));
  });

  app.patch("/api/v2/custom-tags/:id", { config: tagsWrite("update") }, async (req) => {
    const c = ctx(req);
    assertMayTag(req, ["accounts", "edit_campaigns"]);
    const b = body(req, z.object({ label: z.string().trim().min(1).max(60).optional(), description: z.string().max(500).nullable().optional(), color: z.string().max(20).nullable().optional() }));
    if (b.label !== undefined) {
      const [taken] = await db
        .select({ id: T.id })
        .from(T)
        .where(and(eq(T.workspaceId, c.wsId), eq(T.label, b.label), ne(T.id, (req.params as { id: string }).id)))
        .limit(1);
      if (taken) throw conflict(`A tag named "${b.label}" already exists`);
    }
    const [row] = await db
      .update(T)
      .set({ ...(b.label !== undefined ? { label: b.label } : {}), ...(b.description !== undefined ? { description: b.description } : {}), ...(b.color !== undefined ? { color: b.color } : {}) })
      .where(and(eq(T.id, (req.params as { id: string }).id), eq(T.workspaceId, c.wsId)))
      .returning();
    return serializeTag(assertFound(row, "Custom tag"));
  });

  app.delete("/api/v2/custom-tags/:id", { config: tagsWrite("delete") }, async (req) => {
    const c = ctx(req);
    const [row] = await db.select().from(T).where(and(eq(T.id, (req.params as { id: string }).id), eq(T.workspaceId, c.wsId)));
    const tag = assertFound(row, "Custom tag");
    // Campaigns that pick their senders by the tag, or carry it, change with it: that takes campaign editing.
    const senders = (await db.select({ id: schema.campaigns.id, tags: schema.campaigns.emailTagList }).from(schema.campaigns).where(eq(schema.campaigns.workspaceId, c.wsId))).filter((x) => (x.tags ?? []).includes(tag.id));
    const [onCampaign] = await db.select({ id: TM.id }).from(TM).where(and(eq(TM.workspaceId, c.wsId), eq(TM.tagId, tag.id), eq(TM.resourceType, 2))).limit(1);
    assertMayTag(req, senders.length || onCampaign ? ["edit_campaigns"] : ["accounts", "edit_campaigns"]);
    await db.delete(T).where(eq(T.id, tag.id));
    await db.delete(TM).where(eq(TM.tagId, tag.id));
    for (const camp of senders) await db.update(schema.campaigns).set({ emailTagList: (camp.tags ?? []).filter((x) => x !== tag.id) }).where(eq(schema.campaigns.id, camp.id));
    return serializeTag(tag);
  });

  app.post("/api/v2/custom-tags/toggle-resource", { config: tagsWrite("update") }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        tag_ids: z.array(z.string()).min(1),
        resource_type: z.number().int().min(1).max(3),
        resource_ids: z.array(z.string()).optional(),
        excluded_resource_ids: z.array(z.string()).optional(),
        assign: z.boolean(),
        selected_all: z.boolean().optional(),
        filter: z.union([z.string(), z.record(z.unknown())]).nullable().optional(),
        search: z.string().optional(),
      }),
    );
    assertMayTag(req, [b.resource_type === 1 ? "accounts" : b.resource_type === 2 ? "edit_campaigns" : "settings"]);
    await assertTags(c.wsId, b.tag_ids);
    let ids = b.resource_ids ?? [];
    if (b.selected_all) {
      // Every mailbox, every campaign, or the workspace itself.
      const table = b.resource_type === 1 ? schema.emailAccounts : schema.campaigns;
      const all = b.resource_type === 3 ? [c.wsId] : (await db.select({ id: table.id }).from(table).where(eq(table.workspaceId, c.wsId))).map((r) => r.id);
      const excluded = new Set(b.excluded_resource_ids ?? []);
      ids = all.filter((id) => !excluded.has(id));
    } else if (b.assign && ids.length) {
      // Only the workspace's own mailboxes and campaigns (or the workspace itself) get its tags.
      const table = b.resource_type === 1 ? schema.emailAccounts : b.resource_type === 2 ? schema.campaigns : null;
      const own = table ? new Set((await db.select({ id: table.id }).from(table).where(and(eq(table.workspaceId, c.wsId), inArray(table.id, ids)))).map((r) => r.id)) : new Set([c.wsId]);
      ids = ids.filter((id) => own.has(id));
    }
    if (!ids.length) return { success: true };
    if (b.assign) {
      const values = ids.flatMap((rid) => b.tag_ids.map((tagId) => ({ workspaceId: c.wsId, tagId, resourceId: rid, resourceType: b.resource_type })));
      for (const part of chunk(values, 500)) await db.insert(TM).values(part).onConflictDoNothing();
    } else {
      for (const part of chunk(ids, 800)) await db.delete(TM).where(and(eq(TM.workspaceId, c.wsId), inArray(TM.tagId, b.tag_ids), inArray(TM.resourceId, part)));
    }
    return { success: true };
  });

  app.get("/api/v2/custom-tag-mappings", { config: { scope: ["custom_tag_mappings", "read"] } }, async (req) => {
    const c = ctx(req);
    const q = query(req, pageQuery.extend({ resource_ids: zList }));
    const limit = q.limit ?? 100;
    const conds = [eq(TM.workspaceId, c.wsId)];
    if (q.resource_ids?.length) conds.push(inArray(TM.resourceId, q.resource_ids));
    if (q.starting_after) conds.push(gt(TM.id, q.starting_after));
    const rows = await db
      .select()
      .from(TM)
      .where(and(...conds))
      .orderBy(asc(TM.id))
      .limit(limit + 1);
    const page = paginated(rows, limit);
    return {
      ...page,
      items: page.items.map((m) => ({ id: m.id, organization_id: m.workspaceId, tag_id: m.tagId, resource_id: m.resourceId, resource_type: m.resourceType, timestamp_created: iso(m.createdAt) })),
    };
  });

  // ---------- Background jobs ----------
  const J = schema.backgroundJobs;
  // A member sees the jobs they started, and those of the kinds they could start (owners and admins see them all).
  const everyJob = (req: FastifyRequest) => req.auth.via === "api_key" || req.auth.role === "owner" || req.auth.role === "admin";
  const jobKinds = (req: FastifyRequest) =>
    Object.entries(JOB_PERMISSIONS)
      .filter(([, perm]) => perm !== "admin" && may(req, perm))
      .map(([type]) => type);
  const jobsSeen = (req: FastifyRequest): SQL | undefined => {
    if (everyJob(req)) return undefined;
    const kinds = jobKinds(req);
    return or(req.auth.user ? eq(J.userId, req.auth.user.id) : undefined, kinds.length ? inArray(J.type, kinds) : undefined) ?? sql`0`;
  };
  const seesJob = (req: FastifyRequest, job: JobRow) => everyJob(req) || (!!job.userId && job.userId === req.auth.user?.id) || jobKinds(req).includes(job.type);
  app.get("/api/v2/background-jobs", { config: { scope: ["background-jobs", "read"] } }, async (req) => {
    const c = ctx(req);
    const q = query(
      req,
      pageQuery.extend({
        ids: zList,
        included_ids: zList,
        excluded_ids: zList,
        type: z.string().optional(),
        entity_type: z.string().optional(),
        entity_id: zList,
        status: zList,
        sort_column: z.enum(["created_at", "updated_at"]).optional(),
        sort_order: z.enum(["asc", "desc"]).optional(),
      }),
    );
    const limit = q.limit ?? 100;
    const filters: SQL[] = [];
    if (q.ids?.length) filters.push(inArray(J.id, q.ids));
    if (q.excluded_ids?.length) filters.push(sql`${J.id} not in (${sql.join(q.excluded_ids.map((x) => sql`${x}`), sql`, `)})`);
    if (q.type) filters.push(eq(J.type, q.type));
    if (q.entity_type) filters.push(eq(J.entityType, q.entity_type));
    if (q.entity_id?.length) filters.push(inArray(J.entityId, q.entity_id));
    if (q.status?.length) filters.push(inArray(J.status, q.status));
    // included_ids adds jobs to what the filters match (with no filters, every job is there already).
    const matched = filters.length && q.included_ids?.length ? or(and(...filters), inArray(J.id, q.included_ids)) : and(...filters);
    const col = q.sort_column === "updated_at" ? J.updatedAt : J.createdAt;
    const ascending = q.sort_order === "asc";
    // The next page starts after the last job in the order asked for, whatever its id.
    let after: SQL | undefined;
    if (q.starting_after) {
      const [at] = await db.select({ v: col }).from(J).where(and(eq(J.id, q.starting_after), eq(J.workspaceId, c.wsId))).limit(1);
      if (!at) throw badRequest("starting_after: that job no longer exists. Load the list from the start.");
      after = ascending
        ? or(gt(col, at.v), and(eq(col, at.v), gt(J.id, q.starting_after)))
        : or(lt(col, at.v), and(eq(col, at.v), lt(J.id, q.starting_after)));
    }
    const rows = await db
      .select()
      .from(J)
      .where(and(eq(J.workspaceId, c.wsId), jobsSeen(req), matched, after))
      .orderBy(ascending ? asc(col) : desc(col), ascending ? asc(J.id) : desc(J.id))
      .limit(limit + 1);
    const page = paginated(rows, limit);
    return { ...page, items: page.items.map(serializeJob) };
  });

  app.get("/api/v2/background-jobs/:id", { config: { scope: ["background-jobs", "read"] } }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ data_fields: zList }));
    const job = await getJob((req.params as { id: string }).id);
    if (!job || job.workspaceId !== c.wsId || !seesJob(req, job)) throw notFound("Background job");
    const out = serializeJob(job);
    if (q.data_fields?.length && out.data) out.data = Object.fromEntries(Object.entries(out.data).filter(([k]) => q.data_fields!.includes(k)));
    return out;
  });

  app.post("/api/app/background-jobs/:id/cancel", { config: { write: true } }, async (req) => {
    const c = ctx(req);
    const job = await getJob((req.params as { id: string }).id);
    if (!job || job.workspaceId !== c.wsId || !seesJob(req, job)) throw notFound("Background job");
    const [unstarted] = await db.update(J).set({ status: "cancelled" }).where(and(eq(J.id, job.id), eq(J.status, "pending"))).returning();
    if (unstarted) {
      // One that never started won't run to clear its input or settle up (credits, waiting leads): that happens now.
      await dropJobInput(job.id);
      await cleanUpJob(unstarted, { handlerRan: false });
    } else {
      // A running one stops at its next step, then clears up after itself.
      await db.update(J).set({ status: "cancelled" }).where(and(eq(J.id, job.id), eq(J.status, "in-progress")));
    }
    return serializeJob((await getJob(job.id))!);
  });

  // ---------- App: import / export / notes / activity ----------
  // A full import (up to LEAD_IMPORT_MAX leads with their columns) is bigger than other requests may be.
  app.post("/api/app/leads/import", { config: leadsCreate, bodyLimit: 160 * 1024 * 1024 }, async (req) => {
    const c = ctx(req);
    const b = body(
      req,
      z.object({
        campaign_id: z.string().optional(),
        list_id: z.string().optional(),
        leads: z
          .array(leadInputSchema)
          .min(1)
          .max(LEAD_IMPORT_MAX, `One import takes up to ${LEAD_IMPORT_MAX.toLocaleString("en-US")} leads. Split the file and import the rest separately.`),
        skip_if_in_workspace: z.boolean().optional(),
        skip_if_in_campaign: z.boolean().optional(),
        skip_if_in_list: z.boolean().optional(),
        verify_leads_on_import: z.boolean().optional(),
        source: z.enum(["csv", "sheet", "manual"]).default("csv"),
        // A big file comes in parts: these leads are the first, and the rest follow to /parts while it runs.
        parts: z.number().int().min(1).max(1000).optional(),
        total: z.number().int().min(1).max(LEAD_IMPORT_MAX).optional(),
      }),
    );
    if (!b.campaign_id && !b.list_id) throw badRequest("Choose a campaign or a list");
    const { leads, parts, total, ...settings } = b;
    const job = await createJob({
      workspaceId: c.wsId,
      userId: c.userId,
      type: "import-leads",
      entityType: b.campaign_id ? "campaign" : "list",
      entityId: b.campaign_id ?? b.list_id ?? null,
      data: { ...settings, upload_method: b.source, total: total ?? leads.length, ...(parts && parts > 1 ? { parts } : {}) },
      input: leads,
    });
    return serializeJob(job);
  });

  // The next part of an import sent in parts (see above), by whoever started it, while the import runs.
  app.post("/api/app/leads/import/:id/parts", { config: leadsCreate, bodyLimit: 100 * 1024 * 1024 }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ seq: z.number().int().min(2), leads: z.array(leadInputSchema).min(1).max(LEAD_IMPORT_MAX) }));
    const job = await getJob((req.params as { id: string }).id);
    if (!job || job.workspaceId !== c.wsId || job.type !== "import-leads" || job.userId !== c.userId) throw notFound("Import");
    const parts = Number((job.data as { parts?: number } | null)?.parts ?? 1);
    if (b.seq > parts) throw badRequest(`This import was started with ${parts} part${parts === 1 ? "" : "s"}.`);
    if (job.status !== "pending" && job.status !== "in-progress") throw conflict("This import has already ended.");
    await addJobInputPart(job.id, b.seq, b.leads);
    return { ok: true };
  });

  app.post("/api/app/leads/import-sheet", { config: leadsCreate }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ url: z.string().url(), campaign_id: z.string().optional(), list_id: z.string().optional() }));
    const m = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(b.url);
    if (!m) throw badRequest("Paste a Google Sheets link");
    const gid = /[#&?]gid=(\d+)/.exec(b.url)?.[1] ?? "0";
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw badRequest("Could not read the sheet. Make sure it is shared as 'Anyone with the link can view'.");
    const parsed = Papa.parse<Record<string, string>>(await res.text(), { header: true, skipEmptyLines: true, transform: unescapeCsvFormula });
    // As much as one import takes; `total` says how many rows the sheet has, so the rest isn't dropped unnoticed.
    return { columns: parsed.meta.fields ?? [], rows: parsed.data.slice(0, LEAD_IMPORT_MAX), total: parsed.data.length, campaign_id: b.campaign_id ?? null, list_id: b.list_id ?? null, workspace: c.wsId };
  });

  app.post("/api/app/leads/export", { config: leadsRead }, async (req) => {
    const c = ctx(req);
    const b = body(req, leadFilterSchema.extend({ columns: z.array(z.string()).optional() }));
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: "export-leads", entityType: b.campaign ? "campaign" : b.list_id ? "list" : "workspace", entityId: b.campaign ?? b.list_id ?? c.wsId, data: b });
    return serializeJob(job);
  });

  app.get("/api/app/exports/:id/download", { config: leadsRead }, async (req, reply) => {
    const c = ctx(req);
    const job = await getJob((req.params as { id: string }).id);
    if (!job || job.workspaceId !== c.wsId || job.status !== "success") throw notFound("Export");
    const file = path.join(config.dataDir, "exports", `${job.id}.csv`);
    if (!existsSync(file)) throw notFound("Export file");
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="leads-export-${job.id.slice(0, 8)}.csv"`);
    return reply.send(createReadStream(file));
  });

  app.post("/api/app/leads/delete", { config: leadsDelete }, async (req) => {
    const c = ctx(req);
    const b = body(req, leadFilterSchema.extend({ limit: z.number().int().positive().optional() }));
    // Refuse an unfiltered request so a missing filter can never wipe every lead in the workspace.
    if (!isFiltered(b)) throw badRequest("Select leads, a campaign or a list");
    const conds = await leadConditions(c.wsId, b);
    const { count, entryId } = await deleteLeadsWhere(c.wsId, conds, actorOf(req), b.limit);
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_DELETION, req, affectedCount: count, campaignId: b.campaign ?? null, listId: b.list_id ?? null });
    return { count, recently_deleted_id: entryId };
  });

  app.post("/api/app/leads/status", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, leadFilterSchema.extend({ ...everyLead, action: z.enum(["pause", "resume", "mark_completed", "interest"]), interest_value: z.number().nullable().optional() }));
    assertSelection(b);
    const conds = await leadConditions(c.wsId, b);
    const ids = (await db.select({ id: L.id }).from(L).where(and(...conds))).map((r) => r.id);
    if (b.action === "interest") {
      await setInterestStatus({ workspaceId: c.wsId, leadIds: ids, value: b.interest_value ?? null, userId: c.userId, source: "user" });
      return { affected: ids.length };
    }
    for (const part of chunk(ids, 800)) {
      // In the campaign and in a subsequence alike.
      if (b.action === "pause") await pauseLeads(inArray(L.id, part));
      if (b.action === "resume") await resumeLeads(inArray(L.id, part));
      if (b.action === "mark_completed") await completeLeads(inArray(L.id, part));
    }
    return { affected: ids.length };
  });

  // One field or custom variable set (or cleared) for the selected leads: while the request waits for a few thousand,
  // by a background job for more. The answer has the count, or the job to follow.
  app.post("/api/app/leads/edit", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, editSchema);
    assertSelection(b);
    const edit = leadEditOf(b);
    const ids = (await db.select({ id: L.id }).from(L).where(and(...(await leadConditions(c.wsId, b))))).map((r) => r.id);
    const scope = { campaignId: b.campaign ?? null, listId: b.list_id ?? null };
    if (ids.length <= EDIT_INLINE_MAX) {
      await editLeads(c.wsId, ids, edit);
      await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_EDITED, req, affectedCount: ids.length, ...scope, metadata: { field: b.field ?? null, variable: b.variable ?? null, cleared: !b.value?.trim() } });
      return { count: ids.length, job: null };
    }
    const job = await createJob({
      workspaceId: c.wsId,
      userId: c.userId,
      type: "edit-leads",
      entityType: b.campaign ? "campaign" : b.list_id ? "list" : "workspace",
      entityId: b.campaign ?? b.list_id ?? c.wsId,
      data: { field: b.field, variable: b.variable, value: b.value, campaign: b.campaign, list_id: b.list_id, count: ids.length },
      input: ids,
    });
    return { count: ids.length, job: serializeJob(job) };
  });

  app.get("/api/app/leads/:id/activity", { config: leadsRead }, async (req) => {
    const c = ctx(req);
    const lead = await findLead(c.wsId, (req.params as { id: string }).id);
    return { lead: serializeLead(lead), ...(await leadActivity(c.wsId, lead)) };
  });

  app.get("/api/app/leads/by-email", { config: leadsRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ email: z.string().trim().toLowerCase() }));
    const rows = await db.select().from(L).where(and(eq(L.workspaceId, c.wsId), eq(L.email, q.email))).orderBy(desc(L.lastContactAt), desc(L.createdAt));
    const campaignIds = [...new Set(rows.map((r) => r.campaignId).filter((x): x is string => !!x))];
    const listIds = [...new Set(rows.map((r) => r.listId).filter((x): x is string => !!x))];
    const campaigns = campaignIds.length ? await db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(inArray(schema.campaigns.id, campaignIds)) : [];
    const lists = listIds.length ? await db.select({ id: schema.leadLists.id, name: schema.leadLists.name }).from(schema.leadLists).where(inArray(schema.leadLists.id, listIds)) : [];
    const names = new Map([...campaigns, ...lists].map((x) => [x.id, x.name]));
    return { items: rows.map((r) => ({ ...serializeLead(r), campaign_name: r.campaignId ? names.get(r.campaignId) : null, list_name: r.listId ? names.get(r.listId) : null })) };
  });

  const N = schema.leadNotes;
  app.get("/api/app/lead-notes", { config: leadsRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ lead_email: z.string().trim().toLowerCase().optional(), lead_id: z.string().optional() }));
    // A person's notes go by their address (their other leads show them too); a lead without one has its own.
    const about = [q.lead_email ? eq(N.leadEmail, q.lead_email) : null, q.lead_id ? eq(N.leadId, q.lead_id) : null].filter((x) => x !== null);
    if (!about.length) throw badRequest("Say which lead: lead_email or lead_id");
    const rows = await db.select().from(N).where(and(eq(N.workspaceId, c.wsId), or(...about))).orderBy(desc(N.createdAt));
    const userIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
    const users = userIds.length ? await db.select({ id: schema.users.id, firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    const byId = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim() || u.email]));
    return { items: rows.map((r) => ({ id: r.id, lead_email: r.leadEmail, lead_id: r.leadId, body: r.body, created_by: r.createdBy, created_by_name: r.createdBy ? byId.get(r.createdBy) : null, timestamp_created: iso(r.createdAt), timestamp_updated: iso(r.updatedAt) })) };
  });

  app.post("/api/app/lead-notes", { config: { perm: "leads", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ lead_email: z.string().trim().toLowerCase().nullable().optional(), lead_id: z.string().optional(), body: z.string().trim().min(1).max(20_000) }));
    // Only a lead of this workspace is kept with the note; its address files the note when none is given.
    const [lead] = b.lead_id ? await db.select({ id: L.id, email: L.email }).from(L).where(and(eq(L.id, b.lead_id), eq(L.workspaceId, c.wsId))).limit(1) : [];
    const email = b.lead_email || lead?.email?.toLowerCase() || null;
    if (!email && !lead) throw b.lead_id ? notFound("Lead") : badRequest("Say which lead the note is about");
    const [row] = await db.insert(N).values({ workspaceId: c.wsId, leadEmail: email, leadId: lead?.id ?? null, body: b.body, createdBy: c.userId }).returning();
    return { id: row!.id, body: row!.body, timestamp_created: iso(row!.createdAt) };
  });

  app.patch("/api/app/lead-notes/:id", { config: { perm: "leads", write: true } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ body: z.string().trim().min(1).max(20_000) }));
    const [row] = await db.update(N).set({ body: b.body }).where(and(eq(N.id, (req.params as { id: string }).id), eq(N.workspaceId, c.wsId))).returning();
    return { id: assertFound(row, "Note").id, body: row!.body };
  });

  app.delete("/api/app/lead-notes/:id", { config: { perm: "leads", write: true } }, async (req) => {
    const c = ctx(req);
    const [row] = await db.delete(N).where(and(eq(N.id, (req.params as { id: string }).id), eq(N.workspaceId, c.wsId))).returning();
    assertFound(row, "Note");
    return { ok: true };
  });

  /** Every list's name, newest first, for the pickers: all of them, not a first page. */
  app.get("/api/app/lead-lists/names", { config: listsRead }, async (req) => {
    const LS = schema.leadLists;
    const rows = await db.select({ id: LS.id, name: LS.name }).from(LS).where(eq(LS.workspaceId, ctx(req).wsId)).orderBy(desc(LS.createdAt), desc(LS.id));
    return { items: rows };
  });

  // Lead lists overview for the Leads page sidebar (with counts by status).
  app.get("/api/app/lead-lists/overview", { config: listsRead }, async (req) => {
    const c = ctx(req);
    const lists = await db.select().from(schema.leadLists).where(eq(schema.leadLists.workspaceId, c.wsId)).orderBy(desc(schema.leadLists.createdAt));
    const counts = await listCounts(lists.map((l) => l.id));
    const [total] = await db.select({ n: sql<number>`count(*)` }).from(L).where(and(eq(L.workspaceId, c.wsId), isNotNull(L.listId)));
    return { total_in_lists: Number(total?.n ?? 0), items: lists.map((l) => serializeList(l, counts.get(l.id) ?? 0)) };
  });

  /** Custom variable names the leads use (filter builder suggestions and AI column prompts). */
  app.get("/api/app/leads/variables", { config: leadsRead }, async (req) => {
    const c = ctx(req);
    const q = query(req, z.object({ campaign_id: z.string().optional(), list_id: z.string().optional() }));
    const scope = q.campaign_id ? sql`and ${L.campaignId} = ${q.campaign_id}` : q.list_id ? sql`and ${L.listId} = ${q.list_id}` : sql``;
    const rows = await db.all<{ key: string }>(sql`select distinct j.key as key from ${L}, json_each(${L.payload}) j where ${L.workspaceId} = ${c.wsId} ${scope} limit 500`);
    return { keys: rows.map((r) => r.key).filter(Boolean).sort((a, b) => a.localeCompare(b)) };
  });

  // ---------- Custom variables: how many leads have each and which emails use it; rename (or merge) and remove ----------
  app.get("/api/app/lead-variables", { config: leadsRead }, async (req) => ({ items: await listLeadVariables(ctx(req).wsId) }));

  // Renames a variable on every lead that has it (and, unless told not to, in the emails that use it): while the
  // request waits for a few thousand leads, by a background job for more.
  app.post("/api/app/lead-variables/rename", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: variableName, to: variableName, emails: z.boolean().optional() }));
    checkAppVariable(b.name);
    checkVariableName(b.to);
    if (b.to === b.name) throw badRequest("That's its name already.");
    const ids = await leadsWithVariable(c.wsId, b.name);
    if (!ids.length) throw notFound("Custom variable");
    const emails = b.emails ?? true;
    if (ids.length <= EDIT_INLINE_MAX) {
      const r = await renameLeadVariable({ workspaceId: c.wsId, leadIds: ids, from: b.name, to: b.to, emails, actor: actorOf(req) });
      await audit({ workspaceId: c.wsId, activityType: AuditActivity.VARIABLE_RENAMED, req, affectedCount: ids.length, metadata: { from: b.name, to: b.to, emails: r.emails } });
      return { ...r, job: null };
    }
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: "rename-variable", entityType: "workspace", entityId: c.wsId, data: { name: b.name, to: b.to, emails, count: ids.length }, input: ids });
    return { leads: ids.length, emails: null, job: serializeJob(job) };
  });

  app.post("/api/app/lead-variables/delete", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ name: variableName }));
    checkAppVariable(b.name);
    const ids = await leadsWithVariable(c.wsId, b.name);
    if (!ids.length) throw notFound("Custom variable");
    if (ids.length <= EDIT_INLINE_MAX) {
      const r = await deleteLeadVariable({ workspaceId: c.wsId, leadIds: ids, name: b.name });
      await audit({ workspaceId: c.wsId, activityType: AuditActivity.VARIABLE_DELETED, req, affectedCount: ids.length, metadata: { name: b.name } });
      return { ...r, job: null };
    }
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: "delete-variable", entityType: "workspace", entityId: c.wsId, data: { name: b.name, count: ids.length }, input: ids });
    return { leads: ids.length, job: serializeJob(job) };
  });

  // ---------- Saved views of the leads tables: filters and sort under a name, shared by the workspace ----------
  const V = schema.crmViews;
  const MAX_VIEWS = 100;
  const viewFields = {
    name: z.string().trim().min(1, "Give the view a name").max(80),
    rules: z.array(leadRuleSchema).max(MAX_LEAD_RULES),
    sort_by: z.enum(LEAD_SORT_KEYS).nullable().optional(),
    sort_order: z.enum(["asc", "desc"]).nullable().optional(),
  };
  const viewSort = (b: { sort_by?: LeadSortKey | null; sort_order?: "asc" | "desc" | null }) =>
    b.sort_by ? [{ by: b.sort_by, order: b.sort_order ?? LEAD_SORTS.find((s) => s.key === b.sort_by)?.order ?? "desc" }] : null;
  const leadViews = (wsId: string) => and(eq(V.workspaceId, wsId), eq(V.entity, "leads"));
  const findView = async (wsId: string, id: string) => assertFound((await db.select().from(V).where(and(eq(V.id, id), leadViews(wsId))).limit(1))[0], "Saved view");
  async function assertNameFree(wsId: string, name: string, exceptId?: string) {
    const rows = await db.select({ id: V.id, name: V.name }).from(V).where(leadViews(wsId));
    if (rows.some((r) => r.id !== exceptId && r.name.trim().toLowerCase() === name.toLowerCase())) throw conflict(`There's already a view called "${name}"`);
    if (!exceptId && rows.length >= MAX_VIEWS) throw badRequest(`A workspace can keep up to ${MAX_VIEWS} views. Delete one you no longer use first.`);
  }

  app.get("/api/app/lead-views", { config: leadsRead }, async (req) => {
    const c = ctx(req);
    const rows = await db.select().from(V).where(leadViews(c.wsId)).orderBy(asc(sql`lower(${V.name})`));
    return { items: rows.map(serializeSavedView) };
  });

  app.post("/api/app/lead-views", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object(viewFields));
    await assertNameFree(c.wsId, b.name);
    const [row] = await db.insert(V).values({ workspaceId: c.wsId, entity: "leads", name: b.name, filters: b.rules, sort: viewSort(b), createdBy: c.userId }).returning();
    return serializeSavedView(row!);
  });

  app.patch("/api/app/lead-views/:id", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const view = await findView(c.wsId, (req.params as { id: string }).id);
    const b = body(req, z.object(viewFields).partial());
    if (b.name !== undefined) await assertNameFree(c.wsId, b.name, view.id);
    const [row] = await db
      .update(V)
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.rules !== undefined ? { filters: b.rules } : {}),
        ...(b.sort_by !== undefined ? { sort: viewSort(b) } : {}),
      })
      .where(eq(V.id, view.id))
      .returning();
    return serializeSavedView(row!);
  });

  app.delete("/api/app/lead-views/:id", { config: leadsUpdate }, async (req) => {
    const c = ctx(req);
    const view = await findView(c.wsId, (req.params as { id: string }).id);
    await db.delete(V).where(eq(V.id, view.id));
    return { deleted: true };
  });
}

// Enrichment columns as the leads table shows them: one column per enrichment kind on a list or campaign and one
// per AI prompt. Lists them with their progress, runs them on chosen rows, stops and removes them. The work itself
// is the enrich-leads job in ./enrichment.
import { and, desc, eq, inArray, isNotNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { ENRICHMENT_OUTPUT_KEYS, VerificationStatus, normalizeKeys } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { notFound } from "../../http/errors";
import { iso } from "../../lib/time";
import { customValue, requestedSort, sortOrder } from "../lead-filters";
import { leadConditions, type LeadFilter } from "../leads";
import { FILLED_BY, normalizeTargets, scheduleRun, type AiColumnConfig, type EnrichmentRow, type ResourceType, type RunOptions } from "./enrichment";
import { findAction } from "./integrations";

const E = schema.enrichments;
const L = schema.leads;
const J = schema.backgroundJobs;
const RUNS = schema.enrichmentRuns;
const ACTIVE = ["pending", "in-progress"];

/** Column keys: the enrichment kind, or "ai:<variable>" for an AI column. */
export const columnKey = (type: string, name?: string) => (type === "ai_enrichment" ? `ai:${name ?? ""}` : type);

export interface EnrichmentColumn {
  key: string;
  type: string;
  /** AI columns: the variable each answer is saved to. */
  name?: string;
  ai?: AiColumnConfig;
  row: EnrichmentRow;
  /** Custom variables the column writes (found addresses and email checks live on the lead itself). */
  variables: string[];
}

function integrationVariables(row: EnrichmentRow): string[] {
  const actions = ((row.enrichmentPayload ?? {}).actions ?? {}) as Record<string, Record<string, unknown>>;
  const out = new Set<string>();
  for (const [provider, acts] of Object.entries(actions)) {
    for (const action of Object.keys(acts ?? {})) {
      try {
        out.add(findAction(provider, action).action.outputColumn);
      } catch {
        // A provider or action that no longer exists writes nothing.
      }
    }
  }
  return [...out];
}

/** The columns a resource's enrichment rows make, oldest first. */
export function columnsOf(rows: EnrichmentRow[]): EnrichmentColumn[] {
  const out: EnrichmentColumn[] = [];
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (row.type === "supersearch") continue;
    if (row.type === "ai_enrichment") {
      for (const ai of Object.values(((row.enrichmentPayload ?? {}).columns ?? {}) as Record<string, AiColumnConfig>)) {
        out.push({ key: columnKey(row.type, ai.output_column), type: row.type, name: ai.output_column, ai, row, variables: [ai.output_column] });
      }
      continue;
    }
    const variables = row.type === "normalize" ? normalizeKeys(normalizeTargets(row)) : row.type === "integration" ? integrationVariables(row) : [...(ENRICHMENT_OUTPUT_KEYS[row.type] ?? [])];
    out.push({ key: row.type, type: row.type, row, variables });
  }
  return out;
}

export async function resourceColumns(workspaceId: string, resourceId: string): Promise<EnrichmentColumn[]> {
  return columnsOf(await db.select().from(E).where(and(eq(E.workspaceId, workspaceId), eq(E.resourceId, resourceId))));
}

export async function findColumn(workspaceId: string, resourceId: string, key: string): Promise<EnrichmentColumn> {
  const col = (await resourceColumns(workspaceId, resourceId)).find((c) => c.key === key);
  if (!col) throw notFound("Enrichment column");
  return col;
}

const resourceLeads = (workspaceId: string, resourceId: string, type: ResourceType) =>
  and(eq(L.workspaceId, workspaceId), type === 1 ? eq(L.campaignId, resourceId) : eq(L.listId, resourceId))!;

const NOT_CHECKED = [VerificationStatus.NOT_VERIFIED, VerificationStatus.PENDING, VerificationStatus.PENDING_JOB];

/** Leads that have a value in the column. */
export function filledCondition(c: EnrichmentColumn): SQL {
  if (c.type === "work_email_enrichment" || c.type === "custom_flow") return sql`coalesce(${L.email}, '') <> ''`;
  if (c.type === "email_verification") return notInArray(L.verificationStatus, NOT_CHECKED);
  const keys = FILLED_BY[c.type] ?? c.variables;
  return keys.length ? or(...keys.map((k) => sql`coalesce(${customValue(k)}, '') <> ''`))! : sql`0 = 1`;
}

async function activeJobs(workspaceId: string, resourceId: string) {
  return db
    .select()
    .from(J)
    .where(and(eq(J.workspaceId, workspaceId), eq(J.type, "enrich-leads"), eq(J.entityId, resourceId), inArray(J.status, ACTIVE)));
}

/**
 * Whether a run of the column's enrichment fills this column: an AI run fills the AI columns noted when it was queued
 * (runs queued before those were noted: the one they name, or all of them).
 */
const namesColumn = (data: unknown, c: EnrichmentColumn) => {
  const d = (data ?? {}) as { columnName?: string; aiColumns?: string[] };
  if (c.type !== "ai_enrichment") return true;
  if (d.aiColumns) return d.aiColumns.includes(c.name ?? "");
  return !d.columnName || d.columnName === c.name;
};
const covers = (data: unknown, c: EnrichmentColumn) => !!((data ?? {}) as { enrichment_ids?: string[] }).enrichment_ids?.includes(c.row.id) && namesColumn(data, c);

/** The resource's columns with how many leads have a value, the run in progress and the last finished run. */
export async function listColumns(workspaceId: string, resourceId: string, type: ResourceType) {
  const columns = await resourceColumns(workspaceId, resourceId);
  const fields: Record<string, SQL<number>> = { total: sql<number>`count(*)` };
  columns.forEach((c, i) => {
    fields[`c${i}`] = sql<number>`coalesce(sum(case when ${filledCondition(c)} then 1 else 0 end), 0)`;
  });
  const [counts] = await db.select(fields).from(L).where(resourceLeads(workspaceId, resourceId, type));
  const jobs = await activeJobs(workspaceId, resourceId);
  const runs = await db
    .select({ run: RUNS, data: J.data })
    .from(RUNS)
    .leftJoin(J, eq(J.id, RUNS.jobId))
    .where(and(eq(RUNS.workspaceId, workspaceId), eq(RUNS.resourceId, resourceId), sql`${RUNS.status} <> 'running'`))
    .orderBy(desc(RUNS.startedAt))
    .limit(200);
  return {
    total_leads: Number(counts?.total ?? 0),
    columns: columns.map((c, i) => {
      const job = jobs.find((j) => covers(j.data, c));
      const at = (job?.data ?? {}) as { processed?: number; total?: number };
      const last = runs.find((r) => r.run.enrichmentId === c.row.id && namesColumn(r.data, c))?.run;
      return {
        key: c.key,
        type: c.type,
        name: c.name ?? null,
        variables: c.variables,
        prompt: c.ai?.prompt ?? null,
        skip_leads_without_email: c.ai?.skip_leads_without_email ?? false,
        paused: c.ai?.status === 2,
        targets: c.type === "normalize" ? normalizeTargets(c.row) : null,
        auto_update: c.ai?.auto_update ?? !!c.row.autoUpdate,
        filled: Number(counts?.[`c${i}`] ?? 0),
        running: job ? { job_id: job.id, status: job.status, progress: Math.round(job.progress), processed: at.processed ?? 0, total: at.total ?? null } : null,
        last_run: last
          ? { status: last.status, processed: last.processed, succeeded: last.succeeded, failed: last.failed, credits_used: last.creditsUsed, error: last.error, finished_at: iso(last.finishedAt) }
          : null,
        timestamp_created: iso(c.row.createdAt),
      };
    }),
  };
}

/** Rows to run a column on: the first rows of the table as it's filtered and sorted, picked rows, a filter, or all. */
export type RowsScope = { mode: "first"; count: number; filter?: LeadFilter } | { mode: "ids"; ids: string[] } | { mode: "filter"; filter: LeadFilter } | { mode: "all" };

/** Queues a run of one column; null when no lead matches. */
export async function runColumn(workspaceId: string, userId: string | null, c: EnrichmentColumn, type: ResourceType, rows: RowsScope, overwrite: boolean) {
  const resourceId = c.row.resourceId;
  // Filters from the table never reach past this list or campaign.
  const inResource = (f: LeadFilter = {}): LeadFilter => ({ ...f, campaign: type === 1 ? resourceId : undefined, list_id: type === 2 ? resourceId : undefined });
  const opts: RunOptions = {
    types: [c.type],
    // A found address never replaces one the lead already has.
    overwrite: c.type === "work_email_enrichment" || c.type === "custom_flow" ? false : overwrite,
    ...(c.name ? { columnName: c.name } : {}),
  };
  if (rows.mode === "first") {
    const f = inResource(rows.filter);
    const sort = await requestedSort(workspaceId, f);
    const picked = await db
      .select({ id: L.id })
      .from(L)
      .where(and(...(await leadConditions(workspaceId, f))))
      .orderBy(...(sort ? sortOrder(sort) : [desc(L.id)]))
      .limit(rows.count);
    if (!picked.length) return null;
    opts.leadIds = picked.map((r) => r.id);
  } else if (rows.mode === "ids") opts.leadIds = rows.ids;
  else if (rows.mode === "filter") opts.leadFilter = inResource(rows.filter);
  if (rows.mode !== "first") {
    const conds = rows.mode === "ids" ? [resourceLeads(workspaceId, resourceId, type), inArray(L.id, rows.ids)] : await leadConditions(workspaceId, inResource(rows.mode === "filter" ? rows.filter : {}));
    const [any] = await db.select({ id: L.id }).from(L).where(and(...conds)).limit(1);
    if (!any) return null;
  }
  return scheduleRun(workspaceId, userId, resourceId, opts);
}

/** Leaves the in-progress flag only on enrichments that still have a run waiting or running. */
async function settleInProgress(workspaceId: string, resourceId: string) {
  const busy = new Set((await activeJobs(workspaceId, resourceId)).flatMap((j) => ((j.data ?? {}) as { enrichment_ids?: string[] }).enrichment_ids ?? []));
  const flagged = await db.select({ id: E.id }).from(E).where(and(eq(E.workspaceId, workspaceId), eq(E.resourceId, resourceId), eq(E.inProgress, true)));
  const idle = flagged.map((r) => r.id).filter((id) => !busy.has(id));
  if (idle.length) await db.update(E).set({ inProgress: false }).where(inArray(E.id, idle));
}

/** Stops the runs filling a column; returns how many were stopped. */
export async function stopColumn(workspaceId: string, c: EnrichmentColumn): Promise<number> {
  const jobs = (await activeJobs(workspaceId, c.row.resourceId)).filter((j) => covers(j.data, c));
  if (!jobs.length) return 0;
  await db
    .update(J)
    .set({ status: "cancelled" })
    .where(and(inArray(J.id, jobs.map((j) => j.id)), inArray(J.status, ACTIVE)));
  // A run that never started won't reach the job's own clean-up.
  const waiting = jobs.filter((j) => j.status === "pending").map((j) => j.id);
  if (waiting.length) await db.update(RUNS).set({ status: "cancelled", finishedAt: new Date() }).where(and(inArray(RUNS.jobId, waiting), eq(RUNS.status, "running")));
  await settleInProgress(workspaceId, c.row.resourceId);
  return jobs.length;
}

/** Deletes custom variables from the leads in scope. */
async function clearVariables(scope: SQL, keys: string[]) {
  // Plain keys go in one statement; anything else (names saved through the API) one lead at a time.
  const plain = keys.filter((k) => /^[\w -]+$/.test(k));
  const odd = keys.filter((k) => !plain.includes(k));
  if (plain.length) {
    await db
      .update(L)
      .set({ payload: sql`json_remove(${L.payload}, ${sql.join(plain.map((k) => sql`${`$."${k}"`}`), sql`, `)})` })
      .where(and(scope, or(...plain.map((k) => isNotNull(customValue(k))))));
  }
  if (!odd.length) return;
  for (const lead of await db.select({ id: L.id, payload: L.payload }).from(L).where(and(scope, isNotNull(L.payload)))) {
    const payload = { ...(lead.payload ?? {}) };
    if (!odd.some((k) => k in payload)) continue;
    for (const k of odd) delete payload[k];
    await db.update(L).set({ payload }).where(eq(L.id, lead.id));
  }
}

/** Removes a column. With clearValues the variables it wrote go too (never found addresses or email checks). */
export async function removeColumn(workspaceId: string, c: EnrichmentColumn, type: ResourceType, clearValues: boolean) {
  await stopColumn(workspaceId, c);
  const resourceId = c.row.resourceId;
  if (c.type === "ai_enrichment") {
    const columns = { ...(((c.row.enrichmentPayload ?? {}).columns ?? {}) as Record<string, AiColumnConfig>) };
    delete columns[c.name!];
    if (Object.keys(columns).length) await db.update(E).set({ enrichmentPayload: { ...(c.row.enrichmentPayload ?? {}), columns } }).where(eq(E.id, c.row.id));
    else await db.delete(E).where(eq(E.id, c.row.id));
  } else {
    await db.delete(E).where(eq(E.id, c.row.id));
  }
  const left = await resourceColumns(workspaceId, resourceId);
  if (clearValues) {
    // Variables another column still writes stay.
    const kept = new Set(left.flatMap((x) => x.variables));
    await clearVariables(resourceLeads(workspaceId, resourceId, type), c.variables.filter((k) => !kept.has(k)));
  }
  if (type === 2) {
    const [any] = await db.select({ id: E.id }).from(E).where(and(eq(E.workspaceId, workspaceId), eq(E.resourceId, resourceId))).limit(1);
    if (!any) await db.update(schema.leadLists).set({ hasEnrichmentTask: false }).where(eq(schema.leadLists.id, resourceId));
  }
}

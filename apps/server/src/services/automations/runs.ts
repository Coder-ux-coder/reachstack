// Automation runs: creating them, the progress the engine stores on them, serialization for History, and retries.
import { and, eq, or, sql } from "drizzle-orm";
import { MAX_RUN_RETRIES, nodeLabel, type AutomationGraph, type RunStatus, type RunVariables } from "@reachstack/shared";
import { db, isDuplicate, schema } from "../../db/client";
import { conflict } from "../../http/errors";
import { iso } from "../../lib/time";

const W = schema.workflows;
const R = schema.workflowRuns;
export type WorkflowRow = typeof W.$inferSelect;
export type RunRow = typeof R.$inferSelect;
export type LogLine = { at: string; node: string; level: string; message: string };

export interface StepRecord {
  status: "running" | "success" | "error" | "waiting";
  started_at: string;
  finished_at?: string | null;
  /** What the step worked with (resolved fields, condition details), shown as "Data in". */
  input?: unknown;
  output?: unknown;
  error?: string | null;
}

/** A step ready to run; `via` is the connection it arrived through (joins wait for all of theirs). */
export interface Token {
  node: string;
  via?: string | null;
}

export interface RunState {
  steps: Record<string, StepRecord>;
  queue: Token[];
  /** Delay steps waiting for their time (epoch ms). */
  delayed: Array<{ node: string; until: number }>;
  /** Join steps: incoming connections that have arrived so far. */
  arrived: Record<string, string[]>;
  /** Join steps that already continued. */
  joined: string[];
  /** Steps in the order they finished. */
  order: string[];
  executed: number;
  /** How many automations set this one off in a row (see scope.ts). */
  depth: number;
}

export const ACTIVE_RUN_STATUSES: RunStatus[] = ["queued", "running", "waiting"];

export function initialState(graph: AutomationGraph, depth = 0): RunState {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  return { steps: {}, queue: trigger ? [{ node: trigger.id }] : [], delayed: [], arrived: {}, joined: [], order: [], executed: 0, depth };
}

export const runState = (r: Pick<RunRow, "context">): RunState => ({ ...initialState({ nodes: [], edges: [] }), ...((r.context ?? {}) as Partial<RunState>) });

/** The data steps can reference while this run executes. */
export function runVariables(run: Pick<RunRow, "id" | "attempt" | "isTest" | "triggerEvent">, wf: Pick<WorkflowRow, "id" | "name">, state: RunState): RunVariables {
  const steps: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(state.steps)) if (s.status === "success") steps[id] = s.output ?? null;
  return {
    trigger: (run.triggerEvent ?? {}) as RunVariables["trigger"],
    steps: steps as RunVariables["steps"],
    workflow: { id: wf.id, name: wf.name },
    run: { id: run.id, attempt: run.attempt, is_test: run.isTest },
    now: new Date().toISOString(),
  };
}

/** Queues one run per trigger output (several when one event covers many leads). */
export async function createRuns(wf: WorkflowRow, outputs: Array<Record<string, unknown>>, opts: { isTest?: boolean; depth?: number } = {}) {
  if (!outputs.length) return [];
  const now = new Date();
  const rows: RunRow[] = [];
  for (let i = 0; i < outputs.length; i += 100) {
    const values = outputs.slice(i, i + 100).map((trigger) => ({
      workspaceId: wf.workspaceId,
      workflowId: wf.id,
      status: "queued" as const,
      triggerEvent: trigger,
      context: initialState(wf.graph, opts.depth ?? 0) as unknown as Record<string, unknown>,
      workflowVersion: wf.version,
      isTest: !!opts.isTest,
      leadEmail: ((trigger.lead as { email?: string | null } | null | undefined)?.email ?? null) || null,
      logs: [],
      updatedAt: now,
    }));
    rows.push(...(await db.insert(R).values(values).returning()));
  }
  if (!opts.isTest) {
    // Keep updated_at as it is: "Last modified" means edits, not runs.
    await db
      .update(W)
      .set({ runCount: sql`${W.runCount} + ${rows.length}`, lastRunAt: now, updatedAt: sql`${W.updatedAt}` })
      .where(eq(W.id, wf.id));
  }
  return rows;
}

export async function createRun(wf: WorkflowRow, trigger: Record<string, unknown>, opts: { isTest?: boolean; depth?: number } = {}) {
  const [row] = await createRuns(wf, [trigger], opts);
  return row!;
}

function stepName(wf: Pick<WorkflowRow, "graph"> | null | undefined, id: string | null | undefined) {
  if (!id) return null;
  const node = wf?.graph.nodes.find((n) => n.id === id);
  return node ? nodeLabel(node) : "A deleted step";
}

export function serializeRun(r: RunRow, wf?: Pick<WorkflowRow, "name" | "graph"> | null) {
  return {
    id: r.id,
    workflow_id: r.workflowId,
    workflow_name: wf?.name ?? null,
    status: r.status,
    error: r.error,
    current_step: r.currentNodeId ? { id: r.currentNodeId, name: stepName(wf, r.currentNodeId) } : null,
    lead_email: r.leadEmail,
    is_test: r.isTest,
    attempt: r.attempt,
    retry_of: r.retryOf,
    resume_at: iso(r.resumeAt),
    duration_ms: r.durationMs,
    timestamp_created: iso(r.startedAt),
    timestamp_updated: iso(r.updatedAt ?? r.startedAt),
    timestamp_finished: iso(r.finishedAt),
  };
}

const lineageOf = (root: string) => db.select().from(R).where(or(eq(R.id, root), eq(R.retryOf, root))).orderBy(R.attempt);

export interface RetryCheck {
  available: boolean;
  reason: string | null;
  message: string | null;
}

export function retryCheck(r: RunRow, wf: WorkflowRow | null, lineage: RunRow[]): RetryCheck {
  const no = (reason: string, message: string): RetryCheck => ({ available: false, reason, message });
  if (r.status !== "error") return no("invalid_status", "Only runs that failed can be retried.");
  if (!wf) return no("workflow_unavailable", "Retry is unavailable: this automation was deleted.");
  if (!r.isTest && wf.status !== "active") return no("workflow_inactive", "Retry is unavailable: turn the automation on to retry the failed step.");
  if (wf.version !== r.workflowVersion) return no("flow_changed", "Retry is unavailable: the automation was edited after this run failed. Start a new run instead.");
  if (lineage.some((x) => x.status === "success" && x.attempt > r.attempt)) return no("lineage_succeeded", "A later retry of this run already succeeded.");
  if (lineage.some((x) => ACTIVE_RUN_STATUSES.includes(x.status))) return no("in_flight", "A retry of this run is still going. Wait for it to finish.");
  const latest = Math.max(...lineage.map((x) => x.attempt));
  if (r.attempt < latest) return no("superseded", "A newer attempt of this run exists. Retry that one instead.");
  if (latest >= MAX_RUN_RETRIES) return no("limit_exceeded", "This run reached the retry limit. Start a new run to try again.");
  return { available: true, reason: null, message: null };
}

/** Full detail for the History dialog: every step's data, the log and the attempts. */
export async function runDetail(r: RunRow) {
  const [wf] = await db.select().from(W).where(eq(W.id, r.workflowId)).limit(1);
  const state = runState(r);
  const nodes = new Map((wf?.graph.nodes ?? []).map((n) => [n.id, n]));
  const ids = [...state.order, ...Object.keys(state.steps).filter((id) => !state.order.includes(id))];
  const lineage = await lineageOf(r.retryOf ?? r.id);
  return {
    ...serializeRun(r, wf),
    trigger: r.triggerEvent,
    steps: ids.map((id) => {
      const s = state.steps[id]!;
      const node = nodes.get(id);
      return {
        id,
        name: node ? nodeLabel(node) : "A deleted step",
        type: node?.type ?? null,
        key: node?.data.key ?? null,
        status: s.status,
        started_at: s.started_at,
        finished_at: s.finished_at ?? null,
        input: s.input ?? null,
        // The trigger's data is stored once, as the run's trigger_event.
        output: s.output ?? (node?.type === "trigger" ? r.triggerEvent : null),
        error: s.error ?? null,
      };
    }),
    logs: r.logs ?? [],
    attempts: lineage.map((x) => ({ id: x.id, attempt: x.attempt, status: x.status, timestamp_created: iso(x.startedAt) })),
    retry: retryCheck(r, wf ?? null, lineage),
  };
}

/** Starts a new attempt that resumes at the failed step, reusing what earlier steps produced. */
export async function retryRun(r: RunRow) {
  const root = r.retryOf ?? r.id;
  const lineage = await lineageOf(root);
  const [wf] = await db.select().from(W).where(eq(W.id, r.workflowId)).limit(1);
  const check = retryCheck(r, wf ?? null, lineage);
  if (!check.available) throw conflict(check.message!);
  const state = runState(r);
  const failed = r.currentNodeId;
  if (failed) {
    delete state.steps[failed];
    state.order = state.order.filter((id) => id !== failed);
  }
  const attempt = Math.max(...lineage.map((x) => x.attempt)) + 1;
  const now = new Date();
  // Two retries clicked at once both see the same last attempt; the second one finds its number taken.
  const [row] = await db
    .insert(R)
    .values({
      workspaceId: r.workspaceId,
      workflowId: r.workflowId,
      status: "queued",
      triggerEvent: r.triggerEvent,
      context: state as unknown as Record<string, unknown>,
      workflowVersion: r.workflowVersion,
      attempt,
      retryOf: root,
      isTest: r.isTest,
      leadEmail: r.leadEmail,
      logs: [{ at: now.toISOString(), node: "", level: "info", message: `Retry ${attempt}: resuming at "${stepName(wf, failed) ?? "the failed step"}".` }],
      updatedAt: now,
    })
    .returning()
    .catch((err: unknown) => {
      throw isDuplicate(err) ? conflict("This run is already being retried.") : err;
    });
  return row!;
}

/** Stops a run that hasn't finished (waiting on a delay or queued). */
export async function cancelRun(r: RunRow, reason = "Cancelled by a user.") {
  const now = new Date();
  const [row] = await db
    .update(R)
    .set({ status: "cancelled", error: reason, resumeAt: null, lockedAt: null, finishedAt: now, updatedAt: now, durationMs: now.getTime() - r.startedAt.getTime() })
    .where(and(eq(R.id, r.id), or(eq(R.status, "queued"), eq(R.status, "waiting"))))
    .returning();
  if (!row) throw conflict("Only runs that are queued or waiting can be cancelled.");
  return row;
}

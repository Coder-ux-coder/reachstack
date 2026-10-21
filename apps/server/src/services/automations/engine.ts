// Runs automations. The loop claims queued runs and runs whose delay is over, walks the graph from where each run
// stopped, and saves every step's data on the run, so History can show it and a retry can resume at a failed step.
import { and, eq, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { actionDef, delayError, delayToMs, evaluateCondition, testVariables, type AutomationGraph, type AutomationNode } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { engineRunsHere, keepSending } from "../../engine/index";
import { inUse } from "../live-workspaces";
import { HttpError, badRequest } from "../../http/errors";
import { ACTION_RUNNERS, StepError, emptyRequired, resolveFields } from "./actions";
import { initialState, runState, runVariables, type LogLine, type RunRow, type RunState, type StepRecord, type Token, type WorkflowRow } from "./runs";
import { automationScope, type AutomationScope } from "./scope";
import { withCurrentLead } from "./triggers";

const R = schema.workflowRuns;
const W = schema.workflows;

const MAX_PARALLEL = 4;
/** Steps one run may take (a guard against graphs that keep fanning out). */
const MAX_STEPS = 500;
/** A run still marked running after this long was cut off (the process stopped mid-run). */
const STALE_MS = 15 * 60_000;
const MAX_LOGS = 300;
const MAX_OUTPUT_CHARS = 200_000;

const active = new Set<string>();
let lastStaleCheck = 0;
/** A pick of due runs is going on; `pickAgain` asks it for one more round once it's done. */
let picking = false;
let pickAgain = false;

interface Exec {
  run: RunRow;
  wf: WorkflowRow;
  state: RunState;
  logs: LogLine[];
  nodes: Map<string, AutomationNode>;
  scope: AutomationScope;
  /** The step being worked on and its filled-in fields (kept for the error record). */
  current: { node: string; input: unknown } | null;
}

/** Engine loop: starts queued runs and runs whose delay is over. */
export async function runAutomations() {
  if (Date.now() - lastStaleCheck > 60_000) {
    lastStaleCheck = Date.now();
    await failStaleRuns();
  }
  await startDue();
}

/**
 * The next runs to start, `limit` at most: each workspace's in turn (a test run first, then oldest first), so one
 * workspace with a long queue (a big import) doesn't hold up the others.
 */
async function dueRuns(limit: number): Promise<string[]> {
  const now = new Date();
  const ranked = db
    .select({ id: R.id, startedAt: R.startedAt, turn: sql<number>`row_number() over (partition by ${R.workspaceId} order by ${R.isTest} desc, ${R.startedAt}, ${R.id})`.as("turn") })
    .from(R)
    .where(and(or(eq(R.status, "queued"), and(eq(R.status, "waiting"), lte(R.resumeAt, now))), await inUse(R.workspaceId)))
    .as("ranked");
  const rows = await db.select({ id: ranked.id }).from(ranked).orderBy(sql`turn`, ranked.startedAt).limit(limit);
  return rows.map((r) => r.id);
}

/** Fills the free places with due runs; while the engine runs here, a run that ends makes room for the next at once. */
async function startDue() {
  if (picking) {
    pickAgain = true;
    return;
  }
  picking = true;
  try {
    do {
      pickAgain = false;
      if (active.size >= MAX_PARALLEL || !keepSending()) return;
      for (const id of await dueRuns(MAX_PARALLEL + active.size)) {
        if (active.size >= MAX_PARALLEL) break;
        if (active.has(id)) continue;
        active.add(id);
        void executeRun(id)
          .catch((err) => console.error("[automations]", err))
          .finally(() => {
            active.delete(id);
            if (engineRunsHere()) void startDue().catch((err) => console.error("[automations]", err));
          });
      }
    } while (pickAgain);
  } finally {
    picking = false;
  }
}

async function failStaleRuns() {
  const now = new Date();
  await db
    .update(R)
    .set({ status: "error", error: "The run stopped unexpectedly, probably because the server restarted. Retry it to continue from the step it was on.", lockedAt: null, finishedAt: now, updatedAt: now })
    .where(and(eq(R.status, "running"), lt(R.lockedAt, new Date(now.getTime() - STALE_MS)), ...(active.size ? [notInArray(R.id, [...active])] : [])));
}

async function stopRun(run: RunRow, status: "cancelled" | "error", error: string) {
  const now = new Date();
  await db
    .update(R)
    .set({ status, error, lockedAt: null, resumeAt: null, finishedAt: now, updatedAt: now, durationMs: now.getTime() - run.startedAt.getTime() })
    .where(eq(R.id, run.id));
}

async function executeRun(id: string) {
  const now = new Date();
  const [run] = await db
    .update(R)
    .set({ status: "running", lockedAt: now, updatedAt: now })
    .where(and(eq(R.id, id), or(eq(R.status, "queued"), and(eq(R.status, "waiting"), lte(R.resumeAt, now)))))
    .returning();
  if (!run) return;
  const [wf] = await db.select().from(W).where(eq(W.id, run.workflowId)).limit(1);
  let state = runState(run);
  const started = Object.keys(state.steps).length > 0;
  if (!wf) return stopRun(run, "cancelled", "The automation was deleted.");
  if (!run.isTest && wf.status !== "active") {
    return stopRun(run, "cancelled", started ? "The automation was turned off while this run was waiting." : "The automation was turned off before this run started.");
  }
  if (run.workflowVersion !== wf.version) {
    if (started) return stopRun(run, "cancelled", "The automation was edited while this run was waiting, so the run stopped. New runs use the edited version.");
    // Queued before the edit and not started yet: run the current version.
    state = initialState(wf.graph, state.depth);
    run.workflowVersion = wf.version;
  }
  // Going on after a wait (a Delay, or a retry): the lead as it is now, so "still no reply?" checks today's status.
  // History keeps the event as it came.
  if (started) run.triggerEvent = await withCurrentLead(run.workspaceId, run.triggerEvent);
  const x: Exec = {
    run,
    wf,
    state,
    logs: [...(run.logs ?? [])],
    nodes: new Map(wf.graph.nodes.map((n) => [n.id, n])),
    scope: { runId: run.id, workflowId: wf.id, depth: state.depth + 1, notes: [], pending: [] },
    current: null,
  };
  await walk(x);
}

// ---------------------------------------------------------------------------------------------------------------
// Walking the graph

function log(x: Exec, node: string, level: "info" | "warn" | "error", message: string) {
  x.logs.push({ at: new Date().toISOString(), node, level, message: message.slice(0, 2_000) });
  if (x.logs.length > MAX_LOGS) x.logs.splice(0, x.logs.length - MAX_LOGS);
}

function drainNotes(x: Exec) {
  for (const note of x.scope.notes.splice(0)) log(x, x.current?.node ?? "", "warn", note);
}

function outgoing(x: Exec, nodeId: string, handle: string | null): Token[] {
  return x.wf.graph.edges.filter((e) => e.source === nodeId && (e.sourceHandle ?? null) === handle && x.nodes.has(e.target)).map((e) => ({ node: e.target, via: e.id }));
}

const incoming = (x: Exec, nodeId: string) => x.wf.graph.edges.filter((e) => e.target === nodeId && x.nodes.has(e.source));

function record(x: Exec, nodeId: string, step: StepRecord) {
  x.state.steps[nodeId] = step;
  x.state.order = [...x.state.order.filter((id) => id !== nodeId), nodeId];
}

function clampOutput(output: unknown): unknown {
  const json = JSON.stringify(output ?? null);
  return json.length <= MAX_OUTPUT_CHARS ? output : { too_large: true, size: json.length, preview: json.slice(0, 2_000) };
}

async function save(x: Exec) {
  drainNotes(x);
  const now = new Date();
  await db
    .update(R)
    .set({ context: x.state as unknown as Record<string, unknown>, logs: x.logs, workflowVersion: x.run.workflowVersion, lockedAt: now, updatedAt: now })
    .where(eq(R.id, x.run.id));
}

async function finish(x: Exec, patch: { status: "success" | "waiting" | "error"; error?: string | null; currentNodeId?: string | null; resumeAt?: Date | null }) {
  drainNotes(x);
  const now = new Date();
  const done = patch.status !== "waiting";
  await db
    .update(R)
    .set({
      status: patch.status,
      error: patch.error ?? null,
      context: x.state as unknown as Record<string, unknown>,
      logs: x.logs,
      workflowVersion: x.run.workflowVersion,
      currentNodeId: patch.currentNodeId ?? null,
      resumeAt: patch.resumeAt ?? null,
      lockedAt: null,
      updatedAt: now,
      ...(done ? { finishedAt: now, durationMs: now.getTime() - x.run.startedAt.getTime() } : {}),
    })
    .where(eq(R.id, x.run.id));
}

/** Whether a path goes from one step to the other. */
function leadsTo(x: Exec, from: string, to: string): boolean {
  const seen = new Set([from]);
  const next = [from];
  while (next.length) {
    const id = next.pop()!;
    for (const e of x.wf.graph.edges) {
      if (e.source !== id || seen.has(e.target)) continue;
      if (e.target === to) return true;
      seen.add(e.target);
      next.push(e.target);
    }
  }
  return false;
}

function release(x: Exec, nodeId: string, partial: boolean) {
  const expected = incoming(x, nodeId).length;
  const arrived = x.state.arrived[nodeId]?.length ?? 0;
  x.state.joined.push(nodeId);
  const now = new Date().toISOString();
  record(x, nodeId, { status: "success", started_at: x.state.steps[nodeId]?.started_at ?? now, finished_at: now, output: { arrived, expected } });
  if (partial) log(x, nodeId, "info", `Continued with ${arrived} of ${expected} paths; the others didn't run.`);
  x.state.queue.push(...outgoing(x, nodeId, null));
}

async function walk(x: Exec) {
  const { state } = x;
  const now = Date.now();
  for (const d of state.delayed.filter((d) => d.until <= now)) {
    const step = state.steps[d.node];
    if (step) record(x, d.node, { ...step, status: "success", finished_at: new Date().toISOString() });
    state.queue.push(...outgoing(x, d.node, null));
  }
  state.delayed = state.delayed.filter((d) => d.until > now);

  for (;;) {
    while (state.queue.length) {
      const token = state.queue.shift()!;
      if (state.executed >= MAX_STEPS) {
        state.queue.unshift(token);
        const message = `The run stopped after ${MAX_STEPS} steps. Check the automation for paths that repeat.`;
        log(x, token.node, "error", message);
        return finish(x, { status: "error", error: message, currentNodeId: token.node });
      }
      if (!(await runStep(x, token))) return;
      await save(x);
    }
    // Joins still waiting on paths that never ran continue with what arrived, once nothing else can: one at a time and
    // the innermost first, since a join another waiting join leads into must hear from that one before it goes on.
    if (state.delayed.length) break;
    const pending = Object.keys(state.arrived).filter((id) => !state.joined.includes(id) && x.nodes.has(id));
    if (!pending.length) break;
    release(x, pending.find((id) => !pending.some((other) => other !== id && leadsTo(x, other, id))) ?? pending[0]!, true);
  }
  if (state.delayed.length) {
    const next = state.delayed.reduce((a, b) => (b.until < a.until ? b : a));
    return finish(x, { status: "waiting", currentNodeId: next.node, resumeAt: new Date(next.until) });
  }
  log(x, "", "info", x.run.isTest ? "Test run finished." : "Run finished.");
  return finish(x, { status: "success" });
}

/** Runs one step; false when it failed (the run is already marked as failed). */
async function runStep(x: Exec, token: Token): Promise<boolean> {
  const node = x.nodes.get(token.node);
  if (!node) {
    log(x, token.node, "warn", "Skipped a step that was deleted.");
    return true;
  }
  const startedAt = new Date().toISOString();
  x.state.executed++;
  x.current = { node: node.id, input: null };
  try {
    switch (node.type) {
      case "trigger":
        // The trigger's data is the run's trigger_event; History shows it from there.
        record(x, node.id, { status: "success", started_at: startedAt, finished_at: startedAt, output: null });
        x.state.queue.push(...outgoing(x, node.id, null));
        break;
      case "action":
        await runAction(x, node, startedAt);
        x.state.queue.push(...outgoing(x, node.id, null));
        break;
      case "condition": {
        const r = evaluateCondition(node.data.groups, runVariables(x.run, x.wf, x.state));
        record(x, node.id, { status: "success", started_at: startedAt, finished_at: new Date().toISOString(), input: { groups: r.groups }, output: { result: r.result } });
        log(x, node.id, "info", `The condition was ${r.result ? "true" : "false"}.`);
        x.state.queue.push(...outgoing(x, node.id, r.result ? "true" : "false"));
        break;
      }
      case "delay": {
        const error = delayError(node.data.amount, node.data.unit);
        if (error) throw new StepError(error);
        const until = Date.now() + delayToMs(node.data.amount, node.data.unit);
        record(x, node.id, { status: "waiting", started_at: startedAt, input: { amount: node.data.amount, unit: node.data.unit }, output: { until: new Date(until).toISOString() } });
        x.state.delayed.push({ node: node.id, until });
        break;
      }
      case "paths": {
        const paths = node.data.paths ?? [];
        record(x, node.id, { status: "success", started_at: startedAt, finished_at: startedAt, output: { paths: paths.map((p) => p.name) } });
        for (const p of paths) x.state.queue.push(...outgoing(x, node.id, p.id));
        break;
      }
      case "merge": {
        if (x.state.joined.includes(node.id)) {
          log(x, node.id, "info", "A path arrived after the join had continued; that path stops here.");
          break;
        }
        const arrived = (x.state.arrived[node.id] ??= []);
        if (token.via && !arrived.includes(token.via)) arrived.push(token.via);
        if (incoming(x, node.id).every((e) => arrived.includes(e.id))) release(x, node.id, false);
        else if (!x.state.steps[node.id]) record(x, node.id, { status: "waiting", started_at: startedAt });
        break;
      }
    }
    return true;
  } catch (err) {
    const message = err instanceof StepError || err instanceof HttpError ? err.message : (err as Error)?.message || "The step failed.";
    if (!(err instanceof StepError) && !(err instanceof HttpError)) console.error(`[automations] run ${x.run.id} step ${node.id}`, err);
    record(x, node.id, {
      status: "error",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      input: x.current?.input ?? null,
      output: err instanceof StepError ? err.output : null,
      error: message,
    });
    // A retry starts again at this step.
    x.state.queue.unshift(token);
    log(x, node.id, "error", message);
    await finish(x, { status: "error", error: message, currentNodeId: node.id });
    return false;
  }
}

async function runAction(x: Exec, node: AutomationNode, startedAt: string) {
  const def = actionDef(node.data.key);
  const runner = def ? ACTION_RUNNERS[def.key] : undefined;
  if (!def || !runner) throw new StepError("This step has no action yet. Choose one in the editor.");
  const vars = runVariables(x.run, x.wf, x.state);
  const values = resolveFields(def, node.data.config ?? {}, vars);
  x.current = { node: node.id, input: values };
  const now = new Date();
  await db.update(R).set({ currentNodeId: node.id, lockedAt: now, updatedAt: now }).where(eq(R.id, x.run.id));
  const missing = emptyRequired(def, values);
  if (missing.length) throw new StepError(`${missing.join(", ")} came out empty. Check the data ${missing.length > 1 ? "these fields use" : "this field uses"}.`);
  const output = await automationScope.run(x.scope, () =>
    runner({ workspaceId: x.wf.workspaceId, workflow: x.wf, run: x.run, vars, values, log: (message, level = "info") => log(x, node.id, level, message) }),
  );
  await Promise.allSettled(x.scope.pending.splice(0));
  record(x, node.id, { status: "success", started_at: startedAt, finished_at: new Date().toISOString(), input: values, output: clampOutput(output) });
}

// ---------------------------------------------------------------------------------------------------------------
// Testing one step in the editor

export interface StepTestResult {
  status: "success" | "error";
  input: unknown;
  output: unknown;
  error: string | null;
  logs: Array<{ level: string; message: string }>;
}

/** Runs one action (for real) or evaluates one condition with test data. */
export async function testStep(wf: WorkflowRow, graph: AutomationGraph, nodeId: string): Promise<StepTestResult> {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw badRequest("That step isn't in the automation. Save and try again.");
  const vars = testVariables(graph, wf);
  const logs: StepTestResult["logs"] = [];
  if (node.type === "condition") {
    const r = evaluateCondition(node.data.groups, vars);
    return { status: "success", input: { groups: r.groups }, output: { result: r.result }, error: null, logs };
  }
  const def = node.type === "action" ? actionDef(node.data.key) : null;
  const runner = def ? ACTION_RUNNERS[def.key] : undefined;
  if (!def || !runner) return { status: "error", input: null, output: null, error: "Choose an action first.", logs };
  const values = resolveFields(def, node.data.config ?? {}, vars);
  const missing = emptyRequired(def, values);
  if (missing.length) return { status: "error", input: values, output: null, error: `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} empty.`, logs };
  const scope: AutomationScope = { runId: "test", workflowId: wf.id, depth: 1, notes: [], pending: [] };
  try {
    const output = await automationScope.run(scope, () => runner({ workspaceId: wf.workspaceId, workflow: wf, run: null, vars, values, log: (message, level = "info") => logs.push({ level, message }) }));
    await Promise.allSettled(scope.pending.splice(0));
    for (const note of scope.notes) logs.push({ level: "warn", message: note });
    return { status: "success", input: values, output: clampOutput(output), error: null, logs };
  } catch (err) {
    if (!(err instanceof StepError) && !(err instanceof HttpError)) console.error(`[automations] test step ${node.id}`, err);
    return { status: "error", input: values, output: err instanceof StepError ? err.output : null, error: (err as Error)?.message || "The step failed.", logs };
  }
}

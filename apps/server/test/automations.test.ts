// Automations: a run that waits on a Delay sees the lead as it is when it goes on, an import starts at most 1,000
// runs of a "Lead added" automation however many parts it's added in, the engine's campaign changes start runs, a
// retry happens once, workspaces take turns, joins wait for the joins inside them, and schedules (Ask AI's too) read
// days by name on the workspace's clock. Everything runs in the process; the AI is a local fake.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CampaignStatus, LeadStatus, type AutomationGraph } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { buildAutomation } from "../src/services/automations/ai-build";
import { runAutomations } from "../src/services/automations/engine";
import { createRun, createRuns, retryRun, runState } from "../src/services/automations/runs";
import { nextScheduledRun } from "../src/services/automations/schedule";
import { MAX_RUNS_PER_EVENT } from "../src/services/automations/triggers";
import { addLeads } from "../src/services/leads";

// ---------- A local stand-in for the AI: it answers with `answer` and keeps what it was asked ----------

let answer: Record<string, unknown> = {};
let asked = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:9/")) throw new Error(`Tests must not use the network (fetch ${url})`);
  asked = typeof init?.body === "string" ? init.body : "";
  const message = { id: "msg_test", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: JSON.stringify(answer) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
}) as typeof fetch;

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};

const R = schema.workflowRuns;
const W = schema.workflows;
const L = schema.leads;

let app: FastifyInstance;
let user: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Ari", workspaceName: "Automations Co" });
});
after(stopServer);

const node = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (source: string, target: string, handle: string | null = null) => ({ id: `${source}-${target}`, source, target, sourceHandle: handle });

async function automation(name: string, trigger: string, graph: { nodes: unknown[]; edges: unknown[] }, workspaceId = user.workspaceId!) {
  const [wf] = await db
    .insert(W)
    .values({ workspaceId, name, status: "active", triggerType: trigger, graph: graph as AutomationGraph })
    .returning();
  return wf!;
}

/** Runs the engine until the run stops moving (waiting, done or failed). */
async function settle(runId: string) {
  for (let i = 0; i < 200; i++) {
    await runAutomations();
    await new Promise((r) => setTimeout(r, 20));
    const [run] = await db.select().from(R).where(eq(R.id, runId));
    if (run && run.status !== "queued" && run.status !== "running") return run;
  }
  throw new Error("The run didn't settle");
}

/** Bus listeners start runs after the event: waits until `count` holds still at `expected`. */
async function eventually(count: () => Promise<number>, expected: number) {
  let n = -1;
  for (let i = 0; i < 200 && n !== expected; i++) {
    await new Promise((r) => setTimeout(r, 25));
    n = await count();
  }
  await new Promise((r) => setTimeout(r, 100));
  return count();
}

describe("a run that waited on a delay", () => {
  it("checks the lead as it is when it goes on, and History keeps the event as it came", async () => {
    const campaign = json(await user.client.post("/api/app/campaigns", { name: "Still quiet?" }));
    const lead = json(await user.client.post("/api/v2/leads", { email: "wren@waiting.example.test", first_name: "Wren", campaign: campaign.id }));
    const wf = await automation("No reply in three days", "manual", {
      nodes: [
        node("start", "trigger", { key: "manual", config: {} }),
        node("wait", "delay", { amount: 3, unit: "days" }),
        node("check", "condition", { groups: [{ rules: [{ field: "trigger.lead.status", operator: "equals", value: "Active" }] }] }),
      ],
      edges: [edge("start", "wait"), edge("wait", "check")],
    });
    const run = await createRun(wf, { event: "manual", occurred_at: new Date().toISOString(), lead: { id: lead.id, email: lead.email, status: "Active" } });
    const waiting = await settle(run.id);
    assert.equal(waiting.status, "waiting");

    // The lead replies while the run waits, and the wait ends.
    await db.update(L).set({ status: LeadStatus.COMPLETED }).where(eq(L.id, lead.id));
    const state = runState(waiting);
    state.delayed = state.delayed.map((d) => ({ ...d, until: Date.now() - 1_000 }));
    await db
      .update(R)
      .set({ context: state as unknown as Record<string, unknown>, resumeAt: new Date(Date.now() - 1_000) })
      .where(eq(R.id, run.id));

    const done = await settle(run.id);
    assert.equal(done.status, "success");
    assert.deepEqual(runState(done).steps.check?.output, { result: false }, "the lead isn't active any more");
    assert.equal((done.triggerEvent as { lead: { status: string } }).lead.status, "Active", "History shows the event as it came");
  });
});

describe("an import", () => {
  it("starts at most 1,000 runs of a Lead added automation, however many parts it's added in", async () => {
    const list = json(await user.client.post("/api/v2/lead-lists", { name: "Big import" }));
    const wf = await automation("Welcome everyone", "lead_added", { nodes: [node("start", "trigger", { key: "lead_added", config: {} })], edges: [] });
    const runs = async () => (await db.select({ id: R.id }).from(R).where(eq(R.workflowId, wf.id))).length;
    const part = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ email: `person-${from + i}@big-import.example.test` }));
    try {
      for (let i = 0; i < 3; i++) await addLeads({ workspaceId: user.workspaceId!, listId: list.id, leads: part(500, i * 500), batchId: "import-one" });
      assert.equal(await eventually(runs, MAX_RUNS_PER_EVENT), MAX_RUNS_PER_EVENT);
      // Another import has its own allowance; leads added one at a time aren't an import.
      await addLeads({ workspaceId: user.workspaceId!, listId: list.id, leads: part(10, 5_000), batchId: "import-two" });
      await addLeads({ workspaceId: user.workspaceId!, listId: list.id, leads: part(2, 6_000) });
      assert.equal(await eventually(runs, MAX_RUNS_PER_EVENT + 12), MAX_RUNS_PER_EVENT + 12);
    } finally {
      await db.update(W).set({ status: "draft" }).where(eq(W.id, wf.id));
      await db.delete(R).where(eq(R.workflowId, wf.id));
    }
  });
});

describe("a campaign the engine finishes", () => {
  it("starts the automations waiting for a campaign's status to change, with what it was before", async () => {
    const wf = await automation("When a campaign changes", "campaign_status_changed", { nodes: [node("start", "trigger", { key: "campaign_status_changed", config: {} })], edges: [] });
    try {
      const mailbox = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
      await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, mailbox));
      const campaign = json(await user.client.post("/api/app/campaigns", { name: "Short and done" }));
      const steps = [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Hi", body: "<p>Hello</p>" }] }];
      json(await user.client.patch(`/api/v2/campaigns/${campaign.id}`, { email_list: [mailbox], campaign_schedule: ALWAYS_OPEN, email_gap: 0, random_wait_max: 0, sequences: [{ steps }] }));
      json(await user.client.post("/api/v2/leads", { email: "done@finished.example.test", campaign: campaign.id }));
      expectStatus(await user.client.post(`/api/v2/campaigns/${campaign.id}/activate`), 200);
      const status = async () => (await db.select({ s: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, campaign.id)))[0]!.s;
      for (let i = 0; i < 5 && (await status()) !== CampaignStatus.COMPLETED; i++) await runSender();
      assert.equal(await status(), CampaignStatus.COMPLETED);

      type Changed = { status?: { code?: unknown; previous_code?: unknown } };
      const finished = async () => (await db.select().from(R).where(eq(R.workflowId, wf.id))).filter((r) => (r.triggerEvent as Changed).status?.code === CampaignStatus.COMPLETED);
      assert.equal(await eventually(async () => (await finished()).length, 1), 1);
      assert.equal(((await finished())[0]!.triggerEvent as Changed).status?.previous_code, CampaignStatus.ACTIVE);
    } finally {
      await db.update(W).set({ status: "draft" }).where(eq(W.id, wf.id));
      await db.delete(R).where(eq(R.workflowId, wf.id));
    }
  });
});

describe("a failed run", () => {
  it("is retried once, however many times Retry is clicked at once", async () => {
    const wf = await automation("Needs a lead", "manual", {
      nodes: [node("start", "trigger", { key: "manual", config: {} }), node("note", "action", { key: "add_note", config: { lead: "", note: "Hello" } })],
      edges: [edge("start", "note")],
    });
    const run = await createRun(wf, { event: "manual", occurred_at: new Date().toISOString() });
    const failed = await settle(run.id);
    assert.equal(failed.status, "error");
    const tries = await Promise.allSettled([retryRun(failed), retryRun(failed), retryRun(failed)]);
    assert.equal(tries.filter((x) => x.status === "fulfilled").length, 1);
    for (const x of tries) if (x.status === "rejected") assert.equal((x.reason as { statusCode?: number }).statusCode, 409);
    const retries = await db.select().from(R).where(eq(R.retryOf, run.id));
    assert.deepEqual(retries.map((r) => r.attempt), [1]);
    await db.update(W).set({ status: "draft" }).where(eq(W.id, wf.id));
    await db.delete(R).where(eq(R.workflowId, wf.id)); // the queued retry would take a place in the next test's round

  });
});

describe("runs waiting to start", () => {
  it("take turns by workspace, so a long queue in one doesn't hold up another", async () => {
    const other = await signUp(app, { firstName: "Bo", workspaceName: "Quiet Co" });
    const trigger = { nodes: [node("start", "trigger", { key: "manual", config: {} })], edges: [] };
    const busy = await automation("Busy", "manual", trigger);
    const quiet = await automation("Quiet", "manual", trigger, other.workspaceId!);
    const event = { event: "manual", occurred_at: new Date().toISOString() };
    const queue = await createRuns(busy, Array.from({ length: 6 }, () => event));
    const [theirs] = await createRuns(quiet, [event]);
    await runAutomations();
    await new Promise((r) => setTimeout(r, 300));
    const [q] = await db.select().from(R).where(eq(R.id, theirs!.id));
    assert.equal(q!.status, "success", "the quiet workspace's run went in the first round");
    const left = (await db.select().from(R).where(eq(R.workflowId, busy.id))).filter((r) => r.status === "queued");
    assert.equal(left.length, 3, "four places: three of the busy workspace's runs and the quiet one");
    // Made in the same moment, they go in id order.
    const newest = queue.map((r) => r.id).sort().slice(3);
    assert.deepEqual(new Set(left.map((r) => r.id)), new Set(newest), "oldest first within a workspace");
    for (const r of left) await settle(r.id);
    await db.update(W).set({ status: "draft" }).where(inArray(W.id, [busy.id, quiet.id]));
  });
});

describe("joins", () => {
  it("one inside another goes on first, so the outer one hears from it before going on", async () => {
    const yes = { groups: [{ rules: [{ field: "trigger.event", operator: "equals", value: "manual" }] }] };
    const no = { groups: [{ rules: [{ field: "trigger.event", operator: "equals", value: "never" }] }] };
    const wf = await automation("Nested joins", "manual", {
      nodes: [
        node("start", "trigger", { key: "manual", config: {} }),
        node("outer", "paths", { paths: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }),
        node("inner", "paths", { paths: [{ id: "a1", name: "A1" }, { id: "a2", name: "A2" }] }),
        node("pass", "condition", yes),
        node("stop", "condition", no),
        node("innerJoin", "merge", {}),
        node("outerJoin", "merge", {}),
        node("after", "condition", yes),
      ],
      edges: [
        edge("start", "outer"),
        edge("outer", "inner", "a"),
        edge("outer", "outerJoin", "b"),
        edge("inner", "pass", "a1"),
        edge("inner", "stop", "a2"),
        edge("pass", "innerJoin", "true"),
        edge("stop", "innerJoin", "true"),
        edge("innerJoin", "outerJoin"),
        edge("outerJoin", "after"),
      ],
    });
    const run = await createRun(wf, { event: "manual", occurred_at: new Date().toISOString() });
    const done = await settle(run.id);
    assert.equal(done.status, "success");
    const steps = runState(done).steps;
    assert.deepEqual(steps.innerJoin?.output, { arrived: 1, expected: 2 }, "the inner join went on without the path that stopped");
    assert.deepEqual(steps.outerJoin?.output, { arrived: 2, expected: 2 }, "the outer join waited for it");
    assert.ok(!(done.logs ?? []).some((l) => /arrived after the join/.test(l.message)));
    await db.update(W).set({ status: "draft" }).where(eq(W.id, wf.id));
  });
});

describe("schedules", () => {
  it("take a weekday by name or number, and a time that isn't one as nine", () => {
    const wednesday = new Date("2026-10-14T12:00:00Z");
    const next = (config: Record<string, unknown>) => nextScheduledRun({ frequency: "weekly", timezone: "UTC", ...config }, wednesday).toISOString();
    assert.equal(next({ weekday: "monday", time: "09:30" }), "2026-10-19T09:30:00.000Z");
    assert.equal(next({ weekday: "Fri", time: "25:00" }), "2026-10-16T09:00:00.000Z");
    assert.equal(next({ weekday: 7, time: "08:00" }), "2026-10-18T08:00:00.000Z", "7 is Sunday too");
    assert.equal(next({ weekday: "3", time: "13:05" }), "2026-10-14T13:05:00.000Z");
  });

  it("built by Ask AI: days and times as people write them, on the workspace's clock", async () => {
    answer = {
      name: "Weekly check",
      explanation: "Runs every Monday morning.",
      trigger: { key: "schedule", settings: [{ field: "frequency", value: "Every week" }, { field: "weekday", value: "Monday" }, { field: "time", value: "9am" }] },
      steps: [],
    };
    const built = await buildAutomation(user.workspaceId!, "Every Monday morning", { nodes: [], edges: [] }, { campaigns: [], lists: [], labels: [], members: [], slack: [], subsequences: [], sites: [] });
    const trigger = built.graph.nodes.find((n) => n.type === "trigger")!;
    assert.deepEqual(trigger.data.config, { frequency: "weekly", every: 1, weekday: "1", time: "09:00", timezone: "America/New_York" });
    assert.ok(asked.includes("The workspace's timezone is America/New_York"), "the AI is told the workspace's timezone");
  });
});

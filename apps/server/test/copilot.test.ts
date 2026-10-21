// Copilot: a chat that a restart cut short carries on, "Try again" never repeats changes, approval cards name the
// campaign, the tools see whole lists, memory keeps what was switched off, and recurring tasks keep to their day and
// wait while their owner is turned off. The AI is a scripted local fake: nothing leaves the process.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AccountStatus, ProviderCode } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { invokerFor } from "../src/services/copilot/invoke";
import { memoryPrompt } from "../src/services/copilot/memory";
import { contextLine, pairResults } from "../src/services/copilot/runner";
import { DEFAULT_SETTINGS } from "../src/services/copilot/settings";
import { nextRun, runDueTasks } from "../src/services/copilot/tasks";
import { TOOL_BY_NAME, type ToolCtx } from "../src/services/copilot/tools";
import { workspaceToday } from "../src/services/workspace-clock";

// ---------- The AI: each streamed answer is the next scripted one ("Done." when there's none) ----------

type Block = Record<string, unknown>;
const script: Block[][] = [];
const asked: Array<Array<{ role: string; content: Block[] }>> = [];

function sse(blocks: Block[]) {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:9/")) throw new Error(`Tests must not use the network (fetch ${url})`);
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { stream?: boolean; messages?: Array<{ role: string; content: Block[] }> };
  if (body.stream) {
    asked.push(body.messages ?? []);
    return new Response(sse(script.shift() ?? [{ type: "text", text: "Done." }]), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
  }
  const message = { id: "msg_test", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
}) as typeof fetch;

// ---------- Setup ----------

const T = schema.copilotThreads;
const MSG = schema.copilotMessages;
const ACT = schema.copilotActions;
const TK = schema.copilotTasks;

let app: FastifyInstance;
let user: TestUser;
let ws: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Robin", workspaceName: "Copilot Co" });
  ws = user.workspaceId!;
  json(await user.client.put("/api/app/copilot/settings", { follow_up_suggestions: false }));
});
after(stopServer);

const toolCtx = (settings: Partial<typeof DEFAULT_SETTINGS> = {}): ToolCtx => ({
  wsId: ws,
  userId: user.id,
  threadId: "none",
  timezone: "UTC",
  settings: { ...DEFAULT_SETTINGS, ...settings },
  invoke: invokerFor(user.client.cookie!, ws),
});
const run = (tool: string, input: unknown, ctx = toolCtx()) => TOOL_BY_NAME.get(tool)!.run(input as never, ctx);
const campaign = async (name: string) => json(await user.client.post("/api/app/campaigns", { name })).id as string;

/** A chat with these rows (and their actions), as an earlier answer left it. */
async function chat(rows: Array<{ role: "user" | "assistant"; content: Block[]; hidden?: boolean; action?: Partial<typeof ACT.$inferInsert> }>, thread: Partial<typeof T.$inferInsert> = {}) {
  const [t] = await db.insert(T).values({ workspaceId: ws, userId: user.id, title: "Earlier chat", system: "You help.", ...thread }).returning();
  let at = Date.now() - 60 * 60_000;
  for (const r of rows) {
    const [m] = await db
      .insert(MSG)
      .values({ threadId: t!.id, role: r.role, content: r.content, hidden: !!r.hidden, createdAt: new Date(at++), ...(r.role === "user" && !r.hidden ? { display: { text: String(r.content[0]?.text) } } : {}) })
      .returning();
    if (r.action) {
      const call = r.content.find((b) => b.type === "tool_use")!;
      await db.insert(ACT).values({ workspaceId: ws, userId: user.id, threadId: t!.id, messageId: m!.id, toolUseId: String(call.id), tool: String(call.name), input: call.input as Record<string, unknown>, status: "done", ...r.action });
    }
  }
  return t!.id;
}

const draft = { name: "Q4 outreach", steps: [{ delay_days: 0, variants: [{ subject: "Hi", body: "Hello there." }] }] };
const callCreate = (id: string) => ({ type: "tool_use", id, name: "create_campaign", input: draft });
const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: '{"campaign_id":"c1"}' });

describe("a chat cut short by a restart", () => {
  it("carries on: the call that was running failed, and its result comes right after it", async () => {
    const threadId = await chat(
      [
        { role: "user", content: [{ type: "text", text: "Make me a campaign" }] },
        { role: "assistant", content: [callCreate("toolu_restart")], action: { status: "running" } },
      ],
      { status: "running", updatedAt: new Date(Date.now() - 60 * 60_000) },
    );
    asked.length = 0;
    script.push([{ type: "text", text: "It may not have finished: check Campaigns." }]);
    const res = await user.client.post("/api/app/copilot/chat", { thread_id: threadId, text: "Did that work?" });
    expectStatus(res, 200);
    assert.match(res.body, /event: done/);

    const sent = asked[0]!;
    assert.deepEqual(
      sent.map((m) => [m.role, m.content.map((b) => b.type)]),
      [
        ["user", ["text"]],
        ["assistant", ["tool_use"]],
        ["user", ["tool_result", "text", "text"]],
      ],
    );
    assert.match(String(sent[2]!.content[0]!.content), /restarted/);
    const [action] = await db.select().from(ACT).where(eq(ACT.threadId, threadId));
    assert.equal(action!.status, "error");
  });

  it("puts each call's result after it, whatever order the rows were saved in", () => {
    const call = { type: "tool_use", id: "toolu_a", name: "list_campaigns", input: {} };
    const later = { type: "tool_result", tool_use_id: "toolu_a", content: "[]" };
    const turns = pairResults([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [call] },
      { role: "user", content: [{ type: "text", text: "Hello?" }] },
      { role: "user", content: [later] },
    ] as never);
    assert.deepEqual(
      turns.map((t) => [t.role, (t.content as Block[]).map((b) => b.type)]),
      [
        ["user", ["text"]],
        ["assistant", ["tool_use"]],
        ["user", ["tool_result", "text"]],
      ],
    );
    // A call that never got a result says so.
    const [, , missing] = pairResults([{ role: "user", content: [{ type: "text", text: "Hi" }] }, { role: "assistant", content: [call] }] as never);
    assert.deepEqual((missing!.content as Block[])[0], { type: "tool_result", tool_use_id: "toolu_a", is_error: true, content: "Not run: the answer was cut short." });
  });
});

describe("Try again", () => {
  it("isn't done on a finished answer that made changes: it could make them twice", async () => {
    const threadId = await chat([
      { role: "user", content: [{ type: "text", text: "Create the Q4 campaign" }] },
      { role: "assistant", content: [callCreate("toolu_done")], action: { result: { summary: 'Create a draft campaign "Q4 outreach" with 1 email', content: {} } } },
      { role: "user", content: [result("toolu_done")], hidden: true },
      { role: "assistant", content: [{ type: "text", text: "Created it." }] },
    ]);
    const res = await user.client.post(`/api/app/copilot/threads/${threadId}/regenerate`);
    expectStatus(res, 409);
    assert.match(res.json().message, /already made changes \(Create a draft campaign "Q4 outreach" with 1 email\)/);
    assert.equal((await db.select().from(MSG).where(eq(MSG.threadId, threadId))).length, 4, "nothing dropped");
  });

  it("carries on from where an answer that made changes stopped", async () => {
    const threadId = await chat([
      { role: "user", content: [{ type: "text", text: "Create the Q4 campaign" }] },
      { role: "assistant", content: [callCreate("toolu_cut")], action: {} },
      { role: "user", content: [result("toolu_cut")], hidden: true },
    ]);
    asked.length = 0;
    script.push([{ type: "text", text: "Created it." }]);
    expectStatus(await user.client.post(`/api/app/copilot/threads/${threadId}/regenerate`), 200);
    assert.deepEqual(
      asked[0]!.map((m) => m.role),
      ["user", "assistant", "user"],
      "the model saw what it had done",
    );
    assert.equal((await db.select().from(ACT).where(eq(ACT.threadId, threadId))).length, 1);
  });
});

describe("an approval card", () => {
  it("names the campaign it's about", async () => {
    const id = await campaign("Q3 push");
    script.push([{ type: "tool_use", id: "toolu_pause", name: "set_campaign_status", input: { campaign_id: id, action: "pause" } }]);
    const res = await user.client.post("/api/app/copilot/chat", { text: "Pause the Q3 push campaign" });
    expectStatus(res, 200);
    const threadId = /"id":"([^"]+)"/.exec(res.body.slice(res.body.indexOf("event: thread")))![1]!;
    const { actions } = json(await user.client.get(`/api/app/copilot/threads/${threadId}`));
    assert.equal(actions[0].status, "awaiting_approval");
    assert.equal(actions[0].summary, 'Pause the campaign "Q3 push"');
  });
});

describe("Copilot's tools", () => {
  it("count every mailbox in the overview, not the newest 100", async () => {
    await db.insert(schema.emailAccounts).values(Array.from({ length: 105 }, (_, i) => ({ workspaceId: ws, email: `box${i}@overview-count.example.test`, providerCode: ProviderCode.SANDBOX, status: AccountStatus.ACTIVE })));
    const out = (await run("get_workspace_overview", {})) as { content: { email_accounts: { total: number } } };
    assert.equal(out.content.email_accounts.total, 105);
  });

  it("chart only the campaigns asked about", async () => {
    const [a, b, c] = [await campaign("Asked A"), await campaign("Asked B"), await campaign("Not asked")];
    const today = await workspaceToday(ws); // the workspace's date, which isn't the UTC one around midnight
    await db.insert(schema.emailEvents).values([a, b, c].map((campaignId, i) => ({ workspaceId: ws, campaignId, leadEmail: `p${i}@chart.example.test`, type: "sent", step: 0, variant: 0 })));
    const out = (await run("get_campaign_analytics", { campaign_ids: [a, b], start_date: today, end_date: today, include_daily: true })) as { card: { daily?: Array<{ sent: number }> } };
    assert.equal(out.card.daily?.reduce((s, d) => s + d.sent, 0), 2);
  });

  it("keep what was switched off in memory off, and say when a list is full", async () => {
    json(await user.client.put("/api/app/copilot/memory", { memory: { business_offers: ["Audits", "Retainers"], active_business_offers_indexes: [0] } }));
    await run("save_business_details", { add_offers: ["Workshops", "audits"] });
    const { memory } = json(await user.client.get("/api/app/copilot/memory"));
    assert.deepEqual([memory.business_offers, memory.active_business_offers_indexes], [["Audits", "Retainers", "Workshops"], [0, 2]]);
    assert.doesNotMatch(memoryPrompt(memory), /Retainers/);

    json(await user.client.put("/api/app/copilot/memory", { memory: { business_offers: Array.from({ length: 20 }, (_, i) => `Offer ${i}`) } }));
    await assert.rejects(run("save_business_details", { company: "Copilot Co", add_offers: ["One more"] }), /Memory is full \(20 of 20 offers\)/);
    assert.equal(json(await user.client.get("/api/app/copilot/memory")).memory.company, undefined, "nothing was saved");
  });

  it("cap the leads added at once only in WARP mode, which adds without asking", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const ctx = toolCtx({ execute_tools: false, warp_mode: true, enrich_leads_limit: 10 });
    ctx.invoke = (async (_method: string, _url: string, body?: unknown) => {
      bodies.push(body as Record<string, unknown>);
      return { resource_id: "list-1", list_name: "Founders" };
    }) as ToolCtx["invoke"];
    await run("add_leads_from_search", { filters: { job_titles: ["Founder"] }, limit: 50, list_name: "Founders" }, ctx);
    assert.equal(bodies[0]!.limit, 50, "each call needs approval while steps don't run by themselves");
  });
});

describe("the date Copilot goes by", () => {
  it("names the workspace's day when it isn't the user's", () => {
    const at = new Date("2026-10-16T20:00:00Z"); // 4 pm in New York, 1:30 am the next day in Kolkata
    assert.match(contextLine("America/New_York", "Asia/Kolkata", at), /Today is 2026-10-16 for the user and 2026-10-17 on the workspace's calendar \(Asia\/Kolkata\)/);
    assert.match(contextLine("UTC", "UTC", at), /Today is 2026-10-16\.<\/context>/);
  });
});

describe("a recurring task", () => {
  it("run monthly keeps its day: the 31st after a shorter month", () => {
    const after = nextRun(new Date("2027-02-28T09:00:00Z"), "monthly", "09:00", "UTC", 31);
    assert.equal(after.toISOString(), "2027-03-31T09:00:00.000Z");
  });

  it("waits while its owner is turned off", async () => {
    const member = await signUp(app, { firstName: "Max", workspaceName: "Max's own" });
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: member.id, email: member.email, role: "admin", accepted: true });
    const [task] = await db.insert(TK).values({ workspaceId: ws, userId: member.id, title: "Weekly numbers", prompt: "How did we do?", frequency: "weekly", nextRunAt: new Date(Date.now() - 60_000) }).returning();
    await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, member.id));
    await runDueTasks();
    const [row] = await db.select().from(TK).where(eq(TK.id, task!.id));
    assert.equal(row!.lastRunAt, null);
    assert.equal(row!.runCount, 0);
  });
});

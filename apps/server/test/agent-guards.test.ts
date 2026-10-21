// The AI agents and Lead Finder keeping to what they may do and pay for: follow-ups written once per email, credits
// back when the AI writes nothing, replies only to people the workspace may email, one pass of an agent at a time,
// autopilot replies held when autopilot goes off, a Copilot approval that counts once, reveals refunded when no lead
// goes in, Lead Finder pages that don't skip anyone, imports that leave out people a campaign would refuse and keep to
// the member's permissions, stopped jobs that settle up, checks that keep a pause or an edit made meanwhile, bounded
// search filters, and bulk deletes that need and do what deleting one does. Mailboxes are sandboxes, people are made up
// (.test) and the AI is a local fake: nothing leaves the process.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CREDIT_COSTS, EmailType, LeadStatus } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";
import { client, db, schema } from "../src/db/client";
import { config } from "../src/env";
import { runPendingJobs } from "../src/engine/jobs";
import { AgentStatus, AgentType } from "../src/services/agents/common";
import { runInboxManager, sendReply } from "../src/services/agents/inbox-manager";
import { checkLeadFinderAgent } from "../src/services/agents/lead-finder-agent";
import { defaultConfig, type SalesConfig } from "../src/services/agents/sales-agent";
import { creditBalance } from "../src/services/billing-limits";
import { createJob } from "../src/services/jobs";
import { importDatasetRows } from "../src/services/lead-finder/dataset";
import { scheduleRun, upsertEnrichment } from "../src/services/lead-finder/enrichment";
import { unlockPeople } from "../src/services/lead-finder/imports";
import type { PersonResult } from "../src/services/lead-finder/search";

// ---------- A local stand-in for the AI ----------

/** What a reply draft decides; the AI turning every request down while `aiDown`; `beforeAnswer` runs once, on the next call. */
let decision: "reply" | "no_reply" = "reply";
let aiDown = false;
let beforeAnswer: (() => Promise<void>) | null = null;
/** Requests to write a reply, follow-up or win-back. */
let drafts = 0;

function sse(text: string) {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:9/")) throw new Error(`Tests must not use the network (fetch ${url})`);
  const req = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean; output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } } };
  const hook = beforeAnswer;
  beforeAnswer = null;
  if (hook) await hook();
  if (req.stream) return new Response(sse("Done."), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
  const props = Object.keys(req.output_config?.format?.schema?.properties ?? {});
  if (props.includes("decision")) drafts++;
  if (aiDown) {
    const error = { type: "error", error: { type: "invalid_request_error", message: "The test AI is down" } };
    return new Response(JSON.stringify(error), { status: 400, headers: { "content-type": "application/json", "request-id": "req_test" } });
  }
  const out = props.includes("decision")
    ? { decision, reply_text: "Hi Pat,\n\nJust checking in on my last note.\n\nSam", confidence: 90, needs_human: false, human_reason: "", information_requested: "", used_booking_link: false }
    : props.includes("label")
      ? { label: "Interested", confidence: 0.9, reason: "Test reading" }
      : {};
  const message = { id: "msg_test", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
}) as typeof fetch;

// ---------- Setup ----------

const R = schema.aiAgentReplies;
const E = schema.emails;
const AE = schema.aiAgentEvents;
const ACT = schema.aiSalesAgentActivities;
const J = schema.backgroundJobs;
const HEADERS = ["first_name", "last_name", "title", "email", "company", "domain"];

let app: FastifyInstance;
let user: TestUser; // unlimited (self-hosted)
let paying: TestUser; // pays per use
let ws: string;
let sender: string;
let senderId: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Guards Co" });
  ws = user.workspaceId!;
  paying = await signUp(app, { firstName: "Pat", workspaceName: "Paying Guards Co" });
  await db.update(schema.workspaces).set({ selfHosted: false, trialEndsAt: new Date(Date.now() + 7 * 86_400_000) }).where(eq(schema.workspaces.id, paying.workspaceId!));
  await db.insert(schema.creditLedger).values({ workspaceId: paying.workspaceId!, pool: "credits", delta: 100, reason: "test_grant" });
  sender = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
  senderId = (await db.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(eq(schema.emailAccounts.email, sender)))[0]!.id;
  json(await user.client.put("/api/app/copilot/settings", { follow_up_suggestions: false }));
});
after(stopServer);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const tag = () => Math.random().toString(36).slice(2, 8);

/** An AI Inbox Manager in review mode, switched on `sinceMs` ago. */
async function inboxAgent(owner: TestUser, payload: Record<string, unknown> = {}, sinceMs = 0) {
  const [row] = await db
    .insert(schema.aiAgents)
    .values({ workspaceId: owner.workspaceId!, name: `Inbox ${tag()}`, type: AgentType.INBOX_MANAGER, status: AgentStatus.ACTIVE, payload: { configuration_type: 1, active_since: new Date(Date.now() - sinceMs).toISOString(), ...payload } })
    .returning();
  return row!;
}
const agentRow = async (id: string) => (await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, id)))[0]!;

async function lead(owner: TestUser, email: string, extra: Partial<typeof schema.leads.$inferInsert> = {}) {
  const [row] = await db.insert(schema.leads).values({ workspaceId: owner.workspaceId!, email, firstName: "Pat", ...extra }).returning();
  return row!;
}

/** A message from `from` about the lead, filed a minute ago (in a thread of its own). */
async function received(owner: TestUser, l: typeof schema.leads.$inferSelect, from = l.email!) {
  const threadId = `thread-${tag()}`;
  const [row] = await db
    .insert(E)
    .values({
      workspaceId: owner.workspaceId!,
      messageId: `<in-${threadId}@guards.test>`,
      threadId,
      subject: "Re: Hi Pat",
      fromAddress: from,
      toList: sender,
      leadEmail: l.email,
      leadId: l.id,
      accountId: owner === user ? senderId : null,
      eaccount: sender,
      ueType: EmailType.RECEIVED,
      bodyText: "Sounds interesting, tell me more.",
      timestampEmail: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 60_000),
    })
    .returning();
  return row!;
}

/** A conversation the agent answered three days ago (its reply went to `to`) and the lead has been quiet since. */
async function answeredThread(owner: TestUser, agentId: string, l: typeof schema.leads.$inferSelect, to = l.email!) {
  const threadId = `thread-${tag()}`;
  const wsId = owner.workspaceId!;
  const base = { workspaceId: wsId, threadId, subject: "Re: Hi Pat", leadEmail: l.email, leadId: l.id, eaccount: sender };
  const [incoming] = await db
    .insert(E)
    .values({ ...base, messageId: `<in-${threadId}@guards.test>`, fromAddress: l.email, toList: sender, ueType: EmailType.RECEIVED, bodyText: "Tell me more.", timestampEmail: daysAgo(4), createdAt: daysAgo(4) })
    .returning();
  const [sent] = await db
    .insert(E)
    .values({ ...base, messageId: `<out-${threadId}@guards.test>`, fromAddress: sender, toList: to, ueType: EmailType.SENT, bodyText: "Happy to. What would you like to know?", timestampEmail: daysAgo(3), createdAt: daysAgo(3) })
    .returning();
  await db.insert(R).values({ workspaceId: wsId, agentId, threadId, inReplyToEmailId: incoming!.id, leadEmail: l.email, leadId: l.id, html: "<p>Happy to.</p>", sendingStatus: 1, sentEmailId: sent!.id, jobType: 1, createdAt: daysAgo(3), updatedAt: daysAgo(3) });
  return { incoming: incoming!, sent: sent! };
}

const skips = async (agentId: string) => (await db.select().from(AE).where(and(eq(AE.agentId, agentId), eq(AE.eventType, "reply_skipped")))).map((e) => [e.payload.email_id, e.payload.reason]);

/** An AI Sales Agent that has learned the business, with a master list, not due to plan. */
async function salesAgent(owner: TestUser, autonomy: Partial<SalesConfig["autonomy_settings"]> = {}) {
  const list = json(await owner.client.post("/api/v2/lead-lists", { name: `Master ${tag()}` }));
  const base = defaultConfig();
  const cfg: SalesConfig = { ...base, memory: { ...base.memory, company: "Guards Co", business_description: "We help teams answer email." }, autonomy_settings: { ...base.autonomy_settings, ...autonomy } };
  const [row] = await db
    .insert(schema.aiSalesAgents)
    .values({
      workspaceId: owner.workspaceId!,
      name: `Sales ${tag()}`,
      type: "website",
      input: "https://guards.test",
      status: 1,
      config: cfg as unknown as Record<string, unknown>,
      masterLeadListId: list.id,
      initialScrapeReady: true,
      selfImprovement: false,
      nextDecisionAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  return row!;
}

/** Someone invited into `by`'s workspace with these permissions, signed up through the link. */
async function join(by: TestUser, role: string, permissions: string[]): Promise<TestUser> {
  const email = uniqueEmail(role);
  const invite = json(await by.client.post("/api/v2/workspace-members", { email, role, permissions }));
  return signUp(app, { email, inviteToken: new URL(invite.invite_url).searchParams.get("token")! });
}

/** Runs jobs until none of the workspace's is waiting or running. */
async function settle(wsId: string) {
  for (let i = 0; i < 200; i++) {
    await runPendingJobs();
    const open = await db.select({ id: J.id }).from(J).where(and(eq(J.workspaceId, wsId), sql`${J.status} in ('pending', 'in-progress')`));
    if (!open.length) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Jobs didn't finish");
}

const cancelJob = async (id: string) => json(await user.client.post(`/api/app/background-jobs/${id}/cancel`));

// ---------- The AI Inbox Manager ----------

describe("one pass of an agent at a time", () => {
  it("Run now during a pass joins it, and a pass another server is running is left to it", async () => {
    const agent = await inboxAgent(user, {}, 3_600_000);
    const l = await lead(user, "pat.once@guards-pass.test");
    await received(user, l);
    const row = await agentRow(agent.id);
    const [first, second] = await Promise.all([runInboxManager(row), runInboxManager(row)]);
    assert.equal(first, 1);
    assert.equal(second, 1, "the second call was the same pass");
    assert.equal((await db.select().from(R).where(eq(R.agentId, agent.id))).length, 1, "one draft");
    assert.equal((await agentRow(agent.id)).runningUntil, null, "the pass let go of the agent");

    // Another server is running a pass for it: this one leaves it alone, and Run now says so.
    await db.update(schema.aiAgents).set({ runningUntil: new Date(Date.now() + 60_000) }).where(eq(schema.aiAgents.id, agent.id));
    assert.equal(await runInboxManager(await agentRow(agent.id)), null);
    const res = await user.client.post(`/api/app/ai-agents/inbox-manager/${agent.id}/run`);
    expectStatus(res, 409);
    assert.match(res.json().message, /checking for replies right now/);
    // A pass that server never finished frees the agent once its time is up.
    await db.update(schema.aiAgents).set({ runningUntil: new Date(Date.now() - 1_000) }).where(eq(schema.aiAgents.id, agent.id));
    assert.equal(await runInboxManager(await agentRow(agent.id)), 0);
  });
});

describe("follow-ups", () => {
  it("are written once per email: not again every pass after the AI said none was needed, or after a draft was discarded", async () => {
    const agent = await inboxAgent(user, { handle_followup: true });
    const quiet = await lead(user, "pat.quiet@guards-followup.test");
    const { sent } = await answeredThread(user, agent.id, quiet);
    decision = "no_reply";
    const asked = drafts;
    try {
      await runInboxManager(await agentRow(agent.id));
      await runInboxManager(await agentRow(agent.id));
    } finally {
      decision = "reply";
    }
    assert.equal(drafts - asked, 1, "asked once whether to follow up");
    assert.deepEqual(await skips(agent.id), [[sent.id, "agent_chose_not_to_reply"]]);

    // One whose draft was discarded isn't written again either.
    const other = await lead(user, "pat.discarded@guards-followup.test");
    const second = await answeredThread(user, agent.id, other);
    await db.insert(R).values({
      workspaceId: ws,
      agentId: agent.id,
      threadId: second.sent.threadId,
      inReplyToEmailId: second.sent.id,
      leadEmail: other.email,
      leadId: other.id,
      html: "<p>Checking in.</p>",
      sendingStatus: -1,
      jobType: 2,
      followupNumber: 1,
      usageMetadata: { discarded: "answered_by_person" },
    });
    const later = drafts;
    await runInboxManager(await agentRow(agent.id));
    assert.equal(drafts, later, "nothing new written");
    assert.equal((await db.select().from(R).where(eq(R.threadId, second.sent.threadId!))).length, 2);
  });

  it("go only to addresses the workspace may email: everyone the email goes to, not only the lead", async () => {
    const agent = await inboxAgent(user, { handle_followup: true });
    const l = await lead(user, "pat.cc@guards-cc.test");
    // The agent's reply also went to a colleague whose company is on the blocklist.
    const { sent } = await answeredThread(user, agent.id, l, `${l.email},boss@blocked-colleague.test`);
    await db.insert(schema.blockList).values({ workspaceId: ws, value: "blocked-colleague.test", isDomain: true });
    const asked = drafts;
    await runInboxManager(await agentRow(agent.id));
    assert.equal(drafts, asked, "no follow-up written");
    assert.deepEqual(await skips(agent.id), [[sent.id, "recipient_blocked"]]);
  });

  it("give the credit back when the AI writes nothing", async () => {
    const agent = await inboxAgent(paying, { handle_followup: true });
    const l = await lead(paying, "pat.refund@guards-credit.test");
    await answeredThread(paying, agent.id, l);
    const start = await creditBalance(paying.workspaceId!);
    aiDown = true;
    try {
      await runInboxManager(await agentRow(agent.id));
    } finally {
      aiDown = false;
    }
    assert.equal(await creditBalance(paying.workspaceId!), start, "the credit taken for the draft came back");
    const [failed] = await db.select().from(AE).where(and(eq(AE.agentId, agent.id), eq(AE.eventType, "run_failed")));
    assert.ok(failed, "the failed check is in the agent's activity");
  });
});

describe("answers to replies", () => {
  it("aren't drafted when the reply would go to an address on the blocklist", async () => {
    const agent = await inboxAgent(user, {}, 3_600_000);
    const l = await lead(user, "pat.lead@guards-reply.test");
    // The answer came from an assistant's address, on a domain that's on the blocklist.
    await db.insert(schema.blockList).values({ workspaceId: ws, value: "blocked-assistant.test", isDomain: true });
    const incoming = await received(user, l, "assistant@blocked-assistant.test");
    await runInboxManager(await agentRow(agent.id));
    assert.equal((await db.select().from(R).where(eq(R.inReplyToEmailId, incoming.id))).length, 0, "no draft for it");
    assert.ok((await skips(agent.id)).some(([id, reason]) => id === incoming.id && reason === "recipient_blocked"));
  });

  it("aren't sent to an address that unsubscribed after the draft was written", async () => {
    const agent = await inboxAgent(user);
    const l = await lead(user, "pat.later@guards-send.test");
    const incoming = await received(user, l);
    const [draft] = await db
      .insert(R)
      .values({ workspaceId: ws, agentId: agent.id, threadId: incoming.threadId, inReplyToEmailId: incoming.id, leadEmail: l.email, leadId: l.id, accountId: senderId, html: "<p>Thanks, Pat!</p>", sendingStatus: 2, scheduledSendAt: new Date(Date.now() - 1_000), jobType: 1 })
      .returning();
    await db.insert(schema.unsubscribes).values({ workspaceId: ws, email: l.email!, source: "link" });
    const out = await sendReply(draft!);
    assert.equal(out.sendingStatus, -1);
    assert.equal(out.errorCode, "RECIPIENT_UNSUBSCRIBED");
    const answers = await db.select().from(E).where(and(eq(E.threadId, incoming.threadId!), eq(E.ueType, EmailType.SENT)));
    assert.equal(answers.length, 0, "nothing went out");
  });
});

// ---------- The AI Sales Agent ----------

describe("the AI Sales Agent", () => {
  it("with autopilot switched off, holds the replies it queued to send by itself; ones a person approved still go", async () => {
    const agent = await salesAgent(user, { autopilot_mode: true });
    const queued = async (approvedBy: string | null) =>
      (
        await db
          .insert(ACT)
          .values({ workspaceId: ws, aiSdrId: agent.id, actionType: "email_sent", actionStatus: "approved", approvedAt: new Date(), approvedBy, actionPayload: { send_at: Date.now() + 3_600_000 } })
          .returning()
      )[0]!;
    const status = async (id: string) => (await db.select().from(ACT).where(eq(ACT.id, id)))[0]!.actionStatus;
    const byAgent = await queued(null);
    const byPerson = await queued(user.id);
    json(await user.client.patch(`/api/v2/ai-agents/sales/${agent.id}`, { config: { autonomy_settings: { autopilot_mode: false } } }));
    assert.equal(await status(byAgent.id), "pending", "waits for approval now");
    assert.equal(await status(byPerson.id), "approved");

    // Switching off answering replies does the same.
    json(await user.client.patch(`/api/v2/ai-agents/sales/${agent.id}`, { config: { autonomy_settings: { autopilot_mode: true } } }));
    const again = await queued(null);
    json(await user.client.patch(`/api/v2/ai-agents/sales/${agent.id}`, { config: { autonomy_settings: { auto_reply_to_responses: false } } }));
    assert.equal(await status(again.id), "pending");
  });

  it("doesn't send a reply to an address that unsubscribed from the workspace", async () => {
    const agent = await salesAgent(user);
    const l = await lead(user, "pat.sales@guards-sales.test");
    const incoming = await received(user, l);
    await db.insert(schema.unsubscribes).values({ workspaceId: ws, email: l.email!, source: "link" });
    const [act] = await db
      .insert(ACT)
      .values({ workspaceId: ws, aiSdrId: agent.id, actionType: "email_sent", actionStatus: "pending", actionPayload: { in_reply_to_email_id: incoming.id, lead_id: l.id, html: "<p>Thanks, Pat!</p>" } })
      .returning();
    const out = json(await user.client.post(`/api/v2/ai-agents/sales/${agent.id}/activities/${act!.id}/approve`, {}));
    assert.equal(out.action_status, "rejected");
    assert.equal(out.action_output.not_sent, "lead_unsubscribed");
    const answers = await db.select().from(E).where(and(eq(E.threadId, incoming.threadId!), eq(E.ueType, EmailType.SENT)));
    assert.equal(answers.length, 0, "nothing went out");
  });

  it("gives back what it paid for an address when the lead couldn't be added", async () => {
    const pw = paying.workspaceId!;
    const agent = await salesAgent(paying);
    const c = json(await paying.client.post("/api/app/campaigns", { name: "Reveal fails" }));
    await db.update(schema.campaigns).set({ aiSdrId: agent.id }).where(eq(schema.campaigns.id, c.id));
    await importDatasetRows([{ first_name: "Rae", last_name: "Test", title: "Head of Sales", email: "rae@reveal-fails.test", company: "Reveal Fails", domain: "reveal-fails.test" }], HEADERS, pw);
    const [person] = await db.select({ id: schema.lfPeople.id }).from(schema.lfPeople).where(eq(schema.lfPeople.email, "rae@reveal-fails.test"));
    const [act] = await db
      .insert(ACT)
      .values({ workspaceId: pw, aiSdrId: agent.id, actionType: "recommend_lead", actionStatus: "pending", actionPayload: { person_id: person!.id, campaign_id: c.id } })
      .returning();
    const start = await creditBalance(pw);
    // Nothing can be added to the workspace's leads for this one.
    await client.execute("CREATE TRIGGER guards_no_new_leads BEFORE INSERT ON leads BEGIN SELECT RAISE(ABORT, 'no new leads in this test'); END");
    let out: Record<string, any>;
    try {
      out = json(await paying.client.post(`/api/v2/ai-agents/sales/${agent.id}/activities/${act!.id}/approve`, {}));
    } finally {
      await client.execute("DROP TRIGGER guards_no_new_leads");
    }
    assert.equal(out.action_status, "failed");
    assert.equal(start - (await creditBalance(pw)), CREDIT_COSTS.lead_finder_unlock, "only the reveal itself stays paid for");
  });
});

// ---------- Copilot ----------

describe("a Copilot approval", () => {
  it("counts once: two clicks at once make the change once, and the chat gets its result once", async () => {
    const name = `Guarded ${tag()}`;
    const input = { name, steps: [{ delay_days: 0, variants: [{ subject: "Hi", body: "Hello there." }] }] };
    const [t] = await db.insert(schema.copilotThreads).values({ workspaceId: ws, userId: user.id, title: "Approve twice", system: "You help.", status: "waiting" }).returning();
    await db.insert(schema.copilotMessages).values({ threadId: t!.id, role: "user", content: [{ type: "text", text: "Make the campaign" }], display: { text: "Make the campaign" }, createdAt: new Date(Date.now() - 60_000) });
    const [m] = await db
      .insert(schema.copilotMessages)
      .values({ threadId: t!.id, role: "assistant", content: [{ type: "tool_use", id: "toolu_twice", name: "create_campaign", input }], createdAt: new Date(Date.now() - 50_000) })
      .returning();
    const [action] = await db
      .insert(schema.copilotActions)
      .values({ workspaceId: ws, userId: user.id, threadId: t!.id, messageId: m!.id, toolUseId: "toolu_twice", tool: "create_campaign", input, status: "awaiting_approval" })
      .returning();
    const approve = () => user.client.post(`/api/app/copilot/threads/${t!.id}/actions/${action!.id}`, { decision: "approve" });
    const answers = await Promise.all([approve(), approve()]);
    const turnedAway = answers.filter((r) => r.statusCode === 409 || /no longer waiting for approval/.test(r.body));
    assert.equal(turnedAway.length, 1, "one of the clicks is turned away");
    const made = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ws), eq(schema.campaigns.name, name)));
    assert.equal(made.length, 1, "the campaign was made once");
    const results = await db
      .select()
      .from(schema.copilotMessages)
      .where(and(eq(schema.copilotMessages.threadId, t!.id), sql`json_extract(${schema.copilotMessages.content}, '$[0].tool_use_id') = 'toolu_twice'`));
    assert.equal(results.length, 1, "its result is in the chat once");
  });
});

// ---------- Lead Finder ----------

describe("Lead Finder", () => {
  it("records 9,000 people revealed at once (an export's worth)", async () => {
    const people = Array.from({ length: 9_000 }, (_, i) => ({ id: `guard-reveal-${i}`, unlocked: false }) as unknown as PersonResult);
    const out = await unlockPeople(ws, user.id, people, "test:reveal");
    assert.equal(out.allowed.length, 9_000);
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.lfUnlocks)
      .where(and(eq(schema.lfUnlocks.workspaceId, ws), sql`${schema.lfUnlocks.personId} like 'guard-reveal-%'`));
    assert.equal(Number(row!.n), 9_000);
  });

  it("turns away a search with more terms than it can run, and runs one it can", async () => {
    const titles = Array.from({ length: 1_200 }, (_, i) => `Title ${i}`);
    const count = (include: string[]) => user.client.post("/api/v2/supersearch-enrichment/count-leads-from-supersearch", { search_filters: { title: { include } } });
    expectStatus(await count(titles), 400);
    json(await count(titles.slice(0, 300)));
  });

  it("imports into a campaign leave out people it would turn away, before paying for them", async () => {
    await importDatasetRows(
      [0, 1, 2].map((i) => ({ first_name: `P${i}`, last_name: "Test", title: "Head of Sales", email: `p${i}@refuse-import.test`, company: "Refuse Import", domain: "refuse-import.test" })),
      HEADERS,
      ws,
    );
    await db.insert(schema.unsubscribes).values({ workspaceId: ws, email: "p0@refuse-import.test", source: "link" });
    await db.insert(schema.leadSuppressions).values({ workspaceId: ws, email: "p1@refuse-import.test", reason: "bounced" });
    const c = json(await user.client.post("/api/app/campaigns", { name: "Refuse import" }));
    json(await user.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: { domains: ["refuse-import.test"] }, limit: 10, resource_id: c.id }));
    await settle(ws);
    const leads = await db.select({ email: schema.leads.email }).from(schema.leads).where(eq(schema.leads.campaignId, c.id));
    assert.deepEqual(
      leads.map((l) => l.email),
      ["p2@refuse-import.test"],
    );
  });

  it("adds people to existing lists and campaigns only for members who may change leads", async () => {
    const finder = await join(user, "editor", ["lead_finder"]);
    const c = json(await user.client.post("/api/app/campaigns", { name: "Not theirs" }));
    const search = { search_filters: { domains: ["refuse-import.test"] }, limit: 10 };
    const into = await finder.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { ...search, resource_id: c.id });
    expectStatus(into, 403);
    assert.match(into.json().message, /needs access to leads/);
    // A new list of their own is fine.
    json(await finder.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { ...search, list_name: "Mine" }));
    // A Lead Finder agent adds leads to a campaign, so setting one up needs that too.
    const agent = await finder.client.post("/api/v2/ai-agents/lead-finder", { name: "Theirs", campaign_id: c.id, search_filters: { title: { include: ["Head of Sales"] } }, min_active_leads: 10, on_exhaustion: "pause" });
    expectStatus(agent, 403);
  });
});

describe("the Lead Finder agent", () => {
  /** An agent for a new campaign of the workspace's, with these settings. */
  async function lfAgent(payload: Record<string, unknown>) {
    const c = json(await user.client.post("/api/app/campaigns", { name: `Agent campaign ${tag()}` }));
    const [row] = await db
      .insert(schema.aiAgents)
      .values({ workspaceId: ws, name: `Finder ${tag()}`, type: AgentType.LEAD_FINDER, status: AgentStatus.ACTIVE, payload: { campaign_id: c.id, campaign_name: c.name, show_one_lead_per_company: false, audience: "primary", ...payload } })
      .returning();
    return { agent: row!, campaignId: c.id as string };
  }

  it("goes through every match when the people it adds drop out of its search", async () => {
    // 600 matches in id order: 10 with an address, 490 without, 40 with, 60 without.
    const has = (i: number) => i <= 10 || (i > 500 && i <= 540);
    const rows = Array.from({ length: 600 }, (_, k) => {
      const i = k + 1;
      const n = String(i).padStart(4, "0");
      return { id: `pg-${n}`, workspaceId: ws, firstName: `P${n}`, lastName: "Test", title: "Paging Tester", email: has(i) ? `p${n}@paging.test` : null };
    });
    for (let i = 0; i < rows.length; i += 100) await db.insert(schema.lfPeople).values(rows.slice(i, i + 100));
    // 50 wanted: the first page has 10, the rest are on the second.
    const { agent, campaignId } = await lfAgent({ search_filters: { title: { include: ["Paging Tester"] }, skip_owned_leads: true }, min_active_leads: 40, on_exhaustion: "pause" });
    await checkLeadFinderAgent(agent.id);
    const added = await db.select({ id: schema.leads.id }).from(schema.leads).where(eq(schema.leads.campaignId, campaignId));
    assert.equal(added.length, 50);
    assert.equal((await agentRow(agent.id)).status, AgentStatus.ACTIVE, "it didn't run out");
  });

  /** An agent with a lead held for its AI column (retried first) and an audience nobody matches. */
  async function heldAgent() {
    const { agent, campaignId } = await lfAgent({
      search_filters: { title: { include: ["Nobody At All"] } },
      fallback_search_filters: { title: { include: ["Nobody Either"] } },
      min_active_leads: 5,
      on_exhaustion: "fallback",
      ai_enrichment: { opener: { prompt: "Write a one-line opener.", order: 1 } },
    });
    await lead(user, `held.${tag()}@guards-held.test`, { campaignId, status: LeadStatus.PAUSED, payload: { lf_agent_id: agent.id, lf_agent_hold: "opener: the AI had no answer" } });
    return agent;
  }

  it("keeps an edit made while it checks", async () => {
    const agent = await heldAgent();
    const edited = { title: { include: ["Someone New"] } };
    // Someone changes the audience while the check fills the held lead's column.
    beforeAnswer = async () => {
      const a = await agentRow(agent.id);
      await db.update(schema.aiAgents).set({ payload: { ...a.payload, search_filters: edited, audience: "primary" } }).where(eq(schema.aiAgents.id, agent.id));
    };
    await checkLeadFinderAgent(agent.id, { retryHeld: true });
    beforeAnswer = null;
    const after = await agentRow(agent.id);
    assert.deepEqual(after.payload.search_filters, edited, "the new audience stands");
    assert.equal(after.status, AgentStatus.ACTIVE, "not paused for running out of the old one");
  });

  it("keeps a pause made while it checks", async () => {
    const agent = await heldAgent();
    beforeAnswer = async () => {
      await db.update(schema.aiAgents).set({ status: AgentStatus.PAUSED }).where(eq(schema.aiAgents.id, agent.id));
    };
    await checkLeadFinderAgent(agent.id, { retryHeld: true });
    beforeAnswer = null;
    const after = await agentRow(agent.id);
    assert.equal(after.status, AgentStatus.PAUSED);
    assert.equal(after.payload.audience, "primary", "it didn't move on to the fallback audience");
    const said = (await db.select().from(AE).where(eq(AE.agentId, agent.id))).map((e) => e.eventType);
    assert.ok(!said.includes("paused_exhausted"), "the activity doesn't say it ran out");
  });
});

// ---------- Jobs stopped before they started ----------

describe("a job stopped before it started", () => {
  it("settles up: enrichment runs, imports, company lists and uploaded files don't stay as they were left", async () => {
    // An enrichment run.
    const list = json(await user.client.post("/api/v2/lead-lists", { name: `Stopped ${tag()}` }));
    await upsertEnrichment({ workspaceId: ws, resourceId: list.id, resourceType: 2, type: "email_verification", userId: user.id });
    const run = (await scheduleRun(ws, user.id, list.id))!;
    await cancelJob(run.id);
    const runs = await db.select().from(schema.enrichmentRuns).where(eq(schema.enrichmentRuns.jobId, run.id));
    assert.deepEqual(
      runs.map((r) => r.status),
      ["cancelled"],
    );
    const [column] = await db.select().from(schema.enrichments).where(and(eq(schema.enrichments.resourceId, list.id), eq(schema.enrichments.type, "email_verification")));
    assert.equal(column!.inProgress, false, "the column isn't shown as running");

    // A Lead Finder import.
    const started = json(await user.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: { domains: ["refuse-import.test"] }, limit: 10, list_name: `Stopped import ${tag()}` }));
    await cancelJob(started.background_job_id);
    const [search] = await db.select().from(schema.enrichments).where(eq(schema.enrichments.id, started.id));
    assert.equal(search!.inProgress, false, "the search isn't shown as running");

    // A company list being built.
    const [companies] = await db.insert(schema.companyLists).values({ workspaceId: ws, name: "Stopped list", providerId: "local_dataset", companySourceId: "companies", requestedCount: 10, filters: {}, createdBy: user.id }).returning();
    const build = await createJob({ workspaceId: ws, userId: user.id, type: "company-list-build", entityId: companies!.id, entityType: "company_list" });
    await cancelJob(build.id);
    const [built] = await db.select().from(schema.companyLists).where(eq(schema.companyLists.id, companies!.id));
    assert.deepEqual([built!.status, built!.terminalReason], ["FAILED", "CANCELLED"]);

    // An uploaded dataset file.
    const file = path.join(config.dataDir, `guards-upload-${tag()}.csv`);
    writeFileSync(file, "first_name,email\nPat,pat@upload.test\n");
    const upload = await createJob({ workspaceId: ws, userId: user.id, type: "lf-dataset-import", entityType: "lead_finder", data: { file, shared: false, rows: 1 } });
    await cancelJob(upload.id);
    assert.equal(existsSync(file), false, "the uploaded file is gone");
  });
});

// ---------- Deleting agents from the list ----------

describe("bulk-deleting agents", () => {
  const bulk = async (who: TestUser, items: Array<{ id: string; type?: string }>) => json(await who.client.post("/api/v2/agent-items/bulk-delete", { items }));

  it("needs what deleting each one on its own page needs, and does the same clean-up", async () => {
    const agent = await inboxAgent(user);
    const l = await lead(user, "pat.bulk@guards-bulk.test");
    const incoming = await received(user, l);
    const [scheduled] = await db
      .insert(R)
      .values({ workspaceId: ws, agentId: agent.id, threadId: incoming.threadId, inReplyToEmailId: incoming.id, leadEmail: l.email, leadId: l.id, html: "<p>Thanks!</p>", sendingStatus: 2, scheduledSendAt: new Date(Date.now() + 60_000), jobType: 1 })
      .returning();
    await db.insert(AE).values({ workspaceId: ws, agentId: agent.id, eventType: "reply_skipped", payload: { email_id: "x", reason: "automatic_email" } });

    // A member who may edit campaigns but not change settings can't delete a reply agent.
    const editor = await join(user, "editor", ["dashboard", "edit_campaigns"]);
    const refused = await bulk(editor, [{ id: agent.id }]);
    assert.deepEqual(refused, { deleted_ids: [], failed: [{ id: agent.id, reason: "forbidden" }] });
    assert.ok(await agentRow(agent.id), "still there");

    const done = await bulk(user, [{ id: agent.id }]);
    assert.deepEqual(done.deleted_ids, [agent.id]);
    const [reply] = await db.select().from(R).where(eq(R.id, scheduled!.id));
    assert.deepEqual([reply!.sendingStatus, reply!.errorCode], [-1, "AGENT_NOT_FOUND"], "its scheduled reply won't go out");
    assert.equal((await db.select().from(AE).where(eq(AE.agentId, agent.id))).length, 0, "its activity went with it");

    // An outbound agent that still has campaigns stays, as on its own page.
    const sales = await salesAgent(user);
    const c = json(await user.client.post("/api/app/campaigns", { name: `Agent's ${tag()}` }));
    await db.update(schema.campaigns).set({ aiSdrId: sales.id }).where(eq(schema.campaigns.id, c.id));
    assert.deepEqual(await bulk(user, [{ id: sales.id }]), { deleted_ids: [], failed: [{ id: sales.id, reason: "has_campaigns" }] });
    assert.equal((await db.select().from(schema.aiSalesAgents).where(eq(schema.aiSalesAgents.id, sales.id))).length, 1);
  });
});

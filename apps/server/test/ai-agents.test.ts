// The AI agents' judgement about what they send, start and spend: the outbound (sales) agent's replies, customer
// profiles, planning rounds, campaigns and credits; the deliverability agent's checks and fixes; the Lead Finder
// agent's AI columns and credits. Mailboxes are sandboxes or never connected, people and companies are made up,
// DNS answers come from a stand-in, and the AI is a local fake: nothing leaves the process.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AccountStatus, CampaignStatus, EmailType, LeadStatus, ProviderCode } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { creditBalance } from "../src/services/billing-limits";
import { emit } from "../src/services/bus";
import { AgentStatus, AgentType, type AgentRow } from "../src/services/agents/common";
import { processDeliverability, startCycle } from "../src/services/agents/deliverability-agent";
import { checkLeadFinderAgent, validateAiEnrichment } from "../src/services/agents/lead-finder-agent";
import { cfgOf, decide, defaultConfig, runSalesAgents, type SalesAgentRow, type SalesConfig } from "../src/services/agents/sales-agent";
import type { Icp } from "../src/services/agents/sales-ai";
import { importDatasetRows } from "../src/services/lead-finder/dataset";

// ---------- A local stand-in for the AI (it answers with nothing useful, or turns every request down while `aiDown`) ----------

let aiDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:9/")) throw new Error(`Tests must not use the network (fetch ${url})`);
  if (aiDown) {
    const error = { type: "error", error: { type: "invalid_request_error", message: "The test AI is down" } };
    return new Response(JSON.stringify(error), { status: 400, headers: { "content-type": "application/json", "request-id": "req_test" } });
  }
  const message = { id: "msg_test", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
}) as typeof fetch;

// ---------- Setup ----------

const S = schema.aiSalesAgents;
const ACT = schema.aiSalesAgentActivities;
const C = schema.campaigns;
const ICP = (name: string, title: string): Icp => ({ name, job_title: { include: [title] } });
const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};

let app: FastifyInstance;
let user: TestUser;
let sender: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Agents Co" });
  sender = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
});
after(stopServer);

/** An outbound agent that has learned the business, with a master list. Not due to plan unless `due`. */
async function newAgent(opts: { status?: number; icps?: Icp[]; config?: Partial<SalesConfig>; due?: boolean; owner?: TestUser } = {}) {
  const owner = opts.owner ?? user;
  const list = json(await owner.client.post("/api/v2/lead-lists", { name: `Agent list ${Math.random()}` }));
  const base = defaultConfig();
  const config: SalesConfig = {
    ...base,
    ...opts.config,
    memory: { ...base.memory, company: "Agents Co", business_description: "We help teams answer email.", icps: opts.icps ?? [ICP("Sales leaders", "VP of Sales")] },
    outreach_settings: { ...base.outreach_settings, email_list: [sender], ...(opts.config?.outreach_settings ?? {}) },
    autonomy_settings: { ...base.autonomy_settings, ...(opts.config?.autonomy_settings ?? {}) },
  };
  const [row] = await db
    .insert(S)
    .values({
      workspaceId: owner.workspaceId!,
      name: `Agent ${Math.random().toString(36).slice(2, 7)}`,
      type: "website",
      input: "https://agents-co.test",
      status: opts.status ?? 1,
      config: config as unknown as Record<string, unknown>,
      masterLeadListId: list.id,
      initialScrapeReady: true,
      selfImprovement: false,
      nextDecisionAt: opts.due ? null : new Date(Date.now() + 3_600_000),
    })
    .returning();
  return row!;
}

/** A campaign of the agent's, linked to a profile (by position, as agents did before profiles had ids, or by id). */
async function agentCampaign(a: SalesAgentRow, name: string, link: string | number | null = 0, status: number = CampaignStatus.ACTIVE, owner = user) {
  const created = json(await owner.client.post("/api/app/campaigns", { name }));
  json(
    await owner.client.patch(`/api/v2/campaigns/${created.id}`, {
      email_list: [sender],
      campaign_schedule: ALWAYS_OPEN,
      sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: "Hi {{firstName}}", body: "<p>Hello there.</p>" }] }] }],
    }),
  );
  await db.update(C).set({ aiSdrId: a.id, status }).where(eq(C.id, created.id));
  if (link !== null) {
    const [fresh] = await db.select().from(S).where(eq(S.id, a.id));
    const cfg = cfgOf(fresh!);
    const state = { ...(cfg._state ?? {}), campaign_icps: { ...(cfg._state?.campaign_icps ?? {}), [created.id]: link } };
    await db.update(S).set({ config: { ...cfg, _state: state } as unknown as Record<string, unknown> }).where(eq(S.id, a.id));
  }
  return created.id as string;
}

const freshAgent = async (id: string) => (await db.select().from(S).where(eq(S.id, id)))[0]!;
const statusOf = async (campaignId: string) => (await db.select({ s: C.status }).from(C).where(eq(C.id, campaignId)))[0]!.s;
const activity = async (id: string) => (await db.select().from(ACT).where(eq(ACT.id, id)))[0]!;

let threads = 0;
/** An email in a thread of the lead's, `minutesAgo` minutes ago. */
async function mail(o: { leadId: string; campaignId: string; thread: string; minutesAgo: number; type: number; auto?: boolean }) {
  const [row] = await db
    .insert(schema.emails)
    .values({
      workspaceId: user.workspaceId!,
      messageId: `<m${++threads}@agents.test>`,
      threadId: o.thread,
      subject: "Re: Hi Pat",
      fromAddress: o.type === EmailType.RECEIVED ? "pat@prospect.test" : sender,
      toList: o.type === EmailType.RECEIVED ? sender : "pat@prospect.test",
      bodyText: "Thanks, tell me more.",
      timestampEmail: new Date(Date.now() - o.minutesAgo * 60_000),
      campaignId: o.campaignId,
      leadEmail: "pat@prospect.test",
      leadId: o.leadId,
      eaccount: sender,
      accountId: (await db.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(eq(schema.emailAccounts.email, sender)))[0]!.id,
      ueType: o.type,
      isAutoReply: o.auto ? 1 : 0,
    })
    .returning();
  return row!;
}

/** A drafted answer to `original`, waiting for review or approved and due now. */
async function draftReply(a: SalesAgentRow, original: { id: string; campaignId: string | null }, leadId: string, status: "pending" | "approved") {
  const [row] = await db
    .insert(ACT)
    .values({
      workspaceId: a.workspaceId,
      aiSdrId: a.id,
      actionType: "email_sent",
      actionStatus: status,
      ...(status === "approved" ? { approvedAt: new Date() } : {}),
      actionPayload: { in_reply_to_email_id: original.id, lead_id: leadId, campaign_id: original.campaignId, html: "<p>Happy to explain.</p>", send_at: Date.now() - 1_000 },
      actionOutput: { lead_email: "pat@prospect.test" },
    })
    .returning();
  return row!;
}

async function newLead(campaignId: string, email = `pat${Math.random().toString(36).slice(2, 7)}@prospect.test`) {
  return json(await user.client.post("/api/v2/leads", { email, first_name: "Pat", campaign: campaignId })).id as string;
}

const sentTo = async (leadId: string) => db.select().from(schema.emails).where(and(eq(schema.emails.leadId, leadId), eq(schema.emails.ueType, EmailType.SENT)));

async function eventually(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------- Replies ----------

describe("the outbound agent's replies", () => {
  it("aren't sent once the lead wrote again, or someone answered by hand", async () => {
    const a = await newAgent();
    const c = await agentCampaign(a, "Replies");
    const pat = await newLead(c);
    const first = await mail({ leadId: pat, campaignId: c, thread: "t-again", minutesAgo: 10, type: EmailType.RECEIVED });
    const queued = await draftReply(a, first, pat, "approved");
    await mail({ leadId: pat, campaignId: c, thread: "t-again", minutesAgo: 5, type: EmailType.RECEIVED });

    const kim = await newLead(c);
    const second = await mail({ leadId: kim, campaignId: c, thread: "t-hand", minutesAgo: 10, type: EmailType.RECEIVED });
    const late = await draftReply(a, second, kim, "approved");
    await mail({ leadId: kim, campaignId: c, thread: "t-hand", minutesAgo: 3, type: EmailType.SENT });

    await runSalesAgents();
    for (const [row, reason, lead] of [
      [queued, "lead_replied_again", pat],
      [late, "answered_by_person", kim],
    ] as const) {
      const done = await activity(row.id);
      assert.equal(done.actionStatus, "rejected", reason);
      assert.equal((done.actionOutput ?? {}).not_sent, reason);
      assert.ok(done.rejectionReason);
      assert.equal((await sentTo(lead)).filter((e) => e.timestampEmail.getTime() > Date.now() - 60_000).length, 0, `nothing sent for ${reason}`);
    }
  });

  it("still go out when the conversation hasn't moved on", async () => {
    const a = await newAgent();
    const c = await agentCampaign(a, "Replies that fit");
    const lee = await newLead(c);
    const msg = await mail({ leadId: lee, campaignId: c, thread: "t-fits", minutesAgo: 10, type: EmailType.RECEIVED });
    // An out-of-office notice isn't the lead writing again.
    await mail({ leadId: lee, campaignId: c, thread: "t-fits", minutesAgo: 5, type: EmailType.RECEIVED, auto: true });
    const queued = await draftReply(a, msg, lee, "approved");
    await runSalesAgents();
    assert.equal((await activity(queued.id)).actionStatus, "completed");
    assert.equal((await sentTo(lee)).length, 1);
  });

  it("waiting for a lead are replaced when the lead writes again", async () => {
    const a = await newAgent({ config: { autonomy_settings: { autopilot_mode: false, auto_reply_to_responses: false, manual_leads_mode: false } } });
    const c = await agentCampaign(a, "Replaced drafts");
    const jo = await newLead(c);
    const first = await mail({ leadId: jo, campaignId: c, thread: "t-replaced", minutesAgo: 10, type: EmailType.RECEIVED });
    const waiting = await draftReply(a, first, jo, "pending");
    const again = await mail({ leadId: jo, campaignId: c, thread: "t-replaced", minutesAgo: 1, type: EmailType.RECEIVED });
    emit("reply_received", user.workspaceId!, { campaign_id: c, lead_id: jo, email_id: again.id, lead_email: "pat@prospect.test", text: "One more thing." });
    await eventually(async () => (await activity(waiting.id)).actionStatus === "rejected", "the waiting draft to be dropped");
    assert.equal((await activity(waiting.id)).actionOutput?.not_sent, "lead_replied_again");
  });
});

// ---------- Turning it off and on ----------

describe("turning the outbound agent off and on", () => {
  it("sends its queued replies back for review, and resumes only the campaigns it paused", async () => {
    const a = await newAgent();
    const running = await agentCampaign(a, "Running");
    const byHand = await agentCampaign(a, "Paused by hand", 0, CampaignStatus.PAUSED);
    const never = await agentCampaign(a, "Never started", 0, CampaignStatus.DRAFT);
    const lead = await newLead(running);
    const msg = await mail({ leadId: lead, campaignId: running, thread: "t-off", minutesAgo: 10, type: EmailType.RECEIVED });
    const queued = await draftReply(a, msg, lead, "approved");

    json(await user.client.patch(`/api/v2/ai-agents/sales/${a.id}`, { status: 0 }));
    assert.equal(await statusOf(running), CampaignStatus.PAUSED);
    assert.equal((await activity(queued.id)).actionStatus, "pending");

    json(await user.client.patch(`/api/v2/ai-agents/sales/${a.id}`, { status: 1 }));
    assert.equal(await statusOf(running), CampaignStatus.ACTIVE);
    assert.equal(await statusOf(byHand), CampaignStatus.PAUSED);
    // Made while it was off: started now that it's on and can send.
    assert.equal(await statusOf(never), CampaignStatus.ACTIVE);
  });
});

// ---------- Customer profiles ----------

describe("the outbound agent's customer profiles", () => {
  it("keep each campaign with its own profile when another is removed; a removed or unticked profile gets no leads", async () => {
    // An agent from before profiles had ids: its campaigns were linked by position.
    const a = await newAgent({ icps: [ICP("Founders", "Founder"), ICP("Buyers", "Head of Purchasing"), ICP("Engineers", "CTO")] });
    const forFounders = await agentCampaign(a, "For founders", 0);
    const forBuyers = await agentCampaign(a, "For buyers", 1);
    const forEngineers = await agentCampaign(a, "For engineers", 2);
    assert.equal(await decide(a.id, { force: true }), true);
    const cfg = cfgOf(await freshAgent(a.id));
    const icps = cfg.memory.icps!;
    assert.ok(icps.every((i) => i.id));
    assert.deepEqual(cfg._state?.campaign_icps, { [forFounders]: icps[0]!.id, [forBuyers]: icps[1]!.id, [forEngineers]: icps[2]!.id });

    // Remove "Founders" on the Memory tab and untick "Engineers" (the page sends the profiles it shows).
    json(await user.client.patch(`/api/v2/ai-agents/sales/${a.id}`, { config: { memory: { icps: [icps[1], icps[2]], active_icps_indexes: [0] } } }));
    await db.delete(ACT).where(and(eq(ACT.aiSdrId, a.id), sql`${ACT.actionType} in ('enrich_leads', 'initial_setup_enrich')`));
    await decide(a.id, { force: true });
    const runs = await db.select().from(ACT).where(and(eq(ACT.aiSdrId, a.id), sql`${ACT.actionType} in ('enrich_leads', 'initial_setup_enrich')`));
    const profileOf = (campaignId: string) => runs.filter((r) => r.actionPayload?.campaign_id === campaignId).map((r) => r.actionOutput?.icp_name);
    assert.deepEqual(profileOf(forBuyers), ["Buyers"]);
    assert.deepEqual(profileOf(forFounders), []);
    assert.deepEqual(profileOf(forEngineers), []);
    // What held "For founders" back is in the live feed.
    const feed = json(await user.client.get(`/api/v2/ai-agents/sales/${a.id}/activities?exclude_live_feed_hidden=true&limit=100`));
    assert.ok(feed.items.some((i: { action_type: string; action_output: { message?: string } }) => i.action_type === "warning" && /For founders/.test(i.action_output.message ?? "")));
  });
});

// ---------- Planning rounds ----------

describe("the outbound agent's planning rounds", () => {
  it("run one at a time: Run now during a round is refused, and a round cut short frees the agent later", async () => {
    const a = await newAgent({ icps: [] });
    await db.update(S).set({ decidingUntil: new Date(Date.now() + 60_000) }).where(eq(S.id, a.id));
    expectStatus(await user.client.post(`/api/app/ai-agents/sales/${a.id}/run`), 409);
    assert.equal(await decide(a.id, { force: true }), false);
    await db.update(S).set({ decidingUntil: new Date(Date.now() - 1_000) }).where(eq(S.id, a.id));
    assert.equal(await decide(a.id, { force: true }), true);
    assert.equal((await freshAgent(a.id)).decidingUntil, null);
  });

  it("don't propose pausing a campaign again for a week after the user said no", async () => {
    const a = await newAgent();
    const c = await agentCampaign(a, "Bouncy");
    const at = new Date();
    await db.insert(schema.emailEvents).values([
      ...Array.from({ length: 100 }, (_, i) => ({ workspaceId: user.workspaceId!, type: "sent", campaignId: c, leadId: `sent-${i}`, createdAt: at })),
      ...Array.from({ length: 10 }, (_, i) => ({ workspaceId: user.workspaceId!, type: "bounce", value: 1, campaignId: c, leadId: `sent-${i}`, createdAt: at })),
    ]);
    const pauses = () => db.select().from(ACT).where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "pause_campaign")));
    await decide(a.id, { force: true });
    const [proposal] = await pauses();
    assert.equal(proposal?.actionStatus, "pending");
    json(await user.client.post(`/api/v2/ai-agents/sales/${a.id}/activities/${proposal!.id}/reject`, { rejection_reason: "Those were old addresses" }));
    await decide(a.id, { force: true });
    assert.equal((await pauses()).length, 1);
  });
});

// ---------- Learning and campaigns ----------

describe("the outbound agent's setup", () => {
  it("a first reading that fails leaves the memory to fill in, with the reason in the feed", async () => {
    const created = json(await user.client.post("/api/v2/ai-agents/sales", { name: "Unreadable", type: "website", input: "https://unreachable.invalid", status: 0 }));
    await runSalesAgents();
    assert.equal(json(await user.client.get(`/api/v2/ai-agents/sales/${created.id}`)).initial_scrape_ready, true);
    const [reading] = json(await user.client.get(`/api/v2/ai-agents/sales/${created.id}/activities?action_type=initial_setup_scrape`)).items;
    assert.equal(reading.action_status, "failed");
    assert.ok(reading.error_message);
  });

  it("writes its campaigns on the workspace's clock, and leaves them unstarted while it's off", async () => {
    const tz = await signUp(app, { firstName: "Ravi", workspaceName: "Kolkata Co" });
    json(await tz.client.patch("/api/app/workspaces/current/settings", { default_timezone: "Asia/Kolkata" }));
    const a = await newAgent({ status: 0, owner: tz, config: { outreach_settings: { ...defaultConfig().outreach_settings, email_list: [] } } });
    const icp = cfgOf(a).memory.icps![0]!;
    const [proposal] = await db
      .insert(ACT)
      .values({
        workspaceId: a.workspaceId,
        aiSdrId: a.id,
        actionType: "create_campaign",
        actionStatus: "pending",
        actionPayload: { icp_index: 0, name: "On our clock", steps: [{ delay: 0, subject: "Hello", body: "<p>Hello.</p>" }] },
        actionOutput: { icp_name: icp.name },
      })
      .returning();
    const done = json(await tz.client.post(`/api/v2/ai-agents/sales/${a.id}/activities/${proposal!.id}/approve`));
    assert.equal(done.action_status, "completed");
    const [c] = await db.select().from(C).where(and(eq(C.workspaceId, tz.workspaceId!), eq(C.name, "On our clock")));
    assert.equal(c!.schedule?.schedules[0]?.timezone, "Asia/Kolkata");
    assert.equal(c!.status, CampaignStatus.DRAFT);
  });

  it("in 'only my leads' mode, proposes newer leads after older ones were turned down, and an approved move leaves a lead someone put elsewhere", async () => {
    const a = await newAgent({ config: { autonomy_settings: { autopilot_mode: false, auto_reply_to_responses: true, manual_leads_mode: true } } });
    const c = await agentCampaign(a, "Hand-picked");
    const old = Array.from({ length: 200 }, (_, i) => ({ email: `old${i}@picked.test`, first_name: "Old" }));
    json(await user.client.post("/api/v2/leads/add", { list_id: a.masterLeadListId, leads: old }));
    const oldIds = await db.select({ id: schema.leads.id }).from(schema.leads).where(eq(schema.leads.listId, a.masterLeadListId!));
    await db.insert(ACT).values(oldIds.map((l) => ({ workspaceId: a.workspaceId, aiSdrId: a.id, actionType: "push_lead", actionStatus: "rejected", actionPayload: { lead_id: l.id, campaign_id: c } })));
    await new Promise((r) => setTimeout(r, 5));
    const fresh = json(await user.client.post("/api/v2/leads", { email: "new@picked.test", first_name: "New", list_id: a.masterLeadListId })).id as string;
    await decide(a.id, { force: true });
    const [proposal] = await db
      .select()
      .from(ACT)
      .where(and(eq(ACT.aiSdrId, a.id), eq(ACT.actionType, "push_lead"), eq(ACT.actionStatus, "pending")));
    assert.equal(proposal?.actionPayload?.lead_id, fresh);

    // Meanwhile someone put the lead in another campaign: approving doesn't take it out of there.
    const elsewhere = json(await user.client.post("/api/app/campaigns", { name: "Elsewhere" })).id as string;
    await db.update(schema.leads).set({ campaignId: elsewhere }).where(eq(schema.leads.id, fresh));
    const done = json(await user.client.post(`/api/v2/ai-agents/sales/${a.id}/activities/${proposal!.id}/approve`));
    assert.equal(done.action_status, "failed");
    assert.equal((await db.select().from(schema.leads).where(eq(schema.leads.id, fresh)))[0]!.campaignId, elsewhere);
  });
});

// ---------- Credits ----------

describe("the outbound agent's credits", () => {
  it("reveal only people it can pay for in full, so a reveal is never paid for without the address", async () => {
    const paying = await signUp(app, { firstName: "Pat", workspaceName: "Paying Agents Co" });
    const ws = paying.workspaceId!;
    await db.update(schema.workspaces).set({ selfHosted: false, trialEndsAt: new Date(Date.now() + 7 * 86_400_000) }).where(eq(schema.workspaces.id, ws));
    await db.insert(schema.creditLedger).values({ workspaceId: ws, pool: "credits", delta: 1.5, reason: "test_grant" });
    await importDatasetRows([{ first_name: "Dee", last_name: "Test", title: "VP of Sales", email: "dee@reveal.test", company: "reveal.test", domain: "reveal.test" }], ["first_name", "last_name", "title", "email", "company", "domain"], null);
    const [person] = await db.select().from(schema.lfPeople).where(eq(schema.lfPeople.email, "dee@reveal.test"));
    const box = json(await paying.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
    const a = await newAgent({ owner: paying, config: { outreach_settings: { ...defaultConfig().outreach_settings, email_list: [box] } } });
    const c = json(await paying.client.post("/api/app/campaigns", { name: "Paid prospects" })).id as string;
    await db.update(C).set({ aiSdrId: a.id }).where(eq(C.id, c));
    const [recommendation] = await db
      .insert(ACT)
      .values({ workspaceId: ws, aiSdrId: a.id, actionType: "recommend_lead", actionStatus: "pending", actionPayload: { person_id: person!.id, campaign_id: c } })
      .returning();
    const done = json(await paying.client.post(`/api/v2/ai-agents/sales/${a.id}/activities/${recommendation!.id}/approve`));
    assert.equal(done.action_status, "failed");
    assert.equal(done.error_code, "insufficient_credits");
    assert.equal(await creditBalance(ws), 1.5);
  });
});

// ---------- The deliverability agent ----------

const CY = schema.deliverabilityCycles;
const DA = schema.deliverabilityActivities;
const FI = schema.deliverabilityFeedItems;

/** A workspace with its deliverability agent and an active campaign sending from one mailbox (a sandbox unless `email`). */
async function deliverabilitySetup(name: string, email?: string) {
  const owner = await signUp(app, { firstName: "Dee", workspaceName: name });
  const ws = owner.workspaceId!;
  const address = email ?? json(await owner.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
  if (email) await db.insert(schema.emailAccounts).values({ workspaceId: ws, email, providerCode: ProviderCode.CUSTOM, status: AccountStatus.ACTIVE });
  const [box] = await db.select().from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, ws), eq(schema.emailAccounts.email, address)));
  const campaign = json(await owner.client.post("/api/app/campaigns", { name: `${name} outreach` })).id as string;
  await db.update(C).set({ status: CampaignStatus.ACTIVE, emailList: [address] }).where(eq(C.id, campaign));
  const [agent] = await db.insert(schema.aiAgents).values({ workspaceId: ws, name: "Deliverability Agent", type: AgentType.DELIVERABILITY, status: AgentStatus.ACTIVE, payload: {} }).returning();
  return { owner, box: box!, agent: agent!, campaign };
}

/** Runs one check of the agent's, in a round of its own. */
async function runCheck(agent: AgentRow, code: string) {
  const [cycle] = await db.insert(CY).values({ workspaceId: agent.workspaceId, agentId: agent.id, status: "running", totalChecks: 1 }).returning();
  await db.insert(DA).values({ workspaceId: agent.workspaceId, agentId: agent.id, cycleId: cycle!.id, activityCode: code, status: "queued", subjectType: "workspace", subjectId: agent.workspaceId, updatedAt: new Date() });
  await processDeliverability();
}

const dnsIssue = (agent: AgentRow, domain: string, accountIds: string[]) =>
  db
    .insert(FI)
    .values({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      feedCode: "dns_health_recommendation",
      kind: "recommendation",
      severity: "critical",
      dedupeKey: `dns_health:${domain}`,
      payload: { title: `Fix DNS for ${domain}`, account_ids: accountIds },
      actionCode: "pause_affected_accounts",
    })
    .returning();

const feedItem = async (id: string) => (await db.select().from(FI).where(eq(FI.id, id)))[0]!;

describe("the deliverability agent", () => {
  it("closes a check cut short by a restart, so the next round of checks can start", async () => {
    const { agent } = await deliverabilitySetup("Restarted Co");
    const [cycle] = await db.insert(CY).values({ workspaceId: agent.workspaceId, agentId: agent.id, status: "running", totalChecks: 1 }).returning();
    const [cut] = await db
      .insert(DA)
      .values({ workspaceId: agent.workspaceId, agentId: agent.id, cycleId: cycle!.id, activityCode: "check_bounce_health", status: "in_progress", startedAt: new Date(Date.now() - 20 * 60_000), subjectType: "workspace", subjectId: agent.workspaceId, updatedAt: new Date() })
      .returning();
    await processDeliverability();
    const closed = (await db.select().from(DA).where(eq(DA.id, cut!.id)))[0]!;
    assert.equal(closed.status, "failed");
    assert.equal(closed.errorCode, "INTERRUPTED");
    assert.equal((await db.select().from(CY).where(eq(CY.id, cycle!.id)))[0]!.status, "completed");
    const next = await startCycle(agent);
    assert.equal(next.enqueued, true);
    await db.update(DA).set({ status: "cancelled" }).where(eq(DA.cycleId, next.cycle.id));
  });

  it("doesn't flag mailboxes again for the bounces that got them a rest from campaigns", async () => {
    const { owner, agent, box } = await deliverabilitySetup("Bouncy Co");
    const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(schema.accountDailyStats).values({ workspaceId: agent.workspaceId, accountId: box.id, date: day, sent: 40, bounced: 10 });
    const open = () => db.select().from(FI).where(and(eq(FI.agentId, agent.id), eq(FI.feedCode, "bounce_health_recommendation"), eq(FI.status, "todo")));
    await runCheck(agent, "check_bounce_health");
    const [flagged] = await open();
    assert.ok(flagged, "high bounces are flagged");
    const rest = json(await owner.client.post(`/api/v2/ai-agents/deliverability/feed-items/${flagged!.id}/pause-campaign-sending`));
    assert.equal(rest.paused_account_count, 1);
    await runCheck(agent, "check_bounce_health");
    assert.equal((await open()).length, 0);
  });

  describe("when DNS doesn't answer", () => {
    // steady-dns.example.com has every record; quiet-dns.example.org never answers.
    const P = dns.promises.Resolver.prototype as unknown as Record<string, (name: string) => Promise<unknown>>;
    const saved = { resolveMx: P.resolveMx, resolveTxt: P.resolveTxt, resolveCname: P.resolveCname };
    const fail = (code: string, name: string) => Object.assign(new Error(`${code} ${name}`), { code });
    const TXT: Record<string, string> = {
      "steady-dns.example.com": "v=spf1 ~all",
      "_dmarc.steady-dns.example.com": "v=DMARC1; p=none",
      "google._domainkey.steady-dns.example.com": "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC",
    };
    before(() => {
      P.resolveMx = async (name) => {
        if (name.endsWith("quiet-dns.example.org")) throw fail("ETIMEOUT", name);
        if (name === "steady-dns.example.com") return [{ exchange: "mx.steady-dns.example.com", priority: 10 }];
        throw fail("ENOTFOUND", name);
      };
      P.resolveTxt = async (name) => {
        if (name.endsWith("quiet-dns.example.org")) throw fail("ETIMEOUT", name);
        if (TXT[name]) return [[TXT[name]]];
        throw fail("ENOTFOUND", name);
      };
      P.resolveCname = async (name) => {
        throw fail(name.endsWith("quiet-dns.example.org") ? "ETIMEOUT" : "ENOTFOUND", name);
      };
    });
    after(() => Object.assign(P, saved));

    it("pausing the mailboxes for an issue pauses them, instead of calling the issue fixed", async () => {
      const { owner, agent, box } = await deliverabilitySetup("Quiet DNS Co", "ops@quiet-dns.example.org");
      const [item] = await dnsIssue(agent, "quiet-dns.example.org", [box.id]);
      const r = json(await owner.client.post(`/api/v2/ai-agents/deliverability/feed-items/${item!.id}/pause-affected-accounts`));
      assert.equal(r.paused_account_count, 1);
      assert.equal(r.item.action_status, "completed");
      assert.equal((await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, box.id)))[0]!.status, AccountStatus.PAUSED);
    });

    it("an open issue stays open when the next check couldn't reach that domain", async () => {
      const { agent, box, campaign } = await deliverabilitySetup("Mixed DNS Co", "team@quiet-dns.example.org");
      await db.insert(schema.emailAccounts).values({ workspaceId: agent.workspaceId, email: "team@steady-dns.example.com", providerCode: ProviderCode.CUSTOM, status: AccountStatus.ACTIVE });
      await db.update(C).set({ emailList: [box.email, "team@steady-dns.example.com"] }).where(eq(C.id, campaign));
      const [item] = await dnsIssue(agent, "quiet-dns.example.org", [box.id]);
      await runCheck(agent, "check_dns_health");
      assert.equal((await feedItem(item!.id)).status, "todo");
    });
  });
});

// ---------- The Lead Finder agent ----------

/** A workspace that pays for what it uses (a trial: 250 contacts), with `credits` to spend. */
async function meteredWorkspace(name: string, credits: number) {
  const owner = await signUp(app, { firstName: "Lou", workspaceName: name });
  await db.update(schema.workspaces).set({ selfHosted: false, trialEndsAt: new Date(Date.now() + 7 * 86_400_000) }).where(eq(schema.workspaces.id, owner.workspaceId!));
  await db.insert(schema.creditLedger).values({ workspaceId: owner.workspaceId!, pool: "credits", delta: credits, reason: "test_grant" });
  return owner;
}

/** People in the Lead Finder dataset, each at a company of their own (`<key>-<i>.test`). */
async function datasetPeople(key: string, n: number) {
  const domains = Array.from({ length: n }, (_, i) => `${key}-${i}.test`);
  await importDatasetRows(
    domains.map((d, i) => ({ first_name: "Lee", last_name: `Test${i}`, title: "Head of Growth", email: `lee${i}@${d}`, company: d, domain: d })),
    ["first_name", "last_name", "title", "email", "company", "domain"],
    null,
  );
  return domains;
}

/** A Lead Finder agent keeping one active lead in the campaign (so it tops up to 6 at a time). */
async function leadFinderAgent(owner: TestUser, campaignId: string, filters: Record<string, unknown>, aiColumns?: Record<string, unknown>) {
  const [row] = await db
    .insert(schema.aiAgents)
    .values({
      workspaceId: owner.workspaceId!,
      name: "Keep it stocked",
      type: AgentType.LEAD_FINDER,
      status: AgentStatus.ACTIVE,
      payload: { campaign_id: campaignId, search_filters: filters, min_active_leads: 1, on_exhaustion: "pause", ...(aiColumns ? { ai_enrichment: validateAiEnrichment(aiColumns) } : {}) },
    })
    .returning();
  return row!;
}

const campaignLeads = (campaignId: string) => db.select().from(schema.leads).where(eq(schema.leads.campaignId, campaignId));

describe("the Lead Finder agent", () => {
  it("pauses when no new lead gets its AI columns, gives the AI credits back, and tries the held leads again on resume", async () => {
    const owner = await meteredWorkspace("Held Co", 50);
    const domains = await datasetPeople("held-ai", 8);
    const campaign = json(await owner.client.post("/api/app/campaigns", { name: "Stocked with openers" })).id as string;
    const agent = await leadFinderAgent(owner, campaign, { domains }, { opener: { model_version: "default", prompt: "Write one friendly opening line for {{firstName}}." } });
    aiDown = true;
    try {
      await checkLeadFinderAgent(agent.id);
    } finally {
      aiDown = false;
    }
    const held = await campaignLeads(campaign);
    assert.equal(held.length, 6);
    assert.ok(held.every((l) => l.status === LeadStatus.PAUSED && l.payload?.lf_agent_hold));
    assert.equal((await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agent.id)))[0]!.status, AgentStatus.PAUSED);
    const events = await db.select().from(schema.aiAgentEvents).where(and(eq(schema.aiAgentEvents.agentId, agent.id), eq(schema.aiAgentEvents.eventType, "paused_ai_failed")));
    assert.equal(events.length, 1);
    // Six reveals and six addresses; the AI calls that failed cost nothing.
    assert.equal(await creditBalance(owner.workspaceId!), 50 - 12);

    json(await owner.client.post(`/api/v2/ai-agents/lead-finder/${agent.id}/resume`));
    await eventually(async () => (await campaignLeads(campaign)).filter((l) => l.status === LeadStatus.ACTIVE).length === 6, "the held leads to be released");
    const released = await campaignLeads(campaign);
    assert.equal(released.length, 6, "no new people were added in their place");
    assert.ok(released.every((l) => l.payload?.opener && !("lf_agent_hold" in (l.payload ?? {}))));
  });

  it("doesn't pay for people it can't add: blocked ones and leads it already has are passed over, and addresses that don't go in are refunded", async () => {
    const owner = await meteredWorkspace("Careful Co", 20);
    const domains = await datasetPeople("careful", 4);
    // lee0 is blocked and lee1 is already a lead here; lee2 and lee3 are new, but the trial has room for one more contact.
    json(await owner.client.post("/api/v2/block-lists-entries", { bl_value: "lee0@careful-0.test" }));
    const list = json(await owner.client.post("/api/v2/lead-lists", { name: "Already ours" })).id as string;
    const filler = Array.from({ length: 248 }, (_, i) => ({ email: `filler${i}@careful-filler.test` }));
    json(await owner.client.post("/api/v2/leads/add", { list_id: list, leads: [{ email: "lee1@careful-1.test" }, ...filler] }));
    const campaign = json(await owner.client.post("/api/app/campaigns", { name: "Careful stock" })).id as string;
    const agent = await leadFinderAgent(owner, campaign, { domains, skip_owned_leads: true });
    await checkLeadFinderAgent(agent.id);
    assert.equal((await campaignLeads(campaign)).length, 1);
    // Two reveals (lee2 and lee3) and the one address that went in.
    assert.equal(await creditBalance(owner.workspaceId!), 20 - 3);
  });
});

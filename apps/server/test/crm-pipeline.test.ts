// The CRM's deals and inbox kept honest: meetings that don't take a deal backwards, won deals that are won only while
// they're Won, deals that follow their lead's owner and leave with a deleted label, tasks that stay with someone who
// left, "Mine" in the inbox, the board's count, reports over any number of deals, sales flow pages, and phone numbers
// bought on the installation's Twilio account. People and companies are made up (.test); Twilio is answered here.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { InterestStatus } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { config } from "../src/env";

const L = schema.leads;
const OP = schema.crmOpportunities;
const T = schema.crmTasks;

let app: FastifyInstance;
let owner: TestUser; // the installation's owner
let alice: TestUser; // runs "Deals Co"
let carl: TestUser; // her teammate
let carlMembership: string;
let ws: string;

const realFetch = globalThis.fetch;
const savedTwilio = { ...config.twilio };
const twilioAsked: string[] = [];

before(async () => {
  app = await startServer();
  owner = await signUp(app);
  alice = await signUp(app, { firstName: "Alice", workspaceName: "Deals Co" });
  ws = alice.workspaceId!;
  carl = await signUp(app, { firstName: "Carl" });
  const invite = json(await alice.client.post("/api/v2/workspace-members", { email: carl.email, role: "editor" }));
  carlMembership = invite.id;
  json(await carl.client.post(`/api/app/invitations/${encodeURIComponent(new URL(invite.invite_url).searchParams.get("token")!)}/accept`));
  config.twilio.accountSid = "AC-local-test-only";
  config.twilio.authToken = "local-test-token";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    twilioAsked.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/IncomingPhoneNumbers.json")) return Response.json({ sid: `PN-local-${twilioAsked.length}`, phone_number: "+15555550142", friendly_name: "(555) 555-0142", capabilities: { voice: true, sms: true } });
    return Response.json({ message: "Not answered in tests" }, { status: 503 });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  Object.assign(config.twilio, savedTwilio);
  await stopServer();
});

let seq = 0;
async function lead(values: Partial<typeof L.$inferInsert> = {}) {
  const n = ++seq;
  const [row] = await db
    .insert(L)
    .values({ workspaceId: ws, email: `person${n}@pipeline-${n}.test`, firstName: `P${n}`, ...values })
    .returning();
  return row!;
}
const statusOf = async (id: string) => (await db.select({ s: L.interestStatus }).from(L).where(eq(L.id, id)))[0]!.s;
const dealOf = async (email: string) => (await db.select().from(OP).where(and(eq(OP.workspaceId, ws), eq(OP.leadEmail, email))))[0];
const dealUrl = (email: string) => `/api/app/crm/opportunities/${encodeURIComponent(email)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Deals follow status changes a moment later (a listener on the change): waits until `check` holds. */
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(10);
  }
  assert.fail(`never happened: ${what}`);
}
const meetingForm = (email: string, status = "scheduled") => ({ title: "Call", lead_email: email, start_at: new Date(Date.now() + 86_400_000).toISOString(), status, set_lead_status: true });

describe("meetings", () => {
  it("never take a won deal backwards, and a meeting that took place isn't undone by another", async () => {
    const won = await lead();
    json(await alice.client.patch(dealUrl(won.email!), { status: InterestStatus.WON, value: 10_000 }));
    await until(async () => !!(await dealOf(won.email!))?.wonAt, "the deal is won");
    const wonAt = (await dealOf(won.email!))!.wonAt;
    // An onboarding call booked, then held, with the customer.
    const onboarding = json(await alice.client.post("/api/app/crm/meetings", meetingForm(won.email!)));
    json(await alice.client.patch(`/api/app/crm/meetings/${onboarding.id}`, { status: "completed", set_lead_status: true }));
    await sleep(50);
    assert.equal(await statusOf(won.id), InterestStatus.WON);
    assert.deepEqual((await dealOf(won.email!))!.wonAt, wonAt);

    const met = await lead({ interestStatus: InterestStatus.MEETING_COMPLETED });
    const followUp = json(await alice.client.post("/api/app/crm/meetings", meetingForm(met.email!)));
    assert.equal(await statusOf(met.id), InterestStatus.MEETING_COMPLETED);
    json(await alice.client.patch(`/api/app/crm/meetings/${followUp.id}`, { status: "no_show", set_lead_status: true }));
    assert.equal(await statusOf(met.id), InterestStatus.MEETING_COMPLETED);

    // A first meeting still moves things along, and a no-show of it says so.
    const fresh = await lead({ interestStatus: InterestStatus.INTERESTED });
    const first = json(await alice.client.post("/api/app/crm/meetings", meetingForm(fresh.email!)));
    assert.equal(await statusOf(fresh.id), InterestStatus.MEETING_BOOKED);
    json(await alice.client.patch(`/api/app/crm/meetings/${first.id}`, { status: "no_show", set_lead_status: true }));
    assert.equal(await statusOf(fresh.id), InterestStatus.NO_SHOW);
  });
});

describe("deals", () => {
  it("count as won only while they're Won", async () => {
    const l = await lead();
    json(await alice.client.patch(dealUrl(l.email!), { status: InterestStatus.WON, value: 500 }));
    await until(async () => !!(await dealOf(l.email!))?.wonAt, "the deal is won");
    json(await alice.client.patch(dealUrl(l.email!), { status: InterestStatus.LOST }));
    await until(async () => (await dealOf(l.email!))!.stage === InterestStatus.LOST, "the deal is lost");
    assert.equal((await dealOf(l.email!))!.wonAt, null);
  });

  it("made by an edit with no status start outside the pipeline", async () => {
    const l = await lead({ interestStatus: InterestStatus.WON });
    json(await alice.client.patch(dealUrl(l.email!), { status: null, value: 300 }));
    await sleep(50);
    const d = await dealOf(l.email!);
    assert.deepEqual([d!.stage, d!.wonAt, d!.value], [0, null, 300]);
  });

  it("follow their lead to its new owner", async () => {
    const l = await lead({ interestStatus: InterestStatus.INTERESTED, assignedTo: alice.id });
    json(await alice.client.patch(dealUrl(l.email!), { value: 1_200 }));
    assert.equal((await dealOf(l.email!))!.ownerId, alice.id);
    json(await alice.client.patch(`/api/v2/leads/${l.id}`, { assigned_to: carl.id }));
    assert.equal((await dealOf(l.email!))!.ownerId, carl.id);
    // On Carl's board ("Me"), not Alice's.
    const mine = json(await carl.client.get("/api/app/crm/opportunities?owner=me"));
    assert.ok(mine.items.some((d: { lead_email: string }) => d.lead_email === l.email));
    json(await alice.client.post("/api/v2/leads/bulk-assign", { ids: [l.id], organization_user_ids: [alice.id] }), 202);
    assert.equal((await dealOf(l.email!))!.ownerId, alice.id);
  });

  it("leave the pipeline when their label is deleted, and sales flows stop filtering on it", async () => {
    const label = json(await alice.client.post("/api/v2/lead-labels", { label: "Hot lead", interest_status_label: "positive" }));
    const l = await lead({ interestStatus: label.interest_status });
    json(await alice.client.patch(dealUrl(l.email!), { value: 7_000 }));
    const flow = json(
      await alice.client.post("/api/app/crm/sales-flows", {
        name: "Hot leads who opened",
        queries: [
          { actionType: "lead-status", values: { "lead-status": { status: label.interest_status, condition: "is" } } },
          { actionType: "email-open", values: { "occurrence-days": 30 } },
        ],
      }),
    );
    const pipeline = async () => json(await alice.client.get("/api/app/crm/reports")).metrics.pipeline_value as number;
    const before = await pipeline();
    json(await alice.client.delete(`/api/v2/lead-labels/${label.id}`));
    assert.equal((await dealOf(l.email!))!.stage, 0);
    assert.equal(await pipeline(), before - 7_000);
    const [stored] = await db.select().from(schema.salesFlows).where(eq(schema.salesFlows.id, flow.id));
    assert.deepEqual(
      stored!.queries.map((q) => q.actionType),
      ["email-open"],
    );
  });

  it("are counted in reports however many were won", async () => {
    // More won deals than one database query can name (32,766).
    const now = Date.now();
    const rows = Array.from({ length: 33_000 }, (_, i) => ({ workspaceId: ws, leadEmail: `won${i}@many-deals.test`, name: `Won ${i}`, stage: InterestStatus.WON, value: 1, wonAt: new Date(now - i), createdAt: new Date(now - 86_400_000) }));
    for (let i = 0; i < rows.length; i += 1_000) await db.insert(OP).values(rows.slice(i, i + 1_000));
    const report = json(await alice.client.get("/api/app/crm/reports")).metrics;
    assert.ok(report.opportunities_won >= 33_000);
    await db.delete(OP).where(and(eq(OP.workspaceId, ws), sql`${OP.leadEmail} like '%@many-deals.test'`));
  });

  it("on a board that shows the newest say how many there are", async () => {
    for (let i = 0; i < 3; i++) await lead({ interestStatus: InterestStatus.INTERESTED, lastInterestChangeAt: new Date(Date.now() + i) });
    const page = json(await alice.client.get("/api/app/crm/opportunities?limit=2"));
    assert.equal(page.items.length, 2);
    assert.ok(page.total >= 3);
  });
});

describe("tasks", () => {
  it("left unassigned stay unassigned", async () => {
    const t = json(await alice.client.post("/api/app/crm/tasks", { title: "Nobody's yet", assigned_to: null }));
    assert.equal(t.assigned_to, null);
    const mine = json(await alice.client.post("/api/app/crm/tasks", { title: "Mine" }));
    assert.equal(mine.assigned_to, alice.id);
  });

  it("from a sequence, once finished, stay as they are", async () => {
    const l = await lead();
    const [done] = await db.insert(T).values({ workspaceId: ws, leadId: l.id, leadEmail: l.email, title: "Call them", source: "sequence", status: "done", completedAt: new Date(), step: 1 }).returning();
    const res = await alice.client.patch(`/api/app/crm/tasks/${done!.id}`, { status: "skipped" });
    expectStatus(res, 409);
    const [row] = await db.select().from(T).where(eq(T.id, done!.id));
    assert.deepEqual([row!.status, !!row!.completedAt], ["done", true]);
  });

  it("on a lead's timeline leave out ones put away, and say which were skipped", async () => {
    const l = await lead();
    await db.insert(T).values([
      { workspaceId: ws, leadId: l.id, leadEmail: l.email, title: "Put away", source: "sequence", status: "open", archivedAt: new Date(), step: 1 },
      { workspaceId: ws, leadId: l.id, leadEmail: l.email, title: "Skipped one", source: "sequence", status: "skipped", completedAt: new Date(), step: 2 },
    ]);
    const timeline = json(await alice.client.get(`/api/app/crm/timeline?lead_email=${encodeURIComponent(l.email!)}`));
    assert.deepEqual(
      timeline.items.filter((i: { type: string }) => i.type === "task").map((i: { title: string; status: string }) => [i.title, i.status]),
      [["Skipped one", "skipped"]],
    );
  });

  it("stay with a teammate who left until someone else takes them", async () => {
    const t = json(await alice.client.post("/api/app/crm/tasks", { title: "Carl's follow-up", assigned_to: carl.id }));
    // "Mine" in the inbox: calls and texts that came in for Carl's leads count as his.
    const his = await lead({ assignedTo: carl.id });
    await db.insert(schema.crmCalls).values({ workspaceId: ws, phoneNumber: "+15555550177", direction: "inbound", status: "completed", leadEmail: his.email });
    await db.insert(schema.crmSms).values({ workspaceId: ws, phoneNumber: "+15555550177", direction: "inbound", status: "received", body: "Call me back", leadEmail: his.email });
    const feed = json(await carl.client.get("/api/app/crm/feed?owner=me&type=call,sms"));
    assert.deepEqual(feed.items.map((i: { type: string }) => i.type).sort(), ["call", "sms"]);
    const counts = json(await carl.client.get("/api/app/crm/counts?owner=me"));
    assert.deepEqual([counts.inbox.call, counts.inbox.sms], [1, 1]);

    expectStatus(await alice.client.delete(`/api/v2/workspace-members/${carlMembership}`), 200);
    // Saving the task's other details, as the dialog does with everything in it, keeps it his.
    const saved = json(await alice.client.patch(`/api/app/crm/tasks/${t.id}`, { title: "Carl's follow-up (call Monday)", assigned_to: carl.id }));
    assert.equal(saved.assigned_to, carl.id);
    // A task can't be given to him anew, though.
    const fresh = json(await alice.client.post("/api/app/crm/tasks", { title: "New one" }));
    expectStatus(await alice.client.patch(`/api/app/crm/tasks/${fresh.id}`, { assigned_to: carl.id }), 400);
  });
});

describe("sales flow pages", () => {
  it("don't skip or repeat leads that become active while someone scrolls", async () => {
    const flow = json(await alice.client.post("/api/app/crm/sales-flows", { name: "Everyone not lost", queries: [{ actionType: "lead-status", values: { "lead-status": { status: InterestStatus.LOST, condition: "is-not" } } }] }));
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 6; i++) await lead({ lastTouchAt: new Date(base - i * 60_000), firstName: `Scroll ${i}` });
    const url = `/api/app/crm/sales-flows/${flow.id}/leads?limit=3`;
    const first = json(await alice.client.get(url));
    assert.equal(first.items.length, 3);
    // Someone further down gets an email meanwhile and moves to the top.
    const shown = new Set(first.items.map((l: { id: string }) => l.id));
    const all = json(await alice.client.get(`/api/app/crm/sales-flows/${flow.id}/leads?limit=500`)).items as Array<{ id: string }>;
    const below = all.find((l) => !shown.has(l.id))!;
    await db.update(L).set({ lastTouchAt: new Date() }).where(eq(L.id, below.id));
    const second = json(await alice.client.get(`${url}&after=${encodeURIComponent(first.next_after)}`));
    assert.ok(second.items.length > 0);
    assert.ok(!second.items.some((l: { id: string }) => shown.has(l.id)), "a lead from the first page came again");
  });
});

describe("phone numbers", () => {
  it("are bought on the installation's Twilio account only for its owner's workspaces", async () => {
    twilioAsked.length = 0;
    const refused = await alice.client.post("/api/app/crm/phone-numbers", { number: "+1 555 555 0142" });
    expectStatus(refused, 403);
    expectStatus(await alice.client.post("/api/app/crm/phone-numbers/import"), 403);
    assert.deepEqual(twilioAsked, []);
    const bought = json(await owner.client.post("/api/app/crm/phone-numbers", { number: "+1 555 555 0142" }));
    assert.equal(bought.number, "+15555550142");
  });
});

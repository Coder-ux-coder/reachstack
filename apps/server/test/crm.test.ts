// The CRM: meetings and the lead's status, reports for one teammate, a deal's colleagues, the pipeline's value, the
// deal board, and phone numbers: who an incoming call rings and how a call's end is recorded.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EmailType, InterestStatus } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { config } from "../src/env";
import { on, type BusEvent } from "../src/services/bus";
import { setOwner } from "../src/services/instance";

const L = schema.leads;
const PN = schema.crmPhoneNumbers;
const CA = schema.crmCalls;

let app: FastifyInstance;
let alice: TestUser; // owns the workspace
let carl: TestUser; // her teammate
let bob: TestUser; // in a workspace of his own
let ws: string;
let carlMembership: string;

// Twilio is answered here: nothing leaves the machine.
const realFetch = globalThis.fetch;
const savedTwilio = { ...config.twilio };
const twilioAsked: string[] = [];

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  alice = await signUp(app, { firstName: "Alice", workspaceName: "Deals Co" });
  bob = await signUp(app, { firstName: "Bob", workspaceName: "Elsewhere" });
  ws = alice.workspaceId!;
  // Phone numbers are bought on the installation's Twilio account: Alice runs the installation here.
  await setOwner(alice.id);
  carl = await signUp(app, { firstName: "Carl" });
  const invite = json(await alice.client.post("/api/v2/workspace-members", { email: carl.email, role: "editor" }));
  carlMembership = invite.id;
  json(await carl.client.post(`/api/app/invitations/${encodeURIComponent(new URL(invite.invite_url).searchParams.get("token")!)}/accept`));

  config.twilio.accountSid = "AC-local-test-only";
  config.twilio.authToken = "local-test-token";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    twilioAsked.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/IncomingPhoneNumbers.json")) return Response.json({ sid: "PN-local-1", phone_number: "+15555550100", friendly_name: "(555) 555-0100", capabilities: { voice: true, sms: true } });
    return Response.json({ message: "Not answered in tests" }, { status: 503 });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  Object.assign(config.twilio, savedTwilio);
  await stopServer();
});

// ---------- Helpers ----------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lead(values: Omit<typeof L.$inferInsert, "workspaceId">) {
  const [row] = await db
    .insert(L)
    .values({ workspaceId: ws, ...values })
    .returning();
  return row!;
}

const statusOf = async (id: string) => (await db.select({ s: L.interestStatus }).from(L).where(eq(L.id, id)))[0]!.s;
const deal = (email: string) => `/api/app/crm/opportunities/${encodeURIComponent(email)}`;

/** A webhook from Twilio, signed the way Twilio signs it. */
function twilioHook(path: string, p: Record<string, string>) {
  const data = `${config.appUrl}${path}` + Object.keys(p).sort().map((k) => k + p[k]).join("");
  const signature = createHmac("sha1", String(config.twilio.authToken)).update(data, "utf8").digest("base64");
  return app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    payload: new URLSearchParams(p).toString(),
  });
}

// ---------- Meetings ----------

describe("meetings", () => {
  it("move the lead's status when booked, held or moved to someone else, not on every edit", async () => {
    const mia = await lead({ email: "mia@meetings.example.test", firstName: "Mia" });
    const noah = await lead({ email: "noah@meetings.example.test", firstName: "Noah" });
    // What the meeting dialog sends: the whole form, with "update the lead's status" ticked.
    const form = { title: "Demo", lead_email: mia.email, start_at: new Date(Date.now() + 86_400_000).toISOString(), end_at: null, location: null, notes: null, status: "scheduled", set_lead_status: true };
    const meeting = json(await alice.client.post("/api/app/crm/meetings", form));
    assert.equal(await statusOf(mia.id), InterestStatus.MEETING_BOOKED);

    // The deal is won, then the meeting's notes are edited: the deal stays won.
    json(await alice.client.patch(deal(mia.email!), { status: InterestStatus.WON }));
    json(await alice.client.patch(`/api/app/crm/meetings/${meeting.id}`, { ...form, notes: "Bring the contract" }));
    assert.equal(await statusOf(mia.id), InterestStatus.WON);

    // The meeting is with Noah now: it's his, and his status moves.
    const moved = json(await alice.client.patch(`/api/app/crm/meetings/${meeting.id}`, { ...form, lead_email: noah.email }));
    assert.equal(moved.lead_email, noah.email);
    assert.equal(moved.lead_id, noah.id);
    assert.equal(await statusOf(noah.id), InterestStatus.MEETING_BOOKED);
    assert.equal(await statusOf(mia.id), InterestStatus.WON);

    // It took place: Noah's status follows.
    json(await alice.client.patch(`/api/app/crm/meetings/${meeting.id}`, { ...form, lead_email: noah.email, status: "completed" }));
    assert.equal(await statusOf(noah.id), InterestStatus.MEETING_COMPLETED);
  });
});

// ---------- Reports ----------

describe("reports for one teammate", () => {
  it("count only the emails, opens, calls and texts about the leads they own", async () => {
    const theirs = "theirs@reports.example.test";
    const others = "others@reports.example.test";
    await lead({ email: theirs, assignedTo: carl.id });
    await lead({ email: others, assignedTo: alice.id });
    const at = new Date(Date.now() - 3_600_000);
    const mail = (to: string, ueType: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        workspaceId: ws,
        threadId: `report-${to}-${ueType}-${i}`,
        messageId: `<report-${to}-${ueType}-${i}@example.test>`,
        leadEmail: to,
        eaccount: "sender@reports.example.test",
        subject: "Hello",
        ueType,
        timestampEmail: at,
      }));
    const sent = await db
      .insert(schema.emails)
      .values([...mail(theirs, EmailType.SENT, 2), ...mail(others, EmailType.SENT, 3), ...mail(theirs, EmailType.RECEIVED, 1), ...mail(others, EmailType.RECEIVED, 4)])
      .returning({ id: schema.emails.id, leadEmail: schema.emails.leadEmail, ueType: schema.emails.ueType });
    const opened = sent.filter((e) => e.ueType === EmailType.SENT);
    await db.insert(schema.emailEvents).values(opened.map((e) => ({ workspaceId: ws, type: "open", emailId: e.id, leadEmail: e.leadEmail })));
    const inbound = (leadEmail: string) => ({ workspaceId: ws, leadEmail, phoneNumber: "+15555550123", direction: "inbound" });
    await db.insert(CA).values([inbound(theirs), inbound(others), inbound(others)]);
    await db.insert(schema.crmSms).values([
      { ...inbound(theirs), body: "Hi" },
      { ...inbound(others), body: "Hi" },
    ]);

    const mine = json(await alice.client.get(`/api/app/crm/reports?owner=${carl.id}`)).metrics;
    assert.deepEqual([mine.sent_emails, mine.received_emails, mine.emails_open, mine.inbound_calls, mine.received_sms], [2, 1, 2, 1, 1]);
    const everyone = json(await alice.client.get("/api/app/crm/reports")).metrics;
    assert.deepEqual([everyone.sent_emails, everyone.received_emails, everyone.emails_open, everyone.inbound_calls, everyone.received_sms], [5, 5, 5, 3, 2]);
  });
});

// ---------- Deals ----------

describe("a deal's colleagues", () => {
  it("are the people at the same company, not everyone at the same free mail provider", async () => {
    await lead({ email: "ann@acme-deals.example.test", interestStatus: InterestStatus.INTERESTED });
    await lead({ email: "ben@acme-deals.example.test" });
    await lead({ email: "reachstack-test-pat@gmail.com", interestStatus: InterestStatus.INTERESTED });
    await lead({ email: "reachstack-test-sam@gmail.com" });
    const acme = json(await alice.client.get(deal("ann@acme-deals.example.test")));
    assert.deepEqual(
      acme.contacts.map((x: { email: string }) => x.email),
      ["ben@acme-deals.example.test"],
    );
    const freeMail = json(await alice.client.get(deal("reachstack-test-pat@gmail.com")));
    assert.deepEqual(freeMail.contacts, []);
  });
});

describe("the pipeline's value", () => {
  it("leaves out deals whose leads were deleted", async () => {
    const gone = await lead({ email: "gone@pipeline.example.test", interestStatus: InterestStatus.INTERESTED });
    json(await alice.client.patch(deal(gone.email!), { value: 1234 }));
    const before = json(await alice.client.get("/api/app/crm/reports")).metrics.pipeline_value as number;
    expectStatus(await alice.client.delete(`/api/v2/leads/${gone.id}`), 200);
    const after = json(await alice.client.get("/api/app/crm/reports")).metrics.pipeline_value as number;
    assert.equal(before - after, 1234);
  });
});

describe("the deal board", () => {
  it("shows a teammate's deals however many newer deals others have, one per address", async () => {
    const now = Date.now();
    const busy = Array.from({ length: 5_001 }, (_, i) => ({
      workspaceId: ws,
      email: `lead${i}@busy-board.example.test`,
      interestStatus: InterestStatus.INTERESTED,
      assignedTo: alice.id,
      lastInterestChangeAt: new Date(now - i * 1_000),
    }));
    for (let i = 0; i < busy.length; i += 500) await db.insert(L).values(busy.slice(i, i + 500));
    // Carl's deal is older than all of those; the same person is also in a second campaign.
    await lead({ email: "carls.deal@board.example.test", interestStatus: InterestStatus.MEETING_BOOKED, assignedTo: carl.id, lastInterestChangeAt: new Date(now - 30 * 86_400_000) });
    await lead({ email: "carls.deal@board.example.test", interestStatus: InterestStatus.INTERESTED, assignedTo: carl.id, lastInterestChangeAt: new Date(now - 40 * 86_400_000) });

    const carls = json(await alice.client.get(`/api/app/crm/opportunities?owner=${carl.id}`)).items as Array<{ lead_email: string; status: number }>;
    assert.deepEqual(
      carls.map((d) => [d.lead_email, d.status]),
      [["carls.deal@board.example.test", InterestStatus.MEETING_BOOKED]],
    );
    const hers = json(await alice.client.get("/api/app/crm/opportunities?owner=me&limit=3")).items as Array<{ lead_email: string }>;
    assert.deepEqual(
      hers.map((d) => d.lead_email),
      ["lead0@busy-board.example.test", "lead1@busy-board.example.test", "lead2@busy-board.example.test"],
    );
  });
});

// ---------- Phone numbers and calls ----------

describe("phone numbers and calls", () => {
  it("a number can only be given to someone in the workspace, checked before it's bought", async () => {
    twilioAsked.length = 0;
    const refused = await alice.client.post("/api/app/crm/phone-numbers", { number: "+1 555 555 0100", assigned_to: bob.id });
    expectStatus(refused, 400);
    assert.match(refused.body, /assigned_to/);
    assert.deepEqual(twilioAsked, []);
    const bought = json(await alice.client.post("/api/app/crm/phone-numbers", { number: "+1 555 555 0100", assigned_to: carl.id }));
    assert.equal(bought.number, "+15555550100");
    assert.equal(twilioAsked.length, 1);
    // Saving it with nothing changed is fine.
    json(await alice.client.patch(`/api/app/crm/phone-numbers/${bought.id}`, {}));
  });

  it("a call's end is recorded and announced once, a late update doesn't reopen it, and a later recording is kept", async () => {
    const ended: BusEvent[] = [];
    on("call_completed", (e) => {
      if (e.workspaceId === ws) ended.push(e);
    });
    const [call] = await db.insert(CA).values({ workspaceId: ws, phoneNumber: "+15555550199", direction: "inbound", status: "ringing", twilioSid: "CA-status-1" }).returning();
    const update = (p: Record<string, string>) => twilioHook("/api/webhooks/twilio/call-status", { CallSid: "CA-status-1", ...p });
    expectStatus(await update({ CallStatus: "completed", CallDuration: "42" }), 200);
    expectStatus(await update({ CallStatus: "completed", CallDuration: "42" }), 200);
    expectStatus(await update({ CallStatus: "in-progress", CallDuration: "0" }), 200);
    expectStatus(await update({ CallStatus: "completed", CallDuration: "42", RecordingUrl: "https://recordings.invalid/CA-status-1" }), 200);
    await sleep(50);
    const [row] = await db.select().from(CA).where(eq(CA.id, call!.id));
    assert.deepEqual([row!.status, row!.durationSec, row!.recordingUrl], ["completed", 42, "https://recordings.invalid/CA-status-1"]);
    assert.deepEqual(
      ended.map((e) => e.data.call_id),
      [call!.id],
    );
  });

  it("an incoming call rings the teammate the number is given to, and no longer once they've left", async () => {
    await db.update(schema.users).set({ phone: "+1 (555) 555-0111" }).where(eq(schema.users.id, carl.id));
    const [number] = await db.insert(PN).values({ workspaceId: ws, number: "+15555550101", assignedTo: carl.id, capabilities: { voice: true, sms: true } }).returning();
    const ring = async (sid: string) => (await twilioHook("/api/webhooks/twilio/voice", { CallSid: sid, From: "+15555550199", To: number!.number })).body;
    assert.match(await ring("CA-ring-1"), /<Dial>\+15555550111<\/Dial>/);

    expectStatus(await alice.client.delete(`/api/v2/workspace-members/${carlMembership}`), 200);
    const [released] = await db.select().from(PN).where(eq(PN.id, number!.id));
    assert.equal(released!.assignedTo, null);
    assert.doesNotMatch(await ring("CA-ring-2"), /<Dial>/);
    // A number still given to him from before (or by mistake) doesn't ring his phone either.
    await db.update(PN).set({ assignedTo: carl.id }).where(eq(PN.id, number!.id));
    assert.doesNotMatch(await ring("CA-ring-3"), /<Dial>/);
  });
});

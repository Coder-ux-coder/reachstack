// Lead data that has to hold up: moves that don't restart anyone, addresses that stay suppressed after their lead is
// deleted, labels on any number of leads and label codes never given out twice, searches that find what's typed,
// who may change tags and see jobs, big campaigns duplicated and big files imported in parts, and pickers that list
// everything.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { LeadStatus } from "@reachstack/shared";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";
import { runSender } from "../src/engine/sender";
import * as leadRoutes from "../src/routes/leads";
import { handleBounce, setInterestStatus, unsubscribeFromCampaign } from "../src/services/activity";
import * as jobs from "../src/services/jobs";

const L = schema.leads;
const J = schema.backgroundJobs;
const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const STEPS = [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Hi {{firstName}}", body: "<p>Hello {{firstName}}</p>" }] }] }];

let app: FastifyInstance;
let owner: TestUser;
let sender = "";

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  owner = await signUp(app, { firstName: "Lee", workspaceName: "Lead Data Co" });
  sender = json(await owner.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
});
after(stopServer);

const tokenOf = (inviteUrl: string) => new URL(inviteUrl).searchParams.get("token")!;
async function join(role: string, permissions?: string[]): Promise<TestUser> {
  const email = uniqueEmail(role);
  const invite = json(await owner.client.post("/api/v2/workspace-members", { email, role, ...(permissions ? { permissions } : {}) }));
  return signUp(app, { email, inviteToken: tokenOf(invite.invite_url) });
}

async function waitForJob(id: string) {
  for (let i = 0; i < 200; i++) {
    await runPendingJobs();
    const [job] = await db.select().from(J).where(eq(J.id, id));
    if (job!.status === "success" || job!.status === "failed") return job!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("The job didn't finish");
}

/** A campaign that sends from the sandbox mailbox at any hour, with these leads. */
async function sendingCampaign(name: string, emails: string[]) {
  const id = json(await owner.client.post("/api/app/campaigns", { name })).id as string;
  json(await owner.client.patch(`/api/v2/campaigns/${id}`, { email_list: [sender], campaign_schedule: ALWAYS_OPEN, sequences: STEPS }));
  for (const email of emails) json(await owner.client.post("/api/v2/leads", { email, first_name: "Pat", campaign: id }));
  return id;
}
const leadIn = async (campaignId: string, email: string) => (await db.select().from(L).where(and(eq(L.campaignId, campaignId), eq(L.email, email))))[0]!;
const sends = async (campaignId: string, email: string) =>
  (
    await db
      .select({ id: schema.emailEvents.id })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.campaignId, campaignId), eq(schema.emailEvents.leadEmail, email), eq(schema.emailEvents.type, "sent"), isNull(schema.emailEvents.subsequenceId)))
  ).length;

describe("moving leads", () => {
  it("into the campaign they're already in leaves them where they are in its sequence", async () => {
    const id = await sendingCampaign("Already here", ["here@example.test"]);
    const lead = await leadIn(id, "here@example.test");
    await db.update(L).set({ nextStep: 1, openCount: 2 }).where(eq(L.id, lead.id));
    const job = json(await owner.client.post("/api/v2/leads/move", { ids: [lead.id], to_campaign_id: id }));
    const done = await waitForJob(job.id);
    assert.deepEqual(done.result, { moved_count: 0, skipped_count: 1 });
    const now = await leadIn(id, "here@example.test");
    assert.equal(now.nextStep, 1, "not sent the first email again");
    assert.equal(now.openCount, 2);
  });
});

describe("addresses that bounced or asked a campaign to stop", () => {
  it("aren't emailed again once their lead is deleted and added back, here or (for a bounce) anywhere", async () => {
    const first = await sendingCampaign("Bounced once", ["gone@example.test"]);
    const lead = await leadIn(first, "gone@example.test");
    await handleBounce({ workspaceId: owner.workspaceId!, lead, campaignId: first, accountId: null, accountEmail: null, hard: true });
    json(await owner.client.delete(`/api/v2/leads/${lead.id}`));
    json(await owner.client.post("/api/v2/leads", { email: "gone@example.test", first_name: "Pat", campaign: first }));
    const elsewhere = await sendingCampaign("Bounced elsewhere", ["gone@example.test"]);
    for (const id of [first, elsewhere]) expectStatus(await owner.client.post(`/api/v2/campaigns/${id}/activate`), 200);
    await runSender();
    for (const id of [first, elsewhere]) {
      assert.equal(await sends(id, "gone@example.test"), 0);
      assert.equal((await leadIn(id, "gone@example.test")).status, LeadStatus.BOUNCED);
    }
  });

  it("a campaign told to stop isn't sent again after the lead is deleted and added back; another campaign still is", async () => {
    const stopped = await sendingCampaign("Told to stop", ["stop@example.test"]);
    await unsubscribeFromCampaign({ workspaceId: owner.workspaceId!, email: "stop@example.test", campaignId: stopped });
    json(await owner.client.delete(`/api/v2/leads/${(await leadIn(stopped, "stop@example.test")).id}`));
    json(await owner.client.post("/api/v2/leads", { email: "stop@example.test", first_name: "Pat", campaign: stopped }));
    const other = await sendingCampaign("Never told", ["stop@example.test"]);
    for (const id of [stopped, other]) expectStatus(await owner.client.post(`/api/v2/campaigns/${id}/activate`), 200);
    await runSender();
    assert.equal(await sends(stopped, "stop@example.test"), 0);
    assert.equal((await leadIn(stopped, "stop@example.test")).status, LeadStatus.UNSUBSCRIBED);
    assert.equal(await sends(other, "stop@example.test"), 1);
  });

  it("a duplicated campaign's copies keep who bounced or unsubscribed, and start the rest from the first step", async () => {
    const id = json(await owner.client.post("/api/app/campaigns", { name: "Big one" })).id as string;
    const rows = Array.from({ length: 1050 }, (_, i) => ({ workspaceId: owner.workspaceId!, campaignId: id, email: `copy${i}@example.test` }));
    for (let i = 0; i < rows.length; i += 200) await db.insert(L).values(rows.slice(i, i + 200));
    await db.update(L).set({ status: LeadStatus.BOUNCED }).where(eq(L.email, "copy1@example.test"));
    await db.update(L).set({ status: LeadStatus.UNSUBSCRIBED }).where(eq(L.email, "copy2@example.test"));
    await db.update(L).set({ status: LeadStatus.COMPLETED, nextStep: 3, openCount: 4, interestStatus: 1 }).where(eq(L.email, "copy3@example.test"));
    const copy = json(await owner.client.post(`/api/v2/campaigns/${id}/duplicate`, { copy_leads: true })).id as string;
    const copied = await db.select().from(L).where(eq(L.campaignId, copy));
    assert.equal(copied.length, 1050, "every page of leads");
    const of = (email: string) => copied.find((l) => l.email === email)!;
    assert.equal(of("copy1@example.test").status, LeadStatus.BOUNCED);
    assert.equal(of("copy2@example.test").status, LeadStatus.UNSUBSCRIBED);
    const fresh = of("copy3@example.test");
    assert.deepEqual([fresh.status, fresh.nextStep, fresh.openCount, fresh.interestStatus], [LeadStatus.ACTIVE, 0, 0, null]);
  });
});

describe("labels", () => {
  it("are set on more leads than one database statement can name", async () => {
    const id = json(await owner.client.post("/api/app/campaigns", { name: "Labelled" })).id as string;
    const leads = await db
      .insert(L)
      .values([1, 2, 3].map((i) => ({ workspaceId: owner.workspaceId!, campaignId: id, email: `many${i}@example.test` })))
      .returning({ id: L.id });
    const ids = [...leads.map((l) => l.id), ...Array.from({ length: 33_000 }, (_, i) => `not-a-lead-${i}`)];
    assert.equal(await setInterestStatus({ workspaceId: owner.workspaceId!, leadIds: ids, value: 1, source: "user" }), 3);
    const now = await db.select({ v: L.interestStatus }).from(L).where(eq(L.campaignId, id));
    assert.deepEqual(now.map((l) => l.v), [1, 1, 1]);
  });

  it("a deleted label's code is never given to a new one, and nothing goes on naming it", async () => {
    const ws = owner.workspaceId!;
    const doNotContact = json(await owner.client.post("/api/v2/lead-labels", { label: "Do not contact", interest_status_label: "negative" }));
    const code = doNotContact.interest_status as number;
    json(await owner.client.put("/api/app/blocklist/settings", { triggers: { statuses: [code, 3], phrases: [] } }));
    const parent = json(await owner.client.post("/api/app/campaigns", { name: "With a label subsequence" })).id as string;
    const sub = json(await owner.client.post("/api/v2/subsequences", { parent_campaign: parent, name: "On the label", conditions: { crm_status: [code, 1] } }));
    const [thread] = await db
      .insert(schema.emails)
      .values({ workspaceId: ws, messageId: "<label-thread@example.test>", subject: "Hi", eaccount: sender, ueType: 2, leadEmail: "dnc@example.test", interestStatus: code, timestampEmail: new Date() })
      .returning();

    json(await owner.client.delete(`/api/v2/lead-labels/${doNotContact.id}`));
    assert.deepEqual(json(await owner.client.get("/api/app/blocklist/settings")).triggers.statuses, [3]);
    const [s] = await db.select({ c: schema.subsequences.conditions }).from(schema.subsequences).where(eq(schema.subsequences.id, sub.id));
    assert.deepEqual(s!.c.crm_status, [1]);
    const [email] = await db.select({ v: schema.emails.interestStatus }).from(schema.emails).where(eq(schema.emails.id, thread!.id));
    assert.equal(email!.v, null);

    const next = json(await owner.client.post("/api/v2/lead-labels", { label: "Hot", interest_status_label: "negative" }));
    assert.notEqual(next.interest_status, code, "the old code would put the new label's leads on the blocklist");
  });
});

describe("blocklist searches", () => {
  it("find what's typed, so deleting by a search deletes only that", async () => {
    json(await owner.client.post("/api/v2/block-lists-entries/bulk-create", { bl_values: ["a_b@wild.test", "axb@wild.test", "100%off@wild.test", "1000ff@wild.test"] }));
    const found = json(await owner.client.get("/api/v2/block-lists-entries?search=a_b")).items.map((e: { bl_value: string }) => e.bl_value);
    assert.deepEqual(found, ["a_b@wild.test"]);
    assert.deepEqual(json(await owner.client.get("/api/v2/block-lists-entries?search=100%25")).items.map((e: { bl_value: string }) => e.bl_value), ["100%off@wild.test"]);
    const gone = json(await owner.client.delete("/api/v2/block-lists-entries?search=a_b")) as Array<{ bl_value: string }>;
    assert.deepEqual(gone.map((e) => e.bl_value), ["a_b@wild.test"]);
    const left = json(await owner.client.get("/api/v2/block-lists-entries?search=wild.test")).items.map((e: { bl_value: string }) => e.bl_value).sort();
    assert.deepEqual(left, ["100%off@wild.test", "1000ff@wild.test", "axb@wild.test"]);
  });
});

describe("tags", () => {
  it("are changed only by people who manage what they're on", async () => {
    const campaign = json(await owner.client.post("/api/app/campaigns", { name: "Tagged" })).id as string;
    const tag = json(await owner.client.post("/api/v2/custom-tags", { label: "VIP" }));
    const leadsOnly = await join("editor", ["leads"]);
    expectStatus(await leadsOnly.client.post("/api/v2/custom-tags", { label: "Mine" }), 403);
    expectStatus(await leadsOnly.client.post("/api/v2/custom-tags/toggle-resource", { tag_ids: [tag.id], resource_type: 2, resource_ids: [campaign], assign: true }), 403);
    expectStatus(await leadsOnly.client.delete(`/api/v2/custom-tags/${tag.id}`), 403);

    const campaigns = await join("editor", ["view_campaigns", "edit_campaigns"]);
    json(await campaigns.client.post("/api/v2/custom-tags/toggle-resource", { tag_ids: [tag.id], resource_type: 2, resource_ids: [campaign], assign: true }));
    const mailbox = json(await owner.client.get("/api/v2/accounts")).items[0];
    expectStatus(await campaigns.client.post("/api/v2/custom-tags/toggle-resource", { tag_ids: [tag.id], resource_type: 1, resource_ids: [mailbox.id], assign: true }), 403);
  });

  it("put on the workspace with “select all” go on the workspace, not on every campaign", async () => {
    const tag = json(await owner.client.post("/api/v2/custom-tags", { label: "Agency client" }));
    json(await owner.client.post("/api/app/campaigns", { name: "Not the workspace" }));
    json(await owner.client.post("/api/v2/custom-tags/toggle-resource", { tag_ids: [tag.id], resource_type: 3, selected_all: true, assign: true }));
    const on = await db.select().from(schema.customTagMappings).where(eq(schema.customTagMappings.tagId, tag.id));
    assert.deepEqual(on.map((m) => [m.resourceId, m.resourceType]), [[owner.workspaceId, 3]]);
  });
});

describe("background jobs", () => {
  it("are seen by whoever started them and those who could, not by everyone", async () => {
    const campaign = json(await owner.client.post("/api/app/campaigns", { name: "Exported" })).id as string;
    const exported = json(await owner.client.post("/api/app/leads/export", { campaign }));
    await waitForJob(exported.id);
    const client = await join("client", ["dashboard"]);
    assert.equal(json(await client.client.get("/api/v2/background-jobs")).items.length, 0);
    expectStatus(await client.client.get(`/api/v2/background-jobs/${exported.id}`), 404);
    const leadsEditor = await join("editor", ["leads"]);
    assert.ok(json(await leadsEditor.client.get("/api/v2/background-jobs")).items.some((j: { id: string }) => j.id === exported.id));
    json(await leadsEditor.client.get(`/api/v2/background-jobs/${exported.id}`));
  });

  it("of every kind say what seeing them takes", () => {
    assert.deepEqual(jobs.jobTypes().filter((t) => !jobs.JOB_PERMISSIONS[t]), []);
  });
});

describe("imports sent in parts", () => {
  const start = (campaign_id: string, emails: string[], parts: number) =>
    owner.client.post("/api/app/leads/import", { campaign_id, leads: emails.map((email) => ({ email })), parts, total: parts * emails.length, source: "csv" });

  it("bring in the whole file", async () => {
    const id = json(await owner.client.post("/api/app/campaigns", { name: "In parts" })).id as string;
    const job = json(await start(id, ["p1a@example.test", "p1b@example.test"], 3));
    json(await owner.client.post(`/api/app/leads/import/${job.id}/parts`, { seq: 3, leads: [{ email: "p3@example.test" }] }));
    json(await owner.client.post(`/api/app/leads/import/${job.id}/parts`, { seq: 2, leads: [{ email: "p2@example.test" }] }));
    expectStatus(await owner.client.post(`/api/app/leads/import/${job.id}/parts`, { seq: 4, leads: [{ email: "p4@example.test" }] }), 400);
    const done = await waitForJob(job.id);
    assert.equal(done.status, "success");
    assert.equal((done.result as { leads_uploaded: number }).leads_uploaded, 4);
    expectStatus(await owner.client.post(`/api/app/leads/import/${job.id}/parts`, { seq: 2, leads: [{ email: "late@example.test" }] }), 409);
    const other = await join("editor");
    expectStatus(await other.client.post(`/api/app/leads/import/${job.id}/parts`, { seq: 2, leads: [{ email: "theirs@example.test" }] }), 404);
  });

  it("end with what arrived when the rest never comes", async () => {
    const id = json(await owner.client.post("/api/app/campaigns", { name: "Cut short" })).id as string;
    const wait = leadRoutes.importParts.waitMs;
    leadRoutes.importParts.waitMs = 0;
    try {
      const job = json(await start(id, ["only@example.test"], 2));
      const done = await waitForJob(job.id);
      assert.equal(done.status, "failed");
      assert.match(done.error ?? "", /stopped arriving after part 1 of 2/);
      assert.equal((await db.select().from(L).where(eq(L.campaignId, id))).length, 1);
    } finally {
      leadRoutes.importParts.waitMs = wait;
    }
  });
});

describe("pickers", () => {
  it("list every campaign and list by name, newest first, and only the workspace's own", async () => {
    const older = json(await owner.client.post("/api/app/campaigns", { name: "Picker one" })).id as string;
    const newer = json(await owner.client.post("/api/app/campaigns", { name: "Picker two" })).id as string;
    const names = json(await owner.client.get("/api/app/campaigns/names")).items as Array<{ id: string; name: string }>;
    assert.ok(names.findIndex((c) => c.id === newer) < names.findIndex((c) => c.id === older));
    const all = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(eq(schema.campaigns.workspaceId, owner.workspaceId!));
    assert.equal(names.length, all.length);
    const list = json(await owner.client.post("/api/v2/lead-lists", { name: "Picker list" })).id as string;
    assert.ok(json(await owner.client.get("/api/app/lead-lists/names")).items.some((l: { id: string }) => l.id === list));
    const stranger = await signUp(app, { workspaceName: "Someone else" });
    assert.deepEqual(json(await stranger.client.get("/api/app/campaigns/names")).items, []);
  });
});

// Recently deleted: deleting a campaign, a lead list, leads, a template or a subsequence keeps it for 30 days. It comes
// back as it was (campaigns paused), only for people allowed to delete it, never for another workspace, and the daily
// purge removes it for good after 30 days. Blocking an address never deletes anything.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CampaignStatus, LeadStatus } from "@reachstack/shared";
import { TestClient, expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { isReady, purgeDeleted } from "../src/services/recently-deleted";

const L = schema.leads;
const DAY = 86_400_000;
const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const step = (subject: string, body: string) => ({ type: "email", delay: 1, delay_unit: "days", variants: [{ subject, body }] });

type Entry = { id: string; kind: string; name: string; context: string | null; counts: Record<string, number>; deleted_by_name: string | null; days_left: number; can_restore: boolean; ready: boolean };

let app: FastifyInstance;
let owner: TestUser;
let stranger: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  owner = await signUp(app, { firstName: "Robin", workspaceName: "Trash Co" });
  stranger = await signUp(app, { firstName: "Sasha", workspaceName: "Other Co" });
});
after(stopServer);

const trash = async (client = owner.client, kind?: string) => json<{ items: Entry[] }>(await client.get(`/api/app/recently-deleted${kind ? `?kind=${kind}` : ""}`)).items;
const entry = async (id: string, client = owner.client) => (await trash(client)).find((e) => e.id === id);
const restore = async (id: string, client = owner.client) => json(await client.post(`/api/app/recently-deleted/${id}/restore`));
const newCampaign = async (name: string) => json(await owner.client.post("/api/app/campaigns", { name })).id as string;
const addLead = async (email: string, where: { campaign?: string; list_id?: string }) => json(await owner.client.post("/api/v2/leads", { email, first_name: "Pat", ...where })).id as string;
const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const leadsIn = async (campaignId: string) => byId(await db.select().from(L).where(eq(L.campaignId, campaignId)));
const analytics = async (campaignId: string) => json<Array<Record<string, number>>>(await owner.client.get(`/api/v2/campaigns/analytics?id=${campaignId}`))[0];

/** A campaign with its own mailbox, an always-open schedule and leads, that has sent its first emails. */
async function sentCampaign(name: string, emails: string[], steps = [step("Hi {{firstName}}", "<p>Hello {{firstName}}</p>")]) {
  const c = owner.client;
  const id = await newCampaign(name);
  const mailbox = json(await c.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
  // No wait between sends, so a follow-up can go out right away.
  await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, mailbox));
  json(await c.patch(`/api/v2/campaigns/${id}`, { email_list: [mailbox], campaign_schedule: ALWAYS_OPEN, email_gap: 0, random_wait_max: 0, sequences: [{ steps }] }));
  for (const email of emails) await addLead(email, { campaign: id });
  expectStatus(await c.post(`/api/v2/campaigns/${id}/activate`), 200);
  await runSender();
  return id;
}

async function join(role: "view" | "editor") {
  const person = await signUp(app);
  const invite = json(await owner.client.post("/api/v2/workspace-members", { email: person.email, role }));
  const token = new URL(invite.invite_url).searchParams.get("token")!;
  json(await person.client.post(`/api/app/invitations/${encodeURIComponent(token)}/accept`));
  assert.equal(json(await person.client.get("/api/app/auth/me")).workspace.id, owner.workspaceId);
  return person;
}

describe("a deleted campaign", () => {
  it("comes back as it was, with its leads, subsequence, analytics and sequence versions, but paused", async () => {
    const c = owner.client;
    const id = await sentCampaign("Q4 outreach", ["ana@example.test", "ben@example.test"]);
    const sub = json(await c.post("/api/v2/subsequences", { parent_campaign: id, name: "Interested", conditions: { crm_status: [1] } }));
    const stats = await analytics(id);
    assert.ok(stats.emails_sent_count >= 1);
    const leads = await leadsIn(id);
    const events = (await db.select().from(schema.emailEvents).where(eq(schema.emailEvents.campaignId, id))).length;
    const versions = json(await c.get(`/api/app/campaigns/${id}/sequence-versions`)).items.length;
    assert.equal(versions, 1);
    const emails = (await db.select().from(schema.emails).where(eq(schema.emails.campaignId, id))).length;
    assert.ok(emails >= 1);

    const deleted = json(await c.delete(`/api/v2/campaigns/${id}`));
    assert.ok(deleted.recently_deleted_id);
    expectStatus(await c.get(`/api/v2/campaigns/${id}`), 404);
    assert.equal((await leadsIn(id)).length, 0);
    assert.equal((await db.select().from(schema.emailEvents).where(eq(schema.emailEvents.campaignId, id))).length, 0);
    assert.equal((await db.select().from(schema.subsequences).where(eq(schema.subsequences.parentCampaignId, id))).length, 0);
    // Its conversations stay in the Unibox.
    assert.equal((await db.select().from(schema.emails).where(eq(schema.emails.campaignId, id))).length, emails);

    const e = (await entry(deleted.recently_deleted_id))!;
    assert.equal(e.kind, "campaign");
    assert.equal(e.name, "Q4 outreach");
    assert.deepEqual(e.counts, { leads: 2, subsequences: 1, events });
    assert.equal(e.deleted_by_name, "Robin User");
    assert.equal(e.days_left, 30);
    assert.equal(e.can_restore, true);

    const result = await restore(e.id);
    assert.match(result.message, /“Q4 outreach” is back with 2 leads\. It's paused, so nothing is sent until you resume it\./);
    assert.equal(result.link, `/app/campaign/${id}/analytics`);
    const back = json(await c.get(`/api/v2/campaigns/${id}`));
    assert.equal(back.name, "Q4 outreach");
    assert.equal(back.status, CampaignStatus.PAUSED);
    assert.deepEqual(await leadsIn(id), leads);
    const after = await analytics(id);
    for (const k of ["emails_sent_count", "contacted_count", "leads_count", "open_count"]) assert.equal(after[k], stats[k], k);
    assert.deepEqual(
      json(await c.get(`/api/v2/subsequences?parent_campaign=${id}`)).items.map((s: { id: string }) => s.id),
      [sub.id],
    );
    assert.equal(json(await c.get(`/api/app/campaigns/${id}/sequence-versions`)).items.length, versions);
    assert.equal(await entry(e.id), undefined);

    // Paused means paused: even with every lead due, nothing goes out.
    await db
      .update(L)
      .set({ status: LeadStatus.ACTIVE, nextStep: 0, nextSendAt: Date.now() - 1000 })
      .where(eq(L.campaignId, id));
    await runSender();
    assert.equal((await analytics(id)).emails_sent_count, stats.emails_sent_count);
  });

  it("gets “(restored)” added to its name when another campaign has the name by now, and a draft stays a draft", async () => {
    const c = owner.client;
    const id = await newCampaign("Weekly");
    const deleted = json(await c.delete(`/api/v2/campaigns/${id}`));
    await newCampaign("Weekly");
    const result = await restore(deleted.recently_deleted_id);
    assert.equal(result.name, "Weekly (restored)");
    assert.match(result.message, /Another campaign is called “Weekly”, so this one is now “Weekly \(restored\)”\./);
    const back = json(await c.get(`/api/v2/campaigns/${id}`));
    assert.equal(back.name, "Weekly (restored)");
    assert.equal(back.status, CampaignStatus.DRAFT);
  });

  it("comes back suspended when it was suspended, so a delete can't lift a suspension", async () => {
    const id = await newCampaign("Suspended");
    await db.update(schema.campaigns).set({ status: CampaignStatus.ACCOUNT_SUSPENDED }).where(eq(schema.campaigns.id, id));
    const deleted = json(await owner.client.delete(`/api/v2/campaigns/${id}`));
    assert.match((await restore(deleted.recently_deleted_id)).message, /It's still suspended\./);
    assert.equal(json(await owner.client.get(`/api/v2/campaigns/${id}`)).status, CampaignStatus.ACCOUNT_SUSPENDED);
    expectStatus(await owner.client.post(`/api/v2/campaigns/${id}/activate`), 400);
  });

  it("brings back the Lead Finder agent that stocked it, paused", async () => {
    const id = await newCampaign("Stocked");
    const [agent] = await db
      .insert(schema.aiAgents)
      .values({ workspaceId: owner.workspaceId!, name: "Stocker", type: 6, status: 1, payload: { campaign_id: id, min_active_leads: 10 } })
      .returning();
    const status = async () => (await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agent!.id)))[0]!.status;
    const deleted = json(await owner.client.delete(`/api/v2/campaigns/${id}`));
    for (let i = 0; i < 20 && (await status()) !== -1; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(await status(), -1, "deleting the campaign stops the agent");

    await restore(deleted.recently_deleted_id);
    assert.equal(await status(), 0, "it comes back paused, to turn on when wanted");
    const events = await db.select().from(schema.aiAgentEvents).where(eq(schema.aiAgentEvents.agentId, agent!.id));
    assert.deepEqual(events.map((e) => e.eventType).sort(), ["campaign_not_found", "campaign_restored"]);
  });

  it("a bulk delete makes one entry per campaign", async () => {
    const ids = [await newCampaign("Bulk one"), await newCampaign("Bulk two")];
    const res = json(await owner.client.post("/api/app/campaigns/bulk", { ids, action: "delete" }));
    assert.equal(res.updated, 2);
    assert.equal(res.recently_deleted_ids.length, 2);
    const names = (await trash(owner.client, "campaign")).filter((e) => res.recently_deleted_ids.includes(e.id)).map((e) => e.name);
    assert.deepEqual(names.sort(), ["Bulk one", "Bulk two"]);
  });
});

describe("a deleted lead list", () => {
  it("comes back with its leads", async () => {
    const c = owner.client;
    const list = json(await c.post("/api/v2/lead-lists", { name: "Expo leads" }));
    for (const email of ["one@example.test", "two@example.test", "three@example.test"]) await addLead(email, { list_id: list.id });
    const leads = byId(await db.select().from(L).where(eq(L.listId, list.id)));
    assert.equal(leads.length, 3);

    const deleted = json(await c.delete(`/api/v2/lead-lists/${list.id}`));
    expectStatus(await c.get(`/api/v2/lead-lists/${list.id}`), 404);
    assert.equal((await db.select().from(L).where(eq(L.listId, list.id))).length, 0);
    const e = (await entry(deleted.recently_deleted_id))!;
    assert.equal(e.kind, "lead_list");
    assert.deepEqual(e.counts, { leads: 3 });

    const result = await restore(e.id);
    assert.equal(result.message, "“Expo leads” is back with 3 leads.");
    assert.equal(json(await c.get(`/api/v2/lead-lists/${list.id}`)).name, "Expo leads");
    assert.deepEqual(byId(await db.select().from(L).where(eq(L.listId, list.id))), leads);
  });
});

describe("deleted leads", () => {
  it("a bulk delete is one entry, and the leads go back where they were with their history", async () => {
    const c = owner.client;
    const id = await sentCampaign("Bulk source", ["a@example.test", "b@example.test", "c@example.test"]);
    expectStatus(await c.post(`/api/v2/campaigns/${id}/pause`), 200);
    const all = await leadsIn(id);
    await db.update(L).set({ status: LeadStatus.COMPLETED, interestStatus: 1 }).where(eq(L.id, all[0]!.id));
    const before = await leadsIn(id);
    const events = (await db.select().from(schema.emailEvents).where(eq(schema.emailEvents.campaignId, id))).length;
    const entries = (await trash(c, "leads")).length;

    const res = json(await c.post("/api/app/leads/delete", { ids: [before[0]!.id, before[1]!.id] }));
    assert.equal(res.count, 2);
    assert.equal((await trash(c, "leads")).length, entries + 1);
    const e = (await entry(res.recently_deleted_id))!;
    assert.equal(e.kind, "leads");
    assert.equal(e.name, "2 leads");
    assert.equal(e.context, "From “Bulk source”");
    assert.equal((await leadsIn(id)).length, 1);
    // A lead delete never touched events, and still doesn't.
    assert.equal((await db.select().from(schema.emailEvents).where(eq(schema.emailEvents.campaignId, id))).length, events);

    const result = await restore(e.id);
    assert.deepEqual(result.counts, { leads: 2, to_list: 0, skipped: 0 });
    assert.equal(result.link, `/app/campaign/${id}/leads`);
    assert.deepEqual(await leadsIn(id), before);
  });

  it("a lead whose campaign has the same address again goes to “Restored leads”", async () => {
    const c = owner.client;
    const id = await newCampaign("Re-added");
    const leadId = await addLead("twice@example.test", { campaign: id });
    const deleted = json(await c.delete(`/api/v2/leads/${leadId}`));
    assert.equal((await entry(deleted.recently_deleted_id))!.name, "Pat (twice@example.test)");
    await addLead("twice@example.test", { campaign: id });

    const result = await restore(deleted.recently_deleted_id);
    assert.deepEqual(result.counts, { leads: 1, to_list: 1, skipped: 0 });
    const [row] = await db.select().from(L).where(eq(L.id, leadId));
    assert.equal(row!.campaignId, null);
    const [list] = await db.select().from(schema.leadLists).where(eq(schema.leadLists.id, row!.listId!));
    assert.equal(list!.name, "Restored leads");
  });

  it("wait for their campaign when it's in Recently deleted too", async () => {
    const c = owner.client;
    const id = await newCampaign("Both gone");
    const leadId = await addLead("waiting@example.test", { campaign: id });
    const leadEntry = json(await c.delete(`/api/v2/leads/${leadId}`)).recently_deleted_id;
    const campaignEntry = json(await c.delete(`/api/v2/campaigns/${id}`)).recently_deleted_id;

    const refused = await c.post(`/api/app/recently-deleted/${leadEntry}/restore`);
    assert.match(json(refused, 409).message, /These leads were in “Both gone”, which is in Recently deleted too\. Restore the campaign first/);
    await restore(campaignEntry);
    assert.deepEqual(await restore(leadEntry).then((r) => r.counts), { leads: 1, to_list: 0, skipped: 0 });
    assert.deepEqual(
      (await leadsIn(id)).map((l) => l.id),
      [leadId],
    );
  });
});

describe("deleted templates and subsequences", () => {
  it("a template comes back", async () => {
    const c = owner.client;
    const t = json(await c.post("/api/app/templates", { name: "Intro", subject: "Quick question", body: "<p>Hi</p>" }));
    const deleted = json(await c.delete(`/api/app/templates/${t.id}`));
    const ids = async () => json(await c.get("/api/app/templates?type=email")).items.map((x: { id: string }) => x.id) as string[];
    assert.ok(!(await ids()).includes(t.id));
    assert.equal((await entry(deleted.recently_deleted_id))!.context, "Email template");
    await restore(deleted.recently_deleted_id);
    assert.ok((await ids()).includes(t.id));
  });

  it("a subsequence comes back paused, with its leads where they were in it", async () => {
    const c = owner.client;
    const id = await newCampaign("With follow-ups");
    const leadId = await addLead("follow@example.test", { campaign: id });
    const sub = json(await c.post("/api/v2/subsequences", { parent_campaign: id, name: "Warm", conditions: { crm_status: [1] } }));
    await db.update(schema.subsequences).set({ status: CampaignStatus.ACTIVE }).where(eq(schema.subsequences.id, sub.id));
    const due = Date.now() + DAY;
    await db.update(L).set({ subsequenceId: sub.id, subseqStatus: LeadStatus.ACTIVE, subseqNextStep: 1, subseqNextSendAt: due }).where(eq(L.id, leadId));

    const deleted = json(await c.delete(`/api/v2/subsequences/${sub.id}`));
    expectStatus(await c.get(`/api/v2/subsequences/${sub.id}`), 404);
    const [left] = await db.select().from(L).where(eq(L.id, leadId));
    assert.equal(left!.subsequenceId, null);
    assert.equal(left!.campaignId, id);
    const e = (await entry(deleted.recently_deleted_id))!;
    assert.equal(e.context, "In “With follow-ups”");
    assert.deepEqual(e.counts, { leads: 1 });

    const result = await restore(e.id);
    assert.match(result.message, /“Warm” is back in “With follow-ups” with 1 lead\. It's paused/);
    assert.equal(json(await c.get(`/api/v2/subsequences/${sub.id}`)).status, CampaignStatus.PAUSED);
    const [back] = await db.select().from(L).where(eq(L.id, leadId));
    assert.equal(back!.subsequenceId, sub.id);
    assert.equal(back!.subseqStatus, LeadStatus.ACTIVE);
    assert.equal(back!.subseqNextStep, 1);
    assert.equal(back!.subseqNextSendAt, due);
  });
});

describe("who may restore", () => {
  it("a view member sees what was deleted but can't restore it or delete it for good; an editor can", async () => {
    const id = await newCampaign("Viewer can see");
    const deleted = json(await owner.client.delete(`/api/v2/campaigns/${id}`));
    const viewer = await join("view");
    const seen = (await entry(deleted.recently_deleted_id, viewer.client))!;
    assert.equal(seen.can_restore, false);
    expectStatus(await viewer.client.post(`/api/app/recently-deleted/${seen.id}/restore`), 403);
    expectStatus(await viewer.client.delete(`/api/app/recently-deleted/${seen.id}`), 403);
    assert.ok(await entry(seen.id));

    const editor = await join("editor");
    assert.equal((await entry(seen.id, editor.client))!.can_restore, true);
    expectStatus(await editor.client.post(`/api/app/recently-deleted/${seen.id}/restore`), 200);
    expectStatus(await owner.client.get(`/api/v2/campaigns/${id}`), 200);
  });

  it("another workspace never sees, restores or deletes it", async () => {
    const id = await newCampaign("Not yours");
    const deleted = json(await owner.client.delete(`/api/v2/campaigns/${id}`));
    assert.equal(await entry(deleted.recently_deleted_id, stranger.client), undefined);
    expectStatus(await stranger.client.post(`/api/app/recently-deleted/${deleted.recently_deleted_id}/restore`), 404);
    expectStatus(await stranger.client.delete(`/api/app/recently-deleted/${deleted.recently_deleted_id}`), 404);
    assert.ok(await entry(deleted.recently_deleted_id));
    expectStatus(await stranger.client.get(`/api/v2/campaigns/${id}`), 404);
  });

  it("API keys can't reach it", async () => {
    const key = json(await owner.client.post("/api/v2/api-keys", { name: "Trash key", scopes: ["all:all"] })).key as string;
    expectStatus(await new TestClient(app, key).get("/api/app/recently-deleted"), 403);
  });
});

describe("blocking an address", () => {
  it("stops future emails but keeps the lead and its history", async () => {
    const c = owner.client;
    const id = await sentCampaign("Blocked later", ["blocked.later@example.test"], [step("Hi", "<p>First</p>"), step("", "<p>Second</p>")]);
    const sent = (await analytics(id)).emails_sent_count;
    assert.equal(sent, 1);
    const emails = (await db.select().from(schema.emails).where(eq(schema.emails.campaignId, id))).length;
    json(await c.post("/api/v2/block-lists-entries", { bl_value: "blocked.later@example.test" }));
    // The second step is due now.
    await db
      .update(L)
      .set({ nextSendAt: Date.now() - 1000 })
      .where(eq(L.campaignId, id));
    await runSender();

    const [lead] = await leadsIn(id);
    assert.equal(lead!.email, "blocked.later@example.test");
    assert.equal(lead!.status, LeadStatus.SKIPPED);
    assert.equal((await analytics(id)).emails_sent_count, sent);
    assert.equal((await db.select().from(schema.emails).where(eq(schema.emails.campaignId, id))).length, emails);
  });
});

describe("deleting for good", () => {
  it("“Delete forever” removes the entry and everything it kept", async () => {
    const c = owner.client;
    const id = await newCampaign("Gone for good");
    await addLead("gone@example.test", { campaign: id });
    const deleted = json(await c.delete(`/api/v2/campaigns/${id}`));
    assert.ok((await db.select().from(schema.deletedItemRows).where(eq(schema.deletedItemRows.entryId, deleted.recently_deleted_id))).length > 0);

    assert.deepEqual(json(await c.delete(`/api/app/recently-deleted/${deleted.recently_deleted_id}`)), { ok: true });
    assert.equal(await entry(deleted.recently_deleted_id), undefined);
    assert.equal((await db.select().from(schema.deletedItemRows).where(eq(schema.deletedItemRows.entryId, deleted.recently_deleted_id))).length, 0);
    expectStatus(await c.post(`/api/app/recently-deleted/${deleted.recently_deleted_id}/restore`), 404);
    expectStatus(await c.get(`/api/v2/campaigns/${id}`), 404);
  });

  it("an entry past 30 days can't be restored, and the daily purge removes it", async () => {
    const c = owner.client;
    const list = json(await c.post("/api/v2/lead-lists", { name: "Old list" }));
    await addLead("old@example.test", { list_id: list.id });
    const old = json(await c.delete(`/api/v2/lead-lists/${list.id}`)).recently_deleted_id as string;
    const fresh = json(await c.delete(`/api/app/templates/${json(await c.post("/api/app/templates", { name: "Fresh", body: "<p>Hi</p>" })).id}`)).recently_deleted_id as string;

    // Not purged before its 30 days are up.
    await purgeDeleted(Date.now() + 29 * DAY);
    assert.ok(await entry(old));

    await db
      .update(schema.deletedItems)
      .set({ createdAt: new Date(Date.now() - 31 * DAY), expiresAt: new Date(Date.now() - DAY) })
      .where(eq(schema.deletedItems.id, old));
    // Past 30 days it's gone from the list even before the purge runs.
    assert.equal(await entry(old), undefined);
    expectStatus(await c.post(`/api/app/recently-deleted/${old}/restore`), 404);

    assert.equal(await purgeDeleted(), 1);
    assert.equal((await db.select().from(schema.deletedItems).where(eq(schema.deletedItems.id, old))).length, 0);
    assert.equal((await db.select().from(schema.deletedItemRows).where(eq(schema.deletedItemRows.entryId, old))).length, 0);
    assert.ok(await entry(fresh));

    // 30 days on, everything still there goes too.
    assert.ok((await purgeDeleted(Date.now() + 31 * DAY)) >= 1);
    assert.deepEqual(await trash(), []);
    assert.equal((await db.select().from(schema.deletedItemRows)).length, 0);
    assert.equal((await db.select().from(L).where(and(eq(L.workspaceId, owner.workspaceId!), eq(L.email, "old@example.test")))).length, 0);
  });
});

describe("a delete still under way", () => {
  it("can't be restored while it's moving rows, however long it takes; one that stopped part-way can", () => {
    const now = Date.now();
    const deleting = { status: "deleting", createdAt: new Date(now - 30 * 60_000) };
    assert.equal(isReady({ ...deleting, movedAt: new Date(now - 60_000) }, now), false, "it moved rows a minute ago");
    assert.equal(isReady({ ...deleting, movedAt: new Date(now - 11 * 60_000) }, now), true, "it stopped part-way");
    assert.equal(isReady({ ...deleting, movedAt: null }, now), true);
    assert.equal(isReady({ status: "deleting", createdAt: new Date(now - 60_000), movedAt: null }, now), false, "it just started");
    assert.equal(isReady({ status: "ready", createdAt: new Date(now), movedAt: new Date(now) }, now), true);
  });

  it("notes when it last moved rows", async () => {
    const id = await newCampaign("Noted");
    await addLead("noted@trash.example.test", { campaign: id });
    const deleted = json(await owner.client.delete(`/api/v2/campaigns/${id}`));
    const [row] = await db.select().from(schema.deletedItems).where(eq(schema.deletedItems.id, deleted.recently_deleted_id));
    assert.ok(row?.movedAt, "the entry says when the delete last moved rows");
  });
});

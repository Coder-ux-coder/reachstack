// Importing, moving and editing leads: which duplicates are left out, what a move resets, what a bulk edit writes,
// and custom variables renamed, merged and removed across leads and the emails that use them.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { inferLeadTimezone, parseTimezone } from "@reachstack/shared";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";
import { issueToken } from "../src/services/auth-tokens";

const L = schema.leads;
const J = schema.backgroundJobs;

let app: FastifyInstance;
let user: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Mo", workspaceName: "Leads Co" });
});
after(stopServer);

async function waitForJob(id: string) {
  for (let i = 0; i < 100; i++) {
    await runPendingJobs();
    const [job] = await db.select().from(J).where(eq(J.id, id));
    if (job!.status === "success" || job!.status === "failed") return job!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("The job didn't finish");
}

const campaign = async (name: string) => json(await user.client.post("/api/app/campaigns", { name })).id as string;
const list = async (name: string) => json(await user.client.post("/api/v2/lead-lists", { name })).id as string;
const emailsIn = async (campaignId: string) => (await db.select({ email: L.email }).from(L).where(eq(L.campaignId, campaignId))).map((l) => l.email).sort();

async function importInto(target: { campaign_id?: string; list_id?: string }, emails: string[], flags: Record<string, boolean>) {
  const job = json(await user.client.post("/api/app/leads/import", { ...target, leads: emails.map((email) => ({ email })), source: "manual", ...flags }));
  return (await waitForJob(job.id)).result as Record<string, number>;
}

describe("a lead's own variables in a webhook", () => {
  it("never replace what the webhook says about the event", async () => {
    const [hook] = await db.insert(schema.webhooks).values({ workspaceId: user.workspaceId!, targetHookUrl: "https://hooks.invalid/leads", eventType: "lead_interested" }).returning();
    try {
      const id = await campaign("Webhook fields");
      const custom = { event_type: "spoofed", timestamp: "1999-01-01", workspace: "elsewhere", campaign_name: "Not this one", lead_id: "not-this-id", lead_email: "someone@else.example.test", industry: "Bakeries" };
      json(await user.client.post("/api/v2/leads/add", { campaign_id: id, leads: [{ email: "variables@example.test", first_name: "Val", custom_variables: custom }] }));
      const [lead] = await db.select().from(L).where(and(eq(L.campaignId, id), eq(L.email, "variables@example.test")));
      json(await user.client.post("/api/app/leads/status", { ids: [lead!.id], action: "interest", interest_value: 1 }));
      const [sent] = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.webhookId, hook!.id));
      const body = sent!.payload as Record<string, unknown>;
      assert.equal(body.event_type, "lead_interested");
      assert.equal(body.workspace, user.workspaceId);
      assert.ok(Math.abs(Date.parse(String(body.timestamp)) - Date.now()) < 60_000);
      assert.equal(body.campaign_name, "Webhook fields");
      assert.equal(body.lead_id, lead!.id);
      assert.equal(body.lead_email, "variables@example.test");
      assert.equal(body.industry, "Bakeries", "the lead's other variables are still there");
    } finally {
      await db.delete(schema.webhooks).where(eq(schema.webhooks.id, hook!.id));
    }
  });
});

describe("importing", () => {
  it("'any campaign' leaves out people in other campaigns, not people who are only in a list", async () => {
    const first = await campaign("First");
    const staging = await list("Staging");
    await importInto({ campaign_id: first }, ["in.campaign@example.test"], {});
    await importInto({ list_id: staging }, ["in.list@example.test"], {});

    const second = await campaign("Second");
    await importInto({ campaign_id: second }, ["in.campaign@example.test", "in.list@example.test", "new.person@example.test"], { skip_if_in_campaign: true });
    assert.deepEqual(await emailsIn(second), ["in.list@example.test", "new.person@example.test"]);

    const third = await campaign("Third");
    await importInto({ campaign_id: third }, ["in.campaign@example.test", "in.list@example.test", "other.new@example.test"], { skip_if_in_workspace: true });
    assert.deepEqual(await emailsIn(third), ["other.new@example.test"]);
  });

  it("takes the address out of a cell written as a name and address", async () => {
    const target = await campaign("Written loosely");
    const result = await importInto({ campaign_id: target }, ["Jo Doe <Jo.Doe@Example.test>", "mailto:sam@example.test", "nobody"], {});
    assert.deepEqual(await emailsIn(target), ["jo.doe@example.test", "sam@example.test"]);
    assert.equal(result.invalid_email_count, 1);
  });
});

describe("moving", () => {
  it("a move between campaigns with the duplicate check on moves the lead, and starts it fresh", async () => {
    const from = await campaign("Move from");
    const to = await campaign("Move to");
    await importInto({ campaign_id: from }, ["mover@example.test", "twice@example.test"], {});
    // The second person is also in a third campaign, so the check leaves them behind.
    await importInto({ campaign_id: await campaign("Elsewhere") }, ["twice@example.test"], {});
    await db.update(L).set({ openCount: 3, replyCount: 1 }).where(eq(L.campaignId, from));

    const job = json(await user.client.post("/api/v2/leads/move", { campaign: from, to_campaign_id: to, check_duplicates: true, check_duplicates_in_campaigns: true }));
    const done = await waitForJob(job.id);
    assert.equal(done.status, "success");
    assert.deepEqual(await emailsIn(to), ["mover@example.test"]);
    assert.deepEqual(await emailsIn(from), ["twice@example.test"]);
    const [moved] = await db.select().from(L).where(eq(L.campaignId, to));
    assert.equal(moved!.openCount, 0);
    assert.equal(moved!.replyCount, 0);
    assert.equal(moved!.nextStep, 0);
  });

  it("leaves invalid and risky addresses behind when asked", async () => {
    const from = await campaign("Verified from");
    const to = await campaign("Verified to");
    await importInto({ campaign_id: from }, ["fine@example.test", "broken@example.test"], {});
    await db.update(L).set({ verificationStatus: -1 }).where(eq(L.email, "broken@example.test"));
    const job = json(await user.client.post("/api/v2/leads/move", { campaign: from, to_campaign_id: to, skip_invalid_emails: true }));
    await waitForJob(job.id);
    assert.deepEqual(await emailsIn(to), ["fine@example.test"]);
  });
});

describe("editing many leads at once", () => {
  type Person = { email: string; jobTitle?: string; location?: string; timezone?: string; payload?: Record<string, unknown> };
  async function addPeople(target: { campaignId?: string; listId?: string }, people: Person[]) {
    const ids: string[] = [];
    for (let i = 0; i < people.length; i += 200) {
      const rows = await db
        .insert(L)
        .values(people.slice(i, i + 200).map((p) => ({ workspaceId: user.workspaceId!, campaignId: target.campaignId ?? null, listId: target.listId ?? null, email: p.email, jobTitle: p.jobTitle ?? null, location: p.location ?? null, timezone: p.timezone ?? null, payload: p.payload ?? null })))
        .returning({ id: L.id });
      ids.push(...rows.map((r) => r.id));
    }
    return ids;
  }
  const lead = async (id: string) => (await db.select().from(L).where(eq(L.id, id)))[0]!;
  const edit = (b: Record<string, unknown>) => user.client.post("/api/app/leads/edit", b);

  it("sets a field on the chosen leads only, and clears it", async () => {
    const listId = await list("Edit fields");
    const [a, b, c] = await addPeople({ listId }, ["a", "b", "c"].map((x) => ({ email: `${x}@edit.example.test`, jobTitle: "Old title" })));
    assert.deepEqual(json(await edit({ list_id: listId, ids: [a, b], field: "job_title", value: "  Head of Sales " })), { count: 2, job: null });
    assert.deepEqual([(await lead(a!)).jobTitle, (await lead(b!)).jobTitle, (await lead(c!)).jobTitle], ["Head of Sales", "Head of Sales", "Old title"]);

    json(await edit({ list_id: listId, ids: [a], field: "job_title", value: null }));
    json(await edit({ list_id: listId, ids: [b], field: "job_title", value: "   " }));
    assert.deepEqual([(await lead(a!)).jobTitle, (await lead(b!)).jobTitle], [null, null]);

    // Another workspace's leads aren't touched, whatever ids are sent.
    const other = await signUp(app, { firstName: "Other", workspaceName: "Other Co" });
    const res = await other.client.post("/api/app/leads/edit", { ids: [c], field: "job_title", value: "Taken over" });
    assert.equal(json(res).count, 0);
    assert.equal((await lead(c!)).jobTitle, "Old title");
  });

  it("sets and clears a custom variable for a whole campaign, keeping the others", async () => {
    const campaignId = await campaign("Edit variables");
    const [a, b] = await addPeople({ campaignId }, [
      { email: "one@vars.example.test", payload: { industry: "SaaS", size: "10" } },
      { email: "two@vars.example.test" },
    ]);
    assert.equal(json(await edit({ campaign: campaignId, variable: "industry", value: "Fintech" })).count, 2);
    assert.deepEqual((await lead(a!)).payload, { industry: "Fintech", size: "10" });
    assert.deepEqual((await lead(b!)).payload, { industry: "Fintech" });

    json(await edit({ campaign: campaignId, variable: "industry", value: "" }));
    assert.deepEqual((await lead(a!)).payload, { size: "10" });
    assert.equal((await lead(b!)).payload, null);
  });

  it("refuses what it can't do", async () => {
    const campaignId = await campaign("Edit refusals");
    for (const [b, message] of [
      [{ variable: "First_Name", value: "Jo" }, /lead's own fields/],
      [{ variable: "jobTitle", value: "CEO" }, /lead's own fields/],
      [{ variable: "a{b}", value: "x" }, /can't have/],
      [{ field: "job_title", variable: "role", value: "x" }, /Choose one field/],
      [{ value: "x" }, /Choose one field/],
      [{ field: "timezone", value: "Nowhere/Land" }, /Unknown timezone/],
      [{ field: "email", value: "x@example.test" }, /./],
    ] as const) {
      assert.match(json(await edit({ campaign: campaignId, ...b }), 400).message, message);
    }
  });

  it("moves a timezone worked out from the location along with it, and keeps one somebody gave", async () => {
    const listId = await list("Edit places");
    const chicago = inferLeadTimezone({ location: "Chicago, IL" });
    const london = inferLeadTimezone({ location: "London, United Kingdom" });
    assert.ok(chicago && london && chicago !== london);
    const [worked, given] = await addPeople({ listId }, [
      { email: "worked@zones.example.test", location: "Chicago, IL", timezone: chicago },
      { email: "given@zones.example.test", location: "Chicago, IL", timezone: "Asia/Tokyo" },
    ]);
    json(await edit({ list_id: listId, field: "location", value: "London, United Kingdom" }));
    assert.deepEqual([(await lead(worked!)).location, (await lead(worked!)).timezone], ["London, United Kingdom", london]);
    assert.deepEqual([(await lead(given!)).location, (await lead(given!)).timezone], ["London, United Kingdom", "Asia/Tokyo"]);

    // Clearing the timezone works it out again; setting one takes it as written.
    json(await edit({ list_id: listId, ids: [given], field: "timezone", value: null }));
    assert.equal((await lead(given!)).timezone, london);
    json(await edit({ list_id: listId, ids: [worked], field: "timezone", value: "EST" }));
    assert.equal((await lead(worked!)).timezone, parseTimezone("EST"));
  });

  it("edits a big selection with a background job", async () => {
    const listId = await list("Edit many");
    const ids = await addPeople({ listId }, Array.from({ length: 2_001 }, (_, i) => ({ email: `p${i}@many.example.test` })));
    const r = json(await edit({ list_id: listId, field: "company_name", value: "Acme" }));
    assert.equal(r.count, 2_001);
    const done = await waitForJob(r.job.id);
    assert.equal(done.status, "success");
    assert.deepEqual(done.result, { count: 2_001 });
    const names = await db.selectDistinct({ name: L.companyName }).from(L).where(inArray(L.id, ids));
    assert.deepEqual(names, [{ name: "Acme" }]);
  });
});

describe("custom variables", () => {
  const T = schema.emailTemplates;
  async function people(listId: string, payloads: Array<Record<string, unknown> | null>) {
    const rows = await db
      .insert(L)
      .values(payloads.map((payload, i) => ({ workspaceId: user.workspaceId!, listId, email: `v${i}@${listId.slice(-8)}.example.test`, payload })))
      .returning({ id: L.id });
    return rows.map((r) => r.id);
  }
  const payloadOf = async (id: string) => (await db.select({ p: L.payload }).from(L).where(eq(L.id, id)))[0]!.p;
  const variables = async () => json<{ items: Array<{ name: string; leads: number; example: string | null; used_in: Array<{ kind: string; name: string }> }> }>(await user.client.get("/api/app/lead-variables")).items;
  async function campaignUsing(name: string, subject: string, body: string) {
    const id = await campaign(name);
    json(await user.client.patch(`/api/v2/campaigns/${id}`, { sequences: [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject, body }] }] }] }));
    return id;
  }

  it("lists each variable with the leads that have a value and the emails that use it", async () => {
    const listId = await list("Variables listed");
    await people(listId, [{ sector: "SaaS" }, { sector: "  " }, { sector: "Retail", region: "EMEA" }, null]);
    await campaignUsing("Uses sector", "For {{Sector}} teams", "<p>Hi</p>");
    json(await user.client.post("/api/app/templates", { name: "Sector note", subject: "Note", body: "{{RANDOM | In {{sector}} | Hey}}" }));

    const sector = (await variables()).find((v) => v.name === "sector")!;
    assert.equal(sector.leads, 2);
    assert.ok(sector.example === "SaaS" || sector.example === "Retail");
    assert.deepEqual(sector.used_in.map((u) => `${u.kind}:${u.name}`).sort(), ["campaign:Uses sector", "template:Sector note"]);
    assert.deepEqual((await variables()).find((v) => v.name === "region")?.used_in, []);
  });

  it("renames a variable into one that exists, keeping values already there, and changes the emails that use it", async () => {
    const listId = await list("Variables merged");
    const [a, b, c] = await people(listId, [{ segment: "SaaS" }, { segment: "Retail", vertical: "Shops" }, { vertical: "Food", other: 1 }]);
    const campaignId = await campaignUsing("Uses segment", "Hi {{segment}}", "<p>{{RANDOM | In {{Segment | your field}} | Hey}}</p>");
    const [template] = await db.insert(T).values({ workspaceId: user.workspaceId!, name: "Segment template", subject: "{{segment}}", body: "<p>{{ segment }}</p>" }).returning();

    const r = json(await user.client.post("/api/app/lead-variables/rename", { name: "segment", to: "vertical" }));
    assert.deepEqual(r, { leads: 2, emails: 2, job: null });
    assert.deepEqual([await payloadOf(a!), await payloadOf(b!), await payloadOf(c!)], [{ vertical: "SaaS" }, { vertical: "Shops" }, { vertical: "Food", other: 1 }]);

    const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    assert.deepEqual(camp!.sequences[0]!.steps[0]!.variants[0], { subject: "Hi {{vertical}}", body: "<p>{{RANDOM | In {{vertical | your field}} | Hey}}</p>" });
    const [tpl] = await db.select().from(T).where(eq(T.id, template!.id));
    assert.deepEqual([tpl!.subject, tpl!.body], ["{{vertical}}", "<p>{{ vertical }}</p>"]);
    // The emails as they were are a version away.
    const versions = json(await user.client.get(`/api/app/campaigns/${campaignId}/sequence-versions`)).items;
    assert.equal(versions.length, 2);
  });

  it("can leave the emails as they are, and refuses names it can't take", async () => {
    const listId = await list("Variables checked");
    const [a] = await people(listId, [{ tier: "Gold" }]);
    const campaignId = await campaignUsing("Uses tier", "{{tier}}", "<p>{{tier}}</p>");
    assert.deepEqual(json(await user.client.post("/api/app/lead-variables/rename", { name: "tier", to: "Tier level", emails: false })), { leads: 1, emails: 0, job: null });
    assert.deepEqual(await payloadOf(a!), { "Tier level": "Gold" });
    const [camp] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    assert.equal(camp!.sequences[0]!.steps[0]!.variants[0]!.subject, "{{tier}}");

    for (const [b, status, message] of [
      [{ name: "Tier level", to: "firstName" }, 400, /lead's own fields/],
      [{ name: "Tier level", to: "a|b" }, 400, /can't have/],
      [{ name: "Tier level", to: "Tier level" }, 400, /its name already/],
      [{ name: "nobody has this", to: "x" }, 404, /./],
      [{ name: "lf_person_id", to: "x" }, 400, /Lead Finder uses it/],
      [{ name: "Tier level", to: "lf_person_id" }, 400, /Lead Finder uses it/],
    ] as const) {
      assert.match(json(await user.client.post("/api/app/lead-variables/rename", b), status).message, message);
    }
    assert.match(json(await user.client.post("/api/app/lead-variables/delete", { name: "nobody has this" }), 404).message, /./);
  });

  it("removes a variable from every lead that has it", async () => {
    const listId = await list("Variables removed");
    const [a, b] = await people(listId, [{ score: "9", keep: "yes" }, { score: "3" }]);
    assert.deepEqual(json(await user.client.post("/api/app/lead-variables/delete", { name: "score" })), { leads: 2, job: null });
    assert.deepEqual([await payloadOf(a!), await payloadOf(b!)], [{ keep: "yes" }, null]);
    assert.equal((await variables()).some((v) => v.name === "score"), false);

    // Another workspace's leads keep theirs.
    const other = await signUp(app, { firstName: "Pat", workspaceName: "Variables Elsewhere" });
    const [theirs] = await db.insert(L).values({ workspaceId: other.workspaceId!, email: "theirs@vars.example.test", payload: { score: "7" } }).returning({ id: L.id });
    assert.equal(json(await user.client.post("/api/app/lead-variables/delete", { name: "score" }), 404).statusCode, 404);
    assert.deepEqual(await payloadOf(theirs!.id), { score: "7" });
  });

  it("renames on many leads with a background job", async () => {
    const listId = await list("Variables at scale");
    const ids: string[] = [];
    for (let i = 0; i < 2_001; i += 200) {
      const rows = await db
        .insert(L)
        .values(Array.from({ length: Math.min(200, 2_001 - i) }, (_, k) => ({ workspaceId: user.workspaceId!, listId, email: `s${i + k}@scale.example.test`, payload: { batch: String(i + k) } })))
        .returning({ id: L.id });
      ids.push(...rows.map((r) => r.id));
    }
    const r = json(await user.client.post("/api/app/lead-variables/rename", { name: "batch", to: "batch_no" }));
    assert.equal(r.leads, 2_001);
    const done = await waitForJob(r.job.id);
    assert.equal(done.status, "success");
    const left = await db.select({ p: L.payload }).from(L).where(inArray(L.id, ids));
    assert.ok(left.every((l, i) => l.p && Object.keys(l.p).join() === "batch_no" && l.p.batch_no !== undefined), `lead ${left.findIndex((l) => !l.p?.batch_no)}`);
  });
});

describe("owners", () => {
  it("are only people in the workspace, wherever a lead, list, campaign or task gets one", async () => {
    const stranger = await signUp(app, { firstName: "Sly", workspaceName: "Elsewhere Co" });
    const target = await list("Assignments");
    const lead = json(await user.client.post("/api/v2/leads", { email: "assign.me@example.test", list_id: target }));
    const campaignId = json(await user.client.post("/api/app/campaigns", { name: "Owned here" })).id as string;
    const tries: Array<["post" | "patch", string, Record<string, unknown>]> = [
      ["patch", `/api/v2/leads/${lead.id}`, { assigned_to: stranger.id }],
      ["post", "/api/v2/leads/bulk-assign", { list_id: target, organization_user_ids: [user.id, stranger.id] }],
      ["post", "/api/v2/leads/move", { ids: [lead.id], to_list_id: target, assign_to: stranger.id }],
      ["post", "/api/v2/leads", { email: "other@example.test", list_id: target, assigned_to: stranger.id }],
      ["post", "/api/v2/leads/add", { list_id: target, leads: [{ email: "third@example.test", assigned_to: stranger.id }] }],
      ["post", "/api/v2/lead-lists", { name: "Theirs", owned_by: stranger.id }],
      ["patch", `/api/v2/lead-lists/${target}`, { owned_by: stranger.id }],
      ["post", "/api/v2/campaigns", { name: "Owned elsewhere", owned_by: stranger.id, campaign_schedule: { schedules: [{ name: "Weekdays", timing: { from: "09:00", to: "17:00" }, days: { "1": true }, timezone: "America/Chicago" }] } }],
      ["patch", `/api/v2/campaigns/${campaignId}`, { owned_by: stranger.id }],
      ["post", "/api/app/crm/tasks", { title: "Call them", assigned_to: stranger.id }],
    ];
    for (const [method, url, payload] of tries) {
      const refused = json(await user.client[method](url, payload), 400);
      assert.match(refused.message, /is not a member of this workspace/, `${method} ${url}`);
    }
    const owner = async () => (await db.select({ to: L.assignedTo }).from(L).where(eq(L.listId, target))).map((l) => l.to);
    assert.deepEqual(await owner(), [user.id], "nothing changed, nothing added");

    // Their own people are fine, and so is nobody.
    json(await user.client.patch(`/api/v2/leads/${lead.id}`, { assigned_to: null }));
    assert.deepEqual(await owner(), [null]);
    json(await user.client.post("/api/v2/leads/bulk-assign", { list_id: target, organization_user_ids: [user.id] }), 202);
    assert.deepEqual(await owner(), [user.id]);
    assert.equal(json(await user.client.patch(`/api/v2/campaigns/${campaignId}`, { owned_by: user.id })).owned_by, user.id);
    assert.equal(json(await user.client.get("/api/v2/lead-lists?search=Theirs")).items.length, 0, "no list was made");
  });

  it("of a workspace stay put when the new owner left before the change was confirmed", async () => {
    const boss = await signUp(app, { firstName: "Bo", workspaceName: "Handover Co" });
    const email = uniqueEmail("heir");
    const invite = json(await boss.client.post("/api/v2/workspace-members", { email, role: "admin" }));
    const heir = await signUp(app, { email, inviteToken: new URL(invite.invite_url).searchParams.get("token")! });
    const token = await issueToken("owner_change", { userId: boss.id, data: { workspace_id: boss.workspaceId, new_owner_user_id: heir.id }, ttlMs: 3_600_000 });
    await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, boss.workspaceId!), eq(schema.workspaceMembers.userId, heir.id)));

    const refused = json(await user.client.post("/api/app/workspaces/current/change-owner/confirm", { token }), 400);
    assert.match(refused.message, /no longer a member/);
    const [ws] = await db.select({ ownerId: schema.workspaces.ownerId }).from(schema.workspaces).where(eq(schema.workspaces.id, boss.workspaceId!));
    assert.equal(ws!.ownerId, boss.id);
  });
});

describe("notes", () => {
  it("can be kept on a lead without an email address, and only on this workspace's leads", async () => {
    const listId = await list("No addresses");
    const [noEmail] = await db.insert(L).values({ workspaceId: user.workspaceId!, listId, firstName: "Noor", phone: "+15550100" }).returning({ id: L.id });
    const note = json(await user.client.post("/api/app/lead-notes", { lead_email: null, lead_id: noEmail!.id, body: "Call back Tuesday" }));
    const notesOf = async (leadId: string) => json<{ items: Array<{ id: string; body: string }> }>(await user.client.get(`/api/app/lead-notes?lead_id=${leadId}`)).items.map((n) => [n.id, n.body]);
    assert.deepEqual(await notesOf(noEmail!.id), [[note.id, "Call back Tuesday"]]);

    // Another workspace can't file a note under this lead: without an address it's refused, with one the lead is left off.
    const other = await signUp(app, { firstName: "Oz", workspaceName: "Other Co" });
    expectStatus(await other.client.post("/api/app/lead-notes", { lead_id: noEmail!.id, body: "Not yours" }), 404);
    const filed = json(await other.client.post("/api/app/lead-notes", { lead_email: "oz@example.test", lead_id: noEmail!.id, body: "Filed by address" }));
    const [stored] = await db.select().from(schema.leadNotes).where(eq(schema.leadNotes.id, filed.id));
    assert.equal(stored!.leadId, null);
    assert.deepEqual(await notesOf(noEmail!.id), [[note.id, "Call back Tuesday"]]);

    expectStatus(await user.client.post("/api/app/lead-notes", { body: "About nobody" }), 400);
    expectStatus(await user.client.get("/api/app/lead-notes"), 400);
  });
});

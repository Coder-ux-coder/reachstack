// Sequence versions: every saved change to a campaign's or a subsequence's sequence is kept (the last 50), with who saved
// it and when. A version can be previewed and restored, and restoring is itself a new version.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const step = (subject: string, body: string, variants = 1) => ({
  type: "email",
  delay: 2,
  delay_unit: "days",
  variants: Array.from({ length: variants }, (_, i) => ({ subject: i ? `${subject} (${i + 1})` : subject, body })),
});
const seq = (...steps: ReturnType<typeof step>[]) => [{ steps }];

type Version = {
  id: string;
  created_at: string;
  created_by_name: string | null;
  source: string;
  restored_from: string | null;
  restored_from_at: string | null;
  current: boolean;
  steps: number;
  variants: number;
  summary: string;
  first_subject: string | null;
};

let app: FastifyInstance;
let owner: TestUser;
let stranger: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  owner = await signUp(app, { firstName: "Robin", workspaceName: "Versions Co" });
  stranger = await signUp(app, { firstName: "Sasha", workspaceName: "Other Co" });
});
after(stopServer);

const versions = async (path: string, client = owner.client) => json<{ items: Version[] }>(await client.get(`${path}/sequence-versions`)).items;
const newCampaign = async (name: string) => json(await owner.client.post("/api/app/campaigns", { name })).id as string;
const save = async (id: string, sequences: ReturnType<typeof seq>) => json(await owner.client.patch(`/api/v2/campaigns/${id}`, { sequences }));

describe("a campaign's sequence versions", () => {
  it("keep each saved change with who made it, and skip saves that change nothing", async () => {
    const id = await newCampaign("Versioned");
    const path = `/api/app/campaigns/${id}`;
    // A new campaign's blank step isn't worth keeping.
    assert.deepEqual(await versions(path), []);

    await save(id, seq(step("First try", "<p>Hello</p>")));
    await save(id, seq(step("Second try", "<p>Hi there</p>", 2), step("", "<p>Following up</p>"), step("", "<p>Last one</p>", 2)));
    await save(id, seq(step("Second try", "<p>Hi there</p>", 2), step("", "<p>Following up</p>"), step("", "<p>Last one</p>", 2)));
    json(await owner.client.patch(`/api/v2/campaigns/${id}`, { name: "Versioned (renamed)" }));

    const list = await versions(path);
    assert.equal(list.length, 2);
    const [newest, oldest] = list as [Version, Version];
    assert.equal(newest.summary, "3 steps, 5 variants");
    assert.equal(newest.first_subject, "Second try");
    assert.equal(newest.current, true);
    assert.equal(newest.source, "edit");
    assert.equal(newest.created_by_name, "Robin User");
    assert.equal(oldest.summary, "1 step, 1 variant");
    assert.equal(oldest.current, false);
    assert.ok(newest.created_at > oldest.created_at);
  });

  it("can be previewed, and restoring one saves it as a new version", async () => {
    const id = await newCampaign("Restorable");
    const path = `/api/app/campaigns/${id}`;
    await save(id, seq(step("First try", "<p>Hello</p>")));
    await save(id, seq(step("Second try", "<p>Hi</p>"), step("", "<p>Bump</p>")));
    const [newest, oldest] = (await versions(path)) as [Version, Version];

    const preview = json(await owner.client.get(`${path}/sequence-versions/${oldest.id}`));
    assert.deepEqual(preview.sequences, seq(step("First try", "<p>Hello</p>")));
    assert.equal(preview.current, false);
    assert.equal(json(await owner.client.get(`${path}/sequence-versions/${newest.id}`)).current, true);

    const campaign = json(await owner.client.post(`${path}/sequence-versions/${oldest.id}/restore`));
    assert.deepEqual(campaign.sequences, seq(step("First try", "<p>Hello</p>")));
    assert.deepEqual(json(await owner.client.get(`/api/v2/campaigns/${id}`)).sequences, seq(step("First try", "<p>Hello</p>")));

    const list = await versions(path);
    assert.deepEqual(
      list.map((v) => v.id).slice(1),
      [newest.id, oldest.id],
    );
    const restored = list[0]!;
    assert.equal(restored.source, "restore");
    assert.equal(restored.restored_from, oldest.id);
    assert.equal(restored.restored_from_at, oldest.created_at);
    assert.equal(restored.current, true);
    assert.equal(restored.created_by_name, "Robin User");

    // What the restore replaced is still there, so the restore can be undone the same way.
    json(await owner.client.post(`${path}/sequence-versions/${newest.id}/restore`));
    assert.equal(json(await owner.client.get(`/api/v2/campaigns/${id}`)).sequences[0].steps.length, 2);
    assert.equal((await versions(path)).length, 4);
  });

  it("keep what a campaign held before versions were kept", async () => {
    const id = await newCampaign("From before");
    await db
      .update(schema.campaigns)
      .set({ sequences: seq(step("Old copy", "<p>Written long ago</p>")) })
      .where(eq(schema.campaigns.id, id));
    await save(id, seq(step("New copy", "<p>Written today</p>")));
    const [newest, earlier] = (await versions(`/api/app/campaigns/${id}`)) as [Version, Version];
    assert.equal(newest.first_subject, "New copy");
    assert.equal(earlier.first_subject, "Old copy");
    assert.equal(earlier.source, "earlier");
    assert.equal(earlier.created_by_name, null);
  });

  it("keep the last 50", async () => {
    const id = await newCampaign("Busy");
    for (let i = 1; i <= 55; i++) await save(id, seq(step(`Take ${i}`, "<p>Body</p>")));
    const list = await versions(`/api/app/campaigns/${id}`);
    assert.equal(list.length, 50);
    assert.equal(list[0]!.first_subject, "Take 55");
    assert.equal(list.at(-1)!.first_subject, "Take 6");
    assert.equal((await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.campaignId, id))).length, 50);
  });

  it("start with the steps a campaign was made with, also for copies", async () => {
    const created = json(await owner.client.post("/api/v2/campaigns", { name: "Made with steps", campaign_schedule: ALWAYS_OPEN, sequences: seq(step("Hello", "<p>There</p>")) }));
    const [first] = await versions(`/api/app/campaigns/${created.id}`);
    assert.equal(first!.source, "create");
    assert.equal(first!.current, true);
    const copy = json(await owner.client.post(`/api/v2/campaigns/${created.id}/duplicate`, {}));
    assert.deepEqual(
      (await versions(`/api/app/campaigns/${copy.id}`)).map((v) => v.first_subject),
      ["Hello"],
    );
  });
});

describe("a subsequence's sequence versions", () => {
  it("are kept and restored like a campaign's, separately from the campaign's own", async () => {
    const id = await newCampaign("Parent");
    await save(id, seq(step("Parent step", "<p>Hi</p>")));
    const sub = json(await owner.client.post("/api/v2/subsequences", { parent_campaign: id, name: "Interested", conditions: { crm_status: [1] } }));
    const path = `/api/app/subsequences/${sub.id}`;
    json(await owner.client.patch(`/api/v2/subsequences/${sub.id}`, { sequences: seq(step("", "<p>Glad to hear it</p>")) }));
    json(await owner.client.patch(`/api/v2/subsequences/${sub.id}`, { sequences: seq(step("", "<p>Great, here's a time</p>"), step("", "<p>Checking in</p>")) }));

    const [newest, oldest] = (await versions(path)) as [Version, Version];
    assert.equal(newest.summary, "2 steps, 2 variants");
    assert.equal(oldest.summary, "1 step, 1 variant");
    assert.deepEqual(
      (await versions(`/api/app/campaigns/${id}`)).map((v) => v.first_subject),
      ["Parent step"],
    );

    const restored = json(await owner.client.post(`${path}/sequence-versions/${oldest.id}/restore`));
    assert.deepEqual(restored.sequences, seq(step("", "<p>Glad to hear it</p>")));
    const list = await versions(path);
    assert.equal(list.length, 3);
    assert.equal(list[0]!.restored_from, oldest.id);
  });
});

describe("who may see and restore versions", () => {
  it("a view member can look but not restore; another workspace can do neither", async () => {
    const id = await newCampaign("Guarded");
    await save(id, seq(step("One", "<p>1</p>")));
    await save(id, seq(step("Two", "<p>2</p>")));
    const path = `/api/app/campaigns/${id}`;
    const [, oldest] = (await versions(path)) as [Version, Version];

    const viewer = await signUp(app);
    const invite = json(await owner.client.post("/api/v2/workspace-members", { email: viewer.email, role: "view" }));
    json(await viewer.client.post(`/api/app/invitations/${encodeURIComponent(new URL(invite.invite_url).searchParams.get("token")!)}/accept`));
    assert.equal((await versions(path, viewer.client)).length, 2);
    expectStatus(await viewer.client.get(`${path}/sequence-versions/${oldest.id}`), 200);
    expectStatus(await viewer.client.post(`${path}/sequence-versions/${oldest.id}/restore`), 403);

    expectStatus(await stranger.client.get(`${path}/sequence-versions`), 404);
    expectStatus(await stranger.client.get(`${path}/sequence-versions/${oldest.id}`), 404);
    expectStatus(await stranger.client.post(`${path}/sequence-versions/${oldest.id}/restore`), 404);
    assert.equal(json(await owner.client.get(`/api/v2/campaigns/${id}`)).sequences[0].steps[0].variants[0].subject, "Two");
  });

  it("go to Recently deleted with their campaign and come back with it", async () => {
    const id = await newCampaign("Deleted with versions");
    await save(id, seq(step("Kept", "<p>Kept</p>")));
    await save(id, seq(step("Kept too", "<p>Kept too</p>")));
    const deleted = json(await owner.client.delete(`/api/v2/campaigns/${id}`));
    assert.equal((await db.select().from(schema.sequenceVersions).where(eq(schema.sequenceVersions.campaignId, id))).length, 0);
    json(await owner.client.post(`/api/app/recently-deleted/${deleted.recently_deleted_id}/restore`));
    assert.deepEqual(
      (await versions(`/api/app/campaigns/${id}`)).map((v) => v.first_subject),
      ["Kept too", "Kept"],
    );
  });
});

// A deleted workspace, or one whose owner was turned off or deleted, does no background work (services/live-workspaces.ts):
// its campaigns don't send and its mailboxes aren't synced, while their state stays as it was. Turning the owner back on
// picks up where it stopped.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { CampaignStatus } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { syncDueAccounts } from "../src/engine/inbox-sync";
import { runSender } from "../src/engine/sender";
import { workspaceInUse } from "../src/services/live-workspaces";

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};

let app: FastifyInstance;
let owner: TestUser;

before(async () => {
  app = await startServer();
  owner = await signUp(app); // the installation owner
});
after(stopServer);

/** A launched one-step campaign from a new sandbox mailbox, with one lead. */
async function launch(u: TestUser, domain: string) {
  const [mailbox] = json<{ items: Array<{ email: string }> }>(await u.client.post("/api/app/accounts/sandbox", { count: 1, domain, enable_warmup: false })).items;
  const created = json(await u.client.post("/api/app/campaigns", { name: `Outreach from ${domain}` }));
  json(
    await u.client.patch(`/api/v2/campaigns/${created.id}`, {
      email_list: [mailbox!.email],
      campaign_schedule: ALWAYS_OPEN,
      sequences: [{ steps: [{ type: "email", delay: 1, delay_unit: "days", variants: [{ subject: "Hi {{firstName}}", body: "<p>Hello {{firstName}}</p>" }] }] }],
    }),
  );
  json(await u.client.post("/api/v2/leads", { email: `pat@lead-of-${domain}`, first_name: "Pat", campaign: created.id }));
  expectStatus(await u.client.post(`/api/v2/campaigns/${created.id}/activate`), 200);
  return { campaignId: created.id as string, mailbox: mailbox!.email };
}

const sent = async (campaignId: string) =>
  (await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.campaignId, campaignId), eq(schema.emailEvents.type, "sent")))).length;
const campaignStatus = async (campaignId: string) => (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)))[0]!.status;
const lastSync = async (email: string) => (await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.email, email)))[0]!.lastSyncAt;

describe("stopped workspaces", () => {
  it("a deleted workspace sends nothing and isn't synced, while another carries on", async () => {
    const keeps = await signUp(app, { workspaceName: "Keeps Co" });
    const leaves = await signUp(app, { workspaceName: "Leaves Co" });
    const kept = await launch(keeps, "keeps-co.test");
    const gone = await launch(leaves, "leaves-co.test");

    expectStatus(await leaves.client.delete("/api/app/workspaces/current", { confirm_name: "Leaves Co" }), 200);
    assert.equal(await workspaceInUse(leaves.workspaceId!), false);

    await runSender();
    assert.equal(await sent(kept.campaignId), 1, "the live workspace sends");
    assert.equal(await sent(gone.campaignId), 0, "the deleted one doesn't");
    assert.equal(await campaignStatus(gone.campaignId), CampaignStatus.ACTIVE, "its campaign keeps its state");

    await syncDueAccounts();
    assert.ok(await lastSync(kept.mailbox), "the live mailbox is synced");
    assert.equal(await lastSync(gone.mailbox), null, "the deleted workspace's mailbox isn't");
  });

  it("turning an owner off stops their workspace; turning them back on resumes it", async () => {
    const paused = await signUp(app, { workspaceName: "Paused Co" });
    const { campaignId } = await launch(paused, "paused-co.test");

    expectStatus(await owner.client.patch(`/api/app/admin/users/${paused.id}`, { disabled: true }), 200);
    await runSender();
    assert.equal(await sent(campaignId), 0, "nothing goes out while the owner is turned off");

    expectStatus(await owner.client.patch(`/api/app/admin/users/${paused.id}`, { disabled: false }), 200);
    assert.equal(await workspaceInUse(paused.workspaceId!), true);
    await runSender();
    assert.equal(await sent(campaignId), 1, "back on: the campaign carries on");
  });
});

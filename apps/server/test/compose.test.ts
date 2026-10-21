// "New email" (POST /api/v2/emails/send): a fresh conversation rather than a reply. It gets its own thread, is tied to
// the lead with that address, refuses blocklisted and unsubscribed addresses, and can wait to be sent later. Every
// address here is made up.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { EmailType } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";

let app: FastifyInstance;
let user: TestUser;
let other: TestUser;
let mailbox: string;
let campaignId: string;
const LEAD = "jordan@prospect.test";

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Compose Co" });
  other = await signUp(app, { firstName: "Ola", workspaceName: "Other Co" });
  mailbox = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
  campaignId = json(await user.client.post("/api/app/campaigns", { name: "Compose" })).id;
  json(await user.client.post("/api/v2/leads", { email: LEAD, first_name: "Jordan", campaign: campaignId }));
});
after(stopServer);

const send = (u: TestUser, b: Record<string, unknown>) => u.client.post("/api/v2/emails/send", { eaccount: mailbox, subject: "Quick question", body: { html: "<p>Hello Jordan</p>" }, ...b });

describe("new email", () => {
  it("starts its own conversation and is tied to the lead", async () => {
    const before = await db.select().from(schema.emails).where(eq(schema.emails.workspaceId, user.workspaceId!));
    const e = json(await send(user, { to: ["Jordan@Prospect.test"] }));
    assert.equal(e.ue_type, EmailType.SENT);
    assert.equal(e.subject, "Quick question");
    assert.equal(e.eaccount, mailbox);
    assert.equal(e.lead, LEAD);
    assert.equal(e.campaign_id, campaignId);
    assert.ok(e.thread_id && !before.some((x) => x.threadId === e.thread_id), "a thread of its own");

    const [lead] = await db.select().from(schema.leads).where(and(eq(schema.leads.workspaceId, user.workspaceId!), eq(schema.leads.email, LEAD)));
    assert.ok(lead!.lastContactAt && Date.now() - lead!.lastContactAt.getTime() < 60_000, "the lead counts as contacted");
  });

  it("can go to someone who isn't a lead", async () => {
    const e = json(await send(user, { to: ["someone.new@elsewhere.test"], cc: ["copy@elsewhere.test"] }));
    assert.equal(e.ue_type, EmailType.SENT);
    assert.equal(e.lead_id ?? null, null);
    assert.equal(e.campaign_id ?? null, null);
  });

  it("waits when it's scheduled for later", async () => {
    const at = new Date(Date.now() + 3_600_000);
    const e = json(await send(user, { to: [LEAD], scheduled_at: at.toISOString() }));
    assert.equal(e.ue_type, EmailType.SCHEDULED);
    assert.equal(Date.parse(e.scheduled_at), at.getTime());
  });

  it("refuses blocklisted and unsubscribed addresses, wherever they are", async () => {
    expectStatus(await user.client.post("/api/v2/block-lists-entries", { bl_value: "blocked-co.test" }), 200);
    await db.insert(schema.unsubscribes).values({ workspaceId: user.workspaceId!, email: "gone@prospect.test" });
    const count = async () => (await db.select().from(schema.emails).where(eq(schema.emails.workspaceId, user.workspaceId!))).length;
    const n = await count();

    assert.match(json(await send(user, { to: ["anyone@blocked-co.test"] }), 400).message, /anyone@blocked-co\.test/);
    assert.match(json(await send(user, { to: [LEAD], bcc: ["gone@prospect.test"] }), 400).message, /gone@prospect\.test/);
    assert.equal(await count(), n, "nothing was stored");
  });

  it("needs a recipient, a subject and something to say", async () => {
    expectStatus(await send(user, { to: [] }), 400);
    expectStatus(await send(user, { to: ["not an address"] }), 400);
    expectStatus(await send(user, { to: [LEAD], subject: "  " }), 400);
    expectStatus(await send(user, { to: [LEAD], body: { html: "<p><br></p>" } }), 400);
  });

  it("only sends from the caller's own mailboxes", async () => {
    expectStatus(await send(other, { to: ["someone@elsewhere.test"] }), 404);
  });
});

// Webhooks and the public API: deliveries shared fairly between webhooks, failures counted once each, answers read
// only as far as needed, Lost heard by "all events" webhooks, headers and campaigns checked when saved, the delivery
// log kept 30 days; a domain's forwarding stays with its workspace; duplicates answer 409 with what's taken; a shared
// campaign leaves its workspace's agent, mailboxes and copy addresses behind; and lists page through every row once.
// Nothing leaves the process: deliveries go to a stand-in for the network. Every address and value here is made up.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AuditActivity } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { client, db, schema } from "../src/db/client";
import { uuidv7 } from "../src/lib/ids";
import { outbound } from "../src/lib/net";
import * as webhooks from "../src/services/webhooks";

const here = path.dirname(fileURLToPath(import.meta.url));
const W = schema.webhooks;
const EV = schema.webhookEvents;

let app: FastifyInstance;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
});
after(stopServer);

/** Deliveries go here instead of the network: each call is noted, and `answer` says what the endpoint replies. */
function standIn(answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const real = outbound.send;
  outbound.send = async (url) => {
    calls.push(String(url));
    return answer(String(url));
  };
  return { calls, restore: () => (outbound.send = real) };
}

/** A body of `chunks` pieces of 64 KB, counting how many were read and whether the reader let go. */
function bigBody(chunks: number) {
  const seen = { pulled: 0, cancelled: false };
  const piece = new Uint8Array(64 * 1024).fill(120);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(ctl) {
        if (seen.pulled >= chunks) return ctl.close();
        seen.pulled++;
        ctl.enqueue(piece);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

async function hook(user: TestUser, fields: Record<string, unknown>) {
  return json(await user.client.post("/api/v2/webhooks", fields));
}

const eventsOf = (hookId: string) => db.select().from(EV).where(eq(EV.webhookId, hookId)).orderBy(asc(EV.createdAt), asc(EV.id));

describe("webhook deliveries", () => {
  let user: TestUser;
  before(async () => {
    user = await signUp(app, { firstName: "Hana", workspaceName: "Hooks Co" });
  });

  it("one busy webhook doesn't hold up another: a few deliveries each per pass", async () => {
    const busy = await hook(user, { name: "Busy", target_hook_url: "https://93.184.216.34/busy", event_type: "email_sent" });
    const quiet = await hook(user, { name: "Quiet", target_hook_url: "https://93.184.216.34/quiet", event_type: "reply_received" });
    for (let i = 0; i < 12; i++) await webhooks.enqueueWebhooks(user.workspaceId!, "email_sent", { lead_email: `lead-${i}@prospect.test` });
    // The busy webhook's deliveries have waited longest.
    await db.update(EV).set({ nextRetryAt: new Date(Date.now() - 600_000) }).where(eq(EV.webhookId, busy.id));
    await webhooks.enqueueWebhooks(user.workspaceId!, "reply_received", { lead_email: "someone@prospect.test" });

    const net = standIn(() => new Response("ok", { status: 200 }));
    try {
      assert.equal(await webhooks.deliverDueWebhooks(6), 6);
    } finally {
      net.restore();
    }
    assert.equal(net.calls.filter((u) => u.endsWith("/quiet")).length, 1, "the quiet webhook got its delivery in the same pass");
    assert.equal(net.calls.filter((u) => u.endsWith("/busy")).length, 5, "the busy one got five, the rest wait for the next pass");
    assert.equal((await eventsOf(busy.id)).filter((e) => e.willRetry).length, 7);
    assert.ok((await eventsOf(quiet.id)).every((e) => e.success));
  });

  it("deliveries that give up together are each counted, and the webhook pauses once at 25", async () => {
    const shaky = await hook(user, { name: "Shaky", target_hook_url: "https://93.184.216.34/shaky", event_type: "email_bounced" });
    await db.update(W).set({ consecutiveFailures: 23 }).where(eq(W.id, shaky.id));
    for (let i = 0; i < 3; i++) await webhooks.enqueueWebhooks(user.workspaceId!, "email_bounced", { lead_email: `gone-${i}@prospect.test` });
    // Each is on its last try.
    await db.update(EV).set({ retryCount: 5 }).where(eq(EV.webhookId, shaky.id));

    const bodies: Array<ReturnType<typeof bigBody>["seen"]> = [];
    const net = standIn((url) => {
      if (!url.endsWith("/shaky")) return new Response("ok", { status: 200 });
      const { stream, seen } = bigBody(200); // 12.5 MB of error page
      bodies.push(seen);
      return new Response(stream, { status: 500 });
    });
    try {
      await webhooks.deliverDueWebhooks();
    } finally {
      net.restore();
    }
    assert.equal(net.calls.filter((u) => u.endsWith("/shaky")).length, 3);
    const [row] = await db.select().from(W).where(eq(W.id, shaky.id));
    assert.equal(row!.consecutiveFailures, 26, "three failures on top of 23");
    assert.equal(row!.status, -1, "paused");
    const errors = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.webhookId, shaky.id), eq(schema.auditLogs.activityType, AuditActivity.WEBHOOK_ERROR)));
    assert.equal(errors.length, 1, "paused once, noted once");

    const events = await eventsOf(shaky.id);
    assert.ok(events.every((e) => !e.willRetry && e.statusCode === 500));
    assert.match(events[0]!.errorMessage ?? "", /^HTTP 500: x+$/);
    assert.ok((events[0]!.errorMessage ?? "").length <= 320, "only the start of the error page is kept");
    for (const seen of bodies) {
      assert.ok(seen.pulled <= 4, `the error page was read only in part (${seen.pulled} of 200 pieces)`);
      assert.ok(seen.cancelled, "and let go of");
    }
  });

  it("a successful delivery's answer isn't read", async () => {
    const steady = await hook(user, { name: "Steady", target_hook_url: "https://93.184.216.34/steady", event_type: "lead_unsubscribed" });
    await webhooks.enqueueWebhooks(user.workspaceId!, "lead_unsubscribed", { lead_email: "bye@prospect.test" });
    let seen: ReturnType<typeof bigBody>["seen"] | null = null;
    const net = standIn((url) => {
      if (!url.endsWith("/steady")) return new Response("ok", { status: 200 });
      const big = bigBody(200);
      seen = big.seen;
      return new Response(big.stream, { status: 200 });
    });
    try {
      await webhooks.deliverDueWebhooks();
    } finally {
      net.restore();
    }
    const [ev] = await eventsOf(steady.id);
    assert.equal(ev!.success, true);
    assert.ok(seen, "delivered");
    const s = seen as ReturnType<typeof bigBody>["seen"];
    assert.ok(s.pulled <= 2 && s.cancelled, `the answer was let go of unread (${s.pulled} pieces read)`);
  });

  it("finished deliveries leave the log after 30 days; ones still being tried stay", async () => {
    const logged = await hook(user, { name: "Logged", target_hook_url: "https://93.184.216.34/logged", event_type: "campaign_completed" });
    const row = (id: string, willRetry: boolean, daysAgo: number) => ({
      id,
      workspaceId: user.workspaceId!,
      webhookId: logged.id,
      eventType: "campaign_completed",
      payload: { event_type: "campaign_completed" },
      webhookUrl: logged.target_hook_url,
      willRetry,
      success: !willRetry,
      createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    });
    const [oldDone, oldRetrying, recentDone] = [uuidv7(), uuidv7(), uuidv7()];
    await db.insert(EV).values([row(oldDone, false, 31), row(oldRetrying, true, 31), row(recentDone, false, 1)]);
    assert.ok((await webhooks.pruneWebhookEvents()) >= 1);
    const left = (await db.select({ id: EV.id }).from(EV).where(inArray(EV.id, [oldDone, oldRetrying, recentDone]))).map((r) => r.id);
    assert.deepEqual(left.sort(), [oldRetrying, recentDone].sort());
  });
});

describe("what webhooks hear, and what they can be set to", () => {
  let user: TestUser;
  let other: TestUser;
  before(async () => {
    user = await signUp(app, { firstName: "Ines", workspaceName: "Labels Co" });
    other = await signUp(app, { firstName: "Otto", workspaceName: "Elsewhere Co" });
  });

  it("marking a lead Lost reaches an \"all events\" webhook; a label with its own event isn't sent twice", async () => {
    const campaign = json(await user.client.post("/api/app/campaigns", { name: "Autumn" }));
    const lead = json(await user.client.post("/api/v2/leads", { email: "lost@prospect.test", campaign: campaign.id }));
    const all = await hook(user, { name: "Everything", target_hook_url: "https://93.184.216.34/all" });
    assert.equal(all.event_type, "all_events");

    expectStatus(await user.client.patch(`/api/v2/leads/${lead.id}`, { lt_interest_status: -3 }), 200);
    let heard = (await eventsOf(all.id)).map((e) => e.eventType);
    assert.deepEqual(
      heard.filter((t) => t.startsWith("lead_")),
      ["lead_interest_changed"],
      "Lost has no event of its own, so it arrives as a label change",
    );
    const [lost] = await eventsOf(all.id);
    assert.equal((lost!.payload as Record<string, unknown>).lead_email, "lost@prospect.test");

    expectStatus(await user.client.patch(`/api/v2/leads/${lead.id}`, { lt_interest_status: 1 }), 200);
    heard = (await eventsOf(all.id)).map((e) => e.eventType);
    assert.deepEqual(heard.filter((t) => t.startsWith("lead_")), ["lead_interest_changed", "lead_interested"], "Interested arrives once, as itself");
  });

  it("headers are checked when saved", async () => {
    const url = "https://93.184.216.34/headers";
    const refused = async (headers: Record<string, string>, why: RegExp) => {
      const res = await user.client.post("/api/v2/webhooks", { target_hook_url: url, headers });
      expectStatus(res, 400, JSON.stringify(headers).slice(0, 80));
      assert.match(res.body, why);
    };
    await refused({ "Team Name": "growth" }, /isn't a header name/);
    await refused({ "X-Note": "first line\r\nX-Injected: yes" }, /line breaks/);
    await refused({ Host: "elsewhere.test" }, /set for each delivery/);
    await refused({ "X-Webhook-Signature": "sha256=made-up" }, /set for each delivery/);
    await refused({ "Content-Length": "1" }, /set for each delivery/);
    await refused(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-Field-${i}`, "1"])), /up to 20 headers/);

    const ok = await hook(user, { target_hook_url: url, headers: { "X-Team": "growth", "X-Source": "Reachstack tests" } });
    assert.deepEqual(ok.headers, { "X-Team": "growth", "X-Source": "Reachstack tests" });
    const res = await user.client.patch(`/api/v2/webhooks/${ok.id}`, { headers: { "X-Team": "a\nb" } });
    expectStatus(res, 400);
    assert.match(res.body, /line breaks/);
  });

  it("a webhook can only be limited to one of its own workspace's campaigns", async () => {
    const theirs = json(await other.client.post("/api/app/campaigns", { name: "Not yours" }));
    const mine = json(await user.client.post("/api/app/campaigns", { name: "Yours" }));
    const res = await user.client.post("/api/v2/webhooks", { target_hook_url: "https://93.184.216.34/c", campaign: theirs.id });
    expectStatus(res, 400);
    assert.match(res.body, /no campaign with that id in this workspace/);
    expectStatus(await user.client.post("/api/v2/webhooks", { target_hook_url: "https://93.184.216.34/c", campaign: "no-such-campaign" }), 400);

    const h = await hook(user, { target_hook_url: "https://93.184.216.34/c", campaign: mine.id });
    assert.equal(h.campaign, mine.id);
    expectStatus(await user.client.patch(`/api/v2/webhooks/${h.id}`, { campaign: theirs.id }), 400);
    const cleared = json(await user.client.patch(`/api/v2/webhooks/${h.id}`, { campaign: null }));
    assert.equal(cleared.campaign, null);
  });
});

describe("domain forwarding", () => {
  it("a domain that forwards from one workspace isn't taken over by another", async () => {
    const one = await signUp(app, { firstName: "Una", workspaceName: "First Co" });
    const two = await signUp(app, { firstName: "Tom", workspaceName: "Second Co" });
    // Both have mailboxes at the domain (the same company's, connected in two workspaces).
    for (const u of [one, two]) await db.insert(schema.emailAccounts).values({ workspaceId: u.workspaceId!, email: "sales@shared-forward.test" });
    const url = "/api/v2/domains/shared-forward.test/forwarding";
    assert.equal(json(await one.client.put(url, { forwarding_domain: "first-site.test" })).forwarding_domain, "first-site.test");

    const res = await two.client.put(url, { forwarding_domain: "second-site.test" });
    expectStatus(res, 409);
    assert.match(res.json().message, /already forwards from another workspace/);
    assert.equal(json(await one.client.get(url)).forwarding_domain, "first-site.test", "the first workspace's setting is untouched");
    const [row] = await db.select().from(schema.domainForwarding).where(eq(schema.domainForwarding.domain, "shared-forward.test"));
    assert.equal(row!.workspaceId, one.workspaceId);

    // Its own workspace changes it as before.
    assert.equal(json(await one.client.put(url, { forwarding_domain: "first-site-new.test", forwarding_mode: "stealth" })).forwarding_domain, "first-site-new.test");
  });
});

describe("duplicates", () => {
  let user: TestUser;
  before(async () => {
    user = await signUp(app, { firstName: "Dana", workspaceName: "Dupes Co" });
  });

  it("a duplicate the database refuses answers 409, not a server error", async () => {
    // Stands in for two requests adding the same thing at once: the second meets the unique index.
    await client.execute("create unique index test_webhook_names_uq on webhooks (workspace_id, name)");
    try {
      await hook(user, { name: "Twice", target_hook_url: "https://93.184.216.34/twice" });
      const res = await user.client.post("/api/v2/webhooks", { name: "Twice", target_hook_url: "https://93.184.216.34/twice" });
      expectStatus(res, 409);
      assert.equal(res.json().code, "conflict");
      assert.match(res.json().message, /already exists/);
    } finally {
      await client.execute("drop index test_webhook_names_uq");
    }
  });

  it("renaming a tag to another tag's name says which name is taken", async () => {
    json(await user.client.post("/api/v2/custom-tags", { label: "Warm" }));
    const cold = json(await user.client.post("/api/v2/custom-tags", { label: "Cold" }));
    const res = await user.client.patch(`/api/v2/custom-tags/${cold.id}`, { label: "Warm" });
    expectStatus(res, 409);
    assert.match(res.json().message, /A tag named "Warm" already exists/);
    assert.equal(json(await user.client.patch(`/api/v2/custom-tags/${cold.id}`, { label: "Cold", color: "#336699" })).label, "Cold", "keeping its own name is fine");
  });

  it("changing a lead's address to one its campaign already has says so", async () => {
    const campaign = json(await user.client.post("/api/app/campaigns", { name: "Winter" }));
    json(await user.client.post("/api/v2/leads", { email: "kim@prospect.test", campaign: campaign.id }));
    const lee = json(await user.client.post("/api/v2/leads", { email: "lee@prospect.test", campaign: campaign.id }));
    const res = await user.client.patch(`/api/v2/leads/${lee.id}`, { email: "kim@prospect.test" });
    expectStatus(res, 409);
    assert.match(res.json().message, /kim@prospect\.test is already a lead in this campaign/);
    assert.equal(json(await user.client.patch(`/api/v2/leads/${lee.id}`, { email: "lee.new@prospect.test" })).email, "lee.new@prospect.test");
  });
});

describe("a campaign shared with another workspace", () => {
  let owner: TestUser;
  let guest: TestUser;
  let agentId = "";
  let sharedId = "";
  before(async () => {
    owner = await signUp(app, { firstName: "Olga", workspaceName: "Sharing Co" });
    guest = await signUp(app, { firstName: "Gus", workspaceName: "Importing Co" });
    const box = json(await owner.client.post("/api/app/accounts/sandbox", { count: 1, domain: "sharing-co.test", enable_warmup: false })).items[0].email;
    const [agent] = await db.insert(schema.aiSalesAgents).values({ workspaceId: owner.workspaceId!, name: "Sally", config: {} }).returning();
    agentId = agent!.id;
    sharedId = json(await owner.client.post("/api/app/campaigns", { name: "Agent's campaign" })).id;
    await db
      .update(schema.campaigns)
      .set({ aiSdrId: agentId, emailList: [box], ccList: ["desk@sharing-co.test"], bccList: ["archive@sharing-co.test"] })
      .where(eq(schema.campaigns.id, sharedId));
    expectStatus(await owner.client.post(`/api/v2/campaigns/${sharedId}/share`), 204);
  });

  it("is imported without its workspace's agent, mailboxes or copy addresses, and shows in the list", async () => {
    const copy = json(await guest.client.post(`/api/v2/campaigns/${sharedId}/from-export`));
    const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, copy.id));
    assert.equal(row!.workspaceId, guest.workspaceId);
    assert.equal(row!.aiSdrId, null);
    assert.deepEqual(row!.emailList, []);
    assert.deepEqual(row!.ccList, []);
    assert.deepEqual(row!.bccList, []);
    const listed = json(await guest.client.get("/api/v2/campaigns?limit=100")).items.map((c: { id: string }) => c.id);
    assert.ok(listed.includes(copy.id), "the imported campaign is in the guest's list");

    // Imported back into its own workspace, it keeps them.
    const own = json(await owner.client.post(`/api/v2/campaigns/${sharedId}/from-export`));
    const [mine] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, own.id));
    assert.equal(mine!.aiSdrId, agentId);
    assert.deepEqual(mine!.ccList, ["desk@sharing-co.test"]);
  });

  it("links left by earlier imports are cleared when the installation updates", async () => {
    const stale = json(await guest.client.post("/api/app/campaigns", { name: "Imported before the fix" })).id;
    await db.update(schema.campaigns).set({ aiSdrId: agentId }).where(eq(schema.campaigns.id, stale));
    const migration = readFileSync(path.join(here, "../drizzle/0032_sales_agent_links.sql"), "utf8");
    await client.executeMultiple(migration);
    const rows = await db.select({ id: schema.campaigns.id, agent: schema.campaigns.aiSdrId }).from(schema.campaigns).where(inArray(schema.campaigns.id, [stale, sharedId]));
    const agentOf = new Map(rows.map((r) => [r.id, r.agent]));
    assert.equal(agentOf.get(stale), null, "another workspace's agent is let go");
    assert.equal(agentOf.get(sharedId), agentId, "a campaign keeps its own workspace's agent");
  });

  it("an agent is deleted once its own workspace's campaigns have left it, whatever another workspace holds", async () => {
    const stale = json(await guest.client.post("/api/app/campaigns", { name: "Still linked elsewhere" })).id;
    await db.update(schema.campaigns).set({ aiSdrId: agentId }).where(eq(schema.campaigns.id, stale));
    const blocked = await owner.client.delete(`/api/v2/ai-agents/sales/${agentId}`);
    expectStatus(blocked, 409);
    assert.match(blocked.json().message, /still has 2 campaign\(s\)/, "the owner's own two campaigns count; the guest's doesn't");
    await db
      .update(schema.campaigns)
      .set({ aiSdrId: null })
      .where(and(eq(schema.campaigns.workspaceId, owner.workspaceId!), eq(schema.campaigns.aiSdrId, agentId)));
    expectStatus(await owner.client.delete(`/api/v2/ai-agents/sales/${agentId}`), 200);
  });
});

describe("paging", () => {
  let user: TestUser;
  before(async () => {
    user = await signUp(app, { firstName: "Paz", workspaceName: "Paging Co" });
  });

  /** Follows next_starting_after to the end, one page at a time. */
  async function walk(page: (after: string | null) => Promise<{ items: Array<{ id: string }>; next_starting_after: string | null }>) {
    const seen: Array<{ id: string }> = [];
    let cursor: string | null = null;
    for (let n = 0; n < 50; n++) {
      const p = await page(cursor);
      seen.push(...p.items);
      if (!p.next_starting_after) return seen;
      cursor = p.next_starting_after;
    }
    throw new Error("the pages never ended");
  }

  it("background jobs page in the order asked for, ties included, every job once", async () => {
    const base = Date.now() - 3_600_000;
    const at = [0, 0, 0, 5, 5, 9, 2]; // minutes after base, with ties, and not in id order
    const ids: string[] = [];
    for (const m of at) {
      const id = uuidv7();
      ids.push(id);
      await db.insert(schema.backgroundJobs).values({
        id,
        workspaceId: user.workspaceId!,
        type: m === 9 ? "export" : "import",
        status: "success",
        createdAt: new Date(base + m * 60_000),
        updatedAt: new Date(base + (10 - m) * 60_000),
      });
    }
    const expected = (key: (i: number) => number, dir: 1 | -1) =>
      ids
        .map((id, i) => ({ id, v: key(i) }))
        .sort((x, y) => (x.v - y.v || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)) * dir)
        .map((r) => r.id);
    const list = (qs: string) => async (after: string | null) =>
      json(await user.client.get(`/api/v2/background-jobs?limit=2&${qs}${after ? `&starting_after=${after}` : ""}`)) as { items: Array<{ id: string }>; next_starting_after: string | null };

    const asc = (await walk(list("sort_order=asc"))).map((j) => j.id);
    assert.deepEqual(asc, expected((i) => at[i]!, 1), "oldest first");
    const desc = (await walk(list("sort_order=desc"))).map((j) => j.id);
    assert.deepEqual(desc, expected((i) => at[i]!, -1), "newest first");
    const byUpdate = (await walk(list("sort_column=updated_at&sort_order=asc"))).map((j) => j.id);
    assert.deepEqual(byUpdate, expected((i) => 10 - at[i]!, 1), "by when they last changed");

    // A job added by included_ids comes once, not on every page.
    const exportId = ids[at.indexOf(9)]!;
    const imports = (await walk(list(`type=import&included_ids=${exportId}`))).map((j) => j.id);
    assert.equal(imports.length, 7);
    assert.equal(new Set(imports).size, 7);

    const gone = await user.client.get(`/api/v2/background-jobs?starting_after=${uuidv7()}`);
    expectStatus(gone, 400);
    assert.match(gone.body, /no longer exists/);
  });

  it("one lead per address pages through every address once, past runs of repeats", async () => {
    const older = json(await user.client.post("/api/app/campaigns", { name: "Older" })).id;
    const newer = json(await user.client.post("/api/app/campaigns", { name: "Newer" })).id;
    const add = async (local: string, campaign: string) => json(await user.client.post("/api/v2/leads", { email: `${local}@prospect.test`, campaign }));
    for (const l of ["e4", "e5", "e1", "e2", "e3"]) await add(l, older);
    for (const l of ["e1", "e2", "e3"]) await add(l, newer);

    const pages: string[][] = [];
    const leads = await walk(async (after) => {
      const p = json(await user.client.post("/api/v2/leads/list", { distinct_contacts: true, limit: 3, ...(after ? { starting_after: after } : {}) }));
      pages.push(p.items.map((l: { email: string }) => l.email.split("@")[0]));
      return p;
    });
    const emails = (leads as Array<{ id: string; email?: string }>).map((l) => l.email!.split("@")[0]);
    assert.deepEqual(emails, ["e3", "e2", "e1", "e5", "e4"], `pages: ${JSON.stringify(pages)}`);
    const newest = await db.select({ id: schema.leads.id }).from(schema.leads).where(eq(schema.leads.campaignId, newer));
    const ids = new Set(newest.map((r) => r.id));
    assert.ok(leads.slice(0, 3).every((l) => ids.has(l.id)), "each address is shown with its newest lead");
  });

  it("mailboxes sorted by a column page with next_starting_after", async () => {
    json(await user.client.post("/api/app/accounts/sandbox", { count: 5, domain: "paging-co.test", enable_warmup: false }));
    for (const sort of ["email", "health_score"]) {
      const all = (
        await walk(async (after) => json(await user.client.get(`/api/v2/accounts?sort_by=${sort}&sort_order=asc&limit=2${after ? `&starting_after=${after}` : ""}`)) as never)
      ).map((a) => (a as unknown as { email: string }).email);
      assert.equal(all.length, 5, sort);
      assert.equal(new Set(all).size, 5, `${sort}: no mailbox twice`);
      if (sort === "email") assert.deepEqual(all, [...all].sort());
    }
  });
});

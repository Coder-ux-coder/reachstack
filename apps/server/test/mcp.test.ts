// The MCP server at /mcp: who may use it (an API key, never a session cookie, never another website), the protocol
// (initialize, tools/list, tools/call, batches, notifications), and the tools, driven through a whole campaign on test
// mailboxes: mail stays inside the process. Every address and value here is made up.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { EmailType } from "@reachstack/shared";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client";
import { REPO_ROOT } from "../src/env";
import { uuidv7 } from "../src/lib/ids";
import { MCP_TOOLS } from "../src/services/mcp-tools";

let app: FastifyInstance;
let owner: TestUser;
let fullKey = "";
let readKey = "";

before(async () => {
  app = await startServer();
  owner = await signUp(app, { firstName: "Olive", workspaceName: "Olive Outreach" });
  fullKey = json(await owner.client.post("/api/v2/api-keys", { name: "Assistant", scopes: ["all:all"] })).key;
  readKey = json(await owner.client.post("/api/v2/api-keys", { name: "Reader", scopes: ["all:read"] })).key;
});
after(stopServer);

let seq = 0;

function rpc(key: string | null, body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    payload: JSON.stringify(body),
  });
}

async function call(key: string, name: string, args: Record<string, unknown> = {}) {
  const id = ++seq;
  const res = await rpc(key, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  expectStatus(res, 200, name);
  const out = res.json();
  assert.equal(out.id, id);
  const text: string = out.result.content[0].text;
  return { isError: out.result.isError as boolean, text };
}

/** A tool that should work: its answer, read back from the JSON it wrote. */
async function use<T = Record<string, any>>(name: string, args: Record<string, unknown> = {}, key = fullKey): Promise<T> {
  const r = await call(key, name, args);
  assert.equal(r.isError, false, `${name}: ${r.text}`);
  return JSON.parse(r.text) as T;
}

describe("who may use it", () => {
  it("wants an API key: none, a wrong one, or only a session cookie are turned away", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const none = await rpc(null, ping);
    expectStatus(none, 401);
    assert.match(String(none.headers["www-authenticate"]), /^Bearer/);
    assert.match(none.json().error.message, /API key/);
    expectStatus(await rpc("rs_not-a-real-key", ping), 401);
    expectStatus(await rpc(null, ping, { cookie: `rs_sid=${owner.client.cookie}` }), 401);
    expectStatus(await rpc(fullKey, ping), 200);
  });

  it("answers this computer's pages and no other website's", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    expectStatus(await rpc(fullKey, init, { origin: "https://evil.example" }), 403);
    expectStatus(await rpc(fullKey, init, { origin: "http://localhost:6274" }), 200);
    const preflight = (origin: string) =>
      app.inject({ method: "OPTIONS", url: "/mcp", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,mcp-protocol-version" } });
    assert.equal((await preflight("http://localhost:6274")).headers["access-control-allow-origin"], "http://localhost:6274");
    assert.equal((await preflight("https://evil.example")).headers["access-control-allow-origin"], undefined);
  });

  it("refuses a protocol version it doesn't speak, and says what it is to anything but POST", async () => {
    expectStatus(await rpc(fullKey, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" }), 400);
    expectStatus(await rpc(fullKey, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-06-18" }), 200);
    const get = await app.inject({ method: "GET", url: "/mcp" });
    expectStatus(get, 405);
    assert.equal(get.headers.allow, "POST");
    // OAuth discovery finds nothing (rather than the web app's page).
    const discovery = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expectStatus(discovery, 404);
    assert.match(String(discovery.headers["content-type"]), /json/);
  });
});

describe("the protocol", () => {
  it("initializes with the version asked for, or its newest", async () => {
    const asked = json(await rpc(fullKey, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    assert.equal(asked.result.protocolVersion, "2025-03-26");
    assert.equal(asked.result.serverInfo.name, "reachstack");
    assert.ok(asked.result.capabilities.tools);
    assert.match(asked.result.instructions, /launch_campaign/);
    const other = json(await rpc(fullKey, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2030-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    assert.equal(other.result.protocolVersion, "2025-11-25");
  });

  it("takes notifications without an answer, and batches", async () => {
    const note = await rpc(fullKey, { jsonrpc: "2.0", method: "notifications/initialized" });
    expectStatus(note, 202);
    assert.equal(note.body, "");
    const batch = json(await rpc(fullKey, [{ jsonrpc: "2.0", id: 7, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 8, method: "nope" }]));
    assert.equal(batch.length, 2);
    assert.deepEqual(batch[0], { jsonrpc: "2.0", id: 7, result: {} });
    assert.equal(batch[1].error.code, -32601);
  });

  it("lists every tool with a JSON Schema for its input", async () => {
    const { tools } = json(await rpc(fullKey, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result;
    const names = tools.map((t: { name: string }) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of ["get_overview", "connect_email_account", "create_test_mailboxes", "create_campaign", "launch_campaign", "add_leads", "list_replies", "reply_to_email", "search_lead_finder", "api_request"]) {
      assert.ok(names.includes(name), name);
    }
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.ok(t.description.length > 20, t.name);
      assert.equal(t.inputSchema.$schema, undefined, t.name);
    }
    const create = tools.find((t: { name: string }) => t.name === "create_campaign");
    assert.deepEqual(create.inputSchema.required.sort(), ["name", "steps"]);
    assert.equal(tools.find((t: { name: string }) => t.name === "list_campaigns").annotations.readOnlyHint, true);
    assert.equal(tools.find((t: { name: string }) => t.name === "launch_campaign").annotations.openWorldHint, true);
  });

  it("says when a tool doesn't exist, and what's wrong with arguments", async () => {
    const unknown = json(await rpc(fullKey, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "launch_rockets", arguments: {} } }));
    assert.equal(unknown.error.code, -32602);
    const bad = await call(fullKey, "create_campaign", { name: "No steps" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /steps/);
  });
});

describe("a campaign, start to finish", () => {
  let campaignId = "";
  let mailboxes: string[] = [];

  it("starts from an empty workspace", async () => {
    const o = await use("get_overview");
    assert.equal(o.workspace.name, "Olive Outreach");
    assert.equal(o.email_accounts.total, 0);
    assert.equal(o.unread_replies, 0);
  });

  it("makes test mailboxes to send from", async () => {
    const r = await use("create_test_mailboxes", { count: 2, domain: "olive-demo.test" });
    mailboxes = r.created.map((m: { email: string }) => m.email);
    assert.equal(mailboxes.length, 2);
    assert.ok(r.created.every((m: { test_mailbox: boolean; status: string }) => m.test_mailbox && m.status === "Active"));
    assert.equal((await use("list_email_accounts")).total, 2);
  });

  it("creates a campaign from steps, days and hours", async () => {
    const c = await use("create_campaign", {
      name: "Olive's first campaign",
      steps: [
        { subject: "Quick question, {{firstName}}", body: "Hi {{firstName | there}},\nWould {{companyName}} like fewer late invoices?" },
        { wait_days: 2, body: "Just bumping this up." },
        { wait_days: 4, variants: [{ subject: "Last note", body: "Closing the loop." }, { subject: "Should I stop?", body: "Happy to leave it here." }] },
      ],
      use_all_mailboxes: true,
      schedule: { days: ["weekdays"], from: "08:00", to: "18:00", timezone: "Europe/Berlin" },
      daily_limit: 40,
    });
    campaignId = c.id;
    assert.equal(c.status, "Draft");
    assert.deepEqual(c.mailboxes.sort(), [...mailboxes].sort());
    assert.deepEqual(c.schedule.days, ["monday", "tuesday", "wednesday", "thursday", "friday"]);
    assert.equal(c.schedule.timezone, "Europe/Berlin");
    assert.equal(c.steps[0].body, "Hi {{firstName | there}},<br/>Would {{companyName}} like fewer late invoices?");
    assert.equal(c.steps[1].wait_days, 2);
    assert.equal(c.steps[2].variants.length, 2);
    assert.equal(c.settings.daily_limit, 40);
    // Campaigns an assistant makes offer the unsubscribe header Gmail and Yahoo look for, unless it's turned off.
    assert.equal(c.settings.unsubscribe_header, true);
    // In the API's own terms each wait sits on the step before it.
    const raw = json(await owner.client.get(`/api/v2/campaigns/${campaignId}`));
    assert.deepEqual(raw.sequences[0].steps.map((s: { delay: number }) => s.delay).slice(0, 2), [2, 4]);
    assert.deepEqual(raw.campaign_schedule.schedules[0].days, { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false });
  });

  it("refuses mailboxes that aren't connected, naming the ones that are", async () => {
    const r = await call(fullKey, "create_campaign", { name: "Wrong sender", steps: [{ subject: "Hi", body: "Hello" }], mailboxes: ["nobody@elsewhere.test"] });
    assert.equal(r.isError, true);
    assert.match(r.text, /nobody@elsewhere\.test/);
    assert.ok(mailboxes.every((m) => r.text.includes(m)));
  });

  it("adds leads, and previews an email as one of them gets it", async () => {
    const added = await use("add_leads", {
      campaign_id: campaignId,
      leads: [
        { email: "interested.dana@prospect-co.test", first_name: "Dana", company_name: "Prospect Co" },
        { email: "sam@prospect-co.test", company_name: "Prospect Co" },
      ],
    });
    assert.equal(added.leads_uploaded, 2);
    const p = await use("preview_email", { campaign_id: campaignId, lead_email: "interested.dana@prospect-co.test" });
    assert.equal(p.subject, "Quick question, Dana");
    assert.match(p.text, /Hi Dana,\s+Would Prospect Co like fewer late invoices\?/);
    const fallback = await use("preview_email", { campaign_id: campaignId, lead_email: "sam@prospect-co.test" });
    assert.match(fallback.text, /^Hi there,/);
    assert.equal((await call(fullKey, "preview_email", { campaign_id: campaignId, lead_email: "stranger@prospect-co.test" })).isError, true);
    const leads = await use("list_leads", { campaign_id: campaignId });
    assert.equal(leads.total, 2);
  });

  it("checks it, launches it and says what it's doing", async () => {
    const check = await use("check_campaign", { campaign_id: campaignId });
    assert.equal(check.ready, true, JSON.stringify(check.problems));
    const launched = await use("launch_campaign", { campaign_id: campaignId });
    assert.equal(launched.status, "Active");
    const status = await use("campaign_status", { campaign_id: campaignId });
    assert.equal(typeof status.is_sending, "boolean");
    assert.ok(Array.isArray(status.reasons));
    assert.equal(status.details.accounts.total, 2);
    assert.equal(status.details.leads.active, 2);
    const details = await use("get_campaign", { campaign_id: campaignId });
    assert.equal(details.leads, 2);
    assert.equal(details.steps.length, 3);
  });

  it("won't launch a campaign with nothing to send from, and says why", async () => {
    const lonely = await use("create_campaign", { name: "No mailboxes", steps: [{ subject: "Hi", body: "Hello" }] });
    const r = await call(fullKey, "launch_campaign", { campaign_id: lonely.id });
    assert.equal(r.isError, true);
    assert.match(r.text, /sending account/);
  });

  it("changes part of the schedule and keeps the rest", async () => {
    const c = await use("update_campaign", { campaign_id: campaignId, schedule: { to: "16:30" } });
    assert.equal(c.schedule.from, "08:00");
    assert.equal(c.schedule.to, "16:30");
    assert.equal(c.schedule.timezone, "Europe/Berlin");
    assert.equal(c.steps.length, 3);
    assert.equal((await call(fullKey, "update_campaign", { campaign_id: campaignId })).isError, true);
  });

  it("labels a lead's interest and finds leads by it", async () => {
    await use("set_lead_interest", { email: "sam@prospect-co.test", interest: "meeting_booked" });
    const booked = await use("list_leads", { campaign_id: campaignId, interest: "meeting_booked" });
    assert.deepEqual(booked.leads.map((l: { email: string }) => l.email), ["sam@prospect-co.test"]);
    assert.equal(booked.leads[0].interest, "Meeting booked");
  });

  it("reads a reply and answers it in its thread", async () => {
    const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.email, "interested.dana@prospect-co.test"));
    const emailId = uuidv7();
    await db.insert(schema.emails).values({
      id: emailId,
      workspaceId: owner.workspaceId!,
      messageId: `<${emailId}@prospect-co.test>`,
      threadId: uuidv7(),
      subject: "Re: Quick question, Dana",
      fromAddress: lead!.email!,
      fromJson: [{ address: lead!.email!, name: "Dana" }],
      toList: mailboxes[0]!,
      leadEmail: lead!.email,
      leadId: lead!.id,
      campaignId,
      eaccount: mailboxes[0]!,
      ueType: EmailType.RECEIVED,
      bodyText: "Sounds useful. What does it cost?",
      bodyHtml: "<p>Sounds useful. What does it cost?</p>",
      contentPreview: "Sounds useful. What does it cost?",
      timestampEmail: new Date(),
      isUnread: 1,
    });
    assert.equal((await use("get_overview")).unread_replies, 1);
    const { replies } = await use("list_replies", { unread_only: true });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].from, "interested.dana@prospect-co.test");
    assert.equal(replies[0].to_mailbox, mailboxes[0]);
    const convo = await use("get_conversation", { lead_email: "interested.dana@prospect-co.test" });
    assert.ok(convo.emails.some((e: { text: string }) => e.text.includes("What does it cost?")));
    const sent = await use("reply_to_email", { email_id: emailId, body: "Thanks Dana!\nIt starts at $49 a month." });
    assert.equal(sent.sent, true);
    assert.equal(sent.from, mailboxes[0]);
    assert.equal(sent.subject, "Re: Quick question, Dana");
    await use("mark_thread_read", { thread_id: replies[0].thread_id });
    assert.equal((await use("get_overview")).unread_replies, 0);
  });

  it("pauses it, and reports results", async () => {
    assert.equal((await use("pause_campaign", { campaign_id: campaignId })).status, "Paused");
    const [row] = await use<Array<Record<string, any>>>("campaign_analytics", { campaign_id: campaignId });
    assert.equal(row!.leads, 2);
    const list = await use("list_campaigns");
    assert.ok(list.campaigns.some((c: { id: string; status: string }) => c.id === campaignId && c.status === "Paused"));
  });
});

describe("keys and the REST API", () => {
  it("does only what the key may: a read-only key reads and can't change", async () => {
    assert.equal((await use("list_campaigns", {}, readKey)).campaigns.length >= 1, true);
    const r = await call(readKey, "create_campaign", { name: "Not allowed", steps: [{ subject: "Hi", body: "Hello" }] });
    assert.equal(r.isError, true);
    assert.match(r.text, /campaigns:create/);
    const ov = await use("get_overview", {}, readKey);
    assert.equal(ov.workspace.name, "Olive Outreach");
  });

  it("calls any v2 endpoint, and nothing outside the API", async () => {
    const lists = await use("api_request", { method: "POST", path: "/api/v2/lead-lists", body: { name: "Made by an assistant" } });
    assert.equal(lists.name, "Made by an assistant");
    const page = await use("api_request", { method: "GET", path: "/api/v2/lead-lists?limit=5" });
    assert.ok(page.items.some((l: { id: string }) => l.id === lists.id));
    for (const path of ["/api/app/auth/me", "/api/v2/../app/auth/me", "https://evil.example/api/v2/campaigns"]) {
      const r = await call(fullKey, "api_request", { method: "GET", path });
      assert.equal(r.isError, true, path);
    }
    const ref = await use("api_reference", { search: "lead lists" });
    assert.ok(ref.endpoints.some((e: string) => e.startsWith("POST /api/v2/lead-lists")));
  });

  it("connects Google and Microsoft mailboxes by a sign-in link, once that sign-in is set up", async () => {
    const r = await call(fullKey, "connect_with_sign_in", { provider: "microsoft" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Microsoft/);
  });

  it("documents every tool in docs/agents.md", () => {
    const guide = readFileSync(path.join(REPO_ROOT, "docs", "agents.md"), "utf8");
    assert.deepEqual(MCP_TOOLS.map((t) => t.name).filter((name) => !guide.includes(`\`${name}\``)), []);
  });

  it("names days the way people say them, and refuses ones it can't read", async () => {
    const c = await use("create_campaign", { name: "Weekend", steps: [{ subject: "Hi", body: "Hello" }], schedule: { days: ["Sat", "sunday"] } });
    assert.deepEqual(c.schedule.days, ["sunday", "saturday"]);
    const r = await call(fullKey, "create_campaign", { name: "Bad day", steps: [{ subject: "Hi", body: "Hello" }], schedule: { days: ["funday"] } });
    assert.equal(r.isError, true);
    assert.match(r.text, /funday/);
  });
});

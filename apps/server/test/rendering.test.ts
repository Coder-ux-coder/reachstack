// What an email says on its way out: AI edits that keep links and images, a {{ left open, emails that come out blank
// for a lead, the preview and test email as the lead gets them, and templates in emails written by hand. Mailboxes
// are sandboxes and the AI is a local fake: nothing leaves the process.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as shared from "@reachstack/shared";
import { CampaignStatus, EmailType, LeadStatus, renderTemplate, timeVariables } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import * as agentText from "../src/services/agents/common";

// ---------- A local stand-in for the AI: it answers with `answer` and keeps what it was asked ----------

let answer: Record<string, unknown> = {};
let asked = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:9/")) throw new Error(`Tests must not use the network (fetch ${url})`);
  asked = typeof init?.body === "string" ? init.body : "";
  const message = { id: "msg_test", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: JSON.stringify(answer) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
}) as typeof fetch;

// ---------- Setup ----------

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const step = (subject: string, body: string) => ({ type: "email", delay: 1, delay_unit: "days", variants: [{ subject, body }] });

let app: FastifyInstance;
let user: TestUser;
let mailbox: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Rendering Co" });
  mailbox = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
  // No pause between this mailbox's emails, so a few sender passes send them all.
  await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, mailbox));
});
after(stopServer);

/** A campaign from the test mailbox with these steps and leads; launched unless `draft`. */
async function campaign(name: string, steps: unknown[], leads: Array<Record<string, unknown>>, opts: { extra?: Record<string, unknown>; draft?: boolean } = {}) {
  const c = user.client;
  const row = json(await c.post("/api/app/campaigns", { name }));
  json(await c.patch(`/api/v2/campaigns/${row.id}`, { email_list: [mailbox], campaign_schedule: ALWAYS_OPEN, email_gap: 0, random_wait_max: 0, sequences: [{ steps }], ...opts.extra }));
  for (const lead of leads) json(await c.post("/api/v2/leads", { ...lead, campaign: row.id }));
  if (!opts.draft) expectStatus(await c.post(`/api/v2/campaigns/${row.id}/activate`), 200);
  return row.id as string;
}

const sentEmails = (campaignId: string) =>
  db.select().from(schema.emails).where(and(eq(schema.emails.campaignId, campaignId), eq(schema.emails.ueType, EmailType.CAMPAIGN_SENT)));

async function sendAll(campaignId: string, expected: number) {
  for (let i = 0; i < 10 && (await sentEmails(campaignId)).length < expected; i++) await runSender();
}

const leadBy = async (email: string) => (await db.select().from(schema.leads).where(eq(schema.leads.email, email)))[0]!;

// ---------- Tests ----------

describe("a {{ left open", () => {
  it("isn't saved", async () => {
    const id = await campaign("Open brace", [step("Hi", "<p>Hi there</p>")], [], { draft: true });
    const res = await user.client.patch(`/api/v2/campaigns/${id}`, { sequences: [{ steps: [step("Hi", "<p>Hi {{firstName,</p>")] }] });
    expectStatus(res, 400);
    assert.match(json(res, 400).message, /curly braces/);
  });

  it("in a sequence saved before the check: the launch names the variant, and the sender passes it by", async () => {
    const id = await campaign("Saved broken", [step("Hi", "<p>Hi there</p>")], [{ email: "braces.lead@example.test", first_name: "Pat" }], { draft: true });
    const broken = {
      type: "email",
      delay: 1,
      delay_unit: "days",
      variants: [
        { subject: "A", body: "<p>Hi {{firstName,</p>" },
        { subject: "B", body: "<p>Hi {{firstName}}</p>" },
      ],
    };
    await db.update(schema.campaigns).set({ sequences: [{ steps: [broken] }] } as never).where(eq(schema.campaigns.id, id));
    const refused = await user.client.post(`/api/v2/campaigns/${id}/activate`);
    expectStatus(refused, 400);
    assert.match(json(refused, 400).message, /Step 1 variant A: Make sure all curly braces/);

    // Running anyway (it was launched before the check existed): only variant B goes out.
    await db.update(schema.campaigns).set({ status: CampaignStatus.ACTIVE }).where(eq(schema.campaigns.id, id));
    await sendAll(id, 1);
    const sent = await sentEmails(id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.subject, "B");
    assert.match(sent[0]!.bodyHtml ?? "", /Hi Pat/);
  });
});

describe("an email that comes out blank for a lead", () => {
  it("isn't sent: the lead waits, paused, its activity says why, and resuming once it's filled in sends it", async () => {
    const id = await campaign("Blank for some", [step("Hi", "<p>{{personalization}}</p>")], [
      { email: "blank.has@example.test", personalization: "Loved your talk on pricing." },
      { email: "blank.none@example.test" },
    ]);
    await sendAll(id, 1);
    for (let i = 0; i < 2; i++) await runSender();
    assert.deepEqual((await sentEmails(id)).map((e) => e.leadEmail), ["blank.has@example.test"]);

    const held = await leadBy("blank.none@example.test");
    assert.equal(held.status, LeadStatus.PAUSED);
    assert.equal(held.nextStep, 0);
    const notes = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, held.id), eq(schema.emailEvents.type, "not_sent")));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.detail ?? "", /^Step 1 came out blank: nothing for \{\{personalization\}\}\. Fill in the lead's details, then resume it\.$/);
    const activity = json(await user.client.get(`/api/app/leads/${held.id}/activity`));
    assert.ok(activity.events.some((e: { type: string }) => e.type === "not_sent"));

    json(await user.client.patch(`/api/v2/leads/${held.id}`, { personalization: "Saw the new office." }));
    assert.equal(json(await user.client.post("/api/app/leads/status", { ids: [held.id], action: "resume" })).affected, 1);
    await sendAll(id, 2);
    const late = (await sentEmails(id)).find((e) => e.leadEmail === "blank.none@example.test");
    assert.match(late?.bodyHtml ?? "", /Saw the new office\./);
  });

  it("the preview warns, and a test email isn't sent", async () => {
    const id = await campaign("Blank preview", [step("Hi", "<p>{{personalization}}</p>")], [{ email: "blank.preview@example.test" }], { draft: true });
    const lead = await leadBy("blank.preview@example.test");
    const p = json(await user.client.post(`/api/app/campaigns/${id}/preview`, { lead_id: lead.id }));
    assert.match(p.warnings[0], /comes out blank for this lead/);
    const res = await user.client.post(`/api/app/campaigns/${id}/test-email`, { to: mailbox, lead_id: lead.id });
    expectStatus(res, 400);
    assert.match(json(res, 400).message, /comes out blank for this lead: there's nothing for \{\{personalization\}\}/);
  });
});

describe("the preview", () => {
  it("shows the first email as plain text when that's how it goes out, and the others, and a subsequence's, as written", async () => {
    const id = await campaign("Plain first", [step("Hi", "<p>Hello <b>there</b></p>"), step("", "<p>Again <b>soon</b></p>")], [], { draft: true, extra: { first_email_text_only: true } });
    const first = json(await user.client.post(`/api/app/campaigns/${id}/preview`, { step: 0 }));
    assert.equal(first.text_only, true);
    assert.equal(first.body, "Hello there");
    const second = json(await user.client.post(`/api/app/campaigns/${id}/preview`, { step: 1 }));
    assert.equal(second.text_only, false);
    assert.match(second.body, /<b>soon<\/b>/);
    const sub = json(await user.client.post(`/api/app/campaigns/${id}/preview`, { step: 0, subsequence: true, subject: "", body: "<p>Hello <b>there</b></p>" }));
    assert.equal(sub.text_only, false);
  });

  it("follows the workspace's first-email preference too", async () => {
    json(await user.client.patch("/api/app/workspaces/current/settings", { first_email_text_only: true }));
    try {
      const id = await campaign("Plain by workspace", [step("Hi", "<p>Hello <i>you</i></p>")], [], { draft: true });
      const p = json(await user.client.post(`/api/app/campaigns/${id}/preview`, { step: 0 }));
      assert.equal(p.text_only, true);
      assert.equal(p.body, "Hello you");
    } finally {
      json(await user.client.patch("/api/app/workspaces/current/settings", { first_email_text_only: false }));
    }
  });
});

describe("AI edits", () => {
  it("spintax keeps the email's links and images where they were", async () => {
    const body = `<p>Hi {{firstName}}, see <a href="https://example.test/deck?a=1&amp;b=2">our deck</a>.</p><p><img src="https://example.test/chart.png" alt="Chart"></p>`;
    answer = { subject: "", body: "{{RANDOM | Hi | Hello}} {{firstName}}, see [our deck](https://example.test/deck?a=1&b=2).\n\n[image 1]" };
    const out = json(await user.client.post("/api/app/ai/spintax", { body }));
    assert.ok(asked.includes("[our deck](https://example.test/deck?a=1&b=2)"), "the AI sees the link as a marker");
    assert.ok(asked.includes("[image 1]"), "the AI sees the image as a marker");
    assert.match(out.body, /<a href="https:\/\/example\.test\/deck\?a=1&amp;b=2">our deck<\/a>/);
    assert.ok(out.body.includes(`<img src="https://example.test/chart.png" alt="Chart">`));
    assert.match(out.body, /\{\{RANDOM \| Hi \| Hello\}\}/);
  });

  it("a rewrite keeps them too, and a marker the AI made up stays as text", async () => {
    const body = `<p>Our <a href="https://example.test/pricing">pricing</a> is simple.</p><p><img src="https://example.test/logo.png"></p>`;
    answer = { subject: "", body: "Pricing is simple: [see it](https://example.test/pricing).\n\n[image 1] [image 7]" };
    const out = json(await user.client.post("/api/app/ai/write", { instruction: "Shorter", body }));
    assert.match(out.body, /<a href="https:\/\/example\.test\/pricing">see it<\/a>/);
    assert.ok(out.body.includes(`<img src="https://example.test/logo.png">`));
    assert.match(out.body, /\[image 7\]/);
  });
});

describe("links in AI replies", () => {
  it("leave out what ends the sentence, and keep brackets that belong to the address", () => {
    assert.equal(agentText.linkify("See https://example.test/a."), `See <a href="https://example.test/a">https://example.test/a</a>.`);
    assert.equal(agentText.linkify("(see https://example.test/a)"), `(see <a href="https://example.test/a">https://example.test/a</a>)`);
    assert.equal(agentText.linkify("https://example.test/wiki/Foo_(bar)"), `<a href="https://example.test/wiki/Foo_(bar)">https://example.test/wiki/Foo_(bar)</a>`);
    assert.equal(agentText.linkify("Book: https://example.test/b?x=1&amp;y=2!"), `Book: <a href="https://example.test/b?x=1&amp;y=2">https://example.test/b?x=1&amp;y=2</a>!`);
    assert.equal(agentText.textToParagraphs("Here: <https://example.test/c>"), `<p>Here: &lt;<a href="https://example.test/c">https://example.test/c</a>&gt;</p>`);
  });
});

describe("templates in emails written by hand", () => {
  it("fill the date and time on the lead's clock, the lead's details and an unsubscribe address", () => {
    const lead = { email: "ana@example.test", first_name: "Ana", timezone: "Asia/Tokyo", linkedin_url: "https://linkedin.example.test/in/ana", location: "Osaka" };
    const vars = shared.writtenEmailVariables(lead, { email: "sam@rendering.test", first_name: "Sam" }, "America/New_York");
    assert.equal(vars.today, timeVariables(new Date(), "Asia/Tokyo").today);
    assert.equal(vars.linkedinUrl, "https://linkedin.example.test/in/ana");
    assert.equal(vars.location, "Osaka");
    assert.equal(vars.unsubscribe_url, "mailto:sam@rendering.test?subject=unsubscribe");
    const out = renderTemplate("Happy {{day_of_week}}, {{firstName}}. {{sendingAccountFirstName}}", vars).output;
    assert.equal(out, `Happy ${timeVariables(new Date(), "Asia/Tokyo").day_of_week}, Ana. Sam`);

    // A timezone this runtime doesn't know: the workspace's clock.
    const elsewhere = shared.writtenEmailVariables({ ...lead, timezone: "Mars/Olympus" }, { email: "sam@rendering.test" }, "America/New_York");
    assert.equal(elsewhere.time_of_day, timeVariables(new Date(), "America/New_York").time_of_day);
  });
});

// Tracking and the sending engine, with sandbox mailboxes (they deliver locally, never to the internet): what a lead's
// copy and its cc/bcc copies carry, where click links lead, which opens and clicks count, quoted and forwarded copies,
// and the engine's bookkeeping (an email is never sent twice, ended leads stay ended, limits hold). Every address and
// value here is made up.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EmailType, LeadStatus, SubsequenceActivity, VerificationStatus } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runSender } from "../src/engine/sender";
import { runPendingJobs } from "../src/engine/jobs";
import { uuidv7 } from "../src/lib/ids";
import { parseInbound, type InboundMessage } from "../src/mail/parse";
import { SandboxDriver } from "../src/mail/sandbox";
import type { OutgoingMessage } from "../src/mail/types";
import { handleBounce, handleOpen } from "../src/services/activity";
import { monthlyEmailsSent } from "../src/services/billing-limits";
import { emit, on } from "../src/services/bus";
import { enrollInSubsequence } from "../src/services/subsequences";
import { appendOpenPixel, clickUrl, emailToken, rewriteLinks, unsubscribeUrl } from "../src/services/tracking";
import { composeAndSend } from "../src/services/unibox";
import { forgetWorkspaceZones, startOfMonthOn } from "../src/services/workspace-clock";

const BASE = "http://localhost:4000";
const L = schema.leads;
const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const step = (subject: string, body: string) => ({ type: "email", delay: 1, delay_unit: "days", variants: [{ subject, body }] });

let app: FastifyInstance;
let user: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Tracking Co" });
});
after(stopServer);

/** A sandbox mailbox of its own, with no gap between sends. */
async function mailbox(owner: TestUser = user): Promise<string> {
  const email = json(await owner.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email as string;
  await db.update(schema.emailAccounts).set({ sendingGap: 0 }).where(eq(schema.emailAccounts.email, email));
  return email;
}

/** An active campaign sending from these mailboxes to these leads, any time of day. */
async function campaign(name: string, mailboxes: string[], leads: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}, owner: TestUser = user) {
  const c = owner.client;
  const created = json(await c.post("/api/app/campaigns", { name }));
  json(
    await c.patch(`/api/v2/campaigns/${created.id}`, {
      email_list: mailboxes,
      campaign_schedule: ALWAYS_OPEN,
      email_gap: 0,
      random_wait_max: 0,
      sequences: [{ steps: [step("Hi {{firstName}}", "<p>Hello {{firstName}}</p>")] }],
      ...extra,
    }),
  );
  for (const lead of leads) json(await c.post("/api/v2/leads", { first_name: "Pat", ...lead, campaign: created.id }));
  expectStatus(await c.post(`/api/v2/campaigns/${created.id}/activate`), 200);
  return created.id as string;
}

const leadsOf = (campaignId: string) => db.select().from(L).where(eq(L.campaignId, campaignId));
const sentTo = async (address: string) => (await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadEmail, address), eq(schema.emailEvents.type, "sent")))).length;

/** What reached a sandbox inbox: each message parsed, with its raw text (headers as sent). */
async function inbox(address: string): Promise<Array<{ m: InboundMessage; raw: string }>> {
  const rows = await db
    .select()
    .from(schema.sandboxMessages)
    .where(and(eq(schema.sandboxMessages.mailbox, address), eq(schema.sandboxMessages.folder, "INBOX")));
  return Promise.all(rows.map(async (r) => ({ m: await parseInbound(Buffer.from(r.raw)), raw: r.raw })));
}
const headerBlock = (raw: string) => raw.slice(0, raw.search(/\r?\n\r?\n/));

async function waitFor(check: () => Promise<boolean> | boolean, ms = 3_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Replaces the sandbox's send for one recipient (everyone else is sent as usual). */
function interceptSend(recipient: string, fn: (msg: OutgoingMessage, send: () => Promise<unknown>) => Promise<unknown>) {
  const real = SandboxDriver.prototype.send;
  SandboxDriver.prototype.send = async function (this: SandboxDriver, msg: OutgoingMessage) {
    const send = () => real.call(this, msg);
    return (msg.to[0]?.address === recipient ? fn(msg, send) : send()) as ReturnType<typeof real>;
  };
  return () => {
    SandboxDriver.prototype.send = real;
  };
}

describe("a campaign email's copies", () => {
  it("cc and bcc addresses get their own copy, without the lead's tracking or unsubscribe link", async () => {
    const box = await mailbox();
    await campaign("Copied in", [box], [{ email: "copied.lead@example.test" }], {
      cc_list: ["boss@cc.example.test"],
      bcc_list: ["crm@bcc.example.test"],
      open_tracking: true,
      link_tracking: true,
      insert_unsubscribe_header: true,
      sequences: [{ steps: [step("Pricing", '<p>See <a href="https://example.com/pricing">pricing</a>.</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>')] }],
    });
    await runSender();
    const [lead] = await inbox("copied.lead@example.test");
    const [boss] = await inbox("boss@cc.example.test");
    const [crm] = await inbox("crm@bcc.example.test");
    assert.ok(lead && boss && crm, "everyone got the email");

    // The lead's copy is tracked and can be unsubscribed from.
    assert.match(lead.m.html, /\/t\/o\//);
    assert.match(lead.m.html, /\/t\/c\//);
    assert.match(lead.m.html, /\/u\//);
    assert.match(headerBlock(lead.raw), /^List-Unsubscribe:/im);

    for (const copy of [boss, crm]) {
      assert.doesNotMatch(copy.m.html, /\/t\/[oc]\/|\/u\//, "no pixel, no click redirects, no unsubscribe token");
      assert.match(copy.m.html, /href="https:\/\/example\.com\/pricing"/, "links lead straight to their page");
      assert.doesNotMatch(headerBlock(copy.raw), /^List-Unsubscribe/im);
      assert.equal(copy.m.messageId, lead.m.messageId, "the same email, so replies thread");
      assert.deepEqual(
        copy.m.cc.map((a) => a.address),
        ["boss@cc.example.test"],
      );
    }
    // Nobody learns the bcc address, and Sent has the email once.
    for (const shown of [lead, boss]) assert.doesNotMatch(shown.raw, /crm@bcc\.example\.test/);
    const sent = await db
      .select()
      .from(schema.sandboxMessages)
      .where(and(eq(schema.sandboxMessages.mailbox, box), eq(schema.sandboxMessages.folder, "Sent")));
    assert.equal(sent.filter((s) => s.messageId === lead.m.messageId).length, 1);
  });

  it("one-click unsubscribe is only offered on an https address", async () => {
    const plain = await mailbox();
    await campaign("Over http", [plain], [{ email: "oneclick.http@example.test" }], { insert_unsubscribe_header: true });
    const secure = await mailbox();
    await db.update(schema.emailAccounts).set({ trackingDomainName: "track.example.com", trackingDomainStatus: "verified" }).where(eq(schema.emailAccounts.email, secure));
    await campaign("Over https", [secure], [{ email: "oneclick.https@example.test" }], { insert_unsubscribe_header: true });
    await runSender();

    const [http] = await inbox("oneclick.http@example.test");
    assert.match(headerBlock(http!.raw), /^List-Unsubscribe:\s*<http:\/\/localhost:4000\/u\//im);
    assert.doesNotMatch(headerBlock(http!.raw), /^List-Unsubscribe-Post:/im, "RFC 8058 needs https");
    const [https] = await inbox("oneclick.https@example.test");
    assert.match(headerBlock(https!.raw), /^List-Unsubscribe:\s*<https:\/\/track\.example\.com\/u\//im);
    assert.match(headerBlock(https!.raw), /^List-Unsubscribe-Post:\s*List-Unsubscribe=One-Click/im);
  });

  it("a text-only email is kept as text: a lead's < and & stay characters", async () => {
    const box = await mailbox();
    const id = await campaign("Plain text", [box], [{ email: "plain.text@example.test", first_name: "<b>Pat</b> & co" }], { text_only: true });
    await runSender();
    const [email] = await db.select().from(schema.emails).where(eq(schema.emails.campaignId, id));
    assert.ok(email, "sent");
    assert.match(email.bodyHtml!, /&lt;b&gt;Pat&lt;\/b&gt; &amp; co/);
    assert.doesNotMatch(email.bodyHtml!, /<b>Pat/);
  });
});

describe("tracked links and opens", () => {
  /** A sent campaign email for a new lead, an hour old (past the scanners' window). */
  async function sentEmail(address: string) {
    const lead = json(await user.client.post("/api/v2/leads", { email: address, first_name: "Pat" }));
    const id = uuidv7();
    await db.insert(schema.emails).values({
      id,
      workspaceId: user.workspaceId!,
      messageId: `<${id}@example.test>`,
      threadId: uuidv7(),
      subject: "Hello",
      eaccount: "sales@example.test",
      fromAddress: "sales@example.test",
      toList: address,
      leadEmail: address,
      leadId: lead.id,
      ueType: EmailType.CAMPAIGN_SENT,
      step: "1",
      variant: 0,
      timestampEmail: new Date(Date.now() - 3_600_000),
    });
    return { id, leadId: lead.id as string };
  }
  const leadRow = async (id: string) => (await db.select().from(L).where(eq(L.id, id)))[0]!;

  it("click links lead where the email's link pointed, written the way browsers write addresses", async () => {
    const id = uuidv7();
    const html = rewriteLinks(`<a href="https://shop.example.com/?q=it&#39;s&amp;size=&quot;L&quot;">a</a> <a href="https://例え.example.com/パス?x=ü">b</a>`, BASE, id);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
    assert.deepEqual(
      hrefs.map((h) => new URL(h).searchParams.get("u")),
      ['https://shop.example.com/?q=it\'s&size="L"', "https://例え.example.com/パス?x=ü"],
      "character references read as characters, like a browser reads the link",
    );
    for (const h of hrefs) {
      const url = new URL(h);
      const res = await app.inject({ method: "GET", url: url.pathname + url.search });
      assert.equal(res.statusCode, 302, String(res.body).slice(0, 200));
      assert.equal(res.headers.location, new URL(url.searchParams.get("u")!).href);
      assert.match(String(res.headers.location), /^[\x21-\x7e]+$/, "a header carries ASCII only");
    }
  });

  it("Outlook for Windows opening an email counts; Office checking a link doesn't", async () => {
    const { id, leadId } = await sentEmail("outlook.reader@example.test");
    const outlook = "Mozilla/4.0 (compatible; ms-office; MSOffice 16)";
    const open = await app.inject({ method: "GET", url: `/t/o/${emailToken(id)}.gif`, headers: { "user-agent": outlook } });
    assert.equal(open.statusCode, 200);
    await waitFor(async () => (await leadRow(leadId)).openCount === 1);

    const link = new URL(clickUrl(BASE, id, "https://example.com/offer"));
    const probe = await app.inject({ method: "GET", url: link.pathname + link.search, headers: { "user-agent": "Microsoft Office Existence Discovery" } });
    assert.equal(probe.statusCode, 302);
    const click = await app.inject({ method: "GET", url: link.pathname + link.search, headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" } });
    assert.equal(click.statusCode, 302);
    await waitFor(async () => (await leadRow(leadId)).clickCount > 0);
    assert.equal((await leadRow(leadId)).clickCount, 1, "the browser's click, not Office's look");
  });

  it("opens arriving together have one first", async () => {
    const { id, leadId } = await sentEmail("opens.together@example.test");
    const ctx = { workspaceId: user.workspaceId!, leadId, campaignId: null, emailId: id, step: 2, variant: 1 };
    await Promise.all([handleOpen(ctx), handleOpen(ctx), handleOpen(ctx)]);
    const events = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.emailId, id), eq(schema.emailEvents.type, "open")));
    assert.equal(events.length, 3);
    assert.equal(events.filter((e) => e.isFirst).length, 1);
    const lead = await leadRow(leadId);
    assert.deepEqual([lead.openCount, lead.openedStep, lead.openedVariant], [3, 2, 1]);
  });
});

describe("replies and forwards from the Unibox", () => {
  it("quote and forward the email without its tracking, with its names and subject as text", async () => {
    const box = await mailbox();
    const [account] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.email, box));
    const id = uuidv7();
    const tracked = appendOpenPixel(
      rewriteLinks(`<p>Our prices: <a href="https://example.com/prices?a=1&amp;b=2">prices</a></p><p><a href="${unsubscribeUrl(BASE, id)}">Unsubscribe</a></p>`, BASE, id),
      BASE,
      id,
    );
    const [original] = await db
      .insert(schema.emails)
      .values({
        id,
        workspaceId: user.workspaceId!,
        messageId: `<${id}@example.test>`,
        threadId: uuidv7(),
        subject: "<i>Prices</i> & more",
        eaccount: box,
        accountId: account!.id,
        fromAddress: box,
        fromJson: [{ address: box, name: 'Sam "Sales" <Team>' }],
        toList: "quoted.lead@example.test",
        leadEmail: "quoted.lead@example.test",
        ueType: EmailType.CAMPAIGN_SENT,
        bodyHtml: tracked,
        bodyText: "Our prices",
        timestampEmail: new Date(Date.now() - 3_600_000),
      })
      .returning();
    const token = emailToken(id);

    const reply = await composeAndSend({ workspaceId: user.workspaceId!, account: account!, original: original!, kind: "reply", html: "<p>Following up</p>", includeQuote: true });
    const forward = await composeAndSend({ workspaceId: user.workspaceId!, account: account!, original: original!, kind: "forward", to: ["colleague@example.test"], html: "<p>FYI</p>" });
    for (const sent of [reply, forward]) {
      assert.ok(!sent.bodyHtml!.includes(token), "no tracking token in the copy");
      assert.doesNotMatch(sent.bodyHtml!, /\/t\/[oc]\//);
      assert.match(sent.bodyHtml!, /href="https:\/\/example\.com\/prices\?a=1&amp;b=2"/);
    }
    assert.match(reply.bodyHtml!, /Sam &quot;Sales&quot; &lt;Team&gt; &lt;[^&]+@[^&]+&gt; wrote:/, "the sender's name and address shown as text");
    assert.match(forward.bodyHtml!, /From: Sam &quot;Sales&quot; &lt;Team&gt; &lt;/);
    assert.match(forward.bodyHtml!, /Subject: &lt;i&gt;Prices&lt;\/i&gt; &amp; more/);
    // The colleague's copy carries nothing that would count as the lead.
    const [delivered] = await inbox("colleague@example.test");
    assert.ok(delivered && !delivered.raw.includes(token));
  });
});

describe("an email on its way", () => {
  it("is never sent twice, even while the first pass is still sending it", async () => {
    const box = await mailbox();
    const id = await campaign("In flight", [box], [{ email: "in.flight@example.test" }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let sends = 0;
    let during: { nextStep: number; stored: number } | null = null;
    const restore = interceptSend("in.flight@example.test", async (msg, send) => {
      sends++;
      if (sends === 1) {
        const [lead] = await leadsOf(id);
        during = { nextStep: lead!.nextStep, stored: (await db.select().from(schema.emails).where(eq(schema.emails.messageId, msg.messageId))).length };
        await gate;
      }
      return send();
    });
    try {
      const first = runSender();
      await waitFor(() => sends === 1);
      // Another pass (another process taking over, say) while the email is still going out.
      await runSender();
      release();
      await first;
    } finally {
      restore();
    }
    assert.equal(sends, 1, "sent once");
    assert.deepEqual(during, { nextStep: 1, stored: 1 }, "the lead had moved on, and the email was written down, before it went out");
    assert.equal(await sentTo("in.flight@example.test"), 1);
  });

  it("that fails puts the lead back where it was, and keeps no copy", async () => {
    const box = await mailbox();
    const id = await campaign("Try later", [box], [{ email: "try.later@example.test" }]);
    const restore = interceptSend("try.later@example.test", async () => {
      throw Object.assign(new Error("421 4.7.0 Try again later"), { responseCode: 421 });
    });
    try {
      await runSender();
    } finally {
      restore();
    }
    const [lead] = await leadsOf(id);
    assert.equal(lead!.status, LeadStatus.ACTIVE);
    assert.equal(lead!.nextStep, 0);
    assert.equal(lead!.lastStepId, null);
    assert.ok((lead!.nextSendAt ?? 0) > Date.now(), "tried again later");
    assert.equal((await db.select().from(schema.emails).where(eq(schema.emails.campaignId, id))).length, 0);
    assert.equal(await sentTo("try.later@example.test"), 0);
  });

  it("an address that bounces or unsubscribes while its last email goes out stays that way", async () => {
    const box = await mailbox();
    const id = await campaign("Last one", [box], [{ email: "last.bounce@example.test" }]);
    const changes: string[] = [];
    on("lead_status_changed", (e) => {
      if (e.data.campaign_id === id) changes.push(String(e.data.status));
    });
    const restore = interceptSend("last.bounce@example.test", async (_msg, send) => {
      // The bounce notice is filed while the email is still being handed over.
      const [lead] = await leadsOf(id);
      await handleBounce({ workspaceId: lead!.workspaceId, lead: lead!, campaignId: id, accountId: null, accountEmail: null, hard: true });
      return send();
    });
    try {
      await runSender();
    } finally {
      restore();
    }
    await new Promise((r) => setTimeout(r, 100));
    const [lead] = await leadsOf(id);
    assert.equal(lead!.status, LeadStatus.BOUNCED);
    assert.ok(!changes.includes("completed"), "not reported as completed");
  });
});

describe("the sending engine", () => {
  it("a subsequence that emailed a lead doesn't take it again", async () => {
    const box = await mailbox();
    const parent = await campaign("Two follow-ups", [box], [{ email: "ping.pong@example.test" }]);
    const subs: string[] = [];
    for (const name of ["Opened A", "Opened B"]) {
      const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: parent, name, conditions: { lead_activity: [SubsequenceActivity.EMAIL_OPENED] } }));
      json(await user.client.patch(`/api/v2/subsequences/${sub.id}`, { sequences: [{ steps: [step("", `<p>${name}</p>`)] }] }));
      json(await user.client.post(`/api/v2/subsequences/${sub.id}/resume`));
      subs.push(sub.id);
    }
    const [a, b] = subs as [string, string];
    const subSends = async (sub: string) => (await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.subsequenceId, sub), eq(schema.emailEvents.type, "sent")))).length;
    const lead = async () => (await leadsOf(parent))[0]!;
    const opened = async (expected: string) => {
      const l = await lead();
      emit("email_opened", l.workspaceId, { lead_id: l.id, campaign_id: parent });
      await waitFor(async () => (await lead()).subsequenceId === expected);
      await db.update(L).set({ subseqNextSendAt: Date.now() - 1_000 }).where(eq(L.id, l.id));
      await runSender();
    };
    await opened(a);
    assert.equal(await subSends(a), 1);
    await opened(b);
    assert.equal(await subSends(b), 1);
    // Opening B's email: A already emailed this lead, so nothing starts over.
    const l = await lead();
    emit("email_opened", l.workspaceId, { lead_id: l.id, campaign_id: parent });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await lead()).subsequenceId, b);
    await runSender();
    assert.deepEqual([await subSends(a), await subSends(b)], [1, 1]);
  });

  it("leads waiting for verification don't hold up a subsequence", async () => {
    const box = await mailbox();
    const parent = await campaign("Verify first", [box], [{ email: "wait.one@example.test" }, { email: "wait.two@example.test" }, { email: "ready.now@example.test" }]);
    // Nothing from the campaign itself: these leads go straight into the subsequence.
    await db.update(L).set({ nextSendAt: Date.now() + 86_400_000 }).where(eq(L.campaignId, parent));
    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: parent, name: "Interested", conditions: { crm_status: [1] } }));
    json(await user.client.patch(`/api/v2/subsequences/${sub.id}`, { sequences: [{ steps: [step("", "<p>Glad to hear it</p>")] }] }));
    json(await user.client.post(`/api/v2/subsequences/${sub.id}/resume`));
    const [row] = await db.select().from(schema.subsequences).where(eq(schema.subsequences.id, sub.id));
    const order = ["wait.one@example.test", "wait.two@example.test", "ready.now@example.test"];
    for (const l of await leadsOf(parent)) {
      await enrollInSubsequence(l, row!);
      const waiting = l.email !== "ready.now@example.test";
      await db
        .update(L)
        .set({ subseqNextSendAt: Date.now() - 10_000 + order.indexOf(l.email!) * 1_000, ...(waiting ? { verificationStatus: VerificationStatus.PENDING } : {}) })
        .where(eq(L.id, l.id));
    }
    await runSender();
    assert.equal(await sentTo("ready.now@example.test"), 1, "the verified lead goes, though two waiting ones are due first");
    assert.equal(await sentTo("wait.one@example.test"), 0);
  });

  it("the per-company limit counts by the domain of the addresses emailed", async () => {
    const one = await mailbox();
    const two = await mailbox();
    const id = await campaign(
      "Per company",
      [one, two],
      [
        { email: "a@acme-corp.example.test", company_domain: "acme.example.test" },
        { email: "b@acme-corp.example.test", company_domain: "acme.example.test" },
      ],
      { limit_emails_per_company_override: { mode: "custom", daily_limit: 1, scope: "per_campaign" } },
    );
    await runSender();
    assert.equal((await sentTo("a@acme-corp.example.test")) + (await sentTo("b@acme-corp.example.test")), 1);
    const waiting = (await leadsOf(id)).find((l) => l.nextStep === 0)!;
    assert.ok((waiting.nextSendAt ?? 0) > Date.now(), "the other waits for tomorrow");
  });

  it("moving a bounced or unsubscribed lead keeps it that way, and a subsequence can't take it", async () => {
    const box = await mailbox();
    const from = await campaign("Moved from", [box], [{ email: "moved.bounced@example.test" }]);
    const to = await campaign("Moved to", [box], [{ email: "moved.placeholder@example.test" }]);
    const [lead] = await leadsOf(from);
    await handleBounce({ workspaceId: lead!.workspaceId, lead: lead!, campaignId: from, accountId: null, accountEmail: null, hard: true });
    const job = json(await user.client.post("/api/v2/leads/move", { ids: [lead!.id], to_campaign_id: to }));
    await runPendingJobs();
    await waitFor(async () => (await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id)))[0]?.status === "success");
    const [moved] = await db.select().from(L).where(eq(L.id, lead!.id));
    assert.equal(moved!.campaignId, to);
    assert.equal(moved!.status, LeadStatus.BOUNCED);
    await runSender();
    assert.equal(await sentTo("moved.bounced@example.test"), 0);

    const sub = json(await user.client.post("/api/v2/subsequences", { parent_campaign: to, name: "Never", conditions: { crm_status: [1] } }));
    const res = await user.client.post("/api/v2/leads/subsequence/move", { id: lead!.id, subsequence_id: sub.id });
    expectStatus(res, 400);
    assert.match(json(res, 400).message, /bounced or unsubscribed/);
    assert.equal((await db.select().from(L).where(eq(L.id, lead!.id)))[0]!.status, LeadStatus.BOUNCED);
  });

  it("bulk changes need a selection: a missing filter never means every lead", async () => {
    const solo = await signUp(app, { workspaceName: "Selection Co" });
    const [list] = [json(await solo.client.post("/api/v2/lead-lists", { name: "Somewhere" }))];
    json(await solo.client.post("/api/v2/leads", { email: "only.one@example.test", list_id: list.id }));
    for (const [url, payload] of [
      ["/api/v2/leads/move", { to_list_id: list.id }],
      ["/api/app/leads/status", { action: "pause" }],
      ["/api/app/leads/edit", { field: "job_title", value: "Chief" }],
    ] as const) {
      const res = await solo.client.post(url, payload);
      expectStatus(res, 400, url);
      assert.match(json(res, 400).message, /all_leads/);
    }
    // Asked for in so many words, it's every lead.
    assert.equal(json(await solo.client.post("/api/app/leads/status", { action: "pause", all_leads: true })).affected, 1);
  });
});

describe("a hosted plan's monthly emails", () => {
  let hosted: TestUser;
  before(async () => {
    hosted = await signUp(app, { workspaceName: "Hosted Co" });
    await db.update(schema.workspaces).set({ selfHosted: false, trialEndsAt: new Date(Date.now() + 7 * 86_400_000) }).where(eq(schema.workspaces.id, hosted.workspaceId!));
  });

  it("can't be overrun by a busy pass", async () => {
    // The trial's 1,000 emails a month, all but one used.
    await db.insert(schema.emailEvents).values(Array.from({ length: 999 }, () => ({ workspaceId: hosted.workspaceId!, type: "sent", leadEmail: "earlier@example.test" })));
    const boxes = [await mailbox(hosted), await mailbox(hosted), await mailbox(hosted)];
    await campaign("Busy", boxes, [{ email: "busy.one@example.test" }, { email: "busy.two@example.test" }, { email: "busy.three@example.test" }], {}, hosted);
    await runSender();
    const sent = (await sentTo("busy.one@example.test")) + (await sentTo("busy.two@example.test")) + (await sentTo("busy.three@example.test"));
    assert.equal(sent, 1);
  });

  it("start on the workspace's clock", async () => {
    const zone = "Pacific/Kiritimati"; // UTC+14: its month starts the day before UTC's
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, hosted.workspaceId!));
    await db.update(schema.workspaces).set({ settings: { ...(ws!.settings ?? {}), default_timezone: zone } }).where(eq(schema.workspaces.id, hosted.workspaceId!));
    forgetWorkspaceZones(hosted.workspaceId!);
    const start = startOfMonthOn(zone);
    const count = await monthlyEmailsSent(hosted.workspaceId!);
    await db.insert(schema.emailEvents).values([
      { workspaceId: hosted.workspaceId!, type: "sent", leadEmail: "month.in@example.test", createdAt: new Date(start + 60_000) },
      { workspaceId: hosted.workspaceId!, type: "sent", leadEmail: "month.out@example.test", createdAt: new Date(start - 60_000) },
    ]);
    assert.equal(await monthlyEmailsSent(hosted.workspaceId!), count + 1);
  });
});

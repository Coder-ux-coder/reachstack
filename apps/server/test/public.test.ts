// What strangers can reach without signing in: which routes are public at all, tracking and unsubscribe links,
// the privacy center forms, abuse reports, and webhooks from other services.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { LeadStatus } from "@reachstack/shared";
import { TestClient, expectStatus, json, listRoutes, signUp, startServer, stopServer, type Res, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { importDatasetRows } from "../src/services/lead-finder/dataset";
import { verifyStripeSignature } from "../src/services/stripe";
import { systemMailLog } from "../src/services/system-mail";
import { appendOpenPixel, clickUrl, emailToken, readEmailToken, rewriteLinks, unsubscribeUrl } from "../src/services/tracking";

const MISSING_ID = "00000000-0000-7000-8000-000000000000";
const BASE = "https://track.example.test";

let app: FastifyInstance;
let owner: TestUser;
let alice: TestUser;
let campaignId = "";
let otherCampaignId = "";

before(async () => {
  app = await startServer();
  owner = await signUp(app); // the installation owner, who gets privacy and abuse notices
  alice = await signUp(app, { firstName: "Alice" });
  campaignId = json(await alice.client.post("/api/app/campaigns", { name: "Outreach" })).id;
  otherCampaignId = json(await alice.client.post("/api/app/campaigns", { name: "Other outreach" })).id;
});
after(stopServer);

const stranger = () => new TestClient(app);

/** A lead in Alice's campaign and an email "sent" to it, as the sending engine would store it. */
async function sentTo(leadEmail: string, opts: { campaign?: string | null; ueType?: number; addLead?: boolean } = {}) {
  const campaign = opts.campaign === undefined ? campaignId : opts.campaign;
  const lead = opts.addLead === false || !campaign ? null : json(await alice.client.post("/api/v2/leads", { email: leadEmail, campaign }));
  const [row] = await db
    .insert(schema.emails)
    .values({
      workspaceId: alice.workspaceId!,
      messageId: `<${randomUUID()}@example.test>`,
      subject: "Quick question",
      eaccount: "sender@example.test",
      ueType: opts.ueType ?? 1,
      leadEmail,
      leadId: lead?.id ?? null,
      campaignId: campaign,
      timestampEmail: new Date(Date.now() - 3_600_000),
    })
    .returning();
  return { email: row!, token: emailToken(row!.id), leadId: (lead?.id as string | undefined) ?? null };
}

async function leadStatus(id: string) {
  const [row] = await db.select({ status: schema.leads.status }).from(schema.leads).where(eq(schema.leads.id, id));
  return row?.status;
}

async function workspaceUnsubscribed(address: string) {
  const ws = alice.workspaceId!;
  const [unsub] = await db.select().from(schema.unsubscribes).where(and(eq(schema.unsubscribes.workspaceId, ws), eq(schema.unsubscribes.email, address)));
  const [blocked] = await db.select().from(schema.blockList).where(and(eq(schema.blockList.workspaceId, ws), eq(schema.blockList.value, address)));
  return { unsubscribed: !!unsub, blocked: !!blocked };
}

const mailsTo = (to: string) => systemMailLog.filter((m) => m.to === to);

describe("the route table", () => {
  it("public routes live only where public routes belong", async () => {
    const routes = await listRoutes();
    const pub = routes.filter((r) => r.config.auth === "public");
    assert.ok(pub.length >= 20, `only ${pub.length} public routes`);
    // Signed-out pages of the app: sign-up/sign-in/reset, links from emails (a token in the path or body), OAuth return.
    const appAllowed = [
      /^\/api\/app\/auth\//,
      /^\/api\/app\/oauth\/:provider\/callback$/,
      /^\/api\/app\/(invitations|workspace-group-invitations)\/:token$/,
      /^\/api\/app\/workspaces\/current\/change-owner\/confirm$/,
    ];
    const misplaced = pub.filter(({ url }) => {
      if (url.startsWith("/api/app/")) return !appAllowed.some((re) => re.test(url));
      if (url.startsWith("/api/")) return !(url === "/api/health" || /^\/api\/(public|webhooks|hooks)\//.test(url));
      return false; // tracking pixel, click and unsubscribe links, the visitor script
    });
    assert.deepEqual(
      misplaced.map((r) => `${r.method} ${r.url}`),
      [],
      "a new public route: if it's meant to be public, move it under /api/public/ or add it to appAllowed here",
    );
    assert.ok(!pub.some((r) => r.url.startsWith("/api/v2/") || r.url.startsWith("/api/app/admin")));
  });

  it("every other route turns strangers away with 401", async () => {
    const routes = (await listRoutes()).filter((r) => r.config.auth !== "public");
    assert.ok(routes.length > 400, `only ${routes.length} routes`);
    const anon = stranger();
    const failures: string[] = [];
    for (const r of routes) {
      const url = r.url.replace(/:[A-Za-z_]+/g, MISSING_ID).replace(/\*$/, "x");
      const res = await anon.request(r.method as HTTPMethods, url, r.method === "GET" || r.method === "DELETE" ? undefined : {});
      if (res.statusCode !== 401) failures.push(`${r.method} ${r.url} → ${res.statusCode} ${res.body.slice(0, 100)}`);
    }
    assert.deepEqual(failures, []);
  });
});

describe("tracking links", () => {
  it("email tokens round-trip and can't be forged or moved to another email", () => {
    const id = randomUUID();
    const token = emailToken(id);
    assert.equal(readEmailToken(token), id);
    assert.equal(readEmailToken(`${token}.gif`), id);
    const [, sig] = token.split(".");
    for (const bad of [undefined, "", id, `${id}.`, `${id}.${"A".repeat(sig!.length)}`, `${randomUUID()}.${sig}`, `${token}x`, `.${sig}`]) {
      assert.equal(readEmailToken(bad), null, String(bad));
    }
  });

  it("click links redirect only to the signed address", async () => {
    const { email, token } = await sentTo("clicker@example.test");
    const target = "https://www.example.com/pricing?plan=pro&ref=email";
    const link = new URL(clickUrl(BASE, email.id, target));
    const path = `${link.pathname}${link.search}`;
    const ok = await stranger().get(path);
    expectStatus(ok, 302);
    assert.equal(ok.headers.location, target);

    const sig = link.searchParams.get("s")!;
    const other = emailToken(randomUUID());
    const tampered = [
      `/t/c/${token}?u=${encodeURIComponent("https://evil.example/")}&s=${sig}`,
      `/t/c/${token}?u=${encodeURIComponent(target)}`,
      `/t/c/${token}?u=${encodeURIComponent(target)}&s=`,
      `/t/c/${token}?u=${encodeURIComponent(target)}&s=${sig.slice(0, -1)}`,
      `/t/c/${other}?u=${encodeURIComponent(target)}&s=${sig}`,
      `/t/c/${token}?s=${sig}`,
    ];
    for (const url of tampered) {
      const res = await stranger().get(url);
      expectStatus(res, 400, url);
      assert.equal(res.headers.location, undefined);
      assert.match(String(res.headers["content-type"]), /text\/html/);
      assert.equal(res.headers["x-frame-options"], "DENY");
    }
    // Even a correctly signed link never leads to a script or data URL.
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "//evil.example/"]) {
      const l = new URL(clickUrl(BASE, email.id, bad));
      expectStatus(await stranger().get(`${l.pathname}${l.search}`), 400, bad);
    }
  });

  it("scanners, HEAD requests and clicks right after sending don't count as the lead clicking", async () => {
    const target = "https://www.example.com/case-study";
    const clicks = async (leadId: string, expected: number) => {
      // Clicks are recorded after the redirect goes out.
      let n = -1;
      for (let i = 0; i < 40 && n !== expected; i++) {
        await new Promise((r) => setTimeout(r, 25));
        n = (await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.leadId, leadId), eq(schema.emailEvents.type, "click")))).length;
      }
      return n;
    };
    const pathFor = (emailId: string) => {
      const link = new URL(clickUrl(BASE, emailId, target));
      return `${link.pathname}${link.search}`;
    };

    const sent = await sentTo("scanned@example.test"); // an hour ago
    const path = pathFor(sent.email.id);
    expectStatus(await stranger().request("HEAD", path), 302);
    for (const agent of ["Mozilla/5.0 (compatible; Barracuda Sentinel)", "Microsoft Office Protocol Discovery", "Go-http-client/1.1"]) {
      expectStatus(await stranger().get(path, { headers: { "user-agent": agent } }), 302, agent);
    }
    assert.equal(await clicks(sent.leadId!, 0), 0);
    expectStatus(await stranger().get(path), 302);
    assert.equal(await clicks(sent.leadId!, 1), 1, "a browser an hour later is the lead");

    // Followed seconds after sending: a scanner checking the email as it arrived.
    const fresh = await sentTo("just.sent@example.test");
    await db.update(schema.emails).set({ timestampEmail: new Date() }).where(eq(schema.emails.id, fresh.email.id));
    expectStatus(await stranger().get(pathFor(fresh.email.id)), 302);
    assert.equal(await clicks(fresh.leadId!, 0), 0);
  });

  it("the open pixel looks the same for real and made-up tokens", async () => {
    const { token } = await sentTo("opener@example.test");
    const real = await stranger().get(`/t/o/${token}.gif`);
    const fake = await stranger().get(`/t/o/${emailToken(randomUUID())}.gif`);
    const junk = await stranger().get("/t/o/not-a-token.gif");
    for (const res of [real, fake, junk]) {
      expectStatus(res, 200);
      assert.equal(res.headers["content-type"], "image/gif");
      assert.match(String(res.headers["cache-control"]), /no-store/);
      assert.deepEqual(res.rawPayload, real.rawPayload);
    }
  });

  it("link rewriting skips mail and phone links, the unsubscribe link and opted-out links", () => {
    const id = randomUUID();
    const html = [
      `<a href="https://www.example.com/a?x=1&amp;y=2">tracked</a>`,
      `<a href="mailto:someone@example.test">mail</a>`,
      `<a href="tel:+15555550100">call</a>`,
      `<a href="${unsubscribeUrl(BASE, id)}">unsubscribe</a>`,
      `<a data-no-track href="https://www.example.com/private">untracked</a>`,
    ].join("\n");
    const out = rewriteLinks(html, BASE, id).split("\n");
    assert.ok(out[0]!.includes(`${BASE}/t/c/${emailToken(id)}?u=${encodeURIComponent("https://www.example.com/a?x=1&y=2")}&amp;s=`));
    assert.deepEqual(out.slice(1), html.split("\n").slice(1));
    assert.match(appendOpenPixel("<html><body><p>Hi</p></body></html>", BASE, id), new RegExp(`<img src="${BASE}/t/o/${emailToken(id).replace(/\./g, "\\.")}\\.gif"[^>]*/></body>`));
  });
});

describe("unsubscribe links", () => {
  it("made-up or altered links show an expired page and change nothing", async () => {
    const { token } = await sentTo("keep-me@example.test");
    // The last character changed (to one it isn't already).
    const altered = `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`;
    for (const t of [emailToken(randomUUID()), altered, "nothing"]) {
      const page = await stranger().get(`/u/${t}`);
      expectStatus(page, 200);
      assert.match(page.body, /Link expired/);
      expectStatus(await stranger().post(`/u/${t}`, "", { csrf: false, headers: { "content-type": "application/x-www-form-urlencoded" } }), 404);
      expectStatus(await stranger().get(`/api/public/unsubscribe/${t}`), 404);
      expectStatus(await stranger().post(`/api/public/unsubscribe/${t}`, { scope: "all" }, { csrf: false }), 404);
    }
    assert.deepEqual(await workspaceUnsubscribed("keep-me@example.test"), { unsubscribed: false, blocked: false });
  });

  it("the page escapes the address and can't be framed", async () => {
    const { token } = await sentTo(`"pat<b>bold</b>"@example.test`, { addLead: false });
    const page = await stranger().get(`/u/${token}`);
    expectStatus(page, 200);
    assert.ok(!page.body.includes("<b>bold</b>"));
    assert.ok(page.body.includes("&quot;pat&lt;b&gt;bold&lt;/b&gt;&quot;@example.test"));
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  });

  it("the form unsubscribes the address from the whole workspace", async () => {
    const address = "form-unsub@example.test";
    const { token, leadId } = await sentTo(address);
    assert.match((await stranger().get(`/u/${token}`)).body, /<form method="post">/);
    const done = await stranger().post(`/u/${token}`, "", { csrf: false, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expectStatus(done, 200);
    assert.match(done.body, /You're unsubscribed/);
    assert.equal(await leadStatus(leadId!), LeadStatus.UNSUBSCRIBED);
    assert.deepEqual(await workspaceUnsubscribed(address), { unsubscribed: true, blocked: true });
    assert.match((await stranger().get(`/u/${token}`)).body, /You're unsubscribed/);
  });

  it("one-click unsubscribe (RFC 8058) works without a page", async () => {
    const address = "one-click@example.test";
    const { token, leadId } = await sentTo(address);
    const res = await stranger().post(`/u/${token}`, "List-Unsubscribe=One-Click", { csrf: false, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expectStatus(res, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(await leadStatus(leadId!), LeadStatus.UNSUBSCRIBED);
    assert.equal((await workspaceUnsubscribed(address)).unsubscribed, true);
  });

  it("the app's unsubscribe page can stop just one campaign, then everything", async () => {
    const address = "choosy@example.test";
    const { token, leadId } = await sentTo(address);
    const other = json(await alice.client.post("/api/v2/leads", { email: address, campaign: otherCampaignId }));
    const url = `/api/public/unsubscribe/${token}`;
    assert.deepEqual(json(await stranger().get(url)), {
      email: address,
      from: "sender@example.test",
      has_campaign: true,
      unsubscribed: { all: false, campaign: false },
    });

    json(await stranger().post(url, { scope: "campaign" }, { csrf: false }));
    assert.deepEqual(json(await stranger().get(url)).unsubscribed, { all: false, campaign: true });
    assert.equal(await leadStatus(leadId!), LeadStatus.UNSUBSCRIBED);
    assert.equal(await leadStatus(other.id), LeadStatus.ACTIVE);
    assert.equal((await workspaceUnsubscribed(address)).unsubscribed, false);

    json(await stranger().post(url, { scope: "all" }, { csrf: false }));
    assert.deepEqual(json(await stranger().get(url)).unsubscribed, { all: true, campaign: true });
    assert.equal(await leadStatus(other.id), LeadStatus.UNSUBSCRIBED);
    assert.deepEqual(await workspaceUnsubscribed(address), { unsubscribed: true, blocked: true });
  });

  it("a campaign told to stop stays stopped once the lead is deleted", async () => {
    const { token, leadId } = await sentTo("stopped-then-deleted@example.test");
    const url = `/api/public/unsubscribe/${token}`;
    json(await stranger().post(url, { scope: "campaign" }, { csrf: false }));
    json(await alice.client.delete(`/api/v2/leads/${leadId}`));
    assert.deepEqual(json(await stranger().get(url)).unsubscribed, { all: false, campaign: true });
  });

  it("links for emails we received, rather than sent, aren't unsubscribe links", async () => {
    const { token } = await sentTo("replier@example.test", { ueType: 2, addLead: false });
    expectStatus(await stranger().get(`/api/public/unsubscribe/${token}`), 404);
    assert.equal(json(await stranger().post("/api/public/abuse/verify", { id: token }, { csrf: false })).status, "invalid");
  });
});

describe("the privacy center", () => {
  const SHARED = "robin.profile@example.test";
  let personId = "";

  before(async () => {
    const [company] = await db.insert(schema.lfCompanies).values({ name: "Example Widgets", domain: "example.com" }).returning();
    const [person] = await db
      .insert(schema.lfPeople)
      .values({ companyId: company!.id, firstName: "Robin", lastName: "Profile", email: SHARED, linkedinUrl: "https://www.linkedin.com/in/robin-profile-test" })
      .returning();
    personId = person!.id;
    await db.insert(schema.lfUnlocks).values({ workspaceId: alice.workspaceId!, personId });
  });

  const who = (email: string) => ({ first_name: "Test", last_name: "Person", email });
  const optOut = (email: string) => ({ ...who(email), confirm_identity: true, confirm_retention: true });
  const dataRequest = (email: string) => ({ ...who(email), confirm_identity: true, confirm_verification: true });

  async function suppressed(type: "email" | "linkedin", value: string) {
    const [row] = await db
      .select()
      .from(schema.privacySuppressions)
      .where(and(eq(schema.privacySuppressions.type, type), eq(schema.privacySuppressions.value, value)));
    return row ?? null;
  }

  function confirmToken(to: string): string {
    const mail = mailsTo(to).find((m) => /token=/.test(m.text));
    assert.ok(mail, `no confirmation mail to ${to}`);
    return decodeURIComponent(/[?&]token=([^\s&]+)/.exec(mail.text)![1]!);
  }

  const same = (a: Res, b: Res) => {
    assert.equal(a.statusCode, b.statusCode);
    assert.equal(a.body, b.body);
  };

  it("an opt-out answers the same whether or not we hold a profile, and removes the profile", async () => {
    const withProfile = await stranger().post("/api/public/privacy/opt-out", optOut(SHARED), { csrf: false });
    const without = await stranger().post("/api/public/privacy/opt-out", optOut("nobody-here@example.test"), { csrf: false });
    expectStatus(withProfile, 200);
    same(withProfile, without);

    assert.equal((await db.select().from(schema.lfPeople).where(eq(schema.lfPeople.id, personId))).length, 0);
    assert.equal((await db.select().from(schema.lfUnlocks).where(eq(schema.lfUnlocks.personId, personId))).length, 0);
    assert.ok(await suppressed("email", SHARED));
    assert.ok(await suppressed("linkedin", "linkedin.com/in/robin-profile-test"));
    assert.ok(await suppressed("email", "nobody-here@example.test"));
    // What happened is only ever told to the address itself.
    assert.match(mailsTo(SHARED)[0]!.subject, /profile was removed/);
    assert.match(mailsTo("nobody-here@example.test")[0]!.subject, /opted out/);
  });

  it("a data request answers the same either way, and only the emailed link carries it out", async () => {
    const [p] = await db.insert(schema.lfPeople).values({ firstName: "Sam", lastName: "Profile", email: "sam.profile@example.test" }).returning();
    const known = await stranger().post("/api/public/privacy/data-request", dataRequest("sam.profile@example.test"), { csrf: false });
    const unknown = await stranger().post("/api/public/privacy/data-request", dataRequest("nobody-either@example.test"), { csrf: false });
    expectStatus(known, 200);
    same(known, unknown);
    assert.ok(!mailsTo("sam.profile@example.test").some((m) => /data report/i.test(m.subject)), "nothing is sent before the link is used");

    const outcomes = [];
    for (const to of ["sam.profile@example.test", "nobody-either@example.test"]) {
      const token = confirmToken(to);
      const res = await stranger().post("/api/public/privacy/confirm", { token }, { csrf: false });
      outcomes.push(json(res));
      assert.match(mailsTo(to)[0]!.subject, /data report/i);
      expectStatus(await stranger().post("/api/public/privacy/confirm", { token }, { csrf: false }), 400, "a link works once");
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(outcomes[0], { type: "data_request", status: "resolved", done: ["access"], waiting: [] });
    assert.match(mailsTo("sam.profile@example.test")[0]!.text, /Sam Profile/);
    assert.equal((await db.select().from(schema.lfPeople).where(eq(schema.lfPeople.id, p!.id))).length, 1, "a data request alone removes nothing");
  });

  it("a data report shows the profiles under the confirmed address, never one found by a LinkedIn link", async () => {
    const [other] = await db
      .insert(schema.lfPeople)
      .values({ firstName: "Lee", lastName: "Elsewhere", email: "lee.elsewhere@example.test", phone: "+15555550123", linkedinUrl: "https://www.linkedin.com/in/lee-elsewhere-test" })
      .returning();
    const asker = "asker@example.test";
    json(await stranger().post("/api/public/privacy/data-request", { ...dataRequest(asker), linkedin_url: "https://www.linkedin.com/in/lee-elsewhere-test" }, { csrf: false }));
    json(await stranger().post("/api/public/privacy/confirm", { token: confirmToken(asker) }, { csrf: false }));
    const report = mailsTo(asker).find((m) => /data report/i.test(m.subject));
    assert.ok(report, "the report went out");
    assert.doesNotMatch(report.text + report.html, /Lee|lee\.elsewhere|5555550123/, "someone else's details stay out of it");
    assert.match(report.text, /found no profile for asker@example\.test/);

    // Asked to delete as well, the LinkedIn link still takes the profile out (removing never shows anything).
    const deleter = "deleter@example.test";
    json(
      await stranger().post(
        "/api/public/privacy/requests",
        { ...who(deleter), linkedin_url: "https://www.linkedin.com/in/lee-elsewhere-test", applicant_type: "self", country: "United States", requests: ["access", "delete"], confirm: true },
        { csrf: false },
      ),
    );
    json(await stranger().post("/api/public/privacy/confirm", { token: confirmToken(deleter) }, { csrf: false }));
    assert.doesNotMatch(mailsTo(deleter).find((m) => /data report/i.test(m.subject))!.text, /Lee|5555550123/);
    assert.equal((await db.select().from(schema.lfPeople).where(eq(schema.lfPeople.id, other!.id))).length, 0);
  });

  it("made-up confirmation links, and tokens meant for something else, are refused", async () => {
    for (const token of ["made-up-token-123456", "x".repeat(40), "short"]) {
      expectStatus(await stranger().post("/api/public/privacy/confirm", { token }, { csrf: false }), 400, token);
    }
    json(await stranger().post("/api/app/auth/password-reset/request", { email: alice.email }, { csrf: false }));
    const mail = mailsTo(alice.email).find((m) => /reset-password\?token=/.test(m.text));
    const resetToken = decodeURIComponent(/reset-password\?token=([^\s&]+)/.exec(mail!.text)![1]!);
    expectStatus(await stranger().post("/api/public/privacy/confirm", { token: resetToken }, { csrf: false }), 400);
  });

  it("people who opted out don't come back with the next shared data import", async () => {
    const address = "casey.optout@example.test";
    json(await stranger().post("/api/public/privacy/opt-out", { ...optOut(address), linkedin_url: "https://www.linkedin.com/in/casey-optout-test/" }, { csrf: false }));
    const headers = ["First Name", "Last Name", "Email", "LinkedIn", "Company", "Domain"];
    const row = (first: string, email: string, linkedin = "") => ({ "First Name": first, "Last Name": "Import", Email: email, LinkedIn: linkedin, Company: "Example Widgets", Domain: "example.com" });
    const summary = await importDatasetRows(
      [row("Casey", address), row("Casey", "casey.new-job@example.test", "https://linkedin.com/in/Casey-Optout-Test"), row("Jo", "jo.fresh@example.test")],
      headers,
      null,
    );
    assert.equal(summary.suppressed, 2);
    assert.equal(summary.people_created, 1);
    const people = await db.select({ email: schema.lfPeople.email }).from(schema.lfPeople).where(isNull(schema.lfPeople.workspaceId));
    assert.ok(people.some((p) => p.email === "jo.fresh@example.test"));
    assert.ok(!people.some((p) => p.email === address || p.email === "casey.new-job@example.test"));
  });

  it("a removal request confirmed by link removes the profile", async () => {
    const address = "lee.profile@example.test";
    const [p] = await db.insert(schema.lfPeople).values({ firstName: "Lee", lastName: "Profile", email: address }).returning();
    json(
      await stranger().post(
        "/api/public/privacy/requests",
        { ...who(address), applicant_type: "self", country: "United States", state: "California", requests: ["delete"], confirm: true },
        { csrf: false },
      ),
    );
    assert.equal((await db.select().from(schema.lfPeople).where(eq(schema.lfPeople.id, p!.id))).length, 1, "nothing happens before the link");
    const outcome = json(await stranger().post("/api/public/privacy/confirm", { token: confirmToken(address) }, { csrf: false }));
    assert.deepEqual(outcome, { type: "removal", status: "resolved", done: ["delete"], waiting: [] });
    assert.equal((await db.select().from(schema.lfPeople).where(eq(schema.lfPeople.id, p!.id))).length, 0);
    assert.equal((await suppressed("email", address))?.reason, "removal");
  });

  it("bots that fill the hidden field get a thank-you and nothing else", async () => {
    const before = systemMailLog.length;
    const res = await stranger().post(
      "/api/public/privacy/requests",
      { ...who("bot-target@example.test"), applicant_type: "self", country: "United States", requests: ["access"], confirm: true, website: "https://spam.example" },
      { csrf: false },
    );
    assert.deepEqual(json(res), { ok: true });
    assert.equal(systemMailLog.length, before);
    assert.equal(mailsTo("bot-target@example.test").length, 0);
    assert.equal((await db.select().from(schema.privacyRequests).where(eq(schema.privacyRequests.email, "bot-target@example.test"))).length, 0);
  });

  it("limits forms per address, whichever network they come from", async () => {
    const address = "often@example.test";
    for (let i = 0; i < 3; i++) expectStatus(await stranger().post("/api/public/privacy/opt-out", optOut(address), { csrf: false }), 200);
    const res = await stranger().post("/api/public/privacy/opt-out", optOut(address), { csrf: false });
    expectStatus(res, 429);
    assert.equal(res.json().code, "rate_limited");
  });
});

describe("abuse reports", () => {
  it("unknown report ids are refused", async () => {
    for (const id of ["nothing", emailToken(randomUUID())]) {
      assert.deepEqual(json(await stranger().post("/api/public/abuse/verify", { id }, { csrf: false })), { status: "invalid" });
      expectStatus(await stranger().post("/api/public/abuse/submit", { id }, { csrf: false }), 400);
    }
  });

  it("a report unsubscribes the person, keeps every campaign from emailing them, and tells the sender once", async () => {
    const address = "reporter@example.test";
    const { token, leadId } = await sentTo(address);
    const verify = () => stranger().post("/api/public/abuse/verify", { id: token }, { csrf: false });
    assert.equal(json(await verify()).status, "valid");
    assert.equal(json(await stranger().post("/api/public/abuse/submit", { id: token }, { csrf: false })).status, "reported");
    assert.equal(json(await verify()).status, "reported");
    assert.equal(json(await stranger().post("/api/public/abuse/submit", { id: token }, { csrf: false })).status, "already");

    assert.equal(await leadStatus(leadId!), LeadStatus.UNSUBSCRIBED);
    assert.equal((await workspaceUnsubscribed(address)).unsubscribed, true);
    const entry = await db.select().from(schema.privacySuppressions).where(and(eq(schema.privacySuppressions.type, "email"), eq(schema.privacySuppressions.value, address)));
    assert.equal(entry[0]?.blockSending, true);
    const notices = mailsTo(alice.email).filter((m) => /reported as unwanted/.test(m.subject));
    assert.equal(notices.length, 1);
    assert.ok(mailsTo(owner.email).some((m) => m.subject === "New abuse report"));
    assert.equal(mailsTo(address).length, 0, "the person who reported gets no mail");
  });
});

describe("webhooks from other services", () => {
  const SECRET = "test-webhook-secret-not-real";
  const sign = (body: string, t: number, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

  it("Stripe signatures must match the body, the secret and a recent time", () => {
    const body = JSON.stringify({ id: "evt_test", type: "customer.subscription.updated" });
    const now = Math.floor(Date.now() / 1000);
    assert.equal(verifyStripeSignature(body, sign(body, now), SECRET), true);
    assert.equal(verifyStripeSignature(body, `${sign(body, now)},v1=${"0".repeat(64)}`, SECRET), true);
    assert.equal(verifyStripeSignature(`${body} `, sign(body, now), SECRET), false);
    assert.equal(verifyStripeSignature(body, sign(body, now, "another-secret"), SECRET), false);
    assert.equal(verifyStripeSignature(body, sign(body, now - 600), SECRET), false);
    assert.equal(verifyStripeSignature(body, sign(body, now + 600), SECRET), false);
    assert.equal(verifyStripeSignature(body, `t=${now}`, SECRET), false);
    assert.equal(verifyStripeSignature(body, undefined, SECRET), false);
    assert.equal(verifyStripeSignature(body, "", SECRET), false);
  });

  it("unsigned or unconfigured webhooks are refused", async () => {
    const event = JSON.stringify({ id: "evt_test", type: "checkout.session.completed", data: { object: {} } });
    expectStatus(await stranger().request("POST", "/api/webhooks/stripe", event, { csrf: false, headers: { "content-type": "application/json" } }), 503);
    for (const path of ["/api/webhooks/twilio/sms", "/api/webhooks/twilio/voice", "/api/webhooks/twilio/call-status"]) {
      const res = await stranger().request("POST", path, "From=%2B15555550100&To=%2B15555550101&Body=hi", {
        csrf: false,
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bm90LWEtcmVhbC1zaWduYXR1cmU=" },
      });
      expectStatus(res, 400, path);
    }
    expectStatus(await stranger().post(`/api/hooks/automations/${"z".repeat(32)}`, { hello: "world" }, { csrf: false }), 404);
    expectStatus(await stranger().post("/api/hooks/automations/short", { hello: "world" }, { csrf: false }), 400);
  });
});

// Custom tracking domains (services/tracking-domains.ts): links use one only while HTTPS reaches this installation under
// it, checked when it's set, on request and every hour. DNS and HTTPS answers come from stand-ins; nothing is looked up
// for real. Also the shared reading of HTML character references. Every name here is made up.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ProviderCode, decodeEntities, htmlToText } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { verifyHmac } from "../src/lib/crypto";
import { outbound } from "../src/lib/net";
import { checkTrackingDomain, healthProof, recheckTrackingDomains, trackingProbes } from "../src/services/tracking-domains";

let app: FastifyInstance;
let user: TestUser;
const real = { ...trackingProbes };
/** What the stand-in DNS and HTTPS checks answer, and how often HTTPS was asked. */
const answers = { cname: true, https: false, asked: 0 };

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Domains Co" });
  trackingProbes.cname = async () => answers.cname;
  trackingProbes.https = async () => {
    answers.asked++;
    return answers.https;
  };
});
after(async () => {
  Object.assign(trackingProbes, real);
  await stopServer();
});

async function mailbox(): Promise<string> {
  return json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email as string;
}
const statusOf = async (email: string) => (await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.email, email)))[0]!.trackingDomainStatus;

describe("custom tracking domains", () => {
  it("are used once HTTPS reaches this installation under them, whatever the request says", async () => {
    const box = await mailbox();
    Object.assign(answers, { cname: true, https: false });
    const set = json(await user.client.patch(`/api/v2/accounts/${box}`, { tracking_domain_name: "track.acme-mail.com", tracking_domain_status: "verified" }));
    assert.equal(set.tracking_domain_status, "pending", "a DNS record without working HTTPS would break every link");

    answers.https = true;
    const check = json(await user.client.post(`/api/app/accounts/${box}/ctd/check`));
    assert.deepEqual([check.status, check.cname, check.ssl], ["verified", true, true]);
    assert.equal(await statusOf(box), "verified");

    // Saving the mailbox's other settings doesn't look a working domain up again.
    const asked = answers.asked;
    json(await user.client.patch(`/api/v2/accounts/${box}`, { tracking_domain_name: "track.acme-mail.com", daily_limit: 40 }));
    assert.equal(answers.asked, asked);
    assert.equal(await statusOf(box), "verified");

    expectStatus(await user.client.patch(`/api/v2/accounts/${box}`, { tracking_domain_name: "not a domain" }), 400);
  });

  it("fall back to the shared address when HTTPS stops working there, and come back when it works", async () => {
    const box = await mailbox();
    Object.assign(answers, { cname: true, https: true });
    json(await user.client.patch(`/api/v2/accounts/${box}`, { tracking_domain_name: "links.bright-mail.com" }));
    assert.equal(await statusOf(box), "verified");

    answers.https = false;
    await recheckTrackingDomains();
    assert.equal(await statusOf(box), "pending");
    answers.https = true;
    await recheckTrackingDomains();
    assert.equal(await statusOf(box), "verified");
  });

  it("on a new mailbox are checked too, whatever status the request names", async () => {
    Object.assign(answers, { cname: true, https: false });
    const add = (email: string, extra: Record<string, unknown> = {}) =>
      user.client.post("/api/v2/accounts", { email, provider_code: ProviderCode.SANDBOX, tracking_domain_name: "track.added-mail.com", ...extra });
    const first = json(await add("first.box@added-mail.test", { tracking_domain_status: "verified" }));
    assert.equal(first.tracking_domain_status, "pending");

    answers.https = true;
    json(await user.client.post(`/api/app/accounts/${first.email}/ctd/check`));
    // A domain mailboxes already use (verified) isn't looked up again for the next one.
    const asked = answers.asked;
    assert.equal(json(await add("second.box@added-mail.test")).tracking_domain_status, "verified");
    assert.equal(answers.asked, asked);
    expectStatus(await add("third.box@added-mail.test", { tracking_domain_name: "not a domain" }), 400);
  });

  it("reserved names are never looked up", async () => {
    const asked = answers.asked;
    assert.deepEqual(await checkTrackingDomain("track.acme.test"), { cname: false, ssl: false, status: "pending" });
    assert.equal(answers.asked, asked);
  });

  it("count only an answer from this installation", async () => {
    const challenge = "a-challenge-of-sixteen";
    const health = JSON.parse((await app.inject({ method: "GET", url: `/api/health?challenge=${challenge}` })).body) as { proof: string };
    assert.ok(verifyHmac(`health:${challenge}`, health.proof, 16));
    assert.equal(health.proof, healthProof(challenge));

    // The real check, over a stand-in for the network: this server answering, then others.
    const send = outbound.send;
    try {
      outbound.send = async (url) => {
        const u = new URL(url);
        const res = await app.inject({ method: "GET", url: u.pathname + u.search });
        return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
      };
      assert.equal(await real.https("93.184.216.34"), true);
      outbound.send = async () => new Response(JSON.stringify({ ok: true, proof: "x".repeat(16) }), { status: 200 });
      assert.equal(await real.https("93.184.216.34"), false, "another server's answer");
      outbound.send = async () => new Response("<html><body>Welcome</body></html>", { status: 200 });
      assert.equal(await real.https("93.184.216.34"), false, "a web page");
      outbound.send = async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } });
      };
      assert.equal(await real.https("93.184.216.34"), false, "a certificate for another name");
    } finally {
      outbound.send = send;
    }
  });
});

describe("HTML character references", () => {
  it("are read once, as a browser reads them", () => {
    assert.equal(decodeEntities("a &amp;lt; b &#39;c&#x27; &eacute;&Eacute; &copy=2 &unknown; &#0; &#xD800;"), "a &lt; b 'c' éÉ &copy=2 &unknown; � �");
    assert.equal(htmlToText("<p>Don&#8217;t&nbsp;stop &amp;lt;3 &mdash; ok</p>"), "Don’t stop &lt;3 — ok");
  });
});

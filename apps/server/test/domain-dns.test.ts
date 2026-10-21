// DNS checks of sending domains (services/domain-dns.ts): MX, SPF, DKIM and DMARC per domain, kept per workspace and
// shown on the account list. DNS answers come from a stand-in zone below; nothing is looked up for real.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { ProviderCode } from "@reachstack/shared";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { checkDomainAuth, checkDomainBlocklists, organizationalDomain } from "../src/lib/dns";
import { emit } from "../src/services/bus";
import { refreshDomainChecks } from "../src/services/domain-dns";

type Zone = { mx?: string[]; txt?: Record<string, string | string[]> } | "timeout";
const ZONE: Record<string, Zone> = {
  // Everything in place, DKIM under Google's selector.
  "good.example.com": {
    mx: ["mx1.good.example.com"],
    txt: { "": "v=spf1 include:_spf.example.com ~all", _dmarc: "v=DMARC1; p=none", "google._domainkey": "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC" },
  },
  // Sends and receives, but no DKIM and no DMARC.
  "nodmarc.example.net": { mx: ["mx.nodmarc.example.net"], txt: { "": "v=spf1 -all" } },
  // The DNS server never answers: unknown, not missing.
  "flaky.example.org": "timeout",
  // Added later, for the "new mailbox" and background checks.
  "fresh.example.com": { mx: ["mx.fresh.example.com"], txt: { "": "v=spf1 ~all", _dmarc: "v=DMARC1; p=reject" } },
  "later.example.com": { mx: ["mx.later.example.com"] },
  // Two SPF records: as good as none.
  "twospf.example.com": {
    mx: ["mx.twospf.example.com"],
    txt: { "": ["v=spf1 include:_spf.example.com ~all", "v=spf1 include:spf.example.net ~all"], _dmarc: "v=DMARC1; p=none", "google._domainkey": "v=DKIM1; k=rsa; p=MIGfMA0G" },
  },
  // A DKIM key that was withdrawn (an empty p=).
  "revoked.example.com": { mx: ["mx.revoked.example.com"], txt: { "": "v=spf1 -all", _dmarc: "v=DMARC1; p=none", "google._domainkey": "v=DKIM1; k=rsa; p=" } },
  // DMARC at the organization's domain only: its subdomains are covered.
  "orgdmarc.co.uk": { mx: ["mx.orgdmarc.co.uk"], txt: { "": "v=spf1 -all", _dmarc: "v=DMARC1; p=reject" } },
};

const P = dns.promises.Resolver.prototype as unknown as Record<string, (name: string) => Promise<unknown>>;
const saved = { resolveMx: P.resolveMx, resolveTxt: P.resolveTxt, resolveCname: P.resolveCname, resolve4: P.resolve4 };
const fail = (code: string, name: string) => Object.assign(new Error(`${code} ${name}`), { code });
function find(name: string): { zone: Zone; label: string } | null {
  for (const [domain, zone] of Object.entries(ZONE)) {
    if (name === domain) return { zone, label: "" };
    if (name.endsWith(`.${domain}`)) return { zone, label: name.slice(0, -domain.length - 1) };
  }
  return null;
}

let app: FastifyInstance;
let alice: TestUser;
let bob: TestUser;

async function mailbox(owner: TestUser, email: string, providerCode: number = ProviderCode.CUSTOM) {
  const [row] = await db.insert(schema.emailAccounts).values({ workspaceId: owner.workspaceId!, email, providerCode }).returning();
  return row!;
}
const listed = async (owner: TestUser, query = "") => json(await owner.client.get(`/api/v2/accounts?limit=100${query}`)).items as Array<{ email: string; dns: any }>;

before(async () => {
  P.resolveMx = async (name: string) => {
    const hit = find(name);
    if (hit?.zone === "timeout") throw fail("ETIMEOUT", name);
    if (!hit || hit.label || !hit.zone.mx) throw fail("ENOTFOUND", name);
    return hit.zone.mx.map((exchange, i) => ({ exchange, priority: 10 * (i + 1) }));
  };
  P.resolveTxt = async (name: string) => {
    const hit = find(name);
    if (hit?.zone === "timeout") throw fail("ETIMEOUT", name);
    const txt = hit?.zone.txt?.[hit.label];
    if (!txt) throw fail("ENOTFOUND", name);
    return (Array.isArray(txt) ? txt : [txt]).map((t) => [t]);
  };
  P.resolveCname = async (name: string) => {
    if (find(name)?.zone === "timeout") throw fail("ETIMEOUT", name);
    throw fail("ENOTFOUND", name);
  };
  app = await startServer();
  alice = await signUp(app, { workspaceName: "Alice DNS" });
  bob = await signUp(app, { workspaceName: "Bob DNS" });
  await mailbox(alice, "sales@good.example.com");
  await mailbox(alice, "hello@nodmarc.example.net");
  await mailbox(alice, "team@flaky.example.org");
  await mailbox(bob, "bob@nodmarc.example.net");
});

after(async () => {
  Object.assign(P, saved);
  await stopServer();
});

describe("checking sending domains", () => {
  it("finds each record and shows the result on the account list", async () => {
    const r = json(await alice.client.post("/api/app/accounts/dns-check", { emails: ["sales@good.example.com"] }));
    assert.equal(r.items.length, 1);
    const good = r.items[0];
    assert.deepEqual([good.domain, good.mx, good.spf, good.dkim, good.dmarc], ["good.example.com", true, true, true, true]);
    assert.equal(good.details.dkim_selector, "google");
    assert.equal(good.details.dmarc, "v=DMARC1; p=none");

    const rows = await listed(alice);
    assert.equal(rows.find((a) => a.email === "sales@good.example.com")?.dns?.spf, true);
    // Not checked yet: no result rather than a guess.
    assert.equal(rows.find((a) => a.email === "hello@nodmarc.example.net")?.dns, null);
    const one = json(await alice.client.get("/api/v2/accounts/sales@good.example.com"));
    assert.equal(one.dns.dkim, true);
  });

  it("tells a missing record from one that couldn't be looked up", async () => {
    const r = json(await alice.client.post("/api/app/accounts/dns-check", { include_all_emails: true }));
    const by = Object.fromEntries(r.items.map((d: any) => [d.domain, d]));
    assert.deepEqual(Object.keys(by).sort(), ["flaky.example.org", "good.example.com", "nodmarc.example.net"]);
    const nodmarc = by["nodmarc.example.net"];
    assert.deepEqual([nodmarc.mx, nodmarc.spf, nodmarc.dkim, nodmarc.dmarc], [true, true, false, false]);
    const flaky = by["flaky.example.org"];
    assert.deepEqual([flaky.mx, flaky.spf, flaky.dkim, flaky.dmarc], [null, null, null, null]);
  });

  it("filters and counts the mailboxes whose domain is missing a record", async () => {
    const problems = await listed(alice, "&filter=ACC_FILTER_DNS");
    assert.deepEqual(
      problems.map((a) => a.email),
      ["hello@nodmarc.example.net"],
    );
    const summary = json(await alice.client.get("/api/app/accounts/summary"));
    assert.equal(summary.dns_issues, 1);
  });

  it("keeps each workspace's results to itself", async () => {
    // Bob's mailbox shares a domain with one of Alice's, but nothing has been checked in Bob's workspace.
    assert.equal((await listed(bob))[0]?.dns, null);
    assert.equal(json(await bob.client.get("/api/app/accounts/summary")).dns_issues, 0);
    // Alice's addresses mean nothing in Bob's workspace.
    const r = json(await bob.client.post("/api/app/accounts/dns-check", { emails: ["sales@good.example.com"] }));
    assert.equal(r.items.length, 0);
    assert.equal((await listed(bob))[0]?.dns, null);
  });

  it("leaves sandbox mailboxes out", async () => {
    json(await alice.client.post("/api/app/accounts/sandbox", { count: 1, domain: "good.example.com" }));
    const r = json(await alice.client.post("/api/app/accounts/dns-check", { include_all_emails: true }));
    assert.equal(r.sandbox, 1);
    const sandbox = (await listed(alice)).find((a) => a.email !== "sales@good.example.com" && a.email.endsWith("@good.example.com"));
    assert.ok(sandbox, "the sandbox mailbox is listed");
    assert.equal(sandbox.dns, null);
  });

  it("checks a new mailbox's domain as soon as it's added", async () => {
    const row = await mailbox(alice, "new@fresh.example.com");
    emit("account_added", alice.workspaceId!, { account_id: row.id, email: row.email });
    let check: typeof schema.domainChecks.$inferSelect | undefined;
    for (let i = 0; i < 50 && !check; i++) {
      await new Promise((r) => setTimeout(r, 20));
      [check] = await db.select().from(schema.domainChecks).where(and(eq(schema.domainChecks.workspaceId, alice.workspaceId!), eq(schema.domainChecks.domain, "fresh.example.com")));
    }
    assert.ok(check, "checked without anyone asking");
    assert.equal(check.dmarc, true);
    assert.equal(check.dkim, false);
  });

  it("checks never-checked domains in the background and leaves fresh ones alone", async () => {
    await mailbox(alice, "late@later.example.com");
    const before = await db.select().from(schema.domainChecks).where(eq(schema.domainChecks.domain, "good.example.com"));
    await refreshDomainChecks();
    const [later] = await db.select().from(schema.domainChecks).where(eq(schema.domainChecks.domain, "later.example.com"));
    assert.ok(later, "the new domain was checked");
    assert.equal(later.spf, false);
    const after = await db.select().from(schema.domainChecks).where(eq(schema.domainChecks.domain, "good.example.com"));
    assert.equal(after[0]!.checkedAt.getTime(), before[0]!.checkedAt.getTime(), "a check from today isn't repeated");
    // Bob's workspace gets its own check of the shared domain.
    assert.equal((await listed(bob))[0]?.dns?.dmarc, false);
  });

  it("keeps the results of the API's vitals test", async () => {
    await db.delete(schema.domainChecks).where(eq(schema.domainChecks.workspaceId, alice.workspaceId!));
    const r = json(await alice.client.post("/api/v2/accounts/test/vitals", { accounts: ["sales@good.example.com"] }));
    assert.equal(r.success_list[0]?.domain, "good.example.com");
    assert.equal((await listed(alice)).find((a) => a.email === "sales@good.example.com")?.dns?.dmarc, true);
  });

  it("checks the workspace's own mailboxes only, not any address named", async () => {
    await db.delete(schema.domainChecks).where(eq(schema.domainChecks.workspaceId, bob.workspaceId!));
    const r = json(await bob.client.post("/api/v2/accounts/test/vitals", { accounts: ["sales@good.example.com", "anyone@fresh.example.com"] }));
    assert.deepEqual([r.success_list.length, r.failure_list.length], [0, 0]);
    assert.equal((await db.select().from(schema.domainChecks).where(eq(schema.domainChecks.workspaceId, bob.workspaceId!))).length, 0);
    const own = json(await bob.client.post("/api/v2/accounts/test/vitals", {}));
    assert.deepEqual(own.failure_list.map((d: { domain: string }) => d.domain), ["nodmarc.example.net"]);
  });
});

describe("records that are there but don't count", () => {
  it("two SPF records are no SPF, and the check says why", async () => {
    const r = await checkDomainAuth("twospf.example.com");
    assert.deepEqual([r.spf, r.dkim, r.dmarc], [false, true, true]);
    assert.match(r.details.notes?.spf ?? "", /2 SPF records/);
  });

  it("a withdrawn DKIM key (an empty p=) isn't DKIM", async () => {
    const r = await checkDomainAuth("revoked.example.com");
    assert.equal(r.dkim, false);
    assert.match(r.details.notes?.dkim ?? "", /revoked/);
  });

  it("a subdomain is covered by its organization's DMARC record", async () => {
    const r = await checkDomainAuth("mail.orgdmarc.co.uk");
    assert.equal(r.dmarc, true);
    assert.equal(r.details.dmarc_domain, "orgdmarc.co.uk");
    assert.equal(r.details.dmarc, "v=DMARC1; p=reject");
    assert.equal(organizationalDomain("a.b.example.com"), "example.com");
    assert.equal(organizationalDomain("shop.example.com.au"), "example.com.au");
    assert.equal(organizationalDomain("example.com"), "example.com");
  });

  it("a blocklist that refuses to answer (127.0.0.1) hasn't listed the domain", async () => {
    P.resolve4 = async (name: string) => {
      if (name.endsWith(".multi.surbl.org")) return ["127.0.0.1"];
      if (name.endsWith(".dbl.spamhaus.org")) return ["127.0.1.2"];
      throw fail("ENOTFOUND", name);
    };
    try {
      const by = Object.fromEntries((await checkDomainBlocklists("listed-check.example.com")).map((h) => [h.list, h]));
      assert.equal(by["dbl.spamhaus.org"]?.listed, true);
      assert.deepEqual([by["multi.surbl.org"]?.listed, by["multi.surbl.org"]?.error], [false, true]);
    } finally {
      P.resolve4 = saved.resolve4;
    }
  });
});

describe("checking again", () => {
  it("looks the records up afresh, so one fixed a moment ago shows", async () => {
    ZONE["fixed.example.com"] = { mx: ["mx.fixed.example.com"], txt: { "": "v=spf1 ~all" } };
    await mailbox(alice, "ops@fixed.example.com");
    const first = json(await alice.client.post("/api/app/accounts/dns-check", { emails: ["ops@fixed.example.com"] })).items[0];
    assert.equal(first.dmarc, false);
    ZONE["fixed.example.com"] = { mx: ["mx.fixed.example.com"], txt: { "": "v=spf1 ~all", _dmarc: "v=DMARC1; p=quarantine" } };
    const again = json(await alice.client.post("/api/app/accounts/dns-check", { emails: ["ops@fixed.example.com"] })).items[0];
    assert.equal(again.dmarc, true);
  });
});

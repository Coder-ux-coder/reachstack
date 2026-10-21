// Website visitors: the snippet's collector, the companies found and what's done with them, setting up a domain,
// and the background lookups. Companies and addresses are made up (.test and documentation ranges), lookups are
// stubbed and nothing leaves the machine.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runVisitorLookups, saveLookupToken } from "../src/services/visitors";

const S = schema.visitorSites;
const V = schema.visitorSessions;
const P = schema.visitorPageviews;
const VV = schema.visitorViews;
const A = schema.visitorAlerts;

let app: FastifyInstance;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
});
after(stopServer);

let siteSeq = 0;
/** A domain set up in the user's workspace (the terms are another test's business). */
async function siteOf(u: TestUser, domain: string, settings: typeof S.$inferInsert.settings = {}) {
  return (await db.insert(S).values({ workspaceId: u.workspaceId!, domain, pixelKey: `wv_test_${++siteSeq}_${process.pid}`, settings }).returning())[0]!;
}

const companyData = (domain: string, extra: Record<string, unknown> = {}) => ({
  name: domain.split(".")[0],
  domain,
  industry: null,
  employee_count: null,
  revenue_range: null,
  country: null,
  city: null,
  logo_url: null,
  linkedin_url: null,
  description: null,
  source: "ip_lookup",
  network: null,
  ...extra,
});

/** One identified visit of `domain` per timestamp in `at`. */
async function identifiedVisits(u: TestUser, siteId: string, domain: string, at: number[], extra: Record<string, unknown> = {}) {
  const rows = at.map((t, i) => ({
    workspaceId: u.workspaceId!,
    siteId,
    visitorKey: `k-${domain}-${i}`,
    identified: true,
    resolveStatus: "identified",
    resolvedAt: new Date(t),
    companyDomain: domain,
    companyName: domain,
    companyData: companyData(domain, extra),
    firstSeenAt: new Date(t),
    lastSeenAt: new Date(t),
  }));
  for (let i = 0; i < rows.length; i += 500) await db.insert(V).values(rows.slice(i, i + 500));
}

describe("the snippet's collector", () => {
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  /** What the snippet sends: a beacon whose body is JSON as text. */
  const send = (event: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/wv/collect",
      headers: { "content-type": "text/plain", "user-agent": CHROME, ...headers },
      payload: JSON.stringify(event),
      remoteAddress: "198.51.100.77",
    });
  let user: TestUser;
  before(async () => {
    user = await signUp(app, { firstName: "Cole", workspaceName: "Collector Co" });
  });

  it("records a visit's pages, where it came from and how long each page was read", async () => {
    const site = await siteOf(user, "shop-a.test");
    const k = site.pixelKey;
    for (const e of [
      { k, v: "visitor-1", e: "pageview", u: "https://www.shop-a.test/pricing?utm_source=news", r: "https://search.test/results?q=shoes", t: "Pricing" },
      { k, v: "visitor-1", e: "pageview", u: "https://shop-a.test/docs", r: "https://shop-a.test/pricing" },
      { k, v: "visitor-1", e: "leave", u: "https://shop-a.test/docs", d: 42 },
    ]) {
      assert.equal((await send(e)).statusCode, 204);
    }
    const visits = await db.select().from(V).where(eq(V.siteId, site.id));
    assert.equal(visits.length, 1);
    const [v] = visits;
    assert.deepEqual([v!.pageviews, v!.durationSec, v!.referrer, v!.utm, v!.landingUrl], [2, 42, "https://search.test/results", { utm_source: "news" }, "https://www.shop-a.test/pricing?utm_source=news"]);
    const pages = await db.select().from(P).where(eq(P.sessionId, v!.id));
    assert.deepEqual(
      pages.map((p) => [p.path, p.title, p.durationSec]).sort(),
      [
        ["/docs", null, 42],
        ["/pricing", "Pricing", 0],
      ],
    );
  });

  it("leaves out other websites, robots, excluded pages and events it can't place", async () => {
    const site = await siteOf(user, "shop-b.test", { exclude_paths: ["/admin"] });
    const k = site.pixelKey;
    const ignored: Array<[Record<string, unknown>, Record<string, string>?]> = [
      [{ k, v: "x1", e: "pageview", u: "https://elsewhere.test/" }],
      [{ k, v: "x2", e: "pageview", u: "https://shop-b.test.elsewhere.test/" }],
      [{ k, v: "x3", e: "pageview", u: "https://shop-b.test/" }, { origin: "https://elsewhere.test" }],
      [{ k, v: "x4", e: "pageview", u: "https://shop-b.test/" }, { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0" }],
      [{ k, v: "x5", e: "pageview", u: "https://shop-b.test/admin/users" }],
      [{ k, e: "pageview", u: "https://shop-b.test/" }],
      [{ k, v: "x7", e: "pageview", u: "javascript:alert(1)" }],
      [{ k: "wv_unknown_key", v: "x8", e: "pageview", u: "https://shop-b.test/" }],
      [{ k, v: "x9", e: "leave", u: "https://shop-b.test/", d: 30 }],
    ];
    for (const [e, headers] of ignored) assert.equal((await send(e, headers)).statusCode, 204);
    assert.equal((await db.select().from(V).where(eq(V.siteId, site.id))).length, 0);
    // Not JSON at all is answered the same way.
    const garbled = await app.inject({ method: "POST", url: "/wv/collect", headers: { "content-type": "text/plain", "user-agent": CHROME }, payload: "{not json", remoteAddress: "198.51.100.77" });
    assert.equal(garbled.statusCode, 204);
    // The excluded section's own neighbours still count.
    assert.equal((await send({ k, v: "x10", e: "pageview", u: "https://blog.shop-b.test/administration" })).statusCode, 204);
    assert.equal((await db.select().from(V).where(eq(V.siteId, site.id))).length, 1);
  });

  it("confirms the snippet is installed when a test visit comes in", async () => {
    const site = await siteOf(user, "shop-c.test");
    const before = json(await user.client.get("/api/app/website-visitors/sites")).items.find((s: { id: string }) => s.id === site.id);
    assert.equal(before.test_status, "not_tested");
    assert.equal((await send({ k: site.pixelKey, e: "test", u: "https://shop-c.test/?wv_test=1" })).statusCode, 204);
    const after = json(await user.client.get("/api/app/website-visitors/sites")).items.find((s: { id: string }) => s.id === site.id);
    assert.equal(after.test_status, "successful");
  });
});

describe("companies that visited", () => {
  it("are all listed, however many visits one of them has", async () => {
    const u = await signUp(app, { firstName: "Bea", workspaceName: "Busy Co" });
    const site = await siteOf(u, "busy.test");
    const now = Date.now();
    // A company that's on the site all day, and two that came by once, earlier.
    await identifiedVisits(
      u,
      site.id,
      "regular.test",
      Array.from({ length: 5_001 }, (_, i) => now - i),
    );
    await identifiedVisits(u, site.id, "once-a.test", [now - 3_600_000]);
    await identifiedVisits(u, site.id, "once-b.test", [now - 7_200_000]);
    const page = json(await u.client.get("/api/app/website-visitors/companies?days=30"));
    assert.equal(page.total, 3);
    assert.deepEqual(
      page.items.map((c: { domain: string; visits: number }) => [c.domain, c.visits]),
      [
        ["regular.test", 5_001],
        ["once-a.test", 1],
        ["once-b.test", 1],
      ],
    );
  });

  it("are all exported, and all added by “select all”, past five thousand", async () => {
    const u = await signUp(app, { firstName: "Max", workspaceName: "Many Co" });
    const site = await siteOf(u, "many.test");
    const now = Date.now();
    const rows = Array.from({ length: 5_001 }, (_, i) => ({
      workspaceId: u.workspaceId!,
      siteId: site.id,
      visitorKey: `k-many-${i}`,
      identified: true,
      resolveStatus: "identified",
      resolvedAt: new Date(now - i),
      companyDomain: `co-${i}.test`,
      companyName: `Co ${i}`,
      companyData: companyData(`co-${i}.test`),
      firstSeenAt: new Date(now - i),
      lastSeenAt: new Date(now - i),
    }));
    for (let i = 0; i < rows.length; i += 500) await db.insert(V).values(rows.slice(i, i + 500));
    const csv = await u.client.get("/api/app/website-visitors/export?days=30");
    assert.equal(csv.statusCode, 200);
    assert.equal(csv.body.trim().split("\n").length, 1 + 5_001);
    const list = json(await u.client.post("/api/v2/lead-lists", { name: "Visitors" }));
    const added = json(await u.client.post("/api/app/website-visitors/add-leads", { all: { days: 30 }, list_id: list.id }));
    // None of these made-up companies has people in the lead data, so all of them are counted as without a contact.
    assert.deepEqual([added.companies, added.without_contact, added.leads_uploaded], [5_001, 5_001, 0]);
  });
});

describe("a domain's settings", () => {
  it("re-score its visits against a new ideal customer profile", async () => {
    const u = await signUp(app, { firstName: "Ida", workspaceName: "Profile Co" });
    const site = await siteOf(u, "profile.test");
    const now = Date.now();
    await identifiedVisits(u, site.id, "software.test", [now, now - 1], { industry: "Software & Internet" });
    await identifiedVisits(u, site.id, "retail.test", [now - 2], { industry: "Retail" });
    const scores = async () =>
      Object.fromEntries((await db.select().from(V).where(eq(V.siteId, site.id))).map((v) => [`${v.companyDomain}:${v.visitorKey}`, v.matchesIcp]));
    json(await u.client.patch(`/api/app/website-visitors/sites/${site.id}`, { icp: { industries: ["Software & Internet"] } }));
    assert.deepEqual(await scores(), { "software.test:k-software.test-0": true, "software.test:k-software.test-1": true, "retail.test:k-retail.test-0": false });
    json(await u.client.patch(`/api/app/website-visitors/sites/${site.id}`, { icp: {} }));
    assert.deepEqual(Object.values(await scores()), [null, null, null]);
  });

  it("go with it when it's deleted, with its tracking filters and their alerts", async () => {
    const u = await signUp(app, { firstName: "Del", workspaceName: "Delete Co" });
    const site = await siteOf(u, "gone.test");
    const keep = await siteOf(u, "kept.test");
    const views = await db
      .insert(VV)
      .values([
        { workspaceId: u.workspaceId!, siteId: site.id, name: "Only gone.test", filters: {}, destinations: { webhook_url: "https://hooks.invalid/wv" } },
        { workspaceId: u.workspaceId!, siteId: keep.id, name: "Only kept.test", filters: {}, destinations: { webhook_url: "https://hooks.invalid/wv" } },
      ])
      .returning();
    await db.insert(A).values(views.map((v, i) => ({ workspaceId: u.workspaceId!, viewId: v.id, sessionId: `visit-${i}`, companyDomain: "someone.test", day: "2026-10-01" })));
    json(await u.client.delete(`/api/app/website-visitors/sites/${site.id}`));
    const left = await db
      .select()
      .from(A)
      .where(
        inArray(
          A.viewId,
          views.map((v) => v.id),
        ),
      );
    assert.deepEqual(
      left.map((a) => a.viewId),
      [views[1]!.id],
    );
    assert.deepEqual(
      (await db.select().from(VV).where(eq(VV.workspaceId, u.workspaceId!))).map((v) => v.name),
      ["Only kept.test"],
    );
  });
});

describe("background lookups", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("go to the workspaces that can look visits up, a share each round", async () => {
    // Every address belongs to a made-up company named after its last number.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const ip = decodeURIComponent(String(input instanceof Request ? input.url : input).split("/").at(-2) ?? "");
      const n = ip.split(".").at(-1);
      return Response.json({ ip, country: "DE", company: { type: "business", name: `Net ${n}`, domain: `net-${n}.test` } });
    }) as typeof fetch;
    const [waiting, first, second] = [
      await signUp(app, { firstName: "Wes", workspaceName: "No Token Co" }),
      await signUp(app, { firstName: "Fia", workspaceName: "Token Co" }),
      await signUp(app, { firstName: "Sam", workspaceName: "Token Too Co" }),
    ];
    await saveLookupToken(first.workspaceId!, "local-test-only");
    await saveLookupToken(second.workspaceId!, "local-test-only");
    const now = Date.now();
    const pending = async (u: TestUser, n: number, newest: number, net: string) => {
      const site = await siteOf(u, `${u.workspaceId}.test`);
      const rows = Array.from({ length: n }, (_, i) => ({
        workspaceId: u.workspaceId!,
        siteId: site.id,
        visitorKey: `k-${i}`,
        ip: `${net}.${(i % 250) + 1}`,
        firstSeenAt: new Date(newest - i),
        lastSeenAt: new Date(newest - i),
      }));
      for (let i = 0; i < rows.length; i += 500) await db.insert(V).values(rows.slice(i, i + 500));
    };
    // The newest visits wait for a token that isn't there; the two workspaces with one come after them.
    await pending(waiting, 250, now, "198.51.100");
    await pending(second, 40, now - 60_000, "203.0.113");
    await pending(first, 40, now - 120_000, "203.0.113");
    await runVisitorLookups();
    const identified = async (u: TestUser) => (await db.select().from(V).where(eq(V.workspaceId, u.workspaceId!))).filter((v) => v.resolveStatus === "identified").length;
    assert.equal(await identified(waiting), 0);
    assert.equal(await identified(first), 25);
    assert.equal(await identified(second), 25);
  });
});

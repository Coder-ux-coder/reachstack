// What Lead Finder and website visitors charge on a workspace that pays per use (one the owner hasn't made
// unlimited), and the imports and enrichment runs around those charges: every credit is for something delivered,
// once. People, companies and addresses are made up (.test), lookups are stubbed and nothing leaves the machine.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNull, sql } from "drizzle-orm";
import { CREDIT_COSTS } from "@reachstack/shared";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { config } from "../src/env";
import { runPendingJobs } from "../src/engine/jobs";
import { HttpError } from "../src/http/errors";
import { on } from "../src/services/bus";
import { creditBalance } from "../src/services/billing-limits";
import { importDatasetRows } from "../src/services/lead-finder/dataset";
import { scheduleRun, upsertEnrichment } from "../src/services/lead-finder/enrichment";
import { unlockPeople } from "../src/services/lead-finder/imports";
import { countPeople, peopleByIds } from "../src/services/lead-finder/search";
import { identifyVisit, identifyWaiting } from "../src/services/visitors";
import { startOfDayOn, workspaceZone } from "../src/services/workspace-clock";

const J = schema.backgroundJobs;
const L = schema.leads;
const V = schema.visitorSessions;
const HEADERS = ["first_name", "last_name", "title", "email", "company", "domain"];

/** `n` people at one made-up company, with addresses p0@domain, p1@domain… */
const people = (domain: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ first_name: `P${i}`, last_name: "Test", title: "Head of Sales", email: `p${i}@${domain}`, company: domain, domain }));

let pay: TestUser;
let free: TestUser;
let other: TestUser;

/** Pays per use: on a trial (250 contacts, 50 identified companies a month) with `credits` to spend. */
async function meter(user: TestUser, credits: number) {
  const ws = user.workspaceId!;
  await db
    .update(schema.workspaces)
    .set({ selfHosted: false, trialEndsAt: new Date(Date.now() + 7 * 86_400_000) })
    .where(eq(schema.workspaces.id, ws));
  await db.insert(schema.creditLedger).values([
    { workspaceId: ws, pool: "credits", delta: credits, reason: "test_grant" },
    { workspaceId: ws, pool: "verification", delta: 10, reason: "test_grant" },
  ]);
}

before(async () => {
  const app = await startServer();
  await signUp(app); // the installation owner
  pay = await signUp(app, { firstName: "Pat", workspaceName: "Paying Co" });
  free = await signUp(app, { firstName: "Fay", workspaceName: "Unlimited Co" });
  other = await signUp(app, { firstName: "Oli", workspaceName: "Other Co" });
  await meter(pay, 200);
});
after(stopServer);

/** Runs jobs until none of the workspace's is waiting or running. */
async function settle(ws: string) {
  for (let i = 0; i < 200; i++) {
    await runPendingJobs();
    const open = await db.select({ id: J.id }).from(J).where(and(eq(J.workspaceId, ws), sql`${J.status} in ('pending', 'in-progress')`));
    if (!open.length) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Jobs didn't finish");
}

const jobResult = async (id: string) => (await db.select().from(J).where(eq(J.id, id)))[0]!;
const spent = async (ws: string, run: () => Promise<unknown>) => {
  const start = await creditBalance(ws);
  await run();
  return start - (await creditBalance(ws));
};

async function listWith(user: TestUser, name: string, leads: Array<Record<string, unknown>>) {
  const list = json(await user.client.post("/api/v2/lead-lists", { name }));
  json(await user.client.post("/api/v2/leads/add", { list_id: list.id, leads }));
  return list.id as string;
}

describe("revealing people", () => {
  it("is charged once when two reveals of the same people run at once", async () => {
    await importDatasetRows(people("twice.test", 3), HEADERS, null);
    const ids = (await db.select({ id: schema.lfPeople.id }).from(schema.lfPeople).where(sql`${schema.lfPeople.email} like '%@twice.test'`)).map((p) => p.id);
    const found = await peopleByIds(pay.workspaceId!, ids);
    let results: Array<Awaited<ReturnType<typeof unlockPeople>>> = [];
    const cost = await spent(pay.workspaceId!, async () => {
      results = await Promise.all([unlockPeople(pay.workspaceId!, null, found, "test:reveal"), unlockPeople(pay.workspaceId!, null, found, "test:reveal")]);
    });
    assert.equal(cost, 3 * CREDIT_COSTS.lead_finder_unlock);
    assert.equal(results[0]!.charged + results[1]!.charged, cost);
    assert.ok(results.every((r) => r.allowed.length === 3));
  });
});

describe("imports from a search", () => {
  it("that skip the people you already have still add every match", async () => {
    await importDatasetRows(people("many.test", 1_100), HEADERS, free.workspaceId);
    const r = json(
      await free.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", {
        search_filters: { domains: ["many.test"], skip_owned_leads: true },
        limit: 1_100,
        list_name: "Everyone at Many",
      }),
    );
    await settle(free.workspaceId!);
    const [n] = await db.select({ n: sql<number>`count(*)` }).from(L).where(eq(L.listId, r.resource_id));
    assert.equal(Number(n!.n), 1_100);
  });

  it("into a campaign pay for addresses only for the leads that went in", async () => {
    await importDatasetRows(people("blockco.test", 3), HEADERS, null);
    json(await pay.client.post("/api/v2/block-lists-entries", { bl_value: "p0@blockco.test" }));
    const c = json(await pay.client.post("/api/app/campaigns", { name: "Block Co" }));
    let job = "";
    const cost = await spent(pay.workspaceId!, async () => {
      job = json(await pay.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: { domains: ["blockco.test"] }, limit: 10, resource_id: c.id })).background_job_id;
      await settle(pay.workspaceId!);
    });
    const res = (await jobResult(job)).result as Record<string, unknown>;
    assert.equal(res.imported, 2);
    // Two people revealed, two addresses: the blocked one was left out before anything was paid for.
    assert.equal(cost, 2 * CREDIT_COSTS.lead_finder_unlock + 2 * CREDIT_COSTS.work_email_enrichment);
    assert.equal(res.duplicates, 1);
    assert.equal(res.credits_used, cost);
  });

  it("into a campaign stop at the plan's contact limit, keeping and paying for what went in", async () => {
    const full = await signUp(await startServer(), { firstName: "Flo", workspaceName: "Full Co" });
    await meter(full, 50);
    // The trial allows 250 contacts; 249 are in a list already.
    await listWith(full, "Already here", people("here.test", 249).map((p) => ({ email: p.email, first_name: p.first_name })));
    await importDatasetRows(people("limitco.test", 3), HEADERS, null);
    const c = json(await full.client.post("/api/app/campaigns", { name: "Limit Co" }));
    const run = async () => {
      let id = "";
      const cost = await spent(full.workspaceId!, async () => {
        id = json(await full.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: { domains: ["limitco.test"] }, limit: 10, resource_id: c.id })).background_job_id;
        await settle(full.workspaceId!);
      });
      return { job: await jobResult(id), cost };
    };
    const first = await run();
    assert.equal(first.job.status, "success");
    assert.deepEqual([(first.job.result as Record<string, unknown>).imported, (first.job.result as Record<string, unknown>).stop_reason], [1, "CONTACT_LIMIT"]);
    assert.equal(first.cost, 3 * CREDIT_COSTS.lead_finder_unlock + CREDIT_COSTS.work_email_enrichment);
    // Full now: the next import ends straight away, and its addresses cost nothing (the people were revealed before).
    const second = await run();
    assert.equal(second.job.status, "success", second.job.error ?? "");
    assert.deepEqual([(second.job.result as Record<string, unknown>).imported, (second.job.result as Record<string, unknown>).stop_reason], [0, "CONTACT_LIMIT"]);
    assert.equal(second.cost, 0);
  });

  it("whose search can't run fail before a list is made", async () => {
    const lists = async () => (await db.select({ id: schema.leadLists.id }).from(schema.leadLists).where(eq(schema.leadLists.workspaceId, free.workspaceId!))).length;
    const before = await lists();
    const res = await free.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: { company_list_id: "no-such-list" }, limit: 10, list_name: "Never" });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /Company list not found/);
    assert.equal(await lists(), before);
  });

  it("that fail on the way stop showing as running", async () => {
    const r = json(await free.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: { domains: ["many.test"] }, limit: 5, list_name: "Gone soon" }));
    // The list goes before the import starts.
    await db.delete(schema.leadLists).where(eq(schema.leadLists.id, r.resource_id));
    await settle(free.workspaceId!);
    assert.equal((await jobResult(r.background_job_id)).status, "failed");
    const [search] = await db.select().from(schema.enrichments).where(eq(schema.enrichments.id, r.id));
    assert.equal(search!.inProgress, false);
  });
});

describe("enrichment runs", () => {
  it("run on more leads than one database statement can name", async () => {
    const ws = free.workspaceId!;
    const list = await listWith(free, "Tidy", [
      { email: "ann@tidy.test", first_name: "ANN" },
      { email: "bo@tidy.test", first_name: "bo" },
    ]);
    const ids = (await db.select({ id: L.id }).from(L).where(eq(L.listId, list))).map((l) => l.id);
    await upsertEnrichment({ workspaceId: ws, resourceId: list, resourceType: 2, type: "normalize" });
    const filler = Array.from({ length: 40_000 }, (_, i) => `missing-${i}`);
    const job = await scheduleRun(ws, null, list, { leadIds: [...filler, ...ids], types: ["normalize"] });
    // What the job shows stays small.
    assert.equal((job!.data as Record<string, unknown>).leadIds, undefined);
    await settle(ws);
    const done = await jobResult(job!.id);
    assert.equal(done.status, "success", done.error ?? "");
    const filled = (await db.select({ p: L.payload }).from(L).where(eq(L.listId, list))).filter((l) => (l.p as Record<string, unknown> | null)?.clean_first_name);
    assert.equal(filled.length, 2);
  });

  it("picked up again after a restart leave the leads they already did alone", async () => {
    const ws = pay.workspaceId!;
    await importDatasetRows(people("redo.test", 2), HEADERS, ws);
    const list = await listWith(pay, "Redo", [{ email: "p0@redo.test" }, { email: "p1@redo.test" }]);
    // p0 was done before the app stopped.
    await db.update(L).set({ payload: { seniority: "Director-Level" } }).where(and(eq(L.listId, list), eq(L.email, "p0@redo.test")));
    await upsertEnrichment({ workspaceId: ws, resourceId: list, resourceType: 2, type: "fully_enriched_profile" });
    const job = await scheduleRun(ws, null, list, { types: ["fully_enriched_profile"] });
    await db.update(J).set({ attempts: 1 }).where(eq(J.id, job!.id));
    const cost = await spent(ws, () => settle(ws));
    assert.equal(cost, CREDIT_COSTS.fully_enriched_profile);
  });

  it("of a column that's already running are refused; other columns and just-added leads aren't", async () => {
    const ws = free.workspaceId!;
    const list = await listWith(free, "Busy", [{ email: "cy@busy.test", first_name: "Cy" }]);
    await upsertEnrichment({ workspaceId: ws, resourceId: list, resourceType: 2, type: "normalize" });
    await upsertEnrichment({ workspaceId: ws, resourceId: list, resourceType: 2, type: "engagement_score" });
    await upsertEnrichment({
      workspaceId: ws,
      resourceId: list,
      resourceType: 2,
      type: "ai_enrichment",
      payload: { columns: { one: { output_column: "one", prompt: "One" }, two: { output_column: "two", prompt: "Two" } } },
    });
    const refused = (err: unknown) => err instanceof HttpError && err.statusCode === 409;
    const first = await scheduleRun(ws, null, list, { types: ["normalize"] });
    await assert.rejects(scheduleRun(ws, null, list, { types: ["normalize"] }), refused);
    assert.ok(await scheduleRun(ws, null, list, { types: ["engagement_score"] }));
    assert.ok(await scheduleRun(ws, null, list, { types: ["normalize"], justAdded: true }));
    // AI columns: one running doesn't hold up another, but does hold up a run of every AI column.
    const one = await scheduleRun(ws, null, list, { types: ["ai_enrichment"], columnName: "one" });
    assert.ok(await scheduleRun(ws, null, list, { types: ["ai_enrichment"], columnName: "two" }));
    await assert.rejects(scheduleRun(ws, null, list, { types: ["ai_enrichment"] }), refused);
    // Stopped AI runs (nothing to answer them here), the rest finish; then the column runs again.
    await db.update(J).set({ status: "cancelled" }).where(and(eq(J.workspaceId, ws), sql`json_extract(${J.data}, '$.aiColumns') is not null`));
    assert.ok(one && first);
    await settle(ws);
    assert.ok(await scheduleRun(ws, null, list, { types: ["normalize"] }));
    await settle(ws);
    const [norm] = await db.select().from(schema.enrichments).where(and(eq(schema.enrichments.resourceId, list), eq(schema.enrichments.type, "normalize")));
    assert.equal(norm!.inProgress, false);
  });

  it("that fail on the way are closed and stop showing as running", async () => {
    const ws = free.workspaceId!;
    const list = await listWith(free, "Vanishing", [{ email: "di@gone.test", first_name: "Di" }]);
    const e = await upsertEnrichment({ workspaceId: ws, resourceId: list, resourceType: 2, type: "normalize" });
    const job = await scheduleRun(ws, null, list, { types: ["normalize"] });
    await db.delete(schema.leadLists).where(eq(schema.leadLists.id, list));
    await settle(ws);
    assert.equal((await jobResult(job!.id)).status, "failed");
    const [run] = await db.select().from(schema.enrichmentRuns).where(eq(schema.enrichmentRuns.jobId, job!.id));
    assert.equal(run!.status, "failed");
    const [row] = await db.select().from(schema.enrichments).where(eq(schema.enrichments.id, e.id));
    assert.equal(row!.inProgress, false);
  });
});

describe("email verification", () => {
  it("is charged only for fresh verdicts, and a check with no verdict is tried again", async () => {
    const ws = pay.workspaceId!;
    // example.org's mail servers can't be looked up here (no network), so its check reaches no verdict.
    const list = await listWith(pay, "Checks", [{ email: "ok@verify-co.test" }, { email: "who@example.org" }]);
    await upsertEnrichment({ workspaceId: ws, resourceId: list, resourceType: 2, type: "email_verification" });
    const firstRun = await spent(ws, async () => {
      await scheduleRun(ws, null, list, { types: ["email_verification"] });
      await settle(ws);
    });
    assert.equal(firstRun, CREDIT_COSTS.email_verification);
    const again = await spent(ws, async () => {
      await scheduleRun(ws, null, list, { types: ["email_verification"], overwrite: true });
      await settle(ws);
    });
    assert.equal(again, 0);
    const checks = await db.select().from(schema.emailVerifications).where(and(eq(schema.emailVerifications.workspaceId, ws), eq(schema.emailVerifications.email, "who@example.org")));
    assert.equal(checks.length, 2);
    assert.ok(checks.every((c) => c.creditsUsed === 0));
    // A provider lookup of a recent check, and a single check with no verdict, cost nothing either.
    const lookup = json(
      await pay.client.post("/api/v2/supersearch-enrichment/integrations/run", { provider_id: "verifier", action_id: "verify_email", inputs: { email: "ok@verify-co.test" }, credential_source: "instantly_key" }),
    );
    assert.equal(lookup.credits_used, 0);
    const single = json(await pay.client.post("/api/v2/email-verification", { email: "who@example.org" }));
    assert.equal(single.credits_used, 0);
    assert.equal(await creditBalance(ws, "verification"), 10);
  });
});

describe("look-alike searches", () => {
  it("compare only against the shared dataset and the workspace's own companies", async () => {
    const headers = [...HEADERS, "industry", "employees"];
    const row = (first: string, domain: string, employees: string) => ({ first_name: first, last_name: "Test", title: "CEO", email: `${first.toLowerCase()}@${domain}`, company: domain, domain, industry: "Quiet Things", employees });
    await importDatasetRows([row("Ida", "privco.test", "100")], headers, other.workspaceId);
    await importDatasetRows([row("Mo", "mine.test", "100"), row("Lu", "likeco.test", "120")], headers, pay.workspaceId);
    assert.equal(await countPeople(pay.workspaceId!, { look_alike: "mine.test" }), 1);
    // Another workspace's private company is unknown here.
    assert.equal(await countPeople(pay.workspaceId!, { look_alike: "privco.test" }), 0);
  });
});

describe("website visitors over the monthly limit", () => {
  // Lookups answer from this table (and take a moment, so two at once overlap).
  const COMPANY: Record<string, { name: string; domain: string }> = {
    "203.0.113.10": { name: "Repeat Co", domain: "repeat.test" },
    "203.0.113.11": { name: "Repeat Co", domain: "repeat.test" },
    "203.0.113.12": { name: "Repeat Co", domain: "repeat.test" },
    "203.0.113.20": { name: "Hush Co", domain: "hush.test" },
    "203.0.113.21": { name: "Hush Co", domain: "hush.test" },
    "203.0.113.30": { name: "Once Co", domain: "once.test" },
  };
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  const savedToken = config.ipinfoToken;
  let site = "";
  let ws = "";

  const visit = async (ip: string | null, extra: Partial<typeof V.$inferInsert> = {}) =>
    (
      await db
        .insert(V)
        .values({ workspaceId: ws, siteId: site, visitorKey: `k-${ip}-${Math.random()}`, ip, resolveStatus: "limit", firstSeenAt: new Date(), lastSeenAt: new Date(), ...extra })
        .returning()
    )[0]!.id;

  before(async () => {
    ws = pay.workspaceId!;
    config.ipinfoToken = "local-test-only";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const ip = decodeURIComponent(String(input instanceof Request ? input.url : input).split("/").at(-2) ?? "");
      asked.push(ip);
      await new Promise((r) => setTimeout(r, 30));
      const c = COMPANY[ip];
      return Response.json(c ? { ip, country: "DE", company: { type: "business", ...c } } : { ip, bogon: true });
    }) as typeof fetch;
    site = (await db.insert(schema.visitorSites).values({ workspaceId: ws, domain: "paying-co.test", pixelKey: "pk-paying-co" }).returning())[0]!.id;
    // The trial's 50 companies this month are used up.
    for (let i = 0; i < 50; i++) {
      const company = { name: `Seen ${i}`, domain: `seen-${i}.test`, industry: null, employee_count: null, revenue_range: null, country: null, city: null, logo_url: null, linkedin_url: null, description: null, source: "ip_lookup", network: null };
      await visit(null, { identified: true, resolveStatus: "identified", resolvedAt: new Date(), companyDomain: company.domain, companyName: company.name, companyData: company });
    }
  });
  after(() => {
    globalThis.fetch = realFetch;
    config.ipinfoToken = savedToken;
  });

  it("cost one credit per company, however many of its visits are identified", async () => {
    const ids = [await visit("203.0.113.10"), await visit("203.0.113.11"), await visit("203.0.113.12")];
    let out = { identified: 0 };
    const cost = await spent(ws, async () => {
      out = await identifyWaiting(ws, 10);
    });
    assert.equal(out.identified, ids.length);
    assert.equal(cost, 1);
  });

  it("are looked up (and charged) once when two lookups of a visit start together", async () => {
    const id = await visit("203.0.113.30");
    asked.length = 0;
    const cost = await spent(ws, () => Promise.all([identifyVisit(id, { allowLimited: true }), identifyVisit(id, { allowLimited: true })]));
    assert.deepEqual(asked, ["203.0.113.30"]);
    assert.equal(cost, 1);
    const [row] = await db.select().from(V).where(eq(V.id, id));
    assert.deepEqual([row!.resolveStatus, row!.lookupAt], ["identified", null]);
  });

  it("of a company you hid stay hidden, with no alerts or automations", async () => {
    const seen: string[] = [];
    on("website_visit", (ev) => {
      seen.push(String(ev.data.visit_id));
    });
    await identifyVisit(await visit("203.0.113.20"), { allowLimited: true });
    json(await pay.client.post("/api/app/website-visitors/companies/hide", { domains: ["hush.test"] }));
    const again = await visit("203.0.113.21");
    const row = await identifyVisit(again, { allowLimited: true });
    assert.equal(row!.hidden, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!seen.includes(again));
    const listed = json(await pay.client.get("/api/app/website-visitors/companies?days=1"));
    assert.ok(!listed.items.some((c: { domain: string }) => c.domain === "hush.test"));
  });

  it("are counted by whole days on the workspace's clock", async () => {
    const own = (await db.insert(schema.visitorSites).values({ workspaceId: ws, domain: "days-co.test", pixelKey: "pk-days-co" }).returning())[0]!.id;
    const midnight = startOfDayOn(await workspaceZone(ws));
    const at = (t: number) => ({ siteId: own, firstSeenAt: new Date(t), lastSeenAt: new Date(t), resolveStatus: "unresolved" });
    await visit(null, at(midnight - 60_000)); // a minute before today began
    await visit(null, at(Date.now()));
    const today = json(await pay.client.get(`/api/app/website-visitors/overview?days=1&site_id=${own}`));
    assert.equal(today.totals.visits, 1);
  });
});

describe("emails on an unlimited workspace", () => {
  it("show without revealing, in Lead Finder and website visitors; a workspace that pays still reveals them", async () => {
    await importDatasetRows(people("shown.test", 2), HEADERS, null);
    const [company] = await db
      .select()
      .from(schema.lfCompanies)
      .where(and(eq(schema.lfCompanies.domain, "shown.test"), isNull(schema.lfCompanies.workspaceId)));
    type Shown = { email: string | null; revealed: boolean };
    const found = async (u: TestUser) => json(await u.client.post("/api/app/lead-finder/search", { filters: { domains: ["shown.test"] }, record_history: false })).items as Shown[];
    const contacts = async (u: TestUser) => {
      const ws = u.workspaceId!;
      const site = (await db.insert(schema.visitorSites).values({ workspaceId: ws, domain: `shown-${ws}.test`, pixelKey: `pk-shown-${ws}` }).returning())[0]!.id;
      const data = { name: "Shown Co", domain: "shown.test", industry: null, employee_count: null, revenue_range: null, country: null, city: null, logo_url: null, linkedin_url: null, description: null, source: "ip_lookup", network: null };
      await db.insert(V).values({ workspaceId: ws, siteId: site, visitorKey: `k-shown-${ws}`, identified: true, resolveStatus: "identified", resolvedAt: new Date(), companyId: company!.id, companyDomain: "shown.test", companyName: "Shown Co", companyData: data, firstSeenAt: new Date(), lastSeenAt: new Date() });
      return json(await u.client.get("/api/app/website-visitors/companies/shown.test")).contacts as Shown[];
    };
    const both = [
      ["p0@shown.test", true],
      ["p1@shown.test", true],
    ];
    assert.deepEqual((await found(free)).map((p) => [p.email, p.revealed]).sort(), both);
    assert.deepEqual((await contacts(free)).map((p) => [p.email, p.revealed]).sort(), both);
    assert.ok((await found(pay)).every((p) => p.email === null && !p.revealed));
    assert.ok((await contacts(pay)).every((p) => p.email === null && !p.revealed));
  });
});

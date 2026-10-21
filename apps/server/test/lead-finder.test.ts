// Lead Finder imports from a private dataset: who gets added, and when campaign leads may be emailed.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";
import { importDatasetRows } from "../src/services/lead-finder/dataset";

const J = schema.backgroundJobs;
const L = schema.leads;

// Ben has no address anywhere; Cleo's address is one the sandbox verifier calls invalid.
const HEADERS = ["first_name", "last_name", "title", "email", "company", "domain"];
const PEOPLE = [
  { first_name: "Ada", last_name: "Stone", title: "Head of Sales", email: "ada.stone@skipco.test", company: "Skip Co", domain: "skipco.test" },
  { first_name: "Ben", last_name: "Hale", title: "Head of Sales", email: "", company: "Skip Co", domain: "skipco.test" },
  { first_name: "Cleo", last_name: "Park", title: "Head of Sales", email: "invalid.cleo@skipco.test", company: "Skip Co", domain: "skipco.test" },
];
const SEARCH = { domains: ["skipco.test"] };

let app: FastifyInstance;
let user: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Lee", workspaceName: "Finder Co" });
  await importDatasetRows(PEOPLE, HEADERS, user.workspaceId);
});
after(stopServer);

/** Runs jobs until none is waiting or running (an import queues enrichment and verification runs). */
async function settle() {
  for (let i = 0; i < 100; i++) {
    await runPendingJobs();
    const open = await db.select({ id: J.id }).from(J).where(and(eq(J.workspaceId, user.workspaceId!), inArray(J.status, ["pending", "in-progress"])));
    if (!open.length) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Jobs didn't finish");
}

async function namesIn(where: { listId?: string; campaignId?: string }) {
  const rows = await db
    .select({ first: L.firstName, email: L.email, verification: L.verificationStatus })
    .from(L)
    .where(where.listId ? eq(L.listId, where.listId) : eq(L.campaignId, where.campaignId!));
  return rows.sort((a, b) => (a.first ?? "").localeCompare(b.first ?? ""));
}

describe("skip people without an email address", () => {
  it("without an email lookup, only people the dataset has an address for are added", async () => {
    const r = json(await user.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: SEARCH, limit: 10, list_name: "No lookup", skip_rows_without_email: true }));
    await settle();
    assert.deepEqual((await namesIn({ listId: r.resource_id })).map((l) => l.first), ["Ada", "Cleo"]);
  });

  it("with an email lookup, the people it finds no address for are removed afterwards", async () => {
    const r = json(
      await user.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", {
        search_filters: SEARCH,
        limit: 10,
        list_name: "With lookup",
        work_email_enrichment: true,
        skip_rows_without_email: true,
      }),
    );
    await settle();
    const leads = await namesIn({ listId: r.resource_id });
    assert.deepEqual(leads.map((l) => l.first), ["Ada", "Cleo"]);
    assert.ok(leads.every((l) => l.email));
  });

  it("left off, everyone is added", async () => {
    const r = json(await user.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: SEARCH, limit: 10, list_name: "Everyone", skip_rows_without_email: false }));
    await settle();
    assert.deepEqual((await namesIn({ listId: r.resource_id })).map((l) => l.first), ["Ada", "Ben", "Cleo"]);
  });
});

describe("verified imports into a campaign", () => {
  it("leads wait for verification before their first email, and invalid ones never get one", async () => {
    const campaign = json(await user.client.post("/api/app/campaigns", { name: "Verified finder import" }));
    json(await user.client.post("/api/v2/supersearch-enrichment/enrich-leads-from-supersearch", { search_filters: SEARCH, limit: 10, resource_id: campaign.id, email_verification: true }));

    // Right after the import, before any verification ran, nobody can be emailed yet.
    let jobs = await db.select().from(J).where(and(eq(J.workspaceId, user.workspaceId!), eq(J.type, "lead-finder-import"), eq(J.entityId, campaign.id)));
    for (let i = 0; i < 50 && jobs[0]?.status !== "success"; i++) {
      await runPendingJobs();
      await new Promise((r) => setTimeout(r, 100));
      jobs = await db.select().from(J).where(eq(J.id, jobs[0]!.id));
    }
    const waiting = await namesIn({ campaignId: campaign.id });
    assert.deepEqual(waiting.map((l) => l.first), ["Ada", "Cleo"]);
    assert.ok(waiting.every((l) => l.verification === 12 || l.verification === 11), `still waiting: ${JSON.stringify(waiting)}`);

    await settle();
    const after = await namesIn({ campaignId: campaign.id });
    assert.deepEqual(
      after.map((l) => [l.first, l.verification]),
      [
        ["Ada", 1],
        ["Cleo", -1],
      ],
    );
  });
});

describe("people at companies that visited your website", () => {
  it("are what the visitors filter finds; visits you hid don't count", async () => {
    await importDatasetRows(
      [
        { first_name: "Vic", last_name: "Tor", title: "CEO", email: "vic@visitco.test", company: "Visit Co", domain: "visitco.test" },
        { first_name: "Hal", last_name: "Hid", title: "CEO", email: "hal@hiddenco.test", company: "Hidden Co", domain: "hiddenco.test" },
      ],
      HEADERS,
      user.workspaceId,
    );
    const [site] = await db.insert(schema.visitorSites).values({ workspaceId: user.workspaceId!, domain: "finder-co.test", pixelKey: "pk-finder-visits" }).returning();
    const visit = (domain: string, hidden: boolean) => ({
      workspaceId: user.workspaceId!,
      siteId: site!.id,
      visitorKey: `v-${domain}`,
      companyDomain: domain,
      identified: true,
      resolveStatus: "identified",
      hidden,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });
    await db.insert(schema.visitorSessions).values([visit("visitco.test", false), visit("hiddenco.test", true)]);
    const found = json(await user.client.post("/api/v2/supersearch-enrichment/preview-leads-from-supersearch", { search_filters: { website_visitors: true } }));
    assert.deepEqual(
      found.leads.map((l: { fullName: string }) => l.fullName),
      ["Vic Tor"],
    );
  });
});

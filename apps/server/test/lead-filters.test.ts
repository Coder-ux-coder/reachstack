// The leads tables' filter builder: every rule and sort, paging through a sorted table, bad input, saved views,
// what another workspace can see, and bulk actions on "all matching" leads keeping to the filter.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { LEAD_SORTS, type LeadRule } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";

const L = schema.leads;
const J = schema.backgroundJobs;
const DAY = 86_400_000;
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * DAY);
const dateOf = (d: Date) => d.toISOString().slice(0, 10);

let app: FastifyInstance;
let ann: TestUser;
let bob: TestUser;

// Four made-up people. Every sort key differs between them, so each order is exact.
const PEOPLE = [
  {
    key: "ada",
    firstName: "Ada",
    lastName: "Stone",
    companyName: "Acme Inc",
    companyDomain: "acme.test",
    jobTitle: "Head of Sales",
    location: "Berlin, Germany",
    status: 1,
    interestStatus: 1,
    verificationStatus: 1,
    espCode: 1,
    openCount: 3,
    replyCount: 2,
    clickCount: 0,
    nextStep: 2,
    createdAt: daysAgo(270),
    lastContactAt: daysAgo(14),
    payload: { industry: "Software", tier: "A" },
    owned: true,
  },
  {
    key: "ben",
    firstName: "Ben",
    lastName: "Hale",
    companyName: "Globex",
    companyDomain: "globex.test",
    jobTitle: "CTO",
    location: "Paris, France",
    status: 2,
    interestStatus: null,
    verificationStatus: -1,
    espCode: 2,
    openCount: 0,
    replyCount: 1,
    clickCount: 2,
    nextStep: 1,
    createdAt: daysAgo(160),
    lastContactAt: daysAgo(45),
    payload: { industry: "Retail" },
  },
  {
    key: "cleo",
    firstName: "Cleo",
    lastName: "Park",
    companyName: null,
    companyDomain: "",
    jobTitle: "Founder",
    location: null,
    status: 3,
    interestStatus: -1,
    verificationStatus: 0,
    espCode: 0,
    openCount: 1,
    replyCount: 3,
    clickCount: 0,
    nextStep: 3,
    createdAt: daysAgo(20),
    lastContactAt: daysAgo(5),
    payload: null,
  },
  {
    key: "dan",
    firstName: "dan",
    lastName: "Ray",
    companyName: "acme labs",
    companyDomain: "acme.test",
    jobTitle: "Sales Rep",
    location: "Berlin",
    status: 1,
    interestStatus: 2,
    verificationStatus: -2,
    espCode: 1,
    openCount: 2,
    replyCount: 0,
    clickCount: 0,
    nextStep: 0,
    createdAt: daysAgo(2),
    lastContactAt: null,
    payload: { tier: "B", note: "100% match_here" },
  },
];

/** Puts the four people into a campaign or list of a workspace; returns their lead ids by name. */
async function seed(user: TestUser, where: { campaignId?: string; listId?: string }, domain = "example.test") {
  const ids: Record<string, string> = {};
  for (const { key, owned, ...p } of PEOPLE) {
    const [row] = await db
      .insert(L)
      .values({ ...p, workspaceId: user.workspaceId!, campaignId: where.campaignId ?? null, listId: where.listId ?? null, email: `${key}@${domain}`, assignedTo: owned ? user.id : null })
      .returning({ id: L.id });
    ids[key] = row!.id;
  }
  return ids;
}

const newCampaign = async (user: TestUser, name: string) => json(await user.client.post("/api/app/campaigns", { name })).id as string;
const newList = async (user: TestUser, name: string) => json(await user.client.post("/api/v2/lead-lists", { name })).id as string;
const who = (items: Array<{ email: string }>) => items.map((l) => l.email.split("@")[0]!);

async function names(user: TestUser, filter: Record<string, unknown>, sorted = true) {
  const res = json(await user.client.post("/api/v2/leads/list", { limit: 100, ...filter }));
  const out = who(res.items);
  return sorted ? out.sort() : out;
}

async function waitForJob(id: string) {
  for (let i = 0; i < 200; i++) {
    await runPendingJobs();
    const [job] = await db.select().from(J).where(eq(J.id, id));
    if (job!.status === "success" || job!.status === "failed") return job!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("The job didn't finish");
}

let campaign: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  ann = await signUp(app, { firstName: "Ann", workspaceName: "Filters Co" });
  bob = await signUp(app, { firstName: "Bob", workspaceName: "Other Co" });
  campaign = await newCampaign(ann, "Filters");
  await seed(ann, { campaignId: campaign });
});
after(stopServer);

describe("filter rules", () => {
  it("each rule narrows the campaign's leads", async () => {
    const owner = ann.id;
    const cases: Array<[string, LeadRule[], string[]]> = [
      ["status is", [{ field: "status", op: "is", value: [2] }], ["ben"]],
      ["status is not", [{ field: "status", op: "is_not", value: [1] }], ["ben", "cleo"]],
      ["lead status is", [{ field: "interest", op: "is", value: [1, 2] }], ["ada", "dan"]],
      ["no lead status", [{ field: "interest", op: "is", value: [null] }], ["ben"]],
      ["lead status is not (keeps leads without one)", [{ field: "interest", op: "is_not", value: [1] }], ["ben", "cleo", "dan"]],
      ["email check is", [{ field: "verification", op: "is", value: [1] }], ["ada"]],
      ["email check is not", [{ field: "verification", op: "is_not", value: [1, -1] }], ["cleo", "dan"]],
      ["email provider", [{ field: "provider", op: "is", value: [1] }], ["ada", "dan"]],
      ["owner is", [{ field: "owner", op: "is", value: [owner] }], ["ada"]],
      ["nobody owns", [{ field: "owner", op: "is", value: [null] }], ["ben", "cleo", "dan"]],
      ["owner is not", [{ field: "owner", op: "is_not", value: [owner] }], ["ben", "cleo", "dan"]],
      ["opened", [{ field: "opened", op: "yes" }], ["ada", "cleo", "dan"]],
      ["never opened", [{ field: "opened", op: "no" }], ["ben"]],
      ["replied", [{ field: "replied", op: "yes" }], ["ada", "ben", "cleo"]],
      ["never replied", [{ field: "replied", op: "no" }], ["dan"]],
      ["clicked", [{ field: "clicked", op: "yes" }], ["ben"]],
      ["steps sent is", [{ field: "step", op: "is", value: 0 }], ["dan"]],
      ["steps sent at least", [{ field: "step", op: "gte", value: 2 }], ["ada", "cleo"]],
      ["steps sent at most", [{ field: "step", op: "lte", value: 1 }], ["ben", "dan"]],
      ["steps sent is not", [{ field: "step", op: "is_not", value: 3 }], ["ada", "ben", "dan"]],
      ["company contains (any case)", [{ field: "company_name", op: "contains", value: "ACME" }], ["ada", "dan"]],
      ["company doesn't contain", [{ field: "company_name", op: "not_contains", value: "acme" }], ["ben", "cleo"]],
      ["company is", [{ field: "company_name", op: "is", value: " globex " }], ["ben"]],
      ["company is not", [{ field: "company_name", op: "is_not", value: "globex" }], ["ada", "cleo", "dan"]],
      ["company is empty", [{ field: "company_name", op: "empty" }], ["cleo"]],
      ["company has a value", [{ field: "company_name", op: "not_empty" }], ["ada", "ben", "dan"]],
      ["% is a plain character", [{ field: "company_name", op: "contains", value: "%" }], []],
      ["_ is a plain character", [{ field: "company_name", op: "contains", value: "_" }], []],
      ["company domain is a pasted address", [{ field: "company_domain", op: "is", value: "https://www.acme.test/about" }], ["ada", "dan"]],
      ["job title contains", [{ field: "job_title", op: "contains", value: "sales" }], ["ada", "dan"]],
      ["location contains", [{ field: "location", op: "contains", value: "berlin" }], ["ada", "dan"]],
      ["location is empty", [{ field: "location", op: "empty" }], ["cleo"]],
      ["added before", [{ field: "created", op: "before", value: dateOf(daysAgo(200)) }], ["ada"]],
      ["added on or after", [{ field: "created", op: "after", value: dateOf(daysAgo(30)) }], ["cleo", "dan"]],
      ["added on or after (exact time)", [{ field: "created", op: "after", value: daysAgo(10).toISOString() }], ["dan"]],
      ["added in the last days", [{ field: "created", op: "within_days", value: 7 }], ["dan"]],
      ["added more than days ago", [{ field: "created", op: "over_days", value: 100 }], ["ada", "ben"]],
      ["never contacted", [{ field: "last_contacted", op: "empty" }], ["dan"]],
      ["contacted", [{ field: "last_contacted", op: "not_empty" }], ["ada", "ben", "cleo"]],
      ["contacted in the last days", [{ field: "last_contacted", op: "within_days", value: 30 }], ["ada", "cleo"]],
      ["contacted more than days ago", [{ field: "last_contacted", op: "over_days", value: 30 }], ["ben"]],
      ["custom variable is", [{ field: "custom", key: "industry", op: "is", value: "software" }], ["ada"]],
      ["custom variable contains", [{ field: "custom", key: "industry", op: "contains", value: "ret" }], ["ben"]],
      ["custom variable is empty", [{ field: "custom", key: "tier", op: "empty" }], ["ben", "cleo"]],
      ["custom variable has a value", [{ field: "custom", key: "tier", op: "not_empty" }], ["ada", "dan"]],
      ["custom value with % and _", [{ field: "custom", key: "note", op: "contains", value: "100% match_" }], ["dan"]],
      ["quick filter as a rule", [{ field: "preset", op: "is", value: "FILTER_VAL_REPLIED" }], ["ada", "ben", "cleo"]],
      ["search as a rule", [{ field: "search", op: "contains", value: "globex" }], ["ben"]],
      [
        "rules combine with AND",
        [
          { field: "company_name", op: "contains", value: "acme" },
          { field: "replied", op: "yes" },
        ],
        ["ada"],
      ],
    ];
    for (const [label, rules, expected] of cases) {
      assert.deepEqual(await names(ann, { campaign, rules }), expected, label);
    }
  });

  it("works with the search box and quick filter, and on lists", async () => {
    assert.deepEqual(await names(ann, { campaign, search: "acme", rules: [{ field: "opened", op: "yes" }] }), ["ada", "dan"]);
    assert.deepEqual(await names(ann, { campaign, filter: "FILTER_VAL_CONTACTED", rules: [{ field: "company_name", op: "not_empty" }] }), ["ada", "ben"]);
    const list = await newList(ann, "Filter list");
    await seed(ann, { listId: list }, "list.test");
    assert.deepEqual(await names(ann, { list_id: list, rules: [{ field: "job_title", op: "contains", value: "sales" }] }), ["ada", "dan"]);
    // Leads of the campaign stay out of the list's table.
    assert.equal((await names(ann, { list_id: list })).length, 4);
  });

  it("finds the leads that came from a visit to your website", async () => {
    const list = await newList(ann, "Visitors");
    const ids = await seed(ann, { listId: list }, "visits.test");
    await db.update(L).set({ isWebsiteVisitor: true }).where(eq(L.id, ids.ben!));
    assert.deepEqual(await names(ann, { list_id: list, filter: "FILTER_VAL_WEBSITE_VISITOR" }), ["ben"]);
    assert.deepEqual(await names(ann, { campaign, filter: "FILTER_VAL_WEBSITE_VISITOR" }), []);
  });

  it("values typed into rules are data, never SQL", async () => {
    assert.deepEqual(await names(ann, { campaign, rules: [{ field: "custom", key: "x') or 1=1 --", op: "not_empty" }] }), []);
    assert.deepEqual(await names(ann, { campaign, rules: [{ field: "company_name", op: "contains", value: "' or '1'='1" }] }), []);
    assert.deepEqual(await names(ann, { campaign, rules: [{ field: "custom", key: 'in"dustry', op: "empty" }] }), ["ada", "ben", "cleo", "dan"]);
  });
});

describe("sorting", () => {
  const ORDERS: Record<string, { asc: string[]; desc: string[] }> = {
    timestamp_created: { desc: ["dan", "cleo", "ben", "ada"], asc: ["ada", "ben", "cleo", "dan"] },
    // Never contacted comes last both ways.
    timestamp_last_contact: { desc: ["cleo", "ada", "ben", "dan"], asc: ["ben", "ada", "cleo", "dan"] },
    name: { asc: ["ada", "ben", "cleo", "dan"], desc: ["dan", "cleo", "ben", "ada"] },
    // No company comes last both ways.
    company_name: { asc: ["ada", "dan", "ben", "cleo"], desc: ["ben", "dan", "ada", "cleo"] },
    email_open_count: { desc: ["ada", "dan", "cleo", "ben"], asc: ["ben", "cleo", "dan", "ada"] },
    email_reply_count: { desc: ["cleo", "ada", "ben", "dan"], asc: ["dan", "ben", "ada", "cleo"] },
  };

  it("sorts by every key both ways, and pages through the same order one lead at a time", async () => {
    for (const s of LEAD_SORTS) {
      for (const order of ["asc", "desc"] as const) {
        const label = `${s.key} ${order}`;
        assert.deepEqual(await names(ann, { campaign, sort_by: s.key, sort_order: order }, false), ORDERS[s.key]![order], label);
        const paged: string[] = [];
        let next: string | undefined;
        for (let i = 0; i < 6; i++) {
          const page = json(await ann.client.post("/api/v2/leads/list", { campaign, sort_by: s.key, sort_order: order, limit: 1, ...(next ? { starting_after: next } : {}) }));
          paged.push(...who(page.items));
          next = page.next_starting_after ?? undefined;
          if (!next) break;
        }
        assert.deepEqual(paged, ORDERS[s.key]![order], `${label}, paged`);
      }
    }
  });

  it("uses each key's natural direction when no order is given, and filters still apply", async () => {
    assert.deepEqual(await names(ann, { campaign, sort_by: "name" }, false), ["ada", "ben", "cleo", "dan"]);
    assert.deepEqual(await names(ann, { campaign, sort_by: "email_open_count", rules: [{ field: "company_name", op: "contains", value: "acme" }] }, false), ["ada", "dan"]);
  });
});

describe("bad input", () => {
  it("is turned away with a 400 that says what's wrong", async () => {
    const bad: Array<[string, Record<string, unknown>, RegExp]> = [
      ["unknown field", { rules: [{ field: "salary", op: "is", value: [1] }] }, /field/i],
      ["wrong operator", { rules: [{ field: "status", op: "contains", value: [1] }] }, /op/i],
      ["nothing picked", { rules: [{ field: "status", op: "is", value: [] }] }, /Pick at least one/],
      ["not a date", { rules: [{ field: "created", op: "before", value: "last tuesday" }] }, /date like/],
      ["impossible year", { rules: [{ field: "created", op: "after", value: "0001-01-01" }] }, /date like/],
      ["zero days", { rules: [{ field: "created", op: "within_days", value: 0 }] }, /number of days/],
      ["created can't be empty", { rules: [{ field: "created", op: "empty" }] }, /before, after/],
      ["missing value", { rules: [{ field: "company_name", op: "contains" }] }, /Enter a value/],
      ["missing variable name", { rules: [{ field: "custom", key: " ", op: "is", value: "x" }] }, /custom variable/i],
      ["unknown quick filter", { rules: [{ field: "preset", op: "is", value: "FILTER_VAL_EVERYONE" }] }, /Unknown quick filter/],
      ["too many rules", { rules: Array.from({ length: 26 }, () => ({ field: "opened", op: "yes" })) }, /rules/],
      ["unknown sort", { sort_by: "email" }, /sort_by/],
      ["unknown order", { sort_by: "name", sort_order: "up" }, /sort_order/],
      ["unknown quick filter field", { filter: "FILTER_VAL_NOPE" }, /Unknown filter/],
    ];
    for (const [label, body, message] of bad) {
      const res = await ann.client.post("/api/v2/leads/list", { campaign, ...body });
      expectStatus(res, 400, label);
      assert.match(res.json().message, message, label);
    }
  });

  it("a cursor from a lead that's gone, or an unknown saved view, is an error rather than a wider list", async () => {
    const res = await ann.client.post("/api/v2/leads/list", { campaign, sort_by: "name", starting_after: "0190a000-0000-7000-8000-000000000000" });
    expectStatus(res, 400);
    expectStatus(await ann.client.post("/api/v2/leads/list", { campaign, smart_view_id: "no-such-view" }), 404);
    expectStatus(await ann.client.post("/api/app/leads/delete", { smart_view_id: "no-such-view" }), 404);
    expectStatus(await ann.client.post("/api/app/leads/delete", {}), 400);
    assert.equal((await names(ann, { campaign })).length, 4);
  });
});

describe("saved views", () => {
  it("save filters and sort under a name, use them anywhere a filter goes, rename, update and delete", async () => {
    const c = ann.client;
    const rules: LeadRule[] = [
      { field: "interest", op: "is", value: [1, 2] },
      { field: "search", op: "contains", value: "test" },
    ];
    const view = json(await c.post("/api/app/lead-views", { name: "Warm leads", rules, sort_by: "name", sort_order: "desc" }));
    assert.deepEqual(view.rules, rules);
    assert.equal(view.sort_by, "name");
    assert.equal(view.sort_order, "desc");
    assert.ok(json(await c.get("/api/app/lead-views")).items.some((v: { id: string }) => v.id === view.id));

    // Its rules and its sort apply through smart_view_id.
    assert.deepEqual(await names(ann, { campaign, smart_view_id: view.id }, false), ["dan", "ada"]);
    // A sort in the request wins over the view's.
    assert.deepEqual(await names(ann, { campaign, smart_view_id: view.id, sort_by: "name", sort_order: "asc" }, false), ["ada", "dan"]);

    expectStatus(await c.post("/api/app/lead-views", { name: "warm LEADS", rules: [] }), 409);
    expectStatus(await c.post("/api/app/lead-views", { name: " ", rules: [] }), 400);
    expectStatus(await c.post("/api/app/lead-views", { name: "Broken", rules: [{ field: "created", op: "before", value: "soon" }] }), 400);

    json(await c.patch(`/api/app/lead-views/${view.id}`, { name: "Hot leads", rules: [{ field: "interest", op: "is", value: [1] }], sort_by: null }));
    const [saved] = json(await c.get("/api/app/lead-views")).items.filter((v: { id: string }) => v.id === view.id);
    assert.equal(saved.name, "Hot leads");
    assert.equal(saved.sort_by, null);
    assert.deepEqual(await names(ann, { campaign, smart_view_id: view.id }), ["ada"]);

    json(await c.delete(`/api/app/lead-views/${view.id}`));
    assert.ok(!json(await c.get("/api/app/lead-views")).items.some((v: { id: string }) => v.id === view.id));
    expectStatus(await ann.client.post("/api/v2/leads/list", { campaign, smart_view_id: view.id }), 404);
  });

  it("a Salesflow works as a saved view too", async () => {
    const flow = json(await ann.client.post("/api/app/crm/sales-flows", { name: "Interested", campaign_id: campaign, queries: [{ actionType: "lead-status", values: { "lead-status": { status: 1, condition: "is" } } }] }));
    assert.deepEqual(await names(ann, { smart_view_id: flow.id }), ["ada"]);
  });
});

describe("workspaces", () => {
  it("one workspace can't see another's leads or saved views", async () => {
    const bobCampaign = await newCampaign(bob, "Bob's");
    await seed(bob, { campaignId: bobCampaign }, "bob.test");
    const view = json(await ann.client.post("/api/app/lead-views", { name: "Ann only", rules: [{ field: "opened", op: "yes" }] }));

    // Ann's campaign, rules and view mean nothing in Bob's workspace.
    assert.deepEqual(await names(bob, { campaign, rules: [{ field: "opened", op: "yes" }] }), []);
    expectStatus(await bob.client.post("/api/v2/leads/list", { smart_view_id: view.id }), 404);
    assert.ok(!json(await bob.client.get("/api/app/lead-views")).items.some((v: { id: string }) => v.id === view.id));
    expectStatus(await bob.client.patch(`/api/app/lead-views/${view.id}`, { name: "Mine now" }), 404);
    expectStatus(await bob.client.delete(`/api/app/lead-views/${view.id}`), 404);
    // Bob may use the same name in his own workspace.
    json(await bob.client.post("/api/app/lead-views", { name: "Ann only", rules: [] }));

    // Without a campaign, a rule only ever reaches the caller's own leads.
    const everyone = await names(bob, { rules: [{ field: "company_name", op: "contains", value: "acme" }] });
    assert.deepEqual(everyone, ["ada", "dan"]);
    const all = json(await bob.client.post("/api/v2/leads/list", { rules: [{ field: "company_name", op: "contains", value: "acme" }], limit: 100 })).items;
    assert.ok(all.every((l: { email: string }) => l.email.endsWith("@bob.test")));

    // Bulk actions from Bob with Ann's campaign touch nothing.
    json(await bob.client.post("/api/app/leads/status", { campaign, rules: [{ field: "opened", op: "yes" }], action: "pause" }));
    json(await bob.client.post("/api/app/leads/delete", { campaign, rules: [{ field: "opened", op: "yes" }] }));
    assert.equal((await names(ann, { campaign })).length, 4);
    assert.deepEqual(await names(ann, { campaign, rules: [{ field: "status", op: "is", value: [2] }] }), ["ben"]);
  });
});

describe("bulk actions on all matching leads", () => {
  const acme: LeadRule[] = [{ field: "company_name", op: "contains", value: "acme" }];

  it("set the lead status only on the matching leads", async () => {
    const id = await newCampaign(ann, "Bulk status");
    const ids = await seed(ann, { campaignId: id }, "status.test");
    assert.equal(json(await ann.client.post("/api/app/leads/status", { campaign: id, rules: acme, action: "interest", interest_value: 3 })).affected, 2);
    const rows = await db.select({ id: L.id, interest: L.interestStatus }).from(L).where(eq(L.campaignId, id));
    const interest = Object.fromEntries(rows.map((r) => [Object.keys(ids).find((k) => ids[k] === r.id)!, r.interest]));
    assert.deepEqual(interest, { ada: 3, ben: null, cleo: -1, dan: 3 });
    json(await ann.client.post("/api/app/leads/status", { campaign: id, rules: [{ field: "opened", op: "no" }], action: "resume" }));
    const [ben] = await db.select({ status: L.status }).from(L).where(eq(L.id, ids.ben!));
    assert.equal(ben!.status, 1);
  });

  it("move only the matching leads", async () => {
    const id = await newCampaign(ann, "Bulk move");
    await seed(ann, { campaignId: id }, "move.test");
    const list = await newList(ann, "Moved here");
    const job = json(await ann.client.post("/api/v2/leads/move", { campaign: id, rules: [{ field: "opened", op: "yes" }], sort_by: "name", to_list_id: list }));
    assert.equal((await waitForJob(job.id)).status, "success");
    assert.deepEqual(await names(ann, { list_id: list }), ["ada", "cleo", "dan"]);
    assert.deepEqual(await names(ann, { campaign: id }), ["ben"]);
  });

  it("export only the matching leads", async () => {
    const id = await newCampaign(ann, "Bulk export");
    await seed(ann, { campaignId: id }, "export.test");
    const job = json(await ann.client.post("/api/app/leads/export", { campaign: id, rules: acme, sort_by: "name", sort_order: "desc" }));
    assert.equal((await waitForJob(job.id)).status, "success");
    const csv = (await ann.client.get(`/api/app/exports/${job.id}/download`)).body;
    const found = ["ada", "ben", "cleo", "dan"].filter((n) => csv.includes(`${n}@export.test`));
    assert.deepEqual(found, ["ada", "dan"]);
    // The export follows the table's order.
    assert.ok(csv.indexOf("dan@export.test") < csv.indexOf("ada@export.test"));
  });

  it("verify only the matching leads", async () => {
    const id = await newCampaign(ann, "Bulk verify");
    await seed(ann, { campaignId: id }, "verify.test");
    // Both Acme leads were checked before, so "only unverified" finds nobody there, though Cleo isn't verified.
    const none = await ann.client.post("/api/app/verification/leads", { campaign: id, rules: acme });
    expectStatus(none, 400);
    assert.match(none.json().message, /already verified/);
    const job = json(await ann.client.post("/api/app/verification/leads", { campaign: id, rules: acme, only_unverified: false }));
    assert.equal(job.data.charged, 2);
    assert.match(job.data.name, /\(filtered\)$/);
    await db.update(J).set({ status: "cancelled" }).where(eq(J.id, job.id));
  });

  it("delete only the matching leads", async () => {
    const id = await newCampaign(ann, "Bulk delete");
    await seed(ann, { campaignId: id }, "delete.test");
    assert.equal(json(await ann.client.post("/api/app/leads/delete", { campaign: id, rules: [{ field: "verification", op: "is", value: [-1] }] })).count, 1);
    assert.deepEqual(await names(ann, { campaign: id }), ["ada", "cleo", "dan"]);
    const view = json(await ann.client.post("/api/app/lead-views", { name: "Never contacted", rules: [{ field: "last_contacted", op: "empty" }] }));
    assert.equal(json(await ann.client.post("/api/app/leads/delete", { campaign: id, smart_view_id: view.id })).count, 1);
    assert.deepEqual(await names(ann, { campaign: id }), ["ada", "cleo"]);
    const left = await db.select({ id: L.id }).from(L).where(and(eq(L.campaignId, campaign), eq(L.workspaceId, ann.workspaceId!)));
    assert.equal(left.length, 4, "other campaigns keep their leads");
  });
});

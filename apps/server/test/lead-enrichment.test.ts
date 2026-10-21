// Enrichment and AI columns on lists and campaigns: the local clean-up rules, adding a column and running it on the
// first rows, picked rows or a filter, AI prompts with {{variables}}, new leads filling in, two columns at once,
// stopping and deleting, and other workspaces kept out. The AI is a local fake (nothing leaves the process).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { cleanCompanyName, cleanDomain, cleanPersonName } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";
import { scheduleRun } from "../src/services/lead-finder/enrichment";

// ---------- A local stand-in for the AI (the client is created on first use, so it picks this fetch up) ----------

const aiTasks: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:9/")) throw new Error(`Tests must not use the network (fetch ${url})`);
  const req = JSON.parse(String(init?.body ?? "{}"));
  const last = [...(req.messages ?? [])].reverse().find((m: { role: string }) => m.role === "user");
  const said: string = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b: { text?: string }) => b.text ?? "").join(" ");
  const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(said)?.[1] ?? said;
  aiTasks.push(task);
  const message = { id: "msg_test", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: `Answer: ${task}` }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
}) as typeof fetch;

// ---------- Setup ----------

const L = schema.leads;
const E = schema.enrichments;
const J = schema.backgroundJobs;
const RUNS = schema.enrichmentRuns;

let app: FastifyInstance;
let ann: TestUser;
let bob: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  ann = await signUp(app, { firstName: "Ann", workspaceName: "Enrich Co" });
  bob = await signUp(app, { firstName: "Bob", workspaceName: "Other Co" });
});
after(stopServer);

const newList = async (name: string, user = ann) => json(await user.client.post("/api/v2/lead-lists", { name })).id as string;
const newCampaign = async (name: string) => json(await ann.client.post("/api/app/campaigns", { name })).id as string;

type Person = { first: string; last?: string; company?: string; website?: string; payload?: Record<string, unknown>; email?: string };

async function addPeople(listId: string, people: Person[]) {
  const ids: Record<string, string> = {};
  for (const p of people) {
    const [row] = await db
      .insert(L)
      .values({
        workspaceId: ann.workspaceId!,
        listId,
        email: p.email ?? `${p.first.toLowerCase().replace(/[^a-z]/g, "")}@${listId.slice(-6)}.example.test`,
        firstName: p.first,
        lastName: p.last ?? null,
        companyName: p.company ?? null,
        website: p.website ?? null,
        payload: p.payload ?? null,
      })
      .returning({ id: L.id });
    ids[p.first] = row!.id;
  }
  return ids;
}

const payloadOf = async (id: string) => (await db.select({ p: L.payload }).from(L).where(eq(L.id, id)))[0]!.p ?? {};

async function waitForJob(id: string) {
  for (let i = 0; i < 300; i++) {
    await runPendingJobs();
    const [job] = await db.select().from(J).where(eq(J.id, id));
    if (["success", "failed", "cancelled"].includes(job!.status)) return job!;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("The job didn't finish");
}

/** Runs every waiting job of the workspace until none is left. */
async function settle() {
  for (let i = 0; i < 300; i++) {
    await runPendingJobs();
    const open = await db.select({ id: J.id }).from(J).where(and(eq(J.workspaceId, ann.workspaceId!), inArray(J.status, ["pending", "in-progress"])));
    if (!open.length) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Jobs didn't finish");
}

const columns = async (resource: string, user = ann) => json(await user.client.get(`/api/app/enrichment-columns/${resource}`));
const add = (body: Record<string, unknown>) => ann.client.post("/api/app/enrichment-columns", body);
const run = (body: Record<string, unknown>) => ann.client.post("/api/app/enrichment-columns/run", body);

// ---------- Clean-up rules ----------

describe("clean-up rules (no AI)", () => {
  it("company names lose legal forms, taglines and shouting", () => {
    const cases: Array<[string | null, string]> = [
      ["Acme Inc.", "Acme"],
      ["Acme, Inc", "Acme"],
      ["ACME WIDGETS LTD", "Acme Widgets"],
      ["Globex Corporation", "Globex"],
      ["Initech GmbH", "Initech"],
      ["Umbrella Co.", "Umbrella"],
      ["Wayne Enterprises (UK) Ltd", "Wayne Enterprises"],
      ["Stark Industries | Defense systems", "Stark Industries"],
      ["acme.io", "Acme"],
      ["hooli labs", "Hooli Labs"],
      ["IBM", "IBM"],
      ["IT HR SOLUTIONS", "IT HR Solutions"],
      ["GmbH", "GmbH"],
      ["", ""],
      [null, ""],
    ];
    for (const [input, expected] of cases) assert.equal(cleanCompanyName(input), expected, String(input));
  });

  it("names get capitals where they were all one case, and lose titles and credentials", () => {
    const cases: Array<[string | null, string]> = [
      ["JOHN", "John"],
      ["mary-jane o'neil", "Mary-Jane O'Neil"],
      ["Smith, MBA", "Smith"],
      ["dr. ada lovelace", "Ada Lovelace"],
      ["MCDONALD", "McDonald"],
      ["ludwig van beethoven", "Ludwig van Beethoven"],
      ["Ada 🚀", "Ada"],
      ["deSouza", "deSouza"],
      [null, ""],
    ];
    for (const [input, expected] of cases) assert.equal(cleanPersonName(input), expected, String(input));
  });

  it("domains come out bare, and free mailbox domains don't count", () => {
    const cases: Array<[string | null, string]> = [
      ["https://www.Acme.com/about", "acme.com"],
      ["ada@acme.io", "acme.io"],
      ["acme.co.uk:8080/path", "acme.co.uk"],
      ["gmail.com", ""],
      ["someone@gmail.com", ""],
      ["not a domain", ""],
      [null, ""],
    ];
    for (const [input, expected] of cases) assert.equal(cleanDomain(input), expected, String(input));
  });
});

// ---------- Columns ----------

describe("a clean-up column", () => {
  it("saves tidy copies on every lead, keeps the originals and other variables, and reports progress", async () => {
    const list = await newList("Messy");
    const ids = await addPeople(list, [
      { first: "JOHN", last: "SMITH", company: "ACME WIDGETS LTD", website: "https://www.Acme.test/about", payload: { industry: "Retail" } },
      { first: "mary-jane", last: "o'neil", company: "Globex Corporation", email: "mary@globex.test" },
    ]);
    const r = json(await add({ resource_id: list, type: "normalize", run: { rows: { mode: "all" } } }));
    assert.equal(r.key, "normalize");
    assert.equal((await waitForJob(r.job_id)).status, "success");

    assert.deepEqual(await payloadOf(ids.JOHN!), { industry: "Retail", clean_first_name: "John", clean_last_name: "Smith", clean_company_name: "Acme Widgets", clean_company_domain: "acme.test" });
    assert.deepEqual(await payloadOf(ids["mary-jane"]!), { clean_first_name: "Mary-Jane", clean_last_name: "O'Neil", clean_company_name: "Globex", clean_company_domain: "globex.test" });
    const [john] = await db.select().from(L).where(eq(L.id, ids.JOHN!));
    assert.equal(john!.firstName, "JOHN");
    assert.equal(john!.companyName, "ACME WIDGETS LTD");

    const info = await columns(list);
    assert.equal(info.resource_type, 2);
    assert.equal(info.total_leads, 2);
    const [col] = info.columns;
    assert.equal(col.key, "normalize");
    assert.deepEqual(col.variables, ["clean_first_name", "clean_last_name", "clean_company_name", "clean_company_domain"]);
    assert.equal(col.filled, 2);
    assert.equal(col.running, null);
    assert.equal(col.last_run.status, "completed");
    assert.equal(col.last_run.succeeded, 2);
  });

  it("tells a webhook when it's done", async () => {
    const [hook] = await db.insert(schema.webhooks).values({ workspaceId: ann.workspaceId!, targetHookUrl: "https://hooks.invalid/enrichment", eventType: "supersearch_enrichment_completed" }).returning();
    try {
      const list = await newList("Webhook list");
      await addPeople(list, [{ first: "ADA", company: "ADA WORKS LTD" }, { first: "grace", company: "Hopper Inc." }]);
      const r = json(await add({ resource_id: list, type: "normalize", run: { rows: { mode: "all" } } }));
      assert.equal((await waitForJob(r.job_id)).status, "success");
      const sent = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.webhookId, hook!.id));
      assert.equal(sent.length, 1);
      const body = sent[0]!.payload as Record<string, unknown>;
      assert.equal(body.event_type, "supersearch_enrichment_completed");
      assert.equal(body.list_id, list);
      assert.equal(body.list_name, "Webhook list");
      assert.equal(body.campaign_id, null);
      assert.equal(body.leads, 2);
      assert.deepEqual(body.enrichments, [{ type: "normalize", processed: 2, succeeded: 2, failed: 0, credits: 0 }]);
    } finally {
      await db.delete(schema.webhooks).where(eq(schema.webhooks.id, hook!.id));
    }
  });

  it("runs on the first rows of the table as sorted and filtered, on picked rows, or on a filter", async () => {
    const list = await newList("Scopes");
    const ids = await addPeople(list, [
      { first: "Eve", company: "Eve Labs LLC" },
      { first: "Ann", company: "Ann Corp" },
      { first: "Cid", company: "Cid GmbH" },
      { first: "Bea", company: "Bea Ltd" },
      { first: "Dee", company: "Dee Inc." },
    ]);
    const cleaned = async () => {
      const out: string[] = [];
      for (const [name, id] of Object.entries(ids)) if ((await payloadOf(id)).clean_company_name) out.push(name);
      return out.sort();
    };
    const first = json(await add({ resource_id: list, type: "normalize", targets: ["company"], run: { rows: { mode: "first", count: 2, filter: { sort_by: "name", sort_order: "asc" } } } }));
    await waitForJob(first.job_id);
    assert.deepEqual(await cleaned(), ["Ann", "Bea"]);

    await waitForJob(json(await run({ resource_id: list, key: "normalize", rows: { mode: "ids", ids: [ids.Cid] } })).job_id);
    assert.deepEqual(await cleaned(), ["Ann", "Bea", "Cid"]);

    await waitForJob(json(await run({ resource_id: list, key: "normalize", rows: { mode: "filter", filter: { rules: [{ field: "company_name", op: "contains", value: "dee" }] } } })).job_id);
    assert.deepEqual(await cleaned(), ["Ann", "Bea", "Cid", "Dee"]);
    assert.equal((await columns(list)).columns[0].filled, 4);

    // Without "redo", rows that have a value keep it; with it they're done again.
    await db.update(L).set({ payload: { clean_company_name: "Typed by hand" } }).where(eq(L.id, ids.Ann!));
    await waitForJob(json(await run({ resource_id: list, key: "normalize", rows: { mode: "all" } })).job_id);
    assert.equal((await payloadOf(ids.Ann!)).clean_company_name, "Typed by hand");
    assert.equal((await payloadOf(ids.Eve!)).clean_company_name, "Eve Labs");
    await waitForJob(json(await run({ resource_id: list, key: "normalize", rows: { mode: "ids", ids: [ids.Ann] }, overwrite: true })).job_id);
    assert.equal((await payloadOf(ids.Ann!)).clean_company_name, "Ann");

    // Rows from elsewhere, or a filter nobody matches, run nothing.
    const other = await newList("Elsewhere");
    const stranger = await addPeople(other, [{ first: "Gus", company: "Gus Inc" }]);
    const none = await run({ resource_id: list, key: "normalize", rows: { mode: "ids", ids: [stranger.Gus] } });
    expectStatus(none, 400);
    assert.match(none.json().message, /No leads match/);
    expectStatus(await run({ resource_id: list, key: "normalize", rows: { mode: "first", count: 5, filter: { search: "nobody-here" } } }), 400);
    assert.equal((await payloadOf(stranger.Gus!)).clean_company_name, undefined);
  });
});

describe("an AI column", () => {
  it("answers each lead's prompt with its {{variables}} and saves the answer under the column's name", async () => {
    const list = await newList("AI list");
    const ids = await addPeople(list, [
      { first: "Ada", company: "Acme Inc" },
      { first: "Ben", company: "Globex" },
    ]);
    const r = json(await add({ resource_id: list, type: "ai_enrichment", name: "opening_line", prompt: "Say hi to {{first_name}} at {{company_name}}", run: { rows: { mode: "ids", ids: [ids.Ada] } } }));
    assert.equal(r.key, "ai:opening_line");
    assert.equal((await waitForJob(r.job_id)).status, "success");
    assert.equal((await payloadOf(ids.Ada!)).opening_line, "Answer: Say hi to Ada at Acme Inc");
    assert.equal((await payloadOf(ids.Ben!)).opening_line, undefined);

    const info = await columns(list);
    const col = info.columns.find((c: { key: string }) => c.key === "ai:opening_line");
    assert.equal(col.prompt, "Say hi to {{first_name}} at {{company_name}}");
    assert.equal(col.filled, 1);
    assert.equal(info.ai_available, true);

    // A new prompt, redone for Ada.
    json(await ann.client.patch("/api/app/enrichment-columns", { resource_id: list, key: "ai:opening_line", prompt: "Greet {{first_name}}" }));
    assert.equal((await columns(list)).columns[0].prompt, "Greet {{first_name}}");
    await waitForJob(json(await run({ resource_id: list, key: "ai:opening_line", rows: { mode: "all" }, overwrite: true })).job_id);
    assert.equal((await payloadOf(ids.Ada!)).opening_line, "Answer: Greet Ada");
    assert.equal((await payloadOf(ids.Ben!)).opening_line, "Answer: Greet Ben");
  });

  it("checks the column's name, the prompt and where each kind of column can go", async () => {
    const list = await newList("Rules");
    const campaign = await newCampaign("Rules campaign");
    json(await add({ resource_id: list, type: "ai_enrichment", name: "summary", prompt: "Sum up {{company_name}}" }));
    const cases: Array<[Record<string, unknown>, number, RegExp]> = [
      [{ resource_id: list, type: "ai_enrichment", name: "first name", prompt: "x" }, 400, /letters, numbers and underscores/],
      [{ resource_id: list, type: "ai_enrichment", name: "email", prompt: "x" }, 400, /already a lead field/],
      [{ resource_id: list, type: "ai_enrichment", name: "clean_company_name", prompt: "x" }, 400, /already a lead field/],
      [{ resource_id: list, type: "ai_enrichment", name: "SUMMARY", prompt: "x" }, 409, /already a column called/],
      [{ resource_id: list, type: "ai_enrichment", name: "blank" }, 400, /prompt/],
      [{ resource_id: list, type: "translate" }, 400, /type/],
      [{ resource_id: campaign, type: "work_email_enrichment" }, 400, /work on lists/],
      [{ resource_id: list, type: "engagement_score" }, 400, /work on campaigns/],
      [{ resource_id: list, type: "normalize", targets: [] }, 400, /at least one/],
      [{ resource_id: "no-such-list", type: "normalize" }, 404, /not found/i],
    ];
    for (const [body, status, message] of cases) {
      const res = await add(body);
      expectStatus(res, status, JSON.stringify(body));
      assert.match(res.json().message, message, JSON.stringify(body));
    }
    json(await add({ resource_id: list, type: "technologies" }));
    expectStatus(await add({ resource_id: list, type: "technologies" }), 409);
    expectStatus(await ann.client.patch("/api/app/enrichment-columns", { resource_id: list, key: "technologies", prompt: "x" }), 400);
    expectStatus(await run({ resource_id: list, key: "ai:nope", rows: { mode: "all" } }), 404);
    expectStatus(await run({ resource_id: list, key: "technologies", rows: { mode: "first", count: 0 } }), 400);
  });

  it("fills in new leads automatically only for the columns that ask to", async () => {
    const list = await newList("Auto");
    json(await add({ resource_id: list, type: "ai_enrichment", name: "auto_line", prompt: "Auto for {{first_name}}", auto_update: true }));
    json(await add({ resource_id: list, type: "ai_enrichment", name: "manual_line", prompt: "Manual for {{first_name}}", auto_update: false }));
    json(await add({ resource_id: list, type: "normalize", targets: ["name"], auto_update: true }));
    const info = await columns(list);
    assert.deepEqual(
      info.columns.map((c: { key: string; auto_update: boolean }) => [c.key, c.auto_update]),
      [
        ["ai:auto_line", true],
        ["ai:manual_line", false],
        ["normalize", true],
      ],
    );

    const lead = json(await ann.client.post("/api/v2/leads", { email: "zed@auto.example.test", first_name: "ZED", list_id: list }));
    // The run is queued by an event after the response.
    for (let i = 0; i < 50 && !(await db.select({ id: J.id }).from(J).where(and(eq(J.entityId, list), eq(J.type, "enrich-leads")))).length; i++) await new Promise((r) => setTimeout(r, 20));
    await settle();
    const p = await payloadOf(lead.id);
    assert.equal(p.auto_line, "Answer: Auto for ZED");
    assert.equal(p.manual_line, undefined);
    assert.equal(p.clean_first_name, "Zed");
  });

  it("two columns running at the same time both keep their values", async () => {
    const list = await newList("Together");
    const ids = await addPeople(list, [
      { first: "ADA", company: "Acme Inc", payload: { industry: "Software" } },
      { first: "BEN", company: "Globex LLC", payload: { industry: "Retail" } },
      { first: "CY", company: "Initech GmbH" },
    ]);
    json(await add({ resource_id: list, type: "normalize" }));
    json(await add({ resource_id: list, type: "ai_enrichment", name: "hello", prompt: "Hello {{first_name}}" }));
    const a = json(await run({ resource_id: list, key: "normalize", rows: { mode: "all" } }));
    const b = json(await run({ resource_id: list, key: "ai:hello", rows: { mode: "all" } }));
    await settle();
    assert.equal((await db.select().from(J).where(eq(J.id, a.job_id)))[0]!.status, "success");
    assert.equal((await db.select().from(J).where(eq(J.id, b.job_id)))[0]!.status, "success");
    for (const [name, id] of Object.entries(ids)) {
      const p = await payloadOf(id);
      assert.equal(p.hello, `Answer: Hello ${name}`, name);
      assert.ok(p.clean_first_name, name);
    }
    assert.equal((await payloadOf(ids.ADA!)).industry, "Software");
  });

  it("a column added while a run of the others waits isn't shown as running", async () => {
    const list = await newList("Added later");
    await addPeople(list, [{ first: "Ada", company: "Acme" }]);
    json(await add({ resource_id: list, type: "ai_enrichment", name: "early", prompt: "Early {{first_name}}" }));
    await scheduleRun(ann.workspaceId!, null, list, { types: ["ai_enrichment"] });
    json(await add({ resource_id: list, type: "ai_enrichment", name: "late", prompt: "Late {{first_name}}" }));
    const shown = (await columns(list)).columns.map((c: { key: string; running: unknown }) => [c.key, !!c.running]);
    assert.deepEqual(shown, [
      ["ai:early", true],
      ["ai:late", false],
    ]);
    await settle();
  });
});

describe("stopping and deleting", () => {
  it("stop cancels the column's waiting run and clears its progress", async () => {
    const list = await newList("Stop me");
    await addPeople(list, [{ first: "Ada", company: "Acme" }]);
    const r = json(await add({ resource_id: list, type: "ai_enrichment", name: "later", prompt: "Later {{first_name}}", run: { rows: { mode: "all" } } }));
    assert.ok((await columns(list)).columns[0].running);
    assert.equal(json(await ann.client.post("/api/app/enrichment-columns/stop", { resource_id: list, key: "ai:later" })).stopped, 1);
    const [job] = await db.select().from(J).where(eq(J.id, r.job_id));
    assert.equal(job!.status, "cancelled");
    const [runRow] = await db.select().from(RUNS).where(eq(RUNS.jobId, r.job_id));
    assert.equal(runRow!.status, "cancelled");
    const [enrichment] = await db.select().from(E).where(eq(E.resourceId, list));
    assert.equal(enrichment!.inProgress, false);
    const col = (await columns(list)).columns[0];
    assert.equal(col.running, null);
    assert.equal(col.last_run.status, "cancelled");
    assert.equal(json(await ann.client.post("/api/app/enrichment-columns/stop", { resource_id: list, key: "ai:later" })).stopped, 0);
  });

  it("delete removes the column, and its values only when asked; found addresses always stay", async () => {
    const list = await newList("Delete me");
    const ids = await addPeople(list, [{ first: "Ada", company: "Acme Inc", payload: { email_finder_status: "verified", industry: "Software" } }]);
    json(await add({ resource_id: list, type: "ai_enrichment", name: "keep_me", prompt: "Keep {{first_name}}" }));
    json(await add({ resource_id: list, type: "ai_enrichment", name: "drop_me", prompt: "Drop {{first_name}}" }));
    json(await add({ resource_id: list, type: "work_email_enrichment" }));
    await waitForJob(json(await run({ resource_id: list, key: "ai:keep_me", rows: { mode: "all" } })).job_id);
    await waitForJob(json(await run({ resource_id: list, key: "ai:drop_me", rows: { mode: "all" } })).job_id);
    const listRow = async () => (await db.select().from(schema.leadLists).where(eq(schema.leadLists.id, list)))[0]!;
    assert.equal((await listRow()).hasEnrichmentTask, true);

    json(await ann.client.post("/api/app/enrichment-columns/remove", { resource_id: list, key: "ai:drop_me", clear_values: true }));
    json(await ann.client.post("/api/app/enrichment-columns/remove", { resource_id: list, key: "work_email_enrichment", clear_values: true }));
    const p = await payloadOf(ids.Ada!);
    assert.equal(p.drop_me, undefined);
    assert.equal(p.email_finder_status, undefined);
    assert.equal(p.keep_me, "Answer: Keep Ada");
    assert.equal(p.industry, "Software");
    const [lead] = await db.select().from(L).where(eq(L.id, ids.Ada!));
    assert.ok(lead!.email, "the address stays");
    assert.deepEqual(
      (await columns(list)).columns.map((c: { key: string }) => c.key),
      ["ai:keep_me"],
    );

    // Without clear_values the answers stay as variables; with the last column gone the list has no enrichment.
    json(await ann.client.post("/api/app/enrichment-columns/remove", { resource_id: list, key: "ai:keep_me" }));
    assert.equal((await payloadOf(ids.Ada!)).keep_me, "Answer: Keep Ada");
    assert.deepEqual((await columns(list)).columns, []);
    assert.equal((await listRow()).hasEnrichmentTask, false);
    expectStatus(await ann.client.post("/api/app/enrichment-columns/remove", { resource_id: list, key: "ai:keep_me" }), 404);
  });
});

describe("workspaces and the API", () => {
  it("another workspace can't see, run, stop or delete a list's columns", async () => {
    const list = await newList("Private");
    const ids = await addPeople(list, [{ first: "Ada", company: "Acme Inc" }]);
    json(await add({ resource_id: list, type: "normalize" }));
    const b = bob.client;
    expectStatus(await b.get(`/api/app/enrichment-columns/${list}`), 404);
    expectStatus(await b.post("/api/app/enrichment-columns", { resource_id: list, type: "technologies" }), 404);
    expectStatus(await b.patch("/api/app/enrichment-columns", { resource_id: list, key: "normalize", auto_update: true }), 404);
    expectStatus(await b.post("/api/app/enrichment-columns/run", { resource_id: list, key: "normalize", rows: { mode: "all" } }), 404);
    expectStatus(await b.post("/api/app/enrichment-columns/stop", { resource_id: list, key: "normalize" }), 404);
    expectStatus(await b.post("/api/app/enrichment-columns/remove", { resource_id: list, key: "normalize", clear_values: true }), 404);
    // Bob's own list can't reach Ann's leads either.
    const bobList = await newList("Bob's", bob);
    json(await b.post("/api/app/enrichment-columns", { resource_id: bobList, type: "normalize" }));
    const res = await b.post("/api/app/enrichment-columns/run", { resource_id: bobList, key: "normalize", rows: { mode: "ids", ids: [ids.Ada] } });
    expectStatus(res, 400);
    assert.deepEqual(await payloadOf(ids.Ada!), {});
    assert.equal((await columns(list)).columns.length, 1);
  });

  it("the API's enrichment endpoint takes the clean-up type too", async () => {
    const list = await newList("API clean-up");
    const ids = await addPeople(list, [{ first: "GRACE", last: "hopper", company: "Navy Ltd" }]);
    const r = json(await ann.client.post("/api/v2/supersearch-enrichment", { resource_id: list, type: "normalize" }));
    assert.ok(r.job_id);
    await waitForJob(r.job_id);
    const p = await payloadOf(ids.GRACE!);
    assert.equal(p.clean_first_name, "Grace");
    assert.equal(p.clean_last_name, "Hopper");
    assert.equal(p.clean_company_name, "Navy");
    assert.equal(json(await ann.client.get(`/api/v2/supersearch-enrichment/${list}`)).enrichment_payload.normalize, true);
  });
});

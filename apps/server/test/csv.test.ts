// CSV files the app writes: text a spreadsheet app would run as a formula ("CSV injection") is written as text, while
// numbers and phone numbers stay as they are; reading a CSV takes the apostrophe off again.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import Papa from "papaparse";
import { CSV_FORMULA, unescapeCsvFormula } from "@reachstack/shared";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";
import { toCsv } from "../src/lib/csv";

let app: FastifyInstance;
let user: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Cass", workspaceName: "Sheets Co" });
});
after(stopServer);

describe("a CSV cell", () => {
  it("that a spreadsheet would run is written as text; numbers and phone numbers aren't touched", () => {
    for (const v of ["=1+1", '=HYPERLINK("http://evil.test","x")', "@SUM(A1:A2)", "+cmd|' /C calc'!A0", "-2+3", "-Smith", "\tlead", "\rlead"]) assert.ok(CSV_FORMULA.test(v), v);
    for (const v of ["+1 (555) 010-2000", "+44 20 7946 0958", "-12.5", "-1,234.50", "-", "Acme", "a=b", "jo@acme.test"]) assert.ok(!CSV_FORMULA.test(v), v);
    assert.equal(toCsv([{ company: "=1+1", phone: "+1 (555) 010-2000" }]), "company,phone\r\n\"'=1+1\",+1 (555) 010-2000");
  });

  it("read back from a CSV loses the apostrophe an export put in front", () => {
    assert.equal(unescapeCsvFormula("'=1+1"), "=1+1");
    assert.equal(unescapeCsvFormula("'@Home Realty"), "@Home Realty");
    // Text that merely starts with an apostrophe keeps it.
    assert.equal(unescapeCsvFormula("'tis the season"), "'tis the season");
    assert.equal(unescapeCsvFormula("'+1 555 0100"), "'+1 555 0100");
  });
});

/** Runs a lead export and returns the CSV it made. */
async function exportCsv(filter: Record<string, unknown>): Promise<string> {
  const job = json(await user.client.post("/api/app/leads/export", filter));
  for (let i = 0; i < 400; i++) {
    await runPendingJobs();
    const [row] = await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id));
    if (row!.status === "failed") assert.fail(`the export failed: ${row!.error}`);
    if (row!.status === "success") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await user.client.get(`/api/app/exports/${job.id}/download`)).body;
}

describe("a lead export", () => {
  it("writes formula-like values as text", async () => {
    const campaignId = json(await user.client.post("/api/app/campaigns", { name: "Exported" })).id as string;
    await db.insert(schema.leads).values({
      workspaceId: user.workspaceId!,
      campaignId,
      email: "pat@sheets.example.test",
      companyName: '=HYPERLINK("http://evil.test","Open")',
      lastName: "-Smith",
      phone: "+1 (555) 010-2000",
    });
    const csv = await exportCsv({ campaign: campaignId });
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.test"",""Open"")"`), csv);
    assert.ok(csv.includes(`"'-Smith"`), csv);
    assert.ok(csv.includes(",+1 (555) 010-2000"), csv);
  });
});

describe("a big lead export", () => {
  it("has every lead in order, a page at a time, and keeps a custom variable named like a lead's field apart", async () => {
    const campaignId = json(await user.client.post("/api/app/campaigns", { name: "Big export" })).id as string;
    const start = Date.now() - 86_400_000;
    const rows = Array.from({ length: 2_100 }, (_, i) => ({
      workspaceId: user.workspaceId!,
      campaignId,
      email: `lead-${String(i).padStart(4, "0")}@big.example.test`,
      phone: "+1 555 0100",
      payload: i === 0 ? { phone: "a custom phone", favourite: "teal" } : null,
      createdAt: new Date(start + i * 1000),
    }));
    for (let i = 0; i < rows.length; i += 200) await db.insert(schema.leads).values(rows.slice(i, i + 200));
    const parsed = Papa.parse<Record<string, string>>(await exportCsv({ campaign: campaignId }), { header: true, skipEmptyLines: true });
    assert.equal(parsed.data.length, 2_100);
    assert.deepEqual(
      parsed.data.map((r) => r.email),
      rows.map((r) => r.email),
    );
    const first = parsed.data[0]!;
    assert.equal(first.phone, "+1 555 0100");
    assert.equal(first.custom_phone, "a custom phone");
    assert.equal(first.favourite, "teal");
  });

  it("of no leads still has its header", async () => {
    const campaignId = json(await user.client.post("/api/app/campaigns", { name: "Nobody yet" })).id as string;
    assert.match(await exportCsv({ campaign: campaignId }), /^email,first_name,last_name,/);
  });
});

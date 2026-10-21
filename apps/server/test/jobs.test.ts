// Background jobs: what they keep apart (an import's rows), what happens when the app stops mid-job, and what a failed
// job tells the person who started it. Verification runs: what they charge for however they end, and leads that
// never wait for a run that's over.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { VerificationStatus, readSheetNumber, readWarmupIncrease } from "@reachstack/shared";
import { db, schema } from "../src/db/client";
import { jobErrorMessage, requeueStalledJobs, runPendingJobs } from "../src/engine/jobs";
import { badRequest } from "../src/http/errors";
import { MailError } from "../src/mail/types";
import { creditBalance } from "../src/services/billing-limits";
import { repairStuckVerification } from "../src/services/bootstrap";
import { createJob, registerJobHandler } from "../src/services/jobs";

const J = schema.backgroundJobs;
const I = schema.jobInputs;

let app: FastifyInstance;
let user: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Jo", workspaceName: "Jobs Co" });
});
after(stopServer);

const jobRow = async (id: string) => (await db.select().from(J).where(eq(J.id, id)))[0]!;
const inputRow = async (id: string) => (await db.select().from(I).where(eq(I.jobId, id)))[0];

async function finished(id: string) {
  for (let i = 0; i < 200; i++) {
    await runPendingJobs();
    const job = await jobRow(id);
    if (job.status !== "pending" && job.status !== "in-progress") return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("The job didn't finish");
}

describe("an import's rows", () => {
  it("are kept apart from the job, so reading it stays small, and are gone once it has run", async () => {
    const campaign = json(await user.client.post("/api/app/campaigns", { name: "Big import" }));
    const leads = Array.from({ length: 1200 }, (_, i) => ({ email: `person${i}@big-import.test`, first_name: `P${i}` }));
    const job = json(await user.client.post("/api/app/leads/import", { campaign_id: campaign.id, leads, source: "csv" }));
    assert.equal(job.data.total, 1200);
    assert.equal(job.data.leads, undefined, "the rows aren't part of the job");
    assert.equal(((await inputRow(job.id))?.input as unknown[]).length, 1200);
    const shown = await user.client.get(`/api/v2/background-jobs/${job.id}`);
    assert.ok(shown.body.length < 2_000, `a job reads small (${shown.body.length} bytes)`);

    const done = await finished(job.id);
    assert.equal(done.status, "success");
    assert.equal((done.result as { leads_uploaded: number }).leads_uploaded, 1200);
    assert.equal(await inputRow(job.id), undefined, "removed once it ran");
  });

  it("of an import stopped before it started are removed with it", async () => {
    const campaign = json(await user.client.post("/api/app/campaigns", { name: "Stopped import" }));
    const job = json(await user.client.post("/api/app/leads/import", { campaign_id: campaign.id, leads: [{ email: "stop@stopped-import.test" }], source: "csv" }));
    json(await user.client.post(`/api/app/background-jobs/${job.id}/cancel`));
    assert.equal((await jobRow(job.id)).status, "cancelled");
    assert.equal(await inputRow(job.id), undefined);
  });
});

describe("a job the app stopped in the middle of", () => {
  it("goes back in the queue, and fails with a note once it was cut short three times", async () => {
    const job = await createJob({ workspaceId: user.workspaceId!, type: "test-noop", input: { rows: [1, 2, 3] } });
    const stale = new Date(Date.now() - 5 * 60_000);
    await db.update(J).set({ status: "in-progress", lockedAt: stale }).where(eq(J.id, job.id));
    await requeueStalledJobs();
    let row = await jobRow(job.id);
    assert.deepEqual([row.status, row.attempts], ["pending", 1]);

    // Still running somewhere (marked alive lately): left alone.
    await db.update(J).set({ status: "in-progress", lockedAt: new Date() }).where(eq(J.id, job.id));
    await requeueStalledJobs();
    assert.equal((await jobRow(job.id)).status, "in-progress");

    for (const attempts of [2, 3]) {
      await db.update(J).set({ status: "in-progress", lockedAt: stale }).where(eq(J.id, job.id));
      await requeueStalledJobs();
      row = await jobRow(job.id);
      if (attempts < 3) assert.deepEqual([row.status, row.attempts], ["pending", attempts]);
    }
    assert.equal(row.status, "failed");
    assert.match(row.error ?? "", /The app stopped while this was running/);
    assert.equal(await inputRow(job.id), undefined);
  });
});

describe("a job that fails", () => {
  registerJobHandler("test-crash", async ({ job }) => {
    const kind = (job.data as { kind: string }).kind;
    if (kind === "internal") (undefined as unknown as { x: () => void }).x();
    if (kind === "refused") throw badRequest("The campaign was deleted, so nothing was imported.");
    if (kind === "disk") throw Object.assign(new Error("SQLITE_FULL: database or disk is full"), { code: "SQLITE_FULL" });
    throw new Error("The workspace no longer exists");
  });

  it("says why when the reason was written for people, and never shows the server's internals", async () => {
    const errorOf = async (kind: string) => (await finished((await createJob({ workspaceId: user.workspaceId!, type: "test-crash", data: { kind } })).id)).error;
    assert.equal(await errorOf("refused"), "The campaign was deleted, so nothing was imported.");
    assert.equal(await errorOf("plain"), "The workspace no longer exists");
    assert.match((await errorOf("internal")) ?? "", /^Something went wrong on the server while this ran\./);
    assert.match((await errorOf("disk")) ?? "", /^The disk is full/);
    assert.equal(jobErrorMessage(new MailError("auth", "The mail server refused the login.")), "The mail server refused the login.");
    assert.match(jobErrorMessage(new TypeError("Cannot read properties of undefined (reading 'id')")), /^Something went wrong/);
  });
});

describe("mailbox CSV values", () => {
  it("take the warmup increase as people write it", () => {
    const cases: Array<[string, string | undefined]> = [
      ["Recommended", "0"],
      ["disabled", "disabled"],
      ["Off", "disabled"],
      ["+2", "2"],
      ["3 per day", "3"],
      ["9", "4"],
      ["fast", undefined],
      ["", undefined],
    ];
    for (const [given, expected] of cases) assert.equal(readWarmupIncrease(given), expected, given);
    for (const [given, expected] of [["50/day", 50], ["1,000", 1000], ["1 000 a day", 1000], [" 30 ", 30], ["lots", undefined], ["", undefined]] as const) {
      assert.equal(readSheetNumber(given), expected, given);
    }
  });

  it("take numbers as spreadsheets write them, and don't refuse the import for one that isn't", async () => {
    const res = await user.client.post("/api/app/accounts/import", {
      accounts: [
        { email: "csv-1@example.test", imap_host: "127.0.0.1", smtp_host: "127.0.0.1", imap_password: "test-only-pass-1", daily_limit: "50/day", warmup_limit: "1,000", warmup_increment: "Recommended" },
        { email: "csv-2@example.test", imap_host: "127.0.0.1", smtp_host: "127.0.0.1", imap_password: "test-only-pass-2", daily_limit: "lots", imap_port: "993" },
      ],
      enable_warmup: false,
    });
    const job = json(res);
    const done = await finished(job.id);
    assert.equal(done.status, "success");
    // Every row reached the mailbox checks (here: a private host, refused without connecting).
    for (const r of (done.result as { results: Array<{ error?: string }> }).results) assert.match(r.error ?? "", /private or internal network/);
  });
});

describe("a job stopped while it runs", () => {
  registerJobHandler("test-stopped", async ({ job }) => {
    await db.update(J).set({ status: "cancelled" }).where(eq(J.id, job.id));
    return { done: 3 };
  });

  it("keeps what it did before it stopped", async () => {
    const job = await finished((await createJob({ workspaceId: user.workspaceId!, type: "test-stopped" })).id);
    assert.equal(job.status, "cancelled");
    assert.deepEqual(job.result, { done: 3 });
  });
});

describe("verification runs", () => {
  let metered: TestUser;
  before(async () => {
    metered = await signUp(app, { firstName: "Vi", workspaceName: "Verifying Co" });
    await db.update(schema.workspaces).set({ selfHosted: false, trialEndsAt: new Date(Date.now() + 7 * 86_400_000) }).where(eq(schema.workspaces.id, metered.workspaceId!));
    await db.insert(schema.creditLedger).values({ workspaceId: metered.workspaceId!, pool: "verification", delta: 100, reason: "test_grant" });
  });
  const balance = () => creditBalance(metered.workspaceId!, "verification");
  const leadsOf = (campaignId: string) => db.select().from(schema.leads).where(eq(schema.leads.campaignId, campaignId));
  const runOf = async (campaignId: string) =>
    (await db.select().from(J).where(and(eq(J.workspaceId, metered.workspaceId!), eq(J.type, "verify-leads"), eq(J.entityId, campaignId))))[0]!;

  it("stopped before it started gives its credits back, and the leads waiting for it don't wait forever", async () => {
    const campaign = json(await metered.client.post("/api/app/campaigns", { name: "Stopped verification" }));
    const start = await balance();
    json(await metered.client.post("/api/v2/leads/add", { campaign_id: campaign.id, verify_leads_on_import: true, leads: [{ email: "one@stopped-run.test" }, { email: "two@stopped-run.test" }] }));
    assert.equal(await balance(), start - 2);
    const run = await runOf(campaign.id);
    json(await metered.client.post(`/api/app/background-jobs/${run.id}/cancel`));
    assert.equal(await balance(), start);
    assert.deepEqual((await leadsOf(campaign.id)).map((l) => l.verificationStatus), [VerificationStatus.NOT_VERIFIED, VerificationStatus.NOT_VERIFIED]);
  });

  it("given up after restarts does the same", async () => {
    const campaign = json(await metered.client.post("/api/app/campaigns", { name: "Given up verification" }));
    json(await metered.client.post("/api/v2/leads/add", { campaign_id: campaign.id, leads: [{ email: "one@given-up.test" }, { email: "two@given-up.test" }] }));
    const start = await balance();
    const job = json(await metered.client.post("/api/app/verification/leads", { campaign: campaign.id }));
    assert.equal(await balance(), start - 2);
    // Its first attempts had marked the leads pending, then the app stopped each time.
    await db.update(schema.leads).set({ verificationStatus: VerificationStatus.PENDING }).where(eq(schema.leads.campaignId, campaign.id));
    await db.update(J).set({ status: "in-progress", lockedAt: new Date(Date.now() - 5 * 60_000), attempts: 2 }).where(eq(J.id, job.id));
    await requeueStalledJobs();
    assert.equal((await jobRow(job.id)).status, "failed");
    assert.equal(await balance(), start);
    assert.ok((await leadsOf(campaign.id)).every((l) => l.verificationStatus === VerificationStatus.NOT_VERIFIED));
  });

  it("picked up again after a restart finishes the leads its first attempt had started on, and charges once", async () => {
    const campaign = json(await metered.client.post("/api/app/campaigns", { name: "Restarted verification" }));
    json(await metered.client.post("/api/v2/leads/add", { campaign_id: campaign.id, leads: [{ email: "good.one@restarted-run.test" }, { email: "good.two@restarted-run.test" }, { email: "good.three@restarted-run.test" }] }));
    const start = await balance();
    const job = json(await metered.client.post("/api/app/verification/leads", { campaign: campaign.id }));
    await db.update(schema.leads).set({ verificationStatus: VerificationStatus.PENDING }).where(eq(schema.leads.campaignId, campaign.id));
    await db.update(J).set({ status: "in-progress", lockedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(J.id, job.id));
    await requeueStalledJobs();
    const done = await finished(job.id);
    assert.equal(done.status, "success");
    assert.ok((await leadsOf(campaign.id)).every((l) => l.verificationStatus === VerificationStatus.VERIFIED));
    assert.equal(await balance(), start - 3);
  });

  it("of pasted addresses keep the addresses out of the job, show how far they got, and give back what they didn't use", async () => {
    const start = await balance();
    const job = json(await metered.client.post("/api/app/verification/bulk", { emails: ["good@pasted-run.test", "also.good@pasted-run.test", "good@pasted-run.test"] }));
    assert.equal(job.data.emails, undefined, "the addresses aren't part of the job");
    assert.equal(await balance(), start - 2);
    await db.update(J).set({ data: { ...job.data, processed: 1 } }).where(eq(J.id, job.id));
    const listed = (json(await metered.client.get("/api/app/verification/jobs")) as Array<{ id: string; processed: number; total: number }>).find((j) => j.id === job.id)!;
    assert.deepEqual([listed.processed, listed.total], [1, 2]);
    const done = await finished(job.id);
    assert.equal((done.result as { processed: number }).processed, 2);
    // One of them was checked a moment ago by another run: reused, so free.
    json(await metered.client.post("/api/app/verification/bulk", { emails: ["good@pasted-run.test"] }));
    const [again] = await db.select().from(J).where(and(eq(J.workspaceId, metered.workspaceId!), eq(J.type, "verify-emails"), inArray(J.status, ["pending"])));
    await finished(again!.id);
    assert.equal(await balance(), start - 2);
  });

  it("of two imports into one campaign each take their own import's leads: stopping one leaves the other's waiting", async () => {
    const campaign = json(await metered.client.post("/api/app/campaigns", { name: "Two imports" }));
    const start = await balance();
    json(await metered.client.post("/api/v2/leads/add", { campaign_id: campaign.id, verify_leads_on_import: true, leads: [{ email: "first.one@two-imports.test" }, { email: "first.two@two-imports.test" }] }));
    json(await metered.client.post("/api/v2/leads/add", { campaign_id: campaign.id, verify_leads_on_import: true, leads: [{ email: "second.one@two-imports.test" }] }));
    const runs = await db.select().from(J).where(and(eq(J.workspaceId, metered.workspaceId!), eq(J.type, "verify-leads"), eq(J.entityId, campaign.id))).orderBy(asc(J.id));
    assert.equal(runs.length, 2);
    json(await metered.client.post(`/api/app/background-jobs/${runs[0]!.id}/cancel`));
    const states = async () => Object.fromEntries((await leadsOf(campaign.id)).map((l) => [l.email, l.verificationStatus]));
    assert.deepEqual(await states(), {
      "first.one@two-imports.test": VerificationStatus.NOT_VERIFIED,
      "first.two@two-imports.test": VerificationStatus.NOT_VERIFIED,
      "second.one@two-imports.test": VerificationStatus.PENDING_JOB,
    });
    const done = await finished(runs[1]!.id);
    assert.equal(done.status, "success");
    assert.equal((done.result as { total: number }).total, 1, "its own lead only");
    assert.equal((await states())["second.one@two-imports.test"], VerificationStatus.VERIFIED);
    assert.equal(await balance(), start - 1, "the stopped run's credits came back");
    assert.ok((await leadsOf(campaign.id)).every((l) => l.verifyRunId === null), "no lead keeps a run's tag");
  });

  it("follow their leads when they move, and don't hold leads without an address", async () => {
    const campaign = json(await metered.client.post("/api/app/campaigns", { name: "Moved before checked" }));
    const list = json(await metered.client.post("/api/v2/lead-lists", { name: "Moved here" }));
    json(await metered.client.post("/api/v2/leads/add", { campaign_id: campaign.id, verify_leads_on_import: true, leads: [{ email: "moving@moved-run.test" }] }));
    const run = await runOf(campaign.id);
    const [lead] = await leadsOf(campaign.id);
    await db.update(schema.leads).set({ campaignId: null, listId: list.id }).where(eq(schema.leads.id, lead!.id));
    assert.equal((await finished(run.id)).status, "success");
    assert.equal((await db.select().from(schema.leads).where(eq(schema.leads.id, lead!.id)))[0]!.verificationStatus, VerificationStatus.VERIFIED);

    json(await metered.client.post("/api/v2/leads/add", { list_id: list.id, verify_leads_on_import: true, leads: [{ first_name: "Noemail", phone: "+15550100" }] }));
    const [noEmail] = await db.select().from(schema.leads).where(and(eq(schema.leads.listId, list.id), isNull(schema.leads.email)));
    assert.equal(noEmail!.verificationStatus, VerificationStatus.NOT_VERIFIED, "nothing to check, nothing to wait for");
  });

  it("whose leads were tagged just as the app stopped (so it was never queued) is queued at the next start", async () => {
    const campaign = json(await metered.client.post("/api/app/campaigns", { name: "Never queued" }));
    json(await metered.client.post("/api/v2/leads/add", { campaign_id: campaign.id, leads: [{ email: "stranded@never-queued.test" }] }));
    await db.update(schema.leads).set({ verificationStatus: VerificationStatus.PENDING_JOB, verifyRunId: "run-that-never-was" }).where(eq(schema.leads.campaignId, campaign.id));
    await repairStuckVerification();
    const [lead] = await leadsOf(campaign.id);
    assert.ok(lead!.verifyRunId && lead!.verifyRunId !== "run-that-never-was", "tagged for a new run");
    assert.equal((await finished(lead!.verifyRunId!)).status, "success");
    const [after] = await leadsOf(campaign.id);
    assert.deepEqual([after!.verificationStatus, after!.verifyRunId], [VerificationStatus.VERIFIED, null]);
  });

  it("an address with a % in it is looked up, not a server error", async () => {
    const res = await metered.client.get(`/api/v2/email-verification/${encodeURIComponent("100%real@percent.test")}`);
    assert.equal(res.statusCode, 404);
  });
});

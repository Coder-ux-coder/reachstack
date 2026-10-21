// Inbox placement: runs that send in the background (one at a time, added up only once everything went out), seeds
// that can't be read, tests sent from another tool (their codes and seeds), the latest run's numbers and the
// workspace's clock. Senders and seeds are sandboxes, and the one "real" seed is never connected: nothing leaves the
// process.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AccountStatus, INBOX_PLACEMENT, ProviderCode } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { checkPlacement, runTest, seedsForLabels } from "../src/services/placement";

const T = schema.inboxPlacementTests;
const R = schema.inboxPlacementResults;
const REP = schema.inboxPlacementReports;

let app: FastifyInstance;
let user: TestUser;
let sender: string;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Pia", workspaceName: "Placement Co" });
  sender = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
});
after(stopServer);

const US_PRO = (esp: string) => ({ region: "North America", sub_region: "US", type: "Professional", esp });
const testRow = async (id: string) => (await db.select().from(T).where(eq(T.id, id)))[0]!;
const reportsOf = (runId: string) => db.select().from(REP).where(eq(REP.runId, runId));

/** A scheduled test sent from the app, one email at a time, to two seeds (Google and Microsoft, US, business). */
async function scheduledTest(name: string, extra: Record<string, unknown> = {}) {
  const created = json(
    await user.client.post("/api/v2/inbox-placement-tests", {
      name,
      type: INBOX_PLACEMENT.TYPE_AUTOMATED,
      sending_method: INBOX_PLACEMENT.SENDING_FROM_APP,
      delivery_mode: INBOX_PLACEMENT.DELIVERY_ONE_BY_ONE,
      schedule: { days: { 1: true }, timing: { from: "09:00" }, timezone: "UTC" },
      email_subject: "Quick question",
      email_body: "<p>Hello there.</p>",
      emails: [sender],
      recipients_labels: [US_PRO("Google"), US_PRO("Microsoft")],
      ...extra,
    }),
  );
  return created.id as string;
}

const external = (name: string) => ({
  name,
  type: INBOX_PLACEMENT.TYPE_ONE_TIME,
  sending_method: INBOX_PLACEMENT.SENDING_EXTERNAL,
  email_subject: "From the other tool",
  email_body: "<p>Hello.</p>",
  emails: [],
  recipients_labels: [US_PRO("Google")],
});

async function eventually(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("a placement run", () => {
  it("sends in the background, one run at a time, and is added up only once everything went out", async () => {
    const id = await scheduledTest("One at a time");
    const started = await runTest(id);
    assert.equal(started.sending, 2);
    expectStatus(await user.client.post(`/api/app/inbox-placement-tests/${id}/run`), 409, "a second run while it sends");
    // The first email has landed while the second waits its turn: nothing is added up yet.
    await new Promise((r) => setTimeout(r, 400));
    await checkPlacement();
    assert.equal((await reportsOf(started.run_id)).length, 0);

    await started.finished;
    await checkPlacement();
    assert.equal((await db.select().from(R).where(and(eq(R.runId, started.run_id), eq(R.recordType, 2)))).length, 2);
    assert.ok((await reportsOf(started.run_id)).length > 0, "added up once both went out");
    assert.equal((await testRow(id)).sendingRunId, null);
  });

  it("isn't held up by a seed that can't be read: after the wait, its emails are unchecked, left out of the numbers", async () => {
    const id = await scheduledTest("Lost seed");
    await db.insert(R).values({
      workspaceId: user.workspaceId!,
      testId: id,
      runId: "run-lost-seed",
      recordType: 1,
      senderEmail: sender,
      recipientEmail: "gone@removed-seed.test",
      recipientEsp: 1,
      recipientGeo: 1,
      recipientType: 1,
      messageId: "<lost@placement.test>",
      createdAt: new Date(Date.now() - 31 * 60_000),
    });
    await checkPlacement();
    const [unchecked] = await db.select().from(R).where(and(eq(R.runId, "run-lost-seed"), eq(R.recordType, 2)));
    assert.equal(unchecked?.folder, "unchecked");
    assert.equal(unchecked?.isSpam, null, "not counted as spam: nobody could look");
    assert.ok((await reportsOf("run-lost-seed")).length > 0, "the run was added up");
    const page = json(await user.client.get(`/api/app/inbox-placement-tests/${id}/overview?run_id=run-lost-seed`));
    assert.equal(page.summary.count, 0);
    assert.equal(page.summary.unchecked_count, 1);
    assert.equal(page.summary.spam_percent, 0);
  });

  it("with nothing to send says so, and a one-time test doesn't stay running", async () => {
    const paused = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
    await db.update(schema.emailAccounts).set({ status: AccountStatus.PAUSED }).where(eq(schema.emailAccounts.email, paused));
    const created = json(
      await user.client.post("/api/v2/inbox-placement-tests", {
        name: "Nothing to send",
        type: INBOX_PLACEMENT.TYPE_ONE_TIME,
        sending_method: INBOX_PLACEMENT.SENDING_FROM_APP,
        email_subject: "Hi",
        email_body: "<p>Hi</p>",
        emails: [paused],
        recipients_labels: [US_PRO("Google")],
      }),
    );
    // One-time tests start their run as soon as they're made.
    await eventually(async () => (await testRow(created.id)).status === INBOX_PLACEMENT.STATUS_COMPLETED, "the test to end");
    assert.equal(json(await user.client.get(`/api/v2/inbox-placement-tests/${created.id}`)).not_sending_status, "other");
  });
});

describe("placement numbers", () => {
  it("'latest placement' is the newest run's, not every run's added together", async () => {
    const id = await scheduledTest("Two runs");
    const result = (runId: string, isSpam: boolean, minutesAgo: number, n: number) => ({
      workspaceId: user.workspaceId!,
      testId: id,
      runId,
      recordType: 2,
      senderEmail: sender,
      recipientEmail: `seed${n}@numbers.test`,
      messageId: `<${runId}-${n}@numbers.test>`,
      isSpam,
      hasCategory: false,
      folder: isSpam ? "Spam" : "INBOX",
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    await db.insert(R).values([result("old-run", false, 120, 1), result("old-run", false, 120, 2), result("new-run", true, 5, 1), result("new-run", true, 5, 2)]);
    const [latest] = json<Array<{ spam_percent: number }>>(await user.client.post("/api/v2/inbox-placement-analytics/stats-by-test-id", { test_ids: [id], latest_run_only: true }));
    assert.equal(latest!.spam_percent, 100);
    const [all] = json<Array<{ spam_percent: number }>>(await user.client.post("/api/v2/inbox-placement-analytics/stats-by-test-id", { test_ids: [id] }));
    assert.equal(all!.spam_percent, 50);
  });
});

describe("a test sent from another tool", () => {
  const REAL_SEED = "seed@real-seed.example.com";
  after(async () => {
    await db.update(schema.placementSeeds).set({ active: false }).where(eq(schema.placementSeeds.email, REAL_SEED));
  });

  it("needs real seed inboxes: the simulated ones can't get its email", async () => {
    const res = await user.client.post("/api/v2/inbox-placement-tests", external("Simulated seeds only"));
    expectStatus(res, 400);
    assert.match(res.body, /real seed inboxes/);
  });

  it("gets a long code of its own, and only the real seeds' addresses", async () => {
    const [box] = await db.insert(schema.emailAccounts).values({ workspaceId: user.workspaceId!, email: REAL_SEED, providerCode: ProviderCode.CUSTOM, status: AccountStatus.ACTIVE }).returning();
    await db.insert(schema.placementSeeds).values({ email: REAL_SEED, accountId: box!.id, region: "North America", subRegion: "US", type: "Professional", esp: 1, geo: 1 });
    const t = json(await user.client.post("/api/v2/inbox-placement-tests", external("Real seeds")));
    assert.match(t.test_code, /^ptid_[A-Za-z0-9_-]{12}$/);
    assert.deepEqual(t.recipients, [REAL_SEED]);
    // One code per test, and long enough not to be the start of another's.
    expectStatus(await user.client.post("/api/v2/inbox-placement-tests", { ...external("Same code"), test_code: t.test_code }), 409);
    expectStatus(await user.client.post("/api/v2/inbox-placement-tests", { ...external("Short code"), test_code: "ptid_ab" }), 400);
    // A test from the app switched to another tool gets a code.
    const switched = json(await user.client.patch(`/api/v2/inbox-placement-tests/${await scheduledTest("Switched")}`, { sending_method: INBOX_PLACEMENT.SENDING_EXTERNAL }));
    assert.match(switched.test_code, /^ptid_[A-Za-z0-9_-]{12}$/);
    assert.deepEqual(switched.recipients, [REAL_SEED]);
  });

  it("counts only emails carrying its own code, not ones whose code merely starts with it (another workspace's)", async () => {
    const other = await signUp(app, { firstName: "Oz", workspaceName: "Other Placement Co" });
    // A test of another workspace's, from before codes had to be long.
    const [theirs] = await db
      .insert(T)
      .values({ workspaceId: other.workspaceId!, name: "Theirs", type: 1, sendingMethod: 2, emailSubject: "x", emailBody: "x", emails: [], recipients: [], testCode: "ptid_short", status: 1 })
      .returning();
    const id = await scheduledTest("Longer code", { email_body: "<p>Hello there. ptid_shortened</p>", delivery_mode: INBOX_PLACEMENT.DELIVERY_ALL_TOGETHER });
    const started = await runTest(id);
    await started.finished;
    await checkPlacement();
    assert.equal((await db.select().from(R).where(eq(R.testId, theirs!.id))).length, 0);
  });
});

describe("the workspace's clock", () => {
  it("dates placement results", async () => {
    json(await user.client.patch("/api/app/workspaces/current/settings", { default_timezone: "Asia/Kolkata" }));
    const id = await scheduledTest("Late evening");
    await db.insert(R).values({
      workspaceId: user.workspaceId!,
      testId: id,
      runId: "kolkata-run",
      recordType: 2,
      senderEmail: sender,
      recipientEmail: "seed@kolkata.test",
      messageId: "<kolkata@placement.test>",
      isSpam: false,
      hasCategory: false,
      folder: "INBOX",
      createdAt: new Date("2026-10-16T20:00:00Z"),
    });
    const page = json(await user.client.get(`/api/v2/inbox-placement-analytics?test_id=${id}`));
    // 20:00 in London is 01:30 the next day in Kolkata.
    assert.equal(page.items[0].timestamp_created_date, "2026-10-17");
  });
});

describe("seeds", () => {
  it("aren't sent to while their mailbox can't be signed in to for reading", async () => {
    const failing = (side: "imap" | "smtp") => ({ sides: { [side]: { code: "auth", message: "Invalid credentials", at: Date.now(), count: 1 } } });
    const [box] = await db
      .insert(schema.emailAccounts)
      .values({ workspaceId: user.workspaceId!, email: "seed@locked-seed.example.com", providerCode: ProviderCode.CUSTOM, status: AccountStatus.CONNECTION_ERROR, statusMessage: failing("imap") })
      .returning();
    await db.insert(schema.placementSeeds).values({ email: box!.email, accountId: box!.id, region: "North America", subRegion: "US", type: "Professional", esp: 1, geo: 1 });
    try {
      assert.ok(!(await seedsForLabels(null)).some((s) => s.email === box!.email));
      // Only its sending fails: it can still be read.
      await db.update(schema.emailAccounts).set({ statusMessage: failing("smtp") }).where(eq(schema.emailAccounts.id, box!.id));
      assert.ok((await seedsForLabels(null)).some((s) => s.email === box!.email));
    } finally {
      await db.update(schema.placementSeeds).set({ active: false }).where(eq(schema.placementSeeds.email, box!.email));
    }
  });
});

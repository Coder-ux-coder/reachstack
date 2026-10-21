// Secrets stay secret: mailbox passwords (accounts API, CSV imports, background jobs), the private-network guard on
// mail servers, and the workspace's own AI key. Every value here is a made-up test string.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { TestClient, expectStatus, json, signUp, startServer, stopServer, type Res, type TestUser } from "./helpers/app";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";
import { decrypt } from "../src/lib/crypto";
import { bootstrapInstallation } from "../src/services/bootstrap";

const IMAP_PASSWORD = "imap-pass-for-tests-only-1";
const SMTP_PASSWORD = "smtp-pass-for-tests-only-2";
const PUBLIC_HOST = "203.0.113.25"; // documentation range: public, and never contacted (no connection test)

let app: FastifyInstance;
let alice: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  alice = await signUp(app, { firstName: "Alice" });
});
after(stopServer);

async function connectMailbox(email: string, extra: Record<string, unknown> = {}) {
  return alice.client.post("/api/v2/accounts", {
    email,
    imap_host: PUBLIC_HOST,
    smtp_host: PUBLIC_HOST,
    imap_password: IMAP_PASSWORD,
    smtp_password: SMTP_PASSWORD,
    skip_connection_test: true,
    ...extra,
  });
}

async function storedAccount(email: string) {
  const [row] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.email, email));
  assert.ok(row, email);
  return row;
}

function assertNoSecrets(body: string, label: string, secrets = [IMAP_PASSWORD, SMTP_PASSWORD, "_sealed", "v1:"]) {
  for (const s of secrets) assert.ok(!body.includes(s), `${label} contains ${s}`);
}

describe("mailbox passwords", () => {
  it("are stored encrypted and never come back from the accounts API", async () => {
    const email = "mailbox@example.test";
    const created = await connectMailbox(email);
    expectStatus(created, 200);
    assertNoSecrets(created.body, "create");
    const e = encodeURIComponent(email);
    for (const url of [`/api/v2/accounts/${e}`, "/api/v2/accounts", "/api/app/accounts/export", "/api/app/accounts/summary", `/api/app/accounts/${e}/campaigns`]) {
      const res = await alice.client.get(url);
      expectStatus(res, 200, url);
      assertNoSecrets(res.body, url);
    }
    const row = await storedAccount(email);
    assert.equal(decrypt(row.imapPasswordEnc), IMAP_PASSWORD);
    assert.equal(decrypt(row.smtpPasswordEnc), SMTP_PASSWORD);
    assert.ok(!JSON.stringify(row).includes(IMAP_PASSWORD));
  });

  it("moving a mailbox to another server, port or username needs its password again", async () => {
    const email = "mover@example.test";
    expectStatus(await connectMailbox(email), 200);
    const e = encodeURIComponent(email);
    for (const patch of [{ imap_host: "203.0.113.26" }, { smtp_host: "203.0.113.26" }, { imap_port: 143 }, { imap_username: "someone-else" }, { smtp_username: "someone-else" }]) {
      const res = await alice.client.patch(`/api/v2/accounts/${e}`, patch);
      expectStatus(res, 400, JSON.stringify(patch));
      assert.match(res.json().message, /password again/, JSON.stringify(patch));
    }
    const unchanged = json(await alice.client.get(`/api/v2/accounts/${e}`));
    assert.equal(unchanged.imap_host, PUBLIC_HOST);
    assert.equal(unchanged.smtp_host, PUBLIC_HOST);

    const moved = json(await alice.client.patch(`/api/v2/accounts/${e}`, { imap_host: "203.0.113.26", smtp_host: "203.0.113.26", imap_password: "new-imap-pass-for-tests-3" }));
    assert.equal(moved.imap_host, "203.0.113.26");
    const row = await storedAccount(email);
    assert.equal(decrypt(row.imapPasswordEnc), "new-imap-pass-for-tests-3");
    assert.equal(decrypt(row.smtpPasswordEnc), "new-imap-pass-for-tests-3");
  });

  it("a new IMAP password leaves a separate SMTP password alone, and a new inbox server is read afresh", async () => {
    const email = "relay@example.test";
    expectStatus(await connectMailbox(email), 200); // its own SMTP password, a relay's say
    const e = encodeURIComponent(email);
    const folders = { inbox: "INBOX", spam: "Junk", sent: "Sent", trash: "Trash", archive: null, important: null, all: null, checked_at: Date.now() };
    await db.update(schema.emailAccounts).set({ folders, syncState: { INBOX: { uidValidity: "7", lastUid: 40 } } }).where(eq(schema.emailAccounts.email, email));

    json(await alice.client.patch(`/api/v2/accounts/${e}`, { imap_password: "rotated-imap-pass-for-tests-4" }));
    let row = await storedAccount(email);
    assert.equal(decrypt(row.imapPasswordEnc), "rotated-imap-pass-for-tests-4");
    assert.equal(decrypt(row.smtpPasswordEnc), SMTP_PASSWORD, "the SMTP password stays");
    assert.deepEqual(row.folders, folders, "same server: same folders");
    assert.equal(row.syncState?.INBOX?.lastUid, 40);

    json(await alice.client.patch(`/api/v2/accounts/${e}`, { imap_host: "203.0.113.27", imap_password: "rotated-imap-pass-for-tests-4" }));
    row = await storedAccount(email);
    assert.equal(row.folders, null, "another server's folders are read afresh");
    assert.equal(row.syncState, null);
    assert.equal(decrypt(row.smtpPasswordEnc), SMTP_PASSWORD);
  });

  it("mail servers on private networks are refused when connecting, testing or moving", async () => {
    const refused = (res: Res, label: string) => {
      expectStatus(res, 400, label);
      assert.match(res.json().message, /private or internal network/, label);
    };
    let n = 0;
    for (const host of ["127.0.0.1", "10.0.0.8", "192.168.1.10", "169.254.169.254", "::1", "[::1]", "::ffff:7f00:1", "fd00::5"]) {
      refused(await connectMailbox(`private-${++n}@example.test`, { imap_host: host }), `imap ${host}`);
      refused(await connectMailbox(`private-${++n}@example.test`, { smtp_host: host }), `smtp ${host}`);
    }
    refused(
      await alice.client.post("/api/app/accounts/test-connection", {
        email: "probe@example.test",
        imap_host: "127.0.0.1",
        smtp_host: "127.0.0.1",
        imap_password: "probe-pass-for-tests",
        smtp_password: "probe-pass-for-tests",
      }),
      "test-connection",
    );
    const e = encodeURIComponent("mailbox@example.test");
    refused(await alice.client.patch(`/api/v2/accounts/${e}`, { imap_host: "10.9.8.7", imap_password: "another-test-pass" }), "move imap");
    refused(await alice.client.patch(`/api/v2/accounts/${e}`, { smtp_host: "169.254.169.254", smtp_password: "another-test-pass" }), "move smtp");
    assert.equal(json(await alice.client.get(`/api/v2/accounts/${e}`)).imap_host, PUBLIC_HOST);
    assert.ok(!json(await alice.client.get("/api/v2/accounts")).items.some((a: { email: string }) => a.email.startsWith("private-")));
  });
});

describe("background jobs", () => {
  async function importMailboxes() {
    return json(
      await alice.client.post("/api/app/accounts/import", {
        // Private hosts: the import refuses them without opening a connection.
        accounts: [
          { email: "import-1@example.test", imap_host: "127.0.0.1", smtp_host: "127.0.0.1", imap_password: IMAP_PASSWORD, smtp_password: SMTP_PASSWORD },
          { email: "import-2@example.test", imap_host: "10.1.2.3", smtp_host: "10.1.2.3", imap_password: IMAP_PASSWORD, smtp_password: SMTP_PASSWORD },
        ],
        enable_warmup: false,
      }),
    );
  }

  async function waitForJob(id: string) {
    for (let i = 0; i < 250; i++) {
      const [row] = await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, id));
      if (row && row.status !== "pending" && row.status !== "in-progress") return row;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`job ${id} didn't finish`);
  }

  it("never show imported mailbox passwords, to members or API keys", async () => {
    const job = await importMailboxes();
    assert.deepEqual(job.data.emails, ["import-1@example.test", "import-2@example.test"]);
    const { key } = json(await alice.client.post("/api/v2/api-keys", { name: "Jobs", scopes: ["background-jobs:read"] }));
    const api = new TestClient(app, key);
    const answers = {
      created: JSON.stringify(job),
      list: (await alice.client.get("/api/v2/background-jobs")).body,
      one: (await alice.client.get(`/api/v2/background-jobs/${job.id}`)).body,
      fields: (await alice.client.get(`/api/v2/background-jobs/${job.id}?data_fields=accounts,_sealed,emails`)).body,
      apiList: (await api.get("/api/v2/background-jobs")).body,
      apiOne: (await api.get(`/api/v2/background-jobs/${job.id}`)).body,
    };
    for (const [label, body] of Object.entries(answers)) assertNoSecrets(body, label);
  });

  it("keep imported passwords encrypted while waiting, and drop them once the job has run", async () => {
    const job = await importMailboxes();
    const [waiting] = await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, job.id));
    assert.ok(!JSON.stringify(waiting!.data).includes(IMAP_PASSWORD));
    const [input] = await db.select().from(schema.jobInputs).where(eq(schema.jobInputs.jobId, job.id));
    assert.ok(!JSON.stringify(input).includes(IMAP_PASSWORD));
    assert.ok(input?.sealed && decrypt(input.sealed)!.includes(IMAP_PASSWORD), "the passwords wait sealed");

    await runPendingJobs();
    const finished = await waitForJob(job.id);
    assert.equal(finished.status, "success");
    assertNoSecrets(JSON.stringify(finished), "finished job row");
    assert.equal((await db.select().from(schema.jobInputs).where(eq(schema.jobInputs.jobId, job.id))).length, 0, "gone once it ran");
    const shown = await alice.client.get(`/api/v2/background-jobs/${job.id}`);
    const result = shown.json().result as { imported: number; failed: number; results: Array<{ error?: string }> };
    assert.deepEqual([result.imported, result.failed], [0, 2]);
    // The job did get the passwords (otherwise: "IMAP password is required") and stopped at the host check.
    for (const r of result.results) assert.match(r.error ?? "", /private or internal network/);
    assertNoSecrets(shown.body, "finished job");
    assert.ok(!json(await alice.client.get("/api/v2/accounts")).items.some((a: { email: string }) => a.email.startsWith("import-")));
  });

  it("hide credential-looking fields that older jobs kept in plain text", async () => {
    const [old] = await db
      .insert(schema.backgroundJobs)
      .values({
        workspaceId: alice.workspaceId!,
        userId: alice.id,
        type: "import-accounts",
        status: "success",
        data: { accounts: [{ email: "old@example.test", imap_password: IMAP_PASSWORD, smtp_password: SMTP_PASSWORD }], total: 1 },
        result: { api_key: "old-key-for-tests", nested: { token: "old-token-for-tests" } },
      })
      .returning();
    const res = await alice.client.get(`/api/v2/background-jobs/${old!.id}`);
    expectStatus(res, 200);
    assertNoSecrets(res.body, "old job", [IMAP_PASSWORD, SMTP_PASSWORD, "old-key-for-tests", "old-token-for-tests"]);
    assert.ok(res.body.includes("old@example.test"));
  });

  it("finished imports from before the fix lose their passwords at startup", async () => {
    const [old] = await db
      .insert(schema.backgroundJobs)
      .values({
        workspaceId: alice.workspaceId!,
        userId: alice.id,
        type: "import-accounts",
        status: "failed",
        data: { accounts: [{ email: "older@example.test", imap_password: IMAP_PASSWORD }], total: 1 },
      })
      .returning();
    await bootstrapInstallation();
    const [row] = await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, old!.id));
    assert.ok(!JSON.stringify(row!.data).includes(IMAP_PASSWORD));
    assert.deepEqual((row!.data as { emails?: string[] }).emails, ["older@example.test"]);
  });
});

describe("the workspace's own AI key", () => {
  it("is stored encrypted and never returned", async () => {
    const aiKey = "test-workspace-ai-key-not-real";
    json(await alice.client.put("/api/app/ai/settings", { anthropic_api_key: aiKey }));
    assert.equal(json(await alice.client.get("/api/app/ai/settings")).workspace_key_set, true);
    for (const url of ["/api/app/ai/settings", "/api/app/auth/me", "/api/app/workspaces/current/settings", "/api/v2/workspaces/current"]) {
      const res = await alice.client.get(url);
      expectStatus(res, 200, url);
      assert.ok(!res.body.includes(aiKey), url);
      assert.ok(!res.body.includes("anthropic_api_key_enc"), url);
    }
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, alice.workspaceId!));
    assert.equal(decrypt((ws!.settings as Record<string, string>).anthropic_api_key_enc), aiKey);
    assert.ok(!JSON.stringify(ws).includes(aiKey));
  });

  it("can't be overwritten with a raw value through the general settings", async () => {
    expectStatus(await alice.client.patch("/api/app/workspaces/current/settings", { anthropic_api_key_enc: "v1:made-up" }), 400);
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, alice.workspaceId!));
    assert.equal(decrypt((ws!.settings as Record<string, string>).anthropic_api_key_enc), "test-workspace-ai-key-not-real");
  });
});

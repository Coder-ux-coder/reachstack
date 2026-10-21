// Mailboxes: where a Google or Microsoft sign-in token may go, what a viewer and a narrow API key may do to mailboxes,
// how inbox sync backs off a failing inbox and tries new details soon, how many inboxes one pass reads, the warmup
// score before anything landed, and one daily limit for an address connected in two workspaces. Mailboxes are sandboxes
// or rows that are never connected: nothing leaves the process.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AccountStatus, INBOX_PLACEMENT, ProviderCode } from "@reachstack/shared";
import { expectStatus, json, signUp, startServer, stopServer, TestClient, uniqueEmail, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { syncAccount, syncDueAccounts, syncDueAt } from "../src/engine/inbox-sync";
import type { AccountRow } from "../src/mail/driver";
import type { OAuthTokens } from "../src/mail/oauth";
import { SandboxDriver } from "../src/mail/sandbox";
import { classifyError, tokenFor } from "../src/mail/smtp-imap";
import { recordAccountError, retryInboxSoon, sentByTwinsToday } from "../src/services/accounts";
import { workspaceToday } from "../src/services/workspace-clock";

const A = schema.emailAccounts;

let app: FastifyInstance;
let boss: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  boss = await signUp(app, { firstName: "Bo", workspaceName: "Rules Co" });
});
after(stopServer);

const row = async (id: string) => (await db.select().from(A).where(eq(A.id, id)))[0]!;

async function sandbox(count: number, domain: string): Promise<AccountRow[]> {
  const items = json<{ items: Array<{ email: string }> }>(await boss.client.post("/api/app/accounts/sandbox", { count, domain, enable_warmup: false })).items;
  const rows = await db.select().from(A).where(inArray(A.email, items.map((i) => i.email)));
  return items.map((i) => rows.find((r) => r.email === i.email)!);
}

async function join(by: TestUser, role: string): Promise<TestUser> {
  const email = uniqueEmail(role);
  const invite = json(await by.client.post("/api/v2/workspace-members", { email, role }));
  return signUp(app, { email, inviteToken: new URL(invite.invite_url).searchParams.get("token")! });
}

describe("a Google or Microsoft sign-in token", () => {
  it("goes only to that provider's own servers: a relay for sending signs in with its own password", () => {
    const google = { oauth: { provider: "google", access_token: "test-token", refresh_token: null, expires_at: 0 } as OAuthTokens };
    assert.ok(tokenFor(google, { host: "smtp.gmail.com" }));
    assert.ok(tokenFor(google, { host: "imap.gmail.com" }));
    assert.equal(tokenFor(google, { host: "smtp.relay-service.example.com" }), null);
    assert.equal(tokenFor(google, { host: "smtp.office365.com" }), null);
    const microsoft = { oauth: { provider: "microsoft", access_token: "test-token", refresh_token: null, expires_at: 0 } as OAuthTokens };
    assert.ok(tokenFor(microsoft, { host: "outlook.office365.com" }));
    assert.equal(tokenFor(microsoft, { host: "smtp.gmail.com" }), null);
    assert.equal(tokenFor({ oauth: null }, { host: "smtp.gmail.com" }), null);
  });
});

describe("what may be done to mailboxes", () => {
  let box: string;
  before(async () => {
    box = (await sandbox(1, "rules-co.test"))[0]!.email;
  });

  it("a viewer changes their settings, and nothing more", async () => {
    const viewer = await join(boss, "view");
    assert.equal(json(await viewer.client.patch(`/api/v2/accounts/${box}`, { daily_limit: 25 })).daily_limit, 25);
    json(await viewer.client.post("/api/app/accounts/bulk", { emails: [box], action: "pause" }));
    expectStatus(await viewer.client.delete(`/api/v2/accounts/${box}`), 403, "delete");
    expectStatus(await viewer.client.post("/api/app/accounts/bulk", { emails: [box], action: "delete" }), 403, "delete in bulk");
    expectStatus(await viewer.client.post("/api/app/accounts/bulk", { emails: [box], action: "reconnect" }), 403, "test the connection in bulk");
    expectStatus(await viewer.client.post("/api/app/accounts/test-connection", { email: box }), 403, "test a connection");
    expectStatus(await viewer.client.post("/api/app/accounts/sandbox", { count: 1 }), 403, "add mailboxes");
    expectStatus(await viewer.client.post("/api/v2/accounts", { email: "new.box@rules-co.test", provider_code: ProviderCode.SANDBOX }), 403, "add a mailbox");
    const placement = { name: "Viewer's test", type: INBOX_PLACEMENT.TYPE_ONE_TIME, sending_method: INBOX_PLACEMENT.SENDING_FROM_APP, email_subject: "Hi", email_body: "<p>Hi</p>", emails: [box] };
    expectStatus(await viewer.client.post("/api/v2/inbox-placement-tests", placement), 403, "run a placement test");
    assert.ok(await db.select().from(A).where(eq(A.email, box)).then((r) => r.length === 1), "still there");
  });

  it("an API key that may only update mailboxes can't delete them in bulk", async () => {
    const key = json(await boss.client.post("/api/v2/api-keys", { name: "Updates only", scopes: ["accounts:update"] })).key as string;
    const api = new TestClient(app, key);
    json(await api.patch(`/api/v2/accounts/${box}`, { daily_limit: 20 }));
    const res = await api.post("/api/app/accounts/bulk", { emails: [box], action: "delete" });
    expectStatus(res, 403);
    assert.match(res.body, /accounts:delete/);
    assert.equal((await db.select().from(A).where(eq(A.email, box))).length, 1);
  });
});

describe("inbox sync", () => {
  it("files certificate and TLS failures under connection problems", () => {
    const kind = (code: string) => classifyError(Object.assign(new Error(`failed: ${code}`), { code })).kind;
    for (const code of ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "ClosedAfterConnectTLS"]) {
      assert.equal(kind(code), "connection", code);
    }
  });

  it("takes out an inbox failing in a way nobody recognizes after ten tries, and keeps its last good sync time", async () => {
    const [m] = await sandbox(1, "odd-failure.test");
    await syncAccount(m!);
    const good = (await row(m!.id)).lastSyncAt;
    assert.ok(good, "synced once");
    const realOpen = SandboxDriver.prototype.open;
    SandboxDriver.prototype.open = async function () {
      throw new Error("Something odd happened");
    };
    try {
      for (let i = 1; i <= 10; i++) {
        await syncAccount(await row(m!.id));
        assert.equal((await row(m!.id)).status, i < 10 ? AccountStatus.ACTIVE : AccountStatus.CONNECTION_ERROR, `after ${i} failures`);
      }
    } finally {
      SandboxDriver.prototype.open = realOpen;
    }
    assert.equal((await row(m!.id)).lastSyncAt?.getTime(), good.getTime(), "the last sync that worked, not the last try");
  });

  it("waits ten minutes once failures took an inbox out, then twice as long each time, up to a day", () => {
    const at = Date.parse("2026-10-17T10:00:00Z");
    const mailbox = (statusMessage: unknown, providerCode: number = ProviderCode.CUSTOM) =>
      ({ statusMessage, providerCode, lastSyncAt: new Date(at - 3_600_000) }) as Pick<AccountRow, "statusMessage" | "providerCode" | "lastSyncAt">;
    const failing = (code: string, count: number) => syncDueAt(mailbox({ sides: { imap: { code, message: "test failure", at, count } } }));
    assert.equal(syncDueAt(mailbox(null)), at - 3_600_000 + 60_000);
    assert.equal(syncDueAt(mailbox(null, ProviderCode.SANDBOX)), at - 3_600_000 + 15_000);
    // Not out yet: the usual minute after the last try.
    assert.equal(failing("connection", 2), at + 60_000);
    assert.equal(failing("unknown", 9), at + 60_000);
    assert.equal(failing("auth", 1), at + 10 * 60_000);
    assert.equal(failing("auth", 2), at + 20 * 60_000);
    assert.equal(failing("connection", 5), at + 40 * 60_000);
    assert.equal(failing("unknown", 10), at + 10 * 60_000);
    assert.equal(failing("auth", 40), at + 24 * 3_600_000);
  });

  it("tries new sign-in details within a minute instead of after the wait", async () => {
    const [m] = await sandbox(1, "new-details.test");
    await recordAccountError(await row(m!.id), "auth", "Invalid credentials (Failure)", {}, "imap");
    assert.equal((await row(m!.id)).status, AccountStatus.CONNECTION_ERROR);
    assert.ok(syncDueAt(await row(m!.id)) > Date.now() + 9 * 60_000, "out: waits");
    await retryInboxSoon(m!.id);
    assert.ok(syncDueAt(await row(m!.id)) <= Date.now() + 60_000, "new details: tried within a minute");
  });

  it("reads every inbox that's due in one pass, not just the first few", async () => {
    const boxes = [...(await sandbox(25, "many-inboxes.test")), ...(await sandbox(5, "more-inboxes.test"))];
    await db.update(A).set({ lastSyncAt: new Date(Date.now() - 3_600_000) }).where(inArray(A.id, boxes.map((b) => b.id)));
    const start = Date.now();
    await syncDueAccounts();
    const rows = await db.select().from(A).where(inArray(A.id, boxes.map((b) => b.id)));
    assert.equal(rows.filter((r) => (r.lastSyncAt?.getTime() ?? 0) >= start).length, 30);
  });
});

describe("warmup and limits", () => {
  it("has no warmup score before any warmup email landed (not a perfect 100)", async () => {
    const [m] = await sandbox(1, "no-warmup-yet.test");
    const r = json(await boss.client.post("/api/v2/accounts/warmup-analytics", { emails: [m!.email] }));
    assert.equal(r.aggregate_data[m!.email].health_score, null);
    assert.equal(r.aggregate_data[m!.email].health_score_label, "No data yet");
  });

  it("an address connected in two workspaces shares one daily limit", async () => {
    const other = await signUp(app, { firstName: "Oz", workspaceName: "Other Rules Co" });
    const email = "shared.box@twin-mail.example.com";
    const [mine] = await db.insert(A).values({ workspaceId: boss.workspaceId!, email, providerCode: ProviderCode.CUSTOM }).returning();
    const [theirs] = await db.insert(A).values({ workspaceId: other.workspaceId!, email, providerCode: ProviderCode.CUSTOM }).returning();
    await db.insert(schema.accountDailyStats).values({ workspaceId: other.workspaceId!, accountId: theirs!.id, date: await workspaceToday(other.workspaceId!), sent: 12 });
    assert.equal((await sentByTwinsToday([mine!])).get(email), 12, "what it sent from the other workspace today");
    const [lone] = await sandbox(1, "lone-box.test");
    assert.equal((await sentByTwinsToday([lone!])).size, 0);
  });
});

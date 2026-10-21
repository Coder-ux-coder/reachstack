// Sign-up, sessions, CSRF, sign-in limits, password reset, email confirmation, two-step sign-in and account deletion over
// HTTP.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { PASSWORD, TestClient, expectStatus, json, logIn, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";
import { eq } from "drizzle-orm";
import { CampaignStatus } from "@reachstack/shared";
import { db, schema } from "../src/db/client";
import { config } from "../src/env";
import { sha256 } from "../src/lib/ids";
import { totpCode } from "../src/lib/totp";
import { systemMailLog } from "../src/services/system-mail";

let app: FastifyInstance;
let owner: TestUser;

before(async () => {
  app = await startServer();
  owner = await signUp(app);
});
after(stopServer);

/** The token from the newest password-reset email sent to `email`. */
function resetToken(email: string): string {
  const mail = systemMailLog.find((m) => m.to === email && /reset-password\?token=/.test(m.text));
  assert.ok(mail, `no reset email for ${email}`);
  return decodeURIComponent(/reset-password\?token=([^\s&]+)/.exec(mail.text)![1]!);
}

/** A six-digit code that isn't valid right now. */
function wrongCode(secret: string): string {
  const valid = [-1, 0, 1].map((w) => totpCode(secret, Date.now() + w * 30_000));
  let n = Number(valid[1]);
  let code = valid[1]!;
  while (valid.includes(code)) code = String((n = (n + 1) % 1_000_000)).padStart(6, "0");
  return code;
}

describe("sign-up and sessions", () => {
  it("sign-up starts a session with an HttpOnly, SameSite=Lax cookie", async () => {
    const c = new TestClient(app);
    const res = await c.post("/api/app/auth/signup", { email: uniqueEmail(), password: PASSWORD, first_name: "Sam" });
    expectStatus(res, 200);
    const cookie = res.cookies.find((k) => k.name === "rs_sid");
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.path, "/");
    assert.ok(cookie.value.length >= 40);
    const me = json(await c.get("/api/app/auth/me"));
    assert.equal(me.user.first_name, "Sam");
    assert.equal(me.membership.role, "owner");
    assert.ok(me.workspace.id);
  });

  it("keeps only a hash of the session token in the database", async () => {
    const u = await signUp(app);
    const token = u.client.cookie!;
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, u.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tokenHash, sha256(token));
    assert.ok(!JSON.stringify(rows).includes(token));
  });

  it("/me never includes the password hash", async () => {
    const res = await owner.client.get("/api/app/auth/me");
    expectStatus(res, 200);
    assert.ok(!res.body.includes("scrypt$"));
    assert.ok(!/password_?hash/i.test(res.body));
  });

  it("refuses requests without a valid session", async () => {
    const anon = new TestClient(app);
    expectStatus(await anon.get("/api/app/auth/me"), 401);
    expectStatus(await anon.get("/api/app/campaigns"), 401);
    expectStatus(await anon.get("/api/v2/campaigns"), 401);
    anon.cookie = "made-up-session-token-made-up-session-token";
    expectStatus(await anon.get("/api/app/auth/me"), 401);
  });

  it("validates sign-up details and refuses a second account for an email", async () => {
    const c = new TestClient(app);
    expectStatus(await c.post("/api/app/auth/signup", { email: uniqueEmail(), password: "short" }), 400);
    expectStatus(await c.post("/api/app/auth/signup", { email: "not-an-email", password: PASSWORD }), 400);
    expectStatus(await c.post("/api/app/auth/signup", { email: owner.email, password: PASSWORD }), 409);
    expectStatus(await c.post("/api/app/auth/signup", { email: owner.email.toUpperCase(), password: PASSWORD }), 409);
    assert.equal(c.cookie, null);
  });
});

describe("a new workspace's clock", () => {
  /** Signs up from a browser on `timezone`; returns the new account's client. */
  async function signUpIn(timezone?: string) {
    const c = new TestClient(app);
    json(await c.post("/api/app/auth/signup", { email: uniqueEmail("clock"), password: PASSWORD, first_name: "Kim", ...(timezone !== undefined ? { timezone } : {}) }));
    return c;
  }
  const zoneOf = async (c: TestClient) => json(await c.get("/api/app/workspaces/current/settings")).default_timezone as string;

  it("is the time zone of the browser it was signed up in, not a far-off default", async () => {
    assert.equal(await zoneOf(await signUpIn("Asia/Karachi")), "Asia/Karachi");
    assert.equal(await zoneOf(await signUpIn("Europe/London")), "Europe/London");
    // Something that isn't a time zone, or the server's own ("local"), is no use: the default.
    assert.equal(await zoneOf(await signUpIn("Mars/Olympus_Mons")), "America/New_York");
    assert.equal(await zoneOf(await signUpIn("local")), "America/New_York");
    assert.equal(await zoneOf(await signUpIn()), "America/New_York");
  });

  it("of a workspace added later is the one in the person's profile, else their browser's", async () => {
    const c = await signUpIn("Asia/Karachi");
    json(await c.post("/api/app/workspaces", { name: "Second", timezone: "Europe/London" }));
    assert.equal(await zoneOf(c), "Europe/London");
    expectStatus(await c.patch("/api/app/auth/profile", { timezone: "Nowhere/Land" }), 400);
    json(await c.patch("/api/app/auth/profile", { timezone: "Asia/Tokyo" }));
    json(await c.post("/api/app/workspaces", { name: "Third", timezone: "Europe/London" }));
    assert.equal(await zoneOf(c), "Asia/Tokyo");
    json(await c.patch("/api/app/auth/profile", { timezone: null }));
  });

  it("is marked as chosen once an admin picks it, so the dashboard stops asking", async () => {
    const c = await signUpIn("Asia/Karachi");
    const before = json(await c.get("/api/app/workspaces/current/settings"));
    assert.equal(before.timezone_confirmed, undefined);
    const kept = json(await c.patch("/api/app/workspaces/current/settings", { timezone_confirmed: true }));
    assert.deepEqual([kept.default_timezone, kept.timezone_confirmed], ["Asia/Karachi", true]);
    const other = await signUpIn();
    const moved = json(await other.patch("/api/app/workspaces/current/settings", { default_timezone: "Asia/Dubai" }));
    assert.deepEqual([moved.default_timezone, moved.timezone_confirmed], ["Asia/Dubai", true]);
  });
});

describe("logging in and out", () => {
  it("answers a wrong password and an unknown email the same way", async () => {
    const c = new TestClient(app);
    const wrong = await c.post("/api/app/auth/login", { email: owner.email, password: "wrong-password-1" });
    const unknown = await c.post("/api/app/auth/login", { email: uniqueEmail("nobody"), password: "wrong-password-1" });
    expectStatus(wrong, 401);
    expectStatus(unknown, 401);
    assert.deepEqual(wrong.json(), unknown.json());
    assert.equal(c.cookie, null);
  });

  it("logs in with the right password, whatever the email's case", async () => {
    const u = await signUp(app);
    const c = new TestClient(app);
    assert.equal(json(await c.post("/api/app/auth/login", { email: u.email.toUpperCase(), password: u.password })).mfa_required, false);
    assert.equal(json(await c.get("/api/app/auth/me")).user.id, u.id);
  });

  it("logging out ends the session on the server, not only in the browser", async () => {
    const u = await signUp(app);
    const token = u.client.cookie!;
    expectStatus(await u.client.post("/api/app/auth/logout"), 200);
    assert.equal(u.client.cookie, null);
    const replay = new TestClient(app);
    replay.cookie = token;
    expectStatus(await replay.get("/api/app/auth/me"), 401);
  });

  it("the old license-code redemption endpoint is gone", async () => {
    expectStatus(await owner.client.post("/api/app/auth/appsumo/activate", { code: "ABCDEF123456" }), 404);
  });
});

describe("CSRF protection", () => {
  it("refuses cookie-authenticated writes without the x-rs-csrf header", async () => {
    const writes: Array<[method: "POST" | "PATCH" | "DELETE", url: string, body: unknown]> = [
      ["POST", "/api/app/workspaces", { name: "Made by another site" }],
      ["PATCH", "/api/app/auth/profile", { first_name: "Mallory" }],
      ["POST", "/api/app/campaigns", { name: "Made by another site" }],
      ["DELETE", "/api/app/auth/sessions/any-id", undefined],
      ["POST", "/api/app/auth/logout", {}],
    ];
    for (const [method, url, body] of writes) {
      for (const header of [undefined, "0", "true"]) {
        const res = await owner.client.request(method, url, body, { csrf: false, headers: header === undefined ? {} : { "x-rs-csrf": header } });
        expectStatus(res, 403, `${method} ${url} with x-rs-csrf=${header}`);
        assert.equal(res.json().code, "csrf");
      }
    }
    const me = json(await owner.client.get("/api/app/auth/me"));
    assert.notEqual(me.user.first_name, "Mallory");
    assert.ok(!me.workspaces.some((w: { name: string }) => w.name === "Made by another site"));
  });

  it("lets reads through, and writes that carry the header", async () => {
    expectStatus(await owner.client.get("/api/app/campaigns", { csrf: false }), 200);
    expectStatus(await owner.client.patch("/api/app/auth/profile", { first_name: "Owner" }), 200);
    // Without a session cookie there's nothing to forge: signing in needs no header.
    expectStatus(await new TestClient(app).post("/api/app/auth/login", { email: owner.email, password: owner.password }, { csrf: false }), 200);
  });

  it(
    "keeps the check when the Authorization header isn't a Bearer key",
    async () => {
      const u = await signUp(app, { firstName: "Before" });
      const res = await u.client.patch("/api/app/auth/profile", { first_name: "After" }, { csrf: false, headers: { authorization: "Basic dGVzdDp0ZXN0" } });
      expectStatus(res, 403);
      assert.equal(json(await u.client.get("/api/app/auth/me")).user.first_name, "Before");
    },
  );
});

describe("sign-in limits and client addresses", () => {
  it("blocks an address after 10 failed logins to an account, even with the right password", async () => {
    const u = await signUp(app);
    const c = new TestClient(app);
    for (let i = 1; i <= 10; i++) expectStatus(await c.post("/api/app/auth/login", { email: u.email, password: `wrong-password-${i}` }), 401, `attempt ${i}`);
    const blocked = await c.post("/api/app/auth/login", { email: u.email, password: "wrong-password-11" });
    expectStatus(blocked, 429);
    assert.equal(blocked.json().code, "rate_limited");
    expectStatus(await c.post("/api/app/auth/login", { email: u.email, password: u.password }), 429);
    assert.equal(c.cookie, null);
  });

  it("can't be dodged by sending a different X-Forwarded-For each time", async () => {
    const u = await signUp(app);
    const c = new TestClient(app);
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i++) {
      const res = await c.post("/api/app/auth/login", { email: u.email, password: "wrong-password" }, { headers: { "x-forwarded-for": `198.51.100.${i}` } });
      statuses.push(res.statusCode);
    }
    assert.equal(statuses.at(-1), 429, `statuses: ${statuses.join(",")}`);
  });

  it("takes the visitor's address from X-Forwarded-For only when a local proxy sent it", async () => {
    const u = await signUp(app);
    const viaProxy = new TestClient(app);
    const proxied = { remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.77" } };
    expectStatus(await viaProxy.post("/api/app/auth/login", { email: u.email, password: u.password }, proxied), 200);
    const direct = new TestClient(app);
    expectStatus(await direct.post("/api/app/auth/login", { email: u.email, password: u.password }, { headers: { "x-forwarded-for": "198.51.100.88" } }), 200);
    const ips = (json(await u.client.get("/api/app/auth/sessions")) as unknown as Array<{ ip: string }>).map((s) => s.ip);
    assert.ok(ips.includes("198.51.100.77"), ips.join(","));
    assert.ok(ips.includes(direct.address), ips.join(","));
    assert.ok(!ips.includes("198.51.100.88"), ips.join(","));
  });
});

describe("password reset", () => {
  it("answers the same for known and unknown addresses", async () => {
    const c = new TestClient(app);
    const known = await c.post("/api/app/auth/password-reset/request", { email: owner.email });
    const unknown = await c.post("/api/app/auth/password-reset/request", { email: uniqueEmail("nobody") });
    expectStatus(known, 200);
    expectStatus(unknown, 200);
    assert.deepEqual(known.json(), unknown.json());
  });

  it("the emailed link sets a new password once and signs out every session", async () => {
    const u = await signUp(app);
    const second = await logIn(app, u.email);
    expectStatus(await new TestClient(app).post("/api/app/auth/password-reset/request", { email: u.email }), 200);
    const token = resetToken(u.email);
    const anon = new TestClient(app);
    expectStatus(await anon.post("/api/app/auth/password-reset/confirm", { token, password: "new-test-password-2" }), 200);
    expectStatus(await u.client.get("/api/app/auth/me"), 401);
    expectStatus(await second.get("/api/app/auth/me"), 401);
    expectStatus(await new TestClient(app).post("/api/app/auth/login", { email: u.email, password: u.password }), 401);
    await logIn(app, u.email, "new-test-password-2");
    expectStatus(await anon.post("/api/app/auth/password-reset/confirm", { token, password: "third-test-password-3" }), 400);
  });

  it("refuses made-up tokens", async () => {
    expectStatus(await new TestClient(app).post("/api/app/auth/password-reset/confirm", { token: "made-up-token-made-up-token", password: "new-test-password-4" }), 400);
  });
});

describe("confirming the email address", () => {
  it("is on the setup checklist only when this installation can send email", async () => {
    const u = await signUp(app);
    const keys = async () => json<{ steps: Array<{ key: string }> }>(await u.client.get("/api/app/dashboard/setup")).steps.map((s) => s.key);
    assert.ok(!(await keys()).includes("verify_email"));
    const host = config.systemSmtp.host;
    config.systemSmtp.host = "smtp.invalid";
    try {
      assert.equal((await keys())[0], "verify_email");
    } finally {
      config.systemSmtp.host = host;
    }
  });

  it("a launched campaign stays ticked off when bounce protection or unhealthy mailboxes stop it", async () => {
    const u = await signUp(app);
    const launched = async () => json<{ steps: Array<{ key: string; done: boolean }> }>(await u.client.get("/api/app/dashboard/setup")).steps.find((s) => s.key === "launch_campaign")!.done;
    const campaign = json(await u.client.post("/api/app/campaigns", { name: "Stopped by the engine" }));
    assert.equal(await launched(), false);
    for (const status of [CampaignStatus.BOUNCE_PROTECT, CampaignStatus.ACCOUNTS_UNHEALTHY]) {
      await db.update(schema.campaigns).set({ status, launchedAt: new Date() }).where(eq(schema.campaigns.id, campaign.id));
      assert.equal(await launched(), true, `status ${status}`);
    }
  });

  it("resending the link says it wasn't emailed, and keeps it for the owner's System emails list", async () => {
    const u = await signUp(app);
    assert.equal(json(await u.client.post("/api/app/auth/resend-verification")).emailed, false);
    assert.ok(systemMailLog.some((m) => m.to === u.email && /\/auth\/verify\?token=/.test(m.text)));
  });
});

describe("two-step sign-in", () => {
  it("can't be skipped, and each recovery code works once", async () => {
    const u = await signUp(app);
    const secret = json(await u.client.post("/api/app/auth/mfa/setup", { password: u.password })).secret as string;
    expectStatus(await u.client.post("/api/app/auth/mfa/enable", { code: wrongCode(secret) }), 400);
    const codes = json(await u.client.post("/api/app/auth/mfa/enable", { code: totpCode(secret) })).recovery_codes as string[];
    assert.equal(codes.length, 10);

    const c = new TestClient(app);
    assert.equal(json(await c.post("/api/app/auth/login", { email: u.email, password: u.password })).mfa_required, true);
    for (const url of ["/api/app/auth/me", "/api/app/campaigns", "/api/v2/campaigns", "/api/app/workspaces"]) {
      const res = await c.get(url);
      expectStatus(res, 401, url);
      assert.equal(res.json().code, "mfa_required", url);
    }
    expectStatus(await c.post("/api/app/auth/mfa/verify", { code: wrongCode(secret) }), 400);
    expectStatus(await c.post("/api/app/auth/mfa/verify", { recovery_code: "00000-00000" }), 400);
    expectStatus(await c.post("/api/app/auth/mfa/verify", { recovery_code: codes[0] }), 200);
    expectStatus(await c.get("/api/app/auth/me"), 200);

    const again = new TestClient(app);
    json(await again.post("/api/app/auth/login", { email: u.email, password: u.password }));
    expectStatus(await again.post("/api/app/auth/mfa/verify", { recovery_code: codes[0] }), 400);
    expectStatus(await again.post("/api/app/auth/mfa/verify", { code: totpCode(secret) }), 200);
    expectStatus(await again.get("/api/app/auth/me"), 200);
  });
});

describe("session management", () => {
  it("people only see and end their own sessions", async () => {
    const a = await signUp(app);
    const b = await signUp(app);
    const aSessions = json(await a.client.get("/api/app/auth/sessions")) as unknown as Array<{ id: string; current: boolean }>;
    const aCurrent = aSessions.find((s) => s.current);
    assert.ok(aCurrent);
    const bSessions = json(await b.client.get("/api/app/auth/sessions")) as unknown as Array<{ id: string }>;
    assert.ok(!bSessions.some((s) => s.id === aCurrent.id));
    expectStatus(await b.client.delete(`/api/app/auth/sessions/${aCurrent.id}`), 200);
    expectStatus(await a.client.get("/api/app/auth/me"), 200);
  });

  it("changing the password needs the current one and signs out the other sessions", async () => {
    const u = await signUp(app);
    const other = await logIn(app, u.email);
    expectStatus(await u.client.post("/api/app/auth/change-password", { current_password: "wrong-password", new_password: "changed-password-9" }), 400);
    expectStatus(await other.get("/api/app/auth/me"), 200);
    expectStatus(await u.client.post("/api/app/auth/change-password", { current_password: u.password, new_password: "changed-password-9" }), 200);
    expectStatus(await other.get("/api/app/auth/me"), 401);
    expectStatus(await u.client.get("/api/app/auth/me"), 200);
  });
});

describe("deleting an account", () => {
  it("needs the password, then the account and its sessions are gone", async () => {
    const u = await signUp(app);
    expectStatus(await u.client.delete("/api/app/auth/account", { confirm: "DELETE", password: "wrong-password" }), 400);
    expectStatus(await u.client.get("/api/app/auth/me"), 200);
    expectStatus(await u.client.delete("/api/app/auth/account", { confirm: "DELETE", password: u.password }), 200);
    expectStatus(await u.client.get("/api/app/auth/me"), 401);
    expectStatus(await new TestClient(app).post("/api/app/auth/login", { email: u.email, password: u.password }), 401);
  });

  it("the installation owner can't delete their account while others exist", async () => {
    expectStatus(await owner.client.delete("/api/app/auth/account", { confirm: "DELETE", password: owner.password }), 400);
    expectStatus(await owner.client.get("/api/app/auth/me"), 200);
  });
});

// Who gets into what: workspace security rules on every request, Google and Microsoft sign-in, API keys of people who
// no longer run a workspace, admins invited by keys, turning two-step on, handing a workspace over, seats taken through
// a right, attempt limits, expired invitations, what restricted members see, template kinds, changing the sign-in
// email and inviting a workspace into a group.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { PASSWORD, TestClient, expectStatus, json, logIn, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { config } from "../src/env";
import { signPayload } from "../src/lib/crypto";
import { totpCode } from "../src/lib/totp";
import { issueToken } from "../src/services/auth-tokens";
import { systemMailLog } from "../src/services/system-mail";
import { patchWorkspaceSettings } from "../src/services/workspaces";

let app: FastifyInstance;
let owner: TestUser;

before(async () => {
  app = await startServer();
  owner = await signUp(app, { firstName: "Olive" });
});
after(stopServer);

const tokenOf = (inviteUrl: string) => new URL(inviteUrl).searchParams.get("token")!;

/** Someone invited into `by`'s workspace who signs up through the link, so it's the only workspace they have. */
async function join(by: TestUser, role: string, opts: { firstName?: string; permissions?: string[] } = {}): Promise<TestUser> {
  const email = uniqueEmail(role);
  const invite = json(await by.client.post("/api/v2/workspace-members", { email, role, ...(opts.permissions ? { permissions: opts.permissions } : {}) }));
  return signUp(app, { email, inviteToken: tokenOf(invite.invite_url), firstName: opts.firstName });
}

/** Turns two-step authentication on for `u` and returns the authenticator's secret. */
async function turnOn2fa(u: TestUser): Promise<string> {
  const secret = json(await u.client.post("/api/app/auth/mfa/setup", { password: u.password })).secret as string;
  json(await u.client.post("/api/app/auth/mfa/enable", { code: totpCode(secret) }));
  return secret;
}

async function logInWithCode(email: string, secret: string): Promise<TestClient> {
  const c = new TestClient(app);
  json(await c.post("/api/app/auth/login", { email, password: PASSWORD }));
  json(await c.post("/api/app/auth/mfa/verify", { code: totpCode(secret) }));
  return c;
}

async function memberRow(workspaceId: string, userId: string) {
  const M = schema.workspaceMembers;
  const [row] = await db.select().from(M).where(and(eq(M.workspaceId, workspaceId), eq(M.userId, userId)));
  return row;
}

/** The token in the newest system email to `to` that has a link with `path?token=`. */
function mailedToken(to: string, path: string): string {
  const mail = systemMailLog.find((m) => m.to === to && m.text.includes(`${path}?token=`));
  assert.ok(mail, `no ${path} email for ${to}`);
  return decodeURIComponent(new RegExp(`${path}\\?token=([^\\s&]+)`).exec(mail.text)![1]!);
}

// ---------- Google and Microsoft sign-in ----------

/** Answers the provider's token request with an ID token saying these things about the person. */
function fakeProvider(claims: Record<string, unknown>): () => void {
  const real = globalThis.fetch;
  const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://oauth2.googleapis.com/token" || url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      return new Response(JSON.stringify({ access_token: "test-access", id_token: idToken, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return real(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Comes back from a Google or Microsoft sign-in in the browser that started it; returns where it was sent. */
async function signInWith(provider: "google" | "microsoft", claims: Record<string, unknown>) {
  const client = new TestClient(app);
  const restore = fakeProvider(claims);
  try {
    const state = signPayload({ provider, purpose: "login", nonce: "test-nonce", exp: Date.now() + 60_000 });
    const res = await client.get(`/api/app/oauth/${provider}/callback?code=test-code&state=${encodeURIComponent(state)}`, { headers: { cookie: "rs_oauth=test-nonce" } });
    expectStatus(res, 302);
    return { client, location: String(res.headers.location) };
  } finally {
    restore();
  }
}

describe("signing in with Google or Microsoft", () => {
  it("doesn't create an account from an address the provider didn't vouch for", async () => {
    const email = uniqueEmail("unvouched");
    const r = await signInWith("microsoft", { sub: "ms-new", email, given_name: "Mal", family_name: "Ory" });
    assert.match(decodeURIComponent(r.location), /\/auth\/login\?error=.*can't be used to create an account/);
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.email, email))).length, 0);

    const vouched = await signInWith("google", { sub: "g-new", email: uniqueEmail("vouched"), email_verified: true, given_name: "Val" });
    assert.match(vouched.location, /\/app\/dashboard$/);
  });

  it("a vouched sign-in to an account someone set up first removes their sign-in and their sessions", async () => {
    // As accounts could be made before: no password, the address unconfirmed, a Microsoft sign-in nobody vouched for.
    const email = uniqueEmail("claimed");
    const [u] = await db.insert(schema.users).values({ email, firstName: "Early", onboarding: {} }).returning();
    await db.insert(schema.oauthIdentities).values({ userId: u!.id, provider: "microsoft", subject: "ms-first", email });
    const first = await signInWith("microsoft", { sub: "ms-first", email, given_name: "Early" });
    expectStatus(await first.client.get("/api/app/auth/me"), 200);

    const real = await signInWith("google", { sub: "g-real", email, email_verified: true, given_name: "Real" });
    assert.match(real.location, /\/app\/dashboard$/);
    expectStatus(await real.client.get("/api/app/auth/me"), 200);
    expectStatus(await first.client.get("/api/app/auth/me"), 401);
    const linked = await db.select().from(schema.oauthIdentities).where(eq(schema.oauthIdentities.userId, u!.id));
    assert.deepEqual(
      linked.map((i) => [i.subject, i.verified]),
      [["g-real", true]],
    );
    const again = await signInWith("microsoft", { sub: "ms-first", email, given_name: "Early" });
    assert.match(again.location, /error=/);
  });

  it("a password reset removes sign-ins the provider didn't vouch for and confirms the address", async () => {
    const email = uniqueEmail("reset");
    const [u] = await db.insert(schema.users).values({ email, firstName: "Rae", onboarding: {} }).returning();
    await db.insert(schema.oauthIdentities).values([
      { userId: u!.id, provider: "microsoft", subject: "ms-reset", email },
      { userId: u!.id, provider: "google", subject: "g-reset", email, verified: true },
    ]);
    json(await new TestClient(app).post("/api/app/auth/password-reset/request", { email }));
    json(await new TestClient(app).post("/api/app/auth/password-reset/confirm", { token: mailedToken(email, "reset-password"), password: "fresh-password-1" }));
    const linked = await db.select().from(schema.oauthIdentities).where(eq(schema.oauthIdentities.userId, u!.id));
    assert.deepEqual(
      linked.map((i) => i.subject),
      ["g-reset"],
    );
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u!.id));
    assert.ok(after!.emailVerifiedAt);
  });

  it("makes a new account's workspace on the clock of the browser that started the sign-in", async () => {
    const saved = { ...config.google };
    config.google.clientId = "local-test-client";
    config.google.clientSecret = "local-test-secret";
    try {
      const client = new TestClient(app);
      const start = await client.get(`/api/app/auth/oauth/google/start?tz=${encodeURIComponent("Asia/Tokyo")}`);
      expectStatus(start, 302);
      const state = new URL(String(start.headers.location)).searchParams.get("state")!;
      const nonce = start.cookies.find((c) => c.name === "rs_oauth")!.value;
      const restore = fakeProvider({ sub: "g-tokyo", email: uniqueEmail("tokyo"), email_verified: true, given_name: "Yui" });
      try {
        const back = await client.get(`/api/app/oauth/google/callback?code=test-code&state=${encodeURIComponent(state)}`, { headers: { cookie: `rs_oauth=${nonce}` } });
        expectStatus(back, 302);
        assert.match(String(back.headers.location), /\/app\/dashboard$/);
      } finally {
        restore();
      }
      assert.equal(json(await client.get("/api/app/workspaces/current/settings")).default_timezone, "Asia/Tokyo");
    } finally {
      Object.assign(config.google, saved);
    }
  });
});

// ---------- Workspace security rules ----------

describe("workspace security rules", () => {
  it("requiring two-step authentication turns away members without it on every request, not only when switching", async () => {
    const boss = await signUp(app, { firstName: "Bea" });
    await turnOn2fa(boss);
    const member = await join(boss, "editor");
    expectStatus(await member.client.get("/api/app/campaigns"), 200);
    json(await boss.client.patch("/api/app/workspaces/current/security", { require_2fa: true }));

    // The session already inside is stopped at the next request.
    const res = await member.client.get("/api/app/campaigns");
    expectStatus(res, 403);
    assert.equal(res.json().code, "totp_required");
    assert.equal(json(await member.client.get("/api/app/auth/me")).session.workspace_gate, "totp_required");
    // Their own settings stay open, so they can turn it on, and then they're in.
    expectStatus(await member.client.patch("/api/app/auth/profile", { first_name: "Mo" }), 200);
    await turnOn2fa(member);
    expectStatus(await member.client.get("/api/app/campaigns"), 200);
    assert.equal(json(await member.client.get("/api/app/auth/me")).session.workspace_gate, null);
  });

  it("signing in opens a workspace that lets the person in, and a header can't get round the rule", async () => {
    const boss = await signUp(app);
    await turnOn2fa(boss);
    const member = await join(boss, "editor");
    const own = json(await member.client.post("/api/app/workspaces", { name: "Mine" }));
    json(await boss.client.patch("/api/app/workspaces/current/security", { require_2fa: true }));

    const fresh = await logIn(app, member.email);
    const me = json(await fresh.get("/api/app/auth/me"));
    assert.equal(me.workspace.id, own.id);
    assert.equal(me.session.workspace_gate, null);
    const viaHeader = await fresh.get("/api/app/campaigns", { headers: { "x-workspace-id": boss.workspaceId! } });
    expectStatus(viaHeader, 403);
    assert.equal(viaHeader.json().code, "totp_required");
    const sw = await fresh.post(`/api/app/workspaces/${boss.workspaceId}/switch`);
    expectStatus(sw, 403);
    assert.equal(sw.json().code, "totp_required");
  });

  it("a fresh code every few hours: asked again once the last one is too old; the sign-in code counts", async () => {
    const boss = await signUp(app);
    await turnOn2fa(boss);
    const member = await join(boss, "editor");
    const secret = await turnOn2fa(member);
    json(await boss.client.patch("/api/app/workspaces/current/security", { reauth_hours: 8 }));
    expectStatus(await member.client.get("/api/app/campaigns"), 200);

    await db
      .update(schema.sessions)
      .set({ workspaceReauth: { "*": Date.now() - 9 * 3_600_000 } })
      .where(eq(schema.sessions.userId, member.id));
    const stale = await member.client.get("/api/app/campaigns");
    expectStatus(stale, 403);
    assert.equal(stale.json().code, "workspace_reauth_required");
    json(await member.client.post("/api/app/auth/workspace-reauth", { workspace_id: boss.workspaceId, code: totpCode(secret) }));
    expectStatus(await member.client.get("/api/app/campaigns"), 200);

    const signedIn = await logInWithCode(member.email, secret);
    expectStatus(await signedIn.get("/api/app/campaigns"), 200);
  });
});

// ---------- API keys ----------

describe("API keys of people who no longer run the workspace", () => {
  it("stop working once their creator is demoted, keys made by those keys included, and the list says so", async () => {
    const boss = await signUp(app);
    const helper = await join(boss, "admin", { firstName: "Hal" });
    const key = json(await helper.client.post("/api/v2/api-keys", { name: "Hal's sync", scopes: ["all:all"] })).key as string;
    const api = new TestClient(app, key);
    expectStatus(await api.get("/api/v2/campaigns"), 200);
    const child = json(await api.post("/api/v2/api-keys", { name: "child", scopes: ["campaigns:read"] })).key as string;

    const seat = (await memberRow(boss.workspaceId!, helper.id))!;
    json(await boss.client.patch(`/api/v2/workspace-members/${seat.id}`, { role: "editor" }));
    for (const k of [key, child]) {
      const res = await new TestClient(app, k).get("/api/v2/campaigns");
      expectStatus(res, 401);
      assert.equal(res.json().code, "api_key_orphaned");
    }
    const listed = json(await boss.client.get("/api/v2/api-keys")).items as Array<{ name: string; active: boolean; created_by: { name: string } | null }>;
    for (const name of ["Hal's sync", "child"]) {
      const row = listed.find((k) => k.name === name)!;
      assert.equal(row.active, false, name);
      assert.equal(row.created_by?.name, "Hal User", name);
    }

    json(await boss.client.patch(`/api/v2/workspace-members/${seat.id}`, { role: "admin" }));
    expectStatus(await api.get("/api/v2/campaigns"), 200);
  });

  it("stop while the workspace's owner is turned off", async () => {
    const boss = await signUp(app);
    const api = new TestClient(app, json(await boss.client.post("/api/v2/api-keys", { name: "k", scopes: ["all:all"] })).key as string);
    expectStatus(await api.get("/api/v2/campaigns"), 200);
    json(await owner.client.patch(`/api/app/admin/users/${boss.id}`, { disabled: true }));
    const res = await api.get("/api/v2/campaigns");
    expectStatus(res, 403);
    assert.equal(res.json().code, "workspace_stopped");
    json(await owner.client.patch(`/api/app/admin/users/${boss.id}`, { disabled: false }));
    expectStatus(await api.get("/api/v2/campaigns"), 200);
  });
});

describe("inviting people with an API key", () => {
  it("a key scoped to inviting can't make anyone an admin and never gets the invitation link", async () => {
    const boss = await signUp(app);
    const scoped = json(await boss.client.post("/api/v2/api-keys", { name: "hr", scopes: ["workspace_members:create", "workspace_members:update", "workspace_members:read"] })).key as string;
    const api = new TestClient(app, scoped);
    expectStatus(await api.post("/api/v2/workspace-members", { email: uniqueEmail("would-be-admin"), role: "admin" }), 403);
    const editor = json(await api.post("/api/v2/workspace-members", { email: uniqueEmail("editor"), role: "editor" }));
    assert.equal(editor.invite_url, undefined);
    expectStatus(await api.patch(`/api/v2/workspace-members/${editor.id}`, { role: "admin" }), 403);

    const full = new TestClient(app, json(await boss.client.post("/api/v2/api-keys", { name: "full", scopes: ["all:all"] })).key as string);
    const admin = json(await full.post("/api/v2/workspace-members", { email: uniqueEmail("admin"), role: "admin" }));
    assert.equal(admin.role, "admin");
    assert.equal(admin.invite_url, undefined);
  });
});

// ---------- Two-step authentication ----------

describe("turning on two-step authentication", () => {
  it("needs the password, signs out other devices and tells the account's inbox", async () => {
    const u = await signUp(app);
    const other = await logIn(app, u.email);
    expectStatus(await u.client.post("/api/app/auth/mfa/setup", {}), 400);
    expectStatus(await u.client.post("/api/app/auth/mfa/setup", { password: "wrong-password-1" }), 400);
    const secret = json(await u.client.post("/api/app/auth/mfa/setup", { password: u.password })).secret as string;
    json(await u.client.post("/api/app/auth/mfa/enable", { code: totpCode(secret) }));
    expectStatus(await other.get("/api/app/auth/me"), 401);
    expectStatus(await u.client.get("/api/app/auth/me"), 200);
    assert.ok(systemMailLog.some((m) => m.to === u.email && m.subject.startsWith("Two-step authentication is on")));

    // Once it's on, a session alone can't swap in another authenticator.
    expectStatus(await u.client.post("/api/app/auth/mfa/setup", { password: u.password }), 400);
    expectStatus(await u.client.post("/api/app/auth/mfa/enable", { code: totpCode(secret) }), 400);
  });
});

// ---------- Handing a workspace over ----------

describe("handing a workspace to someone else", () => {
  it("one link works once, other waiting links stop, and nobody can be given what they already own", async () => {
    const boss = await signUp(app);
    const b = await join(boss, "admin");
    const c = await join(boss, "admin");
    expectStatus(await boss.client.post("/api/v2/workspaces/current/change-owner", { email: boss.email }), 400);
    json(await boss.client.post("/api/v2/workspaces/current/change-owner", { email: b.email }));
    const toB = mailedToken(boss.email, "change-owner");
    json(await boss.client.post("/api/v2/workspaces/current/change-owner", { email: c.email }));
    const toC = mailedToken(boss.email, "change-owner");
    assert.notEqual(toB, toC);

    json(await new TestClient(app).post("/api/app/workspaces/current/change-owner/confirm", { token: toC }));
    expectStatus(await new TestClient(app).post("/api/app/workspaces/current/change-owner/confirm", { token: toC }), 400);
    expectStatus(await new TestClient(app).post("/api/app/workspaces/current/change-owner/confirm", { token: toB }), 400);
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, boss.workspaceId!));
    assert.equal(ws!.ownerId, c.id);
    assert.equal((await memberRow(boss.workspaceId!, boss.id))!.role, "admin");
  });

  it("a link from someone who doesn't own the workspace does nothing", async () => {
    const boss = await signUp(app);
    const b = await join(boss, "admin");
    const token = await issueToken("owner_change", { userId: b.id, data: { workspace_id: boss.workspaceId, new_owner_user_id: b.id }, ttlMs: 60_000 });
    expectStatus(await new TestClient(app).post("/api/app/workspaces/current/change-owner/confirm", { token }), 400);
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, boss.workspaceId!));
    assert.equal(ws!.ownerId, boss.id);
  });
});

// ---------- Seats taken through a right ----------

describe("seats taken through a right", () => {
  it("administrators can't open the owner's or another administrator's workspace, and lose opened ones with the role", async () => {
    const adminA = await signUp(app);
    const adminB = await signUp(app);
    const someone = await signUp(app);
    json(await owner.client.patch(`/api/app/admin/users/${adminA.id}`, { admin: true }));
    json(await owner.client.patch(`/api/app/admin/users/${adminB.id}`, { admin: true }));
    expectStatus(await adminA.client.post(`/api/app/admin/workspaces/${owner.workspaceId}/enter`), 403);
    expectStatus(await adminA.client.post(`/api/app/admin/workspaces/${adminB.workspaceId}/enter`), 403);
    json(await adminA.client.post(`/api/app/admin/workspaces/${someone.workspaceId}/enter`));
    assert.equal((await memberRow(someone.workspaceId!, adminA.id))?.enteredVia, "installation");

    json(await owner.client.patch(`/api/app/admin/users/${adminA.id}`, { admin: false }));
    assert.equal(await memberRow(someone.workspaceId!, adminA.id), undefined);
    const ownerHelping = await logIn(app, owner.email);
    json(await ownerHelping.post(`/api/app/admin/workspaces/${adminB.workspaceId}/enter`));
  });

  it("admins of a managing workspace lose the seats they took when they leave it, or when the group link goes", async () => {
    const agency = await signUp(app, { firstName: "Agnes" });
    const staff = await join(agency, "admin");
    const client = await signUp(app, { firstName: "Cliff" });
    json(await agency.client.post("/api/v2/workspace-group-members", { email: client.email }));
    const G = schema.workspaceGroupMembers;
    const [link] = await db.select().from(G).where(and(eq(G.adminWorkspaceId, agency.workspaceId!), eq(G.subWorkspaceId, client.workspaceId!)));
    json(await client.client.post(`/api/app/workspace-group-members/${link!.id}/respond`, { accept: true }));

    json(await staff.client.post(`/api/app/workspace-groups/${client.workspaceId}/enter`));
    assert.equal((await memberRow(client.workspaceId!, staff.id))?.enteredVia, `agency:${agency.workspaceId}`);
    json(await staff.client.post("/api/app/workspaces/current/leave", {}, { headers: { "x-workspace-id": agency.workspaceId! } }));
    assert.equal(await memberRow(client.workspaceId!, staff.id), undefined);

    const staff2 = await join(agency, "admin");
    json(await staff2.client.post(`/api/app/workspace-groups/${client.workspaceId}/enter`));
    const staff3 = await join(agency, "admin");
    json(await staff3.client.post(`/api/app/workspace-groups/${client.workspaceId}/enter`));
    // Demoted in the agency: the client seat goes.
    json(await agency.client.patch(`/api/v2/workspace-members/${(await memberRow(agency.workspaceId!, staff3.id))!.id}`, { role: "editor" }));
    assert.equal(await memberRow(client.workspaceId!, staff3.id), undefined);
    // The group link removed: every seat taken through it goes.
    json(await agency.client.delete(`/api/v2/workspace-group-members/${link!.id}`));
    assert.equal(await memberRow(client.workspaceId!, staff2.id), undefined);
    assert.ok(await memberRow(client.workspaceId!, client.id));
  });

  it("inviting a workspace by email answers the same for every address, names nobody, and doesn't re-ask after a no", async () => {
    const agency = await signUp(app);
    const known = await signUp(app, { workspaceName: "Quiet Holdings" });
    const unknown = json(await agency.client.post("/api/v2/workspace-group-members", { email: uniqueEmail("nobody") }));
    const asked = json(await agency.client.post("/api/v2/workspace-group-members", { email: known.email }));
    assert.deepEqual(unknown, asked);
    const listed = json(await agency.client.get("/api/v2/workspace-group-members"));
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].sub_workspace_id, null);
    assert.ok(!JSON.stringify(listed).includes("Quiet Holdings"));

    const G = schema.workspaceGroupMembers;
    const [link] = await db.select().from(G).where(eq(G.adminWorkspaceId, agency.workspaceId!));
    json(await known.client.post(`/api/app/workspace-group-members/${link!.id}/respond`, { accept: false }));
    const invitesTo = () => systemMailLog.filter((m) => m.to === known.email && /workspace group/.test(m.subject)).length;
    const before = invitesTo();
    json(await agency.client.post("/api/v2/workspace-group-members", { email: known.email }));
    assert.equal(invitesTo(), before);
    const [still] = await db.select().from(G).where(eq(G.id, link!.id));
    assert.equal(still!.status, "rejected");
  });
});

// ---------- Attempt limits ----------

describe("attempt limits", () => {
  it("an account's sign-in waits after many wrong passwords from anywhere, until its password is reset", async () => {
    const u = await signUp(app);
    for (let i = 0; i < 30; i++) expectStatus(await new TestClient(app).post("/api/app/auth/login", { email: u.email, password: "wrong-password-x" }), 401);
    expectStatus(await new TestClient(app).post("/api/app/auth/login", { email: u.email, password: u.password }), 429);
    json(await new TestClient(app).post("/api/app/auth/password-reset/request", { email: u.email }));
    json(await new TestClient(app).post("/api/app/auth/password-reset/confirm", { token: mailedToken(u.email, "reset-password"), password: "another-password-2" }));
    expectStatus(await new TestClient(app).post("/api/app/auth/login", { email: u.email, password: "another-password-2" }), 200);
  });

  it("checking the current password behind a session is limited too", async () => {
    const u = await signUp(app);
    for (let i = 0; i < 10; i++) expectStatus(await u.client.post("/api/app/auth/change-password", { current_password: "not-it-at-all", new_password: "whatever-new-1" }), 400);
    expectStatus(await u.client.post("/api/app/auth/change-password", { current_password: u.password, new_password: "whatever-new-1" }), 429);
  });
});

// ---------- Invitations ----------

describe("invitations", () => {
  it("an expired one can't be used to sign up; editing it doesn't renew it, sending it again does", async () => {
    const boss = await signUp(app);
    const email = uniqueEmail("late");
    const invite = json(await boss.client.post("/api/v2/workspace-members", { email, role: "editor" }));
    await db
      .update(schema.workspaceMembers)
      .set({ invitedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(schema.workspaceMembers.id, invite.id));
    const refused = await new TestClient(app).post("/api/app/auth/signup", { email, password: PASSWORD, invite_token: tokenOf(invite.invite_url) });
    expectStatus(refused, 410);
    assert.equal(refused.json().code, "invitation_expired");

    json(await boss.client.patch(`/api/v2/workspace-members/${invite.id}`, { nickname: "Late" }));
    expectStatus(await new TestClient(app).get(`/api/app/invitations/${encodeURIComponent(tokenOf(invite.invite_url))}`), 410);
    const resent = json(await boss.client.post(`/api/app/workspace-members/${invite.id}/resend`));
    const joined = await signUp(app, { email, inviteToken: tokenOf(resent.invite_url) });
    assert.equal(joined.workspaceId, boss.workspaceId);
  });
});

// ---------- Restricted members ----------

describe("what restricted members see", () => {
  it("clients see teammates' names only, and nobody gets the CRM's Stripe key", async () => {
    const boss = await signUp(app, { firstName: "Bo" });
    const pending = uniqueEmail("pending");
    json(await boss.client.post("/api/v2/workspace-members", { email: pending, role: "editor" }));
    const client = await join(boss, "client");
    const team = json(await client.client.get("/api/v2/workspace-members"));
    assert.equal(team.items.length, 2);
    for (const m of team.items) {
      assert.equal(m.email, null);
      assert.equal(m.role, undefined);
    }
    assert.ok(team.items.some((m: { name: { first: string } }) => m.name.first === "Bo"));
    assert.ok(!JSON.stringify(team).includes(boss.email));
    assert.ok(JSON.stringify(json(await boss.client.get("/api/v2/workspace-members"))).includes(pending));

    await patchWorkspaceSettings(boss.workspaceId!, { crm_stripe: { mode: "key", secret: "enc-test-only-not-a-key", account_name: "Bo Ltd", connected_at: "2026-10-01T00:00:00.000Z" } });
    for (const url of ["/api/app/auth/me", "/api/app/workspaces/current/settings", "/api/v2/workspaces/current"]) {
      for (const who of [client, boss]) assert.ok(!(await who.client.get(url)).body.includes("enc-test-only"), url);
    }
    assert.equal(json(await boss.client.get("/api/app/workspaces/current/settings")).crm_stripe.account_name, "Bo Ltd");
  });

  it("templates: members see the kinds they work with, and can't edit one kind by turning it into the other", async () => {
    const boss = await signUp(app);
    const emailTemplate = json(await boss.client.post("/api/app/templates", { name: "Intro", subject: "Hi", body: "<p>Hello</p>" }));
    json(await boss.client.post("/api/app/templates", { name: "Thanks", subject: "", body: "<p>Thanks</p>", is_reply_template: true }));
    const replies = await join(boss, "client", { permissions: ["unibox"] });
    assert.deepEqual(
      json(await replies.client.get("/api/app/templates")).items.map((t: { name: string }) => t.name),
      ["Thanks"],
    );
    expectStatus(await replies.client.patch(`/api/app/templates/${emailTemplate.id}`, { is_reply_template: true, body: "<p>Changed</p>" }), 403);
    const [kept] = await db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.id, emailTemplate.id));
    assert.equal(kept!.body, "<p>Hello</p>");
    const dashboardOnly = await join(boss, "client", { permissions: ["dashboard"] });
    expectStatus(await dashboardOnly.client.get("/api/app/templates"), 403);
  });
});

// ---------- Changing the sign-in email ----------

describe("changing the sign-in email", () => {
  it("works when the new address has an invitation waiting in a workspace they're already in", async () => {
    const boss = await signUp(app);
    const u = await join(boss, "editor");
    const next = uniqueEmail("new-address");
    json(await boss.client.post("/api/v2/workspace-members", { email: next, role: "view" }));
    json(await u.client.post("/api/app/auth/change-email/send-code", { new_email: next, current_password: u.password }));
    const code = /verification code: (\d{6})/.exec(systemMailLog.find((m) => m.to === next && /verification code/.test(m.subject))!.subject)![1]!;
    json(await u.client.post("/api/app/auth/change-email/verify", { code }));
    const rows = (await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, boss.workspaceId!))).filter((r) => r.email === next);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.userId, u.id);
    assert.equal(rows[0]!.role, "editor");
    assert.equal(json(await u.client.get("/api/app/auth/me")).user.email, next);
  });
});
